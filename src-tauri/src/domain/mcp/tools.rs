// @Author Christian Relf
// @Date 2026-10-22

//! What an assistant can actually do, as plain functions on a connection.
//!
//! Each tool is a parameter struct (whose JSON Schema the model is shown) and
//! a function taking `&Connection` and the calling client. Nothing here opens
//! a socket or knows about rmcp — `server.rs` wires these up, and these are
//! what the tests drive.
//!
//! Two rules hold throughout:
//!
//! - **Ask `policy` before touching a project.** Every function that takes or
//!   returns a project id calls `ensure_project` or filters with `visible`.
//! - **Answer small.** The model pays for every field, so these return brief
//!   shapes with names in them (project names, label names), not the internal
//!   records with their ids, sort orders and timestamps.

use crate::domain::mcp::clients::McpClient;
use crate::domain::mcp::policy;
use crate::domain::{activity, boards, labels, notes, projects, search, tasks};
use crate::error::{invalid, AppResult};
use chrono::Local;
use rmcp::schemars;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ------------------------------------------------------------ brief shapes

#[derive(Serialize, schemars::JsonSchema, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskBrief {
    pub id: String,
    pub title: String,
    /// todo | in_progress | blocked | completed
    pub status: String,
    /// 0 none, 1 low, 2 medium, 3 high.
    pub priority: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtasks: Option<String>,
}

#[derive(Serialize, schemars::JsonSchema, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBrief {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_date: Option<String>,
    pub open_tasks: i64,
    pub done_tasks: i64,
    pub overdue_tasks: i64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
}

#[derive(Serialize, schemars::JsonSchema, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteBrief {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Serialize, schemars::JsonSchema, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColumnBrief {
    pub id: String,
    pub name: String,
    pub status: Option<String>,
}

#[derive(Serialize, schemars::JsonSchema, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BoardBrief {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub columns: Vec<ColumnBrief>,
}

/// Names for ids, so a brief reads without a second call.
struct Names {
    projects: HashMap<String, String>,
    labels: HashMap<String, String>,
}

impl Names {
    fn load(conn: &Connection) -> AppResult<Names> {
        let projects = projects::list_projects(conn, true)?.into_iter().map(|p| (p.id, p.name)).collect();
        let labels = labels::list(conn)?.into_iter().map(|l| (l.id, l.name)).collect();
        Ok(Names { projects, labels })
    }

    fn task(&self, t: &tasks::Task) -> TaskBrief {
        TaskBrief {
            id: t.id.clone(),
            title: t.title.clone(),
            status: t.status.clone(),
            priority: t.priority,
            project: t.project_id.as_ref().and_then(|p| self.projects.get(p).cloned()),
            project_id: t.project_id.clone(),
            due_date: t.due_date.clone(),
            labels: t.label_ids.iter().filter_map(|l| self.labels.get(l).cloned()).collect(),
            subtasks: (t.subtask_count > 0).then(|| format!("{}/{}", t.subtask_done, t.subtask_count)),
        }
    }
}

fn project_brief(p: projects::Project) -> ProjectBrief {
    ProjectBrief {
        archived: p.archived_at.is_some(),
        id: p.id,
        name: p.name,
        description: p.description,
        target_date: p.target_date,
        open_tasks: p.task_total - p.task_done,
        done_tasks: p.task_done,
        overdue_tasks: p.task_overdue,
    }
}

fn note_brief(n: notes::Note, with_content: bool) -> NoteBrief {
    NoteBrief {
        id: n.id,
        title: n.title,
        project_id: n.project_id,
        content: with_content.then_some(n.content),
    }
}

fn board_brief(conn: &Connection, b: boards::Board) -> AppResult<BoardBrief> {
    let columns = boards::list_columns(conn, &b.id)?
        .into_iter()
        .map(|c| ColumnBrief { id: c.id, name: c.name, status: c.status })
        .collect();
    Ok(BoardBrief { id: b.id, name: b.name, project_id: b.project_id, columns })
}

/// The projects this client may see, in order.
fn visible_projects(conn: &Connection, client: &McpClient, include_archived: bool) -> AppResult<Vec<projects::Project>> {
    Ok(projects::list_projects(conn, include_archived)?
        .into_iter()
        .filter(|p| policy::visible(conn, client, Some(&p.id)))
        .collect())
}

fn today() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

