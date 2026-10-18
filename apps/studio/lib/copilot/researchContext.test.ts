import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions } from "@rescript/engine";
import { BRIEF_HYPOTHESES, MASTER_PROMPT_BRIEF } from "./fixtures/masterPromptBrief.mjs";
import { copilotUserPrompt, normalizeBrief, surveyLanguageOf } from "./prompt.ts";
import { executeItemPrompt, type ChangePlan } from "./changePlan.ts";
import { copilotOutline } from "./outline.ts";
import { copilotCall } from "../aiPromptCache.ts";
import { capabilityStatusReport } from "../capabilityStatus.ts";
import {
  addCalls, briefHypotheses, briefLayerOptions, contextLayersFor, contextOwner, deriveResearchContext, itemPassagesFor, MemoryResearchContextStore,
  questionnaireScope, reconcileContext, renderResearchContext, retrieveBriefPassages, sectionBrief, workflowIdFor, type StoredResearchContext,
} from "./researchContext.ts";

/*
 * §3 (2026-10-18) — a long brief is read once: the plan stage leaves a structured research context (lines
 * copied verbatim), the staged item calls get it plus their own exact passages instead of the whole brief,
 * the survey definition stays authoritative, and one survey's context never reaches another.
 */

const BRIEF = normalizeBrief(MASTER_PROMPT_BRIEF);
const PLAN: ChangePlan = {
  summary: "A global B2B survey of research professionals from the brief",
  items: [
    { id: "p1", title: "Write the research design with objectives and hypotheses H1–H8", kind: "design", objects: ["Research design"], reason: "every hypothesis must be measurable" },
    { id: "p2", title: "Add the screening and firmographics block with the regional quotas", kind: "create", objects: ["Screener"], reason: "qualify respondents; regional minimum completes" },
    { id: "p3", title: "Add the technology stack block", kind: "create", objects: ["Technology stack"], reason: "map the tools used at each stage" },
    { id: "p4", title: "Add the buying process block with the MaxDiff of 12 criteria and Van Westendorp", kind: "create", objects: ["Pricing"], reason: "rank decision criteria; price sensitivity" },
    { id: "p5", title: "Propose the analysis plan", kind: "analysis", objects: ["Analysis plan"], reason: "hypothesis tests per the brief" },
  ],
  questions: [], assumptions: ["The competitor list will be supplied later; a placeholder exclusion question is used"],
};
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Industry survey" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
let n = 0;
const ids = (p: string) => `${p}_${++n}`;

