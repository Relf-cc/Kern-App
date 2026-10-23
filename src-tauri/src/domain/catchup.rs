// @Author Christian Relf
// @Date 2026-10-12

//! Project catch-up: what happened in a project over a period, and what
//! needs doing next.
//!
//! The digest is built locally and deterministically from Kern's own data
//! (tasks, notes, milestones, sessions, activity) plus, when chosen,
//! development data (local git history of trusted repositories and GitHub
//! data Kern already fetched). Every line points at numbered sources, so the
//! interface can link each claim to the task, note, commit or pull request
//! behind it. It works with no AI configured at all.
//!
//! The optional AI summary is built from the same numbered sources only (no
//! file contents), after the user sees which categories are included and an
//! estimate of the size. It honours the global "AI may use project content"
//! setting and the project's own opt-out, redacts key-shaped strings, and
//! drops any claim that cites sources it wasn't given.

use crate::domain::ai::router::{self, RouteRequest};
use crate::domain::ai::vault::redact;
use crate::domain::{git, passkeys, repos, sessions, settings};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use tauri::AppHandle;

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Include {
    pub tasks: bool,
    pub notes: bool,
    pub milestones: bool,
    pub sessions: bool,
    pub commits: bool,
    pub github: bool,
}

impl Default for Include {
    fn default() -> Self {
        Include { tasks: true, notes: true, milestones: true, sessions: true, commits: true, github: true }
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    /// task | note | milestone | commit | pull | issue | run | session
    pub kind: String,
    pub ref_id: String,
    pub title: String,
    pub detail: Option<String>,
    pub url: Option<String>,
    pub repository_id: Option<String>,
    pub at: Option<i64>,
    /// Which category it belongs to (for exclusions).
    pub category: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub text: String,
    pub sources: Vec<String>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Digest {
    pub project_id: String,
    pub project_name: String,
    pub from: i64,
    pub to: i64,
    pub what_changed: Vec<Line>,
    pub completed: Vec<Line>,
    pub needs_attention: Vec<Line>,
    pub next_steps: Vec<Line>,
    pub sources: Vec<Source>,
    pub counts: BTreeMap<String, i64>,
}

struct B {
    d: Digest,
}

impl B {
    fn src(&mut self, kind: &str, category: &str, ref_id: &str, title: &str, detail: Option<String>, url: Option<String>, repository_id: Option<String>, at: Option<i64>) -> String {
        if let Some(s) = self.d.sources.iter().find(|s| s.kind == kind && s.ref_id == ref_id) {
            return s.id.clone();
        }
        let id = format!("S{}", self.d.sources.len() + 1);
        self.d.sources.push(Source { id: id.clone(), kind: kind.into(), ref_id: ref_id.into(), title: clean(title), detail: detail.map(|d| clean(&d)), url, repository_id, at, category: category.into() });
        id
    }
    fn count(&mut self, k: &str, n: i64) {
        *self.d.counts.entry(k.into()).or_default() += n;
    }
}

/// Redacts key-shaped strings and trims to one line.
fn clean(s: &str) -> String {
    let mut out = redact(s, None);
    for prefix in ["ghp_", "gho_", "github_pat_", "xoxb-", "xoxp-", "AKIA", "glpat-"] {
        while let Some(i) = out.find(prefix) {
            let end = out[i..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).map(|e| i + e).unwrap_or(out.len());
            if end - i < 12 {
                break;
            }
            out.replace_range(i..end, "[redacted]");
        }
    }
    out.lines().next().unwrap_or("").chars().take(240).collect()
}

fn day(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string()).unwrap_or_default()
}

fn plural(n: i64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn fmt_ms(ms: i64) -> String {
    let m = ms / 60_000;
    if m >= 60 {
        format!("{}h {}m", m / 60, m % 60)
    } else {
        format!("{m}m")
    }
}

fn cached(conn: &Connection, key: &str) -> Option<Value> {
    conn.query_row("SELECT data FROM dev_cache WHERE key = ?1", [key], |r| r.get::<_, String>(0)).optional().ok().flatten().and_then(|s| serde_json::from_str(&s).ok())
}

fn iso_ms(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s).map(|d| d.timestamp_millis()).unwrap_or(0)
}

/// Kern's own data for the period (no git, no network).
fn local_part(conn: &Connection, b: &mut B, project_id: &str, from: i64, to: i64, inc: &Include) -> AppResult<()> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if inc.tasks {
        let mut stmt = conn.prepare(
            "SELECT id, title, completed_at FROM tasks WHERE project_id = ?1 AND deleted_at IS NULL AND parent_id IS NULL
             AND resolution IS NULL AND completed_at >= ?2 AND completed_at < ?3 ORDER BY completed_at DESC LIMIT 40",
        )?;
        let done: Vec<(String, String, i64)> = stmt.query_map(params![project_id, from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
        b.count("tasksCompleted", done.len() as i64);
        for (id, title, at) in &done {
            let s = b.src("task", "tasks", id, title, Some("completed".into()), None, None, Some(*at));
            b.d.completed.push(Line { text: clean(title), sources: vec![s] });
        }
        let mut stmt = conn.prepare(
            "SELECT id, title, created_at FROM tasks WHERE project_id = ?1 AND deleted_at IS NULL AND parent_id IS NULL
             AND created_at >= ?2 AND created_at < ?3 ORDER BY created_at DESC LIMIT 40",
        )?;
        let created: Vec<(String, String, i64)> = stmt.query_map(params![project_id, from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
        b.count("tasksCreated", created.len() as i64);
        if !created.is_empty() {
            let ids: Vec<String> = created.iter().take(8).map(|(id, t, at)| b.src("task", "tasks", id, t, Some("created".into()), None, None, Some(*at))).collect();
            let names: Vec<String> = created.iter().take(3).map(|(_, t, _)| clean(t)).collect();
            b.d.what_changed.push(Line { text: format!("Added {} ({}{})", plural(created.len() as i64, "task", "tasks"), names.join(", "), if created.len() > 3 { ", …" } else { "" }), sources: ids });
        }
        // Rescheduling and board moves, from the activity log.
        let mut stmt = conn.prepare(
            "SELECT entity_id, action, summary, created_at FROM activity WHERE project_id = ?1 AND entity_type = 'task' AND action IN ('rescheduled', 'moved')
             AND created_at >= ?2 AND created_at < ?3 ORDER BY created_at DESC LIMIT 30",
        )?;
        let moves: Vec<(String, String, String, i64)> = stmt.query_map(params![project_id, from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<_, _>>()?;
        let resched: Vec<_> = moves.iter().filter(|m| m.1 == "rescheduled").collect();
        let moved: Vec<_> = moves.iter().filter(|m| m.1 == "moved").collect();
        if !resched.is_empty() {
            let ids = resched.iter().take(6).map(|m| b.src("task", "tasks", &m.0, m.2.split(" → ").next().unwrap_or(&m.2), Some(format!("rescheduled: {}", m.2)), None, None, Some(m.3))).collect();
            b.d.what_changed.push(Line { text: format!("Changed {}", plural(resched.len() as i64, "deadline", "deadlines")), sources: ids });
        }
        if !moved.is_empty() {
            let ids = moved.iter().take(6).map(|m| b.src("task", "tasks", &m.0, m.2.split(" → ").next().unwrap_or(&m.2), Some(format!("moved: {}", m.2)), None, None, Some(m.3))).collect();
            b.d.what_changed.push(Line { text: format!("Moved {} on the board", plural(moved.len() as i64, "card", "cards")), sources: ids });
        }
        // Current state: overdue and blocked work, and what to do next.
        let mut stmt = conn.prepare(
            "SELECT id, title, due_date, status, priority FROM tasks WHERE project_id = ?1 AND deleted_at IS NULL AND archived_at IS NULL AND parent_id IS NULL
             AND status != 'completed' ORDER BY (due_date IS NULL), due_date, priority DESC, sort_order LIMIT 400",
        )?;
        let open: Vec<(String, String, Option<String>, String, i64)> = stmt.query_map([project_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<Result<_, _>>()?;
        let overdue: Vec<_> = open.iter().filter(|t| t.2.as_deref().is_some_and(|d| d < today.as_str())).collect();
        let blocked: Vec<_> = open.iter().filter(|t| t.3 == "blocked").collect();
        b.count("overdue", overdue.len() as i64);
        b.count("blocked", blocked.len() as i64);
        for t in overdue.iter().take(5) {
            let s = b.src("task", "tasks", &t.0, &t.1, Some(format!("overdue since {}", t.2.clone().unwrap_or_default())), None, None, None);
            b.d.needs_attention.push(Line { text: format!("Overdue: {}", clean(&t.1)), sources: vec![s] });
        }
        for t in blocked.iter().take(5) {
            let s = b.src("task", "tasks", &t.0, &t.1, Some("blocked".into()), None, None, None);
            b.d.needs_attention.push(Line { text: format!("Blocked: {}", clean(&t.1)), sources: vec![s] });
        }
        // Next steps: overdue first, then in progress, then due soonest / highest priority.
        let mut next: Vec<&(String, String, Option<String>, String, i64)> = overdue.iter().copied().filter(|t| t.3 != "blocked").collect();
        let in_progress: Vec<_> = open.iter().filter(|t| t.3 == "in_progress" && !next.iter().any(|n| n.0 == t.0)).collect();
        next.extend(in_progress);
        let mut rest: Vec<_> = open.iter().filter(|t| t.3 != "blocked" && !next.iter().any(|n| n.0 == t.0)).collect();
        rest.sort_by(|a, b| a.2.is_none().cmp(&b.2.is_none()).then(a.2.cmp(&b.2)).then(b.4.cmp(&a.4)));
        next.extend(rest);
        for t in next.into_iter().take(3) {
            let why = if t.2.as_deref().is_some_and(|d| d < today.as_str()) { "overdue" } else if t.3 == "in_progress" { "in progress" } else if let Some(d) = &t.2 { d } else { "open" };
            let s = b.src("task", "tasks", &t.0, &t.1, Some(why.to_string()), None, None, None);
            b.d.next_steps.push(Line { text: format!("{} ({why})", clean(&t.1)), sources: vec![s] });
        }
    }
    if inc.notes {
        let mut stmt = conn.prepare(
            "SELECT id, title, updated_at, created_at FROM notes WHERE project_id = ?1 AND deleted_at IS NULL AND updated_at >= ?2 AND updated_at < ?3 ORDER BY updated_at DESC LIMIT 12",
        )?;
        let notes: Vec<(String, String, i64, i64)> = stmt.query_map(params![project_id, from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<_, _>>()?;
        b.count("notes", notes.len() as i64);
        if !notes.is_empty() {
            let ids = notes.iter().map(|n| b.src("note", "notes", &n.0, if n.1.trim().is_empty() { "Untitled note" } else { &n.1 }, Some(if n.3 >= from { "created".into() } else { "edited".into() }), None, None, Some(n.2))).collect();
            b.d.what_changed.push(Line { text: format!("Wrote or edited {}", plural(notes.len() as i64, "note", "notes")), sources: ids });
        }
    }
    if inc.milestones {
        for m in crate::domain::milestones::list(conn, project_id)? {
            let label = match (&m.version, m.is_release) {
                (Some(v), true) => format!("{} ({v})", m.title),
                _ => m.title.clone(),
            };
            if m.completed_at.is_some_and(|c| c >= from && c < to) {
                let s = b.src("milestone", "milestones", &m.id, &label, Some("completed".into()), m.release_url.clone(), None, m.completed_at);
                b.d.completed.push(Line { text: format!("Milestone reached: {}", clean(&label)), sources: vec![s] });
                b.count("milestonesCompleted", 1);
            } else if m.overdue {
                let s = b.src("milestone", "milestones", &m.id, &label, Some(format!("target {} passed, {:.0}% done", m.target_date.clone().unwrap_or_default(), m.progress * 100.0)), None, None, None);
                b.d.needs_attention.push(Line { text: format!("Milestone past its target: {}", clean(&label)), sources: vec![s] });
            } else if (m.status == "planned" || m.status == "active") && m.target_date.is_some() && b.d.next_steps.len() < 5 {
                let s = b.src("milestone", "milestones", &m.id, &label, Some(format!("target {}, {:.0}% done", m.target_date.clone().unwrap_or_default(), m.progress * 100.0)), None, None, None);
                b.d.next_steps.push(Line { text: format!("Keep {} on track (target {})", clean(&label), m.target_date.clone().unwrap_or_default()), sources: vec![s] });
            }
        }
    }
    if inc.sessions {
        let list = sessions::list(conn, &sessions::SessionQuery { from: Some(from), to: Some(to), project_id: Some(project_id.to_string()), task_id: None, limit: Some(200) })?;
        if !list.is_empty() {
            let total: i64 = list.iter().map(|s| s.elapsed_ms).sum();
            b.count("sessionMs", total);
            let mut by_task: BTreeMap<String, (String, i64)> = BTreeMap::new();
            for s in &list {
                if let (Some(t), Some(title)) = (&s.task_id, &s.task_title) {
                    by_task.entry(t.clone()).or_insert((title.clone(), 0)).1 += s.elapsed_ms;
                }
            }
            let mut top: Vec<_> = by_task.into_iter().collect();
            top.sort_by(|a, b| b.1 .1.cmp(&a.1 .1));
            let ids = top.iter().take(3).map(|(id, (t, ms))| b.src("task", "sessions", id, t, Some(format!("{} worked", fmt_ms(*ms))), None, None, None)).collect();
            b.d.what_changed.push(Line { text: format!("Worked {} across {}", fmt_ms(total), plural(list.len() as i64, "session", "sessions")), sources: ids });
        }
    }
    Ok(())
}

/// Development data: local commits (trusted repositories) and cached GitHub data.
fn dev_part(state: &AppState, b: &mut B, project_id: &str, from: i64, to: i64, inc: &Include) -> AppResult<()> {
    let repos = state.with(|c| repos::list(c, project_id))?;
    if inc.commits {
        let since = chrono::DateTime::from_timestamp_millis(from).map(|d| d.to_rfc3339()).unwrap_or_default();
        for r in &repos {
            let commits = match repos::trusted_root(state, &r.id) {
                Ok(root) => git::log_of(&root, 40, true, None, Some(&since)).unwrap_or_default().into_iter().map(|c| (c.hash, c.short, c.subject, iso_ms(&c.date))).collect::<Vec<_>>(),
                Err(_) => {
                    let Some(gh) = &r.github else { continue };
                    let cached = state.with(|c| Ok(cached(c, &format!("gh:commits:{}", gh.to_lowercase())))).ok().flatten();
                    cached
                        .and_then(|v| v.as_array().cloned())
                        .unwrap_or_default()
                        .iter()
                        .map(|c| {
                            let s = |k: &str| c.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
                            (s("sha"), s("short"), s("subject"), iso_ms(&s("date")))
                        })
                        .collect()
                }
            };
            let commits: Vec<_> = commits.into_iter().filter(|c| c.3 >= from && c.3 < to).collect();
            if commits.is_empty() {
                continue;
            }
            b.count("commits", commits.len() as i64);
            let ids = commits
                .iter()
                .take(6)
                .map(|c| {
                    let url = r.github.as_ref().map(|g| format!("https://github.com/{g}/commit/{}", c.0));
                    b.src("commit", "commits", &c.0, &c.2, Some(format!("{} in {}", c.1, r.name)), url, Some(r.id.clone()), Some(c.3))
                })
                .collect();
            b.d.what_changed.push(Line { text: format!("{} in {}", plural(commits.len() as i64, "commit", "commits"), r.name), sources: ids });
        }
    }
    if inc.github {
        for r in repos.iter().filter(|r| r.github.is_some()) {
            let gh = r.github.clone().unwrap_or_default().to_lowercase();
            let (pulls, actions) = state.with(|c| Ok((cached(c, &format!("gh:pulls:{gh}")), cached(c, &format!("gh:actions:{gh}")))))?;
            for p in pulls.and_then(|v| v.as_array().cloned()).unwrap_or_default() {
                let n = p.get("number").and_then(|x| x.as_i64()).unwrap_or(0);
                let title = p.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let url = p.get("htmlUrl").and_then(|x| x.as_str()).map(String::from);
                let updated = iso_ms(p.get("updatedAt").and_then(|x| x.as_str()).unwrap_or(""));
                let review = p.get("review").and_then(|x| x.as_str()).unwrap_or("none");
                if review == "changes_requested" {
                    let s = b.src("pull", "github", &format!("{gh}#{n}"), &title, Some(format!("#{n}: changes requested")), url.clone(), Some(r.id.clone()), Some(updated));
                    b.d.needs_attention.push(Line { text: format!("Pull request #{n} has changes requested: {}", clean(&title)), sources: vec![s] });
                } else if updated >= from && updated < to {
                    let s = b.src("pull", "github", &format!("{gh}#{n}"), &title, Some(format!("#{n} updated")), url, Some(r.id.clone()), Some(updated));
                    b.d.what_changed.push(Line { text: format!("Pull request #{n} updated: {}", clean(&title)), sources: vec![s] });
                    b.count("pulls", 1);
                }
            }
            if let Some(a) = actions {
                let default = a.get("defaultBranch").and_then(|x| x.as_str()).map(String::from);
                for run in a.get("latest").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
                    let failed = matches!(run.get("conclusion").and_then(|c| c.as_str()), Some("failure" | "timed_out"));
                    let on_default = default.is_none() || run.get("branch").and_then(|x| x.as_str()) == default.as_deref();
                    if failed && on_default {
                        let wf = run.get("workflow").and_then(|x| x.as_str()).unwrap_or("Workflow").to_string();
                        let id = run.get("id").and_then(|x| x.as_i64()).unwrap_or(0).to_string();
                        let s = b.src("run", "github", &id, &wf, Some(format!("failed on {}", default.clone().unwrap_or_default())), run.get("htmlUrl").and_then(|x| x.as_str()).map(String::from), Some(r.id.clone()), None);
                        b.d.needs_attention.push(Line { text: format!("{} is failing in {}", clean(&wf), r.name), sources: vec![s] });
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn build(state: &AppState, project_id: &str, from: i64, to: i64, inc: &Include) -> AppResult<Digest> {
    if to <= from {
        return invalid("Choose a period that ends after it starts.");
    }
    let name: String = state
        .with(|c| {
            // A digest is the project's content, retold.
            passkeys::ensure_readable(c, project_id)?;
            Ok(c.query_row("SELECT name FROM projects WHERE id = ?1", [project_id], |r| r.get(0)).optional()?)
        })?
        .ok_or_else(|| AppError::NotFound("Project".into()))?;
    let mut b = B { d: Digest { project_id: project_id.into(), project_name: name, from, to, ..Default::default() } };
    state.with(|c| local_part(c, &mut b, project_id, from, to, inc))?;
    dev_part(state, &mut b, project_id, from, to, inc)?;
    Ok(b.d)
}

// ------------------------------------------------------------ AI

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub categories: Vec<(String, usize)>,
    pub sources: usize,
    pub chars: usize,
    pub approx_tokens: usize,
    pub allowed: bool,
    pub blocked_reason: Option<String>,
}

fn ai_allowed(conn: &Connection, project_id: &str) -> Option<String> {
    if !settings::get_or(conn, "privacy.network", true) {
        return Some("External network requests are turned off in Privacy settings.".into());
    }
    if !settings::get_or(conn, "privacy.aiProjectContent", false) {
        return Some("AI access to project content is off. Turn it on in Settings → Privacy to use AI catch-up.".into());
    }
    let prefs: String = conn.query_row("SELECT ai_prefs FROM projects WHERE id = ?1", [project_id], |r| r.get(0)).unwrap_or_default();
    let v: Value = serde_json::from_str(&prefs).unwrap_or(Value::Null);
    if v.get("contentAccess").and_then(|b| b.as_bool()) == Some(false) {
        return Some("This project doesn't allow AI to use its content.".into());
    }
    let accounts: i64 = conn.query_row("SELECT count(*) FROM ai_accounts WHERE enabled = 1", [], |r| r.get(0)).unwrap_or(0);
    if accounts == 0 {
        return Some("Add an AI account in Settings → API to use AI catch-up.".into());
    }
    None
}

/// The compact, source-numbered context sent to the model.
pub fn prompt_of(d: &Digest) -> String {
    let mut p = format!("Project: {}\nPeriod: {} to {}\n\nSources:\n", clean(&d.project_name), day(d.from), day(d.to));
    for s in &d.sources {
        p.push_str(&format!("[{}] {}: \"{}\"{}{}\n", s.id, s.kind, s.title, s.detail.as_ref().map(|x| format!(" ({x})")).unwrap_or_default(), s.at.map(|a| format!(" on {}", day(a))).unwrap_or_default()));
    }
    p.push_str("\nLocal summary (for reference):\n");
    for (name, lines) in [("What changed", &d.what_changed), ("Completed", &d.completed), ("Needs attention", &d.needs_attention), ("Next", &d.next_steps)] {
        for l in lines {
            p.push_str(&format!("- {name}: {} [{}]\n", l.text, l.sources.join(", ")));
        }
    }
    p
}

const SYSTEM: &str = "You write a short catch-up for the owner of a project, using only the numbered sources provided. \
Every item must cite the ids of the sources it is based on. Never invent tasks, commits, people, numbers or dates. \
Respond with JSON only, no prose, in exactly this shape: \
{\"whatChanged\":[{\"text\":\"...\",\"sources\":[\"S1\"]}],\"completed\":[...],\"needsAttention\":[...],\"nextSteps\":[...]}. \
Use at most 5 short items per section; merge related items. \"nextSteps\" are your suggestions and must still cite the sources that motivate them. \
Leave a section empty when nothing applies.";

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiSummary {
    pub what_changed: Vec<Line>,
    pub completed: Vec<Line>,
    pub needs_attention: Vec<Line>,
    pub next_steps: Vec<Line>,
    pub sources: Vec<Source>,
    /// Items dropped because they cited no known source.
    pub dropped: usize,
    pub model: Option<String>,
    pub account_name: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub estimated_cost: Option<f64>,
}

/// Parses the model's JSON and keeps only items citing known sources.
pub fn parse_ai(text: &str, sources: &[Source]) -> AppResult<(BTreeMap<String, Vec<Line>>, usize)> {
    let start = text.find('{').ok_or_else(|| AppError::Invalid("The AI response wasn't in the expected format.".into()))?;
    let end = text.rfind('}').ok_or_else(|| AppError::Invalid("The AI response wasn't in the expected format.".into()))?;
    let v: Value = serde_json::from_str(&text[start..=end]).map_err(|_| AppError::Invalid("The AI response wasn't in the expected format.".into()))?;
    let known: std::collections::HashSet<&str> = sources.iter().map(|s| s.id.as_str()).collect();
    let mut out = BTreeMap::new();
    let mut dropped = 0;
    for key in ["whatChanged", "completed", "needsAttention", "nextSteps"] {
        let mut lines = vec![];
        for item in v.get(key).and_then(|x| x.as_array()).cloned().unwrap_or_default().into_iter().take(8) {
            let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
            let cited: Vec<String> = item.get("sources").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).filter(|x| known.contains(x)).map(String::from).collect()).unwrap_or_default();
            if text.is_empty() || cited.is_empty() {
                dropped += 1;
                continue;
            }
            lines.push(Line { text: text.chars().take(300).collect(), sources: cited });
        }
        out.insert(key.to_string(), lines);
    }
    Ok((out, dropped))
}

#[tauri::command]
pub async fn catchup_local(app: AppHandle, project_id: String, from: i64, to: i64, include: Include) -> AppResult<Digest> {
    git::blocking(&app, move |s| build(s, &project_id, from, to, &include)).await
}

#[tauri::command]
pub async fn catchup_preview(app: AppHandle, project_id: String, from: i64, to: i64, include: Include) -> AppResult<Preview> {
    git::blocking(&app, move |s| {
        let d = build(s, &project_id, from, to, &include)?;
        let mut cats: BTreeMap<String, usize> = BTreeMap::new();
        for src in &d.sources {
            *cats.entry(src.category.clone()).or_default() += 1;
        }
        let prompt = prompt_of(&d);
        let blocked = s.with(|c| Ok(ai_allowed(c, &project_id)))?;
        Ok(Preview {
            categories: cats.into_iter().collect(),
            sources: d.sources.len(),
            chars: prompt.len() + SYSTEM.len(),
            approx_tokens: (prompt.len() + SYSTEM.len()) / 4 + 800,
            allowed: blocked.is_none() && !d.sources.is_empty(),
            blocked_reason: blocked.or_else(|| d.sources.is_empty().then(|| "Nothing happened in this period, so there's nothing to summarise.".into())),
        })
    })
    .await
}

#[tauri::command]
pub async fn catchup_ai(app: AppHandle, project_id: String, from: i64, to: i64, include: Include, request_id: String) -> AppResult<AiSummary> {
    git::blocking(&app, move |s| {
        if let Some(why) = s.with(|c| Ok(ai_allowed(c, &project_id)))? {
            return invalid(&why);
        }
        let d = build(s, &project_id, from, to, &include)?;
        if d.sources.is_empty() {
            return invalid("Nothing happened in this period, so there's nothing to summarise.");
        }
        let req = RouteRequest {
            request_id,
            prompt: prompt_of(&d),
            system: Some(SYSTEM.into()),
            max_tokens: Some(1200),
            project_id: Some(project_id.clone()),
            replayable: Some(true),
            purpose: Some("catchup".into()),
            // As in assist: offered only if the user has servers switched on.
            use_tools: Some(true),
            ..Default::default()
        };
        let outcome = router::route(s, &s.ai, &req)?;
        if !outcome.ok {
            return Err(AppError::Invalid(outcome.error.map(|e| e.message).unwrap_or_else(|| "The AI request failed.".into())));
        }
        let (mut sections, dropped) = parse_ai(outcome.text.as_deref().unwrap_or(""), &d.sources)?;
        let usage = outcome.usage.as_ref();
        Ok(AiSummary {
            what_changed: sections.remove("whatChanged").unwrap_or_default(),
            completed: sections.remove("completed").unwrap_or_default(),
            needs_attention: sections.remove("needsAttention").unwrap_or_default(),
            next_steps: sections.remove("nextSteps").unwrap_or_default(),
            sources: d.sources,
            dropped,
            model: outcome.model,
            account_name: outcome.account_name,
            input_tokens: usage.and_then(|u| u.input_tokens).map(|n| n as i64),
            output_tokens: usage.and_then(|u| u.output_tokens).map(|n| n as i64),
            estimated_cost: outcome.estimated_cost,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(id: &str) -> Source {
        Source { id: id.into(), kind: "task".into(), ref_id: "t".into(), title: "x".into(), detail: None, url: None, repository_id: None, at: None, category: "tasks".into() }
    }

    #[test]
    fn ai_claims_must_cite_known_sources() {
        let text = "Here you go:\n```json\n{\"whatChanged\":[{\"text\":\"Did A\",\"sources\":[\"S1\"]},{\"text\":\"Invented\",\"sources\":[\"S9\"]},{\"text\":\"No cite\",\"sources\":[]}],\"completed\":[],\"needsAttention\":[],\"nextSteps\":[{\"text\":\"Do B\",\"sources\":[\"S2\"]}]}\n```";
        let (s, dropped) = parse_ai(text, &[src("S1"), src("S2")]).unwrap();
        assert_eq!(s["whatChanged"].len(), 1);
        assert_eq!(s["nextSteps"][0].sources, vec!["S2".to_string()]);
        assert_eq!(dropped, 2);
        assert!(parse_ai("not json", &[]).is_err());
    }

    #[test]
    fn cleaning_redacts_tokens() {
        let c = clean("deploy with ghp_abcdefghijklmnopqrstuv123 now\nsecond line");
        assert!(!c.contains("ghp_abc") && c.contains("[redacted]") && !c.contains("second"));
    }

    #[test]
    fn local_digest_without_git_or_ai() {
        use crate::domain::projects::{create_project, ProjectInput};
        use crate::domain::tasks::{create_task, update_task, TaskInput, TaskPatch};
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(crate::db::open_memory(), crate::state::Paths::new(tmp.path().to_path_buf()));
        let (pid, done) = state
            .with(|c| {
                let p = create_project(c, &ProjectInput { name: "Garden".into(), ..Default::default() })?;
                let a = create_task(c, &TaskInput { title: "Plant beans".into(), project_id: Some(p.id.clone()), ..Default::default() })?;
                create_task(c, &TaskInput { title: "Water".into(), project_id: Some(p.id.clone()), due_date: Some("2000-01-01".into()), ..Default::default() })?;
                update_task(c, &a.id, &TaskPatch { status: Some("completed".into()), ..Default::default() })?;
                Ok((p.id, a.id))
            })
            .unwrap();
        let d = build(&state, &pid, 0, crate::util::now_ms() + 1000, &Include::default()).unwrap();
        assert_eq!(d.completed.len(), 1);
        assert!(d.sources.iter().any(|s| s.ref_id == done && s.kind == "task"));
        assert!(d.needs_attention.iter().any(|l| l.text.starts_with("Overdue: Water")));
        assert!(!d.next_steps.is_empty());
        // Every line cites sources that exist.
        let ids: Vec<&str> = d.sources.iter().map(|s| s.id.as_str()).collect();
        for l in d.what_changed.iter().chain(&d.completed).chain(&d.needs_attention).chain(&d.next_steps) {
            assert!(!l.sources.is_empty() && l.sources.iter().all(|s| ids.contains(&s.as_str())));
        }
    }
}
