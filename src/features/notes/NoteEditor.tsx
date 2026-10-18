/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { useEditor, EditorContent, BubbleMenu, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { NoteFavicons } from "@/features/links/noteFavicons";
import { Spellcheck, forgetWord, rescanSpelling, spellMarkAtCoords, spellcheckAvailable, type SpellMark } from "./spellcheck";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  SquareCode,
  Strikethrough,
  Plus,
  Pilcrow,
  SpellCheck2,
  BookPlus,
  Ban,
  Eraser,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { prompt } from "@/components/ui/Dialog";
import { api } from "@/lib/ipc";
import type { SearchHit } from "@/lib/types";
import { navigate } from "@/stores/router";
import { useSetting } from "@/stores/settings";
import { useOutsideDismiss } from "@/hooks/useOutsideDismiss";
import { openTask } from "@/features/tasks/menu";
import { FileText, FolderKanban, SquareCheckBig, Link as LinkIcon } from "lucide-react";

// ------------------------------------------------------------ [[ links
// Typing "[[" opens a picker of notes, tasks and projects; picking one
// inserts an ordinary Markdown link to kern://<kind>/<id>, which opens it
// with a click and shows up in the target's "Linked from".

const LINKABLE = new Set(["note", "task", "project"]);

/** Opens a kern://note|task|project/<id> link; false for anything else. */
export function openKernLink(href: string | null | undefined): boolean {
  const m = /^kern:\/\/(note|task|project)\/([A-Za-z0-9_-]+)/.exec(href ?? "");
  if (!m) return false;
  if (m[1] === "note") navigate({ name: "notes", id: m[2] });
  else if (m[1] === "task") openTask(m[2]);
  else navigate({ name: "project", id: m[2] });
  return true;
}

interface SpellState {
  mark: SpellMark;
  /** Where the click landed, in viewport coordinates. */
  x: number;
  y: number;
}

interface LinkState {
  /** Position of the "[[" that opened the picker. */
  from: number;
  query: string;
  index: number;
  left: number;
  top: number;
  up: boolean;
}

function detectLink(editor: Editor): LinkState | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if ($from.parent.type.name === "codeBlock") return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const m = /\[\[([^\[\]\n]{0,60})$/.exec(before);
  if (!m) return null;
  const from = selection.from - m[1].length - 2;
  const c = editor.view.coordsAtPos(from);
  const up = window.innerHeight - c.bottom < 300;
  return { from, query: m[1], index: 0, left: c.left, top: up ? c.top - 4 : c.bottom + 4, up };
}

const KIND_ICON = { note: FileText, task: SquareCheckBig, project: FolderKanban } as const;

function LinkPicker({ state, hits, onPick, onHover }: { state: LinkState; hits: SearchHit[]; onPick: (h: SearchHit) => void; onHover: (i: number) => void }) {
  return createPortal(
    <div
      className="menu slash-menu"
      role="listbox"
      aria-label="Link to"
      style={{ position: "fixed", left: state.left, ...(state.up ? { bottom: window.innerHeight - state.top } : { top: state.top }), minWidth: 280 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {!hits.length && (
        <div className="menu__item" aria-disabled>
          <LinkIcon strokeWidth={1.75} />
          <span className="faint">{state.query ? "No notes, tasks or projects match" : "Type to find a note, task or project"}</span>
        </div>
      )}
      {hits.map((h, i) => {
        const Icon = KIND_ICON[h.kind as keyof typeof KIND_ICON] ?? FileText;
        return (
          <div key={`${h.kind}:${h.id}`} className="menu__item" role="option" aria-selected={i === state.index} data-highlighted={i === state.index ? "" : undefined} onMouseEnter={() => onHover(i)} onClick={() => onPick(h)}>
            <Icon strokeWidth={1.75} />
            <span className="truncate grow">{h.title || "Untitled"}</span>
            <span className="menu__hint">{h.kind}</span>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

// ------------------------------------------------------- spelling menu

/**
 * Corrections for the word that was right-clicked. The webview underlines
 * misspellings on Windows but offers nothing to fix them, so this is the only
 * way to take a suggestion there.
 */
function SpellMenu({ editor, state, onClose }: { editor: Editor; state: SpellState; onClose: () => void }) {
  const { mark } = state;
  const ref = useRef<HTMLDivElement>(null);
  const [words, setWords] = useState<string[] | null>(null);
  useOutsideDismiss(ref, true, onClose, () => mark.from);

  useEffect(() => {
    let live = true;
    const done = (w: string[]) => live && setWords(w);
    void api.spell
      .suggest(mark.word)
      .then(done)
      .catch(() => done([]));
    return () => {
      live = false;
    };
  }, [mark.word]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const replace = (word: string) => {
    onClose();
    const range = { from: mark.from, to: mark.to };
    const chain = editor.chain().focus();
    // preserveWhitespace keeps the plain word plain instead of re-parsing it.
    if (word) chain.insertContentAt(range, word, { parseOptions: { preserveWhitespace: true } });
    else chain.deleteRange(range);
    chain.run();
  };

  const remember = async (forever: boolean) => {
    onClose();
    try {
      await (forever ? api.spell.add(mark.word) : api.spell.ignore(mark.word));
    } catch {
      // The word simply stays underlined; there is nothing to explain.
      return;
    }
    forgetWord(mark.word);
    rescanSpelling(editor.view);
  };

  // A certain answer ("teh" -> "the") leads; an empty one means the run is a
  // repeat and should just go.
  const repeat = mark.replacement === "";
  const list = repeat ? [] : [...new Set([mark.replacement, ...(words ?? [])].filter((w): w is string => !!w))];

  return createPortal(
    <div
      ref={ref}
      className="menu spell-menu"
      role="menu"
      aria-label={`Spelling of ${mark.word}`}
      style={{ position: "fixed", left: Math.min(state.x, window.innerWidth - 230), top: Math.min(state.y, window.innerHeight - 180) }}
    >
      {repeat ? (
        <button type="button" className="menu__item" role="menuitem" onClick={() => replace("")}>
          <Eraser strokeWidth={1.75} />
          <span className="grow">Remove the repeated word</span>
        </button>
      ) : list.length ? (
        list.map((w) => (
          <button type="button" key={w} className="menu__item" role="menuitem" onClick={() => replace(w)}>
            <SpellCheck2 strokeWidth={1.75} />
            <span className="truncate grow">{w}</span>
          </button>
        ))
      ) : (
        <div className="menu__item" aria-disabled>
          <SpellCheck2 strokeWidth={1.75} />
          <span className="faint">{words ? "No corrections" : "Looking…"}</span>
        </div>
      )}
      <div className="menu__sep" role="separator" />
      <button type="button" className="menu__item" role="menuitem" onClick={() => void remember(true)}>
        <BookPlus strokeWidth={1.75} />
        <span className="grow">Add to dictionary</span>
      </button>
      <button type="button" className="menu__item" role="menuitem" onClick={() => void remember(false)}>
        <Ban strokeWidth={1.75} />
        <span className="grow">Ignore for now</span>
      </button>
    </div>,
    document.body,
  );
}

export function getMarkdown(editor: Editor): string {
  return (editor.storage as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();
}

async function setLink(editor: Editor) {
  const prev = editor.getAttributes("link").href as string | undefined;
  const url = await prompt({ title: prev ? "Edit link" : "Add link", initial: prev ?? "https://", confirmLabel: "Apply" });
  if (url === null) return;
  if (!url || url === "https://") editor.chain().focus().extendMarkRange("link").unsetLink().run();
  else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
}

export function insertItems(editor: Editor) {
  return [
    { label: "Heading 1", icon: Heading1, shortcut: "# ", onSelect: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: "Heading 2", icon: Heading2, shortcut: "## ", onSelect: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: "Heading 3", icon: Heading3, shortcut: "### ", onSelect: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: "Bullet list", icon: List, shortcut: "- ", onSelect: () => editor.chain().focus().toggleBulletList().run() },
    { label: "Numbered list", icon: ListOrdered, shortcut: "1. ", onSelect: () => editor.chain().focus().toggleOrderedList().run() },
    { label: "Checklist", icon: ListChecks, shortcut: "[ ] ", onSelect: () => editor.chain().focus().toggleTaskList().run() },
    { label: "Quote", icon: Quote, shortcut: "> ", onSelect: () => editor.chain().focus().toggleBlockquote().run() },
    { label: "Code block", icon: SquareCode, shortcut: "``` ", onSelect: () => editor.chain().focus().toggleCodeBlock().run() },
    { label: "Divider", icon: Minus, shortcut: "---", onSelect: () => editor.chain().focus().setHorizontalRule().run() },
  ];
}

// ------------------------------------------------------------ slash menu

interface SlashState {
  /** Position of the "/" that opened the menu. */
  from: number;
  query: string;
  index: number;
  left: number;
  top: number;
  /** Open upwards when there's no room below. */
  up: boolean;
}

function slashItems(editor: Editor, query: string) {
  const all = [
    { label: "Text", icon: Pilcrow, shortcut: "", onSelect: () => editor.chain().focus().setParagraph().run() },
    ...insertItems(editor),
  ];
  const q = query.toLowerCase().replace(/\s/g, "");
  return q ? all.filter((i) => i.label.toLowerCase().replace(/\s/g, "").includes(q)) : all;
}

/** Finds a "/command" being typed just before the cursor. */
function detectSlash(editor: Editor): SlashState | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if ($from.parent.type.name === "codeBlock") return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const m = /(?:^|\s)\/([a-z0-9]{0,20})$/i.exec(before);
  if (!m) return null;
  const from = selection.from - m[1].length - 1;
  const c = editor.view.coordsAtPos(from);
  const up = window.innerHeight - c.bottom < 300;
  return { from, query: m[1], index: 0, left: c.left, top: up ? c.top - 4 : c.bottom + 4, up };
}

function SlashMenu({ editor, state, onPick, onHover }: { editor: Editor; state: SlashState; onPick: (i: number) => void; onHover: (i: number) => void }) {
  const items = slashItems(editor, state.query);
  if (!items.length) return null;
  return createPortal(
    <div
      className="menu slash-menu"
      role="listbox"
      aria-label="Insert block"
      style={{ position: "fixed", left: state.left, ...(state.up ? { bottom: window.innerHeight - state.top } : { top: state.top }) }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        const Icon = it.icon;
        return (
          <div
            key={it.label}
            className="menu__item"
            role="option"
            aria-selected={i === state.index}
            data-highlighted={i === state.index ? "" : undefined}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(i)}
          >
            <Icon strokeWidth={1.75} />
            <span className="truncate grow">{it.label}</span>
            {it.shortcut && <span className="menu__hint">{it.shortcut.trim()}</span>}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

/**
 * Markdown-backed rich text editor. Content is stored as Markdown (portable);
 * typing Markdown syntax formats inline, and "/" opens a block menu. Changes
 * are reported via onChange (debounced by the caller) and flushed on unmount.
 */
export function NoteEditor({
  initial,
  onChange,
  onFlush,
  onBlur,
  placeholder = "Start writing… Type / for blocks, [[ to link a note or task, or use Markdown: #, -, [ ], **bold**",
  autoFocus,
  onEditor,
  compact,
}: {
  initial: string;
  onChange: (markdown: string) => void;
  onFlush?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  onEditor?: (e: Editor | null) => void;
  /** Smaller type and no minimum height (task descriptions). */
  compact?: boolean;
}) {
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const blurRef = useRef(onBlur);
  blurRef.current = onBlur;
  const [slash, setSlash] = useState<SlashState | null>(null);
  const slashRef = useRef(slash);
  slashRef.current = slash;
  // The "/" whose menu was dismissed with Escape stays closed.
  const dismissedAt = useRef<number | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [linkPick, setLinkPick] = useState<LinkState | null>(null);
  const linkRef = useRef(linkPick);
  linkRef.current = linkPick;
  const [hits, setHits] = useState<SearchHit[]>([]);
  const hitsRef = useRef(hits);
  hitsRef.current = hits;
  const linkDismissedAt = useRef<number | null>(null);
  const [spell, setSpell] = useState<SpellState | null>(null);
  const spellOn = useSetting("editor.spellcheck");
  const linkQuery = linkPick?.query;
  useEffect(() => {
    if (linkQuery === undefined) return;
    let live = true;
    const run = async () => {
      const q = linkQuery.trim();
      const found = q ? await api.search(q, 12).catch(() => []) : (await api.notes.list(null).catch(() => [])).slice(0, 8).map((n) => ({ kind: "note" as const, id: n.id, parentId: n.projectId, title: n.title, snippet: "", meta: null }));
      if (live) setHits(found.filter((h) => LINKABLE.has(h.kind)).slice(0, 8));
    };
    const t = window.setTimeout(() => void run(), 120);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [linkQuery]);

  const pickLink = (e: Editor, h: SearchHit) => {
    const s = linkRef.current;
    if (!s) return;
    setLinkPick(null);
    const title = h.title || "Untitled";
    e.chain()
      .focus()
      .deleteRange({ from: s.from, to: e.state.selection.from })
      .insertContent([{ type: "text", text: title, marks: [{ type: "link", attrs: { href: `kern://${h.kind}/${h.id}` } }] }, { type: "text", text: " " }])
      .unsetMark("link")
      .run();
  };

  const pick = (e: Editor, i: number) => {
    const s = slashRef.current;
    if (!s) return;
    const item = slashItems(e, s.query)[i];
    setSlash(null);
    if (!item) return;
    e.chain().focus().deleteRange({ from: s.from, to: e.state.selection.from }).run();
    item.onSelect();
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true, protocols: ["kern"] }),
      NoteFavicons,
      Placeholder.configure({ placeholder }),
      Markdown.configure({ html: false, tightLists: true, linkify: true, transformPastedText: true, breaks: false }),
      Spellcheck,
    ],
    content: initial,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: { class: compact ? "prose prose--compact" : "prose", spellcheck: "true" },
      handleKeyDown: (_view, event) => {
        const ed = editorRef.current;
        const l = linkRef.current;
        if (l && ed) {
          const count = hitsRef.current.length;
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) {
            const d = event.key === "ArrowDown" ? 1 : -1;
            setLinkPick({ ...l, index: (l.index + d + count) % count });
            return true;
          }
          if ((event.key === "Enter" || event.key === "Tab") && count) {
            pickLink(ed, hitsRef.current[Math.min(l.index, count - 1)]);
            return true;
          }
          if (event.key === "Escape") {
            linkDismissedAt.current = l.from;
            setLinkPick(null);
            return true;
          }
        }
        const s = slashRef.current;
        if (!s || !ed) return false;
        const count = slashItems(ed, s.query).length;
        if (!count) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const d = event.key === "ArrowDown" ? 1 : -1;
          setSlash({ ...s, index: (s.index + d + count) % count });
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          pick(ed, s.index);
          return true;
        }
        if (event.key === "Escape") {
          dismissedAt.current = s.from;
          setSlash(null);
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        // Right-clicking a misspelling offers corrections. Everything else
        // keeps the webview's own menu (cut, copy, paste).
        contextmenu: (view, event) => {
          const m = spellMarkAtCoords(view, event.clientX, event.clientY);
          if (!m) return false;
          event.preventDefault();
          setSpell({ mark: m, x: event.clientX, y: event.clientY });
          return true;
        },
      },
      handleClick: (_view, _pos, event) => {
        const a = (event.target as HTMLElement).closest("a");
        // Links to notes, tasks and projects open with a click.
        if (a && openKernLink(a.getAttribute("href"))) return true;
        if (a && (event.ctrlKey || event.metaKey)) {
          void api.system.open(a.getAttribute("href") ?? "");
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => changeRef.current(getMarkdown(e)),
    onTransaction: ({ editor: e }) => {
      const nextLink = detectLink(e);
      if (!nextLink) linkDismissedAt.current = null;
      if (!nextLink || nextLink.from === linkDismissedAt.current) {
        if (linkRef.current) setLinkPick(null);
      } else {
        const prevLink = linkRef.current;
        setLinkPick(prevLink && prevLink.from === nextLink.from ? { ...nextLink, index: prevLink.query === nextLink.query ? prevLink.index : 0 } : nextLink);
      }
      const next = detectSlash(e);
      // Once the dismissed "/" is gone, a new one may open the menu again.
      if (!next) dismissedAt.current = null;
      if (!next || next.from === dismissedAt.current) {
        if (slashRef.current) setSlash(null);
        return;
      }
      const prev = slashRef.current;
      setSlash(prev && prev.from === next.from ? { ...next, index: prev.query === next.query ? prev.index : 0 } : next);
    },
    onBlur: () => {
      setSlash(null);
      setLinkPick(null);
      blurRef.current?.();
    },
  });
  editorRef.current = editor;

  // A fixed menu can't follow scrolling; close it instead.
  const slashOpen = !!slash || !!linkPick || !!spell;
  useEffect(() => {
    if (!slashOpen) return;
    const close = () => {
      setSlash(null);
      setLinkPick(null);
      setSpell(null);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [slashOpen]);

  // Our underline replaces the webview's. Where we have no checker (macOS,
  // Linux, or Windows with no dictionary installed) the webview keeps its own,
  // which offers corrections there anyway.
  useEffect(() => {
    if (!editor) return;
    let live = true;
    void spellcheckAvailable().then((ours) => {
      if (!live || editor.isDestroyed) return;
      editor.view.dom.setAttribute("spellcheck", ours && spellOn ? "false" : String(spellOn));
      rescanSpelling(editor.view);
    });
    return () => {
      live = false;
    };
  }, [editor, spellOn]);

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  useEffect(() => () => onFlush?.(), [onFlush]);

  if (!editor) return null;
  return (
    <>
      <BubbleMenu editor={editor} tippyOptions={{ duration: 120, maxWidth: "none" }} shouldShow={({ editor: e, from, to }) => from !== to && !e.isActive("codeBlock")}>
        <div className="bubble" role="toolbar" aria-label="Formatting">
          <IconButton icon={Bold} label="Bold" shortcut="Mod+B" size="sm" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} />
          <IconButton icon={Italic} label="Italic" shortcut="Mod+I" size="sm" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} />
          <IconButton icon={Strikethrough} label="Strikethrough" size="sm" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()} />
          <IconButton icon={Code} label="Inline code" size="sm" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()} />
          <IconButton icon={Link2} label="Link" size="sm" active={editor.isActive("link")} onClick={() => void setLink(editor)} />
          <IconButton icon={Heading2} label="Heading" size="sm" active={editor.isActive("heading")} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
          <IconButton icon={ListChecks} label="Checklist" size="sm" active={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()} />
        </div>
      </BubbleMenu>
      <EditorContent editor={editor} />
      {slash && <SlashMenu editor={editor} state={slash} onPick={(i) => pick(editor, i)} onHover={(i) => setSlash({ ...slash, index: i })} />}
      {linkPick && <LinkPicker state={linkPick} hits={hits} onPick={(h) => pickLink(editor, h)} onHover={(i) => setLinkPick({ ...linkPick, index: i })} />}
      {spell && <SpellMenu editor={editor} state={spell} onClose={() => setSpell(null)} />}
    </>
  );
}

export function InsertMenu({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  return (
    <Dropdown items={insertItems(editor)} align="end">
      <IconButton icon={Plus} label="Insert block" noTooltip />
    </Dropdown>
  );
}
