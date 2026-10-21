/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { memo, type CSSProperties } from "react";
import { Ban, CalendarDays, ClockAlert, Ellipsis, GripVertical, ListChecks, Paperclip, Pin, Repeat, Timer } from "lucide-react";
import type { Label, Member, Project, Task } from "@/lib/types";
import { TaskCheck, TaskTitle } from "@/components/ui/Controls";
import { IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { dueState, formatDue, formatDuration } from "@/lib/dates";
import { PriorityIcon } from "./meta";
import { GithubMark } from "@/features/github/shared";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { Avatar } from "@/features/cloud/ui";
import { Tooltip } from "@/components/ui/Tooltip";
import { DuePopover } from "./pickers";
import { taskMenu } from "./menu";
import { LabelChip } from "./labels";
import { toggleComplete, updateTask } from "./actions";
import type { Settings } from "@/features/settings/schema";

export interface RowContext {
  projects: Project[];
  projectMap: Map<string, Project>;
  labelMap: Map<string, Label>;
  labels: Label[];
  meta: Settings["appearance.taskMeta"];
  expanded: boolean;
  hideProject?: boolean;
  today: string;
  selection: string[];
  /** Workspace members by user id, for the creator's picture and name. */
  people: Map<string, Member>;
  /** Whether rows show who wrote them (a workspace with the setting on). */
  showCreator: boolean;
}

/**
 * The author's picture, at the end of the row. Hovering it names them: the
 * face alone doesn't say who it is, and the row's own hover actions tuck in
 * beside it rather than covering it, so there's something there to point at.
 */
function Creator({ task, people }: { task: Task; people: Map<string, Member> }) {
  if (!task.createdBy) return null;
  const member = people.get(task.createdBy);
  const name = member?.name || task.createdByName || "Someone else";
  return (
    <Tooltip content={`Created by ${name}`} side="top">
      <span className="task-row__who">
        {/* The tooltip says it; a native one as well would be two tips. */}
        <Avatar name={name} image={member?.image} size={18} title={null} />
      </span>
    </Tooltip>
  );
}

export function DueLabel({ date, time, done, today }: { date: string | null; time?: string | null; done: boolean; today: string }) {
  if (!date) return null;
  const st = dueState(date, done, today);
  return (
    <span className="due" data-state={st ?? undefined}>
      {st === "overdue" ? <ClockAlert /> : <CalendarDays />}
      {formatDue(date, time, today)}
    </span>
  );
}

function TaskRowInner({
  task: t,
  ctx,
  focused,
  selected,
  onClick,
  dragHandle,
  dragging,
  style,
  rowRef,
}: {
  task: Task;
  ctx: RowContext;
  focused: boolean;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  dragHandle?: Record<string, unknown>;
  dragging?: boolean;
  style?: CSSProperties;
  rowRef?: (el: HTMLElement | null) => void;
}) {
  const done = t.status === "completed";
  const project = t.projectId ? ctx.projectMap.get(t.projectId) : undefined;
  const labels = ctx.meta.labels ? t.labelIds.map((id) => ctx.labelMap.get(id)).filter(Boolean) as Label[] : [];
  const firstLine = ctx.expanded && t.description ? t.description.split("\n").find((l) => l.trim())?.replace(/^[#>*\-\s[\]x]+/, "") : "";

  return (
    <div
      ref={rowRef}
      className="task-row"
      role="option"
      aria-selected={selected}
      data-task-id={t.id}
      data-flip-id={t.id}
      data-focused={focused || undefined}
      data-selected={selected || undefined}
      data-done={done}
      data-dragging={dragging || undefined}
      style={style}
      onClick={onClick}
    >
      {dragHandle && (
        <span className="drag-handle" {...dragHandle} aria-label="Drag to reorder">
          <GripVertical size={14} />
        </span>
      )}
      <TaskCheck checked={done} onToggle={() => void toggleComplete(t)} priority={t.priority} blocked={t.status === "blocked" || !!t.blockedBy} cancelled={!!t.resolution} />
      <div className="task-row__main">
        <div className="task-row__line">
          <span className="task-row__title">
            <TaskTitle title={t.title} done={done} />
          </span>
          {t.pinned && <Pin size={12} className="faint" aria-label="Pinned" />}
          <div className="task-row__meta">
            {!!t.blockedBy && !done && (
              <span title={`Blocked by ${t.blockedBy} open ${t.blockedBy === 1 ? "task" : "tasks"}`} aria-label={`Blocked by ${t.blockedBy}`}>
                <Ban />
                {t.blockedBy}
              </span>
            )}
            {labels.slice(0, 2).map((l) => (
              <LabelChip key={l.id} label={l} />
            ))}
            {labels.length > 2 && <span className="chip">+{labels.length - 2}</span>}
            {ctx.meta.subtasks && t.subtaskCount > 0 && (
              <span aria-label={`${t.subtaskDone} of ${t.subtaskCount} subtasks`}>
                <ListChecks />
                {t.subtaskDone}/{t.subtaskCount}
              </span>
            )}
            {t.attachmentCount > 0 && (
              <span aria-label={`${t.attachmentCount} attachments`}>
                <Paperclip />
                {t.attachmentCount}
              </span>
            )}
            {t.issue && (
              <span aria-label={`GitHub issue ${t.issue.number}`} title={`${t.issue.repo}#${t.issue.number}`}>
                <GithubMark size={12} />#{t.issue.number}
              </span>
            )}
            {t.recurrence && (
              <span aria-label="Repeats">
                <Repeat />
              </span>
            )}
            {ctx.meta.estimate && t.estimateMinutes ? (
              <span>
                <Timer />
                {formatDuration(t.estimateMinutes * 60)}
              </span>
            ) : null}
            {ctx.meta.project && !ctx.hideProject && project && (
              <span className="truncate" style={{ maxWidth: 140 }}>
                <ProjectGlyph project={project} size={13} />
                <span className="truncate">{project.name}</span>
              </span>
            )}
            {ctx.meta.due && <DueLabel date={t.dueDate} time={t.dueTime} done={done} today={ctx.today} />}
            {ctx.meta.priority && t.priority > 0 && !done && <PriorityIcon priority={t.priority} size={13} />}
          </div>
        </div>
        {firstLine && <div className="task-row__desc">{firstLine}</div>}
      </div>
      {ctx.showCreator && <Creator task={t} people={ctx.people} />}
      <div className="task-row__hover" onClick={(e) => e.stopPropagation()}>
        <DuePopover
          date={t.dueDate}
          time={t.dueTime}
          onChange={(d, tm) => void updateTask(t.id, { dueDate: d, dueTime: tm }, { undoLabel: d ? `Due ${formatDue(d)}` : "Date removed" })}
          trigger={<IconButton icon={CalendarDays} label="Set due date" size="sm" />}
        />
        <Dropdown items={() => taskMenu(t, ctx)} align="end">
          <IconButton icon={Ellipsis} label="More actions" size="sm" noTooltip />
        </Dropdown>
      </div>
    </div>
  );
}

export const TaskRow = memo(TaskRowInner);
