/**
 * @Author Christian Relf
 * @Date 2026-10-23
 */

// Everything assistants did in Kern, and everything Kern ran on your servers,
// in one place. Each assistant call that changed something still there to
// change back carries Revert; one call is one batch, so a project that
// arrived with twenty tasks goes back as a project with twenty tasks.

import { useState } from "react";
import { History, Undo2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { McpAuditEntry } from "@/lib/types";
import { api } from "@/lib/ipc";
import { relativeTime } from "@/lib/dates";
import { useSetting } from "@/stores/settings";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { EmptyState, Segmented, Select, Skeleton } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { revertCall } from "./mcpActions";
import "./mcp.css";

type View = "assistants" | "servers";

export default function McpActivityDialog({ onClose }: { onClose: () => void }) {
  const days = useSetting("mcp.auditDays");
  const [view, setView] = useState<View>("assistants");
  const { data: servers } = useQuery({ queryKey: ["mcp", "servers"], queryFn: api.mcp.servers });
  const hasServers = (servers?.length ?? 0) > 0;
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={
        <span className="row" style={{ gap: 8 }}>
          <History size={16} strokeWidth={1.75} /> Activity
        </span>
      }
      footer={
        <>
          <span className="faint mcp-footnote">Entries older than {days} day{days === 1 ? "" : "s"} are deleted. Arguments are described, never copied.</span>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {hasServers && (
        <Segmented
          value={view}
          onChange={setView}
          ariaLabel="Whose activity"
          options={[
            { value: "assistants", label: "Assistants in Kern" },
            { value: "servers", label: "Kern on your servers" },
          ]}
        />
      )}
      {view === "assistants" ? <AssistantCalls /> : <ServerCalls />}
    </Dialog>
  );
}

function AssistantCalls() {
  const { data: rows } = useQuery({ queryKey: ["mcp", "audit"], queryFn: () => api.mcp.audit(200), refetchInterval: 10_000 });
  const [who, setWho] = useState("all");
  if (!rows) return <Skeleton height={160} />;
  const names = [...new Map(rows.map((r) => [r.clientId, r.clientName])).entries()];
  const shown = who === "all" ? rows : rows.filter((r) => r.clientId === who);
  if (rows.length === 0)
    return (
      <EmptyState icon={History} title="Nothing yet" compact>
        Every call an assistant makes is listed here, with a way to put its changes back.
      </EmptyState>
    );
  return (
    <>
      {names.length > 1 && (
        <Select value={who} onChange={setWho} ariaLabel="Assistant" style={{ alignSelf: "flex-start", minWidth: 200 }} options={[{ value: "all", label: "Every assistant" }, ...names.map(([id, name]) => ({ value: id, label: name }))]} />
      )}
      <ul className="mcp-audit">
        {shown.map((r) => (
          <AuditRow key={r.id} r={r} />
        ))}
      </ul>
    </>
  );
}

function AuditRow({ r }: { r: McpAuditEntry }) {
  const [busy, setBusy] = useState(false);
  return (
    <li data-ok={r.ok} data-reverted={!!r.revertedAt}>
      <span className="mcp-audit__when tabular">{relativeTime(r.createdAt)}</span>
      <span className="mcp-audit__who truncate">{r.clientName}</span>
      <span className="mcp-audit__tool mono">{r.tool.replace(/^kern_/, "")}</span>
      <span className="mcp-audit__detail">{r.ok ? (r.detail ?? "") : (r.message ?? "Refused")}</span>
      <span className="mcp-audit__revert">
        {r.revertedAt ? (
          <Tooltip content={`Put back ${relativeTime(r.revertedAt)}`}>
            <span>Reverted</span>
          </Tooltip>
        ) : r.revertable ? (
          <Button
            size="sm"
            variant="ghost"
            icon={Undo2}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await revertCall(r.id, r.clientName);
              setBusy(false);
            }}
          >
            Revert
          </Button>
        ) : null}
      </span>
    </li>
  );
}

function ServerCalls() {
  const { data: rows } = useQuery({ queryKey: ["mcp", "tool-calls"], queryFn: () => api.mcp.serverCalls(200), refetchInterval: 10_000 });
  if (!rows) return <Skeleton height={160} />;
  if (rows.length === 0)
    return (
      <EmptyState icon={History} title="Nothing yet" compact>
        When Kern's AI features use one of your servers, each tool it runs is listed here.
      </EmptyState>
    );
  return (
    <ul className="mcp-audit">
      {rows.map((r) => (
        <li key={r.id} data-ok={r.ok}>
          <span className="mcp-audit__when tabular">{relativeTime(r.createdAt)}</span>
          <span className="mcp-audit__who truncate">{r.serverName}</span>
          <span className="mcp-audit__tool mono">{r.tool}</span>
          <span className="mcp-audit__detail">{r.ok ? `${r.durationMs ?? 0} ms` : (r.message ?? "Failed")}</span>
          <span className="mcp-audit__revert" />
        </li>
      ))}
    </ul>
  );
}
