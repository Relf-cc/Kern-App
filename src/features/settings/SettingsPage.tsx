/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import {
  Bell,
  Database,
  FolderKanban,
  Gauge,
  Info,
  Keyboard,
  LayoutGrid,
  ListTodo,
  Palette,
  Presentation,
  Puzzle,
  Search,
  Settings,
  Sunrise,
  Timer,
  ArrowDown,
  ArrowUp,
  Plus,
  X,
  Pencil,
  Trash,
  Shield,
  KeyRound,
  Blocks,
  SquareTerminal,
  Cloud,
  Minimize2,
  CalendarDays,
  LayoutTemplate,
  Upload,
} from "lucide-react";
import { useCalendarGroups } from "@/features/calendar/CalendarSettings";
import { templateGroups } from "@/features/templates/TemplatesSettings";
import { ImportDialog } from "@/features/import/ImportDialog";
import { CloudSection } from "@/features/cloud/CloudSection";
import { IntegrationsSection } from "@/features/github/IntegrationsSection";
import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { navigate, type ApiTab, type SettingsSection } from "@/stores/router";
import { useSetting, setSetting, useSettings, getSetting } from "@/stores/settings";
import { pushUndo } from "@/stores/undo";
import { DEFAULTS } from "./schema";
import { useDashboards, useLabels, useProjects } from "@/hooks/data";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toastError } from "@/stores/toast";
import { Button, IconButton, Kbd } from "@/components/ui/Button";
import { Checkbox, Select, Skeleton, Switch } from "@/components/ui/Controls";

const ApiPage = lazy(() => import("@/features/ai/ApiPage"));
import { confirm, prompt } from "@/components/ui/Dialog";
import { SNumber, SSegmented, SSelect, SSlider, STime, SToggle, type GroupDef, type RowDef } from "./controls";
import { useDataGroups, StorageStats } from "./DataSection";
import { useStorageGroups } from "@/features/storage/StorageSection";
import { KeyboardSection } from "./KeyboardSection";
import { TrustedFolders } from "./TrustedFolders";
import { LockedProjects, PasskeyList, PasskeyRecovery } from "./Passkeys";
import { NAV } from "@/components/layout/Sidebar";
import { STATUS_LABELS } from "@/features/tasks/meta";
import type { NavItemId, Accent } from "./schema";
import type { TaskStatus } from "@/lib/types";
import { APP_NAME } from "@/app/brand";
import { comboFromEvent } from "@/lib/shortcuts";
import { ACCENTS } from "@/features/projects/ProjectGlyph";
import { switchMode } from "@/app/mode";
import { AboutSection } from "./AboutSection";
import { PluginsSection } from "@/features/plugins/PluginsSection";
import { developerGroups } from "./DeveloperSection";
import { LabelColorPicker } from "@/features/tasks/labels";

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Settings }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "cloud", label: "Account & Cloud", icon: Cloud },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "dashboard", label: "Dashboard", icon: LayoutGrid },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "calendars", label: "Calendars", icon: CalendarDays },
  { id: "templates", label: "Templates", icon: LayoutTemplate },
  { id: "projects", label: "Projects & Boards", icon: FolderKanban },
  { id: "whiteboards", label: "Whiteboards", icon: Presentation },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "rundown", label: "Daily Rundown", icon: Sunrise },
  { id: "focus", label: "Focus", icon: Timer },
  { id: "keyboard", label: "Keyboard & Mouse", icon: Keyboard },
  { id: "data", label: "Data & Storage", icon: Database },
  { id: "privacy", label: "Privacy & Security", icon: Shield },
  { id: "api", label: "API", icon: KeyRound },
  { id: "integrations", label: "Integrations", icon: Blocks },
  { id: "plugins", label: "Plugins", icon: Puzzle },
  { id: "developer", label: "Developer Tools", icon: SquareTerminal },
  { id: "performance", label: "Performance", icon: Gauge },
  { id: "about", label: "About", icon: Info },
];

// ------------------------------------------------------------ small editors

function ImportButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" icon={Upload} onClick={() => setOpen(true)}>
        Import…
      </Button>
      <ImportDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function GlobalShortcutPicker({ k = "general.globalCaptureShortcut" }: { k?: "general.globalCaptureShortcut" | "general.globalLiteShortcut" }) {
  const value = useSetting(k);
  const [recording, setRecording] = useState(false);
  return (
    <div className="row" style={{ gap: 6 }}>
      {recording ? (
        <button
          type="button"
          className="shortcut-capture"
          data-recording="true"
          autoFocus
          onBlur={() => setRecording(false)}
          onKeyDown={(e) => {
            e.preventDefault();
            if (e.key === "Escape") return setRecording(false);
            const combo = comboFromEvent(e);
            if (!combo) return;
            if (!/\+/.test(combo) || !/(Mod|Alt)/.test(combo)) {
              toastError("Use at least Ctrl or Alt with another key.");
              return;
            }
            void setSetting(k, combo);
            setRecording(false);
          }}
        >
          Press keys…
        </button>
      ) : (
        <button type="button" className="shortcut-capture" onClick={() => setRecording(true)}>
          {value ? <Kbd combo={value} /> : <span className="faint">Off</span>}
        </button>
      )}
      {value && <IconButton icon={X} label="Turn off" size="sm" onClick={() => void setSetting(k, null)} />}
    </div>
  );
}

function AccentPicker() {
  const accent = useSetting("appearance.accent");
  const options: { id: Accent; color: string }[] = [
    { id: "none", color: "var(--text-2)" },
    ...Object.entries(ACCENTS).map(([id, color]) => ({ id: id as Accent, color })),
  ];
  return (
    <div className="row" style={{ gap: 6 }}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className="swatch"
          data-active={accent === o.id || undefined}
          style={{ background: o.color, width: 20, height: 20 }}
          aria-label={o.id === "none" ? "Greyscale" : o.id}
          title={o.id === "none" ? "Greyscale" : o.id[0].toUpperCase() + o.id.slice(1)}
          onClick={() => void setSetting("appearance.accent", o.id)}
        />
      ))}
    </div>
  );
}

