// @Author Christian Relf
// @Date 2026-10-23

//! The other direction: the user's own MCP servers, which Kern's AI
//! features may call as tools.
//!
//! Everything else in this module is Kern as a *server* — an assistant
//! connects in and works on the user's data. Here Kern is the client. It
//! starts a program on this computer, speaks MCP to it over its stdin and
//! stdout, and offers that program's tools to the model during an assist or
//! catch-up run. That is the only place in Kern where a model can reach
//! outside Kern's own data, so it is the only place in this module that
//! starts a program, and it is off twice over:
//!
//! - `mcp.toolsEnabled` is off by default, and nothing is offered to a model
//!   while it is;
//! - each server has an `enabled` switch of its own, also off when added.
//!
//! A server's `command` runs as the user, with whatever that gives it. Kern
//! cannot make that safe and does not pretend to: the Assistants tab says so
//! plainly, and the list is the user's own, typed in by them. What Kern does
//! do is keep the arrangement honest — a tool is only offered when both
//! switches are on, every call is written down in `mcp_tool_calls` with how
//! it went, and a call that hangs is cut off rather than holding an AI
//! request open forever.
//!
//! Secrets are deliberately absent. A server that needs an API key reads it
//! from the environment the user gave it; Kern's credential store holds the
//! user's own secrets and is not a place to keep someone else's program's.
//!
//! Connections are kept between calls, because starting a server over `npx`
//! takes seconds and a tool loop makes several calls. They are shut down
//! when the server is changed, disabled or removed.

use crate::domain::ai::router::{ToolRun, ToolRunner, ToolSpec};
use crate::domain::settings;
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms, some};
use rmcp::model::{CallToolRequestParams, CallToolResponse};
use rmcp::service::RunningService;
use rmcp::transport::TokioChildProcess;
use rmcp::{RoleClient, ServiceExt};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

/// A connected server. `()` is the client handler: Kern asks for tools and
/// nothing else — it offers the server no sampling, no roots and no
/// elicitation, so a server cannot ask Kern's model to do anything.
type Session = RunningService<RoleClient, ()>;

/// How long one tool call may take before Kern gives up on it. Long enough
/// for a web fetch, short enough that an AI request isn't left hanging.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// How long starting a server may take. `npx` has to be allowed to download.
const START_TIMEOUT: Duration = Duration::from_secs(60);

/// The separator between a server's slug and one of its tool names. Two
/// underscores, because a tool name may contain one.
const SEP: &str = "__";

pub const UNKNOWN: &str = "unknown";
pub const READY: &str = "ready";
pub const ERROR: &str = "error";

// ------------------------------------------------------------ the settings

/// Defaults here must match `DEFAULTS` in the settings schema.
pub fn tools_enabled(conn: &Connection) -> bool {
    settings::get_or(conn, "mcp.toolsEnabled", false)
}

// ------------------------------------------------------------ the records

/// One tool a server offers, as the model will see it.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerTool {
    pub name: String,
    pub description: String,
    /// The tool's JSON Schema, passed to the model unchanged.
    pub schema: Value,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    pub name: String,
    /// What the model sees its tools under: `<slug>__<tool>`.
    pub slug: String,
    pub command: String,
    pub args: Vec<String>,
    /// Extra environment variables. Non-secret by design (see the module docs).
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
    pub enabled: bool,
    /// What it offered when it was last connected to.
    pub tools: Vec<ServerTool>,
    /// unknown | ready | error
    pub status: String,
    pub status_detail: Option<String>,
    pub last_checked_at: Option<i64>,
    pub created_at: i64,
    /// Whether Kern has it running right now.
    pub connected: bool,
}

const SELECT: &str = "SELECT id, name, slug, command, args, env, cwd, enabled, tools, status, status_detail, last_checked_at,
  created_at FROM mcp_servers";

