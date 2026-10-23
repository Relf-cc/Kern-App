/**
 * @Author Christian Relf
 * @Date 2026-10-23
 */

// Settings → Assistants: the Model Context Protocol, both ways round.
//
// An AI app the user already pays for - Claude Desktop, Claude Code - connects
// to Kern over a local pipe and works through a curated set of tools; and,
// the other way, Kern's own AI features can call MCP servers the user adds.
//
// The section is ordinary settings rows, so search finds every one of them.
// Each row says where things stand and offers one way in; anything that takes
// more than one decision opens a dialog, and anything that takes more than
// one step opens a guided one. The dialogs are their own chunks.

import { lazy, Suspense, useState, type ReactNode } from "react";
import { Ellipsis, Pencil, Play, Plus, Trash } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { McpClient, McpServer, McpStatus } from "@/lib/types";
import { api } from "@/lib/ipc";
import { relativeTime } from "@/lib/dates";
import { setSetting, useSetting } from "@/stores/settings";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { Dialog } from "@/components/ui/Dialog";
import { Switch } from "@/components/ui/Controls";
import { SNumber, SSelect, type GroupDef } from "@/features/settings/controls";
import { GUARANTEES, removeServer, setConnection, setServerEnabled, setServersAllowed, testServer } from "./mcpActions";
import { STATUS_LABEL, activitySummary, clientSummary, projectsLabel, serverSummary } from "./mcpForm";
import "./mcp.css";

const ConnectAssistantWizard = lazy(() => import("./ConnectAssistantWizard"));
const AssistantDialog = lazy(() => import("./AssistantDialog"));
const ProjectScopeDialog = lazy(() => import("./ProjectScopeDialog"));
const HttpEndpointDialog = lazy(() => import("./HttpEndpointDialog"));
const McpActivityDialog = lazy(() => import("./McpActivityDialog"));
const McpServerWizard = lazy(() => import("./McpServerWizard"));

/** A button that opens a lazily loaded dialog, the way every row here works. */
function Opens({ label, render, variant, icon }: { label: string; render: (close: () => void) => ReactNode; variant?: "primary" | "ghost"; icon?: typeof Plus }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={variant} icon={icon} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && <Suspense fallback={null}>{render(() => setOpen(false))}</Suspense>}
    </>
  );
}

function Pill({ state, children }: { state: string; children: ReactNode }) {
  return (
    <span className="mcp-status" data-status={state}>
      <span className="mcp-status__dot" />
      {children}
    </span>
  );
}

function connectionHint(enabled: boolean, status: McpStatus | undefined): string {
  if (!enabled) return "Off. Claude Desktop, Claude Code and other MCP apps can work in your projects, tasks and notes on their own subscription - no API key.";
  if (!status) return "On. Assistants you approve can connect.";
  if (!status.running) return "On, but not listening yet. If this lasts, turn it off and on again.";
  const approved = status.clients.filter((c) => c.status === "approved").length;
  const waiting = status.clients.filter((c) => c.status === "pending").length;
  const parts = ["Listening on this computer"];
  if (approved) parts.push(`${approved} connected`);
  if (waiting) parts.push(`${waiting} waiting for you`);
  return parts.join(" · ");
}

function ConnectionSwitch({ enabled, status }: { enabled: boolean; status?: McpStatus }) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      {enabled && status && <Pill state={status.running ? "on" : "off"}>{status.running ? "Listening" : "Stopped"}</Pill>}
      <Switch
        checked={enabled}
        disabled={busy}
        label="Let AI assistants connect to Kern"
        onChange={async (v) => {
          setBusy(true);
          await setConnection(v);
          setBusy(false);
        }}
      />
    </>
  );
}

function ClientControl({ c }: { c: McpClient }) {
  return (
    <>
      <Pill state={c.status}>{STATUS_LABEL[c.status]}</Pill>
      <Opens label={c.status === "pending" ? "Review…" : "Manage…"} variant={c.status === "pending" ? "primary" : undefined} render={(close) => <AssistantDialog id={c.id} onClose={close} />} />
    </>
  );
}

