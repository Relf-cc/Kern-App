# MCP

How Kern becomes a Model Context Protocol server, so an AI client signed in
with your own subscription — Claude Desktop, Claude Code — can create tasks,
boards, flowcharts, notes and whole projects in Kern.

Status: **phases 0–4 built** — the server runs in-app over a pipe, the
bridge and a `.mcpb` extension ship beside it, the tool surface below is
live, a write can be held until the user approves it, and any one call can be
put back afterwards. Phase 4 added the three optional pieces: a loopback
**HTTP endpoint** beside the pipe ([§11](#11-the-http-endpoint)), Kern as an
MCP **client** ([§12](#12-kern-as-a-client)), and Kern's own AI features on
the **`claude` CLI** rather than an API key ([Appendix B](#appendix-b--putting-your-subscription-behind-kerns-own-ai)).
All of it ships in **0.2.6** (`release/notes-0.2.6.md`).

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
anything else  ──http──────────────────────▶ 127.0.0.1:8787/mcp, same handler (§11)
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
| Features | `server`, `macros`, `schemars`, `transport-async-rw`, plus `transport-streamable-http-server` (§11) and `client` + `transport-child-process` (§12) |
| Protocol | implements **2026-07-28**, compatible back through 2025-11-25 and earlier |
| Runtime | tokio — already present via Tauri; add `net` for pipes and `process` for child servers |
| axum | **0.8**, `default-features = false`, features `http1` + `tokio`. Only for §11: rmcp's Streamable HTTP server is a Tower service and something has to listen on the socket. Nothing else in Kern listens on a port |

Two costs to accept up front:

- **MSRV moves 1.80 → 1.88.** rmcp 3.6 is edition 2024. `rust-version` in
  `src-tauri/Cargo.toml` needs updating, and CI/toolchain with it.
- **Binary growth.** Measured on the 0.2.6 build: the release `kern.exe` is
  **15.1 MB** and the bridge 0.15 MB, which is the row now in
  PERFORMANCE.md — that table is the record. (The 7.3 MB figure elsewhere in
  that document is the process's working set, not the file.)

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
  http.rs      the loopback HTTP endpoint: token, Host/Origin rules, per-request service (§11)
  outbound.rs  the other direction: the user's own servers, and the ToolRunner the AI router calls (§12)
src-tauri/mcp-bridge/   new workspace member → kern-mcp(.exe)
scripts/mcp-bundle.mjs  the bridge sidecar + the .mcpb, built before each tauri build
src/features/ai/AssistantsSection.tsx (+ mcp.css), the dialogs it opens
(ConnectAssistantWizard, AssistantDialog, ProjectScopeDialog,
HttpEndpointDialog, McpActivityDialog, McpServerWizard), mcpActions.ts,
mcpForm.ts (+ test), McpApproval.tsx
```

Plus the edits the house recipes demand:

- commands registered in `generate_handler!` in `src-tauri/src/lib.rs`, under a
  new `// mcp` group;
- `api.mcp` in `src/lib/ipc.ts` and mirrored types in `src/lib/types.ts`;
- `"assistants"` added to `SettingsSection` in `src/stores/router.ts` (it
  began as an `"mcp"` tab of API; `/api/mcp` still resolves to it);
- settings keys in `src/features/settings/schema.ts` **twice** — the interface
  and `DEFAULTS` — plus rows in `SettingsPage.tsx` with `hint` and `keywords`.

New source files carry the `@Author` / `@Date` header.

Four migrations: one appends `mcp_clients` and `mcp_audit`; a later one adds
`undo` and `reverted_at` to `mcp_audit` (§7); phase 4 adds `mcp_servers` and
`mcp_tool_calls` (§12), and rebuilds `ai_accounts` because its `provider`
column was written with a `CHECK` naming the two API providers and SQLite
cannot widen one in place (Appendix B). All four MCP tables are
**per-computer**, so all four go in `DEVICE_TABLES` in
`src-tauri/src/db/mod.rs` and *not* in `TABLES` in `domain/cloud/sync.rs`. A
connected assistant is a property of this machine, not of your data; so is a
program installed on it.

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
executable path, and remembers the decision in `mcp_clients`. A token *is*
necessary on the HTTP endpoint, where any local process — including a web page —
could POST to a port; `Origin` validation and localhost-only binding come with
it. That is all in [§11](#11-the-http-endpoint), and it is why the endpoint has
a switch of its own rather than riding on `mcp.enabled`.

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

## 8. The settings section

**Settings → Assistants** (`SettingsSection` `"assistants"`) is ordinary
settings rows — built by `useAssistantGroups` in `AssistantsSection.tsx`, so
settings search finds every one — and each row says where things stand and
offers one way in. Anything that takes more than one decision opens a dialog;
anything that takes more than one step opens a `Wizard`. It started life as
an `mcp` tab of the API page, and `/api/mcp` still resolves here.

| Group | Rows | Opens |
| --- | --- | --- |
| Assistants | master switch with listening status; one row per client (status, scope, projects, last used); *Connect an assistant* | **Connect** wizard; **Review/Manage** dialog per client |
| Safety | *Ask before changes*; *Projects assistants may see*; calls a minute; *Activity* (summary); *Keep activity for*; *What an assistant can reach* | project picker; activity; the guarantees |
| Local address | status and URL | HTTP setup wizard the first time, its manager after |
| Servers Kern can use | `mcp.toolsEnabled`; one row per server (switch, Test / Edit / Remove); *Add a server*; `ai.maxToolRounds` | **Add a server** wizard |

**Connect an assistant** — *Choose → Set up → Approve*. Choosing Claude
Desktop, Claude Code or another app; continuing turns `mcp.enabled` on if it
wasn't. Set up does the work where Kern can:

- **Claude Desktop** → *Automatically* writes the `kern-mcp` entry into
  `claude_desktop_config.json`; *As an extension* shows `kern.mcpb` to drag
  onto Claude Desktop's Extensions page; *By hand* is the fragment to copy.
- **Claude Code** → `claude mcp add kern -- "<path>\kern-mcp.exe"` to copy.
- **Another app** → the bridge path and config to copy, or the local HTTP
  address (turned on from here) with its token.

Approve then waits — polling every 2 s, beaten by `kern://mcp-state` — for
the assistant to knock, and approves it inline with a scope and a project
list. That last step is the point: setup used to end with "now find the
request in Settings", while the assistant was being refused.

A client that knocks while nobody is in the flow raises a toast whose
**Review** opens the same approve-or-block dialog in place
(`reviewAssistant` in `McpApproval.tsx`, mounted in both shells), so an
assistant can be approved from wherever you are. While it is pending nothing
applies until **Approve**; afterwards each change applies as it is made, as a
settings row does.

The `.mcpb` (Anthropic's extension format, renamed from `.dxt` in September
2025) is a zip of a manifest and the bridge, built by
`scripts/mcp-bundle.mjs` from `beforeBuildCommand`, so every `tauri build`
has one; the same script writes the `binaries/kern-mcp-<triple>` sidecar that
`bundle.externalBin` installs beside `kern.exe`. `release.mjs` attaches
`Kern_<version>.mcpb` to the GitHub release as a plain download — it has
nothing to do with the updater.

Keys: `mcp.enabled`, `mcp.confirmWrites`, `mcp.allowedProjects`,
`mcp.maxCallsPerMinute`, `mcp.auditDays`, and from phase 4
`mcp.httpEnabled`, `mcp.httpPort` ([§11](#11-the-http-endpoint)) and
`mcp.toolsEnabled` ([§12](#12-kern-as-a-client)). `mcp.allowedProjects` is
the blanket allowlist: a project has to be inside it *and* inside the
client's own list, and while it is set no assistant can create a project.

**Add a server** — *Choose → Configure → Test*. Presets (Filesystem, Git,
Fetch, Memory, Playwright) fill in the command; *Something else* takes any.
Configure asks only for a name and, where the server needs them, folders
(picked, not typed); the command, arguments, environment and working folder
sit folded underneath, since a preset rarely needs them. Node launchers are
written `npx.cmd` on Windows because `outbound.rs` starts the command
directly, without a shell. Test saves first, then starts what was saved, and
lists the tools it offered; **Done** switches the server on — and, if asked,
`mcp.toolsEnabled` too. Editing opens at Configure, with *Save without
testing*.

The server presets, argument/environment forms and every row's summary line
are pure functions in `mcpForm.ts`, covered by `mcpForm.test.ts`.

## 9. Phasing

| Phase | Scope | Est. | |
| --- | --- | --- | --- |
| **0 — spike** | rmcp in-app over a pipe, bridge binary, one tool (`kern_task_create`), driven from Claude Code. Proves the MSRV bump, the pipe and the threading. | ½ day | done |
| **1 — core** | `policy.rs`, audit, migration, settings tab, read tools plus task/note/board writes, Claude Desktop config writer. | 2–3 days | done |
| **2 — the asks** | `kern_project_setup` via `ProjectDoc`, mermaid port + shared fixture, milestones and labels, resources, prompts. | 2 days | done |
| **3 — polish** | approval dialog, revert-batch, activity UI, `.mcpb`, `kern_project_update` and `kern_task_move`, DEVELOPMENT.md and README. | 1–2 days | done |
| **4 — optional** | HTTP transport (+axum) for other clients (§11); Kern as MCP client (§12); Appendix B. | 2–3 days | done |
| **5 — ship** | version 0.2.6, release notes at `release/notes-0.2.6.md`, the artifact sizes in PERFORMANCE.md re-measured from the 0.2.6 build. | ½ day | done |

The surface in §4 is complete. The settings keys are now eight —
`mcp.enabled`, `mcp.confirmWrites`, `mcp.allowedProjects`,
`mcp.maxCallsPerMinute`, `mcp.auditDays`, `mcp.httpEnabled`, `mcp.httpPort`,
`mcp.toolsEnabled` — plus `ai.maxToolRounds` on the AI side.

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
- **A port is not a pipe.** The pipe is ACL'd to one user account; a loopback
  port is reachable by everything running as anyone on the machine, and by a
  web page if nothing stops it. §11's token, `Host` allowlist and blanket
  `Origin` refusal are all load-bearing, and the endpoint is off by default
  with a switch of its own rather than riding on `mcp.enabled`.
- **Somebody else's program.** §12 starts a command the user typed, as the
  user. That cannot be made safe from inside Kern, so the UI says so plainly
  rather than implying a sandbox, and the switches, the round cap and the
  call log are what Kern does promise.
- **The CLI is not an API.** Appendix B depends on a command's flags and on
  the shape of its `--output-format json`, neither of which is a stable
  contract. It is pinned down by tests on the parsing and the error
  classification, and a CLI that has moved on shows up as a failed
  connection test with whatever it actually said, not as a silent wrong
  answer.

## 11. The HTTP endpoint

`domain/mcp/http.rs`. Claude Desktop still cannot reach a localhost HTTP
server (§1), so this is not for it: it is for everything that takes a URL —
Claude Code's `--transport http`, editors, a script. Same `ServerHandler`,
same tools, same `policy.rs`, same audit.

What changes is the boundary. The pipe needs no credential because the
operating system is one. A port is not: everything running on this computer
can reach `127.0.0.1`, and a page in a browser can try. So:

- **A bearer token**, 244 bits from two UUIDv4s, held in the OS credential
  store under its own service name — not beside the AI keys, because a token
  for a local port and a key that spends money are different kinds of
  secret. Compared in constant time, and accepted only in `Authorization`,
  never in a query string that would end up in somebody's shell history.
- **Loopback only.** The listener binds `127.0.0.1` and `[::1]` and never
  `0.0.0.0`, and rmcp validates `Host` against the loopback names, which is
  what stops a DNS name pointing here from being used to reach it.
- **No browser at all.** `enforce_origin_validation()` with an empty
  allowlist refuses any request carrying an `Origin` — which is every
  request a browser can make. A web page cannot talk to Kern even holding
  the token.

Identity works as it does on the pipe: the caller names itself
(`X-Kern-Client`, or `?client=`, else "HTTP assistant"), that name is
registered in `mcp_clients` and has to be approved in Settings → Assistants, and
the name is advisory — the token is what got it in. The service is built
**per request**, for the client the token's caller named, so revoking an
assistant stops its next call rather than its next connection.

`mcp_http_credentials` returns the token. That is a deliberate exception to
"Rust owns secrets": a bearer token is no use until it is in the other
program's configuration, and there is nowhere else for it to go. It is still
made in the backend, kept in the credential store, and never written to
SQLite, a log or a backup. **New token** throws it away and issues another,
which locks every HTTP client out at once and leaves the pipe alone.

Two keys, both off by default: `mcp.httpEnabled` and `mcp.httpPort` (8787,
clamped to 1024–65535). The endpoint needs `mcp.enabled` *and*
`mcp.httpEnabled`, because a port is a bigger thing to open than a pipe.
Changing the port restarts the listener; a port already in use is reported in
the tab rather than swallowed.

## 12. Kern as a client

`domain/mcp/outbound.rs`, and the only place in Kern where a model can reach
outside Kern's own data. The user adds an MCP server — a command, its
arguments, its environment, a working directory — and Kern starts it, speaks
MCP to it over its stdin and stdout, and offers its tools to the model during
an AI request that asked for them.

```
Kern (ai/router.rs tool loop) ──stdio──▶ npx @modelcontextprotocol/server-…
                               ToolRunner → outbound.rs → rmcp client
```

The honest part first: `command` runs as the user, with everything that gives
it. Kern cannot make that safe and the tab does not pretend to. What it does:

- **Two switches.** `mcp.toolsEnabled` is off by default, and each server
  arrives switched off. A tool is offered only when both are on.
- **Asked for, not assumed.** `RouteRequest.useTools` has to be set; an
  ordinary request carries no `tools` key at all.
- **A bounded loop.** The model answers with tool calls, Kern runs them,
  appends the results and asks again, up to `ai.maxToolRounds` (4). Each
  round is a billed request in its own right and is recorded as one. Hit the
  cap and Kern answers with the text it has, with a warning, rather than
  erroring.
- **No silent replay.** Once a tool has run the request stops being
  replayable: failing over to another account would run that tool a second
  time. `cargo test --lib ai::` holds that down.
- **A log.** Every call lands in `mcp_tool_calls` — server, tool, outcome,
  duration — the mirror of `mcp_audit`, pruned by the same setting.
- **Nothing offered back.** Kern connects as `()`: no sampling, no roots, no
  elicitation. A server cannot ask Kern's model to do anything.

Two details worth knowing. Tools are namespaced `<slug>__<tool>` from the
server's name, because a tool name may only hold letters, digits, `_` and
`-`, and two servers may both offer `read_file`. And the catalogue the model
is shown comes from the database — what each server offered when it was last
tested — so building a prompt never waits on `npx` downloading something.

Connections are kept open between calls (a loop makes several, and starting a
server takes seconds) and shut down when a server is changed, disabled or
removed. The router is synchronous by design, so a call is handed to the
runtime and waited for on a channel rather than through `block_on`.

A server's own API key goes in its `env`, which is stored as typed. That is
deliberate: Kern's credential store holds *the user's* secrets, and a drawer
full of other programs' keys with no way to use them except handing them to
those programs is ceremony, not security. The dialog says so and suggests the
environment the server already reads from.

## Appendix A — Kern as MCP *client* (the other direction)

Built in phase 4 — see [§12](#12-kern-as-a-client).

## Appendix B — putting your subscription behind Kern's own AI

Built in phase 4. `Provider::ClaudeCli` is a third provider whose "API" is the
`claude` command already installed on this computer, so breakdown, catch-up
and the rundown can run on the user's own subscription with no API key and
nothing billed per token.

The seam was as clean as expected. `complete_request` builds the ordinary
Anthropic body against a `claude-cli://local/v1/messages` URL, and
`CliTransport` — the only new `Transport` — answers anything on that scheme by
running the command and synthesising the response the API would have returned.
Everything downstream (routing, failover, cooldowns, usage, budgets, the
accounts UI) needed no changes at all. What *did* need changes was the idea
that an account has a key: `Provider::needs_key()` is now asked before the
vault is touched, before `clean_key`, in the connection test and in the
security report, and `ai_accounts.provider` needed its `CHECK` widened
(migration 12).

Three more decisions worth recording:

- **A model, not an agent.** The command runs with `--max-turns 1` in a
  scratch directory. The CLI's own file and shell tools are powerful and
  point at whatever directory it starts in; a request for a project
  breakdown must not be able to become a file write. Kern's tools go the
  other way round, through the server above.
- **No cost, not zero cost.** `Provider::metered()` is false, so Kern
  estimates no per-token cost and raises no budget warning in dollars rather
  than reporting a price for something already paid for. Token counts are
  still recorded.
- **Finding it.** The usual installer puts `claude` somewhere a shell profile
  adds to `PATH`, which a GUI process never reads. Kern tries the name, then
  the places the installers use, and `KERN_CLAUDE_CLI` overrides the lot.

Kern now drives itself in both directions: the CLI can be pointed at Kern's
own MCP server, in which case a model on the subscription is reading and
writing Kern through the tool surface in §4. Check Anthropic's terms on
programmatic use before relying on that in anger.

## Sources

- [MCP spec changelog (2026-07-28)](https://modelcontextprotocol.io/specification/latest/changelog)
- [MCP transports](https://modelcontextprotocol.io/specification/latest/basic/transports)
- [rmcp on docs.rs](https://docs.rs/rmcp/latest/rmcp/)
- [Rust SDK repository](https://github.com/modelcontextprotocol/rust-sdk)
- [Getting started with local MCP servers on Claude Desktop](https://support.claude.com/en/articles/10949351)
- [Desktop Extensions / MCPB](https://www.anthropic.com/engineering/desktop-extensions)
- [MCPB documentation](https://claude.com/docs/connectors/building/mcpb)
