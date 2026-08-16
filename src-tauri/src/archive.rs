//! Native RAR/7z archive sessions for comic reading.
//!
//! Sessions retain only source metadata and an optional in-memory password.
//! Payloads are decoded into a bounded buffer for the requested entry; no
//! external archive executable is invoked and nothing is expanded to a tree.

use crate::remote::{self, RemoteState};
use rars::{
    Archive as RarArchive, ArchiveMemberDetail, ArchiveReadOptions,
    ArchiveReader as RarArchiveReader, Error as RarError,
};
use serde::Serialize;
use sevenz_rust2::{
    ArchiveReader as SevenZArchiveReader, EncoderMethod, Error as SevenZError, Password,
};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};
use zeroize::Zeroizing;

const MAX_ARCHIVE_ENTRIES: usize = 5_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_COMPRESSION_RATIO: u64 = 200;

const RAR4_SIGNATURE: &[u8] = b"Rar!\x1a\x07\x00";
const RAR5_SIGNATURE: &[u8] = b"Rar!\x1a\x07\x01\x00";
const SEVEN_Z_SIGNATURE: &[u8] = b"7z\xbc\xaf\x27\x1c";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveError {
    pub code: String,
    pub message: String,
}

impl ArchiveError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeFormat {
    Rar,
    SevenZ,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetectedArchiveFormat {
    Rar4,
    Rar5,
    SevenZ,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeArchiveEntry {
    pub id: String,
    pub filename: String,
    pub directory: bool,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub encrypted: bool,
    pub solid: bool,
    pub split: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveOpenResult {
    pub archive_id: String,
    pub format: String,
    pub access_mode: String,
    pub solid: bool,
    pub encrypted: bool,
    pub multivolume: bool,
    pub entries: Vec<NativeArchiveEntry>,
}

#[derive(Debug)]
struct InspectedArchive {
    format: NativeFormat,
    format_name: String,
    solid: bool,
    encrypted: bool,
    entries: Vec<NativeArchiveEntry>,
}

#[derive(Debug)]
struct ArchiveSession {
    path: PathBuf,
    format: NativeFormat,
    solid: bool,
    entries: Vec<NativeArchiveEntry>,
    password: Option<Zeroizing<String>>,
}

pub struct ArchiveState {
    sessions: Mutex<HashMap<String, Arc<Mutex<ArchiveSession>>>>,
    sequence: AtomicU64,
}

impl Default for ArchiveState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
        }
    }
}

pub fn detect_archive_format(prefix: &[u8]) -> Option<DetectedArchiveFormat> {
    if prefix.starts_with(RAR5_SIGNATURE) {
        Some(DetectedArchiveFormat::Rar5)
    } else if prefix.starts_with(RAR4_SIGNATURE) {
        Some(DetectedArchiveFormat::Rar4)
    } else if prefix.starts_with(SEVEN_Z_SIGNATURE) {
        Some(DetectedArchiveFormat::SevenZ)
    } else {
        None
    }
}

fn read_magic(path: &Path) -> Result<DetectedArchiveFormat, ArchiveError> {
    let mut file =
        File::open(path).map_err(|_| ArchiveError::new("ARCHIVE_IO", "无法打开归档文件"))?;
    let mut prefix = [0_u8; 8];
    let read = file
        .read(&mut prefix)
        .map_err(|_| ArchiveError::new("ARCHIVE_IO", "无法读取归档文件"))?;
    detect_archive_format(&prefix[..read]).ok_or_else(|| {
        ArchiveError::new(
            "ARCHIVE_FORMAT_UNSUPPORTED",
            "文件不是受支持的 RAR 或 7z 归档",
        )
    })
}

