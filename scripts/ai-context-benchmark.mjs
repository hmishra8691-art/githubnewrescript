/**
 * AI CONTEXT BENCHMARK — the same long-brief staged generation, BEFORE and AFTER the structured research
 * context (docs/CONTEXT-COST-REGISTRY-2026-10-18.md §3).
 *
 *   node --experimental-strip-types --no-warnings scripts/ai-context-benchmark.mjs [--json]
 *
 * Reproducible: the ~24k-character brief fixture (apps/studio/lib/copilot/fixtures/masterPromptBrief.mjs), a fixed
 * 12-item plan (one item per questionnaire section plus design, logic and analysis — the shape the plan prompt asks
 * for), an empty survey. Every stage's prompt is built with the Studio's own builders exactly as the copilot route
 * assembles it (copilotUserPrompt, executeItemPrompt, copilotCall, and for AFTER the route's helpers
 * deriveResearchContext / briefLayerOptions / itemPassagesFor), and SENT through the fake provider
 * (AI_API_URL=fake:) inside collectUsage — the fake reports input tokens deterministically from the characters
 * (ceil(chars / 4) + 60), the meter's own estimator. BEFORE is the old context assembly (the whole brief in every
 * item), kept here only as the builder called without the new options.
 *
 * Priced with the billing package's priceSpec and default rate table at claude-sonnet-4-6 ($3 / M input, $15 / M
 * output, cache read 10 %, write 125 %). Output tokens are NOT measured here (the fake answers {}): both runs are
 * priced with the same assumed output per call, so the difference is input alone.
 */
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

process.env.AI_API_URL = "fake:";
delete process.env.BILLING_SIMULATE_FAKE_COSTS;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STUDIO = join(ROOT, "apps/studio");
const req = createRequire(join(STUDIO, "package.json"));
const imp = (rel) => import(pathToFileURL(join(STUDIO, rel)).href);
const pkg = async (name) => import(pathToFileURL(req.resolve(name)).href);

const { completeJson, collectUsage, sumUsage } = await pkg("@rescript/ai");
const { priceSpec, DEFAULT_RATES, DEFAULT_BILLABLE_EVENTS, billingConfig } = await pkg("@rescript/billing");
const { SurveyDefinition } = await pkg("@rescript/schema");
const P = await imp("lib/copilot/prompt.ts");
const { executeItemPrompt, planStagePrompt } = await imp("lib/copilot/changePlan.ts");
const { copilotOutline } = await imp("lib/copilot/outline.ts");
const { copilotCall } = await imp("lib/aiPromptCache.ts");
const { listFillIntent } = await imp("lib/copilot/listFillGuide.ts");
const { methodsIntent } = await imp("lib/copilot/methodsGuide.ts");
const { qualIntent, researchPlanIntent } = await imp("lib/copilot/researchGuide.ts");
const RC = await imp("lib/copilot/researchContext.ts");
const { MASTER_PROMPT_BRIEF } = await imp("lib/copilot/fixtures/masterPromptBrief.mjs");

