// @Author Christian Relf
// @Date 2026-10-22

//! Model Context Protocol: an AI assistant the user already pays for —
//! Claude Desktop, Claude Code — connects to Kern and works on their data
//! through a small set of tools.
//!
//! Kern is the *server* here. Nothing reaches out: the assistant's own
//! program connects in, over a named pipe (Windows) or a Unix socket that
//! only this user account can open. There is no port, no token and nothing
//! on the network. The protocol itself lives in this process, because the
//! database belongs to it — the open connection is swapped when a cloud
//! space opens, a commit hook feeds the sync outbox, and which projects are
//! unlocked is state held here. A second process reading `kern.db` would
//! walk past all three.
//!
//! The bridge (`mcp-bridge`, shipped as `kern-mcp`) exists only because
//! assistants launch local servers as a child process and talk to them over
//! stdin and stdout. It copies bytes to this pipe and back; it holds no
//! logic and reads no data.
//!
//! There is a second way in, off by default: `http`, a loopback endpoint
//! for assistants that take a URL rather than a command to run. A port has
//! no owner the way a pipe does, so that one carries a bearer token, refuses
//! anything with an `Origin`, and is otherwise the same server — same
//! policy, same approvals, same audit.
//!
//! The other direction is `outbound`: the user's own MCP servers, which
//! Kern's AI features may call as tools. That is Kern as a *client*, and it
//! is the only part of this module where Kern starts a program.
//!
//! Layout: `clients` (who may connect), `policy` (may they do this?),
//! `confirm` (should we ask first?), `tools` (what they can do), `server`
//! (the rmcp wiring, the resources and the prompts), `mermaid` (flowchart
//! text ↔ whiteboard objects), `audit` (what they did), `revert` (putting
//! one call back), `http` (the endpoint) and `outbound` (other servers).

pub mod audit;
pub mod clients;
pub mod confirm;
pub mod http;
pub mod mermaid;
pub mod outbound;
pub mod policy;
pub mod revert;
pub mod server;
pub mod tools;

use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use rmcp::ServiceExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Notify;

/// What the assistant is told about Kern before it calls anything.
pub const INSTRUCTIONS: &str = "\
Kern is the user's own task and project workspace on this computer. Their tasks, \
projects, boards and notes are real and in use, so treat changes as you would \
changes to someone's files: create what was asked for, nothing more.

Call kern_overview first to see what exists. Dates are the user's local calendar \
days, written YYYY-MM-DD; times are HH:MM. Notes are Markdown. Deleting moves \
items to Kern's Trash, where the user can restore them.

Prefer one call with a list over many calls with one item each, and reuse the \
project and label names already in use rather than inventing near-duplicates. \
A new project and everything in it is one kern_project_setup call, not twenty. \
A flowchart goes in as Mermaid text through kern_whiteboard_from_mermaid and \
becomes real shapes the user can move and edit.";

// ------------------------------------------------------------ the endpoint

/// Where the bridge connects. An isolated instance (`KERN_DATA_DIR`) gets its
/// own, the same way the credential-store namespace does, so a development
/// run never answers the assistant pointed at the real one.
pub fn endpoint() -> String {
    let suffix = match std::env::var("KERN_DATA_DIR") {
        Ok(d) if !d.is_empty() => {
            let h = d.bytes().fold(1469598103934665603u64, |h, b| (h ^ b as u64).wrapping_mul(1099511628211));
            format!("-{h:x}")
        }
        _ => String::new(),
    };
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\kern-mcp{suffix}")
    }
    #[cfg(not(windows))]
    {
        std::env::temp_dir().join(format!("kern-mcp{suffix}.sock")).to_string_lossy().into_owned()
    }
}

/// The bridge executable: beside the app in an installed copy, under
/// `target/` in a development run.
pub fn bridge_path() -> PathBuf {
    let name = if cfg!(windows) { "kern-mcp.exe" } else { "kern-mcp" };
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let candidates = [dir.join(name), dir.join("binaries").join(name)];
    candidates.into_iter().find(|p| p.exists()).unwrap_or_else(|| dir.join(name))
}

// ------------------------------------------------------------ the listener

/// Whether the listener is up. `Some` while running; dropping the handle's
/// `Notify` is how it is asked to stop.
#[derive(Default)]
pub struct McpState {
    stop: Mutex<Option<Arc<Notify>>>,
    /// Whether this process has ever held the endpoint's name. Stopping the
    /// listener leaves any live connection running on its own pipe instance,
    /// so the first-instance check below has to be asked only once.
    bound: AtomicBool,
    /// Write confirmations waiting for an answer from the window.
    pub asks: confirm::Asks,
    /// The HTTP endpoint beside the pipe, while it is listening.
    pub http: http::HttpState,
    /// Connections to the user's own MCP servers, kept open between calls.
    pub servers: outbound::Sessions,
}

