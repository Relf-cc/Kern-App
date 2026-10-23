// @Author Christian Relf
// @Date 2026-10-23

//! The HTTP endpoint: the same tools as the pipe, for assistants that take a
//! URL instead of a command to run.
//!
//! The pipe needs no credential because the operating system is the
//! boundary — only this user account can open it. A port has no such
//! boundary: every program on this computer can reach `127.0.0.1`, and a web
//! page in a browser can try. So this endpoint has three of its own:
//!
//! - **A bearer token**, held in the OS credential store and never in
//!   SQLite, logs or backups. A request without it is refused before
//!   anything reads the database.
//! - **Loopback only.** The listener binds `127.0.0.1`, and rmcp validates
//!   the `Host` header against the loopback names, which is what stops a
//!   name pointing at this machine from being used to reach it.
//! - **No browser.** Origin validation is enforced with an empty allowlist,
//!   so a request carrying any `Origin` at all is refused. A page in a
//!   browser cannot talk to Kern even with the token.
//!
//! Everything past that is the pipe's story exactly: the client is named,
//! that name is approved once in Settings → Assistants, and every call goes
//! through `policy` and lands in the audit. The name is advisory here too —
//! the token is what gets a caller in — so a token belongs to the person,
//! not to a program, and rotating it locks every client out at once.
//!
//! Off by default, like the rest of it. `mcp.enabled` has to be on *and*
//! `mcp.httpEnabled`, because a port is a bigger thing to open than a pipe.

use crate::domain::ai::vault::{OsKeyring, Secret, SecretStore};
use crate::domain::settings;
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use axum::body::Body;
use axum::http::{header, HeaderMap, Request, Response, StatusCode};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use super::clients::{self, APPROVED, PENDING};
use super::policy;
use super::server::KernMcp;

/// The one path. A request anywhere else gets a line saying so rather than a
/// bare 404, because the commonest mistake is the wrong URL.
pub const PATH: &str = "/mcp";

/// The credential-store entry holding the bearer token. Isolated instances
/// (`KERN_DATA_DIR`) keep their own, the same way AI keys do.
const TOKEN_REF: &str = "http-token";

/// What a client is called when it doesn't say.
const UNNAMED: &str = "HTTP assistant";

/// Credential-store namespace for the assistant endpoint. Separate from the
/// AI keys' namespace: a token for a local port and a key that spends money
/// are different kinds of secret and shouldn't share a drawer.
pub fn vault_service() -> String {
    match std::env::var("KERN_DATA_DIR") {
        Ok(d) if !d.is_empty() => {
            let h = d.bytes().fold(1469598103934665603u64, |h, b| (h ^ b as u64).wrapping_mul(1099511628211));
            format!("app.kern.desktop.mcp.isolated-{h:x}")
        }
        _ => "app.kern.desktop.mcp".into(),
    }
}

fn store() -> OsKeyring {
    OsKeyring::new(vault_service())
}

// ------------------------------------------------------------ the settings

/// Defaults here must match `DEFAULTS` in the settings schema.
pub fn http_enabled(conn: &Connection) -> bool {
    settings::get_or(conn, "mcp.httpEnabled", false)
}

pub fn port(conn: &Connection) -> u16 {
    settings::get_or::<i64>(conn, "mcp.httpPort", 8787).clamp(1024, 65535) as u16
}

pub fn url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{PATH}")
}

// ------------------------------------------------------------ the token

