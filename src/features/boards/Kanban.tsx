/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Generic Kanban: sortable columns and cards across columns, with optimistic
// local ordering, a drag overlay that tracks the pointer exactly, keyboard
// dragging, collapsible/resizable columns, WIP limits and inline adding.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCorners,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { ChevronsLeftRight, Ellipsis, Maximize2, ListChecks, Paperclip, Plus, Repeat, TriangleAlert, Flag, GitBranch } from "lucide-react";
import type { Label, Project, Task, TaskStatus } from "@/lib/types";
import { TaskCheck, TaskTitle } from "@/components/ui/Controls";
import { IconButton } from "@/components/ui/Button";
import { ContextMenu, Dropdown, type MenuItems } from "@/components/ui/Menu";
import { DueLabel } from "@/features/tasks/TaskRow";
import { PriorityIcon, PRIORITY_LABELS } from "@/features/tasks/meta";
import { toggleComplete, updateTask } from "@/features/tasks/actions";
import { openTask, taskMenu } from "@/features/tasks/menu";
import { LabelChip } from "@/features/tasks/labels";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { GithubMark } from "@/features/github/shared";
import { getSetting } from "@/stores/settings";
import { confettiAtRect } from "@/lib/confetti";

export interface KanbanColumn {
  id: string;
  title: string;
  status?: TaskStatus | null;
  wipLimit?: number | null;
  collapsed?: boolean;
  width?: number | null;
}

export interface CardContext {
  projects: Project[];
  projectMap: Map<string, Project>;
  labels: Label[];
  labelMap: Map<string, Label>;
  hidden: Set<string>;
  showProject: boolean;
  today: string;
  /** Opt-in details shown on cards (e.g. "milestone", "branch"). */
  optIn?: Set<string>;
  milestoneTitles?: Map<string, string>;
}

export function between(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 1;
  if (a === undefined) return b! - 1;
  if (b === undefined) return a + 1;
  return (a + b) / 2;
}

const COL_PREFIX = "col:";

/** Confetti for a card that just crossed the finish line, if it's switched on. */
const celebrate = (rect: { left: number; top: number; width: number; height: number } | null | undefined) => {
  if (getSetting("boards.celebrate")) confettiAtRect(rect);
};

// ----------------------------------------------------------------- card

