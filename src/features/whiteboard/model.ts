/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import type { Edge, Node } from "@xyflow/react";
import type { WbEdgeRecord, WbNodeRecord } from "@/lib/types";
import { getSetting } from "@/stores/settings";

export type WbNodeType =
  | "text"
  | "sticky"
  | "task"
  | "image"
  | "shape"
  | "area"
  | "link"
  | "file"
  | "project"
  | "board"
  | "note"
  | "milestone"
  | "draw";

/**
 * Shapes the shape tool can draw. The first five are the general-purpose
 * ones; the rest are the standard flowchart vocabulary, so a diagram drawn
 * here reads the same as one drawn anywhere else.
 */
export type ShapeKind =
  | "rect"
  | "rounded"
  | "circle"
  | "line"
  | "arrow"
  | "stadium"
  | "diamond"
  | "parallelogram"
  | "hexagon"
  | "cylinder"
  | "document";

/** Shapes that carry a flowchart meaning, drawn with their own proportions. */
export const FLOW_SHAPE_SIZES: Partial<Record<ShapeKind, { w: number; h: number }>> = {
  stadium: { w: 180, h: 64 },
  diamond: { w: 160, h: 120 },
  parallelogram: { w: 190, h: 90 },
  hexagon: { w: 190, h: 90 },
  cylinder: { w: 150, h: 120 },
  document: { w: 180, h: 110 },
};

/** Ink colours, mapped onto the muted series hues so both themes stay legible. */
export type WbColor = "default" | "blue" | "green" | "amber" | "red" | "purple" | "teal";

export const WB_COLORS: { value: WbColor; label: string; css: string }[] = [
  { value: "default", label: "Default", css: "var(--text-2)" },
  { value: "blue", label: "Blue", css: "var(--hue-0)" },
  { value: "green", label: "Green", css: "var(--hue-2)" },
  { value: "amber", label: "Amber", css: "var(--hue-1)" },
  { value: "red", label: "Red", css: "var(--hue-5)" },
  { value: "purple", label: "Purple", css: "var(--hue-3)" },
  { value: "teal", label: "Teal", css: "var(--hue-4)" },
];

export const colorVar = (c: WbColor | undefined, fallback = "var(--text-2)") => (c && c !== "default" ? WB_COLORS.find((x) => x.value === c)?.css ?? fallback : fallback);

/** Node types that take an ink colour. */
export const COLORABLE = new Set<WbNodeType>(["shape", "draw", "area", "text"]);

export interface WbData extends Record<string, unknown> {
  title?: string;
  text?: string;
  label?: string;
  locked?: boolean;
  color?: WbColor;
  // sticky
  tone?: "plain" | "warm" | "cool";
  // shapes
  shape?: ShapeKind;
  flip?: boolean;
  /** Line/arrow: run from the far end back to the start. */
  reverse?: boolean;
  stroke?: "solid" | "dashed";
  fill?: boolean;
  // freehand: flat [x, y, ...] in a vw x vh box; scaled to the node's size
  points?: number[];
  vw?: number;
  vh?: number;
  strokeWidth?: number;
  // area
  areaFill?: "dashed" | "solid";
  // references
  taskId?: string;
  projectId?: string;
  boardId?: string;
  noteId?: string;
  milestoneId?: string;
  url?: string;
  description?: string;
  siteName?: string;
  path?: string;
  name?: string;
  // image (path relative to the attachments dir)
  src?: string;
  /** Kern Cloud: the compressed copy shared with collaborators. */
  cloudAsset?: string;
  aspect?: number;
  /** Transient: start in edit mode after creation. */
  editing?: boolean;
}

export type WbNode = Node<WbData, WbNodeType>;

export interface WbEdgeData extends Record<string, unknown> {
  /**
   * Pick the handles from where the two objects sit, and keep picking as they
   * move. On for connectors drawn from now on; connectors from before it
   * existed keep the sides they were drawn on until this is switched on.
   */
  auto?: boolean;
  directed?: boolean;
  both?: boolean;
  line?: "solid" | "dashed" | "dotted";
  path?: "smooth" | "straight" | "step";
  label?: string;
  color?: WbColor;
}

export type WbEdge = Edge<WbEdgeData>;

const STICKY_SIZES = { s: 160, m: 200, l: 260 };

export const DEFAULT_SIZES: Record<WbNodeType, { w: number; h: number }> = {
  text: { w: 260, h: 140 },
  sticky: { w: 200, h: 200 },
  task: { w: 260, h: 92 },
  image: { w: 320, h: 220 },
  shape: { w: 160, h: 110 },
  area: { w: 520, h: 360 },
  link: { w: 280, h: 96 },
  file: { w: 260, h: 72 },
  project: { w: 260, h: 104 },
  board: { w: 260, h: 84 },
  note: { w: 280, h: 140 },
  milestone: { w: 280, h: 110 },
  draw: { w: 100, h: 100 },
};

export const newNodeId = () => `n_${crypto.randomUUID()}`;
export const newEdgeId = () => `e_${crypto.randomUUID()}`;

export function makeNode(type: WbNodeType, position: { x: number; y: number }, data: Partial<WbData> = {}, size?: { w: number; h: number }): WbNode {
  let s = size ?? DEFAULT_SIZES[type];
  const base: WbData = {};
  if (type === "sticky") {
    const px = STICKY_SIZES[getSetting("wb.stickySize")];
    s = size ?? { w: px, h: px };
    base.tone = getSetting("wb.stickyTone");
  }
  if (type === "shape") {
    base.shape = data.shape ?? "rounded";
    s = size ?? FLOW_SHAPE_SIZES[base.shape] ?? DEFAULT_SIZES.shape;
  }
  if (type === "area") base.label = "Area";
  return {
    id: newNodeId(),
    type,
    position: { x: position.x - s.w / 2, y: position.y - s.h / 2 },
    width: s.w,
    height: s.h,
    data: { ...base, ...data },
    zIndex: type === "area" ? -1 : 0,
  };
}

