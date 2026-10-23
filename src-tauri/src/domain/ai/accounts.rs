// @Author Christian Relf
// @Date 2026-10-12

//! AI API account profiles: non-sensitive metadata in SQLite, keys in the
//! OS credential store (see vault.rs). "Account" here usually means an API
//! credential profile.
//!
//! The exception is `Provider::ClaudeCli`, which is the `claude` command on
//! this computer and is signed in as somebody already. Such an account has
//! no key, nothing in the credential store and no key hint — it is a profile
//! saying "use the CLI", with the same routing, budget and status machinery
//! around it as any other.

use super::provider::{ErrorCategory, Provider};
use super::vault::{Secret, SecretStore};
use crate::error::{invalid, AppError, AppResult};
use crate::util::{new_id, now_ms, some};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonthUsage {
    pub requests: i64,
    pub tokens: i64,
    /// Only for models with a configured price.
    pub cost: Option<f64>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: Provider,
    pub name: String,
    /// Last four characters of the key, to tell keys apart.
    pub key_hint: Option<String>,
    pub enabled: bool,
    pub priority: f64,
    /// primary | fallback | none
    pub role: String,
    pub failover_eligible: bool,
    pub preferred_model: Option<String>,
    /// Models the key could see at its last connection test.
    pub models: Vec<String>,
    pub organization_id: Option<String>,
    pub project_ref: Option<String>,
    /// Organisation reported by the provider (shared quota pool).
    pub observed_pool: Option<String>,
    pub budget_limit: Option<f64>,
    pub budget_unit: Option<String>,
    pub budget_warn_percent: i64,
    pub budget_hard: bool,
    /// Effective status: ready | rate_limited | quota_reached | auth_error |
    /// permission_error | unavailable | disabled | unknown
    pub status: String,
    pub status_detail: Option<String>,
    pub cooldown_until: Option<i64>,
    pub rate_limits: Value,
    pub last_checked_at: Option<i64>,
    pub last_used_at: Option<i64>,
    pub created_at: i64,
    pub month: MonthUsage,
}

impl Account {
    /// The quota pool this key belongs to, when known.
    pub fn pool(&self) -> Option<String> {
        self.organization_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| self.observed_pool.clone())
            .map(|p| format!("{}:{}", self.provider.as_str(), p))
    }

    pub fn cooling_down(&self, now: i64) -> bool {
        self.cooldown_until.is_some_and(|t| t > now)
    }

    pub fn credential_ref(&self) -> String {
        credential_ref(&self.id)
    }
}

pub fn credential_ref(id: &str) -> String {
    format!("ai-account:{id}")
}

const SELECT: &str = "SELECT id, provider, name, key_hint, enabled, priority, role, failover_eligible, preferred_model, models,
  organization_id, project_ref, observed_pool, budget_limit, budget_unit, budget_warn_percent, budget_hard, status, status_detail,
  cooldown_until, rate_limits, last_checked_at, last_used_at, created_at FROM ai_accounts";

/// Start of the current local month (epoch ms), for budgets.
pub fn month_start() -> i64 {
    use chrono::{Datelike, Local, TimeZone};
    let now = Local::now();
    Local.with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0).single().map(|d| d.timestamp_millis()).unwrap_or(0)
}

