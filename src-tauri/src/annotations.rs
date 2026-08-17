//! 标注持久化（ebook-reader T6 / R4 / R5）。
//!
//! 标注按「文件内容哈希」关联，存 `<app_data_dir>/annotations/<hash>.json`，
//! 原子写（复用 [`crate::file::write_file_impl`]）。缺失或不可读视为空标注
//! （R4：损坏/缺失不阻断阅读）；标注读写永不触碰源电子书文件。
//!
//! JSON 对 Rust 不透明：备注、颜色等字段由前端 schema 拥有；改备注或删除是
//! 整文件覆写，不在此升跨书索引或「全部标注」目录。
//!
//! 内容哈希由本模块的 [`content_hash`] 命令在 Rust 侧计算（读字节 +
//! [`crate::asset::content_hash_hex`]，FNV-1a 64-bit）；`read_annotations` /
//! `write_annotations` 接收该哈希作为存储 key，只负责按 key 读写 JSON。

use std::fs;
use std::path::Path;

use crate::identifiers::validate_content_hash;

const ANNOTATIONS_DIR: &str = "annotations";

/// 标注文件路径：`<base_dir>/annotations/<content_hash>.json`。
fn annotations_path(base_dir: &Path, content_hash: &str) -> Result<std::path::PathBuf, String> {
    let content_hash = validate_content_hash(content_hash)?;
    Ok(base_dir
        .join(ANNOTATIONS_DIR)
        .join(format!("{}.json", content_hash)))
}

/// 读标注 JSON。文件缺失或不可读返回空串（视为无标注，不报错、不阻断）。
pub fn read_annotations_impl(base_dir: &Path, content_hash: &str) -> Result<String, String> {
    let path = annotations_path(base_dir, content_hash)?;
    if !path.exists() {
        return Ok(String::new());
    }
    // 读失败（权限等）同样视为空，避免阻断阅读。
    Ok(fs::read_to_string(&path).unwrap_or_default())
}

/// 原子写标注 JSON（创建 annotations 目录，复用 file::write_file_impl 的原子写）。
pub fn write_annotations_impl(
    base_dir: &Path,
    content_hash: &str,
    json: &str,
) -> Result<(), String> {
    let path = annotations_path(base_dir, content_hash)?;
    let dir = base_dir.join(ANNOTATIONS_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建标注目录: {}", e))?;
    crate::file::write_file_impl(&path, json)
}

fn resolve_base_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("lightink"))
}

#[tauri::command]
pub fn read_annotations(app: tauri::AppHandle, content_hash: String) -> Result<String, String> {
    read_annotations_impl(&resolve_base_dir(&app), &content_hash)
}

/// 计算文件内容哈希（FNV-1a 64-bit → 16 hex），作为标注存储 key。
/// 供前端按内容特征关联标注（R4）；读字节与哈希都在 Rust 侧，避免 JS 大文件 BigInt 开销。
#[tauri::command]
pub fn content_hash(path: String) -> Result<String, String> {
    let bytes = crate::file::read_file_bytes_impl(std::path::Path::new(&path))?;
    Ok(crate::asset::content_hash_hex(&bytes))
}

