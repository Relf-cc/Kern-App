// @Author Christian Relf
// @Date 2026-10-13

//! Kern Cloud: an optional account, a synced personal space and shared
//! workspaces.
//!
//! Offline mode is the ordinary local database and needs no account. Online,
//! each space (the personal space, or a workspace) has its own local replica
//! with the same schema, so every feature works the same - and keeps working
//! without a connection. Only the core records sync (projects, boards, tasks,
//! issues, milestones, notes, whiteboards); files, folders, repositories,
//! terminals and environment settings always stay on this computer.
//!
//! A single background worker pushes local changes (woken by the replica's
//! commit hook) and pulls remote ones. The interface keeps a realtime socket
//! open and hands incoming changes to `cloud_apply`, so collaborators' edits
//! appear within moments.

pub mod client;
pub mod sync;

use crate::db;
use crate::domain::settings;
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

// ------------------------------------------------------------ state

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSpace {
    pub id: String,
    /// "personal" | "workspace"
    pub kind: String,
    pub name: String,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// "off" | "idle" | "syncing" | "offline" | "error" | "signed_out" | "read_only"
    pub state: String,
    pub pending: i64,
    pub last_synced_at: Option<i64>,
    pub message: Option<String>,
}

#[derive(Default)]
struct Flags {
    push: bool,
    pull: bool,
    force: bool,
}

#[derive(Clone, Default)]
pub struct Waker(Arc<(Mutex<Flags>, Condvar)>);

impl Waker {
    pub fn signal(&self, push: bool, pull: bool) {
        let (m, cv) = &*self.0;
        if let Ok(mut f) = m.lock() {
            f.push |= push;
            f.pull |= pull;
        }
        cv.notify_one();
    }

    fn force_pull(&self) {
        let (m, cv) = &*self.0;
        if let Ok(mut f) = m.lock() {
            f.pull = true;
            f.force = true;
        }
        cv.notify_one();
    }

    /// Waits for a signal or the timeout (which counts as a pull).
    fn wait(&self, timeout: Duration) -> (bool, bool, bool) {
        let (m, cv) = &*self.0;
        let Ok(mut f) = m.lock() else { return (false, true, false) };
        let mut timed_out = false;
        if !f.push && !f.pull {
            let (g, r) = match cv.wait_timeout(f, timeout) {
                Ok(x) => x,
                Err(_) => return (false, true, false),
            };
            f = g;
            timed_out = r.timed_out();
        }
        let out = (f.push, f.pull || timed_out, f.force);
        *f = Flags::default();
        out
    }

    fn take(&self) -> (bool, bool, bool) {
        let (m, _) = &*self.0;
        let Ok(mut f) = m.lock() else { return (false, false, false) };
        let out = (f.push, f.pull, f.force);
        *f = Flags::default();
        out
    }
}

#[derive(Default)]
pub struct CloudState {
    active: Mutex<Option<ActiveSpace>>,
    waker: Waker,
    status: Mutex<SyncStatus>,
    links: Mutex<Vec<String>>,
    /// The realtime connection id (pushes carry it so the echo is recognised).
    conn_id: Mutex<Option<String>>,
}

impl CloudState {
    pub fn active(&self) -> Option<ActiveSpace> {
        self.active.lock().ok().and_then(|a| a.clone())
    }

    pub fn is_active(&self) -> bool {
        self.active().is_some()
    }

    pub fn waker(&self) -> Waker {
        self.waker.clone()
    }

    /// Queues a deep link (kern://…) for the interface.
    pub fn push_link(&self, url: String) {
        if let Ok(mut l) = self.links.lock() {
            l.push(url);
        }
    }

    fn status(&self) -> SyncStatus {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn realtime(&self) -> bool {
        self.conn_id.lock().map(|c| c.is_some()).unwrap_or(false)
    }
}

fn set_status(app: &AppHandle, f: impl FnOnce(&mut SyncStatus)) {
    let state = app.state::<AppState>();
    let changed = match state.cloud.status.lock() {
        Ok(mut s) => {
            let before = s.clone();
            f(&mut s);
            (*s != before).then(|| s.clone())
        }
        Err(_) => None,
    };
    if let Some(s) = changed {
        let _ = app.emit("kern://cloud-sync", s);
    }
}

// ------------------------------------------------------------ account

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub email_verified: bool,
    pub image: Option<String>,
}

fn account(conn: &rusqlite::Connection) -> Option<Account> {
    settings::get(conn, "cloud.account")
}

