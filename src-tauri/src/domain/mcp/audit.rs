// @Author Christian Relf
// @Date 2026-10-22

//! What each assistant did. Every tool call lands here, successful or not,
//! with a short description of its arguments rather than the payload — the
//! point is to be able to see at a glance what an assistant has been doing,
//! not to keep a second copy of your data.

use crate::error::AppResult;
use crate::util::now_ms;
use rusqlite::{params, Connection, Row};
use serde::Serialize;

use super::clients::McpClient;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub client_id: String,
    pub client_name: String,
    pub tool: String,
    pub detail: Option<String>,
    pub ok: bool,
    pub message: Option<String>,
    pub created_at: i64,
}

fn map(r: &Row) -> rusqlite::Result<AuditEntry> {
    Ok(AuditEntry {
        id: r.get(0)?,
        client_id: r.get(1)?,
        client_name: r.get(2)?,
        tool: r.get(3)?,
        detail: r.get(4)?,
        ok: r.get::<_, i64>(5)? != 0,
        message: r.get(6)?,
        created_at: r.get(7)?,
    })
}

/// Trims a description to something a row can show.
fn short(s: &str) -> String {
    let s = s.trim();
    if s.chars().count() <= 160 {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(160).collect::<String>())
    }
}

pub fn record(conn: &Connection, client: &McpClient, tool: &str, detail: Option<&str>, outcome: Result<(), &str>) {
    let (ok, message) = match outcome {
        Ok(()) => (1i64, None),
        Err(e) => (0, Some(short(e))),
    };
    // Auditing must never be the reason a call fails; a lost row is worth
    // less than a broken tool.
    let _ = conn.execute(
        "INSERT INTO mcp_audit(client_id, client_name, tool, detail, ok, message, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![client.id, client.name, tool, detail.map(short), ok, message, now_ms()],
    );
}

pub fn list(conn: &Connection, limit: i64) -> AppResult<Vec<AuditEntry>> {
    let limit = limit.clamp(1, 500);
    let mut stmt = conn.prepare(
        "SELECT id, client_id, client_name, tool, detail, ok, message, created_at
         FROM mcp_audit ORDER BY created_at DESC, id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], map)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// How many calls this client has made since `since` (epoch ms).
pub fn calls_since(conn: &Connection, client_id: &str, since: i64) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM mcp_audit WHERE client_id = ?1 AND created_at >= ?2",
        params![client_id, since],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

pub fn prune(conn: &Connection, days: i64) -> AppResult<usize> {
    if days <= 0 {
        return Ok(0);
    }
    let cutoff = now_ms() - days * 86_400_000;
    Ok(conn.execute("DELETE FROM mcp_audit WHERE created_at < ?1", [cutoff])?)
}

#[cfg(test)]
mod tests {
    use super::super::clients;
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        c
    }

    #[test]
    fn failures_are_recorded_too() {
        let c = db();
        let client = clients::register(&c, "Claude Code").unwrap();
        record(&c, &client, "kern_task_create", Some("1 task"), Ok(()));
        record(&c, &client, "kern_task_delete", Some("id abc"), Err("Task not found"));
        let rows = list(&c, 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(!rows[0].ok);
        assert_eq!(rows[0].message.as_deref(), Some("Task not found"));
        assert_eq!(calls_since(&c, &client.id, 0), 2);
    }

    #[test]
    fn pruning_keeps_recent_rows() {
        let c = db();
        let client = clients::register(&c, "Claude Code").unwrap();
        record(&c, &client, "kern_search", None, Ok(()));
        c.execute("UPDATE mcp_audit SET created_at = 1", []).unwrap();
        record(&c, &client, "kern_search", None, Ok(()));
        assert_eq!(prune(&c, 30).unwrap(), 1);
        assert_eq!(list(&c, 10).unwrap().len(), 1);
    }
}
