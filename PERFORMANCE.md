# Performance report

Measured on the development machine: Windows 11 Home (26200), 12 logical cores,
32 GB RAM, WebView2 154, release build (`npx tauri build`, LTO, `opt-level = "s"`).
Scripts drive the real release binary (`src-tauri/target/release/kern.exe`) over the
WebView2 DevTools protocol. Numbers are single runs on one machine. Treat them as
indicative, not as guarantees.

## Startup

| Metric | Result | Target |
|---|---|---|
| Launch → interface rendered (first run after build) | **430 ms** | ≤ 2 s |
| Launch → interface rendered (relaunch) | **419 ms** | ≤ 2 s |

Measured from `spawn()` to the shell's first commit (`window.__kernReadyAt`, set in
`src/app/App.tsx`, converted to wall-clock time with `performance.timeOrigin`). The
"first run" was not a true cold boot: the OS file cache was warm from the build.
Startup defers non-essential work. The scheduler waits 6 s before its first tick,
whiteboards, notes, settings and the calendar are lazy chunks, and only the
dashboard's queries run at launch.

## Idle resources (dashboard open, 60 s after launch, no debugger attached)

| Process (WebView2 type) | Private memory | CPU |
|---|---|---|
| kern.exe (Rust host) | 7.3 MB | 0.00 % |
| WebView2 browser | 37.1 MB | 0.21 % |
| WebView2 renderer | 45.8 MB | 0.16 % |
| WebView2 GPU | 95.5 MB | 0.05 % |
| WebView2 utility ×2, crashpad | 22.1 MB | 0.05 % |
| **Total** | **≈ 208 MB** | **≈ 0.47 % of one core** |

The summed working set (≈ 394 MB) double-counts shared pages between WebView2
processes, so private memory is the better measure. Almost all of it is WebView2's
fixed cost; the app's own native process uses 7 MB. This is just above the ~200 MB
goal. The spec notes WebView2 makes that goal approximate.

There are no polling loops in the UI. "Today" flips via a single timeout at local
midnight, the focus timer only ticks while running, and the backend scheduler wakes
every 20 s (60 s with *Reduce background activity*).

## Data (5,000+ tasks across 9 projects, invoked from the UI over IPC)

| Operation | Median |
|---|---|
| Create task (incl. IPC round-trip) | 1.3 ms |
| Update task (patch + activity + FTS trigger) | 2.7 ms |
| Query all open top-level tasks (5,005 rows, with labels/subtask counts) | 51 ms |
| Query one project's tasks (1,000 rows) | 10.8 ms |
| Full-text search (FTS5, 28 hits) | 1.3 ms |
| Projects list with progress statistics | 4.7 ms |
| Dashboard overview counts | 1.7 ms |
| Open *My Tasks* with 5,005 tasks (click → rows painted) | 204 ms |

Large lists are virtualised (above 250 rows), so only around 50 rows are mounted.
Memory after loading the 5,000-task list was about 368 MB private.

## Bundle and installer

| Artifact | Size |
|---|---|
| `kern.exe` (release, LTO) | 15.1 MB - includes the MCP server, its HTTP endpoint and the MCP client (rmcp + axum) |
| `kern-mcp.exe` (the bridge) | 0.15 MB |
| `kern.mcpb` (the Claude Desktop extension) | 79 KB |
| NSIS installer | 6.3 MB |
| MSI installer | 8.9 MB |
| Main JS chunk (React, query, dashboard, tasks) | 886 KB (278 KB gzip) - was 816 KB (256 KB gzip), and 691 KB (211 KB gzip) before phase 2 |
| Storage chart (Chart.js), lazy | 141 KB (49 KB gzip) |
| API account pages (incl. Assistants), lazy | 45 KB (13 KB gzip) - was 19 KB (6 KB gzip) before the MCP tab |
| Project Code tab (GitHub & git), lazy | 29 KB (10 KB gzip) |
| Whiteboard chunk (React Flow + editor), lazy | 271 KB (87 KB gzip) |
| Notes chunk (TipTap/ProseMirror), lazy | 521 KB (181 KB gzip) |
| Settings chunk, lazy | 145 KB (46 KB gzip) |

## Whiteboard stress test (600 objects, 400 connectors)

Text cards, stickies and shapes in a 30×20 grid with chained connectors, on a
2560×1369 window. Pan and zoom were driven by scripted wheel events while frame
intervals were recorded with `requestAnimationFrame`.

| Metric | Before LOD | With LOD |
|---|---|---|
| Save full scene (diffed upsert) | 30 ms | 25 ms |
| Open board (click → nodes on screen) | 1.33 s | 1.26 s |
| Frame interval, median | 5.9 ms | 5.9 ms |
| Frame interval, 95th percentile | 35.2 ms | 23.6 ms |

Fitting the whole board on screen (23% zoom) shows all 600 objects at once. Below
40% zoom the canvas now drops card bodies, metadata, handles, edge labels and
shadows (level of detail), since they're unreadable at that scale. Above
150 objects, React Flow also renders only visible elements. Rich editors mount only
while a card is being edited.

## Phase 2 additions (debug build, dev machine, single runs)

| Operation | Result |
|---|---|
| Storage scan of Kern's data (848 files incl. WebView data) | 38–60 ms, background thread |
| Rescan after adding one attachment (unchanged folders served from the scan cache) | 38 ms |
| Favicon, first fetch (page + icon) | 140–610 ms, background thread |
| Favicon, cached lookup | 3 ms |
| GitHub issue import (4 issues) / no-op re-sync | 1.0 s / 0.4 s |
| Strikethrough animation | 260 ms transform (standard intensity), no layout reads per frame |

The main chunk grew by ~125 KB for the sidebar reordering, task composer, inspector
behaviour, folders, links and the dashboard storage widget. Everything heavy added in
this phase (chart library, API pages, Code tab, note-editor link icons) loads lazily.

## Not measured here

- **Board drag responsiveness.** Verified with scripted drags (cards move between
  columns and persist), but not instrumented. Cards render through a drag overlay
  that tracks the pointer directly.
- **Image-heavy whiteboards.** Not stress-tested.
- **True cold boot** (after a restart, with an empty file cache).

## Reproducing

The measurement scripts are Node + `playwright-core` (`connectOverCDP`). Set
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` when launching
`kern.exe`, connect, and read `performance.timeOrigin + window.__kernReadyAt`. Per-process
memory and CPU come from `Get-Process` over the `kern.exe` process tree.