function NavItemsEditor() {
  const items = useSetting("appearance.navItems");
  const all = Object.keys(NAV) as NavItemId[];
  const hidden = all.filter((i) => !items.includes(i));
  const move = (i: number, d: number) => {
    const next = [...items];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    void setSetting("appearance.navItems", next);
  };
  return (
    <div className="col" style={{ gap: 2, width: "100%" }}>
      {[...items, ...hidden].map((id) => {
        const on = items.includes(id);
        const idx = items.indexOf(id);
        const Icon = NAV[id].icon;
        return (
          <div key={id} className="row" style={{ height: 30, gap: 8 }}>
            <Checkbox
              checked={on}
              label={NAV[id].label}
              onChange={(v) => {
                if (!v && items.length <= 1) return;
                void setSetting("appearance.navItems", v ? [...items, id] : items.filter((x) => x !== id));
              }}
            />
            <Icon size={14} className="faint" />
            <span className="grow" style={{ fontSize: "var(--fs-sm)", color: on ? "var(--text)" : "var(--text-3)" }}>
              {NAV[id].label}
            </span>
            {on && (
              <>
                <IconButton icon={ArrowUp} label="Move up" size="sm" disabled={idx === 0} onClick={() => move(idx, -1)} />
                <IconButton icon={ArrowDown} label="Move down" size="sm" disabled={idx === items.length - 1} onClick={() => move(idx, 1)} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TaskMetaEditor() {
  const meta = useSetting("appearance.taskMeta");
  const labels: [keyof typeof meta, string][] = [
    ["project", "Project"],
    ["due", "Due date"],
    ["priority", "Priority"],
    ["labels", "Labels"],
    ["subtasks", "Subtask progress"],
    ["estimate", "Estimate"],
    ["creator", "Who created it"],
  ];
  return (
    <div className="row" style={{ flexWrap: "wrap", gap: 14 }}>
      {labels.map(([k, l]) => (
        <label key={k} className="row" style={{ gap: 6, fontSize: "var(--fs-sm)" }}>
          <Checkbox checked={meta[k]} onChange={(v) => void setSetting("appearance.taskMeta", { ...meta, [k]: v })} label={l} />
          {l}
        </label>
      ))}
    </div>
  );
}

function ColumnsEditor() {
  const cols = useSetting("projects.defaultColumns");
  const set = (next: typeof cols) => void setSetting("projects.defaultColumns", next);
  return (
    <div className="col" style={{ gap: 4, width: "100%" }}>
      {cols.map((c, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          <input className="input" style={{ height: "var(--control-h-sm)", maxWidth: 200 }} value={c.name} onChange={(e) => set(cols.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Column name" />
          <Select
            value={c.status ?? "none"}
            onChange={(v) => set(cols.map((x, j) => (j === i ? { ...x, status: v === "none" ? null : (v as TaskStatus) } : x)))}
            options={[{ value: "none", label: "Keeps status" }, ...(["todo", "in_progress", "blocked", "completed"] as TaskStatus[]).map((s) => ({ value: s, label: `Sets ${STATUS_LABELS[s]}` }))]}
          />
          <IconButton icon={ArrowUp} label="Move up" size="sm" disabled={i === 0} onClick={() => { const n = [...cols]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; set(n); }} />
          <IconButton icon={X} label="Remove column" size="sm" disabled={cols.length <= 1} onClick={() => set(cols.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={Plus} style={{ alignSelf: "flex-start" }} onClick={() => set([...cols, { name: "New column", status: null }])}>
        Add column
      </Button>
    </div>
  );
}

function LabelsEditor() {
  const { data: labels } = useLabels();
  if (!labels?.length) return <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Labels you create on tasks appear here.</span>;
  return (
    <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
      {labels.map((l) => (
        <span key={l.id} className="chip chip--outline" style={{ height: 26, gap: 2, paddingLeft: 2, paddingRight: 2 }}>
          <LabelColorPicker label={l} />
          <button type="button" onClick={() => navigate({ name: "label", id: l.id })}>{l.name}</button>
          <span className="faint">{l.taskCount}</span>
          <IconButton
            icon={Pencil}
            label="Rename"
            size="sm"
            onClick={async () => {
              const n = await prompt({ title: "Rename label", initial: l.name });
              if (n) await api.labels.update(l.id, n).then(() => invalidate("labels")).catch((e) => toastError(describeError(e)));
            }}
          />
          <IconButton
            icon={Trash}
            label="Delete"
            size="sm"
            onClick={async () => {
              if (await confirm({ title: `Delete “${l.name}”?`, message: "It's removed from all tasks.", confirmLabel: "Delete", danger: true })) {
                await api.labels.delete(l.id);
                invalidate("labels", "tasks", "task");
              }
            }}
          />
        </span>
      ))}
    </div>
  );
}

function ProjectFilterEditor() {
  const ids = useSetting("rundown.projectIds");
  const { data: projects } = useProjects();
  return (
    <div className="col" style={{ gap: 4, width: "100%" }}>
      <label className="row" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
        <Checkbox checked={!ids} onChange={(v) => void setSetting("rundown.projectIds", v ? null : (projects ?? []).map((p) => p.id))} label="All projects" />
        All projects (and tasks without one)
      </label>
      {ids &&
        (projects ?? []).map((p) => (
          <label key={p.id} className="row" style={{ gap: 8, fontSize: "var(--fs-sm)", marginLeft: 22 }}>
            <Checkbox checked={ids.includes(p.id)} onChange={(v) => void setSetting("rundown.projectIds", v ? [...ids, p.id] : ids.filter((x) => x !== p.id))} label={p.name} />
            {p.name}
          </label>
        ))}
    </div>
  );
}

function DashboardLayouts() {
  const { data: dashboards } = useDashboards();
  return (
    <div className="col" style={{ gap: 2, width: "100%" }}>
      {dashboards?.map((d) => (
        <div key={d.id} className="row" style={{ height: 32 }}>
          <span className="grow" style={{ fontSize: "var(--fs-sm)" }}>
            {d.name} {d.isDefault && <span className="chip">Home</span>}
          </span>
          {!d.isDefault && (
            <Button size="sm" variant="ghost" onClick={() => void api.dashboards.update(d.id, { isDefault: true }).then(() => invalidate("dashboards"))}>
              Use as home
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => navigate({ name: "dashboard", id: d.id })}>
            Open
          </Button>
        </div>
      ))}
    </div>
  );
}

async function testNotification() {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) {
      toastError("Notifications are blocked for this app in your system settings.");
      return;
    }
    sendNotification({ title: APP_NAME, body: "Notifications are working." });
  } catch (e) {
    toastError(describeError(e, "Couldn't show a notification."));
  }
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const startup = typeof performance !== "undefined" ? Math.round(performance.now()) : 0;

function GroupingToggle() {
  const grouping = useSetting("projects.grouping");
  return <Switch checked={grouping === "groups"} onChange={(v) => void setSetting("projects.grouping", v ? "groups" : "none")} label="Allow project grouping" />;
}

async function restoreNavOrder() {
  const prev = { items: getSetting("appearance.navItems"), sections: getSetting("sidebar.sectionOrder") };
  await useSettings.getState().setMany({ "appearance.navItems": DEFAULTS["appearance.navItems"], "sidebar.sectionOrder": DEFAULTS["sidebar.sectionOrder"] });
  pushUndo("Sidebar order restored", () => useSettings.getState().setMany({ "appearance.navItems": prev.items, "sidebar.sectionOrder": prev.sections }));
}

async function resetProjectOrder() {
  if (!(await confirm({ title: "Reset project ordering?", message: "Projects and groups return to creation order. Group membership is kept, and you can undo this.", confirmLabel: "Reset order" }))) return;
  try {
    const [projects, groups] = await Promise.all([api.projects.list(true), api.groups.list()]);
    const placements = [...projects].sort((a, b) => a.sortOrder - b.sortOrder).map((p) => ({ id: p.id, groupId: p.groupId }));
    const groupOrder = groups.map((g) => g.id);
    await api.projects.resetOrder();
    invalidate("projects", "groups");
    pushUndo("Project order reset", async () => {
      await api.projects.arrange(placements);
      await api.groups.reorder(groupOrder);
      invalidate("projects", "groups");
    });
  } catch (e) {
    toastError(describeError(e));
  }
}

// ------------------------------------------------------------ sections

function useSections(apiTab?: ApiTab): Record<SettingsSection, GroupDef[] | ReactNode> {
  const data = [
    { title: "Import", rows: [{ label: "Import from another app", hint: "Projects and tasks from Todoist, Trello, Linear, Notion or any CSV.", keywords: "todoist trello linear notion csv migrate switch", control: <ImportButton /> }] },
    ...useStorageGroups(),
    ...useDataGroups(),
  ];
  const calendars = useCalendarGroups();
  const { data: dashboards } = useDashboards();
  const notificationsOn = useSetting("notifications.enabled");
  const quiet = useSetting("notifications.quietHours");
  const timeOpts = [
    { value: "relative", label: "Relative (Today, Fri, 12 Oct)" },
    { value: "dmy", label: "12 Oct 2026" },
    { value: "mdy", label: "Oct 12, 2026" },
    { value: "iso", label: "2026-10-12" },
  ];
  return {
    general: [
      {
        title: "Startup",
        rows: [
          {
            label: "When Kern starts",
            hint: "Kern Lite is a tiny task tracker over the same data. Switch any time from the sidebar, the tray or Ctrl+K.",
            keywords: "kern lite mini mode ask choose start",
            control: <SSegmented k="general.startMode" options={[{ value: "ask", label: "Ask" }, { value: "kern", label: "Kern" }, { value: "lite", label: "Kern Lite" }]} />,
          },
          { label: "Launch at login", hint: `Start ${APP_NAME} when you sign in.`, keywords: "autostart boot", control: <SToggle k="general.launchAtLogin" /> },
          { label: "Start minimised at login", hint: "When launched at login, stay in the tray (or taskbar) until opened.", control: <SToggle k="general.launchMinimized" clears={["general.startMaximized"]} /> },
          { label: "Start maximised", control: <SToggle k="general.startMaximized" clears={["general.launchMinimized"]} /> },
          { label: "Remember window size and position", control: <SToggle k="general.rememberWindow" /> },
          {
            label: "On launch, open",
            keywords: "landing home remember last workspace",
            control: (
              <SSelect
                k="general.landing"
                options={[
                  { value: "dashboard", label: "Dashboard" },
                  { value: "last", label: "Where I left off" },
                  { value: "tasks", label: "My Tasks" },
                  { value: "inbox", label: "Inbox" },
                ]}
              />
            ),
          },
        ],
      },
      {
        title: "Kern Lite",
        rows: [
          { label: "Open Kern Lite", hint: "Switch this window to Kern Lite now.", keywords: "mini compact", control: <Button size="sm" icon={Minimize2} onClick={() => void switchMode("lite")}>Switch</Button> },
          { label: "Keep on top", hint: "Keep the Kern Lite window above other windows.", keywords: "always on top pin float", control: <SToggle k="lite.alwaysOnTop" /> },
          { label: "Show tasks done today", control: <SToggle k="lite.showDone" /> },
          { label: "Celebrate a cleared list", hint: "A little confetti when you finish the last task in a list.", keywords: "confetti animation", control: <SToggle k="lite.celebrate" /> },
          { label: "System-wide shortcut", hint: "Opens Kern Lite from any app.", keywords: "global hotkey lite", control: <GlobalShortcutPicker k="general.globalLiteShortcut" /> },
          { label: "Today's tasks in the tray menu", hint: "Tick off what's due today from the tray icon without opening Kern.", keywords: "tray menu complete quick", control: <SToggle k="general.trayTasks" /> },
        ],
      },
      {
        title: "Window",
        rows: [
          { label: "When closing the window", keywords: "close behaviour tray", control: <SSegmented k="general.closeBehavior" options={[{ value: "quit", label: "Quit" }, { value: "tray", label: "Keep running in tray" }]} /> },
          { label: "Minimise to tray", hint: "Hide the window from the taskbar when minimised.", control: <SToggle k="general.minimizeToTray" /> },
          { label: "Show tray icon", control: <SToggle k="general.showTray" /> },
        ],
      },
      {
        title: "Behaviour",
        rows: [
          {
            label: "Open task details in",
            keywords: "inspector modal page detail",
            control: <SSegmented k="general.detailMode" options={[{ value: "inspector", label: "Side panel" }, { value: "modal", label: "Dialog" }, { value: "page", label: "Full page" }]} />,
          },
          { label: "Confirm before deleting", hint: "Asks before moving tasks, notes, projects, whiteboards, files and other items to the trash.", keywords: "are you sure delete modal", control: <SToggle k="general.confirmDelete" /> },
          { label: "Confirm permanent deletes", hint: "Asks before deleting something from the trash for good.", control: <SToggle k="general.confirmPermanentDelete" /> },
          { label: "System-wide quick capture", hint: "Opens quick capture from any app. Off by default.", keywords: "global hotkey shortcut", control: <GlobalShortcutPicker /> },
        ],
      },
      {
        title: "Interactions",
        rows: [
          {
            label: "Close panels on outside click",
            hint: "Automatically close side panels when clicking the main workspace.",
            keywords: "inspector dismiss details panel",
            control: <SToggle k="interaction.closePanelsOnOutsideClick" />,
          },
          { label: "Allow pinning the details panel", hint: "A pinned panel stays open while you work elsewhere.", keywords: "inspector pin", control: <SToggle k="interaction.inspectorPinning" /> },
          { label: "Animate task completion", hint: "A line draws through the title when you tick a task off. Off, or reduced motion, updates instantly.", keywords: "strikethrough checkbox", control: <SToggle k="interaction.completionAnimation" /> },
          {
            label: "Completion animation intensity",
            keywords: "strikethrough speed",
            control: <SSegmented k="interaction.completionIntensity" options={[{ value: "subtle", label: "Subtle" }, { value: "standard", label: "Standard" }, { value: "pronounced", label: "Pronounced" }]} />,
          },
          {
            label: "New task opens",
            hint: "Quick capture is always available from its own shortcut.",
            keywords: "default task creation interface composer",
            control: <SSegmented k="interaction.createInterface" options={[{ value: "composer", label: "Full composer" }, { value: "quick", label: "Quick capture" }]} />,
          },
          { label: "Remember last-used task properties", hint: "New tasks start with the priority and labels you used last.", keywords: "defaults", control: <SToggle k="interaction.rememberTaskProps" /> },
        ],
      },
      {
        title: "Writing",
        rows: [
          {
            label: "Check spelling",
            hint: "Underlines misspelled words in notes, with corrections on right-click. It uses your computer's own dictionaries, so nothing is sent anywhere.",
            keywords: "spell checker spelling autocorrect proofread dictionary suggestions typo",
            control: <SToggle k="editor.spellcheck" />,
          },
          {
            label: "Note width",
            hint: "Readable keeps text in a measured column; wide lets it fill the pane, for tables and wide code.",
            keywords: "notes editor expanded full width measure line length column",
            control: <SSegmented k="editor.noteWidth" options={[{ value: "readable", label: "Readable" }, { value: "wide", label: "Wide" }]} />,
          },
        ],
      },
    ],
    appearance: [
      {
        title: "Theme",
        rows: [
          { label: "Theme", keywords: "dark light mode", control: <SSegmented k="appearance.theme" options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }]} /> },
          { label: "Accent colour", hint: "Greyscale by default. Accents never carry meaning on their own.", keywords: "color", control: <AccentPicker /> },
          { label: "Font", control: <SSegmented k="appearance.font" options={[{ value: "inter", label: "Inter" }, { value: "geist", label: "Geist" }, { value: "system", label: "System" }]} /> },
          { label: "Text size", keywords: "font scale zoom", control: <SSlider k="appearance.fontScale" min={0.85} max={1.25} step={0.05} format={pct} /> },
          { label: "Density", keywords: "compact comfortable relaxed spacing", control: <SSegmented k="appearance.density" options={[{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }, { value: "relaxed", label: "Relaxed" }]} /> },
          { label: "Corners", keywords: "radius rounded", control: <SSegmented k="appearance.radius" options={[{ value: "sharp", label: "Sharp" }, { value: "default", label: "Default" }, { value: "round", label: "Round" }]} /> },
          { label: "Animation", hint: "System follows your OS reduced-motion preference.", keywords: "motion reduced", control: <SSegmented k="appearance.motion" options={[{ value: "system", label: "System" }, { value: "full", label: "Full" }, { value: "reduced", label: "Reduced" }, { value: "off", label: "Off" }]} /> },
          { label: "Scrollbars", control: <SSegmented k="appearance.scrollbars" options={[{ value: "thin", label: "Thin" }, { value: "hover", label: "On hover" }, { value: "wide", label: "Wide" }]} /> },
        ],
      },
      {
        title: "Sidebar",
        rows: [
          { label: "Width", control: <SSlider k="appearance.sidebarWidth" min={184} max={380} step={4} format={(v) => `${v}px`} /> },
          { label: "Collapsed to icons", hint: "Labels appear as tooltips when collapsed.", keywords: "rail labels", control: <SToggle k="appearance.sidebarCollapsed" /> },
          { label: "Destinations", hint: "Choose and order the items in the sidebar.", keywords: "navigation visible", block: <NavItemsEditor /> },
          { label: "Enable sidebar reordering", hint: "Drag destinations, views, projects and groups. Alt+↑/↓ moves the focused item.", keywords: "drag drop order", control: <SToggle k="sidebar.reorder" /> },
          { label: "Show drag handles on hover", keywords: "grip", control: <SToggle k="sidebar.dragHandles" /> },
          {
            label: "Flexible layout",
            hint: "Also rearrange the Views, Pinned and Projects sections by dragging their headers.",
            keywords: "advanced personalisation sections",
            control: <SSegmented k="sidebar.layout" options={[{ value: "standard", label: "Standard" }, { value: "flexible", label: "Flexible" }]} />,
          },
          { label: "Allow project grouping", keywords: "groups folders", control: <GroupingToggle /> },
          { label: "Remember collapsed groups", hint: "Otherwise groups and sections open expanded each time.", control: <SToggle k="sidebar.rememberGroups" /> },
          { label: "Restore default navigation order", keywords: "reset sidebar", control: <Button size="sm" onClick={() => void restoreNavOrder()}>Restore</Button> },
          { label: "Reset project ordering", hint: "Projects and groups return to the order they were created in.", keywords: "sort", control: <Button size="sm" onClick={() => void resetProjectOrder()}>Reset…</Button> },
        ],
      },
      {
        title: "Tasks",
        rows: [
          { label: "Task rows", hint: "Expanded shows the first line of notes.", keywords: "card density", control: <SSegmented k="appearance.taskRowStyle" options={[{ value: "compact", label: "Compact" }, { value: "expanded", label: "Expanded" }]} /> },
          { label: "Show on tasks", keywords: "metadata", block: <TaskMetaEditor /> },
          { label: "Details panel width", control: <SSlider k="appearance.inspectorWidth" min={300} max={680} step={10} format={(v) => `${v}px`} /> },
        ],
      },
    ],
    dashboard: [
      {
        rows: [
          {
            label: "Home layout",
            keywords: "default dashboard",
            control: dashboards?.length ? (
              <Select
                value={dashboards.find((d) => d.isDefault)?.id ?? dashboards[0].id}
                onChange={(id) => void api.dashboards.update(id, { isDefault: true }).then(() => invalidate("dashboards"))}
                options={dashboards.map((d) => ({ value: d.id, label: d.name }))}
              />
            ) : null,
          },
          { label: "Layouts", hint: "Create, rename and reset layouts from the dashboard's menu.", block: <DashboardLayouts /> },
          { label: "Show dashboard toolbar", control: <SToggle k="dashboard.showHeader" /> },
          { label: "Refresh widgets when the window regains focus", keywords: "refresh behaviour", control: <SToggle k="dashboard.refreshOnFocus" /> },
          {
            label: "Open on launch",
            control: (
              <SSelect
                k="general.landing"
                options={[
                  { value: "dashboard", label: "Dashboard" },
                  { value: "last", label: "Where I left off" },
                  { value: "tasks", label: "My Tasks" },
                  { value: "inbox", label: "Inbox" },
                ]}
              />
            ),
          },
        ],
      },
    ],
    tasks: [
      {
        title: "New tasks",
        rows: [
          { label: "Default priority", control: <SSelect k="tasks.defaultPriority" options={["None", "Low", "Medium", "High", "Urgent"].map((l, i) => ({ value: String(i), label: l }))} /> },
          {
            label: "Tasks without a project go to",
            keywords: "destination default",
            control: <SSegmented k="tasks.defaultDestination" options={[{ value: "inbox", label: "Inbox" }, { value: "today", label: "Today" }, { value: "noDate", label: "My Tasks" }]} />,
          },
          { label: "Repeat from completion by default", hint: "Next occurrence counts from the day you finish, not the due date.", keywords: "recurring", control: <SToggle k="tasks.recurrenceFromCompletion" /> },
          { label: "Reminder before due time", keywords: "due date reminder", control: <SNumber k="notifications.dueLeadMinutes" min={0} max={1440} suffix="minutes" /> },
          { label: "Subtask nesting depth", control: <SNumber k="tasks.maxSubtaskDepth" min={1} max={5} suffix="levels" /> },
        ],
      },
      {
        title: "Lists",
        rows: [
          { label: "Default view", control: <SSelect k="tasks.defaultView" options={[{ value: "list", label: "List" }, { value: "today", label: "Today" }, { value: "upcoming", label: "Upcoming" }, { value: "plan", label: "Day planner" }, { value: "calendar", label: "Calendar" }, { value: "board", label: "Board" }]} /> },
          { label: "Default sort", control: <SSelect k="tasks.defaultSort" options={[{ value: "manual", label: "Manual" }, { value: "due", label: "Due date" }, { value: "priority", label: "Priority" }, { value: "created", label: "Newest first" }, { value: "title", label: "Title" }]} /> },
          { label: "Show completed tasks", control: <SToggle k="tasks.showCompleted" /> },
          { label: "Archive completed tasks after", hint: "0 keeps them until you archive manually.", control: <SNumber k="tasks.autoArchiveDays" min={0} max={365} suffix="days" /> },
        ],
      },
      {
        title: "Dates",
        rows: [
          { label: "Week starts on", control: <SSegmented k="tasks.weekStart" options={[{ value: "1", label: "Monday" }, { value: "0", label: "Sunday" }]} /> },
          { label: "Date format", control: <SSelect k="tasks.dateFormat" options={timeOpts} width={220} /> },
          { label: "Time format", control: <SSegmented k="tasks.timeFormat" options={[{ value: "24h", label: "24-hour" }, { value: "12h", label: "12-hour" }]} /> },
        ],
      },
      { title: "Labels", rows: [{ label: "Labels", keywords: "tags", block: <LabelsEditor /> }] },
    ],
    projects: [
      {
        title: "Projects",
        rows: [
          { label: "Open projects on", control: <SSelect k="projects.defaultTab" options={[{ value: "overview", label: "Overview" }, { value: "tasks", label: "Tasks" }, { value: "board", label: "Board" }, { value: "whiteboard", label: "Whiteboard" }, { value: "notes", label: "Notes" }, { value: "milestones", label: "Milestones" }]} /> },
          {
            label: "When reopening a project",
            hint: "Resuming restores the tab, board, whiteboard, open task and file you had. It never runs commands.",
            keywords: "resume workspace remember last tab",
            control: (
              <SSelect
                k="projects.resume"
                width={220}
                options={[
                  { value: "resume", label: "Resume where I left off" },
                  { value: "lastTab", label: "Open the last tab" },
                  { value: "overview", label: "Always open the overview" },
                  { value: "ask", label: "Ask each time" },
                ]}
              />
            ),
          },
          { label: "Show progress in sidebar", control: <SToggle k="projects.showProgress" /> },
          { label: "Archived projects", control: <SSegmented k="projects.archivedDisplay" options={[{ value: "section", label: "Show in a section" }, { value: "hide", label: "Hide" }]} /> },
          { label: "Group projects", control: <SSegmented k="projects.grouping" options={[{ value: "groups", label: "By group" }, { value: "none", label: "No grouping" }]} /> },
          { label: "Sidebar order", control: <SSegmented k="projects.sidebarOrder" options={[{ value: "manual", label: "Custom" }, { value: "recent", label: "Recent" }, { value: "name", label: "Name" }]} /> },
          { label: "Count archived tasks in progress", control: <SToggle k="projects.progressIncludeArchived" /> },
        ],
      },
      {
        title: "Linked folders",
        rows: [
          {
            label: "Folder field in New Project",
            hint: "Linking a folder is always optional.",
            keywords: "default folder linking behaviour",
            control: <SSegmented k="projects.folderField" options={[{ value: "visible", label: "Always shown" }, { value: "more", label: "Under More options" }]} />,
          },
          { label: "Open the folder after creating a project", control: <SToggle k="projects.openFolderAfterCreate" /> },
          { label: "Show linked folder in project overview", control: <SToggle k="projects.showFolderInOverview" /> },
          { label: "Show the Files tab", keywords: "project files tab", control: <SToggle k="projects.showFilesTab" /> },
        ],
      },
      {
        title: "Boards",
        rows: [
          { label: "Default columns for new boards", keywords: "kanban", block: <ColumnsEditor /> },
          { label: "Default card density", control: <SSegmented k="boards.defaultCardDensity" options={[{ value: "compact", label: "Compact" }, { value: "expanded", label: "Expanded" }]} /> },
          { label: "Default column width", control: <SSlider k="boards.columnWidth" min={220} max={420} step={4} format={(v) => `${v}px`} /> },
          { label: "Celebrate finished cards", hint: "A small burst of confetti when you tick a card off or drag one into a done column.", keywords: "confetti celebration animation done complete", control: <SToggle k="boards.celebrate" /> },
        ],
      },
    ],
    whiteboards: [
      {
        title: "Canvas",
        rows: [
          { label: "Interaction", hint: "Mouse: wheel zooms, drag empty space to pan. Trackpad: two-finger scroll pans, pinch zooms.", keywords: "trackpad mouse pan", control: <SSegmented k="wb.interactionMode" options={[{ value: "mouse", label: "Mouse" }, { value: "trackpad", label: "Trackpad" }]} /> },
          { label: "Show grid", control: <SToggle k="wb.showGrid" /> },
          { label: "Snap to grid", control: <SToggle k="wb.snapToGrid" /> },
          { label: "Grid size", control: <SNumber k="wb.gridSize" min={5} max={80} suffix="px" /> },
          { label: "Alignment guides", hint: "Lines appear when edges or centres line up while dragging.", control: <SToggle k="wb.alignGuides" /> },
          { label: "Fit content when opening", hint: "Otherwise the last view is restored.", control: <SToggle k="wb.autoFit" /> },
          { label: "Default zoom", control: <SSlider k="wb.defaultZoom" min={0.5} max={1.5} step={0.05} format={pct} /> },
          { label: "Pan speed", control: <SSlider k="wb.panSensitivity" min={0.4} max={2} step={0.1} format={(v) => `${v.toFixed(1)}×`} /> },
          { label: "Zoom speed", control: <SSlider k="wb.zoomSensitivity" min={0.4} max={2} step={0.1} format={(v) => `${v.toFixed(1)}×`} /> },
        ],
      },
      {
        title: "Objects",
        rows: [
          { label: "Connector style", control: <SSegmented k="wb.connectorStyle" options={[{ value: "smooth", label: "Curved" }, { value: "straight", label: "Straight" }, { value: "step", label: "Elbow" }]} /> },
          { label: "Arrowheads on new connectors", control: <SToggle k="wb.connectorArrow" /> },
          { label: "Sticky note size", control: <SSegmented k="wb.stickySize" options={[{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }]} /> },
          { label: "Sticky note tone", control: <SSegmented k="wb.stickyTone" options={[{ value: "plain", label: "Plain" }, { value: "warm", label: "Warm" }, { value: "cool", label: "Cool" }]} /> },
        ],
      },
    ],
    notifications: [
      {
        rows: [
          { label: "Notifications", hint: "Native system notifications. Each reminder fires once.", control: <SToggle k="notifications.enabled" /> },
          { label: "Due-time reminders", control: <SToggle k="notifications.dueReminders" /> },
          { label: "Remind me", control: <SNumber k="notifications.dueLeadMinutes" min={0} max={1440} suffix="minutes before" width={70} /> },
          { label: "Daily overdue summary", control: <SToggle k="notifications.overdue" /> },
          { label: "Overdue summary time", control: <STime k="notifications.overdueTime" /> },
          { label: "Focus timer finished", control: <SToggle k="notifications.focus" /> },
          { label: "Morning rundown", control: <SToggle k="rundown.notify" /> },
          { label: "Evening review", control: <SToggle k="rundown.eveningNotify" /> },
          { label: "Weekly review", control: <SToggle k="review.notify" /> },
          { label: "Someone mentions me", hint: "When a workspace member @mentions you in a task comment.", keywords: "comments mention", control: <SToggle k="notifications.mentions" /> },
          {
            label: "Quiet hours",
            hint: "No notifications during this period.",
            keywords: "do not disturb",
            control: (
              <div className="row" style={{ gap: 6 }}>
                <input className="input" type="time" value={quiet.start} disabled={!quiet.enabled} style={{ width: 104 }} onChange={(e) => void setSetting("notifications.quietHours", { ...quiet, start: e.target.value })} aria-label="Quiet hours start" />
                <span className="faint">–</span>
                <input className="input" type="time" value={quiet.end} disabled={!quiet.enabled} style={{ width: 104 }} onChange={(e) => void setSetting("notifications.quietHours", { ...quiet, end: e.target.value })} aria-label="Quiet hours end" />
                <Switch checked={quiet.enabled} onChange={(v) => void setSetting("notifications.quietHours", { ...quiet, enabled: v })} label="Quiet hours" />
              </div>
            ),
          },
          { label: "Test", control: <Button size="sm" disabled={!notificationsOn} onClick={() => void testNotification()}>Send test notification</Button> },
        ],
      },
    ],
    rundown: [
      {
        title: "Weekly review",
        rows: [
          { label: "Weekly review reminder", hint: "A nudge once a week to look back and plan the next one.", keywords: "weekly review reflect plan", control: <SToggle k="review.enabled" /> },
          { label: "Day", control: <SSelect k="review.day" options={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => ({ value: String(i), label: d }))} /> },
          { label: "Time", control: <STime k="review.time" /> },
          { label: "Open the weekly review", control: <Button size="sm" onClick={() => navigate({ name: "review" })}>Open</Button> },
        ],
      },
      {
        title: "Morning briefing",
        rows: [
          { label: "Daily rundown", control: <SToggle k="rundown.enabled" /> },
          { label: "Briefing time", hint: "If the app is closed at this time, the briefing appears on next launch.", control: <STime k="rundown.time" /> },
          { label: "Open automatically", hint: "Otherwise a quiet prompt appears.", control: <SToggle k="rundown.autoOpen" /> },
          { label: "Show a notification", control: <SToggle k="rundown.notify" /> },
        ],
      },
      {
        title: "Contents",
        rows: [
          { label: "Overdue tasks", control: <SToggle k="rundown.includeOverdue" /> },
          { label: "Upcoming deadlines", control: <SToggle k="rundown.includeUpcoming" /> },
          { label: "Look ahead", control: <SNumber k="rundown.upcomingDays" min={1} max={60} suffix="days" /> },
          { label: "Recent completions", control: <SToggle k="rundown.includeCompleted" /> },
          { label: "Projects needing attention", control: <SToggle k="rundown.includeProjects" /> },
          { label: "Tasks shown per section", control: <SNumber k="rundown.maxTasks" min={3} max={30} /> },
          { label: "Projects included", block: <ProjectFilterEditor /> },
        ],
      },
      {
        title: "Evening review",
        rows: [
          { label: "Evening review", hint: "Review what got done and move the rest to tomorrow.", control: <SToggle k="rundown.eveningEnabled" /> },
          { label: "Review time", control: <STime k="rundown.eveningTime" /> },
          { label: "History", control: <Button size="sm" onClick={() => navigate({ name: "rundown" })}>Open rundown & history</Button> },
        ],
      },
    ],
    focus: [
      {
        rows: [
          { label: "Focus length", keywords: "pomodoro", control: <SNumber k="focus.focusMinutes" min={1} max={240} suffix="min" /> },
          { label: "Short break", control: <SNumber k="focus.shortBreakMinutes" min={1} max={60} suffix="min" /> },
          { label: "Long break", control: <SNumber k="focus.longBreakMinutes" min={1} max={120} suffix="min" /> },
          { label: "Long break every", control: <SNumber k="focus.longBreakEvery" min={2} max={12} suffix="sessions" /> },
          { label: "Start breaks automatically", control: <SToggle k="focus.autoStartBreaks" /> },
          { label: "Start next focus automatically", control: <SToggle k="focus.autoStartFocus" /> },
          { label: "Keep focus history", hint: "Records sessions and adds time to tasks.", control: <SToggle k="focus.trackHistory" /> },
        ],
      },
    ],
    keyboard: <KeyboardSection />,
    data,
    privacy: [
      {
        title: "Network",
        rows: [
          {
            label: "Allow external network requests",
            hint: `When off, ${APP_NAME} makes no network requests at all: no favicons, no link titles and no AI requests.`,
            keywords: "offline internet",
            control: <SToggle k="privacy.network" />,
          },
          { label: "Fetch website favicons", hint: "Contacts a linked site once to cache its icon locally. No third-party icon services are used.", keywords: "icons links", control: <SToggle k="privacy.favicons" /> },
          { label: "Fetch link titles", hint: "Reads a linked page's title and description when you add a link.", keywords: "metadata previews", control: <SToggle k="data.linkPreviews" /> },
          { label: "Telemetry", hint: "None. Nothing is collected or transmitted.", control: <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Off</span> },
        ],
      },
      {
        title: "AI",
        rows: [
          { label: "AI access to project content", hint: "Allow AI requests to include project names, tasks and notes. Off by default.", keywords: "privacy send", control: <SToggle k="privacy.aiProjectContent" /> },
          {
            label: "AI access to linked folders",
            hint: "Allow AI requests to read files in linked project folders. Each project must also be trusted and allow it individually.",
            keywords: "files filesystem",
            control: <SToggle k="privacy.aiLinkedFolders" />,
          },
          { label: "Keep AI request history for", hint: "Request metadata only (time, model, tokens); never prompts or responses.", keywords: "usage retention", control: <SNumber k="ai.usageRetentionDays" min={1} max={3650} suffix="days" /> },
          {
            label: "Files that hold secrets",
            hint: "Files like .env, *.pem, *.key, id_rsa and anything named “credentials” or “secret” are never read by AI features, even in a trusted folder.",
            keywords: "env pem key credentials redact exclude",
            control: <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Never sent</span>,
          },
        ],
      },
      {
        title: "On screen",
        rows: [
          {
            label: "Blur contents when Kern isn't focused",
            hint: "Hides tasks and notes as soon as you switch to another app, for shared screens and desk-side meetings.",
            keywords: "privacy screen peek obscure hide shoulder",
            control: <SToggle k="privacy.blurOnUnfocus" />,
          },
          {
            label: "Show details in notifications",
            hint: "When off, desktop notifications say only that something needs attention — no task titles, comment text or names, so nothing shows on a lock screen.",
            keywords: "notifications lock screen titles redact",
            control: <SToggle k="privacy.notificationDetails" />,
          },
        ],
      },
      {
        title: "Passkeys",
        rows: [
          {
            label: "Passkeys on this computer",
            hint: "Windows draws the prompt and keeps the credential; Kern stores only the name and the dates. A passkey is per computer, so each one you use needs its own.",
            keywords: "passkey webauthn windows hello security key fido biometric fingerprint face pin",
            block: <PasskeyList />,
          },
          {
            label: "Keep a project open for",
            hint: "After this, opening it asks for a passkey again. “Until Kern closes” still re-asks on the next launch.",
            keywords: "passkey relock timeout lock session",
            control: (
              <SSelect
                k="privacy.passkeyRelockMinutes"
                options={[
                  { value: "0", label: "Until Kern closes" },
                  { value: "5", label: "5 min" },
                  { value: "15", label: "15 min" },
                  { value: "60", label: "1 hour" },
                ]}
              />
            ),
          },
          {
            label: "Lost your authenticator?",
            hint: "A lock is a gate on the running app, not encryption — the database holds the same rows either way — so there is a way back in that doesn't need a passkey.",
            keywords: "passkey recovery reset lost locked out forget",
            control: <PasskeyRecovery />,
          },
        ],
      },
      {
        title: "Locked projects",
        rows: [
          {
            label: "Require a passkey to open",
            hint: "A locked project keeps its name in the sidebar and nothing else: its tasks, notes, whiteboards, files and search hits are withheld until a passkey opens it.",
            keywords: "project lock passkey private hide require",
            block: <LockedProjects />,
          },
        ],
      },
      {
        title: "Folder trust",
        rows: [
          { label: "Remember trusted folders", hint: "When off, trusted folders return to restricted mode each time Kern starts.", keywords: "workspace trust", control: <SToggle k="projects.rememberTrust" /> },
          {
            label: "Trust expires after",
            hint: "A folder returns to restricted mode this long after you trusted it, so an old decision doesn't outlive the work.",
            keywords: "workspace trust expiry revoke forget",
            control: (
              <SSelect
                k="privacy.trustExpiryDays"
                options={[
                  { value: "0", label: "Never" },
                  { value: "1", label: "1 day" },
                  { value: "7", label: "7 days" },
                  { value: "30", label: "30 days" },
                  { value: "90", label: "90 days" },
                ]}
              />
            ),
          },
          { label: "Trusted folders", hint: "Trust applies to exactly the folder shown, never to its parents or other folders.", keywords: "manage revoke workspace trust restricted", block: <TrustedFolders /> },
        ],
      },
      {
        title: "On this computer",
        rows: [
          {
            label: "Record recently opened items",
            hint: "The Recent list in search and the sidebar. When off, nothing new is recorded and the existing list is cleared.",
            keywords: "history recent clear",
            control: <SToggle k="privacy.recordRecents" />,
          },
          {
            label: "Allow plugin and syntax downloads",
            hint: "Plugins and syntax highlighting grammars are fetched from their source only when you install them.",
            keywords: "plugins syntax grammars download network",
            control: <SToggle k="privacy.pluginDownloads" />,
          },
          {
            label: "AI assistants",
            hint: "Off by default. An assistant you approve - Claude Desktop, Claude Code - reads and changes your work through its own program, so anything it reads leaves this computer with it. Kern never reaches out to it. You can be asked before anything is written, hold assistants to chosen projects, and put any one change back. The same page adds a local HTTP address for assistants that take a URL, and - the other way round - MCP servers of your own that Kern's AI features may call.",
            keywords: "mcp model context protocol claude desktop claude code assistant connector tools pipe confirm approve writes allowed projects revert undo batch audit activity mcpb extension http port token bearer localhost endpoint url servers external tool calls subscription claude cli",
            control: (
              <Button size="sm" onClick={() => navigate({ name: "api", tab: "mcp" })}>
                Assistants…
              </Button>
            ),
          },
          { label: "Secrets", hint: "API keys and tokens live in the OS credential store, never in the database, logs or backups.", keywords: "keys tokens keychain credential manager", control: <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>OS credential store</span> },
        ],
      },
    ],
    integrations: <IntegrationsSection />,
    cloud: <CloudSection />,
    plugins: <PluginsSection />,
    developer: developerGroups(),
    api: (
      <Suspense fallback={<Skeleton height={120} />}>
        <ApiPage tab={apiTab} />
      </Suspense>
    ),
    performance: [
      {
        rows: [
          { label: "Animation", keywords: "transitions reduce", control: <SSegmented k="appearance.motion" options={[{ value: "system", label: "System" }, { value: "full", label: "Full" }, { value: "reduced", label: "Reduced" }, { value: "off", label: "Off" }]} /> },
          { label: "Reduce background activity", hint: "Checks for reminders once a minute instead of every 20 seconds.", control: <SToggle k="performance.reduceBackground" /> },
          { label: "Limit whiteboard effects", hint: "Turns off shadows, animated connectors and the minimap.", control: <SToggle k="wb.limitEffects" /> },
          { label: "Keep loaded data for", hint: "How long views you've left stay cached in memory.", keywords: "cache memory", control: <SSelect k="performance.cacheMinutes" options={[1, 5, 15, 30].map((m) => ({ value: String(m), label: `${m} min` }))} /> },
          { label: "Stay running in the tray", control: <SToggle k="general.showTray" /> },
          { label: "Startup", hint: "Time from launching the window to the interface being ready, this session.", control: <span className="tabular faint">{startup} ms</span> },
          { label: "Storage", block: <StorageStats /> },
        ],
      },
    ],
    about: <AboutSection />,
    calendars,
    templates: templateGroups(),
  };
}

function Group({ g, highlight }: { g: GroupDef; highlight?: string }) {
  return (
    <div id={g.id}>
      {g.title && <div className="set-group__title">{g.title}</div>}
      <div className="set-group">
        {g.rows.map((r) => (
          <Row key={r.label} r={r} highlight={!!highlight} />
        ))}
      </div>
    </div>
  );
}

function Row({ r, highlight }: { r: RowDef; highlight: boolean }) {
  return (
    <div className="set-row" data-highlight={highlight || undefined} style={r.block ? { flexWrap: "wrap" } : undefined}>
      <div className="set-row__text">
        <span className="set-row__label">{r.label}</span>
        {r.hint && <span className="set-row__hint">{r.hint}</span>}
      </div>
      {r.control && <div className="set-row__control">{r.control}</div>}
      {r.block && <div style={{ flexBasis: "100%", minWidth: 0, paddingBottom: 4 }}>{r.block}</div>}
    </div>
  );
}

export default function SettingsPage({ section = "general", apiTab }: { section?: SettingsSection; apiTab?: ApiTab }) {
  const sections = useSections(apiTab);
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return null;
    const out: { section: SettingsSection; groups: GroupDef[] }[] = [];
    for (const meta of SECTIONS) {
      const content = sections[meta.id];
      if (!Array.isArray(content)) continue;
      const groups = (content as GroupDef[])
        .map((g) => ({
          ...g,
          rows: g.rows.filter((r) => `${r.label} ${typeof r.hint === "string" ? r.hint : ""} ${r.keywords ?? ""} ${g.title ?? ""} ${meta.label}`.toLowerCase().includes(s)),
        }))
        .filter((g) => g.rows.length);
      if (groups.length) out.push({ section: meta.id, groups });
    }
    if ("keyboard shortcuts hotkeys".includes(s) || s.includes("shortcut")) out.push({ section: "keyboard", groups: [] });
    return out;
  }, [q, sections]);

  const current = sections[section];
  const meta = SECTIONS.find((x) => x.id === section)!;

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">
          <Settings /> Settings
        </h1>
      </header>
      <div className="settings">
        <nav className="settings__nav" aria-label="Settings categories">
          <div className="input-wrap" style={{ marginBottom: 8 }}>
            <Search />
            <input className="input" style={{ height: "var(--control-h-sm)" }} placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search settings" />
          </div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="nav-item"
              data-active={!matches && s.id === section ? true : undefined}
              onClick={() => {
                setQ("");
                navigate(s.id === "api" ? { name: "api", tab: "accounts" } : { name: "settings", section: s.id }, { replace: true });
              }}
            >
              <s.icon strokeWidth={1.75} />
              <span className="nav-item__label">{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings__body">
          <div className="settings__inner">
            {matches ? (
              matches.length ? (
                matches.map((m) => (
                  <div key={m.section} style={{ marginBottom: 20 }}>
                    <button type="button" className="settings__heading" style={{ fontSize: "var(--fs-lg)" }} onClick={() => { setQ(""); navigate({ name: "settings", section: m.section }, { replace: true }); }}>
                      {SECTIONS.find((x) => x.id === m.section)!.label} →
                    </button>
                    {m.groups.map((g, i) => (
                      <Group key={i} g={g} highlight={q} />
                    ))}
                  </div>
                ))
              ) : (
                <div className="empty">No settings match “{q}”.</div>
              )
            ) : (
              <>
                <h2 className="settings__heading">{meta.label}</h2>
                {Array.isArray(current) ? (current as GroupDef[]).map((g, i) => <Group key={i} g={g} />) : current}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

