// @Author Christian Relf
// @Date 2026-10-12

//! Task service: querying, creation, updates (with status/board-column
//! synchronisation and recurrence), bulk operations, duplication and
//! soft deletion into the trash.

use crate::domain::{activity, cloud, passkeys, recurrence::Recurrence};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms, placeholders, some, valid_date, valid_time};
use chrono::NaiveDate;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

pub const STATUSES: &[&str] = &["inbox", "todo", "in_progress", "blocked", "completed"];
/// How a completed task was closed; none means done.
pub const RESOLUTIONS: &[&str] = &["cancelled", "duplicate"];

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: i64,
    pub project_id: Option<String>,
    pub column_id: Option<String>,
    pub parent_id: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub start_date: Option<String>,
    pub estimate_minutes: Option<i64>,
    pub tracked_seconds: i64,
    pub sort_order: f64,
    pub board_order: f64,
    pub pinned: bool,
    pub recurrence: Option<Value>,
    pub series_id: Option<String>,
    pub reminder_minutes: Option<i64>,
    pub completed_at: Option<i64>,
    pub archived_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub label_ids: Vec<String>,
    pub subtask_count: i64,
    pub subtask_done: i64,
    pub attachment_count: i64,
    /// Linked GitHub issue, if any.
    #[serde(default)]
    pub issue: Option<IssueRef>,
    #[serde(default)]
    pub milestone_id: Option<String>,
    /// Explicitly linked development resources (branches, worktrees, …).
    #[serde(default)]
    pub dev_links: Vec<DevLinkRef>,
    /// Set on completed tasks that were cancelled or closed as duplicates.
    #[serde(default)]
    pub resolution: Option<String>,
    /// Open tasks that block this one.
    #[serde(default)]
    pub blocked_by: i64,
    /// Time block: the day it's planned for, and optionally the start time.
    #[serde(default)]
    pub plan_date: Option<String>,
    #[serde(default)]
    pub plan_time: Option<String>,
    #[serde(default)]
    pub comment_count: i64,
    /// Kern Cloud account that wrote the task, and its name at the time.
    /// Both are None for anything written offline.
    #[serde(default)]
    pub created_by: Option<String>,
    #[serde(default)]
    pub created_by_name: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevLinkRef {
    pub kind: String,
    pub repository_id: Option<String>,
    #[serde(rename = "ref")]
    pub reference: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IssueRef {
    pub repo: String,
    pub number: i64,
    pub url: String,
}

pub const TASK_SELECT: &str = "SELECT t.id, t.title, t.description, t.status, t.priority, t.project_id, t.column_id,
  t.parent_id, t.due_date, t.due_time, t.start_date, t.estimate_minutes, t.tracked_seconds, t.sort_order,
  t.board_order, t.pinned, t.recurrence, t.series_id, t.reminder_minutes, t.completed_at, t.archived_at,
  t.deleted_at, t.created_at, t.updated_at,
  (SELECT group_concat(tl.label_id) FROM task_labels tl WHERE tl.task_id = t.id),
  (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id AND s.deleted_at IS NULL),
  (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id AND s.deleted_at IS NULL AND s.status = 'completed'),
  (SELECT count(*) FROM attachments a WHERE a.task_id = t.id),
  (SELECT l.repo || char(31) || l.issue_number || char(31) || l.html_url FROM task_issue_links l WHERE l.task_id = t.id),
  t.milestone_id,
  (SELECT group_concat(d.kind || char(31) || coalesce(d.repository_id, '') || char(31) || d.ref, char(30)) FROM task_dev_links d WHERE d.task_id = t.id),
  t.resolution,
  (SELECT count(*) FROM task_relations r JOIN tasks b ON b.id = r.task_id
     WHERE r.related_id = t.id AND r.kind = 'blocks' AND b.status != 'completed' AND b.deleted_at IS NULL),
  t.plan_date, t.plan_time,
  (SELECT count(*) FROM task_comments c WHERE c.task_id = t.id),
  t.created_by, t.created_by_name
FROM tasks t";

pub fn map_task(r: &Row) -> rusqlite::Result<Task> {
    let recurrence: Option<String> = r.get(16)?;
    let labels: Option<String> = r.get(24)?;
    Ok(Task {
        id: r.get(0)?,
        title: r.get(1)?,
        description: r.get(2)?,
        status: r.get(3)?,
        priority: r.get(4)?,
        project_id: r.get(5)?,
        column_id: r.get(6)?,
        parent_id: r.get(7)?,
        due_date: r.get(8)?,
        due_time: r.get(9)?,
        start_date: r.get(10)?,
        estimate_minutes: r.get(11)?,
        tracked_seconds: r.get(12)?,
        sort_order: r.get(13)?,
        board_order: r.get(14)?,
        pinned: r.get::<_, i64>(15)? != 0,
        recurrence: recurrence.and_then(|s| serde_json::from_str(&s).ok()),
        series_id: r.get(17)?,
        reminder_minutes: r.get(18)?,
        completed_at: r.get(19)?,
        archived_at: r.get(20)?,
        deleted_at: r.get(21)?,
        created_at: r.get(22)?,
        updated_at: r.get(23)?,
        label_ids: labels
            .map(|s| s.split(',').filter(|x| !x.is_empty()).map(String::from).collect())
            .unwrap_or_default(),
        subtask_count: r.get(25)?,
        subtask_done: r.get(26)?,
        attachment_count: r.get(27)?,
        issue: r.get::<_, Option<String>>(28)?.and_then(|s| {
            let mut p = s.split('\u{1f}');
            Some(IssueRef { repo: p.next()?.to_string(), number: p.next()?.parse().ok()?, url: p.next()?.to_string() })
        }),
        milestone_id: r.get(29)?,
        dev_links: r.get::<_, Option<String>>(30)?.map(|s| parse_dev_links(&s)).unwrap_or_default(),
        resolution: r.get(31)?,
        blocked_by: r.get(32)?,
        plan_date: r.get(33)?,
        plan_time: r.get(34)?,
        comment_count: r.get(35)?,
        created_by: r.get(36)?,
        created_by_name: r.get(37)?,
    })
}

/// Decodes the `kind␟repository␟ref␞…` list built by TASK_SELECT.
fn parse_dev_links(s: &str) -> Vec<DevLinkRef> {
    s.split('\u{1e}')
        .filter_map(|l| {
            let mut p = l.split('\u{1f}');
            let kind = p.next()?.to_string();
            let repo = p.next()?;
            Some(DevLinkRef { kind, repository_id: (!repo.is_empty()).then(|| repo.to_string()), reference: p.next()?.to_string() })
        })
        .collect()
}

pub fn get_task(conn: &Connection, id: &str) -> AppResult<Task> {
    let task = conn
        .query_row(&format!("{TASK_SELECT} WHERE t.id = ?1"), [id], map_task)
        .optional()?
        .ok_or_else(|| AppError::NotFound("Task".into()))?;
    passkeys::ensure_readable_opt(conn, task.project_id.as_deref())?;
    Ok(task)
}

// ---------------------------------------------------------------- queries

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskQuery {
    pub ids: Option<Vec<String>>,
    pub project_ids: Option<Vec<String>>,
    pub no_project: bool,
    pub statuses: Option<Vec<String>>,
    pub exclude_statuses: Option<Vec<String>>,
    pub min_priority: Option<i64>,
    pub priorities: Option<Vec<i64>>,
    pub label_ids: Option<Vec<String>>,
    pub due_from: Option<String>,
    pub due_to: Option<String>,
    /// Treat the due window as a span: a task with a start date earlier than
    /// its due date matches when any day between the two falls inside it, so
    /// a run reaching across a whole calendar month is still returned.
    pub due_overlap: bool,
    pub has_due: Option<bool>,
    /// Open tasks due strictly before this date.
    pub overdue_as_of: Option<String>,
    pub include_completed: bool,
    pub completed_from: Option<i64>,
    pub completed_to: Option<i64>,
    pub search: Option<String>,
    pub parent_id: Option<String>,
    pub top_level_only: bool,
    pub include_archived: bool,
    pub pinned: Option<bool>,
    pub milestone_ids: Option<Vec<String>>,
    pub no_milestone: bool,
    /// Time-blocked within [planned_from, planned_to].
    pub planned_from: Option<String>,
    pub planned_to: Option<String>,
    pub limit: Option<i64>,
    /// manual | due | priority | created | updated | title | completed
    pub order: Option<String>,
}

pub fn query_tasks(conn: &Connection, q: &TaskQuery) -> AppResult<Vec<Task>> {
    let mut sql = format!("{TASK_SELECT} WHERE t.deleted_at IS NULL");
    let mut args: Vec<SqlValue> = Vec::new();
    let text = |s: &str| SqlValue::Text(s.to_string());

    if let Some(ids) = &q.ids {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        sql.push_str(&format!(" AND t.id IN ({})", placeholders(ids.len())));
        args.extend(ids.iter().map(|s| text(s)));
    }
    match (&q.project_ids, q.no_project) {
        (Some(p), true) if !p.is_empty() => {
            sql.push_str(&format!(" AND (t.project_id IS NULL OR t.project_id IN ({}))", placeholders(p.len())));
            args.extend(p.iter().map(|s| text(s)));
        }
        (Some(p), false) if !p.is_empty() => {
            sql.push_str(&format!(" AND t.project_id IN ({})", placeholders(p.len())));
            args.extend(p.iter().map(|s| text(s)));
        }
        (_, true) => sql.push_str(" AND t.project_id IS NULL"),
        _ => {}
    }
    if let Some(st) = &q.statuses {
        if !st.is_empty() {
            sql.push_str(&format!(" AND t.status IN ({})", placeholders(st.len())));
            args.extend(st.iter().map(|s| text(s)));
        }
    }
    if let Some(st) = &q.exclude_statuses {
        if !st.is_empty() {
            sql.push_str(&format!(" AND t.status NOT IN ({})", placeholders(st.len())));
            args.extend(st.iter().map(|s| text(s)));
        }
    }
    let wants_completed = q.include_completed
        || q.completed_from.is_some()
        || q.statuses.as_ref().map(|s| s.iter().any(|x| x == "completed")).unwrap_or(false);
    if !wants_completed {
        sql.push_str(" AND t.status != 'completed'");
    }
    if let Some(p) = q.min_priority {
        sql.push_str(" AND t.priority >= ?");
        args.push(SqlValue::Integer(p));
    }
    if let Some(ps) = &q.priorities {
        if !ps.is_empty() {
            sql.push_str(&format!(" AND t.priority IN ({})", placeholders(ps.len())));
            args.extend(ps.iter().map(|p| SqlValue::Integer(*p)));
        }
    }
    if let Some(ls) = &q.label_ids {
        if !ls.is_empty() {
            sql.push_str(&format!(
                " AND EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id = t.id AND tl.label_id IN ({}))",
                placeholders(ls.len())
            ));
            args.extend(ls.iter().map(|s| text(s)));
        }
    }
    match (&q.due_from, &q.due_to, q.due_overlap) {
        // A run matches when any of its days falls in the window, so one that
        // starts before it and ends after it is still returned.
        (Some(from), Some(to), true) => {
            sql.push_str(
                " AND ((t.due_date >= ? AND t.due_date <= ?)
                   OR (t.start_date IS NOT NULL AND t.start_date < t.due_date AND t.start_date <= ? AND t.due_date >= ?))",
            );
            args.push(text(from));
            args.push(text(to));
            args.push(text(to));
            args.push(text(from));
        }
        _ => {
            if let Some(d) = &q.due_from {
                sql.push_str(" AND t.due_date >= ?");
                args.push(text(d));
            }
            if let Some(d) = &q.due_to {
                sql.push_str(" AND t.due_date <= ?");
                args.push(text(d));
            }
        }
    }
    match q.has_due {
        Some(true) => sql.push_str(" AND t.due_date IS NOT NULL"),
        Some(false) => sql.push_str(" AND t.due_date IS NULL"),
        None => {}
    }
    if let Some(d) = &q.planned_from {
        sql.push_str(" AND t.plan_date >= ?");
        args.push(text(d));
    }
    if let Some(d) = &q.planned_to {
        sql.push_str(" AND t.plan_date <= ?");
        args.push(text(d));
    }
    if let Some(d) = &q.overdue_as_of {
        sql.push_str(" AND t.due_date < ? AND t.status != 'completed'");
        args.push(text(d));
    }
    if let Some(f) = q.completed_from {
        sql.push_str(" AND t.completed_at >= ?");
        args.push(SqlValue::Integer(f));
    }
    if let Some(f) = q.completed_to {
        sql.push_str(" AND t.completed_at < ?");
        args.push(SqlValue::Integer(f));
    }
    if let Some(s) = &q.search {
        let s = s.trim();
        if !s.is_empty() {
            sql.push_str(" AND (t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')");
            let pat = format!("%{}%", s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
            args.push(text(&pat));
            args.push(text(&pat));
        }
    }
    if let Some(p) = &q.parent_id {
        sql.push_str(" AND t.parent_id = ?");
        args.push(text(p));
    } else if q.top_level_only {
        sql.push_str(" AND t.parent_id IS NULL");
    }
    if !q.include_archived {
        sql.push_str(" AND t.archived_at IS NULL");
    }
    if let Some(p) = q.pinned {
        sql.push_str(if p { " AND t.pinned = 1" } else { " AND t.pinned = 0" });
    }
    match (&q.milestone_ids, q.no_milestone) {
        (Some(m), nm) if !m.is_empty() => {
            sql.push_str(&format!(" AND (t.milestone_id IN ({}){})", placeholders(m.len()), if nm { " OR t.milestone_id IS NULL" } else { "" }));
            args.extend(m.iter().map(|s| text(s)));
        }
        (_, true) => sql.push_str(" AND t.milestone_id IS NULL"),
        _ => {}
    }
    let order = match q.order.as_deref() {
        Some("due") => "t.due_date IS NULL, t.due_date, t.due_time IS NULL, t.due_time, t.priority DESC, t.sort_order",
        Some("priority") => "t.priority DESC, t.due_date IS NULL, t.due_date, t.sort_order",
        Some("created") => "t.created_at DESC",
        Some("updated") => "t.updated_at DESC",
        Some("title") => "t.title COLLATE NOCASE",
        Some("completed") => "t.completed_at DESC",
        _ => "t.sort_order, t.created_at",
    };
    // Tasks of a locked project are in nobody's lists.
    sql.push_str(&format!(" AND {}", passkeys::readable_sql(conn, "t.project_id")));
    sql.push_str(&format!(" ORDER BY {order}"));
    if let Some(l) = q.limit {
        sql.push_str(" LIMIT ?");
        args.push(SqlValue::Integer(l.clamp(1, 20_000)));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), map_task)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

// --------------------------------------------------------------- creation

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskInput {
    pub title: String,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<i64>,
    pub project_id: Option<String>,
    pub column_id: Option<String>,
    pub parent_id: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub start_date: Option<String>,
    pub estimate_minutes: Option<i64>,
    pub pinned: Option<bool>,
    pub recurrence: Option<Value>,
    pub label_ids: Option<Vec<String>>,
    pub reminder_minutes: Option<i64>,
    pub sort_order: Option<f64>,
    pub board_order: Option<f64>,
    pub milestone_id: Option<String>,
    pub plan_date: Option<String>,
    pub plan_time: Option<String>,
}

/// A milestone may only hold tasks from its own project.
fn check_milestone(conn: &Connection, milestone_id: &str, project_id: Option<&str>) -> AppResult<()> {
    let owner: Option<String> =
        conn.query_row("SELECT project_id FROM milestones WHERE id = ?1", [milestone_id], |r| r.get(0)).optional()?;
    match owner {
        None => Err(AppError::NotFound("Milestone".into())),
        Some(p) if Some(p.as_str()) != project_id => invalid("A task can only belong to a milestone in its own project."),
        _ => Ok(()),
    }
}

fn validate_dates(due: Option<&str>, time: Option<&str>, start: Option<&str>) -> AppResult<()> {
    if let Some(d) = due {
        if !valid_date(d) {
            return invalid(format!("'{d}' isn't a valid date."));
        }
    }
    if let Some(d) = start {
        if !valid_date(d) {
            return invalid(format!("'{d}' isn't a valid date."));
        }
    }
    if let Some(t) = time {
        if !valid_time(t) {
            return invalid(format!("'{t}' isn't a valid time."));
        }
    }
    Ok(())
}

fn validate_recurrence(v: &Value) -> AppResult<String> {
    let r: Recurrence = serde_json::from_value(v.clone())
        .map_err(|_| AppError::Invalid("Repeat rule is malformed.".into()))?;
    r.validate().map_err(AppError::Invalid)?;
    Ok(serde_json::to_string(&r)?)
}

/// (board_id, project_id, status) for a column.
fn column_info(conn: &Connection, column_id: &str) -> AppResult<(String, String, Option<String>)> {
    conn.query_row(
        "SELECT c.board_id, b.project_id, c.status FROM board_columns c JOIN boards b ON b.id = c.board_id WHERE c.id = ?1",
        [column_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("Board column".into()))
}

fn next_sort(conn: &Connection, project_id: Option<&str>, parent_id: Option<&str>) -> AppResult<f64> {
    let max: Option<f64> = match parent_id {
        Some(p) => conn.query_row("SELECT max(sort_order) FROM tasks WHERE parent_id = ?1", [p], |r| r.get(0))?,
        None => conn.query_row(
            "SELECT max(sort_order) FROM tasks WHERE parent_id IS NULL AND project_id IS ?1",
            [project_id],
            |r| r.get(0),
        )?,
    };
    Ok(max.unwrap_or(0.0) + 1.0)
}

fn next_board_order(conn: &Connection, column_id: &str) -> AppResult<f64> {
    let max: Option<f64> =
        conn.query_row("SELECT max(board_order) FROM tasks WHERE column_id = ?1", [column_id], |r| r.get(0))?;
    Ok(max.unwrap_or(0.0) + 1.0)
}

/// Who is writing: the signed-in Kern Cloud account, or nobody offline. The
/// name is cached beside the id so a row stays readable after a member
/// leaves the workspace.
fn creator(conn: &Connection) -> (Option<String>, Option<String>) {
    match cloud::current_account(conn) {
        Some(a) => {
            let name = if a.name.trim().is_empty() { a.email } else { a.name };
            (Some(a.id), Some(name))
        }
        None => (None, None),
    }
}

pub fn create_task(conn: &Connection, input: &TaskInput) -> AppResult<Task> {
    let title = input.title.trim();
    if title.is_empty() {
        return invalid("Task title can't be empty.");
    }
    validate_dates(input.due_date.as_deref(), input.due_time.as_deref(), input.start_date.as_deref())?;
    validate_dates(input.plan_date.as_deref(), input.plan_time.as_deref(), None)?;
    let mut project_id = input.project_id.clone();
    let mut status = input.status.clone().unwrap_or_else(|| "todo".into());
    if !STATUSES.contains(&status.as_str()) {
        return invalid(format!("Unknown status '{status}'."));
    }
    let mut parent_depth = 0;
    if let Some(parent) = &input.parent_id {
        let (pproj, depth): (Option<String>, i64) = conn
            .query_row(
                "WITH RECURSIVE anc(id, parent_id, d) AS (
                   SELECT id, parent_id, 0 FROM tasks WHERE id = ?1
                   UNION ALL SELECT t.id, t.parent_id, anc.d + 1 FROM tasks t JOIN anc ON t.id = anc.parent_id)
                 SELECT (SELECT project_id FROM tasks WHERE id = ?1), max(d) FROM anc",
                [parent],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| AppError::NotFound("Parent task".into()))?;
        parent_depth = depth + 1;
        if project_id.is_none() {
            project_id = pproj;
        }
        if status == "inbox" {
            status = "todo".into();
        }
    }
    if parent_depth > 4 {
        return invalid("Subtasks can be nested at most 5 levels deep.");
    }
    let mut column_id = input.column_id.clone();
    if let Some(col) = &column_id {
        let (_, proj, col_status) = column_info(conn, col)?;
        project_id = Some(proj);
        if let Some(s) = col_status {
            status = s;
        }
    }
    if input.parent_id.is_some() {
        column_id = None;
    }
    if status == "inbox" && project_id.is_some() {
        status = "todo".into();
    }
    let recurrence = match &input.recurrence {
        Some(v) if !v.is_null() => Some(validate_recurrence(v)?),
        _ => None,
    };
    let priority = input.priority.unwrap_or(0).clamp(0, 4);
    let now = now_ms();
    let id = new_id();
    let sort_order = match input.sort_order {
        Some(s) => s,
        None => next_sort(conn, project_id.as_deref(), input.parent_id.as_deref())?,
    };
    let board_order = match (input.board_order, &column_id) {
        (Some(o), _) => o,
        (None, Some(c)) => next_board_order(conn, c)?,
        _ => 0.0,
    };
    let completed_at = if status == "completed" { Some(now) } else { None };
    if let Some(m) = &input.milestone_id {
        check_milestone(conn, m, project_id.as_deref())?;
    }
    let (created_by, created_by_name) = creator(conn);
    conn.execute(
        "INSERT INTO tasks(id, title, description, status, priority, project_id, column_id, parent_id, due_date,
           due_time, start_date, estimate_minutes, sort_order, board_order, pinned, recurrence, series_id,
           reminder_minutes, completed_at, created_at, updated_at, milestone_id, plan_date, plan_time,
           created_by, created_by_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20, ?21, ?22, ?23, ?24, ?25)",
        params![
            id,
            title,
            input.description.clone().unwrap_or_default(),
            status,
            priority,
            project_id,
            column_id,
            input.parent_id,
            input.due_date,
            input.due_time,
            input.start_date,
            input.estimate_minutes,
            sort_order,
            board_order,
            input.pinned.unwrap_or(false) as i64,
            recurrence,
            recurrence.as_ref().map(|_| id.clone()),
            input.reminder_minutes,
            completed_at,
            now,
            input.milestone_id,
            input.plan_date,
            input.plan_date.as_ref().and(input.plan_time.clone()),
            created_by,
            created_by_name
        ],
    )?;
    if let Some(labels) = &input.label_ids {
        set_labels(conn, &id, labels)?;
    }
    get_task(conn, &id)
}