/// The signed-in Kern Cloud account, if any (cached on this computer).
pub fn current_account(conn: &rusqlite::Connection) -> Option<Account> {
    account(conn)
}

fn account_from(v: &Value) -> Option<Account> {
    Some(Account {
        id: v.get("id")?.as_str()?.to_string(),
        name: v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
        email: v.get("email")?.as_str()?.to_string(),
        email_verified: v.get("emailVerified").and_then(|b| b.as_bool()).unwrap_or(false),
        image: v.get("image").and_then(|i| i.as_str()).map(String::from),
    })
}

fn base(state: &AppState) -> AppResult<String> {
    state.with(|c| {
        if !settings::get_or(c, "privacy.network", true) {
            return invalid("Network access is turned off in Settings → Privacy, so Kern Cloud is unavailable.");
        }
        Ok(client::api_base())
    })
}

fn token(state: &AppState) -> AppResult<String> {
    match state.ai.vault.get(client::TOKEN_REF)? {
        Some(t) => Ok(t.expose().to_string()),
        None => Err(AppError::Auth("Sign in to Kern Cloud first.".into())),
    }
}

/// An authenticated request. A rejected session clears the stored token.
fn authed(app: &AppHandle, method: &str, path: &str, body: Option<&Value>) -> AppResult<Value> {
    let state = app.state::<AppState>();
    let base = base(&state)?;
    let token = token(&state)?;
    match client::check(client::request(&base, Some(&token), method, path, body)) {
        Ok(r) => Ok(r.body),
        Err(AppError::Auth(m)) => {
            let _ = state.ai.vault.delete(client::TOKEN_REF);
            set_status(app, |s| {
                s.state = "signed_out".into();
                s.message = Some(m.clone());
            });
            let _ = app.emit("kern://cloud-auth", "expired");
            Err(AppError::Auth(m))
        }
        Err(e) => Err(e),
    }
}

/// Stores a fresh session and the account it belongs to.
fn signed_in(app: &AppHandle, reply: client::Reply) -> AppResult<Account> {
    let state = app.state::<AppState>();
    let token = reply
        .token
        .clone()
        .or_else(|| reply.body.get("token").and_then(|t| t.as_str()).map(String::from))
        .ok_or_else(|| AppError::Other("Kern Cloud didn't return a session.".into()))?;
    let user = reply.body.get("user").and_then(account_from).ok_or_else(|| AppError::Other("Kern Cloud didn't return the account.".into()))?;
    // Switching accounts: leave the previous account's spaces first.
    let previous = state.with(|c| Ok(account(c)))?;
    if previous.as_ref().map(|p| p.id != user.id).unwrap_or(false) && state.cloud.is_active() {
        open_space_now(app, None)?;
    }
    state.ai.vault.set(client::TOKEN_REF, &crate::domain::ai::vault::Secret::new(token))?;
    state.with(|c| settings::set(c, "cloud.account", &serde_json::to_value(&user)?))?;
    set_status(app, |s| {
        if s.state == "signed_out" {
            s.state = "idle".into();
            s.message = None;
        }
    });
    state.cloud.waker.signal(true, true);
    let _ = app.emit("kern://cloud-auth", "signed-in");
    Ok(user)
}

async fn blocking<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&AppHandle) -> AppResult<T> + Send + 'static) -> AppResult<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app)).await.map_err(|e| AppError::Other(e.to_string()))?
}

fn email_ok(email: &str) -> AppResult<String> {
    let e = email.trim().to_lowercase();
    if e.len() < 3 || e.len() > 254 || !e.contains('@') || e.contains(char::is_whitespace) {
        return invalid("Enter a valid email address.");
    }
    Ok(e)
}

// ------------------------------------------------------------ spaces

fn safe_id(id: &str) -> AppResult<&str> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return invalid("That space id isn't valid.");
    }
    Ok(id)
}

fn replica_path(state: &AppState, user_id: &str, space_id: &str) -> AppResult<PathBuf> {
    Ok(state.paths.cloud_dir().join(safe_id(user_id)?).join(format!("{}.db", safe_id(space_id)?)))
}

/// True when any cloud replica exists on this computer (their whiteboards may
/// use attachment files the offline database doesn't know about).
pub fn has_replicas(state: &AppState) -> bool {
    let dir = state.paths.cloud_dir();
    std::fs::read_dir(&dir)
        .map(|users| users.flatten().any(|u| std::fs::read_dir(u.path()).map(|f| f.flatten().any(|e| e.path().extension().is_some_and(|x| x == "db"))).unwrap_or(false)))
        .unwrap_or(false)
}

