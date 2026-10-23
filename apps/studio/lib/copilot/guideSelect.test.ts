import test from "node:test";
import assert from "node:assert/strict";
import { COPILOT_ANALYSIS_GUIDE, COPILOT_QUOTA_GUIDE, COPILOT_SYSTEM_PROMPT, copilotUserPrompt, repairPrompt } from "./prompt.ts";
import { COPILOT_METHODS_GUIDE as COPILOT_METHODS_GUIDE_TEXT_FOR_TEST } from "./methodsGuide.ts";
import { GUIDE_ORDER, GUIDE_TEXT, coreGuides, flagsOf, guideForOp, guideMisses, guideTexts, guidesOf, itemGuideSelection, itemGuidesEnabled, ownPassage, type GuideFlags } from "./guideSelect.ts";
import { copilotCall } from "../aiPromptCache.ts";
import type { ChangePlanItem } from "./changePlan.ts";

/*
 * ENGINE WEAKNESS #11 (2026-10-22): per-item guide selection in a staged build. Each item gets the build's core
 * guides (one cached block) and what the item needs; the same set is the same bytes; an action whose guide was not
 * sent is a miss the route logs and repairs with the guide.
 */
const build: GuideFlags = { analysis: true, translation: true, quota: true, listFill: true, methods: true, findings: true, researchPlan: true, qual: true, reporting: true };
const item = (id: string, title: string, kind: ChangePlanItem["kind"] = "create", extra: Partial<ChangePlanItem> = {}): ChangePlanItem => ({ id, title, kind, objects: [], reason: "", ...extra });
const sel = (it: ChangePlanItem, passages = "") => itemGuideSelection({ item: it, build, mode: "generate", passages });

test("#11 a screener gets the question vocabulary (system prompt), the analysis core and the quota guide — not MaxDiff, qualitative, reporting or UX", () => {
  const s = sel(item("p2", "Add the screener with the regional quotas", "create", { objects: ["Screener"] }));
  assert.deepEqual(s.core, ["analysis"]);
  assert.ok(s.all.includes("quota"));
  for (const g of ["methods", "qual", "reporting", "ux", "translation", "findings", "listFill"] as const) assert.equal(s.all.includes(g), false, `${g} is not for a screener`);
  assert.equal(s.fallback, false);
});

test("#11 the design item gets the research guide; a MaxDiff item the methods guide; a List Fill item the List Fill guide; a closing block only the core", () => {
  assert.ok(sel(item("p1", "Write the research design: objectives and hypotheses", "design")).all.includes("research"));
  const md = sel(item("p3", "Add the MaxDiff of eight phone features"));
  assert.ok(md.all.includes("methods") && !md.all.includes("research") && !md.all.includes("quota"));
  assert.ok(sel(item("p4", "Add Q9 as a list fill of the brands selected in Q8, 4 at random")).all.includes("listFill"));
  assert.deepEqual(sel(item("p9", "Add the closing questions")).all, ["analysis"]);
  /* a reason that says WHY ("to test H2") does not make a question block a research-design item */
  assert.equal(sel(item("p5", "Add the trust block", "create", { reason: "measures H2 and the trust construct" })).all.includes("research"), false);
});

test("#11 the item's OWN brief section counts, the context passages after it (objectives naming every method) do not", () => {
  const own = "[§8.9 Buying process]\nInclude a MaxDiff of the 10 decision criteria.\n\n[§1 Objectives]\nUse quotas by region.";
  assert.equal(ownPassage(own), "Include a MaxDiff of the 10 decision criteria.");
  const s = sel(item("p10", "Add the Buying process block"), `\n\nBRIEF PASSAGES (verbatim …):\n${own}`);
  assert.ok(s.all.includes("methods"), "its own section asks for a MaxDiff");
  assert.equal(s.all.includes("quota"), false, "the objectives' quota line is another section's");
});

test("#11 an item nothing can be read from gets the build's whole set (never less than before); findings and reporting only for an output item", () => {
  const f = sel(item("p7", "Finish it", "other"));
  assert.equal(f.fallback, true);
  assert.deepEqual(f.all, guidesOf(build));
  assert.equal(sel(item("p6", "Add the analysis and reporting block")).all.includes("reporting"), false, "a block of questions ABOUT reporting is not a report");
  assert.ok(sel(item("p12", "Draft the findings report", "analysis")).all.includes("reporting"));
});

