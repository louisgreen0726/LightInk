// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod asset;
mod cli;
mod export;
mod file;
mod snapshot;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 首实例启动时的命令行/关联文件参数（如 `lightink note.md` 或双击 .md）。
    let first_file = cli::extract_file_arg(&std::env::args().collect::<Vec<_>>());

    let builder = tauri::Builder::default();
    // 单实例（桌面）：第二实例启动时把 argv 解析出的文件写入待打开槽并发出
    // `open-file` 信号，由前端取出开新标签，避免出现第二个窗口。
    // 回调把文件始终先落入 PendingFile 槽，转发/前端就绪失败时亦可经
    // take_pending_file 回退打开，不丢文件。
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        if let Some(path) = cli::extract_file_arg(&args) {
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
            export::read_image_base64,
            cli::take_pending_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
