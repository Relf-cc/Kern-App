/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { Archive, CalendarDays, CircleCheck, Flag, FolderInput, FolderPlus, Tag, Trash, X } from "lucide-react";
import { IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { useLabels, useProjects } from "@/hooks/data";
import { copyTasksToProject, deleteTasks, rescheduleTasks, updateTasks } from "./actions";
import { DuePopover } from "./pickers";
import { PRIORITY_LABELS } from "./meta";

/** Floating toolbar for multi-selected tasks. */
export function BulkBar({ ids, onClear }: { ids: string[]; onClear: () => void }) {
  const { data: projects } = useProjects();
  const { data: labels } = useLabels();
  const n = ids.length;
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Selected tasks">
      <span className="bulk-bar__count">{n} selected</span>
      <IconButton
        icon={CircleCheck}
        label="Complete"
        tooltipSide="top"
        onClick={() => {
          void updateTasks(ids, { status: "completed" }, `Completed ${n} tasks`);
          onClear();
        }}
      />
      <DuePopover
        date={null}
        withTime={false}
        onChange={(d) => void rescheduleTasks(ids, d)}
        trigger={<IconButton icon={CalendarDays} label="Change due date" tooltipSide="top" />}
      />
      <Dropdown
        side="top"
        items={[4, 3, 2, 1, 0].map((p) => ({
          label: PRIORITY_LABELS[p],
          onSelect: () => void updateTasks(ids, { priority: p }, "Priority changed"),
        }))}
      >
        <IconButton icon={Flag} label="Change priority" tooltipSide="top" noTooltip />
      </Dropdown>
      <Dropdown
        side="top"
        items={[
          { label: "Inbox (no project)", onSelect: () => void updateTasks(ids, { projectId: null }, "Moved to Inbox") },
          ...((projects ?? []).length ? [{ type: "separator" as const }] : []),
          ...(projects ?? []).map((p) => ({
            label: p.name,
            onSelect: () => void updateTasks(ids, { projectId: p.id }, `Moved to ${p.name}`),
          })),
        ]}
      >
        <IconButton icon={FolderInput} label="Move to project" tooltipSide="top" noTooltip />
      </Dropdown>
      <Dropdown
        side="top"
        items={[
          { label: "Inbox (no project)", onSelect: () => void copyTasksToProject(ids, { id: null, name: "the Inbox" }) },
          ...((projects ?? []).length ? [{ type: "separator" as const }] : []),
          ...(projects ?? []).map((p) => ({ label: p.name, onSelect: () => void copyTasksToProject(ids, p) })),
        ]}
      >
        <IconButton icon={FolderPlus} label="Copy to project" tooltipSide="top" noTooltip />
      </Dropdown>
      <Dropdown
        side="top"
        items={
          labels?.length
            ? labels.map((l) => ({ label: l.name, onSelect: () => void updateTasks(ids, { addLabelIds: [l.id] }, `Labelled ${l.name}`) }))
            : [{ label: "No labels yet", disabled: true, onSelect: () => undefined }]
        }
      >
        <IconButton icon={Tag} label="Apply label" tooltipSide="top" noTooltip />
      </Dropdown>
      <IconButton
        icon={Archive}
        label="Archive"
        tooltipSide="top"
        onClick={() => {
          void updateTasks(ids, { archived: true }, `Archived ${n} tasks`);
          onClear();
        }}
      />
      <IconButton
        icon={Trash}
        label="Move to trash"
        tooltipSide="top"
        onClick={() => {
          void deleteTasks(ids);
          onClear();
        }}
      />
      <span className="sep" />
      <IconButton icon={X} label="Clear selection" shortcut="Escape" tooltipSide="top" onClick={onClear} />
    </div>
  );
}
