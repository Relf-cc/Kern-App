/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import {
  ArrowDown,
  ArrowUp,
  Bug,
  CalendarClock,
  ChevronDown,
  ClipboardCheck,
  Repeat2,
  CircleArrowDown,
  Coffee,
  EyeOff,
  FolderKanban,
  GitBranch,
  Inbox,
  KeyRound,
  LayoutGrid,
  ListFilter,
  Lock,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Presentation,
  Search,
  Settings,
  Settings2,
  SquareCheckBig,
  StickyNote,
  Sunrise,
  Timer,
  Trash,
  type LucideIcon,
} from "lucide-react";
import { SessionPill } from "@/features/sessions/SessionUi";
import { SpaceSwitcher } from "@/features/cloud/SpaceSwitcher";
import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  useDroppable,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useGroups, useOverview, useProjects, useUpdateCheck, useViews } from "@/hooks/data";
import { useRouter, navigate, type Route } from "@/stores/router";
import { useSetting, setSetting } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { IconButton } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { ContextMenu, Dropdown, type MenuItems } from "@/components/ui/Menu";
import { Ring } from "@/components/ui/Controls";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { newGroup, projectMenu } from "@/features/projects/actions";
import { importFromGithub } from "@/features/github/shared";
import { useFocus, remainingOf, KIND_LABEL } from "@/features/focus/store";
import { useNow } from "@/hooks/useToday";
import { formatClock } from "@/lib/dates";
import { api, describeError } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import { toastError } from "@/stores/toast";
import { announce } from "@/lib/announce";
import type { NavItemId, SidebarSectionId } from "@/features/settings/schema";
import type { Project, ProjectGroup, SavedView } from "@/lib/types";
import { resolveBindings } from "@/lib/shortcuts";
import { prompt, confirm } from "@/components/ui/Dialog";
import { APP_NAME } from "@/app/brand";
import { BrandMark } from "@/app/BrandMark";
import { switchMode } from "@/app/mode";
import { startUpdate } from "@/features/updates/store";
import { openBugReport } from "@/features/bug-report/open";
import { AUTO_SCROLL, DROP_ANIMATION, DragPreview, SORT_TRANSITION, SortableRow, announcements, restrictToVertical, useListSensors } from "./sortable";

/**
 * Shown above Trash when a newer GitHub release exists; installs it in the
 * app (see features/updates). Pops in when an update appears.
 */
function UpdateBanner({ collapsed }: { collapsed: boolean }) {
  const { data } = useUpdateCheck();
  if (!data?.latest) return null;
  const label = `${data.security ? "Required security update" : "Update"} to ${APP_NAME} v${data.latest} (you have v${data.current})`;
  return (
    <Tooltip content={label} side="right">
      <button
        type="button"
        className="update-banner"
        data-collapsed={collapsed || undefined}
        aria-label={label}
        data-security={data.security || undefined}
        onClick={() => void startUpdate({ current: data.current, target: data.latest!, fallbackUrl: data.url, forced: data.security })}
      >
        <CircleArrowDown strokeWidth={2} />
        {!collapsed && (
          <>
            <span className="truncate">{data.security ? "Security Update" : "Update Available"}</span>
            <span className="update-banner__dot" aria-hidden />
            <span className="update-banner__version">v{data.latest}</span>
          </>
        )}
      </button>
    </Tooltip>
  );
}

export const NAV: Record<NavItemId, { label: string; icon: LucideIcon; route: Route; shortcut?: string }> = {
  dashboard: { label: "Dashboard", icon: LayoutGrid, route: { name: "dashboard" }, shortcut: "goDashboard" },
  tasks: { label: "My Tasks", icon: SquareCheckBig, route: { name: "tasks" }, shortcut: "goTasks" },
  inbox: { label: "Inbox", icon: Inbox, route: { name: "inbox" }, shortcut: "goInbox" },
  projects: { label: "Projects", icon: FolderKanban, route: { name: "projects" }, shortcut: "goProjects" },
  whiteboards: { label: "Whiteboards", icon: Presentation, route: { name: "whiteboards" }, shortcut: "goWhiteboards" },
  notes: { label: "Notes", icon: StickyNote, route: { name: "notes" }, shortcut: "goNotes" },
  search: { label: "Search", icon: Search, route: { name: "search" } },
  focus: { label: "Focus", icon: Timer, route: { name: "focus" }, shortcut: "focusMode" },
  rundown: { label: "Daily Rundown", icon: Sunrise, route: { name: "rundown" }, shortcut: "rundown" },
  ai: { label: "AI Accounts", icon: KeyRound, route: { name: "api", tab: "accounts" } },
  planner: { label: "Day Planner", icon: CalendarClock, route: { name: "tasks", view: "plan" } },
  habits: { label: "Habits", icon: Repeat2, route: { name: "habits" } },
  review: { label: "Weekly Review", icon: ClipboardCheck, route: { name: "review" } },
};

function isActive(item: NavItemId, r: Route): boolean {
  switch (item) {
    case "whiteboards":
      return r.name === "whiteboards" || r.name === "whiteboard";
    case "ai":
      return r.name === "api";
    case "planner":
      return r.name === "tasks" && r.view === "plan";
    case "tasks":
      return r.name === "tasks" && r.view !== "plan";
    default:
      return r.name === item;
  }
}

