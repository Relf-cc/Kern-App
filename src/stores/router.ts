/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Minimal in-app router with back/forward history. A desktop app has no
// URL bar, so routes are plain typed objects.

import { create } from "zustand";
import type { ProjectTab } from "@/lib/types";

export type TasksView = "list" | "today" | "upcoming" | "calendar" | "board" | "plan";
export type SettingsSection =
  | "general"
  | "cloud"
  | "appearance"
  | "dashboard"
  | "tasks"
  | "calendars"
  | "templates"
  | "projects"
  | "whiteboards"
  | "notifications"
  | "rundown"
  | "focus"
  | "keyboard"
  | "data"
  | "privacy"
  | "api"
  | "integrations"
  | "plugins"
  | "developer"
  | "performance"
  | "about";

/** Sub-pages of Settings → API (the account manager lives at /api/accounts). */
export type ApiTab = "accounts" | "routing" | "usage" | "security" | "mcp";

export type Route =
  | { name: "dashboard"; id?: string }
  | { name: "tasks"; view?: TasksView }
  | { name: "inbox" }
  | { name: "projects" }
  | { name: "project"; id: string; tab?: ProjectTab; boardId?: string; whiteboardId?: string; /** Column to bring into view on the board. */ column?: string }
  | { name: "whiteboards" }
  | { name: "whiteboard"; id: string }
  | { name: "notes"; id?: string }
  | { name: "view"; id: string }
  | { name: "label"; id: string }
  | { name: "search"; q?: string }
  | { name: "settings"; section?: SettingsSection }
  | { name: "api"; tab?: ApiTab }
  | { name: "trash" }
  | { name: "focus" }
  | { name: "sessions"; projectId?: string }
  | { name: "rundown"; day?: string; mode?: "morning" | "evening" }
  | { name: "task"; id: string }
  | { name: "streams"; id?: string; tab?: StreamTab }
  | { name: "habits" }
  /** The weekly review; `week` is its first day (YYYY-MM-DD). */
  | { name: "review"; week?: string };

/** Sections of a stream's page. */
export type StreamTab = "overview" | "destination" | "fields" | "security" | "github" | "responses" | "deliveries";

interface RouterState {
  route: Route;
  back: Route[];
  forward: Route[];
  navigate: (r: Route, opts?: { replace?: boolean }) => void;
  goBack: () => void;
  goForward: () => void;
}

const same = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);

/** Hooks run before navigating away (e.g. flush unsaved edits). */
const leaveHooks = new Set<() => void>();
export function onBeforeNavigate(fn: () => void) {
  leaveHooks.add(fn);
  return () => {
    leaveHooks.delete(fn);
  };
}

export const useRouter = create<RouterState>((set, get) => ({
  route: { name: "dashboard" },
  back: [],
  forward: [],
  navigate: (r, opts) => {
    const cur = get().route;
    if (same(cur, r)) return;
    leaveHooks.forEach((fn) => fn());
    if (opts?.replace) set({ route: r });
    else set({ route: r, back: [...get().back.slice(-49), cur], forward: [] });
  },
  goBack: () => {
    const { back, route, forward } = get();
    if (!back.length) return;
    leaveHooks.forEach((fn) => fn());
    set({ route: back[back.length - 1], back: back.slice(0, -1), forward: [route, ...forward].slice(0, 50) });
  },
  goForward: () => {
    const { back, route, forward } = get();
    if (!forward.length) return;
    leaveHooks.forEach((fn) => fn());
    set({ route: forward[0], forward: forward.slice(1), back: [...back, route] });
  },
}));

export const navigate = (r: Route, opts?: { replace?: boolean }) => useRouter.getState().navigate(r, opts);

const API_TABS: ApiTab[] = ["accounts", "routing", "usage", "security", "mcp"];

/** Internal path for routes that have one (e.g. "/api/accounts"). */
export function pathOf(r: Route): string | null {
  switch (r.name) {
    case "api":
      return `/api/${r.tab ?? "accounts"}`;
    case "settings":
      return `/settings/${r.section ?? "general"}`;
    default:
      return null;
  }
}

/** Resolves an internal path such as "/api/accounts" to a route. */
export function routeFromPath(path: string): Route | null {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  if (parts[0] === "api") {
    const tab = (parts[1] ?? "accounts") as ApiTab;
    return API_TABS.includes(tab) ? { name: "api", tab } : null;
  }
  if (parts[0] === "settings") return { name: "settings", section: (parts[1] as SettingsSection) || undefined };
  return null;
}

export const navigatePath = (path: string) => {
  const r = routeFromPath(path);
  if (r) navigate(r);
  return !!r;
};
