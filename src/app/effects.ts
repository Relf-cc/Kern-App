/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// App-wide side effects: appearance attributes, OS integration sync,
// backend events, briefing prompts and global keyboard shortcuts.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { navigate, useRouter } from "@/stores/router";
import { useUndo } from "@/stores/undo";
import { api, describeError, isTauri } from "@/lib/ipc";
import { invalidate, invalidateTasks, queryClient } from "@/lib/query";
import { comboFromEvent, isTextInput, resolveBindings } from "@/lib/shortcuts";
import { todayStr } from "@/lib/dates";
import { useFocus } from "@/features/focus/store";
import { toast, toastError } from "@/stores/toast";
import { announce } from "@/lib/announce";
import { setSetting } from "@/stores/settings";
import { openNewTask } from "@/features/tasks/creation";
import { useSessions } from "@/features/sessions/store";
import { confirm } from "@/components/ui/Dialog";
import { openTask } from "@/features/tasks/menu";
import { askMcpConfirm, closeMcpConfirm, reviewAssistant } from "@/features/ai/McpApproval";
import type { McpConfirmRequest } from "@/lib/types";

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

export function useAppearance() {
  const v = useSettings((s) => s.values);
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const theme = v["appearance.theme"] === "system" ? (prefersDark() ? "dark" : "light") : v["appearance.theme"];
      root.dataset.theme = theme;
      root.dataset.accent = v["appearance.accent"];
      root.dataset.density = v["appearance.density"];
      root.dataset.radius = v["appearance.radius"];
      root.dataset.font = v["appearance.font"];
      root.dataset.scrollbars = v["appearance.scrollbars"];
      const motion = v["appearance.motion"] === "system" ? (prefersReducedMotion() ? "reduced" : "full") : v["appearance.motion"];
      root.dataset.motion = motion;
      root.dataset.complete = v["interaction.completionAnimation"] ? v["interaction.completionIntensity"] : "off";
      root.style.setProperty("--fs", String(v["appearance.fontScale"]));
      document.body.style.background = theme === "light" ? "#f6f6f6" : "#111111";
    };
    apply();
    const mq1 = window.matchMedia("(prefers-color-scheme: dark)");
    const mq2 = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq1.addEventListener("change", apply);
    mq2.addEventListener("change", apply);
    return () => {
      mq1.removeEventListener("change", apply);
      mq2.removeEventListener("change", apply);
    };
  }, [v]);

  // Privacy: blur everything while another app has focus.
  const blurOnUnfocus = v["privacy.blurOnUnfocus"];
  useEffect(() => {
    const root = document.documentElement;
    if (!blurOnUnfocus) {
      delete root.dataset.unfocused;
      return;
    }
    const sync = () => {
      if (document.hasFocus()) delete root.dataset.unfocused;
      else root.dataset.unfocused = "";
    };
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      delete root.dataset.unfocused;
    };
  }, [blurOnUnfocus]);

  // Query cache lifetime (Performance settings).
  const cacheMinutes = v["performance.cacheMinutes"];
  useEffect(() => {
    queryClient.setDefaultOptions({
      ...queryClient.getDefaultOptions(),
      queries: { ...queryClient.getDefaultOptions().queries, gcTime: cacheMinutes * 60_000 },
    });
  }, [cacheMinutes]);
}