/// Switches the open database to a space replica (or back to offline data).
pub fn open_space_now(app: &AppHandle, target: Option<ActiveSpace>) -> AppResult<()> {
    let state = app.state::<AppState>();
    if state.cloud.active() == target {
        return Ok(());
    }
    let conn = match &target {
        Some(t) => {
            let acct = state.with(|c| Ok(account(c)))?.ok_or_else(|| AppError::Auth("Sign in to Kern Cloud first.".into()))?;
            let path = replica_path(&state, &acct.id, &t.id)?;
            let conn = db::open_space(&path, &state.paths.cloud_dir().join("backups"), &state.paths.db_path)?;
            sync::set_meta(&conn, "space", &t.id)?;
            let waker = state.cloud.waker();
            conn.commit_hook(Some(move || {
                waker.signal(true, false);
                false
            }))?;
            conn
        }
        None => db::open(&state.paths.db_path, &state.paths.default_backups_dir)?,
    };
    drop(state.swap_connection(conn)?);
    if let Ok(mut a) = state.cloud.active.lock() {
        *a = target.clone();
    }
    state.with(|c| settings::set(c, "cloud.activeSpace", &serde_json::to_value(&target)?))?;
    set_status(app, |s| {
        *s = SyncStatus { state: if target.is_some() { "syncing".into() } else { "off".into() }, ..Default::default() };
    });
    state.cloud.waker.signal(true, true);
    let _ = app.emit("kern://cloud-space", &target);
    let _ = app.emit("kern://data-changed", ());
    Ok(())
}

/// Reopens the space that was active when the app last closed.
pub fn restore_active(app: &AppHandle) {
    let state = app.state::<AppState>();
    let saved: Option<ActiveSpace> = state.with(|c| Ok(if settings::get_or(c, "cloud.enabled", false) { settings::get(c, "cloud.activeSpace") } else { None })).ok().flatten();
    if let Some(space) = saved {
        if let Err(e) = open_space_now(app, Some(space)) {
            eprintln!("couldn't reopen the cloud space: {e}");
            let _ = state.with(|c| settings::set(c, "cloud.activeSpace", &Value::Null));
        }
    }
}

// ------------------------------------------------------------ worker

enum Stop {
    /// The active space changed while working; drop the result.
    Stale,
    Err(AppError),
}

impl From<AppError> for Stop {
    fn from(e: AppError) -> Self {
        Stop::Err(e)
    }
}

/// Runs `f` on the database only if it is still the given space's replica.
fn on_space<T>(app: &AppHandle, space: &str, f: impl FnOnce(&mut rusqlite::Connection) -> AppResult<T>) -> Result<T, Stop> {
    let state = app.state::<AppState>();
    let mut stale = false;
    let out = state.with(|c| {
        if sync::space_of(c).as_deref() != Some(space) {
            stale = true;
            return Err(AppError::Other("stale".into()));
        }
        f(c)
    });
    match out {
        Ok(v) => Ok(v),
        Err(_) if stale => Err(Stop::Stale),
        Err(e) => Err(Stop::Err(e)),
    }
}

fn emit_applied(app: &AppHandle, space: &str, touched: &sync::Touched) {
    if !touched.is_empty() {
        let _ = app.emit("kern://cloud-applied", json!({ "space": space, "tables": touched.tables, "whiteboards": touched.whiteboards }));
    }
    if touched.tables.contains("task_comments") {
        crate::domain::comments::notify_mentions(app, space);
    }
}

fn pull(app: &AppHandle, space: &str, force: bool) -> Result<(), Stop> {
    let mut first = true;
    loop {
        let since = if force && first {
            on_space(app, space, |c| sync::discard_local(c))?;
            0
        } else {
            on_space(app, space, |c| sync::cursor(c))?
        };
        let body = authed(app, "GET", &format!("/spaces/{space}/sync/pull?since={since}"), None)?;
        let changes: Vec<sync::RemoteChange> = serde_json::from_value(body.get("changes").cloned().unwrap_or(json!([]))).map_err(AppError::from)?;
        let next = body.get("cursor").and_then(|v| v.as_i64()).unwrap_or(since);
        let more = body.get("hasMore").and_then(|v| v.as_bool()).unwrap_or(false);
        let apply_force = force && first;
        let touched = on_space(app, space, |c| {
            let t = sync::apply(c, &changes, apply_force)?;
            if next > sync::cursor(c)? {
                sync::set_cursor(c, next)?;
            }
            Ok(t)
        })?;
        emit_applied(app, space, &touched);
        first = false;
        if !more {
            return Ok(());
        }
    }
}