export function Sidebar() {
  const collapsed = useSetting("appearance.sidebarCollapsed");
  const width = useSetting("appearance.sidebarWidth");
  const shortcuts = resolveBindings(useSetting("keyboard.shortcuts"));
  const route = useRouter((s) => s.route);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const resizing = useRef(false);

  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    resizing.current = true;
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.max(184, Math.min(380, startW + ev.clientX - startX));
      setLiveWidth(w);
    };
    const up = () => {
      resizing.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLiveWidth(null);
      void setSetting("appearance.sidebarWidth", Math.round(w));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside
      className="sidebar"
      data-collapsed={collapsed}
      data-resizing={liveWidth !== null}
      style={{ "--sidebar-w": `${liveWidth ?? width}px` } as CSSProperties}
      aria-label="Navigation"
    >
      <div className="sidebar__top">
        <div className="brand">
          <Tooltip content={collapsed ? "Expand sidebar" : undefined} side="right" disabled={!collapsed}>
            <button
              type="button"
              className="row"
              style={{ gap: 8 }}
              onClick={() => collapsed && void setSetting("appearance.sidebarCollapsed", false)}
              aria-label={collapsed ? "Expand sidebar" : APP_NAME}
            >
              <BrandMark className="brand__mark" />
            </button>
          </Tooltip>
          <span className="brand__name truncate">{APP_NAME}</span>
        </div>
        <IconButton icon={Search} label="Search & commands" shortcut={shortcuts.palette} size="sm" onClick={() => useUi.getState().setPalette(true)} />
        <IconButton icon={Plus} label="Quick capture" shortcut={shortcuts.quickCapture} size="sm" onClick={() => useUi.getState().openCapture()} />
      </div>

      <div className="sidebar__space">
        <SpaceSwitcher collapsed={collapsed} />
      </div>

      <div className="sidebar__scroll">
        <Destinations collapsed={collapsed} />
        {!collapsed && <Sections />}
      </div>

      <div className="sidebar__bottom">
        <UpdateBanner collapsed={collapsed} />
        <SessionPill collapsed={collapsed} />
        <FocusPill collapsed={collapsed} />
        <NavButton icon={Bug} label="Report a bug" collapsed={collapsed} onClick={openBugReport} />
        <NavButton icon={Trash} label="Trash" active={route.name === "trash"} collapsed={collapsed} onClick={() => navigate({ name: "trash" })} />
        <div className="row" style={{ gap: 2 }}>
          <div className="grow">
            <NavButton
              icon={Settings}
              label="Settings"
              active={route.name === "settings" || route.name === "api"}
              collapsed={collapsed}
              shortcut={shortcuts.goSettings}
              onClick={() => navigate({ name: "settings" })}
            />
          </div>
          {!collapsed && <IconButton icon={Minimize2} label="Switch to Kern Lite" size="sm" onClick={() => void switchMode("lite")} />}
          {!collapsed && (
            <IconButton
              icon={PanelLeftClose}
              label="Collapse sidebar"
              shortcut={shortcuts.toggleSidebar}
              size="sm"
              onClick={() => void setSetting("appearance.sidebarCollapsed", true)}
            />
          )}
        </div>
        {collapsed && (
          <NavButton
            icon={PanelLeftOpen}
            label="Expand sidebar"
            collapsed
            shortcut={shortcuts.toggleSidebar}
            onClick={() => void setSetting("appearance.sidebarCollapsed", false)}
          />
        )}
      </div>
      {!collapsed && (
        <div
          className="resize-handle sidebar-resize"
          data-dragging={liveWidth !== null}
          onPointerDown={onResizeStart}
          onDoubleClick={() => void setSetting("appearance.sidebarWidth", 236)}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
        />
      )}
    </aside>
  );
}

function NavButton({
  icon: Icon,
  label,
  active,
  count,
  collapsed,
  shortcut,
  onClick,
  glyph,
  actions,
  dot,
}: {
  icon?: LucideIcon;
  label: string;
  active?: boolean;
  count?: number;
  collapsed?: boolean;
  shortcut?: string | null;
  onClick: () => void;
  glyph?: React.ReactNode;
  actions?: React.ReactNode;
  dot?: boolean;
}) {
  const btn = (
    <button type="button" className="nav-item" data-active={active || undefined} onClick={onClick} aria-current={active ? "page" : undefined}>
      {glyph ?? (Icon && <Icon strokeWidth={1.75} />)}
      <span className="nav-item__label">{label}</span>
      {!!count && <span className="nav-item__count">{count}</span>}
      {dot && collapsed && <span className="nav-item__dot" />}
      {actions && <span className="nav-item__actions">{actions}</span>}
    </button>
  );
  return collapsed ? (
    <Tooltip content={count ? `${label} · ${count}` : label} shortcut={shortcut} side="right">
      {btn}
    </Tooltip>
  ) : (
    btn
  );
}

/** Up/down entries shared by every reorderable row's context menu. */
function moveItems(index: number, count: number, move: (delta: -1 | 1) => void): MenuItems {
  return [
    { label: "Move up", icon: ArrowUp, shortcut: "Alt+ArrowUp", disabled: index <= 0, onSelect: () => move(-1) },
    { label: "Move down", icon: ArrowDown, shortcut: "Alt+ArrowDown", disabled: index >= count - 1, onSelect: () => move(1) },
  ];
}