/// The token, making one the first time it is asked for. Generated from two
/// UUIDv4s: 244 bits of the platform's randomness, which is more than a
/// bearer token on a loopback port needs and costs nothing.
pub fn token(create: bool) -> AppResult<Option<String>> {
    let vault = store();
    if let Some(found) = vault.get(TOKEN_REF)? {
        return Ok(Some(found.expose().to_string()));
    }
    if !create {
        return Ok(None);
    }
    let fresh = format!("kern-{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    vault.set(TOKEN_REF, &Secret::new(fresh.clone()))?;
    Ok(Some(fresh))
}

/// Throws the token away and issues another. Everything connected over HTTP
/// stops working until it is given the new one — which is the point.
pub fn rotate() -> AppResult<String> {
    store().delete(TOKEN_REF)?;
    token(true)?.ok_or_else(|| AppError::Other("Kern couldn't make a new token.".into()))
}

/// Whether a token exists at all, without reading it.
pub fn token_present() -> bool {
    matches!(token(false), Ok(Some(_)))
}

/// Compares in constant time. The length is not a secret; the bytes are.
fn same_token(offered: &str, real: &str) -> bool {
    if offered.len() != real.len() {
        return false;
    }
    offered.bytes().zip(real.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

// ------------------------------------------------------------ the listener

/// A listening endpoint. Dropping the `Notify` is how it is asked to stop.
pub struct Listener {
    stop: Arc<Notify>,
    pub port: u16,
}

/// What `McpState` keeps for the HTTP endpoint: the listener while it is up,
/// and why it isn't when it should be.
#[derive(Default)]
pub struct HttpState {
    listener: Mutex<Option<Listener>>,
    problem: Mutex<Option<String>>,
    /// Sessions for clients on protocol versions older than 2026-07-28,
    /// which still expect `Mcp-Session-Id` to mean something.
    sessions: Mutex<Option<Arc<LocalSessionManager>>>,
}

impl HttpState {
    pub fn port(&self) -> Option<u16> {
        self.listener.lock().ok().and_then(|l| l.as_ref().map(|l| l.port))
    }

    pub fn problem(&self) -> Option<String> {
        self.problem.lock().ok().and_then(|p| p.clone())
    }

    fn set_problem(&self, why: Option<String>) {
        if let Ok(mut slot) = self.problem.lock() {
            *slot = why;
        }
    }

    fn session_manager(&self) -> Arc<LocalSessionManager> {
        let mut slot = match self.sessions.lock() {
            Ok(s) => s,
            Err(p) => p.into_inner(),
        };
        slot.get_or_insert_with(|| Arc::new(LocalSessionManager::default())).clone()
    }
}

/// Brings the endpoint in line with the settings. Called wherever
/// `mcp::sync` is.
pub fn sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    let wanted = state
        .with(|c| Ok(policy::enabled(c).then(|| port(c)).filter(|_| http_enabled(c))))
        .unwrap_or(None);
    let running = state.mcp.http.port();
    match (wanted, running) {
        (Some(want), Some(have)) if want == have => {}
        (Some(want), _) => {
            stop(app);
            start(app, want);
        }
        (None, Some(_)) => stop(app),
        (None, None) => state.mcp.http.set_problem(None),
    }
}

fn start(app: &AppHandle, port: u16) {
    let state = app.state::<AppState>();
    // A token has to exist before anything can get in, so make it now
    // rather than when someone first asks to see it.
    if let Err(e) = token(true) {
        state.mcp.http.set_problem(Some(format!("Kern couldn't put a token in the credential store: {e}")));
        return;
    }
    let stop = Arc::new(Notify::new());
    {
        let Ok(mut slot) = state.mcp.http.listener.lock() else { return };
        if slot.is_some() {
            return;
        }
        *slot = Some(Listener { stop: stop.clone(), port });
    }
    state.mcp.http.set_problem(None);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = serve(handle.clone(), port, stop).await;
        let state = handle.state::<AppState>();
        if let Ok(mut slot) = state.mcp.http.listener.lock() {
            *slot = None;
        }
        if let Err(e) = result {
            state.mcp.http.set_problem(Some(e));
        }
        let _ = handle.emit("kern://mcp-state", json!({ "http": false }));
    });
    let _ = app.emit("kern://mcp-state", json!({ "http": true }));
}

pub fn stop(app: &AppHandle) {
    let listener = app.state::<AppState>().mcp.http.listener.lock().ok().and_then(|mut l| l.take());
    if let Some(l) = listener {
        l.stop.notify_waiters();
    }
}

/// The loopback addresses. Both families, because a client given
/// `localhost` may resolve either.
fn binds(port: u16) -> [std::net::SocketAddr; 2] {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
    [SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port), SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port)]
}

async fn serve(app: AppHandle, port: u16, stop: Arc<Notify>) -> Result<(), String> {
    // Loopback only, and never `0.0.0.0`: this endpoint is for programs on
    // this computer, so it must not be reachable from the network even by
    // accident. IPv6 is a bonus — a machine without it still gets IPv4.
    let [v4, v6] = binds(port);
    let listener = tokio::net::TcpListener::bind(v4)
        .await
        .map_err(|e| format!("Kern couldn't listen on 127.0.0.1:{port} ({e}). Another program may already have that port."))?;
    let v6_listener = tokio::net::TcpListener::bind(v6).await.ok();

    let router = axum::Router::new()
        .route(PATH, axum::routing::any(endpoint))
        .fallback(wrong_path)
        .with_state(app.clone());

    let shutdown = {
        let stop = stop.clone();
        async move { stop.notified().await }
    };
    let second = v6_listener.map(|l| {
        let router = router.clone();
        let stop = stop.clone();
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(l, router).with_graceful_shutdown(async move { stop.notified().await }).await;
        })
    });
    let result = axum::serve(listener, router).with_graceful_shutdown(shutdown).await;
    if let Some(task) = second {
        task.abort();
    }
    result.map_err(|e| format!("Kern's assistant endpoint stopped: {e}"))
}

