/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { CircleAlert, CircleCheck, ShieldCheck, Terminal } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Controls";
import { confirm } from "@/components/ui/Dialog";
import { toast, toastError } from "@/stores/toast";
import { SNumber, SToggle } from "@/features/settings/controls";

const GUARANTEES = [
  "Keys are stored only in your system's credential store, never in Kern's database or browser storage.",
  "Kern never shows a saved key again or sends it to the interface; requests are made by Kern's backend.",
  "Keys never appear in logs, error messages, URLs, command lines or backups and exports.",
  "Removing an account deletes its key from the credential store.",
  "Only request metadata is kept (time, model, tokens, outcome) - never prompts or replies.",
  "Nothing is sent to an AI provider unless you make a request; Kern doesn't poll for usage.",
];

export function SecurityTab() {
  const { data: report } = useQuery({ queryKey: ["ai", "security"], queryFn: api.ai.security });
  return (
    <div className="col" style={{ gap: 20 }}>
      <section>
        <div className="set-group__title">Secret storage</div>
        <div className="set-group">
          <div className="set-row">
            <div className="set-row__text">
              <span className="set-row__label">Credential store</span>
              <span className="set-row__hint">{report ? report.store : "Checking…"}</span>
            </div>
            <div className="set-row__control">
              {!report ? (
                <Skeleton width={120} />
              ) : report.missing.length ? (
                <span className="row" style={{ gap: 6, fontSize: "var(--fs-sm)" }}>
                  <CircleAlert size={14} /> {report.missing.length} key{report.missing.length === 1 ? "" : "s"} missing
                </span>
              ) : (
                <span className="row faint" style={{ gap: 6, fontSize: "var(--fs-sm)" }}>
                  <CircleCheck size={14} /> {report.keysPresent} of {report.accounts} keys present
                </span>
              )}
            </div>
          </div>
          {report && report.missing.length > 0 && (
            <div className="set-row">
              <span className="set-row__hint">
                Missing on this device: {report.missing.join(", ")}. This happens after restoring a backup on another computer - backups never contain keys. Replace the key from the account's menu.
              </span>
            </div>
          )}
        </div>
        <ul className="ai-guarantees">
          {GUARANTEES.map((g) => (
            <li key={g}>
              <ShieldCheck size={13} />
              {g}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <div className="set-group__title">Privacy</div>
        <div className="set-group">
          <Row label="Allow external network requests" hint="When off, no AI requests or connection tests are made.">
            <SToggle k="privacy.network" />
          </Row>
          <Row label="AI access to project content" hint="Off by default. Each project can choose its own AI account and model under its Details.">
            <SToggle k="privacy.aiProjectContent" />
          </Row>
          <Row label="AI access to linked folders" hint="Also needs a trusted folder and the project's own permission. Trust alone never allows it.">
            <SToggle k="privacy.aiLinkedFolders" />
          </Row>
          <Row label="Keep request history for" hint="Older entries are deleted automatically.">
            <SNumber k="ai.usageRetentionDays" min={1} max={3650} suffix="days" />
          </Row>
          <Row label="Clear AI request history" hint="Deletes usage and switching history. Accounts and keys are kept.">
            <Button
              size="sm"
              onClick={async () => {
                if (!(await confirm({ title: "Clear AI request history?", message: "Usage and switching history are deleted permanently.", confirmLabel: "Clear history", danger: true }))) return;
                try {
                  await api.ai.clearHistory();
                  invalidate("ai");
                  toast("History cleared");
                } catch (e) {
                  toastError(describeError(e));
                }
              }}
            >
              Clear…
            </Button>
          </Row>
        </div>
      </section>
      <section>
        <div className="set-group__title">External coding agents</div>
        <div className="set-group">
          {AGENTS.map((a) => (
            <div key={a.tool} className="set-row">
              <Terminal size={14} className="faint" />
              <div className="set-row__text">
                <span className="set-row__label">{a.tool}</span>
                <span className="set-row__hint">{a.hint}</span>
              </div>
              <span className="set-row__control faint" style={{ fontSize: "var(--fs-sm)" }}>
                {a.state}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * What Kern does and doesn't do with a coding agent installed on this
 * computer. Kern can run the `claude` command as a model for its own AI
 * features, which is a one-turn text request in a scratch folder - it never
 * reads or changes that command's sign-in, and the command is not used as an
 * agent. Nothing here is about assistants connecting *to* Kern, which is the
 * Assistants tab.
 */
const AGENTS = [
  {
    tool: "Claude Code",
    state: "Usable as a provider",
    hint: "Add a Claude subscription account under Accounts and Kern runs the claude command for its own AI features, on whatever that command is already signed in as. Kern never reads or changes that sign-in, and runs it as a model - one turn, in a scratch folder - not as an agent.",
  },
  {
    tool: "Codex CLI",
    state: "Unsupported",
    hint: "Kern doesn't launch it, so it never reads or changes its sign-in or accounts.",
  },
];

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