impl McpState {
    pub fn running(&self) -> bool {
        self.stop.lock().map(|s| s.is_some()).unwrap_or(false)
    }
}

/// Starts or stops the listener to match the setting. Safe to call at any
/// time, and called at startup and whenever the switch is flipped.
pub fn sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    let enabled = state.with(|c| Ok(policy::enabled(c))).unwrap_or(false);
    if enabled {
        start(app);
    } else {
        stop(app);
    }
    // The endpoint has a switch of its own and reads both.
    http::sync(app);
}

pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    {
        let Ok(mut slot) = state.mcp.stop.lock() else { return };
        if slot.is_some() {
            return;
        }
        *slot = Some(Arc::new(Notify::new()));
    }
    // Housekeeping: the audit list is the user's, not a log file.
    let days = state.with(|c| Ok(policy::audit_days(c))).unwrap_or(30);
    let _ = state.with(|c| audit::prune(c, days));

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = accept_loop(handle.clone()).await {
            eprintln!("mcp: listener stopped: {e}");
        }
        if let Ok(mut slot) = handle.state::<AppState>().mcp.stop.lock() {
            *slot = None;
        }
        let _ = handle.emit("kern://mcp-state", json!({ "running": false }));
    });
    let _ = app.emit("kern://mcp-state", json!({ "running": true }));
}

pub fn stop(app: &AppHandle) {
    let notify = app.state::<AppState>().mcp.stop.lock().ok().and_then(|mut s| s.take());
    if let Some(n) = notify {
        n.notify_waiters();
    }
}

fn stop_signal(app: &AppHandle) -> Option<Arc<Notify>> {
    app.state::<AppState>().mcp.stop.lock().ok().and_then(|s| s.clone())
}

#[cfg(windows)]
async fn accept_loop(app: AppHandle) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = endpoint();
    let Some(stop) = stop_signal(&app) else { return Ok(()) };
    // `first_pipe_instance` once, the first time this process binds the name:
    // if something else already holds it, fail loudly rather than answer
    // alongside it. Asking again would refuse our own instances, which is
    // what switching the feature off and on with an assistant still
    // connected would otherwise do.
    let mut first = !app.state::<AppState>().mcp.bound.load(Ordering::Relaxed);
    loop {
        let server = ServerOptions::new().first_pipe_instance(first).create(&name)?;
        if first {
            app.state::<AppState>().mcp.bound.store(true, Ordering::Relaxed);
        }
        first = false;
        tokio::select! {
            _ = stop.notified() => return Ok(()),
            connected = server.connect() => connected?,
        }
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = serve(app2, server).await {
                eprintln!("mcp: connection ended: {e}");
            }
        });
    }
}

#[cfg(not(windows))]
async fn accept_loop(app: AppHandle) -> std::io::Result<()> {
    use tokio::net::UnixListener;
    let path = endpoint();
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    let Some(stop) = stop_signal(&app) else { return Ok(()) };
    loop {
        let stream = tokio::select! {
            _ = stop.notified() => {
                let _ = std::fs::remove_file(&path);
                return Ok(());
            }
            accepted = listener.accept() => accepted?.0,
        };
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = serve(app2, stream).await {
                eprintln!("mcp: connection ended: {e}");
            }
        });
    }
}

/// What the bridge sends as its first line.
#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Hello {
    /// The assistant's name, as the bridge was told to report it. Advisory:
    /// the pipe's permissions are the boundary, this is the label.
    name: String,
}

