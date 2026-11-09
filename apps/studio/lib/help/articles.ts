import type { HelpChunk, SourceKind } from "./search.ts";

/**
 * HELP GUIDES (content/help/*.md). One task per file, written against the interface as it is: every label in bold
 * inside a "How to" section is a real control, checked by lib/help/articles.test.ts against the Studio's source.
 *
 *   ---
 *   id: display-logic
 *   title: Show a question only when a condition is met (display logic)
 *   category: logic
 *   keywords: show only if, conditional question, hide question
 *   related: skip-logic, conditions
 *   ---
 *   ## What it does …  ## Why researchers use it …  ## When to use it …  ## How to set it up …
 *   ## Example …  ## Common mistakes …  ## Alternatives …  ## In Intelligent Mode …
 */
export interface HelpArticle {
  id: string;
  title: string;
  category: string;
  keywords: string[];
  related: string[];
  sections: { heading: string; body: string }[];
  kind: SourceKind;
  href: string;
}

export const CATEGORIES: Record<string, string> = {
  start: "Getting started",
  studio: "Survey creation & programming",
  logic: "Logic & advanced programming",
  intelligent: "Intelligent Mode",
  designs: "Research design generators",
  branding: "Branding & customization",
  project: "Projects & collaboration",
  billing: "Billing, usage & wallet",
  results: "Results, fieldwork & recruitment",
  qualitative: "Qualitative research",
  advanced: "Advanced configuration",
  analytics: "Data & analytics",
  troubleshooting: "Troubleshooting",
  reference: "Reference",
};

export function parseArticle(md: string, kind: SourceKind = "guide", fallbackId = "article"): HelpArticle {
  let body = md.replace(/\r\n/g, "\n");
  const meta: Record<string, string> = {};
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (fm) {
    for (const line of fm[1].split("\n")) { const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim()); if (m) meta[m[1]] = m[2].trim(); }
    body = body.slice(fm[0].length);
  }
  const h1 = /^#\s+(.+)$/m.exec(body);
  const id = meta.id || fallbackId;
  const title = meta.title || h1?.[1]?.replace(/`/g, "").trim() || id;
  if (h1) body = body.replace(h1[0], "");
  const sections: HelpArticle["sections"] = [];
  let cur = { heading: "Overview", body: "" };
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    const h = !fence && /^##\s+(.+)$/.exec(line);
    if (h) { if (cur.body.trim()) sections.push({ ...cur, body: cur.body.trim() }); cur = { heading: h[1].trim(), body: "" }; continue; }
    cur.body += line + "\n";
  }
  if (cur.body.trim()) sections.push({ ...cur, body: cur.body.trim() });
  const list = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return { id, title, category: meta.category || (kind === "doc" ? "reference" : "start"), keywords: list(meta.keywords), related: list(meta.related), sections, kind, href: kind === "doc" ? `/docs/${id}` : `/help?article=${encodeURIComponent(id)}` };
}

const MAX_CHUNK = 2400;
/** an article → section-sized chunks (a long section is split at paragraphs) */
export function chunksOf(a: HelpArticle): HelpChunk[] {
  const out: HelpChunk[] = [];
  for (const s of a.sections) {
    const paras = s.body.split(/\n{2,}/);
    let buf = "", part = 0;
    const flush = () => { if (!buf.trim()) return; out.push({ id: `${a.id}#${slugOf(s.heading)}${part ? `-${part}` : ""}`, article: a.id, title: a.title, heading: s.heading, category: a.category, kind: a.kind, keywords: a.keywords, text: buf.trim(), href: a.href }); part++; buf = ""; };
    for (const p of paras) { if (buf.length + p.length > MAX_CHUNK) flush(); buf += p + "\n\n"; }
    flush();
  }
  return out;
}
export const slugOf = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";

/** the bold labels inside a guide's "How to …" / steps sections — the controls it tells a person to use */
export function uiLabelsIn(a: HelpArticle): string[] {
  const out = new Set<string>();
  for (const s of a.sections) {
    if (!/^(how to|steps|set(?:ting)? it up|where to find|navigate|what to check|how to check)/i.test(s.heading)) continue;
    for (const m of s.body.matchAll(/\*\*([^*]+)\*\*/g)) out.add(m[1].trim());
  }
  return [...out];
}
