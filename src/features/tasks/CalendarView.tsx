/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { ChevronLeft, ChevronRight, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { format } from "date-fns";
import type { CalEvent, Task } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/ipc";
import { useSetting } from "@/stores/settings";
import { useTasks } from "@/hooks/data";
import { useToday } from "@/hooks/useToday";
import { addMonthsStr, formatDue, formatTime, monthGrid, monthStartStr, parseDateStr, weekdayLabels, addDaysStr, isoWeekday } from "@/lib/dates";
import { layOutMonth, movedTo, type Bar } from "./spans";
import { IconButton, Button } from "@/components/ui/Button";
import { Popover, TaskCheck, TaskTitle, Switch } from "@/components/ui/Controls";
import { openTask } from "./menu";
import { toggleComplete, updateTask } from "./actions";
import { useUi } from "@/stores/ui";

/** How many lines of chips a cell has room for under the band of bars. */
const CELL_LINES = 4;
/** Lanes of bars a week row will give up to runs before they spill. */
const MAX_LANES = 3;

/**
 * The day under the pointer, not the cell the dragged thing happens to cover
 * most: a bar is as wide as the run it draws, so by area it would land on the
 * middle of itself.
 */
const collision: CollisionDetection = (args) => {
  const hit = pointerWithin(args);
  return hit.length ? hit : rectIntersection(args);
};

/** What a drag carries: the task, and where on the grid it was picked up. */
interface DragData {
  task: Task;
  /** The day a chip sits on, or undefined for one with no date. */
  day?: string;
  /** Set when a bar is being dragged, to work out which day was grabbed. */
  bar?: Bar;
}

function sortDay(a: Task, b: Task) {
  return (
    Number(a.status === "completed") - Number(b.status === "completed") ||
    (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99") ||
    b.priority - a.priority ||
    a.sortOrder - b.sortOrder
  );
}

/** A task on a single day: its own cell, the unscheduled tray or a popover. */
function CalChip({ task, day, overlay, still }: { task: Task; day?: string; overlay?: boolean; still?: boolean }) {
  const inert = overlay || still;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: inert ? `inert:${task.id}` : day ? `${task.id}@${day}` : task.id,
    data: { task, day } satisfies DragData,
    disabled: inert,
  });
  return (
    <div
      ref={inert ? undefined : setNodeRef}
      {...(inert ? {} : attributes)}
      {...(inert ? {} : listeners)}
      className="cal-task"
      data-done={task.status === "completed"}
      style={{ opacity: isDragging && !overlay ? 0.35 : 1, boxShadow: overlay ? "var(--shadow-md)" : undefined }}
      onClick={(e) => {
        e.stopPropagation();
        openTask(task.id);
      }}
      title={task.title}
    >
      <TaskCheck checked={task.status === "completed"} onToggle={() => void toggleComplete(task)} priority={task.priority} cancelled={!!task.resolution} />
      {task.dueTime && <span className="faint tabular">{formatTime(task.dueTime)}</span>}
      <TaskTitle title={task.title} done={task.status === "completed"} />
    </div>
  );
}

/**
 * A run of days, as one element spanning its columns of a week row. The two
 * ends are square where the run carries on past them — into the row below,
 * or off the grid — so a long task reads as one continuous bar.
 */
