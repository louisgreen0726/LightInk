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
/// 大小写不敏感；无匹配返回 `None`。返回的是原始参数（可能相对）。
pub fn extract_file_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| has_markdown_extension(a))
        .cloned()
}

/// 解析首个 markdown 文件参数为可被首实例进程直接读取的路径：
/// 绝对路径原样返回；相对路径按 `cwd`（第二实例转发的 shell 工作目录，或
/// 首实例进程 cwd）拼接为绝对路径。第二实例 cwd 与首实例 cwd 通常不同，
/// 故相对路径必须按其来源 cwd 解析，否则 `read_file` 会取错目录静默失败。
/// 不做 canonicalize（避免 Windows UNC 前缀与文件必须存在的前置），`..` 等
/// 由 OS 在打开时解析。
pub fn resolve_file_arg(args: &[String], cwd: Option<&str>) -> Option<String> {
    let raw = extract_file_arg(args)?;
    if std::path::Path::new(&raw).is_absolute() {
        return Some(raw);
    }
    let base = match cwd {
        Some(c) => std::path::PathBuf::from(c),
        None => std::env::current_dir().unwrap_or_default(),
    };
    Some(base.join(&raw).to_string_lossy().into_owned())
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

    #[test]
    fn resolve_relative_joins_cwd() {
        // 相对路径按来源 cwd 拼为绝对路径（OS 无关：两侧同用 PathBuf::join）。
        let resolved =
            resolve_file_arg(&argv(&["lightink", "note.md"]), Some("/home/user")).unwrap();
        assert_eq!(
            resolved,
            std::path::PathBuf::from("/home/user")
                .join("note.md")
                .to_string_lossy()
                .into_owned()
        );
        assert!(std::path::Path::new(&resolved).is_absolute() || resolved.contains("home"));
    }

    #[test]
    fn resolve_absolute_returned_unchanged() {
        let abs = if cfg!(windows) {
            "C:\\docs\\note.md"
        } else {
            "/docs/note.md"
        };
        let resolved = resolve_file_arg(&argv(&["lightink", abs]), Some("/other/cwd")).unwrap();
        assert_eq!(resolved, abs);
    }

    #[test]
    fn resolve_dotdot_against_cwd() {
        let resolved = resolve_file_arg(&argv(&["lightink", "sub\\..\\note.md"]), Some("/home/user"))
            .unwrap();
        assert_eq!(
            resolved,
            std::path::PathBuf::from("/home/user")
                .join("sub\\..\\note.md")
                .to_string_lossy()
                .into_owned()
        );
    }

    #[test]
    fn resolve_no_arg_is_none() {
        assert!(resolve_file_arg(&argv(&["lightink"]), Some("/home/user")).is_none());
    }
}