fn validate_entries(entries: &[NativeArchiveEntry], solid: bool) -> Result<(), ArchiveError> {
    if entries.len() > MAX_ARCHIVE_ENTRIES {
        return Err(ArchiveError::new(
            "ARCHIVE_ENTRY_LIMIT",
            format!("归档条目数超过上限 {MAX_ARCHIVE_ENTRIES}"),
        ));
    }
    let mut total_uncompressed = 0_u64;
    let mut total_compressed = 0_u64;
    for entry in entries.iter().filter(|entry| !entry.directory) {
        if entry.uncompressed_size > MAX_ENTRY_UNCOMPRESSED_BYTES {
            return Err(ArchiveError::new(
                "ARCHIVE_ENTRY_TOO_LARGE",
                format!("归档条目超过 {} 字节上限", MAX_ENTRY_UNCOMPRESSED_BYTES),
            ));
        }
        total_uncompressed = total_uncompressed.saturating_add(entry.uncompressed_size);
        total_compressed = total_compressed.saturating_add(entry.compressed_size);
        if !solid
            && entry.uncompressed_size > 0
            && (entry.compressed_size == 0
                || entry.uncompressed_size
                    > entry
                        .compressed_size
                        .saturating_mul(MAX_COMPRESSION_RATIO))
        {
            return Err(ArchiveError::new(
                "ARCHIVE_COMPRESSION_RATIO_LIMIT",
                "归档条目的压缩比超过安全上限",
            ));
        }
    }
    if total_uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES {
        return Err(ArchiveError::new(
            "ARCHIVE_TOTAL_SIZE_LIMIT",
            format!(
                "归档累计解压大小超过 {} 字节上限",
                MAX_TOTAL_UNCOMPRESSED_BYTES
            ),
        ));
    }
    if solid
        && total_uncompressed > 0
        && (total_compressed == 0
            || total_uncompressed > total_compressed.saturating_mul(MAX_COMPRESSION_RATIO))
    {
        return Err(ArchiveError::new(
            "ARCHIVE_COMPRESSION_RATIO_LIMIT",
            "固实归档的累计压缩比超过安全上限",
        ));
    }
    Ok(())
}

fn map_rar_error(error: RarError) -> ArchiveError {
    match error {
        RarError::NeedPassword => ArchiveError::new("ARCHIVE_PASSWORD_REQUIRED", "归档需要密码"),
        RarError::WrongPasswordOrCorruptData => {
            ArchiveError::new("ARCHIVE_PASSWORD_INCORRECT", "归档密码错误")
        }
        RarError::UnsupportedCompression { .. }
        | RarError::UnsupportedEncryption { .. }
        | RarError::UnsupportedFeature { .. }
        | RarError::UnsupportedFamilyFeature { .. }
        | RarError::UnsupportedVersion(_) => ArchiveError::new(
            "ARCHIVE_CODEC_UNSUPPORTED",
            "归档使用了当前版本不支持的 RAR 压缩或加密能力",
        ),
        RarError::Cancelled => ArchiveError::new("ARCHIVE_CANCELLED", "归档读取已取消"),
        RarError::MemoryLimitExceeded { .. } => {
            ArchiveError::new("ARCHIVE_MEMORY_LIMIT", "RAR 解码工作区超过内存限制")
        }
        RarError::Rar50BufferedDecodeLimitExceeded { .. } => {
            ArchiveError::new("ARCHIVE_ENTRY_TOO_LARGE", "RAR 条目解码超过大小上限")
        }
        RarError::Io(_) => ArchiveError::new("ARCHIVE_IO", "读取 RAR 归档失败"),
        _ => ArchiveError::new("ARCHIVE_CORRUPT", "RAR 归档损坏或无法解析"),
    }
}

fn map_sevenz_error(error: SevenZError) -> ArchiveError {
    match error {
        SevenZError::PasswordRequired => {
            ArchiveError::new("ARCHIVE_PASSWORD_REQUIRED", "归档需要密码")
        }
        SevenZError::MaybeBadPassword(_) => {
            ArchiveError::new("ARCHIVE_PASSWORD_INCORRECT", "归档密码错误")
        }
        SevenZError::UnsupportedCompressionMethod(_)
        | SevenZError::ExternalUnsupported
        | SevenZError::Unsupported(_) => ArchiveError::new(
            "ARCHIVE_CODEC_UNSUPPORTED",
            "归档使用了当前版本不支持的 7z 压缩能力",
        ),
        SevenZError::MaxMemLimited { .. } => {
            ArchiveError::new("ARCHIVE_MEMORY_LIMIT", "7z 解码工作区超过内存限制")
        }
        SevenZError::Io(error, _)
            if matches!(
                error.kind(),
                std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::InvalidData
            ) =>
        {
            ArchiveError::new("ARCHIVE_CORRUPT", "7z 归档损坏或内容不完整")
        }
        SevenZError::Io(_, _) | SevenZError::FileOpen(_, _) => {
            ArchiveError::new("ARCHIVE_IO", "读取 7z 归档失败")
        }
        _ => ArchiveError::new("ARCHIVE_CORRUPT", "7z 归档损坏或无法解析"),
    }
}

