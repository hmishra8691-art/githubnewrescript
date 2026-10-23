/**
 * AI CONTEXT BENCHMARK — the same long-brief staged generation assembled three ways:
 *
 *   BEFORE   the whole brief in every item call, every guide the brief names (before 2026-10-18)
 *   CONTEXT  the structured research context + each item's brief passages instead of the brief, every guide the
 *            brief names (docs/CONTEXT-COST-REGISTRY-2026-10-18.md §3)
 *   ITEMS    CONTEXT + per-item guide selection (engine weakness #11, docs/ENGINE-11-14-2026-10-22.md): each item
 *            gets the build's core guides (one cached block) plus what the item itself needs
 *
 *   node --experimental-strip-types --no-warnings scripts/ai-context-benchmark.mjs [--json]
 *
 * Reproducible: the ~24k-character brief fixture (apps/studio/lib/copilot/fixtures/masterPromptBrief.mjs), a fixed
 * 12-item plan (design, 10 sections, logic and analysis — the shape the plan prompt asks for), an empty survey.
 * Every stage's prompt is built with the Studio's own builders exactly as the copilot route assembles it
 * (copilotUserPrompt, executeItemPrompt, copilotCall, deriveResearchContext / briefLayerOptions / itemPassagesFor,
 * itemGuideSelection / flagsOf / guideTexts), and SENT through the fake provider (AI_API_URL=fake:) inside
 * collectUsage — the fake reports input tokens deterministically from the characters (ceil(chars / 4) + 60).
 *
 * THE PROMPT CACHE is simulated block by block, the way Anthropic's works: every system block is a cache breakpoint
 * (≤ 4), a call reads the longest prefix of whole blocks that an earlier call wrote within the TTL (5 minutes,
 * refreshed on every read) and writes the rest of its system blocks; the user text is never cached. Calls are
 * placed on a clock (the plan call 40 s, each item 50 s — a 3,000-token answer). Block tokens are ceil(chars / 4).
 *
 * Priced with the billing package's priceSpec and default rate table at claude-sonnet-4-6 ($3 / M input, $15 / M
 * output, cache read 10 %, cache write 125 %). Output tokens are NOT measured (the fake answers {}): every run is
 * priced with the same assumed output per call, so the differences are input alone.
 */
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

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
const { aiInterviewIntent } = await imp("lib/copilot/aiInterviewGuide.ts");
const { integrationsIntent } = await imp("lib/copilot/integrationsGuide.ts");
const G = await imp("lib/copilot/guideSelect.ts");
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
const CLOCK = { plan: 40_000, item: 50_000 };
const TTL_MS = 5 * 60_000;
const MODEL = "claude-sonnet-4-6";

/* the route's options for a generation from this brief (mode generate; the guides the brief names) */
const mode = "generate";
const base = {
  message: brief, outline: copilotOutline(def, { analysis: true }), surveyLanguage: P.surveyLanguageOf(def), mode,
  analysis: true, translation: P.translationIntent(brief), quota: P.quotaIntent(brief), listFill: listFillIntent(brief), methods: methodsIntent(brief), findings: P.findingsIntent(brief),
};
/* what the route calls buildGuides — every guide the turn (the brief) would send */
const buildGuides = { ux: false, analysis: true, translation: base.translation, quota: base.quota, listFill: base.listFill, methods: base.methods, findings: base.findings, researchPlan: researchPlanIntent(brief, mode), qual: qualIntent(brief), aiInterview: aiInterviewIntent(brief), integrations: integrationsIntent(brief), reporting: P.reportingIntent(brief), qualSynthesis: false };

const tok = (chars) => Math.ceil(chars / 4);
const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function send(stage, userText, extra = [], opts = {}) {
  const [system, user] = copilotCall(userText, extra, opts);
  const { usage } = await collectUsage(() => completeJson(system, user, OUT.item, { operation: stage }));
  const t = sumUsage(usage);
  const stable = system.reduce((n, b) => n + b.length, 0) + Math.max(0, system.length - 1) * 2;
  /* the cumulative prefix at each block boundary: its identity and its tokens */
  const prefixes = [];
  let acc = "", accTok = 0;
  for (const b of system) { acc += `\u0000${b}`; accTok += tok(b.length); prefixes.push({ key: h(acc), tokens: accTok }); }
  return { stage, chars: stable + user.length, stableChars: stable, variableChars: user.length, inputTokens: t.inputTokens, requests: t.requests, blocks: system.map((b) => b.length), prefixes };
}