/// One connection: the greeting, the decision, then the protocol.
async fn serve<S>(app: AppHandle, stream: S) -> AppResult<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
{
    let (read, mut write) = tokio::io::split(stream);
    let mut reader = BufReader::new(read);
    let mut line = String::new();
    // Bounded: a greeting is a short line, and an endless one must not grow
    // this process's memory.
    (&mut reader).take(4096).read_line(&mut line).await?;
    let hello: Hello = serde_json::from_str(line.trim()).map_err(|_| AppError::Invalid("Bad greeting.".into()))?;

    let decision = {
        let app2 = app.clone();
        let name = hello.name.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app2.state::<AppState>().with(|c| {
                if !policy::enabled(c) {
                    return invalid("Kern's assistant connection is turned off.");
                }
                let client = clients::register(c, &name)?;
                Ok(client)
            })
        })
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
    };

    let client = match decision {
        Ok(c) if c.status == clients::APPROVED => c,
        Ok(c) => {
            if c.status == clients::PENDING {
                let _ = app.emit("kern://mcp-pending", json!({ "id": c.id, "name": c.name }));
            }
            let msg = if c.status == clients::PENDING {
                format!("Kern is waiting for '{}' to be approved in Settings → Assistants.", c.name)
            } else {
                format!("'{}' has been blocked in Kern.", c.name)
            };
            write.write_all(format!("{}\n", json!({ "ok": false, "message": msg })).as_bytes()).await?;
            return Ok(());
        }
        Err(e) => {
            write.write_all(format!("{}\n", json!({ "ok": false, "message": e.to_string() })).as_bytes()).await?;
            return Ok(());
        }
    };

    write.write_all(format!("{}\n", json!({ "ok": true })).as_bytes()).await?;
    let _ = app.emit("kern://mcp-state", json!({ "running": true, "connected": client.name }));

    let service = server::KernMcp::new(app, client.id)
        .serve((reader, write))
        .await
        .map_err(|e| AppError::Other(format!("MCP handshake failed: {e}")))?;
    service.waiting().await.map_err(|e| AppError::Other(format!("MCP connection failed: {e}")))?;
    Ok(())
}

// ------------------------------------------------------------ set-up files

/// The client configurations Kern can write or show.
fn claude_desktop_config_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Claude").join("claude_desktop_config.json"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support/Claude/claude_desktop_config.json"))
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config/Claude/claude_desktop_config.json"))
    }
}

/// The entry an MCP client needs: run the bridge, telling it who is asking.
fn server_entry(client_name: &str) -> Value {
    json!({
        "command": bridge_path().to_string_lossy(),
        "args": ["--name", client_name, "--endpoint", endpoint()],
    })
}

/// The MCPB extension bundle, if one shipped beside the app. Installing it
/// is a drag onto Claude Desktop's settings, which is the shortest route for
/// someone who would rather not be shown a JSON fragment.
pub fn bundle_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    [dir.join("kern.mcpb"), dir.join("binaries").join("kern.mcpb")].into_iter().find(|p| p.exists())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpSetup {
    /// The `claude_desktop_config.json` fragment, pretty-printed.
    pub claude_desktop: String,
    /// Where that file lives on this computer, if it is known.
    pub claude_desktop_path: Option<String>,
    /// The one-line command for Claude Code.
    pub claude_code: String,
    pub bridge_path: String,
    pub bridge_exists: bool,
    /// The `.mcpb` bundle beside the app, when there is one.
    pub bundle_path: Option<String>,
    pub endpoint: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub enabled: bool,
    pub running: bool,
    pub endpoint: String,
    /// The HTTP endpoint beside the pipe, and why it isn't up if it should be.
    pub http: http::HttpStatus,
    pub clients: Vec<clients::McpClient>,
}

/// Everything Settings → Assistants shows about the server itself, read in one
/// pass so the switch and the status can't disagree.
fn snapshot(state: &AppState) -> AppResult<McpStatus> {
    let running = state.mcp.running();
    state.with(|c| {
        Ok(McpStatus {
            enabled: policy::enabled(c),
            running,
            endpoint: endpoint(),
            http: http::status(c, state),
            clients: clients::list(c)?,
        })
    })
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub fn mcp_status(state: State<AppState>) -> AppResult<McpStatus> {
    snapshot(&state)
}

/// Brings the listener and the endpoint in line with the settings (called
/// after either switch is flipped, and at startup).
#[tauri::command]
pub fn mcp_sync(app: AppHandle, state: State<AppState>) -> AppResult<McpStatus> {
    sync(&app);
    snapshot(&state)
}

/// The HTTP endpoint's token and the two ways to hand it over.
///
/// This is the one command in Kern that returns a secret to the window, and
/// it does so because a bearer token is no use until it is in the other
/// program's configuration — there is nowhere else for it to go. It is made
/// on first use, lives in the OS credential store, and never reaches SQLite,
/// a log or a backup.
#[tauri::command]
pub fn mcp_http_credentials(state: State<AppState>) -> AppResult<http::HttpCredentials> {
    state.with(|c| http::credentials(c, &state))
}

/// Issues a new token. Everything connected over HTTP has to be given it
/// again, which is what makes this worth having.
#[tauri::command]
pub fn mcp_http_rotate(state: State<AppState>) -> AppResult<http::HttpCredentials> {
    http::rotate()?;
    state.with(|c| http::credentials(c, &state))
}

#[tauri::command]
pub fn mcp_clients_list(state: State<AppState>) -> AppResult<Vec<clients::McpClient>> {
    state.with(|c| clients::list(c))
}

/// Approves, blocks, rescopes or re-targets one assistant.
#[tauri::command]
pub fn mcp_client_update(
    state: State<AppState>,
    id: String,
    status: Option<String>,
    scope: Option<String>,
    projects: Option<Vec<String>>,
) -> AppResult<clients::McpClient> {
    state.with(|c| {
        let mut client = clients::get(c, &id)?;
        if let Some(s) = &status {
            client = clients::set_status(c, &id, s)?;
        }
        if let Some(s) = &scope {
            client = clients::set_scope(c, &id, s)?;
        }
        if let Some(p) = &projects {
            client = clients::set_projects(c, &id, p)?;
        }
        Ok(client)
    })
}

#[tauri::command]
pub fn mcp_client_remove(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| clients::remove(c, &id))
}

