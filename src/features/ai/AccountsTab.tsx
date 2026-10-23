/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { ChevronDown, Ellipsis, KeyRound, Plus, Power, RefreshCw, Star, Trash, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DndContext, DragOverlay, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { AiAccount } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown, type MenuItems } from "@/components/ui/Menu";
import { EmptyState, Segmented, Select, Skeleton, Switch } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { confirm } from "@/components/ui/Dialog";
import { toast, toastError } from "@/stores/toast";
import { announce } from "@/lib/announce";
import { relativeTime } from "@/lib/dates";
import { AUTO_SCROLL, DROP_ANIMATION, DragPreview, SortableRow, announcements, restrictToVertical, useListSensors } from "@/components/layout/sortable";
import { AddAccountDialog } from "./AddAccountDialog";
import { effectiveStatus, formatTokens, formatUsd, NEEDS_KEY, PROVIDER_NAME, ProviderIcon, STATUS_HINT, STATUS_LABEL, VALIDATION_LABEL } from "./meta";

export function useAiAccounts() {
  return useQuery({ queryKey: ["ai", "accounts"], queryFn: api.ai.list, staleTime: 30_000 });
}

async function patch(a: AiAccount, p: Parameters<typeof api.ai.update>[1]) {
  try {
    await api.ai.update(a.id, p);
  } catch (e) {
    toastError(describeError(e));
  } finally {
    invalidate("ai");
  }
}

async function testAccount(a: AiAccount) {
  try {
    const r = await api.ai.test(a.id);
    (r.outcome === "authenticated" ? toast : toastError)(`${a.name}: ${VALIDATION_LABEL[r.outcome]}${r.outcome === "authenticated" ? "" : ` - ${r.message}`}`);
  } catch (e) {
    toastError(describeError(e, "The test couldn't run."));
  } finally {
    invalidate("ai");
  }
}

