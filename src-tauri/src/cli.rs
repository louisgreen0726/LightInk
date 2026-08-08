//! 命令行 / 文件关联 / 单实例的启动文件解析（R1）。
//!
//! 纯逻辑 [`extract_file_arg`] 从原始 argv 扫描首个 `.md`/`.markdown`
//! 文件参数，供首实例启动（`env::args`）与第二实例转发（single-instance
//! 回调的 argv）两条路径共用。无文件系统访问，可移植、可单测。
//!
//! [`PendingFile`] 是经 Tauri 状态托管的「待打开文件」槽：首实例 argv
//! 解析结果在 `run()` 注入，第二实例回调覆盖写入；前端就绪后经
//! [`take_pending_file`] 命令取出并清空（仅消费一次），保证「单实例转发
//! 失败/前端未就绪时回退为正常打开、不丢文件」——文件始终先落入此槽。

use std::sync::Mutex;

/// 待打开文件槽（单值，取出即清空）。
pub struct PendingFile(pub Mutex<Option<String>>);

/// 扫描 argv（含程序路径，索引 0 跳过），返回首个 `.md`/`.markdown` 文件参数。
/// 大小写不敏感；无匹配返回 `None`。
pub fn extract_file_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| has_markdown_extension(a))
        .cloned()
}

/// 大小写不敏感的 `.md` / `.markdown` 扩展名判断（不访问文件系统）。
fn has_markdown_extension(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

/// 取出并清空待打开文件槽（前端就绪或收到 `open-file` 事件时调用）。
#[tauri::command]
pub fn take_pending_file(state: tauri::State<'_, PendingFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut guard| guard.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_args_yields_none() {
        assert!(extract_file_arg(&argv(&["lightink"])).is_none());
    }

    #[test]
    fn picks_first_markdown_arg() {
        assert_eq!(
            extract_file_arg(&argv(&["lightink", "note.md"])),
            Some("note.md".to_string())
        );
    }

    #[test]
    fn skips_non_markdown_args() {
        assert_eq!(
            extract_file_arg(&argv(&["lightink", "--flag", "a.txt", "b.md"])),
            Some("b.md".to_string())
        );
    }

    #[test]
    fn case_insensitive_extension() {
        assert_eq!(
            extract_file_arg(&argv(&["lightink", "README.MARKDOWN"])),
            Some("README.MARKDOWN".to_string())
        );
        assert_eq!(
            extract_file_arg(&argv(&["lightink", "ReadMe.MD"])),
            Some("ReadMe.MD".to_string())
        );
    }

    #[test]
    fn unicode_and_paths_with_spaces() {
        assert_eq!(
            extract_file_arg(&argv(&["lightink", "/path/with space/笔记.md"])),
            Some("/path/with space/笔记.md".to_string())
        );
    }

    #[test]
    fn bare_markdown_without_dot_is_not_matched() {
        assert!(extract_file_arg(&argv(&["lightink", "markdown"])).is_none());
        assert!(extract_file_arg(&argv(&["lightink", "readme.md.txt"])).is_none());
    }
}
