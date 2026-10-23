// @Author Christian Relf
// @Date 2026-10-12

//! Provider adapters and the HTTP transport.
//!
//! Each provider has its own request format, response parser and error
//! classifier (no shared "one size fits all" request); `Provider` is the
//! common interface the router uses. The transport is a trait so routing
//! and failover can be tested deterministically against mocked responses.
//!
//! Two providers talk to an API over HTTPS and are billed per token.
//! `ClaudeCli` is the third: it runs the `claude` command already installed
//! on this computer, so the request goes out on the user's own Claude
//! subscription and costs nothing per token. It reaches the same code by
//! pretending to be HTTP — `claude-cli://` requests are answered by
//! `CliTransport` in the shape Anthropic's API would have answered in — so
//! routing, failover, usage and the account UI needed nothing new for it.
//! What it cannot do is stream, honour `max_tokens`, or take a key: it uses
//! whatever the CLI is already signed in as.
//!
//! A request may also carry **tools** (`ToolSpec`) and the rounds of a tool
//! loop already done (`Round`). The two API providers describe tools their
//! own way, and each keeps the assistant's reply exactly as it framed it so
//! the next round can echo it back verbatim — a provider's own message shape
//! is the one thing that must survive a round trip untouched.

use super::vault::{redact, Secret};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;

// ------------------------------------------------------------ transport

pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    /// Lower-cased header names.
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TransportError {
    /// Failed before the request could be sent (DNS, connect, TLS): the
    /// provider never saw it, so it is safe to try again elsewhere.
    NotSent(String),
    /// Timed out or broke after sending: the provider may have processed
    /// (and billed) it, so it must not be replayed automatically.
    Ambiguous(String),
}

pub trait Transport: Send + Sync {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError>;
}

pub struct UreqTransport;

impl Transport for UreqTransport {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(req.timeout))
            .http_status_as_error(false)
            .max_redirects(0)
            .user_agent("Kern")
            .build();
        let agent: ureq::Agent = config.into();
        let result = match (req.method, &req.body) {
            ("POST", Some(body)) => {
                let mut b = agent.post(&req.url);
                for (k, v) in &req.headers {
                    b = b.header(k, v);
                }
                b.send(body.as_str())
            }
            _ => {
                let mut b = agent.get(&req.url);
                for (k, v) in &req.headers {
                    b = b.header(k, v);
                }
                b.call()
            }
        };
        let mut resp = result.map_err(|e| match e {
            ureq::Error::HostNotFound | ureq::Error::ConnectionFailed | ureq::Error::Tls(_) | ureq::Error::BadUri(_) => {
                TransportError::NotSent(e.to_string())
            }
            ureq::Error::Timeout(t) => match t {
                ureq::Timeout::Resolve | ureq::Timeout::Connect => TransportError::NotSent(format!("timed out connecting ({t})")),
                _ => TransportError::Ambiguous(format!("timed out ({t})")),
            },
            other => TransportError::Ambiguous(other.to_string()),
        })?;
        let status = resp.status().as_u16();
        let headers = resp
            .headers()
            .iter()
            .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_ascii_lowercase(), v.to_string())))
            .collect();
        let body = resp
            .body_mut()
            .with_config()
            .limit(8 * 1024 * 1024)
            .read_to_string()
            .map_err(|e| TransportError::Ambiguous(format!("couldn't read the response ({e})")))?;
        Ok(HttpResponse { status, headers, body })
    }
}

// ------------------------------------------------------------ the CLI

/// Everything `claude-cli://` needs, kept together: finding the command,
/// running it, and answering in the shape `Provider::ClaudeCli` parses.
///
/// Kern treats the CLI as a text model, not as an agent. It runs with
/// `--max-turns 1`, in a scratch directory rather than anywhere of the
/// user's, so a request for a project breakdown cannot turn into the CLI
/// reading or writing files. Kern has its own tools for that, and they go
/// the other way round.
pub struct CliTransport {
    http: UreqTransport,
}

impl CliTransport {
    pub fn new() -> Self {
        CliTransport { http: UreqTransport }
    }
}

impl Default for CliTransport {
    fn default() -> Self {
        Self::new()
    }
}

/// How long the command may take. The CLI thinks for as long as the model
/// does, so this is generous; the request's own timeout bounds it too.
const CLI_TIMEOUT: Duration = Duration::from_secs(180);

/// Where to look for the command. `KERN_CLAUDE_CLI` wins, for a CLI that
/// isn't on `PATH` — which is common, because it is usually installed by a
/// shell script that edits a shell profile a GUI app never reads.
fn cli_candidates() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    if let Some(explicit) = std::env::var_os("KERN_CLAUDE_CLI").filter(|v| !v.is_empty()) {
        return vec![PathBuf::from(explicit)];
    }
    let mut out: Vec<PathBuf> = vec![];
    // On PATH, under each name the installers use.
    let names: &[&str] = if cfg!(windows) { &["claude.cmd", "claude.exe", "claude.bat"] } else { &["claude"] };
    for name in names {
        out.push(PathBuf::from(name));
    }
    // The places the official installers put it.
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    if let Some(home) = home {
        if cfg!(windows) {
            out.push(home.join(".local").join("bin").join("claude.exe"));
            out.push(home.join(".claude").join("local").join("claude.cmd"));
        } else {
            out.push(home.join(".local").join("bin").join("claude"));
            out.push(home.join(".claude").join("local").join("claude"));
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        out.push(appdata.join("npm").join("claude.cmd"));
    }
    if !cfg!(windows) {
        out.push(PathBuf::from("/usr/local/bin/claude"));
        out.push(PathBuf::from("/opt/homebrew/bin/claude"));
    }
    out
}

/// What the command is asked to do, taken back out of the request body.
struct CliInvocation {
    model: Option<String>,
    system: Option<String>,
    prompt: String,
    models_only: bool,
}