fn clamp_limit(limit: Option<i64>, default: i64) -> i64 {
    limit.unwrap_or(default).clamp(1, 200)
}

// ------------------------------------------------------------ reading

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Empty {}

#[derive(Serialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub today: String,
    pub projects: Vec<ProjectBrief>,
    pub overdue: i64,
    pub due_today: i64,
    pub in_progress: i64,
}

/// Everything at a glance: the projects in view and how much is pressing.
pub fn overview(conn: &Connection, client: &McpClient) -> AppResult<Overview> {
    let day = today();
    let projects = visible_projects(conn, client, false)?;
    let ids: Vec<String> = projects.iter().map(|p| p.id.clone()).collect();
    let scoped = |q: tasks::TaskQuery| tasks::TaskQuery {
        project_ids: (!client.projects.is_empty()).then(|| ids.clone()),
        no_project: !client.projects.is_empty(),
        ..q
    };
    let overdue = tasks::query_tasks(conn, &scoped(tasks::TaskQuery { overdue_as_of: Some(day.clone()), ..Default::default() }))?;
    let due_today = tasks::query_tasks(
        conn,
        &scoped(tasks::TaskQuery { due_from: Some(day.clone()), due_to: Some(day.clone()), ..Default::default() }),
    )?;
    let in_progress =
        tasks::query_tasks(conn, &scoped(tasks::TaskQuery { statuses: Some(vec!["in_progress".into()]), ..Default::default() }))?;
    Ok(Overview {
        today: day,
        projects: projects.into_iter().map(project_brief).collect(),
        overdue: overdue.len() as i64,
        due_today: due_today.len() as i64,
        in_progress: in_progress.len() as i64,
    })
}

#[derive(Serialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Today {
    pub date: String,
    pub overdue: Vec<TaskBrief>,
    pub due_today: Vec<TaskBrief>,
    pub in_progress: Vec<TaskBrief>,
}

/// What today looks like: what's late, what's due and what's underway.
pub fn today_list(conn: &Connection, client: &McpClient) -> AppResult<Today> {
    let day = today();
    let names = Names::load(conn)?;
    let base = |q: tasks::TaskQuery| -> AppResult<Vec<TaskBrief>> {
        let rows = tasks::query_tasks(conn, &tasks::TaskQuery { limit: Some(50), top_level_only: true, ..q })?;
        Ok(rows
            .into_iter()
            .filter(|t| policy::visible(conn, client, t.project_id.as_deref()))
            .map(|t| names.task(&t))
            .collect())
    };
    Ok(Today {
        date: day.clone(),
        overdue: base(tasks::TaskQuery { overdue_as_of: Some(day.clone()), order: Some("due".into()), ..Default::default() })?,
        due_today: base(tasks::TaskQuery { due_from: Some(day.clone()), due_to: Some(day), order: Some("priority".into()), ..Default::default() })?,
        in_progress: base(tasks::TaskQuery { statuses: Some(vec!["in_progress".into()]), ..Default::default() })?,
    })
}

#[derive(Deserialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchArgs {
    /// What to look for. Words are matched as prefixes.
    pub query: String,
    /// Narrow the hunt: all (default), tasks, projects, notes.
    pub scope: Option<String>,
    /// How many hits to return (1–200, default 20).
    pub limit: Option<i64>,
}

#[derive(Serialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchHitBrief {
    pub kind: String,
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub snippet: String,
}

/// Full-text search across tasks, notes, projects and whiteboards.
pub fn search_all(conn: &Connection, client: &McpClient, args: &SearchArgs) -> AppResult<Vec<SearchHitBrief>> {
    let limit = clamp_limit(args.limit, 20);
    let hits = search::run(conn, &args.query, Some(limit), args.scope.as_deref())?;
    Ok(hits
        .into_iter()
        // Locked projects are already gone; this is the client's own allowlist.
        .filter(|h| client.projects.is_empty() || policy::visible(conn, client, search::owner_of(conn, h).as_deref()))
        .map(|h| SearchHitBrief { kind: h.kind, id: h.id, title: h.title, snippet: h.snippet })
        .collect())
}

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectListArgs {
    /// Include archived projects too.
    pub include_archived: bool,
}