fn inspect_rar(path: &Path, password: Option<&str>) -> Result<InspectedArchive, ArchiveError> {
    let options = ArchiveReadOptions::with_optional_password(password.map(str::as_bytes))
        .with_rar50_buffered_decode_limit(MAX_ENTRY_UNCOMPRESSED_BYTES);
    let archive = RarArchiveReader::read_path_with_options(path, options).map_err(map_rar_error)?;
    let (format_name, solid, multivolume) = match &archive {
        RarArchive::Rar13(value) => ("rar4", value.main.is_solid(), value.main.is_volume()),
        RarArchive::Rar15To40(value) => ("rar4", value.main.is_solid(), value.main.is_volume()),
        RarArchive::Rar50Plus(value) => ("rar5", value.main.is_solid(), value.main.is_volume()),
        _ => {
            return Err(ArchiveError::new(
                "ARCHIVE_CODEC_UNSUPPORTED",
                "当前版本无法读取该 RAR 归档系列",
            ))
        }
    };
    let entries: Vec<NativeArchiveEntry> = archive
        .members()
        .enumerate()
        .map(|(index, member)| {
            let entry_solid = solid
                || matches!(
                    member.detail,
                    ArchiveMemberDetail::Rar15To40 { solid: true, .. }
                );
            NativeArchiveEntry {
                id: format!("entry-{index}"),
                filename: member.meta.name_lossy(),
                directory: member.meta.is_directory,
                compressed_size: member.meta.packed_size,
                uncompressed_size: member.meta.unpacked_size,
                encrypted: member.meta.is_encrypted,
                solid: entry_solid,
                split: member.meta.is_split_before || member.meta.is_split_after,
            }
        })
        .collect();
    if multivolume || entries.iter().any(|entry| entry.split) {
        return Err(ArchiveError::new(
            "ARCHIVE_MULTIVOLUME_UNSUPPORTED",
            "暂不支持多卷 RAR 归档",
        ));
    }
    validate_entries(&entries, solid)?;
    let encrypted = entries.iter().any(|entry| entry.encrypted);
    if encrypted && password.is_none() {
        return Err(ArchiveError::new(
            "ARCHIVE_PASSWORD_REQUIRED",
            "归档需要密码",
        ));
    }
    Ok(InspectedArchive {
        format: NativeFormat::Rar,
        format_name: format_name.to_string(),
        solid,
        encrypted,
        entries,
    })
}

fn looks_like_split_sevenz(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    name.contains(".7z.")
        && name.rsplit('.').next().is_some_and(|part| {
            part.len() == 3 && part.chars().all(|character| character.is_ascii_digit())
        })
}

fn inspect_sevenz(path: &Path, password: Option<&str>) -> Result<InspectedArchive, ArchiveError> {
    if looks_like_split_sevenz(path) {
        return Err(ArchiveError::new(
            "ARCHIVE_MULTIVOLUME_UNSUPPORTED",
            "暂不支持多卷 7z 归档",
        ));
    }
    let password_value = password.map(Password::new).unwrap_or_else(Password::empty);
    let reader = SevenZArchiveReader::open(path, password_value).map_err(map_sevenz_error)?;
    let archive = reader.archive();
    let entries: Vec<NativeArchiveEntry> = archive
        .files
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let encrypted = archive.stream_map.file_block_index[index]
                .and_then(|block_index| archive.blocks.get(block_index))
                .is_some_and(|block| {
                    block
                        .coders
                        .iter()
                        .any(|coder| coder.encoder_method_id() == EncoderMethod::ID_AES256_SHA256)
                });
            NativeArchiveEntry {
                id: format!("entry-{index}"),
                filename: entry.name.clone(),
                directory: entry.is_directory,
                compressed_size: entry.compressed_size,
                uncompressed_size: entry.size,
                encrypted,
                solid: archive.is_solid,
                split: false,
            }
        })
        .collect();
    validate_entries(&entries, archive.is_solid)?;
    let encrypted = entries.iter().any(|entry| entry.encrypted);
    if encrypted && password.is_none() {
        return Err(ArchiveError::new(
            "ARCHIVE_PASSWORD_REQUIRED",
            "归档需要密码",
        ));
    }
    Ok(InspectedArchive {
        format: NativeFormat::SevenZ,
        format_name: "7z".to_string(),
        solid: archive.is_solid,
        encrypted,
        entries,
    })
}

