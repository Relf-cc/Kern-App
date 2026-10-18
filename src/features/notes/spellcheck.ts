/**
 * @Author Christian Relf
 * @Date 2026-10-18
 */

// Spell checking in the note editor.
//
// WebView2 underlines misspelled words but its context menu offers no
// corrections, so on Windows Kern does both itself: the backend asks the
// operating system's dictionaries which runs are wrong (see
// src-tauri/src/domain/spelling.rs) and this plugin underlines them and hands
// the editor a list of corrections on right-click. Where the webview does
// offer corrections (macOS, Linux) `spellcheckAvailable` is false and we stay
// out of the way entirely.
//
// Results are cached by the text of the block they came from, so moving a
// paragraph, undoing or reloading a note costs nothing, and the squiggles
// follow the text through edits without re-asking.

import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { Node as PmNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { api, isTauri } from "@/lib/ipc";
import { getSetting } from "@/stores/settings";

/** One underlined run, as positions in the live document. */
export interface SpellMark {
  from: number;
  to: number;
  word: string;
  /** The one right answer when the checker is certain; "" means delete it. */
  replacement: string | null;
}

interface SpellState {
  marks: SpellMark[];
}

const key = new PluginKey<SpellState>("kernSpellcheck");

/** Blocks shorter than this are never worth a round trip. */
const MIN_LEN = 2;

/** Settle time after typing before asking again. */
const DEBOUNCE = 450;

/** Blocks we have answers for, keyed by their exact text. */
const cache = new Map<string, SpellMark[]>();
const CACHE_LIMIT = 600;

function remember(text: string, marks: SpellMark[]) {
  if (cache.size >= CACHE_LIMIT) {
    // Oldest first - a plain Map iterates in insertion order.
    for (const k of cache.keys()) {
      cache.delete(k);
      if (cache.size < CACHE_LIMIT) break;
    }
  }
  cache.set(text, marks);
}

/**
 * Whether Kern checks spelling itself here. Asked once per session; the
 * answer never changes while the app is running.
 */
let probe: Promise<boolean> | undefined;
export function spellcheckAvailable(): Promise<boolean> {
  if (!isTauri) return Promise.resolve(false);
  probe ??= api.spell.supported().catch(() => false);
  return probe;
}

/** Live for this session only, so the editor can stop asking straight away. */
let available = false;
void spellcheckAvailable().then((ok) => (available = ok));

const enabled = () => available && getSetting("editor.spellcheck");

/** Each live editor's "check again" trigger, so actions outside can ask. */
const refreshers = new WeakMap<EditorView, () => void>();

// ------------------------------------------------------------------ blocks

interface Block {
  /** Position of the block node itself; its text starts one further in. */
  pos: number;
  text: string;
}

/**
 * The text of every top-level-ish text block, with leaf nodes replaced by a
 * single space so offsets line up one-for-one with the document positions.
 */
function blocksOf(doc: PmNode): Block[] {
  const out: Block[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Code is not prose; nobody wants "fn" underlined.
    if (node.type.name === "codeBlock") return false;
    const text = node.textBetween(0, node.content.size, undefined, " ");
    if (text.trim().length >= MIN_LEN) out.push({ pos, text });
    return false;
  });
  return out;
}

function marksFor(block: Block): SpellMark[] | undefined {
  const hits = cache.get(block.text);
  if (!hits) return undefined;
  return hits.map((m) => ({ ...m, from: m.from + block.pos + 1, to: m.to + block.pos + 1 }));
}

/** The text the document actually holds between two positions. */
const textAt = (doc: PmNode, from: number, to: number) =>
  from >= 0 && to <= doc.content.size ? doc.textBetween(from, to, undefined, " ") : "";

// ------------------------------------------------------------------ queries

/** The underlined run at a document position, if there is one. */
export function spellMarkAt(state: EditorState, pos: number): SpellMark | null {
  const s = key.getState(state);
  if (!s || !enabled()) return null;
  return s.marks.find((m) => pos >= m.from && pos <= m.to) ?? null;
}

/** The underlined run under a point on screen, if there is one. */
export function spellMarkAtCoords(view: EditorView, left: number, top: number): SpellMark | null {
  const at = view.posAtCoords({ left, top });
  return at ? spellMarkAt(view.state, at.pos) : null;
}

// ----------------------------------------------------------------- plugin

export const Spellcheck = Extension.create({
  name: "kernSpellcheck",

  addProseMirrorPlugins() {
    let timer: number | undefined;
    let running = false;

    /** Asks about every block we have no answer for, then redraws. */
    const refresh = async (view: EditorView) => {
      if (running || !enabled()) return;
      const wanted = [...new Set(blocksOf(view.state.doc).map((b) => b.text))].filter((t) => !cache.has(t));
      if (wanted.length) {
        running = true;
        try {
          const answers = await api.spell.check(wanted);
          wanted.forEach((text, i) =>
            remember(
              text,
              (answers[i] ?? []).map((r) => ({ from: r.start, to: r.start + r.len, word: text.slice(r.start, r.start + r.len), replacement: r.replacement })),
            ),
          );
        } catch {
          // No corrections is the worst case; never interrupt writing for it.
          for (const text of wanted) remember(text, []);
        } finally {
          running = false;
        }
      }
      if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, true));
    };

    const schedule = (view: EditorView) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(view), DEBOUNCE);
    };

    return [
      new Plugin<SpellState>({
        key,
        state: {
          init: () => ({ marks: [] }),
          apply(tr, value, _old, state) {
            // A fresh pass rebuilds from the cache; anything else just moves
            // the existing runs along with the text, dropping any whose word
            // has since been edited.
            if (tr.getMeta(key)) {
              const marks: SpellMark[] = [];
              for (const b of blocksOf(state.doc)) marks.push(...(marksFor(b) ?? []));
              return { marks };
            }
            if (!tr.docChanged) return value;
            const marks = value.marks
              .map((m) => ({ ...m, from: tr.mapping.map(m.from, -1), to: tr.mapping.map(m.to, 1) }))
              .filter((m) => m.to > m.from && textAt(tr.doc, m.from, m.to) === m.word);
            return { marks };
          },
        },
        props: {
          decorations(state) {
            const s = key.getState(state);
            if (!s?.marks.length || !enabled()) return null;
            const caret = state.selection.empty ? state.selection.from : -1;
            // A word still being typed is not yet a mistake.
            const visible = s.marks.filter((m) => caret < m.from || caret > m.to);
            return DecorationSet.create(
              state.doc,
              visible.map((m) => Decoration.inline(m.from, m.to, { class: "spell-error" })),
            );
          },
        },
        view(view) {
          refreshers.set(view, () => schedule(view));
          schedule(view);
          return {
            update(v, prev) {
              if (!v.state.doc.eq(prev.doc)) schedule(v);
            },
            destroy() {
              refreshers.delete(view);
              window.clearTimeout(timer);
            },
          };
        },
      }),
    ];
  },
});

// ------------------------------------------------------------------ actions

/**
 * Stops underlining a word everywhere - the dictionary has just learned it,
 * or it has been ignored for the session. Other mistakes in the same
 * paragraph stay underlined.
 */
export function forgetWord(word: string) {
  for (const [text, marks] of cache) {
    if (marks.some((m) => m.word === word)) cache.set(text, marks.filter((m) => m.word !== word));
  }
}

/** Redraws from what we know, then checks anything new in the background. */
export function rescanSpelling(view: EditorView) {
  if (view.isDestroyed) return;
  view.dispatch(view.state.tr.setMeta(key, true));
  refreshers.get(view)?.();
}
