/**
 * @Author Christian Relf
 * @Date 2026-10-23
 */

// "Connect an assistant": the whole of setting up MCP as one guided flow.
//
//   Choose   which app - Claude Desktop, Claude Code, or something else
//   Set up   what to do in that app, with Kern doing it where it can
//   Approve  wait for it to knock, then say what it may do, right here
//
// The last step is the point of the flow. Without it, setting up ends with
// "now go and find the request in Settings", which is where people got lost:
// the assistant connects, is told it isn't approved, and nobody is looking.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bot, CircleAlert, CircleCheck, FolderCheck, Globe, LoaderCircle, Package, Plug, ShieldCheck, Terminal } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { McpClient, McpScope, McpSetup } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { useSetting } from "@/stores/settings";
import { toast, toastError } from "@/stores/toast";
import { Button } from "@/components/ui/Button";
import { Callout, CopyBlock, RadioCards, Segmented, Skeleton } from "@/components/ui/Controls";
import { Wizard } from "@/components/ui/Wizard";
import ProjectScopeDialog from "./ProjectScopeDialog";
import { SCOPE_OPTIONS } from "./AssistantDialog";
import { patchClient, setConnection, setHttp } from "./mcpActions";
import { arrivals, projectsLabel } from "./mcpForm";
import "./mcp.css";

type App = "desktop" | "code" | "other";
type StepId = "choose" | "setup" | "approve";

const APP_NAME: Record<App, string> = { desktop: "Claude Desktop", code: "Claude Code", other: "your app" };

const STEPS = [
  { id: "choose" as const, label: "Choose" },
  { id: "setup" as const, label: "Set up" },
  { id: "approve" as const, label: "Approve" },
];

/** Said before anything is switched on, in three lines rather than nine. */
const PROMISES = [
  "Read-only until you allow changes, and held to the projects you choose.",
  "Deletes go to Trash, and any change it makes can be put back.",
  "Projects locked with a passkey stay invisible.",
];

export default function ConnectAssistantWizard({ onClose }: { onClose: () => void }) {
  const enabled = useSetting("mcp.enabled");
  const [step, setStep] = useState<StepId>("choose");
  const [app, setApp] = useState<App>("desktop");
  const [busy, setBusy] = useState(false);
  // Anything that connects after this counts as the one being set up.
  const [since] = useState(() => Date.now());
  // An approval is on screen, with its own buttons; the footer steps aside.
  const [asking, setAsking] = useState(false);

  const next = async () => {
    if (step === "choose") {
      if (!enabled) {
        setBusy(true);
        const ok = await setConnection(true);
        setBusy(false);
        if (!ok) return;
      }
      setStep("setup");
    } else if (step === "setup") setStep("approve");
    else onClose();
  };

  return (
    <Wizard
      title="Connect an assistant"
      icon={Bot}
      steps={STEPS}
      step={step}
      onStep={setStep}
      onClose={onClose}
      busy={busy}
      secondary={step === "choose" && !enabled ? <span className="wizard-dialog__blocking">Kern starts listening on this computer.</span> : undefined}
      primary={
        step === "approve" && asking
          ? { label: "Decide later", quiet: true, onClick: onClose }
          : { label: step === "choose" ? (enabled ? "Continue" : "Turn on and continue") : step === "setup" ? "I've done this" : "Done", onClick: next }
      }
    >
      {step === "choose" && <Choose app={app} onApp={setApp} />}
      {step === "setup" && <SetUp app={app} />}
      {step === "approve" && <Approve app={app} since={since} onAsking={setAsking} />}
    </Wizard>
  );
}

function Choose({ app, onApp }: { app: App; onApp: (a: App) => void }) {
  return (
    <>
      <p className="wizard-lead">Use Kern from an AI app you already have. It works on that app's own subscription - no API key, nothing billed per token.</p>
      <RadioCards
        value={app}
        onChange={onApp}
        ariaLabel="Which app"
        columns={1}
        options={[
          { value: "desktop", title: "Claude Desktop", icon: Bot, badge: "Easiest", text: "Kern adds itself to Claude Desktop for you. Restart it and you're done." },
          { value: "code", title: "Claude Code", icon: Terminal, text: "One command to paste into a terminal." },
          { value: "other", title: "Another app", icon: Plug, text: "Any app that speaks MCP - by a command it runs, or a local web address." },
        ]}
      />
      <ul className="mcp-promises" aria-label="What an assistant can and can't do">
        {PROMISES.map((p) => (
          <li key={p}>
            <ShieldCheck size={13} />
            {p}
          </li>
        ))}
      </ul>
    </>
  );
}

