/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// Sidebar switcher between offline data, the personal cloud space and
// workspaces, with sync status and who's online.

import { DropdownMenu as DM } from "radix-ui";
import {
  Check,
  ChevronsUpDown,
  CloudOff,
  Cog,
  Copy,
  LogIn,
  LogOut,
  Mail,
  Plus,
  Radio,
  RefreshCw,
  Settings2,
  UserPlus,
  Wifi,
} from "lucide-react";
import { useMemo } from "react";
import { api } from "@/lib/ipc";
import { navigate } from "@/stores/router";
import { useSetting } from "@/stores/settings";
import { Tooltip } from "@/components/ui/Tooltip";
import type { Space, SyncStatus } from "@/lib/types";
import { useActiveSpace, useCloud } from "./store";
import { enableCloud, openInvite, openPersonal, signOut, spaceRef, switchSpace } from "./actions";
import { Avatar, ROLE_LABEL, SpaceLogo, spaceLook, timeAgo } from "./ui";

export function syncLabel(s: SyncStatus | undefined, active: boolean): { tone: string; text: string } {
  if (!active || !s) return { tone: "off", text: "Offline data on this computer" };
  const pending = s.pending ? ` · ${s.pending} change${s.pending === 1 ? "" : "s"} waiting` : "";
  switch (s.state) {
    case "syncing":
      return { tone: "busy", text: `Syncing…${pending}` };
    case "offline":
      return { tone: "warn", text: `Offline - changes are saved here and sync when you're back online${pending}` };
    case "error":
      return { tone: "error", text: `${s.message ?? "Sync problem"}${pending}` };
    case "signed_out":
      return { tone: "error", text: "Signed out - sign in to sync" };
    case "read_only":
      return { tone: "muted", text: "View only - your changes aren't saved to this workspace" };
    default:
      return { tone: "ok", text: `Synced ${timeAgo(s.lastSyncedAt)}${pending}` };
  }
}

function Item({ onSelect, children, active, disabled }: { onSelect: () => void; children: React.ReactNode; active?: boolean; disabled?: boolean }) {
  return (
    <DM.Item className="menu__item space-menu__item" onSelect={onSelect} disabled={disabled}>
      {children}
      {active && <Check size={14} className="menu__check" />}
    </DM.Item>
  );
}