async function removeAccount(a: AiAccount) {
  const ok = await confirm({
    title: `Remove ${a.name}?`,
    message: "Its key is deleted from the system credential store and it can no longer be used. Past usage stays in your history without a name.",
    confirmLabel: "Remove account",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.ai.remove(a.id);
    toast(`Removed ${a.name}`);
  } catch (e) {
    toastError(describeError(e, "Couldn't remove the account."));
  } finally {
    invalidate("ai");
  }
}

function StatusLabel({ a, activeId }: { a: AiAccount; activeId: string | null }) {
  const s = effectiveStatus(a, activeId);
  const until = a.cooldownUntil ? ` Paused until ${new Date(a.cooldownUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : "";
  return (
    <Tooltip content={`${STATUS_HINT[s]}${until}${a.statusDetail ? ` ${a.statusDetail}` : ""}`}>
      <span className="ai-status" data-status={s}>
        <span className="ai-status__dot" />
        {STATUS_LABEL[s]}
      </span>
    </Tooltip>
  );
}

function accountMenu(a: AiAccount, onReplace: () => void): MenuItems {
  return [
    { label: "Test connection", icon: RefreshCw, onSelect: () => void testAccount(a) },
    a.role !== "primary" && { label: "Make primary", icon: Star, disabled: !a.enabled, onSelect: () => void patch(a, { role: "primary" }) },
    a.role === "none" && { label: "Use as fallback", icon: Undo2, onSelect: () => void patch(a, { role: "fallback" }) },
    a.role === "fallback" && { label: "Stop using as fallback", icon: Undo2, onSelect: () => void patch(a, { role: "none" }) },
    // An account on the local command has no key to replace.
    NEEDS_KEY[a.provider] && { label: "Replace key…", icon: KeyRound, onSelect: onReplace },
    { label: a.enabled ? "Disable" : "Enable", icon: Power, onSelect: () => void patch(a, { enabled: !a.enabled }) },
    { type: "separator" },
    { label: "Remove…", icon: Trash, danger: true, onSelect: () => void removeAccount(a) },
  ];
}

function Details({ a }: { a: AiAccount }) {
  const [budget, setBudget] = useState(a.budgetLimit !== null ? String(a.budgetLimit) : "");
  const limits = Object.entries(a.rateLimits?.headers ?? {});
  return (
    <div className="ai-details">
      <div className="ai-details__grid">
        <span className="props__label">Default model</span>
        <div>
          {a.models.length ? (
            <Select
              value={a.preferredModel ?? ""}
              onChange={(v) => void patch(a, { preferredModel: v || null })}
              options={[...(a.preferredModel && !a.models.includes(a.preferredModel) ? [a.preferredModel] : []), ...a.models].map((m) => ({ value: m, label: m }))}
              ariaLabel="Default model"
              style={{ minWidth: 220 }}
            />
          ) : (
            <input
              className="input mono"
              defaultValue={a.preferredModel ?? ""}
              placeholder="Test the connection to list models"
              onBlur={(e) => e.target.value !== (a.preferredModel ?? "") && void patch(a, { preferredModel: e.target.value || null })}
              aria-label="Default model"
            />
          )}
        </div>
        <span className="props__label">Role</span>
        <Segmented
          size="sm"
          value={a.role}
          onChange={(role) => void patch(a, { role })}
          options={[
            { value: "primary", label: "Primary" },
            { value: "fallback", label: "Fallback" },
            { value: "none", label: "Standby" },
          ]}
          ariaLabel="Role"
        />
        <span className="props__label">Automatic failover</span>
        <label className="row" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
          <Switch checked={a.failoverEligible} onChange={(v) => void patch(a, { failoverEligible: v })} label="Eligible for automatic failover" />
          <span className="faint">Kern may switch to this account automatically</span>
        </label>
        <span className="props__label">Kern budget</span>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ width: 110 }}
            inputMode="decimal"
            placeholder="No budget"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            onBlur={() => {
              const n = budget.trim() ? Number(budget) : null;
              if (n !== null && (!(n > 0) || Number.isNaN(n))) return setBudget(a.budgetLimit !== null ? String(a.budgetLimit) : "");
              if (n !== a.budgetLimit) void patch(a, { budgetLimit: n, budgetUnit: a.budgetUnit ?? "tokens" });
            }}
            aria-label="Monthly budget"
          />
          <Segmented size="sm" value={a.budgetUnit ?? "tokens"} onChange={(u) => void patch(a, { budgetUnit: u })} options={[{ value: "tokens", label: "Tokens" }, { value: "usd", label: "USD" }]} ariaLabel="Budget unit" />
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>per month · warn at</span>
          <Select
            value={String(a.budgetWarnPercent)}
            onChange={(v) => void patch(a, { budgetWarnPercent: Number(v) })}
            options={[50, 75, 80, 90, 100].map((n) => ({ value: String(n), label: `${n}%` }))}
            ariaLabel="Warn at"
          />
          <label className="row" style={{ gap: 6, fontSize: "var(--fs-xs)" }}>
            <Switch checked={a.budgetHard} onChange={(v) => void patch(a, { budgetHard: v })} label="Stop at budget" />
            Stop at budget
          </label>
        </div>
        <span />
        <span className="ai-details__note">
          Budgets apply only to requests made through Kern, counted locally ({formatTokens(a.month.tokens)} tokens{a.month.cost !== null ? `, ${formatUsd(a.month.cost)} estimated` : ""} this month). They aren't provider billing limits.
          {a.budgetUnit === "usd" && a.month.cost === null && " USD budgets need model prices, set under Routing."}
        </span>
        {a.provider === "openai" && (
          <>
            <span className="props__label">Organisation / project</span>
            <div className="row" style={{ gap: 6 }}>
              <input className="input mono" defaultValue={a.organizationId ?? ""} placeholder="Organisation ID" onBlur={(e) => e.target.value !== (a.organizationId ?? "") && void patch(a, { organizationId: e.target.value || null })} aria-label="Organisation ID" />
              <input className="input mono" defaultValue={a.projectRef ?? ""} placeholder="Project ID" onBlur={(e) => e.target.value !== (a.projectRef ?? "") && void patch(a, { projectRef: e.target.value || null })} aria-label="Project ID" />
            </div>
          </>
        )}
        <span className="props__label">Usage pool</span>
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          {a.organizationId || a.observedPool ? (
            <span className="mono">{a.organizationId || a.observedPool}</span>
          ) : (
            "Unknown until the first request"
          )}
        </span>
        <span className="props__label">Provider-reported limits</span>
        <div className="col" style={{ gap: 2, fontSize: "var(--fs-xs)" }}>
          {limits.length ? (
            <>
              {limits.map(([k, v]) => (
                <span key={k} className="row" style={{ gap: 8 }}>
                  <span className="mono faint">{k}</span>
                  <span className="mono">{v}</span>
                </span>
              ))}
              <span className="faint">As reported {a.rateLimits?.observedAt ? relativeTime(a.rateLimits.observedAt) : ""}.</span>
            </>
          ) : (
            <span className="faint">None reported yet. Limits appear after a request, from the provider's own response headers.</span>
          )}
        </div>
        <span className="props__label">Checked</span>
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          {a.lastCheckedAt ? `Tested ${relativeTime(a.lastCheckedAt)}` : "Never tested"}
          {a.lastUsedAt ? ` · last used ${relativeTime(a.lastUsedAt)}` : ""}
        </span>
      </div>
    </div>
  );
}

function AccountRow({ a, activeId, open, onToggle, onReplace }: { a: AiAccount; activeId: string | null; open: boolean; onToggle: () => void; onReplace: () => void }) {
  return (
    <div className="ai-account" data-open={open || undefined} data-disabled={!a.enabled || undefined}>
      <div className="ai-account__row" onClick={onToggle} role="button" tabIndex={0} aria-expanded={open} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggle())}>
        <ProviderIcon provider={a.provider} />
        <div className="col grow" style={{ minWidth: 0 }}>
          <span className="row" style={{ gap: 6 }}>
            <span className="ai-account__name truncate">{a.name}</span>
            {a.role === "primary" && <span className="chip">Primary</span>}
            {a.role === "fallback" && <span className="chip chip--outline">Fallback</span>}
          </span>
          <span className="ai-account__meta truncate">
            {PROVIDER_NAME[a.provider]}
            {NEEDS_KEY[a.provider] ? <> · <span className="mono">{a.keyHint ? `••••${a.keyHint}` : "••••••••"}</span></> : <> · no key, no per-token cost</>}
            {a.preferredModel && <> · {a.preferredModel}</>}
            {a.month.requests > 0 && <> · {a.month.requests} requests this month</>}
          </span>
        </div>
        <StatusLabel a={a} activeId={activeId} />
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Dropdown items={() => accountMenu(a, onReplace)} align="end">
            <IconButton icon={Ellipsis} label="Account actions" size="sm" noTooltip />
          </Dropdown>
        </span>
        <ChevronDown size={14} className="ai-account__chev" />
      </div>
      {open && <Details a={a} />}
    </div>
  );
}

/** "Active AI Account" picker: chooses the primary account. */
export function ActiveAccountPicker({ accounts }: { accounts: AiAccount[] }) {
  const primary = accounts.find((a) => a.role === "primary");
  return (
    <Dropdown
      align="start"
      minWidth={280}
      items={[
        { type: "label", label: "Use first" },
        ...accounts.map((a) => ({
          label: `${a.name} · ${PROVIDER_NAME[a.provider]}${!a.enabled ? " (disabled)" : a.status !== "ready" && a.status !== "unknown" ? ` (${STATUS_LABEL[a.status].toLowerCase()})` : ""}`,
          checked: a.role === "primary",
          disabled: !a.enabled,
          onSelect: () => void patch(a, { role: "primary" }),
        })),
      ]}
    >
      <button type="button" className="ai-active">
        {primary ? <ProviderIcon provider={primary.provider} size={22} /> : null}
        <span className="col" style={{ alignItems: "flex-start", minWidth: 0 }}>
          <span className="ai-active__caption">Active AI account</span>
          <span className="truncate">{primary ? primary.name : "None selected"}</span>
        </span>
        <ChevronDown size={14} className="faint" />
      </button>
    </Dropdown>
  );
}

export function AccountsTab() {
  const { data: accounts, isLoading } = useAiAccounts();
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<AiAccount | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const sensors = useListSensors();
  const list = useMemo(() => accounts ?? [], [accounts]);
  const ids = list.map((a) => a.id);
  const activeId = list.find((a) => a.role === "primary")?.id ?? null;
  const byId = new Map(list.map((a) => [a.id, a]));

  const commit = (next: string[], moved: string) => {
    queryClient.setQueryData<AiAccount[]>(["ai", "accounts"], next.map((id, i) => ({ ...byId.get(id)!, priority: i + 1 })));
    void api.ai
      .reorder(next)
      .catch((e) => toastError(describeError(e)))
      .finally(() => invalidate("ai"));
    announce(`${byId.get(moved)?.name} is now priority ${next.indexOf(moved) + 1} of ${next.length}.`);
  };
  const move = (id: string, d: -1 | 1) => {
    const i = ids.indexOf(id);
    if (i + d < 0 || i + d >= ids.length) return;
    commit(arrayMove(ids, i, i + d), id);
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    if (!e.over || e.active.id === e.over.id) return;
    commit(arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))), String(e.active.id));
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 10 }}>
        {list.length > 0 && <ActiveAccountPicker accounts={list} />}
        <span className="spacer" />
        <Button icon={Plus} onClick={() => setAdding(true)}>
          Add account
        </Button>
      </div>
      {isLoading ? (
        <Skeleton height={64} />
      ) : !list.length ? (
        <EmptyState icon={KeyRound} title="No API accounts yet" action={<Button icon={Plus} onClick={() => setAdding(true)}>Add an Anthropic or OpenAI key</Button>}>
          Kern works fully without AI. Add API keys to use AI features, with automatic switching between your accounts when one is unavailable.
        </EmptyState>
      ) : (
        <>
          <div className="ai-list-head">
            <span>Priority order</span>
            <span className="faint">Drag to reorder · Alt+↑/↓</span>
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVertical]}
            autoScroll={AUTO_SCROLL}
            accessibility={{ announcements: announcements((id) => byId.get(id)?.name ?? id, () => ids.length, (id) => ids.indexOf(id)) }}
            onDragStart={(e) => setDragId(String(e.active.id))}
            onDragCancel={() => setDragId(null)}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <div className="ai-list">
                {list.map((a) => (
                  <SortableRow key={a.id} id={a.id} handle disabled={openId === a.id} onMove={(d) => move(a.id, d)}>
                    <AccountRow a={a} activeId={activeId} open={openId === a.id} onToggle={() => setOpenId(openId === a.id ? null : a.id)} onReplace={() => setReplacing(a)} />
                  </SortableRow>
                ))}
              </div>
            </SortableContext>
            <DragOverlay dropAnimation={DROP_ANIMATION} modifiers={[restrictToVertical]}>
              {dragId && byId.get(dragId) && (
                <DragPreview>
                  <AccountRow a={byId.get(dragId)!} activeId={activeId} open={false} onToggle={() => undefined} onReplace={() => undefined} />
                </DragPreview>
              )}
            </DragOverlay>
          </DndContext>
        </>
      )}
      {adding && <AddAccountDialog onClose={() => setAdding(false)} />}
      {replacing && <AddAccountDialog replaceFor={replacing} onClose={() => setReplacing(null)} />}
    </div>
  );
}
