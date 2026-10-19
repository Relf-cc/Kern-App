/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { CalendarDays, Check, CircleCheck, CircleDashed, Flag, FolderKanban, Layers, Search, SlidersHorizontal, Tag, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { TaskFilters, TaskGrouping, TaskMeta, TaskOrder, TaskStatus } from "@/lib/types";
import { Popover, Select, Switch } from "@/components/ui/Controls";
import { useSetting } from "@/stores/settings";
import { Dropdown } from "@/components/ui/Menu";
import { useLabels, useProjects } from "@/hooks/data";
import { PRIORITY_LABELS, STATUS_LABELS } from "./meta";
import { activeFilterCount } from "./grouping";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { LabelDot } from "./labels";

const DUE_OPTIONS: { value: NonNullable<TaskFilters["due"]>; label: string }[] = [
  { value: "any", label: "Any date" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due by today" },
  { value: "week", label: "Due this week" },
  { value: "next7", label: "Next 7 days" },
  { value: "next30", label: "Next 30 days" },
  { value: "dated", label: "Has a date" },
  { value: "none", label: "No date" },
];

export const SORT_OPTIONS: { value: TaskOrder; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "due", label: "Due date" },
  { value: "priority", label: "Priority" },
  { value: "created", label: "Newest first" },
  { value: "updated", label: "Recently updated" },
  { value: "title", label: "Title" },
];

export const GROUP_OPTIONS: { value: TaskGrouping; label: string }[] = [
  { value: "none", label: "No grouping" },
  { value: "project", label: "Project" },
  { value: "due", label: "Due date" },
  { value: "priority", label: "Priority" },
  { value: "status", label: "Status" },
  { value: "label", label: "Label" },
  { value: "milestone", label: "Milestone" },
];

const PROPERTY_OPTIONS: { key: keyof TaskMeta; label: string }[] = [
  { key: "project", label: "Project" },
  { key: "due", label: "Due date" },
  { key: "priority", label: "Priority" },
  { key: "labels", label: "Labels" },
  { key: "subtasks", label: "Sub-tasks" },
  { key: "estimate", label: "Estimate" },
  { key: "creator", label: "Who created it" },
];

/** The view settings that aren't filters: kept when filters are cleared. */
function viewOptions(f: TaskFilters): TaskFilters {
  return { sort: f.sort, group: f.group, subGroup: f.subGroup, showSubtasks: f.showSubtasks, display: f.display };
}

/** Linear-style view options: grouping, ordering and the properties rows show. */
function DisplayMenu({ filters, set, showGrouping }: { filters: TaskFilters; set: (p: Partial<TaskFilters>) => void; showGrouping: boolean }) {
  const globalMeta = useSetting("appearance.taskMeta");
  const meta = { ...globalMeta, ...filters.display };
  const group = filters.group ?? "none";
  const grouped = showGrouping && group !== "none";
  return (
    <Popover
      align="end"
      pad
      trigger={
        <button type="button" className="btn btn--ghost btn--sm">
          {grouped ? <Layers /> : <SlidersHorizontal />}
          {SORT_OPTIONS.find((o) => o.value === (filters.sort ?? "manual"))?.label}
          {grouped && ` · ${GROUP_OPTIONS.find((o) => o.value === group)?.label}`}
        </button>
      }
    >
      <div className="display-menu">
        {showGrouping && (
          <div className="display-menu__row">
            <span>Grouping</span>
            <Select<TaskGrouping>
              value={group}
              onChange={(v) => set({ group: v, subGroup: v === "none" || v === filters.subGroup ? undefined : filters.subGroup })}
              options={GROUP_OPTIONS}
              ariaLabel="Grouping"
              style={{ width: 150 }}
            />
          </div>
        )}
        {grouped && (
          <div className="display-menu__row">
            <span>Sub-grouping</span>
            <Select<TaskGrouping>
              value={filters.subGroup ?? "none"}
              onChange={(v) => set({ subGroup: v === "none" ? undefined : v })}
              options={GROUP_OPTIONS.filter((o) => o.value !== group).map((o) => (o.value === "none" ? { ...o, label: "No sub-grouping" } : o))}
              ariaLabel="Sub-grouping"
              style={{ width: 150 }}
            />
          </div>
        )}
        <div className="display-menu__row">
          <span>Ordering</span>
          <Select<TaskOrder> value={filters.sort ?? "manual"} onChange={(v) => set({ sort: v })} options={SORT_OPTIONS} ariaLabel="Ordering" style={{ width: 150 }} />
        </div>
        <div className="display-menu__row">
          <span>Show sub-tasks</span>
          <Switch checked={!!filters.showSubtasks} onChange={(v) => set({ showSubtasks: v || undefined })} label="Show sub-tasks" />
        </div>
        <div className="display-menu__sep" />
        <div className="display-menu__label">Display properties</div>
        <div className="display-menu__props">
          {PROPERTY_OPTIONS.map((o) => (
            <button
              key={o.key}
              type="button"
              className="chip chip-btn"
              aria-pressed={meta[o.key]}
              data-active={meta[o.key] || undefined}
              onClick={() => set({ display: { ...filters.display, [o.key]: !meta[o.key] } })}
            >
              {o.label}
            </button>
          ))}
        </div>
        {filters.display && (
          <button type="button" className="btn btn--ghost btn--sm" style={{ alignSelf: "flex-start" }} onClick={() => set({ display: undefined })}>
            Use Appearance defaults
          </button>
        )}
      </div>
    </Popover>
  );
}

function MultiPick<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: ReactNode }[];
  value: T[];
  onChange: (v: T[]) => void;
}) {
  return (
    <div style={{ padding: 4, minWidth: 200, maxHeight: 320, overflowY: "auto" }}>
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <div
            key={String(o.value)}
            className="menu__item"
            role="menuitemcheckbox"
            aria-checked={on}
            tabIndex={0}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value]);
              }
            }}
          >
            {o.icon}
            <span className="truncate grow">{o.label}</span>
            {on && <Check size={14} className="menu__check" />}
          </div>
        );
      })}
    </div>
  );
}

