/**
 * @Author Christian Relf
 * @Date 2026-10-23
 */

// Add or change an MCP server Kern may call. The other direction from the
// rest of this tab: here Kern is the client, and `command` is a program on
// this computer that Kern will start and speak MCP to. So the dialog says
// what that means rather than implying Kern can vouch for it.

import { CircleAlert, CircleCheck, LoaderCircle, Play } from "lucide-react";
import { useState } from "react";
import type { McpServer } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { toast, toastError } from "@/stores/toast";

/** One argument per line, which is also how a command's own help prints them. */
const toLines = (args: string[]) => args.join("\n");
const fromLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** `KEY=value` per line. Nothing secret belongs here - see the hint below. */
const toEnv = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
const fromEnv = (text: string) => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
};

export function McpServerDialog({ server, onClose }: { server?: McpServer; onClose: () => void }) {
  const [name, setName] = useState(server?.name ?? "");
  const [command, setCommand] = useState(server?.command ?? "");
  const [args, setArgs] = useState(toLines(server?.args ?? []));
  const [env, setEnv] = useState(toEnv(server?.env ?? {}));
  const [cwd, setCwd] = useState(server?.cwd ?? "");
  const [saving, setSaving] = useState(false);
  // Set once this dialog has saved a new server, so a later press changes
  // that one instead of adding a second copy of it.
  const [savedId, setSavedId] = useState(server?.id ?? null);
  const [tested, setTested] = useState<McpServer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const payload = { name: name.trim(), command: command.trim(), args: fromLines(args), env: fromEnv(env), cwd: cwd.trim() || null };
  const canSave = !!payload.name && !!payload.command && !saving;

  // Saving first and testing after is deliberate: a test has to start the
  // command that is actually saved, not a copy of what is on screen.
  const save = async (): Promise<McpServer | null> => {
    setSaving(true);
    try {
      const saved = savedId ? await api.mcp.serverUpdate(savedId, payload) : await api.mcp.serverCreate(payload);
      setSavedId(saved.id);
      invalidate("mcp");
      return saved;
    } catch (e) {
      toastError(describeError(e, "Couldn't save the server."));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    const saved = await save();
    if (!saved) return;
    setTesting(true);
    setFailed(null);
    setTested(null);
    try {
      setTested(await api.mcp.serverTest(saved.id));
    } catch (e) {
      setFailed(describeError(e, "The server didn't answer."));
    } finally {
      setTesting(false);
      invalidate("mcp");
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={server ? `Edit ${server.name}` : "Add an MCP server"}
      className="ai-dialog"
      footer={
        <>
          <Button variant="ghost" icon={testing ? LoaderCircle : Play} onClick={() => void test()} disabled={!canSave || testing} style={{ marginRight: "auto" }}>
            {testing ? "Starting…" : "Save and test"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canSave}
            onClick={async () => {
              const saved = await save();
              if (!saved) return;
              toast(server ? `Saved ${saved.name}` : `Added ${saved.name}`);
              onClose();
            }}
          >
            {server ? "Save" : "Add server"}
          </Button>
        </>
      }
    >
      <input className="input" autoFocus aria-label="Server name" placeholder="Name - Filesystem, Linear, Playwright…" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="field">
        <input className="input mono" aria-label="Command" placeholder="npx" value={command} onChange={(e) => setCommand(e.target.value)} spellCheck={false} />
        <span className="ai-dialog__hint">
          The program that starts the server. Kern runs it as you, with everything that gives it, so add servers you would run yourself in a
          terminal.
        </span>
      </div>
      <div className="field">
        <textarea
          className="input mono"
          aria-label="Arguments"
          rows={3}
          placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\you\\Notes"}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          spellCheck={false}
        />
        <span className="ai-dialog__hint">One argument per line.</span>
      </div>
      <div className="field">
        <textarea className="input mono" aria-label="Environment variables" rows={2} placeholder="API_KEY=…" value={env} onChange={(e) => setEnv(e.target.value)} spellCheck={false} />
        <span className="ai-dialog__hint">
          <code>KEY=value</code> per line, kept in Kern's database as typed. Kern's credential store is for your own secrets, not another
          program's, so put a server's key in the environment it already reads from where you can.
        </span>
      </div>
      <div className="field">
        <input className="input mono" aria-label="Working directory" placeholder="Working directory (optional)" value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
      </div>
      {(tested || failed) && (
        <div className="ai-test-result" data-ok={tested ? true : undefined} role="status">
          {tested ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
          <div className="col" style={{ minWidth: 0 }}>
            <b>{tested ? `${tested.tools.length} tool${tested.tools.length === 1 ? "" : "s"}` : "It didn't start"}</b>
            <span className="faint">{tested ? tested.tools.map((t) => t.name).join(", ") || "It started but offered nothing." : failed}</span>
          </div>
        </div>
      )}
    </Dialog>
  );
}
