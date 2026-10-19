/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// The main task list: sections, quick add, keyboard navigation,
// multi-selection, drag reordering and (for large lists) virtualisation.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { ContextMenu as CM } from "radix-ui";
import { ChevronDown, type LucideIcon } from "lucide-react";
import type { Task, TaskInput, TaskMeta } from "@/lib/types";
import { useLabelMap, useLabels, useProjectMap, useProjects } from "@/hooks/data";
import { useSetting } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useActiveSpace } from "@/features/cloud/store";
import { useMemberMap } from "@/features/cloud/members";
import { useToday } from "@/hooks/useToday";
import { TaskRow, type RowContext } from "./TaskRow";
import { taskMenu, openTask } from "./menu";
import { deleteTasks, duplicateTask, quickDates, reorderTasks, rescheduleTasks, toggleComplete, updateTasks } from "./actions";
import { QuickAdd } from "./QuickAdd";
import { BulkBar } from "./BulkBar";
import { isTextInput } from "@/lib/shortcuts";
import { AUTO_SCROLL, restrictToVertical } from "@/components/layout/sortable";
import { MenuContent } from "@/components/ui/Menu";
import { useFlip } from "@/hooks/useFlip";

export interface TaskSection {
  key: string;
  title?: ReactNode;
  icon?: LucideIcon;
  tasks: Task[];
  /** Defaults for tasks added in this section; omit to hide the add row. */
  addDefaults?: Partial<TaskInput>;
  collapsible?: boolean;
  actions?: ReactNode;
  /** Colour of a dot before the title (label groups). */
  color?: string;
  /** Nesting depth of the header (1 = a sub-group). */
  level?: number;
  /** The group this sub-group belongs to; hidden while that is collapsed. */
  parentKey?: string;
  /** Count shown in the header when it differs from `tasks` (a parent group). */
  count?: number;
}

export function useRowContext(opts: { hideProject?: boolean; meta?: Partial<TaskMeta> } = {}): RowContext {
  const { data: projects } = useProjects();
  const { data: labels } = useLabels();
  const projectMap = useProjectMap();
  const labelMap = useLabelMap();
  const globalMeta = useSetting("appearance.taskMeta");
  const meta = useMemo(() => (opts.meta ? { ...globalMeta, ...opts.meta } : globalMeta), [globalMeta, opts.meta]);
  const expanded = useSetting("appearance.taskRowStyle") === "expanded";
  const today = useToday();
  const selection = useUi((s) => s.selectedTaskIds);
  // Who wrote a task only means something where more than one person can:
  // in a personal or offline space every row would carry the same face.
  const space = useActiveSpace();
  const people = useMemberMap();
  const showCreator = meta.creator && space?.kind === "workspace";
  return useMemo(
    () => ({
      projects: projects ?? [],
      projectMap,
      labelMap,
      labels: labels ?? [],
      meta,
      expanded,
      hideProject: opts.hideProject,
      today,
      selection,
      people,
      showCreator,
    }),
    [projects, projectMap, labelMap, labels, meta, expanded, opts.hideProject, today, selection, people, showCreator],
  );
}

type FlatRow =
  | { type: "header"; section: TaskSection; collapsed: boolean }
  | { type: "task"; task: Task; section: TaskSection }
  | { type: "add"; section: TaskSection };

const VIRTUAL_THRESHOLD = 250;