async fn wrong_path() -> Response<Body> {
    refusal(StatusCode::NOT_FOUND, &format!("Kern serves the Model Context Protocol at {PATH} and nothing else."))
}

/// A refusal an assistant's log will make sense of. JSON-RPC's own error
/// envelope, because that is what a client here is expecting to parse.
fn refusal(status: StatusCode, message: &str) -> Response<Body> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": Option::<i64>::None,
        "error": { "code": -32600, "message": message },
    });
    let mut response = Response::new(Body::from(body.to_string()));
    *response.status_mut() = status;
    response.headers_mut().insert(header::CONTENT_TYPE, header::HeaderValue::from_static("application/json"));
    if status == StatusCode::UNAUTHORIZED {
        response.headers_mut().insert(header::WWW_AUTHENTICATE, header::HeaderValue::from_static("Bearer realm=\"Kern\""));
    }
    response
}

/// The bearer token out of the `Authorization` header. Nothing else is
/// accepted — not a query string, which would end up in logs and history.
fn offered_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim()).filter(|t| !t.is_empty())
}

/// Whether this request came from a web page. rmcp refuses one too, but it
/// does so inside the protocol handler — after this module would have
/// touched the database to look the client up. A browser gets turned away
/// before that, so a page cannot so much as make Kern ask the user about a
/// client it invented.
fn from_a_browser(headers: &HeaderMap) -> bool {
    headers.contains_key(header::ORIGIN)
}

/// Whether `Host` names this computer. Same reasoning: a name that resolves
/// here is refused before anything is read, not after.
fn host_is_local(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        // HTTP/2 and HTTP/1.0 may omit it; rmcp decides in that case.
        return true;
    };
    // `[::1]:8787`, `127.0.0.1:8787`, `localhost`, or a bare `::1` — a port
    // is only a port when the rest isn't itself full of colons.
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split_once(']').map(|(h, _)| h).unwrap_or(rest)
    } else if host.matches(':').count() == 1 {
        host.split_once(':').map(|(h, _)| h).unwrap_or(host)
    } else {
        host
    };
    matches!(name, "localhost" | "127.0.0.1" | "::1" | "0:0:0:0:0:0:0:1")
}

/// What the caller says it is. Advisory, exactly as over the pipe: the
/// token is what got it in, and this is the label the user approves.
fn offered_name(headers: &HeaderMap, query: Option<&str>) -> String {
    let header_name = headers.get("x-kern-client").and_then(|v| v.to_str().ok()).map(str::trim).filter(|n| !n.is_empty());
    let query_name = query
        .and_then(|q| {
            q.split('&').find_map(|pair| {
                let (k, v) = pair.split_once('=')?;
                (k == "client").then_some(v)
            })
        })
        .map(|v| v.replace('+', " "))
        .map(|v| percent_decode(&v))
        .filter(|n| !n.trim().is_empty());
    let name = header_name.map(String::from).or(query_name).unwrap_or_else(|| UNNAMED.into());
    // The same bounds `clients::register` enforces, applied here so a long
    // name is trimmed rather than refused.
    name.trim().chars().take(80).collect()
}