function AllowedProjectsButton() {
  const chosen = useSetting("mcp.allowedProjects");
  return (
    <Opens
      label={projectsLabel(chosen)}
      render={(close) => (
        <ProjectScopeDialog
          title="Projects assistants may see"
          lead="This covers every assistant, including ones that haven't connected yet. Each one can be narrowed further on its own."
          value={chosen}
          onSave={(ids) => setSetting("mcp.allowedProjects", ids)}
          onClose={close}
        />
      )}
    />
  );
}

function GuaranteesDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="What an assistant can reach"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <ul className="mcp-facts">
        {GUARANTEES.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </ul>
      <span className="field__hint">Anything an assistant reads leaves this computer with it, through its own app. Kern never reaches out to it.</span>
    </Dialog>
  );
}

function ServerControl({ s }: { s: McpServer }) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <Switch checked={s.enabled} onChange={(v) => void setServerEnabled(s, v)} label={`Use ${s.name}`} />
      <Dropdown
        align="end"
        items={() => [
          { label: "Test", icon: Play, onSelect: () => void testServer(s) },
          { label: "Edit…", icon: Pencil, onSelect: () => setEditing(true) },
          { type: "separator" },
          { label: "Remove…", icon: Trash, danger: true, onSelect: () => void removeServer(s) },
        ]}
      >
        <IconButton icon={Ellipsis} label={`${s.name} actions`} size="sm" noTooltip />
      </Dropdown>
      {editing && (
        <Suspense fallback={null}>
          <McpServerWizard server={s} onClose={() => setEditing(false)} />
        </Suspense>
      )}
    </>
  );
}

/**
 * The section's groups. `active` is whether it's on screen: settings search
 * reads every section's rows, but only the one being looked at needs to keep
 * its status fresh.
 */