/// A JSON column, or the type's default if it is missing or unreadable. A
/// generic function rather than a closure: three columns, three types.
fn json_of<T: serde::de::DeserializeOwned>(raw: Option<String>) -> Option<T> {
    raw.and_then(|s| serde_json::from_str(&s).ok())
}

fn map(r: &Row) -> rusqlite::Result<Server> {
    Ok(Server {
        id: r.get(0)?,
        name: r.get(1)?,
        slug: r.get(2)?,
        command: r.get(3)?,
        args: json_of(r.get(4)?).unwrap_or_default(),
        env: json_of(r.get(5)?).unwrap_or_default(),
        cwd: r.get(6)?,
        enabled: r.get::<_, i64>(7)? != 0,
        tools: json_of(r.get(8)?).unwrap_or_default(),
        status: r.get(9)?,
        status_detail: r.get(10)?,
        last_checked_at: r.get(11)?,
        created_at: r.get(12)?,
        connected: false,
    })
}

/// A short name for the model to address the server by: letters, digits and
/// underscores, because that is all a tool name may contain.
fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    let out = out.trim_matches('_').chars().take(24).collect::<String>();
    if out.is_empty() {
        "server".into()
    } else {
        out
    }
}

/// `slugify`, made unique against the servers already added.
fn free_slug(conn: &Connection, name: &str, except: Option<&str>) -> AppResult<String> {
    let base = slugify(name);
    for n in 0..100 {
        let candidate = if n == 0 { base.clone() } else { format!("{base}{n}") };
        let taken: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM mcp_servers WHERE slug = ?1 AND id IS NOT ?2)",
            params![candidate, except],
            |r| r.get(0),
        )?;
        if !taken {
            return Ok(candidate);
        }
    }
    invalid("Too many servers with similar names — give this one a different name.")
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Server> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], map)
        .optional()?
        .ok_or_else(|| AppError::NotFound("Server".into()))
}

pub fn list(conn: &Connection) -> AppResult<Vec<Server>> {
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY name"))?;
    let rows = stmt.query_map([], map)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerPatch {
    pub name: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    #[serde(deserialize_with = "some")]
    pub cwd: Option<Option<String>>,
    pub enabled: Option<bool>,
}

fn check(name: &str, command: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return invalid("Give the server a name.");
    }
    if command.trim().is_empty() {
        return invalid("Say what to run — the command that starts the server.");
    }
    if command.contains('\n') {
        return invalid("A command is one line. Put each argument in its own box.");
    }
    Ok(())
}

pub fn create(conn: &Connection, input: &NewServer) -> AppResult<Server> {
    check(&input.name, &input.command)?;
    let id = new_id();
    let now = now_ms();
    conn.execute(
        "INSERT INTO mcp_servers(id, name, slug, command, args, env, cwd, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)",
        params![
            id,
            input.name.trim(),
            free_slug(conn, &input.name, None)?,
            input.command.trim(),
            serde_json::to_string(&input.args)?,
            serde_json::to_string(&input.env)?,
            input.cwd.as_ref().map(|c| c.trim()).filter(|c| !c.is_empty()),
            now
        ],
    )?;
    get(conn, &id)
}

/// Changes a server. Anything that changes what would be run clears what it
/// offered last time: those tools came from the old command.
pub fn update(conn: &Connection, id: &str, p: &ServerPatch) -> AppResult<(Server, bool)> {
    let before = get(conn, id)?;
    let name = p.name.clone().unwrap_or_else(|| before.name.clone());
    let command = p.command.clone().unwrap_or_else(|| before.command.clone());
    check(&name, &command)?;
    let args = p.args.clone().unwrap_or_else(|| before.args.clone());
    let env = p.env.clone().unwrap_or_else(|| before.env.clone());
    let cwd = match &p.cwd {
        Some(v) => v.as_ref().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
        None => before.cwd.clone(),
    };
    let enabled = p.enabled.unwrap_or(before.enabled);
    let restart = command != before.command || args != before.args || env != before.env || cwd != before.cwd || !enabled;
    let slug = if name == before.name { before.slug.clone() } else { free_slug(conn, &name, Some(id))? };
    conn.execute(
        "UPDATE mcp_servers SET name = ?1, slug = ?2, command = ?3, args = ?4, env = ?5, cwd = ?6, enabled = ?7,
           tools = CASE WHEN ?8 THEN NULL ELSE tools END,
           status = CASE WHEN ?8 THEN 'unknown' ELSE status END,
           status_detail = CASE WHEN ?8 THEN NULL ELSE status_detail END,
           updated_at = ?9
         WHERE id = ?10",
        params![
            name.trim(),
            slug,
            command.trim(),
            serde_json::to_string(&args)?,
            serde_json::to_string(&env)?,
            cwd,
            enabled as i64,
            (command != before.command || args != before.args || env != before.env || cwd != before.cwd) as i64,
            now_ms(),
            id
        ],
    )?;
    Ok((get(conn, id)?, restart))
}

