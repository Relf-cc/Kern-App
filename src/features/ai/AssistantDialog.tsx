/**
 * @Author Christian Relf
 * @Date 2026-10-23
 */

// One assistant: approving it when it first asks to connect, and everything
// about it afterwards. Opened from its row in Settings → Assistants, and from
// the "wants to connect" toast wherever you are in Kern.
//
// While it is waiting, nothing applies until Approve, so the choices on screen
// are the ones it gets. Once approved, a change applies as it is made, the
// way a settings row does.

import { lazy, Suspense, useEffect, useState } from "react";
import { Ban, Bot, FolderCheck, Undo2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { McpClient, McpScope } from "@/lib/types";
import { api } from "@/lib/ipc";
import { relativeTime } from "@/lib/dates";
import { useSetting } from "@/stores/settings";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { RadioCards } from "@/components/ui/Controls";
import { forgetClient, patchClient, revertCall } from "./mcpActions";
import { SCOPE_LABEL, STATUS_LABEL, projectsLabel } from "./mcpForm";
import "./mcp.css";

const ProjectScopeDialog = lazy(() => import("./ProjectScopeDialog"));

export const SCOPE_OPTIONS = [
  { value: "read" as McpScope, title: SCOPE_LABEL.read, text: "Search and read your projects, tasks, notes and boards. Changes nothing." },
  { value: "write" as McpScope, title: SCOPE_LABEL.write, text: "Also create and change them. Deletes go to Trash, and every change can be put back." },
];

export default function AssistantDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: status } = useQuery({ queryKey: ["mcp", "status"], queryFn: api.mcp.status });
  const c = status?.clients.find((x) => x.id === id);
  const gone = !!status && !c;
  // Forgotten from somewhere else while this was open.
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  return c ? <Body key={c.id} c={c} onClose={onClose} /> : null;
}

function Body({ c, onClose }: { c: McpClient; onClose: () => void }) {
  const pending = c.status === "pending";
  const global = useSetting("mcp.allowedProjects");
  // Held here until Approve while it is waiting; written straight through after.
  const [scope, setScope] = useState<McpScope>(c.scope);
  const [projects, setProjects] = useState<string[]>(c.projects);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  const changeScope = (s: McpScope) => {
    setScope(s);
    if (!pending) void patchClient(c, { scope: s });
  };
  const changeProjects = async (ids: string[]) => {
    setProjects(ids);
    if (!pending) await patchClient(c, { projects: ids });
  };
  const decide = async (status: McpClient["status"]) => {
    setBusy(true);
    const ok = await patchClient(c, pending ? { status, scope, projects } : { status });
    setBusy(false);
    if (ok && pending) onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={pending ? `${c.name} wants to connect` : c.name}
      footer={
        pending ? (
          <>
            <Button variant="ghost" icon={Ban} disabled={busy} onClick={() => void decide("revoked")} style={{ marginRight: "auto" }}>
              Block
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Not now
            </Button>
            <Button variant="primary" autoFocus disabled={busy} onClick={() => void decide("approved")}>
              Approve
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => void forgetClient(c).then((gone) => gone && onClose())} style={{ marginRight: "auto" }}>
              Forget…
            </Button>
            {c.status === "approved" ? (
              <Button variant="ghost" icon={Ban} disabled={busy} onClick={() => void decide("revoked")}>
                Block
              </Button>
            ) : (
              <Button variant="ghost" disabled={busy} onClick={() => void decide("approved")}>
                Allow again
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        )
      }
    >
      <div className="mcp-who">
        <span className="provider-icon" style={{ width: 32, height: 32 }} aria-hidden>
          <Bot size={17} strokeWidth={1.75} />
        </span>
        <div className="col" style={{ minWidth: 0 }}>
          <span className="mcp-status" data-status={c.status}>
            <span className="mcp-status__dot" />
            {STATUS_LABEL[c.status]}
          </span>
          <span className="faint mcp-who__meta">
            {pending ? `Asked ${relativeTime(c.createdAt)} from this computer` : `Approved ${c.approvedAt ? relativeTime(c.approvedAt) : "-"}`}
            {c.lastSeenAt ? ` · last used ${relativeTime(c.lastSeenAt)}` : ""}
          </span>
        </div>
      </div>
      {pending && (
        <p className="wizard-lead">
          It is running on this computer and asked for Kern by name. Choose what it may do - you can change this at any time, and nothing it does can't be put back.
        </p>
      )}
      {c.status === "revoked" && <p className="wizard-lead">Blocked: every call it makes is refused. Allow it again to restore the access below.</p>}
      <div className="field">
        <span className="field__label">What it may do</span>
        <RadioCards value={scope} onChange={changeScope} options={SCOPE_OPTIONS} ariaLabel={`What ${c.name} may do`} columns={2} />
      </div>
      <div className="field">
        <span className="field__label">Projects</span>
        <div className="mcp-line">
          <span className="grow">
            {projectsLabel(projects)}
            {global.length > 0 && <span className="faint"> - within the {projectsLabel(global).toLowerCase()} every assistant is limited to</span>}
          </span>
          <Button size="sm" icon={FolderCheck} onClick={() => setPicking(true)}>
            Choose…
          </Button>
        </div>
      </div>
      {!pending && <RecentCalls c={c} />}
      {picking && (
        <Suspense fallback={null}>
          <ProjectScopeDialog
            title={`Projects ${c.name} may see`}
            lead="Anything outside these is invisible to it, and it can't create a new project."
            value={projects}
            within={global}
            onSave={changeProjects}
            onClose={() => setPicking(false)}
          />
        </Suspense>
      )}
    </Dialog>
  );
}

/** Its last few calls, so "what has it been doing?" is answered where it's asked. */
function RecentCalls({ c }: { c: McpClient }) {
  const { data: rows } = useQuery({ queryKey: ["mcp", "audit"], queryFn: () => api.mcp.audit(200) });
  const mine = (rows ?? []).filter((r) => r.clientId === c.id).slice(0, 5);
  return (
    <div className="field">
      <span className="field__label">Recent calls</span>
      {mine.length === 0 ? (
        <span className="field__hint">None kept. Calls appear here and in Activity as it makes them.</span>
      ) : (
        <ul className="mcp-audit mcp-audit--compact">
          {mine.map((r) => (
            <li key={r.id} data-ok={r.ok} data-reverted={!!r.revertedAt}>
              <span className="mcp-audit__when tabular">{relativeTime(r.createdAt)}</span>
              <span className="mcp-audit__tool mono">{r.tool.replace(/^kern_/, "")}</span>
              <span className="mcp-audit__detail">{r.ok ? (r.detail ?? "") : (r.message ?? "Refused")}</span>
              <span className="mcp-audit__revert">
                {r.revertedAt ? (
                  "Reverted"
                ) : r.revertable ? (
                  <Button size="sm" variant="ghost" icon={Undo2} onClick={() => void revertCall(r.id, c.name)}>
                    Revert
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