const JSON_OUT = process.argv.includes("--json");
const brief = P.normalizeBrief(MASTER_PROMPT_BRIEF);
const def = SurveyDefinition.parse({ meta: { id: "bench", code: "BENCH", title: "Industry survey" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
const sections = ["Screening and firmographics", "Research portfolio", "Technology stack", "End-to-end workflow", "Questionnaire design and programming", "Data quality", "Analysis and reporting", "AI adoption", "Buying process and pricing", "Demographics and close"];
const plan = {
  summary: "A global B2B survey of research professionals built from the brief",
  items: [
    { id: "p1", title: "Write the research design: objectives, hypotheses H1–H8, constructs, population and quotas", kind: "design", objects: ["Research design"], reason: "every hypothesis must be measurable" },
    ...sections.map((s, i) => ({ id: `p${i + 2}`, title: `Add the ${s} block`, kind: "create", objects: [s], reason: `section 8.${i + 1} of the brief` })),
    { id: "p12", title: "Add the stage loop, display logic and the analysis plan", kind: "analysis", objects: ["Loop", "Analysis plan"], reason: "the stage-level questions and the hypothesis tests" },
  ],
  questions: [], assumptions: ["The competitor list is supplied later"],
};
const OUT = { plan: 2500, item: 3000 };

/* the route's options for a generation from this brief (mode generate; the guides the brief names) */
const mode = "generate";
const base = {
  message: brief, outline: copilotOutline(def, { analysis: true }), surveyLanguage: P.surveyLanguageOf(def), mode,
  analysis: true, translation: P.translationIntent(brief), quota: P.quotaIntent(brief), listFill: listFillIntent(brief), methods: methodsIntent(brief), findings: P.findingsIntent(brief),
};

async function send(stage, userText, extra = []) {
  const [system, user] = copilotCall(userText, extra);
  const { usage } = await collectUsage(() => completeJson(system, user, OUT.item, { operation: stage }));
  const t = sumUsage(usage);
  const stable = system.join("\n\n").length;
  return { stage, chars: stable + user.length, stableChars: stable, variableChars: user.length, inputTokens: t.inputTokens, requests: t.requests };
}

async function run(after) {
  const rows = [];
  const planText = P.copilotUserPrompt({ ...base, planOnly: true, longBrief: true }) + planStagePrompt({ longBrief: true });
  rows.push(await send("plan", planText));
  /* AFTER: the plan stage leaves the research context behind — derived, not asked of a model */
  const ctx = after ? RC.deriveResearchContext({ brief, plan, def }) : null;
  const layers = ctx ? RC.briefLayerOptions(ctx) : null;
  const briefSections = RC.sectionBrief(brief);
  const prompt = P.copilotUserPrompt({ ...base, ...(layers ? { ...layers, researchPlan: researchPlanIntent(brief, mode), qual: qualIntent(brief), reporting: P.reportingIntent(brief) } : {}) });
  const done = [];
  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i];
    const passages = ctx ? RC.itemPassagesFor(briefSections, item) : { text: "", ids: [] };
    const text = prompt + passages.text + executeItemPrompt(plan, item, i, plan.items, done);
    const row = await send(`item ${item.id}`, text, layers ? [layers.researchContext] : []);
    rows.push({ ...row, passages: passages.ids });
    done.push(`${item.title} (Q${i * 8 + 1}–Q${i * 8 + 8})`);
  }
  return { rows, contextChars: layers?.researchContext.length ?? 0 };
}

const before = await run(false);
const after = await run(true);

const cfg = billingConfig({});
const MODEL = "claude-sonnet-4-6";
const price = (input, output, read = 0, write = 0) => priceSpec({ eventType: "AI_REQUEST", provider: "openai-compatible", service: "chat", model: MODEL, inputUnits: input, outputUnits: output, cacheReadUnits: read, cacheWriteUnits: write }, "LIVE", cfg, DEFAULT_RATES, DEFAULT_BILLABLE_EVENTS).breakdown;
const tok = (chars) => Math.ceil(chars / 4);
function cost(rows) {
  let cold = 0, warm = 0, provCold = 0, provWarm = 0;
  rows.forEach((r, i) => {
    const out = r.stage === "plan" ? OUT.plan : OUT.item;
    const c = price(r.inputTokens, out);
    /* warm: the system blocks were written by the previous call of the run (5-minute cache) and are read now; the first call writes them */
    const cached = Math.min(tok(r.stableChars), r.inputTokens);
    const prevStable = i > 0 ? rows[i - 1].stableChars : 0;
    const w = i === 0 || prevStable !== r.stableChars ? price(r.inputTokens, out, 0, cached) : price(r.inputTokens, out, cached, 0);
    cold += c.customerCharge; warm += w.customerCharge; provCold += c.providerCost; provWarm += w.providerCost;
  });
  return { cold, warm, provCold, provWarm };
}
const total = (rows, k) => rows.reduce((n, r) => n + r[k], 0);
const summary = (label, r) => ({ label, calls: r.rows.length, chars: total(r.rows, "chars"), variableChars: total(r.rows, "variableChars"), inputTokens: total(r.rows, "inputTokens"), itemInputTokens: total(r.rows.slice(1), "inputTokens"), ...cost(r.rows) });
const S = { before: summary("before", before), after: summary("after", after) };

if (JSON_OUT) {
  console.log(JSON.stringify({ briefChars: brief.length, contextChars: after.contextChars, before: before.rows, after: after.rows, totals: S, model: MODEL, assumedOutput: OUT }, null, 2));
} else {
  const pad = (s, n) => String(s).padStart(n);
  console.log(`\nAI CONTEXT BENCHMARK — brief ${brief.length.toLocaleString("en")} characters, ${plan.items.length}-item plan, empty survey; research context ${after.contextChars.toLocaleString("en")} characters`);
  console.log(`(input tokens as the fake provider reports them: ceil(chars/4) + 60; priced at ${MODEL}, default rates and margin; output assumed ${OUT.plan} plan / ${OUT.item} per item in BOTH runs)\n`);
  console.log("stage        | BEFORE chars  variable  in tokens | AFTER chars  variable  in tokens  passages");
  for (let i = 0; i < before.rows.length; i++) {
    const b = before.rows[i], a = after.rows[i];
    console.log(`${b.stage.padEnd(12)} | ${pad(b.chars, 11)} ${pad(b.variableChars, 9)} ${pad(b.inputTokens, 10)} | ${pad(a.chars, 10)} ${pad(a.variableChars, 9)} ${pad(a.inputTokens, 10)}  ${(a.passages ?? []).join(" ")}`);
  }
  const line = (s) => `${s.label.padEnd(7)} calls ${s.calls}  input ${s.inputTokens.toLocaleString("en")} tokens (items ${s.itemInputTokens.toLocaleString("en")}), variable ${s.variableChars.toLocaleString("en")} chars — charge $${s.cold.toFixed(4)} without caching, $${s.warm.toFixed(4)} with the prompt cache (provider $${s.provCold.toFixed(4)} / $${s.provWarm.toFixed(4)})`;
  console.log(`\nTOTAL\n  ${line(S.before)}\n  ${line(S.after)}`);
  const d = (a, b) => `${(100 * (1 - a / b)).toFixed(1)} %`;
  console.log(`\nMEASURED: input tokens −${d(S.after.inputTokens, S.before.inputTokens)} overall, −${d(S.after.itemInputTokens, S.before.itemInputTokens)} on the item calls; charge −${d(S.after.cold, S.before.cold)} uncached, −${d(S.after.warm, S.before.warm)} with the prompt cache (same assumed output in both).\n`);
}
