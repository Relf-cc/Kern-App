/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { Checkbox as RCheckbox, Select as RSelect, Slider as RSlider, Switch as RSwitch, Popover as RPopover } from "radix-ui";
import { Check, ChevronDown, Minus, type LucideIcon } from "lucide-react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from "react";
import { Tooltip } from "./Tooltip";

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <RSwitch.Root className="switch" checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label}>
      <RSwitch.Thumb className="switch__thumb" />
    </RSwitch.Root>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  indeterminate,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  indeterminate?: boolean;
  disabled?: boolean;
}) {
  return (
    <RCheckbox.Root
      className="checkbox"
      disabled={disabled}
      checked={indeterminate ? "indeterminate" : checked}
      onCheckedChange={(v) => onChange(v === true)}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
    >
      <RCheckbox.Indicator>{indeterminate ? <Minus /> : <Check />}</RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

/** Round completion control for tasks. */
export function TaskCheck({
  checked,
  onToggle,
  priority = 0,
  blocked,
  cancelled,
  size,
}: {
  checked: boolean;
  /** The click is passed through so callers can anchor an effect to the control. */
  onToggle: (e?: ReactMouseEvent<HTMLButtonElement>) => void;
  priority?: number;
  blocked?: boolean;
  /** Closed without being done (cancelled or duplicate): shows a cross. */
  cancelled?: boolean;
  size?: number;
}) {
  return (
    <button
      type="button"
      className="task-check"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? (cancelled ? "Reopen" : "Mark incomplete") : "Mark complete"}
      data-checked={checked}
      data-cancelled={(checked && cancelled) || undefined}
      data-priority={checked ? undefined : priority}
      data-blocked={blocked || undefined}
      style={size ? ({ "--size": `${size}px` } as CSSProperties) : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e);
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Drawn from the short stroke so the tick "writes" itself in. */}
      <svg viewBox="0 0 24 24" aria-hidden>
        {checked && cancelled ? <path d="M7.5 7.5l9 9M16.5 7.5l-9 9" pathLength={1} /> : <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} />}
      </svg>
    </button>
  );
}

/**
 * A task title with an animated strikethrough. Completing draws a fine line
 * from left to right across the text itself (never the whole card).
 * Single-line titles use a scaled pseudo-element (compositor-only); wrapped
 * titles sweep a 1px underline-style background across each line in reading
 * order, so the line never crosses empty space. No layout is measured.
 */
export function TaskTitle({
  title,
  done,
  wrap,
  className = "",
}: {
  title: string;
  done: boolean;
  wrap?: boolean;
  className?: string;
}) {
  return wrap ? (
    <span className={`strike strike--wrap ${className}`} data-done={done}>
      <span className="strike__text">{title}</span>
    </span>
  ) : (
    <span className={`strike ${className}`} data-done={done}>
      {title}
    </span>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label?: string;
  icon?: LucideIcon;
  tooltip?: string;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegOption<T>[];
  size?: "md" | "sm" | "lg";
  ariaLabel?: string;
}) {
  return (
    <div className={`segmented${size === "md" ? "" : ` segmented--${size}`}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => {
        const Icon = o.icon;
        const btn = (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            aria-label={o.tooltip ?? o.label}
            className="segmented__item"
            data-state={value === o.value ? "on" : "off"}
            onClick={() => onChange(o.value)}
          >
            {Icon && <Icon strokeWidth={1.75} />}
            {o.label}
          </button>
        );
        return o.tooltip && !o.label ? (
          <Tooltip key={o.value} content={o.tooltip}>
            {btn}
          </Tooltip>
        ) : (
          btn
        );
      })}
    </div>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  style,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  ariaLabel?: string;
  style?: CSSProperties;
}) {
  return (
    <RSelect.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <RSelect.Trigger className="select-trigger" aria-label={ariaLabel} style={style}>
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon>
          <ChevronDown />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content className="select-content" position="popper" sideOffset={4} collisionPadding={8}>
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item key={o.value} value={o.value} className="menu__item">
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                <RSelect.ItemIndicator className="menu__check">
                  <Check size={14} />
                </RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

export function Slider({
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 1,
  ariaLabel,
  width,
}: {
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  ariaLabel?: string;
  width?: number;
}) {
  return (
    <RSlider.Root
      className="slider"
      style={width ? { width } : undefined}
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange(v[0])}
      onValueCommit={(v) => onCommit?.(v[0])}
      aria-label={ariaLabel}
    >
      <RSlider.Track className="slider__track">
        <RSlider.Range className="slider__range" />
      </RSlider.Track>
      <RSlider.Thumb className="slider__thumb" aria-label={ariaLabel} />
    </RSlider.Root>
  );
}

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  align = "start",
  side = "bottom",
  pad,
  className = "",
  modal,
}: {
  trigger: ReactElement;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  pad?: boolean;
  className?: string;
  modal?: boolean;
}) {
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          className={`popover ${pad ? "popover--pad" : ""} ${className}`}
          align={align}
          side={side}
          sideOffset={6}
          collisionPadding={10}
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

export function Progress({ value, style }: { value: number; style?: CSSProperties }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="progress" style={style} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress__bar" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Ring({ value, size = 18, stroke = 2.5 }: { value: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle className="ring__track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
      <circle
        className="ring__bar"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v)}
      />
    </svg>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  compact,
}: {
  icon?: LucideIcon;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty ${compact ? "empty--compact" : ""}`}>
      {Icon && <Icon strokeWidth={1.5} />}
      {title && <div className="empty__title">{title}</div>}
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}

export function Skeleton({ width, height = 12, style }: { width?: number | string; height?: number; style?: CSSProperties }) {
  return <div className="skeleton" style={{ width, height, ...style }} />;
}