pub fn remove(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM mcp_servers WHERE id = ?1", [id])?;
    conn.execute("DELETE FROM mcp_tool_calls WHERE server_id = ?1", [id])?;
    Ok(())
}

fn record_tools(conn: &Connection, id: &str, tools: &[ServerTool]) -> AppResult<()> {
    conn.execute(
        "UPDATE mcp_servers SET tools = ?1, status = 'ready', status_detail = NULL, last_checked_at = ?2, updated_at = ?2
         WHERE id = ?3",
        params![serde_json::to_string(tools)?, now_ms(), id],
    )?;
    Ok(())
}

fn record_error(conn: &Connection, id: &str, why: &str) {
    let short: String = why.chars().take(300).collect();
    let _ = conn.execute(
        "UPDATE mcp_servers SET status = 'error', status_detail = ?1, last_checked_at = ?2, updated_at = ?2 WHERE id = ?3",
        params![short, now_ms(), id],
    );
}

// ------------------------------------------------------------ what it did

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CallEntry {
    pub id: i64,
    pub server_id: String,
    pub server_name: String,
    pub tool: String,
    pub ok: bool,
    pub message: Option<String>,
    pub duration_ms: Option<i64>,
    pub created_at: i64,
}

fn record_call(conn: &Connection, server: &Server, tool: &str, outcome: Result<(), &str>, duration_ms: i64) {
    let (ok, message) = match outcome {
        Ok(()) => (1i64, None),
        Err(e) => (0, Some(e.chars().take(300).collect::<String>())),
    };
    // A lost row is worth less than a broken tool, so this never fails a call.
    let _ = conn.execute(
        "INSERT INTO mcp_tool_calls(server_id, server_name, tool, ok, message, duration_ms, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![server.id, server.name, tool, ok, message, duration_ms, now_ms()],
    );
}

