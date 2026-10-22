/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { QueryClient } from "@tanstack/react-query";
import { api, isTauri } from "./ipc";
import type { BoardData, Task, TaskPatch } from "./types";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Local data: no network retries, no flashing refetches.
      retry: 1,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      networkMode: "always",
    },
    mutations: { networkMode: "always" },
  },
});

export type Domain =
  | "tasks"
  | "passkeys"
  | "plugins"
  | "task"
  | "board"
  | "boards"
  | "projects"
  | "project"
  | "groups"
  | "rundown"
  | "stats"
  | "labels"
  | "activity"
  | "notes"
  | "note"
  | "inbox"
  | "whiteboards"
  | "whiteboard"
  | "recent"
  | "views"
  | "trash"
  | "dashboards"
  | "attachments"
  | "focus"
  | "snapshots"
  | "backups"
  | "search"
  | "folder"
  | "files"
  | "trusted"
  | "storage"
  | "ai"
  | "mcp"
  | "favicon"
  | "git"
  | "github"
  | "repos"
  | "worktrees"
  | "devlinks"
  | "sessions"
  | "workspace"
  | "layouts"
  | "milestones"
  | "devenv"
  | "commands"
  | "env"
  | "services"
  | "deps"
  | "health"
  | "capabilities"
  | "pty"
  | "relations"
  | "comments"
  | "templates"
  | "habits"
  | "calendar"
  | "review"
  | "backlinks"
  | "estimates"
  | "shares";

export function invalidate(...domains: Domain[]) {
  for (const d of domains) void queryClient.invalidateQueries({ queryKey: [d] });
  if (domains.includes("tasks")) refreshTraySoon();
}

export const TASK_DOMAINS: Domain[] = ["tasks", "task", "board", "projects", "project", "rundown", "stats", "activity", "labels", "milestones", "health", "relations", "review", "estimates"];

let trayTimer: number | undefined;
/** The tray menu lists today's tasks; it's rebuilt (debounced) after task changes. */
function refreshTraySoon() {
  window.clearTimeout(trayTimer);
  if (!isTauri) return;
  trayTimer = window.setTimeout(() => void api.app.trayRefresh().catch(() => undefined), 800);
}

export function invalidateTasks() {
  invalidate(...TASK_DOMAINS);
  refreshTraySoon();
}

/** Applies a patch to a task object the way the backend would (best effort). */
export function applyPatch(t: Task, p: TaskPatch): Task {
  const next: Task = { ...t };
  const keys: (keyof TaskPatch & keyof Task)[] = [
    "title",
    "description",
    "status",
    "priority",
    "projectId",
    "columnId",
    "parentId",
    "dueDate",
    "dueTime",
    "startDate",
    "estimateMinutes",
    "reminderMinutes",
    "recurrence",
    "sortOrder",
    "boardOrder",
    "pinned",
    "labelIds",
    "milestoneId",
    "resolution",
    "planDate",
    "planTime",
  ];
  for (const k of keys) {
    if (p[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = p[k];
  }
  if (p.status === "completed" && t.status !== "completed") next.completedAt = Date.now();
  if (p.status && p.status !== "completed") next.completedAt = null;
  if (p.status === "completed" && t.status !== "completed" && p.resolution === undefined) next.resolution = null;
  if (next.status !== "completed") next.resolution = null;
  if (p.archived !== undefined) next.archivedAt = p.archived ? Date.now() : null;
  if (p.addLabelIds) next.labelIds = Array.from(new Set([...next.labelIds, ...p.addLabelIds]));
  if (p.removeLabelIds) next.labelIds = next.labelIds.filter((l) => !p.removeLabelIds!.includes(l));
  if (p.dueDate === null) next.dueTime = null;
  if (p.planDate === null) next.planTime = null;
  return next;
}

/** Optimistically patches tasks in every cached list/board/detail. Returns a rollback. */
export function optimisticPatch(ids: string[], patch: TaskPatch | ((t: Task) => TaskPatch)): () => void {
  const idSet = new Set(ids);
  const snapshots: [readonly unknown[], unknown][] = [];
  const patchOf = (t: Task) => (typeof patch === "function" ? patch(t) : patch);

  for (const [key, data] of queryClient.getQueriesData<Task[]>({ queryKey: ["tasks"] })) {
    if (!Array.isArray(data)) continue;
    if (!data.some((t) => idSet.has(t.id))) continue;
    snapshots.push([key, data]);
    queryClient.setQueryData<Task[]>(key, data.map((t) => (idSet.has(t.id) ? applyPatch(t, patchOf(t)) : t)));
  }
  for (const [key, data] of queryClient.getQueriesData<BoardData>({ queryKey: ["board"] })) {
    if (!data || !Array.isArray(data.tasks)) continue;
    if (!data.tasks.some((t) => idSet.has(t.id))) continue;
    snapshots.push([key, data]);
    queryClient.setQueryData<BoardData>(key, {
      ...data,
      tasks: data.tasks.map((t) => (idSet.has(t.id) ? applyPatch(t, patchOf(t)) : t)),
    });
  }
  for (const id of ids) {
    const key = ["task", id];
    const data = queryClient.getQueryData<Task>(key);
    if (data) {
      snapshots.push([key, data]);
      queryClient.setQueryData<Task>(key, applyPatch(data, patchOf(data)));
    }
  }
  return () => {
    for (const [key, data] of snapshots) queryClient.setQueryData(key, data);
  };
}
