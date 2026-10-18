/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// Kern Cloud actions: turning collaboration on, switching between offline
// data and cloud spaces, invitations, deep links and applying the effects
// of remote changes to the interface.

import { api } from "@/lib/ipc";
import { invalidate, queryClient, TASK_DOMAINS, type Domain } from "@/lib/query";
import type { ActiveSpace, Me, Space } from "@/lib/types";
import { navigate } from "@/stores/router";
import { getSetting, setSetting } from "@/stores/settings";
import { toast, toastError } from "@/stores/toast";
import { resetInterface } from "@/app/reset";
import { confirm } from "@/components/ui/Dialog";
import { errorText, openAuth, refreshMe, refreshStatus, useCloud } from "./store";

const st = () => useCloud.getState();

export const spaceRef = (s: Space): ActiveSpace => ({ id: s.id, kind: s.kind, name: s.kind === "personal" ? "Personal" : s.name });

/** Turns online collaboration on, signing in first if needed. */
export async function enableCloud(reason = "Sign in to turn on online collaboration.") {
  if (!getSetting("privacy.network")) {
    toastError("Network access is turned off in Settings → Privacy. Turn it on to use Kern Cloud.");
    return;
  }
  const info = await refreshStatus();
  if (!info?.signedIn) {
    openAuth({ reason, then: () => enableCloud(reason) });
    return;
  }
  if (!getSetting("cloud.enabled")) await setSetting("cloud.enabled", true);
  await refreshMe();
}

/** Turns collaboration off: back to offline data. Cloud copies stay on disk. */
export async function disableCloud() {
  if (st().info?.active) await switchSpace(null);
  await setSetting("cloud.enabled", false);
}

let switching = false;

/** Opens a cloud space (or offline data with null). */
export async function switchSpace(space: ActiveSpace | null, opts: { quiet?: boolean } = {}) {
  if (switching) return;
  const current = st().info?.active ?? null;
  if ((current?.id ?? null) === (space?.id ?? null)) return;
  switching = true;
  try {
    // Leave the current page first so open editors save into the old space.
    navigate({ name: "dashboard" }, { replace: true });
    await new Promise((r) => window.setTimeout(r, 60));
    await api.cloud.openSpace(space);
    useCloud.setState({ peers: {} });
    await refreshStatus();
    // Nothing from the old space may stay on screen or in the cache.
    resetInterface(space?.id ?? null);
    if (!opts.quiet) toast(space ? `Switched to ${space.kind === "personal" ? "your personal space" : space.name}` : "Switched to offline data");
  } catch (e) {
    toastError(errorText(e, "Couldn't open that space."));
  } finally {
    switching = false;
  }
}

/** Opens (creating on first use) the account's personal cloud space. */
export async function openPersonal() {
  try {
    const s = await api.cloud.request<Space>("POST", "/me/personal");
    await refreshMe();
    await switchSpace(spaceRef(s));
    return s;
  } catch (e) {
    toastError(errorText(e, "Couldn't open your personal space."));
    return null;
  }
}

export async function signOut() {
  const forget = await confirm({
    title: "Sign out of Kern Cloud?",
    message: "You'll switch to your offline data. Cloud spaces stay on the server; their copies on this computer are kept so they open faster next time.",
    confirmLabel: "Sign out",
  });
  if (!forget) return;
  try {
    const revoked = await api.cloud.signOut(false);
    useCloud.setState({ me: null, peers: {} });
    const info = await refreshStatus();
    resetInterface(info?.active?.id ?? null);
    // Signed out here either way, but the session may still be live on the
    // server, and the token to revoke it is already gone from this computer.
    if (revoked) toast("Signed out of Kern Cloud");
    else
      toast("Signed out on this computer, but Kern Cloud couldn't be reached to end the session. If you're concerned someone else has access, sign out of all devices from another computer that's still signed in.", { tone: "error", duration: 12000 });
  } catch (e) {
    toastError(errorText(e, "Couldn't sign out."));
  }
}

// ------------------------------------------------------------ invitations

/** Opens an invitation (from a link or the pending list). */
export function openInvite(id: string) {
  useCloud.setState({ inviteId: id });
}

export async function acceptInvite(id: string): Promise<boolean> {
  try {
    const space = await api.cloud.request<Space>("POST", `/invites/${id}/accept`);
    if (!getSetting("cloud.enabled")) await setSetting("cloud.enabled", true);
    await refreshMe();
    await switchSpace(spaceRef(space), { quiet: true });
    toast(`Welcome to ${space.name}`, { tone: "success" });
    return true;
  } catch (e) {
    toastError(errorText(e, "Couldn't accept the invitation."));
    return false;
  }
}

export async function declineInvite(id: string) {
  try {
    await api.cloud.request("POST", `/invites/${id}/decline`);
    await refreshMe();
  } catch (e) {
    toastError(errorText(e, "Couldn't decline the invitation."));
  }
}

const INVITE_LINK = /^kern:\/\/invite\/([0-9a-f-]{36})\/?$/i;

/** Handles kern:// links that opened the app. */
export async function handleDeepLinks() {
  const links = await api.cloud.takeLinks().catch(() => [] as string[]);
  for (const link of links) {
    const m = INVITE_LINK.exec(link.trim());
    if (m) openInvite(m[1]);
  }
}

