/**
 * @Author Christian Relf
 * @Date 2026-10-23
 */

import { describe, expect, it } from "vitest";
import type { McpAuditEntry, McpClient, McpServer } from "@/lib/types";
import {
  activitySummary,
  argsFromText,
  arrivals,
  clientSummary,
  draftFromPreset,
  draftFromServer,
  envFromRows,
  envToRows,
  projectsLabel,
  serverInput,
  serverProblem,
  serverSummary,
  withFolders,
} from "./mcpForm";

const ago = (ms: number) => `@${ms}`;

const client = (over: Partial<McpClient> = {}): McpClient => ({
  id: "c1",
  name: "Claude Desktop",
  status: "approved",
  scope: "read",
  projects: [],
  createdAt: 100,
  approvedAt: 200,
  lastSeenAt: null,
  ...over,
});

const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: "s1",
  name: "Files",
  slug: "files",
  command: "npx",
  args: ["-y", "pkg"],
  env: {},
  cwd: null,
  enabled: false,
  tools: [],
  status: "unknown",
  statusDetail: null,
  lastCheckedAt: null,
  createdAt: 1,
  connected: false,
  ...over,
});

const audit = (over: Partial<McpAuditEntry> = {}): McpAuditEntry => ({
  id: 1,
  clientId: "c1",
  clientName: "Claude Desktop",
  tool: "kern_task_create",
  detail: "3 tasks",
  ok: true,
  message: null,
  createdAt: 0,
  revertable: false,
  revertedAt: null,
  ...over,
});

describe("server presets", () => {
  it("uses the .cmd shim for Node launchers on Windows only", () => {
    expect(draftFromPreset("memory", "windows").command).toBe("npx.cmd");
    expect(draftFromPreset("memory", "other").command).toBe("npx");
    expect(draftFromPreset("fetch", "windows").command).toBe("uvx");
  });

  it("writes chosen folders into the arguments", () => {
    const d = withFolders(draftFromPreset("filesystem", "other"), ["/a", "/b c"], "other");
    expect(argsFromText(d.args)).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/a", "/b c"]);
    const git = withFolders(draftFromPreset("git", "other"), ["/repo"], "other");
    expect(argsFromText(git.args)).toEqual(["mcp-server-git", "--repository", "/repo"]);
  });

  it("leaves a hand-edited command alone when folders change", () => {
    const d = { ...draftFromPreset("filesystem", "other"), command: "my-fs", args: "--root\n/x", edited: true };
    const after = withFolders(d, ["/y"], "other");
    expect(after.command).toBe("my-fs");
    expect(after.args).toBe("--root\n/x");
    expect(after.folders).toEqual(["/y"]);
  });

  it("names a preset after itself, and leaves a custom one blank", () => {
    expect(draftFromPreset("playwright", "other").name).toBe("Playwright");
    expect(draftFromPreset("custom", "other").name).toBe("");
  });
});

describe("the server form", () => {
  it("round-trips the environment and drops unnamed rows", () => {
    expect(envFromRows(envToRows({ A: "1", B: "two" }))).toEqual({ A: "1", B: "two" });
    expect(envFromRows([{ key: " KEY ", value: "v" }, { key: "", value: "lost" }])).toEqual({ KEY: "v" });
  });

  it("splits arguments one per line, ignoring blank lines", () => {
    expect(argsFromText(" -y \n\n@pkg/server\n  C:\\Users\\me  ")).toEqual(["-y", "@pkg/server", "C:\\Users\\me"]);
  });

  it("says what stops a save, in order", () => {
    const fs = draftFromPreset("filesystem", "other");
    expect(serverProblem({ ...fs, name: " " })).toBe("Give it a name.");
    expect(serverProblem(fs)).toBe("Choose at least one folder.");
    expect(serverProblem(draftFromPreset("git", "other"))).toBe("Choose the repository.");
    expect(serverProblem(withFolders(fs, ["/a"], "other"))).toBeNull();
    const custom = { ...draftFromPreset("custom", "other"), name: "Mine" };
    expect(serverProblem(custom)).toBe("Say which command starts it.");
    const cmd = { ...custom, command: "srv" };
    expect(serverProblem({ ...cmd, env: [{ key: "1BAD", value: "" }] })).toBe("“1BAD” isn't a valid variable name.");
    expect(serverProblem({ ...cmd, env: [{ key: "A", value: "1" }, { key: "A", value: "2" }] })).toBe("A is set twice.");
  });

  it("edits a saved server as typed, with no preset rewriting it", () => {
    const d = draftFromServer(server({ cwd: "/w", env: { K: "v" } }));
    expect(d.edited).toBe(true);
    expect(serverInput(d)).toEqual({ name: "Files", command: "npx", args: ["-y", "pkg"], env: { K: "v" }, cwd: "/w" });
    expect(serverInput({ ...d, cwd: "  " }).cwd).toBeNull();
  });
});

describe("summaries", () => {
  it("describes an assistant by what it may do", () => {
    expect(clientSummary(client({ scope: "write", projects: ["a", "b"], lastSeenAt: 5 }), ago)).toBe("Read and write · 2 projects · used @5");
    expect(clientSummary(client(), ago)).toBe("Read only · All projects · not used yet");
    expect(clientSummary(client({ status: "pending", createdAt: 9 }), ago)).toBe("Asked to connect @9");
    expect(projectsLabel(["x"])).toBe("1 project");
  });

  it("counts the last day's calls and what can still be put back", () => {
    const now = 10 * 86_400_000;
    expect(activitySummary([], now, ago)).toMatch(/^Nothing yet/);
    const rows = [audit({ createdAt: now - 1000, revertable: true }), audit({ createdAt: now - 2000, revertable: true, revertedAt: now }), audit({ createdAt: now - 3 * 86_400_000 })];
    expect(activitySummary(rows, now, ago)).toBe("2 calls in the last day · 1 can be put back");
    expect(activitySummary([audit({ createdAt: 7 })], now, ago)).toBe("Last call @7");
  });

  it("describes a server by whether it starts", () => {
    expect(serverSummary(server(), ago)).toBe("Not tested yet");
    expect(serverSummary(server({ status: "error", statusDetail: "not found" }), ago)).toBe("Wouldn't start - not found");
    const tools = [{ name: "a", description: "", schema: null }];
    expect(serverSummary(server({ connected: true, tools }), ago)).toBe("Running · 1 tool");
    expect(serverSummary(server({ lastCheckedAt: 3, tools }), ago)).toBe("1 tool · tested @3");
  });
});

describe("arrivals", () => {
  it("waits for anything pending, and anything approved that connected since", () => {
    const list = [
      client({ id: "old", lastSeenAt: 50 }),
      client({ id: "back", lastSeenAt: 500 }),
      client({ id: "new", status: "pending", createdAt: 400 }),
      client({ id: "blocked", status: "revoked", lastSeenAt: 900 }),
    ];
    expect(arrivals(list, 300).map((c) => c.id)).toEqual(["back", "new"]);
  });
});
