/**
 * @Author Christian Relf
 * @Date 2026-10-19
 */

// Laying tasks out on the month grid. A task with a start date earlier than
// its due date occupies a run of days rather than a point, and is drawn as
// one bar across every cell between the two; everything else sits on its due
// date. Pure so the arithmetic — clipping to the grid, cutting a bar at the
// end of a week row — can be tested without a calendar on screen.

import type { Task } from "@/lib/types";
import { addDaysStr, diffDays } from "@/lib/dates";

/** A task's place in one day of the run from its start date to its due date. */
export interface Segment {
  task: Task;
  /** The day this piece of the bar is drawn on. */
  day: string;
  /** The bar carries on into the cell to the left / right of this one. */
  openLeft: boolean;
  openRight: boolean;
  /** Pieces after a cut repeat the title; the ones between stay bare. */
  labelled: boolean;
}

export interface DayLayout {
  /** Bars by day, in the same order in every cell they cross. */
  bars: Map<string, Segment[]>;
  /** Single-day tasks by due date. */
  byDay: Map<string, Task[]>;
}

/** True when a task covers a run of days rather than a single due date. */
export function spans(t: Task): boolean {
  return !!t.startDate && !!t.dueDate && t.startDate < t.dueDate;
}

/**
 * Splits `tasks` across `days` (a month grid of whole weeks, in order).
 * `sortDay` orders the single-day tasks within a cell.
 */
export function layOutDays(tasks: Task[], days: string[], sortDay: (a: Task, b: Task) => number): DayLayout {
  const index = new Map(days.map((d, i) => [d, i]));
  const bars = new Map<string, Segment[]>();
  const byDay = new Map<string, Task[]>();
  const runs: Task[] = [];
  for (const t of tasks) {
    if (!t.dueDate) continue;
    if (!spans(t)) {
      if (!byDay.has(t.dueDate)) byDay.set(t.dueDate, []);
      byDay.get(t.dueDate)!.push(t);
    } else runs.push(t);
  }
  // One stable order for every cell, so a bar keeps the same row across all
  // the days it covers.
  runs.sort((a, b) => a.startDate!.localeCompare(b.startDate!) || a.dueDate!.localeCompare(b.dueDate!) || a.id.localeCompare(b.id));
  for (const t of runs) {
    // A run reaching in from an earlier month starts at the first cell.
    const from = t.startDate! < days[0] ? days[0] : t.startDate!;
    let d = from;
    for (let i = 0; i < 62 && d <= t.dueDate!; i++) {
      const at = index.get(d);
      if (at !== undefined) {
        // A bar is cut at each end of a week row, where the next day is on
        // the row below; the piece after a cut repeats the title.
        const openLeft = d > from && at % 7 !== 0;
        const openRight = d < t.dueDate! && at % 7 !== 6;
        if (!bars.has(d)) bars.set(d, []);
        bars.get(d)!.push({ task: t, day: d, openLeft, openRight, labelled: !openLeft });
      }
      d = addDaysStr(d, 1);
    }
  }
  for (const list of byDay.values()) list.sort(sortDay);
  return { bars, byDay };
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
