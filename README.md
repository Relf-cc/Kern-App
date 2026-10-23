# Kern

A calm desktop workspace for your tasks, projects, notes and whiteboards, all in
one place and all on your own computer. There's no account to create, no
subscription, and nothing is sent anywhere unless you turn it on. When you want
to, **Kern Cloud** (free) syncs a personal space across your devices and lets you
collaborate with others in shared workspaces, in real time.

**[⬇ Download Kern for Windows or Linux](https://github.com/Relf-cc/Kern-App/releases/latest)**

## What you can do with it

- **Plan your day.** Capture tasks in seconds, sort them later from the Inbox, and
  start each morning with a daily rundown that suggests what to work on and shows
  why. Due dates, reminders, priorities, checklists and repeating tasks are all there.
- **Run projects.** A project only needs a name. Add Kanban boards, milestones with
  target dates, and an overview page with progress, deadlines and a simple "on
  track / needs attention" check.
- **Think visually.** Whiteboards for sketching ideas: cards, sticky notes, shapes,
  freehand pen, connectors and images. You can also drop live tasks and projects onto them.
- **Write things down.** Notes with formatting and checklists, linked to your projects.
- **Stay focused.** A focus timer, and work sessions that track time spent on a task
  or project, with simple reports.
- **Kern Lite.** A tiny, distraction-free task list over the same data: pick a
  list or project from the slim sidebar, add tasks, tick them off. Open it from the
  **Kern Lite** shortcut, the tray, the sidebar or **Ctrl+K**, and choose whether
  Kern starts as Kern, Kern Lite, or asks (**Settings → General**).
- **Make it yours.** Give projects and workspaces an icon or emoji and any colour,
  choose which project sections show and which one opens first (**Customize…**
  in a project's menu).
- **Find anything.** Press **Ctrl+K** to search tasks, notes, projects and
  commands from anywhere in the app.
- **Optional extras for developers.** Link git repositories to a project to see
  changes, history, branches and pull requests, run commands in a built-in terminal,
  and sync GitHub issues with your tasks. None of this appears unless you link code.
- **Optional AI.** Bring your own API key for extras like a "catch me up" summary
  of a project, which shows exactly what would be sent before anything leaves your computer.
- **Optional AI assistants.** Let Claude Desktop or Claude Code connect to Kern
  on your own subscription — no API key — and create tasks, notes, boards, whole
  projects and flowcharts in it. It's off until you turn it on, nothing connects
  until you approve it by name, Kern can ask you before anything is written, and
  anything an assistant changes can be put back in one go.

## Install

Download the file for your system from the
[latest release](https://github.com/Relf-cc/Kern-App/releases/latest).

### Windows (10 and 11, 64-bit)

1. Download **`Kern_…_x64-setup.exe`** and open it. It installs just for your user
   account, so no administrator rights are needed.
2. Windows may show **"Windows protected your PC"**, because the installer isn't
   code-signed yet. Click **More info → Run anyway**.

Prefer an MSI (for example, for managed machines)? Use `Kern_…_x64_en-US.msi` instead.

### Linux (64-bit)

Pick the package that fits your distribution:

| Distribution | File | How to install |
| --- | --- | --- |
| Ubuntu, Debian, Mint, Pop!_OS | `Kern_…_amd64.deb` | `sudo apt install ./Kern_*_amd64.deb` |
| Fedora, openSUSE | `Kern-…x86_64.rpm` | `sudo dnf install ./Kern-*.x86_64.rpm` |
| Anything else | `Kern_…_amd64.AppImage` | `chmod +x Kern_*.AppImage` then run it |

Kern runs on Ubuntu 22.04, Debian 12, Fedora 35 and newer (or anything similarly
recent). It then appears in your app launcher as **Kern**.

macOS isn't packaged yet.

## Getting started

When you first open Kern, a short welcome helps you set things up. After that,
these shortcuts cover most of what you'll do (on Linux and Windows):

| Shortcut | What it does |
| --- | --- |
| **Ctrl+K** | Search and run any command |
| **Ctrl+Shift+Space** | Quick capture: jot down a task or note |
| **Ctrl+Shift+N** | New task |
| **Ctrl+Shift+D** | Today's rundown |
| **Ctrl+1** to **Ctrl+6** | Dashboard, My Tasks, Inbox, Projects, Whiteboards, Notes |
| **Ctrl+/** | See every shortcut (you can change most of them) |

Tip: to capture a task while you're in *another* app, turn on **System-wide quick
capture** in **Settings → General**.

## Working together (optional)

Turn on **online collaboration** from the space menu at the top of the sidebar
(or **Settings → Account & Cloud**) and sign in, or create a free account.

- **Personal space**: your own projects, tasks, boards, notes and whiteboards,
  synced between every computer you sign in on. You can copy your offline data
  into it (files are never uploaded).
- **Workspaces**: shared spaces for a team. Give it a name, logo and a few
  details, optionally bring in a GitHub organisation (each repository becomes a
  project), and invite people by email. Changes appear for everyone instantly,
  and whiteboards are multiplayer, with live cursors.
- **Streams**: addresses your website or services send to
  (`streams.relf.cc/kern/<id>`), such as a "Report a bug" form or a failing
  CI job. Each submission becomes a task, an inbox item or a GitHub issue in the
  space, with origin rules, secrets or signed requests, rate limits, spam checks,
  field validation and a delivery log. Owners and admins open them from the space
  menu → **Streams…**. See the [streams documentation](https://kern.chrisrelf.xyz/docs/streams.html).
- **Offline** stays exactly as it was: no account, nothing leaves your computer.
  Switch between Offline, Personal and your workspaces from the space menu.

Only the core things sync: projects, boards, tasks, issues, milestones, notes and
whiteboards. Images on whiteboards are shared as compressed copies; the originals
stay on your computer. Files, folders, code, terminals and settings always stay on your
computer. A workspace project shows its files only on computers where you've
linked the folder.

## Your data stays yours

- **Everything is stored on your computer**, in one folder:
  - Windows: `%APPDATA%\app.kern.desktop`
  - Linux: `~/.local/share/app.kern.desktop`
- **It works fully offline.** The few features that go online (link previews,
  GitHub, AI, and the update check) are all optional. **Settings → Privacy** has a
  single switch that turns all of them off.
- **No tracking.** There's no analytics or telemetry, and an account is only
  needed if you choose Kern Cloud.
- **Backups happen automatically**, and **Settings** can export everything to
  ordinary files (JSON, Markdown and CSV) whenever you like.
- **Deleted items go to Trash first**, so you can restore them — including
  anything an AI assistant deletes.
- **An AI assistant only reaches what you allow.** The connection is off by
  default and is a local pipe only your user account can open, so there's no
  port and nothing on the network. Each assistant is read-only until you say
  otherwise, can be held to the projects you pick, never sees projects locked
  with a passkey, and is never offered your files, terminal, keys or settings.
  Every call it makes is listed in **Settings → API → Assistants**.
- **Passwords and API keys** are kept in your system's secure storage (Windows
  Credential Manager, or GNOME Keyring / KWallet on Linux), never in Kern's own files.

## Updating

When a new version is out, a blue **Update available** card appears in the sidebar.
Click it, download the new installer and install it over the old one. Your data is
kept, and Kern backs it up automatically before upgrading.

## Troubleshooting

- **Linux: the window is blank or white.** Kern already avoids the most common cause.
  If it still happens, start it from a terminal with
  `WEBKIT_DISABLE_COMPOSITING_MODE=1 kern`.
- **Linux: no tray icon on GNOME.** GNOME hides tray icons unless the
  *AppIndicator and KStatusNotifierItem Support* extension is installed. You only
  need the tray if you set Kern to keep running in the background (Settings → General).
- **Something else?** Please
  [open an issue](https://github.com/Relf-cc/Kern-App/issues) describing what
  happened. **Settings → About** shows the version you're on.

## Building from source

Kern is built with [Tauri](https://v2.tauri.app), React and Rust. See
[DEVELOPMENT.md](DEVELOPMENT.md) for build instructions, architecture and internals.
