//! Device-local sync records, causal merge and conflict persistence.
//!
//! WebDAV transports immutable blobs and device snapshots. This module owns the
//! small, structured records contained in those snapshots: one value per
//! object/field/device, with a dotted causal context so offline edits can merge
//! without relying on wall-clock order alone.

use crate::library;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use tauri::AppHandle;
use uuid::Uuid;

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
