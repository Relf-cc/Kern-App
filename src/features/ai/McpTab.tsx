/**
 * @Author Christian Relf
 * @Date 2026-10-22
 */

// Settings → API → Assistants (/api/mcp): the Model Context Protocol server.
// An AI client the user already pays for - Claude Desktop, Claude Code -
// connects to Kern over a local pipe and works through a curated set of
// tools. Kern is the server here; nothing reaches out.

import { useEffect, useState } from "react";
import { Ban, Bot, Check, Copy, FolderCheck, Package, ShieldCheck, Terminal, Trash, Undo2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { McpAuditEntry, McpClient, McpScope } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown, type MenuItems } from "@/components/ui/Menu";
import { EmptyState, Select, Skeleton, Switch } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { confirm } from "@/components/ui/Dialog";
import { toast, toastError } from "@/stores/toast";
import { setSetting, useSetting } from "@/stores/settings";
import { useProjects } from "@/hooks/data";
import { relativeTime } from "@/lib/dates";
import { SNumber, SSelect } from "@/features/settings/controls";
import "./mcp.css";

const GUARANTEES = [
  "Nothing listens until you switch this on, and nothing connects until you approve it by name.",
  "The connection is a local pipe only your user account can open - no port, no token, nothing on the network.",
  "Each assistant is read-only until you give it write access, and can be limited to the projects you choose.",
  "Kern can ask you before anything is written, and every change an assistant makes can be put back in one go.",
  "Projects locked with a passkey stay invisible, as they do everywhere else in Kern.",
  "Deleting through an assistant moves items to Trash; nothing an assistant does destroys data.",
  "Linked folders, the terminal, environment variables, tokens and your settings are not exposed at all.",
  "Every call is listed below with what it touched - arguments are described, never copied.",
];

const STATUS_LABEL: Record<string, string> = { pending: "Waiting for approval", approved: "Connected", revoked: "Blocked" };

async function patch(c: McpClient, p: Parameters<typeof api.mcp.updateClient>[1]) {
  try {
    await api.mcp.updateClient(c.id, p);
  } catch (e) {
    toastError(describeError(e));
  } finally {
    invalidate("mcp");
  }
}