// ------------------------------------------------------------ server events

export function handleSpaceEvent(event: string, spaceId: string) {
  const active = st().info?.active;
  void refreshMe().then((me) => {
    if (!active || active.id !== spaceId) return;
    if (event === "removed" || event === "deleted") {
      const msg = event === "deleted" ? `${active.name} was deleted by its owner.` : `You were removed from ${active.name}.`;
      toast(msg, { tone: "error", duration: 8000 });
      void leaveLostSpace(spaceId, me);
    }
  });
}

/** Moves away from a space this account can no longer open. */
export async function leaveLostSpace(spaceId: string, me?: Me | null) {
  const personal = (me ?? st().me)?.personal;
  await switchSpace(personal ? spaceRef(personal) : null, { quiet: true });
  void api.cloud.forgetSpace(spaceId).catch(() => undefined);
}

export function handleInviteEvent(inv: { id: string; workspace: string; inviterName: string | null }) {
  void refreshMe();
  toast(`${inv.inviterName ?? "Someone"} invited you to ${inv.workspace}`, { action: { label: "View", run: () => openInvite(inv.id) }, duration: 10_000 });
}

export interface StreamEventMessage {
  space: string;
  stream: { id: string; name: string };
  status: "delivered" | "partial" | "failed";
  title: string;
  taskId: string | null;
  inboxId: string | null;
  issueUrl: string | null;
  test: boolean;
}

/** A stream delivered a submission into a space (the records arrive as ordinary changes). */
export function handleStreamEvent(e: StreamEventMessage) {
  void queryClient.invalidateQueries({ queryKey: ["cloud", "streams", e.space] });
  if (e.space !== st().info?.active?.id || !getSetting("cloud.streamToasts")) return;
  const action = e.taskId
    ? { label: "Open", run: () => navigate({ name: "task", id: e.taskId! }) }
    : e.inboxId
      ? { label: "Inbox", run: () => navigate({ name: "inbox" }) }
      : e.issueUrl
        ? { label: "Open issue", run: () => void api.system.open(e.issueUrl!) }
        : { label: "Details", run: () => navigate({ name: "streams", id: e.stream.id, tab: "deliveries" }) };
  if (e.status === "failed") toast(`${e.stream.name}: a submission couldn't be delivered`, { tone: "error", action: { label: "Details", run: () => navigate({ name: "streams", id: e.stream.id, tab: "deliveries" }) }, duration: 8000 });
  else toast(`${e.stream.name}${e.test ? " (test)" : ""}: ${e.title}`, { action, duration: 8000 });
}

// ------------------------------------------------------------ remote changes

const TABLE_DOMAINS: Record<string, Domain[]> = {
  tasks: [...TASK_DOMAINS, "search", "trash", "inbox"],
  task_labels: TASK_DOMAINS,
  labels: ["labels", "tasks", "task", "board"],
  projects: ["projects", "project", "groups", "search", "trash", "capabilities", "health", "stats", "rundown"],
  project_groups: ["groups", "projects"],
  boards: ["boards", "board", "projects", "project"],
  board_columns: ["board", "boards"],
  milestones: ["milestones", "health", "tasks", "task", "project"],
  milestone_deps: ["milestones"],
  release_links: ["milestones"],
  notes: ["notes", "note", "search", "trash", "backlinks"],
  inbox_items: ["inbox", "stats"],
  whiteboards: ["whiteboards", "search", "trash", "recent"],
  wb_nodes: ["whiteboards"],
  wb_edges: [],
  project_repos: ["github", "repos", "project", "capabilities"],
  task_issue_links: ["github", "tasks", "task"],
  task_relations: ["relations", "tasks", "task"],
  task_comments: ["comments", "tasks", "task"],
  templates: ["templates"],
  habits: ["habits", "review"],
  habit_checks: ["habits", "review"],
};

type WbListener = (whiteboardIds: Set<string>) => void;
const wbListeners = new Set<WbListener>();

/** Lets an open whiteboard merge collaborators' saved changes. */
export function onWhiteboardChanges(fn: WbListener) {
  wbListeners.add(fn);
  return () => {
    wbListeners.delete(fn);
  };
}

let pendingTables = new Set<string>();
let pendingBoards = new Set<string>();
let flushTimer: number | undefined;

/** Refreshes what remote changes affected (batched over a short window). */
export function onApplied(tables: string[], whiteboards: string[]) {
  tables.forEach((t) => pendingTables.add(t));
  whiteboards.forEach((w) => pendingBoards.add(w));
  if (flushTimer !== undefined) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = undefined;
    const domains = new Set<Domain>();
    pendingTables.forEach((t) => (TABLE_DOMAINS[t] ?? []).forEach((d) => domains.add(d)));
    invalidate(...domains);
    if (pendingBoards.size) {
      void queryClient.invalidateQueries({ queryKey: ["whiteboard", "preview"] });
      const ids = new Set(pendingBoards);
      wbListeners.forEach((fn) => fn(ids));
    }
    pendingTables = new Set();
    pendingBoards = new Set();
  }, 80);
}
