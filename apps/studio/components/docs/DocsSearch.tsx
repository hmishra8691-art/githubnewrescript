"use client";
import * as React from "react";

/**
 * SEARCH THE DEVELOPER DOCS (2026-11-09): every page's title, summary, headings and text, fetched once from
 * /docs/search-index.json when the box is first used. Ranked by where the words appear (title, then headings, then
 * summary, then text), every word required. "/" or Ctrl/⌘+K focuses the box; arrows and Enter pick a result.
 */
type Entry = { slug: string; title: string; description: string; category: string; headings: string[]; text: string };

export function rankDocs(index: Entry[], query: string): { e: Entry; score: number; heading?: string; snippet?: string }[] {
  const words = query.toLowerCase().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}+#.-]/gu, "")).filter((w) => w.length > 1);
  if (!words.length) return [];
  const out: { e: Entry; score: number; heading?: string; snippet?: string }[] = [];
  for (const e of index) {
    const title = e.title.toLowerCase(), desc = e.description.toLowerCase(), text = e.text.toLowerCase();
    let score = 0, ok = true, heading: string | undefined;
    for (const w of words) {
      const h = e.headings.find((x) => x.toLowerCase().includes(w));
      const s = (title.includes(w) ? 10 : 0) + (h ? 5 : 0) + (desc.includes(w) ? 3 : 0) + (text.includes(w) ? 1 + Math.min(3, text.split(w).length - 2) * 0.3 : 0);
      if (!s) { ok = false; break; }
      if (h && !heading) heading = h;
      score += s;
    }
    if (!ok) continue;
    if (title === query.toLowerCase().trim()) score += 20;
    const at = text.indexOf(words[0]);
    const snippet = at >= 0 ? `${at > 40 ? "…" : ""}${e.text.slice(Math.max(0, at - 40), at + 110)}…` : undefined;
    out.push({ e, score, heading, snippet });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 10);
}

export function DocsSearch() {
  const [q, setQ] = React.useState("");
  const [index, setIndex] = React.useState<Entry[] | null>(null);
  const [open, setOpen] = React.useState(false);
  const [sel, setSel] = React.useState(0);
  const ref = React.useRef<HTMLInputElement>(null);
  const load = React.useCallback(() => {
    if (index) return;
    void fetch("/docs/search-index.json").then((r) => r.json()).then((j) => setIndex(j.pages ?? [])).catch(() => setIndex([]));
  }, [index]);
  React.useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? "");
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) { e.preventDefault(); ref.current?.focus(); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  const results = index ? rankDocs(index, q) : [];
  const go = (slug: string) => { window.location.href = `/docs/${slug}`; };
  return (
    <div className="docs-search" data-testid="docs-search">
      <input ref={ref} className="docs-search-input" type="search" value={q} placeholder="Search the docs   ( / )" aria-label="Search the documentation"
        data-testid="docs-search-input"
        onFocus={() => { load(); setOpen(true); }} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setQ(e.target.value); setSel(0); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
          if (e.key === "Enter" && results[sel]) go(results[sel].e.slug);
          if (e.key === "Escape") { setQ(""); ref.current?.blur(); }
        }} />
      {open && q.trim().length > 1 && (
        <div className="docs-search-results" role="listbox" data-testid="docs-search-results">
          {!index && <div className="docs-search-empty">Loading…</div>}
          {index && !results.length && <div className="docs-search-empty">Nothing matches “{q}”.</div>}
          {results.map((r, i) => (
            <a key={r.e.slug} href={`/docs/${r.e.slug}`} role="option" aria-selected={i === sel} className={`docs-search-hit${i === sel ? " on" : ""}`} data-testid="docs-search-hit"
              onMouseDown={(e) => { e.preventDefault(); go(r.e.slug); }}>
              <span className="docs-search-cat">{r.e.category}</span>
              <span className="docs-search-title">{r.e.title}{r.heading && r.heading !== r.e.title ? <span className="docs-search-h"> › {r.heading}</span> : null}</span>
              <span className="docs-search-snip">{r.e.description || r.snippet}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
