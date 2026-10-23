// @Author Christian Relf
// @Date 2026-10-22

//! What an assistant can actually do, as plain functions on a connection.
//!
//! Each tool is a parameter struct (whose JSON Schema the model is shown) and
//! a function taking `&Connection` and the calling client. Nothing here opens
//! a socket or knows about rmcp — `server.rs` wires these up, and these are
//! what the tests drive.
//!
//! Three rules hold throughout:
//!
//! - **Ask `policy` before touching a project.** Every function that takes or
//!   returns a project id calls `ensure_project` or filters with `visible`.
//! - **Answer small.** The model pays for every field, so these return brief
//!   shapes with names in them (project names, label names), not the internal
//!   records with their ids, sort orders and timestamps.
//! - **A write says how to undo itself.** Every write returns `Wrote<T>`,
//!   whose second half is the batch's revert plan (`revert.rs`).

use crate::domain::mcp::clients::McpClient;
use crate::domain::mcp::revert::{self, Step, Touched};
use crate::domain::mcp::{mermaid, policy};
use crate::domain::{activity, boards, labels, milestones, notes, projects, search, tasks, templates, whiteboards};
use crate::error::{invalid, AppError, AppResult};
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

#[derive(Serialize, schemars::JsonSchema, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneBrief {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_date: Option<String>,
    /// planned | active | completed | cancelled
    pub status: String,
    pub open_tasks: i64,
    pub done_tasks: i64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub overdue: bool,
}

fn milestone_brief(m: milestones::Milestone) -> MilestoneBrief {
    MilestoneBrief {
        id: m.id,
        title: m.title,
        description: m.description,
        target_date: m.target_date,
        status: m.status,
        open_tasks: m.task_total - m.task_done,
        done_tasks: m.task_done,
        overdue: m.overdue,
    }
}

#[derive(Deserialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIdArgs {
    pub project_id: String,
}

pub fn milestone_list(conn: &Connection, client: &McpClient, args: &ProjectIdArgs) -> AppResult<Vec<MilestoneBrief>> {
    policy::ensure_project(conn, client, Some(&args.project_id))?;
    Ok(milestones::list(conn, &args.project_id)?.into_iter().map(milestone_brief).collect())
}

#[derive(Serialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDigest {
    pub project: ProjectBrief,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub boards: Vec<BoardBrief>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub milestones: Vec<MilestoneBrief>,
    /// Open tasks, soonest first.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tasks: Vec<TaskBrief>,
    /// Titles only; read one with kern_note_get.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<NoteBrief>,
}

/// One project and everything on it worth a sentence — the shape behind both
/// `kern_project_get` and the `kern://project/{id}` resource, so an assistant
/// can orient itself in a project in one go rather than five.
pub fn project_get(conn: &Connection, client: &McpClient, args: &IdArgs) -> AppResult<ProjectDigest> {
    policy::ensure_project(conn, client, Some(&args.id))?;
    let names = Names::load(conn)?;
    let project = projects::get_project(conn, &args.id)?;
    let mut boards = vec![];
    for b in boards::list_boards(conn, &args.id)? {
        boards.push(board_brief(conn, b)?);
    }
    let q = tasks::TaskQuery {
        project_ids: Some(vec![args.id.clone()]),
        top_level_only: true,
        order: Some("due".into()),
        limit: Some(100),
        ..Default::default()
    };
    Ok(ProjectDigest {
        project: project_brief(project),
        boards,
        milestones: milestones::list(conn, &args.id)?.into_iter().map(milestone_brief).collect(),
        tasks: tasks::query_tasks(conn, &q)?.iter().map(|t| names.task(t)).collect(),
        notes: notes::list(conn, Some(&args.id), false)?
            .into_iter()
            .map(|n| NoteBrief { id: n.id, title: n.title, project_id: n.project_id, content: None })
            .collect(),
    })
}

#[derive(Serialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WhiteboardBrief {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub objects: i64,
}

pub fn whiteboard_list(conn: &Connection, client: &McpClient, args: &BoardListArgs) -> AppResult<Vec<WhiteboardBrief>> {
    policy::ensure_project(conn, client, args.project_id.as_deref())?;
    let names = Names::load(conn)?;
    Ok(whiteboards::list(conn, args.project_id.as_deref())?
        .into_iter()
        .filter(|w| policy::visible(conn, client, w.project_id.as_deref()))
        .map(|w| WhiteboardBrief {
            project: w.project_id.as_ref().and_then(|p| names.projects.get(p).cloned()),
            id: w.id,
            name: w.name,
            project_id: w.project_id,
            objects: w.node_count,
        })
        .collect())
}

#[derive(Serialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WhiteboardMermaid {
    pub name: String,
    /// The board as Mermaid `flowchart` text.
    pub mermaid: String,
    pub included: usize,
    /// Objects with no Mermaid equivalent — drawings, images, loose lines —
    /// which were left out rather than guessed at.
    pub skipped: usize,
}

pub fn whiteboard_to_mermaid(conn: &Connection, client: &McpClient, args: &IdArgs) -> AppResult<WhiteboardMermaid> {
    let wb = whiteboards::get(conn, &args.id)?;
    policy::ensure_project(conn, client, wb.project_id.as_deref())?;
    let nodes = whiteboards::nodes(conn, &args.id)?;
    let edges = whiteboards::edges(conn, &args.id)?;
    let out = mermaid::to_mermaid(&nodes, &edges, mermaid::Direction::Tb);
    Ok(WhiteboardMermaid { name: wb.name, mermaid: out.text, included: out.included, skipped: out.skipped })
}

// ------------------------------------------------------------ finding things

/// The project an assistant named, by id or by name. Prompts take a name
/// because that is what someone types into the prompt picker.
pub fn find_project(conn: &Connection, client: &McpClient, needle: &str) -> AppResult<projects::Project> {
    let needle = needle.trim();
    if needle.is_empty() {
        return invalid("Name a project.");
    }
    if let Ok(p) = projects::get_project(conn, needle) {
        policy::ensure_project(conn, client, Some(&p.id))?;
        return Ok(p);
    }
    visible_projects(conn, client, true)?
        .into_iter()
        .find(|p| p.name.eq_ignore_ascii_case(needle))
        .ok_or_else(|| AppError::NotFound(format!("Project '{needle}'")))
}

