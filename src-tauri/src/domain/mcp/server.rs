// @Author Christian Relf
// @Date 2026-10-22

//! The MCP server itself: the tools an assistant sees, and the one path
//! every call takes to reach `tools`.
//!
//! `run` is that path. It takes the database lock on a blocking thread, reads
//! the client's record fresh (so revoking access stops the next call, not the
//! next connection), asks `policy`, runs the tool, writes an audit row, and —
//! for a write — tells the interface to refresh. A tool that doesn't go
//! through `run` is a bug; `cargo test mcp` checks that none does.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{Implementation, ServerCapabilities, ServerConfig};
use rmcp::{Json, ServerHandler, tool, tool_handler, tool_router};
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::clients::{self, McpClient};
use super::policy::{self, Access};
use super::tools::{self, *};
use super::{audit, INSTRUCTIONS};

#[derive(Clone)]
pub struct KernMcp {
    app: AppHandle,
    client_id: String,
    tool_router: ToolRouter<Self>,
}

impl KernMcp {
    pub fn new(app: AppHandle, client_id: String) -> Self {
        Self { app, client_id, tool_router: Self::tool_router() }
    }

    /// Policy, the tool, the audit row and the refresh, in that order.
    ///
    /// `detail` is the one-line description of the arguments that the
    /// Assistants tab shows; it must never carry the payload itself.
    async fn run<T, F>(&self, tool: &'static str, access: Access, detail: String, f: F) -> Result<Json<T>, String>
    where
        T: Serialize + Send + 'static,
        F: for<'a> FnOnce(&'a mut Connection, &McpClient) -> AppResult<T> + Send + 'static,
    {
        let app = self.app.clone();
        let id = self.client_id.clone();
        let emitter = app.clone();
        let logged = detail.clone();
        let out = tauri::async_runtime::spawn_blocking(move || {
            app.state::<AppState>().with(|conn| {
                let client = clients::get(conn, &id)?;
                policy::guard(conn, &client, access)?;
                let result = f(conn, &client);
                let outcome = match &result {
                    Ok(_) => Ok(()),
                    Err(e) => Err(e.to_string()),
                };
                audit::record(conn, &client, tool, Some(&logged), outcome.as_ref().map(|_| ()).map_err(|e| e.as_str()));
                clients::touch(conn, &client.id)?;
                result.map(|value| (value, client.name))
            })
        })
        .await
        .map_err(|e| format!("Kern couldn't run that: {e}"))?;

        match out {
            Ok((value, client_name)) => {
                if access == Access::Write {
                    let _ = emitter.emit(
                        "kern://mcp-applied",
                        serde_json::json!({ "client": client_name, "tool": tool, "detail": detail }),
                    );
                }
                Ok(Json(value))
            }
            // The model reads this string, so it has to say what to do next.
            Err(e) => Err(describe(&e)),
        }
    }
}

/// An error an assistant can act on. `AppError`'s own messages are written
/// for people and work here too; the locked case gets a clearer one, because
/// "ask the person at the keyboard" is the only way forward.
fn describe(e: &AppError) -> String {
    match e {
        AppError::Locked(_) => "That project is locked with a passkey. Only the person at this computer can open it.".into(),
        AppError::NotFound(what) => format!("{what} not found — it may have been deleted, or be outside what this assistant can see."),
        other => other.to_string(),
    }
}

