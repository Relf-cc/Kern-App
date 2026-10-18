/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// The whiteboard editor: React Flow with custom nodes/edges, tools,
// undo/redo, clipboard, grouping into areas, alignment guides, file drops,
// debounced persistence with explicit flushes, and export. In a cloud space
// it is multiplayer: saves send only what changed, collaborators' saves are
// merged in, and cursors, selections and drags are shared live.

import { takeWhiteboardFocus } from "./focus";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  getNodesBounds,
  getViewportForBounds,
  reconnectEdge,
  useReactFlow,
  useStore,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams,
  type Viewport as RFViewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./whiteboard.css";
import { ContextMenu as CM } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toPng, toSvg } from "html-to-image";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  BringToFront,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Group,
  Lock,
  LockOpen,
  SendToBack,
  Trash,
  Ungroup,
  Pencil,
  Presentation,
  SquareCheckBig,
  StickyNote,
  Type,
  Scan,
  ScanSearch,
} from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import type { Viewport, WhiteboardScene } from "@/lib/types";
import { useSetting, useSettings } from "@/stores/settings";
import { onBeforeNavigate } from "@/stores/router";
import { toast, toastError } from "@/stores/toast";
import { MenuContent, type MenuItems } from "@/components/ui/Menu";
import { EmptyState, Skeleton } from "@/components/ui/Controls";
import { isTextInput } from "@/lib/shortcuts";
import { openTask } from "@/features/tasks/menu";
import { openShare } from "@/features/share/open";
import { NODE_TYPES, WbContext, shapeFigure } from "./nodes";
import { EDGE_TYPES, withMarkers } from "./edges";
import { EdgeApiContext } from "./edgeContext";
import {
  absolutePosition,
  autoRoute,
  colorVar,
  edgeDefaults,
  fromRecords,
  isDescendant,
  makeNode,
  newEdgeId,
  newNodeId,
  sizeOf,
  sortParentsFirst,
  toRecords,
  type WbData,
  type WbEdge,
  type WbEdgeData,
  type WbNode,
  type WbColor,
  type WbNodeType,
} from "./model";
import { Toolbar, TopBar, type ShapeKind, type Tool } from "./Toolbar";
import { PropsPanel } from "./PropsPanel";
import { MermaidDialog } from "./MermaidDialog";
import { chartToScene, toMermaid, type MermaidChart } from "./mermaid";
import { inkHit, inkPath, makeDrawing } from "./ink";
import { baselineOf, commit as commitBaseline, diff as diffScene, isEmpty, merge as mergeScene } from "./collab";
import { onEphemeral, sendEphemeral, setPresence } from "@/features/cloud/realtime";
import { onWhiteboardChanges } from "@/features/cloud/actions";
import { useCloud, useReadOnly } from "@/features/cloud/store";
import { PeerStack, WhiteboardPresence } from "@/features/cloud/Presence";
import { shareImage } from "./cloudImages";

interface Snap {
  nodes: WbNode[];
  edges: WbEdge[];
}

type Pt = { x: number; y: number };

/** In-progress gesture on the drawing layer, in flow coordinates. */
type Draft = { kind: "ink"; points: number[] } | { kind: "box"; a: Pt; b: Pt };

const CLIP_PREFIX = "kern-wb:";
let memoryClipboard: Snap | null = null;
// Pen options survive switching whiteboards within a session.
let penMemory: { color: WbColor; width: number } = { color: "default", width: 4 };

/** Smallest size a dragged-out object may take; anything smaller counts as a click. */
const DRAW_MIN: Partial<Record<WbNodeType, [number, number]>> = {
  text: [140, 60],
  sticky: [100, 80],
  area: [160, 120],
  shape: [20, 20],
};

/** Types that open their inline editor on Enter. */
const EDITABLE = new Set<WbNodeType>(["text", "sticky", "shape", "area", "link"]);

const isLineTool = (t: Tool) => t === "shape:line" || t === "shape:arrow";

/** One click for the labels a decision branch almost always needs. */
const BRANCH_LABELS = ["Yes", "No", "Otherwise"];

/** Shift while dragging: square boxes, 45° lines. */
function constrain(a: Pt, b: Pt, line: boolean): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (line) {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return { x: a.x + Math.round(Math.cos(angle) * len), y: a.y + Math.round(Math.sin(angle) * len) };
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: a.x + Math.sign(dx || 1) * side, y: a.y + Math.sign(dy || 1) * side };
}

const clean = (n: WbNode): WbNode => {
  const { selected: _s, dragging: _d, ...rest } = n;
  void _s;
  void _d;
  return rest as WbNode;
};

export function WhiteboardCanvas({ id, projectId }: { id: string; projectId: string | null }) {
  const { data: scene, isError } = useQuery({
    queryKey: ["whiteboard", id],
    queryFn: () => api.whiteboards.get(id),
    staleTime: Infinity,
    gcTime: 0,
  });
  if (isError) return <EmptyState icon={Presentation} title="This whiteboard isn't available" />;
  if (!scene)
    return (
      <div className="wb">
        <div className="page-loading">
          <Skeleton height={200} />
        </div>
      </div>
    );
  return (
    <ReactFlowProvider>
      <Editor key={id} scene={scene} projectId={projectId} />
    </ReactFlowProvider>
  );
}