fn read_invocation(req: &HttpRequest) -> CliInvocation {
    let models_only = req.url.ends_with("/v1/models");
    let body: Value = req.body.as_deref().and_then(|b| serde_json::from_str(b).ok()).unwrap_or(Value::Null);
    // One user message, because the CLI is never offered tools and so never
    // asks for a second round. Anything else is flattened rather than lost.
    let prompt = body
        .get("messages")
        .and_then(|m| m.as_array())
        .map(|msgs| {
            msgs.iter()
                .filter_map(|m| m.get("content").and_then(|c| c.as_str()))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default();
    let model = body.get("model").and_then(|m| m.as_str()).filter(|m| !m.is_empty() && *m != "default").map(String::from);
    CliInvocation {
        model,
        system: body.get("system").and_then(|s| s.as_str()).map(String::from),
        prompt,
        models_only,
    }
}

/// A response in the provider's own shape, so nothing downstream has to
/// know this came from a command rather than an API.
fn cli_error(status: u16, kind: &str, message: impl Into<String>) -> HttpResponse {
    let body = json!({ "type": "error", "error": { "type": kind, "message": message.into() } });
    HttpResponse { status, headers: BTreeMap::new(), body: body.to_string() }
}

fn cli_ok(body: Value) -> HttpResponse {
    HttpResponse { status: 200, headers: BTreeMap::new(), body: body.to_string() }
}

/// The model names the CLI accepts. There is no endpoint to ask, and these
/// are aliases rather than versions, so the list is fixed and short:
/// `default` follows whatever the subscription is entitled to.
const CLI_MODELS: &[&str] = &["default", "opus", "sonnet", "haiku"];

/// Reads what the command wrote, with a limit and a deadline. Returns the
/// exit code, stdout and stderr.
fn run_command(
    exe: &std::path::Path,
    args: &[String],
    stdin_text: &str,
    timeout: Duration,
) -> std::io::Result<(Option<i32>, String, String)> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    let mut command = Command::new(exe);
    command.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // A scratch directory: the CLI must not be pointed at anything of the
    // user's, whatever Kern's own working directory happens to be.
    command.current_dir(std::env::temp_dir());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: never flash a console onto the user's screen.
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        let text = stdin_text.to_owned();
        // Written on a thread, and stdin closed when it finishes: the
        // command waits for end-of-input before it starts.
        std::thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
        });
    }
    // Both pipes are drained on their own threads: a command that fills one
    // while Kern waits on the other would deadlock.
    let mut out_handle = child.stdout.take();
    let mut err_handle = child.stderr.take();
    let out_thread = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(h) = out_handle.as_mut() {
            let _ = h.take(8 * 1024 * 1024).read_to_string(&mut text);
        }
        text
    });
    let err_thread = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(h) = err_handle.as_mut() {
            let _ = h.take(256 * 1024).read_to_string(&mut text);
        }
        text
    });
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "the command didn't finish"));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    };
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    Ok((status.code(), stdout, stderr))
}

/// What a failed run was about, read from what it said. The CLI has no
/// error codes, so this is text matching — kept to the few phrases worth
/// acting on differently, with everything else reported as it came.
fn classify_cli_output(code: Option<i32>, stdout: &str, stderr: &str) -> HttpResponse {
    let said = format!("{stderr}\n{stdout}").to_ascii_lowercase();
    let message = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
    let message: String = message.chars().take(500).collect();
    if said.contains("usage limit") || said.contains("rate limit") || said.contains("try again later") {
        return cli_error(429, "usage_limit", if message.is_empty() { "The subscription behind the Claude CLI has hit its usage limit.".into() } else { message });
    }
    if said.contains("not logged in") || said.contains("/login") || said.contains("unauthorized") || said.contains("authentication") || said.contains("invalid api key") {
        return cli_error(
            401,
            "cli_signed_out",
            "The Claude CLI isn't signed in on this computer. Run `claude` in a terminal and sign in, then test this account again.",
        );
    }
    let code = code.map(|c| c.to_string()).unwrap_or_else(|| "no".into());
    cli_error(
        500,
        "api_error",
        if message.is_empty() { format!("The Claude CLI exited with {code} status and said nothing.") } else { message },
    )
}

impl Transport for CliTransport {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TransportError> {
        if !req.url.starts_with("claude-cli://") {
            return self.http.send(req);
        }
        let call = read_invocation(req);
        let mut args: Vec<String> = if call.models_only {
            // Nothing to ask: proving the command exists and runs is the
            // whole of a connection test for a CLI.
            vec!["--version".into()]
        } else {
            vec!["-p".into(), "--output-format".into(), "json".into(), "--max-turns".into(), "1".into()]
        };
        if !call.models_only {
            if let Some(model) = &call.model {
                args.push("--model".into());
                args.push(model.clone());
            }
            if let Some(system) = &call.system {
                args.push("--append-system-prompt".into());
                args.push(system.clone());
            }
        }

        let mut missing: Option<String> = None;
        for exe in cli_candidates() {
            match run_command(&exe, &args, &call.prompt, CLI_TIMEOUT.min(req.timeout.max(Duration::from_secs(30)))) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    missing = Some(exe.to_string_lossy().into_owned());
                    continue;
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    return Ok(cli_error(504, "cli_timeout", "The Claude CLI didn't finish in time, so Kern stopped waiting for it."));
                }
                Err(e) => return Err(TransportError::NotSent(format!("couldn't run {}: {e}", exe.to_string_lossy()))),
                Ok((code, stdout, stderr)) => {
                    if call.models_only {
                        return Ok(if code == Some(0) {
                            cli_ok(json!({ "data": CLI_MODELS.iter().map(|m| json!({ "id": m })).collect::<Vec<_>>() }))
                        } else {
                            classify_cli_output(code, &stdout, &stderr)
                        });
                    }
                    let parsed: Option<Value> = serde_json::from_str(stdout.trim()).ok();
                    return Ok(match parsed {
                        // The CLI reports its own failures in the same
                        // object, with a zero exit code, so this has to be
                        // turned into an error response or it would read as
                        // an answer.
                        Some(v) if v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false) => {
                            let said = v.get("result").and_then(|r| r.as_str()).unwrap_or_default();
                            classify_cli_output(code, said, "")
                        }
                        Some(v) if code == Some(0) => cli_ok(v),
                        _ => classify_cli_output(code, &stdout, &stderr),
                    });
                }
            }
        }
        Ok(cli_error(
            404,
            "cli_missing",
            format!(
                "Kern couldn't find the `claude` command on this computer{}. Install Claude Code, or set KERN_CLAUDE_CLI to the full path of the command.",
                missing.map(|m| format!(" (it tried {m}, among others)")).unwrap_or_default()
            ),
        ))
    }
}