/// A short description of a call for the audit row.
fn count_detail(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

#[tool_router]
impl KernMcp {
    #[tool(description = "Everything at a glance: the user's projects, and how much is overdue, due today or in progress. Start here.")]
    async fn kern_overview(&self) -> Result<Json<Overview>, String> {
        self.run("kern_overview", Access::Read, "overview".into(), |c, cl| tools::overview(c, cl)).await
    }

    #[tool(description = "What today looks like: tasks that are overdue, due today, or in progress.")]
    async fn kern_today(&self) -> Result<Json<Today>, String> {
        self.run("kern_today", Access::Read, "today".into(), |c, cl| tools::today_list(c, cl)).await
    }

    #[tool(description = "Full-text search across tasks, notes, projects and whiteboards.")]
    async fn kern_search(&self, Parameters(args): Parameters<SearchArgs>) -> Result<Json<Vec<SearchHitBrief>>, String> {
        let detail = format!("\"{}\"", args.query);
        self.run("kern_search", Access::Read, detail, move |c, cl| tools::search_all(c, cl, &args)).await
    }

    #[tool(description = "List the user's projects, with how many tasks are open, done and overdue in each.")]
    async fn kern_project_list(&self, Parameters(args): Parameters<ProjectListArgs>) -> Result<Json<Vec<ProjectBrief>>, String> {
        self.run("kern_project_list", Access::Read, "list projects".into(), move |c, cl| tools::project_list(c, cl, &args)).await
    }

    #[tool(description = "Find tasks by project, status, due date or words in the title. Returns open tasks unless told otherwise.")]
    async fn kern_task_search(&self, Parameters(args): Parameters<TaskSearchArgs>) -> Result<Json<Vec<TaskBrief>>, String> {
        let detail = args.query.clone().unwrap_or_else(|| "filter".into());
        self.run("kern_task_search", Access::Read, detail, move |c, cl| tools::task_search(c, cl, &args)).await
    }

    #[tool(description = "Read one note, including its Markdown body.")]
    async fn kern_note_get(&self, Parameters(args): Parameters<IdArgs>) -> Result<Json<NoteBrief>, String> {
        let detail = args.id.clone();
        self.run("kern_note_get", Access::Read, detail, move |c, cl| tools::note_get(c, cl, &args)).await
    }

    #[tool(description = "List the boards in a project, with their columns.")]
    async fn kern_board_list(&self, Parameters(args): Parameters<BoardListArgs>) -> Result<Json<Vec<BoardBrief>>, String> {
        self.run("kern_board_list", Access::Read, "list boards".into(), move |c, cl| tools::board_list(c, cl, &args)).await
    }

    #[tool(description = "List the labels in use, with how many open tasks carry each.")]
    async fn kern_label_list(&self) -> Result<Json<Vec<LabelBrief>>, String> {
        self.run("kern_label_list", Access::Read, "list labels".into(), |c, cl| tools::label_list(c, cl)).await
    }

    #[tool(description = "What has happened recently: created, completed and changed items.")]
    async fn kern_activity_recent(&self, Parameters(args): Parameters<ActivityArgs>) -> Result<Json<Vec<ActivityBrief>>, String> {
        self.run("kern_activity_recent", Access::Read, "recent activity".into(), move |c, cl| {
            tools::activity_recent(c, cl, &args)
        })
        .await
    }

    #[tool(description = "Create one or more tasks. Send a whole list in one call rather than calling repeatedly.")]
    async fn kern_task_create(&self, Parameters(args): Parameters<TaskCreateArgs>) -> Result<Json<Vec<TaskBrief>>, String> {
        let detail = count_detail(args.tasks.len(), "task", "tasks");
        self.run("kern_task_create", Access::Write, detail, move |c, cl| tools::task_create(c, cl, &args)).await
    }

    #[tool(description = "Change a task: its title, detail, status, priority, project, due date or labels.")]
    async fn kern_task_update(&self, Parameters(args): Parameters<TaskUpdateArgs>) -> Result<Json<TaskBrief>, String> {
        let detail = args.id.clone();
        self.run("kern_task_update", Access::Write, detail, move |c, cl| tools::task_update(c, cl, &args)).await
    }

    #[tool(description = "Mark tasks as completed.")]
    async fn kern_task_complete(&self, Parameters(args): Parameters<IdsArgs>) -> Result<Json<CountResult>, String> {
        let detail = count_detail(args.ids.len(), "task", "tasks");
        self.run("kern_task_complete", Access::Write, detail, move |c, cl| tools::task_complete(c, cl, &args)).await
    }

    #[tool(description = "Move tasks to the Trash. They are recoverable from there; nothing is destroyed.")]
    async fn kern_task_delete(&self, Parameters(args): Parameters<IdsArgs>) -> Result<Json<CountResult>, String> {
        let detail = count_detail(args.ids.len(), "task", "tasks");
        self.run("kern_task_delete", Access::Write, detail, move |c, cl| tools::task_delete(c, cl, &args)).await
    }

    #[tool(description = "Write a new note. The body is Markdown, which is how Kern stores notes.")]
    async fn kern_note_create(&self, Parameters(args): Parameters<NoteCreateArgs>) -> Result<Json<NoteBrief>, String> {
        let detail = args.title.clone();
        self.run("kern_note_create", Access::Write, detail, move |c, cl| tools::note_create(c, cl, &args)).await
    }

    #[tool(description = "Change a note: replace its body with `content`, or add to the end with `append`.")]
    async fn kern_note_update(&self, Parameters(args): Parameters<NoteUpdateArgs>) -> Result<Json<NoteBrief>, String> {
        let detail = args.id.clone();
        self.run("kern_note_update", Access::Write, detail, move |c, cl| tools::note_update(c, cl, &args)).await
    }

    #[tool(description = "Create a board in a project, with columns of your choosing.")]
    async fn kern_board_create(&self, Parameters(args): Parameters<BoardCreateArgs>) -> Result<Json<BoardBrief>, String> {
        let detail = args.name.clone();
        self.run("kern_board_create", Access::Write, detail, move |c, cl| tools::board_create(c, cl, &args)).await
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for KernMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("kern", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }
}

