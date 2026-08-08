//! 导出辅助服务（T10，R5）。
//!
//! 导出 HTML / PDF 的唯一 Rust 侧需求：把文档引用的**相对路径图片**
//! （`assets/<name>.<ext>`）读成 base64，供前端内嵌为 data URI 生成
//! 独立 HTML。PDF 打印管线与样式内嵌全部在前端完成（见
//! src/export/pdf-export.ts），这里不做 PDF 生成。
//!
//! 路径解析规则（与 asset.rs 的落盘布局对应）：
//!   - 文档已保存（`doc_path` 为 Some）→ 相对 `<文档目录>/` 解析；
//!   - 文档未保存 → 相对应用数据目录下 `staging-assets/<session_id>/`
//!     解析，此时相对路径必须位于 `assets/` 前缀之下（剥离前缀后即为
//!     暂存目录内的文件名）。
//!
//! 安全：相对路径逐段校验，拒绝 `..`、盘符/UNC、绝对路径段，杜绝路径
//! 穿越；会话 id 消毒规则与 asset.rs 一致。base64 编码器为本模块自带
//! 实现（asset.rs 只有解码器），不引入新 crate。

use std::fs;
use std::path::{Path, PathBuf};

/// 文档旁的图片目录名（与 asset.rs 同一约定）。
const ASSETS_DIR_NAME: &str = "assets";
/// 应用数据目录下的暂存根目录名（与 asset.rs 同一约定）。
const STAGING_DIR_NAME: &str = "staging-assets";

// ---------------------------------------------------------------------------
// base64 编码（自实现，无新 crate）
// ---------------------------------------------------------------------------

/// 编码标准 base64（含 `=` 填充；空输入编码为空串）。
pub fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b2 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

// ---------------------------------------------------------------------------
// 纯逻辑（可注入目录，便于测试）
// ---------------------------------------------------------------------------

/// 相对路径消毒：按 `/` 与 `\` 切段，剔除空段与 `.`，拒绝 `..` 与含
/// 盘符/冒号的段。返回安全的相对段序列；空路径报错。
fn sanitize_rel_path(rel_path: &str) -> Result<Vec<String>, String> {
    let mut parts: Vec<String> = Vec::new();
    for seg in rel_path.split(['/', '\\']) {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." || seg.contains(':') {
            return Err(format!("非法的图片相对路径: {:?}", rel_path));
        }
        parts.push(seg.to_owned());
    }
    if parts.is_empty() {
        return Err("图片相对路径不能为空".to_owned());
    }
    Ok(parts)
}

/// 会话 id 消毒（与 asset.rs 同一规则）：只保留字母数字/`-`/`_`。
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

/// 读取相对路径图片并返回 base64。
///
/// - `doc_dir` 为 Some：解析 `<doc_dir>/<rel_path>`；
/// - 为 None（文档未保存）：`rel_path` 必须以 `assets/` 开头，剥离后解析
///   `<staging_root>/staging-assets/<session_id>/<name>`；`session_id`
///   缺失时报错。
/// 导出图片读取上限：超过即拒绝（全量读入 + base64 会放大约 4/3 倍并
/// 经 IPC 返回，超大文件会导致卡顿/内存峰值）。
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

pub fn read_image_base64_impl(
    doc_dir: Option<&Path>,
    staging_root: &Path,
    session_id: Option<&str>,
    rel_path: &str,
) -> Result<String, String> {
    let parts = sanitize_rel_path(rel_path)?;
    let full: PathBuf = match doc_dir {
        Some(dir) => parts.iter().fold(dir.to_path_buf(), |acc, p| acc.join(p)),
        None => {
            let session = session_id
                .ok_or_else(|| "文档未保存且缺少会话 id，无法定位暂存图片".to_owned())?;
            if parts.first().map(String::as_str) != Some(ASSETS_DIR_NAME) || parts.len() < 2 {
                return Err(format!(
                    "暂存图片路径必须位于 {}/ 之下: {:?}",
                    ASSETS_DIR_NAME, rel_path
                ));
            }
            let mut base = staging_root
                .join(STAGING_DIR_NAME)
                .join(sanitize_session_id(session)?);
            for part in &parts[1..] {
                base = base.join(part);
            }
            base
        }
    };
    let size = fs::metadata(&full)
        .map_err(|e| format!("无法读取图片 {}: {}", full.display(), e))?
        .len();
    if size > MAX_IMAGE_BYTES {
        return Err(format!(
            "图片过大（{} 字节，上限 {} 字节）: {}",
            size,
            MAX_IMAGE_BYTES,
            full.display()
        ));
    }
    let bytes =
        fs::read(&full).map_err(|e| format!("无法读取图片 {}: {}", full.display(), e))?;
    Ok(encode_base64(&bytes))
}

/// 解析应用数据目录：优先 Tauri app_data_dir，失败回退系统临时目录
/// （与 asset.rs / snapshot.rs 同一约定）。
fn resolve_base_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("lightink"))
}