// ------------------------------------------------------------ destinations

function Destinations({ collapsed }: { collapsed: boolean }) {
  const navItems = useSetting("appearance.navItems");
  const reorder = useSetting("sidebar.reorder");
  const handles = useSetting("sidebar.dragHandles");
  const shortcuts = resolveBindings(useSetting("keyboard.shortcuts"));
  const route = useRouter((s) => s.route);
  const { data: overview } = useOverview();
  const sensors = useListSensors();
  const [activeId, setActiveId] = useState<NavItemId | null>(null);
  const items = navItems.filter((id) => NAV[id]);
  const counts: Partial<Record<NavItemId, number>> = {
    inbox: overview?.inbox,
    tasks: overview ? overview.dueToday + overview.overdue : undefined,
  };

  const commit = (next: NavItemId[], moved: NavItemId) => {
    void setSetting("appearance.navItems", next);
    announce(`${NAV[moved].label} moved to position ${next.indexOf(moved) + 1} of ${next.length}.`);
  };
  const move = (id: NavItemId, delta: -1 | 1) => {
    const i = items.indexOf(id);
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    commit(arrayMove(items, i, j), id);
  };
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    if (!e.over || e.active.id === e.over.id) return;
    const from = items.indexOf(e.active.id as NavItemId);
    const to = items.indexOf(e.over.id as NavItemId);
    if (from >= 0 && to >= 0) commit(arrayMove(items, from, to), e.active.id as NavItemId);
  };

  const row = (id: NavItemId, isCollapsed: boolean) => {
    const item = NAV[id];
    return (
      <NavButton
        icon={item.icon}
        label={item.label}
        active={isActive(id, route)}
        count={counts[id]}
        collapsed={isCollapsed}
        shortcut={item.shortcut ? shortcuts[item.shortcut] : undefined}
        onClick={() => navigate(item.route)}
      />
    );
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVertical]}
      autoScroll={AUTO_SCROLL}
      accessibility={{ announcements: announcements((id) => NAV[id as NavItemId]?.label ?? id, () => items.length, (id) => items.indexOf(id as NavItemId)) }}
      onDragStart={(e) => setActiveId(e.active.id as NavItemId)}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <nav className="col" style={{ gap: 1 }} aria-label="Destinations">
          {items.map((id, i) => (
            <SortableRow key={id} id={id} disabled={!reorder || collapsed} handle={handles} onMove={reorder ? (d) => move(id, d) : undefined}>
              <ContextMenu
                items={() => [
                  ...(reorder ? moveItems(i, items.length, (d) => move(id, d)) : []),
                  { type: "separator" },
                  {
                    label: "Hide from sidebar",
                    icon: EyeOff,
                    disabled: items.length <= 1,
                    onSelect: () => void setSetting("appearance.navItems", items.filter((x) => x !== id)),
                  },
                  { label: "Customise sidebar…", icon: Settings2, onSelect: () => navigate({ name: "settings", section: "appearance" }) },
                ]}
              >
                <div>{row(id, collapsed)}</div>
              </ContextMenu>
            </SortableRow>
          ))}
        </nav>
      </SortableContext>
      <DragOverlay dropAnimation={DROP_ANIMATION} modifiers={[restrictToVertical]}>
        {activeId && <DragPreview>{row(activeId, false)}</DragPreview>}
      </DragOverlay>
    </DndContext>
  );
}

// ------------------------------------------------------------ sections

const SECTION_LABEL: Record<SidebarSectionId, string> = { views: "Views", pinned: "Pinned", projects: "Projects" };

/** Collapse state of a section: persisted when "Remember collapsed groups" is on. */
function useSectionOpen(id: SidebarSectionId): [boolean, () => void] {
  const remember = useSetting("sidebar.rememberGroups");
  const stored = useSetting("sidebar.collapsedSections");
  const [local, setLocal] = useState(false);
  const collapsed = remember ? stored.includes(id) : local;
  const toggle = () => {
    if (remember) void setSetting("sidebar.collapsedSections", collapsed ? stored.filter((x) => x !== id) : [...stored, id]);
    else setLocal(!local);
  };
  return [!collapsed, toggle];
}

interface HeaderDrag {
  /** Listeners that make the header the drag handle of its section. */
  listeners?: Record<string, unknown>;
  draggable: boolean;
}

function SectionHead({
  label,
  collapsed,
  onToggle,
  actions,
  drag,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  drag?: HeaderDrag;
}) {
  return (
    <div className="sidebar__section-head" data-collapsed={collapsed} data-draggable={drag?.draggable || undefined} {...(drag?.draggable ? drag.listeners : {})}>
      <button type="button" className="sidebar__section-toggle" onClick={onToggle} aria-expanded={!collapsed}>
        {label}
        <ChevronDown />
      </button>
      {actions}
    </div>
  );
}

