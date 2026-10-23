// @Author Christian Relf
// @Date 2026-10-22

//! The MCP server itself: the tools an assistant sees, the context it can
//! read without asking, the prompts it offers, and the one path every call
//! takes to reach `tools`.
//!
//! `call` is that path. It takes the database lock on a blocking thread, reads
//! the client's record fresh (so revoking access stops the next call, not the
//! next connection), asks `policy`, runs the work, writes an audit row, and —
//! for a write — tells the interface to refresh. A tool that doesn't go
//! through `call` is a bug; `cargo test mcp` checks that none does. Reading a
//! resource and fetching a prompt go through it too: both read the user's
//! data, so both are gated, rate-limited and audited like anything else.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    GetPromptRequestParams, GetPromptResponse, GetPromptResult, Implementation, ListPromptsResult,
    ListResourceTemplatesResult, ListResourcesResult, PaginatedRequestParams, Prompt, PromptArgument, PromptMessage,
    ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, Resource, ResourceContents, ResourceTemplate, Role,
    ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, Json, RoleServer, ServerHandler, tool, tool_handler, tool_router};
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

    /// Policy, the work, the audit row and the refresh, in that order.
    ///
    /// `detail` is the one-line description of the arguments that the
    /// Assistants tab shows; it must never carry the payload itself.
    async fn call<T, F>(&self, tool: &'static str, access: Access, detail: String, f: F) -> Result<T, String>
    where
        T: Send + 'static,
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
                Ok(value)
            }
            // The model reads this string, so it has to say what to do next.
            Err(e) => Err(describe(&e)),
        }
    }

    /// `call`, for a tool whose answer goes back as JSON. The `tool` string
    /// is what the Assistants tab lists, so a resource read and a prompt go
    /// under a `kern_resource_*` / `kern_prompt_*` name rather than their uri.
    async fn run<T, F>(&self, tool: &'static str, access: Access, detail: String, f: F) -> Result<Json<T>, String>
    where
        T: Serialize + Send + 'static,
        F: for<'a> FnOnce(&'a mut Connection, &McpClient) -> AppResult<T> + Send + 'static,
    {
        self.call(tool, access, detail, f).await.map(Json)
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

fn as_json<T: Serialize>(value: &T) -> AppResult<String> {
    Ok(serde_json::to_string_pretty(value)?)
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

    #[tool(description = "One project in full: its boards and columns, milestones, open tasks and the titles of its notes.")]
    async fn kern_project_get(&self, Parameters(args): Parameters<IdArgs>) -> Result<Json<ProjectDigest>, String> {
        let detail = args.id.clone();
        self.run("kern_project_get", Access::Read, detail, move |c, cl| tools::project_get(c, cl, &args)).await
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

    #[tool(description = "List a project's milestones, with how far along each one is.")]
    async fn kern_milestone_list(&self, Parameters(args): Parameters<ProjectIdArgs>) -> Result<Json<Vec<MilestoneBrief>>, String> {
        let detail = args.project_id.clone();
        self.run("kern_milestone_list", Access::Read, detail, move |c, cl| tools::milestone_list(c, cl, &args)).await
    }

    #[tool(description = "List the labels in use, with how many open tasks carry each.")]
    async fn kern_label_list(&self) -> Result<Json<Vec<LabelBrief>>, String> {
        self.run("kern_label_list", Access::Read, "list labels".into(), |c, cl| tools::label_list(c, cl)).await
    }

    #[tool(description = "List the user's whiteboards, with how many objects are on each.")]
    async fn kern_whiteboard_list(&self, Parameters(args): Parameters<BoardListArgs>) -> Result<Json<Vec<WhiteboardBrief>>, String> {
        self.run("kern_whiteboard_list", Access::Read, "list whiteboards".into(), move |c, cl| {
            tools::whiteboard_list(c, cl, &args)
        })
        .await
    }

    #[tool(description = "Read a whiteboard as a Mermaid flowchart, so you can see a diagram that was drawn by hand.")]
    async fn kern_whiteboard_to_mermaid(&self, Parameters(args): Parameters<IdArgs>) -> Result<Json<WhiteboardMermaid>, String> {
        let detail = args.id.clone();
        self.run("kern_whiteboard_to_mermaid", Access::Read, detail, move |c, cl| tools::whiteboard_to_mermaid(c, cl, &args)).await
    }

    #[tool(description = "What has happened recently: created, completed and changed items.")]
    async fn kern_activity_recent(&self, Parameters(args): Parameters<ActivityArgs>) -> Result<Json<Vec<ActivityBrief>>, String> {
        self.run("kern_activity_recent", Access::Read, "recent activity".into(), move |c, cl| {
            tools::activity_recent(c, cl, &args)
        })
        .await
    }

    #[tool(
        description = "Set up a whole project in one go: its boards and columns, milestones, tasks with checklists and due dates, and notes. \
                       Dates are days after `startDate`, so a plan keeps its shape whenever it starts. Prefer this over creating a project \
                       and then filling it call by call — it all arrives together or not at all."
    )]
    async fn kern_project_setup(&self, Parameters(args): Parameters<ProjectSetupArgs>) -> Result<Json<ProjectDigest>, String> {
        let detail = args.name.clone();
        self.run("kern_project_setup", Access::Write, detail, move |c, cl| tools::project_setup(c, cl, &args)).await
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

    #[tool(description = "Add a milestone to a project. Tasks join it through their own milestone.")]
    async fn kern_milestone_create(&self, Parameters(args): Parameters<MilestoneCreateArgs>) -> Result<Json<MilestoneBrief>, String> {
        let detail = args.title.clone();
        self.run("kern_milestone_create", Access::Write, detail, move |c, cl| tools::milestone_create(c, cl, &args)).await
    }

    #[tool(description = "Create a label. A label of that name already in use is reused rather than duplicated.")]
    async fn kern_label_create(&self, Parameters(args): Parameters<LabelCreateArgs>) -> Result<Json<LabelBrief>, String> {
        let detail = args.name.clone();
        self.run("kern_label_create", Access::Write, detail, move |c, cl| tools::label_create(c, cl, &args)).await
    }

    #[tool(
        description = "Draw a Mermaid flowchart onto a whiteboard as real, editable Kern shapes and connectors — not a picture. \
                       Send `flowchart` or `graph` text; the shapes, labels, arrows and line styles all come across."
    )]
    async fn kern_whiteboard_from_mermaid(
        &self,
        Parameters(args): Parameters<WhiteboardMermaidArgs>,
    ) -> Result<Json<WhiteboardResult>, String> {
        let detail = args.name.clone().unwrap_or_else(|| "flowchart".into());
        self.run("kern_whiteboard_from_mermaid", Access::Write, detail, move |c, cl| {
            tools::whiteboard_from_mermaid(c, cl, &args)
        })
        .await
    }
}

