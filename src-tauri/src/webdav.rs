//! WebDAV 配置与安全传输基础。
//!
//! 该模块只负责同步目标的凭据边界、URL/路径策略和 WebDAV 原语。同步
//! 合并及本地数据库记录由 `sync.rs` 提供；这样网络错误不会直接污染书库。

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_LENGTH, CONTENT_TYPE, DESTINATION};
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

const CONFIG_FILE: &str = "sync-profile.json";
const KEYRING_SERVICE: &str = "lightink.sync";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
pub const MAX_SYNC_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_SYNC_BLOB_BYTES: u64 = 512 * 1024 * 1024;
pub const WEBDAV_ROOT: &str = "LightInk/v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncAuthKind {
    Basic,
    Bearer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SyncCredential {
    Basic { username: String, password: String },
    Bearer { token: String },
}

impl SyncCredential {
    pub fn kind(&self) -> SyncAuthKind {
        match self {
            Self::Basic { .. } => SyncAuthKind::Basic,
            Self::Bearer { .. } => SyncAuthKind::Bearer,
        }
    }

    fn validate(&self) -> Result<(), WebDavError> {
        match self {
            Self::Basic { username, password } => {
                if username.trim().is_empty() || password.is_empty() {
                    return Err(WebDavError::new(
                        "SYNC_CREDENTIAL_INVALID",
                        "Basic 用户名和密码不能为空",
                    ));
                }
            }
            Self::Bearer { token } if token.trim().is_empty() => {
                return Err(WebDavError::new(
                    "SYNC_CREDENTIAL_INVALID",
                    "Bearer 令牌不能为空",
                ));
            }
            Self::Bearer { .. } => {}
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncProfile {
    pub id: String,
    pub name: String,
    pub url: String,
    pub auth_type: SyncAuthKind,
    pub allow_http: bool,
    pub needs_credential: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub url: String,
    pub auth_type: SyncAuthKind,
    pub allow_http: Option<bool>,
    pub credential: Option<SyncCredential>,
    pub clear_credential: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCredentialResult {
    pub credential_ref: String,
    pub persisted: bool,
    pub needs_credential: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavCapability {
    pub reachable: bool,
    pub supports_propfind: bool,
    pub supports_mkcol: bool,
    pub supports_move: bool,
    pub supports_conditional_put: bool,
    pub final_url: String,
    pub server: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebDavError {
    pub code: String,
    pub message: String,
    pub status: Option<u16>,
}

impl WebDavError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: None,
        }
    }

    fn status(code: impl Into<String>, message: impl Into<String>, status: StatusCode) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: Some(status.as_u16()),
        }
    }
}

#[derive(Default)]
pub struct WebDavState {
    session_credentials: Mutex<std::collections::HashMap<String, SyncCredential>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedProfile {
    profile: SyncProfile,
    credential_ref: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

fn credential_ref(profile_id: &str) -> String {
    format!("sync-profile-{}", profile_id)
}

fn keyring_credential(reference: &str) -> Option<SyncCredential> {
    keyring::Entry::new(KEYRING_SERVICE, reference)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|value| serde_json::from_str(&value).ok())
}

fn save_keyring_credential(reference: &str, credential: &SyncCredential) -> bool {
    let Ok(value) = serde_json::to_string(credential) else {
        return false;
    };
    keyring::Entry::new(KEYRING_SERVICE, reference)
        .and_then(|entry| entry.set_password(&value))
        .is_ok()
}

fn delete_keyring_credential(reference: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, reference) {
        let _ = entry.delete_credential();
    }
}

fn load_persisted(app: &AppHandle) -> Result<Option<PersistedProfile>, WebDavError> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| {
            WebDavError::new(
                "SYNC_STORAGE_ERROR",
                format!("无法定位同步配置目录: {error}"),
            )
        })?
        .join(CONFIG_FILE);
    match fs::read_to_string(path) {
        Ok(value) => serde_json::from_str(&value).map(Some).map_err(|error| {
            WebDavError::new("SYNC_CONFIG_INVALID", format!("同步配置损坏: {error}"))
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(WebDavError::new(
            "SYNC_STORAGE_ERROR",
            format!("无法读取同步配置: {error}"),
        )),
    }
}

fn persist_profile(app: &AppHandle, value: &PersistedProfile) -> Result<(), WebDavError> {
    let directory = app.path().app_data_dir().map_err(|error| {
        WebDavError::new(
            "SYNC_STORAGE_ERROR",
            format!("无法定位同步配置目录: {error}"),
        )
    })?;
    fs::create_dir_all(&directory).map_err(|error| {
        WebDavError::new(
            "SYNC_STORAGE_ERROR",
            format!("无法创建同步配置目录: {error}"),
        )
    })?;
    let body = serde_json::to_vec_pretty(value).map_err(|error| {
        WebDavError::new(
            "SYNC_CONFIG_INVALID",
            format!("无法序列化同步配置: {error}"),
        )
    })?;
    let temporary = directory.join(format!(".{CONFIG_FILE}.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, body).map_err(|error| {
        WebDavError::new("SYNC_STORAGE_ERROR", format!("无法写入同步配置: {error}"))
    })?;
    if let Err(error) = fs::rename(&temporary, directory.join(CONFIG_FILE)) {
        let _ = fs::remove_file(&temporary);
        return Err(WebDavError::new(
            "SYNC_STORAGE_ERROR",
            format!("无法提交同步配置: {error}"),
        ));
    }
    Ok(())
}

pub fn validate_webdav_url(raw: &str, allow_http: bool) -> Result<Url, WebDavError> {
    if raw.chars().any(char::is_control) || raw.trim().is_empty() {
        return Err(WebDavError::new(
            "SYNC_URL_INVALID",
            "WebDAV 地址为空或包含控制字符",
        ));
    }
    let mut url = Url::parse(raw.trim())
        .map_err(|_| WebDavError::new("SYNC_URL_INVALID", "WebDAV 地址格式无效"))?;
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(WebDavError::new(
            "SYNC_URL_INVALID",
            "地址不能包含用户名、密码或主机名缺失",
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(WebDavError::new(
            "SYNC_URL_INVALID",
            "WebDAV 根地址不能带查询参数或片段",
        ));
    }
    match url.scheme() {
        "https" => {}
        "http" if allow_http => {}
        "http" => {
            return Err(WebDavError::new(
                "SYNC_HTTP_NOT_ALLOWED",
                "HTTP/LAN 同步必须显式开启",
            ))
        }
        _ => {
            return Err(WebDavError::new(
                "SYNC_SCHEME_UNSUPPORTED",
                "仅支持 HTTP(S) WebDAV",
            ))
        }
    }
    let path = url.path().trim_end_matches('/');
    url.set_path(if path.is_empty() { "/" } else { path });
    Ok(url)
}

pub fn redirect_allowed(from: &Url, to: &Url, authenticated: bool) -> bool {
    if to.host_str().is_none()
        || !to.username().is_empty()
        || to.password().is_some()
        || !matches!(to.scheme(), "http" | "https")
        || (from.scheme() == "https" && to.scheme() == "http")
    {
        return false;
    }
    !authenticated
        || (from.scheme() == to.scheme()
            && from.host_str() == to.host_str()
            && from.port_or_known_default() == to.port_or_known_default())
}

/// 将同步协议的相对路径约束在固定的 `LightInk/v1` 根下。
pub fn validate_relative_path(path: &str) -> Result<String, WebDavError> {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() || trimmed.len() > 1024 || trimmed.chars().any(char::is_control) {
        return Err(WebDavError::new(
            "SYNC_PATH_INVALID",
            "远端路径为空、过长或包含控制字符",
        ));
    }
    let mut parts = Vec::new();
    for component in Path::new(trimmed).components() {
        let Component::Normal(value) = component else {
            return Err(WebDavError::new(
                "SYNC_PATH_INVALID",
                "远端路径不能包含 .、.. 或绝对路径",
            ));
        };
        let value = value
            .to_str()
            .ok_or_else(|| WebDavError::new("SYNC_PATH_INVALID", "远端路径不是有效 UTF-8"))?;
        if value.is_empty() || value == "." || value == ".." || value.contains('\\') {
            return Err(WebDavError::new("SYNC_PATH_INVALID", "远端路径分量无效"));
        }
        parts.push(value.to_owned());
    }
    if parts.is_empty() {
        return Err(WebDavError::new("SYNC_PATH_INVALID", "远端路径为空"));
    }
    Ok(parts.join("/"))
}

pub fn remote_blob_path(hash: &str) -> Result<String, WebDavError> {
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WebDavError::new(
            "SYNC_HASH_INVALID",
            "正文哈希必须是 64 位十六进制 SHA-256",
        ));
    }
    Ok(format!(
        "{WEBDAV_ROOT}/blobs/sha256/{}/{}",
        &hash[..2],
        hash
    ))
}