fn push(app: &AppHandle, space: &str) -> Result<(), Stop> {
    let conn_id = app.state::<AppState>().cloud.conn_id.lock().ok().and_then(|c| c.clone());
    for _ in 0..200 {
        let batch = on_space(app, space, |c| sync::collect(c, 300, 2 * 1024 * 1024))?;
        if batch.keys.is_empty() {
            return Ok(());
        }
        let result = if batch.changes.is_empty() {
            sync::PushResult::default()
        } else {
            set_status(app, |s| s.state = "syncing".into());
            match authed(app, "POST", &format!("/spaces/{space}/sync/push"), Some(&json!({ "conn": conn_id, "changes": batch.changes }))) {
                Ok(v) => serde_json::from_value(v).map_err(AppError::from)?,
                Err(AppError::Invalid(m)) if m.contains("read-only") => {
                    // Viewers can't change anything: restore the server's copy.
                    set_status(app, |s| {
                        s.state = "read_only".into();
                        s.message = Some("You have view-only access to this workspace, so changes aren't saved.".into());
                    });
                    let _ = app.emit("kern://cloud-readonly", space);
                    pull(app, space, true)?;
                    return Ok(());
                }
                Err(e) => return Err(Stop::Err(e)),
            }
        };
        let touched = on_space(app, space, |c| sync::ack(c, &batch, &result))?;
        emit_applied(app, space, &touched);
    }
    Ok(())
}

/// Starts the background sync worker.
pub fn start_worker(app: AppHandle) {
    std::thread::Builder::new()
        .name("kern-cloud-sync".into())
        .spawn(move || {
            let waker = app.state::<AppState>().cloud.waker();
            let mut backoff = 0u32;
            let mut last_pull = Instant::now() - Duration::from_secs(3600);
            loop {
                let state = app.state::<AppState>();
                let idle = if state.cloud.realtime() { 300 } else { 45 };
                let wait = if backoff > 0 { Duration::from_secs([2, 5, 15, 30, 60][(backoff as usize - 1).min(4)]) } else { Duration::from_secs(idle) };
                let (mut want_push, mut want_pull, mut force) = waker.wait(wait);
                if want_push && !want_pull {
                    // Coalesce bursts of edits (typing, dragging).
                    std::thread::sleep(Duration::from_millis(150));
                    let (p, l, f) = waker.take();
                    want_push |= p;
                    want_pull |= l;
                    force |= f;
                }
                let Some(space) = state.cloud.active() else { continue };
                if backoff > 0 {
                    want_pull = true;
                }
                if state.ai.vault.get(client::TOKEN_REF).ok().flatten().is_none() {
                    set_status(&app, |s| {
                        s.state = "signed_out".into();
                        s.message = Some("Sign in to sync this space.".into());
                    });
                    continue;
                }
                let mut run = || -> Result<(), Stop> {
                    if want_pull || last_pull.elapsed() > Duration::from_secs(idle) {
                        set_status(&app, |s| s.state = "syncing".into());
                        pull(&app, &space.id, force)?;
                        last_pull = Instant::now();
                    }
                    if want_push || want_pull {
                        push(&app, &space.id)?;
                    }
                    Ok(())
                };
                match run() {
                    Ok(()) | Err(Stop::Stale) => {
                        backoff = 0;
                        let pending = state.with(|c| Ok(sync::pending_count(c))).unwrap_or(0);
                        set_status(&app, |s| {
                            if s.state != "read_only" {
                                s.state = "idle".into();
                                s.message = None;
                            }
                            s.pending = pending;
                            s.last_synced_at = Some(now_ms());
                        });
                    }
                    Err(Stop::Err(e)) => {
                        let pending = state.with(|c| Ok(sync::pending_count(c))).unwrap_or(0);
                        let (st, retry) = match &e {
                            AppError::Auth(_) => ("signed_out", false),
                            AppError::Network(_) => ("offline", true),
                            AppError::NotFound(_) => {
                                // Removed from the workspace, or it was deleted.
                                let _ = app.emit("kern://cloud-space-lost", &space.id);
                                ("error", false)
                            }
                            _ => ("error", true),
                        };
                        backoff = if retry { (backoff + 1).min(5) } else { 0 };
                        set_status(&app, |s| {
                            s.state = st.into();
                            s.pending = pending;
                            s.message = Some(e.to_string());
                        });
                    }
                }
            }
        })
        .expect("failed to start the cloud sync thread");
}

