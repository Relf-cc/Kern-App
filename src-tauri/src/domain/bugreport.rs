// @Author Christian Relf
// @Date 2026-10-24

//! Bug reports: the sidebar's "Report a bug" sends what the person wrote to a
//! Kern Cloud stream that belongs to the Kern workspace, where it becomes a
//! task. Reporters need no account and join nothing - a stream can only add
//! to its space, and replies never carry ids from it.
//!
//! The stream is created from the server's `bug_report` preset, so the keys
//! below (title, description, steps, severity, email) are its fields and the
//! severity picks the task's priority. It is a *public* stream with "require
//! Origin" off: its address ships in every copy of Kern, so a token would be
//! no more secret, and this request comes from Rust rather than a browser
//! page. The stream's own rate limits, size limit and duplicate window apply.
//!
//! Each report carries an idempotency key chosen when the dialog opens, so
//! retrying after a timeout never files it twice.

use crate::domain::settings;
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The Kern workspace's bug report stream (Streams → the stream → Address).
/// Empty turns the feature off. Served from the API host: streams.relf.cc
/// isn't routed to Kern Cloud yet.
const STREAM_URL: &str = "https://api.relf.cc/kern/4518edb906c527003aa2ef8e54f01f12c48dd2685af899f52c6e08852bc8030b";

const SEVERITIES: [&str; 4] = ["low", "medium", "high", "critical"];
const TITLE_MAX: usize = 200;
const TEXT_MAX: usize = 5000;
const EMAIL_MAX: usize = 254;

/// Debug builds can send reports to a local server's stream instead
/// (`KERN_BUG_REPORT_URL`); release builds always use the Kern workspace's.
fn stream_url() -> String {
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("KERN_BUG_REPORT_URL") {
        return url;
    }
    STREAM_URL.to_string()
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BugReport {
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub steps: String,
    pub severity: Option<String>,
    /// Where the Kern team can reply; optional.
    #[serde(default)]
    pub email: String,
    /// Adds the Kern version and operating system.
    #[serde(default)]
    pub include_system: bool,
}

/// The JSON body for the stream, or why the report can't be sent as written.
pub fn payload(r: &BugReport, version: &str, os: &str, arch: &str) -> AppResult<Value> {
    let title = r.title.trim();
    let description = r.description.trim();
    let steps = r.steps.trim();
    let email = r.email.trim();
    if title.is_empty() {
        return invalid("Add a summary of the problem.");
    }
    if title.chars().count() > TITLE_MAX {
        return invalid(format!("The summary can be at most {TITLE_MAX} characters."));
    }
    if description.is_empty() {
        return invalid("Describe what happened.");
    }
    if description.chars().count() > TEXT_MAX || steps.chars().count() > TEXT_MAX {
        return invalid(format!("The description and steps can be at most {TEXT_MAX} characters each."));
    }
    if !email.is_empty() && (email.len() > EMAIL_MAX || !valid_email(email)) {
        return invalid("That contact email doesn't look right.");
    }

    let mut body = Map::new();
    body.insert("title".into(), json!(title));
    body.insert("description".into(), json!(description));
    if !steps.is_empty() {
        body.insert("steps".into(), json!(steps));
    }
    if let Some(s) = r.severity.as_deref().filter(|s| !s.is_empty()) {
        if !SEVERITIES.contains(&s) {
            return invalid(format!("'{s}' isn't a severity."));
        }
        body.insert("severity".into(), json!(s));
    }
    if !email.is_empty() {
        body.insert("email".into(), json!(email));
    }
    if r.include_system {
        body.insert("version".into(), json!(version));
        body.insert("os".into(), json!(format!("{os} ({arch})")));
    }
    Ok(Value::Object(body))
}

/// The same shape the server accepts: something@something.tld.
fn valid_email(s: &str) -> bool {
    let Some((local, host)) = s.split_once('@') else { return false };
    let Some((name, tld)) = host.rsplit_once('.') else { return false };
    !local.is_empty() && local.len() <= 64 && !name.is_empty() && tld.len() >= 2 && !s.chars().any(|c| c.is_whitespace()) && !host.contains('@')
}

/// What the stream's reply means for the person who sent the report: the
/// stream's thank-you message, or an error worth showing them.
pub fn outcome(status: u16, body: &Value, retry_after: Option<&str>) -> AppResult<String> {
    let message = body.get("message").and_then(Value::as_str).map(str::trim).filter(|m| !m.is_empty());
    match status {
        200..=202 => Ok(message.unwrap_or("Thanks - the Kern team has your report.").to_string()),
        413 => invalid("That report is too long. Shorten the description or the steps."),
        422 => invalid(message.unwrap_or("Kern Cloud didn't accept one of the fields.").to_string()),
        429 => {
            let minutes = retry_after.and_then(|s| s.trim().parse::<u64>().ok()).map(|s| s.div_ceil(60).max(1));
            Err(AppError::Network(match minutes {
                Some(1) => "You've sent several reports in a row. Try again in a minute.".into(),
                Some(m) => format!("You've sent several reports in a row. Try again in {m} minutes."),
                None => "You've sent several reports in a row. Try again later.".into(),
            }))
        }
        // Paused, rotated, or the stream's rules changed (a token or an
        // Origin now required): nothing the reporter can fix.
        401 | 403 | 404 | 503 => Err(AppError::Network("Bug reports aren't being accepted right now. Try again later.".into())),
        _ => Err(AppError::Network(format!("Kern Cloud couldn't take the report (HTTP {status}). Try again later."))),
    }
}

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 200 && key.bytes().all(|b| b.is_ascii_graphic())
}