function Chip({ icon: Icon, label, active, onClear }: { icon: typeof Flag; label: string; active: boolean; onClear?: () => void }) {
  return (
    <span className="filter-chip" data-active={active}>
      <Icon strokeWidth={1.75} />
      {label}
      {active && onClear && (
        <span
          role="button"
          aria-label={`Clear ${label}`}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          style={{ display: "inline-flex", marginRight: -3 }}
        >
          <X size={12} />
        </span>
      )}
    </span>
  );
}

export function FilterBar({
  filters,
  onChange,
  showGrouping = true,
  trailing,
}: {
  filters: TaskFilters;
  onChange: (f: TaskFilters) => void;
  showGrouping?: boolean;
  trailing?: ReactNode;
}) {
  const { data: projects } = useProjects();
  const { data: labels } = useLabels();
  const [search, setSearch] = useState(filters.search ?? "");
  const set = (p: Partial<TaskFilters>) => onChange({ ...filters, ...p });

  const projectIds = [...(filters.projectIds ?? []), ...(filters.noProject ? ["__none"] : [])];
  const projectLabel = projectIds.length
    ? projectIds.length === 1
      ? projectIds[0] === "__none"
        ? "No project"
        : projects?.find((p) => p.id === projectIds[0])?.name ?? "Project"
      : `${projectIds.length} projects`
    : "Project";

  return (
    <div className="toolbar">
      <div className="input-wrap" style={{ width: 200 }}>
        <Search />
        <input
          className="input"
          style={{ height: "var(--control-h-sm)" }}
          placeholder="Filter by text"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            set({ search: e.target.value });
          }}
          aria-label="Filter by text"
        />
      </div>
      <Popover
        trigger={
          <button type="button">
            <Chip icon={FolderKanban} label={projectLabel} active={projectIds.length > 0} onClear={() => set({ projectIds: [], noProject: false })} />
          </button>
        }
      >
        <MultiPick<string>
          options={[
            { value: "__none", label: "No project" },
            ...(projects ?? []).map((p) => ({ value: p.id, label: p.name, icon: <ProjectGlyph project={p} size={14} /> })),
          ]}
          value={projectIds}
          onChange={(v) => set({ projectIds: v.filter((x) => x !== "__none"), noProject: v.includes("__none") })}
        />
      </Popover>
      <Popover
        trigger={
          <button type="button">
            <Chip
              icon={CircleDashed}
              label={filters.statuses?.length ? filters.statuses.map((s) => STATUS_LABELS[s]).join(", ") : "Status"}
              active={!!filters.statuses?.length}
              onClear={() => set({ statuses: [] })}
            />
          </button>
        }
      >
        <MultiPick<TaskStatus>
          options={(["inbox", "todo", "in_progress", "blocked"] as TaskStatus[]).map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
          value={filters.statuses ?? []}
          onChange={(v) => set({ statuses: v })}
        />
      </Popover>
      <Popover
        trigger={
          <button type="button">
            <Chip
              icon={Flag}
              label={filters.priorities?.length ? filters.priorities.map((p) => PRIORITY_LABELS[p]).join(", ") : "Priority"}
              active={!!filters.priorities?.length}
              onClear={() => set({ priorities: [] })}
            />
          </button>
        }
      >
        <MultiPick<number>
          options={[4, 3, 2, 1, 0].map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
          value={filters.priorities ?? []}
          onChange={(v) => set({ priorities: v })}
        />
      </Popover>
      {!!labels?.length && (
        <Popover
          trigger={
            <button type="button">
              <Chip
                icon={Tag}
                label={
                  filters.labelIds?.length
                    ? filters.labelIds.map((id) => labels.find((l) => l.id === id)?.name ?? "").join(", ")
                    : "Labels"
                }
                active={!!filters.labelIds?.length}
                onClear={() => set({ labelIds: [] })}
              />
            </button>
          }
        >
          <MultiPick<string>
            options={labels.map((l) => ({ value: l.id, label: l.name, icon: <LabelDot label={l} /> }))}
            value={filters.labelIds ?? []}
            onChange={(v) => set({ labelIds: v })}
          />
        </Popover>
      )}
      <Dropdown
        items={DUE_OPTIONS.map((o) => ({
          label: o.label,
          checked: (filters.due ?? "any") === o.value,
          onSelect: () => set({ due: o.value }),
        }))}
      >
        <button type="button">
          <Chip
            icon={CalendarDays}
            label={DUE_OPTIONS.find((o) => o.value === (filters.due ?? "any"))!.label === "Any date" ? "Due" : DUE_OPTIONS.find((o) => o.value === filters.due)!.label}
            active={!!filters.due && filters.due !== "any"}
            onClear={() => set({ due: "any" })}
          />
        </button>
      </Dropdown>
      <button type="button" onClick={() => set({ showCompleted: !filters.showCompleted })} aria-pressed={!!filters.showCompleted}>
        <Chip icon={CircleCheck} label="Completed" active={!!filters.showCompleted} />
      </button>
      {activeFilterCount(filters) > 0 && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            setSearch("");
            onChange(viewOptions(filters));
          }}
        >
          Clear
        </button>
      )}
      <span className="spacer" />
      <DisplayMenu filters={filters} set={set} showGrouping={showGrouping} />
      {trailing}
    </div>
  );
}
