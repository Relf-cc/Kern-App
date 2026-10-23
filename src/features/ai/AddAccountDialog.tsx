/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { CircleAlert, CircleCheck, KeyRound, LoaderCircle, TerminalSquare } from "lucide-react";
import { useState } from "react";
import type { AiProvider, AiValidation } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Segmented, Select } from "@/components/ui/Controls";
import { toast, toastError } from "@/stores/toast";
import { NEEDS_KEY, PROVIDER_HINT, PROVIDER_NAME, ProviderIcon, SUGGESTED_MODEL, VALIDATION_LABEL } from "./meta";

/**
 * Add an API credential profile, or replace a profile's key. The key can be
 * tested before saving (a no-cost "list models" call) and is then sent once
 * to the OS credential store. It's never shown again.
 *
 * One provider takes no key at all: "Claude subscription" is the `claude`
 * command on this computer, already signed in. There is nothing to type and
 * nothing to store, so the key field goes away and the test simply checks
 * that the command runs.
 */
export function AddAccountDialog({ onClose, replaceFor }: { onClose: () => void; replaceFor?: { id: string; name: string; provider: AiProvider } }) {
  const [provider, setProvider] = useState<AiProvider>(replaceFor?.provider ?? "anthropic");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [org, setOrg] = useState("");
  const [project, setProject] = useState("");
  const [model, setModel] = useState(SUGGESTED_MODEL.anthropic ?? "");
  const [more, setMore] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AiValidation | null>(null);
  const [saving, setSaving] = useState(false);

  const needsKey = NEEDS_KEY[provider];

  const changeProvider = (p: AiProvider) => {
    setProvider(p);
    setResult(null);
    setModel(SUGGESTED_MODEL[p] ?? "");
    if (!NEEDS_KEY[p]) setKey("");
    if (!name.trim() && !NEEDS_KEY[p]) setName(PROVIDER_NAME[p]);
  };

  const test = async () => {
    if (needsKey && !key.trim()) return;
    setTesting(true);
    try {
      const r = await api.ai.testKey(provider, key, org || null, project || null);
      setResult(r);
      if (r.outcome === "authenticated" && r.models.length && !r.models.includes(model)) {
        setModel(r.models.includes(SUGGESTED_MODEL[provider] ?? "") ? SUGGESTED_MODEL[provider]! : r.models[0]);
      }
    } catch (e) {
      toastError(describeError(e, "The test couldn't run."));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      if (replaceFor) {
        await api.ai.replaceKey(replaceFor.id, key);
        toast(`Key replaced for ${replaceFor.name}`);
      } else {
        const a = await api.ai.create({ provider, name: name.trim(), apiKey: key, organizationId: org || null, projectRef: project || null, preferredModel: model || null });
        // A tested key gets its real status (and model list) recorded.
        if (result) await api.ai.test(a.id).catch(() => undefined);
        toast(`Added ${a.name}`);
      }
      setKey("");
      invalidate("ai");
      onClose();
    } catch (e) {
      toastError(describeError(e, "Couldn't save the account."));
    } finally {
      setSaving(false);
    }
  };

  const ok = result?.outcome === "authenticated" || result?.outcome === "quota" || result?.outcome === "rate_limited";
  const canSave = (!needsKey || !!key.trim()) && (!!replaceFor || !!name.trim()) && !saving;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={replaceFor ? `Replace key for ${replaceFor.name}` : "Add API account"}
      className="ai-dialog"
      footer={
        <>
          <Button
            variant="ghost"
            icon={testing ? LoaderCircle : needsKey ? KeyRound : TerminalSquare}
            onClick={() => void test()}
            disabled={(needsKey && !key.trim()) || testing}
            style={{ marginRight: "auto" }}
          >
            {testing ? "Testing…" : needsKey ? "Test connection" : "Check the command"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!canSave}>
            {replaceFor ? "Replace key" : "Save account"}
          </Button>
        </>
      }
    >
      {!replaceFor && (
        <Segmented
          value={provider}
          onChange={changeProvider}
          options={(["anthropic", "openai", "claude-cli"] as AiProvider[]).map((p) => ({ value: p, label: PROVIDER_NAME[p] }))}
          ariaLabel="Provider"
        />
      )}
      {!replaceFor && (
        <div className="row" style={{ gap: 10 }}>
          <ProviderIcon provider={provider} size={32} />
          <input className="input grow" autoFocus placeholder="Account name - Personal, Work, Secondary…" aria-label="Account name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      )}
      {needsKey ? (
        <div className="field">
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus={!!replaceFor}
            aria-label="API key"
            placeholder={provider === "anthropic" ? "API key (sk-ant-…)" : "API key (sk-…)"}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setResult(null);
            }}
          />
          <span className="ai-dialog__hint">Stored in your system's credential store - never in Kern's database, backups or logs. This is an API key, not a subscription login.</span>
        </div>
      ) : (
        <div className="field">
          <span className="ai-dialog__hint">
            {PROVIDER_HINT[provider]} Kern runs it as a model and nothing more: one turn, in a scratch folder, so a request can't turn into
            the command reading or writing your files. If Kern can't find it, set <span className="mono">KERN_CLAUDE_CLI</span> to the full
            path.
          </span>
        </div>
      )}
      {result && (
        <div className="ai-test-result" data-ok={ok || undefined} role="status">
          {ok ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
          <div className="col" style={{ minWidth: 0 }}>
            <b>{VALIDATION_LABEL[result.outcome]}</b>
            <span className="faint">{result.message}</span>
          </div>
        </div>
      )}
      {!replaceFor &&
        (more ? (
          <div className="ai-dialog__more">
            <div className="ai-dialog__row">
              <span>Default model</span>
              {result?.models.length ? (
                <Select value={model} onChange={setModel} ariaLabel="Default model" options={result.models.map((m) => ({ value: m, label: m }))} style={{ minWidth: 220 }} />
              ) : (
                <input className="input mono" value={model} placeholder={provider === "openai" ? "Test the connection to list models" : ""} onChange={(e) => setModel(e.target.value)} aria-label="Default model" />
              )}
            </div>
            <div className="ai-dialog__row">
              <span>Organisation ID</span>
              <input className="input mono" placeholder={provider === "anthropic" ? "Optional - detected after a request" : "Optional"} value={org} onChange={(e) => setOrg(e.target.value)} aria-label="Organisation ID" />
            </div>
            {provider === "openai" && (
              <div className="ai-dialog__row">
                <span>Project ID</span>
                <input className="input mono" placeholder="Optional" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project ID" />
              </div>
            )}
            <span className="ai-dialog__hint">Keys from the same organisation share rate limits and billing, so Kern won't switch between them when one hits a limit.</span>
          </div>
        ) : (
          <button type="button" className="link-btn" style={{ alignSelf: "flex-start", color: "var(--text-2)", fontSize: "var(--fs-sm)" }} onClick={() => setMore(true)}>
            Model and organisation…
          </button>
        ))}
    </Dialog>
  );
}
