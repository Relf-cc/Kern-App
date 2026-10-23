/**
 * @Author Christian Relf
 * @Date 2026-10-23
 */

// The loopback HTTP address, for assistants that take a URL rather than a
// command to run. Turning it on is a short guided flow - what it is, which
// port, then what to paste where - because a port is a bigger thing to open
// than the pipe: the pipe belongs to this user account, while anything on the
// computer can reach a port. Once it is on, the same dialog manages it.
//
// The token is the one secret Kern ever shows. There is nowhere else for it
// to go but the other program's configuration.

import { useState } from "react";
import { CircleAlert, Eye, EyeOff, Globe, Power, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { McpHttpCredentials, McpHttpStatus } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { useSetting } from "@/stores/settings";
import { toast, toastError } from "@/stores/toast";
import { Dialog, confirm } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout, CopyBlock, Skeleton } from "@/components/ui/Controls";
import { Wizard } from "@/components/ui/Wizard";
import { setHttp } from "./mcpActions";
import "./mcp.css";

const FACTS = [
  "Only this computer can reach it - never your network.",
  "Every request has to carry a token. A page open in a browser is refused outright, token or not.",
  "Assistants that connect this way are approved one by one, exactly as over the pipe.",
];

const validPort = (n: number) => Number.isInteger(n) && n >= 1024 && n <= 65535;

export default function HttpEndpointDialog({ onClose }: { onClose: () => void }) {
  const on = useSetting("mcp.httpEnabled");
  // Decided once: turning it on inside the flow must not swap the flow for
  // the manager halfway through.
  const [setup] = useState(!on);
  return setup ? <Setup onClose={onClose} /> : <Manage onClose={onClose} />;
}

function useHttpStatus() {
  return useQuery({ queryKey: ["mcp", "status"], queryFn: api.mcp.status, refetchInterval: 15_000, select: (s) => s.http });
}