pub fn project_list(conn: &Connection, client: &McpClient, args: &ProjectListArgs) -> AppResult<Vec<ProjectBrief>> {
    Ok(visible_projects(conn, client, args.include_archived)?.into_iter().map(project_brief).collect())
}

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskSearchArgs {
    pub project_id: Option<String>,
    /// todo | in_progress | blocked | completed
    pub status: Option<String>,
    /// Words to match in the title or description.
    pub query: Option<String>,
    /// Only tasks due on or before this day (YYYY-MM-DD).
    pub due_before: Option<String>,
    /// Only tasks due on or after this day (YYYY-MM-DD).
    pub due_after: Option<String>,
    /// Only tasks that are past their due date.
    pub overdue: bool,
    /// Include completed tasks (they are left out by default).
    pub include_completed: bool,
    /// How many to return (1–200, default 50).
    pub limit: Option<i64>,
}

pub fn task_search(conn: &Connection, client: &McpClient, args: &TaskSearchArgs) -> AppResult<Vec<TaskBrief>> {
    policy::ensure_project(conn, client, args.project_id.as_deref())?;
    let names = Names::load(conn)?;
    let q = tasks::TaskQuery {
        project_ids: args.project_id.clone().map(|p| vec![p]),
        statuses: args.status.clone().map(|s| vec![s]),
        search: args.query.clone(),
        due_from: args.due_after.clone(),
        due_to: args.due_before.clone(),
        overdue_as_of: args.overdue.then(today),
        include_completed: args.include_completed || args.status.as_deref() == Some("completed"),
        limit: Some(clamp_limit(args.limit, 50)),
        ..Default::default()
    };
    Ok(tasks::query_tasks(conn, &q)?
        .into_iter()
        .filter(|t| policy::visible(conn, client, t.project_id.as_deref()))
        .map(|t| names.task(&t))
        .collect())
}

#[derive(Deserialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IdArgs {
    pub id: String,
}

pub fn note_get(conn: &Connection, client: &McpClient, args: &IdArgs) -> AppResult<NoteBrief> {
    let note = notes::get_note(conn, &args.id)?;
    policy::ensure_project(conn, client, note.project_id.as_deref())?;
    Ok(note_brief(note, true))
}

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BoardListArgs {
    /// Leave out to list every board the assistant can see.
    pub project_id: Option<String>,
}

pub fn board_list(conn: &Connection, client: &McpClient, args: &BoardListArgs) -> AppResult<Vec<BoardBrief>> {
    let project_ids = match &args.project_id {
        Some(p) => {
            policy::ensure_project(conn, client, Some(p))?;
            vec![p.clone()]
        }
        None => visible_projects(conn, client, false)?.into_iter().map(|p| p.id).collect(),
    };
    let mut out = vec![];
    for id in project_ids {
        for b in boards::list_boards(conn, &id)? {
            out.push(board_brief(conn, b)?);
        }
    }
    Ok(out)
}

#[derive(Serialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LabelBrief {
    pub id: String,
    pub name: String,
    pub open_tasks: i64,
}

pub fn label_list(conn: &Connection, _client: &McpClient) -> AppResult<Vec<LabelBrief>> {
    Ok(labels::list(conn)?
        .into_iter()
        .map(|l| LabelBrief { id: l.id, name: l.name, open_tasks: l.task_count })
        .collect())
}

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ActivityArgs {
    pub project_id: Option<String>,
    /// How many entries (1–200, default 30).
    pub limit: Option<i64>,
}

#[derive(Serialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActivityBrief {
    pub what: String,
    pub action: String,
    pub summary: String,
    pub at: i64,
}

pub fn activity_recent(conn: &Connection, client: &McpClient, args: &ActivityArgs) -> AppResult<Vec<ActivityBrief>> {
    policy::ensure_project(conn, client, args.project_id.as_deref())?;
    Ok(activity::list(conn, args.project_id.as_deref(), Some(clamp_limit(args.limit, 30)), None)?
        .into_iter()
        .filter(|a| policy::visible(conn, client, a.project_id.as_deref()))
        .map(|a| ActivityBrief { what: a.entity_type, action: a.action, summary: a.summary, at: a.created_at })
        .collect())
}

// ------------------------------------------------------------ writing

