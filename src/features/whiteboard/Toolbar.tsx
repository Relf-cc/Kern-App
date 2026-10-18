/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import {
  ArrowRight,
  ChevronUp,
  Circle,
  Download,
  Eraser,
  FileText,
  File,
  FolderKanban,
  Frame,
  Globe,
  Hand,
  Image,
  Lock,
  LockOpen,
  Map as MapIcon,
  Minus,
  MousePointer2,
  Pen,
  Plus,
  Redo2,
  Scan,
  Spline,
  Square,
  SquareCheckBig,
  SquareKanban,
  StickyNote,
  Type,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
  Ellipsis,
  RectangleHorizontal,
  Flag,
  Diamond,
  Cylinder,
  Copy,
  ClipboardPaste,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import { forwardRef } from "react";
import { IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { Segmented } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { WB_COLORS, type ShapeKind, type WbColor } from "./model";

export type { ShapeKind };

/**
 * Icons for the flowchart shapes lucide has no match for. Each one is the
 * shape itself, drawn to lucide's proportions so the picker reads at a
 * glance.
 */
const shapeIcon = (name: string, d: string): LucideIcon => {
  const Icon = forwardRef<SVGSVGElement, LucideProps>(({ size, strokeWidth = 2, ...rest }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      <path d={d} />
    </svg>
  ));
  Icon.displayName = name;
  return Icon as unknown as LucideIcon;
};

const StadiumIcon = shapeIcon("Stadium", "M8 6h8a6 6 0 0 1 0 12H8A6 6 0 0 1 8 6Z");
const ParallelogramIcon = shapeIcon("Parallelogram", "M8 6h13l-5 12H3Z");
const FlowHexagonIcon = shapeIcon("FlowHexagon", "M7 6h10l4 6-4 6H7l-4-6Z");
const DocumentIcon = shapeIcon("Document", "M3 5h18v11c-3 0-4.5 2.5-9 2.5S6 16 3 16Z");

export type Tool =
  | "select"
  | "hand"
  | "text"
  | "sticky"
  | "connector"
  | "task"
  | "area"
  | "link"
  | "project"
  | "board"
  | "note"
  | "milestone"
  | "pen"
  | "eraser"
  | `shape:${ShapeKind}`;

export interface ShapeOption {
  value: ShapeKind;
  label: string;
  icon: LucideIcon;
  /** What the shape means on a flowchart, where it has one. */
  hint?: string;
}

/** The general-purpose shapes, offered first. */
export const BASIC_SHAPES: ShapeOption[] = [
  { value: "rect", label: "Rectangle", icon: Square },
  { value: "rounded", label: "Rounded rectangle", icon: RectangleHorizontal },
  { value: "circle", label: "Circle", icon: Circle },
  { value: "line", label: "Line", icon: Minus },
  { value: "arrow", label: "Arrow", icon: ArrowRight },
];

/** The standard flowchart vocabulary. */
export const FLOW_SHAPES: ShapeOption[] = [
  { value: "stadium", label: "Terminator", icon: StadiumIcon, hint: "Start or end" },
  { value: "diamond", label: "Decision", icon: Diamond, hint: "Branch on a question" },
  { value: "parallelogram", label: "Data", icon: ParallelogramIcon, hint: "Input or output" },
  { value: "hexagon", label: "Preparation", icon: FlowHexagonIcon, hint: "Set-up step" },
  { value: "cylinder", label: "Database", icon: Cylinder, hint: "Stored data" },
  { value: "document", label: "Document", icon: DocumentIcon, hint: "Printed or written output" },
];

export const SHAPES: ShapeOption[] = [...BASIC_SHAPES, ...FLOW_SHAPES];

export const PEN_WIDTHS = [
  { value: "2", label: "Fine" },
  { value: "4", label: "Medium" },
  { value: "8", label: "Bold" },
] as const;

const stop = (e: React.SyntheticEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

/** Colour swatches shared by the pen options and the properties panel. */
export function Swatches({ value, onChange }: { value: WbColor | undefined; onChange: (c: WbColor) => void }) {
  const current = value ?? "default";
  return (
    <div className="wb-swatches" role="radiogroup" aria-label="Colour">
      {WB_COLORS.map((c) => (
        <Tooltip key={c.value} content={c.label} side="top">
          <button
            type="button"
            role="radio"
            aria-checked={current === c.value}
            aria-label={c.label}
            className="wb-swatch"
            data-state={current === c.value ? "on" : "off"}
            style={{ "--swatch": c.css } as React.CSSProperties}
            onClick={() => onChange(c.value)}
          />
        </Tooltip>
      ))}
    </div>
  );
}

export function Toolbar({
  tool,
  onTool,
  lastShape,
  locked,
  onToggleLock,
  pen,
  onPen,
  onImage,
  onFile,
  onInsert,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  tool: Tool;
  onTool: (t: Tool) => void;
  lastShape: ShapeKind;
  locked: boolean;
  onToggleLock: () => void;
  pen: { color: WbColor; width: number };
  onPen: (p: Partial<{ color: WbColor; width: number }>) => void;
  onImage: () => void;
  onFile: () => void;
  onInsert: (t: Tool) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const btn = (t: Tool, icon: typeof Type, label: string, key: string) => (
    <IconButton icon={icon} label={label} shortcut={key} tooltipSide="top" active={tool === t} onClick={() => onTool(t)} />
  );
  const shapeActive = tool.startsWith("shape:");
  const shown = SHAPES.find((x) => x.value === (shapeActive ? tool.slice(6) : lastShape)) ?? SHAPES[1];
  return (
    <div className="wb-dock" onContextMenu={stop} onDoubleClick={(e) => e.stopPropagation()}>
      {tool === "pen" && (
        <div className="wb-toolopts" role="group" aria-label="Pen options">
          <Swatches value={pen.color} onChange={(color) => onPen({ color })} />
          <span className="sep" />
          <Segmented size="sm" ariaLabel="Stroke width" value={String(pen.width) as "2" | "4" | "8"} onChange={(v) => onPen({ width: Number(v) })} options={[...PEN_WIDTHS]} />
        </div>
      )}
      <div className="wb-toolbar" role="toolbar" aria-label="Whiteboard tools">
        {btn("select", MousePointer2, "Select", "V")}
        {btn("hand", Hand, "Hand · hold Space", "H")}
        <span className="sep" />
        {btn("text", Type, "Text card", "T")}
        {btn("sticky", StickyNote, "Sticky note", "S")}
        <span className="wb-split">
          <IconButton icon={shown.icon} label={`${shown.label} - click or drag to draw`} shortcut="R" tooltipSide="top" active={shapeActive} onClick={() => onTool(`shape:${shown.value}`)} />
          <Dropdown
            side="top"
            items={[
              ...BASIC_SHAPES.map((x) => ({ label: x.label, icon: x.icon, checked: shown.value === x.value, onSelect: () => onTool(`shape:${x.value}`) })),
              { type: "separator" as const },
              { type: "label" as const, label: "Flowchart" },
              ...FLOW_SHAPES.map((x) => ({ label: x.label, icon: x.icon, checked: shown.value === x.value, onSelect: () => onTool(`shape:${x.value}`) })),
            ]}
          >
            <button type="button" className="wb-split__caret" aria-label="Choose shape">
              <ChevronUp strokeWidth={2} />
            </button>
          </Dropdown>
        </span>
        {btn("pen", Pen, "Pen", "P")}
        {btn("eraser", Eraser, "Eraser - drag across pen strokes", "E")}
        {btn("connector", Spline, "Connector - drag between objects", "C")}
        {btn("task", SquareCheckBig, "Task card", "K")}
        {btn("area", Frame, "Area - click or drag to draw", "A")}
        <Dropdown
          side="top"
          items={[
            { label: "Image…", icon: Image, onSelect: onImage },
            { label: "Link", icon: Globe, shortcut: "L", onSelect: () => onInsert("link") },
            { label: "File reference…", icon: File, onSelect: onFile },
            { type: "separator" },
            { label: "Note", icon: FileText, onSelect: () => onInsert("note") },
            { label: "Project", icon: FolderKanban, onSelect: () => onInsert("project") },
            { label: "Board", icon: SquareKanban, onSelect: () => onInsert("board") },
            { label: "Milestone", icon: Flag, onSelect: () => onInsert("milestone") },
          ]}
        >
          <span>
            <Tooltip content="Insert" side="top">
              <button type="button" className="icon-btn" aria-label="Insert">
                <Plus strokeWidth={1.75} />
              </button>
            </Tooltip>
          </span>
        </Dropdown>
        <span className="sep" />
        <IconButton icon={locked ? Lock : LockOpen} label={locked ? "Tool stays active - click to release" : "Keep tool active"} shortcut="Q" tooltipSide="top" active={locked} onClick={onToggleLock} />
        <IconButton icon={Undo2} label="Undo" shortcut="Mod+Z" tooltipSide="top" disabled={!canUndo} onClick={onUndo} />
        <IconButton icon={Redo2} label="Redo" shortcut="Mod+Y" tooltipSide="top" disabled={!canRedo} onClick={onRedo} />
      </div>
    </div>
  );
}

export function TopBar({
  zoom,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onFit,
  showMap,
  onToggleMap,
  onExport,
  onImport,
}: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onFit: () => void;
  showMap: boolean;
  onToggleMap: () => void;
  onExport: (kind: "png" | "svg" | "json" | "share" | "mermaid") => void;
  onImport: (kind: "json" | "mermaid") => void;
}) {
  return (
    <div className="wb-topbar" onContextMenu={stop} onDoubleClick={(e) => e.stopPropagation()}>
      <IconButton icon={ZoomOut} label="Zoom out" shortcut="Mod+-" size="sm" onClick={onZoomOut} />
      <button type="button" className="wb-zoom" onClick={onResetZoom} title="Reset to 100%">
        {Math.round(zoom * 100)}%
      </button>
      <IconButton icon={ZoomIn} label="Zoom in" shortcut="Mod+=" size="sm" onClick={onZoomIn} />
      <IconButton icon={Scan} label="Fit to content" shortcut="Shift+1" size="sm" onClick={onFit} />
      <IconButton icon={MapIcon} label={showMap ? "Hide minimap" : "Show minimap"} size="sm" active={showMap} onClick={onToggleMap} />
      <Dropdown
        align="end"
        items={[
          { label: "Share link…", icon: Globe, onSelect: () => onExport("share") },
          { type: "separator" },
          { label: "Export PNG…", icon: Download, onSelect: () => onExport("png") },
          { label: "Export SVG…", icon: Download, onSelect: () => onExport("svg") },
          { label: "Export JSON…", icon: Download, onSelect: () => onExport("json") },
          { label: "Copy as Mermaid", icon: Copy, onSelect: () => onExport("mermaid") },
          { type: "separator" },
          { label: "Import JSON…", icon: Upload, onSelect: () => onImport("json") },
          { label: "Paste Mermaid…", icon: ClipboardPaste, onSelect: () => onImport("mermaid") },
        ]}
      >
        <IconButton icon={Ellipsis} label="Export & import" size="sm" noTooltip />
      </Dropdown>
    </div>
  );
}