#[tauri::command]
pub fn write_annotations(
    app: tauri::AppHandle,
    content_hash: String,
    json: String,
) -> Result<(), String> {
    write_annotations_impl(&resolve_base_dir(&app), &content_hash, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH_A: &str = "0123456789abcdef";
    const HASH_B: &str = "fedcba9876543210";

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    #[test]
    fn missing_annotations_return_empty() {
        let dir = temp_dir();
        let got = read_annotations_impl(dir.path(), HASH_A).unwrap();
        assert_eq!(got, "");
    }

    #[test]
    fn write_then_read_roundtrip() {
        let dir = temp_dir();
        let json = r#"{"annotations":[{"id":"a1","kind":"highlight"}]}"#;
        write_annotations_impl(dir.path(), HASH_A, json).unwrap();
        let back = read_annotations_impl(dir.path(), HASH_A).unwrap();
        assert_eq!(back, json);
    }

    #[test]
    fn distinct_content_hashes_isolate_storage() {
        let dir = temp_dir();
        write_annotations_impl(dir.path(), HASH_A, r#"{"a":1}"#).unwrap();
        write_annotations_impl(dir.path(), HASH_B, r#"{"b":2}"#).unwrap();
        assert_ne!(
            read_annotations_impl(dir.path(), HASH_A).unwrap(),
            read_annotations_impl(dir.path(), HASH_B).unwrap()
        );
    }

    #[test]
    fn annotations_dir_is_created() {
        let dir = temp_dir();
        write_annotations_impl(dir.path(), HASH_A, "{}").unwrap();
        assert!(dir
            .path()
            .join(ANNOTATIONS_DIR)
            .join(format!("{HASH_A}.json"))
            .exists());
    }

    #[test]
    fn unreadable_or_corrupt_file_yields_empty_not_error() {
        let dir = temp_dir();
        // 损坏 JSON（非法字节序列对 read_to_string 而言仍可读为字符串）：
        // 这里写一段非 UTF-8 字节会令 read_to_string 失败 → 视为空。
        let path = dir.path().join(ANNOTATIONS_DIR);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join(format!("{HASH_A}.json")), b"\xff\xfe\x00").unwrap();
        // read_to_string 对非 UTF-8 失败 → unwrap_or_default 返回 ""。
        let got = read_annotations_impl(dir.path(), HASH_A).unwrap();
        assert_eq!(got, "");
    }

    #[test]
    fn rejects_invalid_content_hashes_before_path_construction() {
        let dir = temp_dir();
        for hash in ["", "ABCDEF0123456789", "../annotations", "0123456789abcde"] {
            assert!(read_annotations_impl(dir.path(), hash).is_err());
            assert!(write_annotations_impl(dir.path(), hash, "{}").is_err());
        }
        assert!(!dir.path().join(ANNOTATIONS_DIR).exists());
    }

    #[test]
    fn note_and_color_overwrite_stays_per_hash() {
        // R5：改备注/颜色是整文件覆写；只动本书 key，不写跨书总库。
        let dir = temp_dir();
        let original = r##"{"version":2,"annotations":[{"id":"n1","kind":"note","note":"旧备注","color":"#86c28b"}]}"##;
        let updated = r##"{"version":2,"annotations":[{"id":"n1","kind":"note","note":"新备注","color":"#7eb6d9"}]}"##;
        write_annotations_impl(dir.path(), HASH_A, original).unwrap();
        write_annotations_impl(
            dir.path(),
            HASH_B,
            r#"{"version":2,"annotations":[{"id":"b1"}]}"#,
        )
        .unwrap();
        write_annotations_impl(dir.path(), HASH_A, updated).unwrap();
        assert_eq!(read_annotations_impl(dir.path(), HASH_A).unwrap(), updated);
        assert_eq!(
            read_annotations_impl(dir.path(), HASH_B).unwrap(),
            r#"{"version":2,"annotations":[{"id":"b1"}]}"#
        );
    }

    #[test]
    fn delete_overwrite_does_not_create_cross_book_index() {
        let dir = temp_dir();
        write_annotations_impl(
            dir.path(),
            HASH_A,
            r##"{"version":2,"annotations":[{"id":"a1","kind":"highlight","color":"#f2d675"}]}"##,
        )
        .unwrap();
        write_annotations_impl(
            dir.path(),
            HASH_B,
            r#"{"version":2,"annotations":[{"id":"b1","kind":"note","note":"留着"}]}"#,
        )
        .unwrap();
        write_annotations_impl(dir.path(), HASH_A, r#"{"version":2,"annotations":[]}"#).unwrap();

        let names: Vec<String> = fs::read_dir(dir.path().join(ANNOTATIONS_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&format!("{HASH_A}.json")));
        assert!(names.contains(&format!("{HASH_B}.json")));
        assert!(!names
            .iter()
            .any(|name| name == "index.json" || name == "all.json"));
        assert_eq!(
            read_annotations_impl(dir.path(), HASH_A).unwrap(),
            r#"{"version":2,"annotations":[]}"#
        );
        assert_eq!(
            read_annotations_impl(dir.path(), HASH_B).unwrap(),
            r#"{"version":2,"annotations":[{"id":"b1","kind":"note","note":"留着"}]}"#
        );
    }

    #[test]
    fn write_annotations_does_not_touch_source_file() {
        // R4：标注全程不写源文件。用源内容的哈希作 key 写标注，断言源内容/mtime 不变。
        let dir = temp_dir();
        let src = dir.path().join("book.epub");
        let content = b"SOURCE-BYTES";
        fs::write(&src, content).unwrap();
        let mtime_before = fs::metadata(&src).unwrap().modified().unwrap();
        let hash = crate::asset::content_hash_hex(content);
        write_annotations_impl(dir.path(), &hash, r#"{"version":1,"annotations":[]}"#).unwrap();
        assert_eq!(
            fs::read(&src).unwrap(),
            content,
            "source content must not change"
        );
        let mtime_after = fs::metadata(&src).unwrap().modified().unwrap();
        assert_eq!(mtime_before, mtime_after, "source mtime must not change");
        // 标注确实写到了 annotations/<hash>.json，而非源文件。
        assert!(dir
            .path()
            .join(ANNOTATIONS_DIR)
            .join(format!("{hash}.json"))
            .exists());
    }
}