test("the context keeps the brief's exact wording: every hypothesis verbatim, the quota numbers, the method's numbers — and every line is copied, not paraphrased", () => {
  const ctx = deriveResearchContext({ brief: BRIEF, plan: PLAN, def: empty() });
  assert.equal(ctx.hypotheses.length, BRIEF_HYPOTHESES);
  assert.equal(ctx.hypothesesSource, "brief");
  for (const h of ctx.hypotheses) assert.ok(BRIEF.includes(h.text), `${h.id} verbatim: ${h.text}`);
  assert.match(ctx.hypotheses[6].text, /under 50 employees/);
  const text = renderResearchContext(ctx);
  for (const exact of ["| South Asia (incl. India) | 110 |", "| Greater China | 80 | Simplified Chinese version required |", "25–30 minutes", "9 screens of 4 items", "at least 30% director level or above", "agencies 50%, client-side 30%, others 20%", "under 40% of the median length of interview", "no more than 8 rows per grid", "chi-square for H1, H3, H4 and H6"]) assert.ok(text.includes(exact), `kept: ${exact}`);
  // verbatim: every bullet line of the rendering is a substring of the brief (or of the plan, for progress)
  const bullets = text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  assert.ok(bullets.length > 40);
  for (const b of bullets) assert.ok(b.split(" — ").every((part) => BRIEF.includes(part)), `not in the brief: ${b}`); // a section line is its heading — its purpose, both verbatim
  // the brief's questionnaire structure, in order, and the plan's progress and assumption
  const q = ctx.questionnaire.filter((l) => /^8\.\d+ /.test(l)).map((l) => l.split(" ")[0]);
  assert.deepEqual(q, ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6", "8.7", "8.8", "8.9", "8.10"]);
  assert.equal(ctx.progress.pending.length, 5);
  assert.match(ctx.progress.unresolved[0], /^assumed: The competitor list/);
  assert.ok(text.length < BRIEF.length * 0.5, `context ${text.length} vs brief ${BRIEF.length}`);
  assert.ok(ctx.sections.length >= 18, "the brief's index");
});

test("hypothesis forms: H1. / H2: / Hypothesis 3 —, or the lines of a hypotheses section", () => {
  assert.deepEqual(briefHypotheses("Intro\n\nH1: Price drives churn among students.\nHypothesis 2 — Ads raise awareness by 10 points.").map((h) => `${h.id} ${h.text}`), ["H1 Price drives churn among students.", "H2 Ads raise awareness by 10 points."]);
  assert.deepEqual(briefHypotheses("Hypotheses\n\n- Younger buyers switch more often than older ones\n- Loyalty falls with price").map((h) => h.id), ["H1", "H2"]);
});

test("item calls use the context and their own passages, not the brief: smaller, the context in a cached block, the exact passages they need", () => {
  const def = empty();
  const ctx = deriveResearchContext({ brief: BRIEF, plan: PLAN, def });
  const base = { message: BRIEF, outline: copilotOutline(def, {}), surveyLanguage: surveyLanguageOf(def), mode: "generate" as const, analysis: true };
  const legacy = copilotUserPrompt(base);
  const layered = copilotUserPrompt({ ...base, ...briefLayerOptions(ctx) });
  assert.ok(legacy.includes(BRIEF), "before: the whole brief in every item");
  assert.ok(!layered.includes(BRIEF.slice(2000, 2600)) && !layered.includes("Example Wording (style reference only)\n\n"), "after: not the brief");
  assert.match(layered, /RESEARCHER:\nBuild the survey from my research brief \(the brief: 23,\d{3} characters, stored as ref [0-9a-f]{12}/);
  const sections = sectionBrief(BRIEF);
  const quotas = itemPassagesFor(sections, PLAN.items[1]);
  assert.ok(quotas.text.includes("| North America | 160 | English master questionnaire |"), "the screener item gets the quota table verbatim");
  const design = itemPassagesFor(sections, PLAN.items[0]);
  assert.ok(design.ids.includes("s5"), `the design item gets the hypotheses section: ${design.ids}`);
  const item = layered + quotas.text + executeItemPrompt(PLAN, PLAN.items[1], 1, PLAN.items, []);
  const old = legacy + executeItemPrompt(PLAN, PLAN.items[1], 1, PLAN.items, []);
  const [sysNew, varNew] = copilotCall(item, [ctx && renderResearchContext(ctx)]);
  const [, varOld] = copilotCall(old);
  assert.equal(sysNew.length, 3, "system prompt, guides, research context");
  assert.ok(sysNew[2].startsWith("RESEARCH CONTEXT v1"), "the context is a cached block");
  assert.ok(!varNew.includes("RESEARCH CONTEXT v1"), "and not in the variable text");
  assert.ok(varNew.length < varOld.length * 0.4, `variable text ${varNew.length} vs ${varOld.length}`);
  assert.ok(item.length < old.length, `whole call ${item.length} vs ${old.length}`);
});

test("retrieval returns the exact passage — verbatim, best first — by keyword, section and hypothesis id", () => {
  const sections = sectionBrief(BRIEF);
  const q = retrieveBriefPassages(sections, "regional quotas minimum completes South Asia");
  assert.ok(q.length >= 1);
  assert.ok(BRIEF.includes(q[0].text), "verbatim");
  assert.match(q[0].text, /\| South Asia \(incl\. India\) \| 110 \|/);
  const h = retrieveBriefPassages(sections, "measure H5 platform satisfaction drivers");
  assert.match(h[0].text, /H5\. Satisfaction with the primary survey platform is driven more by logic flexibility and support than by price\./);
  const d = retrieveBriefPassages(sections, "definition of person-hours and elapsed days");
  assert.ok(d.some((p) => p.text.includes("| Person-hours | the total working hours of everyone involved in a stage")), "a definitions table row");
  assert.deepEqual(retrieveBriefPassages(sections, "zzz qqq"), []);
});

test("invalidation: the first design is adopted; a later change to a hypothesis makes the context stale (not sent); regenerated on demand with the design's wording", () => {
  const ctx = deriveResearchContext({ brief: BRIEF, plan: PLAN, def: empty() });
  assert.equal(ctx.fingerprint.designEmpty, true);
  const built = applySurveyActions(empty(), [{ op: "set_research", objective: "Quantify the workflow", hypotheses: ["Agencies with 3+ tools report more delays", "Programming takes more hours than writing"] }], { ids }).def;
  const adopted = reconcileContext(ctx, built);
  assert.equal(adopted.invalidated, false);
  assert.equal(adopted.context.status, "fresh");
  assert.equal(adopted.context.hypothesesSource, "design");
  assert.equal(adopted.context.hypotheses[0].text, "Agencies with 3+ tools report more delays");
  assert.deepEqual(reconcileContext(adopted.context, built), { context: adopted.context, changed: false, invalidated: false }, "unchanged design: nothing to do");
  const edited = structuredClone(built);
  edited.research!.hypotheses[1] = "Programming takes FEWER hours than writing";
  const stale = reconcileContext(adopted.context, edited);
  assert.equal(stale.invalidated, true);
  assert.equal(stale.context.status, "stale");
  assert.match(stale.context.staleReason!, /research design/);
  assert.deepEqual(contextLayersFor({ mode: "generate", stage: "execute", hasContext: true, stale: true }), { researchContext: "none" }, "a stale context is not sent");
  const regen = deriveResearchContext({ brief: BRIEF, plan: PLAN, def: edited, previous: stale.context });
  assert.equal(regen.version, 2);
  assert.equal(regen.status, "fresh");
  assert.equal(regen.hypotheses[1].text, "Programming takes FEWER hours than writing", "the survey definition is authoritative");
  assert.equal(reconcileContext(regen, edited).invalidated, false);
});

test("no cross-survey or cross-organisation leakage: the store is keyed by survey AND owner; workflow ids differ per survey", async () => {
  const store = new MemoryResearchContextStore(new Map<string, StoredResearchContext>());
  const ctx = deriveResearchContext({ brief: BRIEF });
  const a = contextOwner({ customerId: "cust-a", userId: "u1" });
  assert.equal(a, "org:cust-a");
  assert.equal(contextOwner({ userId: "u1" }), "user:u1");
  await store.put({ surveyId: "survey-A", owner: a, context: ctx, brief: BRIEF });
  assert.ok(await store.get("survey-A", a));
  assert.equal(await store.get("survey-B", a), null, "another survey of the same organisation");
  assert.equal(await store.get("survey-A", "org:cust-b"), null, "the same survey id under another organisation");
  assert.equal(await store.get("survey-A", "user:u1"), null, "the person outside their organisation's key");
  const got = await store.get("survey-A", a);
  got!.context.hypotheses[0].text = "mutated";
  assert.notEqual((await store.get("survey-A", a))!.context.hypotheses[0].text, "mutated", "a copy, not the stored object");
  assert.notEqual(workflowIdFor("survey-A", a, BRIEF), workflowIdFor("survey-B", a, BRIEF));
  assert.equal(workflowIdFor("survey-A", a, BRIEF), workflowIdFor("survey-A", a, `${BRIEF}\n`), "the plan and every stage of its build share one id");
});

test("task-aware selection: a theme change sends no questionnaire; a logic change the named questions and their dependencies; an edit the compact context", () => {
  const actions: Record<string, unknown>[] = [{ op: "create_block", title: "Main" }];
  for (let i = 1; i <= 40; i++) actions.push({ op: "create_question", ref: `V${i}`, type: "single", text: `Question number ${i} about things`, options: ["Yes", "No"] });
  actions.push({ op: "set_display_logic", target: "V20", expression: "V3 = 1" }, { op: "set_display_logic", target: "V31", expression: "V20 = 1" });
  const def = applySurveyActions(empty(), actions as never, { ids }).def;
  const id = (v: string) => def.questions.find((q) => q.variableName === v)!.id;
  assert.equal(questionnaireScope({ message: "Make the theme navy and white with a rounded font", mode: "ux", uxOnly: true, focusCount: 0, questionCount: 40 }), "none");
  assert.equal(questionnaireScope({ message: "anything", mode: "ux", themeOnly: true, focusCount: 0, questionCount: 40 }), "none");
  assert.equal(questionnaireScope({ message: "Animate the options of V5", mode: "ux", uxOnly: true, focusCount: 1, questionCount: 40 }), "full", "a look change on a question needs the question");
  assert.equal(questionnaireScope({ message: "Show V20 only if V3 = 2", mode: "edit", focusCount: 2, questionCount: 40 }), "focused");
  assert.equal(questionnaireScope({ message: "Reword V20", mode: "edit", focusCount: 1, questionCount: 40 }), "full");
  const none = copilotOutline(def, { ux: true, questionnaire: "none" });
  assert.doesNotMatch(none, /Question number/);
  assert.match(none, /\(40 questions\) — the questionnaire is not listed/);
  assert.match(none, /^Theme: /m);
  const focused = copilotOutline(def, { focusIds: [id("V20")], questionnaire: "focused" });
  const full = copilotOutline(def, { focusIds: [id("V20")] });
  for (const dep of ["V3", "V31"]) assert.match(focused, new RegExp(`\\(${dep}\\) · single select · "Question number`), `${dep} (a dependency) in full`);
  assert.doesNotMatch(focused, /\(V12\) · single/, "an unrelated question is by code only");
  assert.match(focused, /Other questions \(by code\): .*V12|Other questions \(by code\): .*Q12/);
  assert.ok(focused.length < full.length * 0.6, `focused ${focused.length} vs full ${full.length}`);
  assert.deepEqual(contextLayersFor({ mode: "edit", hasContext: true, stale: false }), { researchContext: "compact" });
  assert.deepEqual(contextLayersFor({ mode: "ux", uxOnly: true, hasContext: true, stale: false }), { researchContext: "none" });
  const compact = renderResearchContext(deriveResearchContext({ brief: BRIEF }), { compact: true });
  assert.ok(compact.length < 4500 && /Constraints and mandatory requirements/.test(compact) && !/Hypotheses \(exact/.test(compact), `compact ${compact.length}`);
});

test("measurement: a workflow's calls are summed per operation, completed once the build finishes", () => {
  const c = (operation: string, inputTokens: number, charge: number) => ({ operation, promptChars: inputTokens * 4, inputTokens, outputTokens: 100, cachedInputTokens: 50, requests: 1, retries: 1, latencyMs: 1000, charge });
  let t = addCalls(null, "wf_1", [c("copilot_plan", 9000, 0.05)], { now: "t0" });
  t = addCalls(t, "wf_1", [c("copilot_generate_item", 6000, 0.03), c("copilot_generate_item", 6000, 0.03)]);
  t = addCalls(t, "wf_1", [c("copilot_generate_coverage", 7000, 0.04)], { completed: true });
  assert.equal(t.calls, 4);
  assert.equal(t.inputTokens, 28000);
  assert.equal(t.retries, 4);
  assert.equal(t.charge, 0.15);
  assert.deepEqual(t.byOperation.copilot_item, { calls: 2, promptChars: 48000, inputTokens: 12000, charge: 0.06 });
  assert.equal(t.completed, true);
  assert.equal(addCalls(t, "wf_2", []).calls, 0, "another workflow starts its own totals");
});

test("registry readiness from the server environment, for an administrator: critical gaps are warnings naming variables, never values", () => {
  const none = capabilityStatusReport({});
  assert.ok(none.warnings.some((w) => /^Language model is not configured \(AI_API_URL\)/.test(w)));
  assert.ok(none.warnings.some((w) => /^Speech-to-text provider is not configured \(AI_STT_API_URL\)/.test(w)));
  assert.ok(none.warnings.some((w) => /^Translation provider is not configured \(GOOGLE_TRANSLATE_API_KEY or AI_API_URL\)/.test(w)));
  assert.ok(none.warnings.some((w) => /^Media storage is not configured \(R2_BUCKET or SUPABASE_URL\)/.test(w)));
  const env = { AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "sk-ant-very-secret", SUPABASE_URL: "https://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-very-secret" };
  const r = capabilityStatusReport(env);
  assert.deepEqual(r.warnings.map((w) => w.split(" is not")[0]), ["Speech-to-text provider"], "Anthropic: no speech API — the one gap");
  assert.match(r.warnings[0], /Anthropic endpoint, which has no speech-to-text API/);
  assert.equal(r.capabilities.find((c) => c.id === "platform:recorded_transcription")!.ready, false);
  assert.equal(r.capabilities.find((c) => c.id === "platform:intelligent_mode")!.ready, true);
  const blob = JSON.stringify(r);
  for (const v of ["sk-ant-very-secret", "service-very-secret", "abc.supabase.co"]) assert.ok(!blob.includes(v), `leaked ${v}`);
});

test("measurement: cache writes are summed too, and totals kept before the field existed still add up (2026-10-18)", () => {
  const c = (w?: number) => ({ operation: "copilot_question", promptChars: 400, inputTokens: 9000, outputTokens: 100, cachedInputTokens: 4000, ...(w === undefined ? {} : { cacheWriteTokens: w }), requests: 1, retries: 0, latencyMs: 10, charge: 0.01 });
  const t = addCalls(null, "wf_w", [c(4171), c(0), c()]);
  assert.equal(t.cacheWriteTokens, 4171); assert.equal(t.cachedInputTokens, 12000);
  const old = { ...t, cacheWriteTokens: undefined };
  assert.equal(addCalls(old, "wf_w", [c(10)]).cacheWriteTokens, 10, "an older stored total without the field");
});

test("the turn route's per-call measure carries the cache write next to the cache read", () => {
  const src = readFileSync(new URL("../../app/api/copilot/turn/route.ts", import.meta.url), "utf8");
  assert.match(src, /cacheWriteTokens: Number\(md\.tokens\?\.cacheWrite \?\? 0\)/);
  assert.match(src, /cachedInputTokens: c\.cachedInputTokens, cacheWriteTokens: c\.cacheWriteTokens \?\? 0/);
});