fn inspect_path(path: &Path, password: Option<&str>) -> Result<InspectedArchive, ArchiveError> {
    match read_magic(path)? {
        DetectedArchiveFormat::Rar4 | DetectedArchiveFormat::Rar5 => inspect_rar(path, password),
        DetectedArchiveFormat::SevenZ => inspect_sevenz(path, password),
    }
}

#[derive(Clone)]
struct SharedBufferWriter {
    data: Arc<Mutex<Vec<u8>>>,
    overflowed: Arc<AtomicBool>,
}

impl Write for SharedBufferWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let mut data = self
            .data
            .lock()
            .map_err(|_| std::io::Error::other("archive buffer unavailable"))?;
        if data.len().saturating_add(bytes.len()) > MAX_ENTRY_UNCOMPRESSED_BYTES as usize {
            self.overflowed.store(true, Ordering::Relaxed);
            return Err(std::io::Error::other("archive entry exceeds limit"));
        }
        data.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn shared_writer() -> (SharedBufferWriter, Arc<Mutex<Vec<u8>>>, Arc<AtomicBool>) {
    let data = Arc::new(Mutex::new(Vec::new()));
    let overflowed = Arc::new(AtomicBool::new(false));
    (
        SharedBufferWriter {
            data: Arc::clone(&data),
            overflowed: Arc::clone(&overflowed),
        },
        data,
        overflowed,
    )
}

fn take_shared_data(
    data: Arc<Mutex<Vec<u8>>>,
    overflowed: &AtomicBool,
) -> Result<Vec<u8>, ArchiveError> {
    if overflowed.load(Ordering::Relaxed) {
        return Err(ArchiveError::new(
            "ARCHIVE_ENTRY_TOO_LARGE",
            "归档条目解压后超过大小上限",
        ));
    }
    Arc::try_unwrap(data)
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档缓冲区仍在使用"))?
        .into_inner()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档缓冲区不可用"))
}

fn read_rar_entry(
    path: &Path,
    index: usize,
    password: Option<&str>,
    solid: bool,
) -> Result<Vec<u8>, ArchiveError> {
    let options = ArchiveReadOptions::with_optional_password(password.map(str::as_bytes))
        .with_rar50_buffered_decode_limit(MAX_ENTRY_UNCOMPRESSED_BYTES);
    let archive = RarArchiveReader::read_path_with_options(path, options).map_err(map_rar_error)?;
    let (mut writer, data, overflowed) = shared_writer();
    if solid {
        let mut ordinal = 0_usize;
        let mut target_opened = false;
        let result = archive.extract_to_with_options(options, |meta| {
            if target_opened {
                return Err(RarError::Cancelled);
            }
            let current = ordinal;
            ordinal += 1;
            if current == index {
                target_opened = true;
                Ok(Box::new(writer.clone()))
            } else {
                let _ = meta;
                Ok(Box::new(std::io::sink()))
            }
        });
        if overflowed.load(Ordering::Relaxed) {
            return Err(ArchiveError::new(
                "ARCHIVE_ENTRY_TOO_LARGE",
                "归档条目解压后超过大小上限",
            ));
        }
        match result {
            Ok(()) | Err(RarError::Cancelled) if target_opened => {}
            Ok(()) => {
                return Err(ArchiveError::new(
                    "ARCHIVE_ENTRY_NOT_FOUND",
                    "归档条目不存在",
                ))
            }
            Err(error) => return Err(map_rar_error(error)),
        }
    } else {
        let result = match &archive {
            RarArchive::Rar13(value) => value
                .entries
                .get(index)
                .ok_or_else(|| ArchiveError::new("ARCHIVE_ENTRY_NOT_FOUND", "归档条目不存在"))?
                .write_to(value, password.map(str::as_bytes), &mut writer),
            RarArchive::Rar15To40(value) => value
                .files()
                .nth(index)
                .ok_or_else(|| ArchiveError::new("ARCHIVE_ENTRY_NOT_FOUND", "归档条目不存在"))?
                .write_to(value, password.map(str::as_bytes), &mut writer),
            RarArchive::Rar50Plus(value) => value
                .files()
                .nth(index)
                .ok_or_else(|| ArchiveError::new("ARCHIVE_ENTRY_NOT_FOUND", "归档条目不存在"))?
                .write_to(value, password.map(str::as_bytes), &mut writer),
            _ => {
                return Err(ArchiveError::new(
                    "ARCHIVE_CODEC_UNSUPPORTED",
                    "当前版本无法读取该 RAR 归档系列",
                ))
            }
        };
        if overflowed.load(Ordering::Relaxed) {
            return Err(ArchiveError::new(
                "ARCHIVE_ENTRY_TOO_LARGE",
                "归档条目解压后超过大小上限",
            ));
        }
        result.map_err(map_rar_error)?;
    }
    drop(writer);
    take_shared_data(data, &overflowed)
}

