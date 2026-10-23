/**
 * @Author Christian Relf
 * @Date 2026-10-23
 */

// Add or change an MCP server Kern's own AI features may call. The other
// direction from the rest of Settings → Assistants: here Kern is the client,
// and the command is a program on this computer that Kern starts and speaks
// MCP to.
//
//   Choose     a well-known server, or any command
//   Configure  its name and folders; the command, arguments, environment and
//              working folder are all there, folded away for a preset
//   Test       save it, start it, and show what it offers
//
// Saving comes before testing on purpose: a test has to start the command
// that is actually saved, not a copy of what is on screen.

import { useState } from "react";
import { ChevronRight, CircleAlert, CircleCheck, FolderOpen, FolderPlus, LoaderCircle, Plug, Plus, RotateCcw, Server, X } from "lucide-react";
import type { McpServer } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { setSetting, useSetting } from "@/stores/settings";
import { toast, toastError } from "@/stores/toast";
import { Button, IconButton } from "@/components/ui/Button";
import { Callout, Checkbox, RadioCards } from "@/components/ui/Controls";
import { Wizard } from "@/components/ui/Wizard";
import { SERVER_PRESETS, currentPlatform, draftFromPreset, draftFromServer, presetById, serverInput, serverProblem, withFolders, type PresetId, type ServerDraft } from "./mcpForm";
import "./mcp.css";

type StepId = "choose" | "configure" | "test";

const NEW_STEPS = [
  { id: "choose" as const, label: "Choose" },
  { id: "configure" as const, label: "Configure" },
  { id: "test" as const, label: "Test" },
];
const EDIT_STEPS = NEW_STEPS.slice(1);

async function pickFolder(title: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, title });
  return typeof picked === "string" ? picked : null;
}

export default function McpServerWizard({ server, onClose }: { server?: McpServer; onClose: () => void }) {
  const platform = currentPlatform();
  const allowed = useSetting("mcp.toolsEnabled");
  const [step, setStep] = useState<StepId>(server ? "configure" : "choose");
  const [draft, setDraft] = useState<ServerDraft>(() => (server ? draftFromServer(server) : draftFromPreset("filesystem", platform)));
  const [savedId, setSavedId] = useState(server?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true; server: McpServer } | { ok: false; message: string } | null>(null);
  // What Done turns on: this server, and - if it's off - servers as a whole.
  const [useIt, setUseIt] = useState(server?.enabled ?? true);
  const [allowAll, setAllowAll] = useState(true);
  const set = (p: Partial<ServerDraft>) => setDraft((d) => ({ ...d, ...p }));

  const choose = (id: PresetId) => setDraft((d) => ({ ...draftFromPreset(id, platform), env: d.env, cwd: d.cwd }));

  const save = async (): Promise<McpServer | null> => {
    try {
      const input = serverInput(draft);
      const saved = savedId ? await api.mcp.serverUpdate(savedId, input) : await api.mcp.serverCreate(input);
      setSavedId(saved.id);
      return saved;
    } catch (e) {
      toastError(describeError(e, "Couldn't save the server."));
      return null;
    } finally {
      invalidate("mcp");
    }
  };

  const test = async () => {
    setBusy(true);
    setResult(null);
    const saved = await save();
    if (!saved) return setBusy(false);
    setStep("test");
    try {
      setResult({ ok: true, server: await api.mcp.serverTest(saved.id) });
    } catch (e) {
      setResult({ ok: false, message: describeError(e, "It didn't answer.") });
    } finally {
      setBusy(false);
      invalidate("mcp");
    }
  };

  const finish = async () => {
    if (!savedId) return onClose();
    setBusy(true);
    try {
      const ok = result?.ok === true;
      await api.mcp.serverUpdate(savedId, { enabled: ok && useIt });
      if (ok && useIt && !allowed && allowAll) await setSetting("mcp.toolsEnabled", true);
      const name = draft.name.trim();
      toast(!ok ? `Saved ${name}, switched off until it starts` : server ? `Saved ${name}` : `Added ${name}`);
      onClose();
    } catch (e) {
      toastError(describeError(e));
    } finally {
      setBusy(false);
      invalidate("mcp");
    }
  };

  const problem = step === "configure" ? serverProblem(draft) : null;
  const primary =
    step === "choose"
      ? undefined
      : step === "configure"
        ? { label: "Save and test", onClick: test }
        : { label: result?.ok ? "Done" : "Close", onClick: finish };

  return (
    <Wizard
      title={server ? `Edit ${server.name}` : "Add a server"}
      icon={Server}
      steps={server ? EDIT_STEPS : NEW_STEPS}
      step={step}
      onStep={setStep}
      onClose={onClose}
      busy={busy}
      blocking={problem}
      primary={primary}
      secondary={
        step === "test" && result && !result.ok ? (
          <Button variant="ghost" icon={RotateCcw} disabled={busy} onClick={() => void test()}>
            Try again
          </Button>
        ) : step === "configure" && server ? (
          <Button
            variant="ghost"
            disabled={busy || !!problem}
            onClick={async () => {
              if (!(await save())) return;
              toast(`Saved ${draft.name.trim()}`);
              onClose();
            }}
          >
            Save without testing
          </Button>
        ) : undefined
      }
    >
      {step === "choose" && (
        <>
          <p className="wizard-lead">An MCP server is a small program that gives Kern's AI features tools - reading files, fetching pages, driving a browser. Kern starts it on this computer when a request needs it.</p>
          <RadioCards
            value={draft.preset}
            onChange={choose}
            ariaLabel="Server"
            options={SERVER_PRESETS.map((p) => ({ value: p.id, title: p.name, text: p.description, badge: p.needs ? `Needs ${p.needs}` : undefined, icon: p.id === "custom" ? Plug : undefined }))}
          />
        </>
      )}
      {step === "configure" && <Configure draft={draft} set={set} platform={platform} />}
      {step === "test" && <Test draft={draft} busy={busy} result={result} useIt={useIt} setUseIt={setUseIt} allowed={allowed} allowAll={allowAll} setAllowAll={setAllowAll} />}
    </Wizard>
  );
}

