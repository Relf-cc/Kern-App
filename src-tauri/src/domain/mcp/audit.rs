// @Author Christian Relf
// @Date 2026-10-22

//! What each assistant did. Every tool call lands here, successful or not,
//! with a short description of its arguments rather than the payload — the
//! point is to be able to see at a glance what an assistant has been doing,
//! not to keep a second copy of your data.
//!
//! One row is also one batch: a call that changed something carries what it
//! would take to put it back (`revert::Step`, as JSON), and `reverted_at`
//! once that has been done. That record is the one place data is copied, and
//! only the part the call overwrote — see `revert.rs`.

use crate::error::{AppError, AppResult};
use crate::util::now_ms;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use super::clients::McpClient;
use super::revert::Step;

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
    /// Whether this call can still be put back.
    pub revertable: bool,
    pub reverted_at: Option<i64>,
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
        revertable: r.get::<_, Option<String>>(8)?.is_some() && r.get::<_, Option<i64>>(9)?.is_none(),
        reverted_at: r.get(9)?,
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

/// Writes the row for one call. `undo` is the batch's revert plan, for a
/// call that changed something and could be put back.
pub fn record(
    conn: &Connection,
    client: &McpClient,
    tool: &str,
    detail: Option<&str>,
    outcome: Result<(), &str>,
    undo: Option<&[Step]>,
) -> Option<i64> {
    let (ok, message) = match outcome {
        Ok(()) => (1i64, None),
        Err(e) => (0, Some(short(e))),
    };
    let plan = undo.filter(|u| !u.is_empty()).and_then(|u| serde_json::to_string(u).ok());
    // Auditing must never be the reason a call fails; a lost row is worth
    // less than a broken tool. The row's id is the batch id, for the toast
    // that offers to put the call back.
    conn.execute(
        "INSERT INTO mcp_audit(client_id, client_name, tool, detail, ok, message, created_at, undo)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![client.id, client.name, tool, detail.map(short), ok, message, now_ms(), plan],
    )
    .ok()
    .map(|_| conn.last_insert_rowid())
}

pub fn list(conn: &Connection, limit: i64) -> AppResult<Vec<AuditEntry>> {
    let limit = limit.clamp(1, 500);
    let mut stmt = conn.prepare(
        "SELECT id, client_id, client_name, tool, detail, ok, message, created_at, undo, reverted_at
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

/// The batch a row describes, ready to replay. A row with no plan, and one
/// already put back, each say so rather than quietly doing nothing.
pub fn undo_plan(conn: &Connection, id: i64) -> AppResult<Vec<Step>> {
    let row: Option<(Option<String>, Option<i64>)> = conn
        .query_row("SELECT undo, reverted_at FROM mcp_audit WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    match row {
        None => Err(AppError::NotFound("That call".into())),
        Some((_, Some(_))) => Err(AppError::Invalid("That change has already been put back.".into())),
        Some((None, _)) => Err(AppError::Invalid("That call didn't change anything that can be put back.".into())),
        Some((Some(plan), None)) => Ok(serde_json::from_str(&plan)
            .map_err(|_| AppError::Invalid("Kern can no longer read what that call changed, so it can't be put back.".into()))?),
    }
}

pub fn mark_reverted(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("UPDATE mcp_audit SET reverted_at = ?1 WHERE id = ?2", params![now_ms(), id])?;
    Ok(())
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
        let _ = record(&c, &client, "kern_task_create", Some("1 task"), Ok(()), Some(&[Step::TrashTasks { ids: vec!["t1".into()] }]));
        let _ = record(&c, &client, "kern_task_delete", Some("id abc"), Err("Task not found"), None);
        let rows = list(&c, 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(!rows[0].ok);
        assert_eq!(rows[0].message.as_deref(), Some("Task not found"));
        assert_eq!(calls_since(&c, &client.id, 0), 2);
    }

    #[test]
    fn a_batch_can_be_put_back_once() {
        let c = db();
        let client = clients::register(&c, "Claude Code").unwrap();
        let _ = record(&c, &client, "kern_task_create", Some("1 task"), Ok(()), Some(&[Step::TrashTasks { ids: vec!["t1".into()] }]));
        let _ = record(&c, &client, "kern_search", None, Ok(()), None);
        let rows = list(&c, 10).unwrap();
        let (search, create) = (&rows[0], &rows[1]);
        assert!(!search.revertable, "a read changed nothing");
        assert!(create.revertable);

        assert_eq!(undo_plan(&c, create.id).unwrap().len(), 1);
        mark_reverted(&c, create.id).unwrap();
        assert!(undo_plan(&c, create.id).is_err(), "not twice");
        assert!(!list(&c, 10).unwrap()[1].revertable);
        assert!(undo_plan(&c, search.id).is_err());
        assert!(undo_plan(&c, 9999).is_err());
    }

    #[test]
    fn pruning_keeps_recent_rows() {
        let c = db();
        let client = clients::register(&c, "Claude Code").unwrap();
        let _ = record(&c, &client, "kern_search", None, Ok(()), None);
        c.execute("UPDATE mcp_audit SET created_at = 1", []).unwrap();
        let _ = record(&c, &client, "kern_search", None, Ok(()), None);
        assert_eq!(prune(&c, 30).unwrap(), 1);
        assert_eq!(list(&c, 10).unwrap().len(), 1);
    }
}
