//! OPDS 1.x Atom feed parsing and authenticated browsing.

use crate::library::{self, OpdsSource};
use crate::remote::{
    fetch_remote_text, forget_credential_value, same_origin, store_credential_value,
    validate_remote_url, RemoteCredential, RemoteError, RemoteState,
};
use quick_xml::events::{BytesCData, BytesRef, BytesStart, BytesText, Event};
use quick_xml::Reader;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use url::Url;

const MAX_OPDS_FEED_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpdsLink {
    pub href: String,
    pub rel: String,
    pub media_type: Option<String>,
    pub title: Option<String>,
    pub size: Option<u64>,
    pub extension: Option<String>,
    pub acquisition: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpdsEntry {
    pub id: String,
    pub item_id: Option<String>,
    pub title: String,
    pub authors: Vec<String>,
    pub updated: Option<String>,
    pub summary: Option<String>,
    pub cover_url: Option<String>,
    pub links: Vec<OpdsLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpdsFeed {
    pub id: Option<String>,
    pub title: String,
    pub updated: Option<String>,
    pub entries: Vec<OpdsEntry>,
    pub links: Vec<OpdsLink>,
    pub next_url: Option<String>,
    pub previous_url: Option<String>,
    pub search_template: Option<String>,
    pub source_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpdsSourceInput {
    pub id: Option<String>,
    pub title: String,
    pub url: String,
    pub allow_http: Option<bool>,
    pub credential_ref: Option<String>,
    pub credential: Option<RemoteCredential>,
    pub clear_credential: Option<bool>,
}

#[derive(Default)]
struct EntryBuilder {
    id: String,
    title: String,
    authors: Vec<String>,
    updated: Option<String>,
    summary: Option<String>,
    content: Option<String>,
    cover_url: Option<String>,
    links: Vec<OpdsLink>,
}

fn local_name(raw: &[u8]) -> String {
    let name = raw.rsplit(|byte| *byte == b':').next().unwrap_or(raw);
    String::from_utf8_lossy(name).to_ascii_lowercase()
}

fn text_value(text: &BytesText<'_>) -> Result<String, RemoteError> {
    text.decode()
        .map(|value| value.into_owned())
        .map_err(|error| RemoteError::new("OPDS_XML_INVALID", format!("XML 文本编码无效: {error}")))
}

fn cdata_value(text: &BytesCData<'_>) -> Result<String, RemoteError> {
    text.decode()
        .map(|value| value.into_owned())
        .map_err(|error| {
            RemoteError::new("OPDS_XML_INVALID", format!("XML CDATA 编码无效: {error}"))
        })
}

fn reference_value(reference: &BytesRef<'_>) -> Result<String, RemoteError> {
    if let Some(value) = reference.resolve_char_ref().map_err(|error| {
        RemoteError::new("OPDS_XML_INVALID", format!("XML 字符引用无效: {error}"))
    })? {
        return Ok(value.to_string());
    }
    let name = reference.decode().map_err(|error| {
        RemoteError::new("OPDS_XML_INVALID", format!("XML 实体编码无效: {error}"))
    })?;
    match name.as_ref() {
        "lt" => Ok("<".into()),
        "gt" => Ok(">".into()),
        "amp" => Ok("&".into()),
        "apos" => Ok("'".into()),
        "quot" => Ok("\"".into()),
        _ => Err(RemoteError::new(
            "OPDS_XML_INVALID",
            format!("OPDS XML 包含未声明实体 &{name};"),
        )),
    }
}

fn attributes(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
) -> Result<Vec<(String, String)>, RemoteError> {
    element
        .attributes()
        .with_checks(true)
        .map(|attribute| {
            let attribute = attribute.map_err(|error| {
                RemoteError::new("OPDS_XML_INVALID", format!("XML 属性无效: {error}"))
            })?;
            let key = local_name(attribute.key.as_ref());
            let value = attribute
                .decode_and_unescape_value(reader.decoder())
                .map_err(|error| {
                    RemoteError::new("OPDS_XML_INVALID", format!("XML 属性编码无效: {error}"))
                })?
                .into_owned();
            Ok((key, value))
        })
        .collect()
}

fn extension_from_href(href: &str) -> Option<String> {
    let path = Url::parse(href)
        .ok()
        .map(|url| url.path().to_string())
        .unwrap_or_else(|| href.to_string());
    let name = path.rsplit('/').next().unwrap_or(&path);
    let (_, extension) = name.rsplit_once('.')?;
    let extension = extension.to_ascii_lowercase();
    (!extension.is_empty()).then_some(extension)
}

fn extension_from_media_type(media_type: Option<&str>, href: &str) -> Option<String> {
    let media_type = media_type.unwrap_or_default().to_ascii_lowercase();
    match media_type.split(';').next().unwrap_or_default().trim() {
        "application/epub+zip" => Some("epub".into()),
        "application/pdf" => Some("pdf".into()),
        "application/vnd.comicbook+zip" | "application/x-cbz" => Some("cbz".into()),
        "application/vnd.rar" | "application/x-rar-compressed" => Some(
            extension_from_href(href)
                .filter(|ext| ext == "cbr")
                .unwrap_or_else(|| "rar".into()),
        ),
        "application/x-7z-compressed" => Some(
            extension_from_href(href)
                .filter(|ext| ext == "cb7")
                .unwrap_or_else(|| "7z".into()),
        ),
        "application/x-mobipocket-ebook" => Some("mobi".into()),
        "application/x-fictionbook+xml" => Some("fb2".into()),
        "text/plain" => Some("txt".into()),
        _ => extension_from_href(href),
    }
}

fn resolve_link_url(base: &Url, href: &str) -> Result<String, RemoteError> {
    let resolved = base
        .join(href)
        .map_err(|_| RemoteError::new("OPDS_LINK_INVALID", "OPDS link URL 无效"))?;
    if !matches!(resolved.scheme(), "http" | "https")
        || resolved.host_str().is_none()
        || !resolved.username().is_empty()
        || resolved.password().is_some()
        || (base.scheme() == "https" && resolved.scheme() == "http")
    {
        return Err(RemoteError::new(
            "OPDS_LINK_INVALID",
            "OPDS link 必须是不含内嵌凭据且不从 HTTPS 降级的 HTTP(S) URL",
        ));
    }
    Ok(resolved.to_string())
}

fn supported_extension(extension: Option<&str>) -> bool {
    matches!(
        extension,
        Some("epub" | "pdf" | "cbz" | "cbr" | "rar" | "cb7" | "7z" | "mobi" | "fb2" | "txt")
    )
}

fn parse_link(
    reader: &Reader<&[u8]>,
    element: &BytesStart<'_>,
    base: &Url,
) -> Result<OpdsLink, RemoteError> {
    let mut href = None;
    let mut rel = "alternate".to_string();
    let mut media_type = None;
    let mut title = None;
    let mut size = None;
    for (key, value) in attributes(reader, element)? {
        match key.as_str() {
            "href" => href = Some(value),
            "rel" => rel = value,
            "type" => media_type = Some(value),
            "title" => title = Some(value),
            "length" => size = value.parse().ok(),
            _ => {}
        }
    }
    let href = href.ok_or_else(|| RemoteError::new("OPDS_LINK_INVALID", "OPDS link 缺少 href"))?;
    let href = resolve_link_url(base, &href)?;
    let extension = extension_from_media_type(media_type.as_deref(), &href);
    let rel_tokens = rel.split_ascii_whitespace().collect::<Vec<_>>();
    let acquisition_rel = rel_tokens
        .iter()
        .any(|token| token.contains("opds-spec.org/acquisition") || *token == "acquisition");
    let acquisition = acquisition_rel && supported_extension(extension.as_deref());
    Ok(OpdsLink {
        href,
        rel,
        media_type,
        title,
        size,
        extension,
        acquisition,
    })
}

fn append_text(target: &mut String, value: &str) {
    target.push_str(value);
}

fn append_optional_text(target: &mut Option<String>, value: &str) {
    target.get_or_insert_with(String::new).push_str(value);
}

fn current_text_field(stack: &[String]) -> Option<&str> {
    if let Some(field) = stack
        .iter()
        .rev()
        .find(|part| matches!(part.as_str(), "summary" | "content"))
    {
        return Some(field);
    }
    if stack.iter().any(|part| part == "author") && stack.iter().any(|part| part == "name") {
        return Some("name");
    }
    stack
        .iter()
        .rev()
        .find(|part| matches!(part.as_str(), "id" | "title" | "updated"))
        .map(String::as_str)
}

fn append_field_text(
    stack: &[String],
    entry: &mut Option<EntryBuilder>,
    feed: &mut OpdsFeed,
    author: &mut String,
    value: &str,
) {
    let name = current_text_field(stack).unwrap_or_default();
    if let Some(current) = entry.as_mut() {
        match name {
            "id" => append_text(&mut current.id, value),
            "title" => append_text(&mut current.title, value),
            "updated" => append_optional_text(&mut current.updated, value),
            "summary" => append_optional_text(&mut current.summary, value),
            "content" => append_optional_text(&mut current.content, value),
            "name" if stack.iter().rev().any(|part| part == "author") => append_text(author, value),
            _ => {}
        }
    } else {
        match name {
            "id" => append_optional_text(&mut feed.id, value),
            "title" => append_text(&mut feed.title, value),
            "updated" => append_optional_text(&mut feed.updated, value),
            _ => {}
        }
    }
}

fn trimmed_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn parse_opds_feed(xml: &str, base_url: &Url) -> Result<OpdsFeed, RemoteError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    reader.config_mut().check_end_names = true;
    let mut stack: Vec<String> = Vec::new();
    let mut feed = OpdsFeed {
        id: None,
        title: String::new(),
        updated: None,
        entries: Vec::new(),
        links: Vec::new(),
        next_url: None,
        previous_url: None,
        search_template: None,
        source_url: base_url.to_string(),
    };
    let mut entry: Option<EntryBuilder> = None;
    let mut author = String::new();
    let mut ignored_markup_depth = 0_usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let name = local_name(element.name().as_ref());
                if matches!(name.as_str(), "script" | "style" | "iframe" | "object") {
                    ignored_markup_depth = ignored_markup_depth.saturating_add(1);
                }
                if name == "entry" {
                    entry = Some(EntryBuilder::default());
                } else if name == "author" {
                    author.clear();
                } else if name == "link" {
                    let link = parse_link(&reader, &element, base_url)?;
                    if let Some(current) = entry.as_mut() {
                        if link.rel.split_ascii_whitespace().any(|rel| {
                            rel.ends_with("/image")
                                || rel.ends_with("/image/thumbnail")
                                || rel == "cover"
                        }) {
                            current.cover_url.get_or_insert_with(|| link.href.clone());
                        }
                        current.links.push(link);
                    } else {
                        feed.links.push(link);
                    }
                }
                stack.push(name);
            }
            Ok(Event::Empty(element)) => {
                if local_name(element.name().as_ref()) == "link" {
                    let link = parse_link(&reader, &element, base_url)?;
                    if let Some(current) = entry.as_mut() {
                        if link.rel.split_ascii_whitespace().any(|rel| {
                            rel.ends_with("/image")
                                || rel.ends_with("/image/thumbnail")
                                || rel == "cover"
                        }) {
                            current.cover_url.get_or_insert_with(|| link.href.clone());
                        }
                        current.links.push(link);
                    } else {
                        feed.links.push(link);
                    }
                }
            }
            Ok(Event::Text(text)) => {
                if ignored_markup_depth == 0 {
                    let value = text_value(&text)?;
                    append_field_text(&stack, &mut entry, &mut feed, &mut author, &value);
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                if ignored_markup_depth == 0 {
                    let value = reference_value(&reference)?;
                    append_field_text(&stack, &mut entry, &mut feed, &mut author, &value);
                }
            }
            Ok(Event::CData(text)) => {
                if ignored_markup_depth == 0 {
                    let value = cdata_value(&text)?;
                    append_field_text(&stack, &mut entry, &mut feed, &mut author, &value);
                }
            }
            Ok(Event::End(element)) => {
                let name = local_name(element.name().as_ref());
                if name == "author" && !author.trim().is_empty() {
                    if let Some(current) = entry.as_mut() {
                        current.authors.push(author.trim().to_string());
                    }
                    author.clear();
                } else if name == "entry" {
                    let mut current = entry.take().unwrap_or_default();
                    current.id = current.id.trim().to_string();
                    current.title = current.title.trim().to_string();
                    current.updated = trimmed_optional(current.updated);
                    current.summary = trimmed_optional(current.summary)
                        .or_else(|| trimmed_optional(current.content));
                    if current.id.is_empty() || current.title.is_empty() {
                        return Err(RemoteError::new(
                            "OPDS_ENTRY_INVALID",
                            "OPDS 条目缺少 id 或 title",
                        ));
                    }
                    feed.entries.push(OpdsEntry {
                        id: current.id,
                        item_id: None,
                        title: current.title,
                        authors: current.authors,
                        updated: current.updated,
                        summary: current.summary,
                        cover_url: current.cover_url,
                        links: current.links,
                    });
                }
                if matches!(name.as_str(), "script" | "style" | "iframe" | "object") {
                    ignored_markup_depth = ignored_markup_depth.saturating_sub(1);
                }
                stack.pop();
            }
            Ok(Event::DocType(_)) => {
                return Err(RemoteError::new(
                    "OPDS_XML_UNSAFE",
                    "OPDS Feed 不允许声明 DTD",
                ));
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(RemoteError::new(
                    "OPDS_XML_INVALID",
                    format!("OPDS XML 损坏: {error}"),
                ));
            }
        }
    }
    feed.id = trimmed_optional(feed.id);
    feed.title = feed.title.trim().to_string();
    feed.updated = trimmed_optional(feed.updated);
    if feed.title.is_empty() {
        return Err(RemoteError::new("OPDS_FEED_INVALID", "OPDS Feed 缺少标题"));
    }
    for link in &feed.links {
        let rels = link.rel.split_ascii_whitespace().collect::<Vec<_>>();
        if rels.contains(&"next") {
            feed.next_url = Some(link.href.clone());
        }
        if rels.contains(&"previous") || rels.contains(&"prev") {
            feed.previous_url = Some(link.href.clone());
        }
        if rels.contains(&"search") && link.href.contains("{searchTerms}") {
            feed.search_template = Some(link.href.clone());
        }
    }
    Ok(feed)
}