fn set_labels(conn: &Connection, task_id: &str, label_ids: &[String]) -> AppResult<()> {
    conn.execute("DELETE FROM task_labels WHERE task_id = ?1", [task_id])?;
    for l in label_ids {
        conn.execute("INSERT OR IGNORE INTO task_labels(task_id, label_id) VALUES (?1, ?2)", params![task_id, l])?;
    }
    Ok(())
}

// ----------------------------------------------------------------- update

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<i64>,
    #[serde(deserialize_with = "some")]
    pub project_id: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub column_id: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub parent_id: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub due_date: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub due_time: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub start_date: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub estimate_minutes: Option<Option<i64>>,
    #[serde(deserialize_with = "some")]
    pub reminder_minutes: Option<Option<i64>>,
    #[serde(deserialize_with = "some")]
    pub recurrence: Option<Option<Value>>,
    pub sort_order: Option<f64>,
    pub board_order: Option<f64>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
    pub label_ids: Option<Vec<String>>,
    pub add_label_ids: Option<Vec<String>>,
    pub remove_label_ids: Option<Vec<String>>,
    /// Seconds to add to tracked time (focus sessions).
    pub add_tracked_seconds: Option<i64>,
    #[serde(deserialize_with = "some")]
    pub milestone_id: Option<Option<String>>,
    /// 'cancelled' | 'duplicate' | null (done); only kept on completed tasks.
    #[serde(deserialize_with = "some")]
    pub resolution: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub plan_date: Option<Option<String>>,
    #[serde(deserialize_with = "some")]
    pub plan_time: Option<Option<String>>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdateResult {
    pub task: Task,
    /// Previous state, for undo.
    pub previous: Task,
    /// Next occurrence created when completing a recurring task.
    pub spawned: Option<Task>,
    /// Blocked tasks reopened because this was their last open blocker.
    pub unblocked: Vec<Task>,
}

