// @Author Christian Relf
// @Date 2026-10-13

//! HTTP client for the Kern Cloud API (api.relf.cloud/kern/v1).
//!
//! The session token lives in the OS credential store and is only ever used
//! here, in the backend; the interface never sees it. The realtime socket is
//! opened by the interface with a short-lived ticket instead.

use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::time::Duration;

pub const DEFAULT_API: &str = "https://api.relf.cloud/kern/v1";
/// Credential-store entry holding the session token.
pub const TOKEN_REF: &str = "kern-cloud-session";

/// The API base: `KERN_CLOUD_URL` (development or self-hosting), or the
/// public server.
///
/// Deliberately not a setting. The session token is sent as a bearer to
/// whatever this returns, so a value the front end could write would let
/// anything running in the webview point the token at a host of its own
/// choosing - and these requests are made here, in Rust, where the window's
/// CSP cannot refuse them. The environment is set by whoever starts Kern,
/// which the webview cannot do.
pub fn api_base() -> String {
    from_env(std::env::var("KERN_CLOUD_URL").ok())
}

/// The rule on its own, taking the environment value rather than reading it,
/// so it can be tested without disturbing the process environment.
fn from_env(raw: Option<String>) -> String {
    raw.filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_API.to_string())
        .trim_end_matches('/')
        .to_string()
}

pub fn ws_url(base: &str) -> String {
    let ws = if let Some(rest) = base.strip_prefix("https://") { format!("wss://{rest}") } else { base.replacen("http://", "ws://", 1) };
    format!("{ws}/realtime")
}