function Editor({ scene, projectId }: { scene: WhiteboardScene; projectId: string | null }) {
  const wbId = scene.whiteboard.id;
  const s = useSettings((st) => st.values);
  const initial = useMemo(() => fromRecords(scene.nodes, scene.edges), [scene]);
  const [nodes, setNodes] = useState<WbNode[]>(initial.nodes);
  const [edges, setEdges] = useState<WbEdge[]>(initial.edges);
  const [tool, setTool] = useState<Tool>("select");
  const [toolLock, setToolLock] = useState(false);
  const [lastShape, setLastShape] = useState<ShapeKind>("rounded");
  const [pen, setPenState] = useState(penMemory);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [eraserAt, setEraserAt] = useState<Pt | null>(null);
  const [editingEdge, setEditingEdge] = useState<string | null>(null);
  const [spacePan, setSpacePan] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [mermaidOpen, setMermaidOpen] = useState(false);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const [selection, setSelection] = useState<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] });
  const [menu, setMenu] = useState<{ kind: "node" | "edge" | "pane"; id?: string; flow: { x: number; y: number } } | null>(null);
  const rf = useReactFlow<WbNode, WbEdge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // ------------------------------------------------------------ collaboration
  const readOnly = useReadOnly();
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const shared = useCloud((st) => !!st.info?.active);
  const sharedRef = useRef(shared);
  sharedRef.current = shared;
  /** Each object and connection as last saved or received. */
  const baseline = useRef(baselineOf(toRecords(initial.nodes, initial.edges)));
  /** Objects a collaborator is dragging right now (when), never saved from here. */
  const liveMoved = useRef(new Map<string, number>());
  const moving = () => {
    const now = Date.now();
    for (const [id, t] of liveMoved.current) if (now - t > 4000) liveMoved.current.delete(id);
    return new Set(liveMoved.current.keys());
  };

  // ------------------------------------------------------------ persistence
  const saveTimer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const saving = useRef(false);

  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    if (!dirty.current || saving.current) return;
    dirty.current = false;
    // Viewers can't change a workspace; nothing is saved.
    if (readOnlyRef.current) return;
    saving.current = true;
    // Only what changed since the last save, so collaborators' edits are never overwritten.
    const patch = diffScene(baseline.current, toRecords(nodesRef.current.map(clean), edgesRef.current), moving());
    const vp = rf.getViewport();
    void api.whiteboards
      .patch(wbId, patch, { x: vp.x, y: vp.y, zoom: vp.zoom })
      .then(() => {
        commitBaseline(baseline.current, patch);
        if (isEmpty(patch)) return;
        invalidate("whiteboards", "recent");
        queryClient.removeQueries({ queryKey: ["whiteboard", "preview", wbId] });
      })
      .catch((e) => {
        dirty.current = true;
        toastError(describeError(e, "Couldn't save the whiteboard."), flush);
      })
      .finally(() => {
        saving.current = false;
        if (dirty.current) saveTimer.current = window.setTimeout(flush, 400);
      });
  }, [rf, wbId]);

  const scheduleSave = useCallback(() => {
    dirty.current = true;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flush, 500);
  }, [flush]);

  useEffect(() => {
    const off = onBeforeNavigate(flush);
    const onLeave = () => flush();
    window.addEventListener("blur", onLeave);
    window.addEventListener("beforeunload", onLeave);
    document.addEventListener("mouseleave", onLeave);
    document.addEventListener("visibilitychange", onLeave);
    return () => {
      off();
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("beforeunload", onLeave);
      document.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("visibilitychange", onLeave);
      flush();
    };
  }, [flush]);

  // ------------------------------------------------------------ history
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  const committed = useRef<Snap>({ nodes: initial.nodes, edges: initial.edges });
  const [commitTick, setCommitTick] = useState(0);
  const requestCommit = useCallback(() => setCommitTick((t) => t + 1), []);

  useEffect(() => {
    if (!commitTick) return;
    past.current.push(committed.current);
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    committed.current = { nodes: nodesRef.current.map(clean), edges: edgesRef.current };
    scheduleSave();
  }, [commitTick, scheduleSave]);

  const restore = (snap: Snap) => {
    setNodes(snap.nodes);
    setEdges(snap.edges);
    committed.current = snap;
    scheduleSave();
  };
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push({ nodes: nodesRef.current.map(clean), edges: edgesRef.current });
    restore(prev);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push({ nodes: nodesRef.current.map(clean), edges: edgesRef.current });
    restore(next);
  };

  // ------------------------------------------------------------ collaborators' saved changes
  useEffect(
    () =>
      onWhiteboardChanges((ids) => {
        if (!ids.has(wbId)) return;
        void api.whiteboards
          .preview(wbId)
          .then((fresh) => {
            const conv = fromRecords(fresh.nodes, fresh.edges);
            const live = moving();
            const m = mergeScene(baseline.current, toRecords(nodesRef.current.map(clean), edgesRef.current), toRecords(conv.nodes, conv.edges), live);
            baseline.current = m.next;
            m.nodes.forEach((_, id) => liveMoved.current.delete(id));
            if (!m.nodes.size && !m.edges.size) return;
            const nodeById = new Map(conv.nodes.map((n) => [n.id, n]));
            const edgeById = new Map(conv.edges.map((e) => [e.id, e]));
            const applyNodes = (ns: WbNode[], keepUi: boolean): WbNode[] => {
              const out: WbNode[] = [];
              const seen = new Set<string>();
              for (const n of ns) {
                seen.add(n.id);
                if (!m.nodes.has(n.id)) out.push(n);
                else if (m.nodes.get(n.id) && nodeById.has(n.id)) out.push(keepUi ? { ...nodeById.get(n.id)!, selected: n.selected } : nodeById.get(n.id)!);
              }
              m.nodes.forEach((rec, id) => {
                if (rec && !seen.has(id) && nodeById.has(id)) out.push(nodeById.get(id)!);
              });
              const present = new Set(out.map((n) => n.id));
              return sortParentsFirst(out.map((n) => (n.parentId && !present.has(n.parentId) ? { ...n, parentId: undefined } : n)));
            };
            const applyEdges = (es: WbEdge[], keepUi: boolean): WbEdge[] => {
              const out: WbEdge[] = [];
              const seen = new Set<string>();
              for (const e of es) {
                seen.add(e.id);
                if (!m.edges.has(e.id)) out.push(e);
                else if (m.edges.get(e.id) && edgeById.has(e.id)) out.push(keepUi ? { ...edgeById.get(e.id)!, selected: e.selected } : edgeById.get(e.id)!);
              }
              m.edges.forEach((rec, id) => {
                if (rec && !seen.has(id) && edgeById.has(id)) out.push(edgeById.get(id)!);
              });
              return out;
            };
            setNodes((ns) => applyNodes(ns, true));
            setEdges((es) => applyEdges(es, true));
            // Undo only reverts this person's own edits.
            const fix = (snap: Snap): Snap => ({ nodes: applyNodes(snap.nodes, false), edges: applyEdges(snap.edges, false) });
            committed.current = fix(committed.current);
            past.current = past.current.map(fix);
            future.current = future.current.map(fix);
          })
          .catch(() => undefined);
      }),
    [wbId],
  );

  // Collaborators' drags, shown live until their save arrives.
  useEffect(
    () =>
      onEphemeral((e) => {
        const d = e.data as { k?: string; wb?: string; n?: { id: string; x: number; y: number }[] } | null;
        if (d?.k !== "drag" || d.wb !== wbId || !Array.isArray(d.n)) return;
        const moves = new Map(d.n.filter((m) => Number.isFinite(m.x) && Number.isFinite(m.y)).map((m) => [m.id, m]));
        const now = Date.now();
        moves.forEach((_, id) => liveMoved.current.set(id, now));
        setNodes((ns) =>
          ns.map((n) => {
            const m = moves.get(n.id);
            return m && !n.dragging ? { ...n, position: { x: m.x, y: m.y } } : n;
          }),
        );
      }),
    [wbId],
  );

  // ------------------------------------------------------------ node api
  const updateNode = useCallback(
    (id: string, patch: Partial<WbData>, commit = true) => {
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
      if (commit) requestCommit();
      else scheduleSave();
    },
    [requestCommit, scheduleSave],
  );
  const nodeApi = useMemo(() => ({ update: updateNode, projectId }), [updateNode, projectId]);
  const updateNodes = (ids: string[], patch: Partial<WbData>) => {
    const set = new Set(ids);
    setNodes((ns) => ns.map((n) => (set.has(n.id) ? { ...n, data: { ...n.data, ...patch } } : n)));
    requestCommit();
  };
  const updateEdge = useCallback(
    (id: string, patch: Partial<WbEdgeData>) => {
      setEdges((es) => es.map((e) => (e.id === id ? { ...e, data: { ...e.data, ...patch } } : e)));
      requestCommit();
    },
    [requestCommit],
  );
  const edgeApi = useMemo(() => ({ updateEdge, editingId: editingEdge, setEditingId: setEditingEdge }), [updateEdge, editingEdge]);

  // In a cloud space, images are shared with collaborators as compressed
  // copies (the original stays here). Covers new images and ones copied in
  // from offline data.
  const spaceId = useCloud((st) => st.info?.active?.id ?? null);
  const shareTried = useRef(new Set<string>());
  const shareWarned = useRef(false);
  useEffect(() => {
    if (!spaceId || readOnly) return;
    for (const n of nodes) {
      const src = n.data.src;
      if (n.type !== "image" || !src || n.data.cloudAsset) continue;
      const key = `${n.id}:${src}`;
      if (shareTried.current.has(key)) continue;
      shareTried.current.add(key);
      shareImage(spaceId, src)
        .then((asset) => updateNode(n.id, { cloudAsset: asset }, false))
        .catch((e) => {
          shareTried.current.delete(key);
          // The original is on another computer: nothing to share from here.
          if (e instanceof Error && "code" in e && (e as { code: string }).code === "not_found") {
            shareTried.current.add(key);
            return;
          }
          if (!shareWarned.current) {
            shareWarned.current = true;
            toastError(describeError(e, "Couldn't share an image with collaborators. It's still on this computer."));
          }
        });
    }
  }, [nodes, spaceId, readOnly, updateNode]);

  // ------------------------------------------------------------ alignment guides
  const zoom = useStore((st) => st.transform[2]);
  const computeGuides = (moving: WbNode, pos: { x: number; y: number }) => {
    if (!s["wb.alignGuides"] || moving.parentId) return { pos, guide: {} };
    const { w, h } = sizeOf(moving);
    const threshold = 6 / zoom;
    let best: { dx?: number; dy?: number; gx?: number; gy?: number } = {};
    let bx = threshold;
    let by = threshold;
    const xs = [pos.x, pos.x + w / 2, pos.x + w];
    const ys = [pos.y, pos.y + h / 2, pos.y + h];
    for (const o of nodesRef.current) {
      if (o.id === moving.id || o.parentId || o.selected) continue;
      const { w: ow, h: oh } = sizeOf(o);
      const ox = [o.position.x, o.position.x + ow / 2, o.position.x + ow];
      const oy = [o.position.y, o.position.y + oh / 2, o.position.y + oh];
      for (let i = 0; i < 3; i++)
        for (const t of ox) {
          const d = Math.abs(xs[i] - t);
          if (d < bx) {
            bx = d;
            best = { ...best, dx: t - xs[i], gx: t };
          }
        }
      for (let i = 0; i < 3; i++)
        for (const t of oy) {
          const d = Math.abs(ys[i] - t);
          if (d < by) {
            by = d;
            best = { ...best, dy: t - ys[i], gy: t };
          }
        }
    }
    return { pos: { x: pos.x + (best.dx ?? 0), y: pos.y + (best.dy ?? 0) }, guide: { x: best.gx, y: best.gy } };
  };

  const onNodesChange = useCallback(
    (changes: NodeChange<WbNode>[]) => {
      let commit = false;
      let guide: { x?: number; y?: number } = {};
      const dragging = changes.filter((c) => c.type === "position" && c.dragging);
      if (dragging.length === 1) {
        const c = dragging[0] as Extract<NodeChange<WbNode>, { type: "position" }>;
        const n = nodesRef.current.find((x) => x.id === c.id);
        if (n && c.position) {
          const r = computeGuides(n, c.position);
          c.position = r.pos;
          guide = r.guide;
        }
      }
      setGuides(guide);
      for (const c of changes) {
        if (c.type === "remove") commit = true;
        if (c.type === "position" && c.dragging === false) commit = true;
        if (c.type === "dimensions" && c.resizing === false) commit = true;
      }
      setNodes((ns) => applyNodeChanges(changes, ns));
      if (commit) requestCommit();
      if (sharedRef.current) {
        const moved = changes.filter((c): c is Extract<NodeChange<WbNode>, { type: "position" }> => c.type === "position" && !!c.position);
        if (moved.length) {
          moved.forEach((c) => liveMoved.current.delete(c.id));
          sendEphemeral({ k: "drag", wb: wbId, n: moved.map((c) => ({ id: c.id, x: c.position!.x, y: c.position!.y })) }, moved.some((c) => c.dragging === false));
        }
      }
    },
    [requestCommit, zoom, s["wb.alignGuides"]],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<WbEdge>[]) => {
      setEdges((es) => applyEdgeChanges(changes, es));
      if (changes.some((c) => c.type === "remove")) requestCommit();
    },
    [requestCommit],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === c.target) return;
      setEdges((es) => [...es, { id: newEdgeId(), source: c.source, target: c.target, sourceHandle: c.sourceHandle, targetHandle: c.targetHandle, type: "wb", data: edgeDefaults() }]);
      requestCommit();
    },
    [requestCommit],
  );

  const onReconnect = useCallback(
    (old: WbEdge, c: Connection) => {
      setEdges((es) => reconnectEdge(old, c, es) as WbEdge[]);
      requestCommit();
    },
    [requestCommit],
  );

  /** The innermost area containing a flow point (skipping `exclude` and its descendants). */
  const areaAt = (p: Pt, exclude?: string): WbNode | undefined => {
    const all = nodesRef.current;
    const byId = new Map(all.map((n) => [n.id, n]));
    let best: WbNode | undefined;
    let bestArea = Infinity;
    for (const a of all) {
      if (a.type !== "area" || a.id === exclude || (exclude && isDescendant(a.id, exclude, byId))) continue;
      const ap = absolutePosition(a, byId);
      const as = sizeOf(a);
      if (p.x < ap.x || p.x > ap.x + as.w || p.y < ap.y || p.y > ap.y + as.h || as.w * as.h >= bestArea) continue;
      best = a;
      bestArea = as.w * as.h;
    }
    return best;
  };

  /** Re-homes a freshly placed (top-level) node into the area under its centre. */
  const adopt = (n: WbNode): WbNode => {
    if (n.type === "area") return n;
    const { w, h } = sizeOf(n);
    const host = areaAt({ x: n.position.x + w / 2, y: n.position.y + h / 2 });
    if (!host) return n;
    const hp = absolutePosition(host, new Map(nodesRef.current.map((x) => [x.id, x])));
    return { ...n, parentId: host.id, position: { x: n.position.x - hp.x, y: n.position.y - hp.y } };
  };

  // Move nodes into / out of areas after dragging.
  const onNodeDragStop = useCallback(
    (_: unknown, __: WbNode, dragged: WbNode[]) => {
      setGuides({});
      const all = nodesRef.current;
      const byId = new Map(all.map((n) => [n.id, n]));
      let changed = false;
      const next = all.map((n) => {
        if (!dragged.some((d) => d.id === n.id) || n.type === "area") return n;
        const abs = absolutePosition(n, byId);
        const { w, h } = sizeOf(n);
        const host = areaAt({ x: abs.x + w / 2, y: abs.y + h / 2 }, n.id);
        if ((host?.id ?? undefined) === n.parentId) return n;
        changed = true;
        if (host) {
          const hp = absolutePosition(host, byId);
          return { ...n, parentId: host.id, position: { x: abs.x - hp.x, y: abs.y - hp.y } };
        }
        return { ...n, parentId: undefined, position: abs };
      });
      if (changed) {
        setNodes(sortParentsFirst(next));
        requestCommit();
      }
    },
    [requestCommit],
  );

  // ------------------------------------------------------------ creation
  const flowAt = (clientX: number, clientY: number) => rf.screenToFlowPosition({ x: clientX, y: clientY });
  const viewCenter = () => {
    const r = wrapper.current?.getBoundingClientRect();
    return r ? flowAt(r.left + r.width / 2, r.top + r.height / 2) : { x: 0, y: 0 };
  };
  const snapPos = (p: { x: number; y: number }) => {
    if (!s["wb.snapToGrid"]) return p;
    const g = s["wb.gridSize"];
    return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
  };

  const addNodes = (list: WbNode[], select = true) => {
    const maxZ = Math.max(0, ...nodesRef.current.map((n) => n.zIndex ?? 0));
    const prepared = list.map((n, i) => ({ ...n, zIndex: n.type === "area" ? -1 : maxZ + 1 + i, selected: select }));
    setNodes((ns) => sortParentsFirst([...ns.map((n) => (select ? { ...n, selected: false } : n)), ...prepared]));
    requestCommit();
  };

  const create = (type: WbNodeType, at: { x: number; y: number }, data: Partial<WbData> = {}, size?: { w: number; h: number }) => {
    const n = makeNode(type, at, { editing: true, ...data }, size);
    if (!size) n.position = snapPos(n.position);
    const placed = adopt(n);
    addNodes([placed]);
    return placed;
  };

  const importImages = async (paths: string[], at: { x: number; y: number }) => {
    let offset = 0;
    for (const p of paths) {
      try {
        const asset = await api.attachments.importAsset(p);
        const dims = await imageSize(asset.absPath);
        const w = Math.min(420, dims.w);
        const h = (w / dims.w) * dims.h;
        addNodes([makeNode("image", { x: at.x + offset, y: at.y + offset }, { src: asset.path, name: asset.name, aspect: dims.w / dims.h }, { w, h })]);
        offset += 30;
      } catch (e) {
        toastError(describeError(e, "Couldn't add the image."));
      }
    }
  };

  const addFiles = (paths: string[], at: { x: number; y: number }) => {
    const nodes = paths.map((p, i) => makeNode("file", { x: at.x + i * 24, y: at.y + i * 24 }, { path: p, name: p.split(/[\\/]/).pop() }));
    addNodes(nodes);
  };

  const pickImage = async () => {
    const picked = await openDialog({ multiple: true, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"] }] });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length) await importImages(paths, viewCenter());
  };
  const pickFile = async () => {
    const picked = await openDialog({ multiple: true, title: "Reference files" });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length) addFiles(paths, viewCenter());
  };

  const placeTool = (t: Tool, at: { x: number; y: number }) => {
    switch (t) {
      case "text":
        return create("text", at);
      case "sticky":
        return create("sticky", at);
      case "area":
        return create("area", at, { editing: false });
      case "task":
        return create("task", at);
      case "link":
        return create("link", at);
      case "project":
      case "board":
      case "note":
      case "milestone":
        return create(t, at, { editing: false });
      default:
        if (t.startsWith("shape:")) return create("shape", at, { shape: t.slice(6) as WbData["shape"], editing: false });
    }
  };

  /** Places the current tool into a dragged-out box (a → b, flow coordinates). */
  const placeBox = (t: Tool, a: Pt, b: Pt) => {
    if (s["wb.snapToGrid"]) {
      a = snapPos(a);
      b = snapPos(b);
    }
    let x = Math.min(a.x, b.x);
    let y = Math.min(a.y, b.y);
    let w = Math.abs(b.x - a.x);
    let h = Math.abs(b.y - a.y);
    if (isLineTool(t)) {
      // Lines live in their bounding box; flip/reverse recover the drawn direction.
      const data: Partial<WbData> = { shape: t.slice(6) as WbData["shape"], editing: false, flip: false, reverse: false };
      if (h < 12) {
        y = a.y - 8;
        h = 16;
        data.reverse = b.x < a.x;
      } else if (w < 12) {
        x = a.x - 8;
        w = 16;
        data.reverse = b.y < a.y;
      } else {
        data.flip = (b.x - a.x) * (b.y - a.y) < 0;
        data.reverse = b.x < a.x;
      }
      return create("shape", { x: x + w / 2, y: y + h / 2 }, data, { w: Math.max(w, 20), h });
    }
    const type: WbNodeType = t.startsWith("shape:") ? "shape" : (t as WbNodeType);
    const [mw, mh] = DRAW_MIN[type] ?? [180, 60];
    w = Math.max(w, mw);
    h = Math.max(h, mh);
    const center = { x: x + w / 2, y: y + h / 2 };
    if (type === "shape") return create("shape", center, { shape: t.slice(6) as WbData["shape"], editing: false }, { w, h });
    const data: Partial<WbData> = type === "area" || type === "project" || type === "board" || type === "note" || type === "milestone" ? { editing: false } : {};
    return create(type, center, data, { w, h });
  };

  const onPaneClick = () => setMenu(null);

  // ------------------------------------------------------------ drawing layer
  // While a placing tool, the pen or the eraser is active, a transparent layer
  // over the canvas takes the pointer: click to place, drag to size, ink, erase.
  const gesture = useRef<{ start: Pt; client: Pt; pts: number[]; moved: boolean; erased: Set<string> } | null>(null);

  const eraseAt = (p: Pt) => {
    const g = gesture.current;
    if (!g) return;
    const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
    const hits = nodesRef.current.filter((n) => n.type === "draw" && !n.data.locked && !g.erased.has(n.id) && inkHit(n, absolutePosition(n, byId), p, 8 / zoom));
    if (!hits.length) return;
    const ids = new Set(hits.map((n) => n.id));
    ids.forEach((id) => g.erased.add(id));
    setNodes((ns) => ns.filter((n) => !ids.has(n.id)));
    setEdges((es) => es.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
  };

  const onLayerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    wrapper.current?.focus({ preventScroll: true });
    setMenu(null);
    const p = flowAt(e.clientX, e.clientY);
    gesture.current = { start: p, client: { x: e.clientX, y: e.clientY }, pts: [p.x, p.y], moved: false, erased: new Set() };
    if (tool === "pen") setDraft({ kind: "ink", points: gesture.current.pts });
    if (tool === "eraser") eraseAt(p);
  };

  const onLayerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (tool === "eraser") {
      const r = wrapper.current?.getBoundingClientRect();
      if (r) setEraserAt({ x: e.clientX - r.left, y: e.clientY - r.top });
    }
    const g = gesture.current;
    if (!g) return;
    const p = flowAt(e.clientX, e.clientY);
    if (!g.moved && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) > 4) g.moved = true;
    if (tool === "pen") {
      const n = g.pts.length;
      if (Math.hypot(p.x - g.pts[n - 2], p.y - g.pts[n - 1]) < 1.5 / zoom) return;
      g.pts.push(p.x, p.y);
      setDraft({ kind: "ink", points: g.pts.slice() });
    } else if (tool === "eraser") eraseAt(p);
    else if (g.moved) setDraft({ kind: "box", a: g.start, b: e.shiftKey ? constrain(g.start, p, isLineTool(tool)) : p });
  };

  const onLayerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setDraft(null);
    if (!g) return;
    if (tool === "pen") {
      addNodes([adopt(makeDrawing(g.pts, pen.width, pen.color))], false);
      return;
    }
    if (tool === "eraser") {
      if (g.erased.size) requestCommit();
      return;
    }
    const p = flowAt(e.clientX, e.clientY);
    if (g.moved) placeBox(tool, g.start, e.shiftKey ? constrain(g.start, p, isLineTool(tool)) : p);
    else placeTool(tool, p);
    // Shift-click keeps the tool for one more placement; the lock keeps it until released.
    if (!toolLock && !(e.shiftKey && !g.moved)) setTool("select");
  };

  const setPen = (patch: Partial<typeof pen>) => {
    penMemory = { ...pen, ...patch };
    setPenState(penMemory);
  };

  useEffect(() => {
    if (tool.startsWith("shape:")) setLastShape(tool.slice(6) as ShapeKind);
    if (tool !== "eraser") setEraserAt(null);
  }, [tool]);

  // Double-click on empty canvas adds a text card.
  const onDoubleClick = (e: React.MouseEvent) => {
    if (readOnly || !(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
    create("text", flowAt(e.clientX, e.clientY));
  };

  // ------------------------------------------------------------ selection ops
  const selectedNodes = () => nodesRef.current.filter((n) => n.selected);

  const deleteSelection = () => {
    const ids = new Set(selectedNodes().filter((n) => !n.data.locked).map((n) => n.id));
    const edgeIds = new Set(edgesRef.current.filter((e) => e.selected).map((e) => e.id));
    if (!ids.size && !edgeIds.size) return;
    // Children of deleted areas are kept (moved to the top level).
    const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
    setNodes((ns) =>
      ns
        .filter((n) => !ids.has(n.id))
        .map((n) => (n.parentId && ids.has(n.parentId) ? { ...n, parentId: undefined, position: absolutePosition(n, byId) } : n)),
    );
    setEdges((es) => es.filter((e) => !edgeIds.has(e.id) && !ids.has(e.source) && !ids.has(e.target)));
    requestCommit();
  };

  const copySelection = (cut = false) => {
    const sel = selectedNodes();
    if (!sel.length) return;
    const ids = new Set(sel.map((n) => n.id));
    const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
    // Include children of copied areas.
    for (const n of nodesRef.current) if (n.parentId && ids.has(n.parentId)) ids.add(n.id);
    const nodes = nodesRef.current
      .filter((n) => ids.has(n.id))
      .map((n) => (n.parentId && !ids.has(n.parentId) ? { ...clean(n), parentId: undefined, position: absolutePosition(n, byId) } : clean(n)));
    const clip: Snap = { nodes, edges: edgesRef.current.filter((e) => ids.has(e.source) && ids.has(e.target)) };
    memoryClipboard = clip;
    void navigator.clipboard.writeText(CLIP_PREFIX + JSON.stringify(clip)).catch(() => undefined);
    if (cut) deleteSelection();
  };

  const pasteSnap = (clip: Snap, at?: { x: number; y: number }) => {
    const map = new Map<string, string>();
    clip.nodes.forEach((n) => map.set(n.id, newNodeId()));
    const top = clip.nodes.filter((n) => !n.parentId || !map.has(n.parentId));
    const minX = Math.min(...top.map((n) => n.position.x));
    const minY = Math.min(...top.map((n) => n.position.y));
    const dx = at ? at.x - minX : 30;
    const dy = at ? at.y - minY : 30;
    const nodes = clip.nodes.map((n) => {
      const parent = n.parentId ? map.get(n.parentId) : undefined;
      return {
        ...n,
        id: map.get(n.id)!,
        parentId: parent,
        position: parent ? n.position : { x: n.position.x + dx, y: n.position.y + dy },
        data: { ...n.data, editing: undefined },
      };
    });
    const edges = clip.edges.filter((e) => map.has(e.source) && map.has(e.target)).map((e) => ({ ...e, id: newEdgeId(), source: map.get(e.source)!, target: map.get(e.target)!, selected: false }));
    addNodes(nodes);
    setEdges((es) => [...es, ...edges]);
  };

  const duplicate = () => {
    copySelection();
    if (memoryClipboard) pasteSnap(memoryClipboard);
  };

  const onPaste = async (e: ClipboardEvent) => {
    if (isTextInput(e.target)) return;
    const at = pointer.current ? flowAt(pointer.current.x, pointer.current.y) : viewCenter();
    const items = Array.from(e.clipboardData?.items ?? []);
    const img = items.find((i) => i.type.startsWith("image/"));
    if (img) {
      e.preventDefault();
      const file = img.getAsFile();
      if (!file) return;
      const b64 = await blobToBase64(file);
      try {
        const ext = img.type.split("/")[1] ?? "png";
        const asset = await api.attachments.importAssetBytes(`pasted.${ext}`, b64);
        const dims = await imageSize(asset.absPath);
        const w = Math.min(420, dims.w);
        addNodes([makeNode("image", at, { src: asset.path, name: "Pasted image", aspect: dims.w / dims.h }, { w, h: (w / dims.w) * dims.h })]);
      } catch (err) {
        toastError(describeError(err, "Couldn't paste the image."));
      }
      return;
    }
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    e.preventDefault();
    if (text.startsWith(CLIP_PREFIX)) {
      try {
        pasteSnap(JSON.parse(text.slice(CLIP_PREFIX.length)) as Snap, at);
      } catch {
        /* malformed clipboard - ignore */
      }
      return;
    }
    if (/^https?:\/\/\S+$/i.test(text.trim())) {
      const n = makeNode("link", at, { url: text.trim() });
      addNodes([n]);
      if (useSettings.getState().values["data.linkPreviews"]) {
        void api.system
          .linkMetadata(text.trim())
          .then((m) => updateNode(n.id, { title: m.title ?? undefined, description: m.description ?? undefined, siteName: m.siteName ?? undefined }, false))
          .catch(() => undefined);
      }
      return;
    }
    const [first, ...rest] = text.split("\n");
    addNodes([makeNode("text", at, rest.length ? { title: first.slice(0, 120), text: rest.join("\n") } : { text: first })]);
  };

  const group = () => {
    const sel = selectedNodes().filter((n) => !n.parentId || !selectedNodes().some((p) => p.id === n.parentId));
    if (sel.length < 1) return;
    const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
    const abs = sel.map((n) => ({ n, p: absolutePosition(n, byId), s: sizeOf(n) }));
    const minX = Math.min(...abs.map((a) => a.p.x)) - 24;
    const minY = Math.min(...abs.map((a) => a.p.y)) - 24;
    const maxX = Math.max(...abs.map((a) => a.p.x + a.s.w)) + 24;
    const maxY = Math.max(...abs.map((a) => a.p.y + a.s.h)) + 24;
    const area = makeNode("area", { x: 0, y: 0 }, { label: "Group" }, { w: maxX - minX, h: maxY - minY });
    area.position = { x: minX, y: minY };
    const ids = new Set(sel.map((n) => n.id));
    setNodes((ns) =>
      sortParentsFirst([
        { ...area, zIndex: -1, selected: true },
        ...ns.map((n) => (ids.has(n.id) ? { ...n, selected: false, parentId: area.id, position: { x: absolutePosition(n, byId).x - minX, y: absolutePosition(n, byId).y - minY } } : { ...n, selected: false })),
      ]),
    );
    requestCommit();
  };

  const ungroup = () => {
    const sel = selectedNodes();
    const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
    const areaIds = new Set(sel.filter((n) => n.type === "area").map((n) => n.id));
    const detach = new Set(sel.filter((n) => n.parentId && !areaIds.has(n.id)).map((n) => n.id));
    if (!areaIds.size && !detach.size) return;
    setNodes((ns) =>
      sortParentsFirst(
        ns
          .filter((n) => !areaIds.has(n.id))
          .map((n) => ((n.parentId && areaIds.has(n.parentId)) || detach.has(n.id) ? { ...n, parentId: undefined, position: absolutePosition(n, byId) } : n)),
      ),
    );
    requestCommit();
  };

  const align = (mode: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom" | "hdist" | "vdist") => {
    const sel = selectedNodes();
    if (sel.length < 2) return;
    const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
    const items = sel.map((n) => ({ n, p: absolutePosition(n, byId), s: sizeOf(n) }));
    const minX = Math.min(...items.map((i) => i.p.x));
    const maxX = Math.max(...items.map((i) => i.p.x + i.s.w));
    const minY = Math.min(...items.map((i) => i.p.y));
    const maxY = Math.max(...items.map((i) => i.p.y + i.s.h));
    const target = new Map<string, { x: number; y: number }>();
    if (mode === "hdist" || mode === "vdist") {
      const horiz = mode === "hdist";
      const sorted = [...items].sort((a, b) => (horiz ? a.p.x - b.p.x : a.p.y - b.p.y));
      const total = sorted.reduce((sum, i) => sum + (horiz ? i.s.w : i.s.h), 0);
      const gap = ((horiz ? maxX - minX : maxY - minY) - total) / (sorted.length - 1);
      let cursor = horiz ? minX : minY;
      for (const i of sorted) {
        target.set(i.n.id, horiz ? { x: cursor, y: i.p.y } : { x: i.p.x, y: cursor });
        cursor += (horiz ? i.s.w : i.s.h) + gap;
      }
    } else {
      for (const i of items) {
        const x = mode === "left" ? minX : mode === "right" ? maxX - i.s.w : mode === "hcenter" ? (minX + maxX) / 2 - i.s.w / 2 : i.p.x;
        const y = mode === "top" ? minY : mode === "bottom" ? maxY - i.s.h : mode === "vcenter" ? (minY + maxY) / 2 - i.s.h / 2 : i.p.y;
        target.set(i.n.id, { x, y });
      }
    }
    setNodes((ns) =>
      ns.map((n) => {
        const t = target.get(n.id);
        if (!t) return n;
        const parent = n.parentId ? byId.get(n.parentId) : undefined;
        const pp = parent ? absolutePosition(parent, byId) : { x: 0, y: 0 };
        return { ...n, position: { x: t.x - pp.x, y: t.y - pp.y } };
      }),
    );
    requestCommit();
  };

  const zOrder = (dir: "front" | "back" | "forward" | "backward") => {
    const ids = new Set(selectedNodes().map((n) => n.id));
    if (!ids.size) return;
    const zs = nodesRef.current.map((n) => n.zIndex ?? 0);
    const max = Math.max(...zs);
    const min = Math.min(...zs);
    setNodes((ns) =>
      ns.map((n) => {
        if (!ids.has(n.id)) return n;
        const z = n.zIndex ?? 0;
        const next = dir === "front" ? max + 1 : dir === "back" ? min - 1 : dir === "forward" ? z + 1 : z - 1;
        return { ...n, zIndex: next };
      }),
    );
    requestCommit();
  };

  const setLocked = (locked: boolean) => {
    const ids = new Set(selectedNodes().map((n) => n.id));
    setNodes((ns) => ns.map((n) => (ids.has(n.id) ? { ...n, draggable: !locked, deletable: !locked, data: { ...n.data, locked } } : n)));
    requestCommit();
  };

  const selectAll = () => setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));

  // ------------------------------------------------------------ view
  const fit = () => void rf.fitView({ padding: 0.15, duration: 220, maxZoom: 1.5 });
  const zoomToSelection = () => {
    const sel = selectedNodes();
    if (!sel.length) return fit();
    void rf.fitView({ nodes: sel.map((n) => ({ id: n.id })), padding: 0.3, duration: 220, maxZoom: 2 });
  };
  const resetZoom = () => void rf.zoomTo(1, { duration: 160 });

  useEffect(() => {
    const vp = scene.whiteboard.viewport;
    const focusId = takeWhiteboardFocus(scene.whiteboard.id);
    const t = window.setTimeout(() => {
      const target = focusId ? nodesRef.current.find((n) => n.id === focusId) : undefined;
      if (target) {
        const w = target.measured?.width ?? target.width ?? 200;
        const h = target.measured?.height ?? target.height ?? 100;
        const abs = rf.getInternalNode(target.id)?.internals.positionAbsolute ?? target.position;
        void rf.setCenter(abs.x + w / 2, abs.y + h / 2, { zoom: Math.max(1, s["wb.defaultZoom"]) });
        setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === target.id })));
      } else if (nodesRef.current.length && (s["wb.autoFit"] || !vp)) void rf.fitView({ padding: 0.15, maxZoom: Math.max(1, s["wb.defaultZoom"]) });
      else if (vp) void rf.setViewport(vp);
      else void rf.setViewport({ x: 0, y: 0, zoom: s["wb.defaultZoom"] });
    }, 30);
    return () => window.clearTimeout(t);
  }, []);

  // Custom wheel handling: zoom speed / trackpad panning follow settings.
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".nowheel")) return;
      e.preventDefault();
      const v = rf.getViewport();
      const trackpad = s["wb.interactionMode"] === "trackpad";
      const zoomGesture = e.ctrlKey || (!trackpad && !e.shiftKey);
      if (zoomGesture) {
        const factor = Math.exp(-e.deltaY * (e.ctrlKey && trackpad ? 0.01 : 0.0016) * s["wb.zoomSensitivity"]);
        const z = Math.max(0.1, Math.min(4, v.zoom * factor));
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        void rf.setViewport({ zoom: z, x: px - ((px - v.x) / v.zoom) * z, y: py - ((py - v.y) / v.zoom) * z });
      } else {
        const k = s["wb.panSensitivity"];
        const dx = e.shiftKey && !trackpad ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !trackpad ? 0 : e.deltaY;
        void rf.setViewport({ zoom: v.zoom, x: v.x - dx * k, y: v.y - dy * k });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [rf, s]);

  // Files dropped from the OS (Tauri provides real paths).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((ev) => {
        if (ev.payload.type !== "drop" || readOnlyRef.current) return;
        const rect = wrapper.current?.getBoundingClientRect();
        if (!rect) return;
        const ratio = window.devicePixelRatio || 1;
        const x = ev.payload.position.x / ratio;
        const y = ev.payload.position.y / ratio;
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
        const at = flowAt(x, y);
        const images = ev.payload.paths.filter((p) => /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(p));
        const files = ev.payload.paths.filter((p) => !images.includes(p));
        if (images.length) void importImages(images, at);
        if (files.length) addFiles(files, { x: at.x + 40, y: at.y + 40 });
      })
      .then((f) => (unlisten = f));
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      if (readOnlyRef.current) return;
      if (!wrapper.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      void onPaste(e);
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  });

  // ------------------------------------------------------------ keyboard
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTextInput(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    // View only: navigation keys and copying still work.
    if (readOnly && !(mod && ["0", "=", "+", "-", "c", "a"].includes(k)) && !(e.shiftKey && (e.code === "Digit1" || e.code === "Digit2")) && e.key !== " ") return;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (mod && k === "z" && !e.shiftKey) return handled(), undo();
    if (mod && (k === "y" || (k === "z" && e.shiftKey))) return handled(), redo();
    if (mod && k === "c") return handled(), copySelection();
    if (mod && k === "x") return handled(), copySelection(true);
    if (mod && k === "d") return handled(), duplicate();
    if (mod && k === "a") return handled(), selectAll();
    if (mod && k === "g") return handled(), e.shiftKey ? ungroup() : group();
    if (mod && k === "0") return handled(), resetZoom();
    if (mod && (k === "=" || k === "+")) return handled(), void rf.zoomIn({ duration: 120 });
    if (mod && k === "-") return handled(), void rf.zoomOut({ duration: 120 });
    if (mod && e.shiftKey && k === "l") {
      handled();
      const sel = selectedNodes();
      if (sel.length) setLocked(!sel.every((n) => n.data.locked));
      return;
    }
    if (e.key === "]" || e.key === "[") return handled(), zOrder(e.key === "]" ? (mod ? "front" : "forward") : mod ? "back" : "backward");
    if (e.shiftKey && e.code === "Digit1") return handled(), fit();
    if (e.shiftKey && e.code === "Digit2") return handled(), zoomToSelection();
    if (e.key === "Delete" || e.key === "Backspace") return handled(), deleteSelection();
    if (e.key === "Enter" && !mod) {
      const sel = selectedNodes();
      const n = sel.length === 1 ? sel[0] : undefined;
      if (n?.type && EDITABLE.has(n.type) && !n.data.locked) {
        handled();
        updateNode(n.id, { editing: true }, false);
      }
      return;
    }
    if (e.key === "Escape") {
      // First Escape drops the tool (and its lock); the next clears the selection.
      if (tool !== "select") {
        setTool("select");
        setToolLock(false);
        return;
      }
      setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)));
      return;
    }
    if (e.key === " " && !e.repeat) return handled(), setSpacePan(true);
    if (e.key.startsWith("Arrow")) {
      const sel = selectedNodes().filter((n) => !n.data.locked);
      if (!sel.length) return;
      handled();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      const ids = new Set(sel.map((n) => n.id));
      setNodes((ns) => ns.map((n) => (ids.has(n.id) ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n)));
      requestCommit();
      return;
    }
    if (mod || e.altKey) return;
    if (k === "q") return handled(), setToolLock((l) => !l);
    const tools: Record<string, Tool> = { v: "select", h: "hand", t: "text", s: "sticky", r: `shape:${lastShape}`, p: "pen", e: "eraser", c: "connector", k: "task", a: "area", l: "link" };
    if (tools[k]) return handled(), setTool(tools[k]);
  };

  // ------------------------------------------------------------ menus
  const menuItems = (): MenuItems => {
    if (!menu) return [];
    if (menu.kind === "pane")
      return [
        { label: "Text card", icon: Type, onSelect: () => create("text", menu.flow) },
        { label: "Sticky note", icon: StickyNote, onSelect: () => create("sticky", menu.flow) },
        { label: "Task", icon: SquareCheckBig, onSelect: () => create("task", menu.flow) },
        { type: "separator" },
        memoryClipboard && { label: "Paste", icon: ClipboardPaste, shortcut: "Mod+V", onSelect: () => pasteSnap(memoryClipboard!, menu.flow) },
        { label: "Select all", shortcut: "Mod+A", onSelect: selectAll },
        { label: "Fit to content", icon: Scan, shortcut: "Shift+1", onSelect: fit },
      ];
    if (menu.kind === "edge") {
      const e = edgesRef.current.find((x) => x.id === menu.id);
      if (!e) return [];
      const d = e.data ?? {};
      return [
        {
          type: "submenu",
          label: "Direction",
          items: [
            { label: "Arrow", checked: d.directed !== false && !d.both, onSelect: () => updateEdge(e.id, { directed: true, both: false }) },
            { label: "Both ways", checked: !!d.both, onSelect: () => updateEdge(e.id, { directed: true, both: true }) },
            { label: "No arrow", checked: d.directed === false && !d.both, onSelect: () => updateEdge(e.id, { directed: false, both: false }) },
          ],
        },
        {
          type: "submenu",
          label: "Line",
          items: (["solid", "dashed", "dotted"] as const).map((l) => ({ label: l[0].toUpperCase() + l.slice(1), checked: (d.line ?? "solid") === l, onSelect: () => updateEdge(e.id, { line: l }) })),
        },
        {
          type: "submenu",
          label: "Path",
          items: (["smooth", "straight", "step"] as const).map((p) => ({ label: { smooth: "Curved", straight: "Straight", step: "Elbow" }[p], checked: (d.path ?? "smooth") === p, onSelect: () => updateEdge(e.id, { path: p }) })),
        },
        {
          label: "Route automatically",
          checked: !!d.auto,
          onSelect: () => updateEdge(e.id, { auto: !d.auto }),
        },
        // Defer past the menu's close so its focus restore doesn't blur the label input.
        { label: d.label ? "Edit label" : "Add label", icon: Pencil, onSelect: () => window.setTimeout(() => setEditingEdge(e.id), 0) },
        {
          type: "submenu",
          label: "Branch label",
          items: [
            ...BRANCH_LABELS.map((l) => ({ label: l, checked: d.label === l, onSelect: () => updateEdge(e.id, { label: d.label === l ? undefined : l }) })),
            { type: "separator" as const },
            { label: "Clear", disabled: !d.label, onSelect: () => updateEdge(e.id, { label: undefined }) },
          ],
        },
        { type: "separator" },
        {
          label: "Delete connector",
          icon: Trash,
          danger: true,
          onSelect: () => {
            setEdges((es) => es.filter((x) => x.id !== e.id));
            requestCommit();
          },
        },
      ];
    }
    const sel = selectedNodes();
    const n = nodesRef.current.find((x) => x.id === menu.id);
    if (!n) return [];
    const locked = !!n.data.locked;
    return [
      n.type === "task" && !!n.data.taskId && { label: "Open task", icon: SquareCheckBig, onSelect: () => openTask(n.data.taskId!) },
      { label: "Copy", icon: Copy, shortcut: "Mod+C", onSelect: () => copySelection() },
      { label: "Duplicate", icon: CopyPlus, shortcut: "Mod+D", onSelect: duplicate },
      { label: "Zoom to selection", icon: ScanSearch, shortcut: "Shift+2", onSelect: zoomToSelection },
      { type: "separator" },
      { label: "Bring to front", icon: BringToFront, shortcut: "Mod+]", onSelect: () => zOrder("front") },
      { label: "Send to back", icon: SendToBack, shortcut: "Mod+[", onSelect: () => zOrder("back") },
      sel.length > 1 && {
        type: "submenu",
        label: "Align",
        icon: AlignStartVertical,
        items: [
          { label: "Left", icon: AlignStartVertical, onSelect: () => align("left") },
          { label: "Centre", icon: AlignCenterVertical, onSelect: () => align("hcenter") },
          { label: "Right", icon: AlignEndVertical, onSelect: () => align("right") },
          { type: "separator" },
          { label: "Top", icon: AlignStartHorizontal, onSelect: () => align("top") },
          { label: "Middle", icon: AlignCenterHorizontal, onSelect: () => align("vcenter") },
          { label: "Bottom", icon: AlignEndHorizontal, onSelect: () => align("bottom") },
          ...(sel.length > 2
            ? [
                { type: "separator" as const },
                { label: "Distribute horizontally", onSelect: () => align("hdist") },
                { label: "Distribute vertically", onSelect: () => align("vdist") },
              ]
            : []),
        ],
      },
      { label: "Group into area", icon: Group, shortcut: "Mod+G", onSelect: group },
      (n.type === "area" || !!n.parentId) && { label: n.type === "area" ? "Ungroup" : "Remove from area", icon: Ungroup, shortcut: "Mod+Shift+G", onSelect: ungroup },
      { label: locked ? "Unlock" : "Lock", icon: locked ? LockOpen : Lock, shortcut: "Mod+Shift+L", onSelect: () => setLocked(!locked) },
      { type: "separator" },
      !locked && { label: "Delete", icon: Trash, danger: true, shortcut: "Delete", onSelect: deleteSelection },
    ];
  };

  // ------------------------------------------------------------ export
  /** Image options for the whole board (null when it's empty). */
  const imageOptions = () => {
    const vpEl = wrapper.current?.querySelector(".react-flow__viewport") as HTMLElement | null;
    if (!vpEl || !nodesRef.current.length) return null;
    const bounds = getNodesBounds(nodesRef.current);
    const pad = 48;
    const width = Math.ceil(bounds.width + pad * 2);
    const height = Math.ceil(bounds.height + pad * 2);
    const vp = getViewportForBounds(bounds, width, height, 0.05, 4, 0);
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#111111";
    return {
      vpEl,
      opts: {
        backgroundColor: bg,
        width,
        height,
        style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
        filter: (node: HTMLElement) => !node.classList?.contains("react-flow__resize-control") && !node.classList?.contains("react-flow__handle"),
      },
    };
  };

  /** The board as a PNG for a share link (at most ~2400px wide). */
  const renderForShare = async () => {
    const io = imageOptions();
    if (!io) return null;
    const ratio = Math.max(0.5, Math.min(2, 2400 / io.opts.width));
    const url = await toPng(io.vpEl, { ...io.opts, pixelRatio: ratio });
    return { base64: url.split(",")[1], mime: "image/png", width: Math.round(io.opts.width * ratio), height: Math.round(io.opts.height * ratio), objects: nodesRef.current.length };
  };

  const exportImage = async (kind: "png" | "svg" | "share") => {
    if (kind === "share") {
      flush();
      openShare({ kind: "whiteboard", refId: scene.whiteboard.id, title: scene.whiteboard.name, render: renderForShare });
      return;
    }
    const vpEl = wrapper.current?.querySelector(".react-flow__viewport") as HTMLElement | null;
    if (!vpEl || !nodesRef.current.length) return toast("Nothing to export yet");
    const name = scene.whiteboard.name.replace(/[<>:"/\\|?*]/g, "_");
    const path = await saveDialog({ defaultPath: `${name}.${kind}`, filters: [{ name: kind.toUpperCase(), extensions: [kind] }] });
    if (!path) return;
    const bounds = getNodesBounds(nodesRef.current);
    const pad = 48;
    const width = Math.ceil(bounds.width + pad * 2);
    const height = Math.ceil(bounds.height + pad * 2);
    const vp = getViewportForBounds(bounds, width, height, 0.05, 4, 0);
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#111111";
    const opts = {
      backgroundColor: bg,
      width,
      height,
      style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
      filter: (node: HTMLElement) => !node.classList?.contains("react-flow__resize-control") && !node.classList?.contains("react-flow__handle"),
    };
    try {
      if (kind === "png") {
        const url = await toPng(vpEl, { ...opts, pixelRatio: 2 });
        await api.system.writeBinary(path, url.split(",")[1]);
      } else {
        const url = await toSvg(vpEl, opts);
        await api.system.writeText(path, decodeURIComponent(url.slice(url.indexOf(",") + 1)));
      }
      toast(`Exported ${kind.toUpperCase()}`, { action: { label: "Show", run: () => void api.system.reveal(path) } });
    } catch (e) {
      toastError(describeError(e, "Export failed."));
    }
  };

  // ------------------------------------------------------------ Mermaid
  // Flowcharts travel as Mermaid text, so a board can start as something
  // somebody pasted and leave as something somebody else can read.

  const importMermaid = (chart: MermaidChart) => {
    const scene = chartToScene(chart, { x: 0, y: 0 }, { node: newNodeId, edge: newEdgeId }, edgeDefaults());
    pasteSnap(scene, viewCenter());
    toast(`Added ${scene.nodes.length} ${scene.nodes.length === 1 ? "shape" : "shapes"} from Mermaid`);
  };

  const copyMermaid = async () => {
    const { text, included, skipped } = toMermaid(nodesRef.current.map(clean), edgesRef.current);
    if (!included) return toast("Nothing here becomes a flowchart yet");
    try {
      await navigator.clipboard.writeText(text);
      toast(skipped ? `Copied ${included} as Mermaid; ${skipped} object${skipped === 1 ? "" : "s"} have no equivalent` : `Copied ${included} ${included === 1 ? "shape" : "shapes"} as Mermaid`);
    } catch (e) {
      toastError(describeError(e, "Couldn't copy to the clipboard."));
    }
  };

  const exportJson = async () => {
    flush();
    const name = scene.whiteboard.name.replace(/[<>:"/\\|?*]/g, "_");
    const path = await saveDialog({ defaultPath: `${name}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    const rec = toRecords(nodesRef.current.map(clean), edgesRef.current);
    const doc = { format: "kern-whiteboard", formatVersion: 1, whiteboard: { ...scene.whiteboard, viewport: rf.getViewport() }, nodes: rec.nodes, edges: rec.edges };
    await api.system.writeText(path, JSON.stringify(doc, null, 2));
    toast("Exported JSON", { action: { label: "Show", run: () => void api.system.reveal(path) } });
  };

  // Must be stable: React Flow re-invokes it whenever its identity changes.
  const onSelectionChange = useCallback((p: OnSelectionChangeParams<WbNode, WbEdge>) => {
    const next = { nodes: p.nodes.map((n) => n.id), edges: p.edges.map((e) => e.id) };
    setSelection((prev) => (prev.nodes.join() === next.nodes.join() && prev.edges.join() === next.edges.join() ? prev : next));
  }, []);

  // ------------------------------------------------------------ presence
  const sharePresence = useSetting("cloud.sharePresence") && shared;
  const view = `wb:${wbId}`;
  const cursorAt = useRef<Pt | null>(null);
  const selectionRef = useRef<string[]>([]);
  selectionRef.current = selection.nodes;
  const announce = useCallback(
    (cursor: Pt | null) => {
      cursorAt.current = cursor;
      if (sharePresence) setPresence({ view, label: scene.whiteboard.name, cursor, selection: selectionRef.current });
    },
    [sharePresence, view, scene.whiteboard.name],
  );
  useEffect(() => {
    announce(cursorAt.current);
  }, [selection.nodes, announce]);
  useEffect(() => () => setPresence(null), []);
  const boxOf = (id: string) => {
    const all = nodesRef.current;
    const n = all.find((x) => x.id === id);
    if (!n) return null;
    const p = absolutePosition(n, new Map(all.map((x) => [x.id, x])));
    const { w, h } = sizeOf(n);
    return { x: p.x, y: p.y, w, h };
  };

  // ------------------------------------------------------------ render
  // Automatic connectors re-point at the sides their objects now face, which
  // means re-deriving them on every drag frame. The cache keeps the object
  // identity of edges that did not actually change, so React Flow carries on
  // skipping their re-render.
  const edgeCache = useRef(new Map<string, { from: WbEdge; out: WbEdge }>());
  const displayEdges = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const next = new Map<string, { from: WbEdge; out: WbEdge }>();
    const out = edges.map((e) => {
      const routed = autoRoute(e, byId);
      const hit = edgeCache.current.get(e.id);
      const display = hit && hit.from === routed ? hit.out : withMarkers(routed, e.selected ? "var(--text)" : "var(--text-3)");
      next.set(e.id, { from: routed, out: display });
      return display;
    });
    edgeCache.current = next;
    return out;
  }, [edges, nodes]);
  const transform = useStore((st) => st.transform);
  const placing = tool !== "select" && tool !== "hand" && tool !== "connector" && tool !== "pen" && tool !== "eraser";
  const panWithLeft = tool === "hand" || spacePan;
  const drawLayer = (placing || tool === "pen" || tool === "eraser") && !spacePan;
  const limited = s["wb.limitEffects"];

  const draftPreview = () => {
    if (!draft) return null;
    const ink = "var(--accent-line)";
    if (draft.kind === "ink")
      return <path d={inkPath(draft.points)} fill="none" stroke={colorVar(pen.color, "var(--text)")} strokeWidth={pen.width} strokeLinecap="round" strokeLinejoin="round" />;
    const { a, b } = draft;
    const common = { fill: "var(--accent-soft)", stroke: ink, strokeWidth: 1.5 / transform[2], strokeDasharray: `${5 / transform[2]} ${4 / transform[2]}` };
    if (isLineTool(tool)) return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...common} />;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    if (tool === "shape:circle") return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
    if (tool.startsWith("shape:"))
      return <g transform={`translate(${x} ${y})`}>{shapeFigure(tool.slice(6) as ShapeKind, w, h, common)}</g>;
    return <rect x={x} y={y} width={w} height={h} rx={10} {...common} />;
  };

  return (
    <WbContext.Provider value={nodeApi}>
      <EdgeApiContext.Provider value={edgeApi}>
        <CM.Root modal={false} onOpenChange={(o) => !o && setMenu(null)}>
          <CM.Trigger asChild disabled={readOnly}>
            <div
              ref={wrapper}
              className="wb"
              data-tool={panWithLeft ? "hand" : tool === "connector" || tool === "pen" || tool === "eraser" ? tool : "select"}
              data-placing={placing || undefined}
              data-effects={limited ? "limited" : undefined}
              data-lod={transform[2] < 0.4 ? "low" : undefined}
              tabIndex={0}
              onKeyDown={onKeyDown}
              onKeyUp={(e) => e.key === " " && setSpacePan(false)}
              onMouseMove={(e) => {
                pointer.current = { x: e.clientX, y: e.clientY };
                if (sharePresence) announce(flowAt(e.clientX, e.clientY));
              }}
              onMouseLeave={() => sharePresence && announce(null)}
              onDoubleClick={onDoubleClick}
            >
              <ReactFlow<WbNode, WbEdge>
                attributionPosition="bottom-left"
                nodes={nodes}
                edges={displayEdges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onReconnect={onReconnect}
                edgesReconnectable={!readOnly}
                nodesDraggable={!readOnly}
                nodesConnectable={!readOnly}
                onNodeDragStop={onNodeDragStop}
                onPaneClick={onPaneClick}
                onSelectionChange={onSelectionChange}
                onNodeContextMenu={(e, n) => {
                  if (!n.selected) setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === n.id })));
                  setMenu({ kind: "node", id: n.id, flow: flowAt(e.clientX, e.clientY) });
                }}
                onEdgeContextMenu={(e, ed) => setMenu({ kind: "edge", id: ed.id, flow: flowAt(e.clientX, e.clientY) })}
                onEdgeDoubleClick={(_, ed) => setEditingEdge(ed.id)}
                onPaneContextMenu={(e) => setMenu({ kind: "pane", flow: flowAt(e.clientX, e.clientY) })}
                onMoveEnd={(_: unknown, vp: RFViewport) => {
                  void api.whiteboards.update(wbId, { viewport: vp as Viewport }).catch(() => undefined);
                }}
                connectionMode={ConnectionMode.Loose}
                selectionMode={SelectionMode.Partial}
                selectionOnDrag={!panWithLeft && tool !== "connector"}
                panOnDrag={panWithLeft ? true : [1]}
                panOnScroll={false}
                zoomOnScroll={false}
                zoomOnPinch={false}
                zoomOnDoubleClick={false}
                preventScrolling
                multiSelectionKeyCode="Shift"
                deleteKeyCode={null}
                snapToGrid={s["wb.snapToGrid"]}
                snapGrid={[s["wb.gridSize"], s["wb.gridSize"]]}
                minZoom={0.1}
                maxZoom={4}
                onlyRenderVisibleElements={nodes.length > 150}
                elevateNodesOnSelect={false}
                defaultEdgeOptions={{ type: "wb" }}
              >
                {s["wb.showGrid"] && <Background variant={BackgroundVariant.Dots} gap={s["wb.gridSize"]} size={1.2} color="var(--border-strong)" />}
                {showMap && !limited && <MiniMap pannable zoomable position="bottom-right" nodeBorderRadius={6} />}
              </ReactFlow>
              {(guides.x !== undefined || guides.y !== undefined) && (
                <svg className="helper-lines">
                  {guides.x !== undefined && <line x1={guides.x * transform[2] + transform[0]} x2={guides.x * transform[2] + transform[0]} y1={0} y2="100%" stroke="var(--accent-line)" strokeDasharray="4 3" />}
                  {guides.y !== undefined && <line y1={guides.y * transform[2] + transform[1]} y2={guides.y * transform[2] + transform[1]} x1={0} x2="100%" stroke="var(--accent-line)" strokeDasharray="4 3" />}
                </svg>
              )}
              {drawLayer && (
                <div
                  className="wb-draw-layer"
                  onPointerDown={onLayerDown}
                  onPointerMove={onLayerMove}
                  onPointerUp={onLayerUp}
                  onPointerCancel={() => {
                    gesture.current = null;
                    setDraft(null);
                  }}
                  onPointerLeave={() => setEraserAt(null)}
                  onContextMenu={(e) => setMenu({ kind: "pane", flow: flowAt(e.clientX, e.clientY) })}
                >
                  <svg>
                    <g transform={`translate(${transform[0]} ${transform[1]}) scale(${transform[2]})`}>{draftPreview()}</g>
                    {eraserAt && <circle className="wb-eraser" cx={eraserAt.x} cy={eraserAt.y} r={8} />}
                  </svg>
                </div>
              )}
              <WhiteboardPresence view={view} transform={transform as [number, number, number]} boxOf={boxOf} />
              {(shared || readOnly) && (
                <div className="wb-collab">
                  {readOnly && <span className="chip chip--outline">View only</span>}
                  <PeerStack view={view} />
                </div>
              )}
              {!nodes.length && (
                <div className="wb-empty">
                  <div>
                    <Presentation size={22} strokeWidth={1.5} />
                    <span>Double-click anywhere to add a card, or pick a tool below.</span>
                    <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>Drop images or files here · paste text, links or images</span>
                  </div>
                </div>
              )}
              <TopBar
                zoom={transform[2]}
                onZoomIn={() => void rf.zoomIn({ duration: 120 })}
                onZoomOut={() => void rf.zoomOut({ duration: 120 })}
                onResetZoom={resetZoom}
                onFit={fit}
                showMap={showMap}
                onToggleMap={() => setShowMap(!showMap)}
                onExport={(k) => (k === "json" ? void exportJson() : k === "mermaid" ? void copyMermaid() : void exportImage(k))}
                onImport={async (kind) => {
                  if (kind === "mermaid") return setMermaidOpen(true);
                  const f = await openDialog({ filters: [{ name: "Whiteboard JSON", extensions: ["json"] }] });
                  if (typeof f !== "string") return;
                  try {
                    const doc = JSON.parse(await api.system.readText(f)) as { nodes: unknown[]; edges: unknown[] };
                    const imported = fromRecords(doc.nodes as never, doc.edges as never);
                    pasteSnap(imported, viewCenter());
                  } catch (e) {
                    toastError(describeError(e, "That file isn't a whiteboard export."));
                  }
                }}
              />
              <MermaidDialog open={mermaidOpen} onOpenChange={setMermaidOpen} onImport={importMermaid} />
              {!readOnly && (selection.nodes.length > 0 || selection.edges.length > 0) && (
                <PropsPanel
                  nodes={nodes.filter((n) => selection.nodes.includes(n.id))}
                  edges={edges.filter((e) => selection.edges.includes(e.id))}
                  onUpdateNode={updateNode}
                  onUpdateNodes={updateNodes}
                  onUpdateEdge={updateEdge}
                  onAlign={align}
                  onGroup={group}
                  onUngroup={ungroup}
                  onZ={zOrder}
                  onLock={setLocked}
                  onDelete={deleteSelection}
                />
              )}
              {!readOnly && <Toolbar
                tool={tool}
                onTool={setTool}
                lastShape={lastShape}
                locked={toolLock}
                onToggleLock={() => setToolLock(!toolLock)}
                pen={pen}
                onPen={setPen}
                onImage={() => void pickImage()}
                onFile={() => void pickFile()}
                onInsert={(t) => placeTool(t, viewCenter())}
                canUndo={past.current.length > 0}
                canRedo={future.current.length > 0}
                onUndo={undo}
                onRedo={redo}
              />}
            </div>
          </CM.Trigger>
          <CM.Portal>
            <CM.Content className="menu" collisionPadding={8}>
              <MenuContent kind="context" items={menuItems()} />
            </CM.Content>
          </CM.Portal>
        </CM.Root>
      </EdgeApiContext.Provider>
    </WbContext.Provider>
  );
}

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

async function imageSize(absPath: string): Promise<{ w: number; h: number }> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 320, h: img.naturalHeight || 220 });
    img.onerror = () => resolve({ w: 320, h: 220 });
    img.src = convertFileSrc(absPath);
  });
}