pub fn remote_state_path(device_id: &str) -> Result<String, WebDavError> {
    let id = validate_relative_path(device_id)?;
    if id.contains('/') || id.ends_with(".json") == false {
        return Err(WebDavError::new(
            "SYNC_DEVICE_ID_INVALID",
            "设备状态路径无效",
        ));
    }
    Ok(format!("{WEBDAV_ROOT}/devices/{id}"))
}

fn build_client(initial: &Url, authenticated: bool) -> Result<Client, WebDavError> {
    let first = initial.clone();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("redirect limit exceeded");
        }
        let from = attempt.previous().last().unwrap_or(&first);
        if !redirect_allowed(from, attempt.url(), authenticated) {
            return attempt.error("unsafe redirect refused");
        }
        attempt.follow()
    });
    Client::builder()
        .redirect(policy)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .referer(false)
        .user_agent(concat!("LightInk/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| {
            WebDavError::new(
                "SYNC_CLIENT_ERROR",
                format!("无法创建 WebDAV 客户端: {error}"),
            )
        })
}

fn apply_credential(
    builder: RequestBuilder,
    credential: Option<&SyncCredential>,
) -> RequestBuilder {
    match credential {
        Some(SyncCredential::Basic { username, password }) => {
            builder.basic_auth(username, Some(password))
        }
        Some(SyncCredential::Bearer { token }) => builder.bearer_auth(token),
        None => builder,
    }
}

