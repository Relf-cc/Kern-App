// @Author Christian Relf
// @Date 2026-10-12

//! Update check: reads the newest release's `latest.json` (the updater
//! manifest the release script publishes) and compares it with the running
//! version. Downloading and installing is done by the updater plugin, from
//! the same manifest; this module also fetches a release's notes for the
//! "What's new" dialog shown after updating.
//!
//! The manifest is a release download, not the GitHub API: the API allows
//! only 60 unauthenticated requests an hour per address, which polling
//! used up (and a failed check silently kept reporting an old version).

use crate::domain::settings;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use semver::Version;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const MANIFEST_URL: &str = "https://github.com/Relf-cc/Kern-App/releases/latest/download/latest.json";
const RELEASES_API: &str = "https://api.github.com/repos/Relf-cc/Kern-App/releases";
pub const RELEASES_PAGE: &str = "https://github.com/Relf-cc/Kern-App/releases";

/// Marks a security release: written at the top of its notes (an HTML
/// comment, so invisible on GitHub). `npm run release -- --security` adds it.
pub const SECURITY_MARKER: &str = "<!-- kern:security -->";

/// Debug builds can point the check at a local stand-in (`KERN_UPDATE_MANIFEST`,
/// `KERN_RELEASES_API`) to try the update flow; release builds always ask GitHub.
fn debug_override(var: &str, default: &str) -> String {
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var(var) {
        return url;
    }
    let _ = var;
    default.to_string()
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .http_status_as_error(false)
        .user_agent("Kern")
        .build()
        .into()
}

fn network_allowed(app: &AppHandle) -> AppResult<bool> {
    app.state::<AppState>().with(|c| Ok(settings::get_or(c, "privacy.network", true)))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    /// The newest release when it is newer than the running version.
    pub latest: Option<String>,
    pub url: String,
    /// The running version is older than the oldest one without known
    /// security issues, so the update is required (Kern installs it without
    /// asking).
    pub security: bool,
}

fn parse(tag: &str) -> Option<Version> {
    Version::parse(tag.trim().trim_start_matches(['v', 'V'])).ok()
}

fn release_page(v: &Version) -> String {
    format!("{RELEASES_PAGE}/tag/v{v}")
}

/// The newest release's manifest, or None when the newest release has none.
fn fetch_manifest(agent: &ureq::Agent) -> AppResult<Option<Value>> {
    let mut resp = agent
        .get(&debug_override("KERN_UPDATE_MANIFEST", MANIFEST_URL))
        .call()
        .map_err(|e| AppError::Network(format!("Couldn't reach GitHub ({e}).")))?;
    match resp.status().as_u16() {
        404 => return Ok(None),
        s if s >= 400 => return Err(AppError::Network(format!("GitHub returned {s}."))),
        _ => {}
    }
    let text = resp.body_mut().with_config().limit(1024 * 1024).read_to_string().map_err(|e| AppError::Network(e.to_string()))?;
    serde_json::from_str(&text).map(Some).map_err(|e| AppError::Network(format!("Unexpected update manifest ({e}).")))
}

/// The oldest version without known security issues, per the manifest: its
/// `kern.minSecureVersion` (carried forward by every release after a
/// security release), or the release itself when its notes carry the
/// security marker.
fn min_secure_version(m: &Value) -> Option<Version> {
    let field = m.pointer("/kern/minSecureVersion").and_then(Value::as_str).and_then(parse);
    let marked = m
        .get("notes")
        .and_then(Value::as_str)
        .is_some_and(|n| n.to_ascii_lowercase().contains(SECURITY_MARKER))
        .then(|| m.get("version").and_then(Value::as_str).and_then(parse))
        .flatten();
    field.max(marked)
}

