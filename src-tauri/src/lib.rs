// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod asset;
mod cli;
mod export;
mod file;
mod recents;
mod snapshot;

use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 首实例启动时的命令行/关联文件参数（如 `lightink note.md` 或双击 .md）。
    // 相对路径按首实例进程 cwd 解析（首实例 cwd 即 shell cwd）。
    let first_file = cli::resolve_file_arg(&std::env::args().collect::<Vec<_>>(), None);

    let builder = tauri::Builder::default();
    // 单实例（桌面）：第二实例启动时把 argv 解析出的文件写入待打开槽并发出
    // `open-file` 信号，由前端取出开新标签，避免出现第二个窗口。
    // 回调把文件始终先落入 PendingFile 槽，转发/前端就绪失败时亦可经
    // take_pending_file 回退打开，不丢文件。
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        // 相对路径必须按第二实例转发的 cwd 解析（首/第二实例 cwd 通常不同），
        // 否则 read_file 取错目录静默失败、文件被丢。
        if let Some(path) = cli::resolve_file_arg(&args, Some(&cwd)) {
            if let Some(state) = app.try_state::<cli::PendingFile>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(path.clone());
                }
            }
            let _ = app.emit("open-file", ());
        }
    }));
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(cli::PendingFile(std::sync::Mutex::new(first_file)))
        .invoke_handler(tauri::generate_handler![
            file::read_file,
            file::write_file,
            snapshot::write_snapshot,
            snapshot::clear_snapshot,
            snapshot::read_stale_snapshot,
            snapshot::list_untitled_drafts,
            asset::save_asset,
            asset::migrate_staging_assets,
            asset::import_image_asset,
            export::read_image_base64,
            cli::take_pending_file,
            recents::list_recents,
            recents::add_recent,
            recents::remove_recent,
            recents::clear_recents,
            snapshot::create_version,
            snapshot::list_versions,
            snapshot::read_version,
            snapshot::restore_version,
            open_in_browser,
            open_path_default,
            reveal_path_in_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── R14 链接跳转 / R3 在文件管理器中显示 ──────────────────────────────
// 经 tauri-plugin-opener 的 Rust API（OpenerExt）实现：外部链接走系统浏览器、
// 本地文件走系统默认程序、reveal 在文件管理器中定位（T8 已 invoke 此命令）。

/// 在系统默认浏览器打开外部 URL（http(s) 等）。
#[tauri::command]
fn open_in_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 以系统默认方式打开本地文件（非 .md）。
#[tauri::command]
fn open_path_default(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 在系统文件管理器中定位该文件（R3 标签页右键「在文件管理器中显示」）。
#[tauri::command]
fn reveal_path_in_files(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}
