/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

// Comments on a task. In a Kern Cloud workspace they're shared with members
// and "@" mentions a member (who's notified); offline they're notes to
// yourself. Mentions are stored as @[Name](user-id) and shown as chips.

import { MessageSquare, Pencil, Trash } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Member, Task, TaskComment } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import { relativeTime } from "@/lib/dates";
import { toastError } from "@/stores/toast";
import { IconButton, Button } from "@/components/ui/Button";
import { confirmDelete } from "@/components/ui/Dialog";
import { Avatar } from "@/features/cloud/ui";
import { useActiveSpace, useCloud, useReadOnly } from "@/features/cloud/store";
import { useMembers } from "@/features/cloud/members";
import { extractUrls } from "@/features/links/links";
import "./comments.css";

const MENTION = /@\[([^\]]{1,80})\]\(([A-Za-z0-9_-]{1,64})\)/g;

/** Text with mention chips and clickable links. */
function Body({ text }: { text: string }) {
  const meId = useCloud((s) => s.info?.account?.id);
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    if (m.index! > last) parts.push(<Linked key={last} text={text.slice(last, m.index)} />);
    parts.push(
      <span key={m.index} className="mention" data-me={m[2] === meId || undefined}>
        @{m[1]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(<Linked key={last} text={text.slice(last)} />);
  return <div className="comment__body selectable">{parts}</div>;
}

function Linked({ text }: { text: string }) {
  const urls = extractUrls(text);
  if (!urls.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let rest = text;
  let i = 0;
  for (const u of urls) {
    const at = rest.indexOf(u);
    if (at < 0) continue;
    out.push(rest.slice(0, at));
    out.push(
      <a key={i++} href={u} onClick={(e) => (e.preventDefault(), void api.system.open(u))}>
        {u}
      </a>,
    );
    rest = rest.slice(at + u.length);
  }
  out.push(rest);
  return <>{out}</>;
}

interface MentionState {
  /** Index of the "@" in the text. */
  at: number;
  query: string;
  index: number;
}

/** A textarea that completes "@name" to a member mention. */
function Composer({ initial = "", placeholder, members, onSubmit, onCancel, submitLabel }: { initial?: string; placeholder: string; members: Member[]; onSubmit: (body: string) => Promise<boolean>; onCancel?: () => void; submitLabel: string }) {
  const [text, setText] = useState(initial);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const matches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return members.filter((m) => !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().startsWith(q)).slice(0, 6);
  }, [mention, members]);

  const detect = (value: string, caret: number) => {
    if (!members.length) return setMention(null);
    const before = value.slice(0, caret);
    const m = /(^|\s)@([\p{L}\p{N}._-]{0,30})$/u.exec(before);
    setMention(m ? { at: caret - m[2].length - 1, query: m[2], index: 0 } : null);
  };

  const pick = (m: Member) => {
    if (!mention) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    const token = `@[${(m.name || m.email).replace(/[[\]()]/g, "")}](${m.userId}) `;
    const next = text.slice(0, mention.at) + token + text.slice(caret);
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = mention.at + token.length;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const submit = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    const ok = await onSubmit(v);
    setBusy(false);
    if (ok) setText("");
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && matches.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setMention({ ...mention, index: (mention.index + d + matches.length) % matches.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(matches[mention.index]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
    if (e.key === "Escape" && onCancel) onCancel();
  };

  return (
    <div className="comment-composer">
      <textarea
        ref={ref}
        className="textarea"
        rows={text.includes("\n") || text.length > 60 ? 3 : 1}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          detect(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKey}
        onBlur={() => window.setTimeout(() => setMention(null), 150)}
        aria-label={placeholder}
      />
      {mention && matches.length > 0 && (
        <div className="menu comment-mentions" role="listbox" aria-label="Mention someone">
          {matches.map((m, i) => (
            <div key={m.userId} role="option" aria-selected={i === mention.index} className="menu__item" data-highlighted={i === mention.index ? "" : undefined} onMouseDown={(e) => (e.preventDefault(), pick(m))}>
              <Avatar name={m.name || m.email} image={m.image} size={18} />
              <span className="truncate grow">{m.name || m.email}</span>
              <span className="menu__hint">{m.email}</span>
            </div>
          ))}
        </div>
      )}
      {(text.trim() || onCancel) && (
        <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
          <span className="faint grow" style={{ fontSize: "var(--fs-2xs)" }}>
            {members.length ? "@ to mention · " : ""}Ctrl+Enter to send
          </span>
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!text.trim() || busy} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

function CommentRow({ c, members, shared }: { c: TaskComment; members: Member[]; shared: boolean }) {
  const [editing, setEditing] = useState(false);
  const readOnly = useReadOnly();
  const name = c.authorName || (c.mine ? "You" : "Someone");
  const refresh = () => invalidate("comments", "tasks", "task");
  return (
    <div className="comment">
      {shared && <Avatar name={name} size={22} />}
      <div className="comment__main">
        <div className="comment__head">
          {shared && <span className="comment__author">{c.mine ? `${name} (you)` : name}</span>}
          <span className="faint" title={new Date(c.createdAt).toLocaleString()}>
            {relativeTime(c.createdAt)}
            {c.editedAt ? " · edited" : ""}
          </span>
          {c.mine && !readOnly && !editing && (
            <span className="comment__actions">
              <IconButton icon={Pencil} label="Edit comment" size="sm" onClick={() => setEditing(true)} />
              <IconButton
                icon={Trash}
                label="Delete comment"
                size="sm"
                onClick={async () => {
                  if (!(await confirmDelete("Delete this comment?"))) return;
                  try {
                    await api.comments.delete(c.id);
                    refresh();
                  } catch (e) {
                    toastError(describeError(e));
                  }
                }}
              />
            </span>
          )}
        </div>
        {editing ? (
          <Composer
            initial={c.body}
            placeholder="Edit comment"
            members={members}
            submitLabel="Save"
            onCancel={() => setEditing(false)}
            onSubmit={async (body) => {
              try {
                await api.comments.edit(c.id, body);
                refresh();
                setEditing(false);
                return true;
              } catch (e) {
                toastError(describeError(e, "Couldn't save the comment."));
                return false;
              }
            }}
          />
        ) : (
          <Body text={c.body} />
        )}
      </div>
    </div>
  );
}

export function Comments({ task }: { task: Task }) {
  const space = useActiveSpace();
  const readOnly = useReadOnly();
  const members = useMembers();
  const shared = space?.kind === "workspace";
  const key = ["comments", task.id];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.comments.list(task.id), staleTime: 15_000 });
  const list = data ?? [];
  const add = async (body: string) => {
    try {
      const c = await api.comments.add(task.id, body);
      queryClient.setQueryData<TaskComment[]>(key, (prev) => [...(prev ?? []), c]);
      invalidate("tasks", "task", "activity");
      return true;
    } catch (e) {
      toastError(describeError(e, "Couldn't add the comment."));
      return false;
    }
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="section-title">
        <MessageSquare size={13} /> {shared ? "Comments" : "Comments & notes"}
        {list.length > 0 && <span className="count">{list.length}</span>}
      </div>
      {list.map((c) => (
        <CommentRow key={c.id} c={c} members={members} shared={shared} />
      ))}
      {!readOnly && <Composer placeholder={shared ? "Add a comment… (@ to mention)" : "Add a comment or update…"} members={members} submitLabel="Comment" onSubmit={add} />}
    </div>
  );
}
