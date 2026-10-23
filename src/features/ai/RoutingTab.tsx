/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { ArrowRight, CircleAlert, CircleCheck, Plus, Send, Square, X } from "lucide-react";
import { useState } from "react";
import type { AiRouteOutcome } from "@/lib/types";
import type { AiRoutingMode, ModelPrice } from "@/features/settings/schema";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { useSetting, setSetting } from "@/stores/settings";
import { useProjects } from "@/hooks/data";
import { Button, IconButton } from "@/components/ui/Button";
import { Checkbox, RadioCards, Select } from "@/components/ui/Controls";
import { SNumber, SToggle } from "@/features/settings/controls";
import { toastError } from "@/stores/toast";
import { useAiAccounts } from "./AccountsTab";
import { CATEGORY_LABEL, PROVIDER_NAME, formatUsd } from "./meta";

const MODES: { id: AiRoutingMode; title: string; text: string; recommended?: boolean }[] = [
  { id: "failover", title: "Automatic failover", text: "Use the primary account until it's unavailable, then a fallback or another eligible account.", recommended: true },
  { id: "manual", title: "Manual", text: "Always use the account you choose. Never switches on its own." },
  { id: "priority", title: "Priority routing", text: "Use the highest-priority account that's available right now." },
  { id: "cost", title: "Cost-conscious", text: "Prefer the eligible account whose model has the lowest price you've entered below." },
];

function ModelPrices() {
  const prices = useSetting("ai.modelPrices");
  const [model, setModel] = useState("");
  const set = (next: Record<string, ModelPrice>) => void setSetting("ai.modelPrices", next);
  const entries = Object.entries(prices);
  return (
    <div className="col" style={{ gap: 4, width: "100%" }}>
      {entries.map(([m, p]) => (
        <div key={m} className="row ai-price" style={{ gap: 6 }}>
          <span className="mono grow truncate" style={{ fontSize: "var(--fs-sm)" }}>
            {m}
          </span>
          {(["input", "output", "cached"] as const).map((k) => (
            <label key={k} className="ai-price__field">
              <span>{k}</span>
              <input
                className="input"
                inputMode="decimal"
                defaultValue={p[k] ?? ""}
                placeholder={k === "cached" ? "= input" : "0"}
                onBlur={(e) => {
                  const v = e.target.value.trim() === "" ? undefined : Number(e.target.value);
                  if (v !== undefined && (Number.isNaN(v) || v < 0)) return;
                  set({ ...prices, [m]: { ...p, [k]: v ?? (k === "cached" ? undefined : 0) } });
                }}
                aria-label={`${m} ${k} price per million tokens`}
              />
            </label>
          ))}
          <IconButton
            icon={X}
            label="Remove price"
            size="sm"
            onClick={() => {
              const next = { ...prices };
              delete next[m];
              set(next);
            }}
          />
        </div>
      ))}
      <div className="row" style={{ gap: 6 }}>
        <input className="input mono" style={{ maxWidth: 260 }} placeholder="Model ID, e.g. claude-opus-5-5" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model ID" />
        <Button
          size="sm"
          icon={Plus}
          disabled={!model.trim() || model.trim() in prices}
          onClick={() => {
            set({ ...prices, [model.trim()]: { input: 0, output: 0 } });
            setModel("");
          }}
        >
          Add price
        </Button>
      </div>
      <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
        USD per million tokens, from your provider's current price list. Kern never assumes prices: without one, cost isn't estimated.
      </span>
    </div>
  );
}

