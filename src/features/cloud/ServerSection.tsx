/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Settings → Account & Cloud → Kern server: which server this copy of Kern
// signs in to.
//
// Kern Cloud is a server, not a service. The same code runs at the public
// address and on somebody's own machine or company network (the
// `Kern-Cloud-Self-Host` repository), so this is a choice people make, not
// something fixed when Kern was built.
//
// The rules live in the backend (`domain/cloud/servers.rs`); this screen only
// has to be honest about them:
//
//   * `KERN_CLOUD_URL` wins. When it is set the choice is locked and the
//     controls here are disabled, with a line saying why.
//   * Nothing is added without a native dialog naming the host. This screen
//     can propose a server; only the person can accept one.
//   * Each server has its own account. Switching never carries a session
//     along, so the new one asks for a sign-in - which is what makes a
//     silent switch worthless to anyone who managed to force one.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Cloud, Loader2, Lock, Plus, Server, ShieldAlert, Trash } from "lucide-react";
import { api } from "@/lib/ipc";
import type { CloudServer, Registration, ServerCheck } from "@/lib/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog, confirm } from "@/components/ui/Dialog";
import { toast, toastError } from "@/stores/toast";
import { resetInterface } from "@/app/reset";
import { errorText, refreshMe, refreshStatus, useCloud } from "./store";

/** The public Kern Cloud. Always offered, never in the stored list: it is the
 * fallback, not a choice somebody made. */
const PUBLIC_API = "https://api.relf.cc/kern/v1";

/** What the backend says when the person cancelled the native dialog. */
const CANCELLED = "Left as it was.";

const REGISTRATION: Record<Registration, string> = {
  open: "Anyone can create an account here.",
  invite: "New accounts need an invitation from this server's administrator.",
  closed: "This server isn't taking new accounts.",
};

/** The host on its own, which is what identifies a server to a person. */
function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ServerSection() {
  const info = useCloud((s) => s.info);
  const server = info?.server;
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const servers = useQuery({ queryKey: ["cloud", "servers"], queryFn: () => api.cloud.servers(), staleTime: 30_000 });

  const locked = server?.source === "environment";
  const current = server?.url ?? PUBLIC_API;
  const rows: CloudServer[] = [
    { url: PUBLIC_API, name: "Kern Cloud", instanceName: null, addedAt: null },
    ...(servers.data ?? []).filter((s) => s.url !== PUBLIC_API),
  ];

  /** Applies a change and rebuilds the interface: a different server means a
   * different account and a different set of spaces, so nothing on screen
   * survives the change. */
  const apply = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      const fresh = await refreshStatus();
      resetInterface(fresh?.active?.id ?? null);
      await servers.refetch();
      if (fresh?.signedIn) await refreshMe();
      return true;
    } catch (e) {
      const msg = errorText(e, "Couldn't change the server.");
      if (msg !== CANCELLED) toastError(msg);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const select = async (url: string) => {
    if (url === current) return;
    if (await apply(url, () => api.cloud.serverSelect(url === PUBLIC_API ? null : url))) {
      toast(`Now using ${url === PUBLIC_API ? "Kern Cloud" : host(url)}. Sign in to this server to sync.`);
    }
  };

  const forget = async (s: CloudServer) => {
    const ok = await confirm({
      title: `Forget ${host(s.url)}?`,
      message: "Kern forgets the address and the session it holds for it. Your account and everything on that server are untouched - you can add it again later.",
      confirmLabel: "Forget server",
      danger: true,
    });
    if (!ok) return;
    if (await apply(s.url, () => api.cloud.serverRemove(s.url))) toast(`Forgot ${host(s.url)}.`);
  };

  return (
    <section>
      <div className="set-group__title">Kern server</div>
      <div className="set-group">
        <div className="set-row">
          <div className="set-row__text">
            <span className="set-row__label">Signing in to</span>
            <span className="set-row__hint">
              {locked
                ? "Set by KERN_CLOUD_URL when Kern was started, so it can't be changed here."
                : "Kern Cloud is a server, not a service: use the public one, or your own. Each server has its own account and its own spaces."}
            </span>
          </div>
          <div className="set-row__control">
            <span className="row" style={{ gap: 6 }}>
              {locked ? <Lock size={13} /> : current === PUBLIC_API ? <Cloud size={13} /> : <Server size={13} />}
              {server?.name ?? "Kern Cloud"}
            </span>
          </div>
        </div>

        {rows.map((s) => {
          const chosen = s.url === current;
          const isPublic = s.url === PUBLIC_API;
          const working = busy === s.url;
          return (
            <div className="set-row" key={s.url}>
              <div className="set-row__text">
                <span className="set-row__label">
                  {s.instanceName || s.name}
                  {chosen && (
                    <span className="server-row__badge">
                      <Check size={11} /> in use
                    </span>
                  )}
                </span>
                <span className="set-row__hint">
                  {isPublic ? "The public server, hosted by Kern." : host(s.url)}
                  {!isPublic && s.url.startsWith("http://") && " · not encrypted"}
                </span>
              </div>
              <div className="set-row__control">
                {!chosen && (
                  <Button size="sm" icon={working ? Loader2 : undefined} disabled={locked || !!busy} onClick={() => void select(s.url)}>
                    Use
                  </Button>
                )}
                {!isPublic && <IconButton icon={working ? Loader2 : Trash} label={`Forget ${host(s.url)}`} size="sm" disabled={locked || !!busy} onClick={() => void forget(s)} />}
              </div>
            </div>
          );
        })}

        <div className="set-row">
          <div className="set-row__text">
            <span className="set-row__label">Add a server</span>
            <span className="set-row__hint">Its address, from whoever runs it — or http://127.0.0.1:8787 for one on this computer.</span>
          </div>
          <div className="set-row__control">
            <Button size="sm" icon={Plus} disabled={locked || !!busy} onClick={() => setAdding(true)}>
              Add…
            </Button>
          </div>
        </div>
      </div>

      {adding && (
        <AddServerDialog
          onClose={() => setAdding(false)}
          onAdded={async (check) => {
            setAdding(false);
            const fresh = await refreshStatus();
            resetInterface(fresh?.active?.id ?? null);
            await servers.refetch();
            toast(`Now using ${check.name}. Sign in to this server to sync.`, { tone: "success" });
          }}
        />
      )}
    </section>
  );
}