pub struct Reply {
    pub status: u16,
    pub body: Value,
    /// A new session token (sign-in and verification responses).
    pub token: Option<String>,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .user_agent(concat!("Kern/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

/// Sends a request. `path` is relative to the API base and must start with "/".
pub fn request(base: &str, token: Option<&str>, method: &str, path: &str, body: Option<&Value>) -> AppResult<Reply> {
    if !path.starts_with('/') || path.contains("..") || path.contains("://") {
        return Err(AppError::Invalid("Unexpected Kern Cloud address.".into()));
    }
    let url = format!("{base}{path}");
    let origin = url::Url::parse(base).map(|u| u.origin().ascii_serialization()).unwrap_or_default();
    let agent = agent();
    let auth = token.map(|t| format!("Bearer {t}"));
    macro_rules! headers {
        ($req:expr) => {{
            let mut r = $req.header("Accept", "application/json").header("Origin", &origin);
            if let Some(a) = &auth {
                r = r.header("Authorization", a);
            }
            r
        }};
    }
    let res = match method {
        "GET" => headers!(agent.get(&url)).call(),
        "DELETE" => headers!(agent.delete(&url)).call(),
        m => {
            let payload = body.map(|b| b.to_string()).unwrap_or_else(|| "{}".into());
            let req = match m {
                "POST" => agent.post(&url),
                "PATCH" => agent.patch(&url),
                "PUT" => agent.put(&url),
                _ => return Err(AppError::Invalid("Unsupported request.".into())),
            };
            headers!(req).header("Content-Type", "application/json").send(payload)
        }
    };
    let mut resp = res.map_err(|_| AppError::Network("Couldn't reach Kern Cloud. Check your internet connection and try again.".into()))?;
    let status = resp.status().as_u16();
    let token = resp.headers().get("set-auth-token").and_then(|v| v.to_str().ok()).map(String::from);
    let text = resp.body_mut().with_config().limit(64 * 1024 * 1024).read_to_string().unwrap_or_default();
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Ok(Reply { status, body, token })
}

/// A binary request (image upload or download). Error replies are decoded
/// as JSON into `Reply::body`; success bodies are returned as bytes.
pub fn request_bytes(base: &str, token: &str, method: &str, path: &str, upload: Option<(&[u8], &str)>) -> AppResult<(Reply, Vec<u8>, Option<String>)> {
    if !path.starts_with('/') || path.contains("..") || path.contains("://") {
        return Err(AppError::Invalid("Unexpected Kern Cloud address.".into()));
    }
    let url = format!("{base}{path}");
    let origin = url::Url::parse(base).map(|u| u.origin().ascii_serialization()).unwrap_or_default();
    let auth = format!("Bearer {token}");
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(120)))
        .http_status_as_error(false)
        .user_agent(concat!("Kern/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let agent: ureq::Agent = agent;
    let res = match (method, upload) {
        ("POST", Some((bytes, mime))) => agent.post(&url).header("Authorization", &auth).header("Origin", &origin).header("Content-Type", mime).send(bytes),
        ("GET", None) => agent.get(&url).header("Authorization", &auth).header("Origin", &origin).call(),
        _ => return Err(AppError::Invalid("Unsupported request.".into())),
    };
    let mut resp = res.map_err(|_| AppError::Network("Couldn't reach Kern Cloud. Check your internet connection and try again.".into()))?;
    let status = resp.status().as_u16();
    let content_type = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).map(String::from);
    let bytes = resp.body_mut().with_config().limit(32 * 1024 * 1024).read_to_vec().unwrap_or_default();
    let is_json = content_type.as_deref().map(|c| c.starts_with("application/json")).unwrap_or(false);
    let body = if is_json { serde_json::from_slice(&bytes).unwrap_or(Value::Null) } else { Value::Null };
    Ok((Reply { status, body, token: None }, bytes, content_type))
}

/// Turns an error reply into a user-facing error.
pub fn check(reply: AppResult<Reply>) -> AppResult<Reply> {
    let reply = reply?;
    if reply.status < 400 {
        return Ok(reply);
    }
    let code = reply.body.get("code").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let message = reply.body.get("message").and_then(|m| m.as_str()).filter(|m| !m.is_empty()).map(String::from);
    let msg = |fallback: &str| message.clone().unwrap_or_else(|| fallback.to_string());
    Err(match reply.status {
        401 if code == "INVALID_EMAIL_OR_PASSWORD" => AppError::Invalid("That email and password don't match an account.".into()),
        401 => AppError::Auth(msg("Your Kern Cloud session has ended. Sign in again.")),
        403 if code == "EMAIL_NOT_VERIFIED" || code == "unverified" => AppError::Unverified(msg("Confirm your email address first.")),
        429 => AppError::Network("Too many attempts. Wait a minute, then try again.".into()),
        s if s >= 500 => AppError::Network(format!("Kern Cloud is having trouble right now ({s}). Try again shortly.")),
        404 if message.is_none() => AppError::NotFound("That".into()),
        413 => AppError::Invalid(msg("That's too large for Kern Cloud.")),
        _ => AppError::Invalid(msg("Kern Cloud couldn't do that.")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_url_follows_the_api() {
        assert_eq!(ws_url("https://api.relf.cloud/kern/v1"), "wss://api.relf.cloud/kern/v1/realtime");
        assert_eq!(ws_url("http://localhost:8787/kern/v1"), "ws://localhost:8787/kern/v1/realtime");
    }

    #[test]
    fn paths_stay_on_the_api() {
        assert!(request("https://api.relf.cloud/kern/v1", None, "GET", "https://evil.example/x", None).is_err());
        assert!(request("https://api.relf.cloud/kern/v1", None, "GET", "/../x", None).is_err());
    }

    #[test]
    fn the_api_host_comes_only_from_the_environment() {
        // The session token is sent to whatever api_base returns, so nothing
        // the front end can write may change it - only the environment, set
        // by whoever launches Kern.
        assert_eq!(from_env(None), DEFAULT_API);
        assert_eq!(from_env(Some("  ".into())), DEFAULT_API);
        assert_eq!(from_env(Some("http://localhost:8787/kern/v1/".into())), "http://localhost:8787/kern/v1");
    }

    #[test]
    fn errors_map_to_actionable_codes() {
        let r = |status, body: Value| check(Ok(Reply { status, body, token: None })).err().unwrap().code();
        assert_eq!(r(401, serde_json::json!({})), "auth");
        assert_eq!(r(403, serde_json::json!({"code": "EMAIL_NOT_VERIFIED", "message": "Email not verified"})), "unverified");
        assert_eq!(r(401, serde_json::json!({"code": "INVALID_EMAIL_OR_PASSWORD"})), "invalid");
        assert_eq!(r(503, serde_json::json!(null)), "network");
    }
}