function TestRequest() {
  const { data: accounts } = useAiAccounts();
  const { data: projects } = useProjects();
  const [prompt, setPrompt] = useState("Reply with the word “ready”.");
  const [accountId, setAccountId] = useState("auto");
  const [projectId, setProjectId] = useState("none");
  const [running, setRunning] = useState<string | null>(null);
  const [useTools, setUseTools] = useState(false);
  const [out, setOut] = useState<AiRouteOutcome | null>(null);

  const send = async () => {
    const requestId = crypto.randomUUID();
    setRunning(requestId);
    setOut(null);
    try {
      const r = await api.ai.request({
        requestId,
        prompt,
        maxTokens: 256,
        accountId: accountId === "auto" ? null : accountId,
        projectId: projectId === "none" ? null : projectId,
        purpose: "test",
        useTools,
      });
      setOut(r);
    } catch (e) {
      toastError(describeError(e, "The request couldn't be sent."));
    } finally {
      setRunning(null);
      invalidate("ai");
    }
  };

  return (
    <div className="ai-test">
      <textarea className="textarea" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Test prompt" />
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Select
          value={accountId}
          onChange={setAccountId}
          ariaLabel="Account"
          options={[{ value: "auto", label: "Route automatically" }, ...(accounts ?? []).map((a) => ({ value: a.id, label: `Start with ${a.name}` }))]}
        />
        <Select value={projectId} onChange={setProjectId} ariaLabel="Project" options={[{ value: "none", label: "No project" }, ...(projects ?? []).map((p) => ({ value: p.id, label: `As project: ${p.name}` }))]} />
        <Checkbox checked={useTools} onChange={setUseTools} label="Offer my MCP servers" />
        <span className="spacer" />
        {running ? (
          <Button icon={Square} onClick={() => void api.ai.cancel(running)}>
            Cancel
          </Button>
        ) : (
          <Button variant="primary" icon={Send} disabled={!prompt.trim() || !accounts?.length} onClick={() => void send()}>
            Send test request
          </Button>
        )}
      </div>
      <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
        A real, billed request (up to 256 output tokens) - sent only when you press the button. Only request metadata is kept; the prompt and reply aren't stored.
        {useTools ? " With servers offered, each round of tool calls is a request of its own." : ""}
      </span>
      {out && (
        <div className="ai-outcome" data-ok={out.ok || undefined}>
          <div className="row" style={{ gap: 8 }}>
            {out.ok ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
            <b>{out.ok ? `Answered by ${out.accountName}` : out.error ? CATEGORY_LABEL[out.error.category] : "Failed"}</b>
            {out.ok && (
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                {out.provider && PROVIDER_NAME[out.provider]} · {out.model} · {out.usage?.inputTokens ?? 0} in / {out.usage?.outputTokens ?? 0} out
                {out.estimatedCost !== null && ` · ${formatUsd(out.estimatedCost)}`}
              </span>
            )}
          </div>
          {out.text && <p className="ai-outcome__text selectable">{out.text}</p>}
          {out.error && <p className="faint selectable" style={{ fontSize: "var(--fs-sm)" }}>{out.error.message}</p>}
          {out.switches.map((s, i) => (
            <span key={i} className="ai-outcome__line">
              {s.from} <ArrowRight size={12} /> {s.to} <span className="faint">({s.reason})</span>
            </span>
          ))}
          {out.attempts.length > 1 && (
            <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
              Attempts: {out.attempts.map((a) => `${a.accountName} ${a.ok ? "✓" : `✕ ${a.category ? CATEGORY_LABEL[a.category] : ""}`}`).join(" · ")}
            </span>
          )}
          {out.warnings.map((w, i) => (
            <span key={i} className="faint" style={{ fontSize: "var(--fs-xs)" }}>
              {w}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function RoutingTab() {
  const mode = useSetting("ai.routingMode");
  return (
    <div className="col" style={{ gap: 20 }}>
      <section>
        <div className="set-group__title">Switching policy</div>
        <RadioCards
          value={mode}
          onChange={(m) => void setSetting("ai.routingMode", m)}
          options={MODES.map((m) => ({ value: m.id, title: m.title, text: m.text, badge: m.recommended ? "Recommended" : undefined }))}
          ariaLabel="Switching policy"
          columns={2}
        />
      </section>
      <section>
        <div className="set-group__title">Safeguards</div>
        <div className="set-group">
          <Row label="Allow switching between providers" hint="Off: Kern only switches between accounts of the same provider. On: an Anthropic request may continue on OpenAI (with that account's model).">
            <SToggle k="ai.crossProvider" />
          </Row>
          <Row label="Most attempts per request" hint="Including retries. Kern never loops through accounts.">
            <SNumber k="ai.maxAttempts" min={1} max={6} />
          </Row>
          <Row label="Wait for short rate limits" hint="If the provider asks to retry within this time, Kern waits and retries the same account instead of switching.">
            <SNumber k="ai.maxRetryWaitSeconds" min={0} max={120} suffix="seconds" />
          </Row>
          <Row label="Tell me when Kern switches accounts" hint="A brief notice, for example “Switched to Secondary - primary account unavailable.”">
            <SToggle k="ai.notifySwitch" />
          </Row>
        </div>
        <p className="ai-note">
          Requests are only retried on another account when the failure produced no output. A request that timed out after sending might already have been processed, so it's reported instead of resent. Keys from the same organisation share limits - adding a key there doesn't add allowance, and Kern won't rotate between them.
        </p>
      </section>
      <section>
        <div className="set-group__title">Model prices</div>
        <div className="set-group">
          <div className="set-row" style={{ flexWrap: "wrap" }}>
            <ModelPrices />
          </div>
        </div>
      </section>
      <section>
        <div className="set-group__title">Test routing</div>
        <TestRequest />
      </section>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row__text">
        <span className="set-row__label">{label}</span>
        {hint && <span className="set-row__hint">{hint}</span>}
      </div>
      <div className="set-row__control">{children}</div>
    </div>
  );
}
