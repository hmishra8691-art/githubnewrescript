/**
 * THE SCRIPT CORPUS (engine weakness #14, 2026-10-22): every behaviour script and legacy Custom Code that exists in
 * this repository's tests, browser suites, guides, fixtures and templates, with the verdict the script checks gave
 * it BEFORE the tokenizer-based checks — so `scriptChecks.test.ts` can prove that what ran keeps running and what
 * was refused stays refused (and lists every intended difference).
 *
 *   node scripts/engine-11-14/make-script-corpus.mjs            # corpus + verdicts with the engine's current dist
 *   node scripts/engine-11-14/make-script-corpus.mjs --corpus   # (re)collect the corpus only, keep the verdicts
 *
 * Writes packages/engine/src/fixtures/script-corpus.json. Run deliberately (the snapshot is the baseline).
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "packages/engine/src/fixtures/script-corpus.json");
const corpusOnly = process.argv.includes("--corpus");
const req = createRequire(join(ROOT, "apps/studio/package.json"));
const E = await import(pathToFileURL(join(ROOT, "packages/engine/dist/index.js")).href);
const { SurveyDefinition } = await import(pathToFileURL(req.resolve("@rescript/schema")).href);
const { SURVEY_TEMPLATES } = await import(pathToFileURL(req.resolve("@rescript/templates")).href);

const walk = (dir, out = []) => {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f === "dist" || f === ".next" || f.startsWith(".")) continue;
    const p = join(dir, f);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out); else if (/\.(ts|tsx|mjs|json)$/.test(f) && !/script-corpus\.json$/.test(f)) out.push(p);
  }
  return out;
};
const files = [...walk(join(ROOT, "packages")), ...walk(join(ROOT, "apps/studio/lib")), ...walk(join(ROOT, "apps/runtime/lib")), ...walk(join(ROOT, "scripts"))];

const found = new Map();
const add = (code, from) => {
  if (typeof code !== "string" || code.trim().length < 8 || code.length > 20000) return;
  const id = createHash("sha256").update(code).digest("hex").slice(0, 12);
  if (!found.has(id)) found.set(id, { id, from: [from], code });
  else if (!found.get(id).from.includes(from) && found.get(id).from.length < 4) found.get(id).from.push(from);
};
/* a string literal after `script:` / `"script":` / `customJs:` in source text */
const KEY = /["']?(?:script|customJs)["']?\s*:\s*/g;
function literalAt(src, i) {
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let j = i + 1;
  while (j < src.length && src[j] !== q) { if (src[j] === "\\") j++; else if (q === "`" && src[j] === "$" && src[j + 1] === "{") return null; j++; }
  const raw = src.slice(i, j + 1);
  try { return Function(`"use strict"; return (${raw});`)(); } catch { return null; }
}
const unescapeOnce = (s) => { try { return JSON.parse(`"${s}"`); } catch { return null; } };
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const rel = relative(ROOT, f);
  if (f.endsWith(".json")) {
    try { const visit = (o) => { if (Array.isArray(o)) o.forEach(visit); else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if ((k === "script" || k === "customJs") && typeof v === "string") add(v, rel); else visit(v); } }; visit(JSON.parse(src)); } catch { /* not JSON we can read */ }
    continue;
  }
  for (const m of src.matchAll(KEY)) {
    const at = m.index + m[0].length;
    const v = literalAt(src, at);
    if (typeof v === "string") add(v, rel);
  }
  /* any other string literal in a test, a suite or a guide that IS a survey script (assigned to a variable, built in a helper) */
  if (/\.test\.ts$|scripts\/[^/]+\.mjs$|Guide\.ts$|prompt\.ts$|uxScriptGuard\.ts$/.test(rel)) {
    for (const m of src.matchAll(/["'`]/g)) {
      const prevCh = src[m.index - 1];
      if (prevCh === "\\") continue;
      const v = literalAt(src, m.index);
      if (typeof v === "string" && v.length >= 24 && /\brs\s*\.\s*(?:listen|popup|closePopup|show|hide|after|animate|setText|text|style|addClass|removeClass|getAnswer|message)\s*\(|\bdocument\s*\.\s*(?:createElement|querySelector|querySelectorAll|body|getElementById)\b/.test(v) && /[;(){}]/.test(v)) add(v, rel);
    }
  }
  /* JSON written inside a template literal (the guides' worked examples): "script":"…\"…" */
  for (const m of src.matchAll(/\\?"script\\?"\s*:\s*\\?"((?:[^"\\]|\\.)*?)\\?"\s*[,}]/g)) {
    const v = unescapeOnce(m[1].replace(/\\\\/g, "\\"));
    if (typeof v === "string" && /rs\.|document|function|=>/.test(v)) add(v, rel);
  }
}
for (const [key, t] of Object.entries(SURVEY_TEMPLATES)) {
  try {
    const def = typeof t.build === "function" ? t.build() : t;
    for (const b of def.ux?.behaviors ?? []) if (b.script) add(b.script, `template:${key}`);
    for (const q of def.questions ?? []) if (q.customJs) add(q.customJs, `template:${key}`);
  } catch { /* a template that needs arguments */ }
}

/* the survey the verdicts are read against: question ids q1…, codes Q1…, single-selects with options 1–5 */
const qs = Array.from({ length: 12 }, (_, i) => ({ id: `q${i + 1}`, code: `Q${i + 1}`, variableName: `Q${i + 1}`, type: i % 3 === 2 ? "numeric" : "single_select", text: `Question ${i + 1}`, options: i % 3 === 2 ? [] : [1, 2, 3, 4, 5].map((c) => ({ code: c, label: `Option ${c}` })) }));
export const VERDICT_DEF = { meta: { id: "corpus", code: "CORPUS", title: "Script corpus" }, questions: qs, flow: [{ type: "page", id: "p1", questionIds: qs.map((q) => q.id) }] };
const def = SurveyDefinition.parse(VERDICT_DEF);
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
const entries = [...found.values()].sort((a, b) => a.id.localeCompare(b.id)).map((e) => {
  const old = prev?.scripts?.find((x) => x.id === e.id);
  if (corpusOnly && old) return { ...e, verdict: old.verdict };
  const runtime = E.validateUxScript(e.code, def);
  return { ...e, verdict: { runtime: runtime.errors, authoring: E.scriptAuthoringProblems(e.code, def) } };
});
writeFileSync(OUT, `${JSON.stringify({ about: "Every behaviour script / Custom Code found in the repository (tests, browser suites, guides, fixtures, templates) with the verdict of the script checks BEFORE the tokenizer-based checks of 2026-10-22 (engine #14). Regenerate only deliberately: node scripts/engine-11-14/make-script-corpus.mjs", def: VERDICT_DEF, scripts: entries }, null, 1)}\n`);
console.log(`${entries.length} scripts from ${new Set(entries.flatMap((e) => e.from)).size} sources → ${relative(ROOT, OUT)}; refused at authoring: ${entries.filter((e) => e.verdict.authoring.length).length}; refused at runtime: ${entries.filter((e) => e.verdict.runtime.length).length}`);