/// `%20` and friends, for a name in the query string. Anything malformed is
/// left as it stands — this is a label, not a path.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(byte) = hex {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// One request: the token, the name, the decision, then the protocol.
///
/// Nothing here reads the user's data until all three have passed, and the
/// service is built for the client the request belongs to — so revoking an
/// assistant in Settings → Assistants stops its very next call, not its next
/// connection.
async fn endpoint(
    axum::extract::State(app): axum::extract::State<AppHandle>,
    request: Request<Body>,
) -> Response<Body> {
    // Before anything else, and before the database is touched at all.
    if from_a_browser(request.headers()) {
        return refusal(
            StatusCode::FORBIDDEN,
            "Kern's assistant endpoint doesn't answer web pages. It is for programs on this computer.",
        );
    }
    if !host_is_local(request.headers()) {
        return refusal(StatusCode::FORBIDDEN, "Kern's assistant endpoint answers only on this computer's own address.");
    }
    let Ok(Some(real)) = token(false) else {
        return refusal(StatusCode::SERVICE_UNAVAILABLE, "Kern has no token for this endpoint yet. Open Settings → Assistants in Kern.");
    };
    let headers = request.headers().clone();
    match offered_token(&headers) {
        Some(offered) if same_token(offered, &real) => {}
        Some(_) => {
            return refusal(
                StatusCode::UNAUTHORIZED,
                "That token isn't Kern's. The current one is in Kern under Settings → Assistants.",
            )
        }
        None => {
            return refusal(
                StatusCode::UNAUTHORIZED,
                "Kern's assistant endpoint needs a bearer token. Send it as 'Authorization: Bearer …'; the token is in Kern under Settings → Assistants.",
            )
        }
    }

    let name = offered_name(&headers, request.uri().query());
    let decision = {
        let app = app.clone();
        let name = name.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<AppState>().with(|c| {
                if !policy::enabled(c) || !http_enabled(c) {
                    return invalid("Kern's assistant endpoint is turned off.");
                }
                clients::register(c, &name)
            })
        })
        .await
    };
    let client = match decision {
        Ok(Ok(c)) if c.status == APPROVED => c,
        Ok(Ok(c)) => {
            if c.status == PENDING {
                let _ = app.emit("kern://mcp-pending", json!({ "id": c.id, "name": c.name }));
                return refusal(
                    StatusCode::FORBIDDEN,
                    &format!("Kern is waiting for '{}' to be approved in Settings → Assistants.", c.name),
                );
            }
            return refusal(StatusCode::FORBIDDEN, &format!("'{}' has been blocked in Kern.", c.name));
        }
        Ok(Err(e)) => return refusal(StatusCode::FORBIDDEN, &e.to_string()),
        Err(e) => return refusal(StatusCode::INTERNAL_SERVER_ERROR, &format!("Kern couldn't answer that: {e}")),
    };

    let state = app.state::<AppState>();
    let sessions = state.mcp.http.session_manager();
    let handler = {
        let app = app.clone();
        let id = client.id.clone();
        move || Ok(KernMcp::new(app.clone(), id.clone()))
    };
    let service = StreamableHttpService::new(handler, sessions, config());
    service.handle(request).await.map(Body::new)
}

/// How the endpoint behaves on the wire. The two refusals that matter are
/// here: loopback `Host` names only, and no `Origin` at all.
fn config() -> StreamableHttpServerConfig {
    StreamableHttpServerConfig::default()
        .with_allowed_hosts(["localhost", "127.0.0.1", "::1", "[::1]"])
        // An empty allowlist, enforced: a request carrying any `Origin` is
        // refused, which is every request a browser could make. Nothing in a
        // web page can reach Kern, token or no token.
        .enforce_origin_validation()
        // Plain JSON for a plain request and response, which is all a tool
        // call is; rmcp falls back to an event stream by itself if a handler
        // ever needs to send something first.
        .with_json_response(true)
        // Bodies are tool arguments — a project plan, a note, a flowchart —
        // not uploads.
        .with_max_request_body_bytes(2 * 1024 * 1024)
}

// ------------------------------------------------------------ status

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HttpStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub url: String,
    /// Whether a token exists. Never the token itself — that is asked for
    /// on purpose, by `mcp_http_token`.
    pub token_set: bool,
    /// Why it isn't listening, when it was asked to.
    pub problem: Option<String>,
}

pub fn status(conn: &Connection, state: &AppState) -> HttpStatus {
    let configured = port(conn);
    let live = state.mcp.http.port();
    HttpStatus {
        enabled: http_enabled(conn),
        running: live.is_some(),
        port: live.unwrap_or(configured),
        url: url(live.unwrap_or(configured)),
        token_set: token_present(),
        problem: state.mcp.http.problem(),
    }
}

/// The token, and the two things someone does with it. Returned on request
/// because a token has to be pasted into the other program's configuration
/// to be any use — there is no other way for it to get there. It still
/// never touches SQLite, a log or a backup.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HttpCredentials {
    pub token: String,
    pub url: String,
    /// The one-line command for Claude Code.
    pub claude_code: String,
    /// The `mcpServers` fragment for a client that is configured by file.
    pub config: String,
}

