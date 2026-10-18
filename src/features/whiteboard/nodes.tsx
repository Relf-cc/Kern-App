/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { createContext, memo, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { assetUrl } from "@/lib/platform";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useCloud } from "@/features/cloud/store";
import { useQuery } from "@tanstack/react-query";
import {
  ExternalLink,
  File as FileIcon,
  FileText,
  FileWarning,
  FolderKanban,
  FolderOpen,
  Globe,
  ImageOff,
  Image as ImageIcon,
  SquareCheckBig,
  SquareKanban,
  Flag,
} from "lucide-react";
import { colorVar, type WbData, type WbNode } from "./model";
import { inkPath } from "./ink";
import { useAppInfo, useNotes, useProjectMap, useProjects, useTask } from "@/hooks/data";
import { api } from "@/lib/ipc";
import { TaskCheck, TaskTitle, Progress, Select } from "@/components/ui/Controls";
import { Favicon, displayUrl } from "@/features/links/links";
import { toggleComplete, createTask } from "@/features/tasks/actions";
import { openTask } from "@/features/tasks/menu";
import { DueLabel } from "@/features/tasks/TaskRow";
import { PriorityIcon } from "@/features/tasks/meta";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { useToday } from "@/hooks/useToday";
import { navigate } from "@/stores/router";
import { IconButton } from "@/components/ui/Button";
import { getSetting } from "@/stores/settings";
import { useMilestone } from "@/features/dev/hooks";
import { openMilestone } from "@/features/milestones/actions";

// ------------------------------------------------------------- context

export interface WbApi {
  update: (id: string, patch: Partial<WbData>, commit?: boolean) => void;
  projectId: string | null;
}

export const WbContext = createContext<WbApi>({ update: () => undefined, projectId: null });
const useWb = () => useContext(WbContext);

// ------------------------------------------------------------- helpers

function Handles() {
  return (
    <>
      <Handle id="t" type="source" position={Position.Top} />
      <Handle id="r" type="source" position={Position.Right} />
      <Handle id="b" type="source" position={Position.Bottom} />
      <Handle id="l" type="source" position={Position.Left} />
    </>
  );
}

function Resizer({ selected, data, min = [80, 40], keepAspect }: { selected: boolean; data: WbData; min?: [number, number]; keepAspect?: boolean }) {
  return <NodeResizer isVisible={selected && !data.locked} minWidth={min[0]} minHeight={min[1]} keepAspectRatio={keepAspect} />;
}

/** Inline markdown-lite: checklists, bold/italic, links. */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<b key={i++}>{tok.slice(2, -2)}</b>);
    else if (tok.startsWith("`")) out.push(<code key={i++} className="mono">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("*")) out.push(<i key={i++}>{tok.slice(1, -1)}</i>);
    else
      out.push(
        <a
          key={i++}
          href={tok}
          className="nodrag"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void api.system.open(tok);
          }}
        >
          {tok}
        </a>,
      );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownLite({ text, onToggle }: { text: string; onToggle?: (lineIndex: number) => void }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, idx) => {
        const check = line.match(/^\s*[-*] \[( |x|X)\] (.*)$/);
        if (check) {
          const done = check[1].toLowerCase() === "x";
          return (
            <div key={idx} className="md-check" data-done={done}>
              <input type="checkbox" className="nodrag" checked={done} onChange={() => onToggle?.(idx)} onClick={(e) => e.stopPropagation()} />
              <span>{renderInline(check[2])}</span>
            </div>
          );
        }
        const h = line.match(/^#{1,3} (.*)$/);
        if (h) return <p key={idx} style={{ fontWeight: 600, color: "var(--text)" }}>{renderInline(h[1])}</p>;
        const li = line.match(/^\s*[-*] (.*)$/);
        if (li) return <p key={idx}>• {renderInline(li[1])}</p>;
        return <p key={idx}>{line ? renderInline(line) : " "}</p>;
      })}
    </>
  );
}

function toggleLine(text: string, idx: number) {
  const lines = text.split("\n");
  lines[idx] = lines[idx].replace(/\[( |x|X)\]/, (m) => (m === "[ ]" ? "[x]" : "[ ]"));
  return lines.join("\n");
}

