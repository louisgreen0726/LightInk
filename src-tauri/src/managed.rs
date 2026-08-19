//! Content-addressed storage for books managed by LightInk.

use crate::file::MAX_READER_FILE_BYTES;
use crate::library::{self, LibraryItem};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;

const MANAGED_DIRECTORY: &str = "library-content";
const HASH_DIRECTORY: &str = "sha256";
const COPY_BUFFER_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedMigrationEntry {
    pub item_id: String,
    pub title: String,
    pub path: String,
    pub status: String,
    pub size: Option<u64>,
    pub blob_hash: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedMigrationPreview {
    pub entries: Vec<ManagedMigrationEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItemAlias {
    pub alias_id: String,
    pub item_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedMigrationResult {
    pub migrated: usize,
    pub duplicates: usize,
    pub failed: Vec<ManagedMigrationEntry>,
    pub aliases: Vec<LibraryItemAlias>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedItemLocation {
    pub item_id: String,
    pub path: String,
    pub availability: String,
}

#[derive(Debug)]
struct StoredBlob {
    hash: String,
    absolute_path: PathBuf,
    size: u64,
    duplicate: bool,
}

fn extension_for(path: &Path) -> String {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin")
        .to_ascii_lowercase();
    if !extension.is_empty()
        && extension.len() <= 16
        && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        extension
    } else {
        "bin".to_string()
    }
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Untitled")
        .to_string()
}

fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let mut file = File::open(path)
        .map_err(|error| format!("无法读取待托管书籍 {}: {error}", path.display()))?;
    let size = file
        .metadata()
        .map_err(|error| format!("无法读取书籍信息 {}: {error}", path.display()))?
        .len();
    if size > MAX_READER_FILE_BYTES {
        return Err(format!("FILE_TOO_LARGE:{size}:{}", MAX_READER_FILE_BYTES));
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("无法读取待托管书籍 {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

fn managed_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(MANAGED_DIRECTORY)
}

fn safe_managed_path(app_data_dir: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("受管内容路径越出应用数据目录".to_string());
    }
    let root = managed_root(app_data_dir);
    let target = app_data_dir.join(relative);
    if !target.starts_with(&root) {
        return Err("受管内容路径不属于书库目录".to_string());
    }
    Ok(target)
}

fn store_blob_at(
    connection: &Connection,
    app_data_dir: &Path,
    source: &Path,
) -> Result<StoredBlob, String> {
    let size = source
        .metadata()
        .map_err(|error| format!("无法读取书籍信息 {}: {error}", source.display()))?
        .len();
    if size > MAX_READER_FILE_BYTES {
        return Err(format!("FILE_TOO_LARGE:{size}:{}", MAX_READER_FILE_BYTES));
    }
    let root = managed_root(app_data_dir);
    let staging = root.join("staging");
    fs::create_dir_all(&staging).map_err(|error| format!("无法创建受管书库目录: {error}"))?;
    let mut input = File::open(source)
        .map_err(|error| format!("无法读取待托管书籍 {}: {error}", source.display()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(&staging)
        .map_err(|error| format!("无法创建书籍临时文件: {error}"))?;
    let mut hasher = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| format!("无法读取待托管书籍 {}: {error}", source.display()))?;
        if read == 0 {
            break;
        }
        copied = copied.saturating_add(read as u64);
        if copied > MAX_READER_FILE_BYTES {
            return Err(format!("FILE_TOO_LARGE:{copied}:{}", MAX_READER_FILE_BYTES));
        }
        hasher.update(&buffer[..read]);
        temporary
            .write_all(&buffer[..read])
            .map_err(|error| format!("无法写入书籍临时文件: {error}"))?;
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("无法同步书籍临时文件: {error}"))?;
    let hash = format!("{:x}", hasher.finalize());
    let known_path = connection
        .query_row(
            "SELECT relative_path FROM managed_blobs WHERE hash=?1",
            params![hash],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法查询受管书籍: {error}"))?;
    let relative_path = known_path.clone().unwrap_or_else(|| {
        let extension = extension_for(source);
        format!(
            "{MANAGED_DIRECTORY}/{HASH_DIRECTORY}/{}/{}.{}",
            &hash[..2],
            hash,
            extension
        )
    });
    let absolute_path = safe_managed_path(app_data_dir, &relative_path)?;
    let duplicate = known_path.is_some() && absolute_path.is_file();
    if !absolute_path.is_file() {
        let parent = absolute_path
            .parent()
            .ok_or_else(|| "受管书籍目标路径无效".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("无法创建受管书籍目录: {error}"))?;
        temporary
            .persist(&absolute_path)
            .map_err(|error| format!("无法提交受管书籍: {}", error.error))?;
    }
    let now = library::now_ms();
    connection
        .execute(
            "INSERT INTO managed_blobs(hash, relative_path, size, created_at, last_verified_at)
             VALUES (?1,?2,?3,?4,?4)
             ON CONFLICT(hash) DO UPDATE SET last_verified_at=?4",
            params![hash, relative_path, copied as i64, now],
        )
        .map_err(|error| format!("无法记录受管书籍: {error}"))?;
    Ok(StoredBlob {
        hash,
        absolute_path,
        size: copied,
        duplicate,
    })
}

fn insert_managed_item(
    connection: &Connection,
    source: &Path,
    blob: &StoredBlob,
) -> Result<(), String> {
    let id = format!("managed:{}", blob.hash);
    let title = display_name(source);
    let extension = extension_for(source);
    let now = library::now_ms();
    connection
        .execute(
            "INSERT INTO library_items(
               id, source_kind, title, authors_json, local_path, extension, size,
               blob_hash, availability, offline_pinned, subjects_json, updated_at
             ) VALUES (?1,'managed',?2,'[]',?3,?4,?5,?6,'local',0,'[]',?7)
             ON CONFLICT(id) DO UPDATE SET local_path=?3, size=?5,
               availability='local', updated_at=?7",
            params![
                id,
                title,
                blob.absolute_path.to_string_lossy(),
                extension,
                blob.size as i64,
                blob.hash,
                now,
            ],
        )
        .map_err(|error| format!("无法保存受管书籍条目: {error}"))?;
    Ok(())
}

fn migrate_item_at(
    connection: &mut Connection,
    app_data_dir: &Path,
    item_id: &str,
) -> Result<(LibraryItemAlias, bool), String> {
    let source_path: String = connection
        .query_row(
            "SELECT local_path FROM library_items
             WHERE id=?1 AND source_kind='local' AND blob_hash IS NULL",
            params![item_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法读取待迁移书籍 {item_id}: {error}"))?;
    let source = PathBuf::from(source_path);
    let blob = store_blob_at(connection, app_data_dir, &source)?;
    let target_id = format!("managed:{}", blob.hash);
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启书籍迁移事务: {error}"))?;
    transaction
        .execute(
            "INSERT INTO library_items(
               id, source_id, source_kind, title, authors_json, cover_url, local_path,
               acquisition_url, media_type, extension, size, etag, last_modified,
               series, number, volume, page_count, reading_direction, cover_page,
               blob_hash, availability, offline_pinned, subjects_json, updated_at
             ) SELECT ?2, source_id, 'managed', title, authors_json, cover_url, ?3,
               acquisition_url, media_type, extension, ?4, etag, last_modified,
               series, number, volume, page_count, reading_direction, cover_page,
               ?5, 'local', offline_pinned, subjects_json, ?6
             FROM library_items WHERE id=?1
             ON CONFLICT(id) DO UPDATE SET source_kind='managed', local_path=?3, size=?4,
               blob_hash=?5, availability='local', updated_at=?6",
            params![
                item_id,
                target_id,
                blob.absolute_path.to_string_lossy(),
                blob.size as i64,
                blob.hash,
                library::now_ms(),
            ],
        )
        .map_err(|error| format!("无法迁移书籍元数据: {error}"))?;
    if item_id != target_id {
        transaction
            .execute(
                "INSERT INTO acquisition_links(item_id, href, rel, media_type, extension, size)
                 SELECT ?2, href, rel, media_type, extension, size
                 FROM acquisition_links WHERE item_id=?1
                 ON CONFLICT(item_id, href) DO NOTHING",
                params![item_id, target_id],
            )
            .map_err(|error| format!("无法迁移书籍获取链接: {error}"))?;
        transaction
            .execute(
                "INSERT INTO library_item_aliases(alias_id, item_id) VALUES (?1,?2)
                 ON CONFLICT(alias_id) DO UPDATE SET item_id=?2",
                params![item_id, target_id],
            )
            .map_err(|error| format!("无法记录书籍旧标识: {error}"))?;
        transaction
            .execute("DELETE FROM library_items WHERE id=?1", params![item_id])
            .map_err(|error| format!("无法移除旧书籍条目: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("无法提交书籍迁移: {error}"))?;
    Ok((
        LibraryItemAlias {
            alias_id: item_id.to_string(),
            item_id: target_id,
        },
        blob.duplicate,
    ))
}

fn preview_at(connection: &Connection) -> Result<ManagedMigrationPreview, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, title, local_path FROM library_items
             WHERE source_kind='local' AND blob_hash IS NULL AND local_path IS NOT NULL
             ORDER BY title COLLATE NOCASE, id",
        )
        .map_err(|error| format!("无法读取待迁移书籍: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("无法读取待迁移书籍: {error}"))?;
    let known = connection
        .prepare("SELECT hash FROM managed_blobs")
        .and_then(|mut query| {
            let rows = query.query_map([], |row| row.get::<_, String>(0))?;
            Ok(rows.flatten().collect::<HashSet<_>>())
        })
        .unwrap_or_default();
    let mut seen = known;
    let mut entries = Vec::new();
    for row in rows {
        let (item_id, title, raw_path) =
            row.map_err(|error| format!("无法解析待迁移书籍: {error}"))?;
        let path = PathBuf::from(&raw_path);
        let mut entry = ManagedMigrationEntry {
            item_id,
            title,
            path: raw_path,
            status: "ready".to_string(),
            size: None,
            blob_hash: None,
            error: None,
        };
        match hash_file(&path) {
            Ok((hash, size)) => {
                entry.size = Some(size);
                entry.status = if seen.insert(hash.clone()) {
                    "ready".to_string()
                } else {
                    "duplicate".to_string()
                };
                entry.blob_hash = Some(hash);
            }
            Err(error) => {
                entry.status = if !path.exists() {
                    "missing".to_string()
                } else if error.starts_with("FILE_TOO_LARGE:") {
                    "tooLarge".to_string()
                } else {
                    "unreadable".to_string()
                };
                entry.error = Some(error);
            }
        }
        entries.push(entry);
    }
    Ok(ManagedMigrationPreview { entries })
}

#[tauri::command]
pub fn library_import_managed_book(app: AppHandle, path: String) -> Result<LibraryItem, String> {
    let app_data_dir = library::app_data_dir(&app)?;
    let connection = library::open_database_at(&app_data_dir)?;
    let source = PathBuf::from(path);
    let blob = store_blob_at(&connection, &app_data_dir, &source)?;
    insert_managed_item(&connection, &source, &blob)?;
    let id = format!("managed:{}", blob.hash);
    library::library_list_items(app, None)?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "受管书籍写入后无法读取".to_string())
}

#[tauri::command]
pub fn library_preview_managed_migration(
    app: AppHandle,
) -> Result<ManagedMigrationPreview, String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    preview_at(&connection)
}

#[tauri::command]
pub fn library_apply_managed_migration(
    app: AppHandle,
    item_ids: Vec<String>,
) -> Result<ManagedMigrationResult, String> {
    let app_data_dir = library::app_data_dir(&app)?;
    let mut connection = library::open_database_at(&app_data_dir)?;
    let mut result = ManagedMigrationResult {
        migrated: 0,
        duplicates: 0,
        failed: Vec::new(),
        aliases: Vec::new(),
    };
    for item_id in item_ids {
        match migrate_item_at(&mut connection, &app_data_dir, &item_id) {
            Ok((alias, duplicate)) => {
                result.migrated += 1;
                result.duplicates += usize::from(duplicate);
                result.aliases.push(alias);
            }
            Err(error) => result.failed.push(ManagedMigrationEntry {
                item_id,
                title: String::new(),
                path: String::new(),
                status: "failed".to_string(),
                size: None,
                blob_hash: None,
                error: Some(error),
            }),
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn library_materialize_item(
    app: AppHandle,
    item_id: String,
) -> Result<ManagedItemLocation, String> {
    let app_data_dir = library::app_data_dir(&app)?;
    let connection = library::open_database_at(&app_data_dir)?;
    let resolved_id = connection
        .query_row(
            "SELECT item_id FROM library_item_aliases WHERE alias_id=?1",
            params![item_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法解析书籍标识: {error}"))?
        .unwrap_or_else(|| item_id.clone());
    let record = connection
        .query_row(
            "SELECT i.local_path, i.availability, b.relative_path
             FROM library_items i
             LEFT JOIN managed_blobs b ON b.hash=i.blob_hash
             WHERE i.id=?1",
            params![resolved_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("无法读取书籍位置: {error}"))?
        .ok_or_else(|| "书籍不在书库中".to_string())?;
    let path = if let Some(relative_path) = record.2 {
        safe_managed_path(&app_data_dir, &relative_path)?
    } else if let Some(local_path) = record.0 {
        PathBuf::from(local_path)
    } else {
        return Err("书籍正文尚未下载".to_string());
    };
    if !path.is_file() {
        connection
            .execute(
                "UPDATE library_items SET availability='missing' WHERE id=?1",
                params![resolved_id],
            )
            .map_err(|error| format!("无法更新书籍可用状态: {error}"))?;
        return Err("书籍正文不可用，请重新定位或下载".to_string());
    }
    Ok(ManagedItemLocation {
        item_id: resolved_id,
        path: path.to_string_lossy().into_owned(),
        availability: record.1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_content_by_hash_without_modifying_the_source() {
        let app_data = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("book.epub");
        fs::write(&source, b"book bytes").unwrap();
        let connection = library::open_database_at(app_data.path()).unwrap();

        let first = store_blob_at(&connection, app_data.path(), &source).unwrap();
        let second = store_blob_at(&connection, app_data.path(), &source).unwrap();

        assert_eq!(fs::read(&source).unwrap(), b"book bytes");
        assert_eq!(first.hash, second.hash);
        assert!(first.absolute_path.is_file());
        assert!(!first.duplicate);
        assert!(second.duplicate);
    }

    #[test]
    fn deduplicates_identical_content_across_file_extensions() {
        let app_data = tempfile::tempdir().unwrap();
        let source_dir = tempfile::tempdir().unwrap();
        let epub = source_dir.path().join("book.epub");
        let bin = source_dir.path().join("book.bin");
        fs::write(&epub, b"same bytes").unwrap();
        fs::write(&bin, b"same bytes").unwrap();
        let connection = library::open_database_at(app_data.path()).unwrap();

        let first = store_blob_at(&connection, app_data.path(), &epub).unwrap();
        let second = store_blob_at(&connection, app_data.path(), &bin).unwrap();

        assert_eq!(first.absolute_path, second.absolute_path);
        assert!(second.duplicate);
        assert!(!app_data
            .path()
            .join("library-content/sha256")
            .join(&second.hash[..2])
            .join(format!("{}.bin", second.hash))
            .exists());
    }

    #[test]
    fn preview_keeps_missing_items_out_of_the_ready_set() {
        let app_data = tempfile::tempdir().unwrap();
        let connection = library::open_database_at(app_data.path()).unwrap();
        connection
            .execute(
                "INSERT INTO library_items(
                   id,source_kind,title,authors_json,local_path,availability,subjects_json,updated_at
                 ) VALUES ('local:missing','local','Missing','[]','/not/here.epub','external','[]',1)",
                [],
            )
            .unwrap();
        let preview = preview_at(&connection).unwrap();
        assert_eq!(preview.entries.len(), 1);
        assert_eq!(preview.entries[0].status, "missing");
    }

    #[test]
    fn rejects_paths_outside_the_managed_directory() {
        let root = tempfile::tempdir().unwrap();
        assert!(safe_managed_path(root.path(), "../outside").is_err());
        assert!(safe_managed_path(root.path(), "/outside").is_err());
    }
}