const KanbanCard = memo(function KanbanCard({
  task,
  ctx,
  ghost,
  overlay,
  dragProps,
  setRef,
  style,
}: {
  task: Task;
  ctx: CardContext;
  ghost?: boolean;
  overlay?: boolean;
  dragProps?: Record<string, unknown>;
  setRef?: (el: HTMLElement | null) => void;
  style?: CSSProperties;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const done = task.status === "completed";
  const show = (k: string) => !ctx.hidden.has(k);
  const labels = show("labels") ? (task.labelIds.map((id) => ctx.labelMap.get(id)).filter(Boolean) as Label[]) : [];
  const project = ctx.showProject && task.projectId ? ctx.projectMap.get(task.projectId) : undefined;
  const desc = show("description") && task.description ? task.description.replace(/[#*>`[\]]/g, "").trim() : "";
  const milestone = ctx.optIn?.has("milestone") && task.milestoneId ? ctx.milestoneTitles?.get(task.milestoneId) : undefined;
  const branch = ctx.optIn?.has("branch") ? task.devLinks?.find((l) => l.kind === "branch")?.ref : undefined;

  const commit = () => {
    setEditing(false);
    const v = title.trim();
    if (v && v !== task.title) void updateTask(task.id, { title: v }, { undoable: true });
    else setTitle(task.title);
  };

  const card = (
    <div
      ref={setRef}
      className="kcard"
      data-done={done}
      data-ghost={ghost || undefined}
      data-overlay={overlay || undefined}
      style={style}
      {...(editing ? {} : dragProps)}
      onClick={() => !editing && openTask(task.id)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setTitle(task.title);
        setEditing(true);
      }}
      data-task-id={task.id}
    >
      <div className="kcard__title-row">
        <TaskCheck
          checked={done}
          onToggle={(e) => {
            if (!done) celebrate(e?.currentTarget.getBoundingClientRect());
            void toggleComplete(task);
          }}
          priority={task.priority}
          blocked={task.status === "blocked" || !!task.blockedBy}
          cancelled={!!task.resolution}
        />
        {editing ? (
          <textarea
            className="kcard__title-input"
            autoFocus
            rows={2}
            value={title}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                setTitle(task.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="kcard__title">
            <TaskTitle title={task.title} done={done} wrap />
          </span>
        )}
      </div>
      {desc && <div className="kcard__desc">{desc}</div>}
      {(labels.length > 0 ||
        (show("due") && task.dueDate) ||
        (show("priority") && task.priority > 0) ||
        (show("subtasks") && task.subtaskCount > 0) ||
        task.attachmentCount > 0 ||
        task.recurrence ||
        task.issue ||
        project) && (
        <div className="kcard__meta">
          {show("priority") && task.priority > 0 && !done && (
            <span title={PRIORITY_LABELS[task.priority]}>
              <PriorityIcon priority={task.priority} size={12} />
            </span>
          )}
          {show("due") && <DueLabel date={task.dueDate} time={task.dueTime} done={done} today={ctx.today} />}
          {show("subtasks") && task.subtaskCount > 0 && (
            <span>
              <ListChecks />
              {task.subtaskDone}/{task.subtaskCount}
            </span>
          )}
          {task.attachmentCount > 0 && (
            <span>
              <Paperclip />
              {task.attachmentCount}
            </span>
          )}
          {task.recurrence && (
            <span>
              <Repeat />
            </span>
          )}
          {task.issue && (
            <span title={`${task.issue.repo}#${task.issue.number}`}>
              <GithubMark size={11} />#{task.issue.number}
            </span>
          )}
          {milestone && (
            <span className="truncate" style={{ maxWidth: 120 }} title={`Milestone: ${milestone}`}>
              <Flag />
              {milestone}
            </span>
          )}
          {branch && (
            <span className="truncate mono" style={{ maxWidth: 140 }} title={`Branch: ${branch}`}>
              <GitBranch />
              {branch}
            </span>
          )}
          {project && (
            <span className="truncate" style={{ maxWidth: 120 }}>
              <ProjectGlyph project={project} size={12} />
              <span className="truncate">{project.name}</span>
            </span>
          )}
          {labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
        </div>
      )}
      {!overlay && !editing && (
        <div className="kcard__actions" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <Dropdown items={() => taskMenu(task, { projects: ctx.projects, labels: ctx.labels, hideProject: !ctx.showProject })} align="end">
            <IconButton icon={Ellipsis} label="Card actions" size="sm" noTooltip />
          </Dropdown>
        </div>
      )}
    </div>
  );
  if (overlay) return card;
  return (
    <ContextMenu items={() => taskMenu(task, { projects: ctx.projects, labels: ctx.labels, hideProject: !ctx.showProject })}>
      {card}
    </ContextMenu>
  );
});

function SortableCard({ task, ctx }: { task: Task; ctx: CardContext }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: "card" },
  });
  // The card is also the activator, so Enter/Space only start a keyboard
  // drag when the card itself is focused - not when pressed in its menu
  // (portaled, but React still bubbles the key to the card) or checkbox.
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      setNodeRef(el);
      setActivatorNodeRef(el);
    },
    [setNodeRef, setActivatorNodeRef],
  );
  return (
    <KanbanCard
      task={task}
      ctx={ctx}
      ghost={isDragging}
      setRef={setRef}
      dragProps={{ ...attributes, ...listeners }}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
    />
  );
}

// ---------------------------------------------------------------- column

function AddCard({ onAdd, onCompose }: { onAdd: (title: string) => Promise<void> | void; onCompose?: (title: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const compose = onCompose && (
    <IconButton
      icon={Maximize2}
      label="New card with details"
      size="sm"
      className="kcol__compose"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onCompose(text.trim());
        setText("");
        setOpen(false);
      }}
    />
  );
  if (!open)
    return (
      <div className="kcol__add">
        <button type="button" className="kcol__add-btn" onClick={() => setOpen(true)}>
          <Plus strokeWidth={1.75} />
          Add card
        </button>
        {compose}
      </div>
    );
  return (
    <div className="kcol__add">
      <textarea
        className="textarea"
        autoFocus
        placeholder="Card title - try “tomorrow p2”"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => !text.trim() && setOpen(false)}
        onKeyDown={async (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const v = text.trim();
            if (!v) return;
            setText("");
            await onAdd(v);
          } else if (e.key === "Escape") {
            setText("");
            setOpen(false);
          }
        }}
      />
      {compose}
    </div>
  );
}