/** Inline-edit state. `data.editing` (set on creation, or by Enter on a selection) opens the editor. */
function useEditing(id: string, data: WbData, onStart?: () => void) {
  const { update } = useWb();
  const [editing, setEditing] = useState(!!data.editing);
  useEffect(() => {
    if (!data.editing) return;
    if (!data.locked) {
      onStart?.();
      setEditing(true);
    }
    update(id, { editing: undefined }, false);
  }, [data.editing]);
  return [editing, setEditing] as const;
}

/** Exposes a node's ink colour to CSS as --wb-ink. */
const inkStyle = (data: WbData) => (data.color && data.color !== "default" ? ({ "--wb-ink": colorVar(data.color) } as CSSProperties) : undefined);

// ------------------------------------------------------------- text card

export const TextNode = memo(function TextNode({ id, data, selected }: NodeProps<WbNode>) {
  const { update } = useWb();
  const [title, setTitle] = useState(data.title ?? "");
  const [text, setText] = useState(data.text ?? "");
  const [editing, setEditing] = useEditing(id, data, () => {
    setTitle(data.title ?? "");
    setText(data.text ?? "");
  });
  const commit = () => {
    setEditing(false);
    if (title !== (data.title ?? "") || text !== (data.text ?? "")) update(id, { title, text });
  };
  return (
    <>
      <Resizer selected={selected} data={data} min={[140, 60]} />
      <Handles />
      <div
        className="wbn wbn--text"
        data-locked={data.locked}
        data-color={inkStyle(data) ? true : undefined}
        style={inkStyle(data)}
        onDoubleClick={() => {
          if (data.locked) return;
          setTitle(data.title ?? "");
          setText(data.text ?? "");
          setEditing(true);
        }}
      >
        {editing ? (
          <div
            className="nodrag nowheel"
            style={{ display: "flex", flexDirection: "column", height: "100%", gap: 4 }}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit();
            }}
          >
            <input className="wbn__edit wbn__title" autoFocus placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Escape" && commit()} />
            <textarea
              className="wbn__edit wbn__body"
              placeholder="Write… use - [ ] for a checklist"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) commit();
              }}
            />
          </div>
        ) : (
          <>
            {data.title && <div className="wbn__title">{data.title}</div>}
            <div className="wbn__body">
              {data.text ? (
                <MarkdownLite text={data.text} onToggle={(i) => update(id, { text: toggleLine(data.text!, i) })} />
              ) : (
                !data.title && <span className="faint">Double-click to write</span>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
});

// ------------------------------------------------------------- sticky

export const StickyNode = memo(function StickyNode({ id, data, selected }: NodeProps<WbNode>) {
  const { update } = useWb();
  const [text, setText] = useState(data.text ?? "");
  const [editing, setEditing] = useEditing(id, data, () => setText(data.text ?? ""));
  const commit = () => {
    setEditing(false);
    if (text !== (data.text ?? "")) update(id, { text });
  };
  return (
    <>
      <Resizer selected={selected} data={data} min={[100, 80]} />
      <Handles />
      <div
        className="wbn wbn--sticky"
        data-tone={data.tone ?? "plain"}
        data-locked={data.locked}
        onDoubleClick={() => {
          if (data.locked) return;
          setText(data.text ?? "");
          setEditing(true);
        }}
      >
        {editing ? (
          <textarea
            className="wbn__edit nodrag nowheel"
            autoFocus
            value={text}
            placeholder="Note"
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) commit();
            }}
          />
        ) : (
          <div className="wbn__body">{data.text ? <MarkdownLite text={data.text} onToggle={(i) => update(id, { text: toggleLine(data.text!, i) })} /> : <span style={{ opacity: 0.5 }}>Double-click to write</span>}</div>
        )}
      </div>
    </>
  );
});

// ------------------------------------------------------------- area