/** Sections in the user's order; draggable by their headers in the flexible layout. */
function Sections() {
  const order = useSetting("sidebar.sectionOrder");
  const layout = useSetting("sidebar.layout");
  const reorder = useSetting("sidebar.reorder");
  const sensors = useListSensors();
  const flexible = layout === "flexible" && reorder;
  // Tolerate stale or partial stored orders.
  const ids = useMemo(() => {
    const all: SidebarSectionId[] = ["views", "pinned", "projects"];
    return [...order.filter((x) => all.includes(x)), ...all.filter((x) => !order.includes(x))];
  }, [order]);

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const next = arrayMove(ids, ids.indexOf(e.active.id as SidebarSectionId), ids.indexOf(e.over.id as SidebarSectionId));
    void setSetting("sidebar.sectionOrder", next);
    announce(`${SECTION_LABEL[e.active.id as SidebarSectionId]} section moved.`);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVertical]}
      autoScroll={AUTO_SCROLL}
      accessibility={{ announcements: announcements((id) => `${SECTION_LABEL[id as SidebarSectionId]} section`, () => ids.length, (id) => ids.indexOf(id as SidebarSectionId)) }}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {ids.map((id) => (
          <SortableSection key={id} id={id} draggable={flexible} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableSection({ id, draggable }: { id: SidebarSectionId; draggable: boolean }) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, disabled: !draggable, transition: SORT_TRANSITION });
  const drag: HeaderDrag = { listeners: listeners as Record<string, unknown>, draggable };
  return (
    <div ref={setNodeRef} className="sortable" data-ghost={isDragging || undefined} style={{ transform: CSS.Translate.toString(transform), transition }}>
      {id === "views" && <ViewsSection drag={drag} />}
      {id === "pinned" && <PinnedSection drag={drag} />}
      {id === "projects" && <ProjectsSection drag={drag} />}
    </div>
  );
}

// ------------------------------------------------------------ views

function ViewsSection({ drag }: { drag: HeaderDrag }) {
  const { data: views } = useViews();
  const route = useRouter((s) => s.route);
  const reorder = useSetting("sidebar.reorder");
  const handles = useSetting("sidebar.dragHandles");
  const [open, toggle] = useSectionOpen("views");
  const sensors = useListSensors();
  const [activeId, setActiveId] = useState<string | null>(null);
  if (!views?.length) return null;
  const ids = views.map((v) => v.id);
  const byId = new Map(views.map((v) => [v.id, v]));

  const commit = (next: string[], moved: string) => {
    const sorted = next.map((id, i) => ({ ...byId.get(id)!, sortOrder: i + 1 }));
    queryClient.setQueryData<SavedView[]>(["views"], sorted);
    void api.views
      .reorder(next)
      .catch((e) => toastError(describeError(e)))
      .finally(() => invalidate("views"));
    announce(`${byId.get(moved)?.name} moved to position ${next.indexOf(moved) + 1} of ${next.length}.`);
  };
  const move = (id: string, delta: -1 | 1) => {
    const i = ids.indexOf(id);
    if (i + delta < 0 || i + delta >= ids.length) return;
    commit(arrayMove(ids, i, i + delta), id);
  };

  const row = (v: SavedView) => (
    <NavButton icon={ListFilter} label={v.name} active={route.name === "view" && route.id === v.id} onClick={() => navigate({ name: "view", id: v.id })} />
  );

  return (
    <div className="sidebar__section">
      <SectionHead label="Views" collapsed={!open} onToggle={toggle} drag={drag} />
      {open && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVertical]}
          autoScroll={AUTO_SCROLL}
          accessibility={{ announcements: announcements((id) => byId.get(id)?.name ?? id, () => ids.length, (id) => ids.indexOf(id)) }}
          onDragStart={(e) => setActiveId(String(e.active.id))}
          onDragCancel={() => setActiveId(null)}
          onDragEnd={(e) => {
            setActiveId(null);
            if (!e.over || e.active.id === e.over.id) return;
            commit(arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))), String(e.active.id));
          }}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {views.map((v, i) => (
              <SortableRow key={v.id} id={v.id} disabled={!reorder} handle={handles} onMove={reorder ? (d) => move(v.id, d) : undefined}>
                <ContextMenu
                  items={() => [
                    ...(reorder ? moveItems(i, ids.length, (d) => move(v.id, d)) : []),
                    { type: "separator" },
                    {
                      label: "Rename",
                      onSelect: async () => {
                        const name = await prompt({ title: "Rename view", initial: v.name });
                        if (name) {
                          await api.views.update(v.id, { name });
                          invalidate("views");
                        }
                      },
                    },
                    {
                      label: "Delete view",
                      danger: true,
                      onSelect: async () => {
                        if (await confirm({ title: `Delete "${v.name}"?`, message: "Only the saved filter is removed; tasks are unaffected.", confirmLabel: "Delete", danger: true })) {
                          await api.views.delete(v.id);
                          invalidate("views");
                          if (route.name === "view" && route.id === v.id) navigate({ name: "tasks" }, { replace: true });
                        }
                      },
                    },
                  ]}
                >
                  <div>{row(v)}</div>
                </ContextMenu>
              </SortableRow>
            ))}
          </SortableContext>
          <DragOverlay dropAnimation={DROP_ANIMATION} modifiers={[restrictToVertical]}>
            {activeId && byId.get(activeId) && <DragPreview>{row(byId.get(activeId)!)}</DragPreview>}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

// ------------------------------------------------------------ projects

