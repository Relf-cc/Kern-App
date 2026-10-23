/**
 * @Author Christian Relf
 * @Date 2026-10-18
 */

// The cases live in mermaid.cases.json because there are two implementations
// of this parser: this one, and src-tauri/src/domain/mcp/mermaid.rs, which an
// assistant calls through MCP. Both test suites read that file, so neither can
// quietly drift. Add a case there, not here; what stays here is the handful of
// checks whose shape doesn't travel as JSON.

import { describe, expect, it } from "vitest";
import cases from "./mermaid.cases.json";
import { chartToScene, layoutChart, parseMermaid, toMermaid, type MermaidChart } from "./mermaid";
import type { ShapeKind, WbEdge, WbEdgeData, WbNode, WbNodeType } from "./model";

interface SharedCases {
  parse: {
    name: string;
    text: string;
    direction: MermaidChart["direction"];
    nodes: { key: string; label: string; shape: ShapeKind }[];
    edges: { from: string; to: string; label: string | null; line: string; arrow: boolean; both: boolean }[];
  }[];
  errors: { name: string; text: string; error: string }[];
  toMermaid: {
    name: string;
    direction?: MermaidChart["direction"];
    nodes: { id: string; type: WbNodeType; y: number; data: Record<string, unknown> }[];
    edges: { id: string; source: string; target: string; data: WbEdgeData }[];
    text: string;
    included: number;
    skipped: number;
  }[];
  roundTrip: { name: string; text: string; nodes: { label: string; shape: ShapeKind }[]; edges: { label: string | null }[] }[];
}

const shared = cases as unknown as SharedCases;

const chart = (text: string): MermaidChart => {
  const r = parseMermaid(text);
  if ("error" in r) throw new Error(r.error);
  return r;
};

const ids = () => {
  let n = 0;
  let e = 0;
  return { node: () => `n${++n}`, edge: () => `e${++e}` };
};

/** A fixture scene as whiteboard objects: only y matters to the export. */
const sceneOf = (c: SharedCases["toMermaid"][number]): { nodes: WbNode[]; edges: WbEdge[] } => ({
  nodes: c.nodes.map((n) => ({ id: n.id, type: n.type, position: { x: 0, y: n.y }, width: 190, height: 84, data: n.data }) as WbNode),
  edges: c.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: "wb", data: e.data })),
});

describe("the shared cases", () => {
  it.each(shared.parse.map((c) => [c.name, c] as const))("parses: %s", (_name, c) => {
    const got = chart(c.text);
    expect(got.direction).toBe(c.direction);
    expect(got.nodes.map((n) => [n.key, n.label, n.shape])).toEqual(c.nodes.map((n) => [n.key, n.label, n.shape]));
    expect(got.edges.map((e) => [e.from, e.to, e.label ?? null, e.line, e.arrow, !!e.both])).toEqual(
      c.edges.map((e) => [e.from, e.to, e.label, e.line, e.arrow, e.both]),
    );
  });

  it.each(shared.errors.map((c) => [c.name, c] as const))("explains instead of throwing: %s", (_name, c) => {
    expect(parseMermaid(c.text)).toEqual({ error: c.error });
  });

  it.each(shared.toMermaid.map((c) => [c.name, c] as const))("writes back: %s", (_name, c) => {
    const { nodes, edges } = sceneOf(c);
    const out = toMermaid(nodes, edges, c.direction ?? "TB");
    expect(out.text).toBe(c.text);
    expect([out.included, out.skipped]).toEqual([c.included, c.skipped]);
  });

  it.each(shared.roundTrip.map((c) => [c.name, c] as const))("survives a round trip: %s", (_name, c) => {
    const scene = chartToScene(chart(c.text), { x: 0, y: 0 }, ids());
    const again = chart(toMermaid(scene.nodes, scene.edges).text);
    expect(again.nodes.map((n) => [n.label, n.shape])).toEqual(c.nodes.map((n) => [n.label, n.shape]));
    expect(again.edges.map((e) => e.label ?? null)).toEqual(c.edges.map((e) => e.label));
  });
});

describe("layoutChart", () => {
  it("ranks a chain down the board and centres each rank", () => {
    const pos = layoutChart(chart("flowchart TD\n A --> B\n A --> C"));
    const a = pos.get("A")!;
    const b = pos.get("B")!;
    const c = pos.get("C")!;
    expect(b.y).toBeGreaterThan(a.y);
    expect(c.y).toBe(b.y);
    expect(b.x).toBeLessThan(c.x);
    // A sits halfway between its two children.
    expect(a.x + a.w / 2).toBeCloseTo((b.x + b.w / 2 + c.x + c.w / 2) / 2);
  });

  it("lays LR out across instead of down", () => {
    const pos = layoutChart(chart("flowchart LR\n A --> B"));
    expect(pos.get("B")!.x).toBeGreaterThan(pos.get("A")!.x);
    expect(pos.get("B")!.y).toBe(pos.get("A")!.y);
  });

  it("puts a BT chart's first node at the bottom", () => {
    const pos = layoutChart(chart("flowchart BT\n A --> B"));
    expect(pos.get("A")!.y).toBeGreaterThan(pos.get("B")!.y);
  });

  it("places every node of a cycle exactly once", () => {
    const pos = layoutChart(chart("flowchart TD\n A --> B --> C --> A"));
    expect([...pos.keys()].sort()).toEqual(["A", "B", "C"]);
  });
});

describe("chartToScene", () => {
  it("builds shapes and connectors around an origin", () => {
    const { nodes, edges } = chartToScene(chart("flowchart TD\n A{Ok?} -->|Yes| B([Done])"), { x: 100, y: 50 }, ids());
    expect(nodes.map((n) => [n.type, n.data.shape, n.data.label])).toEqual([
      ["shape", "diamond", "Ok?"],
      ["shape", "stadium", "Done"],
    ]);
    expect(nodes.every((n) => n.position.x >= 100 && n.position.y >= 50)).toBe(true);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "n1", target: "n2", type: "wb" });
    expect(edges[0].data).toMatchObject({ auto: true, directed: true, label: "Yes" });
  });

  it("drops a connector that would point at itself", () => {
    const { edges } = chartToScene(chart("flowchart TD\n A --> A\n A --> B"), { x: 0, y: 0 }, ids());
    expect(edges).toHaveLength(1);
  });
});
