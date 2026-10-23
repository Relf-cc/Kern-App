/**
 * @Author Christian Relf
 * @Date 2026-10-23
 */

// The pure half of Settings → Assistants: the server presets, the editable
// forms of a server's arguments and environment, and the one-line summaries
// the settings rows show. No React here, so all of it is tested.

import type { McpAuditEntry, McpClient, McpScope, McpServer } from "@/lib/types";

export type Platform = "windows" | "other";

export const currentPlatform = (): Platform => (typeof navigator !== "undefined" && /Win/i.test(navigator.platform) ? "windows" : "other");

/**
 * Node's launchers are `.cmd` shims on Windows, and Kern starts a server's
 * command directly rather than through a shell, so a bare `npx` isn't found
 * there. `uvx` is a real executable everywhere and needs nothing.
 */
export const npx = (p: Platform) => (p === "windows" ? "npx.cmd" : "npx");

// ------------------------------------------------------------ presets

export type PresetId = "filesystem" | "git" | "fetch" | "memory" | "playwright" | "custom";

export interface ServerPreset {
  id: PresetId;
  name: string;
  description: string;
  /** What has to be installed on this computer for it to start. */
  needs: string | null;
  /** Folders it works in, asked for with a folder picker rather than typed. */
  folders?: { label: string; hint: string; max?: number };
  build: (p: Platform, folders: string[]) => { command: string; args: string[] };
}

export const SERVER_PRESETS: ServerPreset[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read, search and write files in the folders you choose, and nowhere else.",
    needs: "Node.js",
    folders: { label: "Folders it may use", hint: "It can read and change anything inside these, and nothing outside them." },
    build: (p, folders) => ({ command: npx(p), args: ["-y", "@modelcontextprotocol/server-filesystem", ...folders] }),
  },
  {
    id: "git",
    name: "Git",
    description: "Read the history, branches and diffs of one repository.",
    needs: "uv",
    folders: { label: "Repository", hint: "The folder that holds the repository's .git.", max: 1 },
    build: (_p, folders) => ({ command: "uvx", args: ["mcp-server-git", "--repository", folders[0] ?? ""] }),
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "Fetch a web page and read it as text.",
    needs: "uv",
    build: () => ({ command: "uvx", args: ["mcp-server-fetch"] }),
  },
  {
    id: "memory",
    name: "Memory",
    description: "A small knowledge graph the model can keep notes in between requests.",
    needs: "Node.js",
    build: (p) => ({ command: npx(p), args: ["-y", "@modelcontextprotocol/server-memory"] }),
  },
  {
    id: "playwright",
    name: "Playwright",
    description: "Drive a real browser: open pages, click, fill in forms, take snapshots.",
    needs: "Node.js",
    build: (p) => ({ command: npx(p), args: ["-y", "@playwright/mcp@latest"] }),
  },
  {
    id: "custom",
    name: "Something else",
    description: "Any program that speaks MCP over its input and output. You give the command.",
    needs: null,
    build: () => ({ command: "", args: [] }),
  },
];

export const presetById = (id: PresetId) => SERVER_PRESETS.find((p) => p.id === id) ?? SERVER_PRESETS[SERVER_PRESETS.length - 1];

// ------------------------------------------------------------ the server form

/** One argument per line, which is also how a command's own help prints them. */
export const argsToText = (args: string[]) => args.join("\n");
export const argsFromText = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export interface EnvRow {
  key: string;
  value: string;
}

export const envToRows = (env: Record<string, string>): EnvRow[] => Object.entries(env).map(([key, value]) => ({ key, value }));