export const AreaNode = memo(function AreaNode({ id, data, selected }: NodeProps<WbNode>) {
  const { update } = useWb();
  const [label, setLabel] = useState(data.label ?? "");
  const [editing, setEditing] = useEditing(id, data, () => setLabel(data.label ?? ""));
  return (
    <>
      <Resizer selected={selected} data={data} min={[160, 120]} />
      <Handles />
      <div className="wbn wbn--area" data-fill={data.areaFill ?? "dashed"} data-locked={data.locked} data-color={inkStyle(data) ? true : undefined} style={inkStyle(data)}>
        {editing ? (
          <input
            className="wbn__area-label wbn__edit nodrag"
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (label !== data.label) update(id, { label });
            }}
            onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && (e.target as HTMLInputElement).blur()}
            style={{ width: 240 }}
          />
        ) : (
          <div
            className="wbn__area-label"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setLabel(data.label ?? "");
              setEditing(true);
            }}
          >
            {data.label || "Area"}
          </div>
        )}
      </div>
    </>
  );
});

// ------------------------------------------------------------- shape

interface Paint {
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeDasharray: string | undefined;
}

/**
 * The outline of a closed shape, in the node's own width/height coordinates.
 * The flowchart shapes keep their slants and notches proportional but
 * capped, so a wide box does not turn into a sliver.
 */
export function shapeFigure(shape: NonNullable<WbData["shape"]>, w: number, h: number, paint: Paint): ReactNode {
  const poly = (pts: [number, number][]) => <polygon points={pts.map(([x, y]) => `${x},${y}`).join(" ")} {...paint} />;
  const slant = Math.min(w * 0.22, 30);
  switch (shape) {
    case "stadium":
      return <rect x={1} y={1} width={w - 2} height={h - 2} rx={Math.max(2, Math.min(w, h) / 2 - 1)} {...paint} />;
    case "diamond":
      return poly([
        [w / 2, 1],
        [w - 1, h / 2],
        [w / 2, h - 1],
        [1, h / 2],
      ]);
    case "parallelogram":
      return poly([
        [slant, 1],
        [w - 1, 1],
        [w - slant, h - 1],
        [1, h - 1],
      ]);
    case "hexagon":
      return poly([
        [slant, 1],
        [w - slant, 1],
        [w - 1, h / 2],
        [w - slant, h - 1],
        [slant, h - 1],
        [1, h / 2],
      ]);
    case "cylinder": {
      // An open-topped body (SVG closes it for the fill) with the disc on top.
      const r = Math.max(4, Math.min(h * 0.16, 20));
      return (
        <>
          <path d={`M1 ${r} V ${h - r} A ${w / 2 - 1} ${r} 0 0 0 ${w - 1} ${h - r} V ${r}`} {...paint} />
          <ellipse cx={w / 2} cy={r} rx={w / 2 - 1} ry={r} {...paint} />
        </>
      );
    }
    case "document": {
      const wave = Math.max(6, Math.min(h * 0.16, 18));
      return <path d={`M1 1 H ${w - 1} V ${h - wave} C ${w * 0.7} ${h + wave * 0.6}, ${w * 0.3} ${h - wave * 2.6}, 1 ${h - wave} Z`} {...paint} />;
    }
    default:
      return <rect x={1} y={1} width={w - 2} height={h - 2} rx={shape === "rounded" ? 14 : 2} {...paint} />;
  }
}