fn response_error(response: &Response) -> Option<WebDavError> {
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        Some(WebDavError::status(
            "SYNC_AUTH_REQUIRED",
            "WebDAV 需要重新输入凭据",
            status,
        ))
    } else if status == StatusCode::FORBIDDEN {
        Some(WebDavError::status(
            "SYNC_FORBIDDEN",
            "没有 WebDAV 访问权限",
            status,
        ))
    } else if status.is_client_error() || status.is_server_error() {
        Some(WebDavError::status(
            "SYNC_HTTP_ERROR",
            format!("WebDAV 返回 HTTP {}", status.as_u16()),
            status,
        ))
    } else {
        None
    }
}

fn url_for(base: &Url, relative: &str) -> Result<Url, WebDavError> {
    let relative = validate_relative_path(relative)?;
    let mut url = base.clone();
    let prefix = url.path().trim_end_matches('/');
    url.set_path(&format!("{prefix}/{relative}"));
    Ok(url)
}

#[derive(Clone)]
pub struct WebDavClient {
    base: Url,
    client: Client,
    credential: Option<SyncCredential>,
}

impl WebDavClient {
    pub fn new(base: Url, credential: Option<SyncCredential>) -> Result<Self, WebDavError> {
        if let Some(value) = credential.as_ref() {
            value.validate()?;
        }
        let client = build_client(&base, credential.is_some())?;
        Ok(Self {
            base,
            client,
            credential,
        })
    }

    pub fn url_for(&self, relative: &str) -> Result<Url, WebDavError> {
        url_for(&self.base, relative)
    }

    async fn send_raw(&self, request: RequestBuilder) -> Result<Response, WebDavError> {
        let response = request.send().await.map_err(|error| {
            WebDavError::new("SYNC_NETWORK_ERROR", format!("WebDAV 网络错误: {error}"))
        })?;
        Ok(response)
    }