fn map(r: &Row, now: i64) -> rusqlite::Result<Account> {
    let enabled = r.get::<_, i64>(4)? != 0;
    let stored: String = r.get(17)?;
    let cooldown: Option<i64> = r.get(19)?;
    // Temporary states lapse when their cooldown ends.
    let status = if !enabled {
        "disabled".to_string()
    } else if matches!(stored.as_str(), "rate_limited" | "unavailable") && cooldown.map_or(true, |c| c <= now) {
        "ready".to_string()
    } else {
        stored
    };
    let provider: String = r.get(1)?;
    Ok(Account {
        id: r.get(0)?,
        provider: Provider::parse(&provider).unwrap_or(Provider::Anthropic),
        name: r.get(2)?,
        key_hint: r.get(3)?,
        enabled,
        priority: r.get(5)?,
        role: r.get(6)?,
        failover_eligible: r.get::<_, i64>(7)? != 0,
        preferred_model: r.get(8)?,
        models: r.get::<_, Option<String>>(9)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
        organization_id: r.get(10)?,
        project_ref: r.get(11)?,
        observed_pool: r.get(12)?,
        budget_limit: r.get(13)?,
        budget_unit: r.get(14)?,
        budget_warn_percent: r.get(15)?,
        budget_hard: r.get::<_, i64>(16)? != 0,
        status,
        status_detail: r.get(18)?,
        cooldown_until: cooldown.filter(|c| *c > now),
        rate_limits: r.get::<_, Option<String>>(20)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null),
        last_checked_at: r.get(21)?,
        last_used_at: r.get(22)?,
        created_at: r.get(23)?,
        month: MonthUsage { requests: 0, tokens: 0, cost: None },
    })
}

fn with_month(conn: &Connection, mut a: Account) -> AppResult<Account> {
    a.month = conn.query_row(
        "SELECT count(*), coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0), sum(estimated_cost)
         FROM ai_usage_events WHERE account_id = ?1 AND started_at >= ?2 AND purpose != 'validation'",
        params![a.id, month_start()],
        |r| Ok(MonthUsage { requests: r.get(0)?, tokens: r.get(1)?, cost: r.get(2)? }),
    )?;
    Ok(a)
}

