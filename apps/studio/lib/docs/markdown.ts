/**
 * A SMALL MARKDOWN RENDERER for the public documentation (Phase 7).
 *
 * The docs are written by us, so the renderer needs no plugin system and no
 * HTML pass-through: every character of the source is escaped and only the
 * constructs the pages use are drawn — headings, paragraphs, fenced code,
 * inline code, bold, italic, links, lists, tables, block quotes, rules and
 * HTML comments (dropped). Developer Docs (2026-11-09) adds front matter, `::: example <id>` (a live example the
 * page route mounts), `::: steps` (expandable step-by-step), `::: note | tip | warning | unsupported` callouts and
 * syntax highlighting for json, js, css, html and the logic language — still escaping every character of the
 * source. A link to another page is relative (`logic`,
 * `question-types`) and is left for the page route to resolve; an absolute
 * link opens as written. Dependency-free on purpose.
 */
export interface RenderedDoc {
  html: string;
  /** the front matter (`---` key: value lines `---` at the top): summary, related, status … */
  meta: Record<string, string>;
  /** the live examples the page places, in order (`::: example <id>`) */
  examples: string[];
  /** the page title: the first H1 */
  title: string;
  /** every heading, for the page's table of contents */
  headings: { level: number; text: string; id: string }[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const slug = (s: string) => s.toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "section";

/** inline: code, bold, italic, links — code first so nothing inside a code span is read as markup */
export function inline(text: string): string {
  const parts = text.split(/(`[^`]*`)/);
  return parts.map((p) => {
    if (p.startsWith("`") && p.endsWith("`") && p.length >= 2) return `<code>${esc(p.slice(1, -1))}</code>`;
    let s = esc(p);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => `<a href="${esc(href)}"${/^https?:\/\//.test(href) ? ' rel="noopener"' : ""}>${label}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    return s;
  }).join("");
}

/** the marker a live example leaves in the html; the page route splits on it */
export const EXAMPLE_MARK = (id: string) => `<!--rs-example:${id}-->`;
export const EXAMPLE_SPLIT = /<!--rs-example:([a-z0-9-]+)-->/;
/** a live catalog generated from the platform's own registry at render time (`::: catalog methodologies`) */
export const CATALOG_MARK = (id: string) => `<!--rs-example:catalog-${id}-->`;
/** a captured screenshot of a Studio tool, from lib/docs/screens.ts (`::: screen <id>`) — for tools a live survey cannot show */
export const SCREEN_MARK = (id: string) => `<!--rs-example:screen-${id}-->`;

const KEYWORDS: Record<string, RegExp> = {
  js: /\b(?:const|let|var|function|return|if|else|for|of|in|while|new|true|false|null|undefined|this|typeof|async|await|=>)\b/,
  logic: /\b(?:AND|OR|NOT|NOR|BUT NOT|IS|SELECTED|between|and|contains|any|all|answered|empty|starts with|ranked|first|last|before|after|IF|THEN|ELSE|SELECT|DESELECT|CLEAR|SET|SHOW|HIDE|COUNT|UNION|MINUS|INTERSECTION|DIFFERENCE)\b/,
};
/** a small, safe highlighter: the text is escaped first, then wrapped token by token */
export function highlight(lang: string, code: string): string {
  const l = lang === "javascript" ? "js" : lang;
  if (!["json", "js", "css", "html", "logic"].includes(l)) return esc(code);
  const rules: [string, RegExp][] = l === "json"
    ? [["k", /"(?:[^"\\]|\\.)*"(?=\s*:)/], ["s", /"(?:[^"\\]|\\.)*"/], ["n", /-?\b\d+(?:\.\d+)?\b/], ["b", /\b(?:true|false|null)\b/]]
    : l === "css"
      ? [["c", /\/\*[\s\S]*?\*\//], ["k", /[a-z-]+(?=\s*:)/], ["s", /"[^"]*"|'[^']*'/], ["n", /#[0-9a-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|s|ms)?\b/], ["b", /[.#\[][\w-]+(?:="[^"]*")?\]?(?=[^{}]*\{)/]]
      : l === "html"
        ? [["c", /<!--[\s\S]*?-->/], ["k", /<\/?[a-zA-Z][\w-]*|\/?>/], ["s", /"[^"]*"/], ["b", /\{\{[^}]*\}\}/]]
        : l === "logic"
          ? [["c", /--[^\n]*/], ["s", /"[^"]*"/], ["b", /\{\{[^}]*\}\}/], ["k", KEYWORDS.logic], ["n", /\b\d+(?:\.\d+)?\b/]]
          : [["c", /\/\/[^\n]*|\/\*[\s\S]*?\*\//], ["s", /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/], ["k", KEYWORDS.js], ["n", /\b\d+(?:\.\d+)?\b/]];
  let out = "", rest = code;
  while (rest) {
    let best: { cls: string; i: number; t: string } | null = null;
    for (const [cls, re] of rules) { const m = re.exec(rest); if (m && m[0] && (!best || m.index < best.i)) best = { cls, i: m.index, t: m[0] }; }
    if (!best) { out += esc(rest); break; }
    out += esc(rest.slice(0, best.i)) + `<span class="tk-${best.cls}">${esc(best.t)}</span>`;
    rest = rest.slice(best.i + best.t.length);
  }
  return out;
}

function frontMatter(md: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) { const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim()); if (kv) meta[kv[1]] = kv[2].trim(); }
  return { meta, body: md.slice(m[0].length) };
}

const CALLOUT: Record<string, string> = { note: "Note", tip: "Tip", warning: "Watch out", unsupported: "Not supported" };

export function renderMarkdown(md: string): RenderedDoc {
  const fm = frontMatter(md);
  const src = fm.body.replace(/<!--[\s\S]*?-->/g, "");
  const lines = src.split("\n");
  const examples: string[] = [];
  const out: string[] = [];
  const headings: RenderedDoc["headings"] = [];
  let title = "";
  let i = 0;
  const flushPara = (buf: string[]) => { if (buf.length) { out.push(`<p>${inline(buf.join(" ").trim())}</p>`); buf.length = 0; } };
  const para: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    // directives (Developer Docs)
    const dir = /^:::\s*([a-z]+)\s*(.*?)\s*$/.exec(line);
    if (dir && dir[1] !== "") {
      flushPara(para);
      const [, kind, arg] = dir;
      if (kind === "example") { const id = slug(arg); examples.push(id); out.push(EXAMPLE_MARK(id)); i++; continue; }
      if (kind === "catalog") { out.push(CATALOG_MARK(slug(arg))); i++; continue; }
      if (kind === "screen") { out.push(SCREEN_MARK(slug(arg))); i++; continue; }
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^:::\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      if (kind === "steps") {
        const items = body.filter((l) => /^\s*\d+\.\s+/.test(l)).map((l) => l.replace(/^\s*\d+\.\s+/, ""));
        out.push(`${arg ? `<p class="docs-steps-title">${inline(arg)}</p>` : ""}<ol class="docs-steps" data-testid="docs-steps">${items.map((it, n) => {
          const [head, ...more] = it.split(" — ");
          return `<li><details${n === 0 ? " open" : ""}><summary><span class="docs-step-n">${n + 1}</span>${inline(head)}</summary>${more.length ? `<div class="docs-step-body">${inline(more.join(" — "))}</div>` : ""}</details></li>`;
        }).join("")}</ol>`);
        continue;
      }
      if (kind === "flow") {
        const steps = body.map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim()).filter(Boolean);
        out.push(`<div class="docs-flow" role="list" aria-label="${esc(arg || "Workflow")}" data-testid="docs-flow">${steps.map((st, n) => {
          const [head, ...more] = st.split(" — ");
          return `${n ? '<span class="docs-flow-arrow" aria-hidden="true">→</span>' : ""}<div class="docs-flow-step" role="listitem"><b>${inline(head)}</b>${more.length ? inline(more.join(" — ")) : ""}</div>`;
        }).join("")}</div>`);
        continue;
      }
      const inner = renderMarkdown(body.join("\n"));
      examples.push(...inner.examples);
      out.push(`<div class="docs-callout docs-callout-${esc(kind)}" data-testid="docs-callout-${esc(kind)}"><div class="docs-callout-title">${inline(arg || CALLOUT[kind] || kind)}</div>${inner.html}</div>`);
      continue;
    }
    // fenced code
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flushPara(para);
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      out.push(`<pre${fence[1] ? ` data-lang="${esc(fence[1])}"` : ""}><code${fence[1] ? ` class="language-${esc(fence[1])}"` : ""}>${highlight(fence[1], body.join("\n"))}</code></pre>`);
      continue;
    }
    // heading
    const h = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (h) {
      flushPara(para);
      const level = h[1].length;
      const text = h[2];
      const id = slug(text);
      if (level === 1 && !title) title = text.replace(/`/g, "");
      headings.push({ level, text: text.replace(/`/g, ""), id });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }
    // table
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1])) {
      flushPara(para);
      const cells = (l: string) => l.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    // list
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      flushPara(para);
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        let item = lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])) { item += ` ${lines[i].trim()}`; i++; }
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    // block quote
    if (/^>\s?/.test(line)) {
      flushPara(para);
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push(`<blockquote><p>${inline(q.join(" "))}</p></blockquote>`);
      continue;
    }
    // rule
    if (/^(?:---|\*\*\*)\s*$/.test(line)) { flushPara(para); out.push("<hr>"); i++; continue; }
    // blank
    if (!line.trim()) { flushPara(para); i++; continue; }
    para.push(line);
    i++;
  }
  flushPara(para);
  return { html: out.join("\n"), title, headings, meta: fm.meta, examples };
}