    async fn send(&self, request: RequestBuilder) -> Result<Response, WebDavError> {
        let response = self.send_raw(request).await?;
        if let Some(error) = response_error(&response) {
            return Err(error);
        }
        Ok(response)
    }

    pub async fn propfind(&self, relative: &str, depth: &str) -> Result<Response, WebDavError> {
        if !matches!(depth, "0" | "1" | "infinity") {
            return Err(WebDavError::new("SYNC_DEPTH_INVALID", "PROPFIND 深度无效"));
        }
        let url = self.url_for(relative)?;
        self.send(apply_credential(
            self.client
                .request(Method::from_bytes(b"PROPFIND").unwrap(), url)
                .header("Depth", depth)
                .header(CONTENT_LENGTH, "0"),
            self.credential.as_ref(),
        ))
        .await
    }

    pub async fn mkcol(&self, relative: &str) -> Result<(), WebDavError> {
        let url = self.url_for(relative)?;
        let response = self
            .send_raw(apply_credential(
                self.client
                    .request(Method::from_bytes(b"MKCOL").unwrap(), url),
                self.credential.as_ref(),
            ))
            .await?;
        if !(response.status().is_success()
            || response.status() == StatusCode::METHOD_NOT_ALLOWED
            || response.status() == StatusCode::CONFLICT)
        {
            return Err(WebDavError::status(
                "SYNC_HTTP_ERROR",
                "创建 WebDAV 目录失败",
                response.status(),
            ));
        }
        Ok(())
    }