fn read_sevenz_entry(
    path: &Path,
    index: usize,
    password: Option<&str>,
) -> Result<Vec<u8>, ArchiveError> {
    let password_value = password.map(Password::new).unwrap_or_else(Password::empty);
    let mut reader = SevenZArchiveReader::open(path, password_value).map_err(map_sevenz_error)?;
    let target = reader
        .archive()
        .files
        .get(index)
        .cloned()
        .ok_or_else(|| ArchiveError::new("ARCHIVE_ENTRY_NOT_FOUND", "归档条目不存在"))?;
    if !target.has_stream {
        return Ok(Vec::new());
    }
    let duplicate_count = reader
        .archive()
        .files
        .iter()
        .filter(|entry| entry.name == target.name)
        .count();
    if !reader.archive().is_solid && duplicate_count == 1 {
        let bytes = reader.read_file(&target.name).map_err(map_sevenz_error)?;
        if bytes.len() > MAX_ENTRY_UNCOMPRESSED_BYTES as usize {
            return Err(ArchiveError::new(
                "ARCHIVE_ENTRY_TOO_LARGE",
                "归档条目解压后超过大小上限",
            ));
        }
        return Ok(bytes);
    }
    let occurrence = reader.archive().files[..index]
        .iter()
        .filter(|entry| entry.name == target.name)
        .count();
    let (mut writer, data, overflowed) = shared_writer();
    let mut matching = 0_usize;
    let mut found = false;
    let result = reader.for_each_entries(|entry, input| {
        if entry.name == target.name {
            if matching == occurrence {
                std::io::copy(input, &mut writer)?;
                found = true;
                return Ok(false);
            }
            matching += 1;
        }
        std::io::copy(input, &mut std::io::sink())?;
        Ok(true)
    });
    if overflowed.load(Ordering::Relaxed) {
        return Err(ArchiveError::new(
            "ARCHIVE_ENTRY_TOO_LARGE",
            "归档条目解压后超过大小上限",
        ));
    }
    result.map_err(map_sevenz_error)?;
    if !found {
        return Err(ArchiveError::new(
            "ARCHIVE_ENTRY_NOT_FOUND",
            "归档条目不存在",
        ));
    }
    drop(writer);
    take_shared_data(data, &overflowed)
}

fn parse_entry_index(entry_id: &str) -> Result<usize, ArchiveError> {
    entry_id
        .strip_prefix("entry-")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| ArchiveError::new("ARCHIVE_ENTRY_NOT_FOUND", "归档条目 ID 无效"))
}

