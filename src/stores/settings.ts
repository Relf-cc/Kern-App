/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { create } from "zustand";
import { api } from "@/lib/ipc";
import { dateConfig } from "@/lib/dates";
import { DEFAULTS, type SettingKey, type Settings } from "@/features/settings/schema";

interface SettingsState {
  values: Settings;
  /** Everything stored, including internal keys (e.g. "internal.lastRoute"). */
  raw: Record<string, unknown>;
  loaded: boolean;
  load: () => Promise<void>;
  set: <K extends SettingKey>(key: K, value: Settings[K]) => Promise<void>;
  setMany: (entries: Partial<Settings>) => Promise<void>;
  reset: (keys?: SettingKey[]) => Promise<void>;
}

function sanitize(raw: Record<string, unknown>): Settings {
  const out = { ...DEFAULTS } as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in DEFAULTS)) continue;
    const def = (DEFAULTS as unknown as Record<string, unknown>)[k];
    // Ignore values whose type doesn't match the default (malformed data).
    if (def !== null && v !== null && typeof def !== typeof v) continue;
    if (def && typeof def === "object" && !Array.isArray(def) && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = { ...(def as object), ...(v as object) };
    } else {
      out[k] = v;
    }
  }
  return out as unknown as Settings;
}

function syncDerived(v: Settings) {
  dateConfig.dateFormat = v["tasks.dateFormat"];
  dateConfig.timeFormat = v["tasks.timeFormat"];
  dateConfig.weekStart = v["tasks.weekStart"];
}

export const useSettings = create<SettingsState>((set, get) => ({
  values: DEFAULTS,
  raw: {},
  loaded: false,
  load: async () => {
    const raw = await api.settings.getAll();
    const values = sanitize(raw);
    syncDerived(values);
    set({ values, raw, loaded: true });
  },
  set: async (key, value) => {
    const values = { ...get().values, [key]: value };
    syncDerived(values);
    set({ values });
    await api.settings.set({ [key]: value });
  },
  setMany: async (entries) => {
    const values = { ...get().values, ...entries };
    syncDerived(values);
    set({ values });
    await api.settings.set(entries as Record<string, unknown>);
  },
  reset: async (keys) => {
    await api.settings.reset(keys as string[] | undefined);
    await get().load();
  },
}));

/** Subscribe to a single setting. */
export function useSetting<K extends SettingKey>(key: K): Settings[K] {
  return useSettings((s) => s.values[key]);
}

export function getSetting<K extends SettingKey>(key: K): Settings[K] {
  return useSettings.getState().values[key];
}

export function setSetting<K extends SettingKey>(key: K, value: Settings[K]) {
  return useSettings.getState().set(key, value);
}

/** Several settings in one write (keys that have to change together). */
export function setSettings(entries: Partial<Settings>) {
  return useSettings.getState().setMany(entries);
}
