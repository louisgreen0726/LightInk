//! Device-local sync records, causal merge and conflict persistence.
//!
//! WebDAV transports immutable blobs and device snapshots. This module owns the
//! small, structured records contained in those snapshots: one value per
//! object/field/device, with a dotted causal context so offline edits can merge
//! without relying on wall-clock order alone.

use crate::documents;
use crate::file::write_file_impl;
use crate::library;
use crate::managed;
use crate::webdav::{self, WebDavError, WebDavState, MAX_SYNC_RESPONSE_BYTES};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::State;
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncRunState {
    Idle,
    Running,
    Success,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub state: SyncRunState,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub last_error: Option<String>,
    pub uploaded: u64,
    pub downloaded: u64,
    pub conflicts: u64,
}

#[derive(Default)]
pub struct SyncTaskState {
    task: std::sync::Mutex<Option<(String, CancellationToken)>>,
    status: std::sync::Mutex<SyncStatus>,
}

impl Default for SyncStatus {
    fn default() -> Self {
        Self {
            state: SyncRunState::Idle,
            started_at: None,
            finished_at: None,
            last_error: None,
            uploaded: 0,
            downloaded: 0,
            conflicts: 0,
        }
    }
}

fn status_snapshot(state: &SyncTaskState) -> Result<SyncStatus, String> {
    state
        .status
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "同步状态不可用".to_string())
}

fn start_task(state: &SyncTaskState) -> Result<(String, CancellationToken), String> {
    let mut task = state
        .task
        .lock()
        .map_err(|_| "同步任务状态不可用".to_string())?;
    if task.is_some() {
        return Err("已有同步任务正在运行".to_string());
    }
    let id = Uuid::new_v4().to_string();
    let token = CancellationToken::new();
    *task = Some((id.clone(), token.clone()));
    let mut status = state
        .status
        .lock()
        .map_err(|_| "同步状态不可用".to_string())?;
    *status = SyncStatus {
        state: SyncRunState::Running,
        started_at: Some(library::now_ms()),
        ..SyncStatus::default()
    };
    Ok((id, token))
}

fn finish_task(state: &SyncTaskState, task_id: &str, result: &Result<SyncStatus, WebDavError>) {
    if let Ok(mut task) = state.task.lock() {
        if task.as_ref().is_some_and(|(id, _)| id == task_id) {
            *task = None;
        }
    }
    if let Ok(mut status) = state.status.lock() {
        match result {
            Ok(value) => *status = value.clone(),
            Err(error) => {
                status.state = if error.code == "SYNC_CANCELLED" {
                    SyncRunState::Cancelled
                } else {
                    SyncRunState::Error
                };
                status.finished_at = Some(library::now_ms());
                status.last_error = Some(error.message.clone());
            }
        }
    }
}

const DEVICE_ID_KEY: &str = "sync.device_id";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VersionPoint {
    pub device_id: String,
    pub version: u64,
    #[serde(default)]
    pub context: BTreeMap<String, u64>,
    pub modified_at: i64,
}

impl VersionPoint {
    fn counter_for(&self, device_id: &str) -> u64 {
        if self.device_id == device_id {
            self.version
        } else {
            self.context.get(device_id).copied().unwrap_or(0)
        }
    }

