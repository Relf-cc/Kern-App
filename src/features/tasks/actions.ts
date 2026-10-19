/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Task mutations used across the app (lists, boards, dashboard, palette,
// keyboard). Each applies an optimistic update, persists through the
// typed API, offers undo where reversible and reports failures with a
// retry action instead of silently discarding changes.

import { api, describeError } from "@/lib/ipc";
import { invalidate, invalidateTasks, optimisticPatch } from "@/lib/query";
import type { Task, TaskInput, TaskPatch, TaskStatus, TaskUpdateResult } from "@/lib/types";
import { pushUndo } from "@/stores/undo";
import { toast, toastError } from "@/stores/toast";
import { addDaysStr, formatDue, todayStr } from "@/lib/dates";
import { getSetting } from "@/stores/settings";
import { scheduleIssuePush } from "@/features/github/push";
import { confirmDelete } from "@/components/ui/Dialog";
import { taskEasterEgg } from "@/app/easterEggs";

/** Builds the patch that reverts `patch` given the task's previous state. */
export function inversePatch(prev: Task, patch: TaskPatch, spawned: boolean): TaskPatch {
  const inv: TaskPatch = {};
  if (patch.title !== undefined) inv.title = prev.title;
  if (patch.description !== undefined) inv.description = prev.description;
  if (patch.status !== undefined || patch.columnId !== undefined || patch.resolution !== undefined) {
    inv.status = prev.status;
    inv.resolution = prev.resolution ?? null;
  }
  if (patch.priority !== undefined) inv.priority = prev.priority;
  if (patch.projectId !== undefined || patch.columnId !== undefined) {
    inv.projectId = prev.projectId;
    inv.columnId = prev.columnId;
    inv.boardOrder = prev.boardOrder;
  }
  if (patch.parentId !== undefined) inv.parentId = prev.parentId;
  if (patch.dueDate !== undefined || patch.dueTime !== undefined) {
    inv.dueDate = prev.dueDate;
    inv.dueTime = prev.dueTime;
  }
  if (patch.startDate !== undefined) inv.startDate = prev.startDate;
  if (patch.estimateMinutes !== undefined) inv.estimateMinutes = prev.estimateMinutes;
  if (patch.reminderMinutes !== undefined) inv.reminderMinutes = prev.reminderMinutes;
  if (patch.recurrence !== undefined || spawned) inv.recurrence = prev.recurrence;
  if (patch.sortOrder !== undefined) inv.sortOrder = prev.sortOrder;
  if (patch.boardOrder !== undefined) inv.boardOrder = prev.boardOrder;
  if (patch.pinned !== undefined) inv.pinned = prev.pinned;
  if (patch.archived !== undefined) inv.archived = prev.archivedAt !== null;
  if (patch.labelIds !== undefined || patch.addLabelIds !== undefined || patch.removeLabelIds !== undefined)
    inv.labelIds = prev.labelIds;
  if (patch.planDate !== undefined || patch.planTime !== undefined) {
    inv.planDate = prev.planDate ?? null;
    inv.planTime = prev.planTime ?? null;
  }
  return inv;
}

export function defaultTaskPlacement(): Partial<TaskInput> {
  const dest = getSetting("tasks.defaultDestination");
  const priority = getSetting("tasks.defaultPriority");
  if (dest === "today") return { status: "todo", dueDate: todayStr(), priority };
  if (dest === "noDate") return { status: "todo", priority };
  return { status: "inbox", priority };
}

export async function createTask(input: TaskInput, opts?: { quiet?: boolean }): Promise<Task | null> {
  try {
    const t = await api.tasks.create(input);
    invalidateTasks();
    if (!opts?.quiet && input.status === "inbox" && !input.projectId) toast("Added to Inbox");
    return t;
  } catch (e) {
    toastError(describeError(e, "Couldn't create the task."), () => void createTask(input, opts));
    return null;
  }
}

interface UpdateOpts {
  /** Undo toast label; omit for silent edits (still undoable via Ctrl+Z if `undoable`). */
  undoLabel?: string;
  undoable?: boolean;
  /** Delay before refetching lists so a completion animation can play. */
  refreshDelay?: number;
}

/** Says which waiting tasks closing a blocker reopened. */
function announceUnblocked(results: TaskUpdateResult[]) {
  const freed = results.flatMap((r) => r.unblocked ?? []);
  if (freed.length === 1) toast(`Unblocked “${freed[0].title}”`);
  else if (freed.length > 1) toast(`Unblocked ${freed.length} tasks`);
}

export async function updateTask(id: string, patch: TaskPatch, opts: UpdateOpts = {}): Promise<TaskUpdateResult | null> {
  const rollback = optimisticPatch([id], patch);
  try {
    const res = await api.tasks.update(id, patch);
    if (res.task.issue) scheduleIssuePush(id);
    announceUnblocked([res]);
    const refresh = () => invalidateTasks();
    if (opts.refreshDelay) window.setTimeout(refresh, opts.refreshDelay);
    else refresh();
    if (opts.undoLabel || opts.undoable) {
      const inv = inversePatch(res.previous, patch, !!res.spawned);
      pushUndo(
        opts.undoLabel ?? "Change",
        async () => {
          if (res.spawned) await api.tasks.purge([res.spawned.id]);
          await api.tasks.update(id, inv);
          invalidateTasks();
        },
        { silent: !opts.undoLabel },
      );
    }
    return res;
  } catch (e) {
    rollback();
    toastError(describeError(e), () => void updateTask(id, patch, opts));
    return null;
  }
}

/**
 * How long a completed task stays in place before lists reconcile, so the
 * strikethrough can be seen. Zero when animations are off or reduced.
 */
export function completionHold(): number {
  if (!getSetting("interaction.completionAnimation")) return 0;
  const motion = typeof document !== "undefined" ? document.documentElement.dataset.motion : "full";
  if (motion === "reduced" || motion === "off") return 0;
  const strike = { subtle: 220, standard: 260, pronounced: 300 }[getSetting("interaction.completionIntensity")] ?? 260;
  return strike + 320;
}

interface CompletionRun {
  /** The state the user asked for most recently. */
  desired: boolean;
  /** The state the backend has confirmed. */
  applied: boolean;
  /** Status to restore when reopening. */
  reopenStatus: TaskStatus;
  /** Next occurrence spawned by this run (removed again if the user unchecks). */
  spawnedId: string | null;
}

// One run per task: writes are sent in order and coalesced, so rapid clicks
// can never leave the backend in a different state from the last click.
const runs = new Map<string, CompletionRun>();

export async function setCompleted(task: Task, completed: boolean) {
  const statusFor = (done: boolean, reopen: TaskStatus): TaskStatus => (done ? "completed" : reopen);
  const pending = runs.get(task.id);
  if (pending) {
    pending.desired = completed;
    // Keep the UI on the latest click while the earlier write finishes.
    optimisticPatch([task.id], { status: statusFor(completed, pending.reopenStatus) });
    return;
  }
  const run: CompletionRun = {
    desired: completed,
    applied: task.status === "completed",
    reopenStatus: task.status === "completed" ? "todo" : task.status,
    spawnedId: null,
  };
  runs.set(task.id, run);
  try {
    while (run.applied !== run.desired) {
      const target = run.desired;
      if (!target && run.spawnedId) {
        // Unchecked straight after completing a recurring task: withdraw the
        // occurrence it spawned, as Undo would.
        await api.tasks.purge([run.spawnedId]).catch(() => undefined);
        run.spawnedId = null;
      }
      const res = await updateTask(
        task.id,
        { status: statusFor(target, run.reopenStatus) },
        { undoLabel: target ? "Completed" : "Reopened", refreshDelay: target ? completionHold() : 0 },
      );
      if (!res) return; // failure was reported and rolled back
      run.applied = target;
      if (target) taskEasterEgg(task.title);
      if (target && res.spawned) run.spawnedId = res.spawned.id;
    }
    if (run.applied && run.spawnedId) {
      const next = await api.tasks.get(run.spawnedId).catch(() => null);
      if (next?.dueDate) toast(`Next: ${formatDue(next.dueDate)}`);
    }
  } finally {
    runs.delete(task.id);
  }
}

export const toggleComplete = (task: Task) => setCompleted(task, task.status !== "completed");

export async function updateTasks(ids: string[], patch: TaskPatch, label?: string) {
  if (!ids.length) return;
  const rollback = optimisticPatch(ids, patch);
  try {
    const results = await api.tasks.updateMany(ids, patch);
    for (const r of results) if (r.task.issue) scheduleIssuePush(r.task.id);
    announceUnblocked(results);
    invalidateTasks();
    if (label) {
      pushUndo(label, async () => {
        const spawned = results.filter((r) => r.spawned).map((r) => r.spawned!.id);
        if (spawned.length) await api.tasks.purge(spawned);
        await api.tasks.patchBatch(results.map((r) => [r.task.id, inversePatch(r.previous, patch, !!r.spawned)]));
        invalidateTasks();
      });
    }
  } catch (e) {
    rollback();
    toastError(describeError(e), () => void updateTasks(ids, patch, label));
  }
}

export async function deleteTasks(ids: string[]) {
  if (!ids.length) return;
  const one = ids.length === 1;
  if (!(await confirmDelete(one ? "Delete this task?" : `Delete ${ids.length} tasks?`, `${one ? "It moves" : "They move"} to the trash, where you can restore ${one ? "it" : "them"}.`))) return;
  try {
    await api.tasks.delete(ids);
    invalidateTasks();
    invalidate("trash");
    pushUndo(ids.length === 1 ? "Moved to trash" : `${ids.length} tasks moved to trash`, async () => {
      await api.tasks.restore(ids);
      invalidateTasks();
      invalidate("trash");
    });
  } catch (e) {
    toastError(describeError(e, "Couldn't delete."), () => void deleteTasks(ids));
  }
}

export async function duplicateTask(id: string) {
  try {
    const t = await api.tasks.duplicate(id);
    invalidateTasks();
    pushUndo("Duplicated", async () => {
      await api.tasks.delete([t.id]);
      invalidateTasks();
    });
    return t;
  } catch (e) {
    toastError(describeError(e, "Couldn't duplicate the task."));
    return null;
  }
}

/** Copies tasks into another project, leaving the originals where they are. */
export async function copyTasksToProject(ids: string[], project: { id: string | null; name: string }) {
  if (!ids.length) return null;
  try {
    const made = await api.tasks.copyToProject(ids, project.id);
    invalidateTasks();
    toast(`${made.length === 1 ? "Task copied" : `${made.length} tasks copied`} to ${project.name}`);
    pushUndo(made.length === 1 ? "Copied" : `${made.length} tasks copied`, async () => {
      await api.tasks.purge(made.map((t) => t.id));
      invalidateTasks();
    });
    return made;
  } catch (e) {
    toastError(describeError(e, "Couldn't copy the tasks."), () => void copyTasksToProject(ids, project));
    return null;
  }
}

export async function rescheduleTasks(ids: string[], dueDate: string | null) {
  await updateTasks(ids, { dueDate }, dueDate ? `Moved to ${formatDue(dueDate)}` : "Date removed");
}

export const quickDates = () => {
  const today = todayStr();
  return {
    today,
    tomorrow: addDaysStr(today, 1),
    nextWeek: addDaysStr(today, 7),
  };
};

/** Persists an explicit order for a list of sibling tasks with undo. */
export async function reorderTasks(orderedIds: string[], previousIds: string[], field: "list" | "board" = "list") {
  try {
    await api.tasks.reorder(orderedIds, field);
    invalidate("tasks", "board");
    pushUndo(
      "Reordered",
      async () => {
        await api.tasks.reorder(previousIds, field);
        invalidate("tasks", "board");
      },
      { silent: true },
    );
  } catch (e) {
    invalidate("tasks", "board");
    toastError(describeError(e), () => void reorderTasks(orderedIds, previousIds, field));
  }
}