fn stable_source_id(url: &Url) -> String {
    let digest = Sha256::digest(url.as_str().as_bytes());
    format!(
        "opds-{}",
        digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn item_id(source_id: &str, entry_id: &str) -> String {
    let digest = Sha256::digest(format!("{source_id}\n{entry_id}").as_bytes());
    format!(
        "opds-item-{}",
        digest[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn persist_feed(app: &AppHandle, source_id: &str, feed: &OpdsFeed) -> Result<(), RemoteError> {
    let mut connection = library::open_database_at(
        &library::app_data_dir(app)
            .map_err(|message| RemoteError::new("OPDS_STORAGE_ERROR", message))?,
    )
    .map_err(|message| RemoteError::new("OPDS_STORAGE_ERROR", message))?;
    let transaction = connection.transaction().map_err(|error| {
        RemoteError::new(
            "OPDS_STORAGE_ERROR",
            format!("无法开启 OPDS 保存事务: {error}"),
        )
    })?;
    for entry in &feed.entries {
        let id = item_id(source_id, &entry.id);
        let acquisitions = entry
            .links
            .iter()
            .filter(|link| link.acquisition)
            .collect::<Vec<_>>();
        let primary = acquisitions.first().copied();
        let authors_json = serde_json::to_string(&entry.authors).map_err(|error| {
            RemoteError::new("OPDS_STORAGE_ERROR", format!("无法保存作者信息: {error}"))
        })?;
        transaction
            .execute(
                "INSERT INTO library_items(
                   id, source_id, source_kind, title, authors_json, cover_url,
                   acquisition_url, media_type, extension, size, availability, updated_at
                 ) VALUES (?1,?2,'opds',?3,?4,?5,?6,?7,?8,?9,'remote',?10)
                 ON CONFLICT(id) DO UPDATE SET title=?3, authors_json=?4, cover_url=?5,
                   acquisition_url=?6, media_type=?7, extension=?8, size=?9, updated_at=?10",
                params![
                    id,
                    source_id,
                    entry.title,
                    authors_json,
                    entry.cover_url,
                    primary.map(|link| link.href.as_str()),
                    primary.and_then(|link| link.media_type.as_deref()),
                    primary.and_then(|link| link.extension.as_deref()),
                    primary.and_then(|link| link.size.map(|size| size.min(i64::MAX as u64) as i64)),
                    library::now_ms(),
                ],
            )
            .map_err(|error| {
                RemoteError::new("OPDS_STORAGE_ERROR", format!("无法保存 OPDS 条目: {error}"))
            })?;
        transaction
            .execute(
                "DELETE FROM acquisition_links WHERE item_id=?1",
                params![id],
            )
            .map_err(|error| {
                RemoteError::new("OPDS_STORAGE_ERROR", format!("无法更新获取链接: {error}"))
            })?;
        for link in acquisitions {
            transaction
                .execute(
                    "INSERT INTO acquisition_links(item_id, href, rel, media_type, extension, size)
                     VALUES (?1,?2,?3,?4,?5,?6)",
                    params![
                        id,
                        link.href,
                        link.rel,
                        link.media_type,
                        link.extension,
                        link.size.map(|size| size.min(i64::MAX as u64) as i64),
                    ],
                )
                .map_err(|error| {
                    RemoteError::new("OPDS_STORAGE_ERROR", format!("无法保存获取链接: {error}"))
                })?;
        }
    }
    transaction.commit().map_err(|error| {
        RemoteError::new(
            "OPDS_STORAGE_ERROR",
            format!("无法提交 OPDS 保存事务: {error}"),
        )
    })?;
    Ok(())
}

fn load_source(app: &AppHandle, source_id: &str) -> Result<OpdsSource, RemoteError> {
    library::library_list_sources(app.clone())
        .map_err(|message| RemoteError::new("OPDS_STORAGE_ERROR", message))?
        .into_iter()
        .find(|source| source.id == source_id)
        .ok_or_else(|| RemoteError::new("OPDS_SOURCE_NOT_FOUND", "OPDS 源不存在"))
}

#[tauri::command]
pub fn opds_add_source(
    app: AppHandle,
    state: State<'_, RemoteState>,
    source: OpdsSourceInput,
) -> Result<OpdsSource, RemoteError> {
    let allow_http = source.allow_http.unwrap_or(false);
    let url = validate_remote_url(&source.url, allow_http)?;
    if source.title.trim().is_empty() {
        return Err(RemoteError::new(
            "OPDS_SOURCE_INVALID",
            "OPDS 源标题不能为空",
        ));
    }
    if source.clear_credential.unwrap_or(false) && source.credential.is_some() {
        return Err(RemoteError::new(
            "OPDS_SOURCE_INVALID",
            "不能同时清除和设置 OPDS 凭据",
        ));
    }
    let existing = source
        .id
        .as_deref()
        .map(|id| load_source(&app, id))
        .transpose()?;
    let id = source.id.unwrap_or_else(|| stable_source_id(&url));
    let credential_ref = if source.clear_credential.unwrap_or(false) {
        None
    } else {
        source
            .credential_ref
            .or_else(|| {
                existing
                    .as_ref()
                    .and_then(|value| value.credential_ref.clone())
            })
            .or_else(|| {
                source
                    .credential
                    .as_ref()
                    .map(|_| format!("opds-source-{id}"))
            })
    };
    if let (Some(reference), Some(credential)) =
        (credential_ref.as_ref(), source.credential.as_ref())
    {
        store_credential_value(&state, reference.clone(), credential.clone())?;
    }
    let now = library::now_ms();
    let saved = OpdsSource {
        id,
        title: source.title.trim().to_string(),
        url: url.to_string(),
        credential_ref,
        allow_http,
        created_at: existing.as_ref().map_or(now, |value| value.created_at),
        updated_at: now,
    };
    library::library_upsert_source(app, saved.clone())
        .map_err(|message| RemoteError::new("OPDS_STORAGE_ERROR", message))?;
    if let Some(old_reference) = existing.and_then(|value| value.credential_ref) {
        if saved.credential_ref.as_deref() != Some(old_reference.as_str()) {
            forget_credential_value(state.inner(), &old_reference)?;
        }
    }
    Ok(saved)
}

#[tauri::command]
pub fn opds_list_sources(app: AppHandle) -> Result<Vec<OpdsSource>, RemoteError> {
    library::library_list_sources(app)
        .map_err(|message| RemoteError::new("OPDS_STORAGE_ERROR", message))
}

#[tauri::command]
pub fn opds_remove_source(
    app: AppHandle,
    state: State<'_, RemoteState>,
    source_id: String,
) -> Result<(), RemoteError> {
    let source = load_source(&app, &source_id)?;
    library::library_remove_source(app, source_id)
        .map_err(|message| RemoteError::new("OPDS_STORAGE_ERROR", message))?;
    if let Some(credential_ref) = source.credential_ref {
        forget_credential_value(state.inner(), &credential_ref)?;
    }
    Ok(())
}

async fn browse_url(
    app: &AppHandle,
    state: &RemoteState,
    source: &OpdsSource,
    url: &str,
) -> Result<OpdsFeed, RemoteError> {
    let source_url = validate_remote_url(&source.url, source.allow_http)?;
    let target_url = validate_remote_url(url, source.allow_http)?;
    let credential_ref = same_origin(&source_url, &target_url)
        .then_some(source.credential_ref.as_deref())
        .flatten();
    let (final_url, xml) = fetch_remote_text(
        state,
        target_url.as_str(),
        source.allow_http,
        credential_ref,
        MAX_OPDS_FEED_BYTES,
    )
    .await?;
    let mut feed = parse_opds_feed(&xml, &final_url)?;
    for entry in &mut feed.entries {
        entry.item_id = Some(item_id(&source.id, &entry.id));
    }
    persist_feed(app, &source.id, &feed)?;
    Ok(feed)
}

#[tauri::command]
pub async fn opds_browse(
    app: AppHandle,
    state: State<'_, RemoteState>,
    source_id: String,
    url: Option<String>,
) -> Result<OpdsFeed, RemoteError> {
    let source = load_source(&app, &source_id)?;
    let url = url.unwrap_or_else(|| source.url.clone());
    browse_url(&app, &state, &source, &url).await
}

#[tauri::command]
pub async fn opds_search(
    app: AppHandle,
    state: State<'_, RemoteState>,
    source_id: String,
    query: String,
) -> Result<OpdsFeed, RemoteError> {
    if query.trim().is_empty() {
        return Err(RemoteError::new("OPDS_SEARCH_INVALID", "搜索词不能为空"));
    }
    let source = load_source(&app, &source_id)?;
    let root = browse_url(&app, &state, &source, &source.url).await?;
    let template = root
        .search_template
        .ok_or_else(|| RemoteError::new("OPDS_SEARCH_UNSUPPORTED", "该 OPDS 源未提供搜索模板"))?;
    let encoded = url::form_urlencoded::byte_serialize(query.trim().as_bytes()).collect::<String>();
    let url = template.replace("{searchTerms}", &encoded);
    browse_url(&app, &state, &source, &url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <id>catalog</id><title>测试书库</title><updated>2026-01-01</updated>
        <link rel="next" href="?page=2" />
        <link rel="search" href="search?q={searchTerms}" type="application/atom+xml" />
        <entry><id>book-1</id><title>Book 10</title><author><name>Alice</name></author>
          <link rel="http://opds-spec.org/acquisition" href="books/a.cbz" type="application/vnd.comicbook+zip" length="123" />
          <link rel="http://opds-spec.org/image" href="covers/a.jpg" type="image/jpeg" />
        </entry>
      </feed>"#;

    #[test]
    fn parses_relative_links_pagination_search_and_cover() {
        let base = Url::parse("https://example.test/opds/index.xml").unwrap();
        let feed = parse_opds_feed(FEED, &base).unwrap();
        assert_eq!(feed.title, "测试书库");
        assert_eq!(
            feed.next_url.as_deref(),
            Some("https://example.test/opds/index.xml?page=2")
        );
        assert_eq!(
            feed.search_template.as_deref(),
            Some("https://example.test/opds/search?q={searchTerms}")
        );
        assert_eq!(feed.entries[0].authors, vec!["Alice"]);
        assert_eq!(
            feed.entries[0].cover_url.as_deref(),
            Some("https://example.test/opds/covers/a.jpg")
        );
        assert!(feed.entries[0].links[0].acquisition);
        assert_eq!(feed.entries[0].links[0].extension.as_deref(), Some("cbz"));
    }

    #[test]
    fn rejects_doctype_and_malformed_documents() {
        let base = Url::parse("https://example.test/opds").unwrap();
        assert_eq!(
            parse_opds_feed("<!DOCTYPE feed><feed><title>x</title></feed>", &base)
                .unwrap_err()
                .code,
            "OPDS_XML_UNSAFE"
        );
        assert!(parse_opds_feed("<feed><title>x</feed>", &base).is_err());
    }

    #[test]
    fn ignores_executable_markup_as_structure() {
        let base = Url::parse("https://example.test/opds").unwrap();
        let feed = parse_opds_feed(
            "<feed><title>safe</title><entry><id>1</id><title>book</title><summary>&lt;script&gt;alert(1)&lt;/script&gt;</summary></entry></feed>",
            &base,
        )
        .unwrap();
        assert_eq!(
            feed.entries[0].summary.as_deref(),
            Some("<script>alert(1)</script>")
        );
    }

    #[test]
    fn joins_text_entities_numeric_references_and_cdata() {
        let base = Url::parse("https://example.test/opds").unwrap();
        let feed = parse_opds_feed(
            "<feed><title>Rock &amp; Roll &#x1F4DA;</title><entry><id>b&#49;</id><title><![CDATA[A < B]]></title><summary>one &lt; two &apos;x&apos; &quot;y&quot;</summary><content>fallback</content></entry></feed>",
            &base,
        )
        .unwrap();
        assert_eq!(feed.title, "Rock & Roll 📚");
        assert_eq!(feed.entries[0].id, "b1");
        assert_eq!(feed.entries[0].title, "A < B");
        assert_eq!(
            feed.entries[0].summary.as_deref(),
            Some("one < two 'x' \"y\"")
        );
    }

    #[test]
    fn rejects_unknown_and_invalid_character_references() {
        let base = Url::parse("https://example.test/opds").unwrap();
        for xml in [
            "<feed><title>&custom;</title></feed>",
            "<feed><title>&#x110000;</title></feed>",
        ] {
            assert_eq!(
                parse_opds_feed(xml, &base).unwrap_err().code,
                "OPDS_XML_INVALID"
            );
        }
    }

    #[test]
    fn flattens_xhtml_summary_without_active_markup() {
        let base = Url::parse("https://example.test/opds").unwrap();
        let feed = parse_opds_feed(
            "<feed><title>safe</title><entry><id>1</id><title><b>book</b></title><summary type=\"xhtml\"><div>Safe <b>text</b><script>alert(1)</script> tail</div></summary></entry></feed>",
            &base,
        )
        .unwrap();
        assert_eq!(feed.entries[0].title, "book");
        assert_eq!(feed.entries[0].summary.as_deref(), Some("Safe text tail"));
    }

    #[test]
    fn rejects_non_http_links_before_they_reach_the_webview() {
        let base = Url::parse("https://example.test/opds").unwrap();
        let error = parse_opds_feed(
            "<feed><title>safe</title><link rel=\"next\" href=\"file:///tmp/feed.xml\" /></feed>",
            &base,
        )
        .unwrap_err();
        assert_eq!(error.code, "OPDS_LINK_INVALID");

        let downgrade = parse_opds_feed(
            "<feed><title>safe</title><link rel=\"next\" href=\"http://example.test/feed.xml\" /></feed>",
            &base,
        )
        .unwrap_err();
        assert_eq!(downgrade.code, "OPDS_LINK_INVALID");
    }
}
