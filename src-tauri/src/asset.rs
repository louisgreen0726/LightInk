//! 图片资源持久化服务（T4，R3）。
//!
//! 唯一 owner：Rust 资源服务。前端把剪贴板/拖拽得到的图片字节以 base64
//! 字符串经 IPC 传入；本模块解码、校验扩展名白名单、生成唯一文件名并
//! 原子落盘：
//!   - 文档已保存（`doc_path` 为 Some）→ 写入 `<文档目录>/assets/`；
//!   - 文档未保存 → 写入应用数据目录下按会话隔离的暂存目录
//!     `staging-assets/<session_id>/`，保存（另存为）时由
//!     `migrate_staging_assets` 迁移进 `<文档目录>/assets/`。
//!
//! 两种情况下返回给前端的引用都是相对路径 `assets/<name>.<ext>`：暂存期
//! 与迁移后的引用形式一致，迁移只是搬动文件，文档内容无需改写；移动整个
//! 文档目录（文档 + assets/ 一起）引用也不丢失。
//!
//! base64 解码器为本模块自带实现（约 60 行，含完整单测），避免引入新
//! crate；纯逻辑均接受可注入的目录参数以便单元测试，Tauri 命令层负责
//! 解析应用数据目录（与 snapshot.rs 同一约定）。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 文档旁的图片目录名；文档内引用形如 `assets/<name>.<ext>`。
const ASSETS_DIR_NAME: &str = "assets";
/// 应用数据目录下的暂存根目录名（未保存文档的图片先落这里）。
const STAGING_DIR_NAME: &str = "staging-assets";
/// 允许的图片扩展名白名单（小写）。svg 经 `<img>` 渲染，不内联解析。
const ALLOWED_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

/// 进程内单调计数器：与毫秒时间戳、内容哈希共同保证文件名唯一
///（同一毫秒连发多张图也不冲突）。
static NAME_COUNTER: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// base64 解码（自实现，无新 crate）
// ---------------------------------------------------------------------------

/// 解码标准 base64（含 `+` `/` 与 `=` 填充）。拒绝非法字符、非法填充
/// 位置与非 4 倍数长度；空输入解码为空字节串。
pub fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    fn value_of(b: u8) -> Result<u32, String> {
        match b {
            b'A'..=b'Z' => Ok(u32::from(b - b'A')),
            b'a'..=b'z' => Ok(u32::from(b - b'a') + 26),
            b'0'..=b'9' => Ok(u32::from(b - b'0') + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("非法的 base64 字符: 0x{:02x}", b)),
        }
    }

    let bytes = input.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err("base64 长度必须是 4 的倍数".to_owned());
    }
    let chunk_count = bytes.len() / 4;
    let mut out = Vec::with_capacity(chunk_count * 3);
    for (i, chunk) in bytes.chunks(4).enumerate() {
        let is_last = i == chunk_count - 1;
        let pad = if is_last && chunk[3] == b'=' {
            if chunk[2] == b'=' {
                2
            } else {
                1
            }
        } else {
            0
        };
        for &c in chunk {
            if c == b'=' && !(is_last && pad > 0) {
                return Err("base64 填充只能出现在末尾".to_owned());
            }
        }
        let v0 = value_of(chunk[0])?;
        let v1 = value_of(chunk[1])?;
        let v2 = if pad >= 2 { 0 } else { value_of(chunk[2])? };
        let v3 = if pad >= 1 { 0 } else { value_of(chunk[3])? };
        let triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
        out.push((triple >> 16) as u8);
        if pad < 2 {
            out.push((triple >> 8) as u8);
        }
        if pad < 1 {
            out.push(triple as u8);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 纯逻辑（可注入目录，便于测试）
// ---------------------------------------------------------------------------

/// 校验扩展名白名单：小写化、拒绝带点/路径分隔符，必须在白名单内。
fn validate_ext(ext: &str) -> Result<String, String> {
    let lowered = ext.trim().to_lowercase();
    if lowered.is_empty()
        || lowered.contains('.')
        || lowered.contains('/')
        || lowered.contains('\\')
    {
        return Err(format!("非法的图片扩展名: {:?}", ext));
    }
    if !ALLOWED_EXTS.contains(&lowered.as_str()) {
        return Err(format!(
            "不支持的图片格式 .{}（仅支持: {}）",
            lowered,
            ALLOWED_EXTS.join("/")
        ));
    }
    Ok(lowered)
}

/// FNV-1a 64-bit（与 snapshot.rs 同一哈希，跨运行稳定）。
fn fnv64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 唯一文件名（不含扩展名）：`img-<毫秒时间戳>-<计数器>-<内容哈希8位>`。
fn unique_asset_name(bytes: &[u8]) -> String {
    let ms = now_ms();
    let counter = NAME_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "img-{:x}-{:x}-{:08x}",
        ms,
        counter,
        fnv64(bytes) & 0xffff_ffff
    )
}

/// 会话 id 消毒：只保留字母数字/`-`/`_`，其余替换为 `_`，杜绝路径穿越。
fn sanitize_session_id(session_id: &str) -> Result<String, String> {
    let cleaned: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        return Err("会话 id 不能为空".to_owned());
    }
    Ok(cleaned)
}