    pub async fn get_bytes(
        &self,
        relative: &str,
        max_bytes: u64,
        token: Option<&CancellationToken>,
    ) -> Result<(Vec<u8>, Url, Option<String>), WebDavError> {
        let url = self.url_for(relative)?;
        let response = self
            .send(apply_credential(
                self.client.get(url),
                self.credential.as_ref(),
            ))
            .await?;
        let final_url = response.url().clone();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        if response
            .content_length()
            .is_some_and(|size| size > max_bytes)
        {
            return Err(WebDavError::new(
                "SYNC_RESPONSE_TOO_LARGE",
                "WebDAV 响应超过大小限制",
            ));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = match token {
            Some(token) => {
                tokio::select! { _ = token.cancelled() => return Err(WebDavError::new("SYNC_CANCELLED", "同步已取消")), next = stream.next() => next }
            }
            None => stream.next().await,
        } {
            let chunk = chunk.map_err(|error| {
                WebDavError::new("SYNC_NETWORK_ERROR", format!("WebDAV 下载中断: {error}"))
            })?;
            if bytes.len() as u64 + chunk.len() as u64 > max_bytes {
                return Err(WebDavError::new(
                    "SYNC_RESPONSE_TOO_LARGE",
                    "WebDAV 响应超过大小限制",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((bytes, final_url, content_type))
    }

    pub async fn put_bytes(
        &self,
        relative: &str,
        bytes: &[u8],
        if_none_match: bool,
    ) -> Result<(), WebDavError> {
        if bytes.len() as u64 > MAX_SYNC_BLOB_BYTES {
            return Err(WebDavError::new(
                "SYNC_BLOB_TOO_LARGE",
                "同步正文超过大小限制",
            ));
        }
        let url = self.url_for(relative)?;
        let mut request = self.client.put(url).body(bytes.to_vec());
        if if_none_match {
            request = request.header("If-None-Match", "*");
        }
        let response = self
            .send_raw(apply_credential(request, self.credential.as_ref()))
            .await?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Ok(());
        }
        if !response.status().is_success() {
            return Err(WebDavError::status(
                "SYNC_HTTP_ERROR",
                "WebDAV 条件写入失败",
                response.status(),
            ));
        }
        Ok(())
    }

    /// 通过同目录临时对象 + MOVE 原子提交完整状态快照。
    pub async fn put_atomic(
        &self,
        relative: &str,
        bytes: &[u8],
        token: Option<&CancellationToken>,
    ) -> Result<(), WebDavError> {
        if bytes.len() as u64 > MAX_SYNC_RESPONSE_BYTES {
            return Err(WebDavError::new(
                "SYNC_SNAPSHOT_TOO_LARGE",
                "同步快照超过大小限制",
            ));
        }
        if token.is_some_and(CancellationToken::is_cancelled) {
            return Err(WebDavError::new("SYNC_CANCELLED", "同步已取消"));
        }
        let target = self.url_for(relative)?;
        let temp_relative = format!(
            "{}.tmp-{}",
            validate_relative_path(relative)?,
            Uuid::new_v4()
        );
        let temp = self.url_for(&temp_relative)?;
        let put = self.client.put(temp.clone()).body(bytes.to_vec());
        let response = self
            .send_raw(apply_credential(put, self.credential.as_ref()))
            .await?;
        if !response.status().is_success() {
            return Err(WebDavError::status(
                "SYNC_HTTP_ERROR",
                "WebDAV 临时上传失败",
                response.status(),
            ));
        }
        if token.is_some_and(CancellationToken::is_cancelled) {
            let _ = self.delete(&temp_relative).await;
            return Err(WebDavError::new("SYNC_CANCELLED", "同步已取消"));
        }
        let move_method = Method::from_bytes(b"MOVE").unwrap();
        let response = self
            .send(apply_credential(
                self.client
                    .request(move_method, temp)
                    .header(
                        DESTINATION,
                        HeaderValue::from_str(target.as_str()).map_err(|_| {
                            WebDavError::new("SYNC_URL_INVALID", "MOVE 目标地址无效")
                        })?,
                    )
                    .header("Overwrite", "T"),
                self.credential.as_ref(),
            ))
            .await;
        if response.is_err() {
            let _ = self.delete(&temp_relative).await;
        }
        response.map(|_| ())
    }

    pub async fn delete(&self, relative: &str) -> Result<(), WebDavError> {
        let url = self.url_for(relative)?;
        let response = self
            .send_raw(apply_credential(
                self.client.delete(url),
                self.credential.as_ref(),
            ))
            .await?;
        if !(response.status().is_success() || response.status() == StatusCode::NOT_FOUND) {
            return Err(WebDavError::status(
                "SYNC_HTTP_ERROR",
                "WebDAV 删除失败",
                response.status(),
            ));
        }
        Ok(())
    }

    pub async fn download_verified(
        &self,
        relative: &str,
        destination: &Path,
        expected_hash: &str,
        expected_size: u64,
        token: Option<&CancellationToken>,
    ) -> Result<(), WebDavError> {
        let (bytes, _, _) = self.get_bytes(relative, MAX_SYNC_BLOB_BYTES, token).await?;
        if bytes.len() as u64 != expected_size {
            return Err(WebDavError::new(
                "SYNC_HASH_MISMATCH",
                "下载正文大小校验失败",
            ));
        }
        let digest = Sha256::digest(&bytes);
        let actual = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if actual != expected_hash {
            return Err(WebDavError::new(
                "SYNC_HASH_MISMATCH",
                "下载正文 SHA-256 校验失败",
            ));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| WebDavError::new("SYNC_STORAGE_ERROR", "下载目标路径无效"))?;
        fs::create_dir_all(parent).map_err(|error| {
            WebDavError::new("SYNC_STORAGE_ERROR", format!("无法创建下载目录: {error}"))
        })?;
        let temporary = destination.with_extension(format!("part-{}", Uuid::new_v4()));
        let mut file = tokio::fs::File::create(&temporary).await.map_err(|error| {
            WebDavError::new(
                "SYNC_STORAGE_ERROR",
                format!("无法创建下载临时文件: {error}"),
            )
        })?;
        file.write_all(&bytes).await.map_err(|error| {
            WebDavError::new("SYNC_STORAGE_ERROR", format!("无法写入下载文件: {error}"))
        })?;
        file.sync_all().await.map_err(|error| {
            WebDavError::new("SYNC_STORAGE_ERROR", format!("无法同步下载文件: {error}"))
        })?;
        drop(file);
        tokio::fs::rename(&temporary, destination)
            .await
            .map_err(|error| {
                let _ = std::fs::remove_file(&temporary);
                WebDavError::new("SYNC_STORAGE_ERROR", format!("无法提交下载文件: {error}"))
            })?;
        Ok(())
    }

    pub async fn capability(&self) -> Result<WebDavCapability, WebDavError> {
        let response = self.propfind("LightInk/v1", "0").await?;
        let status = response.status();
        let final_url = response.url().to_string();
        let server = response
            .headers()
            .get("Server")
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        Ok(WebDavCapability {
            reachable: status.is_success() || status == StatusCode::MULTI_STATUS,
            supports_propfind: status.is_success() || status == StatusCode::MULTI_STATUS,
            supports_mkcol: true,
            supports_move: true,
            supports_conditional_put: true,
            final_url,
            server,
        })
    }
}

fn load_credential(state: &WebDavState, reference: &str) -> Option<SyncCredential> {
    keyring_credential(reference).or_else(|| {
        state
            .session_credentials
            .lock()
            .ok()
            .and_then(|values| values.get(reference).cloned())
    })
}

pub fn profile_with_credential(
    app: &AppHandle,
    state: &WebDavState,
    profile: &SyncProfile,
) -> Result<WebDavClient, WebDavError> {
    let url = validate_webdav_url(&profile.url, profile.allow_http)?;
    let reference = credential_ref(&profile.id);
    let credential = load_credential(state, &reference);
    if profile.needs_credential && credential.is_none() {
        return Err(WebDavError::new(
            "SYNC_AUTH_REQUIRED",
            "请先输入 WebDAV 凭据",
        ));
    }
    let _ = app;
    WebDavClient::new(url, credential)
}

#[tauri::command]
pub fn sync_get_profile(app: AppHandle) -> Result<Option<SyncProfile>, WebDavError> {
    Ok(load_persisted(&app)?.map(|value| value.profile))
}

#[tauri::command]
pub fn sync_save_profile(
    app: AppHandle,
    state: State<'_, WebDavState>,
    input: SyncProfileInput,
) -> Result<SyncProfile, WebDavError> {
    save_profile_value(&app, state.inner(), input)
}

fn save_profile_value(
    app: &AppHandle,
    state: &WebDavState,
    input: SyncProfileInput,
) -> Result<SyncProfile, WebDavError> {
    if input.name.trim().is_empty() {
        return Err(WebDavError::new(
            "SYNC_PROFILE_INVALID",
            "同步目标名称不能为空",
        ));
    }
    let allow_http = input.allow_http.unwrap_or(false);
    let url = validate_webdav_url(&input.url, allow_http)?;
    let id = input
        .id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let previous = load_persisted(app)?;
    let reference = credential_ref(&id);
    if input.clear_credential.unwrap_or(false) && input.credential.is_some() {
        return Err(WebDavError::new(
            "SYNC_PROFILE_INVALID",
            "不能同时清除和设置凭据",
        ));
    }
    if let Some(credential) = input.credential.as_ref() {
        credential.validate()?;
        if credential.kind() != input.auth_type {
            return Err(WebDavError::new(
                "SYNC_CREDENTIAL_INVALID",
                "凭据类型与同步目标鉴权类型不匹配",
            ));
        }
        let persisted = save_keyring_credential(&reference, credential);
        if !persisted {
            state
                .session_credentials
                .lock()
                .map_err(|_| WebDavError::new("SYNC_STATE_UNAVAILABLE", "同步凭据状态不可用"))?
                .insert(reference.clone(), credential.clone());
        }
    } else if input.clear_credential.unwrap_or(false) {
        delete_keyring_credential(&reference);
        state
            .session_credentials
            .lock()
            .map_err(|_| WebDavError::new("SYNC_STATE_UNAVAILABLE", "同步凭据状态不可用"))?
            .remove(&reference);
    }
    let has_credential = load_credential(&state, &reference).is_some();
    let profile = SyncProfile {
        id: id.clone(),
        name: input.name.trim().to_owned(),
        url: url.to_string(),
        auth_type: input.auth_type,
        allow_http,
        needs_credential: !has_credential,
        updated_at: now_ms(),
    };
    persist_profile(
        app,
        &PersistedProfile {
            profile: profile.clone(),
            credential_ref: Some(reference),
        },
    )?;
    if let Some(old) = previous.and_then(|value| value.credential_ref) {
        if old != credential_ref(&id) {
            delete_keyring_credential(&old);
        }
    }
    Ok(profile)
}

#[tauri::command]
pub async fn sync_test_profile(
    app: AppHandle,
    state: State<'_, WebDavState>,
    input: SyncProfileInput,
) -> Result<WebDavCapability, WebDavError> {
    let profile = save_profile_value(&app, state.inner(), input)?;
    let client = profile_with_credential(&app, state.inner(), &profile)?;
    client.capability().await
}

#[tauri::command]
pub fn sync_forget_profile(
    app: AppHandle,
    state: State<'_, WebDavState>,
) -> Result<(), WebDavError> {
    if let Some(value) = load_persisted(&app)? {
        if let Some(reference) = value.credential_ref {
            delete_keyring_credential(&reference);
            state
                .session_credentials
                .lock()
                .map_err(|_| WebDavError::new("SYNC_STATE_UNAVAILABLE", "同步凭据状态不可用"))?
                .remove(&reference);
        }
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| {
            WebDavError::new(
                "SYNC_STORAGE_ERROR",
                format!("无法定位同步配置目录: {error}"),
            )
        })?
        .join(CONFIG_FILE);
    match fs::remove_file(path) {
        Ok(()) | Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(WebDavError::new(
            "SYNC_STORAGE_ERROR",
            format!("无法删除同步配置: {error}"),
        )),
    }
}

#[tauri::command]
pub fn sync_store_credential(
    state: State<'_, WebDavState>,
    profile_id: String,
    credential: SyncCredential,
) -> Result<SyncCredentialResult, WebDavError> {
    credential.validate()?;
    let reference = credential_ref(&profile_id);
    let persisted = save_keyring_credential(&reference, &credential);
    if !persisted {
        state
            .session_credentials
            .lock()
            .map_err(|_| WebDavError::new("SYNC_STATE_UNAVAILABLE", "同步凭据状态不可用"))?
            .insert(reference.clone(), credential);
    }
    Ok(SyncCredentialResult {
        credential_ref: reference,
        persisted,
        needs_credential: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_policy_rejects_credentials_and_http_by_default() {
        assert!(validate_webdav_url("https://dav.example/remote", false).is_ok());
        assert!(validate_webdav_url("http://192.168.1.2/dav", false).is_err());
        assert!(validate_webdav_url("http://192.168.1.2/dav", true).is_ok());
        assert!(validate_webdav_url("https://u:p@dav.example", false).is_err());
        assert!(validate_webdav_url("https://dav.example/?token=x", false).is_err());
    }

    #[test]
    fn path_and_blob_layout_are_confined() {
        assert_eq!(
            remote_blob_path(&"a".repeat(64)).unwrap(),
            format!("{WEBDAV_ROOT}/blobs/sha256/aa/{}", "a".repeat(64))
        );
        assert!(validate_relative_path("../escape").is_err());
        assert!(validate_relative_path("/absolute").is_err());
        assert!(remote_blob_path("bad").is_err());
        assert_eq!(
            remote_state_path("device.json").unwrap(),
            "LightInk/v1/devices/device.json"
        );
        assert!(remote_state_path("device").is_err());
    }

    #[test]
    fn authenticated_redirect_must_stay_on_origin_and_never_downgrade() {
        let from = Url::parse("https://dav.example/root").unwrap();
        assert!(redirect_allowed(
            &from,
            &Url::parse("https://dav.example/next").unwrap(),
            true
        ));
        assert!(!redirect_allowed(
            &from,
            &Url::parse("https://other.example/next").unwrap(),
            true
        ));
        assert!(!redirect_allowed(
            &from,
            &Url::parse("http://dav.example/next").unwrap(),
            false
        ));
    }

    #[test]
    fn credential_kind_is_explicit() {
        assert_eq!(
            SyncCredential::Bearer { token: "x".into() }.kind(),
            SyncAuthKind::Bearer
        );
        assert!(SyncCredential::Basic {
            username: String::new(),
            password: "x".into()
        }
        .validate()
        .is_err());
    }
}