fn today_local() -> NaiveDate {
    chrono::Local::now().date_naive()
}

/// First column in the same board mapped to `status`.
fn column_for_status(conn: &Connection, board_id: &str, status: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM board_columns WHERE board_id = ?1 AND status = ?2 ORDER BY sort_order LIMIT 1",
            params![board_id, status],
            |r| r.get(0),
        )
        .optional()?)
}

fn descendant_ids(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE d(id) AS (SELECT id FROM tasks WHERE parent_id = ?1
           UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id) SELECT id FROM d",
    )?;
    let rows = stmt.query_map([id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn update_task(conn: &Connection, id: &str, patch: &TaskPatch) -> AppResult<TaskUpdateResult> {
    let prev = get_task(conn, id)?;
    let mut t = prev.clone();
    let now = now_ms();

    if let Some(title) = &patch.title {
        let title = title.trim();
        if title.is_empty() {
            return invalid("Task title can't be empty.");
        }
        t.title = title.to_string();
    }
    if let Some(d) = &patch.description {
        t.description = d.clone();
    }
    if let Some(p) = patch.priority {
        t.priority = p.clamp(0, 4);
    }
    if let Some(v) = &patch.due_date {
        t.due_date = v.clone();
    }
    if let Some(v) = &patch.due_time {
        t.due_time = v.clone();
    }
    if let Some(v) = &patch.start_date {
        t.start_date = v.clone();
    }
    validate_dates(t.due_date.as_deref(), t.due_time.as_deref(), t.start_date.as_deref())?;
    if t.due_date.is_none() {
        t.due_time = None;
    }
    if let Some(v) = &patch.plan_date {
        t.plan_date = v.clone();
    }
    if let Some(v) = &patch.plan_time {
        t.plan_time = v.clone();
    }
    validate_dates(t.plan_date.as_deref(), t.plan_time.as_deref(), None)?;
    if t.plan_date.is_none() {
        t.plan_time = None;
    }
    if let Some(v) = patch.estimate_minutes {
        t.estimate_minutes = v;
    }
    if let Some(v) = patch.reminder_minutes {
        t.reminder_minutes = v;
    }
    if let Some(v) = patch.sort_order {
        t.sort_order = v;
    }
    if let Some(v) = patch.board_order {
        t.board_order = v;
    }
    if let Some(v) = patch.pinned {
        t.pinned = v;
    }
    if let Some(a) = patch.archived {
        t.archived_at = if a { Some(t.archived_at.unwrap_or(now)) } else { None };
    }
    if let Some(s) = patch.add_tracked_seconds {
        t.tracked_seconds = (t.tracked_seconds + s).max(0);
    }
    let mut recurrence_json: Option<String> =
        t.recurrence.as_ref().map(|v| serde_json::to_string(v)).transpose()?;
    if let Some(r) = &patch.recurrence {
        recurrence_json = match r {
            Some(v) if !v.is_null() => Some(validate_recurrence(v)?),
            _ => None,
        };
        if recurrence_json.is_some() && t.series_id.is_none() {
            t.series_id = Some(t.id.clone());
        }
    }
    if let Some(p) = &patch.parent_id {
        if let Some(pid) = p {
            if pid == id || descendant_ids(conn, id)?.contains(pid) {
                return invalid("A task can't be nested inside itself.");
            }
            t.column_id = None;
        }
        t.parent_id = p.clone();
    }

    // Project & column changes.
    if let Some(p) = &patch.project_id {
        t.project_id = p.clone();
    }
    let mut column_status: Option<String> = None;
    if let Some(c) = &patch.column_id {
        match c {
            Some(col) => {
                let (_, proj, st) = column_info(conn, col)?;
                t.project_id = Some(proj);
                t.column_id = Some(col.clone());
                // An unmapped column (e.g. Backlog) reopens a completed card.
                column_status = match st {
                    None if t.status == "completed" && prev.column_id.as_deref() != Some(col) => Some("todo".into()),
                    other => other,
                };
                if patch.board_order.is_none() && prev.column_id.as_deref() != Some(col) {
                    t.board_order = next_board_order(conn, col)?;
                }
            }
            None => t.column_id = None,
        }
    } else if t.project_id != prev.project_id {
        // Moving to another project drops the old board placement.
        t.column_id = None;
    }

    // Milestones belong to one project: an explicit assignment is checked,
    // and moving the task elsewhere drops a milestone it can't keep.
    if let Some(m) = &patch.milestone_id {
        if let Some(mid) = m {
            check_milestone(conn, mid, t.project_id.as_deref())?;
        }
        t.milestone_id = m.clone();
    } else if t.project_id != prev.project_id {
        t.milestone_id = None;
    }

    // Status resolution: explicit status wins; otherwise a mapped column's.
    let requested = patch.status.clone().or(column_status);
    if let Some(s) = requested {
        if !STATUSES.contains(&s.as_str()) {
            return invalid(format!("Unknown status '{s}'."));
        }
        t.status = s;
    }
    // Assigning a project organises an inbox task.
    if t.status == "inbox" && t.project_id.is_some() {
        t.status = "todo".into();
    }
    // Keep board placement in sync when the status changed outside the board.
    if patch.status.is_some() && patch.column_id.is_none() && t.status != prev.status {
        if let Some(col) = &t.column_id {
            if let Ok((board_id, _, col_status)) = column_info(conn, col) {
                if col_status.as_deref() != Some(t.status.as_str()) {
                    if let Some(target) = column_for_status(conn, &board_id, &t.status)? {
                        t.board_order = next_board_order(conn, &target)?;
                        t.column_id = Some(target);
                    }
                }
            }
        }
    }

    let completing = t.status == "completed" && prev.status != "completed";
    let reopening = t.status != "completed" && prev.status == "completed";
    if completing {
        t.completed_at = Some(now);
    } else if reopening {
        t.completed_at = None;
    }
    // A resolution only describes a completed task; completing afresh
    // without one means done.
    if let Some(r) = &patch.resolution {
        if let Some(v) = r {
            if !RESOLUTIONS.contains(&v.as_str()) {
                return invalid(format!("Unknown resolution '{v}'."));
            }
        }
        t.resolution = r.clone();
    } else if completing {
        t.resolution = None;
    }
    if t.status != "completed" {
        t.resolution = None;
    }

    // Recurrence: completing an occurrence moves the rule onto a new one.
    let mut spawned: Option<Task> = None;
    if completing {
        if let Some(rule_json) = recurrence_json.clone() {
            let rule: Recurrence = serde_json::from_str(&rule_json)?;
            let due = t.due_date.as_deref().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
            let next = rule.next_occurrence(due, today_local());
            let start_shift = match (due, t.start_date.as_deref().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())) {
                (Some(d), Some(s)) => Some((next - (d - s)).format("%Y-%m-%d").to_string()),
                _ => None,
            };
            let first_column = match &t.column_id {
                Some(col) => {
                    let (board_id, _, _) = column_info(conn, col)?;
                    conn.query_row(
                        "SELECT id FROM board_columns WHERE board_id = ?1 AND (status IS NULL OR status != 'completed') ORDER BY sort_order LIMIT 1",
                        [board_id],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?
                }
                None => None,
            };
            let input = TaskInput {
                title: t.title.clone(),
                description: Some(t.description.clone()),
                status: Some(if prev.status == "inbox" { "inbox".into() } else { "todo".into() }),
                priority: Some(t.priority),
                project_id: t.project_id.clone(),
                column_id: first_column,
                parent_id: t.parent_id.clone(),
                due_date: Some(next.format("%Y-%m-%d").to_string()),
                due_time: t.due_time.clone(),
                start_date: start_shift,
                estimate_minutes: t.estimate_minutes,
                pinned: Some(t.pinned),
                recurrence: None,
                label_ids: Some(t.label_ids.clone()),
                reminder_minutes: t.reminder_minutes,
                sort_order: Some(t.sort_order + 0.001),
                board_order: None,
                milestone_id: t.milestone_id.clone(),
                plan_date: None,
                plan_time: None,
            };
            let mut next_task = create_task(conn, &input)?;
            let series = t.series_id.clone().unwrap_or_else(|| t.id.clone());
            conn.execute(
                "UPDATE tasks SET recurrence = ?1, series_id = ?2 WHERE id = ?3",
                params![rule_json, series, next_task.id],
            )?;
            // Carry the checklist forward, reset to open.
            let mut stmt = conn.prepare(
                "SELECT title, description, priority, sort_order FROM tasks WHERE parent_id = ?1 AND deleted_at IS NULL ORDER BY sort_order",
            )?;
            let subs: Vec<(String, String, i64, f64)> = stmt
                .query_map([&t.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<Result<_, _>>()?;
            for (title, description, priority, sort_order) in subs {
                create_task(
                    conn,
                    &TaskInput {
                        title,
                        description: Some(description),
                        priority: Some(priority),
                        parent_id: Some(next_task.id.clone()),
                        sort_order: Some(sort_order),
                        ..Default::default()
                    },
                )?;
            }
            t.series_id = Some(series);
            recurrence_json = None;
            next_task = get_task(conn, &next_task.id)?;
            spawned = Some(next_task);
        }
    }

    conn.execute(
        "UPDATE tasks SET title = ?1, description = ?2, status = ?3, priority = ?4, project_id = ?5, column_id = ?6,
           parent_id = ?7, due_date = ?8, due_time = ?9, start_date = ?10, estimate_minutes = ?11,
           tracked_seconds = ?12, sort_order = ?13, board_order = ?14, pinned = ?15, recurrence = ?16,
           series_id = ?17, reminder_minutes = ?18, completed_at = ?19, archived_at = ?20, updated_at = ?21,
           milestone_id = ?23, resolution = ?24, plan_date = ?25, plan_time = ?26
         WHERE id = ?22",
        params![
            t.title,
            t.description,
            t.status,
            t.priority,
            t.project_id,
            t.column_id,
            t.parent_id,
            t.due_date,
            t.due_time,
            t.start_date,
            t.estimate_minutes,
            t.tracked_seconds,
            t.sort_order,
            t.board_order,
            t.pinned as i64,
            recurrence_json,
            t.series_id,
            t.reminder_minutes,
            t.completed_at,
            t.archived_at,
            now,
            id,
            t.milestone_id,
            t.resolution,
            t.plan_date,
            t.plan_time
        ],
    )?;

    // Subtasks follow their parent's project.
    if t.project_id != prev.project_id {
        for d in descendant_ids(conn, id)? {
            conn.execute("UPDATE tasks SET project_id = ?1, updated_at = ?2 WHERE id = ?3", params![t.project_id, now, d])?;
        }
    }

    if let Some(labels) = &patch.label_ids {
        set_labels(conn, id, labels)?;
    }
    if let Some(add) = &patch.add_label_ids {
        for l in add {
            conn.execute("INSERT OR IGNORE INTO task_labels(task_id, label_id) VALUES (?1, ?2)", params![id, l])?;
        }
    }
    if let Some(rm) = &patch.remove_label_ids {
        for l in rm {
            conn.execute("DELETE FROM task_labels WHERE task_id = ?1 AND label_id = ?2", params![id, l])?;
        }
    }

    // Activity (meaningful events only).
    let proj = t.project_id.as_deref();
    if completing {
        let action = if t.resolution.is_some() { "cancelled" } else { "completed" };
        activity::log(conn, proj, "task", id, action, &t.title)?;
    } else if reopening {
        activity::log(conn, proj, "task", id, "reopened", &t.title)?;
    }
    if t.due_date != prev.due_date && !completing {
        let summary = match &t.due_date {
            Some(d) => format!("{} → {}", t.title, d),
            None => format!("{} (no date)", t.title),
        };
        activity::log(conn, proj, "task", id, "rescheduled", &summary)?;
    }
    if t.column_id != prev.column_id && t.column_id.is_some() && !completing {
        let col_name: Option<String> = conn
            .query_row("SELECT name FROM board_columns WHERE id = ?1", [&t.column_id], |r| r.get(0))
            .optional()?;
        activity::log(conn, proj, "task", id, "moved", &format!("{} → {}", t.title, col_name.unwrap_or_default()))?;
    } else if t.project_id != prev.project_id {
        activity::log(conn, proj, "task", id, "moved", &t.title)?;
    }
    if t.archived_at.is_some() && prev.archived_at.is_none() {
        activity::log(conn, proj, "task", id, "archived", &t.title)?;
    }

    // Tasks marked Blocked go back to To Do once their last blocker closes.
    let mut unblocked = Vec::new();
    if completing {
        let mut stmt = conn.prepare(
            "SELECT b.id FROM task_relations r JOIN tasks b ON b.id = r.related_id
             WHERE r.task_id = ?1 AND r.kind = 'blocks' AND b.status = 'blocked' AND b.deleted_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM task_relations o JOIN tasks ob ON ob.id = o.task_id
                 WHERE o.related_id = b.id AND o.kind = 'blocks' AND ob.status != 'completed' AND ob.deleted_at IS NULL)",
        )?;
        let ids: Vec<String> = stmt.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        for b in ids {
            let r = update_task(conn, &b, &TaskPatch { status: Some("todo".into()), ..Default::default() })?;
            activity::log(conn, r.task.project_id.as_deref(), "task", &b, "unblocked", &r.task.title)?;
            unblocked.push(r.task);
        }
    }

    Ok(TaskUpdateResult { task: get_task(conn, id)?, previous: prev, spawned, unblocked })
}

// ---------------------------------------------------------- duplication

pub fn duplicate_task(conn: &Connection, id: &str, parent_override: Option<Option<String>>) -> AppResult<Task> {
    let src = get_task(conn, id)?;
    let input = TaskInput {
        title: if parent_override.is_none() { format!("{} (copy)", src.title) } else { src.title.clone() },
        description: Some(src.description.clone()),
        status: Some(if src.status == "completed" { "todo".into() } else { src.status.clone() }),
        priority: Some(src.priority),
        project_id: src.project_id.clone(),
        column_id: if parent_override.is_some() { None } else { src.column_id.clone() },
        parent_id: parent_override.clone().unwrap_or(src.parent_id.clone()),
        due_date: src.due_date.clone(),
        due_time: src.due_time.clone(),
        start_date: src.start_date.clone(),
        estimate_minutes: src.estimate_minutes,
        pinned: Some(src.pinned),
        recurrence: src.recurrence.clone(),
        label_ids: Some(src.label_ids.clone()),
        reminder_minutes: src.reminder_minutes,
        sort_order: Some(src.sort_order + 0.0005),
        board_order: Some(src.board_order + 0.0005),
        milestone_id: if parent_override.is_none() { src.milestone_id.clone() } else { None },
        plan_date: None,
        plan_time: None,
    };
    let copy = create_task(conn, &input)?;
    let mut stmt = conn.prepare("SELECT id FROM tasks WHERE parent_id = ?1 AND deleted_at IS NULL ORDER BY sort_order")?;
    let children: Vec<String> = stmt.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for c in children {
        duplicate_task(conn, &c, Some(Some(copy.id.clone())))?;
    }
    get_task(conn, &copy.id)
}

/// Copies a task and its checklist into another project. Unlike a duplicate
/// the title is kept — the copy lives somewhere else — and everything tied to
/// the source project is dropped: its board column and its milestone. The
/// copy is open even when the source was done, so it reads as work to do.
pub fn copy_into_project(conn: &Connection, id: &str, project_id: Option<&str>) -> AppResult<Task> {
    passkeys::ensure_readable_opt(conn, project_id)?;
    if let Some(p) = project_id {
        let exists: Option<String> = conn
            .query_row("SELECT id FROM projects WHERE id = ?1 AND deleted_at IS NULL", [p], |r| r.get(0))
            .optional()?;
        if exists.is_none() {
            return Err(AppError::NotFound("Project".into()));
        }
    }
    copy_subtree(conn, id, project_id, None)
}

fn copy_subtree(conn: &Connection, id: &str, project_id: Option<&str>, parent_id: Option<String>) -> AppResult<Task> {
    let src = get_task(conn, id)?;
    let sub = parent_id.is_some();
    let input = TaskInput {
        title: src.title.clone(),
        description: Some(src.description.clone()),
        status: Some(if src.status == "completed" { "todo".into() } else { src.status.clone() }),
        priority: Some(src.priority),
        project_id: project_id.map(String::from),
        // The target project has its own board and milestones.
        column_id: None,
        parent_id,
        due_date: src.due_date.clone(),
        due_time: src.due_time.clone(),
        start_date: src.start_date.clone(),
        estimate_minutes: src.estimate_minutes,
        pinned: Some(false),
        recurrence: if sub { None } else { src.recurrence.clone() },
        label_ids: Some(src.label_ids.clone()),
        reminder_minutes: src.reminder_minutes,
        sort_order: None,
        board_order: None,
        milestone_id: None,
        plan_date: None,
        plan_time: None,
    };
    let copy = create_task(conn, &input)?;
    let mut stmt = conn.prepare("SELECT id FROM tasks WHERE parent_id = ?1 AND deleted_at IS NULL ORDER BY sort_order")?;
    let children: Vec<String> = stmt.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for c in children {
        copy_subtree(conn, &c, project_id, Some(copy.id.clone()))?;
    }
    get_task(conn, &copy.id)
}

// ------------------------------------------------------------- deletion

pub fn soft_delete(conn: &Connection, ids: &[String]) -> AppResult<()> {
    let now = now_ms();
    for id in ids {
        let mut all = descendant_ids(conn, id)?;
        all.push(id.clone());
        for t in all {
            conn.execute(
                "UPDATE tasks SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                params![now, t],
            )?;
        }
    }
    Ok(())
}

pub fn restore(conn: &Connection, ids: &[String]) -> AppResult<()> {
    for id in ids {
        let deleted_at: Option<i64> =
            conn.query_row("SELECT deleted_at FROM tasks WHERE id = ?1", [id], |r| r.get(0)).optional()?.flatten();
        let Some(ts) = deleted_at else { continue };
        // Restore the task and descendants deleted in the same operation.
        let mut all = descendant_ids(conn, id)?;
        all.push(id.clone());
        for t in all {
            conn.execute(
                "UPDATE tasks SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2 AND deleted_at = ?3",
                params![now_ms(), t, ts],
            )?;
        }
        // If the parent is gone, promote to top level; if the project is
        // gone, move to the inbox.
        conn.execute(
            "UPDATE tasks SET parent_id = NULL WHERE id = ?1 AND parent_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.id = tasks.parent_id AND p.deleted_at IS NULL)",
            [id],
        )?;
        conn.execute(
            "UPDATE tasks SET project_id = NULL, column_id = NULL WHERE id = ?1 AND project_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = tasks.project_id AND p.deleted_at IS NULL)",
            [id],
        )?;
    }
    Ok(())
}

// --------------------------------------------------------------- commands

#[tauri::command]
pub fn tasks_query(state: State<AppState>, query: TaskQuery) -> AppResult<Vec<Task>> {
    state.with(|c| query_tasks(c, &query))
}

#[tauri::command]
pub fn task_get(state: State<AppState>, id: String) -> AppResult<Task> {
    state.with(|c| get_task(c, &id))
}

#[tauri::command]
pub fn task_create(state: State<AppState>, input: TaskInput) -> AppResult<Task> {
    state.with(|c| {
        let tx = c.transaction()?;
        let t = create_task(&tx, &input)?;
        tx.commit()?;
        Ok(t)
    })
}

#[tauri::command]
pub fn task_update(state: State<AppState>, id: String, patch: TaskPatch) -> AppResult<TaskUpdateResult> {
    state.with(|c| {
        let tx = c.transaction()?;
        let r = update_task(&tx, &id, &patch)?;
        tx.commit()?;
        Ok(r)
    })
}

#[tauri::command]
pub fn tasks_update_many(state: State<AppState>, ids: Vec<String>, patch: TaskPatch) -> AppResult<Vec<TaskUpdateResult>> {
    state.with(|c| {
        let tx = c.transaction()?;
        let mut out = Vec::with_capacity(ids.len());
        for id in &ids {
            out.push(update_task(&tx, id, &patch)?);
        }
        tx.commit()?;
        Ok(out)
    })
}

/// Applies a set of per-task patches atomically (used for undo and reorders).
#[tauri::command]
pub fn tasks_patch_batch(state: State<AppState>, items: Vec<(String, TaskPatch)>) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        for (id, patch) in &items {
            update_task(&tx, id, patch)?;
        }
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn task_duplicate(state: State<AppState>, id: String) -> AppResult<Task> {
    state.with(|c| {
        let tx = c.transaction()?;
        let t = duplicate_task(&tx, &id, None)?;
        tx.commit()?;
        Ok(t)
    })
}

/// Copies tasks into another project (`project_id` None is the Inbox). A task
/// whose parent is in the same request is left out: it already travels with
/// the parent's checklist.
#[tauri::command]
pub fn tasks_copy_to_project(state: State<AppState>, ids: Vec<String>, project_id: Option<String>) -> AppResult<Vec<Task>> {
    state.with(|c| {
        let tx = c.transaction()?;
        let mut carried: std::collections::HashSet<String> = std::collections::HashSet::new();
        for id in &ids {
            carried.extend(descendant_ids(&tx, id)?);
        }
        let mut out = Vec::new();
        for id in &ids {
            if carried.contains(id) {
                continue;
            }
            out.push(copy_into_project(&tx, id, project_id.as_deref())?);
        }
        tx.commit()?;
        Ok(out)
    })
}

#[tauri::command]
pub fn tasks_delete(state: State<AppState>, ids: Vec<String>) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        soft_delete(&tx, &ids)?;
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn tasks_restore(state: State<AppState>, ids: Vec<String>) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        restore(&tx, &ids)?;
        tx.commit()?;
        Ok(())
    })
}