function ColumnView({
  col,
  tasks,
  ctx,
  menu,
  onToggleCollapse,
  onRename,
  onAdd,
  onCompose,
  onResize,
  lanes,
  defaultWidth,
}: {
  col: KanbanColumn;
  tasks: Task[];
  ctx: CardContext;
  menu?: MenuItems;
  onToggleCollapse?: () => void;
  onRename?: (name: string) => void;
  onAdd?: (title: string) => Promise<void> | void;
  onCompose?: (title: string) => void;
  onResize?: (width: number) => void;
  lanes: boolean;
  defaultWidth: number;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: COL_PREFIX + col.id,
    data: { type: "column" },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `drop:${col.id}`, data: { type: "column-body", columnId: col.id } });
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(col.title);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const width = liveWidth ?? col.width ?? defaultWidth;
  const overLimit = !!col.wipLimit && tasks.filter((t) => t.status !== "completed").length > col.wipLimit;
  const style: CSSProperties = {
    transform: DndCSS.Translate.toString(transform),
    transition,
    ["--col-w" as string]: `${width}px`,
  };

  if (col.collapsed) {
    return (
      <div
        ref={setNodeRef}
        data-col-id={col.id}
        className="kcol kcol--collapsed"
        style={style}
        onClick={onToggleCollapse}
        aria-label={`Expand ${col.title}`}
        {...attributes}
        {...listeners}
      >
        <span className="kcol__count">{tasks.length}</span>
        <span className="kcol__vname">{col.title}</span>
        <div ref={setDropRef} style={{ position: "absolute", inset: 0 }} />
      </div>
    );
  }

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.max(200, Math.min(560, startW + ev.clientX - startX));
      setLiveWidth(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLiveWidth(null);
      onResize?.(Math.round(w));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  let lastLane = -1;
  return (
    <div ref={setNodeRef} className="kcol" style={style} data-col-id={col.id} data-dragging={isDragging || undefined} data-over={isOver || undefined}>
      <div ref={setActivatorNodeRef} className="kcol__head" {...attributes} {...listeners} onDoubleClick={() => onRename && setRenaming(true)}>
        {renaming ? (
          <input
            className="input kcol__name-input"
            autoFocus
            value={name}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setName(col.title);
                setRenaming(false);
              }
            }}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setRenaming(false);
              if (name.trim() && name.trim() !== col.title) onRename?.(name.trim());
              else setName(col.title);
            }}
          />
        ) : (
          <span className="kcol__name">{col.title}</span>
        )}
        <span className="kcol__count" data-over-limit={overLimit || undefined} title={col.wipLimit ? `WIP limit ${col.wipLimit}` : undefined}>
          {overLimit && <TriangleAlert />}
          {col.wipLimit ? `${tasks.filter((t) => t.status !== "completed").length}/${col.wipLimit}` : tasks.length}
        </span>
        <span className="spacer" />
        {onToggleCollapse && <IconButton icon={ChevronsLeftRight} label="Collapse column" size="sm" onClick={onToggleCollapse} />}
        {menu && (
          <Dropdown items={menu} align="end">
            <IconButton icon={Ellipsis} label="Column actions" size="sm" noTooltip />
          </Dropdown>
        )}
      </div>
      <div ref={setDropRef} className="kcol__body">
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((t) => {
            const laneHead = lanes && t.priority !== lastLane;
            lastLane = t.priority;
            return (
              <div key={t.id} style={{ display: "contents" }}>
                {laneHead && <div className="kcol__lane">{PRIORITY_LABELS[t.priority]}</div>}
                <SortableCard task={t} ctx={ctx} />
              </div>
            );
          })}
        </SortableContext>
      </div>
      {onAdd && <AddCard onAdd={onAdd} onCompose={onCompose} />}
      {onResize && <div className="resize-handle kcol-resize" onPointerDown={startResize} onDoubleClick={() => onResize(defaultWidth)} />}
    </div>
  );
}

// ---------------------------------------------------------------- board

