/**
 * @Author Christian Relf
 * @Date 2026-10-19
 */

import { describe, expect, it } from "vitest";
import type { Task } from "@/lib/types";
import { layOutMonth, movedTo } from "./spans";
import { monthGrid } from "@/lib/dates";

const task = (id: string, p: Partial<Task> = {}) => ({ id, title: id, status: "todo", priority: 0, labelIds: [], ...p }) as Task;
const byDue = (a: Task, b: Task) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
// Weeks start on Monday by default, so October 2026's grid runs 28 Sep - 8 Nov.
const october = monthGrid("2026-10-01");
const week = (layout: ReturnType<typeof layOutMonth>, day: string) => layout.weeks.find((w) => w.days.includes(day))!;

describe("layOutMonth", () => {
  it("leaves a task without a start date on its due date", () => {
    const t = task("a", { dueDate: "2026-10-14" });
    const l = layOutMonth([t], october, byDue);
    expect(l.weeks.every((w) => !w.bars.length && w.lanes === 0)).toBe(true);
    expect(l.byDay.get("2026-10-14")?.map((x) => x.id)).toEqual(["a"]);
  });

  it("draws a run as one bar across the days from its start to its due date", () => {
    const t = task("a", { startDate: "2026-10-12", dueDate: "2026-10-15" });
    const l = layOutMonth([t], october, byDue);
    expect(l.byDay.size).toBe(0);
    const w = week(l, "2026-10-12");
    expect(w.lanes).toBe(1);
    // Monday the 12th is the first column, and the run is four days long.
    expect(w.bars).toHaveLength(1);
    expect(w.bars[0]).toMatchObject({ from: "2026-10-12", col: 0, span: 4, lane: 0, openLeft: false, openRight: false });
  });

  it("cuts the bar at the end of a week row, open on the inside ends", () => {
    // 2026-10-18 is a Sunday: the last column of the row.
    const t = task("a", { startDate: "2026-10-16", dueDate: "2026-10-20" });
    const l = layOutMonth([t], october, byDue);
    expect(week(l, "2026-10-16").bars[0]).toMatchObject({ from: "2026-10-16", col: 4, span: 3, openLeft: false, openRight: true });
    expect(week(l, "2026-10-19").bars[0]).toMatchObject({ from: "2026-10-19", col: 0, span: 2, openLeft: true, openRight: false });
  });

  it("clips a run reaching in from an earlier month and leaves that end open", () => {
    const t = task("a", { startDate: "2026-08-20", dueDate: "2026-10-02" });
    const l = layOutMonth([t], october, byDue);
    const w = week(l, october[0]);
    expect(w.bars[0]).toMatchObject({ from: october[0], col: 0, openLeft: true });
    expect(w.bars[0].openRight).toBe(false);
    expect(w.bars[0].span).toBe(5); // 28 Sep - 2 Oct
  });

  it("clips a run running out past the end of the grid", () => {
    const t = task("a", { startDate: "2026-11-06", dueDate: "2026-12-20" });
    const l = layOutMonth([t], october, byDue);
    const w = week(l, "2026-11-06");
    expect(w.bars[0]).toMatchObject({ from: "2026-11-06", span: 3, openLeft: false, openRight: true });
    // Nothing of it reaches the rows before.
    expect(l.weeks.filter((x) => x.bars.length)).toHaveLength(1);
  });

  it("keeps a run in one lane for its whole length, across week rows", () => {
    // A long run, plus a short one sharing only its first day: the short one
    // must take a lane of its own rather than pushing the long one around.
    const long = task("long", { startDate: "2026-10-07", dueDate: "2026-10-21" });
    const short = task("short", { startDate: "2026-10-07", dueDate: "2026-10-08" });
    const l = layOutMonth([short, long], october, byDue);
    const lanesOf = (id: string) => l.weeks.flatMap((w) => w.bars.filter((b) => b.task.id === id)).map((b) => b.lane);
    expect(lanesOf("long")).toEqual([0, 0, 0]);
    expect(lanesOf("short")).toEqual([1]);
    expect(week(l, "2026-10-07").lanes).toBe(2);
  });

  it("reuses a lane once it is free, and reserves no depth in an empty row", () => {
    const a = task("a", { startDate: "2026-10-05", dueDate: "2026-10-07" });
    const b = task("b", { startDate: "2026-10-09", dueDate: "2026-10-10" });
    const l = layOutMonth([a, b], october, byDue);
    expect(week(l, "2026-10-05").bars.map((x) => x.lane)).toEqual([0, 0]);
    expect(week(l, "2026-10-05").lanes).toBe(1);
    expect(week(l, "2026-10-26").lanes).toBe(0);
  });

  it("spills a run past the last lane into the days it covers", () => {
    const runs = ["a", "b", "c", "d"].map((id) => task(id, { startDate: "2026-10-12", dueDate: "2026-10-14" }));
    const l = layOutMonth(runs, october, byDue, 3);
    const w = week(l, "2026-10-12");
    expect(w.lanes).toBe(3);
    expect(w.bars.map((x) => x.task.id)).toEqual(["a", "b", "c"]);
    for (const day of ["2026-10-12", "2026-10-13", "2026-10-14"]) {
      expect(l.overflow.get(day)?.map((x) => x.id)).toEqual(["d"]);
    }
  });

  it("drops a task whose due date is off the grid", () => {
    const l = layOutMonth([task("a", { dueDate: "2026-12-01" })], october, byDue);
    expect(l.byDay.size).toBe(0);
  });
});

describe("movedTo", () => {
  it("moves a plain task to the day it was dropped on", () => {
    const t = task("a", { dueDate: "2026-10-14" });
    expect(movedTo(t, undefined, "2026-10-20")).toEqual({ dueDate: "2026-10-20" });
    expect(movedTo(t, undefined, "2026-10-14")).toBeNull();
  });

  it("shifts a whole run by the distance its grabbed day travelled", () => {
    const t = task("a", { startDate: "2026-10-12", dueDate: "2026-10-15" });
    // Picked up by its third day and dropped two days later.
    expect(movedTo(t, "2026-10-14", "2026-10-16")).toEqual({ startDate: "2026-10-14", dueDate: "2026-10-17" });
    // Dropped where it was picked up: nothing to do.
    expect(movedTo(t, "2026-10-14", "2026-10-14")).toBeNull();
  });
});
