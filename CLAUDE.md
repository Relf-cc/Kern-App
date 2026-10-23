# Kern

A [Tauri 2](https://v2.tauri.app) desktop app: React 19 + TypeScript (strict)
front end in `src/`, Rust back end in `src-tauri/` that owns all data (SQLite)
and OS integration. Local-first; every network feature is optional.

This file is the working guide — conventions, invariants and end-to-end
recipes. The long-form documents are:

| Document | Covers |
| --- | --- |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Prerequisites, release process, updater, full architecture, Kern Cloud sync, privacy model, per-feature behaviour |
| [DESIGN_CRITERIA.md](DESIGN_CRITERIA.md) | Interface design: tokens, layout, which component or modal pattern to use, copy, accessibility, a new-screen checklist |
| [PERFORMANCE.md](PERFORMANCE.md) | Measurements and budgets |
| [README.md](README.md) | What the app does, for users |

Read DEVELOPMENT.md before changing sync, the updater, migrations or anything
security-adjacent — those have invariants that aren't obvious from the code.

## Commands

| Task | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Front-end tests | `npm test` |
| Web build | `npm run build` (typecheck + vite build) |
| Rust check | `cd src-tauri && cargo check` |
| Rust tests | `cd src-tauri && cargo test` |
| Run the app | `npm run app:dev` |
| Release build | `npm run app:build` |

Before calling a change done, run: `npm run typecheck`, `npm test`, and
`cargo check` if you touched Rust. There is no ESLint, Prettier or rustfmt
config — match the style of the file you're in. `tsc` is the de facto linter:
`strict`, `noUnusedLocals`, `noUnusedParameters` and
`noFallthroughCasesInSwitch` are all on, so an unused import fails the build.
Long single-line JSX rows (as in the settings tables) are normal here.

Set `KERN_DATA_DIR` to run a dev instance against a throwaway data folder so
your real database is never touched.

## File headers

Every source file starts with an author/date header. New files get one at
creation; the date is the date the file was created and never changes
afterwards.

`.ts`, `.tsx`, `.css`, `.mjs`:

```
/**
 * @Author Christian Relf
 * @Date YYYY-MM-DD
 */
```

`.rs`:

```
// @Author Christian Relf
// @Date YYYY-MM-DD
```

The header goes first in the file (after a shebang, if any), followed by a
blank line, then any existing module comment — in Rust it sits above the `//!`
module docs. Files that cannot carry comments (JSON, lock files) are exempt, as
are Markdown docs and generated output.

## Layout

```
src/
  app/          bootstrap, Routes.tsx, Shell.tsx, global effects.ts, mode.ts, reset.ts, brand.ts
  components/
    ui/         design-system controls — Button, Controls, Dialog, Wizard, Menu, DatePicker, Tooltip, Toaster
    layout/     Sidebar, Inspector, ErrorBoundary, PageFallback, sortable
  features/<x>/ one folder per feature area (~40 of them), each with its page,
                dialogs, pure logic modules and optional <x>.css
  hooks/        data.ts (query hooks), useToday, useFlip, useOutsideDismiss
  lib/          ipc.ts (typed command client), types.ts, query.ts, dates.ts,
                shortcuts.ts, fuzzy.ts, markdown.ts, platform.ts, announce.ts
  stores/       Zustand: router, settings, ui, undo, toast, drafts
  styles/       tokens.css (~100 variables, redefined per theme), base, components, layout
src-tauri/src/
  db/           mod.rs (open, migrate, device-table parking), migrations.rs
  domain/       one module per area (~50, plus ai/ and cloud/), each = pure
                functions + thin command wrappers
  error.rs      AppError / AppResult, the stable error codes
  state.rs      AppState, state.with(|conn| …)
  util.rs       new_id, now_ms, some, valid_date, valid_time, placeholders, safe_file_name
  scheduler.rs  one low-frequency thread: briefings, reminders, backups, housekeeping
  window.rs     window state, tray, close/minimise, full-vs-Lite mode
```

Imports use the `@/` alias for `src/` (configured in both `vite.config.ts` and
`tsconfig.json`).

## Invariants

These hold everywhere. Breaking one is a bug even if it typechecks.

- **The front end never writes SQL.** All persistence goes through a typed
  command in `src/lib/ipc.ts`. No `invoke()` calls scattered in components.
- **Rust owns secrets.** API keys and tokens live in the OS credential store,
  are used only by the back end, and never reach SQLite, logs or backups.
- **Dates are local calendar strings.** `YYYY-MM-DD` for dates, `HH:MM` for
  times, so due dates never shift with timezone or DST. Instants are UTC epoch
  milliseconds (`now_ms()`). Never store a `Date` or an ISO datetime for a due
  date.
- **Rust structs serialise camelCase.** Every type crossing the boundary uses
  `#[serde(rename_all = "camelCase")]`; `src/lib/types.ts` is the hand-written
  mirror. Change one side and you must change the other — `tsc` will not catch
  a renamed field, because `invoke` is untyped at the seam.
- **Deleting means Trash.** User-facing deletes move items to a recoverable
  Trash, purged on a schedule. Only explicit "purge" paths destroy data.
- **Heavy modules are lazy.** Whiteboard renderer, rich-text editor, settings,
  terminal, charts and the Code tab are separate chunks. Don't add a static
  import that pulls one into the initial bundle.
- **Mutations are optimistic, reversible and retryable.** See the idiom below.

## Recipes

### Add a backend command

1. **Write the logic** in `src-tauri/src/domain/<area>.rs` as a plain function
   taking `&Connection` (or `&mut Connection` when it needs a transaction) and
   returning `AppResult<T>`. Keep it free of Tauri types so it's unit-testable.
2. **Wrap it** at the bottom of the same file:

   ```rust
   #[tauri::command]
   pub fn habit_check(state: State<AppState>, id: String, day: String, delta: i64) -> AppResult<Habit> {
       state.with(|c| check(c, &id, &day, delta))
   }
   ```

   Commands that touch the network or the filesystem are `async` and run off
   the UI thread. Validate inputs and return `invalid("…")` rather than
   panicking.
3. **Register it** in the `tauri::generate_handler![…]` list in
   `src-tauri/src/lib.rs` (~line 135), under the existing `// <area>` comment
   group. *Forgetting this is the most common mistake* — it compiles fine and
   fails only at runtime.
4. **Expose it** in `src/lib/ipc.ts` under the matching `api.<area>` object:

   ```ts
   check: (id: string, day: string, delta: number) => call<T.Habit>("habit_check", { id, day, delta }),
   ```

   Argument names must match the Rust parameter names exactly (camelCase both
   sides).
5. **Add the types** to `src/lib/types.ts`, mirroring the serde output.
6. **Consume it** with a query hook (reads) or an action function (writes).

### Add a setting

`src/features/settings/schema.ts` is the single source of truth, and it needs
**two** edits: the key and its type in the `Settings` interface, and its
default in the `DEFAULTS` object below. Miss the default and the control reads
`undefined`.

Then add a row to the right section in
`src/features/settings/SettingsPage.tsx`, with a `hint` and `keywords` so
settings search finds it. The control comes from
`src/features/settings/controls.tsx` — `SToggle`, `SSelect`, `STime`,
`SNumber`, `SSegmented` or `SSlider`, each bound to a key and typed against its
value (`KeysOfType<boolean>` and friends), so a mismatched key is a type error.
If Rust reads the key too, it must use an identical default.

### Add a database migration

Migrations are append-only. In `src-tauri/src/db/migrations.rs`, add a
`const MIGRATION_N: &str = r#"…"#;` and append it to the `MIGRATIONS` slice at
the top. `SCHEMA_VERSION` is just `MIGRATIONS.len()`, and `PRAGMA user_version`
tracks what's applied; each migration runs in its own transaction, and an
existing database is copied to `backups/` first.

Never edit a shipped migration — someone has already run it. Two follow-ups
that are easy to miss:

- A new **per-computer** table (caches, device state) must be listed in
  `DEVICE_TABLES` in `src-tauri/src/db/mod.rs`, or it will be treated as
  syncable data in cloud replicas.
- A new **synced** table must be added to `TABLES` in
  `src-tauri/src/domain/cloud/sync.rs`, with its primary key and any
  personal-only columns in `local`.

### Add a page and route

1. Add the variant to the `Route` union in `src/stores/router.ts` (and to the
   path parser at the bottom if it should be deep-linkable).
2. Add a `case` in `src/app/Routes.tsx`. Use `lazy(() => import(…))` unless the
   page is tiny, and pass a `key` when the page must remount on id change.
3. If it belongs in the sidebar, add its id to `NavItemId` in the settings
   schema.

A new settings section is the same shape: add the id to `SettingsSection` in
`router.ts`, a `SECTIONS` entry (label + lucide icon) in `SettingsPage.tsx`,
and the section's groups to the record returned by `useSections`.

### Add a query domain

Add the name to the `Domain` union in `src/lib/query.ts`, then use it as the
first element of every related query key (`["habits", …]`). `invalidate("habits")`
then clears the whole domain. Task-shaped changes should call
`invalidateTasks()`, which fans out across `TASK_DOMAINS` and debounces a tray
rebuild.

### Write a release body

A release's notes are read twice: on the GitHub release page, and in the
What's new dialog after updating (`src/features/updates/`). The dialog strips
what doesn't belong there and lays the rest out itself, so the body has a
shape:

```markdown
<!-- kern:security -->
## What's new

### Flowcharts on whiteboards
- Six new **flowchart shapes** in the shape menu: terminator, decision, data.
- **Paste Mermaid…** turns a Mermaid flowchart into real Kern shapes.

### Fixes
- **Sync no longer flickers between *Syncing* and a failure.** A failed round waits out its backoff instead of being retried on every keystroke.

## Install

Windows: download `Kern_0.2.2_x64-setup.exe`. Existing installs update themselves.
```

- `## What's new` opens the body and `## Install` (or "Installation",
  "Downloads") closes it. `inAppNotes` drops both — the heading because the
  dialog has its own title, the install section because an installed copy has
  nothing to do there.
- Between them, one `###` per theme, in sentence case, named for what someone
  gained ("Flowcharts on whiteboards") rather than the area of code. Fixes come
  last under `### Fixes`; a heading mentioning security gets a marked icon.
- Inside a theme, bullets only: `- `, one per line, no nesting, no paragraphs,
  tables or code blocks. A paragraph inside a theme makes the dialog give up on
  the layout and render the notes as plain Markdown instead — correct, but
  plainer. A line of prose *before* the first `###` is kept as an intro.
- A bullet either reads as a sentence with a bold phrase inside it ("Six new
  **flowchart shapes** in the shape menu") or as a headline and its detail. It
  counts as a headline when the bold run closes its own sentence — the full stop
  goes **inside** the asterisks — or is set off with an em dash
  (`- **Day planner** — lay your day out beside your calendar.`); the dialog
  then puts the headline on its own line with the detail beneath it.
- A security release carries `<!-- kern:security -->` anywhere in the body,
  which earns the "Security update" badge. It's stripped before display.
- Present tense, second person, what changed for the person reading. No issue
  numbers, commit hashes or internal module names.

The body lives at `release/notes-<version>.md` and is published by
`node scripts/release.mjs --notes release/notes-<version>.md`, which also
copies it into the updater manifest's `notes` — what What's new shows when
GitHub can't be reached — and adds the security marker for you under
`--security`. `src/features/updates/sections.ts` parses the shape, and
`sections.test.ts` is the record of what it allows.

## Front-end conventions

**State.** Server data lives in TanStack Query — read it through a hook in
`src/hooks/data.ts` (or a local `useQuery` with a domain-prefixed key).
Transient UI state lives in a Zustand store in `src/stores/`. Don't mirror
server data into Zustand.

**The mutation idiom** (`src/features/tasks/actions.ts` is the reference):
patch the cache optimistically, call the command, invalidate, register an undo,
and roll back with a retryable toast on failure.

```ts
const rollback = optimisticPatch(ids, patch);
try {
  const res = await api.tasks.update(id, patch);
  invalidateTasks();
  pushUndo("Change", async () => { await api.tasks.update(id, inverse); invalidateTasks(); });
} catch (e) {
  rollback();
  toastError(describeError(e), () => void updateTask(id, patch));
}
```

**Errors.** Commands reject with `KernError { code, message }`. Always render
them through `describeError(e, fallback)`, which turns the stable codes
(`invalid`, `not_found`, `network`, `auth`, `busy`, `io`, …) into something a
person can act on. Never surface a raw error string.

**Components.** Reach for `src/components/ui` before writing a control:
`Button`, `IconButton`, `Kbd`, `Switch`, `Checkbox`, `TaskCheck`, `TaskTitle`,
`Segmented`, `RadioCards`, `Select`, `Slider`, `Popover`, `Progress`, `Ring`,
`EmptyState`, `Skeleton`, `Callout`, `CopyBlock`, `Dialog`, `Wizard`,
`confirm`, `confirmDelete`, `prompt`, `Dropdown`, `ContextMenu`, `DatePicker`,
`Tooltip`. Icons are `lucide-react`. Which to use when - and how a dialog or
multistep flow should behave - is in [DESIGN_CRITERIA.md](DESIGN_CRITERIA.md).

**Styling.** Plain CSS, no Tailwind, no CSS-in-JS. Use the variables in
`src/styles/tokens.css` (`--bg`, `--surface`, `--text-2`, `--border`,
`--accent`, `--danger`, `--hue-0…7`, `--fs-sm`, `--control-h-sm`, …) — never a
hard-coded colour, because light and dark both redefine the tokens. Class names
are BEM-ish (`cal__tasks`, `set-group__title`). A feature with more than a
little styling gets its own `features/<x>/<x>.css`, imported from the component
that needs it; shared page styles live in `features/pages.css`. Respect
`prefers-reduced-motion`.

**Lite mode.** The same window runs as full Kern (`src/app/Shell.tsx`) or Kern
Lite (`src/features/lite/`, its own chunk) against the same data. A change to
shared data layers should be checked in both.

## Back-end conventions

Each `domain/<area>.rs` is a module doc comment (`//!`) explaining the model,
serde structs, pure functions on a connection, then the `#[tauri::command]`
wrappers. Use the `util.rs` helpers (`new_id()`, `now_ms()`, `valid_date()`)
rather than rolling your own. Return `AppError::Invalid` / `NotFound` for
anything the UI should explain; the codes in `error.rs` are a contract with
`describeError` and shouldn't change meaning.

Background work belongs on a thread — `scheduler.rs` is the one shared
low-frequency loop (briefings, reminders, backups, housekeeping); don't add new
timers that duplicate it. Emit `kern://…` events for things the UI must react
to, and listen for them in `src/app/effects.ts`.

## Testing

Front-end tests are Vitest with `environment: "node"` and
`include: ["src/**/*.test.ts"]` — **`.ts` only, so there are no component
tests.** The convention is to put real logic in a pure module next to the
feature and test that: `features/planner/layout.test.ts`,
`features/import/parsers.test.ts`, `features/whiteboard/collab.test.ts`,
`lib/fuzzy.test.ts`. When logic worth testing is tangled into a component,
extract it rather than reaching for a DOM harness.

Rust uses `#[cfg(test)]` modules in place (44 files have them), including
migration tests that walk a database up from each version. `cargo test cloud`
covers the sync engine.