function sortProjects(list: Project[], order: "manual" | "recent" | "name") {
  const copy = [...list];
  if (order === "name") copy.sort((a, b) => a.name.localeCompare(b.name));
  else if (order === "recent") copy.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
  else copy.sort((a, b) => a.sortOrder - b.sortOrder);
  return copy;
}

const UNGROUPED = "__ungrouped";
type Containers = Record<string, string[]>;

/**
 * Persists a full arrangement. The project list cache is updated first so
 * the dropped item stays where it was released (no snap-back while saving).
 */
async function saveArrangement(placements: { id: string; groupId: string | null }[]) {
  const rank = new Map(placements.map((p, i) => [p.id, { sortOrder: i + 1, groupId: p.groupId }]));
  for (const [key, data] of queryClient.getQueriesData<Project[]>({ queryKey: ["projects"] })) {
    if (!Array.isArray(data)) continue;
    queryClient.setQueryData<Project[]>(
      key,
      data.map((p) => (rank.has(p.id) ? { ...p, ...rank.get(p.id)! } : p)),
    );
  }
  try {
    await api.projects.arrange(placements);
  } catch (e) {
    toastError(describeError(e, "Couldn't save the new order."));
  } finally {
    invalidate("projects", "project");
  }
}

function useProjectLayout() {
  const { data: projects } = useProjects(false);
  const { data: groups } = useGroups();
  const grouping = useSetting("projects.grouping");
  const order = useSetting("projects.sidebarOrder");
  const list = useMemo(() => projects ?? [], [projects]);
  const pinned = useMemo(() => sortProjects(list.filter((p) => p.pinned), order), [list, order]);
  const rest = useMemo(() => sortProjects(list.filter((p) => !p.pinned), order), [list, order]);
  const grouped = grouping === "groups" && (groups?.length ?? 0) > 0;
  const containers = useMemo<Containers>(() => {
    const c: Containers = { [UNGROUPED]: [] };
    if (grouped) for (const g of groups!) c[g.id] = [];
    for (const p of rest) c[grouped && p.groupId && c[p.groupId] ? p.groupId : UNGROUPED].push(p.id);
    return c;
  }, [rest, groups, grouped]);
  const byId = useMemo(() => new Map(list.map((p) => [p.id, p])), [list]);
  return { projects: list, groups: groups ?? [], pinned, rest, grouped, containers, byId, manual: order === "manual" };
}

/** Pinned (favourite) projects, in their own order above the project tree. */
function PinnedSection({ drag }: { drag: HeaderDrag }) {
  const { pinned, containers, groups, byId, manual } = useProjectLayout();
  const route = useRouter((s) => s.route);
  const reorder = useSetting("sidebar.reorder");
  const handles = useSetting("sidebar.dragHandles");
  const showProgress = useSetting("projects.showProgress");
  const [open, toggle] = useSectionOpen("pinned");
  const sensors = useListSensors();
  const [activeId, setActiveId] = useState<string | null>(null);
  if (!pinned.length) return null;
  const ids = pinned.map((p) => p.id);
  const draggable = reorder && manual;
  const activeProjectId = route.name === "project" ? route.id : null;

  const commit = (next: string[], moved: string) => {
    const tail = Object.entries(containers).flatMap(([k, list]) => list.map((id) => ({ id, groupId: k === UNGROUPED ? null : k })));
    void saveArrangement([...next.map((id) => ({ id, groupId: byId.get(id)?.groupId ?? null })), ...tail]);
    announce(`${byId.get(moved)?.name} moved to position ${next.indexOf(moved) + 1} of ${next.length}.`);
  };
  const move = (id: string, delta: -1 | 1) => {
    const i = ids.indexOf(id);
    if (i + delta < 0 || i + delta >= ids.length) return;
    commit(arrayMove(ids, i, i + delta), id);
  };

  return (
    <div className="sidebar__section">
      <SectionHead label="Pinned" collapsed={!open} onToggle={toggle} drag={drag} />
      {open && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVertical]}
          autoScroll={AUTO_SCROLL}
          accessibility={{ announcements: announcements((id) => byId.get(id)?.name ?? id, () => ids.length, (id) => ids.indexOf(id)) }}
          onDragStart={(e) => setActiveId(String(e.active.id))}
          onDragCancel={() => setActiveId(null)}
          onDragEnd={(e) => {
            setActiveId(null);
            if (!e.over || e.active.id === e.over.id) return;
            commit(arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))), String(e.active.id));
          }}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {pinned.map((p, i) => (
              <SortableRow key={p.id} id={p.id} disabled={!draggable} handle={handles} onMove={draggable ? (d) => move(p.id, d) : undefined}>
                <ProjectItem project={p} active={activeProjectId === p.id} showProgress={showProgress} groups={groups} extraMenu={draggable ? moveItems(i, ids.length, (d) => move(p.id, d)) : []} />
              </SortableRow>
            ))}
          </SortableContext>
          <DragOverlay dropAnimation={DROP_ANIMATION} modifiers={[restrictToVertical]}>
            {activeId && byId.get(activeId) && (
              <DragPreview>
                <ProjectItem project={byId.get(activeId)!} active={false} showProgress={showProgress} groups={groups} />
              </DragPreview>
            )}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

type Active = { type: "project" | "group"; id: string } | null;
const groupKey = (id: string) => `group:${id}`;
const dropKey = (container: string) => `drop:${container}`;