function CalBar({ bar }: { bar: Bar }) {
  const { task } = bar;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${task.id}@${bar.from}`,
    data: { task, day: bar.from, bar } satisfies DragData,
  });
  const done = task.status === "completed";
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className="cal-bar"
      data-done={done}
      data-open-left={bar.openLeft || undefined}
      data-open-right={bar.openRight || undefined}
      style={{ gridColumn: `${bar.col + 1} / span ${bar.span}`, gridRow: bar.lane + 1, opacity: isDragging ? 0.35 : 1 }}
      onClick={(e) => {
        e.stopPropagation();
        openTask(task.id);
      }}
      title={`${task.title} · ${formatDue(task.startDate)} – ${formatDue(task.dueDate)}`}
    >
      <TaskCheck checked={done} onToggle={() => void toggleComplete(task)} priority={task.priority} cancelled={!!task.resolution} />
      <TaskTitle title={task.title} done={done} />
    </div>
  );
}

function CalEventChip({ e }: { e: CalEvent }) {
  return (
    <div className="cal-event" style={{ ["--event" as string]: e.color ?? "var(--hue-3)" }} title={`${e.title}${e.location ? ` · ${e.location}` : ""} (${e.feedName})`}>
      {!e.allDay && <span className="faint tabular">{formatTime(e.start.slice(11, 16))}</span>}
      <span className="truncate">{e.title}</span>
    </div>
  );
}

function DayCell({
  day,
  tasks,
  events,
  month,
  today,
  lines,
}: { day: string; tasks: Task[]; events: CalEvent[]; month: number; today: string; lines: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${day}` });
  const d = parseDateStr(day);
  const total = events.length + tasks.length;
  // The "+n more" button takes a line of its own, so it only appears when
  // something would otherwise be cut off.
  const room = total > lines ? Math.max(0, lines - 1) : lines;
  const shownEvents = events.slice(0, room);
  const shownTasks = tasks.slice(0, Math.max(0, room - shownEvents.length));
  const more = total - shownEvents.length - shownTasks.length;
  return (
    <div
      ref={setNodeRef}
      className="cal__cell"
      data-outside={d.getMonth() !== month}
      data-weekend={isoWeekday(day) >= 6 || undefined}
      data-today={day === today}
      data-over={isOver || undefined}
      onDoubleClick={() => useUi.getState().openCapture("task", { dueDate: day })}
    >
      <div className="cal__date">
        <b>{d.getDate() === 1 ? format(d, "d MMM") : d.getDate()}</b>
      </div>
      <div className="cal__tasks">
        {shownEvents.map((e) => (
          <CalEventChip key={`${e.feedId}:${e.uid}:${e.start}`} e={e} />
        ))}
        {shownTasks.map((t) => (
          <CalChip key={t.id} task={t} day={day} />
        ))}
        {more > 0 && (
          <Popover trigger={<button type="button" className="cal__more">+{more} more</button>} pad>
            <div className="col" style={{ gap: 2, width: 260 }}>
              <div className="section-title" style={{ marginBottom: 4 }}>
                {formatDue(day, null, today)}
              </div>
              {events.map((e) => (
                <CalEventChip key={`${e.feedId}:${e.uid}:${e.start}`} e={e} />
              ))}
              {tasks.map((t) => (
                <CalChip key={t.id} task={t} still />
              ))}
            </div>
          </Popover>
        )}
      </div>
    </div>
  );
}

function Unscheduled({ tasks }: { tasks: Task[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: "day:none" });
  return (
    <aside ref={setNodeRef} className="cal-tray" data-over={isOver || undefined}>
      <div className="section-title" style={{ padding: "10px 12px 6px" }}>
        Unscheduled <span className="count">{tasks.length}</span>
      </div>
      <div className="col" style={{ gap: 2, padding: "0 8px 12px", overflowY: "auto" }}>
        {tasks.map((t) => (
          <CalChip key={t.id} task={t} />
        ))}
        {!tasks.length && <div className="faint" style={{ fontSize: "var(--fs-xs)", padding: "4px 4px" }}>Drag a task here to remove its date.</div>}
      </div>
    </aside>
  );
}

