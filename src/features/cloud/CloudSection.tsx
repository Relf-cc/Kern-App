/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// Settings → Account & Cloud: online collaboration, the account, sync and
// what is (and isn't) shared.

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, CloudOff, CloudUpload, HardDrive, KeyRound, LogOut, Pencil, RefreshCw, RotateCcw, Trash, Upload } from "lucide-react";
import { api } from "@/lib/ipc";
import { Button, IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Controls";
import { Dialog, confirm } from "@/components/ui/Dialog";
import { SToggle } from "@/features/settings/controls";
import { useSetting } from "@/stores/settings";
import { toast, toastError } from "@/stores/toast";
import { disableCloud, enableCloud, openPersonal, signOut, switchSpace } from "./actions";
import { ServerSection } from "./ServerSection";
import { errorText, openAuth, refreshMe, refreshStatus, useActiveSpace, useCloud } from "./store";
import { syncLabel } from "./SpaceSwitcher";
import { Avatar, processLogo, timeAgo } from "./ui";
import { YearHeatmap } from "@/features/stats/YearHeatmap";

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row__text">
        <span className="set-row__label">{label}</span>
        {hint && <span className="set-row__hint">{hint}</span>}
      </div>
      {children && <div className="set-row__control">{children}</div>}
    </div>
  );
}

interface SessionInfo {
  id: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}

import { CaptureAnywhere } from "./CaptureAnywhere";