// ------------------------------------------------------------ commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudInfo {
    pub api_url: String,
    pub ws_url: String,
    pub signed_in: bool,
    pub account: Option<Account>,
    pub active: Option<ActiveSpace>,
    pub sync: SyncStatus,
}

#[tauri::command]
pub fn cloud_status(state: tauri::State<AppState>) -> AppResult<CloudInfo> {
    let (api, account) = state.with(|c| Ok((client::api_base(), account(c))))?;
    let signed_in = state.ai.vault.get(client::TOKEN_REF).ok().flatten().is_some();
    let mut sync = state.cloud.status();
    if sync.state.is_empty() {
        sync.state = if state.cloud.is_active() { "idle".into() } else { "off".into() };
    }
    sync.pending = state.with(|c| Ok(if sync::space_of(c).is_some() { sync::pending_count(c) } else { 0 }))?;
    Ok(CloudInfo { ws_url: client::ws_url(&api), api_url: api, signed_in, account, active: state.cloud.active(), sync })
}

#[tauri::command]
pub async fn cloud_sign_up(app: AppHandle, name: String, email: String, password: String) -> AppResult<()> {
    blocking(&app, move |app| {
        let name = name.trim().to_string();
        if name.is_empty() {
            return invalid("Enter your name.");
        }
        if password.chars().count() < 8 {
            return invalid("Use at least 8 characters for your password.");
        }
        let email = email_ok(&email)?;
        let base = base(&app.state::<AppState>())?;
        client::check(client::request(&base, None, "POST", "/auth/sign-up/email", Some(&json!({ "name": name, "email": email, "password": password }))))
            .map_err(|e| match e {
                AppError::Invalid(m) if m.to_lowercase().contains("already") => AppError::Invalid("An account with this email already exists. Sign in instead.".into()),
                e => e,
            })?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn cloud_sign_in(app: AppHandle, email: String, password: String) -> AppResult<Account> {
    blocking(&app, move |app| {
        let email = email_ok(&email)?;
        let base = base(&app.state::<AppState>())?;
        let reply = client::check(client::request(&base, None, "POST", "/auth/sign-in/email", Some(&json!({ "email": email, "password": password, "rememberMe": true }))))?;
        signed_in(app, reply)
    })
    .await
}

/// Emails a one-time code: "verify" (confirm email), "sign-in" or "reset".
#[tauri::command]
pub async fn cloud_send_code(app: AppHandle, email: String, purpose: String) -> AppResult<()> {
    blocking(&app, move |app| {
        let email = email_ok(&email)?;
        let base = base(&app.state::<AppState>())?;
        let (path, body) = match purpose.as_str() {
            "verify" => ("/auth/email-otp/send-verification-otp", json!({ "email": email, "type": "email-verification" })),
            "sign-in" => ("/auth/email-otp/send-verification-otp", json!({ "email": email, "type": "sign-in" })),
            "reset" => ("/auth/email-otp/request-password-reset", json!({ "email": email })),
            _ => return invalid("Unknown code type."),
        };
        client::check(client::request(&base, None, "POST", path, Some(&body)))?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn cloud_verify_email(app: AppHandle, email: String, code: String) -> AppResult<Account> {
    blocking(&app, move |app| {
        let email = email_ok(&email)?;
        let base = base(&app.state::<AppState>())?;
        let reply = client::check(client::request(&base, None, "POST", "/auth/email-otp/verify-email", Some(&json!({ "email": email, "otp": code.trim() }))))
            .map_err(code_error)?;
        signed_in(app, reply)
    })
    .await
}

#[tauri::command]
pub async fn cloud_sign_in_code(app: AppHandle, email: String, code: String) -> AppResult<Account> {
    blocking(&app, move |app| {
        let email = email_ok(&email)?;
        let base = base(&app.state::<AppState>())?;
        let reply = client::check(client::request(&base, None, "POST", "/auth/sign-in/email-otp", Some(&json!({ "email": email, "otp": code.trim() })))).map_err(code_error)?;
        signed_in(app, reply)
    })
    .await
}

#[tauri::command]
pub async fn cloud_reset_password(app: AppHandle, email: String, code: String, password: String) -> AppResult<()> {
    blocking(&app, move |app| {
        let email = email_ok(&email)?;
        if password.chars().count() < 8 {
            return invalid("Use at least 8 characters for your password.");
        }
        let base = base(&app.state::<AppState>())?;
        client::check(client::request(&base, None, "POST", "/auth/email-otp/reset-password", Some(&json!({ "email": email, "otp": code.trim(), "password": password })))).map_err(code_error)?;
        Ok(())
    })
    .await
}

fn code_error(e: AppError) -> AppError {
    match e {
        AppError::Invalid(m) if m.to_lowercase().contains("otp") || m.to_lowercase().contains("invalid") || m.to_lowercase().contains("expired") => {
            AppError::Invalid("That code is wrong or has expired. Check the latest email, or send a new code.".into())
        }
        e => e,
    }
}

/// Signs out on this computer. With `forget`, the local copies of this
/// account's spaces are deleted too (they're on the server).
///
/// Returns whether Kern Cloud actually ended the session. The local token
/// goes either way - the request was to sign out - but a revoke that never
/// reached the server leaves the session usable by anyone holding a copy of
/// the token, so the caller has to be able to say so instead of reporting a
/// clean sign-out.
#[tauri::command]
pub async fn cloud_sign_out(app: AppHandle, forget: bool) -> AppResult<bool> {
    blocking(&app, move |app| {
        let state = app.state::<AppState>();
        // A rejected session is already gone, which is the outcome we wanted.
        let revoked = match authed(app, "POST", "/auth/sign-out", Some(&json!({}))) {
            Ok(_) | Err(AppError::Auth(_)) => true,
            Err(_) => false,
        };
        open_space_now(app, None)?;
        let _ = state.ai.vault.delete(client::TOKEN_REF);
        let acct = state.with(|c| Ok(account(c)))?;
        if forget {
            if let Some(a) = &acct {
                let dir = state.paths.cloud_dir().join(safe_id(&a.id)?);
                let _ = std::fs::remove_dir_all(dir);
            }
            state.with(|c| settings::set(c, "cloud.account", &Value::Null))?;
        }
        set_status(app, |s| *s = SyncStatus { state: "off".into(), ..Default::default() });
        let _ = app.emit("kern://cloud-auth", "signed-out");
        Ok(revoked)
    })
    .await
}

/// An authenticated API request on behalf of the interface.
#[tauri::command]
pub async fn cloud_request(app: AppHandle, method: String, path: String, body: Option<Value>) -> AppResult<Value> {
    blocking(&app, move |app| {
        let m = method.to_uppercase();
        if !["GET", "POST", "PATCH", "PUT", "DELETE"].contains(&m.as_str()) {
            return invalid("Unsupported request.");
        }
        let out = authed(app, &m, &path, body.as_ref())?;
        // Keep the cached account in step with profile changes.
        if path == "/me" || path.starts_with("/auth/update-user") {
            let me = if path == "/me" { out.get("user").cloned() } else { authed(app, "GET", "/me", None).ok().and_then(|v| v.get("user").cloned()) };
            if let Some(user) = me.as_ref().and_then(account_from) {
                let _ = app.state::<AppState>().with(|c| settings::set(c, "cloud.account", &serde_json::to_value(&user)?));
            }
        }
        Ok(out)
    })
    .await
}

/// Invitation details (no session needed).
#[tauri::command]
pub async fn cloud_invite_info(app: AppHandle, id: String) -> AppResult<Value> {
    blocking(&app, move |app| {
        let base = base(&app.state::<AppState>())?;
        Ok(client::check(client::request(&base, None, "GET", &format!("/invites/{}", safe_id(&id)?), None))?.body)
    })
    .await
}

#[tauri::command]
pub async fn cloud_open_space(app: AppHandle, space: Option<ActiveSpace>) -> AppResult<()> {
    blocking(&app, move |app| {
        if let Some(s) = &space {
            safe_id(&s.id)?;
            app.state::<AppState>().with(|c| settings::set(c, "cloud.enabled", &json!(true)))?;
        }
        open_space_now(app, space)
    })
    .await
}

/// Applies changes received over the realtime socket. Out-of-order batches
/// trigger a pull instead.
#[tauri::command]
pub fn cloud_apply(app: AppHandle, state: tauri::State<AppState>, space: String, from: i64, to: i64, changes: Vec<sync::RemoteChange>) -> AppResult<()> {
    let result = on_space(&app, &space, |c| {
        let cursor = sync::cursor(c)?;
        if to <= cursor {
            return Ok(None);
        }
        if from > cursor + 1 {
            return Ok(Some(None));
        }
        let t = sync::apply(c, &changes, false)?;
        sync::set_cursor(c, to)?;
        Ok(Some(Some(t)))
    });
    match result {
        Ok(Some(Some(t))) => emit_applied(&app, &space, &t),
        Ok(Some(None)) => state.cloud.waker.signal(false, true),
        Ok(None) | Err(Stop::Stale) => {}
        Err(Stop::Err(e)) => return Err(e),
    }
    Ok(())
}

#[tauri::command]
pub fn cloud_sync_now(state: tauri::State<AppState>) {
    state.cloud.waker.signal(true, true);
}

/// Restores the server's copy of the open space, discarding unsent changes.
#[tauri::command]
pub fn cloud_resync(state: tauri::State<AppState>) {
    state.cloud.waker.force_pull();
}

/// The interface reports its realtime connection (None when disconnected).
#[tauri::command]
pub fn cloud_set_connection(state: tauri::State<AppState>, conn_id: Option<String>) {
    let reconnected = conn_id.is_some();
    if let Ok(mut c) = state.cloud.conn_id.lock() {
        *c = conn_id;
    }
    if reconnected {
        // Catch up on anything missed while disconnected.
        state.cloud.waker.signal(true, true);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineSummary {
    pub projects: Vec<(String, String)>,
    pub counts: HashMap<String, i64>,
}

/// What offline data exists (for "Copy to the cloud").
#[tauri::command]
pub fn cloud_offline_summary(state: tauri::State<AppState>) -> AppResult<OfflineSummary> {
    state.with(|c| {
        let schema = if sync::space_of(c).is_some() { "local" } else { "main" };
        let mut stmt = c.prepare(&format!("SELECT id, name FROM {schema}.projects WHERE deleted_at IS NULL ORDER BY sort_order, name"))?;
        let projects = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
        let mut counts = HashMap::new();
        for (key, sql) in [
            ("tasks", "SELECT count(*) FROM {s}.tasks WHERE deleted_at IS NULL"),
            ("notes", "SELECT count(*) FROM {s}.notes WHERE deleted_at IS NULL"),
            ("whiteboards", "SELECT count(*) FROM {s}.whiteboards WHERE deleted_at IS NULL"),
            ("boards", "SELECT count(*) FROM {s}.boards"),
            ("inbox", "SELECT count(*) FROM {s}.inbox_items"),
        ] {
            let n: i64 = c.query_row(&sql.replace("{s}", schema), [], |r| r.get(0))?;
            counts.insert(key.to_string(), n);
        }
        Ok(OfflineSummary { projects, counts })
    })
}

/// Copies offline data into the open cloud space (never files). With
/// `project_ids`, only those projects and what belongs to them.
#[tauri::command]
pub async fn cloud_import_offline(app: AppHandle, project_ids: Option<Vec<String>>) -> AppResult<HashMap<String, usize>> {
    blocking(&app, move |app| {
        let state = app.state::<AppState>();
        let space = state.cloud.active().ok_or_else(|| AppError::Invalid("Open a cloud space first.".into()))?;
        let counts = on_space(app, &space.id, |c| sync::import_offline(c, project_ids.as_deref())).map_err(|e| match e {
            Stop::Stale => AppError::Invalid("The open space changed. Try again.".into()),
            Stop::Err(e) => e,
        })?;
        state.cloud.waker.signal(true, false);
        let _ = app.emit("kern://data-changed", ());
        Ok(counts)
    })
    .await
}

/// Deletes this computer's copy of a space (after leaving it, say).
#[tauri::command]
pub fn cloud_forget_space(state: tauri::State<AppState>, space_id: String) -> AppResult<()> {
    if state.cloud.active().map(|a| a.id == space_id).unwrap_or(false) {
        return invalid("Switch to another space first.");
    }
    let acct = state.with(|c| Ok(account(c)))?;
    if let Some(a) = acct {
        let path = replica_path(&state, &a.id, &space_id)?;
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(PathBuf::from(format!("{}{suffix}", path.display())));
        }
    }
    let _ = std::fs::remove_dir_all(assets_dir(&state, &space_id)?);
    Ok(())
}

// ------------------------------------------------------------ shared images

/// Downloaded whiteboard images of a space (disposable cache).
pub fn assets_dir(state: &AppState, space: &str) -> AppResult<PathBuf> {
    Ok(state.paths.cache_dir().join("cloud-assets").join(safe_id(space)?))
}

fn ext_for(mime: &str) -> &'static str {
    match mime {
        "image/webp" => "webp",
        "image/png" => "png",
        _ => "jpg",
    }
}

fn cached(dir: &std::path::Path, asset: &str) -> Option<PathBuf> {
    ["webp", "jpg", "png"].iter().map(|e| dir.join(format!("{asset}.{e}"))).find(|p| p.is_file())
}

fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("part-{}", crate::util::new_id()));
    std::fs::write(&tmp, bytes)?;
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(())
}

/// Uploads an image (already compressed by the interface) so collaborators
/// can see it. Returns the asset id to store on the whiteboard object.
#[tauri::command]
pub async fn cloud_upload_asset(app: AppHandle, space: String, data_base64: String, mime: String, width: Option<u32>, height: Option<u32>) -> AppResult<String> {
    blocking(&app, move |app| {
        use base64::Engine;
        let state = app.state::<AppState>();
        let space = safe_id(&space)?.to_string();
        if !["image/webp", "image/jpeg", "image/png"].contains(&mime.as_str()) {
            return invalid("Only WebP, JPEG and PNG images can be shared.");
        }
        let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64.as_bytes()).map_err(|_| AppError::Invalid("Image data is malformed.".into()))?;
        if bytes.len() > 3 * 1024 * 1024 {
            return invalid("That image is too large to share, even after compression.");
        }
        let (base, token) = (base(&state)?, token(&state)?);
        let q = match (width, height) {
            (Some(w), Some(h)) => format!("?w={w}&h={h}"),
            _ => String::new(),
        };
        let (reply, _, _) = client::request_bytes(&base, &token, "POST", &format!("/spaces/{space}/assets{q}"), Some((&bytes, &mime)))?;
        let reply = client::check(Ok(reply))?;
        let id = reply.body.get("id").and_then(|v| v.as_str()).map(String::from).ok_or_else(|| AppError::Other("Kern Cloud didn't return the image id.".into()))?;
        safe_id(&id)?;
        // This computer already has the image: seed the cache.
        let dir = assets_dir(&state, &space)?;
        if cached(&dir, &id).is_none() {
            let _ = write_atomic(&dir.join(format!("{id}.{}", ext_for(&mime))), &bytes);
        }
        Ok(id)
    })
    .await
}

/// The file to show for a whiteboard image: the original when this computer
/// has it, otherwise the shared copy (downloaded once, then cached). None
/// when neither is available.
#[tauri::command]
pub async fn cloud_image_path(app: AppHandle, space: Option<String>, src: Option<String>, asset: Option<String>) -> AppResult<Option<String>> {
    blocking(&app, move |app| {
        let state = app.state::<AppState>();
        if let Some(src) = src.filter(|s| !s.is_empty() && !s.contains("..") && !std::path::Path::new(s).is_absolute()) {
            let p = state.paths.attachments_dir.join(&src);
            if p.is_file() {
                return Ok(Some(p.to_string_lossy().to_string()));
            }
        }
        let (Some(space), Some(asset)) = (space, asset) else { return Ok(None) };
        let dir = assets_dir(&state, &space)?;
        let asset = safe_id(&asset)?.to_string();
        if let Some(p) = cached(&dir, &asset) {
            return Ok(Some(p.to_string_lossy().to_string()));
        }
        let (base, token) = (base(&state)?, token(&state)?);
        let (reply, bytes, mime) = client::request_bytes(&base, &token, "GET", &format!("/spaces/{}/assets/{asset}", safe_id(&space)?), None)?;
        if reply.status == 404 {
            return Ok(None);
        }
        client::check(Ok(reply))?;
        let path = dir.join(format!("{asset}.{}", ext_for(mime.as_deref().unwrap_or(""))));
        write_atomic(&path, &bytes)?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
}

/// Deep links that arrived before the interface was ready.
#[tauri::command]
pub fn cloud_take_links(state: tauri::State<AppState>) -> Vec<String> {
    state.cloud.links.lock().map(|mut l| std::mem::take(&mut *l)).unwrap_or_default()
}