    fn merged_context(left: &Self, right: &Self) -> BTreeMap<String, u64> {
        let mut devices: BTreeSet<&str> = left.context.keys().map(String::as_str).collect();
        devices.extend(right.context.keys().map(String::as_str));
        devices.insert(left.device_id.as_str());
        devices.insert(right.device_id.as_str());
        devices
            .into_iter()
            .map(|device| {
                (
                    device.to_string(),
                    left.counter_for(device).max(right.counter_for(device)),
                )
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CausalOrder {
    Equal,
    Dominates,
    IsDominated,
    Concurrent,
}

/// Compare two dotted version vectors. Wall-clock time is intentionally not
/// used here; it is only a deterministic tie-breaker for concurrent edits.
pub fn compare_version_points(left: &VersionPoint, right: &VersionPoint) -> CausalOrder {
    let mut devices: BTreeSet<&str> = left.context.keys().map(String::as_str).collect();
    devices.extend(right.context.keys().map(String::as_str));
    devices.insert(left.device_id.as_str());
    devices.insert(right.device_id.as_str());
    let mut left_greater = false;
    let mut right_greater = false;
    for device in devices {
        match left.counter_for(device).cmp(&right.counter_for(device)) {
            Ordering::Greater => left_greater = true,
            Ordering::Less => right_greater = true,
            Ordering::Equal => {}
        }
    }
    match (left_greater, right_greater) {
        (false, false) => CausalOrder::Equal,
        (true, false) => CausalOrder::Dominates,
        (false, true) => CausalOrder::IsDominated,
        (true, true) => CausalOrder::Concurrent,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncRecord {
    pub record_id: String,
    pub object_id: String,
    pub field: String,
    pub value: Option<Value>,
    pub point: VersionPoint,
    #[serde(default)]
    pub tombstone: bool,
}

impl SyncRecord {
    pub fn validate(&self) -> Result<(), String> {
        if self.record_id.trim().is_empty()
            || self.object_id.trim().is_empty()
            || self.field.trim().is_empty()
            || self.point.device_id.trim().is_empty()
        {
            return Err("同步记录缺少标识或字段".to_string());
        }
        if self.object_id.len() > 512 || self.field.len() > 160 || self.point.context.len() > 256 {
            return Err("同步记录超过大小限制".to_string());
        }
        if self.tombstone && self.value.is_some() {
            return Err("删除记录不能同时携带值".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub id: String,
    pub object_id: String,
    pub field: String,
    pub winner: Option<Value>,
    pub loser: Option<Value>,
    pub winner_device_id: String,
    pub loser_device_id: String,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MergeOutcome {
    pub record: SyncRecord,
    pub conflict: Option<SyncConflict>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupParentEdge {
    pub group_id: String,
    pub parent_id: Option<String>,
    pub point: VersionPoint,
}

fn json_equal(left: &Option<Value>, right: &Option<Value>) -> bool {
    left == right
}

fn deterministic_winner(left: &SyncRecord, right: &SyncRecord) -> bool {
    (
        left.point.modified_at,
        left.point.device_id.as_str(),
        left.point.version,
        left.record_id.as_str(),
    ) >= (
        right.point.modified_at,
        right.point.device_id.as_str(),
        right.point.version,
        right.record_id.as_str(),
    )
}

/// Merge two values for the same logical object/field. A concurrent tie keeps
/// a deterministic winner and records the losing value for UI recovery.
pub fn merge_record_pair(left: &SyncRecord, right: &SyncRecord) -> Result<MergeOutcome, String> {
    left.validate()?;
    right.validate()?;
    if left.object_id != right.object_id || left.field != right.field {
        return Err("只能合并同一对象字段的同步记录".to_string());
    }
    let order = compare_version_points(&left.point, &right.point);
    let left_wins = match order {
        CausalOrder::Dominates | CausalOrder::Equal => true,
        CausalOrder::IsDominated => false,
        CausalOrder::Concurrent => deterministic_winner(left, right),
    };
    let (winner, loser) = if left_wins {
        (left, right)
    } else {
        (right, left)
    };
    let mut record = winner.clone();
    // Preserve both causal histories so the next local edit will dominate both
    // concurrent ancestors rather than creating the same conflict repeatedly.
    record.point.context = VersionPoint::merged_context(&left.point, &right.point);
    record.point.context.remove(&record.point.device_id);
    let conflict = (order == CausalOrder::Concurrent
        && (winner.tombstone != loser.tombstone || !json_equal(&winner.value, &loser.value)))
    .then(|| SyncConflict {
        id: Uuid::new_v4().to_string(),
        object_id: winner.object_id.clone(),
        field: winner.field.clone(),
        winner: winner.value.clone(),
        loser: loser.value.clone(),
        winner_device_id: winner.point.device_id.clone(),
        loser_device_id: loser.point.device_id.clone(),
        created_at: library::now_ms(),
        resolved_at: None,
    });
    Ok(MergeOutcome { record, conflict })
}

fn edge_is_older(left: &GroupParentEdge, right: &GroupParentEdge) -> bool {
    match compare_version_points(&left.point, &right.point) {
        CausalOrder::IsDominated => true,
        CausalOrder::Dominates => false,
        CausalOrder::Equal | CausalOrder::Concurrent => {
            (
                left.point.modified_at,
                left.point.device_id.as_str(),
                left.point.version,
                left.group_id.as_str(),
            ) < (
                right.point.modified_at,
                right.point.device_id.as_str(),
                right.point.version,
                right.group_id.as_str(),
            )
        }
    }
}

/// Return a cycle-free set of group parent edges. A remote merge can create a
/// cycle despite each device having validated its local tree, so retain the
/// newest edge and detach the deterministically oldest edge in every cycle.
pub fn resolve_group_parent_cycles(mut edges: Vec<GroupParentEdge>) -> Vec<GroupParentEdge> {
    loop {
        let lookup: HashMap<String, usize> = edges
            .iter()
            .enumerate()
            .map(|(index, edge)| (edge.group_id.clone(), index))
            .collect();
        let mut changed = false;
        for start in 0..edges.len() {
            let mut path = Vec::<usize>::new();
            let mut seen = HashMap::<String, usize>::new();
            let mut current = Some(start);
            while let Some(index) = current {
                let group_id = edges[index].group_id.clone();
                if let Some(cycle_start) = seen.get(&group_id).copied() {
                    let cycle = &path[cycle_start..];
                    let oldest = *cycle
                        .iter()
                        .min_by(|left, right| {
                            if edge_is_older(&edges[**left], &edges[**right]) {
                                Ordering::Less
                            } else if edge_is_older(&edges[**right], &edges[**left]) {
                                Ordering::Greater
                            } else {
                                Ordering::Equal
                            }
                        })
                        .expect("cycle contains at least one edge");
                    edges[oldest].parent_id = None;
                    changed = true;
                    break;
                }
                seen.insert(group_id, path.len());
                path.push(index);
                current = edges[index]
                    .parent_id
                    .as_ref()
                    .and_then(|parent| lookup.get(parent).copied());
            }
            if changed {
                break;
            }
        }
        if !changed {
            return edges;
        }
    }
}

pub(crate) fn device_id(connection: &Connection) -> Result<String, String> {
    let existing = connection
        .query_row(
            "SELECT value FROM sync_meta WHERE key=?1",
            params![DEVICE_ID_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("无法读取同步设备标识: {error}"))?;
    if let Some(value) = existing.filter(|value| Uuid::parse_str(value).is_ok()) {
        return Ok(value);
    }
    let id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO sync_meta(key,value) VALUES (?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![DEVICE_ID_KEY, id],
        )
        .map_err(|error| format!("无法保存同步设备标识: {error}"))?;
    Ok(id)
}

fn parse_value(raw: Option<String>) -> rusqlite::Result<Option<Value>> {
    raw.map(|value| serde_json::from_str(&value).map_err(|_| rusqlite::Error::InvalidQuery))
        .transpose()
}

fn parse_context(raw: String) -> rusqlite::Result<BTreeMap<String, u64>> {
    serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncRecord> {
    Ok(SyncRecord {
        record_id: row.get(0)?,
        object_id: row.get(1)?,
        field: row.get(2)?,
        value: parse_value(row.get(3)?)?,
        point: VersionPoint {
            device_id: row.get(4)?,
            version: row.get::<_, i64>(5)?.max(0) as u64,
            context: parse_context(row.get(6)?)?,
            modified_at: row.get(7)?,
        },
        tombstone: row.get::<_, i64>(8)? != 0,
    })
}

pub(crate) fn list_records_at(connection: &Connection) -> Result<Vec<SyncRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT record_id,object_id,field,value_json,device_id,version,context_json,modified_at,tombstone
             FROM sync_records ORDER BY object_id,field,device_id",
        )
        .map_err(|error| format!("无法读取同步记录: {error}"))?;
    statement
        .query_map([], row_to_record)
        .map_err(|error| format!("无法读取同步记录: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步记录: {error}"))
}

pub(crate) fn put_record_at(connection: &Connection, record: &SyncRecord) -> Result<(), String> {
    record.validate()?;
    let value_json = record
        .value
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("无法序列化同步记录: {error}"))?;
    let context_json = serde_json::to_string(&record.point.context)
        .map_err(|error| format!("无法序列化同步上下文: {error}"))?;
    connection
        .execute(
            "INSERT INTO sync_records(
               record_id,object_id,field,value_json,device_id,version,context_json,modified_at,tombstone
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(object_id,field,device_id) DO UPDATE SET
               record_id=excluded.record_id,value_json=excluded.value_json,version=excluded.version,
               context_json=excluded.context_json,modified_at=excluded.modified_at,tombstone=excluded.tombstone",
            params![
                record.record_id,
                record.object_id,
                record.field,
                value_json,
                record.point.device_id,
                record.point.version as i64,
                context_json,
                record.point.modified_at,
                i64::from(record.tombstone),
            ],
        )
        .map_err(|error| format!("无法写入同步记录: {error}"))?;
    Ok(())
}

fn record_for_device(
    connection: &Connection,
    object_id: &str,
    field: &str,
    device_id: &str,
) -> Result<Option<SyncRecord>, String> {
    connection
        .query_row(
            "SELECT record_id,object_id,field,value_json,device_id,version,context_json,modified_at,tombstone
             FROM sync_records WHERE object_id=?1 AND field=?2 AND device_id=?3",
            params![object_id, field, device_id],
            row_to_record,
        )
        .optional()
        .map_err(|error| format!("无法读取本地同步记录: {error}"))
}

pub(crate) fn write_local_record_at(
    connection: &Connection,
    object_id: String,
    field: String,
    value: Option<Value>,
    tombstone: bool,
) -> Result<SyncRecord, String> {
    if object_id.trim().is_empty() || field.trim().is_empty() {
        return Err("同步对象和字段不能为空".to_string());
    }
    if tombstone && value.is_some() {
        return Err("删除同步记录不能携带值".to_string());
    }
    let local_device = device_id(connection)?;
    let existing = record_for_device(connection, &object_id, &field, &local_device)?;
    let mut context = existing
        .as_ref()
        .map(|record| record.point.context.clone())
        .unwrap_or_default();
    let next_version = existing
        .as_ref()
        .map(|record| record.point.version.saturating_add(1))
        .unwrap_or(1);
    // Incorporate observed records from other devices for this field.
    for record in list_records_at(connection)?
        .into_iter()
        .filter(|record| record.object_id == object_id && record.field == field)
    {
        for (device, version) in VersionPoint::merged_context(
            &VersionPoint {
                device_id: local_device.clone(),
                version: next_version.saturating_sub(1),
                context: context.clone(),
                modified_at: 0,
            },
            &record.point,
        ) {
            if device != local_device {
                context
                    .entry(device)
                    .and_modify(|current| *current = (*current).max(version))
                    .or_insert(version);
            }
        }
    }
    let record = SyncRecord {
        record_id: Uuid::new_v4().to_string(),
        object_id,
        field,
        value,
        point: VersionPoint {
            device_id: local_device,
            version: next_version,
            context,
            modified_at: library::now_ms(),
        },
        tombstone,
    };
    put_record_at(connection, &record)?;
    Ok(record)
}

pub(crate) fn persist_conflict_at(
    connection: &Connection,
    conflict: &SyncConflict,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO sync_conflicts(
               id,object_id,field,winner_json,loser_json,winner_device_id,loser_device_id,created_at,resolved_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                conflict.id,
                conflict.object_id,
                conflict.field,
                conflict.winner.as_ref().map(serde_json::to_string).transpose().map_err(|error| format!("无法序列化冲突胜者: {error}"))?,
                conflict.loser.as_ref().map(serde_json::to_string).transpose().map_err(|error| format!("无法序列化冲突失败版本: {error}"))?,
                conflict.winner_device_id,
                conflict.loser_device_id,
                conflict.created_at,
                conflict.resolved_at,
            ],
        )
        .map_err(|error| format!("无法写入同步冲突: {error}"))?;
    Ok(())
}

pub(crate) fn merge_remote_records_at(
    connection: &Connection,
    remote: impl IntoIterator<Item = SyncRecord>,
) -> Result<Vec<SyncConflict>, String> {
    let mut by_key: HashMap<(String, String), Vec<SyncRecord>> = HashMap::new();
    for record in list_records_at(connection)? {
        by_key
            .entry((record.object_id.clone(), record.field.clone()))
            .or_default()
            .push(record);
    }
    let mut conflicts = Vec::new();
    for incoming in remote {
        incoming.validate()?;
        let key = (incoming.object_id.clone(), incoming.field.clone());
        let records = by_key.entry(key).or_default();
        // Keep each device's source record so a later edit can acknowledge all
        // observed ancestors. Still compare a new device record with every
        // existing device record now, otherwise a concurrent edit would be
        // silently hidden until a later local write.
        for existing in records
            .iter()
            .filter(|record| record.point.device_id != incoming.point.device_id)
        {
            if let Some(conflict) = merge_record_pair(existing, &incoming)?.conflict {
                persist_conflict_at(connection, &conflict)?;
                conflicts.push(conflict);
            }
        }
        if let Some(index) = records
            .iter()
            .position(|record| record.point.device_id == incoming.point.device_id)
        {
            let outcome = merge_record_pair(&records[index], &incoming)?;
            if let Some(conflict) = outcome.conflict {
                persist_conflict_at(connection, &conflict)?;
                conflicts.push(conflict);
            }
            put_record_at(connection, &outcome.record)?;
            records[index] = outcome.record;
        } else {
            put_record_at(connection, &incoming)?;
            records.push(incoming);
        }
    }
    Ok(conflicts)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SnapshotItem {
    id: String,
    source_id: Option<String>,
    source_kind: String,
    title: String,
    authors: Vec<String>,
    cover_url: Option<String>,
    acquisition_url: Option<String>,
    media_type: Option<String>,
    extension: Option<String>,
    size: Option<i64>,
    etag: Option<String>,
    last_modified: Option<String>,
    series: Option<String>,
    number: Option<String>,
    volume: Option<String>,
    page_count: Option<i64>,
    reading_direction: Option<String>,
    cover_page: Option<i64>,
    blob_hash: Option<String>,
    availability: String,
    offline_pinned: bool,
    subjects: Vec<String>,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SnapshotGroup {
    id: String,
    parent_id: Option<String>,
    name: String,
    kind: String,
    rule: Option<Value>,
    sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SnapshotMembership {
    group_id: String,
    item_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SnapshotDocument {
    id: String,
    content_hash: String,
    title: String,
    availability: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SnapshotAsset {
    hash: String,
    relative_path: String,
    size: u64,
    media_type: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SnapshotDocumentVersion {
    id: String,
    document_id: String,
    blob_hash: String,
    size: u64,
    device_id: Option<String>,
    created_at: i64,
    is_current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SnapshotDraft {
    id: String,
    document_id: Option<String>,
    blob_hash: String,
    title: Option<String>,
    device_id: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncSnapshot {
    schema: u32,
    device_id: String,
    generated_at: i64,
    records: Vec<SyncRecord>,
    items: Vec<SnapshotItem>,
    groups: Vec<SnapshotGroup>,
    memberships: Vec<SnapshotMembership>,
    #[serde(default)]
    documents: Vec<SnapshotDocument>,
    #[serde(default)]
    assets: Vec<SnapshotAsset>,
    #[serde(default)]
    document_versions: Vec<SnapshotDocumentVersion>,
    #[serde(default)]
    drafts: Vec<SnapshotDraft>,
}

fn local_items(connection: &Connection) -> Result<Vec<SnapshotItem>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,source_id,source_kind,title,authors_json,cover_url,acquisition_url,
                    media_type,extension,size,etag,last_modified,series,number,volume,page_count,
                    reading_direction,cover_page,blob_hash,availability,offline_pinned,subjects_json,updated_at
             FROM library_items ORDER BY id",
        )
        .map_err(|error| format!("无法读取同步书籍: {error}"))?;
    statement
        .query_map([], |row| {
            let authors: Vec<String> =
                serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default();
            let subjects: Vec<String> =
                serde_json::from_str(&row.get::<_, String>(21)?).unwrap_or_default();
            Ok(SnapshotItem {
                id: row.get(0)?,
                source_id: row.get(1)?,
                source_kind: row.get(2)?,
                title: row.get(3)?,
                authors,
                cover_url: row.get(5)?,
                acquisition_url: row.get(6)?,
                media_type: row.get(7)?,
                extension: row.get(8)?,
                size: row.get(9)?,
                etag: row.get(10)?,
                last_modified: row.get(11)?,
                series: row.get(12)?,
                number: row.get(13)?,
                volume: row.get(14)?,
                page_count: row.get(15)?,
                reading_direction: row.get(16)?,
                cover_page: row.get(17)?,
                blob_hash: row.get(18)?,
                availability: row.get(19)?,
                offline_pinned: row.get::<_, i64>(20)? != 0,
                subjects,
                updated_at: row.get(22)?,
            })
        })
        .map_err(|error| format!("无法读取同步书籍: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步书籍: {error}"))
}

fn local_groups(connection: &Connection) -> Result<Vec<SnapshotGroup>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,parent_id,name,kind,rule_json,sort_order FROM library_groups ORDER BY id",
        )
        .map_err(|error| format!("无法读取同步分组: {error}"))?;
    statement
        .query_map([], |row| {
            let rule: Option<String> = row.get(4)?;
            Ok(SnapshotGroup {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                name: row.get(2)?,
                kind: row.get(3)?,
                rule: rule.and_then(|value| serde_json::from_str(&value).ok()),
                sort_order: row.get(5)?,
            })
        })
        .map_err(|error| format!("无法读取同步分组: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步分组: {error}"))
}

fn local_memberships(connection: &Connection) -> Result<Vec<SnapshotMembership>, String> {
    let mut statement = connection
        .prepare("SELECT group_id,item_id FROM library_group_members ORDER BY group_id,item_id")
        .map_err(|error| format!("无法读取同步分组成员: {error}"))?;
    statement
        .query_map([], |row| {
            Ok(SnapshotMembership {
                group_id: row.get(0)?,
                item_id: row.get(1)?,
            })
        })
        .map_err(|error| format!("无法读取同步分组成员: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步分组成员: {error}"))
}

fn local_documents(connection: &Connection) -> Result<Vec<SnapshotDocument>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,content_hash,title,availability,created_at,updated_at
             FROM managed_documents ORDER BY id",
        )
        .map_err(|error| format!("无法读取同步文档: {error}"))?;
    statement
        .query_map([], |row| {
            Ok(SnapshotDocument {
                id: row.get(0)?,
                content_hash: row.get(1)?,
                title: row.get(2)?,
                availability: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|error| format!("无法读取同步文档: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步文档: {error}"))
}

fn local_assets(connection: &Connection) -> Result<Vec<SnapshotAsset>, String> {
    let mut statement = connection
        .prepare(
            "SELECT hash,relative_path,size,media_type,created_at,updated_at
             FROM managed_assets ORDER BY hash",
        )
        .map_err(|error| format!("无法读取同步资源: {error}"))?;
    statement
        .query_map([], |row| {
            Ok(SnapshotAsset {
                hash: row.get(0)?,
                relative_path: row.get(1)?,
                size: row.get::<_, i64>(2)?.max(0) as u64,
                media_type: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|error| format!("无法读取同步资源: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步资源: {error}"))
}

fn local_document_versions(
    connection: &Connection,
) -> Result<Vec<SnapshotDocumentVersion>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,document_id,blob_hash,size,device_id,created_at,is_current
             FROM document_versions ORDER BY document_id,created_at DESC,id",
        )
        .map_err(|error| format!("无法读取同步文档版本: {error}"))?;
    statement
        .query_map([], |row| {
            Ok(SnapshotDocumentVersion {
                id: row.get(0)?,
                document_id: row.get(1)?,
                blob_hash: row.get(2)?,
                size: row.get::<_, i64>(3)?.max(0) as u64,
                device_id: row.get(4)?,
                created_at: row.get(5)?,
                is_current: row.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|error| format!("无法读取同步文档版本: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步文档版本: {error}"))
}

fn local_drafts(connection: &Connection) -> Result<Vec<SnapshotDraft>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id,document_id,blob_hash,title,device_id,created_at,updated_at
             FROM document_drafts ORDER BY updated_at DESC,id",
        )
        .map_err(|error| format!("无法读取同步草稿: {error}"))?;
    statement
        .query_map([], |row| {
            Ok(SnapshotDraft {
                id: row.get(0)?,
                document_id: row.get(1)?,
                blob_hash: row.get(2)?,
                title: row.get(3)?,
                device_id: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("无法读取同步草稿: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步草稿: {error}"))
}

fn local_snapshot(connection: &Connection, device_id: String) -> Result<SyncSnapshot, String> {
    Ok(SyncSnapshot {
        schema: 1,
        device_id,
        generated_at: library::now_ms(),
        records: list_records_at(connection)?,
        items: local_items(connection)?,
        groups: local_groups(connection)?,
        memberships: local_memberships(connection)?,
        documents: local_documents(connection)?,
        assets: local_assets(connection)?,
        document_versions: local_document_versions(connection)?,
        drafts: local_drafts(connection)?,
    })
}

async fn ensure_remote_layout(client: &webdav::WebDavClient) -> Result<(), WebDavError> {
    // MKCOL is idempotent in WebDAVClient; creating each parent explicitly also
    // works with servers that reject a deep collection in one request.
    for path in [
        "LightInk",
        "LightInk/v1",
        "LightInk/v1/devices",
        "LightInk/v1/blobs",
        "LightInk/v1/blobs/sha256",
    ] {
        client.mkcol(path).await?;
    }
    Ok(())
}

fn snapshot_device_from_href(href: &str) -> Option<String> {
    let path = Url::parse(href)
        .ok()
        .map(|url| url.path().to_owned())
        .unwrap_or_else(|| href.to_owned());
    let name = path.trim_end_matches('/').rsplit('/').next()?.to_owned();
    if name.ends_with(".json")
        && name.len() <= 200
        && !name.contains(['\\', '?', '#'])
        && uuid::Uuid::parse_str(name.trim_end_matches(".json")).is_ok()
    {
        Some(name.trim_end_matches(".json").to_owned())
    } else {
        None
    }
}

async fn read_remote_snapshots(
    client: &webdav::WebDavClient,
    own_device: &str,
    token: &CancellationToken,
) -> Result<Vec<SyncSnapshot>, WebDavError> {
    let hrefs = client.list_hrefs("LightInk/v1/devices").await?;
    let mut snapshots = Vec::new();
    for href in hrefs {
        if token.is_cancelled() {
            return Err(WebDavError::new("SYNC_CANCELLED", "同步已取消"));
        }
        let Some(device) = snapshot_device_from_href(&href) else {
            continue;
        };
        if device == own_device {
            continue;
        }
        let path = webdav::remote_state_path(&format!("{device}.json"))?;
        let (bytes, _, _) = client
            .get_bytes(&path, MAX_SYNC_RESPONSE_BYTES, Some(token))
            .await?;
        let snapshot: SyncSnapshot = serde_json::from_slice(&bytes).map_err(|error| {
            WebDavError::new(
                "SYNC_REMOTE_SNAPSHOT_INVALID",
                format!("远端设备快照无效: {error}"),
            )
        })?;
        if snapshot.schema != 1 || snapshot.device_id != device {
            return Err(WebDavError::new(
                "SYNC_REMOTE_SNAPSHOT_INVALID",
                "远端设备快照版本或设备标识无效",
            ));
        }
        snapshots.push(snapshot);
    }
    Ok(snapshots)
}

fn apply_snapshot_items(connection: &Connection, items: &[SnapshotItem]) -> Result<(), String> {
    for item in items {
        let local_updated = connection
            .query_row(
                "SELECT updated_at FROM library_items WHERE id=?1",
                params![item.id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("无法读取本地书籍时间: {error}"))?;
        if local_updated.is_some_and(|value| value > item.updated_at) {
            continue;
        }
        let authors = serde_json::to_string(&item.authors)
            .map_err(|error| format!("无法序列化作者: {error}"))?;
        let subjects = serde_json::to_string(&item.subjects)
            .map_err(|error| format!("无法序列化主题: {error}"))?;
        connection
            .execute(
                "INSERT INTO library_items(
                   id,source_id,source_kind,title,authors_json,cover_url,acquisition_url,media_type,
                   extension,size,etag,last_modified,series,number,volume,page_count,reading_direction,
                   cover_page,blob_hash,availability,offline_pinned,subjects_json,updated_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)
                 ON CONFLICT(id) DO UPDATE SET source_id=?2,source_kind=?3,title=?4,authors_json=?5,
                   cover_url=?6,acquisition_url=?7,media_type=?8,extension=?9,size=?10,etag=?11,
                   last_modified=?12,series=?13,number=?14,volume=?15,page_count=?16,reading_direction=?17,
                   cover_page=?18,blob_hash=?19,availability=CASE WHEN library_items.local_path IS NULL THEN ?20 ELSE library_items.availability END,
                   offline_pinned=?21,subjects_json=?22,updated_at=?23",
                params![
                    item.id, item.source_id, item.source_kind, item.title, authors, item.cover_url,
                    item.acquisition_url, item.media_type, item.extension, item.size, item.etag,
                    item.last_modified, item.series, item.number, item.volume, item.page_count,
                    item.reading_direction, item.cover_page, item.blob_hash, item.availability,
                    i64::from(item.offline_pinned), subjects, item.updated_at,
                ],
            )
            .map_err(|error| format!("无法合并远端书籍元数据: {error}"))?;
    }
    Ok(())
}

fn apply_snapshot_groups(
    connection: &Connection,
    groups: &[SnapshotGroup],
    memberships: &[SnapshotMembership],
) -> Result<(), String> {
    // Insert/update nodes without parents first, then apply validated edges.
    for group in groups.iter().filter(|group| group.kind == "custom") {
        let rule = group
            .rule
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| format!("无法序列化分组规则: {error}"))?;
        connection
            .execute(
                "INSERT INTO library_groups(id,parent_id,name,kind,rule_json,sort_order,created_at,updated_at)
                 VALUES (?1,NULL,?2,'custom',?3,?4,?5,?5)
                 ON CONFLICT(id) DO UPDATE SET name=?2,kind='custom',rule_json=?3,sort_order=?4,updated_at=?5",
                params![group.id, group.name, rule, group.sort_order, library::now_ms()],
            )
            .map_err(|error| format!("无法合并远端分组: {error}"))?;
    }
    let edges: Vec<GroupParentEdge> = groups
        .iter()
        .filter(|group| group.kind == "custom")
        .map(|group| GroupParentEdge {
            group_id: group.id.clone(),
            parent_id: group.parent_id.clone(),
            point: VersionPoint {
                device_id: "remote".into(),
                version: 0,
                context: BTreeMap::new(),
                modified_at: 0,
            },
        })
        .collect();
    for edge in resolve_group_parent_cycles(edges) {
        let parent_exists: bool = edge
            .parent_id
            .as_ref()
            .and_then(|parent| {
                connection
                    .query_row(
                        "SELECT 1 FROM library_groups WHERE id=?1",
                        params![parent],
                        |_| Ok(1),
                    )
                    .optional()
                    .ok()
            })
            .flatten()
            .is_some();
        connection
            .execute(
                "UPDATE library_groups SET parent_id=?1 WHERE id=?2",
                params![edge.parent_id.filter(|_| parent_exists), edge.group_id],
            )
            .map_err(|error| format!("无法合并分组层级: {error}"))?;
    }
    for member in memberships {
        let valid: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM library_groups WHERE id=?1 AND kind='custom') AND EXISTS(SELECT 1 FROM library_items WHERE id=?2)",
                params![member.group_id, member.item_id],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if valid {
            connection
                .execute(
                    "INSERT INTO library_group_members(group_id,item_id,created_at) VALUES (?1,?2,?3) ON CONFLICT DO NOTHING",
                    params![member.group_id, member.item_id, library::now_ms()],
                )
                .map_err(|error| format!("无法合并分组成员: {error}"))?;
        }
    }
    Ok(())
}

fn apply_snapshot_documents(
    connection: &Connection,
    documents: &[SnapshotDocument],
    versions: &[SnapshotDocumentVersion],
    drafts: &[SnapshotDraft],
) -> Result<(), String> {
    for document in documents {
        if Uuid::parse_str(&document.id).is_err()
            || document.content_hash.len() != 64
            || !document
                .content_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("远端文档标识或哈希无效".to_string());
        }
        let local_state: Option<(String, Option<String>)> = connection
            .query_row(
                "SELECT content_hash,local_path FROM managed_documents WHERE id=?1",
                params![document.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("无法读取本地文档路径: {error}"))?;
        // A local managed file may be open or dirty. Keep it intact when a
        // remote version arrives; the remote version is still retained below
        // and can be explicitly downloaded/recovered by the user.
        if local_state
            .as_ref()
            .is_some_and(|(hash, path)| path.is_some() && hash != &document.content_hash)
        {
            continue;
        }
        let local_path = local_state.and_then(|(_, path)| path);
        connection
            .execute(
                "INSERT INTO managed_documents(id,content_hash,title,local_path,availability,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(id) DO UPDATE SET content_hash=?2,title=?3,
                   local_path=COALESCE(managed_documents.local_path,?4),availability=CASE
                     WHEN managed_documents.local_path IS NULL THEN ?5 ELSE managed_documents.availability END,
                   updated_at=MAX(managed_documents.updated_at,?7)",
                params![
                    document.id,
                    document.content_hash,
                    document.title,
                    local_path,
                    document.availability,
                    document.created_at,
                    document.updated_at,
                ],
            )
            .map_err(|error| format!("无法合并远端文档: {error}"))?;
    }
    for version in versions {
        if Uuid::parse_str(&version.id).is_err()
            || Uuid::parse_str(&version.document_id).is_err()
            || version.blob_hash.len() != 64
        {
            return Err("远端文档版本标识无效".to_string());
        }
        connection
            .execute(
                "INSERT INTO document_versions(id,document_id,blob_hash,size,device_id,created_at,is_current)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(id) DO UPDATE SET blob_hash=?3,size=?4,device_id=?5,
                   created_at=?6,is_current=?7",
                params![
                    version.id,
                    version.document_id,
                    version.blob_hash,
                    version.size as i64,
                    version.device_id,
                    version.created_at,
                    i64::from(version.is_current),
                ],
            )
            .map_err(|error| format!("无法合并远端文档版本: {error}"))?;
    }
    for draft in drafts {
        if Uuid::parse_str(&draft.id).is_err()
            || draft
                .document_id
                .as_ref()
                .is_some_and(|id| Uuid::parse_str(id).is_err())
            || draft.blob_hash.len() != 64
        {
            return Err("远端草稿标识无效".to_string());
        }
        connection
            .execute(
                "INSERT INTO document_drafts(id,document_id,blob_hash,title,device_id,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(id) DO UPDATE SET document_id=?2,blob_hash=?3,title=?4,
                   device_id=?5,created_at=?6,updated_at=?7",
                params![
                    draft.id,
                    draft.document_id,
                    draft.blob_hash,
                    draft.title,
                    draft.device_id,
                    draft.created_at,
                    draft.updated_at,
                ],
            )
            .map_err(|error| format!("无法合并远端草稿: {error}"))?;
    }
    Ok(())
}

fn safe_app_relative_path(
    app_data: &std::path::Path,
    relative: &str,
) -> Result<PathBuf, WebDavError> {
    let path = std::path::Path::new(relative);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(WebDavError::new("SYNC_PATH_INVALID", "本地资源路径无效"));
    }
    let target = app_data.join(path);
    if !target.starts_with(app_data) {
        return Err(WebDavError::new(
            "SYNC_PATH_INVALID",
            "本地资源路径越出应用目录",
        ));
    }
    Ok(target)
}

async fn upload_local_blobs(
    connection: &Connection,
    app_data_dir: &std::path::Path,
    client: &webdav::WebDavClient,
    token: &CancellationToken,
) -> Result<u64, WebDavError> {
    let mut statement = connection
        .prepare("SELECT hash,size FROM managed_blobs ORDER BY hash")
        .map_err(|error| {
            WebDavError::new("SYNC_STORAGE_ERROR", format!("无法读取受管正文: {error}"))
        })?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| {
            WebDavError::new("SYNC_STORAGE_ERROR", format!("无法读取受管正文: {error}"))
        })?;
    let rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
    drop(statement);
    let mut uploaded = 0_u64;
    for row in rows {
        let (hash, size) =
            row.map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
        if token.is_cancelled() {
            return Err(WebDavError::new("SYNC_CANCELLED", "同步已取消"));
        }
        let path = managed::managed_blob_path(connection, app_data_dir, &hash)
            .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?;
        if !path.is_file() {
            continue;
        }
        let bytes = tokio::fs::read(&path).await.map_err(|error| {
            WebDavError::new("SYNC_STORAGE_ERROR", format!("无法读取受管正文: {error}"))
        })?;
        if bytes.len() as i64 != size {
            return Err(WebDavError::new(
                "SYNC_HASH_MISMATCH",
                "本地受管正文大小不一致",
            ));
        }
        let remote_path = webdav::remote_blob_path(&hash)?;
        client.put_bytes(&remote_path, &bytes, true).await?;
        uploaded = uploaded.saturating_add(1);
    }
    Ok(uploaded)
}

async fn upload_document_blobs(
    connection: &Connection,
    app_data_dir: &std::path::Path,
    client: &webdav::WebDavClient,
    token: &CancellationToken,
) -> Result<u64, WebDavError> {
    let mut candidates: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut statement = connection
        .prepare("SELECT content_hash FROM managed_documents")
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
    let document_hashes = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
    drop(statement);
    for hash in document_hashes {
        let hash =
            hash.map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
        candidates.insert(
            hash.clone(),
            documents::document_blob_path(app_data_dir, &hash)
                .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?,
        );
    }
    let mut statement = connection
        .prepare(
            "SELECT blob_hash FROM document_versions UNION SELECT blob_hash FROM document_drafts",
        )
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
    let hashes = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
    drop(statement);
    for hash in hashes {
        candidates.insert(
            hash.clone(),
            documents::document_blob_path(app_data_dir, &hash)
                .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?,
        );
    }
    let mut statement = connection
        .prepare("SELECT hash,relative_path FROM managed_assets")
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
    let assets = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error.to_string()))?;
    drop(statement);
    for (hash, relative) in assets {
        candidates.insert(hash, safe_app_relative_path(app_data_dir, &relative)?);
    }
    let mut uploaded = 0_u64;
    for (hash, path) in candidates {
        if token.is_cancelled() {
            return Err(WebDavError::new("SYNC_CANCELLED", "同步已取消"));
        }
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) || !path.is_file()
        {
            continue;
        }
        let bytes = tokio::fs::read(&path).await.map_err(|error| {
            WebDavError::new("SYNC_STORAGE_ERROR", format!("无法读取文档资源: {error}"))
        })?;
        client
            .put_bytes(&webdav::remote_blob_path(&hash)?, &bytes, true)
            .await?;
        uploaded = uploaded.saturating_add(1);
    }
    Ok(uploaded)
}

async fn sync_once(
    app: &AppHandle,
    webdav_state: &WebDavState,
    token: &CancellationToken,
) -> Result<SyncStatus, WebDavError> {
    let (_, client) = webdav::active_profile_client(app, webdav_state)?;
    ensure_remote_layout(&client).await?;
    let app_data = library::app_data_dir(app)
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?;
    let connection = library::open_database_at(&app_data)
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?;
    let device =
        device_id(&connection).map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?;
    let uploaded_books = upload_local_blobs(&connection, &app_data, &client, token).await?;
    let uploaded_documents = upload_document_blobs(&connection, &app_data, &client, token).await?;
    let remote = read_remote_snapshots(&client, &device, token).await?;
    let mut conflicts = 0_u64;
    for snapshot in &remote {
        conflicts += merge_remote_records_at(&connection, snapshot.records.clone())
            .map_err(|error| WebDavError::new("SYNC_MERGE_ERROR", error))?
            .len() as u64;
        apply_snapshot_items(&connection, &snapshot.items)
            .map_err(|error| WebDavError::new("SYNC_MERGE_ERROR", error))?;
        apply_snapshot_groups(&connection, &snapshot.groups, &snapshot.memberships)
            .map_err(|error| WebDavError::new("SYNC_MERGE_ERROR", error))?;
        apply_snapshot_documents(
            &connection,
            &snapshot.documents,
            &snapshot.document_versions,
            &snapshot.drafts,
        )
        .map_err(|error| WebDavError::new("SYNC_MERGE_ERROR", error))?;
    }
    let snapshot = local_snapshot(&connection, device.clone())
        .map_err(|error| WebDavError::new("SYNC_STORAGE_ERROR", error))?;
    let body = serde_json::to_vec(&snapshot).map_err(|error| {
        WebDavError::new(
            "SYNC_SNAPSHOT_INVALID",
            format!("无法序列化同步快照: {error}"),
        )
    })?;
    let path = webdav::remote_state_path(&format!("{device}.json"))?;
    client.put_atomic(&path, &body, Some(token)).await?;
    Ok(SyncStatus {
        state: SyncRunState::Success,
        started_at: None,
        finished_at: Some(library::now_ms()),
        last_error: None,
        uploaded: uploaded_books.saturating_add(uploaded_documents),
        downloaded: 0,
        conflicts,
    })
}

#[tauri::command]
pub fn sync_status(state: State<'_, SyncTaskState>) -> Result<SyncStatus, String> {
    status_snapshot(state.inner())
}

#[tauri::command]
pub async fn sync_run(
    app: AppHandle,
    webdav_state: State<'_, WebDavState>,
    state: State<'_, SyncTaskState>,
) -> Result<SyncStatus, String> {
    let (task_id, token) = start_task(state.inner())?;
    let result = sync_once(&app, webdav_state.inner(), &token).await;
    match result {
        Ok(status) => {
            finish_task(state.inner(), &task_id, &Ok(status.clone()));
            Ok(status)
        }
        Err(error) => {
            finish_task(state.inner(), &task_id, &Err(error.clone()));
            Err(error.message)
        }
    }
}

#[tauri::command]
pub fn sync_cancel(state: State<'_, SyncTaskState>) -> Result<(), String> {
    let task = state
        .task
        .lock()
        .map_err(|_| "同步任务状态不可用".to_string())?;
    if let Some((_, token)) = task.as_ref() {
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_download_book(
    app: AppHandle,
    webdav_state: State<'_, WebDavState>,
    item_id: String,
) -> Result<String, String> {
    let (_, client) =
        webdav::active_profile_client(&app, webdav_state.inner()).map_err(|error| error.message)?;
    let app_data = library::app_data_dir(&app)?;
    let connection = library::open_database_at(&app_data)?;
    let (resolved_id, hash, size): (String, String, i64) = connection
        .query_row(
            "SELECT id,blob_hash,size FROM library_items WHERE id=?1 AND blob_hash IS NOT NULL",
            params![item_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                ))
            },
        )
        .map_err(|error| format!("无法读取待下载书籍: {error}"))?;
    let path = managed::managed_blob_path(&connection, &app_data, &hash)?;
    let token = CancellationToken::new();
    let remote_path = webdav::remote_blob_path(&hash).map_err(|error| error.message)?;
    client
        .download_verified(&remote_path, &path, &hash, size.max(0) as u64, Some(&token))
        .await
        .map_err(|error| error.message)?;
    managed::register_downloaded_blob(&connection, &app_data, &hash, size.max(0) as u64)?;
    connection
        .execute(
            "UPDATE library_items SET local_path=?1,availability='local',updated_at=?2 WHERE id=?3",
            params![path.to_string_lossy(), library::now_ms(), resolved_id],
        )
        .map_err(|error| format!("无法更新下载书籍状态: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn sync_download_document(
    app: AppHandle,
    webdav_state: State<'_, WebDavState>,
    document_id: String,
) -> Result<String, String> {
    let (_, client) =
        webdav::active_profile_client(&app, webdav_state.inner()).map_err(|error| error.message)?;
    if Uuid::parse_str(&document_id).is_err() {
        return Err("文档标识无效".to_string());
    }
    let app_data = library::app_data_dir(&app)?;
    let connection = library::open_database_at(&app_data)?;
    let (hash, size, local_path): (String, u64, Option<String>) = connection
        .query_row(
            "SELECT d.content_hash,
                    COALESCE((SELECT size FROM document_versions v WHERE v.document_id=d.id ORDER BY v.created_at DESC LIMIT 1),0),
                    d.local_path
             FROM managed_documents d WHERE d.id=?1",
            params![document_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get::<_, i64>(1)?.max(0) as u64,
                    row.get(2)?,
                ))
            },
        )
        .map_err(|error| format!("无法读取待下载文档: {error}"))?;
    let path = local_path.map(PathBuf::from).unwrap_or_else(|| {
        app_data
            .join("managed-documents")
            .join(&document_id)
            .join("document.md")
    });
    let blob = documents::document_blob_path(&app_data, &hash)?;
    let token = CancellationToken::new();
    let remote_path = webdav::remote_blob_path(&hash).map_err(|error| error.message)?;
    client
        .download_verified(&remote_path, &blob, &hash, size, Some(&token))
        .await
        .map_err(|error| error.message)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("无法创建文档目录: {error}"))?;
    }
    let content = tokio::fs::read_to_string(&blob)
        .await
        .map_err(|error| format!("无法读取已校验的文档正文: {error}"))?;
    write_file_impl(&path, &content)?;
    connection
        .execute(
            "UPDATE managed_documents SET local_path=?1,availability='local',updated_at=?2 WHERE id=?3",
            params![path.to_string_lossy(), library::now_ms(), document_id],
        )
        .map_err(|error| format!("无法更新文档状态: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

pub(crate) fn list_conflicts_at(
    connection: &Connection,
    include_resolved: bool,
) -> Result<Vec<SyncConflict>, String> {
    let where_clause = if include_resolved {
        ""
    } else {
        "WHERE resolved_at IS NULL"
    };
    let mut statement = connection
        .prepare(&format!(
            "SELECT id,object_id,field,winner_json,loser_json,winner_device_id,loser_device_id,created_at,resolved_at
             FROM sync_conflicts {where_clause} ORDER BY created_at DESC,id"
        ))
        .map_err(|error| format!("无法读取同步冲突: {error}"))?;
    statement
        .query_map([], |row| {
            Ok(SyncConflict {
                id: row.get(0)?,
                object_id: row.get(1)?,
                field: row.get(2)?,
                winner: parse_value(row.get(3)?)?,
                loser: parse_value(row.get(4)?)?,
                winner_device_id: row.get(5)?,
                loser_device_id: row.get(6)?,
                created_at: row.get(7)?,
                resolved_at: row.get(8)?,
            })
        })
        .map_err(|error| format!("无法读取同步冲突: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法解析同步冲突: {error}"))
}

#[tauri::command]
pub fn sync_device_id(app: AppHandle) -> Result<String, String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    device_id(&connection)
}

#[tauri::command]
pub fn sync_list_records(app: AppHandle) -> Result<Vec<SyncRecord>, String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    list_records_at(&connection)
}

#[tauri::command]
pub fn sync_write_record(
    app: AppHandle,
    object_id: String,
    field: String,
    value: Option<Value>,
    tombstone: Option<bool>,
) -> Result<SyncRecord, String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    write_local_record_at(
        &connection,
        object_id,
        field,
        value,
        tombstone.unwrap_or(false),
    )
}

#[tauri::command]
pub fn sync_list_conflicts(
    app: AppHandle,
    include_resolved: Option<bool>,
) -> Result<Vec<SyncConflict>, String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    list_conflicts_at(&connection, include_resolved.unwrap_or(false))
}

#[tauri::command]
pub fn sync_resolve_conflict(app: AppHandle, conflict_id: String) -> Result<(), String> {
    let connection = library::open_database_at(&library::app_data_dir(&app)?)?;
    let changed = connection
        .execute(
            "UPDATE sync_conflicts SET resolved_at=?1 WHERE id=?2 AND resolved_at IS NULL",
            params![library::now_ms(), conflict_id],
        )
        .map_err(|error| format!("无法处理同步冲突: {error}"))?;
    if changed == 0 {
        return Err("同步冲突不存在或已处理".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(device_id: &str, version: u64, context: &[(&str, u64)]) -> VersionPoint {
        VersionPoint {
            device_id: device_id.into(),
            version,
            context: context
                .iter()
                .map(|(id, version)| ((*id).to_string(), *version))
                .collect(),
            modified_at: 100,
        }
    }

    fn record(device: &str, version: u64, context: &[(&str, u64)], value: Value) -> SyncRecord {
        SyncRecord {
            record_id: format!("r-{device}-{version}"),
            object_id: "book:one".into(),
            field: "progress".into(),
            value: Some(value),
            point: point(device, version, context),
            tombstone: false,
        }
    }

    #[test]
    fn causal_order_distinguishes_before_after_and_concurrency() {
        let first = point("a", 1, &[]);
        let later = point("a", 2, &[]);
        let concurrent = point("b", 1, &[]);
        assert_eq!(
            compare_version_points(&later, &first),
            CausalOrder::Dominates
        );
        assert_eq!(
            compare_version_points(&first, &later),
            CausalOrder::IsDominated
        );
        assert_eq!(
            compare_version_points(&first, &concurrent),
            CausalOrder::Concurrent
        );
    }

    #[test]
    fn concurrent_same_field_keeps_deterministic_winner_and_conflict() {
        let mut left = record("a", 1, &[], serde_json::json!({"chapter": 2}));
        let mut right = record("b", 1, &[], serde_json::json!({"chapter": 3}));
        left.point.modified_at = 20;
        right.point.modified_at = 21;
        let merged = merge_record_pair(&left, &right).unwrap();
        assert_eq!(merged.record.value, right.value);
        assert_eq!(merged.conflict.as_ref().unwrap().loser, left.value);
        assert_eq!(merged.record.point.context.get("a"), Some(&1));
    }

    #[test]
    fn later_write_dominates_observed_concurrent_values() {
        let left = record("a", 1, &[], serde_json::json!(1));
        let right = record("b", 1, &[], serde_json::json!(2));
        let merged = merge_record_pair(&left, &right).unwrap().record;
        let later = SyncRecord {
            record_id: "r-a-2".into(),
            object_id: "book:one".into(),
            field: "progress".into(),
            value: Some(serde_json::json!(3)),
            point: point("a", 2, &[("b", 1)]),
            tombstone: false,
        };
        assert_eq!(
            compare_version_points(&later.point, &merged.point),
            CausalOrder::Dominates
        );
    }

    #[test]
    fn tombstone_is_a_real_value_for_concurrent_conflicts() {
        let left = record("a", 1, &[], serde_json::json!("present"));
        let mut right = record("b", 1, &[], serde_json::json!("ignored"));
        right.value = None;
        right.tombstone = true;
        assert!(merge_record_pair(&left, &right).unwrap().conflict.is_some());
    }

    #[test]
    fn group_cycles_drop_the_deterministically_oldest_parent_edge() {
        let mut oldest = point("a", 1, &[]);
        oldest.modified_at = 10;
        let mut newest = point("b", 1, &[]);
        newest.modified_at = 20;
        let resolved = resolve_group_parent_cycles(vec![
            GroupParentEdge {
                group_id: "a".into(),
                parent_id: Some("b".into()),
                point: oldest,
            },
            GroupParentEdge {
                group_id: "b".into(),
                parent_id: Some("a".into()),
                point: newest,
            },
        ]);
        assert_eq!(resolved[0].parent_id, None);
        assert_eq!(resolved[1].parent_id.as_deref(), Some("a"));
    }
}