export function CloudSection() {
  const enabled = useSetting("cloud.enabled");
  const network = useSetting("privacy.network");
  const info = useCloud((s) => s.info);
  const me = useCloud((s) => s.me);
  const active = useActiveSpace();
  const account = info?.account;
  const signedIn = !!info?.signedIn;

  return (
    <div className="col" style={{ gap: 20 }}>
      <section>
        <div className="set-group__title">Online collaboration</div>
        <div className="set-group">
          <Row
            label="Kern Cloud"
            hint={
              !network
                ? "Network access is off in Privacy, so Kern Cloud is unavailable."
                : enabled
                  ? "On: sync a personal space across devices and collaborate in workspaces in real time."
                  : "Off: Kern works entirely on this computer, with no account."
            }
          >
            <Switch
              checked={enabled && signedIn}
              disabled={!network}
              label="Online collaboration"
              onChange={(on) => void (on ? enableCloud() : disableCloud())}
            />
          </Row>
          <div className="set-row" style={{ flexWrap: "wrap" }}>
            <div className="sync-scope">
              <div>
                <span className="sync-scope__title">
                  <CloudUpload size={13} /> Synced in cloud spaces
                </span>
                <span>Projects, boards and columns, tasks and subtasks, labels, GitHub issues, milestones and releases, notes, inbox, whiteboards</span>
              </div>
              <div>
                <span className="sync-scope__title">
                  <HardDrive size={13} /> Always stays on this computer
                </span>
                <span>Files, folders and attachments, repositories and worktrees, terminals and commands, environment variables, services, AI keys, settings, pins and personal views</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <ServerSection />

      {!signedIn ? (
        <>
          <section>
            <div className="set-group__title">Account</div>
            <div className="set-group">
              <Row label={account ? `Signed out (${account.email})` : "Not signed in"} hint="A free account lets you sync a personal space between your devices and join workspaces.">
                <Button size="sm" variant="primary" disabled={!network} onClick={() => openAuth({ email: account?.email, then: () => enableCloud() })}>
                  Sign in
                </Button>
                <Button size="sm" disabled={!network} onClick={() => openAuth({ mode: "sign-up", then: () => enableCloud() })}>
                  Create account
                </Button>
              </Row>
            </div>
          </section>
          <ActivityGroup />
        </>
      ) : (
        <>
          <AccountGroup />
          <ActivityGroup />
          <section>
            <div className="set-group__title">Sync</div>
            <div className="set-group">
              <Row label="Open space" hint={active ? syncLabel(info?.sync, true).text : "Offline data on this computer - nothing is synced."}>
                <span className="row" style={{ gap: 6 }}>
                  {active ? (active.kind === "personal" ? "Personal" : active.name) : "Offline"}
                </span>
              </Row>
              {active && (
                <Row label="Sync now" hint={`Last synced ${timeAgo(info?.sync.lastSyncedAt)}${info?.sync.pending ? ` · ${info.sync.pending} change(s) waiting to upload` : ""}.`}>
                  <Button size="sm" icon={RefreshCw} onClick={() => void api.cloud.syncNow()}>
                    Sync
                  </Button>
                </Row>
              )}
              {active && (
                <Row label="Restore from the server" hint="Replaces this computer's copy of the open space with the server's, discarding changes that haven't uploaded yet.">
                  <Button
                    size="sm"
                    icon={RotateCcw}
                    onClick={async () => {
                      const ok = await confirm({ title: "Restore from the server?", message: "Changes on this computer that haven't synced yet are discarded.", confirmLabel: "Restore", danger: true });
                      if (ok) {
                        await api.cloud.resync();
                        toast("Restoring from the server…");
                      }
                    }}
                  >
                    Restore
                  </Button>
                </Row>
              )}
              <Row label="Personal space" hint={me?.personal ? "Your own synced space: like a workspace, just for you, on every device you sign in on." : "Create a private synced space for your own work."}>
                <Button size="sm" onClick={() => void openPersonal()} disabled={active?.kind === "personal"}>
                  {active?.kind === "personal" ? "Open" : me?.personal ? "Open" : "Create & open"}
                </Button>
              </Row>
              <Row label="Copy offline data to the cloud" hint="Copies projects, tasks, boards, notes and whiteboards from offline data into the open cloud space. Files are never uploaded.">
                <Button
                  size="sm"
                  icon={Upload}
                  onClick={async () => {
                    if (!active) {
                      const s = await openPersonal();
                      if (!s) return;
                    }
                    useCloud.setState({ importOpen: true });
                  }}
                >
                  Copy…
                </Button>
              </Row>
              {active && (
                <Row label="Back to offline data" hint="Cloud spaces stay on the server and on this computer for next time.">
                  <Button size="sm" icon={CloudOff} onClick={() => void switchSpace(null)}>
                    Switch to offline
                  </Button>
                </Row>
              )}
            </div>
          </section>
          <section>
            <div className="set-group__title">Capture from anywhere</div>
            <div className="set-group" style={{ padding: "12px 14px" }}>
              <CaptureAnywhere />
            </div>
          </section>
          <section>
            <div className="set-group__title">Presence</div>
            <div className="set-group">
              <Row label="Share where I am" hint="Collaborators see which whiteboard or project you have open, and your cursor on whiteboards. Nothing is stored.">
                <SToggle k="cloud.sharePresence" />
              </Row>
              <Row label="Show collaborators' cursors" hint="Live cursors and selections on whiteboards.">
                <SToggle k="cloud.showCursors" />
              </Row>
              <Row label="Stream notifications" hint="A notification when a stream adds a task or inbox item to the open space.">
                <SToggle k="cloud.streamToasts" />
              </Row>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** Tasks completed per day over the last year (in the open space). */
function ActivityGroup() {
  return (
    <section>
      <div className="set-group__title">Your activity</div>
      <YearHeatmap />
    </section>
  );
}

function AccountGroup() {
  const account = useCloud((s) => s.info?.account)!;
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(account.name);
  const sessions = useQuery({ queryKey: ["cloud", "sessions"], queryFn: () => api.cloud.request<SessionInfo[]>("GET", "/auth/list-sessions"), staleTime: 30_000 });

  const update = async (patch: Record<string, unknown>, ok: string) => {
    try {
      await api.cloud.request("POST", "/auth/update-user", patch);
      await refreshStatus();
      await refreshMe();
      toast(ok);
    } catch (e) {
      toastError(errorText(e, "Couldn't update your profile."));
    }
  };

  const [pw, setPw] = useState<null | "change" | "delete">(null);

  const others = (sessions.data ?? []).length - 1;
  return (
    <section>
      <div className="set-group__title">Account</div>
      <div className="set-group">
        <div className="set-row account-row">
          <label className="avatar-edit" title="Change picture">
            <Avatar name={account.name || account.email} image={account.image} size={40} />
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  await update({ image: await processLogo(f, 128) }, "Picture updated");
                } catch (err) {
                  toastError((err as Error).message);
                }
              }}
            />
          </label>
          <div className="set-row__text">
            {editingName ? (
              <form
                className="row"
                style={{ gap: 6 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim()) void update({ name: name.trim() }, "Name updated").then(() => setEditingName(false));
                }}
              >
                <input className="input grow" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditingName(false)} />
                <Button size="sm" type="submit" icon={Check}>
                  Save
                </Button>
              </form>
            ) : (
              <span className="row" style={{ gap: 4 }}>
                <span className="set-row__label truncate" style={{ fontWeight: 600 }}>
                  {account.name || "Add your name"}
                </span>
                <IconButton
                  icon={Pencil}
                  size="sm"
                  label="Edit name"
                  onClick={() => {
                    setName(account.name);
                    setEditingName(true);
                  }}
                />
              </span>
            )}
            <span className="set-row__hint truncate">
              {account.email}
              {account.emailVerified ? " · verified" : ""}
            </span>
          </div>
          <div className="set-row__control">
            <Button size="sm" icon={LogOut} onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
        <Row label="Password" hint="Forgot it? Sign out and use “Forgot password?” to get a recovery code by email.">
          <Button size="sm" icon={KeyRound} onClick={() => setPw("change")}>
            Change…
          </Button>
        </Row>
        <Row label="Signed-in devices" hint={sessions.isLoading ? "Checking…" : others > 0 ? `${others} other device${others === 1 ? "" : "s"} signed in.` : "Only this computer."}>
          {others > 0 && (
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await api.cloud.request("POST", "/auth/revoke-other-sessions", {});
                  void sessions.refetch();
                  toast("Signed out everywhere else");
                } catch (e) {
                  toastError(errorText(e, "Couldn't sign out the other devices."));
                }
              }}
            >
              Sign out others
            </Button>
          )}
        </Row>
        <Row label="Delete account" hint="Removes your account and personal space from the server. Offline data stays.">
          <Button size="sm" variant="danger" icon={Trash} onClick={() => setPw("delete")}>
            Delete…
          </Button>
        </Row>
      </div>
      {pw && <PasswordDialog kind={pw} onClose={() => setPw(null)} onChanged={() => void sessions.refetch()} />}
    </section>
  );
}