/// Permanently removes tasks (used to undo a spawned recurrence and by
/// "delete forever" in the trash).
#[tauri::command]
pub fn tasks_purge(state: State<AppState>, ids: Vec<String>) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        for id in &ids {
            crate::domain::attachments::remove_files_for_task(&tx, id)?;
            tx.execute("DELETE FROM tasks WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(())
    })
}

/// Reassigns sequential sort orders for an ordered list of sibling tasks.
#[tauri::command]
pub fn tasks_reorder(state: State<AppState>, ids: Vec<String>, field: Option<String>) -> AppResult<()> {
    let col = if field.as_deref() == Some("board") { "board_order" } else { "sort_order" };
    state.with(|c| {
        let tx = c.transaction()?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(&format!("UPDATE tasks SET {col} = ?1 WHERE id = ?2"), params![(i + 1) as f64, id])?;
        }
        tx.commit()?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;

    fn input(title: &str) -> TaskInput {
        TaskInput { title: title.into(), ..Default::default() }
    }

    #[test]
    fn create_and_complete() {
        let c = open_memory();
        let t = create_task(&c, &input("Write report")).unwrap();
        assert_eq!(t.status, "todo");
        let r = update_task(&c, &t.id, &TaskPatch { status: Some("completed".into()), ..Default::default() }).unwrap();
        assert!(r.task.completed_at.is_some());
        assert!(r.spawned.is_none());
        let r = update_task(&c, &t.id, &TaskPatch { status: Some("todo".into()), ..Default::default() }).unwrap();
        assert!(r.task.completed_at.is_none());
    }

    #[test]
    fn a_span_matches_a_window_it_only_passes_over() {
        let c = open_memory();
        let mut across = input("Across the month");
        across.start_date = Some("2026-09-20".into());
        across.due_date = Some("2026-11-10".into());
        create_task(&c, &across).unwrap();
        let mut inside = input("Due inside");
        inside.due_date = Some("2026-10-14".into());
        create_task(&c, &inside).unwrap();
        let mut after = input("Due after");
        after.due_date = Some("2026-11-20".into());
        create_task(&c, &after).unwrap();

        let window = TaskQuery {
            due_from: Some("2026-09-28".into()),
            due_to: Some("2026-11-08".into()),
            ..Default::default()
        };
        let titles = |q: &TaskQuery| {
            let mut t: Vec<String> = query_tasks(&c, q).unwrap().into_iter().map(|x| x.title).collect();
            t.sort();
            t
        };
        // By due date alone the run across the window is missed.
        assert_eq!(titles(&window), vec!["Due inside".to_string()]);
        let overlap = TaskQuery { due_overlap: true, ..window };
        assert_eq!(titles(&overlap), vec!["Across the month".to_string(), "Due inside".to_string()]);
    }

    #[test]
    fn copies_a_task_and_its_checklist_into_another_project() {
        let c = open_memory();
        let src = crate::domain::projects::create_project(
            &c,
            &crate::domain::projects::ProjectInput {
                name: "Source".into(),
                description: None,
                icon: None,
                accent: None,
                target_date: None,
                group_id: None,
                default_view: None,
                folder: None,
            },
        )
        .unwrap();
        let dest = crate::domain::projects::create_project(
            &c,
            &crate::domain::projects::ProjectInput {
                name: "Dest".into(),
                description: None,
                icon: None,
                accent: None,
                target_date: None,
                group_id: None,
                default_view: None,
                folder: None,
            },
        )
        .unwrap();
        let mut i = input("Ship the thing");
        i.project_id = Some(src.id.clone());
        let parent = create_task(&c, &i).unwrap();
        let mut sub = input("Write the notes");
        sub.parent_id = Some(parent.id.clone());
        sub.project_id = Some(src.id.clone());
        create_task(&c, &sub).unwrap();

        let copy = copy_into_project(&c, &parent.id, Some(&dest.id)).unwrap();
        // The title travels as it is: the copy lives somewhere else.
        assert_eq!(copy.title, "Ship the thing");
        assert_eq!(copy.project_id.as_deref(), Some(dest.id.as_str()));
        assert_eq!(copy.subtask_count, 1);
        assert!(copy.column_id.is_none() && copy.milestone_id.is_none());
        // The source is untouched.
        let still = get_task(&c, &parent.id).unwrap();
        assert_eq!(still.project_id.as_deref(), Some(src.id.as_str()));
        assert!(copy_into_project(&c, &parent.id, Some("no-such-project")).is_err());
    }

    #[test]
    fn rejects_empty_title_and_bad_dates() {
        let c = open_memory();
        assert!(create_task(&c, &input("  ")).is_err());
        let mut i = input("x");
        i.due_date = Some("2026-02-30".into());
        assert!(create_task(&c, &i).is_err());
    }

    #[test]
    fn recurring_completion_spawns_next_and_keeps_history() {
        let c = open_memory();
        let mut i = input("Water plants");
        i.due_date = Some("2099-01-05".into());
        i.recurrence = Some(serde_json::json!({"freq": "daily", "interval": 2}));
        let t = create_task(&c, &i).unwrap();
        let sub = create_task(&c, &TaskInput { parent_id: Some(t.id.clone()), ..input("Check soil") }).unwrap();
        update_task(&c, &sub.id, &TaskPatch { status: Some("completed".into()), ..Default::default() }).unwrap();
        let r = update_task(&c, &t.id, &TaskPatch { status: Some("completed".into()), ..Default::default() }).unwrap();
        let next = r.spawned.expect("spawned occurrence");
        assert_eq!(next.due_date.as_deref(), Some("2099-01-07"));
        assert!(next.recurrence.is_some());
        assert_eq!(next.subtask_count, 1);
        assert_eq!(next.subtask_done, 0);
        assert!(r.task.recurrence.is_none(), "completed occurrence is history");
        assert_eq!(r.task.series_id, next.series_id);
    }

    #[test]
    fn soft_delete_and_restore_subtree() {
        let c = open_memory();
        let p = create_task(&c, &input("Parent")).unwrap();
        let ch = create_task(&c, &TaskInput { parent_id: Some(p.id.clone()), ..input("Child") }).unwrap();
        soft_delete(&c, &[p.id.clone()]).unwrap();
        assert!(query_tasks(&c, &TaskQuery::default()).unwrap().is_empty());
        restore(&c, &[p.id.clone()]).unwrap();
        let all = query_tasks(&c, &TaskQuery::default()).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|t| t.id == ch.id));
    }

    #[test]
    fn prevents_cycles() {
        let c = open_memory();
        let a = create_task(&c, &input("A")).unwrap();
        let b = create_task(&c, &TaskInput { parent_id: Some(a.id.clone()), ..input("B") }).unwrap();
        let r = update_task(&c, &a.id, &TaskPatch { parent_id: Some(Some(b.id.clone())), ..Default::default() });
        assert!(r.is_err());
    }

    #[test]
    fn search_index_follows_tasks() {
        let c = open_memory();
        let t = create_task(&c, &input("Quarterly budget review")).unwrap();
        let n: i64 = c
            .query_row("SELECT count(*) FROM search_fts WHERE search_fts MATCH 'budget*'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        soft_delete(&c, &[t.id]).unwrap();
        let n: i64 = c
            .query_row("SELECT count(*) FROM search_fts WHERE search_fts MATCH 'budget*'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}
