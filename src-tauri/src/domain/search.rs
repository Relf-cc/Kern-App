// @Author Christian Relf
// @Date 2026-10-12

//! Global search backed by SQLite FTS5 (kept in sync by triggers), plus
//! labels, saved views, saved commands, workspace snapshots, GitHub issues
//! linked to tasks and cached pull requests by name. Linked-folder files and
//! code are searched separately (see `fileindex`).
//!
//! `scope` narrows results: all | tasks | projects | notes | github | commands.

use crate::domain::passkeys;
use crate::error::AppResult;
use crate::state::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub kind: String,
    pub id: String,
    /// Project id (tasks, notes, boards, whiteboards) or whiteboard id (wb_node).
    pub parent_id: Option<String>,
    pub title: String,
    pub snippet: String,
    /// Extra per-kind info, e.g. task status.
    pub meta: Option<String>,
}

/// Converts free text into a safe FTS5 query: every token becomes a quoted
/// prefix term, all terms required.
pub fn to_fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '(' || c == ')' || c == '*' || c == ':' || c == '^')
        .filter(|t| !t.is_empty())
        .take(8)
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

/// FTS kinds included in each scope.
fn scope_kinds(scope: &str) -> Option<&'static [&'static str]> {
    match scope {
        "tasks" => Some(&["task"]),
        "projects" => Some(&["project", "board", "whiteboard", "wb_node", "milestone"]),
        "notes" => Some(&["note"]),
        "github" | "commands" | "files" | "code" => Some(&[]),
        _ => None,
    }
}

/// The project a hit belongs to, for the passkey gate below.
pub fn owner_of(conn: &Connection, hit: &SearchHit) -> Option<String> {
    let one = |sql: &str, id: &str| conn.query_row(sql, [id], |r| r.get::<_, Option<String>>(0)).optional().ok().flatten().flatten();
    match hit.kind.as_str() {
        "project" => Some(hit.id.clone()),
        // Saved commands and snapshots already carry their project.
        "command" | "snapshot" => hit.parent_id.clone(),
        "task" | "github" | "pr" => one("SELECT project_id FROM tasks WHERE id = ?1", &hit.id),
        "note" => one("SELECT project_id FROM notes WHERE id = ?1", &hit.id),
        "whiteboard" => one("SELECT project_id FROM whiteboards WHERE id = ?1", &hit.id),
        "wb_node" => hit.parent_id.as_deref().and_then(|p| one("SELECT project_id FROM whiteboards WHERE id = ?1", p)),
        // Labels and saved views belong to no project.
        _ => None,
    }
}

/// Search crosses every kind of record at once, so locked projects are
/// filtered out of the finished list rather than in each query.
fn drop_locked(conn: &Connection, hits: &mut Vec<SearchHit>) {
    if !passkeys::filtering(conn) {
        return;
    }
    hits.retain(|hit| passkeys::ensure_readable_opt(conn, owner_of(conn, hit).as_deref()).is_ok());
}