// ------------------------------------------------------------ classification

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    /// Temporary request/token rate limit; retry after the given delay.
    RateLimited,
    /// Organisation or workspace spend limit reached.
    SpendLimit,
    /// Out of credits / billing problem.
    InsufficientQuota,
    InvalidKey,
    Permission,
    ModelUnavailable,
    /// Couldn't reach the provider.
    Network,
    /// Provider overloaded or erroring (5xx).
    Overloaded,
    /// Timed out after sending; outcome unknown.
    Timeout,
    InvalidRequest,
    Unknown,
}

impl ErrorCategory {
    pub fn label(self) -> &'static str {
        match self {
            ErrorCategory::RateLimited => "Rate limited",
            ErrorCategory::SpendLimit => "Spend limit reached",
            ErrorCategory::InsufficientQuota => "Out of credit",
            ErrorCategory::InvalidKey => "Invalid API key",
            ErrorCategory::Permission => "Missing permission",
            ErrorCategory::ModelUnavailable => "Model unavailable",
            ErrorCategory::Network => "Network unavailable",
            ErrorCategory::Overloaded => "Provider overloaded",
            ErrorCategory::Timeout => "Timed out",
            ErrorCategory::InvalidRequest => "Invalid request",
            ErrorCategory::Unknown => "Provider error",
        }
    }

    /// Failures that apply to the whole quota pool (organisation/project),
    /// so other keys in the same pool would fail the same way.
    pub fn pool_wide(self) -> bool {
        matches!(self, ErrorCategory::RateLimited | ErrorCategory::SpendLimit | ErrorCategory::InsufficientQuota)
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFailure {
    pub category: ErrorCategory,
    pub http_status: Option<u16>,
    /// Provider's own error type/code, for diagnostics.
    pub code: Option<String>,
    pub message: String,
    /// Seconds to wait, from `retry-after` (or a provider reset header).
    pub retry_after: Option<f64>,
    /// The provider never produced output for this attempt, so replaying it
    /// elsewhere can't duplicate work or charges.
    pub replay_safe: bool,
}

/// Rate-limit headers exactly as the provider reported them.
pub fn rate_limit_headers(h: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    h.iter()
        .filter(|(k, _)| k.starts_with("anthropic-ratelimit-") || k.starts_with("x-ratelimit-") || *k == "retry-after")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Parses durations like "20", "1.5", "6m0s", "1s", "250ms".
pub fn parse_seconds(v: &str) -> Option<f64> {
    let v = v.trim();
    if let Ok(n) = v.parse::<f64>() {
        return Some(n);
    }
    let mut total = 0.0;
    let mut num = String::new();
    let chars: Vec<char> = v.chars().collect();
    let mut i = 0;
    let mut any = false;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_digit() || c == '.' {
            num.push(c);
            i += 1;
            continue;
        }
        let n: f64 = num.parse().ok()?;
        num.clear();
        if c == 'm' && chars.get(i + 1) == Some(&'s') {
            total += n / 1000.0;
            i += 2;
        } else {
            total += match c {
                'h' => n * 3600.0,
                'm' => n * 60.0,
                's' => n,
                _ => return None,
            };
            i += 1;
        }
        any = true;
    }
    if !num.is_empty() {
        return None;
    }
    any.then_some(total)
}

// ------------------------------------------------------------ providers

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    Anthropic,
    Openai,
    /// The `claude` command on this computer, on the user's own
    /// subscription. No key, no per-token cost, no network call from Kern.
    ClaudeCli,
}

impl Provider {
    pub fn parse(s: &str) -> Option<Provider> {
        match s {
            "anthropic" => Some(Provider::Anthropic),
            "openai" => Some(Provider::Openai),
            "claude-cli" => Some(Provider::ClaudeCli),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::Openai => "openai",
            Provider::ClaudeCli => "claude-cli",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Provider::Anthropic => "Anthropic",
            Provider::Openai => "OpenAI",
            Provider::ClaudeCli => "Claude CLI",
        }
    }
    /// Whether an account for this provider needs an API key. The CLI
    /// doesn't: it is already signed in as somebody.
    pub fn needs_key(self) -> bool {
        self != Provider::ClaudeCli
    }
    /// Whether a request to this provider is billed per token. The
    /// subscription behind the CLI is paid for already, so Kern neither
    /// estimates a cost nor warns about one.
    pub fn metered(self) -> bool {
        self != Provider::ClaudeCli
    }
    /// Whether Kern can give this provider tools of its own to call. The
    /// CLI brings its own and runs its own loop, so Kern doesn't drive one.
    pub fn takes_tools(self) -> bool {
        self != Provider::ClaudeCli
    }
}

/// Non-secret account details needed to address the provider.
#[derive(Debug, Clone, Default)]
pub struct Endpoint {
    pub base_url: Option<String>,
    pub organization_id: Option<String>,
    pub project_ref: Option<String>,
}