function SetUp({ app }: { app: App }) {
  const { data: setup, error } = useQuery({ queryKey: ["mcp", "setup"], queryFn: api.mcp.setup });
  if (error) return <Callout icon={CircleAlert} tone="danger" title="Kern couldn't read its own setup">{describeError(error)}</Callout>;
  if (!setup) return <Skeleton height={140} />;
  const missing = !setup.bridgeExists && (
    <Callout icon={CircleAlert} tone="warn" title="The kern-mcp helper is missing">
      An assistant starts it to reach Kern, and it isn't beside Kern on this computer (expected at <span className="mono">{setup.bridgePath}</span>). Reinstalling Kern puts it back.
    </Callout>
  );
  if (app === "desktop") return <ForDesktop setup={setup} missing={missing} />;
  if (app === "code")
    return (
      <>
        <p className="wizard-lead">Paste this into a terminal once. Claude Code remembers it for every folder you work in.</p>
        {missing}
        <CopyBlock text={setup.claudeCode} label="Command" onCopy={() => toast("Command copied")} />
        <span className="field__hint">Then start Claude Code, or type /mcp in one that's already running.</span>
      </>
    );
  return <ForOther setup={setup} missing={missing} />;
}

function ForDesktop({ setup, missing }: { setup: McpSetup; missing: ReactNode }) {
  const [way, setWay] = useState<"auto" | "bundle" | "manual">("auto");
  const [wrote, setWrote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      setWrote(await api.mcp.setupClaudeDesktop());
    } catch (e) {
      toastError(describeError(e, "Couldn't change Claude Desktop's settings."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Segmented
        value={way}
        onChange={setWay}
        ariaLabel="How to add Kern"
        options={[
          { value: "auto", label: "Automatically" },
          ...(setup.bundlePath ? [{ value: "bundle" as const, label: "As an extension" }] : []),
          { value: "manual", label: "By hand" },
        ]}
      />
      {missing}
      {way === "auto" &&
        (wrote ? (
          <Callout icon={CircleCheck} tone="ok" title="Kern is in Claude Desktop's settings">
            Quit Claude Desktop completely - from the tray or menu bar too, not just its window - and open it again. Saved to <span className="mono">{wrote}</span>.
          </Callout>
        ) : (
          <>
            <p className="wizard-lead">Kern adds one entry to Claude Desktop's settings file and leaves everything else in it as it was.</p>
            <div>
              <Button icon={busy ? LoaderCircle : Bot} className={busy ? "spin" : undefined} disabled={busy || !setup.bridgeExists} onClick={() => void add()}>
                Add Kern to Claude Desktop
              </Button>
            </div>
          </>
        ))}
      {way === "bundle" && (
        <>
          <p className="wizard-lead">
            Drag <span className="mono">kern.mcpb</span> onto Claude Desktop's <b>Settings → Extensions</b> page. Same connection, and Claude Desktop manages it from then on.
          </p>
          <div>
            <Button icon={Package} onClick={() => void api.mcp.revealBundle().catch((e) => toastError(describeError(e, "Couldn't show the bundle.")))}>
              Show kern.mcpb
            </Button>
          </div>
        </>
      )}
      {way === "manual" && (
        <>
          <p className="wizard-lead">
            Add this to <span className="mono">claude_desktop_config.json</span>
            {setup.claudeDesktopPath ? <> at <span className="mono">{setup.claudeDesktopPath}</span></> : null}, inside any <span className="mono">mcpServers</span> already there, then restart Claude Desktop.
          </p>
          <CopyBlock text={setup.claudeDesktop} label="Settings" onCopy={() => toast("Settings copied")} />
        </>
      )}
    </>
  );
}

function ForOther({ setup, missing }: { setup: McpSetup; missing: ReactNode }) {
  const [way, setWay] = useState<"command" | "url">("command");
  const httpOn = useSetting("mcp.httpEnabled");
  const [busy, setBusy] = useState(false);
  const { data: creds } = useQuery({ queryKey: ["mcp", "http-credentials"], queryFn: api.mcp.httpCredentials, enabled: way === "url" && httpOn, staleTime: Infinity, gcTime: 0 });
  return (
    <>
      <Segmented
        value={way}
        onChange={setWay}
        ariaLabel="How the app connects"
        options={[
          { value: "command", label: "It runs a command" },
          { value: "url", label: "It takes a URL" },
        ]}
      />
      {way === "command" ? (
        <>
          <p className="wizard-lead">Most apps start a server themselves. Point yours at Kern's helper - no arguments needed:</p>
          {missing}
          <CopyBlock text={setup.bridgePath} label="Command" onCopy={() => toast("Path copied")} />
          <span className="field__hint">An app configured by file usually takes the same settings as Claude Desktop:</span>
          <CopyBlock text={setup.claudeDesktop} label="Settings" onCopy={() => toast("Settings copied")} />
        </>
      ) : !httpOn ? (
        <>
          <p className="wizard-lead">
            Kern can also listen on a local web address. It's off until you turn it on: only this computer can reach it, every request needs a token, and web pages in a browser are refused.
          </p>
          <div>
            <Button
              icon={busy ? LoaderCircle : Globe}
              className={busy ? "spin" : undefined}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await setHttp(true);
                setBusy(false);
              }}
            >
              Turn on the local address
            </Button>
          </div>
        </>
      ) : !creds ? (
        <Skeleton height={100} />
      ) : (
        <>
          <p className="wizard-lead">Give your app this address and token. The settings below include both, so paste them only where you would paste a password.</p>
          <CopyBlock text={creds.url} label="Address" onCopy={() => toast("Address copied")} />
          <CopyBlock text={creds.config} label="Settings" onCopy={() => toast("Settings copied")} />
          <span className="field__hint">Port, token and the Claude Code command are under Local address in Settings → Assistants.</span>
        </>
      )}
    </>
  );
}