pub fn calls(conn: &Connection, limit: i64) -> AppResult<Vec<CallEntry>> {
    let limit = limit.clamp(1, 500);
    let mut stmt = conn.prepare(
        "SELECT id, server_id, server_name, tool, ok, message, duration_ms, created_at
         FROM mcp_tool_calls ORDER BY created_at DESC, id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        Ok(CallEntry {
            id: r.get(0)?,
            server_id: r.get(1)?,
            server_name: r.get(2)?,
            tool: r.get(3)?,
            ok: r.get::<_, i64>(4)? != 0,
            message: r.get(5)?,
            duration_ms: r.get(6)?,
            created_at: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn prune(conn: &Connection, days: i64) -> AppResult<usize> {
    if days <= 0 {
        return Ok(0);
    }
    Ok(conn.execute("DELETE FROM mcp_tool_calls WHERE created_at < ?1", [now_ms() - days * 86_400_000])?)
}

// ------------------------------------------------------------ the catalogue

/// The tools the model may call, from what the enabled servers offered when
/// they were last connected to. Read from the database rather than by
/// connecting, so building a prompt never waits on a program starting.
pub fn catalog(conn: &Connection) -> Vec<ToolSpec> {
    if !tools_enabled(conn) {
        return vec![];
    }
    let servers = list(conn).unwrap_or_default();
    let mut out = vec![];
    for s in servers.iter().filter(|s| s.enabled) {
        for t in &s.tools {
            out.push(ToolSpec {
                name: format!("{}{SEP}{}", s.slug, t.name),
                description: if t.description.is_empty() {
                    format!("{} — a tool from the {} server.", t.name, s.name)
                } else {
                    format!("{} (from {})", t.description, s.name)
                },
                schema: t.schema.clone(),
            });
        }
    }
    out
}

/// Splits `<slug>__<tool>` back into the two halves.
fn split_name(qualified: &str) -> Option<(&str, &str)> {
    qualified.split_once(SEP).filter(|(s, t)| !s.is_empty() && !t.is_empty())
}

fn find_by_slug(conn: &Connection, slug: &str) -> AppResult<Server> {
    conn.query_row(&format!("{SELECT} WHERE slug = ?1"), [slug], map)
        .optional()?
        .ok_or_else(|| AppError::NotFound("Server".into()))
}

// ------------------------------------------------------------ connections

/// The servers Kern has running. Held open between calls: a tool loop makes
/// several, and starting one over `npx` can take seconds.
#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Arc<Session>>>);

impl Sessions {
    fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.0.lock().ok().and_then(|m| m.get(id).cloned())
    }

    /// Keeps whichever connection got there first, so two calls racing to
    /// start the same server end up on one process.
    fn put(&self, id: &str, session: Arc<Session>) -> Arc<Session> {
        match self.0.lock() {
            Ok(mut m) => m.entry(id.to_string()).or_insert(session).clone(),
            Err(_) => session,
        }
    }

    fn take(&self, id: &str) -> Option<Arc<Session>> {
        self.0.lock().ok().and_then(|mut m| m.remove(id))
    }

    pub fn running(&self, id: &str) -> bool {
        self.0.lock().map(|m| m.contains_key(id)).unwrap_or(false)
    }

    fn drain(&self) -> Vec<Arc<Session>> {
        self.0.lock().map(|mut m| m.drain().map(|(_, s)| s).collect()).unwrap_or_default()
    }
}

/// Shuts one server down, if it is running. Called when it is changed,
/// disabled or removed — the next call starts it again from what is saved.
pub fn disconnect(app: &AppHandle, id: &str) {
    if let Some(session) = app.state::<AppState>().mcp.servers.take(id) {
        close(session);
    }
}

/// Shuts all of them down (the feature being switched off, or the app
/// quitting).
pub fn disconnect_all(app: &AppHandle) {
    for session in app.state::<AppState>().mcp.servers.drain() {
        close(session);
    }
}

/// A connection is shut down on the runtime, because closing it is async and
/// the child process has to be reaped. Anything still holding an `Arc` keeps
/// it alive until its call finishes, which is what we want.
fn close(session: Arc<Session>) {
    tauri::async_runtime::spawn(async move {
        // Still held by a call in flight? Then leave it: dropping the last
        // reference kills the child either way.
        if let Ok(owned) = Arc::try_unwrap(session) {
            let _ = owned.cancel().await;
        }
    });
}

/// Starts a server and completes the MCP handshake.
async fn connect(server: &Server) -> AppResult<Session> {
    let mut command = tokio::process::Command::new(&server.command);
    command.args(&server.args);
    for (k, v) in &server.env {
        command.env(k, v);
    }
    if let Some(cwd) = &server.cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: a server started from a GUI app must not flash a
        // console window onto the user's screen.
        command.creation_flags(0x0800_0000);
    }
    let transport = TokioChildProcess::new(command)
        .map_err(|e| AppError::Invalid(format!("Kern couldn't start '{}': {e}", server.command)))?;
    let started = ().serve(transport);
    tokio::time::timeout(START_TIMEOUT, started)
        .await
        .map_err(|_| AppError::Invalid(format!("'{}' didn't answer within {}s of starting.", server.name, START_TIMEOUT.as_secs())))?
        .map_err(|e| AppError::Invalid(format!("'{}' started but didn't speak MCP ({e}).", server.name)))
}


/// Connects if necessary, and hands back the live connection.
async fn session(app: &AppHandle, server: &Server) -> AppResult<Arc<Session>> {
    if let Some(found) = app.state::<AppState>().mcp.servers.get(&server.id) {
        return Ok(found);
    }
    let fresh = Arc::new(connect(server).await?);
    Ok(app.state::<AppState>().mcp.servers.put(&server.id, fresh))
}

/// What a server offers, asked of it directly. Used by **Test** in the
/// Assistants tab, and saved so the model can be told about the tools
/// without the server being started first.
pub async fn probe(app: AppHandle, id: String) -> AppResult<Server> {
    let server = with_db(&app, {
        let id = id.clone();
        move |c| get(c, &id)
    })
    .await?;
    // A fresh connection, so **Test** reports what the saved command does
    // now rather than what a long-running process did when it started.
    disconnect(&app, &id);
    let result = async {
        let live = session(&app, &server).await?;
        let listed = live
            .list_all_tools()
            .await
            .map_err(|e| AppError::Invalid(format!("'{}' wouldn't list its tools ({e}).", server.name)))?;
        Ok::<Vec<ServerTool>, AppError>(
            listed
                .into_iter()
                .map(|t| ServerTool {
                    name: t.name.to_string(),
                    description: t.description.map(|d| d.to_string()).unwrap_or_default(),
                    schema: Value::Object((*t.input_schema).clone()),
                })
                .collect(),
        )
    }
    .await;

    match result {
        Ok(tools) => {
            let found = tools.clone();
            with_db(&app, {
                let id = id.clone();
                move |c| {
                    record_tools(c, &id, &found)?;
                    get(c, &id)
                }
            })
            .await
        }
        Err(e) => {
            // A server that won't start shouldn't be left running.
            disconnect(&app, &id);
            let why = e.to_string();
            let _ = with_db(&app, {
                let id = id.clone();
                move |c| {
                    record_error(c, &id, &why);
                    Ok(())
                }
            })
            .await;
            Err(e)
        }
    }
}

/// Runs the closure with the database, off the UI thread.
async fn with_db<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&mut Connection) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || app.state::<AppState>().with(f))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

