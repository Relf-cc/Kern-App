# Developing Kern

Notes for building Kern from source and working on the code. If you just want
to use the app, see the [README](README.md).

Kern is a [Tauri 2](https://v2.tauri.app) app: a React + TypeScript frontend and
a Rust backend that owns all data (SQLite) and OS integration.

## Running and building

Requirements: Node 20+, Rust (stable, MSVC toolchain on Windows), WebView2
(preinstalled on Windows 11). On Linux, install the
[Tauri system dependencies](https://v2.tauri.app/start/prerequisites/#linux)
(WebKitGTK 4.1, libayatana-appindicator, librsvg, patchelf).

```bash
npm install
npm run app:dev      # development (Vite + Tauri, hot reload)
npm run app:build    # release installers in src-tauri/target/release/bundle/
npm test             # frontend unit tests (Vitest)
cd src-tauri && cargo test   # backend unit and integration tests
```

Linux release bundles (.deb, .rpm, AppImage) are built in an Ubuntu 22.04
container so they run on older distributions too; from any OS with Docker:

```bash
docker build -t kern-linux scripts/linux
docker run --rm -v "$PWD:/repo:ro" -v "$PWD/release/linux:/out" \
  -v kern-cargo:/root/.cargo/registry -v kern-target:/build/src-tauri/target kern-linux
```

To run a development or test instance against a separate data folder (so your
real data is never touched), set `KERN_DATA_DIR` before launching. Such an
instance runs alongside the normal one and uses its own credential-store namespace.

## Releasing and in-app updates

Kern updates itself: when a newer release exists, the sidebar's *Update
available* button (or *Update to …* in Settings → About) swaps the window for a
minimal update screen, downloads the signed installer (up to three attempts;
if all fail it returns to the running version), and installs it. Copies
installed with the `.exe` update silently, with Kern's update screen as the only
UI; `.msi` copies are per-machine, so their installer runs passively and Windows
asks for admin approval (see `context()` in `src-tauri/src/lib.rs`). On the
first start of the new version a *What's new* dialog shows that release's
notes, read from its GitHub release (or from `latest.json` when offline). The
code is in `src/features/updates/`.

The updater reads `latest.json` from the newest (non-pre-release) GitHub
release and only installs files signed with the updater key. The public key is
in `tauri.conf.json` (`plugins.updater.pubkey`); the private key lives outside
the repository, at `~/.tauri/kern-updater.key` by default. **Back it up:** if
it's lost, installed copies can't verify any future update and everyone has to
reinstall by hand once.

To release a new version:

1. Bump the version in `package.json`, `package-lock.json`,
   `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json`;
   commit, tag `v<version>` and push both.
2. Write the release notes (Markdown; a `## What's new` section and an
   optional `## Install` section, which the in-app dialog leaves out).
3. `npm run release -- --notes notes.md --publish`

The script builds the installers with updater signatures, writes
`src-tauri/target/release/bundle/latest.json`, and creates the GitHub release
with the `.exe`, `.msi` and `latest.json` attached. Without `--publish` it
stops after building. The key can also come from `TAURI_SIGNING_PRIVATE_KEY`
(its contents) or `KERN_UPDATER_KEY` (a path).

### Security releases

Add `--security` to make a release a required update. The script puts
`<!-- kern:security -->` at the top of its notes (invisible on GitHub); any
copy older than a release carrying that marker updates without asking, even
when newer, ordinary releases have come out since. Kern starts the update screen
by itself in every mode. If it doesn't finish, Kern stays usable (it's
local-first, so nobody is locked out of their data while offline), shows a
*Security update required* notice, and tries again every 10 minutes and on
each start. Copies with network access turned off in Settings → Privacy don't
check, so they aren't forced either. Use it only for real security fixes.

## Renaming the app

The name "Kern" is provisional. To change it:

1. `src/app/brand.ts`: `APP_NAME` (all UI text).
2. `src-tauri/tauri.conf.json`: `productName` and the window `title`. Changing
   `identifier` moves the data folder (see below).
3. Optionally, `package.json` / `src-tauri/Cargo.toml` package names and the
   icon (`assets/icon.svg`, then `npx tauri icon assets/icon.svg`).

## Architecture

```
src/                     React + TypeScript (strict), Vite
  app/                   bootstrap, routes, global effects and shortcuts
  components/ui|layout   design-system controls (Radix primitives, custom styling) and the shell
  features/<feature>/    dashboard, tasks, boards, projects, whiteboard, notes, inbox,
                         daily-briefing, focus, search, capture, settings, trash, onboarding,
                         storage, links, ai (API accounts), github (GitHub & git),
                         command-centre (project overview), milestones, sessions, workspace
                         (resume & snapshots), catchup, health, terminal, dev (repositories,
                         worktrees, commands, environment profiles, services, dependencies)
  lib/                   typed IPC client, query layer, dates, shortcuts, fuzzy matching
  stores/                Zustand stores for transient UI state, settings, router, undo, toasts
  styles/                design tokens (CSS variables), base, controls, layout
src-tauri/src/
  db/                    connection setup, versioned migrations
  domain/                one module per area: pure service functions on &Connection plus
                         thin #[tauri::command] wrappers (incl. folders, storage, links,
                         ai/{vault,provider,router,accounts}, git, github, repos, worktrees,
                         workflow, sessions, workspace, milestones, devenv, pty, envvars,
                         services, deps, health, catchup, fileindex)
  scheduler.rs           single low-frequency thread: briefings, reminders, backups, housekeeping
  window.rs              window state persistence, tray, close/minimise behaviour
```

- The frontend never issues SQL. It calls typed commands (`src/lib/ipc.ts`). Errors come
  back as `{ code, message }` and are shown as actionable messages with Retry.
- Persisted data uses TanStack Query (keys are grouped by domain for invalidation).
  Mutations are optimistic, roll back on failure, and offer Undo where reversible.
- Heavy modules (whiteboard renderer, rich-text editor, settings, calendar, storage
  chart, API pages, Code tab) are lazy-loaded chunks.
- Network and filesystem work (storage scans, favicon/link fetching, AI requests,
  git, GitHub) runs in async commands on background threads, never the UI thread.

## Data

- Database: SQLite (WAL, foreign keys, FTS5 search kept in sync by triggers) at
  `%APPDATA%\app.kern.desktop\kern.db` (Linux: `~/.local/share/app.kern.desktop/kern.db`).
  Managed attachments live alongside it in `attachments/` and are referenced by relative paths, so backups restore on other machines.
- Dates are local calendar dates (`YYYY-MM-DD`) and times are `HH:MM`, so due dates
  never shift with timezone or DST changes. Instants are UTC epoch milliseconds.
- Migrations are versioned with `PRAGMA user_version`. Each runs in its own
  transaction (an interrupted migration rolls back), and a full copy of the
  database is written to `backups\` before an existing database is migrated.
- Deleting moves items to a recoverable Trash (purged after a configurable period).

### Backups and export

One versioned zip format (`manifest.json` + `kern.db` + `attachments/`) is used for
automatic, manual and pre-restore backups. "Export everything" adds portable copies:
`data/<table>.json`, `notes/*.md` (with front matter), `whiteboards/*.json` and
`settings.json`. Restore validates the archive (manifest, integrity check, schema
version), shows a preview, writes a safety backup, copies the data in with SQLite's
online backup API and swaps attachments atomically. Separate exports produce tasks
as CSV, notes as Markdown and projects as JSON.

## Kern Cloud (optional sync and collaboration)

The server lives in the separate `KERNWEB` repository (Node, Hono, Better Auth,
PostgreSQL) at `https://api.relf.cloud/kern/v1`. Development builds can point
elsewhere with `KERN_CLOUD_URL` (e.g. `http://localhost:8787/kern/v1`).

That environment variable is the *only* way to move the address, and
deliberately so: `client::api_base()` takes no argument and reads no setting.
The session token is sent as a bearer to whatever it returns, and the request
is made in Rust with `ureq`, where the window's CSP doesn't apply - so an
address the front end could write would be a way to hand the token to another
host. Settings are writable from the front end (`settings_set` takes any key),
so a backend-trusted address must not live there. Self-hosting uses the
environment variable too.

Signing out reports whether the server actually ended the session
(`cloud_sign_out` returns a bool). The local token is removed either way, but
a revoke that never reached Kern Cloud leaves the session usable by anyone
holding a copy of the token, so the interface says so rather than claiming a
clean sign-out; a rejected session counts as revoked, since it was already
gone.

- **Offline mode** is the ordinary `kern.db`, unchanged and account-free.
- **Spaces**: the personal space and each workspace get a local replica at
  `cloud/<user>/<space>.db` with the same schema, so every feature works the
  same (and offline). Switching spaces swaps the connection in `AppState`.
  Per-computer tables (settings, AI accounts and usage, folder trust, caches,
  notification log, linked-file index; `db::DEVICE_TABLES`) are parked under a
  `_device_` prefix in replicas, and `kern.db` is attached as `local`, so
  unqualified names resolve to the device copy. Migrations unpark, migrate and
  re-park, so every schema step applies to replicas unchanged.
- **Sync** (`domain/cloud/sync.rs`): triggers on the synced tables
  (`sync::TABLES`) record changed rows in `sync_outbox`. A push sends field-level
  diffs against `sync_shadow` (the server's version as last known), or the full
  row for new records; personal columns (pins, last opened, whiteboard viewport,
  local repository links) never sync. The server merges per field and replies
  with merged rows, which are applied like any remote change: a three-way merge
  where fields with unsent local edits keep the local value. Deletes win and
  leave tombstone shadows, so stale copies can't resurrect a record. Remote
  rows are applied with change capture paused and foreign keys off.
- **Worker** (`domain/cloud/mod.rs`): one background thread, woken by the
  replica's commit hook, pushes and pulls with backoff, and emits
  `kern://cloud-sync` (status) and `kern://cloud-applied` (tables and
  whiteboards changed; the interface invalidates matching queries).
- **Session**: the Better Auth bearer token is stored in the OS credential
  store and used only by the backend (`cloud_request` proxies API calls). The
  interface opens the realtime socket with a single-use ticket, hands incoming
  changes to `cloud_apply`, and shares presence (view, whiteboard cursor and
  selection) and live drags.
- **Whiteboards** save diffs (`whiteboard_patch`) against a per-editor baseline
  and three-way merge collaborators' saves (`features/whiteboard/collab.ts`);
  undo only reverts your own edits. Images placed on a cloud whiteboard are
  compressed in the interface (WebP, ≤1600 px, stepped down to ~400 KB;
  `features/whiteboard/cloudImages.ts`), uploaded once per space (de-duplicated
  by hash) and referenced as `data.cloudAsset`. Other computers show the original
  when they have it, otherwise download the shared copy into
  `cache/cloud-assets/<space>/` (`cloud_image_path`).
- **Invitations**: `link.relf.cloud/kern/invite/<id>` hands off to
  `kern://invite/<id>` (tauri-plugin-deep-link; single-instance forwards it).
- Backups, restore and "export everything" cover offline data only; automatic
  orphaned-asset cleanup is skipped once cloud replicas exist (their whiteboards
  may use attachment files).

Tests: `cargo test cloud` (engine and client), `npx vitest run collab`, and an
opt-in two-replica test against a running server (see KERNWEB's README).

## Privacy and permissions

- No network access is needed. Every network use is optional and controlled in
  Settings → Privacy, with a master switch that turns all of it off:
  - website favicons and link titles, fetched directly from the linked site (never
    a third-party proxy), cached locally; private/local addresses are refused;
  - AI requests and connection tests, only when you make them (no polling);
  - GitHub issue sync and pull requests, only for projects you connect;
  - Kern Cloud, only after turning on online collaboration and signing in.
- Settings → Privacy & Security also covers what Kern shows and keeps locally:
  - **Blur contents when Kern isn't focused** (`privacy.blurOnUnfocus`) sets
    `data-unfocused` on the root element from `src/app/effects.ts`; `base.css`
    blurs `#root`, with no transition so nothing is readable mid-fade.
  - **Show details in notifications** (`privacy.notificationDetails`): off means
    reminders, mentions and focus alerts carry no task titles, comment text or
    names. Call `notify::details_allowed(conn)` with the connection in hand and
    choose a neutral line — `notify::send` runs with the database lock released.
  - **Trust expires after** (`privacy.trustExpiryDays`, 0 = never): `trust_of`
    reads an expired decision as restricted immediately, and
    `apply_trust_retention` writes the downgrade back at the next launch.
  - **Record recently opened items** (`privacy.recordRecents`): off makes
    `recent::touch` a no-op, and `recent_list` clears the table, so turning it
    off also forgets what was already recorded.
  - **Allow plugin and syntax downloads** (`privacy.pluginDownloads`) gates
    `syntax_install` on top of the network switch.
- Files that commonly hold secrets (`.env`, `*.pem`, `*.key`, `id_rsa`, anything
  named `credentials` or `secret` — `folders::is_sensitive`) are never offered to
  AI features, trusted folder or not. That isn't a setting.

### Passkeys and locked projects

`domain/passkeys/` holds both. A passkey is a credential in the OS
authenticator — Windows Hello, or a security key over USB. WebAuthn does not
work inside the webview ([tauri#7926](https://github.com/tauri-apps/tauri/issues/7926),
[WebView2Feedback#5663](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5663)),
so registration and assertion run in Rust through `webauthn.dll`
(`platform_windows.rs`) and the front end never sees key material. macOS and
Linux fall to `platform_other.rs`, which reports that passkeys aren't available
there; implementing one of them means writing those three functions and nothing
above them changes.

Details that aren't obvious from the code:

- **It is a gate, not encryption.** `kern.db` holds the same rows either way,
  so the lock guards the running app, not the data at rest. Say so when
  describing the feature; don't let it read as "encrypted projects".
- **Signatures aren't re-verified.** Kern is its own relying party on the same
  machine as the authenticator, so the gate checks that the OS returned an
  assertion for a credential registered here with its user-verified flag set.
  A verifying key would live inside the process being protected.
- **Locks only bite while this computer has a passkey** (`enforced`), and
  `passkeys_reset` clears every passkey and lock without asking for one. Both
  exist so a synced lock or a reset Hello container can't strand a project
  forever; neither gives up anything that reading the database wouldn't.
- **Credentials are per computer** (`passkeys` is in `DEVICE_TABLES`) while
  `projects.locked_at` syncs, so the lock follows the project and each
  computer registers its own passkey. Sync picks the new column up on its own
  — `sync::columns` reads `pragma_table_info`.
- **Where the gate sits.** Every way into a project's content is covered, in
  one of three ways. Adding a new read path means picking one of them.

  | Kind | How | Covers |
  | --- | --- | --- |
  | SQL predicate | `readable_sql(conn, col)` spliced into the query | `tasks::query_tasks`, `notes_list`, `whiteboards_list`, `activity_list`, `milestones::upcoming`, `comments::mentions_of`, the `stats` counts, `archive::tasks_csv` and `notes_to_dir` |
  | Hard refusal | `ensure_readable(conn, project_id)` (or `_opt`) | `get_task`, `get_note`, `whiteboards::get`, `boards::get_board`, `milestones::list`/`get`, `comments::list`, `attachments::list`, `envvars::profiles` and `env_var_reveal`, `health`, `catchup::build`, `devenv::commands_list`/`devenv_cached`, `repos_list`, and the two file roots |
  | Post-filter | drop rows from a finished list | `search`, `recent_list`, `trash_list`, `task_relations` |

  Two resolvers do most of the work: `folders::root_of`/`target_root` and
  `repos::local_root` are where every file, terminal, git, deps, devenv and
  file-index path resolves a directory, so gating those three covers the dev
  tools without touching them. `projects::hide_content` keeps a locked
  project's name and blanks its counts, which is what lets the sidebar and the
  unlock screen work. `cargo test passkeys` walks each surface.
- **Deliberately not gated**, all three for a reason:
  - **Writes.** Nothing can reach them while the UI shows the lock screen, and
    they reveal nothing. Gating them would mostly add ways to fail.
  - **Whole-database backups and `export_all`.** They copy the file, which is
    data at rest and the documented way back from a lost authenticator; the
    scheduler depends on them, so a locked project must not stop them. The
    targeted exports (CSV, Markdown, per-project JSON) *do* respect the gate
    — the JSON one refuses by name rather than quietly leaving content out.
  - **`trash::list` itself.** `trash_purge_older_than` works through it and
    must not skip a locked project; the filter is in the `trash_list` command.
- Session state (which projects are open, and until when) is a process-wide
  `static` in that module, because the read paths only have a `&Connection`.
  `privacy.passkeyRelockMinutes` sets the lapse; 0 means until Kern quits.
- AI API keys and the GitHub token live in the OS credential store (Windows
  Credential Manager / macOS Keychain / Secret Service), never in SQLite, logs or
  backups. Only the backend uses them. GitHub can also use the GitHub CLI's login.
- Linked project folders are separate from projects: deleting a project never
  touches its folder. Folders are restricted by default; programs, git commands
  and file changes need an explicit "trusted" decision, recorded per exact folder.
- Tauri capabilities are limited to window show/focus, native open/save dialogs,
  notifications, autostart and the optional global quick-capture shortcut. The CSP
  allows one remote connection: the Kern Cloud realtime socket. Opening
  files and URLs, and all file writes, go through Kern's own commands.
- The asset protocol can only read the app's `attachments` folder and the favicon
  cache, and the CSP no longer allows remote images.

## Key behaviours

- **Daily rundown**: a deterministic, offline summary with a transparent score
  (priority, days overdue, due today, pinned, in progress, carried over, project
  deadline, minus blocked). Each suggestion shows its score breakdown, can be
  dismissed for the day, or pinned. The first rundown of each day is stored as a
  snapshot for history; the evening review stores what was done and what moved.
- **Recurring tasks**: completing an occurrence keeps it as history and spawns the
  next one (with its checklist reset). Missed occurrences are skipped, not
  back-filled. "From completion" schedules relative to the completion day.
- **Focus timer**: timestamp-based, so it stays accurate when minimised. The
  completion notification is fired from a native thread.

- **Task completion**: a left-to-right strikethrough (CSS only, no layout
  measurement); writes are ordered and coalesced per task so rapid clicks always
  converge on the last click. Instant with reduced motion.
- **AI routing**: Manual, Automatic failover, Priority or Cost-conscious. Failover
  only replays requests that produced no output, honours retry-after, never rotates
  between keys in the same organisation after a pool-wide limit, and is bounded.
- **GitHub issues**: two-way, three-way-merged per field (newer edit wins when
  both sides changed). Deleting a task unlinks it; it never closes the issue.

### Kern Lite

The same window can run as full Kern or as **Kern Lite**, a small task tracker
(`src/features/lite/`, its own lazily loaded chunk; full Kern lives in
`src/app/Shell.tsx`). Both use the same backend and data, so there's nothing to
sync between them. `window.rs` tracks the mode, gives each mode its own minimum
size and remembered geometry (`internal.windowState` / `internal.liteWindowState`),
and handles `--lite` / `--full` on the command line (also forwarded by the
single-instance plugin, and used by the Windows installer's "Kern Lite" Start menu
shortcut from `src-tauri/windows/hooks.nsh`). `general.startMode` (ask, kern, lite)
picks the mode at launch; "ask" shows `src/app/StartChooser.tsx`.

Switching cloud space or account calls `resetInterface` (`src/app/reset.ts`):
the query cache is cleared and the shell remounts, so nothing from the previous
data stays on screen.

### Projects, with optional development tools

A project needs only a name. Everything else - folders, repositories, commands,
services - is optional and only appears once it's connected, so a renovation or a
school assignment never shows git tabs or empty developer panels.

- **Command Centre**: each project's overview is an editable widget grid (the
  dashboard engine) starting from a preset that fits the project - General, or
  Hybrid once code is linked. Development widgets load lazily and only if added.
- **Resume Workspace**: Kern remembers each project's tab, board, whiteboard, open
  task, open file, selected repository and terminal layout (debounced, flushed on
  navigation/close) and restores it, skipping anything that no longer exists.
  Named workspace snapshots can be saved and reapplied. Resuming never runs
  commands, restarts services or starts assistants.
- **Milestones** work in every project (target date, status, progress from tasks or
  manual, dependencies) and can optionally be releases (version, repository, linked
  pull requests and issues, changelog draft). Tasks join a milestone through
  `tasks.milestone_id` - still one task record. Publishing a release is always done
  by the user on GitHub; Kern only opens a prefilled draft.
- **Work sessions** are timestamp-based (elapsed = end − start − paused), so sleep,
  minimising and restarts never drift. A long silence before a heartbeat is offered
  as a gap to keep or exclude. Only explicit links are stored; inferred pull
  requests are labelled. No keystrokes, screenshots or other apps are tracked.
- **Repositories**: a project can link zero, one or many (local clone, GitHub, or
  both). The existing folder link and GitHub issue sync are adopted automatically.
  Unlinking never touches disk or GitHub. Git commands are repository-scoped and
  still need a trusted folder.
- **Worktrees** are always read from `git worktree list` (including ones Kern didn't
  create). Removal shows the real status first; a dirty worktree needs explicit
  confirmation, a locked one is never removed, and branches are only deleted with
  `git branch -d`. Kern never runs clean, reset, force-push or history rewrites.
- **Start Work** on a task begins a session; with a trusted repository it can also
  create (or reuse) a branch or worktree with a suggested, git-validated name and
  link it to the task. Completing a task never commits, pushes, merges or deletes.
- **Environment detection** reads configuration files only (package.json,
  Cargo.toml, pyproject.toml, go.mod, …) and checks PATH; nothing is executed.
  **Saved commands** are a program plus an argument list (no shell string), run only
  when clicked, in a terminal tab, in a trusted folder.
- **Terminal**: real pseudoterminals (ConPTY on Windows) rendered with xterm.js,
  loaded on first use. Processes run with the user's permissions (trust is not a
  sandbox), are stopped as a tree on close, and quitting with running commands asks
  first. Output is never persisted.
- **Environment profiles**: plain values in SQLite, secrets in the OS credential
  store (only a reference in SQLite, never logged or backed up), injected into the
  launched process only. `.env` import defaults likely credentials to secrets;
  exporting secrets needs explicit consent.
- **Local services** are only the endpoints the user adds, checked only while the
  project is open. "Running" means it answered; "healthy" only when a configured
  HTTP check passed. Docker is optional.
- **Dependencies** come from manifests and lockfiles; a declared range is never shown
  as a resolved version. OSV advisory lookups are explicit and send only package
  names and resolved versions; a clean result reads "no known advisories".
- **Health** is a state (On track / Needs attention / Blocked / No recent data) with
  clickable reasons and configurable rules - no scores. Development signals only
  count when the project has them, and come from data already fetched.
- **Catch-up** builds a deterministic local digest with numbered sources (works with
  no AI). The optional AI summary shows what's included and its size first, honours
  the global and per-project content permissions, redacts key-like strings, and
  drops any claim that doesn't cite a known source.
- **Universal search** (Ctrl+K) adds milestones, saved commands, workspaces, synced
  issues, cached pull requests and commits, and linked-folder files and code from an
  incremental index (skipping dependencies, build output, `.gitignore`d, binary and
  secret-looking files), with filters.

See `PERFORMANCE.md` for measurements.