function Approve({ app, since, onAsking }: { app: App; since: number; onAsking: (asking: boolean) => void }) {
  // Quick while someone is sitting here waiting; the event from the backend
  // usually beats it anyway.
  const { data: status } = useQuery({ queryKey: ["mcp", "status"], queryFn: api.mcp.status, refetchInterval: 2000 });
  // Approved in this step: shown as connected even if it last knocked before
  // the flow opened, which `arrivals` alone would forget once it's approved.
  const [approved, setApproved] = useState<string | null>(null);
  const here = useMemo(() => arrivals(status?.clients ?? [], since), [status, since]);
  const pending = here.find((c) => c.status === "pending");
  const connected = status?.clients.find((c) => c.id === approved && c.status === "approved") ?? here.find((c) => c.status === "approved");
  useEffect(() => onAsking(!!pending), [pending, onAsking]);

  if (pending) return <ApproveCard key={pending.id} c={pending} onApproved={() => setApproved(pending.id)} />;
  if (connected)
    return (
      <div className="mcp-arrived">
        <Callout icon={CircleCheck} tone="ok" title={`${connected.name} is connected`}>
          It can {connected.scope === "write" ? "read and change" : "read"} {projectsLabel(connected.projects).toLowerCase()}. Try asking it:
        </Callout>
        <ul className="mcp-try">
          <li>“What's due today in Kern?”</li>
          {connected.scope === "write" ? <li>“Set up a project for the website relaunch, with a task for each page.”</li> : <li>“Summarise what I finished this week.”</li>}
        </ul>
        <span className="field__hint">Change what it may do, or see what it has done, from its row in Settings → Assistants.</span>
      </div>
    );
  return (
    <div className="mcp-waiting" role="status">
      <LoaderCircle size={20} className="spin mcp-waiting__icon" />
      <b>Waiting for {APP_NAME[app]} to connect…</b>
      <span className="faint">
        {app === "desktop" ? "Open Claude Desktop and start a new chat." : app === "code" ? "Start Claude Code in any folder." : "Start your app and ask it to use Kern."} It appears here the moment it does.
      </span>
      <span className="faint mcp-waiting__later">You can close this - Kern asks you when it connects, wherever you are.</span>
    </div>
  );
}

function ApproveCard({ c, onApproved }: { c: McpClient; onApproved: () => void }) {
  const [scope, setScope] = useState<McpScope>("read");
  const [projects, setProjects] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const decide = async (status: McpClient["status"]) => {
    setBusy(true);
    const ok = await patchClient(c, status === "approved" ? { status, scope, projects } : { status });
    setBusy(false);
    if (ok && status === "approved") onApproved();
  };
  return (
    <>
      <Callout icon={Bot} title={`${c.name} wants to connect`}>
        Choose what it may do. You can change this at any time from Settings → Assistants.
      </Callout>
      <RadioCards value={scope} onChange={setScope} options={SCOPE_OPTIONS} ariaLabel={`What ${c.name} may do`} columns={2} />
      <div className="mcp-line">
        <span className="grow">{projectsLabel(projects)}</span>
        <Button size="sm" icon={FolderCheck} onClick={() => setPicking(true)}>
          Choose projects…
        </Button>
      </div>
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <Button variant="ghost" disabled={busy} onClick={() => void decide("revoked")}>
          Block
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => void decide("approved")}>
          Approve {c.name}
        </Button>
      </div>
      {picking && (
        <ProjectScopeDialog
          title={`Projects ${c.name} may see`}
          lead="Anything outside these is invisible to it, and it can't create a new project."
          value={projects}
          onSave={(ids) => setProjects(ids)}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
