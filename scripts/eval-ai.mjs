/**
 * THE INTELLIGENT MODE EVALUATION HARNESS (2026-10-18) — `pnpm eval:ai`.
 *
 *   pnpm eval:ai                                   fake provider: every model reply scripted per case
 *   EVAL_AI_API_URL=https://api.anthropic.com/v1 EVAL_AI_API_KEY=… EVAL_AI_MODEL=claude-sonnet-4-6 pnpm eval:ai [--record]
 *   pnpm eval:ai --replay apps/studio/lib/eval/cassettes/<file>.json     re-score recorded real replies offline, no key
 *
 *   --filter <regex>     case ids / categories to run        --admin-subset   only the ≤10 /platform cases
 *   --production-limit N how many of E3's production prompts (default 12, one per tag first; 0 = all)
 *   --record [path]      save the real replies as a cassette --replay <path>  answer from a cassette
 *   --stream             ask the route for its NDJSON stream (the Studio's streaming path)
 *   --max-cost <usd>     hard cap: stop between cases once spent (real provider; default 5)
 *   --out <dir>          report directory (default eval-reports/)
 *   --baseline <path>    (default apps/studio/lib/eval/baseline.json)  --update-baseline  write this run into it
 *   --strict             exit non-zero on ANY failing case, not only on a regression
 *   --list               print the cases and exit
 *
 * Every case goes through the REAL /api/copilot/turn handler, loaded in-process with the Studio's own modules
 * (scripts/eval/hooks.mjs resolves the `@/` aliases; the guard answers this process's test user only). The
 * project is always the sandbox: no database is used (SUPABASE_* are removed from this process), no customer
 * project is read or written, the usage is metered by the in-memory sandbox meter — whose events give the
 * tokens (cache read / write included), the cost and the latency of every call.
 *
 * The provider is ONLY what EVAL_AI_* names (or the cassette): an AI_API_URL already in the environment is
 * ignored, so the harness never spends on a key by accident. Exit code: 0 ok, 1 regression against the
 * baseline (or any failure with --strict), 2 harness error.
 */
import { createRequire, register } from "node:module";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STUDIO = join(ROOT, "apps/studio");
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined; };
const flag = (name) => args.includes(`--${name}`);

if (!process.features?.typescript && !process.execArgv.some((a) => a.includes("strip-types"))) {
  console.error("Run with: node --experimental-strip-types --no-warnings scripts/eval-ai.mjs (or `pnpm eval:ai`)");
  process.exit(2);
}

/* ---- the provider: EVAL_AI_* or a cassette, never an inherited key */
const replayPath = opt("replay");
const recordPath = flag("record") ? (opt("record") ?? null) : undefined;
let cassette = null;
let mode = "fake";
for (const k of ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_MODEL_SMALL", "AI_FALLBACK_API_URL", "AI_FALLBACK_API_KEY", "AI_FALLBACK_MODEL", "AI_EMBEDDINGS_MODEL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) delete process.env[k];
if (replayPath) {
  cassette = JSON.parse(readFileSync(resolve(replayPath), "utf8"));
  if (cassette?.version !== 1 || !cassette.provider?.base) { console.error(`${replayPath} is not a cassette`); process.exit(2); }
  Object.assign(process.env, { AI_API_URL: cassette.provider.base, AI_API_KEY: "replay-no-key", AI_MODEL: cassette.provider.model, ...(cassette.provider.modelSmall ? { AI_MODEL_SMALL: cassette.provider.modelSmall } : {}) });
  mode = "replay";
} else if (process.env.EVAL_AI_API_URL && process.env.EVAL_AI_API_URL.trim() !== "fake:") {
  Object.assign(process.env, { AI_API_URL: process.env.EVAL_AI_API_URL.trim(), AI_API_KEY: (process.env.EVAL_AI_API_KEY ?? "").trim(), AI_MODEL: (process.env.EVAL_AI_MODEL ?? "").trim() || "claude-sonnet-4-6", ...(process.env.EVAL_AI_MODEL_SMALL ? { AI_MODEL_SMALL: process.env.EVAL_AI_MODEL_SMALL.trim() } : {}) });
  mode = "live";
} else process.env.AI_API_URL = "fake:";
if (recordPath !== undefined && mode !== "live") { console.error("--record needs a real provider (EVAL_AI_API_URL / EVAL_AI_API_KEY)."); process.exit(2); }
process.env.BILLING_SANDBOX_CREDITS = "1000000";
/* --stream: the route answers NDJSON (on the fake provider too), read by the browser's own reader */
if (flag("stream")) process.env.COPILOT_STREAMING = "on";
process.env.EVAL_GUARD_SHIM = "1";
process.env.EVAL_HARNESS_TOKEN = randomBytes(24).toString("hex");
register(pathToFileURL(join(ROOT, "scripts/eval/hooks.mjs")));