#[tauri::command]
pub fn mcp_audit_list(state: State<AppState>, limit: Option<i64>) -> AppResult<Vec<audit::AuditEntry>> {
    state.with(|c| audit::list(c, limit.unwrap_or(100)))
}

/// Puts one tool call back. The sentence it returns is what the toast says.
#[tauri::command]
pub fn mcp_revert(app: AppHandle, state: State<AppState>, id: i64) -> AppResult<String> {
    let said = state.with(|c| {
        let steps = audit::undo_plan(c, id)?;
        let said = revert::apply(c, &steps)?;
        audit::mark_reverted(c, id)?;
        Ok(said)
    })?;
    // A revert touches the same things a tool call does, so the interface is
    // refreshed the same way — but quietly: the caller has its own toast.
    let _ = app.emit("kern://mcp-reverted", json!({ "id": id, "message": said }));
    Ok(said)
}

/// The window's answer to a write confirmation.
#[tauri::command]
pub fn mcp_confirm_answer(app: AppHandle, id: String, allow: bool) -> AppResult<()> {
    confirm::answer(&app, &id, allow);
    Ok(())
}

#[tauri::command]
pub fn mcp_setup_info() -> AppResult<McpSetup> {
    let bridge = bridge_path();
    let fragment = json!({ "mcpServers": { "kern": server_entry("Claude Desktop") } });
    Ok(McpSetup {
        claude_desktop: serde_json::to_string_pretty(&fragment)?,
        claude_desktop_path: claude_desktop_config_path().map(|p| p.to_string_lossy().into_owned()),
        claude_code: format!(
            "claude mcp add kern -- \"{}\" --name \"Claude Code\" --endpoint \"{}\"",
            bridge.to_string_lossy(),
            endpoint()
        ),
        bridge_exists: bridge.exists(),
        bridge_path: bridge.to_string_lossy().into_owned(),
        bundle_path: bundle_path().map(|p| p.to_string_lossy().into_owned()),
        endpoint: endpoint(),
    })
}

/// Shows the `.mcpb` bundle in the file manager, so it can be dragged onto
/// Claude Desktop's extensions page.
#[tauri::command]
pub fn mcp_reveal_bundle(app: AppHandle) -> AppResult<String> {
    use tauri_plugin_opener::OpenerExt;
    let path = bundle_path()
        .ok_or_else(|| AppError::Invalid("No Kern extension bundle shipped with this copy of Kern.".into()))?;
    let shown = path.to_string_lossy().into_owned();
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| AppError::Other(format!("Kern couldn't show {shown}: {e}")))?;
    Ok(shown)
}

/// Adds Kern to `claude_desktop_config.json`, keeping whatever else is in it.
#[tauri::command]
pub fn mcp_setup_claude_desktop() -> AppResult<String> {
    let path = claude_desktop_config_path()
        .ok_or_else(|| AppError::Invalid("Kern couldn't work out where Claude Desktop keeps its settings.".into()))?;
    if !bridge_path().exists() {
        return invalid("The kern-mcp bridge isn't installed beside Kern yet, so there's nothing for Claude to run.");
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut doc: Value = match std::fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => serde_json::from_str(&text)
            .map_err(|_| AppError::Invalid("Claude Desktop's settings file isn't valid JSON, so Kern left it alone.".into()))?,
        _ => json!({}),
    };
    if !doc.is_object() {
        return invalid("Claude Desktop's settings file isn't in the expected shape, so Kern left it alone.");
    }
    doc["mcpServers"]["kern"] = server_entry("Claude Desktop");
    std::fs::write(&path, serde_json::to_string_pretty(&doc)?)?;
    Ok(path.to_string_lossy().into_owned())
}