// ---------------------------------------------------------------------------
// Tauri 命令层
// ---------------------------------------------------------------------------

/// 读取文档引用的相对路径图片，返回 base64（MIME 由前端按扩展名推导）。
/// `doc_path` 为 None 时按 `session_id` 的暂存目录解析。
#[tauri::command]
pub fn read_image_base64(
    app: tauri::AppHandle,
    doc_path: Option<String>,
    session_id: Option<String>,
    rel_path: String,
) -> Result<String, String> {
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
    read_image_base64_impl(
        doc_dir.as_deref(),
        &resolve_base_dir(&app),
        session_id.as_deref(),
        &rel_path,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    // -- base64 编码（与 asset.rs 解码测试向量互逆） --

    #[test]
    fn base64_encode_vectors() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"Hello"), "SGVsbG8=");
        assert_eq!(encode_base64(b"Hello!"), "SGVsbG8h");
        assert_eq!(encode_base64("🎭".as_bytes()), "8J+OrQ==");
        assert_eq!(encode_base64(&[0xfb, 0xff]), "+/8=");
        // 与解码器 roundtrip
        let data: Vec<u8> = (0u16..=255).map(|b| b as u8).collect();
        assert_eq!(
            crate::asset::decode_base64(&encode_base64(&data)).unwrap(),
            data
        );
    }

    // -- 相对路径消毒 --

    #[test]
    fn rel_path_sanitization() {
        assert_eq!(
            sanitize_rel_path("assets/img-a.png").unwrap(),
            vec!["assets", "img-a.png"]
        );
        // 反斜杠与冗余段归一
        assert_eq!(
            sanitize_rel_path("assets\\./sub\\x.png").unwrap(),
            vec!["assets", "sub", "x.png"]
        );
        for bad in ["../x.png", "assets/../../etc", "C:/x.png", "", "./"] {
            assert!(sanitize_rel_path(bad).is_err(), "should reject {:?}", bad);
        }
    }

    // -- 读取 --

    #[test]
    fn reads_image_relative_to_doc_dir() {
        let dir = temp_dir();
        let doc_dir = dir.path().join("docs");
        fs::create_dir_all(doc_dir.join("assets")).unwrap();
        fs::write(doc_dir.join("assets").join("a.png"), b"\x89PNG fake").unwrap();
        let b64 = read_image_base64_impl(Some(&doc_dir), dir.path(), None, "assets/a.png")
            .expect("read");
        assert_eq!(b64, encode_base64(b"\x89PNG fake"));
    }

    #[test]
    fn reads_image_from_session_staging_when_unsaved() {
        let dir = temp_dir();
        let staged = dir
            .path()
            .join(STAGING_DIR_NAME)
            .join("untitled-ab12");
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("b.gif"), b"GIF89a").unwrap();
        let b64 = read_image_base64_impl(None, dir.path(), Some("untitled-ab12"), "assets/b.gif")
            .expect("read staged");
        assert_eq!(b64, encode_base64(b"GIF89a"));
    }

    #[test]
    fn unsaved_requires_session_and_assets_prefix() {
        let dir = temp_dir();
        // 缺 session id
        assert!(read_image_base64_impl(None, dir.path(), None, "assets/a.png").is_err());
        // 暂存模式拒绝 assets/ 之外的路径
        assert!(
            read_image_base64_impl(None, dir.path(), Some("s"), "other/a.png").is_err()
        );
    }

    #[test]
    fn rejects_traversal_and_reports_missing() {
        let dir = temp_dir();
        let doc_dir = dir.path().join("docs");
        fs::create_dir_all(&doc_dir).unwrap();
        assert!(
            read_image_base64_impl(Some(&doc_dir), dir.path(), None, "../secret.png").is_err()
        );
        let err = read_image_base64_impl(Some(&doc_dir), dir.path(), None, "assets/nope.png")
            .expect_err("must fail");
        assert!(err.contains("无法读取图片"), "unexpected: {}", err);
    }

    #[test]
    fn staging_session_id_is_sanitized() {
        let dir = temp_dir();
        let cleaned = "___evil____x"; // "../evil/../x" 消毒后
        let staged = dir.path().join(STAGING_DIR_NAME).join(cleaned);
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("c.png"), b"png-c").unwrap();
        let b64 = read_image_base64_impl(None, dir.path(), Some("../evil/../x"), "assets/c.png")
            .expect("read with sanitized session");
        assert_eq!(b64, encode_base64(b"png-c"));
    }

    #[test]
    fn rejects_oversized_image() {
        let dir = temp_dir();
        let doc_dir = dir.path().join("docs");
        fs::create_dir_all(doc_dir.join("assets")).unwrap();
        // 用稀疏文件快速构造超限体积
        let big = doc_dir.join("assets").join("big.png");
        let f = fs::File::create(&big).unwrap();
        f.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        drop(f);
        let err = read_image_base64_impl(Some(&doc_dir), dir.path(), None, "assets/big.png")
            .expect_err("must fail on oversize");
        assert!(err.contains("图片过大"), "unexpected: {}", err);
    }
}