/** Keeps OS integration (autostart, tray, global shortcut) in sync with settings. */
export function useOsIntegration() {
  const launchAtLogin = useSettings((s) => s.values["general.launchAtLogin"]);
  const showTray = useSettings((s) => s.values["general.showTray"]);
  const globalCapture = useSettings((s) => s.values["general.globalCaptureShortcut"]);
  const globalLite = useSettings((s) => s.values["general.globalLiteShortcut"]);
  const loaded = useSettings((s) => s.loaded);

  useEffect(() => {
    if (!loaded || !isTauri) return;
    void (async () => {
      try {
        const on = await autostartEnabled();
        if (launchAtLogin && !on) await enableAutostart();
        if (!launchAtLogin && on) await disableAutostart();
      } catch {
        toastError("Couldn't change the launch-at-login setting.");
      }
    })();
  }, [launchAtLogin, loaded]);

  useEffect(() => {
    if (!loaded || !isTauri) return;
    void api.system.setTrayVisible(showTray).catch(() => undefined);
  }, [showTray, loaded]);

  useEffect(() => {
    if (!loaded || !isTauri || !globalCapture) return;
    const accel = globalCapture.replace("Mod", "CommandOrControl");
    let registered = false;
    void register(accel, (e) => {
      if (e.state !== "Pressed") return;
      void api.system.showWindow().then(() => useUi.getState().openCapture());
    })
      .then(() => (registered = true))
      .catch(() => toastError(`Couldn't register ${globalCapture} system-wide - another app may be using it.`));
    return () => {
      if (registered) void unregister(accel).catch(() => undefined);
    };
  }, [globalCapture, loaded]);

  // System-wide shortcut for Kern Lite.
  useEffect(() => {
    if (!loaded || !isTauri || !globalLite || globalLite === globalCapture) return;
    const accel = globalLite.replace("Mod", "CommandOrControl");
    let registered = false;
    void register(accel, (e) => {
      if (e.state !== "Pressed") return;
      void api.system.showWindow().then(() => import("./mode").then((m) => m.switchMode("lite")));
    })
      .then(() => (registered = true))
      .catch(() => toastError(`Couldn't register ${globalLite} system-wide - another app may be using it.`));
    return () => {
      if (registered) void unregister(accel).catch(() => undefined);
    };
  }, [globalLite, globalCapture, loaded]);

  // The tray's Today list starts in step with the data on screen.
  useEffect(() => {
    if (loaded && isTauri) void api.app.trayRefresh().catch(() => undefined);
  }, [loaded]);
}

async function maybePromptBriefing() {
  const v = useSettings.getState().values;
  if (!v["rundown.enabled"]) return;
  const now = new Date();
  const [h, m] = v["rundown.time"].split(":").map(Number);
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
  const snap = await api.daily.getSnapshot(todayStr(), "morning").catch(() => null);
  if (snap?.viewedAt) return;
  if (useRouter.getState().route.name === "rundown") return;
  if (v["rundown.autoOpen"]) navigate({ name: "rundown" });
  else useUi.getState().set({ briefingPrompt: "morning" });
}

/** "Revert" on an assistant's toast: a batch is one tool call's audit row. */
async function revertMcpBatch(batch: number) {
  try {
    toast(await api.mcp.revert(batch));
  } catch (e) {
    toastError(describeError(e, "Couldn't put that back."));
  }
}

/**
 * What an assistant's write is called in the toast. The audit detail is a
 * count for the batch tools ("6 tasks") and an id otherwise, so only the
 * counted ones put it in the sentence.
 */
const MCP_WROTE: Record<string, (detail: string) => string> = {
  kern_task_create: (d) => `created ${d}`,
  kern_task_update: () => "changed a task",
  kern_task_move: (d) => `moved ${d}`,
  kern_task_complete: (d) => `completed ${d}`,
  kern_task_delete: (d) => `moved ${d} to Trash`,
  kern_note_create: () => "wrote a note",
  kern_note_update: () => "changed a note",
  kern_board_create: () => "created a board",
  kern_project_setup: (d) => `set up “${d}”`,
  kern_project_update: () => "changed a project",
  kern_milestone_create: (d) => `added the milestone “${d}”`,
  kern_label_create: (d) => `created the label “${d}”`,
  kern_whiteboard_from_mermaid: () => "drew a flowchart",
};