/**
 * Asks an address what it is, shows the answer, then hands over to the
 * backend - which asks again, in a dialog this window cannot press. Two
 * prompts is deliberate: the first is where a typo or a wrong port is caught,
 * the second is the one that actually authorises anything.
 */
function AddServerDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (check: ServerCheck) => void | Promise<void> }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<ServerCheck | null>(null);

  const check = async () => {
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      const reply = await api.cloud.serverCheck(url);
      setFound(reply);
      if (!name.trim()) setName(reply.name);
    } catch (e) {
      setError(errorText(e, "Couldn't reach that address."));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!found) return;
    setBusy(true);
    setError(null);
    try {
      await api.cloud.serverAdd(found.url, name.trim());
      await onAdded(found);
    } catch (e) {
      const msg = errorText(e, "Couldn't add that server.");
      setError(msg === CANCELLED ? null : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a Kern server"
      description="Kern asks the address what it is before anything is saved. No account details are sent."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {found ? (
            <Button variant="primary" icon={busy ? Loader2 : undefined} disabled={busy} onClick={() => void add()}>
              Use this server
            </Button>
          ) : (
            <Button variant="primary" icon={busy ? Loader2 : undefined} disabled={busy || !url.trim()} onClick={() => void check()}>
              Check
            </Button>
          )}
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="field">
          <label className="field__label">Address</label>
          <input
            className="input"
            value={url}
            autoFocus
            placeholder="kern.example.com"
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => {
              setUrl(e.target.value);
              setFound(null);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && url.trim() && !found && !busy) void check();
            }}
          />
          <span className="field__hint">https:// is assumed. http:// is only allowed for this computer or a private network.</span>
        </div>

        {found && (
          <>
            <div className="field">
              <label className="field__label">Call it</label>
              <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="cloud-callout">
              <Server size={14} />
              <div className="col" style={{ gap: 4 }}>
                <span style={{ fontWeight: 600 }}>{found.name}</span>
                <span>{found.url}</span>
                <span>{REGISTRATION[found.registration]}</span>
                {!found.sendsEmail && <span>This server can't send email, so its administrator confirms accounts by hand.</span>}
                {found.notice && <span>“{found.notice}”</span>}
                {found.contact && <span>Contact: {found.contact}</span>}
                {found.added && <span>Already in your list — this will switch to it.</span>}
              </div>
            </div>
            {found.warning && (
              <div className="cloud-callout">
                <ShieldAlert size={14} />
                <span>{found.warning}</span>
              </div>
            )}
            <span className="field__hint">
              Your account on this server is separate from every other Kern server, and anything you choose to sync is stored on it. Kern will ask you to confirm once more.
            </span>
          </>
        )}

        {error && (
          <div className="auth__error" role="alert">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