#[tauri::command]
pub async fn archive_open(
    app: AppHandle,
    state: State<'_, ArchiveState>,
    remote_state: State<'_, RemoteState>,
    path: Option<String>,
    resource_id: Option<String>,
    password: Option<String>,
) -> Result<ArchiveOpenResult, ArchiveError> {
    let password = password.map(Zeroizing::new);
    let source_path = match (path, resource_id) {
        (Some(path), None) => PathBuf::from(path),
        (None, Some(resource_id)) => {
            remote::complete_cached_path(&app, &remote_state, &resource_id)
                .map_err(|error| ArchiveError::new(error.code, error.message))?
        }
        _ => {
            return Err(ArchiveError::new(
                "ARCHIVE_SOURCE_INVALID",
                "必须且只能提供一个本地路径或远程资源句柄",
            ))
        }
    };
    if !source_path.is_file() {
        return Err(ArchiveError::new("ARCHIVE_IO", "归档文件不存在或不可读"));
    }
    let parse_path = source_path.clone();
    let inspect_password = password
        .as_deref()
        .map(|value| Zeroizing::new(value.to_owned()));
    let inspected = tauri::async_runtime::spawn_blocking(move || {
        inspect_path(&parse_path, inspect_password.as_deref().map(String::as_str))
    })
    .await
    .map_err(|_| ArchiveError::new("ARCHIVE_TASK_FAILED", "归档解析任务异常终止"))??;
    let archive_id = format!("archive-{}", state.sequence.fetch_add(1, Ordering::Relaxed));
    let result = ArchiveOpenResult {
        archive_id: archive_id.clone(),
        format: inspected.format_name,
        access_mode: if inspected.solid {
            "sequential".to_string()
        } else {
            "random".to_string()
        },
        solid: inspected.solid,
        encrypted: inspected.encrypted,
        multivolume: false,
        entries: inspected.entries.clone(),
    };
    state
        .sessions
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?
        .insert(
            archive_id,
            Arc::new(Mutex::new(ArchiveSession {
                path: source_path,
                format: inspected.format,
                solid: inspected.solid,
                entries: inspected.entries,
                password,
            })),
        );
    Ok(result)
}