export function Kanban({
  columns,
  tasks,
  columnOf,
  orderOf,
  ctx,
  onMove,
  onReorderColumns,
  columnMenu,
  onToggleCollapse,
  onRenameColumn,
  onAddCard,
  onComposeCard,
  onResizeColumn,
  sortMode = "manual",
  groupBy = "none",
  density = "compact",
  background = "plain",
  defaultWidth = 288,
  trailing,
}: {
  columns: KanbanColumn[];
  tasks: Task[];
  columnOf: (t: Task) => string;
  orderOf: (t: Task) => number;
  ctx: CardContext;
  onMove: (task: Task, toColumn: KanbanColumn, order: number) => void;
  onReorderColumns?: (ids: string[]) => void;
  columnMenu?: (col: KanbanColumn) => MenuItems;
  onToggleCollapse?: (col: KanbanColumn) => void;
  onRenameColumn?: (col: KanbanColumn, name: string) => void;
  onAddCard?: (col: KanbanColumn, title: string) => Promise<void> | void;
  /** Opens the full composer for a column (placement comes from the column). */
  onComposeCard?: (col: KanbanColumn, title: string) => void;
  onResizeColumn?: (col: KanbanColumn, width: number) => void;
  sortMode?: "manual" | "due" | "priority" | "created" | "title";
  groupBy?: "none" | "priority";
  density?: "compact" | "expanded";
  background?: string;
  defaultWidth?: number;
  trailing?: React.ReactNode;
}) {
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const sortKey = groupBy === "priority" ? "priority" : sortMode;

  const derive = () => {
    const out: Record<string, string[]> = {};
    for (const c of columns) out[c.id] = [];
    const fallback = columns[0]?.id;
    for (const t of tasks) {
      const c = columnOf(t);
      (out[c] ?? (fallback ? out[fallback] : undefined))?.push(t.id);
    }
    for (const c of Object.keys(out)) {
      out[c].sort((a, b) => {
        const ta = taskById.get(a)!;
        const tb = taskById.get(b)!;
        switch (sortKey) {
          case "due":
            return (ta.dueDate ?? "9999").localeCompare(tb.dueDate ?? "9999") || orderOf(ta) - orderOf(tb);
          case "priority":
            return tb.priority - ta.priority || orderOf(ta) - orderOf(tb);
          case "created":
            return tb.createdAt - ta.createdAt;
          case "title":
            return ta.title.localeCompare(tb.title);
          default:
            return orderOf(ta) - orderOf(tb);
        }
      });
    }
    return out;
  };

  const [items, setItems] = useState<Record<string, string[]>>(derive);
  const [colOrder, setColOrder] = useState<string[]>(() => columns.map((c) => c.id));
  const [activeId, setActiveId] = useState<string | null>(null);
  const dragging = useRef(false);
  const startContainer = useRef<string | null>(null);

  useEffect(() => {
    if (!dragging.current) {
      setItems(derive());
      setColOrder(columns.map((c) => c.id));
    }
  }, [tasks, columns, sortKey]);

  const findContainer = (id: string): string | null => {
    if (id.startsWith(COL_PREFIX)) return id.slice(COL_PREFIX.length);
    if (id.startsWith("drop:")) return id.slice(5);
    return Object.keys(items).find((c) => items[c].includes(id)) ?? null;
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const collision: CollisionDetection = (args) => {
    const active = String(args.active.id);
    if (active.startsWith(COL_PREFIX)) {
      return closestCorners({
        ...args,
        droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith(COL_PREFIX)),
      });
    }
    const cards = args.droppableContainers.filter((c) => !String(c.id).startsWith(COL_PREFIX));
    const within = pointerWithin({ ...args, droppableContainers: cards });
    if (within.length) {
      // Prefer a card under the pointer over the column body.
      const card = within.find((c) => !String(c.id).startsWith("drop:"));
      return card ? [card] : within;
    }
    return rectIntersection({ ...args, droppableContainers: cards });
  };

  const onDragStart = (e: DragStartEvent) => {
    dragging.current = true;
    setActiveId(String(e.active.id));
    startContainer.current = findContainer(String(e.active.id));
  };

  const onDragOver = (e: DragOverEvent) => {
    const active = String(e.active.id);
    if (active.startsWith(COL_PREFIX) || !e.over) return;
    const over = String(e.over.id);
    const from = findContainer(active);
    const to = findContainer(over);
    if (!from || !to || from === to) return;
    setItems((prev) => {
      const fromItems = prev[from].filter((x) => x !== active);
      const toItems = [...prev[to]];
      const overIdx = toItems.indexOf(over);
      const idx = overIdx >= 0 ? overIdx : toItems.length;
      toItems.splice(idx, 0, active);
      return { ...prev, [from]: fromItems, [to]: toItems };
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const active = String(e.active.id);
    setActiveId(null);
    const over = e.over ? String(e.over.id) : null;
    if (active.startsWith(COL_PREFIX)) {
      dragging.current = false;
      if (over && over !== active && over.startsWith(COL_PREFIX)) {
        const a = colOrder.indexOf(active.slice(COL_PREFIX.length));
        const b = colOrder.indexOf(over.slice(COL_PREFIX.length));
        const next = arrayMove(colOrder, a, b);
        setColOrder(next);
        onReorderColumns?.(next);
      }
      return;
    }
    const container = findContainer(active);
    if (!container) {
      dragging.current = false;
      return;
    }
    let list = items[container];
    const oldIdx = list.indexOf(active);
    if (over && !over.startsWith("drop:") && container === findContainer(over) && sortKey === "manual") {
      const overIdx = list.indexOf(over);
      if (overIdx >= 0 && overIdx !== oldIdx) {
        list = arrayMove(list, oldIdx, overIdx);
        setItems((p) => ({ ...p, [container]: list }));
      }
    }
    const task = taskById.get(active);
    const col = columns.find((c) => c.id === container);
    dragging.current = false;
    if (!task || !col) return;
    const idx = list.indexOf(active);
    const moved = container !== startContainer.current;
    if (!moved && sortKey !== "manual") return;
    const prev = idx > 0 ? taskById.get(list[idx - 1]) : undefined;
    const next = idx < list.length - 1 ? taskById.get(list[idx + 1]) : undefined;
    const order =
      sortKey === "manual"
        ? between(prev ? orderOf(prev) : undefined, next ? orderOf(next) : undefined)
        : Math.max(0, ...list.map((id) => (taskById.get(id) ? orderOf(taskById.get(id)!) : 0))) + 1;
    if (!moved && order === orderOf(task)) return;
    if (moved && col.status === "completed" && task.status !== "completed") celebrate(e.active.rect.current.translated);
    onMove(task, col, order);
  };

  const orderedCols = colOrder.map((id) => columns.find((c) => c.id === id)).filter(Boolean) as KanbanColumn[];
  const activeTask = activeId && !activeId.startsWith(COL_PREFIX) ? taskById.get(activeId) : undefined;
  const activeCol = activeId?.startsWith(COL_PREFIX) ? columns.find((c) => COL_PREFIX + c.id === activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        dragging.current = false;
        setActiveId(null);
        setItems(derive());
      }}
    >
      <div className="kanban" data-density={density} data-bg={background}>
        <SortableContext items={orderedCols.map((c) => COL_PREFIX + c.id)} strategy={horizontalListSortingStrategy}>
          {orderedCols.map((c) => (
            <ColumnView
              key={c.id}
              col={c}
              tasks={(items[c.id] ?? []).map((id) => taskById.get(id)).filter(Boolean) as Task[]}
              ctx={{ ...ctx, hidden: density === "compact" ? new Set([...ctx.hidden, "description"]) : ctx.hidden }}
              menu={columnMenu?.(c)}
              onToggleCollapse={onToggleCollapse ? () => onToggleCollapse(c) : undefined}
              onRename={onRenameColumn ? (n) => onRenameColumn(c, n) : undefined}
              onAdd={onAddCard ? (title) => onAddCard(c, title) : undefined}
              onCompose={onComposeCard ? (title) => onComposeCard(c, title) : undefined}
              onResize={onResizeColumn ? (w) => onResizeColumn(c, w) : undefined}
              lanes={groupBy === "priority"}
              defaultWidth={defaultWidth}
            />
          ))}
        </SortableContext>
        {trailing}
      </div>
      <DragOverlay dropAnimation={{ duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
        {activeTask && <KanbanCard task={activeTask} ctx={ctx} overlay />}
        {activeCol && (
          <div className="kcol" style={{ ["--col-w" as string]: `${activeCol.width ?? defaultWidth}px`, boxShadow: "var(--shadow-pop)", height: 120 }}>
            <div className="kcol__head">
              <span className="kcol__name">{activeCol.title}</span>
            </div>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
