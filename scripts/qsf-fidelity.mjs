#!/usr/bin/env node
/**
 * QSF FIDELITY REGRESSION SUITE (QSF brief, Phase 5).
 *
 *   node scripts/qsf-fidelity.mjs                 measure the corpus, compare with expected.json, fail on drift
 *   node scripts/qsf-fidelity.mjs --update        rewrite expected.json from the current measurement
 *   node scripts/qsf-fidelity.mjs --dir ~/exports measure every .qsf in a folder of real exports as well
 *                                                 (measured, never copied: nothing from that folder is written here)
 *   node scripts/qsf-fidelity.mjs --json out.json write the full measurement for a report
 *
 * For every file: import (packages/import), the report's measured fidelity
 * (items as-is / changed / not reproduced, per feature), the unresolved
 * references, and the engine verification — structure against the source,
 * and the runtime walks (deepest, first, last, random seeds). The
 * expectation is the whole measurement, so a change that silently loses a
 * feature, a code, a translation or a reachable question fails here.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeImport, verifyImport } from "../packages/import/dist/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = join(ROOT, "packages", "import", "corpus", "qsf");
const EXPECTED = join(CORPUS, "expected.json");
const args = process.argv.slice(2);
const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const update = args.includes("--update");
const extraDir = flag("--dir");
const jsonOut = flag("--json");

let seq = 0;
const uid = (p) => `${p}_${(++seq).toString(36)}`;

async function measure(path) {
  seq = 0;
  const name = basename(path);
  const bytes = new Uint8Array(readFileSync(path));
  const a = await analyzeImport(bytes, name, { surveyId: "fidelity", uid });
  if (!a.result?.def) return { file: name, ok: false, error: a.issues[0]?.message ?? "no survey produced", issues: a.issues.slice(0, 5) };
  const r = a.report, m = a.result;
  const v = verifyImport(a.canonical, m);
  return {
    file: name, ok: r.ok && v.ok,
    title: a.canonical.source.title ?? null,
    detected: r.detected, created: r.created,
    fidelity: {
      totals: r.fidelity.totals, importedPct: r.fidelity.importedPct,
      features: Object.fromEntries(r.fidelity.features.map((f) => [f.feature, { detected: f.detected, imported: f.imported, partial: f.partial, unsupported: f.unsupported }])),
      unresolved: r.fidelity.unresolved.map((u) => `${u.kind}:${u.ref}@${u.location}`).sort(),
      assets: r.fidelity.assets.map((x) => `${x.risk}:${x.location}`).sort(),
      languages: r.fidelity.languages,
      elements: r.fidelity.elements.map((e) => `${e.type}:${e.count}:${e.handled}`),
    },
    quality: { errors: m.quality?.errors.length ?? null, warnings: m.quality?.warnings.length ?? null },
    risks: { high: r.risks.high.length, medium: r.risks.medium.length, low: r.risks.low.length },
    verification: {
      ok: v.ok,
      structure: { checked: v.structure.checked, ok: v.structure.ok, errors: v.structure.findings.filter((f) => f.level === "error").map((f) => `${f.sourceId}: ${f.message}`), warnings: v.structure.findings.filter((f) => f.level === "warning").length },
      runtime: { placed: v.runtime.placed, reached: v.runtime.reached, unreachable: v.runtime.unreachable.map((u) => `${u.code}:${u.reason}`), unanswerable: v.runtime.unanswerable.map((u) => u.code), errors: v.runtime.errors, endStatuses: [...v.runtime.endStatuses].sort(), walks: v.runtime.walks.map((w) => `${w.strategy}:${w.pages}p/${w.questions}q→${w.end}`) },
      analysis: v.analysis,
    },
    summary: r.summary,
  };
}

const diff = (a, b, path = "") => {
  const out = [];
  if (Array.isArray(a) || Array.isArray(b)) { if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); return out; }
  if (a && b && typeof a === "object" && typeof b === "object") { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out.push(...diff(a[k], b[k], path ? `${path}.${k}` : k)); return out; }
  if (a !== b) out.push(`${path}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  return out;
};
/* what the expectation pins: everything except the summary sentences (wording may change) */
const pinned = (x) => { const { summary: _s, ...rest } = x; void _s; return rest; };

const corpusFiles = readdirSync(CORPUS).filter((f) => f.endsWith(".qsf")).sort().map((f) => join(CORPUS, f));
const extraFiles = extraDir && existsSync(extraDir) ? readdirSync(extraDir).filter((f) => /\.qsf$/i.test(f)).sort().map((f) => join(extraDir, f)) : [];
const expected = existsSync(EXPECTED) ? JSON.parse(readFileSync(EXPECTED, "utf8")) : {};
const results = {};
let failed = 0;
const line = (x) => {
  if (!x.fidelity) return `  ${x.file}: FAILED — ${x.error}`;
  const t = x.fidelity.totals, rt = x.verification.runtime;
  return `  ${x.file.padEnd(36)} ${String(x.fidelity.importedPct).padStart(5)}% as-is  (${t.imported}/${t.detected}, ${t.partial} changed, ${t.unsupported} not reproduced)  unresolved ${x.fidelity.unresolved.length}  quality ${x.quality.errors}e/${x.quality.warnings}w  runtime ${rt.reached}/${rt.placed} reached → ${rt.endStatuses.join("/")}  structure ${x.verification.structure.ok}/${x.verification.structure.checked}${x.verification.structure.errors.length ? ` (${x.verification.structure.errors.length} errors)` : ""}  ${x.ok ? "ok" : "NOT OK"}`;
};

console.log("QSF fidelity — corpus");
for (const f of corpusFiles) {
  const x = await measure(f);
  results[x.file] = x;
  console.log(line(x));
  if (!update) {
    const exp = expected[x.file];
    if (!exp) { console.log(`    no expectation recorded — run with --update`); failed++; continue; }
    const d = diff(pinned(x), pinned(exp));
    if (d.length) { failed++; for (const l of d.slice(0, 40)) console.log(`    drift: ${l}`); }
  }
}
if (extraFiles.length) {
  console.log(`\nQSF fidelity — ${extraDir} (measured only)`);
  for (const f of extraFiles) { const x = await measure(f); results[x.file] = x; console.log(line(x)); if (x.fidelity) for (const s of x.summary) console.log(`      ${s}`); }
}
if (update) { writeFileSync(EXPECTED, JSON.stringify(Object.fromEntries(corpusFiles.map((f) => [basename(f), results[basename(f)]])), null, 2) + "\n"); console.log(`\nexpectations written to ${EXPECTED}`); }
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
if (!update && failed) { console.log(`\n${failed} file(s) drifted from expected.json`); process.exit(1); }
console.log(update ? "" : "\nno drift");