export function edgeDefaults(): WbEdgeData {
  return { auto: true, directed: getSetting("wb.connectorArrow"), line: "solid", path: getSetting("wb.connectorStyle") };
}

/** Handle ids, matching the four `Handle`s every node renders. */
type Side = "t" | "r" | "b" | "l";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The sides of two boxes that face each other. Whichever axis they are
 * further apart on wins, so a connector leaves and arrives square-on instead
 * of looping around a corner.
 */
export function facingSides(a: Box, b: Box): { source: Side; target: Side } {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  // Overlapping horizontally is a stronger hint than a slightly bigger gap.
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  const horizontal = gapX > gapY || (gapX === gapY && Math.abs(dx) > Math.abs(dy));
  if (horizontal) return dx >= 0 ? { source: "r", target: "l" } : { source: "l", target: "r" };
  return dy >= 0 ? { source: "b", target: "t" } : { source: "t", target: "b" };
}

const boxOf = (n: WbNode, byId: Map<string, WbNode>): Box => {
  const p = absolutePosition(n, byId);
  const { w, h } = sizeOf(n);
  return { x: p.x, y: p.y, w, h };
};

/**
 * Re-points an automatic connector at the sides its two objects now face.
 * Returns the edge untouched when nothing changes, so React Flow keeps
 * skipping edges that have not moved.
 */
export function autoRoute(e: WbEdge, byId: Map<string, WbNode>): WbEdge {
  if (!e.data?.auto) return e;
  const a = byId.get(e.source);
  const b = byId.get(e.target);
  if (!a || !b) return e;
  const { source, target } = facingSides(boxOf(a, byId), boxOf(b, byId));
  if (e.sourceHandle === source && e.targetHandle === target) return e;
  return { ...e, sourceHandle: source, targetHandle: target };
}

/** React Flow requires parents before children. */
export function sortParentsFirst(nodes: WbNode[]): WbNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = (n: WbNode, seen = new Set<string>()): number => {
    if (!n.parentId || seen.has(n.id)) return 0;
    seen.add(n.id);
    const p = byId.get(n.parentId);
    return p ? depth(p, seen) + 1 : 0;
  };
  return [...nodes].sort((a, b) => depth(a) - depth(b));
}

export function fromRecords(nodes: WbNodeRecord[], edges: WbEdgeRecord[]): { nodes: WbNode[]; edges: WbEdge[] } {
  const ids = new Set(nodes.map((n) => n.id));
  const rfNodes: WbNode[] = nodes.map((r) => {
    const data = { ...(r.data as WbData), locked: r.locked };
    delete data.editing;
    return {
      id: r.id,
      type: r.type as WbNodeType,
      position: { x: r.x, y: r.y },
      width: r.width ?? DEFAULT_SIZES[r.type as WbNodeType]?.w ?? 200,
      height: r.height ?? DEFAULT_SIZES[r.type as WbNodeType]?.h ?? 100,
      parentId: r.parentId && ids.has(r.parentId) ? r.parentId : undefined,
      zIndex: r.z,
      draggable: !r.locked,
      deletable: !r.locked,
      data,
    };
  });
  const rfEdges: WbEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
    type: "wb",
    data: e.data as WbEdgeData,
  }));
  return { nodes: sortParentsFirst(rfNodes), edges: rfEdges };
}

export function toRecords(nodes: WbNode[], edges: WbEdge[]): { nodes: WbNodeRecord[]; edges: WbEdgeRecord[] } {
  return {
    nodes: nodes.map((n) => {
      const data = { ...n.data };
      delete data.editing;
      delete data.locked;
      return {
        id: n.id,
        type: n.type ?? "text",
        x: Math.round(n.position.x * 100) / 100,
        y: Math.round(n.position.y * 100) / 100,
        width: Math.round((n.width ?? n.measured?.width ?? 200) * 100) / 100,
        height: Math.round((n.height ?? n.measured?.height ?? 100) * 100) / 100,
        z: n.zIndex ?? 0,
        parentId: n.parentId ?? null,
        locked: !!n.data.locked,
        data,
      };
    }),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      data: e.data ?? {},
    })),
  };
}

/** Absolute position of a node (resolving parent chain). */
export function absolutePosition(n: WbNode, byId: Map<string, WbNode>): { x: number; y: number } {
  let x = n.position.x;
  let y = n.position.y;
  let p = n.parentId ? byId.get(n.parentId) : undefined;
  const seen = new Set<string>();
  while (p && !seen.has(p.id)) {
    seen.add(p.id);
    x += p.position.x;
    y += p.position.y;
    p = p.parentId ? byId.get(p.parentId) : undefined;
  }
  return { x, y };
}

export function sizeOf(n: WbNode) {
  return { w: n.width ?? n.measured?.width ?? 200, h: n.height ?? n.measured?.height ?? 100 };
}

export function isDescendant(nodeId: string, maybeAncestor: string, byId: Map<string, WbNode>): boolean {
  let p = byId.get(nodeId)?.parentId;
  const seen = new Set<string>();
  while (p && !seen.has(p)) {
    if (p === maybeAncestor) return true;
    seen.add(p);
    p = byId.get(p)?.parentId;
  }
  return false;
}