pub fn list(conn: &Connection) -> AppResult<Vec<Account>> {
    let now = now_ms();
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY priority, created_at"))?;
    let rows = stmt.query_map([], |r| map(r, now))?.collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(|a| with_month(conn, a)).collect()
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Account> {
    let now = now_ms();
    let a = conn
        .query_row(&format!("{SELECT} WHERE id = ?1"), [id], |r| map(r, now))
        .optional()?
        .ok_or_else(|| AppError::NotFound("AI account".into()))?;
    with_month(conn, a)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewAccount {
    pub provider: String,
    pub name: String,
    /// Write-only: goes straight to the credential store.
    pub api_key: String,
    pub organization_id: Option<String>,
    pub project_ref: Option<String>,
    pub preferred_model: Option<String>,
}

fn clean_key(key: &str) -> AppResult<Secret> {
    let k = key.trim();
    if k.is_empty() {
        return invalid("Enter an API key.");
    }
    if k.chars().any(|c| c.is_whitespace() || c.is_control()) || k.len() > 512 {
        return invalid("That doesn't look like an API key (it contains spaces or is too long).");
    }
    Ok(Secret::new(k.to_string()))
}

fn opt(s: &Option<String>) -> Option<String> {
    s.as_ref().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

pub fn create(conn: &Connection, vault: &dyn SecretStore, input: &NewAccount) -> AppResult<Account> {
    let provider = Provider::parse(&input.provider).ok_or_else(|| AppError::Invalid("Choose a provider.".into()))?;
    let name = input.name.trim();
    if name.is_empty() {
        return invalid("Give the account a name.");
    }
    let id = new_id();
    // A provider with no key has nothing to put in the credential store.
    // Otherwise the secret goes in first: if the store refuses, nothing is
    // saved, so there is never a profile without its key.
    let key = if provider.needs_key() {
        let key = clean_key(&input.api_key)?;
        vault.set(&credential_ref(&id), &key)?;
        Some(key)
    } else {
        None
    };
    let now = now_ms();
    let insert = (|| -> AppResult<()> {
        let priority: f64 = conn.query_row("SELECT coalesce(max(priority), 0) + 1 FROM ai_accounts", [], |r| r.get(0))?;
        let has_primary: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM ai_accounts WHERE role = 'primary')", [], |r| r.get(0))?;
        conn.execute(
            "INSERT INTO ai_accounts(id, provider, name, credential_ref, key_hint, priority, role, preferred_model, organization_id,
               project_ref, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'unknown', ?11, ?11)",
            params![
                id,
                provider.as_str(),
                name,
                credential_ref(&id),
                key.as_ref().map(|k| k.hint()).filter(|h| !h.is_empty()),
                priority,
                if has_primary { "none" } else { "primary" },
                opt(&input.preferred_model),
                opt(&input.organization_id),
                opt(&input.project_ref),
                now
            ],
        )?;
        Ok(())
    })();
    if let Err(e) = insert {
        let _ = vault.delete(&credential_ref(&id));
        return Err(e);
    }
    get(conn, &id)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AccountPatch {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub role: Option<String>,
    pub failover_eligible: Option<bool>,
    #[serde(deserialize_with = "some")]
    pub preferred_model: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub organization_id: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub project_ref: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub budget_limit: Option<Option<f64>>,
    pub budget_unit: Option<String>,
    pub budget_warn_percent: Option<i64>,
    pub budget_hard: Option<bool>,
}

pub fn update(conn: &Connection, id: &str, p: &AccountPatch) -> AppResult<Account> {
    get(conn, id)?;
    let now = now_ms();
    let set = |col: &str, v: &dyn rusqlite::ToSql| -> AppResult<()> {
        conn.execute(&format!("UPDATE ai_accounts SET {col} = ?1, updated_at = ?2 WHERE id = ?3"), params![v, now, id])?;
        Ok(())
    };
    if let Some(n) = &p.name {
        if n.trim().is_empty() {
            return invalid("Give the account a name.");
        }
        set("name", &n.trim())?;
    }
    if let Some(v) = p.enabled {
        set("enabled", &(v as i64))?;
    }
    if let Some(r) = &p.role {
        match r.as_str() {
            "primary" => {
                conn.execute("UPDATE ai_accounts SET role = 'none' WHERE role = 'primary'", [])?;
                set("role", &"primary")?;
            }
            "fallback" | "none" => set("role", r)?,
            _ => return invalid("Unknown role."),
        }
    }
    if let Some(v) = p.failover_eligible {
        set("failover_eligible", &(v as i64))?;
    }
    if let Some(v) = &p.preferred_model {
        set("preferred_model", &v.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()))?;
    }
    if let Some(v) = &p.organization_id {
        set("organization_id", &v.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()))?;
    }
    if let Some(v) = &p.project_ref {
        set("project_ref", &v.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()))?;
    }
    if let Some(v) = p.budget_limit {
        if v.is_some_and(|x| !(x > 0.0)) {
            return invalid("A budget must be more than zero.");
        }
        set("budget_limit", &v)?;
    }
    if let Some(u) = &p.budget_unit {
        if u != "tokens" && u != "usd" {
            return invalid("Budgets are in tokens or USD.");
        }
        set("budget_unit", u)?;
    }
    if let Some(v) = p.budget_warn_percent {
        set("budget_warn_percent", &v.clamp(1, 100))?;
    }
    if let Some(v) = p.budget_hard {
        set("budget_hard", &(v as i64))?;
    }
    get(conn, id)
}

/// Replaces the stored key. Status resets: the new key is untested.
pub fn replace_key(conn: &Connection, vault: &dyn SecretStore, id: &str, key: &str) -> AppResult<Account> {
    let a = get(conn, id)?;
    if !a.provider.needs_key() {
        return invalid("This account uses the claude command on this computer, which signs in by itself. There is no key to change.");
    }
    let key = clean_key(key)?;
    vault.set(&a.credential_ref(), &key)?;
    conn.execute(
        "UPDATE ai_accounts SET key_hint = ?1, status = 'unknown', status_detail = NULL, cooldown_until = NULL, observed_pool = NULL,
           updated_at = ?2 WHERE id = ?3",
        params![Some(key.hint()).filter(|h| !h.is_empty()), now_ms(), id],
    )?;
    get(conn, id)
}