function Configure({ draft, set, platform }: { draft: ServerDraft; set: (p: Partial<ServerDraft>) => void; platform: ReturnType<typeof currentPlatform> }) {
  const preset = presetById(draft.preset);
  // A preset hides its command until asked; a custom server is nothing but.
  const [advanced, setAdvanced] = useState(draft.edited || draft.preset === "custom");
  const [more, setMore] = useState(draft.env.length > 0 || !!draft.cwd);
  const folders = preset.folders ?? null;

  const addFolder = async () => {
    const f = await pickFolder(folders?.label ?? "Choose a folder");
    if (!f || draft.folders.includes(f)) return;
    const next = folders?.max === 1 ? [f] : [...draft.folders, f];
    set(withFolders(draft, next, platform));
  };

  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor="srv-name">
          Name
        </label>
        <input id="srv-name" className="input" autoFocus placeholder="Filesystem, Linear, Playwright…" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        <span className="field__hint">Shown to the model as part of each tool's name, so keep it short.</span>
      </div>

      {folders && (
        <div className="field">
          <span className="field__label">{folders.label}</span>
          {draft.folders.length > 0 && (
            <ul className="mcp-folders">
              {draft.folders.map((f) => (
                <li key={f}>
                  <FolderOpen size={13} className="faint" />
                  <span className="mono truncate grow">{f}</span>
                  <IconButton icon={X} size="sm" label="Remove folder" onClick={() => set(withFolders(draft, draft.folders.filter((x) => x !== f), platform))} />
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button size="sm" icon={FolderPlus} onClick={() => void addFolder()}>
              {folders.max === 1 ? (draft.folders.length ? "Choose another…" : "Choose…") : "Add a folder…"}
            </Button>
          </div>
          {draft.edited ? (
            <span className="field__hint">
              The command below was edited by hand, so folders chosen here aren't added to it.{" "}
              <button type="button" className="link-btn" onClick={() => set(withFolders({ ...draft, edited: false }, draft.folders, platform))}>
                Use {preset.name}'s command again
              </button>
            </span>
          ) : (
            <span className="field__hint">{folders.hint}</span>
          )}
        </div>
      )}

      <Disclosure open={advanced} onToggle={() => setAdvanced(!advanced)} label="Command" summary={advanced ? undefined : [draft.command, ...draft.args.split("\n").filter(Boolean)].join(" ")}>
        <div className="field">
          <input
            className="input mono"
            aria-label="Command"
            placeholder={platform === "windows" ? "npx.cmd, uvx, C:\\Tools\\server.exe" : "npx, uvx, /usr/local/bin/server"}
            value={draft.command}
            onChange={(e) => set({ command: e.target.value, edited: true })}
            spellCheck={false}
          />
          <span className="field__hint">
            The program that starts the server. Kern runs it directly, not through a shell{platform === "windows" ? " - so Node's commands are written npx.cmd, not npx" : ""}.
          </span>
        </div>
        <div className="field">
          <textarea
            className="input mono"
            aria-label="Arguments"
            rows={3}
            placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\you\\Notes"}
            value={draft.args}
            onChange={(e) => set({ args: e.target.value, edited: true })}
            spellCheck={false}
          />
          <span className="field__hint">One argument per line.</span>
        </div>
      </Disclosure>

      <Disclosure open={more} onToggle={() => setMore(!more)} label="Environment and working folder" summary={more ? undefined : [draft.env.length ? `${draft.env.length} variable${draft.env.length === 1 ? "" : "s"}` : null, draft.cwd || null].filter(Boolean).join(" · ") || "None"}>
        <div className="field">
          <span className="field__label">Environment variables</span>
          {draft.env.map((r, i) => (
            <div key={i} className="mcp-env">
              <input className="input mono" aria-label="Variable name" placeholder="NAME" value={r.key} spellCheck={false} onChange={(e) => set({ env: draft.env.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
              <input className="input mono grow" aria-label="Value" placeholder="value" value={r.value} spellCheck={false} onChange={(e) => set({ env: draft.env.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
              <IconButton icon={X} size="sm" label="Remove variable" onClick={() => set({ env: draft.env.filter((_, j) => j !== i) })} />
            </div>
          ))}
          <div>
            <Button size="sm" variant="ghost" icon={Plus} onClick={() => set({ env: [...draft.env, { key: "", value: "" }] })}>
              Add a variable
            </Button>
          </div>
          <span className="field__hint">
            Kept in Kern's database as typed. Kern's credential store holds your own secrets, not other programs', so where you can, put a server's key in the environment it already reads from.
          </span>
        </div>
        <div className="field">
          <span className="field__label">Working folder</span>
          <div className="row" style={{ gap: 6 }}>
            <input className="input mono grow" aria-label="Working folder" placeholder="Kern's own, unless you choose one" value={draft.cwd} spellCheck={false} onChange={(e) => set({ cwd: e.target.value })} />
            <Button size="sm" icon={FolderOpen} onClick={() => void pickFolder("Working folder").then((f) => f && set({ cwd: f }))}>
              Browse…
            </Button>
          </div>
        </div>
      </Disclosure>

      <Callout icon={CircleAlert} tone="warn">
        Kern runs this as you, with everything that gives it. Add only servers you would run yourself in a terminal.
      </Callout>
    </>
  );
}

function Disclosure({ open, onToggle, label, summary, children }: { open: boolean; onToggle: () => void; label: string; summary?: string; children: React.ReactNode }) {
  return (
    <div className="mcp-disclosure" data-open={open || undefined}>
      <button type="button" className="mcp-disclosure__head" aria-expanded={open} onClick={onToggle}>
        <ChevronRight size={14} className="mcp-disclosure__chev" />
        <span className="field__label">{label}</span>
        {summary && <span className="mono faint truncate mcp-disclosure__summary">{summary}</span>}
      </button>
      {open && <div className="mcp-disclosure__body">{children}</div>}
    </div>
  );
}

function Test({
  draft,
  busy,
  result,
  useIt,
  setUseIt,
  allowed,
  allowAll,
  setAllowAll,
}: {
  draft: ServerDraft;
  busy: boolean;
  result: { ok: true; server: McpServer } | { ok: false; message: string } | null;
  useIt: boolean;
  setUseIt: (v: boolean) => void;
  allowed: boolean;
  allowAll: boolean;
  setAllowAll: (v: boolean) => void;
}) {
  const needs = presetById(draft.preset).needs;
  if (busy || !result)
    return (
      <div className="mcp-waiting" role="status">
        <LoaderCircle size={20} className="spin mcp-waiting__icon" />
        <b>Starting {draft.name.trim()}…</b>
        <span className="faint">The first start can take a minute while it downloads.</span>
      </div>
    );
  if (!result.ok)
    return (
      <>
        <Callout icon={CircleAlert} tone="danger" title="It didn't start">
          {result.message}
        </Callout>
        <ul className="mcp-facts">
          {needs && <li>It needs {needs} installed on this computer, on the PATH Kern was started with.</li>}
          <li>Go back and check the command and its arguments - run them in a terminal to see what they print.</li>
          <li>It's saved, switched off. You can fix it and test it again from its row later.</li>
        </ul>
      </>
    );
  const tools = result.server.tools;
  return (
    <>
      <Callout icon={CircleCheck} tone="ok" title={`${result.server.name} started and offers ${tools.length} tool${tools.length === 1 ? "" : "s"}`}>
        {tools.length ? "The model sees each one by name and description, and decides when to use it." : "It started but offered nothing, so there is nothing for the model to use yet."}
      </Callout>
      {tools.length > 0 && (
        <ul className="mcp-tools">
          {tools.map((t) => (
            <li key={t.name}>
              <span className="mono">{t.name}</span>
              {t.description && <span className="faint">{t.description}</span>}
            </li>
          ))}
        </ul>
      )}
      <label className="mcp-check">
        <Checkbox checked={useIt} onChange={setUseIt} label="Use it in Kern's AI features" />
        Use it in Kern's AI features
      </label>
      {useIt && !allowed && (
        <label className="mcp-check">
          <Checkbox checked={allowAll} onChange={setAllowAll} label="Let Kern's AI features use servers" />
          Also let Kern's AI features use servers - that's off at the moment
        </label>
      )}
    </>
  );
}