#[derive(Deserialize, schemars::JsonSchema, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct NewTask {
    /// What needs doing. Required.
    pub title: String,
    /// Optional detail, as Markdown.
    pub description: Option<String>,
    pub project_id: Option<String>,
    /// todo (default) | in_progress | blocked | completed
    pub status: Option<String>,
    /// 0 none, 1 low, 2 medium, 3 high.
    pub priority: Option<i64>,
    /// Day it is due, YYYY-MM-DD in the user's own calendar.
    pub due_date: Option<String>,
    /// Time it is due, HH:MM.
    pub due_time: Option<String>,
    pub start_date: Option<String>,
    pub estimate_minutes: Option<i64>,
    /// Label names. Any that don't exist yet are created.
    pub labels: Option<Vec<String>>,
    /// Make this a subtask of an existing task.
    pub parent_id: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreateArgs {
    /// One or many. Creating a list in one call is cheaper than one at a time.
    pub tasks: Vec<NewTask>,
}

/// The most an assistant may create in one call.
const MAX_BATCH: usize = 100;

pub fn task_create(conn: &mut Connection, client: &McpClient, args: &TaskCreateArgs) -> AppResult<Vec<TaskBrief>> {
    if args.tasks.is_empty() {
        return invalid("Give at least one task to create.");
    }
    if args.tasks.len() > MAX_BATCH {
        return invalid(format!("That's more than {MAX_BATCH} tasks in one call. Send them in smaller batches."));
    }
    for t in &args.tasks {
        policy::ensure_project(conn, client, t.project_id.as_deref())?;
    }
    let tx = conn.transaction()?;
    let mut made = vec![];
    for t in &args.tasks {
        let label_ids = match &t.labels {
            Some(names) if !names.is_empty() => {
                let mut ids = vec![];
                for name in names {
                    ids.push(labels::ensure(&tx, name, None)?);
                }
                Some(ids)
            }
            _ => None,
        };
        let input = tasks::TaskInput {
            title: t.title.clone(),
            description: t.description.clone(),
            status: t.status.clone(),
            priority: t.priority,
            project_id: t.project_id.clone(),
            parent_id: t.parent_id.clone(),
            due_date: t.due_date.clone(),
            due_time: t.due_time.clone(),
            start_date: t.start_date.clone(),
            estimate_minutes: t.estimate_minutes,
            label_ids,
            ..Default::default()
        };
        made.push(tasks::create_task(&tx, &input)?);
    }
    tx.commit()?;
    let names = Names::load(conn)?;
    Ok(made.iter().map(|t| names.task(t)).collect())
}

#[derive(Deserialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdateArgs {
    pub id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    /// todo | in_progress | blocked | completed
    pub status: Option<String>,
    pub priority: Option<i64>,
    /// Move it to another project.
    pub project_id: Option<String>,
    /// YYYY-MM-DD. Send "none" to clear it.
    pub due_date: Option<String>,
    pub estimate_minutes: Option<i64>,
    /// Label names to add. Any that don't exist yet are created.
    pub add_labels: Option<Vec<String>>,
}

pub fn task_update(conn: &mut Connection, client: &McpClient, args: &TaskUpdateArgs) -> AppResult<TaskBrief> {
    let existing = tasks::get_task(conn, &args.id)?;
    policy::ensure_project(conn, client, existing.project_id.as_deref())?;
    policy::ensure_project(conn, client, args.project_id.as_deref())?;
    let tx = conn.transaction()?;
    let add_label_ids = match &args.add_labels {
        Some(names) if !names.is_empty() => {
            let mut ids = vec![];
            for name in names {
                ids.push(labels::ensure(&tx, name, None)?);
            }
            Some(ids)
        }
        _ => None,
    };
    let patch = tasks::TaskPatch {
        title: args.title.clone(),
        description: args.description.clone(),
        status: args.status.clone(),
        priority: args.priority,
        project_id: args.project_id.clone().map(Some),
        due_date: args.due_date.as_deref().map(|d| (d != "none").then(|| d.to_string())),
        estimate_minutes: args.estimate_minutes.map(Some),
        add_label_ids,
        ..Default::default()
    };
    tasks::update_task(&tx, &args.id, &patch)?;
    tx.commit()?;
    let names = Names::load(conn)?;
    Ok(names.task(&tasks::get_task(conn, &args.id)?))
}

#[derive(Deserialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IdsArgs {
    pub ids: Vec<String>,
}

#[derive(Serialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CountResult {
    pub count: usize,
    pub message: String,
}

