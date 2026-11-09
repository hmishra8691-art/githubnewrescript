import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArticle, uiLabelsIn, chunksOf } from "./articles.ts";

/*
 * NO INVENTED BUTTONS. Every control a guide tells a person to use — the bold labels in its "How to" / "What to check"
 * sections — must exist as text in the Studio's source. A renamed button fails this test instead of misleading users.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const GUIDES = join(ROOT, "content", "help");
const norm = (s: string) => s.replace(/&amp;/g, "&").replace(/&apos;|&#39;|[’‘]/g, "'").replace(/&quot;|[“”]/g, '"').replace(/\\u2019/g, "'").replace(/\s+/g, " ").toLowerCase();

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f === ".next" || f.startsWith(".")) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs)$/.test(f) && !/\.test\./.test(f) && !p.includes(join("lib", "help"))) out.push(p);
  }
  return out;
}
const corpus = norm([...walk(join(ROOT, "components")), ...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))].map((f) => readFileSync(f, "utf8")).join("\n"));
/* generic words a guide may bold that are not single controls */
const ALLOW = new Set(["projects"].map(norm));

const guides = readdirSync(GUIDES).filter((f) => f.endsWith(".md")).map((f) => ({ f, a: parseArticle(readFileSync(join(GUIDES, f), "utf8"), "guide", f.slice(0, -3)) }));

test("every guide has an id matching its file, a title, a known category and a how-to", () => {
  assert.ok(guides.length >= 40, `${guides.length} guides`);
  const cats = new Set(["start", "studio", "logic", "intelligent", "designs", "branding", "project", "billing", "results", "qualitative", "advanced", "analytics", "troubleshooting"]);
  for (const { f, a } of guides) {
    assert.equal(a.id, f.slice(0, -3), f);
    assert.ok(a.title.length > 5, f);
    assert.ok(cats.has(a.category), `${f}: category ${a.category}`);
    assert.ok(a.keywords.length >= 3, `${f}: keywords`);
    assert.ok(a.sections.some((s) => /^(how to|what to check|what works)/i.test(s.heading)), `${f}: no How to / What to check section`);
  }
});

test("every control a guide names exists in the interface", () => {
  const missing: string[] = [];
  for (const { f, a } of guides) for (const label of uiLabelsIn(a)) {
    const n = norm(label);
    if (ALLOW.has(n) || corpus.includes(n)) continue;
    missing.push(`${f}: **${label}**`);
  }
  assert.deepEqual(missing, [], `labels not found in the Studio source:\n${missing.join("\n")}`);
  /* and the check can fail: an invented control is not in the source */
  assert.ok(!corpus.includes(norm("Logic Wizard")) && !corpus.includes(norm("Configure Skip Conditions")));
});

test("related guides exist", () => {
  const ids = new Set(guides.map((g) => g.a.id));
  const generated = new Set(["studio-map", "quality-rules", "methodologies"]);
  const broken = guides.flatMap(({ f, a }) => a.related.filter((r) => !ids.has(r) && !generated.has(r)).map((r) => `${f} → ${r}`));
  assert.deepEqual(broken, []);
});

test("parsing: front matter, sections, chunks", () => {
  const a = parseArticle("---\nid: x\ntitle: X thing\ncategory: logic\nkeywords: a, b, c\nrelated: y\n---\n## What it does\nIt does.\n\n## How to set it up\n1. Open **Programming** → **Questions**.\n\n```\n## not a heading\n```\n");
  assert.equal(a.id, "x"); assert.deepEqual(a.keywords, ["a", "b", "c"]);
  assert.deepEqual(a.sections.map((s) => s.heading), ["What it does", "How to set it up"]);
  assert.deepEqual(uiLabelsIn(a), ["Programming", "Questions"]);
  assert.equal(chunksOf(a).length, 2);
  assert.equal(chunksOf(a)[1].id, "x#how-to-set-it-up");
});
