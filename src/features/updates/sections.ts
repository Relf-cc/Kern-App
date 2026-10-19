/**
 * @Author Christian Relf
 * @Date 2026-10-19
 */

// Release notes written in Kern's own shape (see "Write a release body" in
// CLAUDE.md) read as a short list of themes, each a heading and a flat list
// of one-line bullets whose opening phrase is bold:
//
//   ### Flowcharts on whiteboards
//   - Six new **flowchart shapes** in the shape menu.
//
//   ### Fixes
//   - **Sync no longer flickers.** A failed round waits out its backoff.
//
// Parsing that shape lets What's new lay it out itself — a titled group per
// theme, a lead line and its detail per bullet — instead of pouring the whole
// body through the Markdown renderer. Anything that isn't in the shape (an
// older release, a hand-written note, a table or a code block) returns null
// and is rendered as plain Markdown instead, so this never has to guess.

/** Which kind of change a theme covers; What's new picks its icon from this. */
export type SectionKind = "feature" | "fix" | "security";

/** One bullet: the bold opening phrase, if it has one, and the rest of the line. */
export interface NoteItem {
  lead: string | null;
  rest: string;
}

export interface NoteSection {
  /** null for bullets that open the notes, before any heading. */
  title: string | null;
  kind: SectionKind;
  items: NoteItem[];
}

export interface ParsedNotes {
  /** Any text before the first heading or bullet, as inline Markdown. */
  intro: string | null;
  sections: NoteSection[];
}

const HEADING = /^(#{1,4})\s+(.*?)\s*#*\s*$/;
const BULLET = /^[-*+]\s+(.+)$/;
const INDENTED = /^\s+(.*\S)\s*$/;
/** A bold run opening a bullet: "**Sync no longer flickers.** A failed round …" or "**Day planner** — …". */
const LEAD = /^\*\*(.+?)\*\*(\s*[—–-]\s+|\s+|$)/;

function kindOf(title: string): SectionKind {
  if (/\bsecurity\b/i.test(title)) return "security";
  if (/^(fix|fixes|fixed|bug ?fixes?|fixes? and|smaller fixes)\b/i.test(title)) return "fix";
  return "feature";
}

function item(text: string): NoteItem {
  const t = text.trim();
  const m = LEAD.exec(t);
  if (!m) return { lead: null, rest: t };
  const rest = t.slice(m[0].length).trim();
  // A headline closes its own sentence ("**… flickers.** A failed round …"), is set off by a
  // dash, or is the whole bullet. A bold run that merely opens one ("**Blur the window** when
  // you switch apps") is part of the sentence and stays in it.
  if (rest && !/[.:!?]$/.test(m[1]) && !/[—–-]/.test(m[2])) return { lead: null, rest: t };
  // A full stop closing a headline goes with it; an ellipsis in a menu name stays.
  return { lead: m[1].trim().replace(/[.:;,]+$/, ""), rest };
}

/**
 * Reads notes (already trimmed by `inAppNotes`) as themed sections, or returns
 * null when they aren't in that shape and should be rendered as Markdown.
 */
export function parseNotes(text: string): ParsedNotes | null {
  const lines = text.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const intro: string[] = [];
  const sections: NoteSection[] = [];
  let open: NoteSection | null = null;
  let bullet: string[] | null = null;

  const flush = () => {
    if (bullet && open) open.items.push(item(bullet.join(" ")));
    bullet = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      if (!heading[2]) return null;
      open = { title: heading[2], kind: kindOf(heading[2]), items: [] };
      sections.push(open);
      continue;
    }
    const li = BULLET.exec(line);
    if (li) {
      flush();
      if (!open) {
        open = { title: null, kind: "feature", items: [] };
        sections.push(open);
      }
      bullet = [li[1]];
      continue;
    }
    const wrapped = INDENTED.exec(line);
    if (wrapped && bullet) {
      // A wrapped bullet, or a nested one: part of the line above either way.
      bullet.push(wrapped[1].replace(BULLET, "$1"));
      continue;
    }
    // A paragraph, quote, table or code block: in the shape only as an opening line.
    if (sections.length) return null;
    intro.push(line.trim());
  }
  flush();

  const kept = sections.filter((s) => s.items.length);
  if (!kept.length) return null;
  return { intro: intro.join("\n") || null, sections: kept };
}