async function run(kind) {
  const rows = [];
  const planText = P.copilotUserPrompt({ ...base, planOnly: true, longBrief: true }) + planStagePrompt({ longBrief: true });
  rows.push(await send("plan", planText));
  /* CONTEXT / ITEMS: the plan stage leaves the research context behind — derived, not asked of a model */
  const ctx = kind !== "before" ? RC.deriveResearchContext({ brief, plan, def }) : null;
  const layers = ctx ? RC.briefLayerOptions(ctx) : null;
  const briefSections = RC.sectionBrief(brief);
  const layerOpts = layers ? { ...layers, researchPlan: researchPlanIntent(brief, mode), qual: qualIntent(brief), reporting: P.reportingIntent(brief) } : {};
  const prompt = P.copilotUserPrompt({ ...base, ...layerOpts });
  const done = [];
  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i];
    const passages = ctx ? RC.itemPassagesFor(briefSections, item) : { text: "", ids: [] };
    let text, opts = {}, guides;
    if (kind === "items") {
      const sel = G.itemGuideSelection({ item, build: buildGuides, mode, passages: passages.text });
      text = P.copilotUserPrompt({ ...base, ...layerOpts, ...G.flagsOf(sel.all) }) + passages.text + executeItemPrompt(plan, item, i, plan.items, done);
      opts = { core: G.guideTexts(sel.core) };
      guides = sel.all;
    } else {
      text = prompt + passages.text + executeItemPrompt(plan, item, i, plan.items, done);
      guides = G.guidesOf(buildGuides);
    }
    const row = await send(`item ${item.id}`, text, layers ? [layers.researchContext] : [], opts);
    rows.push({ ...row, passages: passages.ids, guides, guideChars: guides.reduce((n, g) => n + G.GUIDE_TEXT[g].length, 0) });
    done.push(`${item.title} (Q${i * 8 + 1}–Q${i * 8 + 8})`);
  }
  return { rows, contextChars: layers?.researchContext.length ?? 0 };
}

/* ---------------------------------------------------------------- the prompt cache, simulated */
function simulateCache(rows) {
  const cache = new Map(); // prefix key → expires at
  let t = 0;
  return rows.map((r) => {
    const n = r.prefixes.length;
    let hit = -1;
    for (let i = n - 1; i >= 0; i--) { const exp = cache.get(r.prefixes[i].key); if (exp != null && exp >= t) { hit = i; break; } }
    const read = hit >= 0 ? r.prefixes[hit].tokens : 0;
    const write = n ? r.prefixes[n - 1].tokens - read : 0;
    /* every breakpoint is written (or refreshed) by this call */
    for (const p of r.prefixes) cache.set(p.key, t + TTL_MS);
    const at = t;
    t += r.stage === "plan" ? CLOCK.plan : CLOCK.item;
    return { ...r, at, cacheRead: Math.min(read, r.inputTokens), cacheWrite: Math.min(write, Math.max(0, r.inputTokens - read)) };
  });
}