/** Listens for backend events and handles the morning/evening prompts. */
export function useBackendEvents() {
  const loaded = useSettings((s) => s.loaded);
  useEffect(() => {
    if (!loaded || !isTauri) return;
    const unlisten: Promise<() => void>[] = [
      listen("kern://briefing-due", () => void maybePromptBriefing()),
      listen("kern://evening-due", () => {
        if (useSettings.getState().values["rundown.eveningEnabled"]) useUi.getState().set({ briefingPrompt: "evening" });
      }),
      listen("kern://quick-capture", () => useUi.getState().openCapture()),
      listen("kern://focus-ended", () => useFocus.getState().checkCompletion()),
      listen("kern://data-changed", () => void queryClient.invalidateQueries()),
      listen<number>("kern://confirm-quit", async (e) => {
        const n = e.payload;
        const ok = await confirm({
          title: `Quit and stop ${n} terminal process${n === 1 ? "" : "es"}?`,
          message: "Commands still running in Kern's terminal (and anything they started) will be stopped.",
          confirmLabel: "Quit",
          danger: true,
        });
        if (ok) void api.system.quit();
      }),
      listen<string>("kern://backup-failed", (e) => toastError(`Automatic backup failed: ${e.payload}`)),
      listen<{ taskId: string; taskTitle: string; authorName: string; excerpt: string }[]>("kern://mentioned", (e) => {
        const first = e.payload[0];
        if (!first) return;
        void queryClient.invalidateQueries({ queryKey: ["comments"] });
        const text = e.payload.length > 1 ? `${e.payload.length} new mentions in comments` : `${first.authorName || "Someone"} mentioned you on “${first.taskTitle}”`;
        toast(text, { action: { label: "Open", run: () => openTask(first.taskId) }, duration: 8000 });
      }),
      listen("kern://review-due", () => {
        if (!useSettings.getState().values["review.enabled"] || useRouter.getState().route.name === "review") return;
        toast("Time for your weekly review", { action: { label: "Start", run: () => navigate({ name: "review" }) }, duration: 12_000 });
      }),
      listen<string>("kern://tray-completed", (e) => toast(`Completed “${e.payload}”`)),
      listen("kern://calendar-updated", () => void queryClient.invalidateQueries({ queryKey: ["calendar"] })),
      // An assistant (MCP) changed something: the same shape as cloud's
      // applied event - refresh everything it could have touched, and say so.
      listen<{ client: string; tool: string; detail: string; batch: number | null }>("kern://mcp-applied", (e) => {
        invalidateTasks();
        invalidate("notes", "note", "boards", "whiteboards", "whiteboard", "mcp");
        const wrote = MCP_WROTE[e.payload.tool]?.(e.payload.detail) ?? "changed something";
        // One call is one batch, so the toast can offer the whole thing back.
        const batch = e.payload.batch;
        toast(`${e.payload.client} ${wrote}`, {
          action: batch ? { label: "Revert", run: () => void revertMcpBatch(batch) } : undefined,
          duration: batch ? 8000 : undefined,
        });
      }),
      // A write is waiting on an answer (`mcp.confirmWrites`).
      listen<McpConfirmRequest>("kern://mcp-confirm", (e) => askMcpConfirm(e.payload)),
      listen<{ id: string }>("kern://mcp-confirm-done", (e) => closeMcpConfirm(e.payload.id)),
      listen("kern://mcp-reverted", () => {
        invalidateTasks();
        invalidate("notes", "note", "boards", "whiteboards", "whiteboard", "projects", "project", "mcp", "trash");
      }),
      listen<{ id: string; name: string }>("kern://mcp-pending", (e) => {
        toast(`${e.payload.name} wants to connect to Kern`, {
          action: { label: "Review", run: () => reviewAssistant(e.payload.id) },
          duration: 12_000,
        });
      }),
      listen("kern://mcp-state", () => invalidate("mcp")),
      listen<{ from: string; to: string; reason: string }>("kern://ai-switch", (e) => {
        if (!useSettings.getState().values["ai.notifySwitch"]) return;
        const msg = `Switched to ${e.payload.to} - ${e.payload.from} unavailable (${e.payload.reason}).`;
        toast(msg);
        announce(msg);
      }),
    ];
    // On launch the scheduler only emits once per day, so check directly too.
    const t = window.setTimeout(() => void maybePromptBriefing(), 1500);
    return () => {
      window.clearTimeout(t);
      unlisten.forEach((p) => void p.then((f) => f()));
    };
  }, [loaded]);

  // Refresh time-sensitive data when the window regains focus.
  useEffect(() => {
    const onFocus = () => {
      useFocus.getState().checkCompletion();
      if (useSettings.getState().values["dashboard.refreshOnFocus"]) {
        void queryClient.invalidateQueries({ queryKey: ["rundown"] });
        void queryClient.invalidateQueries({ queryKey: ["stats"] });
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}

/**
 * Work sessions: a low-rate heartbeat while one runs (checking for a gap
 * first, so sleep or a restart is noticed), and a check when the window
 * regains focus. No polling when no session is running.
 */
export function useWorkSessions() {
  const running = useSessions((s) => s.active?.status === "running");
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => void useSessions.getState().tick(), 60_000);
    return () => window.clearInterval(id);
  }, [running]);
  useEffect(() => {
    const onFocus = () => void useSessions.getState().tick();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}

/** Remembers the last route for "remember last workspace". */
export function useRememberRoute() {
  useEffect(
    () =>
      useRouter.subscribe((s) => {
        if (s.route.name !== "task") void api.settings.set({ "internal.lastRoute": s.route }).catch(() => undefined);
      }),
    [],
  );
}

const NAV_ACTIONS: Record<string, () => void> = {
  resumeWork: () => void import("@/features/workspace/store").then((m) => m.resumeWork()),
  toggleTerminal: () => {
    const r = useRouter.getState().route;
    void import("@/features/terminal/store").then((m) => m.toggleTerminal(r.name === "project" ? r.id : null));
  },
  goDashboard: () => navigate({ name: "dashboard" }),
  goTasks: () => navigate({ name: "tasks" }),
  goInbox: () => navigate({ name: "inbox" }),
  goProjects: () => navigate({ name: "projects" }),
  goWhiteboards: () => navigate({ name: "whiteboards" }),
  goNotes: () => navigate({ name: "notes" }),
  goSettings: () => navigate({ name: "settings" }),
  focusMode: () => navigate({ name: "focus" }),
  rundown: () => navigate({ name: "rundown" }),
};

export function useGlobalShortcuts() {
  const overrides = useSettings((s) => s.values["keyboard.shortcuts"]);
  useEffect(() => {
    const bindings = resolveBindings(overrides);
    const byCombo = new Map<string, string>();
    for (const [id, combo] of Object.entries(bindings)) if (combo) byCombo.set(combo, id);
    const global = new Set(["palette", "quickCapture", "newTask", "toggleTerminal"]);

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      const action = byCombo.get(combo);
      const typing = isTextInput(e.target);
      const ui0 = useUi.getState();
      // A pinned panel only closes on Escape when focus is inside it.
      const pinnedAway = ui0.inspectorPinned && !(e.target instanceof Element && e.target.closest(".inspector"));
      if (e.key === "Escape" && !typing && ui0.inspector && !pinnedAway && !document.querySelector("[role=dialog],[role=menu]")) {
        useUi.getState().closeInspector();
        return;
      }
      if (!action) return;
      if (typing && !global.has(action)) return;
      const ui = useUi.getState();
      const run = (): boolean => {
        switch (action) {
          case "palette":
            ui.setPalette(!ui.paletteOpen);
            return true;
          case "quickCapture":
            ui.openCapture(ui.capture.mode);
            return true;
          case "newTask":
            openNewTask();
            return true;
          case "newNote":
            ui.openCapture("note");
            return true;
          case "newProject":
            ui.set({ createProjectOpen: true });
            return true;
          case "toggleSidebar":
            void setSetting("appearance.sidebarCollapsed", !useSettings.getState().values["appearance.sidebarCollapsed"]);
            return true;
          case "closeInspector":
            ui.closeInspector();
            return true;
          case "shortcuts":
            ui.set({ shortcutsOpen: !ui.shortcutsOpen });
            return true;
          case "undo":
            void useUndo.getState().undoLast();
            return true;
          case "back":
            useRouter.getState().goBack();
            return true;
          case "forward":
            useRouter.getState().goForward();
            return true;
          default:
            if (NAV_ACTIONS[action]) {
              NAV_ACTIONS[action]();
              return true;
            }
            return false;
        }
      };
      if (run()) e.preventDefault();
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        useRouter.getState().goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        useRouter.getState().goForward();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, [overrides]);
}
