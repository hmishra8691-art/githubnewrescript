/**
 * THE QUALITATIVE SYNTHESIS EVALUATION (2026-10-22) — the companion of `pnpm eval:ai` for the synthesis prompts
 * (theme summaries, insights, ask, group-session clusters and follow-ups), which do not go through the copilot turn:
 *
 *   node --experimental-strip-types --no-warnings scripts/eval-qual-synthesis.mjs              scripted replies (fake)
 *   EVAL_AI_API_URL=… EVAL_AI_API_KEY=… EVAL_AI_MODEL=… node --experimental-strip-types --no-warnings scripts/eval-qual-synthesis.mjs
 *                                                                                               the model's own replies
 *   --strict   exit 1 on any failing case          --out <dir>   report directory (default eval-reports/)
 *
 * Every case runs the production prompt builders and readers (apps/studio/lib/eval/qualSynthesisCases.ts). The
 * provider is ONLY what EVAL_AI_* names — an AI_API_URL in the environment is ignored, like the main harness. The
 * transcripts are fixtures (no project data); a real run costs ten small calls.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
for (const k of ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_MODEL_SMALL"]) delete process.env[k];
let mode = "fake";
if (process.env.EVAL_AI_API_URL && process.env.EVAL_AI_API_URL.trim() !== "fake:") {
  Object.assign(process.env, { AI_API_URL: process.env.EVAL_AI_API_URL.trim(), AI_API_KEY: (process.env.EVAL_AI_API_KEY ?? "").trim(), AI_MODEL: (process.env.EVAL_AI_MODEL ?? "").trim() || "claude-sonnet-4-6" });
  mode = "live";
} else process.env.AI_API_URL = "fake:";

const { QUAL_EVAL_CASES, runQualEvalCase, qualEvalMarkdown } = await import(pathToFileURL(join(ROOT, "apps/studio/lib/eval/qualSynthesisCases.ts")).href);
const ai = mode === "live" ? await import(pathToFileURL(join(ROOT, "packages/ai/dist/index.js")).href) : null;
const complete = async (system, prompt, fake) => (ai ? ai.completeJson(system, prompt, 1800, { timeoutMs: 90_000, operation: "eval_qual_synthesis" }) : fake());

const results = [];
for (const c of QUAL_EVAL_CASES) {
  const r = await runQualEvalCase(c, complete);
  results.push(r);
  console.log(`${r.pass ? "  ok  " : "  FAIL"} ${r.id}${r.pass ? "" : ` — ${r.checks.filter((x) => !x.pass).map((x) => x.name).join("; ")}`}`);
}
const out = opt("out") ?? join(ROOT, "eval-reports");
mkdirSync(out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(join(out, `qual-synthesis-${mode}-${stamp}.json`), JSON.stringify({ mode, results: results.map(({ system: _s, prompt: _p, ...r }) => r) }, null, 2));
writeFileSync(join(out, `qual-synthesis-${mode}-${stamp}.md`), qualEvalMarkdown(results, mode));
const failed = results.filter((r) => !r.pass).length;
console.log(`qual-synthesis eval (${mode}): ${results.length - failed}/${results.length} passed`);
process.exit(failed && (args.includes("--strict") || mode === "fake") ? 1 : 0);
