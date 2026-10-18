/**
 * @Author Christian Relf
 * @Date 2026-10-18
 */

// Confetti, drawn outside React so anything can call it: a full-window shower
// (the Konami code) or a small burst from a point (finishing a card on a
// board). Decoration only - both sit out when motion is reduced, and nothing
// here touches data.

const COLORS = ["#8aa9dc", "#a597dd", "#8bb795", "#d2ad73", "#cf929d", "#7bb5ae", "#e3a072", "#e391bd"];

/** Reduced motion: the caller's message still lands, just without the movement. */
export const calmMotion = () => {
  const m = document.documentElement.dataset.motion;
  return m === "reduced" || m === "off";
};

function layer(cls: string, lifetime: number): HTMLDivElement {
  const el = document.createElement("div");
  el.className = cls;
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), lifetime);
  return el;
}

/** Full-window confetti falling from the top. */
export function confettiBurst(pieces = 90) {
  if (calmMotion()) return;
  const l = layer("confetti", 3600);
  for (let i = 0; i < pieces; i++) {
    const p = document.createElement("i");
    const w = 5 + Math.random() * 5;
    p.style.cssText = `left:${Math.random() * 100}%;width:${w}px;height:${w * 1.6}px;background:${COLORS[i % COLORS.length]};--dx:${(Math.random() - 0.5) * 240}px;--r:${Math.random() * 1080 - 540}deg;--t:${1600 + Math.random() * 1400}ms;--d:${Math.random() * 500}ms`;
    l.appendChild(p);
  }
}

/** A small burst thrown outwards from a point in viewport coordinates. */
export function confettiAt(x: number, y: number, pieces = 22) {
  if (calmMotion()) return;
  const l = layer("confetti confetti--point", 1300);
  for (let i = 0; i < pieces; i++) {
    const p = document.createElement("i");
    const w = 4 + Math.random() * 4;
    // Fan the pieces upwards and outwards, then let them drop a little.
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
    const dist = 40 + Math.random() * 70;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist + 40 + Math.random() * 40;
    p.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${w * 1.6}px;background:${COLORS[i % COLORS.length]};--dx:${dx.toFixed(1)}px;--dy:${dy.toFixed(1)}px;--r:${Math.random() * 540 - 270}deg;--t:${700 + Math.random() * 350}ms;--d:${Math.random() * 90}ms`;
    l.appendChild(p);
  }
}

/** The same burst, centred on an element's box (ignored if it has no box). */
export function confettiAtRect(rect: { left: number; top: number; width: number; height: number } | null | undefined, pieces?: number) {
  if (!rect || (!rect.width && !rect.height)) return;
  confettiAt(rect.left + rect.width / 2, rect.top + rect.height / 2, pieces);
}