export default function CalendarView() {
  const today = useToday();
  const [month, setMonth] = useState(() => monthStartStr(today));
  const [showDone, setShowDone] = useState(false);
  const [showTray, setShowTray] = useState(true);
  const [dragging, setDragging] = useState<Task | null>(null);
  // The day a drag was picked up by, worked out from where in a bar the
  // pointer went down. Read once, at the drop.
  const grabbed = useRef<string | undefined>(undefined);
  const days = useMemo(() => monthGrid(month), [month]);
  const { data: tasks } = useTasks({
    dueFrom: days[0],
    dueTo: days[days.length - 1],
    // A run across the whole month belongs on it even if neither end is.
    dueOverlap: true,
    topLevelOnly: true,
    includeCompleted: showDone,
    order: "due",
  });
  const { data: undated } = useTasks({ hasDue: false, topLevelOnly: true, limit: 100, order: "priority" }, { enabled: showTray });
  const showEvents = useSetting("calendar.showEvents");
  const { data: events } = useQuery({
    queryKey: ["calendar", "events", days[0], days[days.length - 1]],
    queryFn: () => api.calendar.events(days[0], days[days.length - 1]),
    enabled: showEvents,
    staleTime: 60_000,
  });
  const eventsByDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of events ?? []) {
      // Multi-day events show on each of their days.
      let d = e.start.slice(0, 10);
      const last = e.end.slice(0, 10);
      for (let i = 0; i < 62 && d <= last; i++) {
        if (!m.has(d)) m.set(d, []);
        m.get(d)!.push(e);
        d = addDaysStr(d, 1);
      }
    }
    return m;
  }, [events]);
  // A task with a start date earlier than its due date is a run of days, not
  // a point: it's drawn as one bar per week row, in a band above the day's
  // own chips, holding the same lane for its whole length.
  const { weeks, byDay, overflow } = useMemo(() => layOutMonth(tasks ?? [], days, sortDay, MAX_LANES), [tasks, days]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragStart = (e: DragStartEvent) => {
    const from = e.active.data.current as DragData;
    setDragging(from.task);
    grabbed.current = from.day;
    // A bar covers several days with one element, so which of them was
    // grabbed comes from where across it the pointer went down — otherwise a
    // five-day bar held by the middle would jump its start to the cursor.
    const rect = e.active.rect.current.initial;
    const x = (e.activatorEvent as Partial<PointerEvent>).clientX;
    if (from.bar && rect && typeof x === "number" && rect.width > 0) {
      const i = Math.floor(((x - rect.left) / rect.width) * from.bar.span);
      grabbed.current = addDaysStr(from.bar.from, Math.min(from.bar.span - 1, Math.max(0, i)));
    }
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const task = (e.active.data.current as DragData | undefined)?.task;
    const target = e.over?.id ? String(e.over.id).slice(4) : null;
    const from = grabbed.current;
    grabbed.current = undefined;
    if (!task || target === null) return;
    if (target === "none") {
      void updateTask(task.id, { dueDate: null, dueTime: null, startDate: null }, { undoLabel: "Date removed" });
      return;
    }
    // Dragging a run moves the whole thing, so its length survives the move.
    const next = movedTo(task, from, target);
    if (!next) return;
    void updateTask(task.id, next, { undoLabel: `Moved to ${formatDue(next.startDate ?? next.dueDate)}` });
  };
  const monthIdx = parseDateStr(month).getMonth();

  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="toolbar">
        <span style={{ fontWeight: 600, minWidth: 130 }}>{format(parseDateStr(month), "MMMM yyyy")}</span>
        <IconButton icon={ChevronLeft} label="Previous month" size="sm" onClick={() => setMonth(addMonthsStr(month, -1))} />
        <IconButton icon={ChevronRight} label="Next month" size="sm" onClick={() => setMonth(addMonthsStr(month, 1))} />
        <Button size="sm" variant="ghost" onClick={() => setMonth(monthStartStr(today))}>
          Today
        </Button>
        <span className="spacer" />
        <label className="row" style={{ gap: 8, fontSize: "var(--fs-sm)", color: "var(--text-2)" }}>
          Completed
          <Switch checked={showDone} onChange={setShowDone} label="Show completed" />
        </label>
        <IconButton
          icon={showTray ? PanelRightClose : PanelRightOpen}
          label={showTray ? "Hide unscheduled" : "Show unscheduled"}
          size="sm"
          onClick={() => setShowTray(!showTray)}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div className="cal" style={{ flex: 1, minWidth: 0 }}>
          <div className="cal__head">
            {weekdayLabels().map((d) => (
              <div key={d} className="cal__dow">
                {d}
              </div>
            ))}
          </div>
          <div className="cal__grid">
            {weeks.map((w) => (
              <div key={w.days[0]} className="cal__week" style={{ ["--lanes" as string]: w.lanes } as CSSProperties}>
                {w.days.map((d) => (
                  <DayCell
                    key={d}
                    day={d}
                    tasks={[...(overflow.get(d) ?? []), ...(byDay.get(d) ?? [])]}
                    events={eventsByDay.get(d) ?? []}
                    month={monthIdx}
                    today={today}
                    lines={Math.max(1, CELL_LINES - w.lanes)}
                  />
                ))}
                {!!w.bars.length && (
                  <div className="cal__band">
                    {w.bars.map((b) => (
                      <CalBar key={b.task.id} bar={b} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        {showTray && <Unscheduled tasks={undated ?? []} />}
      </div>
      <DragOverlay dropAnimation={null}>{dragging && <CalChip task={dragging} overlay />}</DragOverlay>
    </DndContext>
  );
}
