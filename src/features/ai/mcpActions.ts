/**
 * @Author Christian Relf
 * @Date 2026-10-23
 */

// The writes behind Settings → Assistants, shared by its rows and its
// dialogs. Every one reports failure through describeError and refreshes the
// "mcp" domain whichever way it went, because the backend is the only thing
// that knows what state a listener or a child process actually ended up in.

import type { McpClient, McpServer } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { confirm } from "@/components/ui/Dialog";
import { setSetting } from "@/stores/settings";
import { toast, toastError } from "@/stores/toast";

export async function patchClient(c: McpClient, p: Parameters<typeof api.mcp.updateClient>[1]): Promise<boolean> {
  try {
    await api.mcp.updateClient(c.id, p);
    return true;
  } catch (e) {
    toastError(describeError(e, `Couldn't change ${c.name}.`));
    return false;
  } finally {
    invalidate("mcp");
  }
}

export async function forgetClient(c: McpClient): Promise<boolean> {
  const ok = await confirm({
    title: `Forget ${c.name}?`,
    message: "Its approval and its activity here are deleted. If it connects again it has to be approved afresh.",
    confirmLabel: "Forget assistant",
    danger: true,
  });
  if (!ok) return false;
  try {
    await api.mcp.removeClient(c.id);
    toast(`Forgot ${c.name}`);
    return true;
  } catch (e) {
    toastError(describeError(e));
    return false;
  } finally {
    invalidate("mcp");
  }
}

/**
 * The listener follows the setting, so this writes the setting and then asks
 * the backend to catch up - the state is never written in two places.
 */
export async function setConnection(on: boolean): Promise<boolean> {
  try {
    await setSetting("mcp.enabled", on);
    await api.mcp.sync();
    return true;
  } catch (e) {
    toastError(describeError(e, "Couldn't change the assistant connection."));
    return false;
  } finally {
    invalidate("mcp");
  }
}

/** The same for the HTTP endpoint, which has a switch of its own. */
export async function setHttp(on: boolean, port?: number): Promise<boolean> {
  try {
    if (port !== undefined) await setSetting("mcp.httpPort", port);
    await setSetting("mcp.httpEnabled", on);
    await api.mcp.sync();
    return true;
  } catch (e) {
    toastError(describeError(e, "Couldn't change the local address."));
    return false;
  } finally {
    invalidate("mcp");
  }
}

export async function revertCall(id: number, clientName: string): Promise<boolean> {
  const ok = await confirm({
    title: "Put this back?",
    message: `Everything ${clientName} changed in this one call is undone - anything it created goes to Trash, anything it overwrote goes back as it was. Changes made since, by you or anything else, are overwritten.`,
    confirmLabel: "Revert this call",
  });
  if (!ok) return false;
  try {
    toast(await api.mcp.revert(id));
    return true;
  } catch (e) {
    toastError(describeError(e, "Couldn't put that back."));
    return false;
  } finally {
    invalidate("mcp");
  }
}

/** Kern's AI features may use added servers only while this is on. */
export async function setServersAllowed(on: boolean) {
  await setSetting("mcp.toolsEnabled", on);
  if (!on) await api.mcp.serversDisconnect().catch(() => undefined);
  invalidate("mcp");
}

export async function setServerEnabled(s: McpServer, enabled: boolean) {
  try {
    await api.mcp.serverUpdate(s.id, { enabled });
  } catch (e) {
    toastError(describeError(e, `Couldn't change ${s.name}.`));
  } finally {
    invalidate("mcp");
  }
}

export async function testServer(s: McpServer) {
  try {
    const after = await api.mcp.serverTest(s.id);
    toast(`${after.name} started and offered ${after.tools.length} tool${after.tools.length === 1 ? "" : "s"}`);
  } catch (e) {
    toastError(describeError(e, `${s.name} didn't start.`));
  } finally {
    invalidate("mcp");
  }
}

export async function removeServer(s: McpServer) {
  const ok = await confirm({
    title: `Remove ${s.name}?`,
    message: "Kern forgets the command and what it offered. The program itself is left alone.",
    confirmLabel: "Remove server",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.mcp.serverRemove(s.id);
    toast(`Removed ${s.name}`);
  } catch (e) {
    toastError(describeError(e));
  } finally {
    invalidate("mcp");
  }
}

/** What Kern promises about an assistant, said once and the same everywhere. */
export const GUARANTEES = [
  "Nothing listens until you turn it on, and nothing connects until you approve it by name.",
  "The connection is a local pipe only your user account can open - no port, no token, nothing on the network.",
  "Each assistant is read-only until you give it write access, and can be held to the projects you choose.",
  "Kern can ask you before anything is written, and every change an assistant makes can be put back in one go.",
  "Projects locked with a passkey stay invisible, as they do everywhere else in Kern.",
  "Deleting through an assistant moves items to Trash; nothing an assistant does destroys data.",
  "Linked folders, the terminal, environment variables, tokens and your settings are not exposed at all.",
  "Every call is listed in Activity with what it touched - arguments are described, never copied.",
  "The HTTP address is separate, off by default, reachable from this computer only, and needs a token no web page can use.",
];
