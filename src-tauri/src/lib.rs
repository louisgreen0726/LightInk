// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod file;
mod snapshot;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            file::read_file,
            file::write_file,
            snapshot::write_snapshot,
            snapshot::clear_snapshot,
            snapshot::read_stale_snapshot,
            snapshot::list_untitled_drafts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
