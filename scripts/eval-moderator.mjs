/**
 * AI MODERATOR EVALUATION (2026-10-22) — the golden conversations of `packages/engine/src/aiModeratorEval.ts`
 * against a real provider, scored with the same checks the unit test applies to the stand-in.
 *
 *   node scripts/eval-moderator.mjs                         stand-in model (free; proves the engine, not a model)
 *   EVAL_AI_API_URL=https://api.anthropic.com/v1 EVAL_AI_API_KEY=… EVAL_AI_MODEL=claude-sonnet-4-6 \
 *     node scripts/eval-moderator.mjs [--filter mod-hindi] [--max-cost 2]
 *
 * Only EVAL_AI_* select a provider (an AI_API_URL already in the environment is ignored, so a run never spends
 * on a key by accident). The guide prefix is sent as cached system blocks, exactly as the runtime sends it.
 * Cost is priced from the reported tokens at EVAL_RATE_IN / EVAL_RATE_CACHED / EVAL_RATE_OUT (USD per million;
 * default 3 / 0.3 / 15) and the run stops between cases past --max-cost (default 2 USD).
 * Report: eval-reports/moderator-<mode>-<time>.{json,md}. Exit 0 all pass · 1 a case failed · 2 harness error.
 *
 * Needs: pnpm --filter @rescript/schema --filter @rescript/engine --filter @rescript/ai build
 */
import { mkdirSync, writeFileSync } from "node:fs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const real = !!process.env.EVAL_AI_API_URL;
for (const k of ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_FALLBACK_API_URL"]) delete process.env[k];
if (real) { process.env.AI_API_URL = process.env.EVAL_AI_API_URL; process.env.AI_API_KEY = process.env.EVAL_AI_API_KEY ?? ""; process.env.AI_MODEL = process.env.EVAL_AI_MODEL ?? ""; }
else process.env.AI_API_URL = "fake:";

try {
  const engine = await import("../packages/engine/dist/index.js");
  const ai = await import("../packages/ai/dist/index.js");
  const rates = { in: Number(process.env.EVAL_RATE_IN ?? 3), cached: Number(process.env.EVAL_RATE_CACHED ?? 0.3), out: Number(process.env.EVAL_RATE_OUT ?? 15) };
  const maxCost = Number(arg("--max-cost", "2"));
  const filter = arg("--filter", null);
  const model = real
    ? async (req) => {
      const { value, usage } = await ai.collectUsage(() => ai.completeJson(req.system, req.user, req.maxTokens, { schema: req.schema, promptCache: true, timeoutMs: 30_000, retries: 1, continuations: 0, operation: "qual_ai_interview_eval" }));
      const u = ai.chatUsageUnits(usage);
      const cached = Number(u.cacheReadUnits ?? 0), input = Number(u.inputUnits ?? 0), out = Number(u.outputUnits ?? 0);
      return { value, costUsd: ((input - cached) * rates.in + cached * rates.cached + out * rates.out) / 1_000_000 };
    }
    : engine.fakeEvalModel;
  const cases = engine.MODERATOR_EVAL_CASES.filter((c) => !filter || new RegExp(filter).test(c.id));
  const results = [];
  let spent = 0;
  for (const c of cases) {
    if (spent > maxCost) { console.log(`  stop  cost cap $${maxCost} reached before ${c.id}`); break; }
    const r = await engine.runModeratorCase(c, model, { real });
    spent += r.costUsd;
    results.push(r);
    console.log(`  ${r.pass ? "pass" : "FAIL"}  ${c.id.padEnd(26)} calls ${r.modelCalls}  rejected ${r.rejected}  $${r.costUsd.toFixed(4)}${r.pass ? "" : `\n        ${r.failures.join("\n        ")}`}`);
  }
  const rep = engine.moderatorEvalReport(results, { mode: real ? "live" : "fake", model: real ? process.env.EVAL_AI_MODEL ?? "?" : "fake" });
  mkdirSync("eval-reports", { recursive: true });
  const stamp = rep.at.replace(/[:.]/g, "-");
  writeFileSync(`eval-reports/moderator-${rep.mode}-${stamp}.json`, JSON.stringify(rep, null, 2));
  writeFileSync(`eval-reports/moderator-${rep.mode}-${stamp}.md`, engine.moderatorEvalMarkdown(rep));
  console.log(`\nPass rate ${rep.passRate} % · model calls ${rep.modelCalls} · rejected ${rep.rejectedReplies} · fallbacks ${rep.fallbacks} · $${rep.costUsd.toFixed(4)} · p50 ${rep.p50Ms} ms\nReport: eval-reports/moderator-${rep.mode}-${stamp}.md`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
} catch (e) {
  console.error("harness error:", e);
  process.exit(2);
}
