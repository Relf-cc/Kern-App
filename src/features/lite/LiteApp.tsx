/**
 * @Author Christian Relf
 * @Date 2026-10-14
 */

// Kern Lite: a tiny task tracker over the same data as Kern. A rail that
// expands to show projects, one list of tasks with the basics (title, due
// date, priority, project), and nothing else. Everything is the same task
// record Kern uses, so changes show up in Kern (and Kern Cloud) at once.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  CalendarClock,
  CalendarX2,
  Check,
  Ellipsis,
  Flag,
  FolderInput,
  Inbox,
  ListTodo,
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Sun,
  Sunrise,
  Trash,
} from "lucide-react";
import type { Project, Task, TaskInput, TaskQuery } from "@/lib/types";
import { api, isTauri } from "@/lib/ipc";
import { queryClient } from "@/lib/query";
import { useProjects, useTasks } from "@/hooks/data";
import { useToday } from "@/hooks/useToday";
import { addDaysStr, dayStartMs, dueState, formatDue, nextWeekdayStr } from "@/lib/dates";
import { getSetting, setSetting, useSetting, useSettings } from "@/stores/settings";
import { useUndo } from "@/stores/undo";
import { useUi } from "@/stores/ui";
import { useRouter, navigate } from "@/stores/router";
import { isTextInput } from "@/lib/shortcuts";
import { Toaster } from "@/components/ui/Toaster";
import { ConfirmHost, PromptHost } from "@/components/ui/Dialog";
import { McpApprovalHost } from "@/features/ai/McpApproval";
import { Tooltip } from "@/components/ui/Tooltip";
import { Dropdown, type MenuItems } from "@/components/ui/Menu";
import { CloudHost } from "@/features/cloud/CloudHost";
import { SpaceSwitcher } from "@/features/cloud/SpaceSwitcher";
import { tintVars } from "@/features/cloud/ui";
import { ProjectGlyph, accentColor } from "@/features/projects/ProjectGlyph";
import { createTask, defaultTaskPlacement, deleteTasks, setCompleted, updateTask } from "@/features/tasks/actions";
import { buildTaskInput } from "@/features/tasks/creation";
import { PRIORITY_LABELS } from "@/features/tasks/meta";
import { useAppearance, useOsIntegration } from "@/app/effects";
import { useEpoch } from "@/app/reset";
import { hideSplash } from "@/app/splash";
import { useEasterEggs } from "@/app/easterEggs";
import { switchMode } from "@/app/mode";
import "./lite.css";

type Scope = { kind: "today" } | { kind: "inbox" } | { kind: "all" } | { kind: "project"; id: string };

const sameScope = (a: Scope, b: Scope) => a.kind === b.kind && (a.kind !== "project" || a.id === (b as { id: string }).id);

function savedScope(): Scope {
  const s = useSettings.getState().raw["internal.liteScope"] as Scope | undefined;
  return s && typeof s === "object" && "kind" in s ? s : { kind: "today" };
}

/** What a scope lists, what "done today" means there, and new-task defaults. */
function scopeSpec(scope: Scope, today: string): { open: TaskQuery; done: TaskQuery; defaults: Partial<TaskInput> } {
  const doneBase: TaskQuery = { statuses: ["completed"], completedFrom: dayStartMs(today), topLevelOnly: true, order: "completed" };
  switch (scope.kind) {
    case "today":
      return { open: { dueTo: today, topLevelOnly: true, order: "due" }, done: doneBase, defaults: { status: "todo", dueDate: today, priority: getSetting("tasks.defaultPriority") } };
    case "inbox":
      return { open: { statuses: ["inbox"], topLevelOnly: true, order: "created" }, done: { ...doneBase, noProject: true }, defaults: { status: "inbox" } };
    case "all":
      return { open: { topLevelOnly: true, order: "due" }, done: doneBase, defaults: defaultTaskPlacement() };
    case "project":
      return { open: { projectIds: [scope.id], topLevelOnly: true, order: "manual" }, done: { ...doneBase, projectIds: [scope.id] }, defaults: { projectId: scope.id, status: "todo" } };
  }
}

