# MCP

How Kern becomes a Model Context Protocol server, so an AI client signed in
with your own subscription — Claude Desktop, Claude Code — can create tasks,
boards, flowcharts, notes and whole projects in Kern.

Status: **phases 0–3 built** — the server runs in-app over a pipe, the
bridge and a `.mcpb` extension ship beside it, the tool surface below is
live, a write can be held until the user approves it, and any one call can be
put back afterwards. Phase 4 (an HTTP transport, Kern as a *client*) is
optional and not started; see [§9](#9-phasing).

## The one thing to get straight first

Kern's AI today runs **outward**: `domain/ai/router.rs` holds API keys in the
OS vault and pays per token. MCP runs **inward**: the client, on your Pro or
Max subscription, connects to Kern and calls *its* tools. No API key, no
per-token cost, and the model thinks in its own process.

The corollary matters: **this does not put Kern's own AI features on your
subscription.** Breakdown, catch-up and the rundown still need an API account,
because those are Kern calling a model. Putting them on the subscription is a
separate option — [Appendix B](#appendix-b--putting-your-subscription-behind-kerns-own-ai).

So the deliverable is: **Kern becomes an MCP server.**

## 1. Transport: where the server actually runs

Three facts decide this.

- **Claude Desktop cannot reach a localhost HTTP server.** Custom connectors
  are dialled from Anthropic's infrastructure, not from this machine. Local
  servers on Desktop are stdio, configured in `claude_desktop_config.json` or
  packaged as a `.mcpb` extension. Claude Code takes either stdio or HTTP.
- **Kern is a GUI process.** Its stdin/stdout are not a usable transport.
- **A second process must not open `kern.db`.** This is the strongest
  constraint. `AppState` serialises every query through a `Mutex<Connection>`;
  `swap_connection` repoints that connection when you switch cloud spaces; a
  commit hook feeds the sync outbox; device tables are parked and unparked on
  open; and passkey unlock state is a process-wide `static`, so a second
  process would read locked projects as if they were open. A sidecar that
  opens SQLite directly bypasses sync, the lock gate and every UI
  invalidation.

**Design:** the protocol lives inside the app, served over a **local named
pipe (Windows) / Unix socket**. A tiny `kern-mcp` bridge binary does nothing
but relay stdin↔pipe.

```
Claude Desktop ──stdio──▶ kern-mcp.exe ──named pipe──▶ Kern (rmcp ServerHandler → domain/*)
Claude Code    ──stdio──▶ kern-mcp.exe ──────┘
(phase 4)      ──http───────────────────────▶ 127.0.0.1 endpoint, same handler
```

The bridge is ~100 lines with no rmcp and no tokio — a blocking byte copy in
each direction. All protocol handling stays in one place, in-process, with the
live connection. rmcp's `transport-async-rw` serves over any
`AsyncRead + AsyncWrite`, which a named pipe is, so this gets stdio-equivalent
framing without an HTTP stack.

## 2. Dependencies and the MSRV bump

| | |
| --- | --- |
| Crate | `rmcp` **3.6.0** (official SDK, published 2026-10-20) |
| Features | `server`, `macros`, `schemars`, `transport-async-rw` |
| Protocol | implements **2026-07-28**, compatible back through 2025-11-25 and earlier |
| Runtime | tokio — already present via Tauri; add the `net` feature for pipes |
| axum | **not needed** with the pipe design (rmcp's HTTP server is a Tower service, so axum only arrives in phase 4) |

Two costs to accept up front:

- **MSRV moves 1.80 → 1.88.** rmcp 3.6 is edition 2024. `rust-version` in
  `src-tauri/Cargo.toml` needs updating, and CI/toolchain with it.
- **Binary growth.** `kern.exe` is 7.3 MB today (see PERFORMANCE.md); expect
  ~9–10 MB plus the bridge. Re-measure and update that table — it is the
  record.

The 2026-07-28 revision removed the `initialize` handshake, sessions and
`Mcp-Session-Id` entirely, and moved protocol version and client capabilities
into `_meta`. Don't hand-roll JSON-RPC against a spec moving at that rate: pin
rmcp and let it absorb the churn.

## 3. Files to add

```
src-tauri/src/domain/mcp/
  mod.rs       McpState, listener start/stop, the tauri::command wrappers
  server.rs    rmcp ServerHandler: #[tool_router] impl, resources, prompts
  tools.rs     tool fns → existing domain functions (thin; no SQL here)
  policy.rs    the single choke point: enabled, scope, project allowlists, locks, limits
  confirm.rs   "may it?" — the dialog a write waits on, and its timeout
  clients.rs   registered clients, approval, last-seen
  audit.rs     mcp_audit writes + activity log
  revert.rs    the undo plan a write records, and replaying it
  mermaid.rs   flowchart text → whiteboard scene (Rust port, §5)
src-tauri/mcp-bridge/   new workspace member → kern-mcp(.exe)
scripts/mcp-bundle.mjs  the bridge sidecar + the .mcpb, built before each tauri build
src/features/ai/McpTab.tsx (+ mcp.css), src/features/ai/McpApproval.tsx
```

Plus the edits the house recipes demand:

- commands registered in `generate_handler!` in `src-tauri/src/lib.rs`, under a
  new `// mcp` group;
- `api.mcp` in `src/lib/ipc.ts` and mirrored types in `src/lib/types.ts`;
- `"mcp"` added to `ApiTab` in `src/stores/router.ts`;
- settings keys in `src/features/settings/schema.ts` **twice** — the interface
  and `DEFAULTS` — plus rows in `SettingsPage.tsx` with `hint` and `keywords`.

New source files carry the `@Author` / `@Date` header.

Two migrations: one appends `mcp_clients` and `mcp_audit`, and a later one
adds `undo` and `reverted_at` to `mcp_audit` (§7). Both tables are
**per-computer**,
so both go in `DEVICE_TABLES` in `src-tauri/src/db/mod.rs` and *not* in
`TABLES` in `domain/cloud/sync.rs`. A connected assistant is a property of this
machine, not of your data.

## 4. The tool surface

Keep it to ~22 tools. A model's tool-selection accuracy falls off a cliff past
roughly thirty, and Kern has ~300 commands — so this is a curated surface, not
a mirror. Prefer one composite tool over five round trips.

| Tool | Maps to | Mode |
| --- | --- | --- |
| `kern_search` | `search::search` | read |
| `kern_overview` | `projects::list_projects` + `stats` | read |
| `kern_today` | `daily::rundown_data` | read |
| `kern_project_list` / `_get` | `projects::*` | read |
| **`kern_project_setup`** | `templates::create_project_from` | write |
| `kern_project_update` | `projects::update` | write |
| `kern_task_search` | `tasks::query_tasks` | read |
| `kern_task_create` (accepts an array, with subtasks) | `tasks::create_task` | write |
| `kern_task_update` / `_complete` | `tasks::*` | write |
| `kern_task_move` | `tasks::*` | write |
| `kern_task_delete` | `tasks_delete` → **Trash** | write |
| `kern_board_list` / `_create` | `boards::*` | write |
| `kern_note_create` / `_update` / `_get` | `notes::*` | write |
| **`kern_whiteboard_from_mermaid`** | §5 | write |
| `kern_whiteboard_to_mermaid` / `_list` | §5 | read |
| `kern_milestone_create` / `_list` | `milestones::*` | write |
| `kern_label_list` / `_create` | `labels::*` | write |
| `kern_activity_recent` | `activity::list` | read |

**`kern_project_setup` is the centrepiece, and it already exists in all but
name.** `domain/templates.rs` defines `ProjectDoc` — boards with columns,
milestones, tasks with subtasks, labels, priorities and day-offset due dates,
and notes — and `create_project_from(&tx, &doc, &input)` instantiates the whole
thing in one transaction. Expose `ProjectDoc` as the tool's input schema and
"set up a project for the Q1 launch" becomes a single atomic call producing a
project, a board, four columns, three milestones and twenty scheduled tasks.
What it took was not the engine but the schema: `ProjectDoc` is mirrored in
`tools.rs` as model-facing structs (`ProjectSetupArgs`, `NewBoard`,
`NewMilestone`, `PlannedTask`, `NewNote`) rather than derived straight from the
template type, so a field Kern adds for its own templates can't silently become
something an assistant may set, and each field can say what it means to someone
who has never seen Kern. Subtasks are a list of titles rather than nested tasks,
which is what a checklist is and keeps the schema flat.

Notes are plain Markdown, so "detailed notes" needs no conversion layer — the
model's best output format is already the storage format.

Two more, both cheap and both worth shipping:

- **Resources** — `kern://project/{id}`, `kern://note/{id}`, `kern://today` —
  so the model can read context without burning a tool call.
- **Prompts** — "Plan my week from Kern", "Break this project into
  milestones", "Turn this note into tasks". These appear in Claude Desktop's
  prompt picker and are how someone discovers what the integration can do.

**Deliberately not exposed:** linked-folder file read/write, the terminal/PTY,
environment variables and `env_var_reveal`, git push, GitHub token operations,
cloud account operations, purge and empty-trash, settings writes, passkey
operations. If file access is added later, the `folders::is_sensitive` rule
applies on top of it, and that isn't a setting.

## 5. Flowcharts

Mermaid is how flowcharts travel between an LLM and anything else, and the app
already committed to that: `src/features/whiteboard/mermaid.ts` parses
`flowchart`/`graph`, lays the nodes out and emits Kern nodes and edges, with
the 11 `ShapeKind`s mapped onto Mermaid's brackets, under test.

It is TypeScript, and the MCP handler is Rust. The alternative — round-tripping
the conversion through the webview — would make a tool call depend on an open
window and buy nothing, so `parseMermaid`, `layoutChart`, `chartToScene` and
`toMermaid` are **ported to `domain/mcp/mermaid.rs`**: pure functions, no React,
no canvas, no regex crate (the patterns are hand-rolled, which is most of the
port's bulk).

Two implementations of one parser drift unless something stops them, so the
cases live in **`src/features/whiteboard/mermaid.cases.json`**, which both test
suites read — Vitest by import, Rust by `include_str!`. A case added there must
pass in both; a case only one of them satisfies is a bug in the other. The port
also gives `toMermaid` on the Rust side, so `kern_whiteboard_to_mermaid` lets
the model read a board drawn by hand.

## 6. Safety model

This deserves the most care, because MCP means task titles and note bodies
leave the machine through the client.

**The boundary is the OS, and the UI should say so plainly.** The pipe is
ACL'd to your user account. A token file in the data dir would be readable by
anything already running as you, so it adds ceremony, not security — don't
pretend otherwise. Identity is advisory: on first connection Kern raises
**"*Claude Desktop* wants to connect to Kern"**, showing the client name and
executable path, and remembers the decision in `mcp_clients`. A token *does*
become necessary in phase 4, where any local process — including a web page —
could POST to an HTTP port; the spec also requires `Origin` validation and
localhost-only binding there.

Everything else:

- `mcp.enabled` **off by default**. Per-client scope: `read` or `read+write`.
  There is no destructive scope.
- **Project allowlist** — all projects, or a chosen set.
- **Locked projects stay invisible.** Every read path picks one of the three
  gate kinds documented in DEVELOPMENT.md — `readable_sql`,
  `ensure_readable`, or post-filter. Add `cargo test mcp`, which walks every
  registered tool and asserts it, the way `cargo test passkeys` does.
- **Deletes mean Trash.** The purge commands are not in the surface.
- **Approval mode** (`mcp.confirmWrites`: never / deletes and rewrites /
  every change). `confirm.rs` emits the question, brings the window forward
  and waits on a channel; two minutes of silence counts as *no*, because
  nobody being at the keyboard is exactly when a write shouldn't go through.
  A refusal comes back as a readable sentence saying who decided. The wait
  happens **before** the database lock is taken — a dialog holding the
  connection would stall the rest of the app behind it. How much of a change
  a call is (`Risk`) is decided per tool, where the arguments are in hand:
  replacing a note's body or what's on a whiteboard counts, adding to either
  doesn't.
- **Audit**: every call into `mcp_audit` (client, tool, argument digest, rows
  touched, outcome); writes also go through `activity::log`; a live list in
  the UI, each row offering **Revert** (§7).
- **Limits**: calls per minute, tasks per call, note length. A confused agent
  should hit a wall, not the database.
- **Privacy docs**: MCP joins the bulleted list in DEVELOPMENT.md § Privacy and
  permissions. It is the first feature where data leaves via a *client* rather
  than an outbound request, so `privacy.network` does not cover it and the copy
  must be explicit.

## 7. Keeping the interface live

Sync already solved this. `kern://cloud-applied` carries the touched tables and
`CloudHost.tsx` invalidates from it. Mirror it: emit
`kern://mcp-applied { tables, clientName, summary }` after each write,
invalidate the matching domains, and raise a toast — *"Claude created 6 tasks
in Website Redesign."* A coarse `kern://data-changed` works for a first cut.

**Revert this batch.** One call is one batch, and the audit row *is* the
batch id — there is no second table. Each write returns `Wrote<T>`: its answer
plus the least that would undo it (`revert::Step` — the ids it created, and
the fields it overwrote as they were), which `server.rs` stores as JSON in
`mcp_audit.undo`. `mcp_revert` replays those steps in one transaction and
stamps `reverted_at`. The `kern://mcp-applied` event carries the batch id, so
the toast can offer it there and then.

This deliberately isn't the front-end undo store: that is a stack of closures
living in a window, and an assistant writes while nobody is looking. Two
honest limits, both said out loud in the dialog: a revert restores the call's
own changes and overwrites anything edited since, and a change's consequences
stay (the next occurrence of a recurring task the assistant completed is a
task in its own right by then). Created items go to Trash, as every other
delete in Kern does. A whiteboard too big to keep a copy of simply has no
plan, and the row says so instead of offering a button that does nothing.

## 8. The settings tab

The API page already has tabs `accounts | routing | usage | security`. Add
**`mcp` — "Assistants"**: master toggle; running/stopped status; connected
clients with scope, allowlist and last-seen; the audit list; and setup that
does the work:

- **Set up Claude Desktop** → writes the `kern-mcp` entry into
  `claude_desktop_config.json`, with copy-to-clipboard as a fallback.
- **Claude Code** → `claude mcp add kern -- "<path>\kern-mcp.exe"`, one click
  to copy.
- **Extension bundle** → shows `kern.mcpb` in the file manager, to drag onto
  Claude Desktop's Extensions page. The `.mcpb` (Anthropic's extension
  format, renamed from `.dxt` in September 2025) is a zip of a manifest and
  the bridge, built by `scripts/mcp-bundle.mjs` from `beforeBuildCommand`, so
  every `tauri build` has one; the same script writes the
  `binaries/kern-mcp-<triple>` sidecar that `bundle.externalBin` installs
  beside `kern.exe`. `release.mjs` attaches `Kern_<version>.mcpb` to the
  GitHub release as a plain download — it has nothing to do with the updater.

New keys: `mcp.enabled`, `mcp.confirmWrites`, `mcp.allowedProjects`,
`mcp.maxCallsPerMinute`, `mcp.auditDays`. `mcp.allowedProjects` is the
blanket allowlist: a project has to be inside it *and* inside the client's
own list, and while it is set no assistant can create a project.

## 9. Phasing

| Phase | Scope | Est. | |
| --- | --- | --- | --- |
| **0 — spike** | rmcp in-app over a pipe, bridge binary, one tool (`kern_task_create`), driven from Claude Code. Proves the MSRV bump, the pipe and the threading. | ½ day | done |
| **1 — core** | `policy.rs`, audit, migration, settings tab, read tools plus task/note/board writes, Claude Desktop config writer. | 2–3 days | done |
| **2 — the asks** | `kern_project_setup` via `ProjectDoc`, mermaid port + shared fixture, milestones and labels, resources, prompts. | 2 days | done |
| **3 — polish** | approval dialog, revert-batch, activity UI, `.mcpb`, `kern_project_update` and `kern_task_move`, DEVELOPMENT.md and README. | 1–2 days | done |
| **4 — optional** | HTTP transport (+axum) for other clients; Kern as MCP client; Appendix B. | — | next |

The surface in §4 is now complete, and so are the five settings keys.

## 10. Risks

- **Spec churn.** 2026-07-28 deleted the handshake and sessions; real clients
  lag behind it. Mitigation: rmcp pinned, and test against the client actually
  in use rather than against the spec.
- **Lock contention.** Tool calls must run on `spawn_blocking` and stay short —
  never hold the `Mutex<Connection>` across an await, or UI commands stall
  behind an agent. `project_setup` is one transaction, which is fine.
- **MSRV and binary size**, as above.
- **Agent writes at scale.** Twenty tasks from one call is normal, which is
  why the undo story went in at phase 3 rather than "someday": one call is
  one batch, and the whole batch goes back together.

## Appendix A — Kern as MCP *client* (the other direction)

Later, `ai/router.rs` could call external MCP servers during assist and
catch-up runs (add `transport-child-process` and `client` to the same rmcp
dependency). Real value, but it spends API tokens and does not serve the goal
above — park it behind phase 4.

## Appendix B — putting your subscription behind Kern's own AI

To get *in-app* features onto the subscription rather than an API key: add a
third variant to `Provider` in `domain/ai/provider.rs` that shells out to the
local `claude` CLI (`claude -p --output-format json`) through a new `Transport`
implementation. The seam is already clean — `Transport` is a one-method trait.
Combined with the MCP server, Kern would effectively be driving itself. Check
Anthropic's terms on programmatic use before building it.

## Sources

- [MCP spec changelog (2026-07-28)](https://modelcontextprotocol.io/specification/latest/changelog)
- [MCP transports](https://modelcontextprotocol.io/specification/latest/basic/transports)
- [rmcp on docs.rs](https://docs.rs/rmcp/latest/rmcp/)
- [Rust SDK repository](https://github.com/modelcontextprotocol/rust-sdk)
- [Getting started with local MCP servers on Claude Desktop](https://support.claude.com/en/articles/10949351)
- [Desktop Extensions / MCPB](https://www.anthropic.com/engineering/desktop-extensions)
- [MCPB documentation](https://claude.com/docs/connectors/building/mcpb)