pub fn task_complete(conn: &mut Connection, client: &McpClient, args: &IdsArgs) -> AppResult<CountResult> {
    if args.ids.is_empty() || args.ids.len() > MAX_BATCH {
        return invalid(format!("Give between 1 and {MAX_BATCH} task ids."));
    }
    for id in &args.ids {
        let t = tasks::get_task(conn, id)?;
        policy::ensure_project(conn, client, t.project_id.as_deref())?;
    }
    let tx = conn.transaction()?;
    let patch = tasks::TaskPatch { status: Some("completed".into()), ..Default::default() };
    for id in &args.ids {
        tasks::update_task(&tx, id, &patch)?;
    }
    tx.commit()?;
    Ok(CountResult { count: args.ids.len(), message: format!("Completed {} task(s).", args.ids.len()) })
}

/// Deleting means Trash, here as everywhere else: the user can put it back.
pub fn task_delete(conn: &mut Connection, client: &McpClient, args: &IdsArgs) -> AppResult<CountResult> {
    if args.ids.is_empty() || args.ids.len() > MAX_BATCH {
        return invalid(format!("Give between 1 and {MAX_BATCH} task ids."));
    }
    for id in &args.ids {
        let t = tasks::get_task(conn, id)?;
        policy::ensure_project(conn, client, t.project_id.as_deref())?;
    }
    let tx = conn.transaction()?;
    tasks::soft_delete(&tx, &args.ids)?;
    tx.commit()?;
    Ok(CountResult {
        count: args.ids.len(),
        message: format!("Moved {} task(s) to Trash, where they can be restored.", args.ids.len()),
    })
}

#[derive(Deserialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteCreateArgs {
    pub title: String,
    /// The body, as Markdown.
    pub content: String,
    pub project_id: Option<String>,
}

/// The most Markdown an assistant may write into one note.
const MAX_NOTE_CHARS: usize = 200_000;

pub fn note_create(conn: &Connection, client: &McpClient, args: &NoteCreateArgs) -> AppResult<NoteBrief> {
    policy::ensure_project(conn, client, args.project_id.as_deref())?;
    if args.content.chars().count() > MAX_NOTE_CHARS {
        return invalid("That note is too long. Split it into several.");
    }
    let note = notes::create_note(conn, &args.title, &args.content, args.project_id.as_deref())?;
    Ok(note_brief(note, false))
}

#[derive(Deserialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdateArgs {
    pub id: String,
    pub title: Option<String>,
    /// Replaces the whole body. Use `append` to add to it instead.
    pub content: Option<String>,
    /// Markdown added to the end of the note, on a new line.
    pub append: Option<String>,
}

pub fn note_update(conn: &mut Connection, client: &McpClient, args: &NoteUpdateArgs) -> AppResult<NoteBrief> {
    let existing = notes::get_note(conn, &args.id)?;
    policy::ensure_project(conn, client, existing.project_id.as_deref())?;
    if args.content.is_some() && args.append.is_some() {
        return invalid("Send either `content` or `append`, not both.");
    }
    let content = match (&args.content, &args.append) {
        (Some(c), _) => Some(c.clone()),
        (_, Some(a)) => Some(format!("{}\n\n{}", existing.content.trim_end(), a.trim())),
        _ => None,
    };
    if content.as_ref().is_some_and(|c| c.chars().count() > MAX_NOTE_CHARS) {
        return invalid("That note is too long. Split it into several.");
    }
    let patch = notes::NotePatch { title: args.title.clone(), content, ..Default::default() };
    let note = notes::update_note(conn, &args.id, &patch)?;
    Ok(note_brief(note, false))
}

#[derive(Deserialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BoardCreateArgs {
    pub project_id: String,
    pub name: String,
    /// Column names, left to right. Defaults to the project's usual set.
    pub columns: Option<Vec<String>>,
}

