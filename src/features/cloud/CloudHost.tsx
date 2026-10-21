/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// Mounts Kern Cloud's dialogs and keeps the interface in step with the
// backend: account and sync status, remote changes, the realtime socket,
// deep links (kern://invite/…) and where this user is (presence).

import { lazy, Suspense, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@/lib/ipc";
import { queryClient } from "@/lib/query";
import type { ActiveSpace, SyncStatus } from "@/lib/types";
import { useRouter, type Route } from "@/stores/router";
import { getSetting, useSetting } from "@/stores/settings";
import { toast } from "@/stores/toast";
import { markShownSpace, resetInterface } from "@/app/reset";
import { AuthDialog } from "./AuthDialog";
import { handleDeepLinks, leaveLostSpace, onApplied } from "./actions";
import { startRealtime, setPresence } from "./realtime";
import { openAuth, refreshMe, refreshStatus, setSync, useActiveSpace, useCloud } from "./store";
import { tintVars } from "./ui";
import { accentColor } from "@/features/projects/ProjectGlyph";

// Larger dialogs load on first use.
const CreateWorkspaceDialog = lazy(() => import("./CreateWorkspace").then((m) => ({ default: m.CreateWorkspaceDialog })));
const ManageWorkspaceDialog = lazy(() => import("./ManageWorkspace").then((m) => ({ default: m.ManageWorkspaceDialog })));
const ImportDialog = lazy(() => import("./ImportDialog").then((m) => ({ default: m.ImportDialog })));
const InviteDialog = lazy(() => import("./InviteDialog").then((m) => ({ default: m.InviteDialog })));

function viewOf(r: Route): { view: string; label?: string } {
  switch (r.name) {
    case "project":
      return { view: r.whiteboardId ? `wb:${r.whiteboardId}` : `project:${r.id}` };
    case "whiteboard":
      return { view: `wb:${r.id}` };
    case "task":
      return { view: `task:${r.id}` };
    case "notes":
      return { view: r.id ? `note:${r.id}` : "notes" };
    default:
      return { view: r.name };
  }
}

function useCloudEffects() {
  const enabled = useSetting("cloud.enabled");
  const share = useSetting("cloud.sharePresence");

  useEffect(() => {
    if (!isTauri) return;
    void refreshStatus().then((info) => {
      markShownSpace(info?.active?.id ?? null);
      if (info?.signedIn) void refreshMe();
    });
    void handleDeepLinks();
    const offs = [
      listen<{ space: string; tables: string[]; whiteboards: string[] }>("kern://cloud-applied", (e) => {
        if (e.payload.space === useCloud.getState().info?.active?.id) onApplied(e.payload.tables, e.payload.whiteboards);
      }),
      listen<SyncStatus>("kern://cloud-sync", (e) => setSync(e.payload)),
      // Any change of open data (a switch, signing out, another account
      // signing in) rebuilds the interface straight away.
      listen<ActiveSpace | null>("kern://cloud-space", (e) => {
        useCloud.setState({ peers: {} });
        void refreshStatus().then(() => resetInterface(e.payload?.id ?? null));
      }),
      listen<string>("kern://cloud-auth", (e) => {
        void refreshStatus().then(() => refreshMe());
        if (e.payload === "expired" && getSetting("cloud.enabled")) {
          toast("Your Kern Cloud session ended. Sign in again to keep syncing.", {
            tone: "error",
            duration: 10_000,
            action: { label: "Sign in", run: () => openAuth({ email: useCloud.getState().info?.account?.email }) },
          });
        }
      }),
      listen<string>("kern://cloud-space-lost", (e) => {
        if (e.payload === useCloud.getState().info?.active?.id) {
          toast("This workspace is no longer available to you.", { tone: "error", duration: 8000 });
          void refreshMe().then((me) => leaveLostSpace(e.payload, me));
        }
      }),
      listen("kern://cloud-readonly", () => toast("You have view-only access here, so changes weren't saved.", { tone: "error" })),
      // A different Kern server is a different account and a different set of
      // spaces, so the interface starts again rather than showing the last
      // one's data under the new one's name.
      listen("kern://cloud-server", () => {
        useCloud.setState({ me: null, peers: {} });
        void queryClient.invalidateQueries({ queryKey: ["cloud"] });
        void refreshStatus().then((fresh) => {
          resetInterface(fresh?.active?.id ?? null);
          if (fresh?.signedIn) void refreshMe();
        });
      }),
      listen("kern://deep-link", () => void handleDeepLinks()),
    ];
    return () => offs.forEach((p) => void p.then((f) => f()));
  }, []);

  // The realtime socket follows the account and the open space.
  useEffect(() => (isTauri && enabled ? startRealtime() : undefined), [enabled]);

  // Share which page is open (whiteboards add the cursor themselves).
  useEffect(() => {
    if (!share) {
      setPresence(null);
      return;
    }
    const announce = (r: Route) => {
      if (r.name === "whiteboard" || (r.name === "project" && r.whiteboardId)) return;
      setPresence(viewOf(r));
    };
    announce(useRouter.getState().route);
    return useRouter.subscribe((s, prev) => {
      if (s.route !== prev.route) announce(s.route);
    });
  }, [share]);

  // A workspace can tint the interface with its colour while it's open.
  const active = useActiveSpace();
  const tint = active?.tint ? tintVars(accentColor(active.accent)) : null;
  const tintKey = tint ? JSON.stringify(tint) : "";
  useEffect(() => {
    if (!tint) return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(tint)) root.style.setProperty(k, v);
    return () => Object.keys(tint).forEach((k) => root.style.removeProperty(k));
  }, [tintKey]);

  // Workspace data shown in dialogs is refreshed when membership changes.
  useEffect(
    () =>
      useCloud.subscribe((s, prev) => {
        if (s.me !== prev.me) void queryClient.invalidateQueries({ queryKey: ["cloud", "workspace"] });
      }),
    [],
  );
}

export function CloudHost() {
  useCloudEffects();
  const create = useCloud((s) => s.createOpen);
  const manage = useCloud((s) => !!s.manage);
  const invite = useCloud((s) => !!s.inviteId);
  const importing = useCloud((s) => s.importOpen);
  return (
    <>
      <AuthDialog />
      <Suspense fallback={null}>
        {create && <CreateWorkspaceDialog />}
        {manage && <ManageWorkspaceDialog />}
        {invite && <InviteDialog />}
        {importing && <ImportDialog />}
      </Suspense>
    </>
  );
}
