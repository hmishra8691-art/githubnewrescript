/**
 * A SMALL MARKDOWN RENDERER for the public documentation (Phase 7).
 *
 * The docs are written by us, so the renderer needs no plugin system and no
 * HTML pass-through: every character of the source is escaped and only the
 * constructs the pages use are drawn — headings, paragraphs, fenced code,
 * inline code, bold, italic, links, lists, tables, block quotes, rules and
 * HTML comments (dropped). A link to another page is relative (`logic`,
 * `question-types`) and is left for the page route to resolve; an absolute
 * link opens as written. Dependency-free on purpose.
 */
export interface RenderedDoc {
  html: string;
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

export function renderMarkdown(md: string): RenderedDoc {
  const src = md.replace(/<!--[\s\S]*?-->/g, "");
  const lines = src.split("\n");
  const out: string[] = [];
  const headings: RenderedDoc["headings"] = [];
  let title = "";
  let i = 0;
  const flushPara = (buf: string[]) => { if (buf.length) { out.push(`<p>${inline(buf.join(" ").trim())}</p>`); buf.length = 0; } };
  const para: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flushPara(para);
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code${fence[1] ? ` class="language-${esc(fence[1])}"` : ""}>${esc(body.join("\n"))}</code></pre>`);
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
  return { html: out.join("\n"), title, headings };
}
