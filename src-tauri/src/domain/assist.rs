// @Author Christian Relf
// @Date 2026-10-15

//! AI actions that reuse the AI account routing: break a task into steps,
//! pull tasks out of a note, write a weekly review summary, and answer a
//! question about a project from its own data.
//!
//! The same rules as catch-up apply: nothing is sent unless network access
//! and AI access to content are on and the project allows it; the exact text
//! that would be sent can be previewed first; key-shaped strings are
//! redacted; and answers are checked against what was sent (extracted tasks
//! must quote the note, answers must cite known sources).

use crate::domain::ai::router::{self, RouteRequest};
use crate::domain::ai::vault::redact;
use crate::domain::{comments, review, settings, tasks};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use chrono::Local;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct AssistInput {
    /// "breakdown" | "extract" | "weekly" | "ask"
    pub action: String,
    pub task_id: Option<String>,
    pub note_id: Option<String>,
    pub project_id: Option<String>,
    pub question: Option<String>,
    pub week_start: Option<String>,
    pub today: Option<String>,
    pub tz_offset_minutes: Option<i64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AssistPreview {
    pub allowed: bool,
    pub blocked_reason: Option<String>,
    /// Exactly what would be sent (instructions and content).
    pub system: String,
    pub prompt: String,
    pub chars: usize,
    pub approx_tokens: usize,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub title: String,
    pub detail: Option<String>,
    pub estimate_minutes: Option<i64>,
    pub due_date: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub id: String,
    pub kind: String,
    pub ref_id: String,
    pub title: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AssistResult {
    pub suggestions: Vec<Suggestion>,
    pub text: Option<String>,
    /// Sources an answer cites (ask).
    pub sources: Vec<SourceRef>,
    /// Items dropped because they didn't match what was sent.
    pub dropped: usize,
    pub model: Option<String>,
    pub account_name: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub estimated_cost: Option<f64>,
}

/// Redacts key-shaped strings throughout (keeps line breaks).
fn scrub(s: &str) -> String {
    let mut out = redact(s, None);
    for prefix in ["ghp_", "gho_", "github_pat_", "xoxb-", "xoxp-", "AKIA", "glpat-"] {
        let mut from = 0;
        while let Some(rel) = out[from..].find(prefix) {
            let i = from + rel;
            let end = out[i..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).map(|e| i + e).unwrap_or(out.len());
            if end - i >= 12 {
                out.replace_range(i..end, "[redacted]");
                from = i + "[redacted]".len();
            } else {
                from = end;
            }
        }
    }
    out
}

fn cap(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

/// Why AI can't be used here, if it can't.
pub fn blocked(conn: &Connection, project_id: Option<&str>) -> Option<String> {
    if !settings::get_or(conn, "privacy.network", true) {
        return Some("Network access is turned off in Settings → Privacy.".into());
    }
    if !settings::get_or(conn, "privacy.aiProjectContent", false) {
        return Some("AI access to your tasks and notes is off. Turn it on in Settings → Privacy to use AI actions.".into());
    }
    if let Some(p) = project_id {
        let prefs: Option<String> = conn.query_row("SELECT ai_prefs FROM projects WHERE id = ?1", [p], |r| r.get(0)).optional().ok().flatten();
        let v: Value = prefs.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
        if v.get("contentAccess").and_then(|b| b.as_bool()) == Some(false) {
            return Some("This project doesn't allow AI to use its content.".into());
        }
    }
    let accounts: i64 = conn.query_row("SELECT count(*) FROM ai_accounts WHERE enabled = 1", [], |r| r.get(0)).unwrap_or(0);
    if accounts == 0 {
        return Some("Add an AI account in Settings → API to use AI actions.".into());
    }
    None
}

const BREAKDOWN: &str = "You break one task into a short checklist of concrete steps. \
Respond with JSON only, no prose, in exactly this shape: {\"steps\":[{\"title\":\"...\",\"estimateMinutes\":15}]}. \
Give 3 to 8 steps in order. Each title starts with a verb and is under 80 characters. estimateMinutes is optional. \
Don't repeat existing subtasks, and don't add steps the task doesn't need.";

const EXTRACT: &str = "You find action items in a note. Respond with JSON only, no prose, in exactly this shape: \
{\"tasks\":[{\"title\":\"...\",\"due\":\"YYYY-MM-DD or null\",\"quote\":\"...\"}]}. \
Only include things the note says need doing. Each title starts with a verb and is under 100 characters. \
\"quote\" is the exact words in the note the task comes from. Only give a due date the note states; resolve relative dates against today's date. \
Skip items already ticked off. Return an empty list when there are none.";

const WEEKLY: &str = "You write a short, encouraging summary of someone's week from the facts given, and nothing else. \
Plain text, at most 120 words, no headings. Mention one or two wins, be honest about what slipped, and end with one concrete suggestion for next week. \
Never invent tasks, numbers or names.";

const ASK: &str = "You answer a question about a project using only the numbered sources provided. \
Cite the ids of the sources you rely on in square brackets, like [S3]. If the sources don't answer the question, say so plainly. \
Respond with JSON only, no prose, in exactly this shape: {\"answer\":\"...\",\"sources\":[\"S1\"]}. Keep the answer under 150 words.";

struct Built {
    system: &'static str,
    prompt: String,
    project_id: Option<String>,
    max_tokens: u32,
    /// For checking answers.
    note_text: Option<String>,
    sources: Vec<SourceRef>,
}

fn project_name(conn: &Connection, id: Option<&str>) -> Option<String> {
    id.and_then(|p| conn.query_row("SELECT name FROM projects WHERE id = ?1", [p], |r| r.get::<_, String>(0)).optional().ok().flatten())
}

fn build(conn: &Connection, input: &AssistInput) -> AppResult<Built> {
    let today = input.today.clone().unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    match input.action.as_str() {
        "breakdown" => {
            let id = input.task_id.as_deref().ok_or_else(|| AppError::Invalid("No task given.".into()))?;
            let t = tasks::get_task(conn, id)?;
            let subs = tasks::query_tasks(conn, &tasks::TaskQuery { parent_id: Some(t.id.clone()), include_completed: true, order: Some("manual".into()), ..Default::default() })?;
            let mut p = format!("Task: {}\n", scrub(&t.title));
            if let Some(n) = project_name(conn, t.project_id.as_deref()) {
                p.push_str(&format!("Project: {}\n", scrub(&n)));
            }
            if let Some(d) = &t.due_date {
                p.push_str(&format!("Due: {d} (today is {today})\n"));
            }
            if !t.description.trim().is_empty() {
                p.push_str(&format!("Notes:\n{}\n", cap(&scrub(&t.description), 4000)));
            }
            if !subs.is_empty() {
                p.push_str("Existing subtasks:\n");
                for s in subs {
                    p.push_str(&format!("- {}{}\n", if s.status == "completed" { "[done] " } else { "" }, scrub(&s.title)));
                }
            }
            Ok(Built { system: BREAKDOWN, prompt: p, project_id: t.project_id, max_tokens: 700, note_text: None, sources: vec![] })
        }
        "extract" => {
            let id = input.note_id.as_deref().ok_or_else(|| AppError::Invalid("No note given.".into()))?;
            let n = crate::domain::notes::get_note(conn, id)?;
            if n.content.trim().is_empty() {
                return invalid("This note is empty.");
            }
            let body = cap(&scrub(&n.content), 12_000);
            let p = format!("Today is {today}.\nNote title: {}\n\nNote:\n{body}\n", scrub(&n.title));
            Ok(Built { system: EXTRACT, prompt: p, project_id: n.project_id, max_tokens: 1500, note_text: Some(body), sources: vec![] })
        }
        "weekly" => {
            let start = input.week_start.as_deref().ok_or_else(|| AppError::Invalid("No week given.".into()))?;
            let r = review::week(conn, start, &today, input.tz_offset_minutes.unwrap_or(0))?;
            let list = |ts: &[tasks::Task]| ts.iter().take(15).map(|t| format!("- {}", scrub(&t.title))).collect::<Vec<_>>().join("\n");
            let mut p = format!("Week {} to {} (today is {today}).\n\nCompleted ({}):\n{}\n", r.week_start, r.week_end, r.completed.len(), list(&r.completed));
            p.push_str(&format!("\nDue this week but not done ({}):\n{}\n", r.slipped.len(), list(&r.slipped)));
            p.push_str(&format!("\nOverdue from earlier weeks: {}\nNew tasks added: {}\nCancelled: {}\n", r.older_overdue, r.created, r.cancelled));
            if r.tracked_ms > 0 {
                p.push_str(&format!("\nTracked time: {} minutes, by project: {}\n", r.tracked_ms / 60_000, r.by_project.iter().map(|b| format!("{} {}m", scrub(&b.label), b.ms / 60_000)).collect::<Vec<_>>().join(", ")));
            }
            if r.focus_minutes > 0 {
                p.push_str(&format!("Focus sessions: {} minutes\n", r.focus_minutes));
            }
            if !r.habits.is_empty() {
                p.push_str(&format!("Habits: {}\n", r.habits.iter().map(|h| format!("{} {}/{}", scrub(&h.name), h.met, h.due)).collect::<Vec<_>>().join(", ")));
            }
            if r.estimates.count > 0 {
                p.push_str(&format!("Estimates: {} tasks took {} minutes against {} estimated\n", r.estimates.count, r.estimates.total_actual_minutes, r.estimates.total_estimate_minutes));
            }
            p.push_str(&format!("\nDue next week ({}):\n{}\n", r.next_week.len(), list(&r.next_week)));
            Ok(Built { system: WEEKLY, prompt: p, project_id: None, max_tokens: 500, note_text: None, sources: vec![] })
        }
        "ask" => {
            let pid = input.project_id.as_deref().ok_or_else(|| AppError::Invalid("No project given.".into()))?;
            let q = input.question.as_deref().map(str::trim).unwrap_or("");
            if q.is_empty() {
                return invalid("Ask a question first.");
            }
            let project = crate::domain::projects::get_project(conn, pid)?;
            let mut sources: Vec<SourceRef> = vec![];
            let mut lines = String::new();
            let mut add = |kind: &str, ref_id: &str, title: &str, detail: String| {
                let id = format!("S{}", sources.len() + 1);
                lines.push_str(&format!("[{id}] {kind}: \"{}\"{}\n", cap(&scrub(title), 200), if detail.is_empty() { String::new() } else { format!(" ({})", cap(&scrub(&detail), 300)) }));
                sources.push(SourceRef { id, kind: kind.into(), ref_id: ref_id.into(), title: title.into() });
            };
            for m in crate::domain::milestones::list(conn, pid)? {
                add("milestone", &m.id, &m.title, format!("{}; target {}; {}% done", m.status, m.target_date.as_deref().unwrap_or("none"), (m.progress * 100.0).round()));
            }
            let open = tasks::query_tasks(conn, &tasks::TaskQuery { project_ids: Some(vec![pid.into()]), top_level_only: true, order: Some("due".into()), limit: Some(120), ..Default::default() })?;
            for t in &open {
                let mut d = vec![t.status.replace('_', " ")];
                if let Some(due) = &t.due_date {
                    d.push(format!("due {due}"));
                }
                if t.priority > 0 {
                    d.push(format!("priority {}", t.priority));
                }
                if t.blocked_by > 0 {
                    d.push("blocked by another task".into());
                }
                if t.comment_count > 0 {
                    if let Ok(cs) = comments::list(conn, &t.id) {
                        if let Some(last) = cs.last() {
                            d.push(format!("latest comment: {}", comments::plain(&last.body)));
                        }
                    }
                }
                add("open task", &t.id, &t.title, d.join("; "));
            }
            let since = crate::util::now_ms() - 30 * 86_400_000;
            for t in tasks::query_tasks(conn, &tasks::TaskQuery { project_ids: Some(vec![pid.into()]), top_level_only: true, completed_from: Some(since), order: Some("completed".into()), limit: Some(40), ..Default::default() })? {
                let when = t.completed_at.and_then(chrono::DateTime::from_timestamp_millis).map(|d| d.with_timezone(&Local).format("%Y-%m-%d").to_string()).unwrap_or_default();
                add("completed task", &t.id, &t.title, format!("completed {when}"));
            }
            let mut stmt = conn.prepare("SELECT id, title, content FROM notes WHERE project_id = ?1 AND deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 20")?;
            let notes: Vec<(String, String, String)> = stmt.query_map([pid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
            for (id, title, content) in notes {
                add("note", &id, if title.is_empty() { "Untitled" } else { &title }, crate::domain::notes::excerpt(&content, 300));
            }
            let mut p = format!("Project: {}\n", scrub(&project.name));
            if !project.description.trim().is_empty() {
                p.push_str(&format!("Description: {}\n", cap(&scrub(&project.description), 600)));
            }
            p.push_str(&format!("Target date: {}\nToday: {today}\n\nSources:\n{lines}\nQuestion: {}\n", project.target_date.as_deref().unwrap_or("none"), scrub(q)));
            Ok(Built { system: ASK, prompt: p, project_id: Some(pid.into()), max_tokens: 900, note_text: None, sources })
        }
        other => invalid(format!("Unknown AI action '{other}'.")),
    }
}

fn json_of(text: &str) -> AppResult<Value> {
    let bad = || AppError::Invalid("The AI response wasn't in the expected format. Try again.".into());
    let start = text.find('{').ok_or_else(bad)?;
    let end = text.rfind('}').ok_or_else(bad)?;
    serde_json::from_str(&text[start..=end]).map_err(|_| bad())
}

fn norm(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Turns the model's reply into checked results.
fn parse(action: &str, text: &str, built: &Built) -> AppResult<(Vec<Suggestion>, Option<String>, Vec<SourceRef>, usize)> {
    match action {
        "breakdown" => {
            let v = json_of(text)?;
            let steps = v.get("steps").and_then(|s| s.as_array()).cloned().unwrap_or_default();
            let mut out = vec![];
            for s in steps.into_iter().take(10) {
                let title = s.get("title").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
                if title.is_empty() {
                    continue;
                }
                let est = s.get("estimateMinutes").and_then(|e| e.as_i64()).filter(|m| *m > 0 && *m <= 8 * 60);
                out.push(Suggestion { title: cap(&title, 120), detail: None, estimate_minutes: est, due_date: None });
            }
            Ok((out, None, vec![], 0))
        }
        "extract" => {
            let v = json_of(text)?;
            let note = norm(built.note_text.as_deref().unwrap_or(""));
            let mut out = vec![];
            let mut dropped = 0;
            for t in v.get("tasks").and_then(|s| s.as_array()).cloned().unwrap_or_default().into_iter().take(40) {
                let title = t.get("title").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
                let quote = t.get("quote").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
                // Every task must come from words that are actually in the note.
                if title.is_empty() || quote.is_empty() || !note.contains(&norm(&quote)) {
                    dropped += 1;
                    continue;
                }
                let due = t.get("due").and_then(|x| x.as_str()).filter(|d| crate::util::valid_date(d)).map(String::from);
                out.push(Suggestion { title: cap(&title, 150), detail: Some(cap(&quote, 200)), estimate_minutes: None, due_date: due });
            }
            Ok((out, None, vec![], dropped))
        }
        "weekly" => Ok((vec![], Some(cap(text.trim(), 1500)), vec![], 0)),
        _ => {
            let v = json_of(text)?;
            let answer = v.get("answer").and_then(|a| a.as_str()).unwrap_or("").trim().to_string();
            if answer.is_empty() {
                return invalid("The AI didn't give an answer. Try rephrasing the question.");
            }
            let cited: Vec<String> = v.get("sources").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            let mut sources: Vec<SourceRef> = built.sources.iter().filter(|s| cited.contains(&s.id) || answer.contains(&format!("[{}]", s.id))).cloned().collect();
            sources.dedup_by(|a, b| a.id == b.id);
            let unknown = cited.iter().filter(|c| !built.sources.iter().any(|s| &s.id == *c)).count();
            Ok((vec![], Some(cap(&answer, 2000)), sources, unknown))
        }
    }
}

async fn blocking<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&AppState) -> AppResult<T> + Send + 'static) -> AppResult<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<AppState>())).await.map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn assist_preview(app: AppHandle, input: AssistInput) -> AppResult<AssistPreview> {
    blocking(&app, move |s| {
        s.with(|c| {
            let b = build(c, &input)?;
            let why = blocked(c, b.project_id.as_deref());
            let chars = b.prompt.len() + b.system.len();
            Ok(AssistPreview { allowed: why.is_none(), blocked_reason: why, system: b.system.into(), approx_tokens: chars / 4 + b.max_tokens as usize, chars, prompt: b.prompt })
        })
    })
    .await
}

#[tauri::command]
pub async fn assist_run(app: AppHandle, input: AssistInput, request_id: String) -> AppResult<AssistResult> {
    blocking(&app, move |s| {
        let built = s.with(|c| {
            let b = build(c, &input)?;
            if let Some(why) = blocked(c, b.project_id.as_deref()) {
                return invalid(why);
            }
            Ok(b)
        })?;
        let req = RouteRequest {
            request_id,
            prompt: built.prompt.clone(),
            system: Some(built.system.into()),
            max_tokens: Some(built.max_tokens),
            project_id: built.project_id.clone(),
            replayable: Some(true),
            purpose: Some(format!("assist:{}", input.action)),
            // The user's own MCP servers, if they have turned them on and
            // enabled any; otherwise this asks for nothing.
            use_tools: Some(true),
            ..Default::default()
        };
        let outcome = router::route(s, &s.ai, &req)?;
        if !outcome.ok {
            return Err(AppError::Invalid(outcome.error.map(|e| e.message).unwrap_or_else(|| "The AI request failed.".into())));
        }
        let (suggestions, text, sources, dropped) = parse(&input.action, outcome.text.as_deref().unwrap_or(""), &built)?;
        let usage = outcome.usage.as_ref();
        Ok(AssistResult {
            suggestions,
            text,
            sources,
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
    use crate::db::open_memory;

    fn built_note(text: &str) -> Built {
        Built { system: EXTRACT, prompt: String::new(), project_id: None, max_tokens: 0, note_text: Some(text.into()), sources: vec![] }
    }

    #[test]
    fn extracted_tasks_must_quote_the_note() {
        let b = built_note("Notes from Monday.\n- Ana will send the contract by Friday\n- Ordered pizza");
        let reply = r#"Sure! {"tasks":[{"title":"Send the contract","due":"2030-01-11","quote":"Ana will send the contract by Friday"},{"title":"Book flights","due":null,"quote":"book the flights"},{"title":"","quote":"x"}]}"#;
        let (s, _, _, dropped) = parse("extract", reply, &b).unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].title.as_str(), s[0].due_date.as_deref()), ("Send the contract", Some("2030-01-11")));
        assert_eq!(dropped, 2);
        assert!(parse("extract", "no json here", &b).is_err());
    }

    #[test]
    fn answers_keep_only_known_sources() {
        let b = Built {
            system: ASK,
            prompt: String::new(),
            project_id: None,
            max_tokens: 0,
            note_text: None,
            sources: vec![SourceRef { id: "S1".into(), kind: "open task".into(), ref_id: "t1".into(), title: "Fix login".into() }, SourceRef { id: "S2".into(), kind: "note".into(), ref_id: "n1".into(), title: "Plan".into() }],
        };
        let (_, text, sources, unknown) = parse("ask", r#"{"answer":"Login is blocking release [S1].","sources":["S1","S9"]}"#, &b).unwrap();
        assert_eq!(text.as_deref(), Some("Login is blocking release [S1]."));
        assert_eq!(sources.iter().map(|s| s.ref_id.as_str()).collect::<Vec<_>>(), vec!["t1"]);
        assert_eq!(unknown, 1);
    }

    #[test]
    fn prompts_are_built_and_gated() {
        let c = open_memory();
        let t = tasks::create_task(&c, &tasks::TaskInput { title: "Plan the offsite".into(), description: Some("Budget token ghp_abcdefghijklmnop1234 is secret".into()), ..Default::default() }).unwrap();
        let b = build(&c, &AssistInput { action: "breakdown".into(), task_id: Some(t.id.clone()), ..Default::default() }).unwrap();
        assert!(b.prompt.contains("Plan the offsite") && b.prompt.contains("[redacted]") && !b.prompt.contains("ghp_abc"));
        // AI access to content is off by default.
        assert!(blocked(&c, None).unwrap().contains("Privacy"));
        assert!(build(&c, &AssistInput { action: "nope".into(), ..Default::default() }).is_err());
        let (steps, ..) = parse("breakdown", r#"{"steps":[{"title":"Pick dates","estimateMinutes":20},{"title":"Book venue","estimateMinutes":9999}]}"#, &b).unwrap();
        assert_eq!((steps.len(), steps[0].estimate_minutes, steps[1].estimate_minutes), (2, Some(20), None));
    }
}