/** Change password, or confirm account deletion, with masked inputs. */
function PasswordDialog({ kind, onClose, onChanged }: { kind: "change" | "delete"; onClose: () => void; onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    if (kind === "change" && next.length < 8) return setError("Use at least 8 characters for the new password.");
    setBusy(true);
    try {
      if (kind === "change") {
        await api.cloud.request("POST", "/auth/change-password", { currentPassword: current, newPassword: next, revokeOtherSessions: true });
        toast("Password changed. Other devices were signed out.");
        onChanged();
      } else {
        const ok = await confirm({
          title: "Delete your Kern Cloud account?",
          message: "Your personal space and workspace memberships are deleted from the server. Workspaces you own with other members must be transferred first. Offline data on this computer is untouched.",
          confirmLabel: "Delete account",
          danger: true,
        });
        if (!ok) return;
        await api.cloud.request("POST", "/auth/delete-user", { password: current });
        await api.cloud.signOut(true);
        await refreshStatus();
        useCloud.setState({ me: null });
        toast("Your Kern Cloud account was deleted.");
      }
      onClose();
    } catch (e) {
      setError(errorText(e, kind === "change" ? "Couldn't change the password." : "Couldn't delete the account."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      centered
      onOpenChange={(o) => !o && onClose()}
      title={kind === "change" ? "Change password" : "Delete account"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={kind === "delete" ? "danger" : "primary"} disabled={busy || !current || (kind === "change" && !next)} onClick={() => void submit()}>
            {kind === "change" ? (busy ? "Saving…" : "Change password") : busy ? "Deleting…" : "Delete account"}
          </Button>
        </>
      }
    >
      <form
        className="col"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label className="field__label">{kind === "change" ? "Current password" : "Your password"}</label>
          <input className="input" type="password" autoFocus autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        {kind === "change" && (
          <div className="field">
            <label className="field__label">New password</label>
            <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            <span className="field__hint">At least 8 characters. Other devices are signed out.</span>
          </div>
        )}
        {error && <div className="auth__error">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
