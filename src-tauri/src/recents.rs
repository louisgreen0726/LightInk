//! 最近打开文件列表（R12）：后端 app_data_dir JSON 持久化（重启保留、跨会话
//! 一致），上限 10、按最近使用序（MRU）、去重、可清空。
//!
//! 纯列表操作 [`add`] / [`remove`] 不依赖运行时，可单测；Tauri 命令
//! （`list_recents` / `add_recent` / `remove_recent` / `clear_recents`）
//! 是读/写 `recents.json` 的薄封装，供前端 File 菜单「最近打开」使用。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 最近文件上限。
pub const MAX_RECENTS: usize = 10;
const RECENTS_FILE: &str = "recents.json";

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

fn file_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(RECENTS_FILE))
}

fn read(app: &AppHandle) -> Recents {
    file_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write(app: &AppHandle, recents: &Recents) {
    if let Some(p) = file_path(app) {
        let _ = fs::create_dir_all(p.parent().unwrap_or(&p));
        if let Ok(json) = serde_json::to_string_pretty(recents) {
            let _ = fs::write(p, json);
        }
    }
}

#[tauri::command]
pub fn list_recents(app: AppHandle) -> Vec<String> {
    read(&app).paths
}

#[tauri::command]
pub fn add_recent(app: AppHandle, path: String) {
    write(&app, &add(read(&app), &path));
}

#[tauri::command]
pub fn remove_recent(app: AppHandle, path: String) {
    write(&app, &remove(read(&app), &path));
}

#[tauri::command]
pub fn clear_recents(app: AppHandle) {
    write(&app, &Recents::default());
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
}