export const ShapeNode = memo(function ShapeNode({ id, data, selected, width, height }: NodeProps<WbNode>) {
  const { update } = useWb();
  const [label, setLabel] = useState(data.label ?? "");
  const [editing, setEditing] = useEditing(id, data, () => setLabel(data.label ?? ""));
  const w = width ?? 160;
  const h = height ?? 110;
  const shape = data.shape ?? "rounded";
  const isLine = shape === "line" || shape === "arrow";
  const dash = data.stroke === "dashed" ? "6 5" : undefined;
  const stroke = colorVar(data.color);
  const fill = !data.fill ? "transparent" : data.color && data.color !== "default" ? `color-mix(in srgb, ${stroke} 18%, var(--surface-2))` : "var(--surface-2)";
  let el: ReactNode;
  if (shape === "circle") el = <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - 1} ry={h / 2 - 1} fill={fill} stroke={stroke} strokeWidth={1.75} strokeDasharray={dash} />;
  else if (isLine) {
    const coords = data.flip ? [0, h, w, 0] : h < 24 ? [0, h / 2, w, h / 2] : w < 24 ? [w / 2, 0, w / 2, h] : [0, 0, w, h];
    const [x1, y1, x2, y2] = data.reverse ? [coords[2], coords[3], coords[0], coords[1]] : coords;
    el = (
      <>
        <defs>
          <marker id={`arrow-${id}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={stroke} />
          </marker>
        </defs>
        <line className="wbn__ink-hit" x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={14} />
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={2} strokeDasharray={dash} markerEnd={shape === "arrow" ? `url(#arrow-${id})` : undefined} />
      </>
    );
  } else {
    const paint = { fill, stroke, strokeWidth: 1.75, strokeDasharray: dash };
    el = shapeFigure(shape, w, h, paint);
  }
  return (
    <>
      <Resizer selected={selected} data={data} min={[20, 8]} />
      {!isLine && <Handles />}
      <div
        className="wbn wbn--shape"
        data-shape={shape}
        data-line={isLine || undefined}
        data-locked={data.locked}
        onDoubleClick={() => {
          if (data.locked || isLine) return;
          setLabel(data.label ?? "");
          setEditing(true);
        }}
      >
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          {el}
        </svg>
        {editing ? (
          <div className="wbn__shape-label" style={{ pointerEvents: "auto" }}>
            <input
              className="wbn__edit nodrag"
              autoFocus
              style={{ textAlign: "center" }}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={() => {
                setEditing(false);
                if (label !== (data.label ?? "")) update(id, { label });
              }}
              onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && (e.target as HTMLInputElement).blur()}
            />
          </div>
        ) : (
          data.label && <div className="wbn__shape-label">{data.label}</div>
        )}
      </div>
    </>
  );
});

// ------------------------------------------------------------- task card (live)

