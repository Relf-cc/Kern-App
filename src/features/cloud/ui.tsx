/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// Small shared pieces for Kern Cloud: avatars, workspace logos, the code
// input and logo processing.

import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import { Cloud, HardDrive, User } from "lucide-react";
import type { SpaceRole } from "@/lib/types";
import { PROJECT_ICONS, accentColor, iconEmoji } from "@/features/projects/ProjectGlyph";

const HUES = ["var(--hue-0)", "var(--hue-1)", "var(--hue-2)", "var(--hue-3)", "var(--hue-4)", "var(--hue-5)", "var(--hue-6)", "var(--hue-7)"];

export function hueFor(key: string) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ name, image, color, size = 22, ring, title }: { name: string; image?: string | null; color?: string; size?: number; ring?: string; title?: string | null }) {
  const style: CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.max(9, Math.round(size * 0.4)),
    background: image ? undefined : color ?? hueFor(name),
    boxShadow: ring ? `0 0 0 2px var(--surface-2), 0 0 0 3.5px ${ring}` : undefined,
  };
  return (
    <span className="avatar" style={style} title={title === null ? undefined : title ?? name} aria-label={title || name}>
      {image ? <img src={image} alt="" /> : initials(name)}
    </span>
  );
}

export function SpaceLogo({ name, logo, kind, size = 20, accent, icon }: { name: string; logo?: string | null; kind?: "personal" | "workspace" | "offline"; size?: number; accent?: string | null; icon?: string | null }) {
  const style: CSSProperties = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.45)), borderRadius: Math.round(size * 0.28) };
  if (kind === "offline")
    return (
      <span className="space-logo space-logo--icon" style={style} aria-hidden>
        <HardDrive size={Math.round(size * 0.62)} strokeWidth={1.75} />
      </span>
    );
  if (kind === "personal")
    return (
      <span className="space-logo space-logo--icon" style={style} aria-hidden>
        <User size={Math.round(size * 0.62)} strokeWidth={1.75} />
      </span>
    );
  if (logo)
    return (
      <span className="space-logo" style={style} aria-hidden>
        <img src={logo} alt="" />
      </span>
    );
  const emoji = iconEmoji(icon);
  const Icon = icon && !emoji ? PROJECT_ICONS[icon] : undefined;
  return (
    <span className="space-logo" style={{ ...style, background: accentColor(accent) ?? hueFor(name), color: "#111" }} aria-hidden>
      {emoji ? (
        <span style={{ fontSize: Math.round(size * 0.6), lineHeight: 1 }}>{emoji}</span>
      ) : Icon ? (
        <Icon size={Math.round(size * 0.6)} strokeWidth={2} />
      ) : (
        name.trim().slice(0, 1).toUpperCase() || <Cloud size={12} />
      )}
    </span>
  );
}

/** A workspace's optional mark and tint, kept in its shared settings. */
export function spaceLook(settings: Record<string, unknown> | null | undefined): { icon: string | null; tint: boolean } {
  const icon = settings?.icon;
  return { icon: typeof icon === "string" && icon ? icon : null, tint: settings?.tint === true };
}

/**
 * Accent variables for tinting the interface with a colour: the colour, a
 * readable foreground and soft/line variants. Null for an unusable colour.
 */
export function tintVars(color: string | undefined): Record<string, string> | null {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return null;
  const n = parseInt(color.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return {
    "--accent": color,
    "--accent-fg": lum > 0.55 ? "#111111" : "#ffffff",
    "--accent-soft": `rgba(${r}, ${g}, ${b}, 0.14)`,
    "--accent-line": `rgba(${r}, ${g}, ${b}, 0.7)`,
  };
}

export const ROLE_LABEL: Record<SpaceRole, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };
export const ROLE_HINT: Record<SpaceRole, string> = {
  owner: "Full control, including deleting the workspace",
  admin: "Manage details, members and invitations",
  member: "Create and edit projects, tasks, boards, notes and whiteboards",
  viewer: "See everything, change nothing",
};

/** Six-digit one-time code input. */
export function CodeInput({ value, onChange, onComplete, autoFocus }: { value: string; onChange: (v: string) => void; onComplete?: (v: string) => void; autoFocus?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? "");
  const setAt = (i: number, d: string) => {
    const next = (value.slice(0, i) + d + value.slice(i + 1)).replace(/\D/g, "").slice(0, 6);
    onChange(next);
    if (next.length === 6) onComplete?.(next);
  };
  const onKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[i] && i > 0) {
      e.preventDefault();
      onChange(value.slice(0, i - 1));
      refs.current[i - 1]?.focus();
    } else if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === "ArrowRight" && i < 5) refs.current[i + 1]?.focus();
  };
  return (
    <div className="code-input" role="group" aria-label="Six-digit code">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="code-input__cell mono"
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={6}
          value={d}
          autoFocus={autoFocus && i === 0}
          aria-label={`Digit ${i + 1}`}
          onKeyDown={(e) => onKey(i, e)}
          onFocus={(e) => e.currentTarget.select()}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
            if (!text) return;
            e.preventDefault();
            onChange(text);
            refs.current[Math.min(text.length, 5)]?.focus();
            if (text.length === 6) onComplete?.(text);
          }}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "");
            if (!v) {
              onChange(value.slice(0, i) + value.slice(i + 1));
              return;
            }
            if (v.length > 1) {
              const merged = (value.slice(0, i) + v).slice(0, 6);
              onChange(merged);
              refs.current[Math.min(merged.length, 5)]?.focus();
              if (merged.length === 6) onComplete?.(merged);
              return;
            }
            setAt(i, v);
            if (i < 5) refs.current[i + 1]?.focus();
          }}
        />
      ))}
    </div>
  );
}

/** Reads an image file, crops it to a centred square and returns a small WebP data URL. */
export async function processLogo(file: File, size = 256): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP, GIF or SVG image.");
  if (file.size > 10 * 1024 * 1024) throw new Error("That image is larger than 10 MB.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That image couldn't be read."));
      i.src = url;
    });
    const w = img.naturalWidth || size;
    const h = img.naturalHeight || size;
    const side = Math.min(w, h);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("That image couldn't be processed.");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
    let out = canvas.toDataURL("image/webp", 0.86);
    if (!out.startsWith("data:image/webp")) out = canvas.toDataURL("image/png");
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function timeAgo(iso: string | number | null | undefined) {
  if (!iso) return "never";
  const t = typeof iso === "number" ? iso : new Date(iso).getTime();
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