/// Calls one tool, by its qualified `<slug>__<tool>` name, and returns what
/// the server said as text for the model to read.
async fn call(app: AppHandle, qualified: String, arguments: Map<String, Value>) -> AppResult<String> {
    let Some((slug, tool)) = split_name(&qualified) else {
        return invalid(format!("'{qualified}' isn't a tool Kern knows how to reach."));
    };
    let (slug, tool) = (slug.to_string(), tool.to_string());
    let server = with_db(&app, {
        let slug = slug.clone();
        move |c| {
            if !tools_enabled(c) {
                return invalid("Tools from other MCP servers are turned off in Kern.");
            }
            let server = find_by_slug(c, &slug)?;
            if !server.enabled {
                return invalid(format!("The '{}' server is switched off in Kern.", server.name));
            }
            Ok(server)
        }
    })
    .await?;

    let started = now_ms();
    let outcome = async {
        let live = session(&app, &server).await?;
        let params = CallToolRequestParams::new(tool.clone()).with_arguments(arguments);
        // `call_tool_once`, not `call_tool`: the higher-level helper drives
        // the server's follow-up rounds through a local handler, and Kern
        // connects as `()` — it has nothing to answer a question with. A
        // server that wants one is told so plainly instead.
        let answered = tokio::time::timeout(CALL_TIMEOUT, live.call_tool_once(params))
            .await
            .map_err(|_| AppError::Invalid(format!("'{tool}' took longer than {}s, so Kern stopped waiting.", CALL_TIMEOUT.as_secs())))?
            .map_err(|e| AppError::Invalid(format!("'{tool}' failed ({e}).")))?;
        let result = match answered {
            CallToolResponse::Complete(result) => result,
            CallToolResponse::InputRequired(_) => {
                return invalid(format!("'{tool}' asked for something back before it would run. Kern can't answer a server's questions."))
            }
            CallToolResponse::Task(_) => {
                return invalid(format!("'{tool}' runs as a background task, which Kern doesn't follow."))
            }
            // The enum is `non_exhaustive`: a newer protocol revision may add
            // a kind of answer this version of Kern has never seen.
            _ => return invalid(format!("'{tool}' answered in a way Kern doesn't understand.")),
        };
        let text = result
            .content
            .iter()
            .filter_map(|b| b.as_text().map(|t| t.text.clone()))
            .collect::<Vec<_>>()
            .join("\n");
        let text = if text.trim().is_empty() {
            match &result.structured_content {
                Some(v) => serde_json::to_string(v).unwrap_or_default(),
                None => "(the tool returned nothing)".to_string(),
            }
        } else {
            text
        };
        if result.is_error.unwrap_or(false) {
            return Err(AppError::Invalid(text));
        }
        Ok(text)
    }
    .await;

    let duration = now_ms() - started;
    let (logged, server_for_log) = (outcome.as_ref().map(|_| ()).map_err(|e| e.to_string()), server.clone());
    let _ = with_db(&app, move |c| {
        record_call(c, &server_for_log, &tool, logged.as_ref().map(|_| ()).map_err(|e| e.as_str()), duration);
        Ok(())
    })
    .await;
    // A server that broke mid-call is probably gone; the next call starts it
    // again rather than talking to a dead pipe.
    if outcome.is_err() {
        disconnect(&app, &server.id);
    }
    outcome
}

