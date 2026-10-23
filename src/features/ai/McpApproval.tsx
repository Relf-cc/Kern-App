/**
 * @Author Christian Relf
 * @Date 2026-10-23
 */

// "Claude Desktop wants to move 3 tasks to Trash" - the dialog an assistant's
// write waits on when Settings → Assistants is set to ask. The same host also
// opens "Claude Desktop wants to connect" from the toast that says so, so an
// assistant can be approved from wherever you are rather than from Settings.
//
// The backend is holding a tool call open on a channel, not the database, so
// taking a moment here costs nothing elsewhere in the app. Silence is a no:
// the countdown runs out and the call is refused, because nobody being at the
// keyboard is exactly when a write shouldn't go through.

import { lazy, Suspense, useEffect, useState } from "react";
import { Bot, ShieldAlert } from "lucide-react";
import { create } from "zustand";
import type { McpConfirmRequest } from "@/lib/types";
import { api } from "@/lib/ipc";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { announce } from "@/lib/announce";
import "./mcp.css";

/** The question on screen, if there is one. Pushed from `app/effects.ts`. */
export const useMcpConfirm = create<{ req: McpConfirmRequest | null; review: string | null }>(() => ({ req: null, review: null }));

// Settings code, so only fetched once someone actually asks to review.
const AssistantDialog = lazy(() => import("./AssistantDialog"));

/** Opens the approve-or-block dialog for one assistant. */
export function reviewAssistant(id: string) {
  useMcpConfirm.setState({ review: id });
}

export function askMcpConfirm(req: McpConfirmRequest) {
  useMcpConfirm.setState({ req });
  announce(`${req.client} is asking to change something in Kern.`);
}

/** Closes the dialog if the call it belongs to has given up waiting. */
export function closeMcpConfirm(id: string) {
  if (useMcpConfirm.getState().req?.id === id) useMcpConfirm.setState({ req: null });
}

/**
 * What each tool is asking for, in a sentence. `detail` is a count for the
 * batch tools ("3 tasks") and a title or an id otherwise, so only the counted
 * ones read it back.
 */
const WANTS: Record<string, (detail: string) => string> = {
  kern_task_create: (d) => `create ${d}`,
  kern_task_update: () => "change a task",
  kern_task_move: (d) => `move ${d}`,
  kern_task_complete: (d) => `complete ${d}`,
  kern_task_delete: (d) => `move ${d} to Trash`,
  kern_note_create: () => "write a note",
  kern_note_update: () => "rewrite a note",
  kern_board_create: () => "create a board",
  kern_project_setup: (d) => `set up the project “${d}”`,
  kern_project_update: () => "change a project",
  kern_milestone_create: (d) => `add the milestone “${d}”`,
  kern_label_create: (d) => `create the label “${d}”`,
  kern_whiteboard_from_mermaid: () => "draw a flowchart",
};

export function McpApprovalHost() {
  const req = useMcpConfirm((s) => s.req);
  const review = useMcpConfirm((s) => s.review);
  const [left, setLeft] = useState(0);

  // One timer per question, started when it appears. The backend keeps its
  // own clock - this is only so the dialog says how long is left.
  useEffect(() => {
    if (!req) return;
    setLeft(req.seconds);
    const t = window.setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearInterval(t);
  }, [req]);

  const answer = (allow: boolean) => {
    const id = req?.id;
    useMcpConfirm.setState({ req: null });
    if (id) void api.mcp.confirmAnswer(id, allow).catch(() => {});
  };

  // The backend decides this: the same tool can take something away or not,
  // depending on what it was asked to do.
  const danger = !!req?.destructive;
  const wants = req ? (WANTS[req.tool]?.(req.detail) ?? "change something") : "";
  return (
    <>
      {review && (
        <Suspense fallback={null}>
          <AssistantDialog id={review} onClose={() => useMcpConfirm.setState({ review: null })} />
        </Suspense>
      )}
      <Dialog
        open={!!req}
        onOpenChange={(o) => !o && answer(false)}
        title={req ? `${req.client} wants to ${wants}` : undefined}
        centered
        hideClose
        className="mcp-ask"
        footer={
          <>
            <span className="mcp-ask__clock tabular faint">
              {left > 0 ? `Refused in ${left}s if you don't answer` : "Waiting…"}
            </span>
            <Button variant="ghost" onClick={() => answer(false)} autoFocus={danger}>
              Don't allow
            </Button>
            <Button variant={danger ? "danger" : "primary"} autoFocus={!danger} onClick={() => answer(true)}>
              Allow
            </Button>
          </>
        }
      >
        {req && (
          <>
            <div className="mcp-ask__tool">
              {danger ? <ShieldAlert size={15} /> : <Bot size={15} />}
              <span className="mono">{req.tool.replace(/^kern_/, "")}</span>
              <span className="faint">{req.detail}</span>
            </div>
            <p className="dialog__desc">
              It is connected over Kern's local pipe and has write access. Allowing this changes your real work — an
              assistant's deletes go to Trash, and Activity in Settings → Assistants can put the whole call back afterwards.
            </p>
            <p className="dialog__desc faint">
              Asked because <b>Ask before changes</b> is on in Settings → Assistants.
            </p>
          </>
        )}
      </Dialog>
    </>
  );
}
