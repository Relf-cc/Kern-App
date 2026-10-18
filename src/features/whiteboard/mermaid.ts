/**
 * @Author Christian Relf
 * @Date 2026-10-18
 */

// Mermaid flowcharts in and out of a whiteboard.
//
// Mermaid is how flowcharts travel: it is what a README, a ticket or another
// AI hands you. Pasting one here turns it into ordinary Kern objects you can
// move and edit, and a board of shapes and connectors comes back out as text
// anyone else can read.
//
// Only `flowchart` / `graph` is covered - the one diagram a whiteboard is the
// right home for. Anything else is reported rather than half-imported.
//
// Pure functions only: the parser and the layout are tested in
// mermaid.test.ts, and nothing here touches React, the canvas or the backend.

import type { ShapeKind, WbEdge, WbEdgeData, WbNode } from "./model";

export type FlowDirection = "TB" | "BT" | "LR" | "RL";

/** A node as Mermaid describes it, before it has a position. */
export interface MermaidNode {
  key: string;
  label: string;
  shape: ShapeKind;
}

export interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
  line: "solid" | "dashed" | "thick";
  arrow: boolean;
  /** `<-->`: an arrowhead at each end. */
  both?: boolean;
}

export interface MermaidChart {
  direction: FlowDirection;
  nodes: MermaidNode[];
  edges: MermaidEdge[];
}

// ------------------------------------------------------------------ parsing

/**
 * Mermaid's node brackets, longest first so `[[x]]` is never read as `[x]`.
 * Each entry is an opening bracket, its closing bracket and the shape it
 * means on a Kern board.
 */
const BRACKETS: { open: string; close: string; shape: ShapeKind }[] = [
  { open: "([", close: "])", shape: "stadium" },
  { open: "[(", close: ")]", shape: "cylinder" },
  { open: "[[", close: "]]", shape: "rect" },
  { open: "((", close: "))", shape: "circle" },
  { open: "{{", close: "}}", shape: "hexagon" },
  { open: "[/", close: "/]", shape: "parallelogram" },
  { open: "[\\", close: "\\]", shape: "parallelogram" },
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "rounded" },
  { open: "{", close: "}", shape: "diamond" },
  { open: ">", close: "]", shape: "document" },
];

const DIRECTIONS: Record<string, FlowDirection> = { TB: "TB", TD: "TB", BT: "BT", LR: "LR", RL: "RL" };

/** Arrow forms, longest first so `-.->` is not read as `-.-`. */
const ARROWS: { text: string; line: MermaidEdge["line"]; arrow: boolean }[] = [
  { text: "-.->", line: "dashed", arrow: true },
  { text: "==>", line: "thick", arrow: true },
  { text: "-->", line: "solid", arrow: true },
  { text: "-.-", line: "dashed", arrow: false },
  { text: "===", line: "thick", arrow: false },
  { text: "---", line: "solid", arrow: false },
  { text: "--", line: "solid", arrow: false },
];

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/s, "$1").replace(/<br\s*\/?>/gi, "\n").trim();

/** Strips comments, the opening declaration and anything we cannot read. */
function usefulLines(text: string): { direction: FlowDirection; lines: string[] } | string {
  const raw = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/%%.*$/, "").trim())
    .filter(Boolean);
  if (!raw.length) return "There is nothing to import.";
  const head = raw[0];
  const m = /^(flowchart|graph)(?:\s+([A-Za-z]{2}))?$/.exec(head);
  if (!m) {
    const kind = /^(\w+)/.exec(head)?.[1];
    return kind && kind !== "flowchart" && kind !== "graph"
      ? `Kern imports Mermaid flowcharts; this is a ${kind} diagram.`
      : "This doesn't start with “flowchart” or “graph”.";
  }
  return { direction: DIRECTIONS[(m[2] ?? "TD").toUpperCase()] ?? "TB", lines: raw.slice(1) };
}

/** Reads one `KEY[Label]` term, returning the node and what came after it. */
function readTerm(s: string): { node: MermaidNode; rest: string } | null {
  const key = /^([A-Za-z0-9_\-.]+)/.exec(s.trimStart());
  if (!key) return null;
  let rest = s.trimStart().slice(key[1].length);
  for (const b of BRACKETS) {
    if (!rest.startsWith(b.open)) continue;
    const end = rest.indexOf(b.close, b.open.length);
    if (end < 0) continue;
    const label = unquote(rest.slice(b.open.length, end));
    return { node: { key: key[1], label: label || key[1], shape: b.shape }, rest: rest.slice(end + b.close.length) };
  }
  return { node: { key: key[1], label: key[1], shape: "rect" }, rest };
}