export function useAssistantGroups(active: boolean): GroupDef[] {
  const enabled = useSetting("mcp.enabled");
  const httpOn = useSetting("mcp.httpEnabled");
  const serversOn = useSetting("mcp.toolsEnabled");
  const { data: status } = useQuery({ queryKey: ["mcp", "status"], queryFn: api.mcp.status, refetchInterval: active ? 15_000 : false, enabled: active });
  const { data: servers } = useQuery({ queryKey: ["mcp", "servers"], queryFn: api.mcp.servers, refetchInterval: active ? 20_000 : false, enabled: active });
  const { data: audit } = useQuery({ queryKey: ["mcp", "audit"], queryFn: () => api.mcp.audit(200), refetchInterval: active ? 20_000 : false, enabled: active });
  const clients = status?.clients ?? [];
  const http = status?.http;

  return [
    {
      title: "Assistants",
      rows: [
        {
          label: "Let AI assistants connect to Kern",
          hint: connectionHint(enabled, status),
          keywords: "mcp model context protocol claude desktop claude code assistant connector tools pipe subscription",
          control: <ConnectionSwitch enabled={enabled} status={status} />,
        },
        ...clients.map((c) => ({
          id: c.id,
          label: c.name,
          hint: clientSummary(c, relativeTime),
          keywords: "assistant client approve block forget read write access",
          control: <ClientControl c={c} />,
        })),
        {
          id: "mcp-connect",
          label: clients.length ? "Connect another assistant" : "Connect an assistant",
          hint: "Claude Desktop, Claude Code, or any app that speaks MCP. Kern does the setup where it can, then asks you to approve it.",
          keywords: "setup set up add claude desktop claude code mcpb extension command install",
          control: <Opens label="Connect…" variant={clients.length ? undefined : "primary"} icon={Plus} render={(close) => <ConnectAssistantWizard onClose={close} />} />,
        },
      ],
    },
    {
      title: "Safety",
      rows: [
        {
          label: "Ask before changes",
          hint: "Kern brings its window forward and waits. Nothing is written if you don't answer within two minutes.",
          keywords: "confirm approve writes permission prompt",
          control: (
            <SSelect
              k="mcp.confirmWrites"
              options={[
                { value: "never", label: "Never ask" },
                { value: "destructive", label: "Deletes and rewrites" },
                { value: "always", label: "Every change" },
              ]}
              width={190}
            />
          ),
        },
        {
          label: "Projects assistants may see",
          hint: "Covers every assistant; each can be narrowed further. Projects locked with a passkey are never visible.",
          keywords: "allowed projects allowlist scope limit",
          control: <AllowedProjectsButton />,
        },
        {
          label: "Calls each assistant may make",
          hint: "A confused assistant hits this instead of your database. 0 means no limit.",
          keywords: "rate limit calls per minute throttle",
          control: <SNumber k="mcp.maxCallsPerMinute" min={0} max={6000} suffix="a minute" width={84} />,
        },
        {
          label: "Activity",
          hint: audit ? activitySummary(audit, Date.now(), relativeTime) : "Every call an assistant makes, with a way to put its changes back.",
          keywords: "audit log history revert undo batch calls",
          control: <Opens label="View…" render={(close) => <McpActivityDialog onClose={close} />} />,
        },
        { label: "Keep activity for", hint: "Older entries are deleted automatically.", keywords: "audit retention", control: <SNumber k="mcp.auditDays" min={1} max={3650} suffix="days" /> },
        {
          label: "What an assistant can reach",
          hint: "Read-only until you allow changes, deletes go to Trash, and the terminal, folders and secrets are never exposed.",
          keywords: "privacy security guarantees exposed data",
          control: <Opens label="Read…" variant="ghost" render={(close) => <GuaranteesDialog onClose={close} />} />,
        },
      ],
    },
    {
      title: "Local address",
      rows: [
        {
          label: "Listen on a local web address",
          hint: !httpOn
            ? "Off. Only for apps that take a URL instead of a command - Claude Desktop and Claude Code don't need it."
            : http?.problem
              ? http.problem
              : (http?.url ?? "…"),
          keywords: "http port token bearer localhost endpoint url",
          control: (
            <>
              {httpOn && http && <Pill state={http.running ? "on" : "revoked"}>{http.running ? "Listening" : "Not listening"}</Pill>}
              <Opens label={httpOn ? "Manage…" : "Set up…"} render={(close) => <HttpEndpointDialog onClose={close} />} />
            </>
          ),
        },
      ],
    },
    {
      title: "Servers Kern can use",
      rows: [
        {
          label: "Let Kern's AI features use MCP servers",
          hint: "The other way round: Kern starts these programs on this computer and offers their tools to the model during an assist or catch-up.",
          keywords: "mcp servers tools external outbound client",
          control: <Switch checked={serversOn} onChange={(v) => void setServersAllowed(v)} label="Let Kern's AI features use MCP servers" />,
        },
        ...(servers ?? []).map((s) => ({
          id: s.id,
          label: s.name,
          hint: serverSummary(s, relativeTime),
          keywords: "mcp server tools",
          control: <ServerControl s={s} />,
        })),
        {
          label: "Add a server",
          hint: "Filesystem, Git, Fetch, Playwright - or any command that speaks MCP.",
          keywords: "add mcp server filesystem git fetch memory playwright npx uvx",
          control: <Opens label="Add…" icon={Plus} render={(close) => <McpServerWizard onClose={close} />} />,
        },
        ...(serversOn
          ? [
              {
                label: "Rounds of tool calls per request",
                hint: "Each round is a request of its own to your AI provider, and is billed as one. Kern stops after this many and answers with what it has.",
                keywords: "tool rounds loop limit",
                control: <SNumber k="ai.maxToolRounds" min={1} max={12} suffix="rounds" width={84} />,
              },
            ]
          : []),
      ],
    },
  ];
}