const imp = (rel) => import(pathToFileURL(join(STUDIO, rel)).href);
const { GOLDEN_CASES, injectionCases, productionPromptCases, productionCorpusCases, adminCases, LOCAL_INJECTION_CORPUS, LOCAL_PRODUCTION_PROMPTS } = await imp("lib/eval/cases.ts");

/* ---- the cases: the golden set, E2's injection corpus and E3's production prompts when they are in the tree */
const notes = [];
const corpusPath = join(ROOT, "packages/engine/src/fixtures/prompt-injection-corpus.json");
let corpus = LOCAL_INJECTION_CORPUS;
if (existsSync(corpusPath)) { try { corpus = JSON.parse(readFileSync(corpusPath, "utf8")); notes.push("Injection cases from E2's corpus (packages/engine/src/fixtures/prompt-injection-corpus.json)."); } catch { notes.push("E2's injection corpus did not parse — the local minimal payloads were used."); } }
else notes.push("E2's injection corpus is not in the tree — the local minimal payloads were used.");
/* E3's corpus: { about, survey, cases: [{ id, prompt, context, tags, expect }], variants } — or a flat list of prompts */
const prodLimit = Number(opt("production-limit") ?? 12);
let prodCorpus = null;
const prodCandidates = ["apps/studio/lib/copilot/fixtures/productionPrompts.json", "apps/studio/lib/copilot/fixtures/production-prompts.json", "packages/engine/src/fixtures/production-prompts.json", "apps/studio/lib/copilot/productionPrompts.json"];
let prodPrompts = [];
const prodHit = prodCandidates.map((p) => join(ROOT, p)).find((p) => existsSync(p));
if (prodHit) { try { const j = JSON.parse(readFileSync(prodHit, "utf8")); if (j && Array.isArray(j.cases)) { prodCorpus = j; notes.push(`Production prompts: ${Math.min(j.cases.length, prodLimit || j.cases.length)} of E3's ${j.cases.length} (${prodHit.slice(ROOT.length + 1)}), one per tag first; --production-limit 0 runs all.`); } else { prodPrompts = Array.isArray(j) ? j : j.prompts ?? j.productionPrompts ?? []; notes.push(`Production prompts from ${prodHit.slice(ROOT.length + 1)} (E3).`); } } catch { notes.push("E3's production prompts did not parse."); } }
else {
  /* E3's corpus may be a TS module exporting productionPrompts */
  for (const p of ["apps/studio/lib/copilot/productionPrompts.ts", "apps/studio/lib/copilot/fixtures/productionPrompts.ts", "packages/engine/src/fixtures/productionPrompts.ts"]) {
    if (!existsSync(join(ROOT, p))) continue;
    try { const m = await import(pathToFileURL(join(ROOT, p)).href); prodPrompts = m.productionPrompts ?? m.PRODUCTION_PROMPTS ?? m.default ?? []; notes.push(`Production prompts from ${p} (E3).`); break; } catch (e) { notes.push(`E3's ${p} could not be loaded: ${String(e?.message ?? e).slice(0, 120)}`); }
  }
}
const prodSource = prodPrompts.length ? "production-prompts" : "local-minimal";
if (!prodPrompts.length && !prodCorpus) { prodPrompts = LOCAL_PRODUCTION_PROMPTS; notes.push("E3's production-prompt corpus is not in the tree — a minimal local set of production-shaped prompts was used (cases.ts LOCAL_PRODUCTION_PROMPTS)."); }
let cases = [...GOLDEN_CASES, ...injectionCases(corpus), ...(prodCorpus ? productionCorpusCases(prodCorpus, prodLimit) : productionPromptCases(prodPrompts, prodLimit, prodSource))];
if (flag("admin-subset")) cases = adminCases(cases);
const filter = opt("filter");
if (filter) { const re = new RegExp(filter, "i"); cases = cases.filter((c) => re.test(c.id) || re.test(c.category)); }
if (cassette) cases = cases.filter((c) => cassette.cases[c.id]);
if (flag("list")) { for (const c of cases) console.log(`${c.id.padEnd(40)} ${c.category.padEnd(18)} ${c.turns.length} turn(s)  ${c.title}`); process.exit(0); }
if (!cases.length) { console.error("No case to run."); process.exit(2); }

/* ---- the real route, in-process */
const { POST } = await imp("app/api/copilot/turn/route.ts");
const { NextRequest } = await import(pathToFileURL(createRequire(join(STUDIO, "package.json")).resolve("next/server.js")).href);
const { inProcessDeps } = await imp("lib/eval/harness.ts");
const { runCases } = await imp("lib/eval/runner.ts");
const { reportMarkdown, compareToBaseline, baselineEntry } = await imp("lib/eval/report.ts");
const { CassetteRecorder, CassettePlayer } = await imp("lib/eval/cassette.ts");
const { getSandboxMeter } = await imp("lib/metering.ts");


