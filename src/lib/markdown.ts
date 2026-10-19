/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Markdown → safe HTML for read-only views (repository READMEs). Raw HTML
// in the source is allowed, as GitHub allows it, then cleaned against an
// allow-list: no scripts, styles, frames, forms or event handlers, and links
// only to web and mail addresses. Images are replaced by their alt text,
// since the app doesn't load remote images.

import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: true, linkify: true, typographer: false });

const ALLOWED = new Set([
  "a", "abbr", "b", "blockquote", "br", "code", "dd", "del", "details", "div", "dl", "dt", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "kbd", "li", "mark", "ol", "p", "pre", "s", "samp", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "u", "ul", "input",
]);
/** Dropped together with everything inside them. */
const DROP = new Set(["script", "style", "iframe", "object", "embed", "form", "textarea", "select", "button", "noscript", "template", "link", "meta", "base", "svg", "math", "video", "audio", "source", "picture"]);
const ATTRS: Record<string, string[]> = {
  a: ["href", "title"],
  td: ["align", "colspan", "rowspan"],
  th: ["align", "colspan", "rowspan"],
  ol: ["start"],
  input: ["type", "checked", "disabled"],
  details: ["open"],
  "*": ["title"],
};

export function safeHref(href: string | null): string | null {
  if (!href) return null;
  const h = href.trim();
  return /^(https?:|mailto:)/i.test(h) ? h : null;
}

/** GitHub task lists: "- [x] done" becomes a ticked, read-only checkbox. */
function taskItem(li: Element, doc: Document) {
  const first = li.firstChild?.nodeName === "P" ? li.firstChild.firstChild : li.firstChild;
  const m = first?.nodeType === Node.TEXT_NODE ? /^\[( |x|X)\]\s+/.exec(first.textContent ?? "") : null;
  if (!first || !m) return;
  first.textContent = (first.textContent ?? "").slice(m[0].length);
  const box = doc.createElement("input");
  box.setAttribute("type", "checkbox");
  box.setAttribute("disabled", "");
  if (m[1] !== " ") box.setAttribute("checked", "");
  first.parentNode!.insertBefore(box, first);
  li.setAttribute("data-task", "");
}

function clean(node: Node, doc: Document): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (DROP.has(tag)) return null;
  if (tag === "img") {
    const alt = el.getAttribute("alt")?.trim();
    if (!alt) return null;
    const s = doc.createElement("span");
    s.className = "md-img";
    s.textContent = alt;
    return s;
  }
  const kids = [...el.childNodes].map((c) => clean(c, doc)).filter((c): c is Node => !!c);
  if (!ALLOWED.has(tag)) {
    // Unknown wrapper (center, font, …): keep its contents.
    const frag = doc.createDocumentFragment();
    kids.forEach((k) => frag.appendChild(k));
    return frag;
  }
  if (tag === "input" && el.getAttribute("type") !== "checkbox") return null;
  const out = doc.createElement(tag);
  for (const name of [...(ATTRS[tag] ?? []), ...ATTRS["*"]]) {
    const v = el.getAttribute(name);
    if (v === null) continue;
    if (name === "href") {
      const safe = safeHref(v);
      if (safe) out.setAttribute("href", safe);
    } else out.setAttribute(name, v);
  }
  if (tag === "input") out.setAttribute("disabled", "");
  if (tag === "p" || tag === "div") {
    const align = el.getAttribute("align");
    if (align === "center" || align === "right") out.setAttribute("data-align", align);
  }
  kids.forEach((k) => out.appendChild(k));
  if (tag === "li") taskItem(out, doc);
  // Links and paragraphs left empty by removed images (badge rows) go too.
  if ((tag === "a" || tag === "p") && !out.textContent?.trim() && !out.querySelector("input")) return null;
  return out;
}

function sanitise(raw: string): string {
  // DOMParser documents are inert: nothing loads or runs while parsing.
  const parsed = new DOMParser().parseFromString(`<body>${raw}</body>`, "text/html");
  const doc = document.implementation.createHTMLDocument("");
  const root = doc.createElement("div");
  [...parsed.body.childNodes].forEach((n) => {
    const c = clean(n, doc);
    if (c) root.appendChild(c);
  });
  return root.innerHTML;
}

/** Renders Markdown to sanitised HTML. */
export function renderMarkdown(source: string): string {
  return sanitise(md.render(source));
}

/** The same, for a run of text that belongs inside a line: no paragraph wrapper. */
export function renderMarkdownInline(source: string): string {
  return sanitise(md.renderInline(source));
}