/** Reads one arrow, with either `|label|` or an inline `-- label -->` form. */
function readArrow(s: string): { edge: Omit<MermaidEdge, "from" | "to">; rest: string } | null {
  const t = s.trimStart();
  // `-- label -->` and `-. label .->`: the text sits inside the arrow.
  const inline = /^(--|-\.|==)\s*([^->|]+?)\s*(-\.->|-->|==>|---|-\.-|===)/.exec(t);
  if (inline) {
    const form = ARROWS.find((a) => a.text === inline[3]);
    return {
      edge: { label: unquote(inline[2]) || undefined, line: inline[1] === "-." ? "dashed" : inline[1] === "==" ? "thick" : (form?.line ?? "solid"), arrow: form?.arrow ?? true },
      rest: t.slice(inline[0].length),
    };
  }
  // `<-->` is the same arrow with a head at each end.
  const both = t.startsWith("<");
  const body = both ? t.slice(1) : t;
  for (const a of ARROWS) {
    if (!body.startsWith(a.text)) continue;
    let rest = body.slice(a.text.length);
    let label: string | undefined;
    const piped = /^\s*\|([^|]*)\|/.exec(rest);
    if (piped) {
      label = unquote(piped[1]) || undefined;
      rest = rest.slice(piped[0].length);
    }
    return { edge: { label, line: a.line, arrow: a.arrow || both, both: both || undefined }, rest };
  }
  return null;
}

/**
 * Parses Mermaid flowchart text. Returns the chart, or a sentence explaining
 * what stopped it - never throws, because this runs on whatever was pasted.
 */
export function parseMermaid(text: string): MermaidChart | { error: string } {
  const head = usefulLines(text);
  if (typeof head === "string") return { error: head };

  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];

  /** A later, richer mention of a key wins: `A` then `A[Start]` keeps the label. */
  const note = (n: MermaidNode) => {
    const seen = nodes.get(n.key);
    if (!seen || (seen.label === seen.key && n.label !== n.key)) nodes.set(n.key, n);
    else if (seen.shape === "rect" && n.shape !== "rect") nodes.set(n.key, { ...seen, shape: n.shape });
  };

  for (const line of head.lines) {
    if (/^(subgraph|end|click|style|classDef|class|linkStyle|direction)\b/.test(line)) continue;
    let rest = line;
    let left = readTerm(rest);
    if (!left) continue;
    note(left.node);
    rest = left.rest;
    // `A --> B --> C` and `A --> B & C` both chain from the term just read.
    for (;;) {
      const arrow = readArrow(rest);
      if (!arrow) break;
      rest = arrow.rest;
      const targets: MermaidNode[] = [];
      for (;;) {
        const right = readTerm(rest);
        if (!right) break;
        note(right.node);
        targets.push(right.node);
        rest = right.rest;
        const amp = /^\s*&/.exec(rest);
        if (!amp) break;
        rest = rest.slice(amp[0].length);
      }
      if (!targets.length) break;
      for (const t of targets) edges.push({ from: left.node.key, to: t.key, ...arrow.edge });
      left = { node: targets[targets.length - 1], rest };
    }
  }

  if (!nodes.size) return { error: "No boxes or arrows were found." };
  return { direction: head.direction, nodes: [...nodes.values()], edges };
}

// ------------------------------------------------------------------- layout

/** Box size and spacing used when a chart is laid out from scratch. */
const BOX = { w: 190, h: 84 };
const GAP = { along: 74, across: 46 };

/**
 * Ranks nodes by how far they are from a root, then spreads each rank across
 * the other axis. Cheap, stable and good enough that the first thing you see
 * is a readable diagram you can then nudge.
 */
export function layoutChart(chart: MermaidChart): Map<string, { x: number; y: number; w: number; h: number }> {
  const keys = chart.nodes.map((n) => n.key);
  const out = new Map<string, number[]>(keys.map((k) => [k, []]));
  const incoming = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const e of chart.edges) {
    if (!out.has(e.from) || !out.has(e.to) || e.from === e.to) continue;
    out.get(e.from)!.push(keys.indexOf(e.to));
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  }

  // Breadth-first from every root (and then anything a cycle left behind).
  const rank = new Map<string, number>();
  const queue = keys.filter((k) => !incoming.get(k));
  for (const k of queue) rank.set(k, 0);
  // The cap stops a cycle from re-ranking forever; a dense cycle just ends
  // up on fewer ranks, which still draws.
  for (let i = 0; i < queue.length && i < 20_000; i++) {
    const k = queue[i];
    for (const ti of out.get(k)!) {
      const t = keys[ti];
      const next = rank.get(k)! + 1;
      if (rank.has(t) && rank.get(t)! >= next) continue;
      rank.set(t, next);
      queue.push(t);
    }
  }
  for (const k of keys) if (!rank.has(k)) rank.set(k, 0);

  // Order within a rank follows the order the chart mentioned them.
  const rows = new Map<number, string[]>();
  for (const k of keys) {
    const r = rank.get(k)!;
    (rows.get(r) ?? rows.set(r, []).get(r)!).push(k);
  }

  const vertical = chart.direction === "TB" || chart.direction === "BT";
  const flip = chart.direction === "BT" || chart.direction === "RL";
  const ranks = [...rows.keys()].sort((a, b) => a - b);
  const widest = Math.max(...ranks.map((r) => rows.get(r)!.length));

  const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const r of ranks) {
    const row = rows.get(r)!;
    const step = vertical ? BOX.w + GAP.across : BOX.h + GAP.across;
    const span = row.length * step - GAP.across;
    const full = widest * step - GAP.across;
    const start = (full - span) / 2;
    const depth = (flip ? ranks.length - 1 - r : r) * (vertical ? BOX.h + GAP.along : BOX.w + GAP.along);
    row.forEach((k, i) => {
      const across = start + i * step;
      pos.set(k, vertical ? { x: across, y: depth, ...BOX } : { x: depth, y: across, ...BOX });
    });
  }
  return pos;
}

