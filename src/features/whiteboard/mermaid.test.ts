/**
 * @Author Christian Relf
 * @Date 2026-10-18
 */

import { describe, expect, it } from "vitest";
import { chartToScene, layoutChart, parseMermaid, toMermaid, type MermaidChart } from "./mermaid";
import type { WbEdge, WbNode } from "./model";

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

describe("parseMermaid", () => {
  it("reads the direction, labels and shapes", () => {
    const c = chart(`flowchart LR
      A([Start]) --> B{Ready?}
      B --> C[(Store)]
      B --> D[/Report/]
      C --> E((Done))`);
    expect(c.direction).toBe("LR");
    expect(c.nodes.map((n) => [n.key, n.label, n.shape])).toEqual([
      ["A", "Start", "stadium"],
      ["B", "Ready?", "diamond"],
      ["C", "Store", "cylinder"],
      ["D", "Report", "parallelogram"],
      ["E", "Done", "circle"],
    ]);
    expect(c.edges).toHaveLength(4);
  });

  it("treats TD as top-to-bottom and defaults to it", () => {
    expect(chart("flowchart TD\n A --> B").direction).toBe("TB");
    expect(chart("graph\n A --> B").direction).toBe("TB");
    expect(chart("graph BT\n A --> B").direction).toBe("BT");
  });

  it("reads both label forms", () => {
    const c = chart(`flowchart TD
      A{Ok?} -->|Yes| B[Ship]
      A -- No --> C[Stop]`);
    expect(c.edges).toEqual([
      { from: "A", to: "B", label: "Yes", line: "solid", arrow: true, both: undefined },
      { from: "A", to: "C", label: "No", line: "solid", arrow: true },
    ]);
  });

  it("chains and fans out", () => {
    const c = chart("flowchart TD\n A --> B --> C\n A --> D & E");
    expect(c.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["A>B", "B>C", "A>D", "A>E"]);
    expect(c.nodes.map((n) => n.key)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("carries line style and arrowheads", () => {
    const c = chart("flowchart TD\n A -.-> B\n B --- C\n C <--> D\n D ==> E");
    expect(c.edges.map((e) => [e.line, e.arrow, !!e.both])).toEqual([
      ["dashed", true, false],
      ["solid", false, false],
      ["solid", true, true],
      ["thick", true, false],
    ]);
  });

  it("keeps the richest mention of a key", () => {
    const c = chart("flowchart TD\n A --> B\n A[Start] --> C");
    expect(c.nodes.find((n) => n.key === "A")).toEqual({ key: "A", label: "Start", shape: "rect" });
  });

  it("skips directives, comments and subgraph scaffolding", () => {
    const c = chart(`flowchart TD
      %% a comment
      subgraph one
      A --> B
      end
      classDef big fill:#fff
      style A stroke:#000`);
    expect(c.nodes.map((n) => n.key)).toEqual(["A", "B"]);
    expect(c.edges).toHaveLength(1);
  });

  it("quotes and line breaks survive", () => {
    const c = chart('flowchart TD\n A["Pick a<br/>plan"] --> B');
    expect(c.nodes[0].label).toBe("Pick a\nplan");
  });

  it("explains what it cannot read instead of throwing", () => {
    expect(parseMermaid("sequenceDiagram\n A->>B: hi")).toEqual({ error: "Kern imports Mermaid flowcharts; this is a sequenceDiagram diagram." });
    expect(parseMermaid("   ")).toEqual({ error: "There is nothing to import." });
    expect(parseMermaid("flowchart TD")).toEqual({ error: "No boxes or arrows were found." });
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

describe("toMermaid", () => {
  const shape = (id: string, label: string, s: WbNode["data"]["shape"], y: number): WbNode => ({
    id,
    type: "shape",
    position: { x: 0, y },
    width: 190,
    height: 84,
    data: { shape: s, label },
  });

  it("writes boxes in reading order with their brackets", () => {
    const nodes = [shape("b", "Ready?", "diamond", 200), shape("a", "Start", "stadium", 0)];
    const edges: WbEdge[] = [{ id: "e1", source: "a", target: "b", type: "wb", data: { label: "go" } }];
    const { text, included, skipped } = toMermaid(nodes, edges);
    expect(included).toBe(2);
    expect(skipped).toBe(0);
    expect(text).toBe(['flowchart TB', '  A(["Start"])', '  B{"Ready?"}', '  A -->|"go"| B', ''].join("\n"));
  });

  it("writes dashed, headless and two-way connectors", () => {
    const nodes = [shape("a", "A", "rect", 0), shape("b", "B", "rect", 100)];
    const out = (data: WbEdge["data"]) => toMermaid(nodes, [{ id: "e", source: "a", target: "b", type: "wb", data }]).text.split("\n")[3];
    expect(out({ line: "dashed" })).toBe("  A -.-> B");
    expect(out({ directed: false })).toBe("  A --- B");
    expect(out({ directed: false, line: "dotted" })).toBe("  A -.- B");
    expect(out({ both: true })).toBe("  A <--> B");
  });

  it("reports what has no Mermaid equivalent instead of inventing one", () => {
    const nodes: WbNode[] = [
      shape("a", "A", "rect", 0),
      shape("l", "", "arrow", 10),
      { id: "d", type: "draw", position: { x: 0, y: 20 }, width: 100, height: 100, data: { points: [0, 0, 1, 1] } },
    ];
    const { included, skipped, text } = toMermaid(nodes, []);
    expect(included).toBe(1);
    expect(skipped).toBe(2);
    expect(text).toBe('flowchart TB\n  A["A"]\n');
  });

  it("survives a round trip", () => {
    const first = chart("flowchart TD\n A([Start]) -->|Yes| B{Ready?}\n B --> C[(Store)]");
    const scene = chartToScene(first, { x: 0, y: 0 }, ids());
    const again = chart(toMermaid(scene.nodes, scene.edges).text);
    expect(again.nodes.map((n) => [n.label, n.shape])).toEqual([
      ["Start", "stadium"],
      ["Ready?", "diamond"],
      ["Store", "cylinder"],
    ]);
    expect(again.edges.map((e) => e.label)).toEqual(["Yes", undefined]);
  });
});