// ------------------------------------------------------------ the runner

/// The handle the AI router reaches tools through. Set once, at startup,
/// because the router is built before the window exists.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Called once at startup: remembers the handle, and gives the AI router the
/// runner that uses it. Both happen here so the window-facing half of this
/// module is reachable only from the app's own start-up path.
pub fn attach(app: AppHandle) {
    app.state::<AppState>().ai.attach_tools(Box::new(McpTools));
    let _ = APP.set(app);
}

/// `ToolRunner` for the real thing: the router is synchronous (it runs on a
/// blocking thread so it never holds the database across a network call),
/// and MCP is asynchronous, so each call is handed to the runtime and waited
/// for on a channel. No `block_on`, so this can't deadlock whichever thread
/// the router happens to be on.
pub struct McpTools;

impl ToolRunner for McpTools {
    fn list(&self) -> Vec<ToolSpec> {
        let Some(app) = APP.get() else { return vec![] };
        app.state::<AppState>().with(|c| Ok(catalog(c))).unwrap_or_default()
    }

    fn call(&self, name: &str, arguments: &Value) -> ToolRun {
        let Some(app) = APP.get() else {
            return ToolRun::failed(name, "Kern isn't ready to run tools yet.");
        };
        let arguments = match arguments {
            Value::Object(map) => map.clone(),
            Value::Null => Map::new(),
            other => {
                let mut map = Map::new();
                map.insert("input".into(), other.clone());
                map
            }
        };
        let (tx, rx) = std::sync::mpsc::channel();
        let app = app.clone();
        let tool = name.to_string();
        let sent = tool.clone();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(call(app, sent, arguments).await);
        });
        // A little past the call's own timeout: that one is the real limit,
        // and this is only here so a lost task can't wedge the router.
        match rx.recv_timeout(CALL_TIMEOUT + Duration::from_secs(10)) {
            Ok(Ok(text)) => ToolRun::done(&tool, text),
            Ok(Err(e)) => ToolRun::failed(&tool, e.to_string()),
            Err(_) => ToolRun::failed(&tool, "Kern didn't hear back from that tool."),
        }
    }
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub fn mcp_servers_list(state: State<AppState>) -> AppResult<Vec<Server>> {
    state.with(|c| {
        let mut servers = list(c)?;
        for s in &mut servers {
            s.connected = state.mcp.servers.running(&s.id);
        }
        Ok(servers)
    })
}

