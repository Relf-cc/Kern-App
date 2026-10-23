/**
 * @Author Christian Relf
 * @Date 2026-10-14
 */

// Full Kern: the sidebar, pages, panels and every dialog host.

import { Fragment, lazy, Suspense, useEffect } from "react";
import { SessionGapHost } from "@/features/sessions/SessionUi";
import { StartWorkHost } from "@/features/sessions/StartWork";
import { FileViewerHost } from "@/features/files/FileViewerHost";
import { useWorktreeDialog } from "@/features/dev/worktreeDialog";
import { useTerminal } from "@/features/terminal/store";
import { useUi } from "@/stores/ui";
import { Toaster } from "@/components/ui/Toaster";
import { ConfirmHost, PromptHost } from "@/components/ui/Dialog";
import { Sidebar } from "@/components/layout/Sidebar";
import { Inspector } from "@/components/layout/Inspector";
import { Routes } from "./Routes";
import { useAppearance, useBackendEvents, useGlobalShortcuts, useOsIntegration, useRememberRoute, useWorkSessions } from "./effects";
import { CommandPalette } from "@/features/search/CommandPalette";
import { QuickCapture } from "@/features/capture/QuickCapture";
import { CreateProjectDialog } from "@/features/projects/CreateProjectDialog";
import { TaskModal } from "@/features/tasks/TaskModal";
import { TaskComposer } from "@/features/tasks/TaskComposer";
import { TrustPromptHost } from "@/features/projects/folders";
import { McpApprovalHost } from "@/features/ai/McpApproval";
import { RepoPickerHost } from "@/features/github/shared";
import { ShortcutsDialog } from "@/features/settings/ShortcutsDialog";
import { BriefingPrompt } from "@/features/daily-briefing/BriefingPrompt";
import { Onboarding } from "@/features/onboarding/Onboarding";
import { useEpoch } from "./reset";
import { hideSplash } from "./splash";
import { useEasterEggs } from "./easterEggs";
import { CloudHost } from "@/features/cloud/CloudHost";
import { useAssist } from "@/features/assist/open";
import { useShare } from "@/features/share/open";
import { useTemplateDialogs } from "@/features/templates/open";

const TerminalPanel = lazy(() => import("@/features/terminal/TerminalPanel"));
const CatchupHost = lazy(() => import("@/features/catchup/CatchupDialog"));
const WorktreeDialogHost = lazy(() => import("@/features/dev/Worktrees"));
const CustomizeProjectHost = lazy(() => import("@/features/projects/CustomizeProject"));
const AssistHost = lazy(() => import("@/features/assist/AssistDialog"));
const ShareHost = lazy(() => import("@/features/share/ShareDialog"));
const TemplateHost = lazy(() => import("@/features/templates/TemplateDialogs"));

/** Hosts that load their code only once they're needed. */
function LazyHosts() {
  const catchup = useUi((s) => !!s.catchupProjectId);
  const worktree = useWorktreeDialog((s) => !!s.req);
  const customize = useUi((s) => !!s.customizeProjectId);
  const assist = useAssist((s) => !!s.req);
  const share = useShare((s) => !!s.req);
  const template = useTemplateDialogs((s) => !!s.req);
  return (
    <Suspense fallback={null}>
      {assist && <AssistHost />}
      {share && <ShareHost />}
      {template && <TemplateHost />}
      {catchup && <CatchupHost />}
      {customize && <CustomizeProjectHost />}
      {worktree && <WorktreeDialogHost />}
    </Suspense>
  );
}

function TerminalDrawer() {
  const needed = useTerminal((s) => s.open && s.tabs.length > 0);
  return needed ? (
    <Suspense fallback={null}>
      <TerminalPanel />
    </Suspense>
  ) : null;
}

export default function Shell() {
  useEffect(() => {
    hideSplash();
    // Startup marker (ms since the page started loading); see PERFORMANCE.md.
    (window as unknown as { __kernReadyAt?: number }).__kernReadyAt ??= performance.now();
  }, []);
  useAppearance();
  useOsIntegration();
  useBackendEvents();
  useGlobalShortcuts();
  useRememberRoute();
  useWorkSessions();
  useEasterEggs();
  // Remounted after switching space or account, so nothing shows stale data.
  const epoch = useEpoch((s) => s.epoch);
  return (
    <div className="shell">
      <Fragment key={epoch}>
        <Sidebar />
        <main className="workspace">
          <div className="workspace__main">
            <Routes />
          </div>
          <TerminalDrawer />
        </main>
        <Inspector />
        <CommandPalette />
        <QuickCapture />
        <CreateProjectDialog />
        <TaskModal />
        <TaskComposer />
        <ShortcutsDialog />
        <BriefingPrompt />
        <Onboarding />
        <TrustPromptHost />
        <RepoPickerHost />
        <SessionGapHost />
        <StartWorkHost />
        <FileViewerHost />
        <LazyHosts />
      </Fragment>
      <CloudHost />
      {/* Outside the epoch fragment: a question an assistant is waiting on
          isn't a space's business, and switching space shouldn't drop it. */}
      <McpApprovalHost />
      <ConfirmHost />
      <PromptHost />
      <Toaster />
    </div>
  );
}