#[tauri::command]
pub async fn archive_read_entry(
    state: State<'_, ArchiveState>,
    archive_id: String,
    entry_id: String,
    password: Option<String>,
) -> Result<tauri::ipc::Response, ArchiveError> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?
        .get(&archive_id)
        .cloned()
        .ok_or_else(|| ArchiveError::new("ARCHIVE_SESSION_NOT_FOUND", "归档会话不存在"))?;
    let index = parse_entry_index(&entry_id)?;
    let (path, format, solid, session_password) = {
        let session = session
            .lock()
            .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?;
        if index >= session.entries.len() {
            return Err(ArchiveError::new(
                "ARCHIVE_ENTRY_NOT_FOUND",
                "归档条目不存在",
            ));
        }
        (
            session.path.clone(),
            session.format,
            session.solid,
            session.password.clone(),
        )
    };
    let supplied_password = password.map(Zeroizing::new);
    let decode_password = supplied_password
        .as_deref()
        .or(session_password.as_deref())
        .map(|value| Zeroizing::new(value.to_owned()));
    let bytes = tauri::async_runtime::spawn_blocking(move || match format {
        NativeFormat::Rar => read_rar_entry(
            &path,
            index,
            decode_password.as_deref().map(String::as_str),
            solid,
        ),
        NativeFormat::SevenZ => {
            read_sevenz_entry(&path, index, decode_password.as_deref().map(String::as_str))
        }
    })
    .await
    .map_err(|_| ArchiveError::new("ARCHIVE_TASK_FAILED", "归档解码任务异常终止"))??;
    if let Some(password) = supplied_password {
        session
            .lock()
            .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?
            .password = Some(password);
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn archive_close(
    state: State<'_, ArchiveState>,
    archive_id: String,
) -> Result<(), ArchiveError> {
    state
        .sessions
        .lock()
        .map_err(|_| ArchiveError::new("ARCHIVE_STATE_UNAVAILABLE", "归档会话状态不可用"))?
        .remove(&archive_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rars::{rar15_40, rar50, ArchiveVersion, FeatureSet};
    use sevenz_rust2::{
        ArchiveEntry as SevenZEntry, ArchiveWriter as SevenZWriter,
        SourceReader as SevenZSourceReader,
    };
    use std::io::Cursor;

    fn write_fixture(path: &Path, bytes: &[u8]) {
        std::fs::write(path, bytes).expect("write archive fixture");
    }

    fn rar4_bytes(solid: bool, password: Option<&[u8]>) -> Vec<u8> {
        let mut features = FeatureSet::store_only();
        features.solid = solid;
        features.file_encryption = password.is_some();
        rar15_40::write_compressed_archive(
            &[
                rar15_40::FileEntry {
                    name: b"page1.png",
                    data: b"first-image",
                    file_time: 0,
                    file_attr: 0x20,
                    host_os: 3,
                    password,
                    file_comment: None,
                },
                rar15_40::FileEntry {
                    name: b"page2.png",
                    data: b"second-image",
                    file_time: 0,
                    file_attr: 0x20,
                    host_os: 3,
                    password,
                    file_comment: None,
                },
            ],
            rar15_40::WriterOptions::new(ArchiveVersion::Rar29, features),
        )
        .expect("create RAR4 fixture")
    }

    fn rar5_bytes() -> Vec<u8> {
        rar50::Rar50Writer::new(rar50::WriterOptions::new(
            ArchiveVersion::Rar50,
            FeatureSet::store_only(),
        ))
        .stored_entries(&[
            rar50::StoredEntry {
                name: b"page1.png",
                data: b"rar5-first",
                mtime: None,
                attributes: 0x20,
                host_os: 3,
            },
            rar50::StoredEntry {
                name: b"page2.png",
                data: b"rar5-second",
                mtime: None,
                attributes: 0x20,
                host_os: 3,
            },
        ])
        .finish()
        .expect("create RAR5 fixture")
    }

    fn write_sevenz(path: &Path, solid: bool) {
        let mut writer = SevenZWriter::create(path).expect("create 7z fixture");
        if solid {
            writer
                .push_archive_entries(
                    vec![
                        SevenZEntry::new_file("page1.png"),
                        SevenZEntry::new_file("page2.png"),
                    ],
                    vec![
                        SevenZSourceReader::new(Cursor::new(b"7z-first".as_slice())),
                        SevenZSourceReader::new(Cursor::new(b"7z-second".as_slice())),
                    ],
                )
                .expect("write solid 7z entries");
        } else {
            writer
                .push_archive_entry(
                    SevenZEntry::new_file("page1.png"),
                    Some(Cursor::new(b"7z-first")),
                )
                .expect("write first 7z entry");
            writer
                .push_archive_entry(
                    SevenZEntry::new_file("page2.png"),
                    Some(Cursor::new(b"7z-second")),
                )
                .expect("write second 7z entry");
        }
        writer.finish().expect("finish 7z fixture");
    }

    #[test]
    fn detects_rar4_rar5_and_sevenz_by_magic() {
        assert_eq!(
            detect_archive_format(RAR4_SIGNATURE),
            Some(DetectedArchiveFormat::Rar4)
        );
        assert_eq!(
            detect_archive_format(RAR5_SIGNATURE),
            Some(DetectedArchiveFormat::Rar5)
        );
        assert_eq!(
            detect_archive_format(SEVEN_Z_SIGNATURE),
            Some(DetectedArchiveFormat::SevenZ)
        );
        assert_eq!(detect_archive_format(b"not archive"), None);
    }

    #[test]
    fn rejects_unsafe_entry_budgets() {
        let oversized = NativeArchiveEntry {
            id: "entry-0".to_string(),
            filename: "page.png".to_string(),
            directory: false,
            compressed_size: 1,
            uncompressed_size: MAX_ENTRY_UNCOMPRESSED_BYTES + 1,
            encrypted: false,
            solid: false,
            split: false,
        };
        assert_eq!(
            validate_entries(&[oversized], false).unwrap_err().code,
            "ARCHIVE_ENTRY_TOO_LARGE"
        );
    }

    #[test]
    fn rejects_split_sevenz_names_without_relying_on_extension_routing() {
        assert!(looks_like_split_sevenz(Path::new("comic.7z.001")));
        assert!(!looks_like_split_sevenz(Path::new("comic.cb7")));
    }

    #[test]
    fn inspects_and_reads_rar4_rar5_and_solid_rar() {
        let directory = tempfile::tempdir().expect("tempdir");
        let rar4 = directory.path().join("comic.cbr");
        let solid = directory.path().join("solid.rar");
        let rar5 = directory.path().join("comic-rar5.cbr");
        write_fixture(&rar4, &rar4_bytes(false, None));
        write_fixture(&solid, &rar4_bytes(true, None));
        write_fixture(&rar5, &rar5_bytes());

        let inspected_rar4 = inspect_path(&rar4, None).expect("inspect RAR4");
        assert_eq!(inspected_rar4.format_name, "rar4");
        assert!(!inspected_rar4.solid);
        assert_eq!(
            read_rar_entry(&rar4, 1, None, false).unwrap(),
            b"second-image"
        );

        let inspected_rar5 = inspect_path(&rar5, None).expect("inspect RAR5");
        assert_eq!(inspected_rar5.format_name, "rar5");
        assert_eq!(
            read_rar_entry(&rar5, 0, None, false).unwrap(),
            b"rar5-first"
        );

        let inspected_solid = inspect_path(&solid, None).expect("inspect solid RAR");
        assert!(inspected_solid.solid);
        assert_eq!(
            read_rar_entry(&solid, 1, None, true).unwrap(),
            b"second-image"
        );
    }

    #[test]
    fn reports_rar_password_errors_without_persisting_credentials() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("secret.cbr");
        write_fixture(&path, &rar4_bytes(false, Some(b"secret")));

        assert_eq!(
            inspect_path(&path, None).unwrap_err().code,
            "ARCHIVE_PASSWORD_REQUIRED"
        );
        assert_eq!(
            read_rar_entry(&path, 0, Some("wrong"), false)
                .unwrap_err()
                .code,
            "ARCHIVE_PASSWORD_INCORRECT"
        );
        assert_eq!(
            read_rar_entry(&path, 0, Some("secret"), false).unwrap(),
            b"first-image"
        );
    }

    #[test]
    fn inspects_and_reads_regular_and_solid_sevenz() {
        let directory = tempfile::tempdir().expect("tempdir");
        let regular = directory.path().join("comic.cb7");
        let solid = directory.path().join("solid.7z");
        write_sevenz(&regular, false);
        write_sevenz(&solid, true);

        let inspected_regular = inspect_path(&regular, None).expect("inspect regular 7z");
        assert!(!inspected_regular.solid);
        assert_eq!(read_sevenz_entry(&regular, 1, None).unwrap(), b"7z-second");

        let inspected_solid = inspect_path(&solid, None).expect("inspect solid 7z");
        assert!(inspected_solid.solid);
        assert_eq!(read_sevenz_entry(&solid, 1, None).unwrap(), b"7z-second");
    }

    #[test]
    fn rejects_multivolume_and_corrupt_archives_with_structured_errors() {
        let directory = tempfile::tempdir().expect("tempdir");
        let payload = b"split archive payload".repeat(20);
        let parts = rar50::Rar50VolumeWriter::new(rar50::WriterOptions::new(
            ArchiveVersion::Rar50,
            FeatureSet::store_only(),
        ))
        .stored_entry(rar50::StoredEntry {
            name: b"page.png",
            data: &payload,
            mtime: None,
            attributes: 0x20,
            host_os: 3,
        })
        .max_payload_per_volume(80)
        .finish()
        .expect("create split RAR fixture");
        let split = directory.path().join("split.rar");
        write_fixture(&split, &parts[0]);
        assert_eq!(
            inspect_path(&split, None).unwrap_err().code,
            "ARCHIVE_MULTIVOLUME_UNSUPPORTED"
        );

        let corrupt = directory.path().join("broken.7z");
        write_fixture(&corrupt, SEVEN_Z_SIGNATURE);
        assert_eq!(
            inspect_path(&corrupt, None).unwrap_err().code,
            "ARCHIVE_CORRUPT"
        );
    }

    #[test]
    fn supports_concurrent_independent_entry_reads() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("parallel.cbr");
        write_fixture(&path, &rar5_bytes());
        let first_path = path.clone();
        let second_path = path.clone();
        let first = std::thread::spawn(move || read_rar_entry(&first_path, 0, None, false));
        let second = std::thread::spawn(move || read_rar_entry(&second_path, 1, None, false));

        assert_eq!(first.join().unwrap().unwrap(), b"rar5-first");
        assert_eq!(second.join().unwrap().unwrap(), b"rar5-second");
    }
}
