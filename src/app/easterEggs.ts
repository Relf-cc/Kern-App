/**
 * @Author Christian Relf
 * @Date 2026-10-14
 */

// A few small secrets. None of them touch data; all of them respect reduced
// motion (you still get the message, just not the movement).
//
//  - The Konami code (↑ ↑ ↓ ↓ ← → ← → B A) anywhere: a confetti party and a
//    brief rainbow accent.
//  - Completing a task called "do a barrel roll": the window does one.
//  - Settings → About: click the logo five times.

import { useEffect } from "react";
import { toast } from "@/stores/toast";
import { calmMotion as calm, confettiBurst } from "@/lib/confetti";

const KONAMI = ["arrowup", "arrowup", "arrowdown", "arrowdown", "arrowleft", "arrowright", "arrowleft", "arrowright", "b", "a"];

function party() {
  toast("Cheat code accepted: +30 lives.", { tone: "success" });
  confettiBurst();
  if (calm()) return;
  const root = document.documentElement;
  root.classList.add("egg-rainbow");
  window.setTimeout(() => root.classList.remove("egg-rainbow"), 4000);
}

function barrelRoll() {
  toast("Wheee!", { tone: "success" });
  if (calm()) return;
  const root = document.getElementById("root");
  if (!root || root.classList.contains("egg-roll")) return;
  root.classList.add("egg-roll");
  window.setTimeout(() => root.classList.remove("egg-roll"), 1300);
}

/** Called when a task is completed. */
export function taskEasterEgg(title: string) {
  const t = title.trim().toLowerCase().replace(/[!.?]+$/, "");
  if (t === "do a barrel roll" || t === "barrel roll") barrelRoll();
}

/** Listens for the Konami code (Kern and Kern Lite). */
export function useEasterEggs() {
  useEffect(() => {
    let pos = 0;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      // An extra ↑ before the ↓s keeps the last two ups.
      pos = k === KONAMI[pos] ? pos + 1 : k === "arrowup" ? (pos === 2 ? 2 : 1) : 0;
      if (pos === KONAMI.length) {
        pos = 0;
        party();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