// ------------------------------------------------------------ commands

/// Whether this build has somewhere to send reports.
#[tauri::command]
pub fn bug_report_available() -> bool {
    !stream_url().is_empty()
}

/// Sends a bug report to the Kern workspace and returns the stream's reply
/// message. `key` is the idempotency key: the same one for every retry of
/// one report.
#[tauri::command]
pub async fn bug_report_send(app: AppHandle, report: BugReport, key: String) -> AppResult<String> {
    let url = stream_url();
    if url.is_empty() {
        return invalid("Bug reports aren't set up in this copy of Kern.");
    }
    if !valid_key(&key) {
        return invalid("That report key isn't valid.");
    }
    let body = payload(&report, &app.package_info().version.to_string(), std::env::consts::OS, std::env::consts::ARCH)?;
    let network = app.state::<AppState>().with(|c| Ok(settings::get_or(c, "privacy.network", true)))?;
    if !network {
        return invalid("Network access is off in Settings → Privacy, so Kern can't send the report.");
    }
    tauri::async_runtime::spawn_blocking(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(20))).http_status_as_error(false).user_agent("Kern").build().into();
        let mut r = agent
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Idempotency-Key", &key)
            .send(body.to_string())
            .map_err(|e| AppError::Network(format!("Couldn't reach Kern Cloud ({e}). Check your connection and try again.")))?;
        let status = r.status().as_u16();
        let retry_after = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(String::from);
        let text = r.body_mut().with_config().limit(64 * 1024).read_to_string().unwrap_or_default();
        outcome(status, &serde_json::from_str(&text).unwrap_or(Value::Null), retry_after.as_deref())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report() -> BugReport {
        BugReport { title: "  Board won't scroll ".into(), description: "It sticks.".into(), ..Default::default() }
    }

    #[test]
    fn payload_trims_and_omits_empty_fields() {
        let v = payload(&report(), "0.2.7", "windows", "x86_64").unwrap();
        assert_eq!(v, json!({ "title": "Board won't scroll", "description": "It sticks." }));
    }

    #[test]
    fn payload_adds_system_details_only_when_asked() {
        let r = BugReport { include_system: true, severity: Some("high".into()), email: "sam@relf.cc".into(), ..report() };
        let v = payload(&r, "0.2.7", "windows", "x86_64").unwrap();
        assert_eq!(v["version"], "0.2.7");
        assert_eq!(v["os"], "windows (x86_64)");
        assert_eq!(v["severity"], "high");
        assert_eq!(v["email"], "sam@relf.cc");
    }

    #[test]
    fn payload_refuses_what_the_stream_would() {
        assert!(payload(&BugReport { title: " ".into(), ..report() }, "", "", "").is_err());
        assert!(payload(&BugReport { description: "".into(), ..report() }, "", "", "").is_err());
        assert!(payload(&BugReport { title: "x".repeat(TITLE_MAX + 1), ..report() }, "", "", "").is_err());
        assert!(payload(&BugReport { steps: "x".repeat(TEXT_MAX + 1), ..report() }, "", "", "").is_err());
        assert!(payload(&BugReport { severity: Some("urgent".into()), ..report() }, "", "", "").is_err());
        for bad in ["sam", "sam@relf", "sam @relf.cc", "@relf.cc", "sam@relf.c"] {
            assert!(payload(&BugReport { email: bad.into(), ..report() }, "", "", "").is_err(), "{bad}");
        }
    }

    #[test]
    fn outcome_reads_the_reply() {
        assert_eq!(outcome(201, &json!({ "message": "Got it." }), None).unwrap(), "Got it.");
        assert!(outcome(200, &Value::Null, None).is_ok());
        let e = outcome(422, &json!({ "message": "email: isn't an email address" }), None).unwrap_err();
        assert_eq!(e.code(), "invalid");
        assert!(e.to_string().contains("email"));
        assert!(outcome(429, &Value::Null, Some("150")).unwrap_err().to_string().contains("3 minutes"));
        assert!(outcome(429, &Value::Null, Some("20")).unwrap_err().to_string().contains("a minute"));
        assert_eq!(outcome(503, &Value::Null, None).unwrap_err().code(), "network");
        assert!(outcome(403, &json!({ "code": "origin_required" }), None).unwrap_err().to_string().contains("aren't being accepted"));
    }

    #[test]
    fn idempotency_keys_are_visible_ascii() {
        assert!(valid_key("3f0c9a2e-6c1b-4d3e-9a51-2b7f0c1d4e5a"));
        assert!(!valid_key(""));
        assert!(!valid_key("has space"));
        assert!(!valid_key(&"k".repeat(201)));
    }
}
