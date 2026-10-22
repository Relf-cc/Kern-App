// @Author Christian Relf
// @Date 2026-10-12

//! Lightweight local activity history. Only meaningful events are recorded
//! (completion, moves, rescheduling, creation of notes, archiving...), and
//! old entries are pruned according to the retention setting.

use crate::domain::passkeys;
use crate::error::AppResult;
use crate::state::AppState;
use crate::util::now_ms;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: i64,
    pub project_id: Option<String>,
    pub entity_type: String,
    pub entity_id: String,
    pub action: String,
    pub summary: String,
    pub created_at: i64,
}

pub fn log(
    conn: &Connection,
    project_id: Option<&str>,
    entity_type: &str,
    entity_id: &str,
    action: &str,
    summary: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO activity(project_id, entity_type, entity_id, action, summary, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![project_id, entity_type, entity_id, action, summary, now_ms()],
    )?;
    Ok(())
}

pub fn prune(conn: &Connection, retention_days: i64) -> AppResult<usize> {
    let cutoff = now_ms() - retention_days.max(7) * 86_400_000;
    Ok(conn.execute("DELETE FROM activity WHERE created_at < ?1", [cutoff])?)
}

#[tauri::command]
pub fn activity_list(
    state: State<AppState>,
    project_id: Option<String>,
    limit: Option<i64>,
    before: Option<i64>,
) -> AppResult<Vec<Activity>> {
    state.with(|c| list(c, project_id.as_deref(), limit, before))
}

/// The feed on a connection, for the command above and the assistant tools.
pub fn list(c: &Connection, project_id: Option<&str>, limit: Option<i64>, before: Option<i64>) -> AppResult<Vec<Activity>> {
    {
        let limit = limit.unwrap_or(50).clamp(1, 500);
        let before = before.unwrap_or(i64::MAX);
        let mut stmt = c.prepare(&format!(
            "SELECT id, project_id, entity_type, entity_id, action, summary, created_at FROM activity
             WHERE (?1 IS NULL OR project_id = ?1) AND created_at < ?2 AND {}
             ORDER BY created_at DESC, id DESC LIMIT ?3",
            passkeys::readable_sql(c, "project_id")
        ))?;
        let rows = stmt.query_map(params![project_id, before, limit], |r| {
            Ok(Activity {
                id: r.get(0)?,
                project_id: r.get(1)?,
                entity_type: r.get(2)?,
                entity_id: r.get(3)?,
                action: r.get(4)?,
                summary: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}
