// @Author Christian Relf
// @Date 2026-10-12

//! AI API account management and provider routing.
//!
//! Optional: nothing else in Kern depends on it, and no network traffic
//! happens merely because accounts are configured (no polling; usage and
//! rate-limit data come from the user's own requests and connection tests).

pub mod accounts;
pub mod provider;
pub mod router;
pub mod vault;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::util::now_ms;
use accounts::{Account, AccountPatch, NewAccount};
use router::{AiService, RouteOutcome, RouteRequest, Validation};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Credential-store namespace. Isolated instances (KERN_DATA_DIR) get their
/// own so test keys never mix with real ones.
pub fn vault_service() -> String {
    match std::env::var("KERN_DATA_DIR") {
        Ok(d) if !d.is_empty() => {
            let h = d.bytes().fold(1469598103934665603u64, |h, b| (h ^ b as u64).wrapping_mul(1099511628211));
            format!("app.kern.desktop.ai.isolated-{h:x}")
        }
        _ => "app.kern.desktop.ai".into(),
    }
}

/// The service the app runs with: the OS credential store, and a transport
/// that answers `claude-cli://` by running the local command and everything
/// else over HTTPS.
///
/// The tool runner is **not** built here. It reaches the user's MCP servers
/// through the window handle, and building one in a constructor this early
/// drags the whole windowing stack into anything that links the library -
/// including the test harness, which has no application manifest to load it
/// with. `mcp::outbound::attach` hands it over at startup instead.
pub fn default_service() -> AiService {
    AiService::new(Box::new(vault::OsKeyring::new(vault_service())), Box::new(provider::CliTransport::new()))
}

async fn blocking<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&AppState) -> AppResult<T> + Send + 'static) -> AppResult<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<AppState>()))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