// ------------------------------------------------------------ resources

/// What `kern://…` points at. Context an assistant can read without spending
/// a tool call, which is the whole reason resources exist.
enum Target {
    Today,
    Project(String),
    Note(String),
}

impl Target {
    fn parse(uri: &str) -> Option<Target> {
        let rest = uri.strip_prefix("kern://")?;
        match rest.split_once('/') {
            Some(("project", id)) if !id.is_empty() => Some(Target::Project(id.into())),
            Some(("note", id)) if !id.is_empty() => Some(Target::Note(id.into())),
            None if rest == "today" => Some(Target::Today),
            _ => None,
        }
    }
}

const TODAY_URI: &str = "kern://today";

// ------------------------------------------------------------ prompts

/// Prompts are how someone finds out what this integration can do without
/// reading any documentation — they appear in the client's own prompt picker —
/// so each one is a job to be done, and each is filled in with what Kern
/// actually holds right now rather than being a blank instruction.
fn plan_week(today: &Today) -> String {
    format!(
        "Plan my week using Kern.\n\n\
         Today is {}. Kern has {} overdue, {} due today and {} in progress.\n\n\
         Look at what's there with kern_today, kern_overview and kern_task_search, then propose an order for the week: \
         what to do on which day, what to move, and what to drop. Tell me the plan before you change anything. \
         Once I agree, set the due dates with kern_task_update rather than creating second copies of tasks I already have.",
        today.date,
        today.overdue.len(),
        today.due_today.len(),
        today.in_progress.len()
    )
}