/// 原子写字节版（与 file.rs 的字符串版同一策略：同目录临时文件 +
/// flush/sync + rename；失败时 NamedTempFile 自动清理，不留半截文件）。
/// file.rs 不在本任务 scope，故字节变体放在这里。
fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("无效的保存路径: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("无法创建目录 {}: {}", parent.display(), e))?;

    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("无法创建临时文件: {}", e))?;
    tmp.write_all(bytes)
        .map_err(|e| format!("写入临时文件失败: {}", e))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("同步临时文件失败: {}", e))?;
    tmp.persist(path)
        .map_err(|e| format!("无法保存到 {}: {}", path.display(), e.error))?;
    Ok(())
}

/// 保存图片字节，返回文档内使用的相对引用 `assets/<name>.<ext>`。
///
/// - `doc_dir` 为 Some：写入 `<doc_dir>/assets/`；
/// - 为 None（文档未保存）：写入 `<staging_root>/staging-assets/<session_id>/`，
///   返回同样的相对引用 —— 保存时 `migrate_staging_assets_impl` 按原名
///   搬入 `<文档目录>/assets/`，引用保持有效。
pub fn save_asset_impl(
    doc_dir: Option<&Path>,
    staging_root: &Path,
    session_id: &str,
    bytes: &[u8],
    ext: &str,
) -> Result<String, String> {
    let ext = validate_ext(ext)?;
    if bytes.is_empty() {
        return Err("图片内容为空，未保存".to_owned());
    }
    let name = format!("{}.{}", unique_asset_name(bytes), ext);
    let dir = match doc_dir {
        Some(d) => d.join(ASSETS_DIR_NAME),
        None => staging_root
            .join(STAGING_DIR_NAME)
            .join(sanitize_session_id(session_id)?),
    };
    write_bytes_atomic(&dir.join(&name), bytes)?;
    Ok(format!("{}/{}", ASSETS_DIR_NAME, name))
}

/// 把某会话暂存目录里的全部图片搬入 `<doc_path 父目录>/assets/`（按原名
/// 移动，跨设备时回退 copy+delete），返回迁移后的相对引用列表（排序后）。
/// 暂存目录不存在视为无事可做（Ok(空)）；搬空后删除会话目录。
pub fn migrate_staging_assets_impl(
    staging_root: &Path,
    session_id: &str,
    doc_path: &str,
) -> Result<Vec<String>, String> {
    let staging = staging_root
        .join(STAGING_DIR_NAME)
        .join(sanitize_session_id(session_id)?);
    if !staging.exists() {
        return Ok(Vec::new());
    }
    let doc_dir = Path::new(doc_path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("无效的文档路径: {}", doc_path))?;
    let target_dir = doc_dir.join(ASSETS_DIR_NAME);
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("无法创建目录 {}: {}", target_dir.display(), e))?;

    let mut moved: Vec<String> = Vec::new();
    let entries = fs::read_dir(&staging)
        .map_err(|e| format!("无法读取暂存目录 {}: {}", staging.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("无法读取暂存目录项: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("无法读取暂存文件类型: {}", e))?;
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name();
        let target = target_dir.join(&name);
        if fs::rename(entry.path(), &target).is_err() {
            // 跨文件系统等 rename 失败场景：回退 copy + delete。
            fs::copy(entry.path(), &target).map_err(|e| {
                format!("无法迁移暂存图片到 {}: {}", target.display(), e)
            })?;
            fs::remove_file(entry.path())
                .map_err(|e| format!("无法清理暂存图片: {}", e))?;
        }
        moved.push(format!("{}/{}", ASSETS_DIR_NAME, name.to_string_lossy()));
    }
    // 搬空后移除会话目录（删不掉不阻断，留空目录无害）。
    let _ = fs::remove_dir(&staging);
    moved.sort();
    Ok(moved)
}

/// 解析应用数据目录：优先 Tauri app_data_dir，失败回退系统临时目录
/// （与 snapshot.rs 同一约定）。
fn resolve_base_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("lightink"))
}