// ------------------------------------------------------------ usage

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    pub day: String,
    pub requests: i64,
    pub failures: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Breakdown {
    pub key: String,
    pub label: String,
    pub requests: i64,
    pub tokens: i64,
    pub cost: Option<f64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageEvent {
    pub id: i64,
    pub request_id: String,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub provider: String,
    pub model: Option<String>,
    pub purpose: String,
    pub attempt: i64,
    pub started_at: i64,
    pub duration_ms: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cached_tokens: Option<i64>,
    pub success: bool,
    pub error_category: Option<String>,
    pub http_status: Option<i64>,
    pub estimated_cost: Option<f64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FailoverEvent {
    pub id: i64,
    pub request_id: String,
    pub from_name: Option<String>,
    pub to_name: Option<String>,
    pub reason: String,
    pub detail: Option<String>,
    pub created_at: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub days: Vec<DayUsage>,
    pub by_provider: Vec<Breakdown>,
    pub by_model: Vec<Breakdown>,
    pub by_account: Vec<Breakdown>,
    pub requests: i64,
    pub failures: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub cost: Option<f64>,
    pub recent: Vec<UsageEvent>,
    pub failovers: Vec<FailoverEvent>,
}

pub fn usage_summary(conn: &Connection, since: i64, tz_offset_minutes: i64) -> AppResult<UsageSummary> {
    let shift = tz_offset_minutes * 60_000;
    let mut days_stmt = conn.prepare(
        "SELECT date((started_at + ?2) / 1000, 'unixepoch') AS d, count(*), sum(success = 0),
                coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0)
         FROM ai_usage_events WHERE started_at >= ?1 AND purpose != 'validation' GROUP BY d ORDER BY d",
    )?;
    let days = days_stmt
        .query_map(params![since, shift], |r| Ok(DayUsage { day: r.get(0)?, requests: r.get(1)?, failures: r.get(2)?, input_tokens: r.get(3)?, output_tokens: r.get(4)? }))?
        .collect::<Result<Vec<_>, _>>()?;
    let breakdown = |sql: &str| -> AppResult<Vec<Breakdown>> {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([since], |r| {
            Ok(Breakdown { key: r.get::<_, Option<String>>(0)?.unwrap_or_default(), label: r.get::<_, Option<String>>(1)?.unwrap_or_else(|| "Removed account".into()), requests: r.get(2)?, tokens: r.get(3)?, cost: r.get(4)? })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    };
    let tok = "coalesce(sum(coalesce(e.input_tokens, 0) + coalesce(e.output_tokens, 0)), 0)";
    let by_provider = breakdown(&format!("SELECT e.provider, e.provider, count(*), {tok}, sum(e.estimated_cost) FROM ai_usage_events e WHERE e.started_at >= ?1 AND e.purpose != 'validation' GROUP BY e.provider ORDER BY 3 DESC"))?;
    let by_model = breakdown(&format!("SELECT e.model, e.model, count(*), {tok}, sum(e.estimated_cost) FROM ai_usage_events e WHERE e.started_at >= ?1 AND e.purpose != 'validation' AND e.model IS NOT NULL GROUP BY e.model ORDER BY 3 DESC"))?;
    let by_account = breakdown(&format!("SELECT e.account_id, a.name, count(*), {tok}, sum(e.estimated_cost) FROM ai_usage_events e LEFT JOIN ai_accounts a ON a.id = e.account_id WHERE e.started_at >= ?1 AND e.purpose != 'validation' GROUP BY e.account_id ORDER BY 3 DESC"))?;
    let (requests, failures, input_tokens, output_tokens, cached_tokens, cost) = conn.query_row(
        "SELECT count(*), coalesce(sum(success = 0), 0), coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0), coalesce(sum(cached_tokens), 0), sum(estimated_cost)
         FROM ai_usage_events WHERE started_at >= ?1 AND purpose != 'validation'",
        [since],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
    )?;
    let mut recent_stmt = conn.prepare(
        "SELECT e.id, e.request_id, e.account_id, a.name, e.provider, e.model, e.purpose, e.attempt, e.started_at, e.duration_ms,
                e.input_tokens, e.output_tokens, e.cached_tokens, e.success, e.error_category, e.http_status, e.estimated_cost
         FROM ai_usage_events e LEFT JOIN ai_accounts a ON a.id = e.account_id ORDER BY e.started_at DESC, e.id DESC LIMIT 50",
    )?;
    let recent = recent_stmt
        .query_map([], |r| {
            Ok(UsageEvent {
                id: r.get(0)?,
                request_id: r.get(1)?,
                account_id: r.get(2)?,
                account_name: r.get(3)?,
                provider: r.get(4)?,
                model: r.get(5)?,
                purpose: r.get(6)?,
                attempt: r.get(7)?,
                started_at: r.get(8)?,
                duration_ms: r.get(9)?,
                input_tokens: r.get(10)?,
                output_tokens: r.get(11)?,
                cached_tokens: r.get(12)?,
                success: r.get::<_, i64>(13)? != 0,
                error_category: r.get(14)?,
                http_status: r.get(15)?,
                estimated_cost: r.get(16)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut fo_stmt = conn.prepare(
        "SELECT f.id, f.request_id, a1.name, a2.name, f.reason, f.detail, f.created_at FROM ai_failover_events f
         LEFT JOIN ai_accounts a1 ON a1.id = f.from_account_id LEFT JOIN ai_accounts a2 ON a2.id = f.to_account_id
         ORDER BY f.created_at DESC LIMIT 30",
    )?;
    let failovers = fo_stmt
        .query_map([], |r| Ok(FailoverEvent { id: r.get(0)?, request_id: r.get(1)?, from_name: r.get(2)?, to_name: r.get(3)?, reason: r.get(4)?, detail: r.get(5)?, created_at: r.get(6)? }))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(UsageSummary { days, by_provider, by_model, by_account, requests, failures, input_tokens, output_tokens, cached_tokens, cost, recent, failovers })
}

/// Drops request history older than the retention setting.
pub fn prune(conn: &Connection, days: i64) -> AppResult<()> {
    let cutoff = now_ms() - days.max(1) * 86_400_000;
    conn.execute("DELETE FROM ai_usage_events WHERE started_at < ?1", [cutoff])?;
    conn.execute("DELETE FROM ai_failover_events WHERE created_at < ?1", [cutoff])?;
    Ok(())
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub fn ai_accounts_list(state: State<AppState>) -> AppResult<Vec<Account>> {
    state.with(|c| accounts::list(c))
}

/// The key travels from the form to the credential store; it is never
/// returned, stored in SQLite or logged.
#[tauri::command]
pub async fn ai_account_create(app: AppHandle, input: NewAccount) -> AppResult<Account> {
    blocking(&app, move |s| s.with(|c| accounts::create(c, s.ai.vault.as_ref(), &input))).await
}

/// Checks a key before it is saved. The key is used for this one call only.
/// A provider that takes no key is tested the same way, with nothing in
/// place of one: whether it works is whether the command runs.
#[tauri::command]
pub async fn ai_key_test(app: AppHandle, provider: String, api_key: String, organization_id: Option<String>, project_ref: Option<String>) -> AppResult<Validation> {
    let p = provider::Provider::parse(&provider).ok_or_else(|| AppError::Invalid("Choose a provider.".into()))?;
    let key = api_key.trim().to_string();
    if key.is_empty() && p.needs_key() {
        return Err(AppError::Invalid("Enter an API key.".into()));
    }
    let endpoint = provider::Endpoint { base_url: None, organization_id, project_ref };
    blocking(&app, move |s| router::test_unsaved(s, &s.ai, p, vault::Secret::new(key), &endpoint)).await
}

#[tauri::command]
pub fn ai_account_update(state: State<AppState>, id: String, patch: AccountPatch) -> AppResult<Account> {
    state.with(|c| accounts::update(c, &id, &patch))
}

#[tauri::command]
pub async fn ai_account_replace_key(app: AppHandle, id: String, api_key: String) -> AppResult<Account> {
    blocking(&app, move |s| s.with(|c| accounts::replace_key(c, s.ai.vault.as_ref(), &id, &api_key))).await
}

#[tauri::command]
pub async fn ai_account_delete(app: AppHandle, id: String) -> AppResult<()> {
    blocking(&app, move |s| s.with(|c| accounts::delete(c, s.ai.vault.as_ref(), &id))).await
}

#[tauri::command]
pub fn ai_accounts_reorder(state: State<AppState>, ids: Vec<String>) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        accounts::reorder(&tx, &ids)?;
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub async fn ai_account_test(app: AppHandle, id: String) -> AppResult<Validation> {
    blocking(&app, move |s| router::test_connection(s, &s.ai, &id)).await
}

/// Runs a text request through the router. Account switches are also
/// emitted as `kern://ai-switch` so the UI can say so quietly.
#[tauri::command]
pub async fn ai_request(app: AppHandle, request: RouteRequest) -> AppResult<RouteOutcome> {
    let handle = app.clone();
    let outcome = blocking(&app, move |s| router::route(s, &s.ai, &request)).await?;
    for sw in &outcome.switches {
        let _ = handle.emit("kern://ai-switch", sw);
    }
    Ok(outcome)
}

#[tauri::command]
pub fn ai_request_cancel(state: State<AppState>, request_id: String) {
    state.ai.cancel(&request_id);
}

#[tauri::command]
pub fn ai_usage(state: State<AppState>, since: i64, tz_offset_minutes: i64) -> AppResult<UsageSummary> {
    state.with(|c| usage_summary(c, since, tz_offset_minutes))
}

#[tauri::command]
pub fn ai_history_clear(state: State<AppState>) -> AppResult<()> {
    state.with(|c| {
        c.execute_batch("DELETE FROM ai_usage_events; DELETE FROM ai_failover_events;")?;
        Ok(())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityReport {
    pub store: String,
    pub accounts: usize,
    /// Accounts whose key is present in this device's credential store.
    pub keys_present: usize,
    pub missing: Vec<String>,
}

/// Checks each account's key is in the credential store (without exposing it).
#[tauri::command]
pub async fn ai_security_check(app: AppHandle) -> AppResult<SecurityReport> {
    blocking(&app, |s| {
        let list = s.with(|c| accounts::list(c))?;
        // Only accounts that have a key are counted: one on the local
        // `claude` command has none to hold, and reporting it as missing
        // would say something is wrong when nothing is.
        let keyed: Vec<&Account> = list.iter().filter(|a| a.provider.needs_key()).collect();
        let mut missing = vec![];
        for a in &keyed {
            if s.ai.vault.get(&a.credential_ref())?.is_none() {
                missing.push(a.name.clone());
            }
        }
        Ok(SecurityReport {
            store: if cfg!(windows) { "Windows Credential Manager" } else if cfg!(target_os = "macos") { "macOS Keychain" } else { "Secret Service" }.into(),
            accounts: keyed.len(),
            keys_present: keyed.len() - missing.len(),
            missing,
        })
    })
    .await
}

// ------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::provider::{HttpRequest, HttpResponse, Transport, TransportError};
    use super::router::Db;
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Arc, Mutex};

    struct TestDb(Mutex<Connection>);
    impl Db for TestDb {
        fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
            f(&self.0.lock().unwrap())
        }
    }

    type Reply = Result<HttpResponse, TransportError>;

    /// Scripted replies per API key; records every request it saw.
    #[derive(Default, Clone)]
    struct Mock {
        replies: Arc<Mutex<HashMap<String, VecDeque<Reply>>>>,
        seen: Arc<Mutex<Vec<String>>>,
        /// Every request body, in order, so a tool loop can be checked for
        /// what it actually sent back.
        bodies: Arc<Mutex<Vec<serde_json::Value>>>,
    }
    impl Mock {
        fn on(&self, key: &str, r: Reply) {
            self.replies.lock().unwrap().entry(key.into()).or_default().push_back(r);
        }
    }
    impl Transport for Mock {
        fn send(&self, req: &HttpRequest) -> Reply {
            let key = req
                .headers
                .iter()
                .find(|(k, _)| k == "x-api-key" || k == "authorization")
                .map(|(_, v)| v.trim_start_matches("Bearer ").to_string())
                .unwrap_or_default();
            self.seen.lock().unwrap().push(key.clone());
            if let Some(body) = req.body.as_deref().and_then(|b| serde_json::from_str(b).ok()) {
                self.bodies.lock().unwrap().push(body);
            }
            self.replies.lock().unwrap().get_mut(&key).and_then(|q| q.pop_front()).unwrap_or_else(|| Err(TransportError::NotSent("no script".into())))
        }
    }

    fn ok(org: &str) -> Reply {
        Ok(HttpResponse {
            status: 200,
            headers: [("anthropic-organization-id".to_string(), org.to_string())].into_iter().collect(),
            body: r#"{"model":"claude-opus-5-5","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn","usage":{"input_tokens":12,"output_tokens":4}}"#.into(),
        })
    }
    fn err(status: u16, kind: &str, headers: &[(&str, &str)]) -> Reply {
        Ok(HttpResponse {
            status,
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body: format!(r#"{{"type":"error","error":{{"type":"{kind}","message":"x"}}}}"#),
        })
    }

    /// A tool that always works, and remembers what it was asked.
    #[derive(Default, Clone)]
    struct FakeTools {
        ran: Arc<Mutex<Vec<String>>>,
        fail: bool,
    }

    impl router::ToolRunner for FakeTools {
        fn list(&self) -> Vec<router::ToolSpec> {
            vec![router::ToolSpec {
                name: "files__read".into(),
                description: "Read a file.".into(),
                schema: serde_json::json!({ "type": "object" }),
            }]
        }
        fn call(&self, name: &str, arguments: &serde_json::Value) -> router::ToolRun {
            self.ran.lock().unwrap().push(format!("{name}({arguments})"));
            if self.fail {
                router::ToolRun::failed(name, "no such file")
            } else {
                router::ToolRun::done(name, "the file said hello")
            }
        }
    }

    struct Setup {
        db: TestDb,
        svc: AiService,
        mock: Mock,
        vault: Arc<vault::MemoryStore>,
    }

    struct SharedVault(Arc<vault::MemoryStore>);
    impl vault::SecretStore for SharedVault {
        fn set(&self, r: &str, s: &vault::Secret) -> AppResult<()> {
            self.0.set(r, s)
        }
        fn get(&self, r: &str) -> AppResult<Option<vault::Secret>> {
            self.0.get(r)
        }
        fn delete(&self, r: &str) -> AppResult<()> {
            self.0.delete(r)
        }
    }

    fn setup(mode: &str) -> Setup {
        let conn = crate::db::open_memory();
        crate::domain::settings::set(&conn, "ai.routingMode", &serde_json::json!(mode)).unwrap();
        let mock = Mock::default();
        let vault = Arc::new(vault::MemoryStore::default());
        let mut svc = AiService::new(Box::new(SharedVault(vault.clone())), Box::new(mock.clone()));
        svc.sleep = Box::new(|_| {});
        Setup { db: TestDb(Mutex::new(conn)), svc, mock, vault }
    }

    fn add(s: &Setup, name: &str, key: &str, org: Option<&str>) -> Account {
        s.db.with_conn(|c| {
            let a = accounts::create(c, s.svc.vault.as_ref(), &NewAccount { provider: "anthropic".into(), name: name.into(), api_key: key.into(), organization_id: org.map(String::from), ..Default::default() })?;
            Ok(a)
        })
        .unwrap()
    }

    fn req(id: &str) -> RouteRequest {
        RouteRequest { request_id: id.into(), prompt: "Say done".into(), ..Default::default() }
    }

    const K1: &str = "sk-ant-primary-0000000000000001";
    const K2: &str = "sk-ant-second-0000000000000002";
    const K3: &str = "sk-ant-third-00000000000000003";

    /// An assistant reply asking for one tool to be run.
    fn wants_tool(id: &str) -> Reply {
        Ok(HttpResponse {
            status: 200,
            headers: Default::default(),
            body: format!(
                r#"{{"model":"claude-opus-5-5","stop_reason":"tool_use","content":[
                     {{"type":"text","text":"Let me look."}},
                     {{"type":"tool_use","id":"{id}","name":"files__read","input":{{"path":"a.txt"}}}}],
                   "usage":{{"input_tokens":10,"output_tokens":5}}}}"#
            ),
        })
    }

    fn with_tools(s: &mut Setup, fail: bool) -> FakeTools {
        let tools = FakeTools { ran: Default::default(), fail };
        s.svc.attach_tools(Box::new(tools.clone()));
        tools
    }

    fn using_tools(id: &str) -> RouteRequest {
        RouteRequest { use_tools: Some(true), ..req(id) }
    }

    #[test]
    fn a_tool_is_run_and_the_answer_comes_from_the_round_after() {
        let mut s = setup("failover");
        let tools = with_tools(&mut s, false);
        add(&s, "Personal", K1, None);
        s.mock.on(K1, wants_tool("tu_1"));
        s.mock.on(K1, ok("org-a"));
        let out = router::route(&s.db, &s.svc, &using_tools("r")).unwrap();
        assert!(out.ok);
        assert_eq!(out.text.as_deref(), Some("done"), "the answer is the last round's, not the first's");
        assert_eq!(out.tool_runs.len(), 1);
        assert_eq!((out.tool_runs[0].name.as_str(), out.tool_runs[0].ok), ("files__read", true));
        assert_eq!(tools.ran.lock().unwrap().len(), 1);
        assert!(tools.ran.lock().unwrap()[0].contains("a.txt"), "the model's arguments reach the tool");
        // Two requests, both to the same account, and the second one carries
        // the reply and the result back.
        assert_eq!(s.mock.seen.lock().unwrap().len(), 2);
        let bodies = s.mock.bodies.lock().unwrap();
        assert_eq!(bodies[0]["tools"][0]["name"], "files__read");
        let second = bodies[1]["messages"].as_array().unwrap();
        assert_eq!(second.len(), 3);
        assert_eq!(second[1]["content"][1]["id"], "tu_1");
        assert_eq!(second[2]["content"][0]["content"], "the file said hello");
        // Each round is a request of its own, so each is billed and recorded.
        let events: i64 = s.db.with_conn(|c| Ok(c.query_row("SELECT count(*) FROM ai_usage_events", [], |r| r.get(0))?)).unwrap();
        assert_eq!(events, 2);
    }

    #[test]
    fn nothing_is_offered_unless_the_request_asks_for_tools() {
        let mut s = setup("failover");
        let tools = with_tools(&mut s, false);
        add(&s, "Personal", K1, None);
        s.mock.on(K1, ok("org-a"));
        let out = router::route(&s.db, &s.svc, &req("r")).unwrap();
        assert!(out.ok && out.tool_runs.is_empty());
        assert!(tools.ran.lock().unwrap().is_empty());
        assert!(s.mock.bodies.lock().unwrap()[0].get("tools").is_none(), "no tools key at all");
    }

    #[test]
    fn a_tool_that_went_wrong_is_reported_to_the_model_rather_than_failing_the_request() {
        let mut s = setup("failover");
        with_tools(&mut s, true);
        add(&s, "Personal", K1, None);
        s.mock.on(K1, wants_tool("tu_1"));
        s.mock.on(K1, ok("org-a"));
        let out = router::route(&s.db, &s.svc, &using_tools("r")).unwrap();
        assert!(out.ok, "the request still succeeds: the model is told and answers anyway");
        assert!(!out.tool_runs[0].ok);
        let bodies = s.mock.bodies.lock().unwrap();
        assert_eq!(bodies[1]["messages"][2]["content"][0]["is_error"], true);
    }

    #[test]
    fn a_model_going_round_in_circles_is_stopped() {
        let mut s = setup("failover");
        with_tools(&mut s, false);
        add(&s, "Personal", K1, None);
        s.db.with_conn(|c| crate::domain::settings::set(c, "ai.maxToolRounds", &serde_json::json!(2))).unwrap();
        for i in 0..4 {
            s.mock.on(K1, wants_tool(&format!("tu_{i}")));
        }
        let out = router::route(&s.db, &s.svc, &using_tools("r")).unwrap();
        assert!(out.ok, "it answers with the text it had rather than erroring");
        assert_eq!(out.tool_runs.len(), 2, "two rounds, as set");
        assert_eq!(out.text.as_deref(), Some("Let me look."));
        assert!(out.warnings.iter().any(|w| w.contains("2 rounds")));
        // The attempt budget is for failures: three good requests must not
        // trip "stopped after 3 attempts".
        assert_eq!(s.mock.seen.lock().unwrap().len(), 3);
        assert!(out.error.is_none());
    }

    #[test]
    fn once_a_tool_has_run_the_request_is_not_handed_to_another_account() {
        let mut s = setup("failover");
        with_tools(&mut s, false);
        add(&s, "Personal", K1, None);
        add(&s, "Secondary", K2, None);
        s.mock.on(K1, wants_tool("tu_1"));
        // The round after the tool ran fails with something that would
        // normally fail over.
        s.mock.on(K1, err(402, "billing_error", &[]));
        s.mock.on(K2, ok("org-b"));
        let out = router::route(&s.db, &s.svc, &using_tools("r")).unwrap();
        assert!(!out.ok);
        assert!(out.switches.is_empty(), "failing over would run that tool a second time");
        assert!(!s.mock.seen.lock().unwrap().contains(&K2.to_string()));
        assert!(out.error.unwrap().message.contains("can't be retried automatically"));
    }

    #[test]
    fn a_provider_that_brings_its_own_tools_is_not_given_kerns() {
        let mut s = setup("failover");
        with_tools(&mut s, false);
        let cli = s
            .db
            .with_conn(|c| {
                accounts::create(
                    c,
                    s.svc.vault.as_ref(),
                    &NewAccount { provider: "claude-cli".into(), name: "Subscription".into(), ..Default::default() },
                )
            })
            .unwrap();
        assert!(cli.key_hint.is_none(), "there is no key to hint at");
        assert_eq!(s.vault.len(), 0, "and nothing went into the credential store");
        // The CLI transport isn't in play here; the mock answers whatever is
        // sent, keyed on an empty key because there is no key header.
        s.mock.on("", ok("none"));
        let out = router::route(&s.db, &s.svc, &using_tools("r")).unwrap();
        assert!(out.ok);
        assert!(s.mock.bodies.lock().unwrap()[0].get("tools").is_none());
        assert!(out.warnings.iter().any(|w| w.contains("runs its own tools")));
        // A subscription has no per-token cost, so none is invented.
        let cost: Option<f64> =
            s.db.with_conn(|c| Ok(c.query_row("SELECT estimated_cost FROM ai_usage_events", [], |r| r.get(0))?)).unwrap();
        assert_eq!(cost, None);
    }

    #[test]
    fn fails_over_on_confirmed_quota_error() {
        let s = setup("failover");
        let a = add(&s, "Personal", K1, Some("org-a"));
        add(&s, "Secondary", K2, Some("org-b"));
        s.mock.on(K1, err(402, "billing_error", &[]));
        s.mock.on(K2, ok("org-b"));
        let out = router::route(&s.db, &s.svc, &req("r1")).unwrap();
        assert!(out.ok);
        assert_eq!(out.account_name.as_deref(), Some("Secondary"));
        assert_eq!(out.switches.len(), 1);
        assert_eq!(out.switches[0].reason, "Out of credit");
        let a = s.db.with_conn(|c| accounts::get(c, &a.id)).unwrap();
        assert_eq!(a.status, "quota_reached");
        let events: i64 = s.db.with_conn(|c| Ok(c.query_row("SELECT count(*) FROM ai_failover_events", [], |r| r.get(0))?)).unwrap();
        assert_eq!(events, 1);
        // The account sits out: the next request goes straight to Secondary.
        s.mock.on(K2, ok("org-b"));
        let out = router::route(&s.db, &s.svc, &req("r2")).unwrap();
        assert_eq!((out.account_name.as_deref(), out.attempts.len()), (Some("Secondary"), 1));
    }

    #[test]
    fn never_rotates_within_the_same_quota_pool() {
        let s = setup("failover");
        add(&s, "Personal", K1, Some("org-a"));
        add(&s, "Same org", K2, Some("org-a"));
        add(&s, "Other org", K3, Some("org-c"));
        s.mock.on(K1, err(429, "rate_limit_error", &[("retry-after", "300")]));
        s.mock.on(K3, ok("org-c"));
        let out = router::route(&s.db, &s.svc, &req("r")).unwrap();
        assert_eq!(out.account_name.as_deref(), Some("Other org"));
        assert!(!s.mock.seen.lock().unwrap().contains(&K2.to_string()), "a key sharing the limited pool must not be tried");
        assert!(out.warnings.iter().any(|w| w.contains("Same org")));
    }

    #[test]
    fn short_rate_limits_wait_and_retry_the_same_account() {
        let s = setup("failover");
        add(&s, "Personal", K1, None);
        add(&s, "Secondary", K2, None);
        s.mock.on(K1, err(429, "rate_limit_error", &[("retry-after", "2")]));
        s.mock.on(K1, ok("org-a"));
        let out = router::route(&s.db, &s.svc, &req("r")).unwrap();
        assert!(out.ok);
        assert_eq!(out.account_name.as_deref(), Some("Personal"));
        assert!(out.switches.is_empty());
        assert_eq!(out.attempts.len(), 2);
    }

    #[test]
    fn manual_mode_never_switches() {
        let s = setup("manual");
        add(&s, "Personal", K1, None);
        add(&s, "Secondary", K2, None);
        s.mock.on(K1, err(402, "billing_error", &[]));
        let out = router::route(&s.db, &s.svc, &req("r")).unwrap();
        assert!(!out.ok);
        assert!(out.switches.is_empty());
        assert!(!s.mock.seen.lock().unwrap().contains(&K2.to_string()));
    }

    #[test]
    fn invalid_keys_are_reported_and_may_fail_over() {
        let s = setup("failover");
        let a = add(&s, "Personal", K1, Some("org-a"));
        add(&s, "Secondary", K2, Some("org-a"));
        s.mock.on(K1, err(401, "authentication_error", &[]));
        s.mock.on(K2, ok("org-a"));
        let out = router::route(&s.db, &s.svc, &req("r")).unwrap();
        // A bad key is per-key, so another key in the same organisation is fine.
        assert_eq!(out.account_name.as_deref(), Some("Secondary"));
        assert_eq!(out.attempts[0].category, Some(provider::ErrorCategory::InvalidKey));
        assert_eq!(s.db.with_conn(|c| accounts::get(c, &a.id)).unwrap().status, "auth_error");
    }

    #[test]
    fn network_failures_dont_mark_accounts_or_switch() {
        let s = setup("failover");
        let a = add(&s, "Personal", K1, None);
        add(&s, "Secondary", K2, None);
        s.mock.on(K1, Err(TransportError::NotSent("offline".into())));
        let out = router::route(&s.db, &s.svc, &req("r")).unwrap();
        assert!(!out.ok && out.switches.is_empty());
        assert_eq!(s.db.with_conn(|c| accounts::get(c, &a.id)).unwrap().status, "unknown");
    }

    #[test]
    fn ambiguous_failures_are_never_replayed() {
        let s = setup("failover");
        add(&s, "Personal", K1, None);
        add(&s, "Secondary", K2, None);
        s.mock.on(K1, Err(TransportError::Ambiguous("read timeout".into())));
        let out = router::route(&s.db, &s.svc, &req("r")).unwrap();
        assert!(!out.ok);
        assert_eq!(s.mock.seen.lock().unwrap().len(), 1, "a request that may have been processed is not resent");
        assert!(!out.error.unwrap().replay_safe);
    }

    #[test]
    fn non_replayable_requests_dont_fail_over() {
        let s = setup("failover");
        add(&s, "Personal", K1, None);
        add(&s, "Secondary", K2, None);
        s.mock.on(K1, err(402, "billing_error", &[]));
        let mut r = req("r");
        r.replayable = Some(false);
        let out = router::route(&s.db, &s.svc, &r).unwrap();
        assert!(!out.ok && s.mock.seen.lock().unwrap().len() == 1);
    }

    #[test]
    fn attempts_are_bounded() {
        let s = setup("priority");
        for (i, k) in [K1, K2, K3].iter().enumerate() {
            add(&s, &format!("A{i}"), k, None);
            s.mock.on(k, err(401, "authentication_error", &[]));
        }
        s.db.with_conn(|c| crate::domain::settings::set(c, "ai.maxAttempts", &serde_json::json!(2))).unwrap();
        let out = router::route(&s.db, &s.svc, &req("r")).unwrap();
        assert!(!out.ok);
        assert_eq!(s.mock.seen.lock().unwrap().len(), 2);
    }

    #[test]
    fn hard_budget_excludes_an_account() {
        let s = setup("failover");
        let a = add(&s, "Personal", K1, None);
        add(&s, "Secondary", K2, None);
        s.db.with_conn(|c| {
            accounts::update(c, &a.id, &AccountPatch { budget_limit: Some(Some(10.0)), budget_unit: Some("tokens".into()), budget_hard: Some(true), ..Default::default() })?;
            c.execute("INSERT INTO ai_usage_events(request_id, account_id, provider, started_at, input_tokens, output_tokens, success) VALUES ('x', ?1, 'anthropic', ?2, 8, 8, 1)", params![a.id, now_ms()])?;
            Ok(())
        })
        .unwrap();
        s.mock.on(K2, ok("o"));
        let out = router::route(&s.db, &s.svc, &req("r")).unwrap();
        assert_eq!(out.account_name.as_deref(), Some("Secondary"));
    }

    #[test]
    fn connection_test_uses_the_models_endpoint() {
        let s = setup("failover");
        let a = add(&s, "Personal", K1, None);
        s.mock.on(K1, Ok(HttpResponse { status: 200, headers: Default::default(), body: r#"{"data":[{"id":"claude-opus-5-5"},{"id":"claude-sonnet-5-5"}]}"#.into() }));
        let v = router::test_connection(&s.db, &s.svc, &a.id).unwrap();
        assert_eq!(v.outcome, "authenticated");
        assert_eq!(v.models.len(), 2);
        s.mock.on(K1, err(401, "authentication_error", &[]));
        assert_eq!(router::test_connection(&s.db, &s.svc, &a.id).unwrap().outcome, "auth_failed");
    }

    /// Security: secrets never reach SQLite (any table, any column), and
    /// removing an account removes its key from the credential store.
    #[test]
    fn secrets_never_reach_the_database() {
        let s = setup("failover");
        let a = add(&s, "Personal", K1, Some("org-a"));
        add(&s, "Secondary", K2, None);
        s.mock.on(K1, err(401, "authentication_error", &[]));
        s.mock.on(K2, ok("o"));
        router::route(&s.db, &s.svc, &req("r")).unwrap();
        let dump: String = s
            .db
            .with_conn(|c| {
                let tables: Vec<String> = c.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
                let mut out = String::new();
                for t in tables {
                    let mut stmt = c.prepare(&format!("SELECT * FROM \"{t}\""))?;
                    let n = stmt.column_count();
                    let mut rows = stmt.query([])?;
                    while let Some(row) = rows.next()? {
                        for i in 0..n {
                            if let Ok(v) = row.get::<_, rusqlite::types::Value>(i) {
                                out.push_str(&format!("{v:?}|"));
                            }
                        }
                    }
                }
                Ok(out)
            })
            .unwrap();
        for k in [K1, K2] {
            assert!(!dump.contains(&k[..20]), "API key material found in SQLite");
        }
        assert_eq!(s.vault.len(), 2);
        s.db.with_conn(|c| accounts::delete(c, s.svc.vault.as_ref(), &a.id)).unwrap();
        assert_eq!(s.vault.len(), 1);
        // A removed account can't be selected again.
        s.mock.on(K2, ok("o"));
        let out = router::route(&s.db, &s.svc, &RouteRequest { account_id: Some(a.id.clone()), ..req("r2") }).unwrap();
        assert_eq!(out.account_name.as_deref(), Some("Secondary"));
    }
}