fn break_down_project(digest: &ProjectDigest, milestones: &[MilestoneBrief]) -> String {
    let existing = if milestones.is_empty() {
        "It has no milestones yet.".to_string()
    } else {
        format!(
            "It already has these milestones, which you should build on rather than replace: {}.",
            milestones.iter().map(|m| m.title.as_str()).collect::<Vec<_>>().join(", ")
        )
    };
    format!(
        "Break the Kern project “{}” (id {}) into milestones.\n\n\
         {} open tasks, {} done. {}\n{}\n\n\
         Read it with kern_project_get first. Then propose a handful of milestones, each with a target date, and say which existing tasks \
         belong to which. Show me that before writing it. Once I agree, use kern_milestone_create for each milestone and kern_task_create \
         for any new tasks, and leave the tasks I already have where they are unless I say otherwise.",
        digest.project.name,
        digest.project.id,
        digest.project.open_tasks,
        digest.project.done_tasks,
        digest.project.target_date.as_ref().map(|d| format!("Its target date is {d}.")).unwrap_or_default(),
        existing
    )
}

/// The most of a note's body a prompt carries. A long note is read with
/// kern_note_get instead of being poured into the prompt.
const PROMPT_NOTE_CHARS: usize = 20_000;

fn note_to_tasks(note: &NoteBrief) -> String {
    let body = note.content.clone().unwrap_or_default();
    let (body, cut) = match body.char_indices().nth(PROMPT_NOTE_CHARS) {
        Some((i, _)) => (body[..i].to_string(), true),
        None => (body, false),
    };
    format!(
        "Turn the Kern note “{}” (id {}) into tasks.\n\n\
         Here it is{}:\n\n---\n{}\n---\n\n\
         Pull out the things that are actually work — not the background — and list them as tasks, with a due date where the note implies one. \
         Show me the list first. Once I agree, create them in one kern_task_create call{}, and leave the note itself alone.",
        note.title,
        note.id,
        if cut { ", up to where it got too long for one prompt (read the rest with kern_note_get)" } else { "" },
        body.trim(),
        note.project_id.as_ref().map(|p| format!(" with projectId \"{p}\"")).unwrap_or_default()
    )
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for KernMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().enable_prompts().build())
            .with_server_info(Implementation::new("kern", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let projects = self
            .call("kern_resources_list", Access::Read, "list resources".into(), |c, cl| {
                tools::project_list(c, cl, &ProjectListArgs::default())
            })
            .await
            .map_err(|e| McpError::internal_error(e, None))?;
        let mut resources = vec![
            Resource::new(TODAY_URI, "today")
                .with_title("Today in Kern")
                .with_description("Tasks that are overdue, due today or in progress.")
                .with_mime_type("application/json"),
        ];
        // One per project, because this list is also how someone browsing a
        // client's resource picker sees what their workspace contains.
        for p in projects {
            resources.push(
                Resource::new(format!("kern://project/{}", p.id), p.name.clone())
                    .with_title(p.name)
                    .with_description(format!("{} open, {} done, {} overdue.", p.open_tasks, p.done_tasks, p.overdue_tasks))
                    .with_mime_type("application/json"),
            );
        }
        Ok(ListResourcesResult::with_all_items(resources))
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, McpError> {
        Ok(ListResourceTemplatesResult::with_all_items(vec![
            ResourceTemplate::new("kern://project/{id}", "project")
                .with_title("A Kern project")
                .with_description("A project with its boards, milestones, open tasks and note titles.")
                .with_mime_type("application/json"),
            ResourceTemplate::new("kern://note/{id}", "note")
                .with_title("A Kern note")
                .with_description("A note's Markdown body.")
                .with_mime_type("text/markdown"),
        ]))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        let uri = request.uri;
        let Some(target) = Target::parse(&uri) else {
            return Err(McpError::resource_not_found(format!("Kern has nothing at {uri}."), None));
        };
        let (body, mime) = match target {
            Target::Today => (
                self.call("kern_resource_today", Access::Read, "today".into(), |c, cl| as_json(&tools::today_list(c, cl)?)).await,
                "application/json",
            ),
            Target::Project(id) => (
                self.call("kern_resource_project", Access::Read, id.clone(), move |c, cl| {
                    as_json(&tools::project_get(c, cl, &IdArgs { id })?)
                })
                .await,
                "application/json",
            ),
            Target::Note(id) => (
                self.call("kern_resource_note", Access::Read, id.clone(), move |c, cl| {
                    Ok(tools::note_get(c, cl, &IdArgs { id })?.content.unwrap_or_default())
                })
                .await,
                "text/markdown",
            ),
        };
        let text = body.map_err(|e| McpError::resource_not_found(e, None))?;
        Ok(ReadResourceResult::new(vec![ResourceContents::text(text, uri).with_mime_type(mime)]).into())
    }

    async fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, McpError> {
        Ok(ListPromptsResult::with_all_items(vec![
            Prompt::new("plan_my_week", Some("Lay the week out from what Kern holds: what's overdue, what's due, what's underway."), None)
                .with_title("Plan my week from Kern"),
            Prompt::new(
                "break_down_project",
                Some("Turn a project into milestones, and say which tasks belong to each."),
                Some(vec![PromptArgument::new("project")
                    .with_description("The project's name, or its id.")
                    .with_required(true)]),
            )
            .with_title("Break this project into milestones"),
            Prompt::new(
                "note_to_tasks",
                Some("Read a note and pull the work out of it as tasks."),
                Some(vec![PromptArgument::new("note").with_description("The note's title, or its id.").with_required(true)]),
            )
            .with_title("Turn this note into tasks"),
        ]))
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, McpError> {
        let argument = |key: &str| {
            request
                .arguments
                .as_ref()
                .and_then(|a| a.get(key))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string()
        };
        let text = match request.name.as_str() {
            "plan_my_week" => {
                self.call("kern_prompt_plan_my_week", Access::Read, "plan the week".into(), |c, cl| {
                    Ok(plan_week(&tools::today_list(c, cl)?))
                })
                .await
            }
            "break_down_project" => {
                let needle = argument("project");
                self.call("kern_prompt_break_down_project", Access::Read, needle.clone(), move |c, cl| {
                    let project = tools::find_project(c, cl, &needle)?;
                    let digest = tools::project_get(c, cl, &IdArgs { id: project.id.clone() })?;
                    let milestones = tools::milestone_list(c, cl, &ProjectIdArgs { project_id: project.id })?;
                    Ok(break_down_project(&digest, &milestones))
                })
                .await
            }
            "note_to_tasks" => {
                let needle = argument("note");
                self.call("kern_prompt_note_to_tasks", Access::Read, needle.clone(), move |c, cl| {
                    let note = tools::find_note(c, cl, &needle)?;
                    Ok(note_to_tasks(&NoteBrief {
                        id: note.id,
                        title: note.title,
                        project_id: note.project_id,
                        content: Some(note.content),
                    }))
                })
                .await
            }
            other => return Err(McpError::invalid_params(format!("Kern has no prompt called '{other}'."), None)),
        };
        let text = text.map_err(|e| McpError::invalid_params(e, None))?;
        Ok(GetPromptResult::new(vec![PromptMessage::new_text(Role::User, text)]).into())
    }
}
