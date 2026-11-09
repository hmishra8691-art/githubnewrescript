import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RULES, CATEGORY_LABELS } from "@rescript/quality";
import { STUDY_METHODOLOGIES, CATEGORY_NAMES } from "@rescript/engine";
import { buildMenuGroups } from "../menubar.ts";
import { STUDIO_NAV } from "../studioNav.ts";
import { MODES } from "../programmingMode.ts";
import { DOC_ORDER, docsDir, readDoc } from "../docs/pages.ts";
import { chunksOf, parseArticle, type HelpArticle } from "./articles.ts";
import { buildIndex, type HelpIndex } from "./search.ts";

/**
 * THE HELP KNOWLEDGE BASE (server side, 2026-11-09). Three sources, one index:
 *   guides     content/help/*.md — task guides written against the interface (articles.test.ts checks their labels)
 *   docs       content/docs/*.md — the platform documentation; three pages are generated from the code
 *   generated  built here, at start-up, from the code itself: where everything is in the Studio (its own menu), the
 *              five programming modes, every quality rule, every research methodology — so a renamed tab or a new rule
 *              is in Help's answers without anyone editing a guide
 * Rebuilt when the files change (mtime), so a deploy that adds a guide needs no code change.
 */
export function helpDir(): string {
  const c = [join(process.cwd(), "content", "help"), join(process.cwd(), "apps", "studio", "content", "help")];
  return c.find((d) => existsSync(d)) ?? c[0];
}

export function loadGuides(): HelpArticle[] {
  const dir = helpDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => parseArticle(readFileSync(join(dir, f), "utf8"), "guide", f.slice(0, -3)));
}

export function loadDocs(): HelpArticle[] {
  return DOC_ORDER.map((d) => { const md = readDoc(d.slug); return md ? parseArticle(md, "doc", d.slug) : null; }).filter((x): x is HelpArticle => !!x).map((a) => ({ ...a, keywords: [...a.keywords, ...(DOC_ORDER.find((d) => d.slug === a.id)?.description.split(/[,:;]/).map((s) => s.trim()).filter(Boolean) ?? [])] }));
}

/** articles generated from the code — always in step with the build */
export function generatedArticles(): HelpArticle[] {
  const groups = buildMenuGroups(STUDIO_NAV, { analyticsHref: "/analytics" });
  const studioMap: HelpArticle = {
    id: "studio-map", title: "Where everything is in ResLens.ai", category: "start", kind: "generated", href: "/help?article=studio-map",
    keywords: ["navigation", "menu", "where is", "find", "tab", "module", "location", "studio menu"],
    related: ["create-survey", "intelligent-mode"],
    sections: [
      { heading: "Overview", body: "Across the top of the platform: **Projects** (every survey project), **Data Analytics** (charts, crosstabs, reports across your data), and your account menu with **My usage** (your wallet and spending). Help is in the main navigation and inside every project.\n\nInside a project (the Studio) the menu bar has four groups — " + groups.map((g) => `**${g.label}**`).join(", ") + " — and a **Mode** menu to switch how you program." },
      ...groups.map((g) => ({ heading: `${g.label} menu`, body: g.items.map((i) => `- **${g.label}** → **${i.label}** — ${i.description || "—"}`).join("\n") })),
      { heading: "Programming modes", body: "The **Mode** menu switches how you program the same survey (nothing is lost when you switch):\n\n" + MODES.map((m) => `- **${m.label}** — ${m.tagline}. ${m.audience}`).join("\n") },
    ],
  };
  const byCat = new Map<string, typeof RULES>();
  for (const r of RULES) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  const quality: HelpArticle = {
    id: "quality-rules", title: "Every data-quality check", category: "results", kind: "generated", href: "/help?article=quality-rules",
    keywords: ["quality rules", "data cleaning", "speeders", "straightliners", "fraud", "bots", "duplicates", "contradictions", "attention check", "flags"],
    related: ["data-quality"],
    sections: [...byCat.entries()].map(([cat, rules]) => ({ heading: CATEGORY_LABELS[cat] ?? cat, body: rules.map((r) => `- **${r.title}** — ${r.description}`).join("\n") })),
  };
  const mByCat = new Map<string, typeof STUDY_METHODOLOGIES>();
  for (const m of STUDY_METHODOLOGIES) mByCat.set(m.category, [...(mByCat.get(m.category) ?? []), m]);
  const methods: HelpArticle = {
    id: "methodologies", title: "Research methodologies ResLens.ai can build", category: "designs", kind: "generated", href: "/help?article=methodologies",
    keywords: ["methodology", "method", "research design", "which method", "pricing research", "conjoint", "maxdiff", "segmentation", "brand tracking", "concept test"],
    related: ["choose-a-method", "conjoint", "maxdiff"],
    sections: [...mByCat.entries()].map(([cat, ms]) => ({ heading: (CATEGORY_NAMES as Record<string, string>)[cat] ?? cat, body: ms.map((m) => `- **${m.name}** — best for ${m.fit}. Strengths: ${m.strengths.join("; ")}. Trade-offs: ${m.tradeoffs.join("; ")}. Sample: ${m.sample.note}.`).join("\n") })),
  };
  return [studioMap, quality, methods];
}

let cache: { key: string; index: HelpIndex; articles: Map<string, HelpArticle> } | null = null;

function stamp(): string {
  const parts: string[] = [];
  for (const d of [helpDir(), docsDir()]) if (existsSync(d)) for (const f of readdirSync(d)) parts.push(f);
  return parts.sort().join("|") + `|${parts.length}`;
}

export function helpKnowledge(): { index: HelpIndex; articles: Map<string, HelpArticle> } {
  const key = stamp();
  if (cache && cache.key === key) return cache;
  const all = [...loadGuides(), ...generatedArticles(), ...loadDocs()];
  const articles = new Map(all.map((a) => [a.id, a]));
  cache = { key, index: buildIndex(all.flatMap(chunksOf)), articles };
  return cache;
}