/// The note an assistant named, by id or by title.
pub fn find_note(conn: &Connection, client: &McpClient, needle: &str) -> AppResult<notes::Note> {
    let needle = needle.trim();
    if needle.is_empty() {
        return invalid("Name a note.");
    }
    if let Ok(n) = notes::get_note(conn, needle) {
        policy::ensure_project(conn, client, n.project_id.as_deref())?;
        return Ok(n);
    }
    let found = notes::list(conn, None, false)?
        .into_iter()
        .filter(|n| policy::visible(conn, client, n.project_id.as_deref()))
        .find(|n| n.title.eq_ignore_ascii_case(needle))
        .ok_or_else(|| AppError::NotFound(format!("Note '{needle}'")))?;
    notes::get_note(conn, &found.id)
}

// ------------------------------------------------------------ writing

/// A write's answer, and what it would take to put it back.
///
/// Every write tool returns one. `server.rs` stores the `undo` half with the
/// call's audit row, and **Revert this batch** in the Assistants tab replays
/// it. An empty plan means the call can't be put back, and the tab says so
/// rather than offering a button that does nothing.
#[derive(Debug)]
pub struct Wrote<T> {
    pub value: T,
    pub undo: Vec<Step>,
}

fn wrote<T>(value: T, undo: Vec<Step>) -> AppResult<Wrote<T>> {
    Ok(Wrote { value, undo })
}

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

