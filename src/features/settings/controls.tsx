/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Small bound controls for the settings screen. Each reads and writes one
// setting key; changes apply immediately and persist.

import type { ReactNode } from "react";
import { useSetting, setSetting, setSettings } from "@/stores/settings";
import type { SettingKey, Settings } from "./schema";
import { Segmented, Select, Slider, Switch } from "@/components/ui/Controls";
import { useState } from "react";

type KeysOfType<T> = { [K in SettingKey]: Settings[K] extends T ? K : never }[SettingKey];

export interface RowDef {
  label: string;
  hint?: ReactNode;
  control?: ReactNode;
  /** Extra text matched by settings search. */
  keywords?: string;
  /** Renders below the label, full width (lists, editors). */
  block?: ReactNode;
}

export interface GroupDef {
  /** Anchor for in-page links. */
  id?: string;
  title?: string;
  rows: RowDef[];
}

/** `clears` lists settings this one contradicts: they go off as it goes on. */
export function SToggle({ k, label, clears }: { k: KeysOfType<boolean>; label?: string; clears?: KeysOfType<boolean>[] }) {
  const v = useSetting(k) as boolean;
  const change = (x: boolean) => {
    if (!x || !clears?.length) return void setSetting(k, x as never);
    const entries = Object.fromEntries([[k, true], ...clears.map((other) => [other, false])]);
    void setSettings(entries as Partial<Settings>);
  };
  return <Switch checked={v} onChange={change} label={label} />;
}

export function SSelect<K extends SettingKey>({
  k,
  options,
  width,
}: {
  k: K;
  options: { value: string; label: string }[];
  width?: number;
}) {
  const v = useSetting(k);
  return (
    <Select
      value={String(v)}
      onChange={(x) => {
        const sample = options.find((o) => o.value === x);
        if (!sample) return;
        const current = v as unknown;
        const parsed = typeof current === "number" ? Number(x) : x === "__null" ? null : x;
        void setSetting(k, parsed as Settings[K]);
      }}
      options={options}
      style={width ? { minWidth: width } : undefined}
    />
  );
}

export function SSegmented<K extends SettingKey>({ k, options }: { k: K; options: { value: string; label: string }[] }) {
  const v = useSetting(k);
  return (
    <Segmented
      size="sm"
      value={String(v)}
      onChange={(x) => {
        const parsed = typeof v === "number" ? Number(x) : x;
        void setSetting(k, parsed as Settings[K]);
      }}
      options={options}
    />
  );
}

export function SSlider({
  k,
  min,
  max,
  step,
  format,
}: {
  k: KeysOfType<number>;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
}) {
  const stored = useSetting(k) as number;
  const [live, setLive] = useState<number | null>(null);
  const v = live ?? stored;
  return (
    <div className="row" style={{ gap: 10 }}>
      <Slider
        value={v}
        min={min}
        max={max}
        step={step}
        onChange={setLive}
        onCommit={(x) => {
          setLive(null);
          void setSetting(k, x as never);
        }}
        width={150}
      />
      <span className="tabular faint" style={{ fontSize: "var(--fs-xs)", minWidth: 44, textAlign: "right" }}>
        {format ? format(v) : v}
      </span>
    </div>
  );
}

export function STime({ k }: { k: KeysOfType<string> }) {
  const v = useSetting(k) as string;
  return (
    <input
      className="input"
      type="time"
      value={v}
      onChange={(e) => /^\d{2}:\d{2}$/.test(e.target.value) && void setSetting(k, e.target.value as never)}
      style={{ width: 110 }}
    />
  );
}

export function SNumber({ k, min, max, suffix, width = 76 }: { k: KeysOfType<number>; min: number; max: number; suffix?: string; width?: number }) {
  const v = useSetting(k) as number;
  const [text, setText] = useState<string | null>(null);
  return (
    <div className="row" style={{ gap: 6 }}>
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        value={text ?? String(v)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Math.round(Number(text));
          setText(null);
          if (text !== null && !Number.isNaN(n)) void setSetting(k, Math.max(min, Math.min(max, n)) as never);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        style={{ width }}
      />
      {suffix && <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>{suffix}</span>}
    </div>
  );
}
