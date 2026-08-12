//! 最近打开文件列表（R12）：后端 app_data_dir JSON 持久化（重启保留、跨会话
//! 一致），上限 10、按最近使用序（MRU）、去重、可清空。
//!
//! 纯列表操作 [`add`] / [`remove`] 不依赖运行时，可单测；Tauri 命令
//! （`list_recents` / `add_recent` / `remove_recent` / `clear_recents`）
//! 是读/写 `recents.json` 的薄封装，供前端 File 菜单「最近打开」使用。

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager};

/// 最近文件上限。
pub const MAX_RECENTS: usize = 10;
const RECENTS_FILE: &str = "recents.json";
static RECENTS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Recents {
    pub paths: Vec<String>,
}

/// 纯逻辑：把 `path` 置顶（MRU），去重，截断至上限。
pub fn add(mut recents: Recents, path: &str) -> Recents {
    recents.paths.retain(|p| p != path);
    recents.paths.insert(0, path.to_string());
    recents.paths.truncate(MAX_RECENTS);
    recents
}

/// 纯逻辑：移除 `path`（若存在）。
pub fn remove(mut recents: Recents, path: &str) -> Recents {
    recents.paths.retain(|p| p != path);
    recents
}

fn file_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(RECENTS_FILE))
        .map_err(|error| format!("无法定位最近文件存储目录: {}", error))
}

fn read_from_path(path: &Path) -> Recents {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_to_path(path: &Path, recents: &Recents) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|directory| !directory.as_os_str().is_empty())
        .ok_or_else(|| format!("无效的最近文件存储路径: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建最近文件存储目录: {}", error))?;
    let json = serde_json::to_vec_pretty(recents)
        .map_err(|error| format!("无法序列化最近文件列表: {}", error))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("无法创建最近文件临时文件: {}", error))?;
    temporary
        .write_all(&json)
        .map_err(|error| format!("无法写入最近文件列表: {}", error))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("无法同步最近文件列表: {}", error))?;
    temporary
        .persist(path)
        .map_err(|error| format!("无法保存最近文件列表: {}", error.error))?;

    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("无法同步最近文件存储目录: {}", error))?;

    Ok(())
}

fn acquire_lock() -> Result<MutexGuard<'static, ()>, String> {
    RECENTS_LOCK
        .lock()
        .map_err(|_| "最近文件存储锁已损坏".to_owned())
}

#[tauri::command]
pub fn list_recents(app: AppHandle) -> Vec<String> {
    let Ok(_guard) = acquire_lock() else {
        return Vec::new();
    };
    file_path(&app)
        .map(|path| read_from_path(&path).paths)
        .unwrap_or_default()
}

#[tauri::command]
pub fn add_recent(app: AppHandle, path: String) -> Result<(), String> {
    let _guard = acquire_lock()?;
    let storage_path = file_path(&app)?;
    write_to_path(&storage_path, &add(read_from_path(&storage_path), &path))
}

#[tauri::command]
pub fn remove_recent(app: AppHandle, path: String) -> Result<(), String> {
    let _guard = acquire_lock()?;
    let storage_path = file_path(&app)?;
    write_to_path(&storage_path, &remove(read_from_path(&storage_path), &path))
}

#[tauri::command]
pub fn clear_recents(app: AppHandle) -> Result<(), String> {
    let _guard = acquire_lock()?;
    write_to_path(&file_path(&app)?, &Recents::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recents(paths: &[&str]) -> Recents {
        Recents {
            paths: paths.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn add_new_to_front() {
        let r = add(recents(&["a.md"]), "b.md");
        assert_eq!(r.paths, vec!["b.md", "a.md"]);
    }

    #[test]
    fn add_existing_moves_to_front_and_dedups() {
        let r = add(recents(&["a.md", "b.md", "c.md"]), "b.md");
        assert_eq!(r.paths, vec!["b.md", "a.md", "c.md"]);
    }

    #[test]
    fn add_caps_at_max() {
        let mut r = Recents::default();
        for i in 0..(MAX_RECENTS + 3) {
            r = add(r, &format!("f{i}.md"));
        }
        assert_eq!(r.paths.len(), MAX_RECENTS);
        // 最新的在最前（MRU），最早的被淘汰。
        assert_eq!(r.paths[0], format!("f{}.md", MAX_RECENTS + 2));
    }

    #[test]
    fn remove_drops_matching() {
        let r = remove(recents(&["a.md", "b.md", "c.md"]), "b.md");
        assert_eq!(r.paths, vec!["a.md", "c.md"]);
    }

    #[test]
    fn remove_missing_is_noop() {
        let r = remove(recents(&["a.md"]), "z.md");
        assert_eq!(r.paths, vec!["a.md"]);
    }

    #[test]
    fn atomic_write_roundtrips_valid_json() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join(RECENTS_FILE);
        let expected = recents(&["文档.md", "C:\\notes\\two.md"]);

        write_to_path(&path, &expected).expect("write recents");

        assert_eq!(read_from_path(&path).paths, expected.paths);
        let entries = fs::read_dir(directory.path()).unwrap().count();
        assert_eq!(entries, 1, "temporary file must be promoted or cleaned");
    }

    #[test]
    fn write_failure_is_reported_without_replacing_unrelated_data() {
        let directory = tempfile::tempdir().expect("temp dir");
        let blocker = directory.path().join("blocker");
        fs::write(&blocker, b"keep me").unwrap();
        let impossible = blocker.join(RECENTS_FILE);

        let error = write_to_path(&impossible, &recents(&["a.md"]))
            .expect_err("directory creation must fail");

        assert!(error.contains("无法创建最近文件存储目录"));
        assert_eq!(fs::read(blocker).unwrap(), b"keep me");
    }
}