/** Rows with no name are dropped; a name given twice keeps the last value. */
export const envFromRows = (rows: EnvRow[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (key) out[key] = r.value;
  }
  return out;
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ServerDraft {
  preset: PresetId;
  name: string;
  command: string;
  args: string;
  env: EnvRow[];
  cwd: string;
  folders: string[];
  /** The command or arguments were edited by hand, so the preset no longer writes them. */
  edited: boolean;
}

export function draftFromPreset(id: PresetId, p: Platform): ServerDraft {
  const preset = presetById(id);
  const built = preset.build(p, []);
  return { preset: id, name: id === "custom" ? "" : preset.name, command: built.command, args: argsToText(built.args), env: [], cwd: "", folders: [], edited: false };
}

/** Editing starts from what was saved; the preset no longer applies. */
export function draftFromServer(s: McpServer): ServerDraft {
  return { preset: "custom", name: s.name, command: s.command, args: argsToText(s.args), env: envToRows(s.env), cwd: s.cwd ?? "", folders: [], edited: true };
}

/** A new folder list rewrites the command, unless it was edited by hand. */
export function withFolders(d: ServerDraft, folders: string[], p: Platform): ServerDraft {
  if (d.edited) return { ...d, folders };
  const built = presetById(d.preset).build(p, folders);
  return { ...d, folders, command: built.command, args: argsToText(built.args) };
}

/** What stops the draft being saved, in a sentence; null when it can be. */
export function serverProblem(d: ServerDraft): string | null {
  if (!d.name.trim()) return "Give it a name.";
  const preset = presetById(d.preset);
  if (!d.edited && preset.folders && d.folders.length === 0) return preset.folders.max === 1 ? "Choose the repository." : "Choose at least one folder.";
  if (!d.command.trim()) return "Say which command starts it.";
  const keys = d.env.map((r) => r.key.trim()).filter(Boolean);
  const bad = keys.find((k) => !ENV_NAME.test(k));
  if (bad) return `“${bad}” isn't a valid variable name.`;
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  if (twice) return `${twice} is set twice.`;
  return null;
}

export const serverInput = (d: ServerDraft) => ({
  name: d.name.trim(),
  command: d.command.trim(),
  args: argsFromText(d.args),
  env: envFromRows(d.env),
  cwd: d.cwd.trim() || null,
});

// ------------------------------------------------------------ summaries

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const SCOPE_LABEL: Record<McpScope, string> = { read: "Read only", write: "Read and write" };

export const STATUS_LABEL: Record<McpClient["status"], string> = { pending: "Waiting for approval", approved: "Connected", revoked: "Blocked" };

export const projectsLabel = (ids: string[]) => (ids.length === 0 ? "All projects" : plural(ids.length, "project"));

/** "Read and write · 3 projects · used 2h ago". `ago` formats a timestamp. */
export function clientSummary(c: McpClient, ago: (ms: number) => string): string {
  if (c.status === "pending") return `Asked to connect ${ago(c.createdAt)}`;
  const parts = [SCOPE_LABEL[c.scope], projectsLabel(c.projects)];
  parts.push(c.lastSeenAt ? `used ${ago(c.lastSeenAt)}` : "not used yet");
  return parts.join(" · ");
}

/** "12 calls in the last day · 3 can be put back", over audit rows newest first. */
export function activitySummary(rows: McpAuditEntry[], now: number, ago: (ms: number) => string): string {
  if (rows.length === 0) return "Nothing yet. Every call an assistant makes is listed, with a way to put its changes back.";
  const day = rows.filter((r) => now - r.createdAt < 86_400_000).length;
  const back = rows.filter((r) => r.revertable && !r.revertedAt).length;
  const parts = [day ? `${plural(day, "call")} in the last day` : `Last call ${ago(rows[0].createdAt)}`];
  if (back) parts.push(`${back} can be put back`);
  return parts.join(" · ");
}

export function serverSummary(s: McpServer, ago: (ms: number) => string): string {
  if (s.status === "error") return `Wouldn't start${s.statusDetail ? ` - ${s.statusDetail}` : ""}`;
  const tools = s.tools.length ? plural(s.tools.length, "tool") : null;
  if (s.connected) return ["Running", tools].filter(Boolean).join(" · ");
  if (s.lastCheckedAt) return [tools ?? "No tools", `tested ${ago(s.lastCheckedAt)}`].join(" · ");
  return "Not tested yet";
}

/**
 * Who the connect flow is waiting for: anything still asking to connect, and
 * anything approved earlier that has connected since the flow opened (set up
 * again on a new install, say). Newest first.
 */
export function arrivals(clients: McpClient[], since: number): McpClient[] {
  return clients
    .filter((c) => c.status === "pending" || (c.status === "approved" && (c.lastSeenAt ?? 0) >= since))
    .sort((a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt));
}