test("#11 the same set is the same bytes; the core block is identical across items with different own guides; the order is fixed", () => {
  const base = { outline: "(empty)", surveyLanguage: "en", mode: "generate" as const, message: "a brief" };
  const a = sel(item("p3", "Add the Research portfolio block")), b = sel(item("p4", "Add the Technology stack block")), q = sel(item("p2", "Add the screener with quotas"));
  const call = (s: ReturnType<typeof sel>) => copilotCall(copilotUserPrompt({ ...base, researchContext: "RESEARCH CONTEXT …", ...flagsOf(s.all) }), ["RESEARCH CONTEXT …"], { core: guideTexts(s.core) });
  const [sa] = call(a), [sb] = call(b), [sq] = call(q);
  assert.deepEqual(sa, sb, "two items needing the same guides send the same system blocks (a cache read)");
  assert.equal(sa[0], COPILOT_SYSTEM_PROMPT);
  assert.equal(sa[1], "RESEARCH CONTEXT …", "the context block comes before the guides (the more stable first)");
  assert.equal(sa[2], COPILOT_ANALYSIS_GUIDE, "the core block");
  assert.equal(sq[2], sa[2], "the same core block for the screener");
  assert.equal(sq[3], COPILOT_QUOTA_GUIDE, "its own guide in the last block");
  for (const s of [a, b, q]) assert.deepEqual(s.all, GUIDE_ORDER.filter((g) => s.all.includes(g)), "fixed order");
  assert.ok(sq.length <= 4, "within Anthropic's four cache breakpoints");
});

test("#11 misses: an op whose guide was not sent; set_question_analysis and set_research are the system prompt's own", () => {
  assert.equal(guideForOp("create_maxdiff"), "methods");
  assert.equal(guideForOp("create_quota"), "quota");
  assert.equal(guideForOp("create_behavior"), "ux");
  assert.equal(guideForOp("create_question"), null);
  assert.deepEqual(guideMisses(["create_question", "create_maxdiff", "simulate_conjoint", "set_question_analysis", "set_research"], ["analysis"]), [{ guide: "methods", ops: ["create_maxdiff", "simulate_conjoint"] }]);
  assert.deepEqual(guideMisses(["set_question_analysis"], []), []);
  assert.deepEqual(guideMisses(["create_maxdiff"], ["methods"]), []);
});

test("#11 the repair carries the guide an item was not sent (once), and COPILOT_ITEM_GUIDES=off turns selection off", () => {
  const prompt = copilotUserPrompt({ outline: "(empty)", surveyLanguage: "en", mode: "generate", message: "x", analysis: true });
  const rp = repairPrompt({ prompt, raw: { actions: [{ op: "create_maxdiff" }] }, refused: ["Create a MaxDiff of 3 items: needs 4"], total: 1, uxGuideSent: false, methodsGuideSent: false, ops: ["create_maxdiff"], extraGuides: [GUIDE_TEXT.methods] });
  assert.equal(rp.text.split(COPILOT_METHODS_GUIDE_TEXT_FOR_TEST).length - 1, 1, "the methods guide once");
  const [sys] = copilotCall(rp.text);
  assert.ok(sys[1]!.includes(COPILOT_METHODS_GUIDE_TEXT_FOR_TEST), "lifted into the cached block");
  assert.equal(itemGuidesEnabled({}), true);
  assert.equal(itemGuidesEnabled({ COPILOT_ITEM_GUIDES: "off" }), false);
  assert.deepEqual(coreGuides({ ux: true, analysis: true }, "ux"), ["ux"]);
});

test("#11 on the 12-item benchmark plan every item is sent less than the brief's whole set, and nothing an item writes is left without its guide", () => {
  const items = [
    item("p1", "Write the research design: objectives, hypotheses H1–H8, constructs, population and quotas", "design"),
    ...["Screening and firmographics", "Research portfolio", "Technology stack", "Data quality", "Demographics and close"].map((s, i) => item(`p${i + 2}`, `Add the ${s} block`)),
    item("p12", "Add the stage loop, display logic and the analysis plan", "analysis"),
  ];
  const whole = guidesOf(build).reduce((n, g) => n + GUIDE_TEXT[g].length, 0);
  for (const it of items) {
    const s = sel(it);
    const chars = s.all.reduce((n, g) => n + GUIDE_TEXT[g].length, 0);
    assert.ok(chars < whole, `${it.id} is sent ${chars} of ${whole} characters`);
  }
  assert.ok(sel(items[0]!).all.includes("quota") && sel(items[0]!).all.includes("research"));
  assert.ok(sel(items[1]!).all.includes("quota"));
});

test("#11 drift: every guide the prompt can lift into the cache is known to the per-item selection (a new guide must be added there, or items would read it from the message)", async () => {
  const { COPILOT_STABLE_GUIDES } = await import("../aiPromptCache.ts");
  const known = new Set(Object.values(GUIDE_TEXT));
  for (const g of COPILOT_STABLE_GUIDES) assert.ok(known.has(g), `a cached guide not in guideSelect: ${g.slice(0, 60)}`);
  assert.equal(GUIDE_ORDER.length, COPILOT_STABLE_GUIDES.length);
  assert.deepEqual(GUIDE_ORDER.map((g) => GUIDE_TEXT[g]), [...COPILOT_STABLE_GUIDES], "the same order as the cached prefix");
});