async function removeClient(c: McpClient) {
  const ok = await confirm({
    title: `Forget ${c.name}?`,
    message: "Its approval and its activity here are deleted. If it connects again it has to be approved afresh.",
    confirmLabel: "Forget assistant",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.mcp.removeClient(c.id);
    toast(`Forgot ${c.name}`);
  } catch (e) {
    toastError(describeError(e));
  } finally {
    invalidate("mcp");
  }
}

export function McpTab() {
  const enabled = useSetting("mcp.enabled");
  const { data: status, isLoading } = useQuery({ queryKey: ["mcp", "status"], queryFn: api.mcp.status, refetchInterval: 15_000 });
  const [busy, setBusy] = useState(false);

  // The listener follows the setting, so the switch writes the setting and
  // then asks the backend to catch up - it is never written in two places.
  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      await setSetting("mcp.enabled", on);
      await api.mcp.sync();
    } catch (e) {
      toastError(describeError(e, "Couldn't change the assistant connection."));
    } finally {
      setBusy(false);
      invalidate("mcp");
    }
  };

  return (
    <div className="col" style={{ gap: 20 }}>
      <section>
        <div className="set-group__title">Assistants</div>
        <div className="set-group">
          <div className="set-row">
            <div className="set-row__text">
              <span className="set-row__label">Let AI assistants connect to Kern</span>
              <span className="set-row__hint">
                Claude Desktop and Claude Code can read your work and create tasks, notes and boards on your own subscription - no API key and nothing per token. Kern's own AI features are separate and still use an account under Accounts.
              </span>
            </div>
            <div className="set-row__control">
              <Switch checked={enabled} disabled={busy} onChange={(v) => void toggle(v)} label="Let AI assistants connect to Kern" />
            </div>
          </div>
          <div className="set-row">
            <div className="set-row__text">
              <span className="set-row__label">Connection</span>
              <span className="set-row__hint mono">{status ? status.endpoint : "…"}</span>
            </div>
            <div className="set-row__control">
              {isLoading ? (
                <Skeleton width={90} />
              ) : (
                <span className="mcp-status" data-status={status?.running ? "on" : "off"}>
                  <span className="mcp-status__dot" />
                  {status?.running ? "Listening" : "Stopped"}
                </span>
              )}
            </div>
          </div>
          <div className="set-row">
            <div className="set-row__text">
              <span className="set-row__label">Ask before changes</span>
              <span className="set-row__hint">
                Kern brings its window forward and waits for you. Nothing is written if you don't answer within two minutes.
              </span>
            </div>
            <div className="set-row__control">
              <SSelect
                k="mcp.confirmWrites"
                options={[
                  { value: "never", label: "Never ask" },
                  { value: "destructive", label: "Deletes and rewrites" },
                  { value: "always", label: "Every change" },
                ]}
                width={180}
              />
            </div>
          </div>
          <AllowedProjects />
          <div className="set-row">
            <div className="set-row__text">
              <span className="set-row__label">Limit each assistant to</span>
              <span className="set-row__hint">Tool calls a minute. A confused assistant hits this instead of your database. 0 means no limit.</span>
            </div>
            <div className="set-row__control">
              <SNumber k="mcp.maxCallsPerMinute" min={0} max={6000} suffix="per minute" width={84} />
            </div>
          </div>
        </div>
      </section>

      {enabled && <SetUp />}
      <Clients clients={status?.clients ?? []} loading={isLoading} />
      {enabled && <Activity />}

      <section>
        <div className="set-group__title">What an assistant can reach</div>
        <ul className="ai-guarantees">
          {GUARANTEES.map((g) => (
            <li key={g}>
              <ShieldCheck size={13} />
              {g}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * The allowlist that covers every assistant, present and future. Each client
 * has one of its own as well; a project has to be in both.
 */
function AllowedProjects() {
  const chosen = useSetting("mcp.allowedProjects");
  const { data: projects } = useProjects(false);
  const all = projects ?? [];
  const set = (ids: string[]) => void setSetting("mcp.allowedProjects", ids);
  const items = (): MenuItems => [
    { type: "label", label: "Assistants may see" },
    { label: "Every project", checked: chosen.length === 0, onSelect: () => set([]) },
    { type: "separator" },
    ...all.map((p) => ({
      label: p.name,
      checked: chosen.includes(p.id),
      onSelect: () => set(chosen.includes(p.id) ? chosen.filter((x) => x !== p.id) : [...chosen, p.id]),
    })),
  ];
  return (
    <div className="set-row">
      <div className="set-row__text">
        <span className="set-row__label">Projects assistants may see</span>
        <span className="set-row__hint">
          {chosen.length === 0
            ? "All of them, unless an assistant is narrowed further below. Nothing can be seen in a project locked with a passkey."
            : "Everything outside these is invisible, and no assistant can create a project while this is set."}
        </span>
      </div>
      <div className="set-row__control">
        <Dropdown items={items} minWidth={220}>
          <Button size="sm" variant="ghost" icon={FolderCheck}>
            {chosen.length === 0 ? "All projects" : `${chosen.length} project${chosen.length === 1 ? "" : "s"}`}
          </Button>
        </Dropdown>
      </div>
    </div>
  );
}

/** The two clients Kern can set up, and the copy-it-yourself fallback. */
function SetUp() {
  const { data: setup } = useQuery({ queryKey: ["mcp", "setup"], queryFn: api.mcp.setup });
  const [wrote, setWrote] = useState<string | null>(null);
  if (!setup) return <Skeleton height={80} />;
  return (
    <section>
      <div className="set-group__title">Connect an assistant</div>
      <div className="set-group">
        {!setup.bridgeExists && (
          <div className="set-row">
            <span className="set-row__hint">
              The <span className="mono">kern-mcp</span> helper isn't beside Kern on this computer, so there is nothing for an assistant to run yet. It is expected at <span className="mono">{setup.bridgePath}</span>.
            </span>
          </div>
        )}
        <div className="set-row">
          <Bot size={14} className="faint" />
          <div className="set-row__text">
            <span className="set-row__label">Claude Desktop</span>
            <span className="set-row__hint">
              {wrote
                ? `Added to ${wrote}. Restart Claude Desktop, then approve Kern below when it connects.`
                : "Kern adds itself to Claude Desktop's settings file, keeping whatever else is in it. Restart Claude Desktop afterwards."}
            </span>
          </div>
          <div className="set-row__control row" style={{ gap: 6 }}>
            <Button
              size="sm"
              disabled={!setup.bridgeExists}
              onClick={async () => {
                try {
                  setWrote(await api.mcp.setupClaudeDesktop());
                  toast("Added Kern to Claude Desktop");
                } catch (e) {
                  toastError(describeError(e, "Couldn't write Claude Desktop's settings."));
                }
              }}
            >
              Set up
            </Button>
            <Tooltip content="Copy the settings fragment instead">
              <IconButton icon={Copy} label="Copy configuration" size="sm" onClick={() => void navigator.clipboard.writeText(setup.claudeDesktop).then(() => toast("Configuration copied"))} />
            </Tooltip>
          </div>
        </div>
        {setup.bundlePath && (
          <div className="set-row">
            <Package size={14} className="faint" />
            <div className="set-row__text">
              <span className="set-row__label">Extension bundle</span>
              <span className="set-row__hint">
                Drag <span className="mono">kern.mcpb</span> onto Claude Desktop's Settings → Extensions to install it there instead. Same connection, no settings file to edit.
              </span>
            </div>
            <div className="set-row__control">
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    await api.mcp.revealBundle();
                  } catch (e) {
                    toastError(describeError(e, "Couldn't show the bundle."));
                  }
                }}
              >
                Show in folder
              </Button>
            </div>
          </div>
        )}
        <div className="set-row">
          <Terminal size={14} className="faint" />
          <div className="set-row__text">
            <span className="set-row__label">Claude Code</span>
            <span className="set-row__hint mono mcp-command">{setup.claudeCode}</span>
          </div>
          <div className="set-row__control">
            <Button size="sm" icon={Copy} disabled={!setup.bridgeExists} onClick={() => void navigator.clipboard.writeText(setup.claudeCode).then(() => toast("Command copied"))}>
              Copy
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Clients({ clients, loading }: { clients: McpClient[]; loading: boolean }) {
  return (
    <section>
      <div className="set-group__title">Assistants that have connected</div>
      {loading ? (
        <Skeleton height={60} />
      ) : clients.length === 0 ? (
        <EmptyState icon={Bot} title="No assistant has connected yet" compact>
          Set one up above. The first time it connects it appears here, waiting for your approval.
        </EmptyState>
      ) : (
        <div className="set-group">
          {clients.map((c) => (
            <ClientRow key={c.id} c={c} />
          ))}
        </div>
      )}
    </section>
  );
}

function ClientRow({ c }: { c: McpClient }) {
  const { data: projects } = useProjects(false);
  const all = projects ?? [];
  const chosen = c.projects.length;
  const menu = (): MenuItems => [
    c.status !== "approved" && { label: "Approve", icon: Check, onSelect: () => void patch(c, { status: "approved" }) },
    c.status !== "revoked" && { label: "Block", icon: Ban, onSelect: () => void patch(c, { status: "revoked" }) },
    c.status === "revoked" && { label: "Return to pending", icon: Bot, onSelect: () => void patch(c, { status: "pending" }) },
    { type: "separator" },
    { label: "Forget…", icon: Trash, danger: true, onSelect: () => void removeClient(c) },
  ];
  const projectMenu = (): MenuItems => [
    { type: "label", label: "This assistant may see" },
    { label: "Every project", checked: chosen === 0, onSelect: () => void patch(c, { projects: [] }) },
    { type: "separator" },
    ...all.map((p) => ({
      label: p.name,
      checked: c.projects.includes(p.id),
      onSelect: () => void patch(c, { projects: c.projects.includes(p.id) ? c.projects.filter((x) => x !== p.id) : [...c.projects, p.id] }),
    })),
  ];
  return (
    <div className="set-row">
      <Bot size={14} className="faint" />
      <div className="set-row__text">
        <span className="set-row__label">{c.name}</span>
        <span className="set-row__hint row" style={{ gap: 6 }}>
          <span className="mcp-status" data-status={c.status}>
            <span className="mcp-status__dot" />
            {STATUS_LABEL[c.status] ?? c.status}
          </span>
          {c.lastSeenAt ? `· last used ${relativeTime(c.lastSeenAt)}` : null}
        </span>
      </div>
      <div className="set-row__control row" style={{ gap: 6 }}>
        <Select
          value={c.scope}
          onChange={(v: McpScope) => void patch(c, { scope: v })}
          options={[
            { value: "read", label: "Read only" },
            { value: "write", label: "Read and write" },
          ]}
          ariaLabel={`What ${c.name} may do`}
          style={{ minWidth: 150 }}
        />
        <Dropdown items={projectMenu} minWidth={220}>
          <Button size="sm" variant="ghost" icon={FolderCheck}>
            {chosen === 0 ? "All projects" : `${chosen} project${chosen === 1 ? "" : "s"}`}
          </Button>
        </Dropdown>
        <Dropdown items={menu}>
          <Button size="sm" variant={c.status === "pending" ? "primary" : "ghost"}>
            {c.status === "approved" ? "Approved" : c.status === "revoked" ? "Blocked" : "Approve…"}
          </Button>
        </Dropdown>
      </div>
    </div>
  );
}

function Activity() {
  const { data: rows, refetch } = useQuery({ queryKey: ["mcp", "audit"], queryFn: () => api.mcp.audit(60) });
  useEffect(() => {
    const t = window.setInterval(() => void refetch(), 20_000);
    return () => window.clearInterval(t);
  }, [refetch]);
  return (
    <section>
      <div className="set-group__title">Recent activity</div>
      <div className="set-group">
        <div className="set-row">
          <div className="set-row__text">
            <span className="set-row__label">Keep activity for</span>
            <span className="set-row__hint">Older entries are deleted automatically.</span>
          </div>
          <div className="set-row__control">
            <SNumber k="mcp.auditDays" min={1} max={3650} suffix="days" />
          </div>
        </div>
      </div>
      {rows && rows.length > 0 ? (
        <ul className="mcp-audit">
          {rows.map((r) => (
            <AuditRow key={r.id} r={r} onDone={() => void refetch()} />
          ))}
        </ul>
      ) : (
        <p className="faint mcp-empty-line">Nothing yet. Every call an assistant makes is listed here.</p>
      )}
    </section>
  );
}

/**
 * One call, and - while it changed something that is still there to change
 * back - the button that puts it back. One call is one batch, so a project
 * that arrived with twenty tasks goes back as a project with twenty tasks.
 */
function AuditRow({ r, onDone }: { r: McpAuditEntry; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const revert = async () => {
    const ok = await confirm({
      title: `Put this back?`,
      message: `Everything ${r.clientName} changed in this one call is undone - anything created goes to Trash, anything it overwrote goes back as it was. Changes made since, by you or by anything else, are overwritten.`,
      confirmLabel: "Revert this batch",
    });
    if (!ok) return;
    setBusy(true);
    try {
      toast(await api.mcp.revert(r.id));
    } catch (e) {
      toastError(describeError(e, "Couldn't put that back."));
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <li data-ok={r.ok} data-reverted={!!r.revertedAt}>
      <span className="mcp-audit__when tabular">{relativeTime(r.createdAt)}</span>
      <span className="mcp-audit__who">{r.clientName}</span>
      <span className="mcp-audit__tool mono">{r.tool.replace(/^kern_/, "")}</span>
      <span className="mcp-audit__detail">{r.ok ? (r.detail ?? "") : (r.message ?? "Refused")}</span>
      <span className="mcp-audit__revert">
        {r.revertedAt ? (
          <Tooltip content={`Put back ${relativeTime(r.revertedAt)}`}>
            <span>Reverted</span>
          </Tooltip>
        ) : r.revertable ? (
          <Button size="sm" variant="ghost" icon={Undo2} disabled={busy} onClick={() => void revert()}>
            Revert
          </Button>
        ) : null}
      </span>
    </li>
  );
}