fn info_from_manifest(m: &Value, current: &str, cur: &Version) -> UpdateInfo {
    let latest = m.get("version").and_then(Value::as_str).and_then(parse).filter(|v| v > cur);
    UpdateInfo {
        current: current.to_string(),
        security: latest.is_some() && min_secure_version(m).is_some_and(|min| *cur < min),
        url: latest.as_ref().map(release_page).unwrap_or_else(|| RELEASES_PAGE.to_string()),
        latest: latest.map(|v| v.to_string()),
    }
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> AppResult<UpdateInfo> {
    let current = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let none = UpdateInfo { current: current.clone(), latest: None, url: RELEASES_PAGE.to_string(), security: false };
        let Some(cur) = parse(&current) else { return Ok(none) };
        if !network_allowed(&app)? {
            return Ok(none);
        }
        Ok(match fetch_manifest(&agent())? {
            Some(m) => info_from_manifest(&m, &current, &cur),
            None => none,
        })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNotes {
    pub version: String,
    pub name: String,
    /// Markdown, as written on the release page.
    pub body: String,
    pub url: String,
    pub published_at: Option<String>,
}

/// The notes of the release tagged `v{version}`: from its GitHub release, or,
/// when the API can't answer (it's rate limited), from the newest release's
/// manifest if that's the same version.
#[tauri::command]
pub async fn release_notes(app: AppHandle, version: String) -> AppResult<ReleaseNotes> {
    let Some(v) = parse(&version) else {
        return Err(AppError::Invalid(format!("'{version}' isn't a version.")));
    };
    tauri::async_runtime::spawn_blocking(move || {
        if !network_allowed(&app)? {
            return Err(AppError::Network("Network access is turned off in Settings → Privacy.".into()));
        }
        let agent = agent();
        match notes_from_api(&agent, &v) {
            Ok(n) => Ok(n),
            Err(e) => fetch_manifest(&agent).ok().flatten().and_then(|m| notes_from_manifest(&m, &v)).ok_or(e),
        }
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

fn notes_from_api(agent: &ureq::Agent, v: &Version) -> AppResult<ReleaseNotes> {
    let url = format!("{}/tags/v{v}", debug_override("KERN_RELEASES_API", RELEASES_API));
    let mut resp = agent
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| AppError::Network(format!("Couldn't reach GitHub ({e}).")))?;
    match resp.status().as_u16() {
        404 => return Err(AppError::NotFound(format!("Release v{v}"))),
        s if s >= 400 => return Err(AppError::Network(format!("GitHub returned {s}."))),
        _ => {}
    }
    let text = resp.body_mut().with_config().limit(1024 * 1024).read_to_string().map_err(|e| AppError::Network(e.to_string()))?;
    let r: Value = serde_json::from_str(&text).map_err(|e| AppError::Network(format!("Unexpected reply from GitHub ({e}).")))?;
    Ok(notes_from_release(&r, v))
}

fn notes_from_release(r: &Value, v: &Version) -> ReleaseNotes {
    let s = |k: &str| r.get(k).and_then(Value::as_str).map(str::to_string);
    ReleaseNotes {
        version: v.to_string(),
        name: s("name").filter(|n| !n.trim().is_empty()).unwrap_or_else(|| format!("Kern {v}")),
        body: s("body").unwrap_or_default(),
        url: s("html_url").unwrap_or_else(|| release_page(v)),
        published_at: s("published_at"),
    }
}

fn notes_from_manifest(m: &Value, v: &Version) -> Option<ReleaseNotes> {
    let mv = m.get("version").and_then(Value::as_str).and_then(parse)?;
    (mv == *v).then(|| ReleaseNotes {
        version: v.to_string(),
        name: format!("Kern {v}"),
        body: m.get("notes").and_then(Value::as_str).unwrap_or_default().to_string(),
        url: release_page(v),
        published_at: m.get("pub_date").and_then(Value::as_str).map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn info(m: Value, current: &str) -> UpdateInfo {
        info_from_manifest(&m, current, &parse(current).unwrap())
    }

    #[test]
    fn offers_a_newer_release() {
        let i = info(json!({ "version": "0.1.12", "notes": "Fixes" }), "0.1.11");
        assert_eq!((i.latest.as_deref(), i.security, i.url.as_str()), (Some("0.1.12"), false, "https://github.com/Relf-cc/Kern-App/releases/tag/v0.1.12"));
        assert!(info(json!({ "version": "0.1.12" }), "0.1.12").latest.is_none());
        assert!(info(json!({ "version": "0.1.11" }), "0.1.12").latest.is_none());
        assert!(info(json!({ "version": "nightly" }), "0.1.12").latest.is_none());
    }

    #[test]
    fn a_marked_release_is_required() {
        let m = json!({ "version": "0.1.12", "notes": "<!-- KERN:SECURITY -->\n## What's new" });
        assert!(info(m.clone(), "0.1.11").security);
        assert!(!info(m, "0.1.12").security);
    }

    #[test]
    fn a_skipped_security_release_still_requires_the_update() {
        // 0.1.12 was a security release; 0.1.13 isn't, but carries it forward.
        let m = json!({ "version": "0.1.13", "notes": "Small fixes", "kern": { "minSecureVersion": "0.1.12" } });
        let i = info(m.clone(), "0.1.10");
        assert_eq!((i.latest.as_deref(), i.security), (Some("0.1.13"), true));
        // Already past it: an ordinary update.
        assert!(!info(m, "0.1.12").security);
    }

    #[test]
    fn reads_release_notes() {
        let v = parse("0.2.0").unwrap();
        let n = notes_from_release(&json!({ "name": "", "body": "## What's new", "html_url": "u", "published_at": "2026-10-14T00:00:00Z" }), &v);
        assert_eq!((n.name.as_str(), n.body.as_str(), n.url.as_str()), ("Kern 0.2.0", "## What's new", "u"));
        assert_eq!(notes_from_release(&json!({}), &v).url, "https://github.com/Relf-cc/Kern-App/releases/tag/v0.2.0");
    }

    #[test]
    fn falls_back_to_the_manifests_notes() {
        let m = json!({ "version": "0.2.0", "notes": "## What's new\n- x", "pub_date": "2026-10-15T00:00:00Z" });
        let n = notes_from_manifest(&m, &parse("0.2.0").unwrap()).unwrap();
        assert_eq!((n.body.as_str(), n.published_at.as_deref()), ("## What's new\n- x", Some("2026-10-15T00:00:00Z")));
        assert!(notes_from_manifest(&m, &parse("0.1.0").unwrap()).is_none());
    }
}
