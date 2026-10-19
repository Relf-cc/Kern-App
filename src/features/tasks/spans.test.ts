/**
 * @Author Christian Relf
 * @Date 2026-10-19
 */

import { describe, expect, it } from "vitest";
import type { Task } from "@/lib/types";
import { layOutDays, movedTo } from "./spans";
import { monthGrid } from "@/lib/dates";

const task = (id: string, p: Partial<Task> = {}) => ({ id, title: id, status: "todo", priority: 0, labelIds: [], ...p }) as Task;
const byDue = (a: Task, b: Task) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
// Weeks start on Monday by default, so October 2026's grid runs 28 Sep - 8 Nov.
const october = monthGrid("2026-10-01");

describe("layOutDays", () => {
  it("leaves a task without a start date on its due date", () => {
    const t = task("a", { dueDate: "2026-10-14" });
    const { bars, byDay } = layOutDays([t], october, byDue);
    expect(bars.size).toBe(0);
    expect(byDay.get("2026-10-14")?.map((x) => x.id)).toEqual(["a"]);
  });

  it("draws a run across every day from its start to its due date", () => {
    const t = task("a", { startDate: "2026-10-12", dueDate: "2026-10-15" });
    const { bars, byDay } = layOutDays([t], october, byDue);
    expect(byDay.size).toBe(0);
    expect([...bars.keys()].sort()).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]);
    // Open on the inside, closed at the two ends of the run.
    expect(bars.get("2026-10-12")![0]).toMatchObject({ openLeft: false, openRight: true, labelled: true });
    expect(bars.get("2026-10-13")![0]).toMatchObject({ openLeft: true, openRight: true, labelled: false });
    expect(bars.get("2026-10-15")![0]).toMatchObject({ openLeft: true, openRight: false, labelled: false });
  });

  it("cuts the bar at the end of a week row and labels the piece after it", () => {
    // 2026-10-18 is a Sunday: the last column of the row.
    const t = task("a", { startDate: "2026-10-16", dueDate: "2026-10-20" });
    const { bars } = layOutDays([t], october, byDue);
    expect(bars.get("2026-10-18")![0]).toMatchObject({ openLeft: true, openRight: false });
    expect(bars.get("2026-10-19")![0]).toMatchObject({ openLeft: false, labelled: true });
  });

  it("clips a run reaching in from an earlier month to the first cell", () => {
    const t = task("a", { startDate: "2026-08-20", dueDate: "2026-10-02" });
    const { bars } = layOutDays([t], october, byDue);
    expect([...bars.keys()][0]).toBe(october[0]);
    expect(bars.get(october[0])![0]).toMatchObject({ openLeft: false, labelled: true });
    expect(bars.get("2026-10-02")![0]).toMatchObject({ openRight: false });
  });

  it("keeps runs in the same order in every cell they cross", () => {
    const a = task("a", { startDate: "2026-10-05", dueDate: "2026-10-09" });
    const b = task("b", { startDate: "2026-10-06", dueDate: "2026-10-08" });
    const { bars } = layOutDays([b, a], october, byDue);
    for (const day of ["2026-10-06", "2026-10-07", "2026-10-08"]) {
      expect(bars.get(day)!.map((s) => s.task.id)).toEqual(["a", "b"]);
    }
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