pub fn task_create(conn: &mut Connection, client: &McpClient, args: &TaskCreateArgs) -> AppResult<Wrote<Vec<TaskBrief>>> {
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
    // Reverting takes the tasks away again. Any label the batch had to create
    // on the way stays: a label is shared, costs nothing, and by then may be
    // on something else.
    let undo = vec![Step::TrashTasks { ids: made.iter().map(|t| t.id.clone()).collect() }];
    wrote(made.iter().map(|t| names.task(t)).collect(), undo)
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

pub fn task_update(conn: &mut Connection, client: &McpClient, args: &TaskUpdateArgs) -> AppResult<Wrote<TaskBrief>> {
    let existing = tasks::get_task(conn, &args.id)?;
    policy::ensure_project(conn, client, existing.project_id.as_deref())?;
    policy::ensure_project(conn, client, args.project_id.as_deref())?;
    // Moving a task to another project drops its place on the old board, so
    // the column counts as changed whenever the project does.
    let touched = Touched {
        title: args.title.is_some(),
        description: args.description.is_some(),
        status: args.status.is_some(),
        priority: args.priority.is_some(),
        project_id: args.project_id.is_some(),
        column_id: args.project_id.is_some(),
        due_date: args.due_date.is_some(),
        estimate_minutes: args.estimate_minutes.is_some(),
        labels: args.add_labels.is_some(),
        ..Default::default()
    };
    let undo = vec![Step::TaskWas { id: args.id.clone(), fields: revert::TaskFields::of(&existing, &touched) }];
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
    wrote(names.task(&tasks::get_task(conn, &args.id)?), undo)
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

pub fn task_complete(conn: &mut Connection, client: &McpClient, args: &IdsArgs) -> AppResult<Wrote<CountResult>> {
    if args.ids.is_empty() || args.ids.len() > MAX_BATCH {
        return invalid(format!("Give between 1 and {MAX_BATCH} task ids."));
    }
    // Reverting puts each task back on the status it was on, which for a
    // recurring task is not the same as un-spawning its next occurrence: that
    // one is a task of its own by then. See `revert.rs`.
    let touched = Touched { status: true, column_id: true, resolution: true, ..Default::default() };
    let mut undo = vec![];
    for id in &args.ids {
        let t = tasks::get_task(conn, id)?;
        policy::ensure_project(conn, client, t.project_id.as_deref())?;
        undo.push(Step::TaskWas { id: id.clone(), fields: revert::TaskFields::of(&t, &touched) });
    }
    let tx = conn.transaction()?;
    let patch = tasks::TaskPatch { status: Some("completed".into()), ..Default::default() };
    for id in &args.ids {
        tasks::update_task(&tx, id, &patch)?;
    }
    tx.commit()?;
    wrote(CountResult { count: args.ids.len(), message: format!("Completed {} task(s).", args.ids.len()) }, undo)
}

/// Deleting means Trash, here as everywhere else: the user can put it back.
pub fn task_delete(conn: &mut Connection, client: &McpClient, args: &IdsArgs) -> AppResult<Wrote<CountResult>> {
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
    wrote(
        CountResult {
            count: args.ids.len(),
            message: format!("Moved {} task(s) to Trash, where they can be restored.", args.ids.len()),
        },
        vec![Step::RestoreTasks { ids: args.ids.clone() }],
    )
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

pub fn note_create(conn: &Connection, client: &McpClient, args: &NoteCreateArgs) -> AppResult<Wrote<NoteBrief>> {
    policy::ensure_project(conn, client, args.project_id.as_deref())?;
    if args.content.chars().count() > MAX_NOTE_CHARS {
        return invalid("That note is too long. Split it into several.");
    }
    let note = notes::create_note(conn, &args.title, &args.content, args.project_id.as_deref())?;
    let undo = vec![Step::TrashNotes { ids: vec![note.id.clone()] }];
    wrote(note_brief(note, false), undo)
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

pub fn note_update(conn: &mut Connection, client: &McpClient, args: &NoteUpdateArgs) -> AppResult<Wrote<NoteBrief>> {
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
    let undo = vec![Step::NoteWas {
        id: existing.id.clone(),
        title: existing.title.clone(),
        content: existing.content.clone(),
    }];
    let patch = notes::NotePatch { title: args.title.clone(), content, ..Default::default() };
    let note = notes::update_note(conn, &args.id, &patch)?;
    wrote(note_brief(note, false), undo)
}

#[derive(Deserialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BoardCreateArgs {
    pub project_id: String,
    pub name: String,
    /// Column names, left to right. Defaults to the project's usual set.
    pub columns: Option<Vec<String>>,
}

pub fn board_create(conn: &mut Connection, client: &McpClient, args: &BoardCreateArgs) -> AppResult<Wrote<BoardBrief>> {
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
    let undo = vec![Step::DeleteBoards { ids: vec![board.id.clone()] }];
    wrote(board_brief(conn, board)?, undo)
}

// ------------------------------------------------------ setting up a project

// `kern_project_setup` is the one tool that earns a whole plan in a single
// call, and it is `templates.rs` wearing a different hat: a project template
// is already boards with columns, milestones, scheduled tasks with checklists
// and notes, and `create_project_from` already instantiates one in a single
// transaction. These structs are the model-facing shape of that document —
// a mirror rather than the thing itself, so that a field Kern adds for its
// own templates doesn't silently become something an assistant can set, and
// so each field can say what it means to someone who has never seen Kern.
//
// Dates are offsets in days from `startDate`, exactly as a template stores
// them, because "day 0, day 14, day 28" is how a plan is actually described.

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewColumn {
    pub name: String,
    /// What a task dropped here becomes: todo | in_progress | blocked | completed.
    pub status: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewBoard {
    pub name: String,
    /// Columns, left to right. Leave empty for the usual set.
    pub columns: Vec<NewColumn>,
}

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewMilestone {
    /// A short handle — "beta", "launch" — that tasks below point at. Required.
    pub key: String,
    pub title: String,
    pub description: Option<String>,
    /// Days after the start date. 0 is the start day itself.
    pub offset_days: Option<i64>,
    /// Mark it as a software release.
    pub is_release: bool,
}

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PlannedTask {
    /// What needs doing. Required.
    pub title: String,
    pub description: Option<String>,
    /// todo (default) | in_progress | blocked
    pub status: Option<String>,
    /// 0 none, 1 low, 2 medium, 3 high.
    pub priority: i64,
    /// Which board, by position in `boards` (0 is the first).
    pub board: Option<usize>,
    /// The name of a column on that board.
    pub column: Option<String>,
    /// Label names. Any that don't exist yet are created.
    pub labels: Vec<String>,
    /// Days after the start date, for the due date.
    pub due_offset: Option<i64>,
    pub estimate_minutes: Option<i64>,
    /// The `key` of one of the milestones above.
    pub milestone: Option<String>,
    /// Steps, as a checklist under this task.
    pub subtasks: Vec<String>,
}

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NewNote {
    pub title: String,
    /// The body, as Markdown.
    pub content: String,
}

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectSetupArgs {
    /// What the project is called. Required.
    pub name: String,
    pub description: Option<String>,
    /// The day the plan starts, YYYY-MM-DD. Defaults to today, and every
    /// offset below counts from it.
    pub start_date: Option<String>,
    /// Days after the start for the project's own target date.
    pub target_offset: Option<i64>,
    /// Boards and their columns. The first replaces the project's default one.
    pub boards: Vec<NewBoard>,
    pub milestones: Vec<NewMilestone>,
    pub tasks: Vec<PlannedTask>,
    pub notes: Vec<NewNote>,
}

fn task_doc(t: &PlannedTask) -> templates::TaskDoc {
    templates::TaskDoc {
        title: t.title.clone(),
        description: t.description.clone().unwrap_or_default(),
        status: t.status.clone(),
        priority: t.priority,
        board: t.board,
        column: t.column.clone(),
        labels: t.labels.clone(),
        due_offset: t.due_offset,
        estimate_minutes: t.estimate_minutes,
        milestone: t.milestone.clone(),
        recurrence: None,
        subtasks: t
            .subtasks
            .iter()
            .map(|s| templates::TaskDoc { title: s.clone(), ..Default::default() })
            .collect(),
    }
}

fn project_doc(args: &ProjectSetupArgs) -> templates::ProjectDoc {
    templates::ProjectDoc {
        description: args.description.clone().unwrap_or_default(),
        target_offset: args.target_offset,
        boards: args
            .boards
            .iter()
            .map(|b| templates::BoardDoc {
                name: b.name.clone(),
                columns: b
                    .columns
                    .iter()
                    .map(|c| boards::ColumnTemplate { name: c.name.trim().to_string(), status: c.status.clone() })
                    .collect(),
            })
            .collect(),
        milestones: args
            .milestones
            .iter()
            .map(|m| templates::MilestoneDoc {
                key: m.key.clone(),
                title: m.title.clone(),
                description: m.description.clone().unwrap_or_default(),
                offset_days: m.offset_days,
                is_release: m.is_release,
            })
            .collect(),
        tasks: args.tasks.iter().map(task_doc).collect(),
        notes: args.notes.iter().map(|n| templates::NoteDoc { title: n.title.clone(), content: n.content.clone() }).collect(),
        ..Default::default()
    }
}

/// A whole project — boards, milestones, scheduled tasks, notes — in one
/// transaction. Either all of it arrives or none of it does.
pub fn project_setup(conn: &mut Connection, client: &McpClient, args: &ProjectSetupArgs) -> AppResult<Wrote<ProjectDigest>> {
    policy::ensure_may_create_project(conn, client)?;
    let total: usize = args.tasks.iter().map(|t| 1 + t.subtasks.len()).sum();
    if total > MAX_BATCH {
        return invalid(format!(
            "That's {total} tasks in one project. Set the project up with the first {MAX_BATCH} and add the rest with kern_task_create."
        ));
    }
    if args.notes.iter().any(|n| n.content.chars().count() > MAX_NOTE_CHARS) {
        return invalid("One of those notes is too long. Split it into several.");
    }
    let doc = project_doc(args);
    let input = templates::UseProject {
        name: args.name.clone(),
        start_date: args.start_date.clone(),
        ..Default::default()
    };
    let tx = conn.transaction()?;
    let project = templates::create_project_from(&tx, &doc, &input)?;
    tx.commit()?;
    // One call, one thing to put back: the project takes its boards,
    // milestones, tasks and notes with it, as it does from the Trash.
    let undo = vec![Step::TrashProjects { ids: vec![project.id.clone()] }];
    wrote(project_get(conn, client, &IdArgs { id: project.id })?, undo)
}

// ---------------------------------------------------- changing a project

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectUpdateArgs {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    /// The day the project is aimed at, YYYY-MM-DD. Send "none" to clear it.
    pub target_date: Option<String>,
    /// Put the project away, or bring it back. An archived project is still
    /// there; it just stays out of the way.
    pub archived: Option<bool>,
}

pub fn project_update(conn: &Connection, client: &McpClient, args: &ProjectUpdateArgs) -> AppResult<Wrote<ProjectBrief>> {
    policy::ensure_project(conn, client, Some(&args.id))?;
    if args.name.is_none() && args.description.is_none() && args.target_date.is_none() && args.archived.is_none() {
        return invalid("Nothing to change. Give a name, a description, a target date or archived.");
    }
    let existing = projects::get_project(conn, &args.id)?;
    let undo = vec![Step::ProjectWas {
        id: args.id.clone(),
        fields: revert::ProjectFields {
            name: args.name.as_ref().map(|_| existing.name.clone()),
            description: args.description.as_ref().map(|_| existing.description.clone()),
            target_date: args.target_date.as_ref().map(|_| existing.target_date.clone()),
            archived: args.archived.map(|_| existing.archived_at.is_some()),
        },
    }];
    let patch = projects::ProjectPatch {
        name: args.name.clone(),
        description: args.description.clone(),
        target_date: args.target_date.as_deref().map(|d| (d != "none").then(|| d.to_string())),
        archived: args.archived,
        ..Default::default()
    };
    wrote(project_brief(projects::update_project(conn, &args.id, &patch)?), undo)
}

// ------------------------------------------------------------ moving tasks

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskMoveArgs {
    /// The tasks to move.
    pub ids: Vec<String>,
    /// The project they should end up in. Send "none" to take them out of
    /// whichever project they are in and leave them loose.
    pub project_id: Option<String>,
    /// A board to put them on, by name or id. Needed with `column` unless
    /// the project has only one board.
    pub board: Option<String>,
    /// A column on that board, by name. A task put in a column takes that
    /// column's status, exactly as it would when dragged there on screen.
    pub column: Option<String>,
}

/// A board an assistant named: by id, or by name within the project.
fn find_board(conn: &Connection, project_id: &str, needle: Option<&str>) -> AppResult<boards::Board> {
    let list = boards::list_boards(conn, project_id)?;
    match needle {
        Some(n) => list
            .into_iter()
            .find(|b| b.id == n || b.name.eq_ignore_ascii_case(n))
            .ok_or_else(|| AppError::NotFound(format!("Board '{n}'"))),
        // No board named: only unambiguous if there is one.
        None => {
            if list.len() > 1 {
                return invalid("That project has more than one board, so say which one with `board`.");
            }
            list.into_iter().next().ok_or_else(|| AppError::NotFound("Board".into()))
        }
    }
}

/// Moves tasks between projects, boards and columns — the one change a
/// `kern_task_update` per task can't make tidily, because a column belongs to
/// a board and a board belongs to a project.
pub fn task_move(conn: &mut Connection, client: &McpClient, args: &TaskMoveArgs) -> AppResult<Wrote<CountResult>> {
    if args.ids.is_empty() || args.ids.len() > MAX_BATCH {
        return invalid(format!("Give between 1 and {MAX_BATCH} task ids."));
    }
    let to_project = match args.project_id.as_deref() {
        Some("none") => Some(None),
        Some(id) => {
            policy::ensure_project(conn, client, Some(id))?;
            projects::get_project(conn, id)?;
            Some(Some(id.to_string()))
        }
        None => None,
    };
    if args.column.is_none() && args.board.is_some() {
        return invalid("A board on its own doesn't say where on it to put them. Add a `column`.");
    }
    if to_project.is_none() && args.column.is_none() {
        return invalid("Say where they should go: a projectId, or a column on one of its boards.");
    }

    let mut existing = vec![];
    for id in &args.ids {
        let t = tasks::get_task(conn, id)?;
        policy::ensure_project(conn, client, t.project_id.as_deref())?;
        existing.push(t);
    }

    // A column is only meaningful on a board in the project the tasks are
    // ending up in, so that project has to be settled first.
    let column_id = match &args.column {
        Some(name) => {
            let project = match &to_project {
                Some(Some(p)) => p.clone(),
                Some(None) => return invalid("A loose task isn't on a board, so a column can't be set with projectId \"none\"."),
                None => {
                    let mut owners: Vec<&str> = existing.iter().filter_map(|t| t.project_id.as_deref()).collect();
                    owners.sort_unstable();
                    owners.dedup();
                    match owners.as_slice() {
                        [one] => one.to_string(),
                        [] => return invalid("Those tasks aren't in a project, so there's no board to put them on. Send a projectId too."),
                        _ => return invalid("Those tasks are in different projects, so one column can't hold them all. Move them a project at a time."),
                    }
                }
            };
            let board = find_board(conn, &project, args.board.as_deref())?;
            let columns = boards::list_columns(conn, &board.id)?;
            let column = columns
                .iter()
                .find(|c| c.id == *name || c.name.eq_ignore_ascii_case(name))
                .ok_or_else(|| {
                    AppError::NotFound(format!(
                        "Column '{name}' on '{}' (it has {})",
                        board.name,
                        columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", ")
                    ))
                })?;
            Some(Some(column.id.clone()))
        }
        None => to_project.as_ref().map(|_| None),
    };

    // A column carries a status, so moving into one can change it.
    let touched = Touched {
        project_id: to_project.is_some(),
        column_id: true,
        status: args.column.is_some(),
        ..Default::default()
    };
    let undo = existing
        .iter()
        .map(|t| Step::TaskWas { id: t.id.clone(), fields: revert::TaskFields::of(t, &touched) })
        .collect();

    let tx = conn.transaction()?;
    let patch = tasks::TaskPatch { project_id: to_project.clone(), column_id: column_id.clone(), ..Default::default() };
    for id in &args.ids {
        tasks::update_task(&tx, id, &patch)?;
    }
    tx.commit()?;
    let names = Names::load(conn)?;
    let where_to = match (&to_project, &args.column) {
        (Some(Some(p)), Some(col)) => format!(" to {} ({col})", names.projects.get(p).cloned().unwrap_or_else(|| p.clone())),
        (Some(Some(p)), None) => format!(" to {}", names.projects.get(p).cloned().unwrap_or_else(|| p.clone())),
        (Some(None), _) => " out of their project".to_string(),
        (None, Some(col)) => format!(" to {col}"),
        (None, None) => String::new(),
    };
    wrote(
        CountResult { count: args.ids.len(), message: format!("Moved {} task(s){where_to}.", args.ids.len()) },
        undo,
    )
}

// ------------------------------------------------------ milestones and labels

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MilestoneCreateArgs {
    pub project_id: String,
    pub title: String,
    pub description: Option<String>,
    /// The day it's due, YYYY-MM-DD.
    pub target_date: Option<String>,
    /// Mark it as a software release.
    pub is_release: bool,
}

pub fn milestone_create(conn: &Connection, client: &McpClient, args: &MilestoneCreateArgs) -> AppResult<Wrote<MilestoneBrief>> {
    policy::ensure_project(conn, client, Some(&args.project_id))?;
    let input = milestones::MilestoneInput {
        project_id: args.project_id.clone(),
        title: args.title.clone(),
        description: args.description.clone(),
        target_date: args.target_date.clone(),
        is_release: Some(args.is_release),
        ..Default::default()
    };
    let made = milestones::create(conn, &input)?;
    let undo = vec![Step::DeleteMilestones { ids: vec![made.id.clone()] }];
    wrote(milestone_brief(made), undo)
}

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LabelCreateArgs {
    /// The label's name. A label of this name already in use is reused rather
    /// than duplicated.
    pub name: String,
    /// A colour from Kern's palette: hue-0 … hue-7. One is picked if you
    /// don't choose.
    pub color: Option<String>,
}

pub fn label_create(conn: &Connection, _client: &McpClient, args: &LabelCreateArgs) -> AppResult<Wrote<LabelBrief>> {
    let before: Vec<String> = labels::list(conn)?.into_iter().map(|l| l.id).collect();
    let id = labels::ensure(conn, &args.name, args.color.as_deref())?;
    // A label that was already in use was reused, not created, so there is
    // nothing to put back.
    let undo = if before.contains(&id) { vec![] } else { vec![Step::DeleteLabels { ids: vec![id.clone()] }] };
    let brief = labels::list(conn)?
        .into_iter()
        .find(|l| l.id == id)
        .map(|l| LabelBrief { id: l.id, name: l.name, open_tasks: l.task_count })
        .ok_or_else(|| AppError::NotFound("Label".into()))?;
    wrote(brief, undo)
}

// ------------------------------------------------------------ flowcharts

#[derive(Deserialize, schemars::JsonSchema, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WhiteboardMermaidArgs {
    /// The flowchart as Mermaid `flowchart` or `graph` text. Required; no
    /// other kind of Mermaid diagram belongs on a whiteboard.
    pub mermaid: String,
    /// A name for the new whiteboard.
    pub name: Option<String>,
    pub project_id: Option<String>,
    /// Draw onto an existing whiteboard instead of making a new one. The
    /// shapes are placed clear of whatever is already on it.
    pub whiteboard_id: Option<String>,
    /// With `whiteboardId`, replace what's there rather than adding to it.
    pub replace: bool,
}

#[derive(Serialize, schemars::JsonSchema, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WhiteboardResult {
    pub id: String,
    pub name: String,
    pub shapes: usize,
    pub connectors: usize,
    pub message: String,
}

/// The most shapes one flowchart may bring. A confused agent should hit a
/// wall, not fill a board with a thousand boxes.
const MAX_SHAPES: usize = 200;

/// Where new shapes go on a board that already has some: clear of the lot.
fn below(nodes: &[whiteboards::WbNode]) -> (f64, f64) {
    let bottom = nodes.iter().map(|n| n.y + n.height.unwrap_or(0.0)).fold(f64::NEG_INFINITY, f64::max);
    if bottom.is_finite() {
        (0.0, bottom + 80.0)
    } else {
        (0.0, 0.0)
    }
}

pub fn whiteboard_from_mermaid(
    conn: &mut Connection,
    client: &McpClient,
    args: &WhiteboardMermaidArgs,
) -> AppResult<Wrote<WhiteboardResult>> {
    // The parser's own sentence is the best thing to hand back: it says what
    // about the text stopped it.
    let chart = mermaid::parse_mermaid(&args.mermaid).map_err(AppError::Invalid)?;
    if chart.nodes.len() > MAX_SHAPES {
        return invalid(format!("That chart has {} boxes, and {MAX_SHAPES} is the most for one board.", chart.nodes.len()));
    }
    // An existing board is drawn onto; otherwise one is made for the chart.
    let (board, added_to, undo) = match &args.whiteboard_id {
        Some(id) => {
            let wb = whiteboards::get(conn, id)?;
            policy::ensure_project(conn, client, wb.project_id.as_deref())?;
            let origin = if args.replace { (0.0, 0.0) } else { below(&whiteboards::nodes(conn, id)?) };
            let (nodes, edges) = mermaid::chart_to_scene(&chart, origin);
            // Adding is undone by taking the new objects off again; replacing
            // needs the whole scene as it was, which is only kept while the
            // board is small enough to be worth copying.
            let undo = if args.replace {
                revert::scene_was(conn, &wb.id)?.into_iter().collect()
            } else {
                vec![Step::RemoveObjects {
                    id: wb.id.clone(),
                    nodes: nodes.iter().map(|n| n.id.clone()).collect(),
                    edges: edges.iter().map(|e| e.id.clone()).collect(),
                }]
            };
            let tx = conn.transaction()?;
            if args.replace {
                whiteboards::save_scene(&tx, &wb.id, &nodes, &edges)?;
            } else {
                // A patch, not a save: whatever else is on the board — and
                // whoever else is editing it — stays.
                whiteboards::patch_scene(&tx, &wb.id, &whiteboards::ScenePatch { nodes, edges, ..Default::default() })?;
            }
            tx.commit()?;
            (wb, !args.replace, undo)
        }
        None => {
            policy::ensure_project(conn, client, args.project_id.as_deref())?;
            let name = args.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or("Flowchart");
            let (nodes, edges) = mermaid::chart_to_scene(&chart, (0.0, 0.0));
            let tx = conn.transaction()?;
            let wb = whiteboards::create(&tx, args.project_id.as_deref(), name)?;
            whiteboards::save_scene(&tx, &wb.id, &nodes, &edges)?;
            activity::log(&tx, args.project_id.as_deref(), "whiteboard", &wb.id, "created", &wb.name)?;
            tx.commit()?;
            let undo = vec![Step::TrashWhiteboards { ids: vec![wb.id.clone()] }];
            (wb, false, undo)
        }
    };
    let (shapes, connectors) = (chart.nodes.len(), chart.edges.len());
    wrote(
        WhiteboardResult {
            shapes,
            connectors,
            message: format!(
                "Drew {shapes} shapes and {connectors} connectors {} “{}”.",
                if added_to { "onto" } else { "on" },
                board.name
            ),
            id: board.id,
            name: board.name,
        },
        undo,
    )
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

        let flow = whiteboard_from_mermaid(
            c,
            &cl,
            &WhiteboardMermaidArgs {
                mermaid: "flowchart TD\n A[Shield] --> B[Check]".into(),
                name: Some("Flow".into()),
                project_id: Some(id.clone()),
                ..Default::default()
            },
        )
        .unwrap()
        .value;

        // Reachable to begin with, or the assertions below prove nothing.
        assert!(project_list(c, &cl, &ProjectListArgs::default()).unwrap().iter().any(|p| p.id == id));
        assert!(project_get(c, &cl, &IdArgs { id: id.clone() }).is_ok());
        assert!(task_search(c, &cl, &TaskSearchArgs::default()).unwrap().iter().any(|x| x.id == t));
        assert!(note_get(c, &cl, &IdArgs { id: note.clone() }).is_ok());
        assert!(board_list(c, &cl, &BoardListArgs::default()).unwrap().iter().any(|b| b.name == "Build"));
        assert!(milestone_list(c, &cl, &ProjectIdArgs { project_id: id.clone() }).is_ok());
        assert!(whiteboard_list(c, &cl, &BoardListArgs::default()).unwrap().iter().any(|w| w.id == flow.id));
        assert!(whiteboard_to_mermaid(c, &cl, &IdArgs { id: flow.id.clone() }).is_ok());
        assert!(!search_all(c, &cl, &SearchArgs { query: "shield".into(), scope: None, limit: None }).unwrap().is_empty());

        lock(c, &id);

        // Reads: the project, and everything inside it, is simply not there.
        assert!(!project_list(c, &cl, &ProjectListArgs::default()).unwrap().iter().any(|p| p.id == id));
        assert!(!project_list(c, &cl, &ProjectListArgs { include_archived: true }).unwrap().iter().any(|p| p.id == id));
        assert!(project_get(c, &cl, &IdArgs { id: id.clone() }).is_err());
        assert!(milestone_list(c, &cl, &ProjectIdArgs { project_id: id.clone() }).is_err());
        assert!(whiteboard_list(c, &cl, &BoardListArgs::default()).unwrap().is_empty());
        assert!(whiteboard_list(c, &cl, &BoardListArgs { project_id: Some(id.clone()) }).is_err());
        assert!(whiteboard_to_mermaid(c, &cl, &IdArgs { id: flow.id.clone() }).is_err());
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
        assert!(task_delete(c, &cl, &IdsArgs { ids: vec![t.clone()] }).is_err());
        assert!(project_update(c, &cl, &ProjectUpdateArgs { id: id.clone(), name: Some("Renamed".into()), ..Default::default() }).is_err());
        assert!(task_move(c, &cl, &TaskMoveArgs { ids: vec![t.clone()], project_id: Some("none".into()), ..Default::default() }).is_err());
        assert!(note_create(c, &cl, &NoteCreateArgs { title: "New".into(), content: "x".into(), project_id: Some(id.clone()) }).is_err());
        assert!(note_update(c, &cl, &NoteUpdateArgs { id: note, title: None, content: Some("Rewritten".into()), append: None }).is_err());
        assert!(board_create(c, &cl, &BoardCreateArgs { project_id: id.clone(), name: "Another".into(), columns: None }).is_err());
        let milestone = MilestoneCreateArgs { project_id: id.clone(), title: "Meltdown".into(), ..Default::default() };
        assert!(milestone_create(c, &cl, &milestone).is_err());
        let chart = "flowchart TD\n A --> B";
        let into_project = WhiteboardMermaidArgs { mermaid: chart.into(), project_id: Some(id.clone()), ..Default::default() };
        assert!(whiteboard_from_mermaid(c, &cl, &into_project).is_err());
        let onto_board = WhiteboardMermaidArgs { mermaid: chart.into(), whiteboard_id: Some(flow.id), ..Default::default() };
        assert!(whiteboard_from_mermaid(c, &cl, &onto_board).is_err());
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
        let made = task_create(c, &cl, &args).unwrap().value;
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
        let note = note_create(c, &cl, &NoteCreateArgs { title: "Coolant".into(), content: "# Flow\n\nSteady.".into(), project_id: None }).unwrap().value;
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
        let board = board_create(c, &cl, &args).unwrap().value;
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

    /// `kern_project_setup` is the centrepiece, so this is the test that says
    /// what "set up a project for the launch" actually produces.
    #[test]
    fn a_whole_project_arrives_in_one_call() {
        let c = &mut db();
        let cl = client(c, "write");
        let args = ProjectSetupArgs {
            name: "Website Redesign".into(),
            description: Some("A new site by the spring.".into()),
            start_date: Some("2030-03-01".into()),
            target_offset: Some(30),
            boards: vec![NewBoard {
                name: "Build".into(),
                columns: vec![
                    NewColumn { name: "Ideas".into(), status: None },
                    NewColumn { name: "Doing".into(), status: Some("in_progress".into()) },
                ],
            }],
            milestones: vec![
                NewMilestone { key: "draft".into(), title: "First draft".into(), offset_days: Some(14), ..Default::default() },
                NewMilestone { key: "live".into(), title: "Live".into(), offset_days: Some(30), is_release: true, ..Default::default() },
            ],
            tasks: vec![
                PlannedTask {
                    title: "Wireframes".into(),
                    due_offset: Some(2),
                    labels: vec!["design".into()],
                    milestone: Some("draft".into()),
                    column: Some("doing".into()),
                    subtasks: vec!["Home".into(), "Pricing".into()],
                    ..Default::default()
                },
                PlannedTask { title: "Launch checks".into(), due_offset: Some(30), milestone: Some("live".into()), ..Default::default() },
            ],
            notes: vec![NewNote { title: "Brief".into(), content: "## Goals\n\n- Fewer clicks".into() }],
        };
        let out = project_setup(c, &cl, &args).unwrap().value;

        assert_eq!(out.project.name, "Website Redesign");
        assert_eq!(out.project.target_date.as_deref(), Some("2030-03-31"), "offsets count from the start date");
        assert_eq!(out.milestones.iter().map(|m| m.title.as_str()).collect::<Vec<_>>(), ["First draft", "Live"]);
        assert_eq!(out.milestones[0].target_date.as_deref(), Some("2030-03-15"));
        assert_eq!(out.boards[0].columns.iter().map(|col| col.name.as_str()).collect::<Vec<_>>(), ["Ideas", "Doing"]);
        assert_eq!(out.notes.len(), 1);
        let wireframes = out.tasks.iter().find(|t| t.title == "Wireframes").unwrap();
        assert_eq!(wireframes.due_date.as_deref(), Some("2030-03-03"));
        assert_eq!(wireframes.subtasks.as_deref(), Some("0/2"), "the checklist came with it");
        assert_eq!(wireframes.labels, vec!["design".to_string()]);
        assert_eq!(wireframes.status, "in_progress", "placed in a column that means in progress");
        assert_eq!(out.tasks.len(), 2, "the digest lists top-level tasks, not checklist steps");
        // The milestones are real, and the tasks joined them.
        let live = milestone_list(c, &cl, &ProjectIdArgs { project_id: out.project.id.clone() }).unwrap();
        assert_eq!(live.iter().find(|m| m.title == "Live").unwrap().open_tasks, 1);
    }

    #[test]
    fn a_setup_bigger_than_the_limit_is_refused_whole() {
        let c = &mut db();
        let cl = client(c, "write");
        let args = ProjectSetupArgs {
            name: "Everything".into(),
            tasks: (0..=MAX_BATCH).map(|i| PlannedTask { title: format!("Task {i}"), ..Default::default() }).collect(),
            ..Default::default()
        };
        assert!(project_setup(c, &cl, &args).is_err());
        assert!(project_list(c, &cl, &ProjectListArgs::default()).unwrap().is_empty(), "no half-made project left behind");

        // A failure partway through takes the whole project with it.
        let bad = ProjectSetupArgs {
            name: "Half a plan".into(),
            start_date: Some("the third".into()),
            tasks: vec![PlannedTask { title: "Fine".into(), ..Default::default() }],
            ..Default::default()
        };
        assert!(project_setup(c, &cl, &bad).is_err());
        assert!(project_list(c, &cl, &ProjectListArgs::default()).unwrap().is_empty());
    }

    #[test]
    fn an_allowlisted_assistant_cannot_create_a_project_to_work_in() {
        let c = &mut db();
        let mine = project(c, "Website Redesign");
        let cl = client(c, "write");
        let cl = clients::set_projects(c, &cl.id, &[mine]).unwrap();
        let args = ProjectSetupArgs { name: "Somewhere else".into(), ..Default::default() };
        assert!(project_setup(c, &cl, &args).is_err());
        assert_eq!(project_list(c, &cl, &ProjectListArgs::default()).unwrap().len(), 1);
    }

    #[test]
    fn a_flowchart_becomes_shapes_that_can_be_read_back() {
        let c = &mut db();
        let id = project(c, "Website Redesign");
        let cl = client(c, "write");
        let args = WhiteboardMermaidArgs {
            mermaid: "flowchart LR\n  A([Start]) -->|Yes| B{Ready?}\n  B --> C[(Store)]".into(),
            name: Some("Flow".into()),
            project_id: Some(id.clone()),
            ..Default::default()
        };
        let out = whiteboard_from_mermaid(c, &cl, &args).unwrap().value;
        assert_eq!((out.shapes, out.connectors), (3, 2));
        assert_eq!(out.name, "Flow");

        let back = whiteboard_to_mermaid(c, &cl, &IdArgs { id: out.id.clone() }).unwrap();
        assert_eq!((back.included, back.skipped), (3, 0));
        assert!(back.mermaid.contains("([\"Start\"])"), "the shapes survived: {}", back.mermaid);
        assert!(back.mermaid.contains("{\"Ready?\"}"));
        assert!(back.mermaid.contains("|\"Yes\"|"), "so did the connector's label");
        assert!(whiteboard_list(c, &cl, &BoardListArgs { project_id: Some(id) }).unwrap().iter().any(|w| w.objects == 3));

        // A second chart is added below the first rather than over it.
        let more = WhiteboardMermaidArgs {
            mermaid: "flowchart TD\n D[Later]".into(),
            whiteboard_id: Some(out.id.clone()),
            ..Default::default()
        };
        assert_eq!(whiteboard_from_mermaid(c, &cl, &more).unwrap().value.shapes, 1);
        assert_eq!(whiteboard_to_mermaid(c, &cl, &IdArgs { id: out.id.clone() }).unwrap().included, 4);
        // Unless replacing is asked for, which it has to be.
        let replace = WhiteboardMermaidArgs { replace: true, ..more };
        whiteboard_from_mermaid(c, &cl, &replace).unwrap();
        assert_eq!(whiteboard_to_mermaid(c, &cl, &IdArgs { id: out.id }).unwrap().included, 1);

        // Anything that isn't a flowchart is explained, not half-imported.
        let wrong = WhiteboardMermaidArgs { mermaid: "sequenceDiagram\n A->>B: hi".into(), ..Default::default() };
        let e = whiteboard_from_mermaid(c, &cl, &wrong).unwrap_err().to_string();
        assert!(e.contains("sequenceDiagram"), "{e}");
    }

    #[test]
    fn milestones_and_labels_are_created_once_and_counted() {
        let c = &mut db();
        let id = project(c, "Website Redesign");
        let cl = client(c, "write");
        let made = milestone_create(
            c,
            &cl,
            &MilestoneCreateArgs {
                project_id: id.clone(),
                title: "Live".into(),
                target_date: Some("2030-03-31".into()),
                is_release: true,
                ..Default::default()
            },
        )
        .unwrap()
        .value;
        assert_eq!(made.status, "planned");
        assert_eq!(made.target_date.as_deref(), Some("2030-03-31"));
        assert!(milestone_list(c, &cl, &ProjectIdArgs { project_id: id }).unwrap().iter().any(|m| m.id == made.id));
        assert!(milestone_create(c, &cl, &MilestoneCreateArgs { title: "Live".into(), ..Default::default() }).is_err());

        let label = label_create(c, &cl, &LabelCreateArgs { name: "Design".into(), color: None }).unwrap().value;
        // Asking again returns the same label rather than a near-duplicate.
        assert_eq!(label_create(c, &cl, &LabelCreateArgs { name: "design".into(), color: None }).unwrap().value.id, label.id);
        assert_eq!(label_list(c, &cl).unwrap().len(), 1);
    }

    #[test]
    fn a_project_is_renamed_and_put_back() {
        let c = &mut db();
        let id = project(c, "Website Redesign");
        let cl = client(c, "write");
        let wrote = project_update(
            c,
            &cl,
            &ProjectUpdateArgs {
                id: id.clone(),
                name: Some("Website, again".into()),
                target_date: Some("2030-06-01".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(wrote.value.name, "Website, again");
        assert_eq!(wrote.value.target_date.as_deref(), Some("2030-06-01"));

        revert::apply(c, &wrote.undo).unwrap();
        let back = &project_list(c, &cl, &ProjectListArgs::default()).unwrap()[0];
        assert_eq!(back.name, "Website Redesign");
        assert!(back.target_date.is_none(), "a date that wasn't there is empty again");

        // A call that changes nothing is a mistake worth saying out loud.
        assert!(project_update(c, &cl, &ProjectUpdateArgs { id, ..Default::default() }).is_err());
    }

    #[test]
    fn a_task_moves_to_a_column_and_takes_its_status() {
        let c = &mut db();
        let id = project(c, "Website Redesign");
        let cl = client(c, "write");
        let t = task(c, "Wireframes", None);
        board_create(
            c,
            &cl,
            &BoardCreateArgs { project_id: id.clone(), name: "Build".into(), columns: Some(vec!["Ideas".into(), "Doing".into()]) },
        )
        .unwrap();
        // A column with no status of its own leaves the task as it is, so the
        // move is made onto one that means something.
        let board = board_list(c, &cl, &BoardListArgs { project_id: Some(id.clone()) }).unwrap();
        let doing = board.iter().flat_map(|b| &b.columns).find(|col| col.name == "Doing").unwrap().id.clone();
        c.execute("UPDATE board_columns SET status = 'in_progress' WHERE id = ?1", [&doing]).unwrap();

        let args = TaskMoveArgs {
            ids: vec![t.clone()],
            project_id: Some(id.clone()),
            board: Some("Build".into()),
            column: Some("doing".into()),
        };
        let wrote = task_move(c, &cl, &args).unwrap();
        assert_eq!(wrote.value.count, 1);
        assert!(wrote.value.message.contains("Website Redesign"), "{}", wrote.value.message);
        let moved = tasks::get_task(c, &t).unwrap();
        assert_eq!(moved.project_id.as_deref(), Some(id.as_str()));
        assert_eq!(moved.column_id.as_deref(), Some(doing.as_str()));
        assert_eq!(moved.status, "in_progress");

        // And back where it came from.
        revert::apply(c, &wrote.undo).unwrap();
        let back = tasks::get_task(c, &t).unwrap();
        assert!(back.project_id.is_none());
        assert!(back.column_id.is_none());
        assert_eq!(back.status, "todo");

        // A column nobody has must say which ones exist.
        let wrong = TaskMoveArgs { column: Some("Shipped".into()), ..args };
        let e = task_move(c, &cl, &wrong).unwrap_err().to_string();
        assert!(e.contains("Ideas") && e.contains("Doing"), "{e}");
        // And a move with no destination at all is a mistake, not a no-op -
        // as is a board without a column on it.
        assert!(task_move(c, &cl, &TaskMoveArgs { ids: vec![t.clone()], ..Default::default() }).is_err());
        assert!(task_move(c, &cl, &TaskMoveArgs { ids: vec![t], board: Some("Build".into()), ..Default::default() }).is_err());
    }

    /// The other half of every write: what the Assistants tab replays when
    /// someone presses **Revert this batch**.
    #[test]
    fn a_batch_goes_back_the_way_it_came() {
        let c = &mut db();
        let cl = client(c, "write");
        let setup = ProjectSetupArgs {
            name: "Website Redesign".into(),
            tasks: vec![PlannedTask { title: "Wireframes".into(), ..Default::default() }],
            notes: vec![NewNote { title: "Brief".into(), content: "## Goals".into() }],
            ..Default::default()
        };
        let made = project_setup(c, &cl, &setup).unwrap();
        let id = made.value.project.id.clone();

        // A second call changes something inside it; reverting that one leaves
        // the project alone.
        let note = made.value.notes[0].id.clone();
        let edit = note_update(c, &cl, &NoteUpdateArgs { id: note.clone(), title: None, content: Some("Rewritten".into()), append: None }).unwrap();
        revert::apply(c, &edit.undo).unwrap();
        assert_eq!(note_get(c, &cl, &IdArgs { id: note }).unwrap().content.as_deref(), Some("## Goals"));
        assert!(project_get(c, &cl, &IdArgs { id: id.clone() }).is_ok());

        // Reverting the setup takes the project and everything in it.
        revert::apply(c, &made.undo).unwrap();
        assert!(project_list(c, &cl, &ProjectListArgs::default()).unwrap().is_empty());
        assert!(task_search(c, &cl, &TaskSearchArgs::default()).unwrap().is_empty());
        assert!(crate::domain::trash::list(c).unwrap().iter().any(|i| i.kind == "project" && i.id == id), "recoverable");
    }

    #[test]
    fn a_reused_label_has_nothing_to_put_back() {
        let c = &mut db();
        let cl = client(c, "write");
        let first = label_create(c, &cl, &LabelCreateArgs { name: "Design".into(), color: None }).unwrap();
        assert_eq!(first.undo.len(), 1, "the label is new, so reverting removes it");
        let again = label_create(c, &cl, &LabelCreateArgs { name: "design".into(), color: None }).unwrap();
        assert!(again.undo.is_empty(), "nothing was created the second time");
        revert::apply(c, &first.undo).unwrap();
        assert!(label_list(c, &cl).unwrap().is_empty());
    }

    #[test]
    fn a_limit_an_assistant_asks_for_is_clamped() {
        assert_eq!(clamp_limit(None, 20), 20);
        assert_eq!(clamp_limit(Some(0), 20), 1);
        assert_eq!(clamp_limit(Some(10_000), 20), 200);
    }
}
