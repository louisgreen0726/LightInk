//! Persistent library metadata and bounded sparse-cache index.
//!
//! The database intentionally stores metadata and byte ranges only. Payload bytes
//! live below the application cache directory, and credentials are never written
//! here. The pure range helpers are kept independent from Tauri so they can be
//! tested without a running application.

use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const DATABASE_FILE: &str = "library.sqlite3";
pub const CACHE_DIRECTORY: &str = "remote-cache";
pub const DEFAULT_CACHE_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const SCHEMA_VERSION: i64 = 3;
const CACHE_LIMIT_KEY: &str = "cache_limit_bytes";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpdsSource {
    pub id: String,
    pub title: String,
    pub url: String,
    pub credential_ref: Option<String>,
    pub allow_http: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub source_id: Option<String>,
    pub source_kind: String,
    pub title: String,
    pub authors: Vec<String>,
    pub cover_url: Option<String>,
    pub local_path: Option<String>,
    pub acquisition_url: Option<String>,
    pub media_type: Option<String>,
    pub extension: Option<String>,
    pub size: Option<i64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionLink {
    pub item_id: String,
    pub href: String,
    pub rel: String,
    pub media_type: Option<String>,
    pub extension: Option<String>,
    pub size: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCacheStats {
    pub bytes_cached: u64,
    pub limit_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheObject {
    pub id: String,
    pub source_key: String,
    pub path: String,
    pub total_size: Option<u64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub complete: bool,
    pub bytes_cached: u64,
    pub last_accessed: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

impl ByteRange {
    pub fn new(start: u64, end: u64) -> Result<Self, String> {
        if start >= end {
            return Err("cache range must have start < end".to_string());
        }
        Ok(Self { start, end })
    }

    pub fn len(self) -> u64 {
        self.end - self.start
    }

    pub fn overlaps_or_touches(self, other: Self) -> bool {
        self.start <= other.end && other.start <= self.end
    }
}

/// Merge a new half-open range into sorted, non-overlapping ranges.
pub fn merge_range(mut ranges: Vec<ByteRange>, incoming: ByteRange) -> Vec<ByteRange> {
    ranges.push(incoming);
    ranges.sort_by_key(|range| range.start);
    let mut merged: Vec<ByteRange> = Vec::with_capacity(ranges.len());
    for range in ranges {
        if let Some(last) = merged.last_mut() {
            if last.overlaps_or_touches(range) {
                last.end = last.end.max(range.end);
                continue;
            }
        }
        merged.push(range);
    }
    merged
}

/// Return whether a range is completely covered by sorted cached ranges.
pub fn range_is_covered(ranges: &[ByteRange], requested: ByteRange) -> bool {
    ranges
        .iter()
        .any(|range| range.start <= requested.start && range.end >= requested.end)
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn open_database_at(app_data_dir: &Path) -> Result<Connection, String> {
    fs::create_dir_all(app_data_dir).map_err(|error| format!("无法创建书库数据目录: {error}"))?;
    let path = app_data_dir.join(DATABASE_FILE);
    let connection = match Connection::open(&path) {
        Ok(connection) => connection,
        Err(error) => {
            if !matches!(
                error.sqlite_error_code(),
                Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
            ) {
                return Err(format!("无法打开书库数据库: {error}"));
            }
            // 保留损坏文件用于诊断，然后重建空数据库，避免书库索引阻塞应用启动。
            let backup = path.with_extension(format!("sqlite3.corrupt.{}", now_ms()));
            let _ = fs::rename(&path, backup);
            Connection::open(&path)
                .map_err(|retry| format!("无法打开书库数据库: {error}; 重建失败: {retry}"))?
        }
    };
    let quick_check =
        match connection.query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0)) {
            Ok(result) => result,
            Err(error)
                if matches!(
                    error.sqlite_error_code(),
                    Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
                ) =>
            {
                "corrupt".to_string()
            }
            Err(error) => return Err(format!("无法检查书库数据库完整性: {error}")),
        };
    if quick_check != "ok" {
        drop(connection);
        // SQLite 对部分损坏文件仍能成功 Connection::open；quick_check
        // 覆盖这一分支，并让用户的旧索引以带时间戳的文件保留待诊断。
        let backup = path.with_extension(format!("sqlite3.corrupt.{}", now_ms()));
        let _ = fs::rename(&path, backup);
        connection =
            Connection::open(&path).map_err(|error| format!("无法重建书库数据库: {error}"))?;
    }
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("无法启用书库数据库约束: {error}"))?;
    connection
        .execute_batch(
            "\
            CREATE TABLE IF NOT EXISTS schema_meta (
              key TEXT PRIMARY KEY NOT NULL,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS opds_sources (
              id TEXT PRIMARY KEY NOT NULL,
              title TEXT NOT NULL,
              url TEXT NOT NULL,
              credential_ref TEXT,
              allow_http INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS library_items (
              id TEXT PRIMARY KEY NOT NULL,
              source_id TEXT REFERENCES opds_sources(id) ON DELETE CASCADE,
              source_kind TEXT NOT NULL,
              title TEXT NOT NULL,
              authors_json TEXT NOT NULL,
              cover_url TEXT,
              local_path TEXT,
              acquisition_url TEXT,
              media_type TEXT,
              extension TEXT,
              size INTEGER,
              etag TEXT,
              last_modified TEXT,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS library_items_source_idx
              ON library_items(source_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS acquisition_links (
              item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
              href TEXT NOT NULL,
              rel TEXT NOT NULL,
              media_type TEXT,
              extension TEXT,
              size INTEGER,
              PRIMARY KEY(item_id, href)
            );
            CREATE TABLE IF NOT EXISTS cache_objects (
              id TEXT PRIMARY KEY NOT NULL,
              source_key TEXT NOT NULL UNIQUE,
              path TEXT NOT NULL,
              total_size INTEGER,
              etag TEXT,
              last_modified TEXT,
              complete INTEGER NOT NULL DEFAULT 0,
              bytes_cached INTEGER NOT NULL DEFAULT 0,
              last_accessed INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cache_ranges (
              object_id TEXT NOT NULL REFERENCES cache_objects(id) ON DELETE CASCADE,
              start INTEGER NOT NULL,
              end INTEGER NOT NULL,
              PRIMARY KEY(object_id, start),
              CHECK(start >= 0 AND end > start)
            );
            CREATE INDEX IF NOT EXISTS cache_ranges_lookup_idx
              ON cache_ranges(object_id, start, end);
            INSERT INTO schema_meta(key, value) VALUES ('version', '3')
              ON CONFLICT(key) DO NOTHING;
            INSERT INTO schema_meta(key, value) VALUES ('cache_limit_bytes', '2147483648')
              ON CONFLICT(key) DO NOTHING;
            ",
        )
        .map_err(|error| format!("无法初始化书库数据库: {error}"))?;
    let version: i64 = connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='version'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(1);
    if version < SCHEMA_VERSION {
        let has_allow_http: bool = connection
            .prepare("PRAGMA table_info(opds_sources)")
            .and_then(|mut statement| {
                let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
                Ok(rows.flatten().any(|name| name == "allow_http"))
            })
            .unwrap_or(false);
        if !has_allow_http {
            connection
                .execute(
                    "ALTER TABLE opds_sources ADD COLUMN allow_http INTEGER NOT NULL DEFAULT 0",
                    [],
                )
                .map_err(|error| format!("无法迁移 OPDS 源协议设置: {error}"))?;
        }
        connection
            .execute(
                "INSERT INTO schema_meta(key, value) VALUES ('cache_limit_bytes', ?1)
                 ON CONFLICT(key) DO NOTHING",
                params![DEFAULT_CACHE_LIMIT_BYTES as i64],
            )
            .map_err(|error| format!("无法迁移书库数据库: {error}"))?;
        connection
            .execute(
                "UPDATE schema_meta SET value=?1 WHERE key='version'",
                params![SCHEMA_VERSION.to_string()],
            )
            .map_err(|error| format!("无法更新书库数据库版本: {error}"))?;
    }
    Ok(connection)
}

pub(crate) fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法定位书库数据目录: {error}"))
}

pub(crate) fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法定位远程缓存目录: {error}"))?
        .join(CACHE_DIRECTORY);
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建远程缓存目录: {error}"))?;
    Ok(directory)
}

#[cfg(test)]
fn database_for_tests(directory: &Path) -> Result<Connection, String> {
    open_database_at(directory)
}

#[tauri::command]
pub fn library_list_sources(app: AppHandle) -> Result<Vec<OpdsSource>, String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    let mut statement = connection
        .prepare(
            "SELECT id, title, url, credential_ref, allow_http, created_at, updated_at
             FROM opds_sources ORDER BY title COLLATE NOCASE, id",
        )
        .map_err(|error| format!("无法读取 OPDS 源: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(OpdsSource {
                id: row.get(0)?,
                title: row.get(1)?,
                url: row.get(2)?,
                credential_ref: row.get(3)?,
                allow_http: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("无法读取 OPDS 源: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析 OPDS 源: {error}"))
}

#[tauri::command]
pub fn library_upsert_source(app: AppHandle, source: OpdsSource) -> Result<(), String> {
    if source.id.trim().is_empty() || source.title.trim().is_empty() || source.url.trim().is_empty()
    {
        return Err("OPDS 源缺少必要字段".to_string());
    }
    let connection = open_database_at(&app_data_dir(&app)?)?;
    connection
        .execute(
            "INSERT INTO opds_sources(id, title, url, credential_ref, allow_http, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET title=?2, url=?3, credential_ref=?4,
               allow_http=?5, updated_at=?7",
            params![
                source.id,
                source.title,
                source.url,
                source.credential_ref,
                i64::from(source.allow_http),
                source.created_at,
                source.updated_at,
            ],
        )
        .map_err(|error| format!("无法保存 OPDS 源: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_remove_source(app: AppHandle, source_id: String) -> Result<(), String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    connection
        .execute("DELETE FROM opds_sources WHERE id = ?1", params![source_id])
        .map_err(|error| format!("无法删除 OPDS 源: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_list_items(
    app: AppHandle,
    source_id: Option<String>,
) -> Result<Vec<LibraryItem>, String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    let mut statement = connection
        .prepare(
            "SELECT id, source_id, source_kind, title, authors_json, cover_url,
                    local_path, acquisition_url, media_type, extension, size,
                    etag, last_modified, updated_at
             FROM library_items
             WHERE (?1 IS NULL OR source_id = ?1)
             ORDER BY updated_at DESC, title COLLATE NOCASE, id",
        )
        .map_err(|error| format!("无法读取书库条目: {error}"))?;
    let rows = statement
        .query_map(params![source_id], |row| {
            let authors_json: String = row.get(4)?;
            let authors = serde_json::from_str(&authors_json).unwrap_or_default();
            Ok(LibraryItem {
                id: row.get(0)?,
                source_id: row.get(1)?,
                source_kind: row.get(2)?,
                title: row.get(3)?,
                authors,
                cover_url: row.get(5)?,
                local_path: row.get(6)?,
                acquisition_url: row.get(7)?,
                media_type: row.get(8)?,
                extension: row.get(9)?,
                size: row.get(10)?,
                etag: row.get(11)?,
                last_modified: row.get(12)?,
                updated_at: row.get(13)?,
            })
        })
        .map_err(|error| format!("无法读取书库条目: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析书库条目: {error}"))
}

#[tauri::command]
pub fn library_list_acquisition_links(
    app: AppHandle,
    item_id: String,
) -> Result<Vec<AcquisitionLink>, String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    let mut statement = connection
        .prepare(
            "SELECT item_id, href, rel, media_type, extension, size
             FROM acquisition_links WHERE item_id=?1
             ORDER BY CASE WHEN rel LIKE '%/acquisition' THEN 0 ELSE 1 END, href",
        )
        .map_err(|error| format!("无法读取获取链接: {error}"))?;
    let rows = statement
        .query_map(params![item_id], |row| {
            Ok(AcquisitionLink {
                item_id: row.get(0)?,
                href: row.get(1)?,
                rel: row.get(2)?,
                media_type: row.get(3)?,
                extension: row.get(4)?,
                size: row.get(5)?,
            })
        })
        .map_err(|error| format!("无法读取获取链接: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析获取链接: {error}"))
}

#[tauri::command]
pub fn library_upsert_item(app: AppHandle, item: LibraryItem) -> Result<(), String> {
    if item.id.trim().is_empty() || item.title.trim().is_empty() {
        return Err("书库条目缺少必要字段".to_string());
    }
    let authors_json = serde_json::to_string(&item.authors)
        .map_err(|error| format!("无法序列化作者信息: {error}"))?;
    let connection = open_database_at(&app_data_dir(&app)?)?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("无法开启书库事务: {error}"))?;
    transaction
        .execute(
            "INSERT INTO library_items(
               id, source_id, source_kind, title, authors_json, cover_url,
               local_path, acquisition_url, media_type, extension, size,
               etag, last_modified, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET
               source_id=?2, source_kind=?3, title=?4, authors_json=?5,
               cover_url=?6, local_path=?7, acquisition_url=?8, media_type=?9,
               extension=?10, size=?11, etag=?12, last_modified=?13, updated_at=?14",
            params![
                item.id,
                item.source_id,
                item.source_kind,
                item.title,
                authors_json,
                item.cover_url,
                item.local_path,
                item.acquisition_url,
                item.media_type,
                item.extension,
                item.size,
                item.etag,
                item.last_modified,
                item.updated_at,
            ],
        )
        .map_err(|error| format!("无法保存书库条目: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交书库事务: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_remove_item(app: AppHandle, item_id: String) -> Result<(), String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    connection
        .execute("DELETE FROM library_items WHERE id = ?1", params![item_id])
        .map_err(|error| format!("无法删除书库条目: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_clear_cache(app: AppHandle) -> Result<(), String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    let directory = cache_dir(&app)?;
    if directory.exists() {
        for entry in
            fs::read_dir(&directory).map_err(|error| format!("无法读取远程缓存: {error}"))?
        {
            let path = entry
                .map_err(|error| format!("无法读取远程缓存条目: {error}"))?
                .path();
            if path.is_file() {
                fs::remove_file(path).map_err(|error| format!("无法删除远程缓存: {error}"))?;
            }
        }
    }
    connection
        .execute_batch("DELETE FROM cache_ranges; DELETE FROM cache_objects;")
        .map_err(|error| format!("无法清理远程缓存索引: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_set_cache_limit(app: AppHandle, limit_bytes: u64) -> Result<(), String> {
    if limit_bytes == 0 {
        return Err("缓存上限必须大于 0".to_string());
    }
    let mut connection = open_database_at(&app_data_dir(&app)?)?;
    connection
        .execute(
            "INSERT INTO schema_meta(key, value) VALUES ('cache_limit_bytes', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![limit_bytes.min(i64::MAX as u64) as i64],
        )
        .map_err(|error| format!("无法保存缓存上限: {error}"))?;
    let _ = evict_cache(&mut connection, &cache_dir(&app)?, limit_bytes)?;
    Ok(())
}

#[tauri::command]
pub fn library_cache_stats(app: AppHandle) -> Result<LibraryCacheStats, String> {
    let connection = open_database_at(&app_data_dir(&app)?)?;
    let bytes_cached: i64 = connection
        .query_row(
            "SELECT COALESCE(SUM(bytes_cached), 0) FROM cache_objects",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法统计缓存大小: {error}"))?;
    Ok(LibraryCacheStats {
        bytes_cached: u64::try_from(bytes_cached).unwrap_or(0),
        limit_bytes: cache_limit(&connection)?,
    })
}

pub fn cache_limit(connection: &Connection) -> Result<u64, String> {
    let value: Option<i64> = connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key=?1",
            params![CACHE_LIMIT_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("无法读取缓存上限: {error}"))?;
    Ok(value
        .and_then(|value| u64::try_from(value).ok())
        .unwrap_or(DEFAULT_CACHE_LIMIT_BYTES))
}

pub(crate) fn confined_cache_path(directory: &Path, stored_path: &Path) -> Option<PathBuf> {
    let relative = if stored_path.is_absolute() {
        stored_path.strip_prefix(directory).ok()?
    } else {
        stored_path
    };
    let mut has_filename = false;
    for component in relative.components() {
        match component {
            Component::Normal(_) => has_filename = true,
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    has_filename.then(|| directory.join(relative))
}

/// Create or refresh a cache-object row. Payload bytes are written by the
/// caller, while this metadata operation remains independent and transactional.
pub fn upsert_cache_object(connection: &Connection, object: &CacheObject) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO cache_objects(
               id, source_key, path, total_size, etag, last_modified, complete,
               bytes_cached, last_accessed
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(source_key) DO UPDATE SET
               id=excluded.id, path=excluded.path, total_size=excluded.total_size,
               etag=excluded.etag, last_modified=excluded.last_modified,
               complete=excluded.complete, last_accessed=excluded.last_accessed",
            params![
                object.id,
                object.source_key,
                object.path,
                object
                    .total_size
                    .map(|value| value.min(i64::MAX as u64) as i64),
                object.etag,
                object.last_modified,
                i64::from(object.complete),
                object.bytes_cached.min(i64::MAX as u64) as i64,
                object.last_accessed,
            ],
        )
        .map_err(|error| format!("无法保存缓存对象: {error}"))?;
    Ok(())
}

/// Evict least-recently-used objects until aggregate cached bytes fit `limit`.
/// Returned paths are safe to remove after the database transaction commits.
pub fn evict_cache(
    connection: &mut Connection,
    directory: &Path,
    limit: u64,
) -> Result<Vec<PathBuf>, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启缓存淘汰事务: {error}"))?;
    let mut total: i64 = transaction
        .query_row(
            "SELECT COALESCE(SUM(bytes_cached), 0) FROM cache_objects",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法计算缓存大小: {error}"))?;
    let mut removed = Vec::new();
    let limit_i64 = limit.min(i64::MAX as u64) as i64;
    while total > limit_i64 {
        let candidate: Option<(String, String, i64)> = transaction
            .query_row(
                "SELECT id, path, bytes_cached FROM cache_objects
                 ORDER BY last_accessed ASC, id ASC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("无法选择缓存淘汰对象: {error}"))?;
        let Some((id, path, bytes)) = candidate else {
            break;
        };
        transaction
            .execute("DELETE FROM cache_objects WHERE id=?1", params![id])
            .map_err(|error| format!("无法删除缓存索引: {error}"))?;
        total = total.saturating_sub(bytes.max(0));
        let candidate_path = PathBuf::from(path);
        if let Some(path) = confined_cache_path(directory, &candidate_path) {
            removed.push(path);
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("无法提交缓存淘汰事务: {error}"))?;
    for path in &removed {
        let _ = fs::remove_file(path);
    }
    Ok(removed)
}

/// Read cached ranges for a source. Used by the remote reader implementation.
pub fn cached_ranges(connection: &Connection, object_id: &str) -> Result<Vec<ByteRange>, String> {
    let mut statement = connection
        .prepare("SELECT start, end FROM cache_ranges WHERE object_id=?1 ORDER BY start")
        .map_err(|error| format!("无法读取缓存区间: {error}"))?;
    let rows = statement
        .query_map(params![object_id], |row| {
            Ok(ByteRange {
                start: row.get::<_, i64>(0)? as u64,
                end: row.get::<_, i64>(1)? as u64,
            })
        })
        .map_err(|error| format!("无法读取缓存区间: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析缓存区间: {error}"))
}

/// Touch a cache object after metadata or payload access so LRU reflects reads.
pub fn touch_cache_object(connection: &mut Connection, object_id: &str) -> Result<(), String> {
    connection
        .execute(
            "UPDATE cache_objects SET last_accessed=?1 WHERE id=?2",
            params![now_ms(), object_id],
        )
        .map_err(|error| format!("无法更新缓存访问时间: {error}"))?;
    Ok(())
}

pub fn record_cached_range(
    connection: &mut Connection,
    object_id: &str,
    range: ByteRange,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("无法开启缓存事务: {error}"))?;
    let existing = {
        let mut statement = transaction
            .prepare("SELECT start, end FROM cache_ranges WHERE object_id=?1 ORDER BY start")
            .map_err(|error| format!("无法读取缓存区间: {error}"))?;
        let rows = statement
            .query_map(params![object_id], |row| {
                Ok(ByteRange {
                    start: row.get::<_, i64>(0)? as u64,
                    end: row.get::<_, i64>(1)? as u64,
                })
            })
            .map_err(|error| format!("无法读取缓存区间: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法解析缓存区间: {error}"))?
    };
    transaction
        .execute(
            "DELETE FROM cache_ranges WHERE object_id=?1",
            params![object_id],
        )
        .map_err(|error| format!("无法更新缓存区间: {error}"))?;
    for merged in merge_range(existing, range) {
        transaction
            .execute(
                "INSERT INTO cache_ranges(object_id, start, end) VALUES (?1, ?2, ?3)",
                params![object_id, merged.start as i64, merged.end as i64],
            )
            .map_err(|error| format!("无法写入缓存区间: {error}"))?;
    }
    transaction
        .execute(
            "UPDATE cache_objects
             SET bytes_cached = COALESCE((SELECT SUM(end-start) FROM cache_ranges WHERE object_id=?1), 0),
                 last_accessed=?2
             WHERE id=?1",
            params![object_id, now_ms()],
        )
        .map_err(|error| format!("无法更新缓存访问时间: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("无法提交缓存事务: {error}"))?;
    Ok(())
}

pub fn find_cache_object(
    connection: &Connection,
    source_key: &str,
) -> Result<Option<(String, PathBuf)>, String> {
    connection
        .query_row(
            "SELECT id, path FROM cache_objects WHERE source_key=?1",
            params![source_key],
            |row| Ok((row.get(0)?, PathBuf::from(row.get::<_, String>(1)?))),
        )
        .optional()
        .map_err(|error| format!("无法读取缓存对象: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_overlapping_and_adjacent_ranges() {
        let ranges = vec![
            ByteRange::new(20, 30).unwrap(),
            ByteRange::new(0, 10).unwrap(),
        ];
        assert_eq!(
            merge_range(ranges, ByteRange::new(10, 20).unwrap()),
            vec![ByteRange { start: 0, end: 30 }]
        );
    }

    #[test]
    fn coverage_requires_the_requested_range_to_be_whole() {
        let ranges = vec![ByteRange { start: 10, end: 20 }];
        assert!(range_is_covered(&ranges, ByteRange::new(12, 18).unwrap()));
        assert!(!range_is_covered(&ranges, ByteRange::new(8, 18).unwrap()));
    }

    #[test]
    fn schema_is_idempotent_and_round_trips_sources() {
        let directory = tempfile::tempdir().unwrap();
        let connection = database_for_tests(directory.path()).unwrap();
        let now = now_ms();
        connection
            .execute(
                "INSERT INTO opds_sources(id,title,url,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",
                params!["source-1", "测试", "https://example.test/opds", now],
            )
            .unwrap();
        drop(connection);
        let reopened = database_for_tests(directory.path()).unwrap();
        let title: String = reopened
            .query_row(
                "SELECT title FROM opds_sources WHERE id='source-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "测试");
    }

    #[test]
    fn cache_ranges_are_transactional_and_lru_evicts_oldest_object() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = database_for_tests(directory.path()).unwrap();
        let first_path = directory.path().join("first.bin");
        let second_path = directory.path().join("second.bin");
        fs::write(&first_path, [0u8; 4]).unwrap();
        fs::write(&second_path, [0u8; 4]).unwrap();
        upsert_cache_object(
            &connection,
            &CacheObject {
                id: "first".into(),
                source_key: "url:first".into(),
                path: first_path.to_string_lossy().into_owned(),
                total_size: Some(4),
                etag: None,
                last_modified: None,
                complete: false,
                bytes_cached: 4,
                last_accessed: 1,
            },
        )
        .unwrap();
        upsert_cache_object(
            &connection,
            &CacheObject {
                id: "second".into(),
                source_key: "url:second".into(),
                path: second_path.to_string_lossy().into_owned(),
                total_size: Some(4),
                etag: None,
                last_modified: None,
                complete: false,
                bytes_cached: 4,
                last_accessed: 2,
            },
        )
        .unwrap();
        record_cached_range(&mut connection, "first", ByteRange::new(0, 4).unwrap()).unwrap();
        connection
            .execute(
                "UPDATE cache_objects SET last_accessed=1 WHERE id='first'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE cache_objects SET last_accessed=2 WHERE id='second'",
                [],
            )
            .unwrap();
        assert!(range_is_covered(
            &cached_ranges(&connection, "first").unwrap(),
            ByteRange::new(1, 3).unwrap()
        ));
        touch_cache_object(&mut connection, "first").unwrap();
        let removed = evict_cache(&mut connection, directory.path(), 4).unwrap();
        assert_eq!(removed, vec![second_path]);
        assert!(find_cache_object(&connection, "url:first")
            .unwrap()
            .is_some());
        assert!(find_cache_object(&connection, "url:second")
            .unwrap()
            .is_none());
    }

    #[test]
    fn rebuilds_a_database_that_passes_open_but_fails_quick_check() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(DATABASE_FILE);
        fs::write(&path, b"not a sqlite database").unwrap();

        let connection = database_for_tests(directory.path()).unwrap();
        let version: String = connection
            .query_row(
                "SELECT value FROM schema_meta WHERE key='version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION.to_string());
        assert!(directory
            .path()
            .read_dir()
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt.")));
    }

    #[test]
    fn lru_never_deletes_a_path_outside_the_cache_directory() {
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("cache");
        fs::create_dir(&cache).unwrap();
        let outside = directory.path().join("keep.bin");
        fs::write(&outside, [0_u8; 4]).unwrap();
        let mut connection = database_for_tests(directory.path()).unwrap();
        upsert_cache_object(
            &connection,
            &CacheObject {
                id: "unsafe".into(),
                source_key: "unsafe-source".into(),
                path: outside.to_string_lossy().into_owned(),
                total_size: Some(4),
                etag: None,
                last_modified: None,
                complete: true,
                bytes_cached: 4,
                last_accessed: 1,
            },
        )
        .unwrap();

        assert!(evict_cache(&mut connection, &cache, 0).unwrap().is_empty());
        assert!(outside.is_file());
        assert!(find_cache_object(&connection, "unsafe-source")
            .unwrap()
            .is_none());
    }
}
