# MCP

How Kern becomes a Model Context Protocol server, so an AI client signed in
with your own subscription — Claude Desktop, Claude Code — can create tasks,
boards, flowcharts, notes and whole projects in Kern.

Status: **plan**. Nothing here is built yet.

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
  policy.rs    the single choke point: enabled, scope, project allowlist, locks, limits
  clients.rs   registered clients, approval, last-seen
  audit.rs     mcp_audit writes + activity log
  mermaid.rs   flowchart text → whiteboard scene (Rust port, §5)
src-tauri/mcp-bridge/   new workspace member → kern-mcp(.exe)
src/features/ai/McpTab.tsx (+ mcp.css)
```

Plus the edits the house recipes demand:

- commands registered in `generate_handler!` in `src-tauri/src/lib.rs`, under a
  new `// mcp` group;
- `api.mcp` in `src/lib/ipc.ts` and mirrored types in `src/lib/types.ts`;
- `"mcp"` added to `ApiTab` in `src/stores/router.ts`;
- settings keys in `src/features/settings/schema.ts` **twice** — the interface
  and `DEFAULTS` — plus rows in `SettingsPage.tsx` with `hint` and `keywords`.

New source files carry the `@Author` / `@Date` header.

One migration appends `mcp_clients` and `mcp_audit`. Both are **per-computer**,
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
| `kern_task_update` / `_complete` / `_move` | `tasks::*` | write |
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
Nothing new to write: it exposes the engine that already backs templates.

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
the 11 `ShapeKind`s mapped onto Mermaid's brackets, and 201 lines of tests.

It is TypeScript, and the MCP handler is Rust. Two honest options:

1. **Port `parseMermaid` + `layoutChart` + `chartToScene` to
   `domain/mcp/mermaid.rs`** (~364 lines of pure functions, no React, no
   canvas — the file was written to be portable). Recommended.
2. Round-trip the conversion through the webview. Possible, since the app must
   be running anyway, but it makes a tool call depend on the window and buys
   nothing.

Port it, and **extract the cases from `mermaid.test.ts` into a shared JSON
fixture** that both the Vitest suite and a `#[cfg(test)]` module read. Two
implementations that cannot silently drift are worth the hour. The port also
gives `toMermaid` on the Rust side, so `kern_whiteboard_to_mermaid` lets the
model read a board drawn by hand.

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
- **Approval mode** (`mcp.confirmWrites`: never / destructive only / always):
  an in-app dialog with a timeout; declined returns `isError` with a readable
  reason.
- **Audit**: every call into `mcp_audit` (client, tool, argument digest, rows
  touched, outcome); writes also go through `activity::log`; a live list in
  the UI.
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

Phase 3 nicety: stamp each tool call's writes with a batch id in the activity
log and offer **Revert this batch** — safer than wiring the front-end undo
store to a backend actor.

## 8. The settings tab

The API page already has tabs `accounts | routing | usage | security`. Add
**`mcp` — "Assistants"**: master toggle; running/stopped status; connected
clients with scope, allowlist and last-seen; the audit list; and setup that
does the work:

- **Set up Claude Desktop** → writes the `kern-mcp` entry into
  `claude_desktop_config.json`, with copy-to-clipboard as a fallback.
- **Claude Code** → `claude mcp add kern -- "<path>\kern-mcp.exe"`, one click
  to copy.
- Later: ship a **`.mcpb` bundle** (Anthropic's extension format, renamed from
  `.dxt` in September 2025) so installing is drag-and-drop.

New keys: `mcp.enabled`, `mcp.confirmWrites`, `mcp.allowedProjects`,
`mcp.maxCallsPerMinute`, `mcp.auditDays`.

## 9. Phasing

| Phase | Scope | Est. |
| --- | --- | --- |
| **0 — spike** | rmcp in-app over a pipe, bridge binary, one tool (`kern_task_create`), driven from Claude Code. Proves the MSRV bump, the pipe and the threading. | ½ day |
| **1 — core** | `policy.rs`, audit, migration, settings tab, read tools plus task/note/board writes, Claude Desktop config writer. | 2–3 days |
| **2 — the asks** | `kern_project_setup` via `ProjectDoc`, mermaid port + shared fixture, milestones and labels, resources, prompts. | 2 days |
| **3 — polish** | approval dialog, revert-batch, activity UI, `.mcpb`, DEVELOPMENT.md and README. | 1–2 days |
| **4 — optional** | HTTP transport (+axum) for other clients; Kern as MCP client; Appendix B. | — |

## 10. Risks

- **Spec churn.** 2026-07-28 deleted the handshake and sessions; real clients
  lag behind it. Mitigation: rmcp pinned, and test against the client actually
  in use rather than against the spec.
- **Lock contention.** Tool calls must run on `spawn_blocking` and stay short —
  never hold the `Mutex<Connection>` across an await, or UI commands stall
  behind an agent. `project_setup` is one transaction, which is fine.
- **MSRV and binary size**, as above.
- **Agent writes at scale.** Twenty tasks from one call is normal; the
  undo/revert story is what keeps that comfortable, which is why it is phase 3
  and not "someday".

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
