//! 崩溃恢复快照服务（T3）。
//!
//! 唯一 owner：Rust 快照服务。前端在编辑防抖后写入本地快照（应用数据目录
//! `snapshots/` 下，按文件路径的稳定哈希命名）；意外退出后重启时检测
//! 「快照比磁盘文件新」并提示恢复；正常保存/关闭后删除对应快照。
//!
//! 纯函数均接受可注入的 `base_dir` 以便单元测试；Tauri 命令层负责解析
//! 应用数据目录（失败时回退到系统临时目录）。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::file::write_file_impl;

const SNAPSHOT_DIR_NAME: &str = "snapshots";
const SNAPSHOT_EXT: &str = "snapshot";

/// FNV-1a 64-bit 哈希 —— 跨进程/跨运行稳定（std 的 DefaultHasher 不保证
/// 稳定，不能用于持久化命名）。对规范化后的路径字符串计算，输出 hex。
fn stable_path_hash(file_path: &str) -> String {
    // 规范化：统一为反斜杠小写（Windows 路径大小写不敏感），去掉结尾分隔符，
    // 使同一路径的不同写法映射到同一快照。
    let normalized = file_path
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in normalized.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}", hash)
}

/// 快照文件完整路径：`<base_dir>/<hash>.snapshot`。
pub fn snapshot_path_for(base_dir: &Path, file_path: &str) -> PathBuf {
    base_dir
        .join(SNAPSHOT_DIR_NAME)
        .join(format!("{}.{}", stable_path_hash(file_path), SNAPSHOT_EXT))
}

/// 原子写快照（复用 file 模块的原子写实现）。
pub fn write_snapshot_impl(base_dir: &Path, file_path: &str, content: &str) -> Result<(), String> {
    let snap = snapshot_path_for(base_dir, file_path);
    write_file_impl(&snap, content)
}

/// 删除快照；快照不存在不算错误。
pub fn clear_snapshot_impl(base_dir: &Path, file_path: &str) -> Result<(), String> {
    let snap = snapshot_path_for(base_dir, file_path);
    match fs::remove_file(&snap) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("无法删除快照 {}: {}", snap.display(), e)),
    }
}

fn mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// 「崩溃新于保存」启发式：快照存在且其 mtime 晚于磁盘文件 mtime 时，
/// 返回快照内容；否则返回 None。磁盘文件不存在时视为 epoch 0，
/// 任何存在的快照都算「更新」。
pub fn read_stale_snapshot_impl(base_dir: &Path, file_path: &str) -> Result<Option<String>, String> {
    let snap = snapshot_path_for(base_dir, file_path);
    let snap_mtime = match mtime(&snap) {
        Some(t) => t,
        None => return Ok(None), // 快照不存在
    };
    let disk_mtime = mtime(Path::new(file_path)).unwrap_or(UNIX_EPOCH);
    if snap_mtime > disk_mtime {
        let content = fs::read_to_string(&snap)
            .map_err(|e| format!("无法读取快照 {}: {}", snap.display(), e))?;
        Ok(Some(content))
    } else {
        Ok(None)
    }
}

/// 解析快照根目录：优先应用数据目录，失败时回退系统临时目录。
fn resolve_base_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("lightink"))
}

#[tauri::command]
pub fn write_snapshot(app: tauri::AppHandle, file_path: String, content: String) -> Result<(), String> {
    write_snapshot_impl(&resolve_base_dir(&app), &file_path, &content)
}

#[tauri::command]
pub fn clear_snapshot(app: tauri::AppHandle, file_path: String) -> Result<(), String> {
    clear_snapshot_impl(&resolve_base_dir(&app), &file_path)
}

#[tauri::command]
pub fn read_stale_snapshot(app: tauri::AppHandle, file_path: String) -> Result<Option<String>, String> {
    read_stale_snapshot_impl(&resolve_base_dir(&app), &file_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    #[test]
    fn hash_is_stable_and_path_form_insensitive() {
        // 同一字符串多次哈希一致（跨运行稳定是 FNV-1a 的算法属性）
        assert_eq!(stable_path_hash("C:\\a\\b.md"), stable_path_hash("C:\\a\\b.md"));
        // 正/反斜杠与大小写差异映射到同一快照
        assert_eq!(
            stable_path_hash("C:/Docs/Note.md"),
            stable_path_hash("c:\\docs\\note.md")
        );
        // 不同路径哈希不同
        assert_ne!(stable_path_hash("C:\\a.md"), stable_path_hash("C:\\b.md"));
        // hex 格式
        assert_eq!(stable_path_hash("x").len(), 16);
    }

    #[test]
    fn write_then_clear_cycle() {
        let dir = temp_dir();
        let target = dir.path().join("doc.md");
        let target_str = target.to_string_lossy().into_owned();
        write_snapshot_impl(dir.path(), &target_str, "快照内容 中文").expect("write snapshot");
        let snap = snapshot_path_for(dir.path(), &target_str);
        assert!(snap.exists());
        assert_eq!(fs::read_to_string(&snap).unwrap(), "快照内容 中文");
        clear_snapshot_impl(dir.path(), &target_str).expect("clear");
        assert!(!snap.exists());
    }

    #[test]
    fn clear_missing_snapshot_is_ok() {
        let dir = temp_dir();
        clear_snapshot_impl(dir.path(), "C:\\never\\existed.md").expect("clear missing");
    }

    #[test]
    fn stale_snapshot_newer_than_disk_returns_content() {
        let dir = temp_dir();
        let target = dir.path().join("doc.md");
        let target_str = target.to_string_lossy().into_owned();
        fs::write(&target, "磁盘旧内容").unwrap();
        // 确保快照 mtime 严格更晚
        thread::sleep(Duration::from_millis(20));
        write_snapshot_impl(dir.path(), &target_str, "崩溃前的新内容").expect("snapshot");
        let stale = read_stale_snapshot_impl(dir.path(), &target_str).expect("read stale");
        assert_eq!(stale.as_deref(), Some("崩溃前的新内容"));
    }

    #[test]
    fn snapshot_older_than_disk_is_not_stale() {
        let dir = temp_dir();
        let target = dir.path().join("doc.md");
        let target_str = target.to_string_lossy().into_owned();
        write_snapshot_impl(dir.path(), &target_str, "旧快照").expect("snapshot");
        thread::sleep(Duration::from_millis(20));
        fs::write(&target, "已保存的新内容").unwrap();
        let stale = read_stale_snapshot_impl(dir.path(), &target_str).expect("read stale");
        assert_eq!(stale, None);
    }

    #[test]
    fn missing_disk_file_makes_any_snapshot_stale() {
        let dir = temp_dir();
        let missing = dir.path().join("gone.md");
        let missing_str = missing.to_string_lossy().into_owned();
        write_snapshot_impl(dir.path(), &missing_str, "未保存的草稿").expect("snapshot");
        let stale = read_stale_snapshot_impl(dir.path(), &missing_str).expect("read stale");
        assert_eq!(stale.as_deref(), Some("未保存的草稿"));
    }

    #[test]
    fn no_snapshot_returns_none() {
        let dir = temp_dir();
        let stale = read_stale_snapshot_impl(dir.path(), "C:\\nothing.md").expect("read stale");
        assert_eq!(stale, None);
    }
}
