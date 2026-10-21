/**
 * @Author Christian Relf
 * @Date 2026-10-19
 */

// Laying tasks out on the month grid. A task with a start date earlier than
// its due date covers a run of days rather than a point: it's drawn as one
// bar per week row, spanning every column between its two ends, in a band
// above everything else in those cells. Anything else sits on its due date.
//
// A run holds one lane for its whole length, so a bar never steps up or down
// a row as it crosses a week boundary or passes another run — which is what
// makes a long task readable as one thing. A week row reserves only the
// lanes it actually uses, and runs past the last lane fall back to the day
// cells' overflow rather than deepening the band.
//
// Pure, so the arithmetic — packing lanes, clipping to the grid, cutting a
// bar at the end of a week row — can be tested without a calendar on screen.

import type { Task } from "@/lib/types";
import { addDaysStr, diffDays } from "@/lib/dates";

/** One week row's piece of a run, drawn as a single element. */
export interface Bar {
  task: Task;
  /** The first day of the run shown in this row. */
  from: string;
  /** Column of `from` within the row, 0–6. */
  col: number;
  /** Columns the bar covers in this row, 1–7. */
  span: number;
  /** The run's lane in the band, the same in every row it crosses. */
  lane: number;
  /** The run carries on past this row's piece, so that end is left open. */
  openLeft: boolean;
  openRight: boolean;
}

export interface Week {
  /** The row's seven days, in order. */
  days: string[];
  /** The row's bars, ordered by lane then column. */
  bars: Bar[];
  /** Lanes the band takes up in this row — 0 when nothing runs through it. */
  lanes: number;
}

export interface MonthLayout {
  weeks: Week[];
  /** Single-day tasks by due date, in `sortDay` order. */
  byDay: Map<string, Task[]>;
  /** Runs that didn't fit the band, listed against every day they cover. */
  overflow: Map<string, Task[]>;
}

/** True when a task covers a run of days rather than a single due date. */
export function spans(t: Task): boolean {
  return !!t.startDate && !!t.dueDate && t.startDate < t.dueDate;
}

function push<T>(m: Map<string, T[]>, key: string, value: T) {
  const list = m.get(key);
  if (list) list.push(value);
  else m.set(key, [value]);
}

/**
 * Splits `tasks` across `days` — a month grid of whole weeks, in order.
 * `sortDay` orders the single-day tasks within a cell; `maxLanes` caps how
 * deep the band of bars may grow before a run spills into the cells.
 */
export function layOutMonth(tasks: Task[], days: string[], sortDay: (a: Task, b: Task) => number, maxLanes = 3): MonthLayout {
  const first = days[0];
  const last = days[days.length - 1];
  const byDay = new Map<string, Task[]>();
  const overflow = new Map<string, Task[]>();
  const runs: { task: Task; from: string; to: string }[] = [];
  for (const t of tasks) {
    if (!t.dueDate) continue;
    if (!spans(t)) {
      if (t.dueDate >= first && t.dueDate <= last) push(byDay, t.dueDate, t);
      continue;
    }
    // Clipped to the grid: a run can reach in from either side of the month.
    const from = t.startDate! < first ? first : t.startDate!;
    const to = t.dueDate! > last ? last : t.dueDate!;
    if (from > to) continue;
    runs.push({ task: t, from, to });
  }
  // Earliest first, and the longer of two starting together above the other,
  // so the long runs settle at the top of the band and the short ones fill in
  // beneath them.
  runs.sort((a, b) => a.from.localeCompare(b.from) || b.to.localeCompare(a.to) || a.task.id.localeCompare(b.task.id));
  // First fit: a lane is free for a run when its last occupant ended before
  // the run starts, which holds because the runs arrive in order of start.
  const freeFrom: string[] = [];
  const placed: { task: Task; from: string; to: string; lane: number }[] = [];
  for (const r of runs) {
    let lane = freeFrom.findIndex((d) => d <= r.from);
    if (lane === -1) lane = freeFrom.length;
    freeFrom[lane] = addDaysStr(r.to, 1);
    if (lane < maxLanes) placed.push({ ...r, lane });
    // Past the last lane the band would crowd out the day's own contents, so
    // the run is left to the cells to list among their extras.
    else for (let d = r.from; d <= r.to; d = addDaysStr(d, 1)) push(overflow, d, r.task);
  }
  const weeks: Week[] = [];
  for (let w = 0; w * 7 < days.length; w++) {
    const rowDays = days.slice(w * 7, w * 7 + 7);
    const a = rowDays[0];
    const b = rowDays[rowDays.length - 1];
    const bars: Bar[] = [];
    let lanes = 0;
    for (const r of placed) {
      if (r.to < a || r.from > b) continue;
      const from = r.from < a ? a : r.from;
      const to = r.to > b ? b : r.to;
      bars.push({
        task: r.task,
        from,
        col: diffDays(a, from),
        span: diffDays(from, to) + 1,
        lane: r.lane,
        // Measured against the task's real dates, not the clipped ones, so a
        // run reaching in from an earlier month is open on the left as well.
        openLeft: r.task.startDate! < from,
        openRight: r.task.dueDate! > to,
      });
      lanes = Math.max(lanes, r.lane + 1);
    }
    bars.sort((x, y) => x.lane - y.lane || x.col - y.col);
    weeks.push({ days: rowDays, bars, lanes });
  }
  for (const list of byDay.values()) list.sort(sortDay);
  return { weeks, byDay, overflow };
}

/**
 * The dates a dragged task lands on when it's dropped on `target`. A run
 * moves whole: the day it was picked up by sets the shift, so its length and
 * the gap to its start date both survive the move.
 */
export function movedTo(task: Task, grabbed: string | undefined, target: string): { dueDate: string; startDate?: string } | null {
  if (!spans(task)) return target === task.dueDate ? null : { dueDate: target };
  const from = grabbed ?? task.dueDate!;
  const shift = diffDays(from, target);
  if (!shift) return null;
  return { dueDate: addDaysStr(task.dueDate!, shift), startDate: addDaysStr(task.startDate!, shift) };
}