pub fn board_create(conn: &mut Connection, client: &McpClient, args: &BoardCreateArgs) -> AppResult<BoardBrief> {
    policy::ensure_project(conn, client, Some(&args.project_id))?;
    let columns = match &args.columns {
        Some(names) if !names.is_empty() => names
            .iter()
            .map(|n| boards::ColumnTemplate { name: n.trim().to_string(), status: None })
            .collect(),
        _ => boards::default_columns(conn),
    };
    let tx = conn.transaction()?;
    let board = boards::create_board(&tx, &args.project_id, &args.name, &columns)?;
    tx.commit()?;
    board_brief(conn, board)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::mcp::clients;
    use crate::domain::projects::{create_project, ProjectInput};
    use crate::domain::settings;
    use crate::domain::tasks::TaskInput;
    use serde_json::json;

    fn db() -> Connection {
        let c = open_memory();
        settings::set(&c, "mcp.enabled", &json!(true)).unwrap();
        c
    }

    fn client(c: &Connection, scope: &str) -> McpClient {
        let cl = clients::register(c, "Claude Code").unwrap();
        clients::set_status(c, &cl.id, clients::APPROVED).unwrap();
        clients::set_scope(c, &cl.id, scope).unwrap()
    }

    fn project(c: &Connection, name: &str) -> String {
        create_project(c, &ProjectInput { name: name.into(), ..Default::default() }).unwrap().id
    }

    /// A lock as the gate reads it: a passkey on this computer (without one,
    /// locks are inert) and the project's own `locked_at`. `set_lock` is
    /// private to `passkeys`, and nothing here needs to open one again.
    fn lock(c: &Connection, project_id: &str) {
        c.execute(
            "INSERT OR IGNORE INTO passkeys(id, label, credential_id, kind, created_at)
             VALUES ('p1', 'This computer', 'Y3JlZA', 'platform', 1)",
            [],
        )
        .unwrap();
        c.execute("UPDATE projects SET locked_at = 1 WHERE id = ?1", [project_id]).unwrap();
    }

    fn task(c: &Connection, title: &str, project_id: Option<&str>) -> String {
        tasks::create_task(c, &TaskInput { title: title.into(), project_id: project_id.map(str::to_string), ..Default::default() })
            .unwrap()
            .id
    }

    /// `TaskUpdateArgs` has no `Default` - every field but the id is a
    /// deliberate change - so this is the empty patch for the tests.
    fn update_args(id: &str) -> TaskUpdateArgs {
        TaskUpdateArgs {
            id: id.to_string(),
            title: None,
            description: None,
            status: None,
            priority: None,
            project_id: None,
            due_date: None,
            estimate_minutes: None,
            add_labels: None,
        }
    }

    /// Every tool in the surface, pointed at a locked project. This is the
    /// test that must not rot: a new tool belongs in this list, and a tool
    /// that forgets to ask `policy` fails here.
    #[test]
    fn a_locked_project_is_invisible_to_every_tool() {
        let c = &mut db();
        let id = project(c, "Mini Reactors");
        let cl = client(c, "write");
        let t = task(c, "Shield check", Some(&id));
        let note = notes::create_note(c, "Coolant notes", "Flow rates", Some(&id)).unwrap().id;
        boards::create_board(c, &id, "Build", &boards::default_columns(c)).unwrap();

        // Reachable to begin with, or the assertions below prove nothing.
        assert!(project_list(c, &cl, &ProjectListArgs::default()).unwrap().iter().any(|p| p.id == id));
        assert!(task_search(c, &cl, &TaskSearchArgs::default()).unwrap().iter().any(|x| x.id == t));
        assert!(note_get(c, &cl, &IdArgs { id: note.clone() }).is_ok());
        assert!(board_list(c, &cl, &BoardListArgs::default()).unwrap().iter().any(|b| b.name == "Build"));
        assert!(!search_all(c, &cl, &SearchArgs { query: "shield".into(), scope: None, limit: None }).unwrap().is_empty());

        lock(c, &id);

        // Reads: the project, and everything inside it, is simply not there.
        assert!(!project_list(c, &cl, &ProjectListArgs::default()).unwrap().iter().any(|p| p.id == id));
        assert!(!project_list(c, &cl, &ProjectListArgs { include_archived: true }).unwrap().iter().any(|p| p.id == id));
        assert!(!overview(c, &cl).unwrap().projects.iter().any(|p| p.id == id));
        let today = today_list(c, &cl).unwrap();
        assert!(![today.overdue, today.due_today, today.in_progress].concat().iter().any(|x| x.id == t));
        assert!(task_search(c, &cl, &TaskSearchArgs::default()).unwrap().is_empty());
        assert!(task_search(c, &cl, &TaskSearchArgs { project_id: Some(id.clone()), ..Default::default() }).is_err());
        assert!(note_get(c, &cl, &IdArgs { id: note.clone() }).is_err());
        assert!(board_list(c, &cl, &BoardListArgs::default()).unwrap().is_empty());
        assert!(board_list(c, &cl, &BoardListArgs { project_id: Some(id.clone()) }).is_err());
        assert!(search_all(c, &cl, &SearchArgs { query: "shield".into(), scope: None, limit: None }).unwrap().is_empty());
        assert!(search_all(c, &cl, &SearchArgs { query: "coolant".into(), scope: None, limit: None }).unwrap().is_empty());
        assert!(activity_recent(c, &cl, &ActivityArgs { project_id: Some(id.clone()), limit: None }).is_err());
        assert!(activity_recent(c, &cl, &ActivityArgs::default()).unwrap().iter().all(|a| !a.summary.contains("Shield")));

        // Writes: nothing may be added to it or changed inside it.
        let new_task = TaskCreateArgs { tasks: vec![NewTask { title: "Melt down".into(), project_id: Some(id.clone()), ..Default::default() }] };
        assert!(task_create(c, &cl, &new_task).is_err());
        assert!(task_update(c, &cl, &TaskUpdateArgs { title: Some("Renamed".into()), ..update_args(&t) }).is_err());
        assert!(task_complete(c, &cl, &IdsArgs { ids: vec![t.clone()] }).is_err());
        assert!(task_delete(c, &cl, &IdsArgs { ids: vec![t] }).is_err());
        assert!(note_create(c, &cl, &NoteCreateArgs { title: "New".into(), content: "x".into(), project_id: Some(id.clone()) }).is_err());
        assert!(note_update(c, &cl, &NoteUpdateArgs { id: note, title: None, content: Some("Rewritten".into()), append: None }).is_err());
        assert!(board_create(c, &cl, &BoardCreateArgs { project_id: id.clone(), name: "Another".into(), columns: None }).is_err());
        // Moving a task *into* a locked project is a write to it too.
        let loose = task(c, "Buy milk", None);
        assert!(task_update(c, &cl, &TaskUpdateArgs { project_id: Some(id), ..update_args(&loose) }).is_err());
    }

    #[test]
    fn the_allowlist_hides_every_other_project() {
        let c = &mut db();
        let mine = project(c, "Website Redesign");
        let theirs = project(c, "Mini Reactors");
        let hidden = task(c, "Shield check", Some(&theirs));
        let cl = client(c, "write");
        let cl = clients::set_projects(c, &cl.id, &[mine.clone()]).unwrap();

        let listed = project_list(c, &cl, &ProjectListArgs::default()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, mine);
        assert!(task_search(c, &cl, &TaskSearchArgs::default()).unwrap().iter().all(|t| t.id != hidden));
        assert!(task_search(c, &cl, &TaskSearchArgs { project_id: Some(theirs.clone()), ..Default::default() }).is_err());
        assert!(search_all(c, &cl, &SearchArgs { query: "shield".into(), scope: None, limit: None }).unwrap().is_empty());
        assert!(board_create(c, &cl, &BoardCreateArgs { project_id: theirs.clone(), name: "Build".into(), columns: None }).is_err());
        let into_theirs = TaskCreateArgs { tasks: vec![NewTask { title: "Melt down".into(), project_id: Some(theirs), ..Default::default() }] };
        assert!(task_create(c, &cl, &into_theirs).is_err());

        // The allowed project still works, as does a task belonging to nobody.
        let into_mine = TaskCreateArgs { tasks: vec![NewTask { title: "Hero image".into(), project_id: Some(mine), ..Default::default() }] };
        assert!(task_create(c, &cl, &into_mine).is_ok());
        let loose = TaskCreateArgs { tasks: vec![NewTask { title: "Buy milk".into(), ..Default::default() }] };
        assert!(task_create(c, &cl, &loose).is_ok());
    }

    #[test]
    fn a_batch_of_tasks_arrives_whole_with_its_labels() {
        let c = &mut db();
        let id = project(c, "Website Redesign");
        let cl = client(c, "write");
        let args = TaskCreateArgs {
            tasks: vec![
                NewTask {
                    title: "Wireframes".into(),
                    project_id: Some(id.clone()),
                    due_date: Some("2026-11-02".into()),
                    labels: Some(vec!["design".into()]),
                    ..Default::default()
                },
                NewTask {
                    title: "Copy".into(),
                    project_id: Some(id.clone()),
                    priority: Some(3),
                    labels: Some(vec!["design".into(), "words".into()]),
                    ..Default::default()
                },
            ],
        };
        let made = task_create(c, &cl, &args).unwrap();
        assert_eq!(made.len(), 2);
        assert_eq!(made[0].project.as_deref(), Some("Website Redesign"));
        assert_eq!(made[0].due_date.as_deref(), Some("2026-11-02"));
        assert_eq!(made[1].labels, vec!["design".to_string(), "words".to_string()]);
        // The label was made once and reused, not once per task.
        assert_eq!(labels::list(c).unwrap().len(), 2);

        // One bad task in the batch leaves nothing behind.
        let bad = TaskCreateArgs {
            tasks: vec![
                NewTask { title: "Fine".into(), project_id: Some(id.clone()), ..Default::default() },
                NewTask { title: "Broken".into(), project_id: Some(id), due_date: Some("the third".into()), ..Default::default() },
            ],
        };
        assert!(task_create(c, &cl, &bad).is_err());
        assert!(task_search(c, &cl, &TaskSearchArgs::default()).unwrap().iter().all(|t| t.title != "Fine"));
    }

    #[test]
    fn deleting_means_trash() {
        let c = &mut db();
        let cl = client(c, "write");
        let t = task(c, "Shield check", None);
        task_delete(c, &cl, &IdsArgs { ids: vec![t.clone()] }).unwrap();
        assert!(task_search(c, &cl, &TaskSearchArgs::default()).unwrap().is_empty());
        let trashed = crate::domain::trash::list(c).unwrap();
        assert!(trashed.iter().any(|i| i.id == t), "an assistant's delete is recoverable");
    }

    #[test]
    fn a_note_is_appended_to_rather_than_rewritten() {
        let c = &mut db();
        let cl = client(c, "write");
        let note = note_create(c, &cl, &NoteCreateArgs { title: "Coolant".into(), content: "# Flow\n\nSteady.".into(), project_id: None }).unwrap();
        let append = NoteUpdateArgs { id: note.id.clone(), title: None, content: None, append: Some("## Day two\n\nStill steady.".into()) };
        note_update(c, &cl, &append).unwrap();
        let body = note_get(c, &cl, &IdArgs { id: note.id.clone() }).unwrap().content.unwrap();
        assert!(body.starts_with("# Flow"), "the original body is kept");
        assert!(body.ends_with("Still steady."));
        // The two are alternatives, and sending both is a mistake worth saying.
        let both = NoteUpdateArgs { id: note.id, title: None, content: Some("x".into()), append: Some("y".into()) };
        assert!(note_update(c, &cl, &both).is_err());
    }

    #[test]
    fn a_board_is_created_with_the_columns_asked_for() {
        let c = &mut db();
        let id = project(c, "Website Redesign");
        let cl = client(c, "write");
        let args = BoardCreateArgs {
            project_id: id.clone(),
            name: "Launch".into(),
            columns: Some(vec!["Ideas".into(), "Doing".into(), "Shipped".into()]),
        };
        let board = board_create(c, &cl, &args).unwrap();
        assert_eq!(board.columns.iter().map(|col| col.name.as_str()).collect::<Vec<_>>(), ["Ideas", "Doing", "Shipped"]);
        assert!(board_list(c, &cl, &BoardListArgs { project_id: Some(id) }).unwrap().iter().any(|b| b.id == board.id));
    }

    #[test]
    fn answers_stay_small_and_carry_names() {
        let c = &mut db();
        let id = project(c, "Website Redesign");
        let cl = client(c, "write");
        let args = TaskCreateArgs {
            tasks: vec![NewTask { title: "Wireframes".into(), project_id: Some(id), labels: Some(vec!["design".into()]), ..Default::default() }],
        };
        task_create(c, &cl, &args).unwrap();
        let brief = &task_search(c, &cl, &TaskSearchArgs::default()).unwrap()[0];
        assert_eq!(brief.project.as_deref(), Some("Website Redesign"), "a name, so no second call is needed");
        assert_eq!(brief.labels, vec!["design".to_string()]);
        let json = serde_json::to_value(brief).unwrap();
        assert!(json.get("createdAt").is_none(), "timestamps and sort orders are not worth the tokens");
        assert!(json.get("sortOrder").is_none());
    }

    #[test]
    fn a_limit_an_assistant_asks_for_is_clamped() {
        assert_eq!(clamp_limit(None, 20), 20);
        assert_eq!(clamp_limit(Some(0), 20), 1);
        assert_eq!(clamp_limit(Some(10_000), 20), 200);
    }
}