function Setup({ onClose }: { onClose: () => void }) {
  const saved = useSetting("mcp.httpPort");
  const [step, setStep] = useState<"about" | "connect">("about");
  const [port, setPort] = useState(String(saved));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const n = Number(port);

  const turnOn = async () => {
    setBusy(true);
    setProblem(null);
    const ok = await setHttp(true, n);
    // The listener starts on its own thread; the status says whether it got the port.
    const after = ok ? await api.mcp.status().catch(() => null) : null;
    setBusy(false);
    if (after?.http.problem) return setProblem(after.http.problem);
    if (ok) setStep("connect");
  };

  return (
    <Wizard
      title="Local address"
      icon={Globe}
      steps={[
        { id: "about", label: "Turn on" },
        { id: "connect", label: "Connect" },
      ]}
      step={step}
      onStep={setStep}
      onClose={onClose}
      busy={busy}
      canBack={false}
      blocking={step === "about" && !validPort(n) ? "Use a port from 1024 to 65535." : null}
      primary={step === "about" ? { label: "Turn on", icon: Power, onClick: turnOn } : { label: "Done", onClick: onClose }}
    >
      {step === "about" ? (
        <>
          <p className="wizard-lead">For assistants that take a URL rather than a command to run. Claude Desktop and Claude Code don't need it - they use the pipe.</p>
          <ul className="mcp-facts">
            {FACTS.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <div className="field">
            <label className="field__label" htmlFor="mcp-port">
              Port
            </label>
            <input id="mcp-port" className="input tabular" style={{ width: 110 }} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
            <span className="field__hint">Change it only if something else on this computer already uses {saved}.</span>
          </div>
          {problem && (
            <Callout icon={CircleAlert} tone="danger" title="It couldn't start">
              {problem}
            </Callout>
          )}
        </>
      ) : (
        <>
          <p className="wizard-lead">It's listening. Give the other app this address and token - the ready-made settings below include both.</p>
          <Details />
        </>
      )}
    </Wizard>
  );
}

function Manage({ onClose }: { onClose: () => void }) {
  const { data: http } = useHttpStatus();
  const saved = useSetting("mcp.httpPort");
  const [port, setPort] = useState(String(saved));
  const [busy, setBusy] = useState(false);
  const n = Number(port);

  const off = async () => {
    setBusy(true);
    const ok = await setHttp(false);
    setBusy(false);
    if (ok) {
      toast("Local address turned off");
      onClose();
    }
  };
  const move = async () => {
    setBusy(true);
    await setHttp(true, n);
    setBusy(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        <span className="row" style={{ gap: 8 }}>
          <Globe size={16} strokeWidth={1.75} /> Local address
        </span>
      }
      footer={
        <>
          <Button variant="ghost" icon={Power} disabled={busy} onClick={() => void off()} style={{ marginRight: "auto" }}>
            Turn off
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <HttpState http={http} />
      <div className="field">
        <label className="field__label" htmlFor="mcp-port">
          Port
        </label>
        <div className="row" style={{ gap: 6 }}>
          <input id="mcp-port" className="input tabular" style={{ width: 110 }} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
          {n !== saved && (
            <Button size="sm" disabled={busy || !validPort(n)} onClick={() => void move()}>
              Move to {port}
            </Button>
          )}
        </div>
        <span className="field__hint">Moving it disconnects everything using the old address until it's given the new one.</span>
      </div>
      <Details />
    </Dialog>
  );
}

function HttpState({ http }: { http?: McpHttpStatus }) {
  if (!http) return <Skeleton height={20} />;
  return (
    <div className="mcp-line">
      <span className="mcp-status" data-status={http.running ? "on" : "off"}>
        <span className="mcp-status__dot" />
        {http.running ? "Listening" : "Not listening"}
      </span>
      <span className="mono faint truncate grow">{http.url}</span>
      {http.problem && <span className="mcp-problem">{http.problem}</span>}
    </div>
  );
}

/** The address, the token and the two ready-made configurations. */
function Details() {
  const [creds, setCreds] = useState<McpHttpCredentials | null>(null);
  const [shown, setShown] = useState(false);
  const { data: loaded } = useQuery({ queryKey: ["mcp", "http-credentials"], queryFn: api.mcp.httpCredentials, staleTime: Infinity, gcTime: 0 });
  const c = creds ?? loaded;

  const rotate = async () => {
    const ok = await confirm({
      title: "Issue a new token?",
      message: "Everything connected over HTTP stops working until you give it the new token. The pipe is unaffected.",
      confirmLabel: "New token",
      danger: true,
    });
    if (!ok) return;
    try {
      setCreds(await api.mcp.httpRotate());
      setShown(true);
      toast("New token issued");
    } catch (e) {
      toastError(describeError(e, "Couldn't issue a new token."));
    } finally {
      invalidate("mcp");
    }
  };

  if (!c) return <Skeleton height={120} />;
  return (
    <>
      <div className="field">
        <span className="field__label">Token</span>
        <div className="mcp-line">
          <span className="mono grow truncate mcp-secret">{shown ? c.token : "•".repeat(32)}</span>
          <IconButton icon={shown ? EyeOff : Eye} label={shown ? "Hide token" : "Show token"} size="sm" onClick={() => setShown(!shown)} />
          <Button size="sm" onClick={() => void navigator.clipboard.writeText(c.token).then(() => toast("Token copied"))}>
            Copy
          </Button>
          <IconButton icon={RefreshCw} label="Issue a new token" size="sm" onClick={() => void rotate()} />
        </div>
        <span className="field__hint">Kept in this computer's credential store, never in Kern's database or a backup. Treat it as a password.</span>
      </div>
      <div className="field">
        <span className="field__label">For Claude Code</span>
        <CopyBlock text={c.claudeCode} label="Command" onCopy={() => toast("Command copied")} />
      </div>
      <div className="field">
        <span className="field__label">For an app configured by file</span>
        <CopyBlock text={c.config} label="Settings" onCopy={() => toast("Settings copied")} />
        <span className="field__hint">Both include the token, so paste them only where you would paste a password.</span>
      </div>
    </>
  );
}