/// The search itself, on a connection. The command below and the assistant
/// tools (`domain::mcp`) both come through here.
pub fn run(c: &Connection, query: &str, limit: Option<i64>, scope: Option<&str>) -> AppResult<Vec<SearchHit>> {
    let limit = limit.unwrap_or(30).clamp(1, 200);
    let Some(fts) = to_fts_query(query) else { return Ok(vec![]) };
    let like = format!("%{}%", query.trim().replace('%', "").replace('_', ""));
    let scope = scope.unwrap_or("all");
    let kinds = scope_kinds(scope);
    let all = kinds.is_none();
    {
        let mut out = vec![];
        let mut stmt = c.prepare(
            "SELECT kind, ref_id, parent_id, title, snippet(search_fts, 4, '', '', '…', 12)
             FROM search_fts WHERE search_fts MATCH ?1
             ORDER BY bm25(search_fts, 0.0, 0.0, 0.0, 8.0, 1.0) LIMIT ?2",
        )?;
        let fetch = if all { limit } else { limit * 3 };
        let rows = stmt.query_map(params![fts, fetch], |r| {
            Ok(SearchHit {
                kind: r.get(0)?,
                id: r.get(1)?,
                parent_id: r.get(2)?,
                title: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                snippet: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                meta: None,
            })
        })?;
        for hit in rows {
            let mut hit = hit?;
            if kinds.is_some_and(|k| !k.contains(&hit.kind.as_str())) {
                continue;
            }
            match hit.kind.as_str() {
                "task" => {
                    hit.meta = c
                        .query_row("SELECT status FROM tasks WHERE id = ?1", [&hit.id], |r| r.get(0))
                        .optional()?;
                }
                "wb_node" => {
                    // Show the whiteboard's name for context.
                    hit.meta = c
                        .query_row("SELECT name FROM whiteboards WHERE id = ?1 AND deleted_at IS NULL", [&hit.parent_id], |r| r.get(0))
                        .optional()?;
                    if hit.meta.is_none() {
                        continue;
                    }
                }
                _ => {}
            }
            out.push(hit);
        }
        if all || scope == "tasks" {
            let mut stmt = c.prepare("SELECT id, name FROM labels WHERE name LIKE ?1 ORDER BY name LIMIT 5")?;
            for row in stmt.query_map([&like], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
                let (id, name) = row?;
                out.push(SearchHit { kind: "label".into(), id, parent_id: None, title: name, snippet: String::new(), meta: None });
            }
            let mut stmt = c.prepare("SELECT id, name FROM saved_views WHERE name LIKE ?1 ORDER BY name LIMIT 5")?;
            for row in stmt.query_map([&like], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
                let (id, name) = row?;
                out.push(SearchHit { kind: "view".into(), id, parent_id: None, title: name, snippet: String::new(), meta: None });
            }
        }
        if all || scope == "commands" {
            let mut stmt = c.prepare(
                "SELECT c.id, c.project_id, c.name, c.program || ' ' || replace(replace(replace(c.args, '[', ''), ']', ''), '\"', ''), p.name
                 FROM project_commands c JOIN projects p ON p.id = c.project_id WHERE p.deleted_at IS NULL AND (c.name LIKE ?1 OR c.program LIKE ?1 OR c.args LIKE ?1) ORDER BY c.pinned DESC, c.name LIMIT 8",
            )?;
            for row in stmt.query_map([&like], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?)))? {
                let (id, pid, name, cmd, project) = row?;
                out.push(SearchHit { kind: "command".into(), id, parent_id: Some(pid), title: name, snippet: cmd.replace(',', " "), meta: Some(project) });
            }
            let mut stmt = c.prepare(
                "SELECT s.id, s.project_id, s.name, p.name FROM workspace_snapshots s JOIN projects p ON p.id = s.project_id WHERE p.deleted_at IS NULL AND s.name LIKE ?1 ORDER BY s.name LIMIT 5",
            )?;
            for row in stmt.query_map([&like], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))? {
                let (id, pid, name, project) = row?;
                out.push(SearchHit { kind: "snapshot".into(), id, parent_id: Some(pid), title: name, snippet: String::new(), meta: Some(project) });
            }
        }
        if all || scope == "github" {
            let number = query.trim().trim_start_matches('#').parse::<i64>().ok();
            let mut stmt = c.prepare(
                "SELECT l.task_id, l.repo, l.issue_number, t.title, t.status FROM task_issue_links l JOIN tasks t ON t.id = l.task_id
                 WHERE t.deleted_at IS NULL AND (t.title LIKE ?1 OR l.issue_number = ?2 OR l.repo LIKE ?1) ORDER BY t.updated_at DESC LIMIT 10",
            )?;
            for row in stmt.query_map(params![like, number], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?)))? {
                let (task, repo, n, title, status) = row?;
                out.push(SearchHit { kind: "issue".into(), id: task, parent_id: Some(repo.clone()), title, snippet: format!("{repo}#{n}"), meta: Some(status) });
            }
            let mut stmt = c.prepare(
                "SELECT substr(d.key, 10), json_extract(j.value, '$.number'), json_extract(j.value, '$.title'), json_extract(j.value, '$.htmlUrl'), json_extract(j.value, '$.head')
                 FROM dev_cache d, json_each(d.data) j
                 WHERE d.key LIKE 'gh:pulls:%' AND (json_extract(j.value, '$.title') LIKE ?1 OR json_extract(j.value, '$.number') = ?2 OR json_extract(j.value, '$.head') LIKE ?1) LIMIT 10",
            )?;
            for row in stmt.query_map(params![like, number], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, Option<String>>(4)?)))? {
                let (repo, n, title, url, head) = row?;
                out.push(SearchHit { kind: "pull".into(), id: url, parent_id: Some(repo.clone()), title, snippet: format!("{repo}#{n}{}", head.map(|h| format!(" · {h}")).unwrap_or_default()), meta: None });
            }
            // Commit metadata from the last fetch (message, short hash).
            let mut stmt = c.prepare(
                "SELECT substr(d.key, 12), json_extract(j.value, '$.subject'), json_extract(j.value, '$.short'), json_extract(j.value, '$.htmlUrl')
                 FROM dev_cache d, json_each(d.data) j
                 WHERE d.key LIKE 'gh:commits:%' AND (json_extract(j.value, '$.subject') LIKE ?1 OR json_extract(j.value, '$.sha') LIKE ?2) LIMIT 8",
            )?;
            let sha = format!("{}%", query.trim().to_lowercase());
            for row in stmt.query_map(params![like, sha], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))? {
                let (repo, subject, short, url) = row?;
                out.push(SearchHit { kind: "commit".into(), id: url, parent_id: Some(repo.clone()), title: subject, snippet: format!("{repo} · {short}"), meta: None });
            }
        }
        drop_locked(c, &mut out);
        Ok(out)
    }
}

#[tauri::command]
pub fn search(state: State<AppState>, query: String, limit: Option<i64>, scope: Option<String>) -> AppResult<Vec<SearchHit>> {
    state.with(|c| run(c, &query, limit, scope.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_sanitising() {
        assert_eq!(to_fts_query("  "), None);
        assert_eq!(to_fts_query("web re\"design"), Some("\"web\"* \"re\"* \"design\"*".into()));
        assert_eq!(to_fts_query("a:b OR c*"), Some("\"a\"* \"b\"* \"OR\"* \"c\"*".into()));
    }
}
