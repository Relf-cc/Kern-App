// @Author Christian Relf
// @Date 2026-10-12

use crate::error::{invalid, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub task_count: i64,
}

#[tauri::command]
pub fn labels_list(state: State<AppState>) -> AppResult<Vec<Label>> {
    state.with(|c| list(c))
}

/// Every label with its open-task count, for the command above and the
/// assistant tools.
pub fn list(c: &Connection) -> AppResult<Vec<Label>> {
    {
        let mut stmt = c.prepare(
            "SELECT l.id, l.name, l.color,
               (SELECT count(*) FROM task_labels tl JOIN tasks t ON t.id = tl.task_id
                 WHERE tl.label_id = l.id AND t.deleted_at IS NULL AND t.status != 'completed')
             FROM labels l ORDER BY l.name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Label { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, task_count: r.get(3)? })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

/// The id of the label called `name` (case-insensitive), created if needed.
pub fn ensure(conn: &Connection, name: &str, color: Option<&str>) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return invalid("Label name can't be empty.");
    }
    if let Some(id) = conn.query_row("SELECT id FROM labels WHERE name = ?1 COLLATE NOCASE", [name], |r| r.get::<_, String>(0)).optional()? {
        return Ok(id);
    }
    let id = new_id();
    conn.execute("INSERT INTO labels(id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)", params![id, name, color, now_ms()])?;
    Ok(id)
}

#[tauri::command]
pub fn label_create(state: State<AppState>, name: String, color: Option<String>) -> AppResult<Label> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return invalid("Label name can't be empty.");
    }
    state.with(|c| {
        // Re-use an existing label with the same name (case-insensitive).
        if let Ok(existing) = c.query_row(
            "SELECT id, name, color FROM labels WHERE name = ?1 COLLATE NOCASE",
            [&name],
            |r| Ok(Label { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, task_count: 0 }),
        ) {
            return Ok(existing);
        }
        let id = new_id();
        c.execute(
            "INSERT INTO labels(id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, color, now_ms()],
        )?;
        Ok(Label { id, name, color, task_count: 0 })
    })
}

#[tauri::command]
pub fn label_update(state: State<AppState>, id: String, name: Option<String>, color: Option<String>) -> AppResult<()> {
    state.with(|c| {
        if let Some(name) = name {
            let name = name.trim().to_string();
            if name.is_empty() {
                return invalid("Label name can't be empty.");
            }
            c.execute("UPDATE labels SET name = ?1 WHERE id = ?2", params![name, id])?;
        }
        if let Some(color) = color {
            let color = if color.is_empty() { None } else { Some(color) };
            c.execute("UPDATE labels SET color = ?1 WHERE id = ?2", params![color, id])?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn label_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("DELETE FROM labels WHERE id = ?1", [id])?;
        Ok(())
    })
}
