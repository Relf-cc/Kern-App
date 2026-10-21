/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// Streams: inbound endpoints (streams.relf.cc/kern/<id>) that turn
// submissions from websites and services - a bug report form, a CI job, a
// webhook - into tasks, inbox items and GitHub issues in the open cloud
// space. Owners and admins manage them here; everything is stored and
// enforced by Kern Cloud.

import { useEffect, useState } from "react";
import { BookOpen, Cloud, Copy, Plus, Radio, ShieldAlert, TriangleAlert } from "lucide-react";
import { api } from "@/lib/ipc";
import type { Stream } from "@/lib/types";
import { navigate, type StreamTab } from "@/stores/router";
import { toast, toastError } from "@/stores/toast";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { EmptyState, Skeleton } from "@/components/ui/Controls";
import { enableCloud, openPersonal } from "@/features/cloud/actions";
import { errorText, useActiveSpace, useCloud } from "@/features/cloud/store";
import { refreshStreams, streamsApi, useStreamList } from "./api";
import { StreamEditor } from "./StreamEditor";
import "./streams.css";

export default function StreamsPage({ id, tab }: { id?: string; tab?: StreamTab }) {
  const space = useActiveSpace();
  const signedIn = useCloud((s) => !!s.info?.signedIn);
  const admin = space?.role === "owner" || space?.role === "admin";
  const { data, isLoading, isError, error } = useStreamList(space?.id, admin);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ stream: Stream; secret: string; rotated?: boolean } | null>(null);

  const selected = data?.streams.find((s) => s.id === id) ?? data?.streams[0] ?? null;
  // Keep the address in step when the selection falls back to the first stream.
  useEffect(() => {
    if (selected && selected.id !== id) navigate({ name: "streams", id: selected.id, tab }, { replace: true });
  }, [selected, id, tab]);

  const header = (
    <header className="page-header">
      <h1 className="page-header__title">
        <Radio /> Streams
      </h1>
      {space && <span className="page-header__sub truncate">{space.kind === "personal" ? "Personal space" : space.name}</span>}
      <div className="page-header__actions">
        <Button variant="ghost" size="sm" icon={BookOpen} onClick={() => void api.system.open(data?.docsUrl ?? "https://kern.chrisrelf.xyz/docs/streams.html")}>
          Documentation
        </Button>
        {admin && data && (
          <Button size="sm" variant="primary" icon={Plus} disabled={data.streams.length >= data.limit} onClick={() => setCreating(true)}>
            New stream
          </Button>
        )}
      </div>
    </header>
  );

  if (!space) {
    return (
      <div className="page">
        {header}
        <EmptyState
          icon={Cloud}
          title="Streams live in Kern Cloud"
          action={
            <Button variant="primary" onClick={() => void (signedIn ? openPersonal() : enableCloud("Sign in to use streams."))}>
              {signedIn ? "Open your personal space" : "Turn on Kern Cloud"}
            </Button>
          }
        >
          A stream is an address your website or services send to, like a bug report form. Each submission becomes a task, an inbox item or a GitHub issue in a cloud space.
        </EmptyState>
      </div>
    );
  }
  if (!admin) {
    return (
      <div className="page">
        {header}
        <EmptyState icon={ShieldAlert} title="Only owners and admins manage streams">
          Streams can add work to {space.name} from outside, so they're limited to people who manage the workspace.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      {header}
      {isLoading ? (
        <div style={{ padding: 20 }}>
          <Skeleton height={200} />
        </div>
      ) : isError || !data ? (
        <EmptyState icon={TriangleAlert} title="Couldn't load streams">
          {errorText(error, "Kern Cloud didn't answer.")}
        </EmptyState>
      ) : !data.streams.length ? (
        <EmptyState
          icon={Radio}
          title="No streams yet"
          action={
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              Create a stream
            </Button>
          }
        >
          Give your website a bug report form, or let your CI open issues. Submissions arrive here as tasks, with spam protection, rate limits and a full delivery log.
        </EmptyState>
      ) : (
        <div className="settings">
          <nav className="settings__nav streams__nav" aria-label="Streams">
            {data.streams.map((s) => (
              <button key={s.id} type="button" className="nav-item streams__item" data-active={s.id === selected?.id || undefined} onClick={() => navigate({ name: "streams", id: s.id, tab }, { replace: true })}>
                <span className="streams__dot" data-state={!s.enabled ? "paused" : s.last24h?.problems ? "problem" : "ok"} />
                <span className="nav-item__label truncate">{s.name}</span>
                {!!s.last24h?.total && <span className="faint streams__count">{s.last24h.total}</span>}
              </button>
            ))}
            <span className="faint streams__limit">
              {data.streams.length} of {data.limit} streams
            </span>
          </nav>
          <div className="settings__body">
            {selected && <StreamEditor key={selected.id} space={space.id} stream={selected} tab={tab ?? "overview"} onSecret={(s, value) => setSecret({ stream: s, secret: value, rotated: true })} />}
          </div>
        </div>
      )}
      {creating && data && (
        <CreateStream
          space={space.id}
          presets={data.presets}
          onClose={() => setCreating(false)}
          onCreated={(s, value) => {
            setCreating(false);
            setSecret({ stream: s, secret: value });
            navigate({ name: "streams", id: s.id, tab: "overview" }, { replace: true });
          }}
        />
      )}
      {secret && <SecretDialog {...secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

const PRESET_TITLE: Record<string, string> = { bug_report: "Bug report form", feedback: "Feedback to Inbox", github_issue: "CI → GitHub issue", webhook: "Webhook" };

function CreateStream({ space, presets, onClose, onCreated }: { space: string; presets: { id: string; description: string }[]; onClose: () => void; onCreated: (s: Stream, secret: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [preset, setPreset] = useState<string>("bug_report");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!name.trim()) return toastError("Give the stream a name.");
    setBusy(true);
    try {
      const r = await streamsApi.create(space, { name: name.trim(), description: description.trim() || undefined, preset: preset === "blank" ? undefined : preset });
      await refreshStreams(space);
      onCreated(r.stream, r.secret);
    } catch (e) {
      toastError(errorText(e, "Couldn't create the stream."));
    } finally {
      setBusy(false);
    }
  };
  const options = [...presets, { id: "blank", description: "A public stream with no fields defined. Set everything up yourself." }];
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New stream"
      description="You can change everything afterwards."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
            {busy ? "Creating…" : "Create stream"}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <label className="col" style={{ gap: 4 }}>
          <span className="set-row__label">Name</span>
          <input className="input" autoFocus maxLength={80} placeholder="Bug reports" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} />
        </label>
        <label className="col" style={{ gap: 4 }}>
          <span className="set-row__label">Description</span>
          <input className="input" maxLength={500} placeholder="From the Report a bug button on the website" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="col" style={{ gap: 6 }}>
          <span className="set-row__label">Start from</span>
          <div className="streams__presets" role="radiogroup" aria-label="Starting point">
            {options.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={preset === p.id} className="streams__preset" data-active={preset === p.id || undefined} onClick={() => setPreset(p.id)}>
                <strong>{PRESET_TITLE[p.id] ?? "Blank"}</strong>
                <span className="faint">{p.description}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export function SecretDialog({ stream, secret, rotated, onClose }: { stream: Stream; secret: string; rotated?: boolean; onClose: () => void }) {
  const copy = () => void navigator.clipboard.writeText(secret).then(() => toast("Secret copied"));
  const usesSecret = stream.config.security.auth !== "public";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={rotated ? "New stream secret" : `${stream.name} is ready`}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        {!rotated && (
          <>
            <span className="muted">Send submissions to this address:</span>
            <CopyField value={stream.url} label="Copy address" />
          </>
        )}
        <span className="muted">
          {rotated
            ? "Update your senders with this secret."
            : usesSecret
              ? "Senders authenticate with this secret. Store it somewhere safe, such as your CI's secret settings."
              : "This stream is public, so it doesn't need the secret yet. Keep it in case you switch to secret tokens or signed requests later."}
        </span>
        <CopyField value={secret} label="Copy secret" mono />
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          Owners and admins can reveal it again later from Security; each reveal is recorded in the activity log.
        </span>
        <Button icon={Copy} onClick={copy}>
          Copy secret
        </Button>
      </div>
    </Dialog>
  );
}

export function CopyField({ value, label, mono = true }: { value: string; label: string; mono?: boolean }) {
  return (
    <div className="streams__copy">
      <input className={`input${mono ? " mono" : ""}`} readOnly value={value} onFocus={(e) => e.currentTarget.select()} aria-label={label} />
      <Button size="sm" icon={Copy} onClick={() => void navigator.clipboard.writeText(value).then(() => toast("Copied"))}>
        Copy
      </Button>
    </div>
  );
}