#[tauri::command]
pub fn mcp_server_create(state: State<AppState>, input: NewServer) -> AppResult<Server> {
    state.with(|c| create(c, &input))
}

/// Changes a server, and shuts down whatever is running if the change means
/// the running copy is no longer what is saved.
#[tauri::command]
pub fn mcp_server_update(app: AppHandle, state: State<AppState>, id: String, patch: ServerPatch) -> AppResult<Server> {
    let (server, restart) = state.with(|c| update(c, &id, &patch))?;
    if restart {
        disconnect(&app, &id);
    }
    Ok(server)
}

#[tauri::command]
pub fn mcp_server_remove(app: AppHandle, state: State<AppState>, id: String) -> AppResult<()> {
    disconnect(&app, &id);
    state.with(|c| remove(c, &id))
}

/// Starts the server, asks what it offers and saves the answer.
#[tauri::command]
pub async fn mcp_server_test(app: AppHandle, id: String) -> AppResult<Server> {
    probe(app, id).await
}

#[tauri::command]
pub fn mcp_server_calls(state: State<AppState>, limit: Option<i64>) -> AppResult<Vec<CallEntry>> {
    state.with(|c| calls(c, limit.unwrap_or(60)))
}

/// Shuts every connected server down. The switch being turned off, or
/// someone wanting a clean start.
#[tauri::command]
pub fn mcp_servers_disconnect(app: AppHandle) -> AppResult<()> {
    disconnect_all(&app);
    Ok(())
}