// ---------------------------------------------------------------------------
// Tauri 命令层
// ---------------------------------------------------------------------------

/// 保存粘贴/拖拽进来的图片。`doc_path` 为 None 时落暂存目录。
/// 成功返回相对引用 `assets/<name>.<ext>`；失败返回错误且不落任何文件，
/// 前端据此决定不插入引用。
#[tauri::command]
pub fn save_asset(
    app: tauri::AppHandle,
    doc_path: Option<String>,
    session_id: String,
    bytes_base64: String,
    ext: String,
) -> Result<String, String> {
    let bytes = decode_base64(&bytes_base64)?;
    let staging_root = resolve_base_dir(&app);
    let doc_dir = match doc_path.as_deref() {
        Some(p) => Some(
            Path::new(p)
                .parent()
                .filter(|d| !d.as_os_str().is_empty())
                .ok_or_else(|| format!("无效的文档路径: {}", p))?
                .to_path_buf(),
        ),
        None => None,
    };
    save_asset_impl(
        doc_dir.as_deref(),
        &staging_root,
        &session_id,
        &bytes,
        &ext,
    )
}

/// 文档首次保存（另存为）后调用：把该会话暂存的图片迁移到文档旁的
/// assets/ 目录。返回迁移后的相对引用列表。
#[tauri::command]
pub fn migrate_staging_assets(
    app: tauri::AppHandle,
    session_id: String,
    doc_path: String,
) -> Result<Vec<String>, String> {
    migrate_staging_assets_impl(&resolve_base_dir(&app), &session_id, &doc_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    // -- base64 --

    #[test]
    fn base64_roundtrip_vectors() {
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
        assert_eq!(decode_base64("SGVsbG8=").unwrap(), b"Hello");
        assert_eq!(decode_base64("SGVsbG8h").unwrap(), b"Hello!");
        assert_eq!(decode_base64("8J+OrQ==").unwrap(), "🎭".as_bytes());
        // 含 + 与 /
        assert_eq!(decode_base64("+/8=").unwrap(), vec![0xfb, 0xff]);
    }

    #[test]
    fn base64_rejects_invalid() {
        assert!(decode_base64("SGVsbG8").is_err(), "非 4 倍数长度");
        assert!(decode_base64("SGVs bG8=").is_err(), "含空格");
        assert!(decode_base64("S=Vs").is_err(), "填充不在末尾");
        assert!(decode_base64("====").is_err(), "纯填充");
        assert!(decode_base64("SG*sbG8=").is_err(), "非法字符");
    }

    // -- ext 白名单 --

    #[test]
    fn ext_whitelist() {
        for ok in ["png", "PNG", " jpg ", "jpeg", "gif", "webp", "svg"] {
            assert!(validate_ext(ok).is_ok(), "should accept {}", ok);
        }
        for bad in ["exe", "html", ".png", "p/ng", "p\\ng", "", "js"] {
            assert!(validate_ext(bad).is_err(), "should reject {:?}", bad);
        }
    }

    // -- 保存 --

    #[test]
    fn save_to_doc_dir_writes_assets_and_returns_relative_path() {
        let dir = temp_dir();
        let doc_dir = dir.path().join("docs");
        let rel = save_asset_impl(
            Some(&doc_dir),
            dir.path(),
            "untitled-x",
            b"\x89PNG fake",
            "png",
        )
        .expect("save");
        assert!(rel.starts_with("assets/"), "rel = {}", rel);
        assert!(rel.ends_with(".png"));
        let on_disk = doc_dir.join(&rel);
        assert_eq!(fs::read(&on_disk).unwrap(), b"\x89PNG fake");
    }

    #[test]
    fn save_without_doc_goes_to_session_staging() {
        let dir = temp_dir();
        let rel = save_asset_impl(None, dir.path(), "untitled-ab12", b"GIF89a", "gif")
            .expect("save");
        assert!(rel.starts_with("assets/") && rel.ends_with(".gif"));
        let file_name = rel.strip_prefix("assets/").unwrap();
        let staged = dir
            .path()
            .join(STAGING_DIR_NAME)
            .join("untitled-ab12")
            .join(file_name);
        assert_eq!(fs::read(&staged).unwrap(), b"GIF89a");
    }

    #[test]
    fn same_bytes_saved_twice_get_unique_names() {
        let dir = temp_dir();
        let a = save_asset_impl(Some(dir.path()), dir.path(), "s", b"same", "png").unwrap();
        let b = save_asset_impl(Some(dir.path()), dir.path(), "s", b"same", "png").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn failed_save_returns_error_and_leaves_nothing() {
        let dir = temp_dir();
        // 用一个「文件」挡住目录创建，写入必然失败。
        let blocker = dir.path().join("blocker");
        fs::write(&blocker, b"i am a file").unwrap();
        let doc_dir = blocker.join("sub");
        let err = save_asset_impl(Some(&doc_dir), dir.path(), "s", b"data", "png")
            .expect_err("must fail");
        assert!(err.contains("无法创建目录"), "unexpected: {}", err);
        assert!(!doc_dir.join(ASSETS_DIR_NAME).exists());
    }

    #[test]
    fn rejects_empty_bytes_and_bad_ext_before_writing() {
        let dir = temp_dir();
        assert!(save_asset_impl(Some(dir.path()), dir.path(), "s", b"", "png").is_err());
        assert!(save_asset_impl(Some(dir.path()), dir.path(), "s", b"x", "exe").is_err());
        assert!(!dir.path().join(ASSETS_DIR_NAME).exists());
    }

    #[test]
    fn session_id_is_sanitized_against_traversal() {
        let dir = temp_dir();
        let rel = save_asset_impl(None, dir.path(), "../evil/../x", b"data", "png").unwrap();
        let file_name = rel.strip_prefix("assets/").unwrap();
        // 消毒后不会逃出 staging 根目录
        let staged_root = dir.path().join(STAGING_DIR_NAME);
        let mut found = false;
        for entry in fs::read_dir(&staged_root).unwrap() {
            let session = entry.unwrap();
            let candidate = session.path().join(file_name);
            if candidate.exists() {
                assert!(candidate.starts_with(&staged_root));
                found = true;
            }
        }
        assert!(found, "sanitized staging file must exist under staging root");
        assert!(save_asset_impl(None, dir.path(), "", b"data", "png").is_err());
    }

    // -- 迁移 --

    #[test]
    fn migrate_moves_staged_files_into_doc_assets() {
        let dir = temp_dir();
        let session = "untitled-m1";
        let rel_a = save_asset_impl(None, dir.path(), session, b"png-a", "png").unwrap();
        let rel_b = save_asset_impl(None, dir.path(), session, b"png-b", "png").unwrap();

        let doc_path = dir.path().join("docs").join("笔记.md");
        fs::create_dir_all(doc_path.parent().unwrap()).unwrap();
        let moved = migrate_staging_assets_impl(
            dir.path(),
            session,
            &doc_path.to_string_lossy(),
        )
        .expect("migrate");
        assert_eq!(moved, {
            let mut v = vec![rel_a.clone(), rel_b.clone()];
            v.sort();
            v
        });
        // 文件已按原名落在文档旁 assets/，内容一致
        let doc_dir = doc_path.parent().unwrap();
        assert_eq!(fs::read(doc_dir.join(&rel_a)).unwrap(), b"png-a");
        assert_eq!(fs::read(doc_dir.join(&rel_b)).unwrap(), b"png-b");
        // 暂存目录已清空移除
        assert!(!dir.path().join(STAGING_DIR_NAME).join(session).exists());
    }

    #[test]
    fn migrate_without_staging_is_noop() {
        let dir = temp_dir();
        let doc = dir.path().join("a.md");
        let moved =
            migrate_staging_assets_impl(dir.path(), "never-staged", &doc.to_string_lossy())
                .expect("noop migrate");
        assert!(moved.is_empty());
    }

    #[test]
    fn migrate_rejects_doc_path_without_parent() {
        let dir = temp_dir();
        let session = "untitled-m2";
        save_asset_impl(None, dir.path(), session, b"x", "png").unwrap();
        assert!(migrate_staging_assets_impl(dir.path(), session, "").is_err());
    }
}
