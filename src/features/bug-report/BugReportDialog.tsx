/**
 * @Author Christian Relf
 * @Date 2026-10-24
 */

// Report a bug: what the person writes becomes a task in the Kern workspace,
// through its bug report stream (src-tauri/src/domain/bugreport.rs). No
// account is needed, and nothing else from the computer is sent.

import { useMemo, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Callout, Checkbox, Segmented } from "@/components/ui/Controls";
import { useAppInfo } from "@/hooks/data";
import { api, describeError } from "@/lib/ipc";
import type { BugSeverity } from "@/lib/types";
import { useCloud } from "@/features/cloud/store";
import { toast } from "@/stores/toast";
import { closeBugReport } from "./open";

const PLATFORM: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

export default function BugReportHost() {
  const accountEmail = useCloud((s) => s.info?.account?.email ?? "");
  const { data: app } = useAppInfo();
  const available = useQuery({ queryKey: ["bugReport", "available"], queryFn: api.bugReport.available, staleTime: Infinity });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState("");
  const [severity, setSeverity] = useState<BugSeverity>("medium");
  const [email, setEmail] = useState(accountEmail);
  const [includeSystem, setIncludeSystem] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per version of the report: a retry of the same report is
  // recognised as already sent, an edited one is a new report.
  const key = useMemo(() => crypto.randomUUID(), [title, description, steps, severity, email, includeSystem]);

  const off = available.data === false;
  const blocking = !title.trim() || !description.trim() ? "Add a summary and what happened." : null;

  const send = async () => {
    if (blocking || off || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.bugReport.send({ title, description, steps, severity, email, includeSystem }, key);
      toast("Sent your bug report");
      closeBugReport();
    } catch (e) {
      setError(describeError(e, "Couldn't send the bug report."));
    } finally {
      setSending(false);
    }
  };

  const sendOnCtrlEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };

  const system = app ? `Kern ${app.version} on ${PLATFORM[app.platform] ?? app.platform}` : "your Kern version and operating system";

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !sending && closeBugReport()}
      title="Report a bug"
      description="It goes to the Kern team as a task in the Kern workspace. You don't need an account."
      footer={
        <>
          {blocking && !off && (
            <span className="field__hint" style={{ marginRight: "auto" }}>
              {blocking}
            </span>
          )}
          <Button variant="ghost" onClick={closeBugReport} disabled={sending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void send()} disabled={!!blocking || off || sending}>
            {sending ? "Sending…" : "Send report"}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {off && <Callout icon={CircleAlert} tone="warn" title="Bug reports aren't set up in this copy of Kern." />}
        <div className="field">
          <label className="field__label" htmlFor="bug-title">
            Summary
          </label>
          <input id="bug-title" className="input" autoFocus maxLength={200} placeholder="The board stops scrolling after I drag a card" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void send()} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="bug-description">
            What happened
          </label>
          <textarea id="bug-description" className="textarea" rows={4} maxLength={5000} placeholder="What you expected, and what happened instead." value={description} onChange={(e) => setDescription(e.target.value)} onKeyDown={sendOnCtrlEnter} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="bug-steps">
            Steps to reproduce
          </label>
          <textarea id="bug-steps" className="textarea" rows={3} maxLength={5000} placeholder={"1. Open a project board\n2. Drag a card to another column\n3. Try to scroll"} value={steps} onChange={(e) => setSteps(e.target.value)} onKeyDown={sendOnCtrlEnter} />
          <span className="field__hint">Optional.</span>
        </div>
        <div className="field">
          <span className="field__label">How bad is it</span>
          <Segmented
            value={severity}
            onChange={setSeverity}
            ariaLabel="Severity"
            options={[
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
              { value: "critical", label: "Critical" },
            ]}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="bug-email">
            Contact email
          </label>
          <input id="bug-email" className="input" type="email" maxLength={254} placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <span className="field__hint">Optional. Only used to ask you about this report.</span>
        </div>
        <label className="row" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
          <Checkbox checked={includeSystem} onChange={setIncludeSystem} label="Include your Kern version and operating system" />
          <span>Include {system}</span>
        </label>
        {error && <Callout icon={CircleAlert} tone="danger" title={error} />}
      </div>
    </Dialog>
  );
}