const cfg = billingConfig({});
const price = (input, output, read = 0, write = 0) => priceSpec({ eventType: "AI_REQUEST", provider: "openai-compatible", service: "chat", model: MODEL, inputUnits: input, outputUnits: output, cacheReadUnits: read, cacheWriteUnits: write }, "LIVE", cfg, DEFAULT_RATES, DEFAULT_BILLABLE_EVENTS).breakdown;
function cost(rows) {
  let cold = 0, warm = 0, provCold = 0, provWarm = 0;
  for (const r of rows) {
    const out = r.stage === "plan" ? OUT.plan : OUT.item;
    const c = price(r.inputTokens, out);
    const w = price(r.inputTokens, out, r.cacheRead, r.cacheWrite);
    cold += c.customerCharge; warm += w.customerCharge; provCold += c.providerCost; provWarm += w.providerCost;
  }
  return { cold, warm, provCold, provWarm };
}
const total = (rows, k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
function summary(label, r) {
  const rows = simulateCache(r.rows);
  const items = rows.slice(1);
  return {
    label, calls: rows.length, chars: total(rows, "chars"), itemChars: total(items, "chars"), variableChars: total(rows, "variableChars"), stableChars: total(rows, "stableChars"),
    guideCharsPerItem: Math.round(total(items, "guideChars") / items.length),
    inputTokens: total(rows, "inputTokens"), itemInputTokens: total(items, "inputTokens"),
    cacheRead: total(rows, "cacheRead"), cacheWrite: total(rows, "cacheWrite"),
    callsReading: rows.filter((x) => x.cacheRead > 0).length, itemsReading: items.filter((x) => x.cacheRead > 0).length,
    /* of the input of the item calls, the share read from the cache */
    itemCacheShare: total(items, "cacheRead") / Math.max(1, total(items, "inputTokens")),
    ...cost(rows), rows,
  };
}

const R = { before: await run("before"), context: await run("context"), items: await run("items") };
const S = { before: summary("before", R.before), context: summary("context", R.context), items: summary("items", R.items) };

if (JSON_OUT) {
  const strip = (s) => ({ ...s, rows: s.rows.map(({ prefixes, ...x }) => x) });
  console.log(JSON.stringify({ briefChars: brief.length, contextChars: R.context.contextChars, model: MODEL, assumedOutput: OUT, clock: CLOCK, ttlMs: TTL_MS, totals: { before: strip(S.before), context: strip(S.context), items: strip(S.items) } }, null, 2));
} else {
  const pad = (s, n) => String(s).padStart(n);
  const k = (n) => `${(n / 1000).toFixed(1)}k`;
  console.log(`\nAI CONTEXT BENCHMARK — brief ${brief.length.toLocaleString("en")} characters, ${plan.items.length}-item plan, empty survey; research context ${R.context.contextChars.toLocaleString("en")} characters`);
  console.log(`(input tokens as the fake provider reports them: ceil(chars/4) + 60; priced at ${MODEL}, default rates and margin; output assumed ${OUT.plan} plan / ${OUT.item} per item in EVERY run; prompt cache simulated per system block, TTL 5 min, plan ${CLOCK.plan / 1000} s, item ${CLOCK.item / 1000} s)\n`);
  console.log("stage     | BEFORE chars  in tok  read  write | CONTEXT chars  in tok  read  write | ITEMS chars  in tok  read  write  guides (chars)");
  for (let i = 0; i < S.before.rows.length; i++) {
    const b = S.before.rows[i], c = S.context.rows[i], a = S.items.rows[i];
    const g = a.guides ? `${a.guides.join(",")} (${k(a.guideChars)})` : "—";
    console.log(`${b.stage.padEnd(9)} | ${pad(b.chars, 12)} ${pad(b.inputTokens, 7)} ${pad(b.cacheRead, 5)} ${pad(b.cacheWrite, 6)} | ${pad(c.chars, 13)} ${pad(c.inputTokens, 7)} ${pad(c.cacheRead, 5)} ${pad(c.cacheWrite, 6)} | ${pad(a.chars, 11)} ${pad(a.inputTokens, 7)} ${pad(a.cacheRead, 5)} ${pad(a.cacheWrite, 6)}  ${g}`);
  }
  const line = (s) => `${s.label.padEnd(8)} chars ${s.chars.toLocaleString("en")} (items ${s.itemChars.toLocaleString("en")}; guides ${s.guideCharsPerItem.toLocaleString("en")}/item) · input ${s.inputTokens.toLocaleString("en")} tok (items ${s.itemInputTokens.toLocaleString("en")}) · cache read ${s.cacheRead.toLocaleString("en")} / write ${s.cacheWrite.toLocaleString("en")} tok, ${s.callsReading}/${s.calls} calls read (${s.itemsReading}/12 items; ${(100 * s.itemCacheShare).toFixed(1)} % of item input read) · charge $${s.cold.toFixed(4)} uncached, $${s.warm.toFixed(4)} cached (provider $${s.provCold.toFixed(4)} / $${s.provWarm.toFixed(4)})`;
  console.log(`\nTOTAL\n  ${line(S.before)}\n  ${line(S.context)}\n  ${line(S.items)}`);
  const d = (a, b) => `${(100 * (1 - a / b)).toFixed(1)} %`;
  console.log(`\nMEASURED, per-item guides (ITEMS) against CONTEXT: characters sent −${d(S.items.chars, S.context.chars)} (item calls −${d(S.items.itemChars, S.context.itemChars)}); input tokens −${d(S.items.inputTokens, S.context.inputTokens)}; guides per item ${S.context.guideCharsPerItem.toLocaleString("en")} → ${S.items.guideCharsPerItem.toLocaleString("en")} characters; cache: ${S.context.itemsReading}/12 → ${S.items.itemsReading}/12 item calls read, writes ${S.context.cacheWrite.toLocaleString("en")} → ${S.items.cacheWrite.toLocaleString("en")} tokens; charge −${d(S.items.cold, S.context.cold)} uncached, −${d(S.items.warm, S.context.warm)} with the prompt cache.`);
  console.log(`MEASURED, ITEMS against BEFORE: input tokens −${d(S.items.inputTokens, S.before.inputTokens)}; charge −${d(S.items.cold, S.before.cold)} uncached, −${d(S.items.warm, S.before.warm)} cached (same assumed output in every run).\n`);
}