/**
 * The project tree. Projects reorder within a group, move between groups
 * (hover a project in another group, or drop on a group's header) and
 * groups reorder as whole blocks by their headers. One drag context with
 * typed collision detection keeps those operations from mixing.
 */
function ProjectsSection({ drag }: { drag: HeaderDrag }) {
  const layout = useProjectLayout();
  const { pinned, groups, grouped, byId, manual } = layout;
  const route = useRouter((s) => s.route);
  const reorder = useSetting("sidebar.reorder");
  const handles = useSetting("sidebar.dragHandles");
  const showProgress = useSetting("projects.showProgress");
  const [open, toggle] = useSectionOpen("projects");
  const sensors = useListSensors();
  const [active, setActive] = useState<Active>(null);
  const [live, setLive] = useState<Containers | null>(null);
  const [liveGroups, setLiveGroups] = useState<string[] | null>(null);
  const containers = live ?? layout.containers;
  const groupIds = liveGroups ?? (grouped ? groups.map((g) => g.id) : []);
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const draggable = reorder && manual;
  const activeProjectId = route.name === "project" ? route.id : null;

  const containerOf = (c: Containers, id: string) => Object.keys(c).find((k) => c[k].includes(id));
  const flatten = (c: Containers, order: string[]) => [
    ...pinned.map((p) => ({ id: p.id, groupId: p.groupId })),
    ...c[UNGROUPED].map((id) => ({ id, groupId: null })),
    ...order.flatMap((g) => (c[g] ?? []).map((id) => ({ id, groupId: g }))),
  ];

  const collision: CollisionDetection = (args) => {
    if (!active) return closestCenter(args);
    const typed = (pred: (id: string) => boolean) => args.droppableContainers.filter((c) => pred(String(c.id)));
    if (active.type === "group") return closestCenter({ ...args, droppableContainers: typed((id) => id.startsWith("group:")) });
    // Group headers (and the empty "no group" slot) take priority under the pointer.
    const headers = pointerWithin({ ...args, droppableContainers: typed((id) => id.startsWith("drop:")) });
    if (headers.length) return headers;
    return closestCenter({ ...args, droppableContainers: typed((id) => !id.startsWith("drop:") && !id.startsWith("group:")) });
  };

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setActive(id.startsWith("group:") ? { type: "group", id: id.slice(6) } : { type: "project", id });
  };

  // Live cross-group move while hovering projects of another group.
  const onDragOver = (e: DragOverEvent) => {
    if (active?.type !== "project" || !e.over) return;
    const overId = String(e.over.id);
    if (overId.startsWith("drop:")) return; // applied on release
    setLive((prev) => {
      const c = prev ?? layout.containers;
      const from = containerOf(c, active.id);
      const to = containerOf(c, overId);
      if (!from || !to || from === to) return prev;
      const next: Containers = { ...c, [from]: c[from].filter((x) => x !== active.id) };
      const target = [...c[to]];
      target.splice(target.indexOf(overId), 0, active.id);
      next[to] = target;
      return next;
    });
  };

  const reset = () => {
    setActive(null);
    setLive(null);
    setLiveGroups(null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const a = active;
    const c = live ?? layout.containers;
    if (!a || !e.over) return reset();
    const overId = String(e.over.id);
    if (a.type === "group") {
      const ids = groupIds;
      const to = ids.indexOf(overId.slice(6));
      const from = ids.indexOf(a.id);
      if (to < 0 || from === to) return reset();
      const next = arrayMove(ids, from, to);
      setLiveGroups(next);
      queryClient.setQueryData<ProjectGroup[]>(["groups"], next.map((id, i) => ({ ...groupById.get(id)!, sortOrder: i + 1 })));
      void api.groups
        .reorder(next)
        .catch((err) => toastError(describeError(err)))
        .finally(() => {
          invalidate("groups");
          setLiveGroups(null);
        });
      announce(`Group ${groupById.get(a.id)?.name} moved to position ${to + 1} of ${ids.length}.`);
      setActive(null);
      return;
    }
    const next: Containers = { ...c };
    const from = containerOf(next, a.id);
    if (!from) return reset();
    if (overId.startsWith("drop:")) {
      const target = overId.slice(5);
      if (target !== from) {
        next[from] = next[from].filter((x) => x !== a.id);
        next[target] = [...(next[target] ?? []), a.id];
      }
    } else if (overId !== a.id) {
      const list = next[from];
      if (list.includes(overId)) next[from] = arrayMove(list, list.indexOf(a.id), list.indexOf(overId));
    }
    const landed = containerOf(next, a.id)!;
    void saveArrangement(flatten(next, groupIds)).finally(() => setLive(null));
    setLive(next);
    setActive(null);
    const groupName = landed === UNGROUPED ? "no group" : groupById.get(landed)?.name;
    announce(`${byId.get(a.id)?.name} moved to position ${next[landed].indexOf(a.id) + 1} in ${groupName}.`);
  };

  const moveWithin = (id: string, delta: -1 | 1) => {
    const c = layout.containers;
    const k = containerOf(c, id);
    if (!k) return;
    const i = c[k].indexOf(id);
    if (i + delta < 0 || i + delta >= c[k].length) return;
    const next = { ...c, [k]: arrayMove(c[k], i, i + delta) };
    void saveArrangement(flatten(next, groupIds));
    announce(`${byId.get(id)?.name} moved to position ${i + delta + 1} of ${c[k].length}.`);
  };
  const moveGroup = (id: string, delta: -1 | 1) => {
    const i = groupIds.indexOf(id);
    if (i + delta < 0 || i + delta >= groupIds.length) return;
    const next = arrayMove(groupIds, i, i + delta);
    queryClient.setQueryData<ProjectGroup[]>(["groups"], next.map((g, j) => ({ ...groupById.get(g)!, sortOrder: j + 1 })));
    void api.groups.reorder(next).finally(() => invalidate("groups"));
    announce(`Group ${groupById.get(id)?.name} moved to position ${i + delta + 1} of ${groupIds.length}.`);
  };

  const item = (id: string) => {
    const p = byId.get(id);
    if (!p) return null;
    const k = containerOf(containers, id) ?? UNGROUPED;
    const list = containers[k];
    const i = list.indexOf(id);
    return (
      <SortableRow key={id} id={id} disabled={!draggable} handle={handles} onMove={draggable ? (d) => moveWithin(id, d) : undefined}>
        <ProjectItem
          project={p}
          active={activeProjectId === id}
          showProgress={showProgress}
          groups={groups}
          extraMenu={draggable ? moveItems(i, list.length, (d) => moveWithin(id, d)) : []}
        />
      </SortableRow>
    );
  };

  const total = Object.values(containers).reduce((n, l) => n + l.length, 0);
  const allNames = (id: string) => (id.startsWith("group:") ? `Group ${groupById.get(id.slice(6))?.name}` : (byId.get(id)?.name ?? id));

  return (
    <div className="sidebar__section">
      <SectionHead
        label="Projects"
        collapsed={!open}
        onToggle={toggle}
        drag={drag}
        actions={
          <Dropdown
            items={[
              { label: "New project", icon: Plus, onSelect: () => useUi.getState().set({ createProjectOpen: true }) },
              { label: "New group", icon: FolderKanban, onSelect: () => void newGroup() },
              { type: "separator" },
              { label: "Import from GitHub…", icon: GitBranch, onSelect: () => void importFromGithub() },
            ]}
            align="end"
          >
            <IconButton icon={Plus} label="New project or group" size="sm" noTooltip />
          </Dropdown>
        }
      />
      {open && (
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          modifiers={[restrictToVertical]}
          autoScroll={AUTO_SCROLL}
          accessibility={{
            announcements: announcements(allNames, () => (active?.type === "group" ? groupIds.length : total), (id) =>
              id.startsWith("group:") ? groupIds.indexOf(id.slice(6)) : (containers[containerOf(containers, id) ?? UNGROUPED]?.indexOf(id) ?? 0),
            ),
          }}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={reset}
        >
          <SortableContext id={UNGROUPED} items={containers[UNGROUPED]} strategy={verticalListSortingStrategy}>
            <div>{containers[UNGROUPED].map(item)}</div>
          </SortableContext>
          {grouped && active?.type === "project" && containers[UNGROUPED].length === 0 && <UngroupedDrop />}
          <SortableContext items={groupIds.map(groupKey)} strategy={verticalListSortingStrategy}>
            {groupIds.map((gid, gi) => {
              const g = groupById.get(gid);
              if (!g) return null;
              return (
                <GroupBlock
                  key={gid}
                  group={g}
                  count={containers[gid]?.length ?? 0}
                  draggable={reorder}
                  extraMenu={reorder ? moveItems(gi, groupIds.length, (d) => moveGroup(gid, d)) : []}
                  onMove={reorder ? (d) => moveGroup(gid, d) : undefined}
                >
                  <SortableContext id={gid} items={containers[gid] ?? []} strategy={verticalListSortingStrategy}>
                    {(containers[gid] ?? []).map(item)}
                  </SortableContext>
                </GroupBlock>
              );
            })}
          </SortableContext>
          <DragOverlay dropAnimation={DROP_ANIMATION} modifiers={[restrictToVertical]}>
            {active?.type === "project" && byId.get(active.id) && (
              <DragPreview>
                <ProjectItem project={byId.get(active.id)!} active={false} showProgress={showProgress} groups={groups} />
              </DragPreview>
            )}
            {active?.type === "group" && groupById.get(active.id) && (
              <DragPreview>
                <SectionHead label={groupById.get(active.id)!.name} collapsed onToggle={() => undefined} />
              </DragPreview>
            )}
          </DragOverlay>
        </DndContext>
      )}
      {open && !layout.projects.length && (
        <button type="button" className="nav-item" onClick={() => useUi.getState().set({ createProjectOpen: true })}>
          <Plus strokeWidth={1.75} />
          <span className="nav-item__label">New project</span>
        </button>
      )}
    </div>
  );
}