/// A tool the model may ask to have run, as that provider's API wants it
/// described. `schema` is JSON Schema and is passed through unchanged.
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

/// The model asking for one tool to be run.
#[derive(Debug, Clone)]
pub struct ToolCall {
    /// The provider's id for this call, which the result has to quote back.
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// What running one came to.
#[derive(Debug, Clone)]
pub struct ToolResult {
    pub id: String,
    pub name: String,
    pub content: String,
    pub ok: bool,
}

/// One finished round of a tool loop: what the model said, and what the
/// tools it asked for came back with.
#[derive(Debug, Clone)]
pub struct Round {
    /// The assistant's message exactly as the provider framed it. Opaque —
    /// only the provider that produced it reads it again.
    pub assistant: Value,
    pub results: Vec<ToolResult>,
}

#[derive(Debug, Clone, Default)]
pub struct TextRequest {
    pub system: Option<String>,
    pub prompt: String,
    pub max_tokens: u32,
    /// Tools the model may call. Empty for an ordinary request, which is
    /// most of them.
    pub tools: Vec<ToolSpec>,
    /// Rounds of the tool loop already done, oldest first.
    pub rounds: Vec<Round>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cached_tokens: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct Completion {
    pub text: String,
    pub model: String,
    pub usage: Usage,
    pub stop_reason: Option<String>,
    /// Tools the model wants run before it will answer.
    pub tool_calls: Vec<ToolCall>,
    /// The assistant's message as the provider framed it, kept for the next
    /// round of a tool loop. Opaque to everything but that provider.
    pub assistant: Value,
}

const ANTHROPIC_URL: &str = "https://api.anthropic.com";
const OPENAI_URL: &str = "https://api.openai.com";
/// Not a real URL. `CliTransport` answers anything on this scheme by running
/// the local `claude` command; `UreqTransport` would refuse it, which is the
/// point — a build without the CLI transport can't accidentally dial out.
pub const CLI_URL: &str = "claude-cli://local";

fn base(p: Provider, e: &Endpoint) -> String {
    e.base_url.clone().unwrap_or_else(|| {
        match p {
            Provider::Anthropic => ANTHROPIC_URL,
            Provider::Openai => OPENAI_URL,
            Provider::ClaudeCli => CLI_URL,
        }
        .to_string()
    })
}

fn auth_headers(p: Provider, key: &Secret, e: &Endpoint) -> Vec<(String, String)> {
    match p {
        Provider::Anthropic => vec![
            ("x-api-key".into(), key.expose().to_string()),
            ("anthropic-version".into(), "2023-06-01".into()),
        ],
        Provider::Openai => {
            let mut h = vec![("authorization".into(), format!("Bearer {}", key.expose()))];
            if let Some(o) = e.organization_id.as_ref().filter(|s| !s.is_empty()) {
                h.push(("openai-organization".into(), o.clone()));
            }
            if let Some(pr) = e.project_ref.as_ref().filter(|s| !s.is_empty()) {
                h.push(("openai-project".into(), pr.clone()));
            }
            h
        }
        // Nothing to authenticate with, and nothing that should look like it.
        Provider::ClaudeCli => vec![],
    }
}

/// Tool definitions in each provider's own shape.
fn tool_defs(p: Provider, tools: &[ToolSpec]) -> Value {
    let described = |t: &ToolSpec| {
        let schema = if t.schema.is_object() { t.schema.clone() } else { json!({ "type": "object" }) };
        match p {
            Provider::Openai => json!({
                "type": "function",
                "function": { "name": t.name, "description": t.description, "parameters": schema },
            }),
            _ => json!({ "name": t.name, "description": t.description, "input_schema": schema }),
        }
    };
    Value::Array(tools.iter().map(described).collect())
}

/// The messages a request carries: the prompt, then each finished round of
/// the tool loop — the assistant's reply as it framed it, and the results it
/// asked for.
fn messages(p: Provider, req: &TextRequest) -> Vec<Value> {
    let mut out = vec![];
    if p == Provider::Openai {
        if let Some(system) = &req.system {
            out.push(json!({ "role": "system", "content": system }));
        }
    }
    out.push(json!({ "role": "user", "content": req.prompt }));
    for round in &req.rounds {
        match p {
            Provider::Openai => {
                // OpenAI keeps the whole assistant message, tool calls and all.
                out.push(round.assistant.clone());
                for r in &round.results {
                    out.push(json!({ "role": "tool", "tool_call_id": r.id, "content": r.content }));
                }
            }
            _ => {
                out.push(json!({ "role": "assistant", "content": round.assistant }));
                let blocks: Vec<Value> = round
                    .results
                    .iter()
                    .map(|r| {
                        let mut block = json!({ "type": "tool_result", "tool_use_id": r.id, "content": r.content });
                        if !r.ok {
                            block["is_error"] = json!(true);
                        }
                        block
                    })
                    .collect();
                out.push(json!({ "role": "user", "content": blocks }));
            }
        }
    }
    out
}

impl Provider {
    /// A no-cost authenticated call (list models) used to validate keys.
    pub fn models_request(self, key: &Secret, e: &Endpoint) -> HttpRequest {
        let url = match self {
            Provider::Anthropic => format!("{}/v1/models?limit=100", base(self, e)),
            Provider::Openai | Provider::ClaudeCli => format!("{}/v1/models", base(self, e)),
        };
        HttpRequest { method: "GET", url, headers: auth_headers(self, key, e), body: None, timeout: Duration::from_secs(15) }
    }

    pub fn parse_models(self, body: &str) -> Vec<String> {
        let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        let mut ids: Vec<String> = v
            .get("data")
            .and_then(|d| d.as_array())
            .map(|a| a.iter().filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from)).collect())
            .unwrap_or_default();
        if self == Provider::Openai {
            // Only chat-capable families are useful for text requests.
            ids.retain(|id| id.starts_with("gpt-") || id.starts_with("o1") || id.starts_with("o3") || id.starts_with("o4") || id.starts_with("chatgpt"));
            ids.sort();
        }
        ids
    }