pub fn credentials(conn: &Connection, state: &AppState) -> AppResult<HttpCredentials> {
    let port = state.mcp.http.port().unwrap_or_else(|| port(conn));
    let url = url(port);
    let token = token(true)?.ok_or_else(|| AppError::Other("Kern couldn't make a token.".into()))?;
    let fragment = json!({
        "mcpServers": {
            "kern": {
                "type": "http",
                "url": url,
                "headers": { "Authorization": format!("Bearer {token}") },
            }
        }
    });
    Ok(HttpCredentials {
        claude_code: format!("claude mcp add --transport http kern {url} --header \"Authorization: Bearer {token}\""),
        config: serde_json::to_string_pretty(&fragment)?,
        url,
        token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn only_a_bearer_header_carries_the_token() {
        assert_eq!(offered_token(&headers(&[("authorization", "Bearer kern-abc")])), Some("kern-abc"));
        assert_eq!(offered_token(&headers(&[("authorization", "bearer kern-abc")])), Some("kern-abc"));
        assert_eq!(offered_token(&headers(&[("authorization", "Basic kern-abc")])), None);
        assert_eq!(offered_token(&headers(&[("authorization", "Bearer   ")])), None);
        assert_eq!(offered_token(&headers(&[])), None);
    }

    #[test]
    fn tokens_are_compared_whole() {
        assert!(same_token("kern-abc", "kern-abc"));
        assert!(!same_token("kern-abd", "kern-abc"));
        // A prefix must not pass, which is the bug a length check prevents.
        assert!(!same_token("kern-ab", "kern-abc"));
        assert!(!same_token("kern-abcd", "kern-abc"));
    }

    #[test]
    fn a_client_names_itself_or_is_called_something() {
        assert_eq!(offered_name(&headers(&[("x-kern-client", "Zed")]), None), "Zed");
        assert_eq!(offered_name(&headers(&[]), Some("client=My%20Agent")), "My Agent");
        assert_eq!(offered_name(&headers(&[]), Some("client=My+Agent&x=1")), "My Agent");
        assert_eq!(offered_name(&headers(&[]), Some("x=1")), UNNAMED);
        assert_eq!(offered_name(&headers(&[]), None), UNNAMED);
        // The header wins, and a long name is cut rather than refused.
        assert_eq!(offered_name(&headers(&[("x-kern-client", "Zed")]), Some("client=Other")), "Zed");
        assert_eq!(offered_name(&headers(&[("x-kern-client", &"x".repeat(200))]), None).len(), 80);
    }

    #[test]
    fn a_web_page_is_turned_away_before_anything_is_read() {
        assert!(from_a_browser(&headers(&[("origin", "https://evil.example")])));
        assert!(from_a_browser(&headers(&[("origin", "null")])));
        assert!(!from_a_browser(&headers(&[("authorization", "Bearer x")])));
    }

    #[test]
    fn only_this_computers_own_names_are_answered() {
        for host in ["localhost", "localhost:8787", "127.0.0.1:8787", "[::1]:8787", "::1"] {
            assert!(host_is_local(&headers(&[("host", host)])), "{host} should be local");
        }
        for host in ["kern.example.com", "192.168.1.4:8787", "evil.localhost"] {
            assert!(!host_is_local(&headers(&[("host", host)])), "{host} should not be local");
        }
        // Absent is left to rmcp rather than guessed at.
        assert!(host_is_local(&headers(&[])));
    }

    #[test]
    fn the_endpoint_is_loopback_only() {
        for addr in binds(8787) {
            assert!(addr.ip().is_loopback(), "{addr} is not loopback");
        }
    }

    #[test]
    fn the_port_setting_stays_in_range() {
        let c = crate::db::open_memory();
        assert_eq!(port(&c), 8787, "the default, with nothing written");
        settings::set(&c, "mcp.httpPort", &json!(3000)).unwrap();
        assert_eq!(port(&c), 3000);
        // Privileged ports and nonsense are pulled back into range rather
        // than tried and refused by the operating system.
        settings::set(&c, "mcp.httpPort", &json!(80)).unwrap();
        assert_eq!(port(&c), 1024);
        settings::set(&c, "mcp.httpPort", &json!(999999)).unwrap();
        assert_eq!(port(&c), 65535);
    }

    #[test]
    fn the_endpoint_is_off_until_both_switches_are_on() {
        let c = crate::db::open_memory();
        assert!(!http_enabled(&c));
        settings::set(&c, "mcp.httpEnabled", &json!(true)).unwrap();
        assert!(http_enabled(&c) && !policy::enabled(&c), "the master switch is still off");
    }

    #[test]
    fn a_browser_cannot_reach_it() {
        let config = config();
        assert!(config.allowed_origins.is_empty());
        // An empty allowlist that is enforced refuses every present Origin.
        assert!(format!("{config:?}").contains("validate_empty_origin_allowlist: true"));
        assert!(config.allowed_hosts.iter().all(|h| h.contains("localhost") || h.contains("127.0.0.1") || h.contains("::1")));
    }
}