// ------------------------------------------------------------ app

export default function LiteApp() {
  useAppearance();
  useOsIntegration();
  useLiteEvents();
  useEasterEggs();
  const epoch = useEpoch((s) => s.epoch);
  const pinned = useSetting("lite.alwaysOnTop");

  useEffect(() => {
    hideSplash();
  }, []);
  useEffect(() => {
    if (isTauri) void api.app.pinLite(pinned).catch(() => undefined);
  }, [pinned]);

  return (
    <>
      <Lite key={epoch} />
      <CloudHost />
      <ConfirmHost />
      <PromptHost />
      <McpApprovalHost />
      <Toaster />
    </>
  );
}

/** Backend events, keyboard shortcuts and hand-offs to full Kern. */
function useLiteEvents() {
  useEffect(() => {
    const offs: Promise<() => void>[] = isTauri
      ? [
          listen("kern://data-changed", () => void queryClient.invalidateQueries()),
          listen("kern://quick-capture", () => useUi.getState().openCapture()),
        ]
      : [];
    // Anything that needs a full page (settings, streams) opens full Kern.
    const offRoute = useRouter.subscribe((s, prev) => {
      if (s.route !== prev.route && (s.route.name === "settings" || s.route.name === "streams" || s.route.name === "api")) void switchMode("kern");
    });
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !isTextInput(e.target)) {
        e.preventDefault();
        void useUndo.getState().undoLast();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      offs.forEach((p) => void p.then((f) => f()));
      offRoute();
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}

function Lite() {
  const today = useToday();
  const [scope, setScopeState] = useState<Scope>(savedScope);
  const [wide, setWide] = useState(() => window.innerWidth >= 600);
  const [open, setOpen] = useState(() => window.innerWidth >= 600);
  const { data: projects } = useProjects();
  const project = scope.kind === "project" ? projects?.find((p) => p.id === scope.id) : undefined;

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 600);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // A deleted or archived project falls back to Today.
  useEffect(() => {
    if (scope.kind === "project" && projects && !project) setScopeState({ kind: "today" });
  }, [scope, projects, project]);

  const setScope = (s: Scope) => {
    setScopeState(s);
    void api.settings.set({ "internal.liteScope": s }).catch(() => undefined);
    if (!wide) setOpen(false);
  };

  // A project's colour tints its checkboxes and progress.
  const tint = tintVars(accentColor(project?.accent));
  return (
    <div className="lite" data-open={open || undefined} data-wide={wide || undefined} style={tint ? ({ "--lite-tint": tint["--accent"], "--lite-tint-fg": tint["--accent-fg"] } as CSSProperties) : undefined}>
      <Rail scope={scope} setScope={setScope} open={open} setOpen={setOpen} projects={projects ?? []} today={today} />
      {open && !wide && <div className="lite-scrim" onClick={() => setOpen(false)} />}
      <TaskPane key={scope.kind === "project" ? scope.id : scope.kind} scope={scope} project={project} projects={projects ?? []} today={today} />
    </div>
  );
}

// ------------------------------------------------------------ rail

function Rail({ scope, setScope, open, setOpen, projects, today }: { scope: Scope; setScope: (s: Scope) => void; open: boolean; setOpen: (v: boolean) => void; projects: Project[]; today: string }) {
  const todayCount = useTasks(scopeSpec({ kind: "today" }, today).open).data?.length;
  const inboxCount = useTasks(scopeSpec({ kind: "inbox" }, today).open).data?.length;
  const sorted = useMemo(() => [...projects].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder), [projects]);

  const item = (s: Scope, label: string, icon: React.ReactNode, count?: number) => {
    const active = sameScope(s, scope);
    const btn = (
      <button type="button" className="lite-nav" data-active={active || undefined} onClick={() => setScope(s)} aria-label={label} aria-current={active || undefined}>
        <span className="lite-nav__icon">{icon}</span>
        <span className="lite-nav__label truncate">{label}</span>
        {!!count && <span className="lite-nav__count">{count}</span>}
      </button>
    );
    return open ? (
      <div key={label}>{btn}</div>
    ) : (
      <Tooltip key={label} content={count ? `${label} · ${count}` : label} side="right">
        {btn}
      </Tooltip>
    );
  };

  return (
    <aside className="lite-rail" aria-label="Lists">
      <div className="lite-rail__top">
        <Tooltip content={open ? "Collapse" : "Show projects"} side="right">
          <button type="button" className="lite-icon-btn" onClick={() => setOpen(!open)} aria-label={open ? "Collapse sidebar" : "Expand sidebar"} aria-expanded={open}>
            {open ? <PanelLeftClose size={16} strokeWidth={1.75} /> : <PanelLeftOpen size={16} strokeWidth={1.75} />}
          </button>
        </Tooltip>
        {open && <span className="lite-rail__brand">Kern Lite</span>}
      </div>
      <nav className="lite-rail__nav">
        {item({ kind: "today" }, "Today", <Sun size={16} strokeWidth={1.75} />, todayCount)}
        {item({ kind: "inbox" }, "Inbox", <Inbox size={16} strokeWidth={1.75} />, inboxCount)}
        {item({ kind: "all" }, "All tasks", <ListTodo size={16} strokeWidth={1.75} />)}
        {sorted.length > 0 && <div className="lite-rail__label">{open ? "Projects" : <span className="lite-rail__rule" />}</div>}
        <div className="lite-rail__projects">
          {sorted.map((p) => item({ kind: "project", id: p.id }, p.name, <ProjectGlyph project={p} size={16} />, Math.max(0, p.taskTotal - p.taskDone)))}
        </div>
      </nav>
      <div className="lite-rail__foot">
        <SpaceSwitcher collapsed={!open} />
        <Tooltip content="Open full Kern" side="right">
          <button type="button" className="lite-nav" onClick={() => void switchMode("kern")} aria-label="Open full Kern">
            <span className="lite-nav__icon">
              <Maximize2 size={15} strokeWidth={1.75} />
            </span>
            <span className="lite-nav__label">Open Kern</span>
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------ list

function TaskPane({ scope, project, projects, today }: { scope: Scope; project?: Project; projects: Project[]; today: string }) {
  const spec = useMemo(() => scopeSpec(scope, today), [scope, today]);
  const open = useTasks(spec.open);
  const done = useTasks(spec.done);
  const showDone = useSetting("lite.showDone");
  const celebrate = useSetting("lite.celebrate");
  const pinned = useSetting("lite.alwaysOnTop");
  const [doneOpen, setDoneOpen] = useState(false);
  const [party, setParty] = useState(0);
  const lastCompletion = useRef(0);
  const seen = useRef<Set<string> | null>(null);

  const openTasks = open.data ?? [];
  const doneTasks = (done.data ?? []).filter((t) => !openTasks.some((o) => o.id === t.id));
  const remaining = openTasks.filter((t) => t.status !== "completed").length;
  const total = remaining + doneTasks.length + openTasks.filter((t) => t.status === "completed").length;
  const finished = total - remaining;

  // Rows that weren't there on first load animate in.
  if (open.data && !seen.current) seen.current = new Set(open.data.map((t) => t.id));
  const isNew = (id: string) => !!seen.current && !seen.current.has(id);
  useEffect(() => {
    if (open.data && seen.current) open.data.forEach((t) => seen.current!.add(t.id));
  });

  // Clearing the list right after completing something earns a little party.
  const prevRemaining = useRef<number | null>(null);
  useEffect(() => {
    if (!open.data) return;
    if (celebrate && prevRemaining.current && remaining === 0 && Date.now() - lastCompletion.current < 3000) setParty((n) => n + 1);
    prevRemaining.current = remaining;
  }, [remaining, open.data, celebrate]);

  const title = scope.kind === "today" ? "Today" : scope.kind === "inbox" ? "Inbox" : scope.kind === "all" ? "All tasks" : (project?.name ?? "Project");
  const onComplete = (t: Task) => {
    if (t.status !== "completed") lastCompletion.current = Date.now();
    void setCompleted(t, t.status !== "completed");
  };

  return (
    <main className="lite-pane">
      <header className="lite-head">
        <h1 className="lite-head__title">
          {scope.kind === "project" && project ? <ProjectGlyph project={project} size={18} /> : scope.kind === "today" ? <Sun size={17} strokeWidth={1.75} /> : scope.kind === "inbox" ? <Inbox size={17} strokeWidth={1.75} /> : <ListTodo size={17} strokeWidth={1.75} />}
          <span className="truncate">{title}</span>
        </h1>
        {scope.kind === "today" && <span className="lite-head__date">{new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span>}
        <span className="grow" />
        {total > 0 && (
          <Tooltip content={`${finished} of ${total} done today`}>
            <span className="lite-progress" data-full={remaining === 0 || undefined}>
              <ProgressRing value={total ? finished / total : 0} />
              <span>
                {finished}/{total}
              </span>
            </span>
          </Tooltip>
        )}
        <Tooltip content={pinned ? "Stop keeping on top" : "Keep on top of other windows"}>
          <button type="button" className="lite-icon-btn" data-on={pinned || undefined} onClick={() => void setSetting("lite.alwaysOnTop", !pinned)} aria-pressed={pinned} aria-label="Keep on top">
            {pinned ? <Pin size={15} strokeWidth={1.75} /> : <PinOff size={15} strokeWidth={1.75} />}
          </button>
        </Tooltip>
      </header>

      <AddTask spec={spec} projects={projects} placeholder={scope.kind === "project" ? `Add to ${title}…` : scope.kind === "today" ? "Add a task for today…" : "Add a task…"} />

      <div className="lite-scroll">
        {open.isLoading && !open.data ? (
          <div className="lite-skeleton">
            {[0, 1, 2].map((i) => (
              <span key={i} style={{ animationDelay: `${i * 90}ms` }} />
            ))}
          </div>
        ) : remaining === 0 && !openTasks.length ? (
          <AllClear key={party} party={party > 0} scope={scope.kind} hadTasks={doneTasks.length > 0} />
        ) : (
          <ul className="lite-list" role="list">
            {openTasks.map((t) => (
              <TaskRow key={t.id} task={t} today={today} showProject={scope.kind !== "project"} hideToday={scope.kind === "today"} projects={projects} fresh={isNew(t.id)} onComplete={onComplete} />
            ))}
          </ul>
        )}

        {showDone && doneTasks.length > 0 && (
          <section className="lite-done">
            <button type="button" className="lite-done__toggle" onClick={() => setDoneOpen(!doneOpen)} aria-expanded={doneOpen}>
              <Check size={13} strokeWidth={2.25} />
              Done today
              <span className="lite-done__count">{doneTasks.length}</span>
            </button>
            {doneOpen && (
              <ul className="lite-list lite-list--done" role="list">
                {doneTasks.map((t) => (
                  <TaskRow key={t.id} task={t} today={today} showProject={scope.kind !== "project"} hideToday={scope.kind === "today"} projects={projects} onComplete={onComplete} />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
      {party > 0 && <Confetti key={party} />}
    </main>
  );
}

function ProgressRing({ value }: { value: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" className="lite-ring" aria-hidden>
      <circle cx={9} cy={9} r={r} className="lite-ring__track" />
      <circle cx={9} cy={9} r={r} className="lite-ring__fill" strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, Math.max(0, value)))} />
    </svg>
  );
}

// ------------------------------------------------------------ add

function AddTask({ spec, projects, placeholder }: { spec: ReturnType<typeof scopeSpec>; projects: Project[]; placeholder: string }) {
  const [text, setText] = useState("");
  const [pulse, setPulse] = useState(0);
  const ref = useRef<HTMLInputElement>(null);

  // "N" or "/" jumps here; quick capture (global shortcut, tray) too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextInput(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "n" || e.key === "/") {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const off = useUi.subscribe((s, prev) => {
      if (s.capture.open && !prev.capture.open) {
        useUi.getState().closeCapture();
        ref.current?.focus();
      }
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      off();
    };
  }, []);

  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    setText("");
    setPulse((n) => n + 1);
    const input = await buildTaskInput(value, projects, spec.defaults);
    await createTask(input, { quiet: true });
  };

  return (
    <form
      className="lite-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <span className="lite-add__plus" key={pulse} data-pulse={pulse > 0 || undefined} aria-hidden>
        +
      </span>
      <input
        ref={ref}
        className="lite-add__input"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && (setText(""), e.currentTarget.blur())}
        aria-label="New task"
        title="Type a task and press Enter. Try “tomorrow p1” or “#project”."
      />
      {text.trim() && <kbd className="lite-add__hint">Enter</kbd>}
    </form>
  );
}

// ------------------------------------------------------------ row

function TaskRow({ task, today, showProject, hideToday, projects, fresh, onComplete }: { task: Task; today: string; showProject: boolean; hideToday?: boolean; projects: Project[]; fresh?: boolean; onComplete: (t: Task) => void }) {
  const done = task.status === "completed";
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const project = showProject && task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const due = task.dueDate ? dueState(task.dueDate, done, today) : null;
  // In Today, "Today" on every row says nothing; times and overdue still show.
  const showDue = !!task.dueDate && !(hideToday && task.dueDate === today && !task.dueTime);

  const save = () => {
    setEditing(false);
    const t = title.trim();
    if (t && t !== task.title) void updateTask(task.id, { title: t }, { undoLabel: "Renamed" });
    else setTitle(task.title);
  };

  const menu = (): MenuItems => [
    { label: "Today", icon: Sun, checked: task.dueDate === today, onSelect: () => void updateTask(task.id, { dueDate: today }, { undoLabel: "Moved to today" }) },
    { label: "Tomorrow", icon: Sunrise, checked: task.dueDate === addDaysStr(today, 1), onSelect: () => void updateTask(task.id, { dueDate: addDaysStr(today, 1) }, { undoLabel: "Moved to tomorrow" }) },
    { label: "Next week", icon: CalendarClock, onSelect: () => void updateTask(task.id, { dueDate: nextWeekdayStr(today, 1) }, { undoLabel: "Moved to next week" }) },
    !!task.dueDate && { label: "No date", icon: CalendarX2, onSelect: () => void updateTask(task.id, { dueDate: null }, { undoLabel: "Date removed" }) },
    { type: "separator" },
    {
      type: "submenu",
      label: "Priority",
      icon: Flag,
      items: [4, 3, 2, 1, 0].map((p) => ({ label: PRIORITY_LABELS[p], checked: task.priority === p, onSelect: () => void updateTask(task.id, { priority: p as Task["priority"] }) })),
    },
    {
      type: "submenu",
      label: "Move to",
      icon: FolderInput,
      items: [
        { label: "No project", checked: !task.projectId, onSelect: () => void updateTask(task.id, { projectId: null, columnId: null }, { undoLabel: "Moved" }) },
        ...(projects.length ? [{ type: "separator" as const }] : []),
        ...projects.map((p) => ({ label: p.name, checked: task.projectId === p.id, onSelect: () => void updateTask(task.id, { projectId: p.id, status: task.status === "inbox" ? "todo" : task.status }, { undoLabel: `Moved to ${p.name}` }) })),
      ],
    },
    {
      label: "Open in Kern",
      icon: Maximize2,
      onSelect: () => {
        navigate({ name: "task", id: task.id });
        void switchMode("kern");
      },
    },
    { type: "separator" },
    { label: "Delete", icon: Trash, danger: true, onSelect: () => void deleteTasks([task.id]) },
  ];

  return (
    <li className="lite-task" data-done={done || undefined} data-fresh={fresh || undefined} data-priority={done ? undefined : task.priority || undefined}>
      <div className="lite-task__inner">
        <button
          type="button"
          className="lite-check"
          role="checkbox"
          aria-checked={done}
          aria-label={done ? "Mark incomplete" : "Mark complete"}
          onClick={() => onComplete(task)}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <circle className="lite-check__ring" cx="12" cy="12" r="9.5" />
            <path className="lite-check__tick" d="M7.5 12.5l3 3 6-6.5" pathLength={1} />
          </svg>
          <span className="lite-check__burst" aria-hidden>
            {Array.from({ length: 8 }, (_, i) => (
              <i key={i} style={{ "--a": `${i * 45}deg` } as CSSProperties} />
            ))}
          </span>
        </button>
        <div className="lite-task__body">
          {editing ? (
            <input
              className="lite-task__edit"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  setTitle(task.title);
                  setEditing(false);
                }
              }}
              aria-label="Task title"
            />
          ) : (
            <span
              className="lite-task__title"
              onClick={() => {
                if (done) return;
                setTitle(task.title);
                setEditing(true);
              }}
            >
              {task.title}
            </span>
          )}
          {(showDue || project || (!done && task.priority >= 3) || task.subtaskCount > 0) && !editing && (
            <span className="lite-task__meta">
              {showDue && (
                <span className="lite-chip" data-due={due ?? undefined}>
                  {formatDue(task.dueDate!, task.dueTime, today)}
                </span>
              )}
              {!done && task.priority >= 3 && (
                <span className="lite-chip" data-prio={task.priority}>
                  <Flag size={10} strokeWidth={2} /> {PRIORITY_LABELS[task.priority]}
                </span>
              )}
              {task.subtaskCount > 0 && (
                <span className="lite-chip">
                  {task.subtaskDone}/{task.subtaskCount}
                </span>
              )}
              {project && (
                <span className="lite-chip lite-chip--project">
                  <ProjectGlyph project={project} size={11} />
                  <span className="truncate">{project.name}</span>
                </span>
              )}
            </span>
          )}
        </div>
        <Dropdown items={menu} align="end">
          <button type="button" className="lite-task__more" aria-label="Task actions">
            <Ellipsis size={15} strokeWidth={1.75} />
          </button>
        </Dropdown>
      </div>
    </li>
  );
}