/** Drop target shown during a drag when no project is ungrouped. */
function UngroupedDrop() {
  const { setNodeRef, isOver } = useDroppable({ id: dropKey(UNGROUPED) });
  return (
    <div ref={setNodeRef} className="sidebar__drop-slot" data-over={isOver || undefined}>
      Remove from group
    </div>
  );
}

function GroupBlock({
  group,
  count,
  draggable,
  extraMenu,
  onMove,
  children,
}: {
  group: ProjectGroup;
  count: number;
  draggable: boolean;
  extraMenu: MenuItems;
  onMove?: (delta: -1 | 1) => void;
  children: ReactNode;
}) {
  const remember = useSetting("sidebar.rememberGroups");
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const collapsed = remember ? group.collapsed : localCollapsed;
  const sortable = useSortable({ id: groupKey(group.id), disabled: !draggable, transition: SORT_TRANSITION });
  const drop = useDroppable({ id: dropKey(group.id) });
  const toggle = () => {
    if (!remember) return setLocalCollapsed(!localCollapsed);
    queryClient.setQueryData<ProjectGroup[]>(["groups"], (gs) => gs?.map((g) => (g.id === group.id ? { ...g, collapsed: !collapsed } : g)));
    void api.groups.update(group.id, { collapsed: !collapsed }).finally(() => invalidate("groups"));
  };
  return (
    <div
      ref={sortable.setNodeRef}
      className="sortable"
      data-ghost={sortable.isDragging || undefined}
      style={{ marginTop: 4, transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}
      onKeyDown={(e) => {
        if (!onMove || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        if (!(e.target as HTMLElement).closest(".sidebar__section-head")) return;
        e.preventDefault();
        onMove(e.key === "ArrowUp" ? -1 : 1);
      }}
    >
      <ContextMenu
        items={() => [
          ...extraMenu,
          { type: "separator" },
          {
            label: "Rename group",
            onSelect: async () => {
              const name = await prompt({ title: "Rename group", initial: group.name });
              if (name) {
                await api.groups.update(group.id, { name });
                invalidate("groups");
              }
            },
          },
          {
            label: "Delete group",
            danger: true,
            onSelect: async () => {
              if (await confirm({ title: `Delete group "${group.name}"?`, message: "Projects in it are kept and become ungrouped.", confirmLabel: "Delete group", danger: true })) {
                await api.groups.delete(group.id);
                invalidate("groups", "projects");
              }
            },
          },
        ]}
      >
        <div ref={drop.setNodeRef} className="sidebar__group-head" data-drop={drop.isOver || undefined}>
          <SectionHead
            label={group.name}
            collapsed={collapsed}
            onToggle={toggle}
            drag={{ listeners: sortable.listeners as Record<string, unknown>, draggable }}
            actions={collapsed && count > 0 ? <span className="sidebar__group-count">{count}</span> : undefined}
          />
        </div>
      </ContextMenu>
      {!collapsed && children}
    </div>
  );
}

function ProjectItem({
  project: p,
  active,
  showProgress,
  groups,
  extraMenu = [],
}: {
  project: Project;
  active: boolean;
  showProgress: boolean;
  groups: ProjectGroup[];
  extraMenu?: MenuItems;
}) {
  const progress = p.taskTotal ? p.taskDone / p.taskTotal : 0;
  const open = p.taskTotal - p.taskDone;
  // Its counts are withheld while it's locked, so show the reason instead.
  const locked = !!p.lockedAt && !p.unlocked;
  return (
    <ContextMenu items={() => [...extraMenu, ...(extraMenu.length ? [{ type: "separator" as const }] : []), ...projectMenu(p, groups)]}>
      <div>
        <NavButton
          label={p.name}
          glyph={<ProjectGlyph project={p} />}
          active={active}
          onClick={() => navigate({ name: "project", id: p.id })}
          count={locked ? undefined : showProgress ? undefined : open || undefined}
          actions={
            locked ? (
              <Tooltip content="Locked - open it with a passkey" side="right">
                <span className="row faint" style={{ marginRight: 6 }}>
                  <Lock strokeWidth={1.75} size={13} />
                </span>
              </Tooltip>
            ) : showProgress && p.taskTotal > 0 ? (
              <Tooltip content={`${p.taskDone} of ${p.taskTotal} done`} side="right">
                <span className="row" style={{ marginRight: 6 }}>
                  <Ring value={progress} size={14} stroke={2} />
                </span>
              </Tooltip>
            ) : undefined
          }
        />
      </div>
    </ContextMenu>
  );
}

function FocusPill({ collapsed }: { collapsed: boolean }) {
  const focus = useFocus();
  const running = focus.phase === "running";
  const now = useNow(1000, focus.phase !== "idle");
  if (focus.phase === "idle") return null;
  const remaining = remainingOf(focus, now);
  const Icon = focus.kind === "focus" ? Timer : Coffee;
  const label = `${KIND_LABEL[focus.kind]}${running ? "" : " (paused)"}`;
  const pill = (
    <button type="button" className="focus-pill" onClick={() => navigate({ name: "focus" })} aria-label={label} style={collapsed ? { justifyContent: "center", padding: 0 } : undefined}>
      <Icon strokeWidth={1.75} />
      {!collapsed && (
        <>
          <span className="grow truncate" style={{ textAlign: "left" }}>
            {focus.taskTitle ?? KIND_LABEL[focus.kind]}
          </span>
          <span style={{ opacity: running ? 1 : 0.55 }}>{formatClock(remaining)}</span>
        </>
      )}
    </button>
  );
  return (
    <Tooltip content={`${label} · ${formatClock(remaining)}`} side="right" disabled={!collapsed}>
      {pill}
    </Tooltip>
  );
}
