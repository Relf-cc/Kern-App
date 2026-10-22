// @Author Christian Relf
// @Date 2026-10-22

//! The one place a tool call is allowed or refused.
//!
//! Every tool goes through `guard` before it touches anything, and every tool
//! that names a project goes through `ensure_project`. Keeping both here
//! means the answer to "what can an assistant reach?" is one file, and
//! `cargo test mcp` can check that each registered tool asks.
//!
//! The rules, in order: the feature is on; this client was approved; writing
//! needs the write scope; a project must be inside the client's allowlist and
//! must not be locked behind a passkey.

use crate::domain::{passkeys, settings};
use crate::error::{AppError, AppResult};
use crate::util::now_ms;
use rusqlite::Connection;

use super::audit;
use super::clients::{McpClient, APPROVED};

/// What a tool is about to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

/// Defaults here must match `DEFAULTS` in the settings schema.
pub fn enabled(conn: &Connection) -> bool {
    settings::get_or(conn, "mcp.enabled", false)
}

pub fn max_calls_per_minute(conn: &Connection) -> i64 {
    settings::get_or(conn, "mcp.maxCallsPerMinute", 120)
}

pub fn audit_days(conn: &Connection) -> i64 {
    settings::get_or(conn, "mcp.auditDays", 30)
}

/// May this client make this kind of call at all, right now?
pub fn guard(conn: &Connection, client: &McpClient, access: Access) -> AppResult<()> {
    if !enabled(conn) {
        return Err(AppError::Invalid(
            "Kern's assistant connection is turned off. Turn it on in Kern under Settings → API → Assistants.".into(),
        ));
    }
    if client.status != APPROVED {
        return Err(AppError::Invalid(format!(
            "'{}' hasn't been approved in Kern yet. Approve it under Settings → API → Assistants.",
            client.name
        )));
    }
    if access == Access::Write && !client.may_write() {
        return Err(AppError::Invalid(format!(
            "'{}' has read-only access to Kern. Give it write access under Settings → API → Assistants to make changes.",
            client.name
        )));
    }
    let limit = max_calls_per_minute(conn);
    if limit > 0 && audit::calls_since(conn, &client.id, now_ms() - 60_000) >= limit {
        return Err(AppError::Invalid(format!(
            "That's more than {limit} calls to Kern in a minute. Wait a moment and try again."
        )));
    }
    Ok(())
}

/// Is this project one the client may touch? A locked project is refused the
/// same way it is everywhere else — `ensure_readable` returns `Locked`.
pub fn ensure_project(conn: &Connection, client: &McpClient, project_id: Option<&str>) -> AppResult<()> {
    let Some(id) = project_id else { return Ok(()) };
    if !client.projects.is_empty() && !client.projects.iter().any(|p| p == id) {
        return Err(AppError::NotFound("Project".into()));
    }
    passkeys::ensure_readable(conn, id)
}

/// True when the client may see this project — the quiet form of
/// `ensure_project`, for filtering rows out of a list.
pub fn visible(conn: &Connection, client: &McpClient, project_id: Option<&str>) -> bool {
    ensure_project(conn, client, project_id).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::mcp::clients;
    use serde_json::json;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        settings::set(&c, "mcp.enabled", &json!(true)).unwrap();
        c
    }

    fn approved(c: &Connection, scope: &str) -> McpClient {
        let client = clients::register(c, "Claude Desktop").unwrap();
        clients::set_status(c, &client.id, APPROVED).unwrap();
        clients::set_scope(c, &client.id, scope).unwrap()
    }

    #[test]
    fn nothing_passes_while_the_feature_is_off() {
        let c = db();
        let client = approved(&c, "write");
        settings::set(&c, "mcp.enabled", &json!(false)).unwrap();
        assert!(guard(&c, &client, Access::Read).is_err());
        assert!(guard(&c, &client, Access::Write).is_err());
    }

    #[test]
    fn a_pending_client_reaches_nothing() {
        let c = db();
        let client = clients::register(&c, "Claude Desktop").unwrap();
        assert!(guard(&c, &client, Access::Read).is_err());
    }

    #[test]
    fn read_only_means_read_only() {
        let c = db();
        let client = approved(&c, "read");
        assert!(guard(&c, &client, Access::Read).is_ok());
        assert!(guard(&c, &client, Access::Write).is_err());
    }

    #[test]
    fn a_revoked_client_stops_immediately() {
        let c = db();
        let client = approved(&c, "write");
        let client = clients::set_status(&c, &client.id, clients::REVOKED).unwrap();
        assert!(guard(&c, &client, Access::Read).is_err());
    }

    #[test]
    fn the_allowlist_hides_every_other_project() {
        let c = db();
        let client = approved(&c, "write");
        c.execute(
            "INSERT INTO projects(id, name, description, sort_order, created_at, updated_at)
             VALUES ('p1', 'One', '', 1, 1, 1), ('p2', 'Two', '', 2, 1, 1)",
            [],
        )
        .unwrap();
        assert!(ensure_project(&c, &client, Some("p2")).is_ok());
        let client = clients::set_projects(&c, &client.id, &["p1".into()]).unwrap();
        assert!(ensure_project(&c, &client, Some("p1")).is_ok());
        assert!(ensure_project(&c, &client, Some("p2")).is_err());
        assert!(!visible(&c, &client, Some("p2")));
        // No project at all is always fine: it isn't anybody's.
        assert!(ensure_project(&c, &client, None).is_ok());
    }

    #[test]
    fn the_rate_limit_bites() {
        let c = db();
        let client = approved(&c, "write");
        settings::set(&c, "mcp.maxCallsPerMinute", &json!(2)).unwrap();
        assert!(guard(&c, &client, Access::Read).is_ok());
        audit::record(&c, &client, "kern_search", None, Ok(()));
        audit::record(&c, &client, "kern_search", None, Ok(()));
        assert!(guard(&c, &client, Access::Read).is_err());
    }
}