/// What the model would be told it can do — the catalogue as it stands, for
/// the Assistants tab to show rather than describe.
#[tauri::command]
pub fn mcp_tool_catalog(state: State<AppState>) -> AppResult<Value> {
    state.with(|c| {
        let tools = catalog(c);
        Ok(json!({
            "enabled": tools_enabled(c),
            "tools": tools.iter().map(|t| json!({ "name": t.name, "description": t.description })).collect::<Vec<_>>(),
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;

    fn db() -> Connection {
        open_memory()
    }

    #[test]
    fn a_name_becomes_something_a_tool_name_can_hold() {
        assert_eq!(slugify("Filesystem"), "filesystem");
        assert_eq!(slugify("My Server 2!"), "my_server_2");
        assert_eq!(slugify("  --  "), "server");
        assert_eq!(slugify("Ünïcødé"), "n_c_d");
        assert!(slugify(&"long name ".repeat(10)).len() <= 24);
    }

    #[test]
    fn slugs_do_not_collide() {
        let c = db();
        let a = create(&c, &NewServer { name: "Files".into(), command: "node".into(), ..Default::default() }).unwrap();
        let b = create(&c, &NewServer { name: "files".into(), command: "node".into(), ..Default::default() }).unwrap();
        assert_eq!(a.slug, "files");
        assert_eq!(b.slug, "files1");
    }

    #[test]
    fn a_server_arrives_switched_off() {
        let c = db();
        let s = create(&c, &NewServer { name: "Files".into(), command: "node".into(), ..Default::default() }).unwrap();
        assert!(!s.enabled, "nothing Kern can run should be enabled by adding it");
        assert_eq!(s.status, UNKNOWN);
        assert!(s.tools.is_empty());
    }

    #[test]
    fn a_command_is_checked() {
        let c = db();
        assert!(create(&c, &NewServer { name: " ".into(), command: "node".into(), ..Default::default() }).is_err());
        assert!(create(&c, &NewServer { name: "Files".into(), command: " ".into(), ..Default::default() }).is_err());
        assert!(create(&c, &NewServer { name: "Files".into(), command: "a\nb".into(), ..Default::default() }).is_err());
    }

    fn with_tools(c: &Connection, name: &str) -> Server {
        let s = create(c, &NewServer { name: name.into(), command: "node".into(), args: vec!["x.js".into()], ..Default::default() })
            .unwrap();
        record_tools(
            c,
            &s.id,
            &[ServerTool { name: "read_file".into(), description: "Read a file.".into(), schema: json!({ "type": "object" }) }],
        )
        .unwrap();
        update(c, &s.id, &ServerPatch { enabled: Some(true), ..Default::default() }).unwrap().0
    }

    #[test]
    fn nothing_is_offered_until_the_switch_is_on() {
        let c = db();
        with_tools(&c, "Files");
        assert!(catalog(&c).is_empty(), "the master switch is off");
        settings::set(&c, "mcp.toolsEnabled", &json!(true)).unwrap();
        let tools = catalog(&c);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "files__read_file");
        assert!(tools[0].description.contains("Files"), "the model is told whose tool it is");
    }

    #[test]
    fn a_disabled_server_offers_nothing() {
        let c = db();
        settings::set(&c, "mcp.toolsEnabled", &json!(true)).unwrap();
        let s = with_tools(&c, "Files");
        assert_eq!(catalog(&c).len(), 1);
        update(&c, &s.id, &ServerPatch { enabled: Some(false), ..Default::default() }).unwrap();
        assert!(catalog(&c).is_empty());
    }

    #[test]
    fn changing_the_command_forgets_the_old_tools() {
        let c = db();
        settings::set(&c, "mcp.toolsEnabled", &json!(true)).unwrap();
        let s = with_tools(&c, "Files");
        assert_eq!(catalog(&c).len(), 1);
        let (after, restart) = update(&c, &s.id, &ServerPatch { command: Some("python".into()), ..Default::default() }).unwrap();
        assert!(restart, "what is running is no longer what is saved");
        assert!(after.tools.is_empty(), "those tools belonged to the old command");
        assert_eq!(after.status, UNKNOWN);
        assert!(catalog(&c).is_empty());
    }

    #[test]
    fn renaming_keeps_the_tools_and_moves_the_slug() {
        let c = db();
        settings::set(&c, "mcp.toolsEnabled", &json!(true)).unwrap();
        let s = with_tools(&c, "Files");
        let (after, restart) = update(&c, &s.id, &ServerPatch { name: Some("Disk".into()), ..Default::default() }).unwrap();
        assert!(!restart, "a name doesn't change what runs");
        assert_eq!(after.slug, "disk");
        assert_eq!(catalog(&c)[0].name, "disk__read_file");
    }

    #[test]
    fn qualified_names_split_back() {
        assert_eq!(split_name("files__read_file"), Some(("files", "read_file")));
        assert_eq!(split_name("files__read__file"), Some(("files", "read__file")));
        assert_eq!(split_name("files"), None);
        assert_eq!(split_name("__read"), None);
        assert_eq!(split_name("files__"), None);
    }

    #[test]
    fn calls_are_written_down_and_pruned() {
        let c = db();
        let s = with_tools(&c, "Files");
        record_call(&c, &s, "read_file", Ok(()), 12);
        record_call(&c, &s, "write_file", Err("refused"), 3);
        let rows = calls(&c, 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(!rows[0].ok && rows[0].message.as_deref() == Some("refused"));
        assert_eq!(prune(&c, 30).unwrap(), 0, "nothing is old enough yet");
        c.execute("UPDATE mcp_tool_calls SET created_at = 1", []).unwrap();
        assert_eq!(prune(&c, 30).unwrap(), 2);
        // Keeping them forever is 0 days, which must not delete everything.
        assert_eq!(prune(&c, 0).unwrap(), 0);
    }

    #[test]
    fn removing_a_server_takes_its_history_with_it() {
        let c = db();
        let s = with_tools(&c, "Files");
        record_call(&c, &s, "read_file", Ok(()), 1);
        remove(&c, &s.id).unwrap();
        assert!(list(&c).unwrap().is_empty());
        assert!(calls(&c, 10).unwrap().is_empty());
    }
}