// ------------------------------------------------------------ empty & party

const CLEAR_LINES: Record<Scope["kind"], [string, string]> = {
  today: ["Today is clear", "Nothing else due. Enjoy it."],
  inbox: ["Inbox zero", "Everything has a home."],
  all: ["All done", "Not a single open task."],
  project: ["Nothing left here", "Add the next step above."],
};

function AllClear({ party, scope, hadTasks }: { party: boolean; scope: Scope["kind"]; hadTasks: boolean }) {
  const [title, line] = hadTasks || party ? CLEAR_LINES[scope] : ["No tasks yet", "Type above and press Enter."];
  return (
    <div className="lite-clear" data-party={party || undefined}>
      <span className="lite-clear__badge" aria-hidden>
        <Check size={22} strokeWidth={2.5} />
      </span>
      <strong>{title}</strong>
      <span>{line}</span>
    </div>
  );
}

const CONFETTI_COLORS = ["var(--lite-tint, var(--accent))", "#8aa9dc", "#a597dd", "#8bb795", "#d2ad73", "#cf929d", "#7bb5ae"];

function Confetti() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setOn(false), 1800);
    return () => window.clearTimeout(t);
  }, []);
  const bits = useMemo(
    () =>
      Array.from({ length: 36 }, (_, i) => ({
        x: (Math.random() - 0.5) * 2,
        delay: Math.random() * 160,
        rot: Math.random() * 720 - 360,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        w: 4 + Math.random() * 4,
      })),
    [],
  );
  if (!on) return null;
  return (
    <div className="lite-confetti" aria-hidden>
      {bits.map((b, i) => (
        <i key={i} style={{ "--x": b.x, "--r": `${b.rot}deg`, "--d": `${b.delay}ms`, background: b.color, width: b.w, height: b.w * 1.6 } as CSSProperties} />
      ))}
    </div>
  );
}
