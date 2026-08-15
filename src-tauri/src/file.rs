//! 字节级文件读写服务（T3）。
//!
//! Rust 侧只做 UTF-8 字节的读取与原子写入，不解析 Markdown —— 文档模型的
//! 唯一 owner 是前端编辑器会话。写入采用「同目录临时文件 + rename」的原子写
//! 策略：失败时清理临时文件并返回错误，目标路径上永远不会留下半截文件。

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::time::UNIX_EPOCH;

pub const MAX_TEXT_FILE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_READER_FILE_BYTES: u64 = 128 * 1024 * 1024;

fn file_limit_error(actual: u64, limit: u64) -> String {
    format!("FILE_TOO_LARGE:{actual}:{limit}")
}

fn ensure_file_size(actual: u64, limit: u64) -> Result<(), String> {
    if actual > limit {
        return Err(file_limit_error(actual, limit));
    }
    Ok(())
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|e| format!("无法读取文件 {}: {}", path.display(), e))?;
    let size = file
        .metadata()
        .map_err(|e| format!("无法读取文件信息 {}: {}", path.display(), e))?
        .len();
    ensure_file_size(size, limit)?;

    let mut bytes = Vec::with_capacity(size.min(limit) as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("无法读取文件 {}: {}", path.display(), e))?;
    ensure_file_size(bytes.len() as u64, limit)?;
    Ok(bytes)
}

fn reader_limit_for_path(path: &Path) -> u64 {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "md" | "markdown" | "mdown" | "mkd" | "txt"
    ) {
        MAX_TEXT_FILE_BYTES
    } else {
        MAX_READER_FILE_BYTES
    }
}

/// 读取 UTF-8 文本文件。io 错误映射为可读的中文错误信息。
pub fn read_file_impl(path: &Path) -> Result<String, String> {
    String::from_utf8(read_bounded(path, MAX_TEXT_FILE_BYTES)?)
        .map_err(|_| "文件不是有效的 UTF-8 文本".to_string())
}

/// 原子写入：先写同目录临时文件并 flush/sync，再 rename 覆盖目标。
///
/// 使用 `tempfile::NamedTempFile`：临时文件与目标同目录（保证 rename
/// 不跨文件系统）；`persist` 在 Windows 上走 MoveFileExW +
/// MOVEFILE_REPLACE_EXISTING，目标已存在时同样原子覆盖。任何一步失败，
/// `NamedTempFile` 的 Drop 会自动清理临时文件，目标路径绝不会留下
/// 半截文件，原文件保持不动。
pub fn write_file_impl(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("无效的保存路径: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("无法创建目录 {}: {}", parent.display(), e))?;

    let mut tmp =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("无法创建临时文件: {}", e))?;
    tmp.write_all(content.as_bytes())
        .map_err(|e| format!("写入临时文件失败: {}", e))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("同步临时文件失败: {}", e))?;
    tmp.persist(path)
        .map_err(|e| format!("无法保存到 {}: {}", path.display(), e.error))?;
    Ok(())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    read_file_impl(Path::new(&path))
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    write_file_impl(Path::new(&path), &content)
}

/// 文件 stat 结果（返回前端用于外部变更检测）：元数据加内容指纹。
#[derive(serde::Serialize, Debug)]
pub struct FileStat {
    pub mtime_ms: u64,
    pub size: u64,
    pub fingerprint: String,
}

fn fingerprint_reader(mut reader: impl Read) -> Result<String, std::io::Error> {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        for byte in &buffer[..count] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    Ok(format!("{:016x}", hash))
}

/// 取文件的修改时间、大小与内容指纹。读不到文件/修改时间时报可读中文错误
/// （R13 失败行为：stat 失败 → 前端提示文件不可读，不做自动动作）。
pub fn stat_file_impl(path: &Path) -> Result<FileStat, String> {
    let file =
        File::open(path).map_err(|e| format!("无法读取文件信息 {}: {}", path.display(), e))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("无法读取文件信息 {}: {}", path.display(), e))?;
    let mtime = meta
        .modified()
        .map_err(|e| format!("无法读取修改时间 {}: {}", path.display(), e))?;
    // mtime 早于 UNIX_EPOCH（极端情况）视为 0；正常文件不会触发。
    let mtime_ms = mtime
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let fingerprint = fingerprint_reader(file)
        .map_err(|e| format!("无法计算文件指纹 {}: {}", path.display(), e))?;
    Ok(FileStat {
        mtime_ms,
        size: meta.len(),
        fingerprint,
    })
}

#[tauri::command]
pub fn stat_file(path: String) -> Result<FileStat, String> {
    stat_file_impl(Path::new(&path))
}

