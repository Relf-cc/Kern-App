// @Author Christian Relf
// @Date 2026-10-12

//! Notes (Markdown content) and the Inbox of unorganised captures.

use crate::domain::{activity, passkeys, recent, tasks};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms, some};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content: String,
    pub project_id: Option<String>,
    pub pinned: bool,
    pub archived_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// List representation without the full body.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    pub project_id: Option<String>,
    pub pinned: bool,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn map_note(r: &Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        title: r.get(1)?,
        content: r.get(2)?,
        project_id: r.get(3)?,
        pinned: r.get::<_, i64>(4)? != 0,
        archived_at: r.get(5)?,
        deleted_at: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

const NOTE_SELECT: &str =
    "SELECT id, title, content, project_id, pinned, archived_at, deleted_at, created_at, updated_at FROM notes";

pub fn get_note(conn: &Connection, id: &str) -> AppResult<Note> {
    let note = conn
        .query_row(&format!("{NOTE_SELECT} WHERE id = ?1"), [id], map_note)
        .optional()?
        .ok_or_else(|| AppError::NotFound("Note".into()))?;
    passkeys::ensure_readable_opt(conn, note.project_id.as_deref())?;
    Ok(note)
}

/// Plain-text excerpt from Markdown for list previews.
pub fn excerpt(md: &str, max: usize) -> String {
    let mut out = String::new();
    for line in md.lines() {
        let l = line
            .trim()
            .trim_start_matches(|c: char| c == '#' || c == '>' || c == '-' || c == '*' || c == '+')
            .trim_start()
            .trim_start_matches("[ ]")
            .trim_start_matches("[x]")
            .trim();
        if l.is_empty() || l.starts_with("```") || l == "---" {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&l.replace("**", "").replace('`', ""));
        if out.chars().count() >= max {
            break;
        }
    }
    out.chars().take(max).collect()
}

pub fn create_note(conn: &Connection, title: &str, content: &str, project_id: Option<&str>) -> AppResult<Note> {
    let id = new_id();
    let now = now_ms();
    conn.execute(
        "INSERT INTO notes(id, title, content, project_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, title.trim(), content, project_id, now],
    )?;
    let label = if title.trim().is_empty() { "Untitled note" } else { title.trim() };
    activity::log(conn, project_id, "note", &id, "created", label)?;
    get_note(conn, &id)
}

#[tauri::command]
pub fn notes_list(
    state: State<AppState>,
    project_id: Option<String>,
    include_archived: Option<bool>,
) -> AppResult<Vec<NoteMeta>> {
    state.with(|c| {
        let mut stmt = c.prepare(&format!(
            "SELECT id, title, substr(content, 1, 600), project_id, pinned, archived_at, created_at, updated_at FROM notes
             WHERE deleted_at IS NULL AND (?1 IS NULL OR project_id = ?1) AND (?2 = 1 OR archived_at IS NULL)
               AND {}
             ORDER BY pinned DESC, updated_at DESC",
            passkeys::readable_sql(c, "project_id")
        ))?;
        let rows = stmt.query_map(params![project_id, include_archived.unwrap_or(false) as i64], |r| {
            let body: String = r.get(2)?;
            Ok(NoteMeta {
                id: r.get(0)?,
                title: r.get(1)?,
                excerpt: excerpt(&body, 160),
                project_id: r.get(3)?,
                pinned: r.get::<_, i64>(4)? != 0,
                archived_at: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command]
pub fn note_get(state: State<AppState>, id: String) -> AppResult<Note> {
    state.with(|c| {
        let n = get_note(c, &id)?;
        recent::touch(c, "note", &id)?;
        Ok(n)
    })
}

#[tauri::command]
pub fn note_create(
    state: State<AppState>,
    title: Option<String>,
    content: Option<String>,
    project_id: Option<String>,
) -> AppResult<Note> {
    state.with(|c| {
        create_note(c, &title.unwrap_or_default(), &content.unwrap_or_default(), project_id.as_deref())
    })
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NotePatch {
    pub title: Option<String>,
    pub content: Option<String>,
    #[serde(deserialize_with = "some")]
    pub project_id: Option<Option<String>>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
}

#[tauri::command]
pub fn note_update(state: State<AppState>, id: String, patch: NotePatch) -> AppResult<Note> {
    state.with(|c| update_note(c, &id, &patch))
}

/// Applies a patch on a connection, for the command above and the assistant
/// tools (`domain::mcp`).
pub fn update_note(c: &mut Connection, id: &str, patch: &NotePatch) -> AppResult<Note> {
    {
        let tx = c.transaction()?;
        let prev = get_note(&tx, id)?;
        let now = now_ms();
        if let Some(t) = &patch.title {
            tx.execute("UPDATE notes SET title = ?1, updated_at = ?2 WHERE id = ?3", params![t, now, id])?;
        }
        if let Some(t) = &patch.content {
            tx.execute("UPDATE notes SET content = ?1, updated_at = ?2 WHERE id = ?3", params![t, now, id])?;
        }
        if let Some(p) = &patch.project_id {
            tx.execute("UPDATE notes SET project_id = ?1, updated_at = ?2 WHERE id = ?3", params![p, now, id])?;
        }
        if let Some(p) = patch.pinned {
            tx.execute("UPDATE notes SET pinned = ?1 WHERE id = ?2", params![p as i64, id])?;
        }
        if let Some(a) = patch.archived {
            let v = if a { Some(prev.archived_at.unwrap_or(now)) } else { None };
            tx.execute("UPDATE notes SET archived_at = ?1 WHERE id = ?2", params![v, id])?;
        }
        let n = get_note(&tx, id)?;
        tx.commit()?;
        Ok(n)
    }
}

/// A note that links to something (`kern://<kind>/<id>` in its Markdown),
/// with the line the link is on.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub context: String,
    pub updated_at: i64,
}

/// Markdown link text and plain words from one line: "[Plan](kern://…)" → "Plan".
fn plain_line(line: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    while let Some(i) = rest.find('[') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match (after.find("]("), after.find(')')) {
            (Some(close), Some(end)) if close < end => {
                out.push_str(&after[..close]);
                rest = &after[end + 1..];
            }
            _ => {
                out.push('[');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    let t = out.trim().trim_start_matches(|c: char| c == '#' || c == '>' || c == '-' || c == '*').trim();
    t.trim_start_matches("[ ]").trim_start_matches("[x]").trim().replace("**", "").chars().take(200).collect()
}

pub fn backlinks(conn: &Connection, kind: &str, id: &str) -> AppResult<Vec<Backlink>> {
    if !matches!(kind, "note" | "task" | "project") {
        return invalid("Unknown link kind.");
    }
    let needle = format!("kern://{kind}/{id}");
    let mut stmt = conn.prepare(
        "SELECT id, title, content, project_id, updated_at FROM notes
         WHERE deleted_at IS NULL AND id != ?2 AND instr(content, ?1) > 0 ORDER BY updated_at DESC LIMIT 100",
    )?;
    let rows = stmt.query_map(params![needle, id], |r| {
        let content: String = r.get(2)?;
        let context = content.lines().find(|l| l.contains(&needle)).map(plain_line).unwrap_or_default();
        Ok(Backlink { id: r.get(0)?, title: r.get(1)?, project_id: r.get(3)?, context, updated_at: r.get(4)? })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn note_backlinks(state: State<AppState>, kind: String, id: String) -> AppResult<Vec<Backlink>> {
    state.with(|c| backlinks(c, &kind, &id))
}

#[tauri::command]
pub fn notes_delete(state: State<AppState>, ids: Vec<String>) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        let now = now_ms();
        for id in &ids {
            tx.execute("UPDATE notes SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL", params![now, id])?;
        }
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn notes_restore(state: State<AppState>, ids: Vec<String>) -> AppResult<()> {
    state.with(|c| {
        for id in &ids {
            c.execute("UPDATE notes SET deleted_at = NULL WHERE id = ?1", [id])?;
            c.execute(
                "UPDATE notes SET project_id = NULL WHERE id = ?1 AND project_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = notes.project_id AND p.deleted_at IS NULL)",
                [id],
            )?;
        }
        Ok(())
    })
}

// ----------------------------------------------------------------- inbox

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub kind: String,
    pub content: String,
    pub created_at: i64,
}

fn detect_kind(content: &str) -> &'static str {
    let c = content.trim();
    if (c.starts_with("http://") || c.starts_with("https://") || c.starts_with("www.")) && !c.contains(char::is_whitespace) {
        "link"
    } else {
        "idea"
    }
}

#[tauri::command]
pub fn inbox_list(state: State<AppState>) -> AppResult<Vec<InboxItem>> {
    state.with(|c| {
        let mut stmt = c.prepare("SELECT id, kind, content, created_at FROM inbox_items ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |r| {
            Ok(InboxItem { id: r.get(0)?, kind: r.get(1)?, content: r.get(2)?, created_at: r.get(3)? })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

#[tauri::command]
pub fn inbox_add(state: State<AppState>, content: String, kind: Option<String>) -> AppResult<InboxItem> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return invalid("Nothing to capture.");
    }
    state.with(|c| {
        let item = InboxItem {
            id: new_id(),
            kind: kind.unwrap_or_else(|| detect_kind(&content).to_string()),
            content,
            created_at: now_ms(),
        };
        c.execute(
            "INSERT INTO inbox_items(id, kind, content, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![item.id, item.kind, item.content, item.created_at],
        )?;
        Ok(item)
    })
}

#[tauri::command]
pub fn inbox_update(state: State<AppState>, id: String, content: String) -> AppResult<()> {
    state.with(|c| {
        c.execute(
            "UPDATE inbox_items SET content = ?1, kind = ?2 WHERE id = ?3",
            params![content.trim(), detect_kind(&content), id],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn inbox_delete(state: State<AppState>, id: String) -> AppResult<Option<InboxItem>> {
    state.with(|c| {
        let item = c
            .query_row("SELECT id, kind, content, created_at FROM inbox_items WHERE id = ?1", [&id], |r| {
                Ok(InboxItem { id: r.get(0)?, kind: r.get(1)?, content: r.get(2)?, created_at: r.get(3)? })
            })
            .optional()?;
        c.execute("DELETE FROM inbox_items WHERE id = ?1", [&id])?;
        Ok(item)
    })
}

/// Restores a previously deleted/converted inbox item (undo).
#[tauri::command]
pub fn inbox_restore(state: State<AppState>, item: serde_json::Value) -> AppResult<()> {
    state.with(|c| {
        let id = item["id"].as_str().unwrap_or_default().to_string();
        let kind = item["kind"].as_str().unwrap_or("idea").to_string();
        let content = item["content"].as_str().unwrap_or_default().to_string();
        let created = item["createdAt"].as_i64().unwrap_or_else(now_ms);
        if id.is_empty() || content.is_empty() {
            return invalid("Malformed inbox item.");
        }
        c.execute(
            "INSERT OR REPLACE INTO inbox_items(id, kind, content, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, kind, content, created],
        )?;
        Ok(())
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConvertResult {
    pub kind: String,
    pub id: String,
}

/// Converts an inbox capture into a task or a note (optionally in a project).
#[tauri::command]
pub fn inbox_convert(
    state: State<AppState>,
    id: String,
    to: String,
    project_id: Option<String>,
) -> AppResult<ConvertResult> {
    state.with(|c| {
        let tx = c.transaction()?;
        let (kind, content): (String, String) = tx
            .query_row("SELECT kind, content FROM inbox_items WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .ok_or_else(|| AppError::NotFound("Inbox item".into()))?;
        let first_line = content.lines().next().unwrap_or("").trim().chars().take(200).collect::<String>();
        let rest = content.lines().skip(1).collect::<Vec<_>>().join("\n");
        let out = match to.as_str() {
            "task" => {
                let description = if kind == "link" { content.clone() } else { rest };
                let t = tasks::create_task(
                    &tx,
                    &tasks::TaskInput {
                        title: first_line,
                        description: Some(description),
                        status: Some(if project_id.is_some() { "todo".into() } else { "inbox".into() }),
                        project_id: project_id.clone(),
                        ..Default::default()
                    },
                )?;
                ConvertResult { kind: "task".into(), id: t.id }
            }
            "note" => {
                let body = if kind == "link" { format!("[{content}]({content})") } else { rest };
                let n = create_note(&tx, &first_line, &body, project_id.as_deref())?;
                ConvertResult { kind: "note".into(), id: n.id }
            }
            _ => return invalid("Can only convert to a task or a note."),
        };
        tx.execute("DELETE FROM inbox_items WHERE id = ?1", [&id])?;
        tx.commit()?;
        Ok(out)
    })
}

#[cfg(test)]
mod tests {

    #[test]
    fn backlinks_find_linking_notes() {
        let c = crate::db::open_memory();
        let target = create_note(&c, "Roadmap", "", None).unwrap();
        create_note(&c, "Monday", &format!("# Standup

- Discussed [Roadmap](kern://note/{}) and **more**
- Other", target.id), None).unwrap();
        create_note(&c, "Unrelated", "nothing here", None).unwrap();
        let b = backlinks(&c, "note", &target.id).unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!((b[0].title.as_str(), b[0].context.as_str()), ("Monday", "Discussed Roadmap and more"));
        assert!(backlinks(&c, "file", "x").is_err());
    }

    use super::*;

    #[test]
    fn excerpt_strips_markdown() {
        let md = "# Title\n\n- [ ] Buy **milk**\n```\ncode\n```\n---\nPlain `text`";
        assert_eq!(excerpt(md, 100), "Title Buy milk code Plain text");
    }

    #[test]
    fn kind_detection() {
        assert_eq!(detect_kind("https://example.com/page"), "link");
        assert_eq!(detect_kind("call mum about https://x.y"), "idea");
    }
}