export const TaskNode = memo(function TaskNode({ id, data, selected }: NodeProps<WbNode>) {
  const { update, projectId } = useWb();
  const { data: task, isError } = useTask(data.taskId);
  const projectMap = useProjectMap();
  const today = useToday();
  const [title, setTitle] = useState("");

  if (!data.taskId) {
    return (
      <>
        <Handles />
        <div className="wbn wbn--card">
          <div className="wbn__kind">
            <SquareCheckBig /> New task
          </div>
          <input
            className="wbn__edit nodrag"
            autoFocus
            placeholder="Task title, then Enter"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={async (e) => {
              e.stopPropagation();
              if (e.key === "Enter" && title.trim()) {
                const t = await createTask({ title: title.trim(), projectId, status: projectId ? "todo" : getSetting("tasks.defaultDestination") === "inbox" ? "inbox" : "todo" }, { quiet: true });
                if (t) update(id, { taskId: t.id, title: t.title });
              }
            }}
          />
        </div>
      </>
    );
  }
  const project = task?.projectId ? projectMap.get(task.projectId) : undefined;
  const done = task?.status === "completed";
  return (
    <>
      <Resizer selected={selected} data={data} min={[180, 60]} />
      <Handles />
      <div className="wbn wbn--card" data-locked={data.locked} onDoubleClick={() => task && openTask(task.id)}>
        <div className="wbn__kind">
          <SquareCheckBig /> Task
        </div>
        {!task || isError || task.deletedAt ? (
          <span className="faint">{isError || task?.deletedAt ? "This task was deleted" : data.title ?? "Loading…"}</span>
        ) : (
          <>
            <div className="wbn__row">
              <span className="nodrag" style={{ display: "flex" }}>
                <TaskCheck checked={done} onToggle={() => void toggleComplete(task)} priority={task.priority} cancelled={!!task.resolution} />
              </span>
              <TaskTitle title={task.title} done={done} className="grow" />
            </div>
            <div className="wbn__meta">
              {task.priority > 0 && !done && <PriorityIcon priority={task.priority} size={12} />}
              <DueLabel date={task.dueDate} time={task.dueTime} done={done} today={today} />
              {task.subtaskCount > 0 && (
                <span>
                  {task.subtaskDone}/{task.subtaskCount}
                </span>
              )}
              {project && project.id !== projectId && (
                <span className="row" style={{ gap: 4 }}>
                  <ProjectGlyph project={project} size={11} /> {project.name}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
});

// ------------------------------------------------------------- image

export const ImageNode = memo(function ImageNode({ data, selected }: NodeProps<WbNode>) {
  const { data: info } = useAppInfo();
  const space = useCloud((s) => s.info?.active?.id ?? null);
  const [localFailed, setLocalFailed] = useState(false);
  const [failed, setFailed] = useState(false);
  // The original when it's on this computer; otherwise the compressed copy a
  // collaborator shared (downloaded once, then cached).
  const local = info && data.src ? assetUrl(info.attachmentsDir, data.src) : null;
  const wantShared = (!local || localFailed) && !!space && !!data.cloudAsset;
  const shared = useQuery({
    queryKey: ["wb-image", space, data.cloudAsset],
    queryFn: () => api.cloud.imagePath(space, null, data.cloudAsset ?? null),
    enabled: wantShared,
    staleTime: Infinity,
    retry: 2,
  });
  const url = local && !localFailed ? local : shared.data ? convertFileSrc(shared.data) : null;
  const missing = !data.cloudAsset && (!local || localFailed) ? "Image is on another computer" : "Image unavailable";
  return (
    <>
      <Resizer selected={selected} data={data} min={[40, 30]} keepAspect />
      <Handles />
      <div className="wbn wbn--image" data-locked={data.locked}>
        {url && !failed ? (
          <img
            src={url}
            alt={data.name ?? ""}
            draggable={false}
            onError={() => (url === local ? setLocalFailed(true) : setFailed(true))}
          />
        ) : wantShared && shared.isLoading ? (
          <div className="wbn__missing" style={{ height: "100%", justifyContent: "center" }}>
            <ImageIcon size={14} /> Loading shared image…
          </div>
        ) : (
          <div className="wbn__missing" style={{ height: "100%", justifyContent: "center" }}>
            <ImageOff size={14} /> {missing}
          </div>
        )}
      </div>
    </>
  );
});

// ------------------------------------------------------------- link

export const LinkNode = memo(function LinkNode({ id, data, selected }: NodeProps<WbNode>) {
  const { update } = useWb();
  const [url, setUrl] = useState(data.url ?? "");
  const [editing, setEditing] = useEditing(id, data, () => setUrl(data.url ?? ""));
  const host = (() => {
    try {
      return new URL(data.url ?? "").host;
    } catch {
      return data.url ?? "";
    }
  })();
  const commit = async () => {
    setEditing(false);
    let u = url.trim();
    if (!u) return;
    if (!/^[a-z]+:/i.test(u)) u = `https://${u}`;
    update(id, { url: u });
    if (getSetting("data.linkPreviews")) {
      try {
        const meta = await api.system.linkMetadata(u);
        update(id, { title: meta.title ?? undefined, description: meta.description ?? undefined, siteName: meta.siteName ?? undefined }, false);
      } catch {
        /* offline: the URL alone is shown */
      }
    }
  };
  return (
    <>
      <Resizer selected={selected} data={data} min={[180, 60]} />
      <Handles />
      <div className="wbn wbn--card" data-locked={data.locked} onDoubleClick={() => !data.locked && (setUrl(data.url ?? ""), setEditing(true))}>
        <div className="wbn__kind">
          {data.url ? <Favicon url={data.url} size={16} /> : <Globe />} {data.siteName || host || "Link"}
          <span className="spacer" />
          {data.url && !editing && (
            <span className="nodrag">
              <IconButton icon={ExternalLink} label="Open link" size="sm" onClick={() => void api.system.open(data.url!)} />
            </span>
          )}
        </div>
        {editing || !data.url ? (
          <input
            className="wbn__edit nodrag"
            autoFocus
            placeholder="Paste a link, then Enter"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <>
            <div className="wbn__title truncate">{data.title || displayUrl(data.url)}</div>
            {data.title && <div className="wbn__url truncate">{displayUrl(data.url)}</div>}
            {data.description && <div className="wbn__body" style={{ WebkitLineClamp: 2, display: "-webkit-box", WebkitBoxOrient: "vertical" }}>{data.description}</div>}
          </>
        )}
      </div>
    </>
  );
});

// ------------------------------------------------------------- file

export const FileNode = memo(function FileNode({ data, selected }: NodeProps<WbNode>) {
  const { data: exists } = useQuery({
    queryKey: ["path-exists", data.path],
    queryFn: () => api.system.exists(data.path!),
    enabled: !!data.path,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  const missing = exists === false;
  return (
    <>
      <Resizer selected={selected} data={data} min={[180, 56]} />
      <Handles />
      <div className="wbn wbn--card" data-locked={data.locked} onDoubleClick={() => data.path && !missing && void api.system.open(data.path)}>
        <div className="wbn__row">
          {missing ? <FileWarning size={16} className="faint" /> : <FileIcon size={16} className="faint" />}
          <span className="truncate grow" style={missing ? { color: "var(--text-3)" } : undefined}>
            {data.name ?? "File"}
          </span>
          {!missing && data.path && (
            <span className="nodrag">
              <IconButton icon={FolderOpen} label="Show in folder" size="sm" onClick={() => void api.system.reveal(data.path!)} />
            </span>
          )}
        </div>
        <div className="wbn__meta truncate" title={data.path}>
          {missing ? "Moved or deleted - not found at its original location" : data.path}
        </div>
      </div>
    </>
  );
});

// ------------------------------------------------------------- references

function RefPicker({ placeholder, options, onPick }: { placeholder: string; options: { value: string; label: string }[]; onPick: (v: string) => void }) {
  return (
    <div className="nodrag" style={{ marginTop: 2 }}>
      {options.length ? <Select value={"" as string} onChange={onPick} options={options} placeholder={placeholder} /> : <span className="faint">Nothing to link yet</span>}
    </div>
  );
}

export const ProjectRefNode = memo(function ProjectRefNode({ id, data, selected }: NodeProps<WbNode>) {
  const { update } = useWb();
  const { data: projects } = useProjects();
  const p = projects?.find((x) => x.id === data.projectId);
  return (
    <>
      <Resizer selected={selected} data={data} min={[180, 70]} />
      <Handles />
      <div className="wbn wbn--card" data-locked={data.locked} onDoubleClick={() => p && navigate({ name: "project", id: p.id })}>
        <div className="wbn__kind">
          <FolderKanban /> Project
        </div>
        {!data.projectId ? (
          <RefPicker placeholder="Choose a project" options={(projects ?? []).map((x) => ({ value: x.id, label: x.name }))} onPick={(v) => update(id, { projectId: v })} />
        ) : p ? (
          <>
            <div className="wbn__row">
              <ProjectGlyph project={p} size={16} />
              <span className="wbn__title truncate">{p.name}</span>
            </div>
            <Progress value={p.taskTotal ? p.taskDone / p.taskTotal : 0} />
            <div className="wbn__meta">
              {p.taskTotal - p.taskDone} open{p.taskOverdue ? ` · ${p.taskOverdue} overdue` : ""}
            </div>
          </>
        ) : (
          <span className="faint">Project unavailable</span>
        )}
      </div>
    </>
  );
});

export const BoardRefNode = memo(function BoardRefNode({ id, data, selected }: NodeProps<WbNode>) {
  const { update } = useWb();
  const { data: boards } = useQuery({ queryKey: ["boards", "all"], queryFn: () => api.boards.list() });
  const projectMap = useProjectMap();
  const b = boards?.find((x) => x.id === data.boardId);
  const project = b ? projectMap.get(b.projectId) : undefined;
  return (
    <>
      <Resizer selected={selected} data={data} min={[180, 60]} />
      <Handles />
      <div className="wbn wbn--card" data-locked={data.locked} onDoubleClick={() => b && navigate({ name: "project", id: b.projectId, tab: "board", boardId: b.id })}>
        <div className="wbn__kind">
          <SquareKanban /> Board
        </div>
        {!data.boardId ? (
          <RefPicker
            placeholder="Choose a board"
            options={(boards ?? []).map((x) => ({ value: x.id, label: `${projectMap.get(x.projectId)?.name ?? "Project"} · ${x.name}` }))}
            onPick={(v) => update(id, { boardId: v })}
          />
        ) : b ? (
          <>
            <div className="wbn__title truncate">{b.name}</div>
            {project && <div className="wbn__meta">{project.name}</div>}
          </>
        ) : (
          <span className="faint">Board unavailable</span>
        )}
      </div>
    </>
  );
});

export const NoteRefNode = memo(function NoteRefNode({ id, data, selected }: NodeProps<WbNode>) {
  const { update } = useWb();
  const { data: notes } = useNotes(null);
  const n = notes?.find((x) => x.id === data.noteId);
  return (
    <>
      <Resizer selected={selected} data={data} min={[180, 70]} />
      <Handles />
      <div className="wbn wbn--card" data-locked={data.locked} onDoubleClick={() => n && navigate({ name: "notes", id: n.id })}>
        <div className="wbn__kind">
          <FileText /> Note
        </div>
        {!data.noteId ? (
          <RefPicker placeholder="Choose a note" options={(notes ?? []).map((x) => ({ value: x.id, label: x.title || "Untitled" }))} onPick={(v) => update(id, { noteId: v })} />
        ) : n ? (
          <>
            <div className="wbn__title truncate">{n.title || "Untitled"}</div>
            {n.excerpt && <div className="wbn__body">{n.excerpt}</div>}
          </>
        ) : (
          <span className="faint">Note unavailable</span>
        )}
      </div>
    </>
  );
});

export const MilestoneRefNode = memo(function MilestoneRefNode({ id, data, selected }: NodeProps<WbNode>) {
  const { update, projectId } = useWb();
  const { data: projects } = useProjects();
  const { data: choices } = useQuery({
    queryKey: ["milestones", "wb", projectId ?? "all", projects?.length],
    queryFn: async () => (projectId ? api.milestones.list(projectId) : (await Promise.all((projects ?? []).map((p) => api.milestones.list(p.id)))).flat()),
    enabled: !data.milestoneId && (!!projectId || !!projects),
  });
  const { data: m, isError } = useMilestone(data.milestoneId);
  const today = useToday();
  return (
    <>
      <Resizer selected={selected} data={data} min={[180, 70]} />
      <Handles />
      <div className="wbn wbn--card" data-locked={data.locked} onDoubleClick={() => m && openMilestone(m.id)}>
        <div className="wbn__kind">
          <Flag /> {m?.isRelease ? "Release" : "Milestone"}
        </div>
        {!data.milestoneId ? (
          <RefPicker placeholder="Choose a milestone" options={(choices ?? []).map((x) => ({ value: x.id, label: x.title }))} onPick={(v) => update(id, { milestoneId: v })} />
        ) : m && !isError ? (
          <>
            <div className="wbn__title truncate">
              {m.title}
              {m.isRelease && m.version ? ` · ${m.version}` : ""}
            </div>
            <Progress value={m.progress} />
            <div className="wbn__meta">
              {m.status === "completed" ? "Completed" : `${m.taskDone}/${m.taskTotal} tasks`}
              {m.targetDate && m.status !== "completed" && <DueLabel date={m.targetDate} time={null} done={false} today={today} />}
            </div>
          </>
        ) : (
          <span className="faint">{isError ? "This milestone was deleted" : "Loading…"}</span>
        )}
      </div>
    </>
  );
});

// ------------------------------------------------------------- freehand ink

export const DrawNode = memo(function DrawNode({ data, selected, width, height }: NodeProps<WbNode>) {
  const w = width ?? data.vw ?? 100;
  const h = height ?? data.vh ?? 100;
  const sx = data.vw ? w / data.vw : 1;
  const sy = data.vh ? h / data.vh : 1;
  const d = useMemo(() => inkPath(data.points ?? [], sx, sy), [data.points, sx, sy]);
  const sw = data.strokeWidth ?? 3;
  return (
    <>
      <Resizer selected={selected} data={data} min={[8, 8]} />
      <div className="wbn wbn--draw" data-locked={data.locked}>
        <svg width={w} height={h}>
          <path className="wbn__ink-hit" d={d} strokeWidth={Math.max(sw + 10, 14)} />
          <path d={d} fill="none" stroke={colorVar(data.color, "var(--text)")} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </>
  );
});

export const NODE_TYPES = {
  text: TextNode,
  sticky: StickyNode,
  area: AreaNode,
  shape: ShapeNode,
  task: TaskNode,
  image: ImageNode,
  link: LinkNode,
  file: FileNode,
  project: ProjectRefNode,
  board: BoardRefNode,
  note: NoteRefNode,
  milestone: MilestoneRefNode,
  draw: DrawNode,
};
