/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  BringToFront,
  Group,
  Lock,
  LockOpen,
  SendToBack,
  Trash,
  Ungroup,
  FlipHorizontal2,
  ArrowLeftRight,
} from "lucide-react";
import { COLORABLE, type WbData, type WbEdge, type WbEdgeData, type WbNode } from "./model";
import { BASIC_SHAPES, FLOW_SHAPES, PEN_WIDTHS, Swatches } from "./Toolbar";
import { IconButton } from "@/components/ui/Button";
import { Segmented, Select, Switch } from "@/components/ui/Controls";

const TYPE_LABEL: Record<string, string> = {
  text: "Text card",
  sticky: "Sticky note",
  task: "Task",
  image: "Image",
  shape: "Shape",
  area: "Area",
  link: "Link",
  file: "File",
  project: "Project",
  board: "Board",
  note: "Note",
  milestone: "Milestone",
  draw: "Drawing",
};

/** Floating properties for the current whiteboard selection. */
export function PropsPanel({
  nodes,
  edges,
  onUpdateNode,
  onUpdateNodes,
  onUpdateEdge,
  onAlign,
  onGroup,
  onUngroup,
  onZ,
  onLock,
  onDelete,
}: {
  nodes: WbNode[];
  edges: WbEdge[];
  onUpdateNode: (id: string, patch: Partial<WbData>) => void;
  onUpdateNodes: (ids: string[], patch: Partial<WbData>) => void;
  onUpdateEdge: (id: string, patch: Partial<WbEdgeData>) => void;
  onAlign: (m: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom" | "hdist" | "vdist") => void;
  onGroup: () => void;
  onUngroup: () => void;
  onZ: (d: "front" | "back" | "forward" | "backward") => void;
  onLock: (locked: boolean) => void;
  onDelete: () => void;
}) {
  const single = nodes.length === 1 ? nodes[0] : null;
  const edge = !nodes.length && edges.length === 1 ? edges[0] : null;
  const allLocked = nodes.length > 0 && nodes.every((n) => n.data.locked);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const colorable = nodes.filter((n) => n.type && COLORABLE.has(n.type));
  const sharedColor = colorable.length && colorable.every((n) => (n.data.color ?? "default") === (colorable[0].data.color ?? "default")) ? colorable[0].data.color : undefined;

  return (
    <div className="wb-props" onDoubleClick={stop} onContextMenu={(e) => e.preventDefault()} onKeyDown={stop}>
      <div className="wb-props__title">
        {single ? TYPE_LABEL[single.type ?? "text"] : edge ? "Connector" : `${nodes.length || edges.length} selected`}
      </div>

      {single?.type === "sticky" && (
        <Field label="Tone">
          <Segmented
            size="sm"
            value={single.data.tone ?? "plain"}
            onChange={(v) => onUpdateNode(single.id, { tone: v })}
            options={[
              { value: "plain", label: "Plain" },
              { value: "warm", label: "Warm" },
              { value: "cool", label: "Cool" },
            ]}
          />
        </Field>
      )}

      {colorable.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          <span className="faint">Colour</span>
          <Swatches value={sharedColor} onChange={(color) => onUpdateNodes(colorable.map((n) => n.id), { color })} />
        </div>
      )}

      {single?.type === "draw" && (
        <Field label="Width">
          <Segmented
            size="sm"
            value={String(single.data.strokeWidth ?? 4) as "2" | "4" | "8"}
            onChange={(v) => onUpdateNode(single.id, { strokeWidth: Number(v) })}
            options={[...PEN_WIDTHS]}
          />
        </Field>
      )}

      {single?.type === "shape" && (
        <>
          <Field label="Shape">
            <Select
              value={single.data.shape ?? "rounded"}
              onChange={(v) => onUpdateNode(single.id, { shape: v })}
              ariaLabel="Shape"
              style={{ minWidth: 148 }}
              options={[
                ...BASIC_SHAPES.map((x) => ({ value: x.value, label: x.label })),
                ...FLOW_SHAPES.map((x) => ({ value: x.value, label: `${x.label} - ${x.hint}` })),
              ]}
            />
          </Field>
          <Field label="Stroke">
            <Segmented
              size="sm"
              value={single.data.stroke ?? "solid"}
              onChange={(v) => onUpdateNode(single.id, { stroke: v })}
              options={[
                { value: "solid", label: "Solid" },
                { value: "dashed", label: "Dashed" },
              ]}
            />
          </Field>
          {single.data.shape === "line" || single.data.shape === "arrow" ? (
            <Field label="Direction">
              <span className="row" style={{ gap: 2 }}>
                <IconButton icon={FlipHorizontal2} label="Flip" size="sm" onClick={() => onUpdateNode(single.id, { flip: !single.data.flip })} />
                {single.data.shape === "arrow" && <IconButton icon={ArrowLeftRight} label="Reverse arrow" size="sm" onClick={() => onUpdateNode(single.id, { reverse: !single.data.reverse })} />}
              </span>
            </Field>
          ) : (
            <Field label="Fill">
              <Switch checked={!!single.data.fill} onChange={(v) => onUpdateNode(single.id, { fill: v })} label="Fill" />
            </Field>
          )}
        </>
      )}

      {single?.type === "area" && (
        <>
          <div className="col" style={{ gap: 4 }}>
            <span className="faint">Label</span>
            <input className="input" style={{ height: 28 }} value={single.data.label ?? ""} onChange={(e) => onUpdateNode(single.id, { label: e.target.value })} />
          </div>
          <Field label="Style">
            <Segmented
              size="sm"
              value={single.data.areaFill ?? "dashed"}
              onChange={(v) => onUpdateNode(single.id, { areaFill: v })}
              options={[
                { value: "dashed", label: "Outline" },
                { value: "solid", label: "Filled" },
              ]}
            />
          </Field>
        </>
      )}

      {edge && (
        <>
          <div className="col" style={{ gap: 6 }}>
            <span className="faint">Colour</span>
            <Swatches value={edge.data?.color} onChange={(color) => onUpdateEdge(edge.id, { color })} />
          </div>
          <Field label="Arrow">
            <Segmented
              size="sm"
              value={edge.data?.both ? "both" : edge.data?.directed === false ? "none" : "end"}
              onChange={(v) => onUpdateEdge(edge.id, { directed: v !== "none", both: v === "both" })}
              options={[
                { value: "none", label: "None" },
                { value: "end", label: "→" },
                { value: "both", label: "↔" },
              ]}
            />
          </Field>
          <Field label="Line">
            <Segmented
              size="sm"
              value={edge.data?.line ?? "solid"}
              onChange={(v) => onUpdateEdge(edge.id, { line: v })}
              options={[
                { value: "solid", label: "Solid" },
                { value: "dashed", label: "Dash" },
                { value: "dotted", label: "Dot" },
              ]}
            />
          </Field>
          <Field label="Path">
            <Segmented
              size="sm"
              value={edge.data?.path ?? "smooth"}
              onChange={(v) => onUpdateEdge(edge.id, { path: v })}
              options={[
                { value: "smooth", label: "Curve" },
                { value: "straight", label: "Line" },
                { value: "step", label: "Elbow" },
              ]}
            />
          </Field>
          <Field label="Routing">
            <Switch
              checked={!!edge.data?.auto}
              onChange={(v) => onUpdateEdge(edge.id, { auto: v })}
              label="Follow the sides the objects face"
            />
          </Field>
          <div className="col" style={{ gap: 4 }}>
            <span className="faint">Label</span>
            <input className="input" style={{ height: 28 }} value={edge.data?.label ?? ""} placeholder="None" onChange={(e) => onUpdateEdge(edge.id, { label: e.target.value || undefined })} />
          </div>
        </>
      )}

      {nodes.length > 1 && (
        <div className="col" style={{ gap: 4 }}>
          <span className="faint">Align</span>
          <div className="wb-props__grid">
            <IconButton icon={AlignStartVertical} label="Align left" size="sm" onClick={() => onAlign("left")} />
            <IconButton icon={AlignCenterVertical} label="Align centre" size="sm" onClick={() => onAlign("hcenter")} />
            <IconButton icon={AlignEndVertical} label="Align right" size="sm" onClick={() => onAlign("right")} />
            <IconButton icon={AlignStartHorizontal} label="Align top" size="sm" onClick={() => onAlign("top")} />
            <IconButton icon={AlignCenterHorizontal} label="Align middle" size="sm" onClick={() => onAlign("vcenter")} />
            <IconButton icon={AlignEndHorizontal} label="Align bottom" size="sm" onClick={() => onAlign("bottom")} />
            {nodes.length > 2 && (
              <>
                <IconButton icon={AlignHorizontalDistributeCenter} label="Distribute horizontally" size="sm" onClick={() => onAlign("hdist")} />
                <IconButton icon={AlignVerticalDistributeCenter} label="Distribute vertically" size="sm" onClick={() => onAlign("vdist")} />
              </>
            )}
          </div>
        </div>
      )}

      {nodes.length > 0 && (
        <div className="wb-props__grid" style={{ borderTop: "1px solid var(--divider)", paddingTop: 8 }}>
          <IconButton icon={BringToFront} label="Bring to front" size="sm" onClick={() => onZ("front")} />
          <IconButton icon={SendToBack} label="Send to back" size="sm" onClick={() => onZ("back")} />
          <IconButton icon={Group} label="Group into area" shortcut="Mod+G" size="sm" onClick={onGroup} />
          {(single?.type === "area" || nodes.some((n) => n.parentId)) && <IconButton icon={Ungroup} label="Ungroup" shortcut="Mod+Shift+G" size="sm" onClick={onUngroup} />}
          <IconButton icon={allLocked ? LockOpen : Lock} label={allLocked ? "Unlock" : "Lock"} size="sm" active={allLocked} onClick={() => onLock(!allLocked)} />
          {!allLocked && <IconButton icon={Trash} label="Delete" shortcut="Delete" size="sm" onClick={onDelete} />}
        </div>
      )}
      {edge && (
        <div className="wb-props__grid" style={{ borderTop: "1px solid var(--divider)", paddingTop: 8 }}>
          <IconButton icon={Trash} label="Delete connector" size="sm" onClick={onDelete} />
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="wb-props__row">
      <span className="faint">{label}</span>
      {children}
    </div>
  );
}