export function TaskList({
  sections,
  sortable = false,
  hideProject,
  empty,
  quickAddPosition = "bottom",
  padding = "8px 12px 80px",
  meta,
}: {
  sections: TaskSection[];
  sortable?: boolean;
  hideProject?: boolean;
  /** Row properties for this list, over the Appearance settings. */
  meta?: Partial<TaskMeta>;
  empty?: ReactNode;
  quickAddPosition?: "top" | "bottom";
  padding?: string;
}) {
  const ctx = useRowContext({ hideProject, meta });
  const selection = useUi((s) => s.selectedTaskIds);
  const anchor = useUi((s) => s.selectionAnchor);
  const setSelection = useUi((s) => s.setSelection);
  const inspector = useUi((s) => s.inspector);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menuTask, setMenuTask] = useState<Task | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Local order override for immediate drag feedback until data refreshes.
  const [orderOverride, setOrderOverride] = useState<Record<string, string[]>>({});

  useEffect(() => setOrderOverride({}), [sections]);
  // Clear multi-selection when the list unmounts (navigating away).
  useEffect(() => () => useUi.getState().clearSelection(), []);

  const ordered = useMemo(
    () =>
      sections.map((s) => {
        const ov = orderOverride[s.key];
        if (!ov) return s;
        const byId = new Map(s.tasks.map((t) => [t.id, t]));
        return { ...s, tasks: ov.map((id) => byId.get(id)).filter(Boolean) as Task[] };
      }),
    [sections, orderOverride],
  );

  const rows: FlatRow[] = useMemo(() => {
    const out: FlatRow[] = [];
    for (const s of ordered) {
      if (s.parentKey && collapsed[s.parentKey]) continue;
      const isCollapsed = !!collapsed[s.key];
      if (s.title) out.push({ type: "header", section: s, collapsed: isCollapsed });
      if (s.addDefaults && quickAddPosition === "top" && !isCollapsed) out.push({ type: "add", section: s });
      if (!isCollapsed) for (const t of s.tasks) out.push({ type: "task", task: t, section: s });
      if (s.addDefaults && quickAddPosition === "bottom" && !isCollapsed) out.push({ type: "add", section: s });
    }
    return out;
  }, [ordered, collapsed, quickAddPosition]);

  const taskRows = useMemo(() => rows.filter((r) => r.type === "task") as Extract<FlatRow, { type: "task" }>[], [rows]);
  const allIds = useMemo(() => taskRows.map((r) => r.task.id), [taskRows]);
  const virtual = taskRows.length > VIRTUAL_THRESHOLD;
  // Neighbours glide into place when tasks leave or join (not for huge lists).
  useFlip(scrollRef, virtual ? null : sections, orderOverride);

  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.type === "header" ? 36 : 34),
    overscan: 12,
  });

  const scrollToTask = useCallback(
    (id: string) => {
      if (virtual) {
        const idx = rows.findIndex((r) => r.type === "task" && r.task.id === id);
        if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
      } else {
        scrollRef.current?.querySelector(`[data-task-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
      }
    },
    [virtual, rows, virtualizer],
  );

  const focusTask = (id: string, follow = true) => {
    setFocusedId(id);
    scrollToTask(id);
    // Keep an open inspector in sync with keyboard focus.
    if (follow && inspector?.kind === "task") useUi.getState().openInspector({ kind: "task", id });
  };

  const onRowClick = useCallback(
    (task: Task, e: React.MouseEvent) => {
      setFocusedId(task.id);
      scrollRef.current?.focus({ preventScroll: true });
      if (e.ctrlKey || e.metaKey) {
        const has = selection.includes(task.id);
        setSelection(has ? selection.filter((x) => x !== task.id) : [...selection, task.id], task.id);
        return;
      }
      if (e.shiftKey && (anchor || focusedId)) {
        const a = allIds.indexOf(anchor ?? focusedId!);
        const b = allIds.indexOf(task.id);
        if (a >= 0 && b >= 0) {
          setSelection(allIds.slice(Math.min(a, b), Math.max(a, b) + 1), anchor ?? focusedId);
          return;
        }
      }
      setSelection([], task.id);
      openTask(task.id);
    },
    [selection, anchor, focusedId, allIds, setSelection],
  );

  const targetIds = () => (selection.length ? selection : focusedId ? [focusedId] : []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTextInput(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const idx = focusedId ? allIds.indexOf(focusedId) : -1;
    const focusedTask = idx >= 0 ? taskRows[idx].task : null;
    const move = (delta: number) => {
      e.preventDefault();
      if (!allIds.length) return;
      const next = idx < 0 ? (delta > 0 ? 0 : allIds.length - 1) : Math.max(0, Math.min(allIds.length - 1, idx + delta));
      const id = allIds[next];
      if (e.shiftKey) {
        const a = allIds.indexOf(anchor ?? focusedId ?? id);
        setSelection(allIds.slice(Math.min(a, next), Math.max(a, next) + 1), anchor ?? focusedId ?? id);
      }
      focusTask(id, !e.shiftKey);
    };
    switch (e.key) {
      case "ArrowDown":
      case "j":
        return move(1);
      case "ArrowUp":
      case "k":
        return move(-1);
      case "Home":
        return move(-allIds.length);
      case "End":
        return move(allIds.length);
      case "Enter":
        if (focusedTask) {
          e.preventDefault();
          openTask(focusedTask.id);
        }
        return;
      case " ":
        e.preventDefault();
        if (selection.length > 1) void updateTasks(selection, { status: "completed" }, `Completed ${selection.length} tasks`);
        else if (focusedTask) void toggleComplete(focusedTask);
        return;
      case "x":
      case "X":
        if (focusedTask) {
          e.preventDefault();
          const has = selection.includes(focusedTask.id);
          setSelection(has ? selection.filter((x) => x !== focusedTask.id) : [...selection, focusedTask.id], focusedTask.id);
        }
        return;
      case "Escape":
        if (selection.length) {
          e.preventDefault();
          setSelection([], null);
        }
        return;
      case "Delete":
      case "Backspace": {
        const ids = targetIds();
        if (ids.length) {
          e.preventDefault();
          const nextFocus = allIds[Math.min(allIds.length - 1, idx + 1)];
          void deleteTasks(ids);
          setSelection([], null);
          if (nextFocus && !ids.includes(nextFocus)) setFocusedId(nextFocus);
        }
        return;
      }
    }
    if (mod && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      setSelection(allIds, allIds[0] ?? null);
      return;
    }
    if (mod && (e.key === "d" || e.key === "D") && focusedTask) {
      e.preventDefault();
      void duplicateTask(focusedTask.id);
      return;
    }
    if (mod || e.altKey) return;
    if (/^[0-4]$/.test(e.key)) {
      const ids = targetIds();
      if (ids.length) {
        e.preventDefault();
        void updateTasks(ids, { priority: Number(e.key) }, ids.length > 1 ? "Priority changed" : undefined);
      }
      return;
    }
    if (e.key === "t" || e.key === "T" || e.key === "m" || e.key === "M") {
      const ids = targetIds();
      if (ids.length) {
        e.preventDefault();
        const d = quickDates();
        void rescheduleTasks(ids, e.key.toLowerCase() === "t" ? d.today : d.tomorrow);
      }
    }
  };

  // Drag & drop (non-virtual lists only).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const section = ordered.find((s) => s.tasks.some((t) => t.id === e.active.id));
    if (!section || !section.tasks.some((t) => t.id === e.over!.id)) return;
    const ids = section.tasks.map((t) => t.id);
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    setOrderOverride((o) => ({ ...o, [section.key]: next }));
    void reorderTasks(next, ids, "list");
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest("[data-task-id]");
    const id = el?.getAttribute("data-task-id");
    const task = id ? taskRows.find((r) => r.task.id === id)?.task : null;
    if (!task) {
      e.preventDefault();
      setMenuTask(null);
      return;
    }
    setMenuTask(task);
    setFocusedId(task.id);
    if (!selection.includes(task.id)) setSelection([], task.id);
  };

  const totalTasks = sections.reduce((n, s) => n + s.tasks.length, 0);
  const hasAdd = sections.some((s) => s.addDefaults);

  const renderRow = (r: FlatRow, key: string | number, style?: React.CSSProperties, measure?: (el: HTMLElement | null) => void) => {
    if (r.type === "header") {
      const Icon = r.section.icon;
      return (
        <div key={key} style={style} ref={measure} data-index={typeof key === "number" ? key : undefined}>
          <div className="task-group-head" data-level={r.section.level || undefined}>
            {r.section.collapsible !== false && (
              <button
                type="button"
                className="row"
                style={{ gap: 6 }}
                onClick={() => setCollapsed((c) => ({ ...c, [r.section.key]: !c[r.section.key] }))}
                aria-expanded={!r.collapsed}
              >
                <ChevronDown size={14} style={{ transform: r.collapsed ? "rotate(-90deg)" : undefined, transition: "transform var(--t-hover)" }} />
                {Icon && <Icon />}
                {r.section.color && <span className="label-dot" style={{ width: 8, height: 8, background: r.section.color }} />}
                <span>{r.section.title}</span>
              </button>
            )}
            {r.section.collapsible === false && (
              <>
                {Icon && <Icon />}
                {r.section.color && <span className="label-dot" style={{ width: 8, height: 8, background: r.section.color }} />}
                <span>{r.section.title}</span>
              </>
            )}
            <span className="count">{r.section.count ?? r.section.tasks.length}</span>
            {r.section.actions && <div className="task-group-head__actions">{r.section.actions}</div>}
          </div>
        </div>
      );
    }
    if (r.type === "add") {
      return (
        <div key={key} style={style} ref={measure} data-index={typeof key === "number" ? key : undefined}>
          <QuickAdd defaults={r.section.addDefaults!} />
        </div>
      );
    }
    const t = r.task;
    if (sortable && !virtual) {
      return (
        <SortableRow key={t.id} task={t} ctx={ctx} focused={focusedId === t.id} selected={selection.includes(t.id)} onRowClick={onRowClick} />
      );
    }
    return (
      <div key={key} style={style} ref={measure} data-index={typeof key === "number" ? key : undefined}>
        <TaskRow
          task={t}
          ctx={ctx}
          focused={focusedId === t.id}
          selected={selection.includes(t.id)}
          onClick={(e) => onRowClick(t, e)}
        />
      </div>
    );
  };

  let body: ReactNode;
  if (virtual) {
    const items = virtualizer.getVirtualItems();
    body = (
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {items.map((vi) =>
          renderRow(rows[vi.index], vi.index, { position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }, virtualizer.measureElement),
        )}
      </div>
    );
  } else if (sortable) {
    body = (
      // The row only ever moves on the list's axis: a free horizontal transform
      // grows the scroller, which auto-scrolls, which lets it grow again.
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} modifiers={[restrictToVertical]} autoScroll={AUTO_SCROLL}>
        {ordered.map((s) => (
          <SortableContext key={s.key} items={s.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <div className="task-list__section">
              {rows.filter((r) => r.section.key === s.key).map((r, i) => renderRow(r, `${s.key}-${r.type}-${r.type === "task" ? r.task.id : i}`))}
            </div>
          </SortableContext>
        ))}
      </DndContext>
    );
  } else {
    body = ordered.map((s) => (
      <div key={s.key} className="task-list__section">
        {rows.filter((r) => r.section.key === s.key).map((r, i) => renderRow(r, `${s.key}-${r.type}-${r.type === "task" ? r.task.id : i}`))}
      </div>
    ));
  }

  return (
    <>
      <CM.Root modal={false}>
        <CM.Trigger asChild onContextMenu={onContextMenu}>
          <div
            ref={scrollRef}
            className="task-list page-body"
            role="listbox"
            aria-multiselectable
            tabIndex={0}
            onKeyDown={onKeyDown}
            style={{ padding }}
          >
            {body}
            {totalTasks === 0 && empty}
            {totalTasks === 0 && !empty && !hasAdd && <div className="empty">No tasks</div>}
          </div>
        </CM.Trigger>
        <CM.Portal>
          <CM.Content className="menu" collisionPadding={8}>
            {menuTask && <MenuContent kind="context" items={taskMenu(menuTask, { ...ctx, selection })} />}
          </CM.Content>
        </CM.Portal>
      </CM.Root>
      {selection.length > 1 && <BulkBar ids={selection} onClear={() => setSelection([], null)} />}
    </>
  );
}

function SortableRow({
  task,
  ctx,
  focused,
  selected,
  onRowClick,
}: {
  task: Task;
  ctx: RowContext;
  focused: boolean;
  selected: boolean;
  onRowClick: (t: Task, e: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <TaskRow
      rowRef={setNodeRef}
      task={task}
      ctx={ctx}
      focused={focused}
      selected={selected}
      dragging={isDragging}
      onClick={(e) => onRowClick(task, e)}
      dragHandle={{ ...attributes, ...listeners }}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
    />
  );
}