    pub fn complete_request(self, key: &Secret, e: &Endpoint, model: &str, req: &TextRequest) -> HttpRequest {
        let (url, body) = match self {
            Provider::Anthropic | Provider::ClaudeCli => {
                let mut b = json!({
                    "model": model,
                    "max_tokens": req.max_tokens,
                    "messages": messages(self, req),
                });
                if let Some(s) = &req.system {
                    b["system"] = json!(s);
                }
                if !req.tools.is_empty() && self.takes_tools() {
                    b["tools"] = tool_defs(self, &req.tools);
                }
                (format!("{}/v1/messages", base(self, e)), b)
            }
            Provider::Openai => {
                let mut b = json!({
                    "model": model,
                    "max_completion_tokens": req.max_tokens,
                    "messages": messages(self, req),
                });
                if !req.tools.is_empty() {
                    b["tools"] = tool_defs(self, &req.tools);
                }
                (format!("{}/v1/chat/completions", base(self, e)), b)
            }
        };
        let mut headers = auth_headers(self, key, e);
        headers.push(("content-type".into(), "application/json".into()));
        HttpRequest { method: "POST", url, headers, body: Some(body.to_string()), timeout: Duration::from_secs(120) }
    }

    pub fn parse_completion(self, body: &str) -> Option<Completion> {
        let v: Value = serde_json::from_str(body).ok()?;
        match self {
            Provider::Anthropic => {
                let content = v.get("content")?.as_array()?;
                let kind = |b: &Value| b.get("type").and_then(|t| t.as_str()).unwrap_or_default().to_string();
                let text = content
                    .iter()
                    .filter(|b| kind(b) == "text")
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("");
                let tool_calls = content
                    .iter()
                    .filter(|b| kind(b) == "tool_use")
                    .filter_map(|b| {
                        Some(ToolCall {
                            id: b.get("id")?.as_str()?.to_string(),
                            name: b.get("name")?.as_str()?.to_string(),
                            arguments: b.get("input").cloned().unwrap_or(Value::Null),
                        })
                    })
                    .collect();
                let u = v.get("usage");
                let n = |k: &str| u.and_then(|u| u.get(k)).and_then(|x| x.as_i64());
                Some(Completion {
                    text,
                    model: v.get("model").and_then(|m| m.as_str()).unwrap_or_default().to_string(),
                    usage: Usage {
                        input_tokens: n("input_tokens").map(|i| i + n("cache_creation_input_tokens").unwrap_or(0)),
                        output_tokens: n("output_tokens"),
                        cached_tokens: n("cache_read_input_tokens"),
                    },
                    stop_reason: v.get("stop_reason").and_then(|s| s.as_str()).map(String::from),
                    tool_calls,
                    // The content blocks, kept whole: a tool_use block has to
                    // go back exactly as it came or the next round is refused.
                    assistant: Value::Array(content.clone()),
                })
            }
            Provider::Openai => {
                let choice = v.get("choices")?.as_array()?.first()?;
                let message = choice.get("message").cloned().unwrap_or(Value::Null);
                let tool_calls = message
                    .get("tool_calls")
                    .and_then(|t| t.as_array())
                    .map(|calls| {
                        calls
                            .iter()
                            .filter_map(|c| {
                                let raw = c.pointer("/function/arguments").and_then(|a| a.as_str()).unwrap_or("{}");
                                Some(ToolCall {
                                    id: c.get("id")?.as_str()?.to_string(),
                                    name: c.pointer("/function/name")?.as_str()?.to_string(),
                                    // Arguments arrive as a JSON string. An
                                    // unparseable one is passed on as text
                                    // rather than dropped, so the tool can say
                                    // what was wrong with it.
                                    arguments: serde_json::from_str(raw).unwrap_or_else(|_| json!(raw)),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let u = v.get("usage");
                let n = |k: &str| u.and_then(|u| u.get(k)).and_then(|x| x.as_i64());
                Some(Completion {
                    text: message.get("content").and_then(|c| c.as_str()).unwrap_or_default().to_string(),
                    model: v.get("model").and_then(|m| m.as_str()).unwrap_or_default().to_string(),
                    usage: Usage {
                        input_tokens: n("prompt_tokens"),
                        output_tokens: n("completion_tokens"),
                        cached_tokens: u.and_then(|u| u.pointer("/prompt_tokens_details/cached_tokens")).and_then(|x| x.as_i64()),
                    },
                    stop_reason: choice.get("finish_reason").and_then(|s| s.as_str()).map(String::from),
                    tool_calls,
                    assistant: message,
                })
            }
            // `claude -p --output-format json`: one object, with the answer
            // in `result`. The CLI runs its own tools, so there is never a
            // tool call here for Kern to make.
            Provider::ClaudeCli => {
                if v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false) {
                    return None;
                }
                let u = v.get("usage");
                let n = |k: &str| u.and_then(|u| u.get(k)).and_then(|x| x.as_i64());
                Some(Completion {
                    text: v.get("result").and_then(|r| r.as_str()).unwrap_or_default().to_string(),
                    model: v
                        .get("modelUsage")
                        .and_then(|m| m.as_object())
                        .and_then(|m| m.keys().next().cloned())
                        .or_else(|| v.get("model").and_then(|m| m.as_str()).map(String::from))
                        .unwrap_or_default(),
                    usage: Usage {
                        input_tokens: n("input_tokens").map(|i| i + n("cache_creation_input_tokens").unwrap_or(0)),
                        output_tokens: n("output_tokens"),
                        cached_tokens: n("cache_read_input_tokens"),
                    },
                    stop_reason: v.get("subtype").and_then(|s| s.as_str()).map(String::from),
                    tool_calls: vec![],
                    assistant: Value::Null,
                })
            }
        }
    }

    /// The organisation a response says the key belongs to - keys sharing
    /// it share rate limits and billing.
    pub fn observed_pool(self, h: &BTreeMap<String, String>) -> Option<String> {
        match self {
            Provider::Anthropic => h.get("anthropic-organization-id").cloned(),
            Provider::Openai => h.get("openai-organization").cloned().map(|o| match h.get("openai-project") {
                Some(p) => format!("{o}/{p}"),
                None => o,
            }),
            // One signed-in CLI per computer: there is no pool to share.
            Provider::ClaudeCli => None,
        }
    }

    /// Classifies a non-success response from structured fields: HTTP
    /// status, the provider's error `type`/`code` and headers. Message text
    /// is only a last-resort hint.
    pub fn classify(self, resp: &HttpResponse, key: Option<&Secret>) -> ProviderFailure {
        let v: Value = serde_json::from_str(&resp.body).unwrap_or(Value::Null);
        let err = v.get("error");
        let etype = err.and_then(|e| e.get("type")).and_then(|t| t.as_str()).map(String::from);
        let ecode = err.and_then(|e| e.get("code")).and_then(|t| t.as_str()).map(String::from);
        let raw_msg = err.and_then(|e| e.get("message")).and_then(|m| m.as_str()).unwrap_or("").to_string();
        let message = redact(&raw_msg, key).chars().take(500).collect::<String>();
        let lower = raw_msg.to_ascii_lowercase();
        let mut retry_after = resp.headers.get("retry-after").and_then(|v| parse_seconds(v));
        let status = resp.status;
        let category = match self {
            Provider::Anthropic => match (status, etype.as_deref()) {
                (_, Some("authentication_error")) | (401, _) => ErrorCategory::InvalidKey,
                (_, Some("billing_error")) | (402, _) => ErrorCategory::InsufficientQuota,
                (_, Some("permission_error")) | (403, _) => ErrorCategory::Permission,
                (_, Some("rate_limit_error")) | (429, _) => ErrorCategory::RateLimited,
                (_, Some("overloaded_error")) | (529, _) => ErrorCategory::Overloaded,
                (_, Some("not_found_error")) if lower.starts_with("model:") => ErrorCategory::ModelUnavailable,
                (_, Some("invalid_request_error")) if lower.contains("credit balance") => ErrorCategory::InsufficientQuota,
                (_, Some("invalid_request_error")) | (_, Some("request_too_large")) | (400 | 413, _) => ErrorCategory::InvalidRequest,
                (_, Some("api_error")) | (500..=599, _) => ErrorCategory::Overloaded,
                (404, _) => ErrorCategory::InvalidRequest,
                _ => ErrorCategory::Unknown,
            },
            // Synthesised by `CliTransport` from what the command did, in
            // the same shape, so one classifier covers all three.
            Provider::ClaudeCli => match (status, etype.as_deref()) {
                (_, Some("cli_missing")) => ErrorCategory::Network,
                (_, Some("cli_signed_out")) | (401, _) => ErrorCategory::InvalidKey,
                (_, Some("usage_limit")) | (429, _) => ErrorCategory::RateLimited,
                (_, Some("cli_timeout")) => ErrorCategory::Timeout,
                (_, Some("invalid_request_error")) | (400, _) => ErrorCategory::InvalidRequest,
                _ => ErrorCategory::Unknown,
            },
            Provider::Openai => match (status, ecode.as_deref(), etype.as_deref()) {
                (_, Some("insufficient_quota"), _) | (_, _, Some("insufficient_quota")) => ErrorCategory::InsufficientQuota,
                (_, Some("billing_hard_limit_reached"), _) | (_, Some("billing_not_active"), _) => ErrorCategory::SpendLimit,
                (_, Some("invalid_api_key"), _) | (401, _, _) => ErrorCategory::InvalidKey,
                (_, Some("model_not_found"), _) => ErrorCategory::ModelUnavailable,
                (403, _, _) => ErrorCategory::Permission,
                (_, Some("rate_limit_exceeded"), _) | (429, _, _) => ErrorCategory::RateLimited,
                (400 | 404 | 413 | 422, _, _) => ErrorCategory::InvalidRequest,
                (500..=599, _, _) => ErrorCategory::Overloaded,
                _ => ErrorCategory::Unknown,
            },
        };
        if category == ErrorCategory::RateLimited && retry_after.is_none() {
            // OpenAI reports when its window resets instead of retry-after.
            retry_after = ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]
                .iter()
                .filter_map(|k| resp.headers.get(*k).and_then(|v| parse_seconds(v)))
                .fold(None, |acc: Option<f64>, x| Some(acc.map_or(x, |a| a.max(x))));
        }
        ProviderFailure {
            category,
            http_status: Some(status),
            code: ecode.or(etype),
            message: if message.is_empty() { format!("HTTP {status}") } else { message },
            retry_after,
            replay_safe: true,
        }
    }
}

pub fn transport_failure(e: &TransportError) -> ProviderFailure {
    match e {
        TransportError::NotSent(m) => ProviderFailure {
            category: ErrorCategory::Network,
            http_status: None,
            code: None,
            message: format!("Couldn't reach the provider ({m})."),
            retry_after: None,
            replay_safe: true,
        },
        TransportError::Ambiguous(m) => ProviderFailure {
            category: ErrorCategory::Timeout,
            http_status: None,
            code: None,
            message: format!("The request didn't complete ({m}). It may still have been processed, so it wasn't retried."),
            retry_after: None,
            replay_safe: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resp(status: u16, body: &str, headers: &[(&str, &str)]) -> HttpResponse {
        HttpResponse { status, body: body.into(), headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
    }

    #[test]
    fn classifies_anthropic_errors_structurally() {
        let a = Provider::Anthropic;
        let r = resp(429, r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#, &[("retry-after", "12")]);
        let f = a.classify(&r, None);
        assert_eq!((f.category, f.retry_after), (ErrorCategory::RateLimited, Some(12.0)));
        assert_eq!(a.classify(&resp(402, r#"{"type":"error","error":{"type":"billing_error","message":"x"}}"#, &[]), None).category, ErrorCategory::InsufficientQuota);
        assert_eq!(a.classify(&resp(401, r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#, &[]), None).category, ErrorCategory::InvalidKey);
        assert_eq!(a.classify(&resp(529, r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#, &[]), None).category, ErrorCategory::Overloaded);
        assert_eq!(a.classify(&resp(404, r#"{"type":"error","error":{"type":"not_found_error","message":"model: nope"}}"#, &[]), None).category, ErrorCategory::ModelUnavailable);
        assert_eq!(a.classify(&resp(400, r#"{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}"#, &[]), None).category, ErrorCategory::InvalidRequest);
        // Unparseable body still classified from the status.
        assert_eq!(a.classify(&resp(503, "<html>", &[]), None).category, ErrorCategory::Overloaded);
    }

    #[test]
    fn classifies_openai_errors_by_code() {
        let o = Provider::Openai;
        let quota = resp(429, r#"{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}"#, &[]);
        assert_eq!(o.classify(&quota, None).category, ErrorCategory::InsufficientQuota, "a 429 isn't always a rate limit");
        let rl = resp(429, r#"{"error":{"message":"Rate limit","type":"requests","code":"rate_limit_exceeded"}}"#, &[("x-ratelimit-reset-requests", "6m0s")]);
        let f = o.classify(&rl, None);
        assert_eq!((f.category, f.retry_after), (ErrorCategory::RateLimited, Some(360.0)));
        let key = Secret::new("sk-proj-abcdefghijklmnopqrstuvwxyz".into());
        let bad = resp(401, r#"{"error":{"message":"Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz.","code":"invalid_api_key"}}"#, &[]);
        let f = o.classify(&bad, Some(&key));
        assert_eq!(f.category, ErrorCategory::InvalidKey);
        assert!(!f.message.contains("abcdefghij"), "key must be redacted from messages");
    }

    #[test]
    fn parses_usage() {
        let c = Provider::Anthropic
            .parse_completion(r#"{"model":"claude-opus-5-5","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":3,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}"#)
            .unwrap();
        assert_eq!((c.text.as_str(), c.usage.input_tokens, c.usage.output_tokens, c.usage.cached_tokens), ("hi", Some(12), Some(3), Some(4)));
        let c = Provider::Openai
            .parse_completion(r#"{"model":"gpt-x","choices":[{"message":{"content":"yo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":1}}}"#)
            .unwrap();
        assert_eq!((c.text.as_str(), c.usage.cached_tokens), ("yo", Some(1)));
    }

    #[test]
    fn durations() {
        assert_eq!(parse_seconds("6m0s"), Some(360.0));
        assert_eq!(parse_seconds("250ms"), Some(0.25));
        assert_eq!(parse_seconds("1.5"), Some(1.5));
        assert_eq!(parse_seconds("soon"), None);
    }

    #[test]
    fn tool_calls_come_back_whichever_way_they_were_framed() {
        let a = Provider::Anthropic
            .parse_completion(
                r#"{"model":"m","stop_reason":"tool_use","content":[
                     {"type":"text","text":"Looking."},
                     {"type":"tool_use","id":"tu_1","name":"files__read","input":{"path":"a.txt"}}]}"#,
            )
            .unwrap();
        assert_eq!(a.text, "Looking.");
        assert_eq!(a.tool_calls.len(), 1);
        assert_eq!((a.tool_calls[0].id.as_str(), a.tool_calls[0].name.as_str()), ("tu_1", "files__read"));
        assert_eq!(a.tool_calls[0].arguments, json!({ "path": "a.txt" }));
        // The blocks are kept whole, because the next round echoes them back.
        assert_eq!(a.assistant.as_array().map(|b| b.len()), Some(2));

        let o = Provider::Openai
            .parse_completion(
                r#"{"model":"m","choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,
                     "tool_calls":[{"id":"call_1","type":"function","function":{"name":"files__read","arguments":"{\"path\":\"a.txt\"}"}}]}}]}"#,
            )
            .unwrap();
        assert_eq!(o.tool_calls.len(), 1);
        assert_eq!(o.tool_calls[0].arguments, json!({ "path": "a.txt" }));
        assert_eq!(o.assistant.get("role").and_then(|r| r.as_str()), Some("assistant"));
        // Unparseable arguments are passed on rather than dropped: the tool
        // can then say what was wrong with them.
        let bad = Provider::Openai
            .parse_completion(
                r#"{"choices":[{"message":{"tool_calls":[{"id":"c","function":{"name":"t","arguments":"{oops"}}]}}]}"#,
            )
            .unwrap();
        assert_eq!(bad.tool_calls[0].arguments, json!("{oops"));
    }

    #[test]
    fn a_finished_round_goes_back_in_the_providers_own_shape() {
        let tools = vec![ToolSpec { name: "files__read".into(), description: "Read a file.".into(), schema: json!({ "type": "object" }) }];
        let round = Round {
            assistant: json!([{ "type": "tool_use", "id": "tu_1", "name": "files__read", "input": {} }]),
            results: vec![ToolResult { id: "tu_1".into(), name: "files__read".into(), content: "hello".into(), ok: true }],
        };
        let req = TextRequest {
            system: Some("be brief".into()),
            prompt: "read it".into(),
            max_tokens: 100,
            tools: tools.clone(),
            rounds: vec![round.clone()],
        };
        let key = Secret::new("sk-ant-0000000000000000".into());
        let body: Value =
            serde_json::from_str(Provider::Anthropic.complete_request(&key, &Endpoint::default(), "m", &req).body.as_deref().unwrap())
                .unwrap();
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3, "the prompt, the assistant's reply, and the results");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"][0]["id"], "tu_1", "the tool_use block has to go back untouched");
        assert_eq!(messages[2]["content"][0]["tool_use_id"], "tu_1");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        // Anthropic takes the system prompt in its own field, not a message.
        assert_eq!(body["system"], "be brief");

        let openai = Round {
            assistant: json!({ "role": "assistant", "tool_calls": [{ "id": "call_1" }] }),
            results: vec![ToolResult { id: "call_1".into(), name: "files__read".into(), content: "hello".into(), ok: true }],
        };
        let req = TextRequest { rounds: vec![openai], ..req };
        let body: Value =
            serde_json::from_str(Provider::Openai.complete_request(&key, &Endpoint::default(), "m", &req).body.as_deref().unwrap())
                .unwrap();
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 4, "system, prompt, the assistant message, the tool result");
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[2]["tool_calls"][0]["id"], "call_1");
        assert_eq!((messages[3]["role"].as_str(), messages[3]["tool_call_id"].as_str()), (Some("tool"), Some("call_1")));
        assert_eq!(body["tools"][0]["type"], "function");
    }

    #[test]
    fn a_failed_tool_is_marked_as_one() {
        let req = TextRequest {
            prompt: "x".into(),
            rounds: vec![Round {
                assistant: json!([]),
                results: vec![ToolResult { id: "tu_1".into(), name: "t".into(), content: "no such file".into(), ok: false }],
            }],
            ..Default::default()
        };
        let key = Secret::new(String::new());
        let body: Value =
            serde_json::from_str(Provider::Anthropic.complete_request(&key, &Endpoint::default(), "m", &req).body.as_deref().unwrap())
                .unwrap();
        assert_eq!(body["messages"][2]["content"][0]["is_error"], true);
    }

    #[test]
    fn the_cli_is_keyless_unmetered_and_runs_its_own_tools() {
        let p = Provider::ClaudeCli;
        assert_eq!(Provider::parse("claude-cli"), Some(p));
        assert!(!p.needs_key() && !p.metered() && !p.takes_tools());
        assert!(Provider::Anthropic.needs_key() && Provider::Anthropic.metered() && Provider::Anthropic.takes_tools());
        // Nothing that could be mistaken for a credential goes on a request.
        let key = Secret::new("not-a-key".into());
        let req = p.complete_request(&key, &Endpoint::default(), "default", &TextRequest { prompt: "hi".into(), ..Default::default() });
        assert!(req.headers.iter().all(|(k, _)| k == "content-type"));
        assert!(req.url.starts_with("claude-cli://"));
        // Tools are never sent to it, even when the request carries some.
        let with_tools = TextRequest {
            prompt: "hi".into(),
            tools: vec![ToolSpec { name: "t".into(), description: "d".into(), schema: json!({ "type": "object" }) }],
            ..Default::default()
        };
        let body: Value = serde_json::from_str(p.complete_request(&key, &Endpoint::default(), "default", &with_tools).body.as_deref().unwrap()).unwrap();
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn reads_what_the_cli_printed() {
        let c = Provider::ClaudeCli
            .parse_completion(
                r#"{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s",
                    "modelUsage":{"claude-opus-5-5":{}},"usage":{"input_tokens":7,"output_tokens":2,"cache_read_input_tokens":1}}"#,
            )
            .unwrap();
        assert_eq!((c.text.as_str(), c.model.as_str()), ("done", "claude-opus-5-5"));
        assert_eq!((c.usage.input_tokens, c.usage.cached_tokens), (Some(7), Some(1)));
        assert!(c.tool_calls.is_empty());
        // Its own failures arrive with a zero exit code, so they must not
        // read as an answer.
        assert!(Provider::ClaudeCli.parse_completion(r#"{"is_error":true,"result":"usage limit reached"}"#).is_none());
    }

    #[test]
    fn what_the_cli_said_decides_what_went_wrong() {
        let limit = classify_cli_output(Some(1), "", "Claude usage limit reached. Try again later.");
        assert_eq!(limit.status, 429);
        assert_eq!(Provider::ClaudeCli.classify(&limit, None).category, ErrorCategory::RateLimited);
        let out = classify_cli_output(Some(1), "", "Not logged in. Run /login.");
        assert_eq!(Provider::ClaudeCli.classify(&out, None).category, ErrorCategory::InvalidKey);
        let odd = classify_cli_output(Some(2), "", "something else broke");
        let f = Provider::ClaudeCli.classify(&odd, None);
        assert_eq!(f.category, ErrorCategory::Unknown);
        assert!(f.message.contains("something else broke"), "whatever it said is passed on");
        // A missing command is about this computer, not about the account,
        // so it must not look like a credential problem.
        let missing = cli_error(404, "cli_missing", "no claude here");
        assert_eq!(Provider::ClaudeCli.classify(&missing, None).category, ErrorCategory::Network);
    }

    #[test]
    fn the_cli_is_looked_for_where_its_installers_put_it() {
        let found = cli_candidates();
        assert!(found.iter().any(|p| p.to_string_lossy().contains("claude")));
        assert!(found.len() > 1, "more than just PATH, because a GUI app doesn't read a shell profile");
    }

    #[test]
    fn keys_go_in_headers_never_urls() {
        let key = Secret::new("sk-ant-abcdefghijklmnop1234".into());
        for p in [Provider::Anthropic, Provider::Openai] {
            let r = p.models_request(&key, &Endpoint::default());
            assert!(!r.url.contains("abcdefghij"));
            let r = p.complete_request(&key, &Endpoint::default(), "m", &TextRequest { system: None, prompt: "x".into(), max_tokens: 5, ..Default::default() });
            assert!(!r.url.contains("abcdefghij") && !r.body.unwrap().contains("abcdefghij"));
        }
    }
}
