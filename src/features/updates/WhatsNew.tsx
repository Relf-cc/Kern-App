/**
 * @Author Christian Relf
 * @Date 2026-10-14
 */

// "What's new" after an update: the release's notes, read from its GitHub
// page (or, offline, from the update's own manifest), shown once on the
// first start of a new version. It can also be opened from Settings → About.

import { useEffect, useMemo, type MouseEvent } from "react";
import { create } from "zustand";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ShieldCheck, Sparkles, Wrench, type LucideIcon } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Controls";
import { api } from "@/lib/ipc";
import { renderMarkdown, renderMarkdownInline, safeHref } from "@/lib/markdown";
import { useSettings } from "@/stores/settings";
import { APP_NAME } from "@/app/brand";
import { compareVersions, inAppNotes, isSecurityRelease } from "./notes";
import { parseNotes, type ParsedNotes, type SectionKind } from "./sections";
import { PENDING_KEY, type PendingUpdate } from "./store";
import { RELEASES_PAGE } from "./constants";
import "./updates.css";

/** Settings key: the version that ran last on this device. */
const LAST_KEY = "internal.lastVersion";

const useWhatsNew = create<{ version: string | null; fallback: string | null }>(() => ({ version: null, fallback: null }));

export function openWhatsNew(version: string, fallback: string | null = null) {
  useWhatsNew.setState({ version, fallback });
}

let noted = false;

/**
 * Once per start: notes that this version has run, and opens What's new when
 * it was just updated to (by the updater, or from an older version).
 */
async function noteVersionRun() {
  // The host remounts after an update screen gives way; the settings read
  // here are from startup, so only the first run may act on them.
  if (noted) return;
  noted = true;
  const [{ version }, raw] = [await api.system.info(), useSettings.getState().raw];
  const pending = raw[PENDING_KEY] as PendingUpdate | null | undefined;
  const last = typeof raw[LAST_KEY] === "string" ? (raw[LAST_KEY] as string) : null;
  const viaUpdater = !!pending && pending.to === version;
  // Versions before this one didn't record themselves: someone who has used
  // Kern before (a saved last page) has updated; a fresh install hasn't.
  const newer = last ? compareVersions(last, version) < 0 : raw["internal.lastRoute"] !== undefined;
  if (last !== version || pending) await api.settings.set({ [LAST_KEY]: version, ...(pending ? { [PENDING_KEY]: null } : {}) });
  if (viaUpdater || newer) openWhatsNew(version, viaUpdater ? (pending?.notes ?? null) : null);
}

const SECTION_ICON: Record<SectionKind, LucideIcon> = { feature: Sparkles, fix: Wrench, security: ShieldCheck };

/**
 * Notes written in Kern's own shape, laid out rather than poured through the
 * Markdown renderer: a titled group per theme, and each bullet as a lead line
 * with its detail underneath. Every run of text is sanitised inline Markdown.
 */
function Notes({ notes }: { notes: ParsedNotes }) {
  const inline = (source: string) => ({ __html: renderMarkdownInline(source) });
  return (
    <div className="whats-new__groups">
      {notes.intro && <p className="whats-new__intro" dangerouslySetInnerHTML={inline(notes.intro)} />}
      {notes.sections.map((section, i) => {
        const Icon = SECTION_ICON[section.kind];
        return (
          <section className="wn-group" key={i} data-kind={section.kind}>
            {section.title && (
              <h3 className="wn-group__title">
                <Icon size={13} className="wn-group__icon" aria-hidden />
                {section.title}
              </h3>
            )}
            <ul className="wn-group__items">
              {section.items.map((item, j) => (
                <li className="wn-item" key={j}>
                  {item.lead ? (
                    <>
                      <span className="wn-item__lead" dangerouslySetInnerHTML={inline(item.lead)} />
                      {item.rest && <span className="wn-item__detail" dangerouslySetInnerHTML={inline(item.rest)} />}
                    </>
                  ) : (
                    <span dangerouslySetInnerHTML={inline(item.rest)} />
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Links in the notes belong in the browser, not in the webview. */
function openLinks(e: MouseEvent<HTMLElement>) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const href = safeHref(a.getAttribute("href"));
  if (href) void api.system.open(href).catch(() => undefined);
}

export function WhatsNewHost() {
  const { version, fallback } = useWhatsNew();
  useEffect(() => {
    void noteVersionRun().catch(() => undefined);
  }, []);
  const notes = useQuery({
    queryKey: ["releaseNotes", version],
    queryFn: () => api.system.releaseNotes(version!),
    enabled: !!version,
    staleTime: Infinity,
    retry: 1,
  });
  const body = notes.data?.body || fallback || "";
  const text = useMemo(() => (body ? inAppNotes(body) : ""), [body]);
  // The house shape is laid out below; anything else falls back to Markdown.
  const parsed = useMemo(() => (text ? parseNotes(text) : null), [text]);
  const html = useMemo(() => (text && !parsed ? renderMarkdown(text) : ""), [text, parsed]);
  const url = notes.data?.url ?? (version ? `${RELEASES_PAGE}/tag/v${version}` : RELEASES_PAGE);
  const published = notes.data?.publishedAt ? new Date(notes.data.publishedAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : null;
  const close = () => useWhatsNew.setState({ version: null, fallback: null });

  return (
    <Dialog
      open={!!version}
      onOpenChange={(o) => !o && close()}
      wide
      title={`What's new in ${APP_NAME} ${version ?? ""}`}
      footer={
        <>
          <Button icon={ArrowUpRight} onClick={() => void api.system.open(url).catch(() => undefined)}>
            Release page
          </Button>
          <span className="grow" />
          <Button variant="primary" onClick={close} autoFocus>
            Got it
          </Button>
        </>
      }
    >
      {(published || isSecurityRelease(body)) && (
        <div className="whats-new__meta">
          {isSecurityRelease(body) && <span className="security-badge">Security update</span>}
          {published && `Released ${published}`}
        </div>
      )}
      {text ? (
        <div className="whats-new__notes selectable" onClick={openLinks}>
          {parsed ? <Notes notes={parsed} /> : <div className="prose prose--compact" dangerouslySetInnerHTML={{ __html: html }} />}
        </div>
      ) : notes.isLoading ? (
        <div className="col" style={{ gap: 8 }}>
          <Skeleton width="40%" height={14} />
          <Skeleton width="90%" />
          <Skeleton width="75%" />
          <Skeleton width="82%" />
        </div>
      ) : (
        <p className="faint" style={{ margin: 0 }}>
          The notes for this version couldn't be loaded. They're on the release page.
        </p>
      )}
    </Dialog>
  );
}