/// 读取文件的原始字节（不做 UTF-8 解码，电子书多为二进制）。io 错误映射为可读中文信息。
pub fn read_file_bytes_impl(path: &Path) -> Result<Vec<u8>, String> {
    read_bounded(path, reader_limit_for_path(path))
}

/// 读取文件字节并经 tauri raw IPC 返回（`InvokeResponseBody::Raw`，前端 `invoke`
/// 直接得到 ArrayBuffer）。不再走 base64 字符串编码与前端 atob 逐字节解码：
/// Rust 侧峰值从 N + 4N/3 降到 N，JS 侧从 ~10N/3 降到 N。128MB/32MB 上限与
/// 错误语义与 `read_file_bytes_impl` 完全一致。
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = read_file_bytes_impl(Path::new(&path))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    // Response::body 来自 IpcResponse trait（消费 self），测试断言需引入。
    use tauri::ipc::IpcResponse;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    #[test]
    fn roundtrip_chinese_and_special_chars() {
        let dir = temp_dir();
        let path = dir.path().join("笔记.md");
        let content =
            "# 标题 🎉\n\n中文内容、特殊字符 <>&\"'\\、emoji 🚀、零宽\u{200b}字符。\n\n第二行\n";
        write_file_impl(&path, content).expect("write");
        let back = read_file_impl(&path).expect("read");
        assert_eq!(back, content);
    }

    #[test]
    fn atomic_write_replaces_existing() {
        let dir = temp_dir();
        let path = dir.path().join("a.md");
        write_file_impl(&path, "old content").expect("write old");
        write_file_impl(&path, "new content").expect("write new");
        assert_eq!(read_file_impl(&path).unwrap(), "new content");
        // 临时文件不应残留：目录里应只有目标文件
        let entries: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["a.md".to_string()], "unexpected leftovers");
    }

    #[test]
    fn failed_write_leaves_original_intact() {
        // 目标位于不存在的深层路径且父目录创建失败时：
        // 用一个「文件」当作目录，create_dir_all 必然失败。
        let dir = temp_dir();
        let blocker = dir.path().join("blocker");
        write_file_impl(&blocker, "i am a file").expect("write blocker");
        let bad_target = blocker.join("sub").join("x.md");
        let err = write_file_impl(&bad_target, "data").expect_err("must fail");
        assert!(err.contains("无法创建目录"), "unexpected error: {}", err);
        // 原文件不受影响
        assert_eq!(read_file_impl(&blocker).unwrap(), "i am a file");
        assert!(!bad_target.exists(), "partial file must not exist");
    }

    #[test]
    fn read_missing_file_reports_error() {
        let dir = temp_dir();
        let missing = dir.path().join("nope.md");
        let err = read_file_impl(&missing).expect_err("must fail");
        assert!(err.contains("无法读取文件"), "unexpected error: {}", err);
    }

    #[test]
    fn write_creates_missing_parent_dirs() {
        let dir = temp_dir();
        let path = dir.path().join("deep").join("nested").join("f.md");
        write_file_impl(&path, "hello").expect("write");
        assert_eq!(read_file_impl(&path).unwrap(), "hello");
    }

    #[test]
    fn stat_returns_mtime_and_size() {
        let dir = temp_dir();
        let path = dir.path().join("stat.md");
        let content = "# 笔记 📝\n中文内容\n";
        write_file_impl(&path, content).expect("write");
        let st = stat_file_impl(&path).expect("stat");
        assert_eq!(st.size, content.len() as u64);
        assert!(st.mtime_ms > 0, "mtime should be a real epoch ms");
        assert_eq!(st.fingerprint.len(), 16);
        write_file_impl(&path, "different").expect("replace");
        let changed = stat_file_impl(&path).expect("stat changed");
        assert_ne!(st.fingerprint, changed.fingerprint);
    }

    #[test]
    fn stat_missing_file_reports_error() {
        let dir = temp_dir();
        let missing = dir.path().join("nope.md");
        let err = stat_file_impl(&missing).expect_err("must fail");
        assert!(
            err.contains("无法读取文件信息"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn read_file_bytes_returns_raw_bytes() {
        let dir = temp_dir();
        let path = dir.path().join("book.epub");
        // 二进制内容（含非 UTF-8 字节）：read_file_bytes_impl 必须原样返回字节，不做 UTF-8 解码。
        let raw = [0x50u8, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80, 0x7f];
        std::fs::write(&path, raw).expect("write");
        let bytes = super::read_file_bytes_impl(&path).expect("read bytes");
        assert_eq!(bytes, raw.to_vec());
    }

    #[test]
    fn read_file_bytes_command_returns_raw_ipc_body() {
        // 命令层（T7）：read_file_bytes 必须经 raw IPC 返回原始字节，不产生 base64
        // 中间拷贝（`InvokeResponseBody::Json(String)` 视为回退到 JSON 通道）。
        let dir = temp_dir();
        let path = dir.path().join("book.epub");
        let raw = [0x50u8, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x80, 0x7f];
        std::fs::write(&path, raw).expect("write");
        let response =
            super::read_file_bytes(path.to_string_lossy().into_owned()).expect("read bytes");
        match response.body() {
            Ok(tauri::ipc::InvokeResponseBody::Raw(bytes)) => assert_eq!(bytes, raw),
            Ok(tauri::ipc::InvokeResponseBody::Json(json)) => {
                panic!("expected raw IPC body, got json: {json}")
            }
            Err(e) => panic!("ipc response body error: {e}"),
        }
    }

    #[test]
    fn read_file_bytes_command_preserves_error_semantics() {
        // 命令层错误语义与 impl 一致：缺失文件仍返回可读中文错误（含路径），
        // 超限仍返回 FILE_TOO_LARGE:actual:limit。
        let dir = temp_dir();
        let missing = dir.path().join("nope.epub");
        let err = match super::read_file_bytes(missing.to_string_lossy().into_owned()) {
            Ok(_) => panic!("missing file must fail"),
            Err(e) => e,
        };
        assert!(err.contains("无法读取文件"), "unexpected error: {}", err);

        let oversized = dir.path().join("oversized.epub");
        File::create(&oversized)
            .unwrap()
            .set_len(MAX_READER_FILE_BYTES + 1)
            .unwrap();
        let err = match super::read_file_bytes(oversized.to_string_lossy().into_owned()) {
            Ok(_) => panic!("oversized file must fail"),
            Err(e) => e,
        };
        assert!(
            err.starts_with("FILE_TOO_LARGE:"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn read_file_bytes_large_file_does_not_overflow() {
        // 大文件：整文件读入不 panic/溢出，字节与长度原样返回（无中间编码拷贝）。
        let dir = temp_dir();
        let path = dir.path().join("big.bin");
        let size = 1_000_003u64;
        let mut big = Vec::with_capacity(size as usize);
        let mut x = 1u8;
        for _ in 0..size {
            big.push(x);
            x = x.wrapping_mul(31).wrapping_add(1);
        }
        std::fs::write(&path, &big).expect("write");
        let bytes = super::read_file_bytes_impl(&path).expect("read");
        assert_eq!(bytes.len() as u64, size);
        assert_eq!(bytes, big);
    }

    #[test]
    fn read_file_bytes_missing_file_reports_error() {
        let dir = temp_dir();
        let missing = dir.path().join("nope.epub");
        let err = super::read_file_bytes_impl(&missing).expect_err("must fail");
        assert!(err.contains("无法读取文件"), "unexpected error: {}", err);
    }

    #[test]
    fn file_size_limits_accept_boundary_and_reject_one_extra_byte() {
        assert!(ensure_file_size(MAX_TEXT_FILE_BYTES, MAX_TEXT_FILE_BYTES).is_ok());
        assert_eq!(
            ensure_file_size(MAX_TEXT_FILE_BYTES + 1, MAX_TEXT_FILE_BYTES).unwrap_err(),
            format!(
                "FILE_TOO_LARGE:{}:{}",
                MAX_TEXT_FILE_BYTES + 1,
                MAX_TEXT_FILE_BYTES
            )
        );
        assert!(ensure_file_size(MAX_READER_FILE_BYTES, MAX_READER_FILE_BYTES).is_ok());
        assert!(ensure_file_size(MAX_READER_FILE_BYTES + 1, MAX_READER_FILE_BYTES).is_err());
    }

    #[test]
    fn oversized_files_are_rejected_before_allocation() {
        let dir = temp_dir();
        let text = dir.path().join("oversized.txt");
        File::create(&text)
            .unwrap()
            .set_len(MAX_TEXT_FILE_BYTES + 1)
            .unwrap();
        assert!(read_file_impl(&text)
            .unwrap_err()
            .starts_with("FILE_TOO_LARGE:"));

        let reader = dir.path().join("oversized.epub");
        File::create(&reader)
            .unwrap()
            .set_len(MAX_READER_FILE_BYTES + 1)
            .unwrap();
        assert!(read_file_bytes_impl(&reader)
            .unwrap_err()
            .starts_with("FILE_TOO_LARGE:"));
    }
}