/// Removes the key from the credential store and the profile from Kern.
/// Usage history keeps its anonymous rows (the account name is gone).
pub fn delete(conn: &Connection, vault: &dyn SecretStore, id: &str) -> AppResult<()> {
    let a = get(conn, id)?;
    vault.delete(&a.credential_ref())?;
    conn.execute("DELETE FROM ai_accounts WHERE id = ?1", [id])?;
    if a.role == "primary" {
        conn.execute(
            "UPDATE ai_accounts SET role = 'primary' WHERE id = (SELECT id FROM ai_accounts WHERE enabled = 1 ORDER BY priority LIMIT 1)",
            [],
        )?;
    }
    Ok(())
}

pub fn reorder(conn: &Connection, ids: &[String]) -> AppResult<()> {
    for (i, id) in ids.iter().enumerate() {
        conn.execute("UPDATE ai_accounts SET priority = ?1 WHERE id = ?2", params![(i + 1) as f64, id])?;
    }
    Ok(())
}

/// Status after a provider failure, and how long the account sits out.
pub fn status_for(category: ErrorCategory, retry_after: Option<f64>) -> Option<(&'static str, Option<i64>)> {
    let now = now_ms();
    let later = |secs: f64| Some(now + (secs * 1000.0) as i64);
    match category {
        ErrorCategory::RateLimited => Some(("rate_limited", later(retry_after.unwrap_or(60.0).max(1.0)))),
        // Billing problems don't fix themselves quickly; don't keep sending doomed requests.
        ErrorCategory::InsufficientQuota | ErrorCategory::SpendLimit => Some(("quota_reached", later(retry_after.unwrap_or(3600.0).max(60.0)))),
        ErrorCategory::InvalidKey => Some(("auth_error", None)),
        ErrorCategory::Permission => Some(("permission_error", later(600.0))),
        ErrorCategory::Overloaded => Some(("unavailable", later(retry_after.unwrap_or(30.0).max(5.0)))),
        // Network trouble, timeouts and bad requests say nothing about the account.
        _ => None,
    }
}

pub fn record_failure(conn: &Connection, id: &str, category: ErrorCategory, detail: &str, retry_after: Option<f64>) -> AppResult<()> {
    if let Some((status, cooldown)) = status_for(category, retry_after) {
        conn.execute(
            "UPDATE ai_accounts SET status = ?1, status_detail = ?2, cooldown_until = ?3, updated_at = ?4 WHERE id = ?5",
            params![status, detail, cooldown, now_ms(), id],
        )?;
    }
    Ok(())
}

pub fn record_success(conn: &Connection, id: &str, pool: Option<&str>, rate_limits: Option<&Value>, models: Option<&[String]>, checked: bool) -> AppResult<()> {
    let now = now_ms();
    conn.execute(
        "UPDATE ai_accounts SET status = 'ready', status_detail = NULL, cooldown_until = NULL,
           observed_pool = coalesce(?1, observed_pool), rate_limits = coalesce(?2, rate_limits), models = coalesce(?3, models),
           last_checked_at = CASE WHEN ?4 THEN ?5 ELSE last_checked_at END,
           last_used_at = CASE WHEN ?4 THEN last_used_at ELSE ?5 END, updated_at = ?5
         WHERE id = ?6",
        params![
            pool,
            rate_limits.map(|v| v.to_string()),
            models.map(|m| serde_json::to_string(m).unwrap_or_default()),
            checked,
            now,
            id
        ],
    )?;
    Ok(())
}

pub fn record_rate_limits(conn: &Connection, id: &str, rate_limits: &Value) -> AppResult<()> {
    conn.execute("UPDATE ai_accounts SET rate_limits = ?1 WHERE id = ?2", params![rate_limits.to_string(), id])?;
    Ok(())
}