// --------------------------------------------------------------- to objects

/**
 * Turns a parsed chart into whiteboard objects, laid out around `origin`.
 * `makeId` keeps id generation out of here so this stays testable.
 */
export function chartToScene(
  chart: MermaidChart,
  origin: { x: number; y: number },
  makeId: { node: () => string; edge: () => string },
  edgeBase: WbEdgeData = {},
): { nodes: WbNode[]; edges: WbEdge[] } {
  const pos = layoutChart(chart);
  const ids = new Map<string, string>();
  const nodes: WbNode[] = chart.nodes.map((n) => {
    const id = makeId.node();
    ids.set(n.key, id);
    const p = pos.get(n.key) ?? { x: 0, y: 0, ...BOX };
    return {
      id,
      type: "shape" as const,
      position: { x: origin.x + p.x, y: origin.y + p.y },
      width: p.w,
      height: p.h,
      data: { shape: n.shape, label: n.label, fill: true },
      zIndex: 0,
    };
  });
  const edges: WbEdge[] = chart.edges.flatMap((e) => {
    const source = ids.get(e.from);
    const target = ids.get(e.to);
    if (!source || !target || source === target) return [];
    return [
      {
        id: makeId.edge(),
        source,
        target,
        type: "wb",
        data: { ...edgeBase, auto: true, directed: e.arrow, both: e.both, line: e.line === "dashed" ? "dashed" : "solid", label: e.label },
      },
    ];
  });
  return { nodes, edges };
}

// ----------------------------------------------------------------- to text

/** Mermaid's brackets for each shape we draw. */
const SHAPE_BRACKETS: Record<ShapeKind, [string, string]> = {
  rect: ["[", "]"],
  rounded: ["(", ")"],
  circle: ["((", "))"],
  stadium: ["([", "])"],
  diamond: ["{", "}"],
  parallelogram: ["[/", "/]"],
  hexagon: ["{{", "}}"],
  cylinder: ["[(", ")]"],
  document: ["[", "]"],
  // Standalone lines and arrows are decoration, not boxes; see below.
  line: ["[", "]"],
  arrow: ["[", "]"],
};

/** Mermaid keys are bare words, so A, B, … C1, C2 … keep it readable. */
function mermaidKey(i: number): string {
  const letter = String.fromCharCode(65 + (i % 26));
  return i < 26 ? letter : `${letter}${Math.floor(i / 26)}`;
}

const escapeLabel = (s: string) => `"${s.replace(/\n/g, "<br/>").replace(/"/g, "&quot;")}"`;

/**
 * The board as Mermaid. Only objects that can be a flowchart box come along -
 * shapes, sticky notes, text and task cards - plus the connectors between
 * them; drawings, images and loose lines have no Mermaid equivalent and are
 * reported as left behind so nobody thinks they were exported.
 */
export function toMermaid(nodes: WbNode[], edges: WbEdge[], direction: FlowDirection = "TB"): { text: string; included: number; skipped: number } {
  const boxy = nodes.filter((n) => (n.type === "shape" && n.data.shape !== "line" && n.data.shape !== "arrow") || n.type === "sticky" || n.type === "text" || n.type === "task");
  // Reading order: down the board, then across.
  const ordered = [...boxy].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  const keys = new Map<string, string>();
  ordered.forEach((n, i) => keys.set(n.id, mermaidKey(i)));

  const labelOf = (n: WbNode) => (n.data.label ?? n.data.title ?? n.data.text ?? "").trim() || "Untitled";
  const lines = [`flowchart ${direction}`];
  for (const n of ordered) {
    const [open, close] = SHAPE_BRACKETS[(n.type === "shape" ? n.data.shape : undefined) ?? "rect"];
    lines.push(`  ${keys.get(n.id)}${open}${escapeLabel(labelOf(n))}${close}`);
  }
  for (const e of edges) {
    const a = keys.get(e.source);
    const b = keys.get(e.target);
    if (!a || !b) continue;
    const dashed = e.data?.line === "dashed" || e.data?.line === "dotted";
    const head = e.data?.directed !== false;
    const arrow = `${e.data?.both ? "<" : ""}${head ? (dashed ? "-.->" : "-->") : dashed ? "-.-" : "---"}`;
    const label = e.data?.label?.trim();
    lines.push(`  ${a} ${arrow}${label ? `|${escapeLabel(label)}|` : ""} ${b}`);
  }
  return { text: `${lines.join("\n")}\n`, included: ordered.length, skipped: nodes.length - ordered.length };
}