export function SpaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const enabled = useSetting("cloud.enabled");
  const info = useCloud((s) => s.info);
  const me = useCloud((s) => s.me);
  const peers = useCloud((s) => s.peers);
  const connected = useCloud((s) => s.connected);
  const active = useActiveSpace();
  const signedIn = !!info?.signedIn;
  const status = syncLabel(info?.sync, !!active);
  const online = useMemo(() => {
    const byUser = new Map<string, (typeof peers)[string]>();
    Object.values(peers).forEach((p) => byUser.set(p.userId, p));
    return [...byUser.values()].filter((p) => p.userId !== info?.account?.id);
  }, [peers, info?.account?.id]);

  const name = active ? (active.kind === "personal" ? "Personal" : active.name) : "Offline";
  const isAdmin = active?.kind === "workspace" && (active.role === "owner" || active.role === "admin");

  const trigger = (
    <button type="button" className="space-switch" data-collapsed={collapsed || undefined} aria-label={`Space: ${name}. ${status.text}`}>
      <span className="space-switch__logo">
        <SpaceLogo name={name} logo={active?.logo} kind={active ? active.kind : "offline"} size={collapsed ? 20 : 22} accent={active?.accent} icon={active?.icon} />
        <span className="sync-dot" data-tone={status.tone} />
      </span>
      {!collapsed && (
        <>
          <span className="space-switch__text">
            <span className="space-switch__name truncate">{name}</span>
            <span className="space-switch__sub truncate">
              {active ? (active.kind === "personal" ? "Cloud · just you" : `${ROLE_LABEL[active.role ?? "member"]} · ${connected ? "live" : "workspace"}`) : enabled && signedIn ? "This computer" : "This computer · no account"}
            </span>
          </span>
          {online.length > 0 && (
            <span className="avatar-stack" aria-label={`${online.length} online`}>
              {online.slice(0, 3).map((p) => (
                <Avatar key={p.userId} name={p.name} image={p.image} color={p.color} size={16} />
              ))}
            </span>
          )}
          <ChevronsUpDown size={13} className="faint" />
        </>
      )}
    </button>
  );

  const workspaces = me?.workspaces ?? [];
  const invites = me?.invites ?? [];

  return (
    <DM.Root modal={false}>
      <Tooltip content={collapsed ? `${name} · ${status.text}` : status.text} side="right">
        <DM.Trigger asChild>{trigger}</DM.Trigger>
      </Tooltip>
      <DM.Portal>
        <DM.Content className="menu space-menu" align="start" side={collapsed ? "right" : "bottom"} sideOffset={4} collisionPadding={8}>
          {signedIn && info?.account && (
            <div className="space-menu__account">
              <Avatar name={info.account.name || info.account.email} image={info.account.image} size={28} />
              <div className="col" style={{ minWidth: 0 }}>
                <span className="truncate" style={{ fontWeight: 600 }}>{info.account.name || "Your account"}</span>
                <span className="truncate faint" style={{ fontSize: "var(--fs-xs)" }}>{info.account.email}</span>
              </div>
            </div>
          )}
          {active && online.length > 0 && (
            <div className="space-menu__online">
              <span className="faint">Online now</span>
              <span className="avatar-stack">
                {online.slice(0, 8).map((p) => (
                  <Avatar key={p.userId} name={p.name} image={p.image} color={p.color} size={20} />
                ))}
              </span>
            </div>
          )}
          <DM.Label className="menu__label">Spaces</DM.Label>
          <Item onSelect={() => void switchSpace(null)} active={!active}>
            <SpaceLogo name="Offline" kind="offline" size={20} />
            <span className="space-menu__label">
              <span className="truncate">Offline</span>
              <span className="faint">This computer only · no account</span>
            </span>
          </Item>
          {signedIn && enabled && (
            <>
              <Item onSelect={() => (me?.personal ? void switchSpace(spaceRef(me.personal)) : void openPersonal())} active={active?.kind === "personal"}>
                <SpaceLogo name="Personal" kind="personal" size={20} />
                <span className="space-menu__label">
                  <span className="truncate">Personal</span>
                  <span className="faint">Synced across your devices</span>
                </span>
              </Item>
              {workspaces.map((w: Space) => (
                <Item key={w.id} onSelect={() => void switchSpace(spaceRef(w))} active={active?.id === w.id}>
                  <SpaceLogo name={w.name} logo={w.logo} accent={w.accent} icon={spaceLook(w.settings).icon} size={20} />
                  <span className="space-menu__label">
                    <span className="truncate">{w.name}</span>
                    <span className="faint">
                      {ROLE_LABEL[w.role]} · {w.memberCount ?? 1} member{(w.memberCount ?? 1) === 1 ? "" : "s"}
                    </span>
                  </span>
                </Item>
              ))}
              {invites.length > 0 && <DM.Label className="menu__label">Invitations</DM.Label>}
              {invites.map((i) => (
                <Item key={i.id} onSelect={() => openInvite(i.id)}>
                  <SpaceLogo name={i.workspace ?? "Workspace"} logo={i.logo} size={20} />
                  <span className="space-menu__label">
                    <span className="truncate">{i.workspace}</span>
                    <span className="faint">
                      <Mail size={10} /> From {i.inviterName ?? "a member"} · {ROLE_LABEL[i.role]}
                    </span>
                  </span>
                </Item>
              ))}
            </>
          )}
          <DM.Separator className="menu__sep" />
          {!signedIn || !enabled ? (
            <>
              <DM.Item className="menu__item" onSelect={() => void enableCloud()}>
                <Wifi strokeWidth={1.75} />
                <span>Turn on online collaboration</span>
              </DM.Item>
              {!signedIn && (
                <DM.Item className="menu__item" onSelect={() => void enableCloud("Sign in to Kern Cloud.")}>
                  <LogIn strokeWidth={1.75} />
                  <span>Sign in</span>
                </DM.Item>
              )}
            </>
          ) : (
            <>
              <DM.Item className="menu__item" onSelect={() => useCloud.setState({ createOpen: true })}>
                <Plus strokeWidth={1.75} />
                <span>Create workspace</span>
              </DM.Item>
              {active?.kind === "workspace" && (
                <DM.Item className="menu__item" onSelect={() => useCloud.setState({ manage: { id: active.id, tab: "general" } })}>
                  <Settings2 strokeWidth={1.75} />
                  <span className="truncate">Manage {active.name}</span>
                </DM.Item>
              )}
              {isAdmin && (
                <DM.Item className="menu__item" onSelect={() => useCloud.setState({ manage: { id: active!.id, tab: "invites" } })}>
                  <UserPlus strokeWidth={1.75} />
                  <span>Invite people</span>
                </DM.Item>
              )}
              {active && (active.role === "owner" || active.role === "admin") && (
                <DM.Item className="menu__item" onSelect={() => navigate({ name: "streams" })}>
                  <Radio strokeWidth={1.75} />
                  <span>Streams</span>
                </DM.Item>
              )}
              {active && active.role !== "viewer" && (
                <DM.Item className="menu__item" onSelect={() => useCloud.setState({ importOpen: true })}>
                  <Copy strokeWidth={1.75} />
                  <span>Copy offline data here</span>
                </DM.Item>
              )}
              {active && (
                <DM.Item className="menu__item" onSelect={() => void api.cloud.syncNow()}>
                  <RefreshCw strokeWidth={1.75} />
                  <span>Sync now</span>
                </DM.Item>
              )}
              <DM.Separator className="menu__sep" />
              <DM.Item className="menu__item" onSelect={() => navigate({ name: "settings", section: "cloud" })}>
                <Cog strokeWidth={1.75} />
                <span>Account &amp; Cloud settings</span>
              </DM.Item>
              <DM.Item className="menu__item" onSelect={() => void signOut()}>
                <LogOut strokeWidth={1.75} />
                <span>Sign out</span>
              </DM.Item>
            </>
          )}
          {signedIn && !enabled && (
            <div className="space-menu__note">
              <CloudOff size={12} /> Online collaboration is off. Your account stays signed in.
            </div>
          )}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
