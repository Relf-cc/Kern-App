// @Author Christian Relf
// @Date 2026-10-22

//! The assistants that have asked to connect, and what each may do.
//!
//! A client is identified by the name its bridge reports, which is advisory:
//! the real boundary is the pipe, which only this user account can open. The
//! record exists so a connection can be recognised, approved once, scoped,
//! and taken away again — not to authenticate anyone.

use crate::error::{invalid, AppError, AppResult};
use crate::util::now_ms;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

pub const PENDING: &str = "pending";
pub const APPROVED: &str = "approved";
pub const REVOKED: &str = "revoked";

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpClient {
    pub id: String,
    pub name: String,
    /// "pending" | "approved" | "revoked".
    pub status: String,
    /// "read" | "write".
    pub scope: String,
    /// Project ids this client may see; empty means all of them.
    pub projects: Vec<String>,
    pub created_at: i64,
    pub approved_at: Option<i64>,
    pub last_seen_at: Option<i64>,
}

impl McpClient {
    pub fn may_write(&self) -> bool {
        self.scope == "write"
    }
}

fn map(r: &Row) -> rusqlite::Result<McpClient> {
    let projects: String = r.get(4)?;
    Ok(McpClient {
        id: r.get(0)?,
        name: r.get(1)?,
        status: r.get(2)?,
        scope: r.get(3)?,
        projects: serde_json::from_str(&projects).unwrap_or_default(),
        created_at: r.get(5)?,
        approved_at: r.get(6)?,
        last_seen_at: r.get(7)?,
    })
}

const SELECT: &str = "SELECT id, name, status, scope, projects, created_at, approved_at, last_seen_at FROM mcp_clients";

/// A stable id for a client name, so the same assistant reconnecting lands on
/// the record it was approved under. FNV-1a of the folded name.
pub fn id_for(name: &str) -> String {
    let h = name
        .trim()
        .to_lowercase()
        .bytes()
        .fold(1469598103934665603u64, |h, b| (h ^ b as u64).wrapping_mul(1099511628211));
    format!("c{h:x}")
}

pub fn get(conn: &Connection, id: &str) -> AppResult<McpClient> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], map)
        .optional()?
        .ok_or_else(|| AppError::NotFound("Assistant".into()))
}

pub fn list(conn: &Connection) -> AppResult<Vec<McpClient>> {
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY last_seen_at DESC, created_at DESC"))?;
    let rows = stmt.query_map([], map)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Records a connection attempt. A name never seen before is written as
/// `pending` — it connects to nothing until someone approves it here.
pub fn register(conn: &Connection, name: &str) -> AppResult<McpClient> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return invalid("An assistant must give a name of 1 to 80 characters.");
    }
    let id = id_for(name);
    let now = now_ms();
    conn.execute(
        "INSERT INTO mcp_clients(id, name, status, scope, projects, created_at, last_seen_at)
         VALUES (?1, ?2, 'pending', 'read', '[]', ?3, ?3)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = ?3, name = ?2",
        params![id, name, now],
    )?;
    get(conn, &id)
}

pub fn touch(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("UPDATE mcp_clients SET last_seen_at = ?1 WHERE id = ?2", params![now_ms(), id])?;
    Ok(())
}

/// Approves, revokes or returns a client to pending.
pub fn set_status(conn: &Connection, id: &str, status: &str) -> AppResult<McpClient> {
    if ![PENDING, APPROVED, REVOKED].contains(&status) {
        return invalid("Unknown assistant status.");
    }
    let approved = (status == APPROVED).then(now_ms);
    let n = conn.execute(
        "UPDATE mcp_clients SET status = ?1, approved_at = ?2 WHERE id = ?3",
        params![status, approved, id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound("Assistant".into()));
    }
    get(conn, id)
}

pub fn set_scope(conn: &Connection, id: &str, scope: &str) -> AppResult<McpClient> {
    if !["read", "write"].contains(&scope) {
        return invalid("An assistant's access is either 'read' or 'write'.");
    }
    conn.execute("UPDATE mcp_clients SET scope = ?1 WHERE id = ?2", params![scope, id])?;
    get(conn, id)
}

/// Limits a client to these projects; an empty list means all of them.
pub fn set_projects(conn: &Connection, id: &str, projects: &[String]) -> AppResult<McpClient> {
    let json = serde_json::to_string(projects)?;
    conn.execute("UPDATE mcp_clients SET projects = ?1 WHERE id = ?2", params![json, id])?;
    get(conn, id)
}

pub fn remove(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM mcp_clients WHERE id = ?1", [id])?;
    conn.execute("DELETE FROM mcp_audit WHERE client_id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        c
    }

    #[test]
    fn a_new_client_starts_pending_and_read_only() {
        let c = db();
        let client = register(&c, "Claude Desktop").unwrap();
        assert_eq!(client.status, PENDING);
        assert_eq!(client.scope, "read");
        assert!(!client.may_write());
        assert!(client.projects.is_empty());
    }

    #[test]
    fn reconnecting_keeps_the_record_it_was_approved_under() {
        let c = db();
        let first = register(&c, "Claude Desktop").unwrap();
        set_status(&c, &first.id, APPROVED).unwrap();
        set_scope(&c, &first.id, "write").unwrap();
        // Same name, different capitalisation and spacing.
        let again = register(&c, " claude desktop ").unwrap();
        assert_eq!(again.id, first.id);
        assert_eq!(again.status, APPROVED);
        assert!(again.may_write());
        assert_eq!(list(&c).unwrap().len(), 1);
    }

    #[test]
    fn names_must_be_sensible() {
        let c = db();
        assert!(register(&c, "   ").is_err());
        assert!(register(&c, &"x".repeat(81)).is_err());
    }
}
