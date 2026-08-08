//! 字节级文件读写服务（T3）。
//!
//! Rust 侧只做 UTF-8 字节的读取与原子写入，不解析 Markdown —— 文档模型的
//! 唯一 owner 是前端编辑器会话。写入采用「同目录临时文件 + rename」的原子写
//! 策略：失败时清理临时文件并返回错误，目标路径上永远不会留下半截文件。

use std::fs;
use std::io::Write;
use std::path::Path;

/// 读取 UTF-8 文本文件。io 错误映射为可读的中文错误信息。
pub fn read_file_impl(path: &Path) -> Result<String, String> {
    fs::read_to_string(path)
        .map_err(|e| format!("无法读取文件 {}: {}", path.display(), e))
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
    fs::create_dir_all(parent)
        .map_err(|e| format!("无法创建目录 {}: {}", parent.display(), e))?;

    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("无法创建临时文件: {}", e))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    #[test]
    fn roundtrip_chinese_and_special_chars() {
        let dir = temp_dir();
        let path = dir.path().join("笔记.md");
        let content = "# 标题 🎉\n\n中文内容、特殊字符 <>&\"'\\、emoji 🚀、零宽\u{200b}字符。\n\n第二行\n";
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
}