const token = process.env.EVAL_HARNESS_TOKEN;
const realFetch = globalThis.fetch;
let recorder = null, player = null;
if (recordPath !== undefined) { recorder = new CassetteRecorder({ base: process.env.AI_API_URL.replace(/\/+$/, ""), model: process.env.AI_MODEL, ...(process.env.AI_MODEL_SMALL ? { modelSmall: process.env.AI_MODEL_SMALL } : {}) }); globalThis.fetch = recorder.wrap(realFetch); }
if (cassette) { player = new CassettePlayer(cassette); globalThis.fetch = player.wrap(async (input) => { throw new Error(`replay: no network (${String(input?.url ?? input).slice(0, 80)})`); }); }

const deps = inProcessDeps({
  call: (body, headers) => POST(new NextRequest("http://eval.local/api/copilot/turn", { method: "POST", headers: { ...headers, "x-rescript-eval": token }, body: JSON.stringify(body) })),
  store: () => getSandboxMeter().store,
  fake: mode === "fake",
  stream: flag("stream"),
});
deps.onTurn = (id, i) => { recorder?.begin(id, i); player?.begin(id, i); };
deps.onTurnEnd = (_id, _i, ms) => recorder?.end(ms);
if (player) deps.recordedLatency = (id, i) => player.turnLatency(id, i);
if (mode === "live") deps.stopAt = Number(opt("max-cost") ?? 5);

const model = mode === "fake" ? "fake" : process.env.AI_MODEL;
const provider = mode === "fake" ? "fake" : (() => { try { return new URL(process.env.AI_API_URL).host; } catch { return "provider"; } })();
const startedAt = new Date().toISOString();
console.log(`Intelligent Mode evaluation — ${mode} (${model}), ${cases.length} case(s)`);
const report = await runCases(cases, deps, { startedAt, mode, provider, model, key: `${mode === "replay" ? "live" : mode}:${model}`, ...(filter ? { filter } : {}), ...(flag("stream") ? { stream: true } : {}), notes: [...notes, ...(mode === "fake" ? ["Fake provider: the model is NOT evaluated — scripted replies stand in for it. Real-model numbers come from the first real run."] : [])] },
  (r) => console.log(`  ${r.passed ? "pass" : "FAIL"}  ${r.id.padEnd(40)} ${r.category.padEnd(18)} $${r.costUsd.toFixed(4)}  ${r.latencyMs} ms${r.passed ? "" : `  ← ${[...r.turns.flatMap((t) => t.failed.map((f) => `t${t.index + 1}:${f}`)), ...r.budgetChecks.filter((b) => !b.ok).map((b) => `budget:${b.name}`), ...(r.error ? [r.error.slice(0, 80)] : [])].join(", ")}`}`));
globalThis.fetch = realFetch;
if (player?.misses.length) report.meta.notes.push(`Cassette misses: ${player.misses.slice(0, 10).join("; ")}`);

/* ---- baseline, reports, cassette */
const baselinePath = resolve(opt("baseline") ?? join(STUDIO, "lib/eval/baseline.json"));
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
const cmp = filter || flag("admin-subset") ? null : compareToBaseline(report, baseline);
const outDir = resolve(opt("out") ?? join(ROOT, "eval-reports"));
mkdirSync(outDir, { recursive: true });
const stamp = report.meta.finishedAt.replace(/[:.]/g, "-");
const md = reportMarkdown(report, cmp ?? undefined);
writeFileSync(join(outDir, `ai-eval-${mode}-${stamp}.json`), JSON.stringify({ ...report, comparison: cmp }, null, 2));
writeFileSync(join(outDir, `ai-eval-${mode}-${stamp}.md`), md);
writeFileSync(join(outDir, "latest.json"), JSON.stringify({ ...report, comparison: cmp }, null, 2));
writeFileSync(join(outDir, "latest.md"), md);
if (recorder) {
  const path = resolve(typeof recordPath === "string" ? recordPath : join(STUDIO, "lib/eval/cassettes", `${model}-${stamp}.json`));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(recorder.cassette, null, 1));
  console.log(`Cassette: ${path}`);
}
if (flag("update-baseline")) { baseline[report.meta.key] = baselineEntry(report); writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`); console.log(`Baseline ${report.meta.key} updated in ${baselinePath}`); }

const s = report.summary;
console.log(`\nPass rate ${(s.passRate * 100).toFixed(1)} % (${s.passed}/${s.cases}) · cost $${s.costUsd.toFixed(4)} · p50 ${s.latencyMs.p50} ms · p95 ${s.latencyMs.p95} ms · repair ${(s.repairRate * 100).toFixed(1)} % · clarify ${(s.clarifyRate * 100).toFixed(1)} %`);
console.log(`Report: ${join(outDir, "latest.md")}`);
if (cmp?.regressions.length) { console.log(`\n${cmp.regressions.length} regression(s) against ${report.meta.key}:\n  ${cmp.regressions.join("\n  ")}`); process.exit(1); }
if (flag("strict") && s.passed < s.cases) process.exit(1);
process.exit(0);
