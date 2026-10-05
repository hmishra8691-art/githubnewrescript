import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions } from "@rescript/engine";
import { chunkResearchDocument, ResearchIndex } from "@rescript/import/research";
import { coerceCopilotReply, classifyRequest, copilotUserPrompt, referencedQuestions, surveyLanguageOf, uxIntent, analysisIntent, translationIntent, quotaIntent, findingsIntent, COPILOT_SYSTEM_PROMPT, COPILOT_UX_GUIDE, COPILOT_ANALYSIS_GUIDE, COPILOT_TRANSLATION_GUIDE, COPILOT_QUOTA_GUIDE, COPILOT_FINDINGS_GUIDE } from "./prompt.ts";
import { copilotOutline } from "./outline.ts";
import { coerceDocSummary, summaryInput, researchCards, researchPassages } from "./research.ts";

const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Skincare" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const survey = () => applySurveyActions(empty(), [
  { op: "create_block", title: "Screening" },
  { op: "create_question", ref: "BUY", type: "yes_no", text: "Bought skincare in the last 6 months?" },
  { op: "create_block", title: "Usage" },
  { op: "create_question", ref: "FREQ", type: "single", text: "How often do you buy?", options: ["Weekly", "Monthly", "Rarely"] },
  { op: "add_skip", from: "BUY", when: "BUY = No", to: "screen_out" },
  { op: "set_display_logic", target: "FREQ", expression: "BUY = Yes" },
  { op: "set_research", objective: "Understand premium skincare buying", hypotheses: ["Social exposure drives purchase"], constructs: [{ name: "Purchase", role: "dependent", questions: ["FREQ"] }, { name: "Exposure", role: "independent" }] },
], { ids }).def;

test("the model's reply is gated: actions through the engine's gate, everything else typed and bounded", () => {
  const r = coerceCopilotReply({
    kind: "proposal", reply: "I will add a trust question.",
    understanding: { objective: "Test influence", hypotheses: ["H1"], variables: [{ name: "Exposure", role: "independent" }, { name: "X", role: "wizard" }, { role: "dependent" }], analysis: ["regression"] },
    plan: [{ block: "Trust", purpose: "Measure trust", questions: 3 }, { purpose: "no block" }],
    actions: [{ op: "create_question", type: "rating", text: "Trust?", scale: { points: 5 } }, { op: "rm -rf" }],
    findings: [{ severity: "critical", questions: ["Q2"], message: "Exposure is not measured" }, { severity: "bogus", message: "x" }, { message: "" }],
    sources: [{ claim: "Trust mediates", support: "document", passages: ["dab1#4", "not a passage id"] }],
    memory: "Objective: influence on skincare.", extra: "ignored",
  })!;
  assert.equal(r.kind, "proposal");
  assert.equal(r.actions.length, 1);
  assert.deepEqual(r.rejected, [{ index: 1, reason: "unknown action “rm -rf”" }]);
  assert.deepEqual(r.understanding!.variables, [{ name: "Exposure", role: "independent" }, { name: "X", role: "descriptive" }]);
  assert.deepEqual(r.plan, [{ block: "Trust", purpose: "Measure trust", questions: 3 }]);
  assert.deepEqual(r.findings.map((f) => f.severity), ["critical", "suggestion"]);
  assert.deepEqual(r.sources[0].passages, ["dab1#4"]);
  assert.equal(r.memory, "Objective: influence on skincare.");
  assert.equal(coerceCopilotReply({}), null);
  assert.equal(coerceCopilotReply({ reply: "Q3 asks about frequency." })!.kind, "answer");
  assert.equal(coerceCopilotReply({ findings: [{ severity: "warning", message: "Q3 is leading" }] })!.kind, "review", "findings without actions are a review");
});

test("what a request needs: mode, and research only when it is about the research", () => {
  assert.deepEqual(classifyRequest("My hypothesis is that younger consumers buy premium skincare because of social media. Create a survey to test it.", 0, 0), { mode: "generate", research: false, ux: false, uxOnly: false });
  assert.deepEqual(classifyRequest("Change Q18 to a matrix question", 30, 3), { mode: "edit", research: false, ux: false, uxOnly: false }, "no papers for a type change");
  assert.deepEqual(classifyRequest("Based on the literature review, add three questions measuring trust", 30, 3), { mode: "edit", research: true, ux: false, uxOnly: false });
  assert.deepEqual(classifyRequest("Review my survey", 30, 0), { mode: "review", research: false, ux: false, uxOnly: false });
  assert.equal(classifyRequest("Mujhe ek customer satisfaction survey banana hai. Pehle screening karo", 0, 0).mode, "generate", "Hinglish");
  assert.equal(classifyRequest("I've uploaded three papers and a brief — create a survey based on them", 0, 4).research, true);
  assert.equal(classifyRequest("What does Q3 measure?", 12, 0).mode, "question");
});

test("the outline: blocks with their questions, the named questions' logic in full, the research design", () => {
  const def = survey();
  const o = copilotOutline(def, { focusIds: referencedQuestions(def, "why is FREQ hidden and what happens after Q1?") });
  assert.match(o, /Block contents: “Screening”: Q1; “Usage”: Q2/);
  assert.match(o, /Q1 details: skip when Q1 = 2 → screen out \(screened\)|Q1 details: skip when .*Q1.*→ screen out \(screened\)/);
  assert.match(o, /Q2 details: display logic: /);
  assert.match(o, /Research design: objective: Understand premium skincare buying · hypotheses: H1 Social exposure drives purchase · constructs: Purchase \(dependent: Q2\); Exposure \(independent, not measured\)/);
  assert.deepEqual(referencedQuestions(def, "make freq required"), [def.questions[1].id], "variables are matched case-insensitively");
  assert.equal(surveyLanguageOf(def), "en");
  // bounded: a large survey is listed by code beyond the first 60, but a named question is always in full
  const big = applySurveyActions(empty(), [{ op: "create_block", title: "Many" }, ...Array.from({ length: 200 }, (_, i) => ({ op: "create_question" as const, type: "text", text: `Question number ${i + 1}?` }))], { ids }).def;
  const ob = copilotOutline(big, { focusIds: referencedQuestions(big, "change Q180") });
  assert.ok(ob.includes('Q180 (Q180) · open text · "Question number 180?"'), "the named question in full");
  assert.ok(!ob.includes('"Question number 120?"'), "the rest only by code");
  assert.ok(ob.length < 12_000, `outline stays bounded: ${ob.length}`);
});

test("the prompt carries only what it was given — memory, recent turns, research, the engine's findings", () => {
  const p = copilotUserPrompt({ message: "Add a trust question", outline: "Survey: X", surveyLanguage: "hi", mode: "edit", memory: { memory: "Objective: trust", history: [{ role: "user", text: "hi" }, { role: "copilot", text: "hello" }] }, research: "[d1#2] trust passage", deterministicFindings: ["warning: Q2 may be leading"], selected: "Q2" });
  for (const part of ["Survey language: hi", "CURRENT SURVEY (outline):\nSurvey: X", "CONVERSATION MEMORY:\nObjective: trust", "Researcher: hi\nCopilot: hello", "RESEARCH MATERIAL", "[d1#2] trust passage", "- warning: Q2 may be leading", "Selected in the Studio: Q2", "RESEARCHER:\nAdd a trust question"]) assert.ok(p.includes(part), part);
  const bare = copilotUserPrompt({ message: "x", outline: "o", surveyLanguage: "en", mode: "question" });
  assert.ok(!bare.includes("RESEARCH MATERIAL") && !bare.includes("MEMORY"), "nothing sent that was not needed");
  // the system prompt knows the survey structure and the action vocabulary
  for (const w of ["create_block", "create_question", "set_display_logic", "add_skip", "create_randomizer", "create_branch", "create_loop", "create_calculation", "create_quota", "set_research", "screen_out", "Hinglish", "never invent a code"]) assert.ok(COPILOT_SYSTEM_PROMPT.includes(w), w);
});

test("research cards and passages: summarised once, cited, and only the relevant passages retrieved", () => {
  const chunks = chunkResearchDocument("dab1", { pages: [
    { n: 1, text: "## Abstract\nWe study social media exposure and premium skincare purchase among 18-34s." },
    { n: 2, text: "## Measures\nInfluencer trust was measured with a 5-item, 7-point scale (α = .88)." },
    { n: 3, text: "## Limitations\nThe sample was online only; offline shoppers were not reached." },
  ], tables: [] });
  const s = coerceDocSummary({ title: "Influence", type: "paper", summary: "A study.", scales: [{ name: "Influencer trust", items: 5, points: 7, passages: ["dab1#2", "zzz#9"] }], gaps: [{ text: "Offline shoppers", passages: ["dab1#3"] }], objectives: ["Test exposure effect"] }, chunks.map((c) => c.id))!;
  assert.deepEqual(s.scales, [{ name: "Influencer trust", items: 5, points: 7, passages: ["dab1#2"] }], "a citation to a passage that does not exist is dropped");
  assert.deepEqual(s.objectives, [{ text: "Test exposure effect", passages: [] }]);
  assert.equal(coerceDocSummary({ type: "paper" }, []), null, "an empty card is no card");
  const cards = researchCards([{ id: "dab1", name: "influence.pdf", summary: s }, { id: "dcd2", name: "brief.docx", summary: null }]);
  assert.match(cards, /Document 1 \[dab1\] “influence.pdf” \(paper\) — Influence/);
  assert.match(cards, /Scales: Influencer trust \(5 items, 7-point\) \[dab1#2\]/);
  assert.match(cards, /Document 2 \[dcd2\] “brief.docx”\n  \(no summary/);
  const ix = new ResearchIndex(chunks);
  const p = researchPassages(ix, [{ id: "dab1", name: "influence.pdf" }], "Based on the literature, add questions measuring influencer trust", { k: 2 });
  assert.equal(p.ids[0], "dab1#2");
  assert.match(p.text, /^\[dab1#2\] influence\.pdf, p\.2 — Measures\n/);
  const input = summaryInput(chunks, 10_000);
  assert.deepEqual(input.used, ["dab1#1", "dab1#2", "dab1#3"], "a short document is sent whole, in order");
  const many = chunkResearchDocument("dbig", { pages: Array.from({ length: 80 }, (_, i) => ({ n: i + 1, text: `## Section ${i}\n${"Filler text about markets and channels. ".repeat(25)}${i === 57 ? "Our hypothesis is that exposure predicts purchase." : ""}` })), tables: [] });
  const big = summaryInput(many, 20_000);
  assert.ok(big.text.length <= 21_000, "a long report is cut to the budget");
  assert.ok(big.used.includes(many.find((c) => /hypothesis/.test(c.text))!.id), "…keeping the passage that states the hypothesis");
});

import { evaluateProposal, rebaseProposal, changeRecord, memoryFrom, linkify, structureRows, proposalCounts, sameSurvey, uxPreviewScope } from "./client.ts";

test("a proposal is a chain: revising it before applying writes the next batch against the PROPOSED survey", () => {
  const base = survey();
  const p1 = { base, steps: [{ request: "add demographics and a trust block", actions: [
    { op: "create_block" as const, title: "Brand trust" },
    { op: "create_question" as const, ref: "TRUST", type: "rating", text: "How much do you trust skincare influencers?", scale: { points: 5 } },
    { op: "create_block" as const, title: "Demographics" },
    { op: "create_question" as const, ref: "GENDER", type: "single", text: "Gender", options: ["Woman", "Man", "Another identity", "Prefer not to say"] },
  ] }] };
  const s1 = evaluateProposal(p1);
  assert.deepEqual(s1.errors, []);
  assert.equal(s1.after.questions.length, base.questions.length + 2);
  // "Remove demographics." — against the proposal, not the saved survey
  const p2 = { ...p1, steps: [...p1.steps, { request: "remove demographics", actions: [{ op: "delete_block" as const, target: "Demographics" }] }] };
  const s2 = evaluateProposal(p2);
  assert.deepEqual(s2.errors, []);
  assert.deepEqual(s2.diff.questionsAdded.map((q) => q.code), ["Q3"], "net of the revision: only the trust question is new");
  assert.deepEqual(s2.diff.blocksAdded.map((b) => b.title), ["Brand trust"]);
  assert.ok(s2.destructive.some((d) => /Deletes block “Demographics”/.test(d)), "deleting what the proposal itself created is still named");
  // the survey changed underneath: the chain replays onto it
  const edited = structuredClone(base); edited.questions[0].text = "Edited elsewhere";
  const s3 = evaluateProposal(rebaseProposal(p2, edited));
  assert.equal(s3.after.questions[0].text, "Edited elsewhere", "the other edit is kept");
  assert.ok(s3.after.questions.some((q) => q.variableName === "TRUST"));
  assert.ok(!sameSurvey(base, edited) && sameSurvey(base, structuredClone(base)));
  // the history record
  const rec = changeRecord(1, "add a trust block", s2, base, "2026-09-28T10:00:00Z");
  assert.equal(rec.label.startsWith("AI change #001: "), true);
  assert.deepEqual(rec.created, ["block “Brand trust”", "Q3"]);
  assert.deepEqual(rec.removed, []);
  assert.equal(rec.before, base);
});

test("memory, links and the before/after structure", () => {
  const def = survey();
  const m = memoryFrom([
    { user: "make a skincare survey", reply: coerceCopilotReply({ reply: "Proposed 5 blocks.", actions: [{ op: "create_block", title: "A" }], memory: "Skincare, 18-35." }) },
    { user: "shorter", reply: coerceCopilotReply({ reply: "Removed 3 questions." }) },
  ]);
  assert.equal(m.memory, "Skincare, 18-35.", "the model's running memory is carried");
  assert.deepEqual(m.history.map((h) => h.role), ["user", "copilot", "user", "copilot"]);
  assert.match(m.history[1].text, /\[proposed 1 actions\]/);
  const seg = linkify("I found an issue in Q2: it reads BUY. The word buy is not a link.", def);
  assert.deepEqual(seg.filter((x) => "questionId" in x).map((x) => x.text), ["Q2", "BUY"]);
  assert.equal(seg.map((x) => x.text).join(""), "I found an issue in Q2: it reads BUY. The word buy is not a link.");
  const p = evaluateProposal({ base: def, steps: [{ request: "x", actions: [{ op: "update_question", target: "Q2", type: "multi" }, { op: "create_question", type: "text", text: "Why?", block: "Usage" }] }] });
  const after = structureRows(p.after, p.diff, "after");
  assert.deepEqual(after.filter((r) => r.mark).map((r) => [r.label.split(" ")[0], r.mark]), [["Q2", "modified"], ["Q3", "added"]]);
  const counts = proposalCounts(p.diff, p.after);
  assert.deepEqual(counts.map((c) => `${c.value} ${c.label}`), ["1 questions", "1 questions changed"]);
});

test("a revised proposal numbers the questions it made in order — and replays to the same codes the model was shown", () => {
  const base = survey(); // Q1, Q2
  const step1 = { request: "add three", actions: [
    { op: "create_block" as const, title: "More" },
    { op: "create_question" as const, type: "text", text: "Third?" },
    { op: "create_question" as const, type: "text", text: "Fourth?" },
    { op: "create_question" as const, type: "text", text: "Fifth?" },
  ] };
  const s1 = evaluateProposal({ base, steps: [step1] });
  assert.deepEqual(s1.after.questions.slice(2).map((q) => q.code), ["Q3", "Q4", "Q5"]);
  const step2 = { request: "drop the third", actions: [{ op: "delete_question" as const, target: "Q3" }] };
  const s2 = evaluateProposal({ base, steps: [step1, step2] });
  assert.deepEqual(s2.after.questions.slice(2).map((q) => [q.code, q.text]), [["Q3", "Fourth?"], ["Q4", "Fifth?"]], "no gap: the survey reads Q1–Q4");
  // the next step names Q4 as the model saw it ("Fifth?"), and the replay agrees
  const step3 = { request: "make Q4 required", actions: [{ op: "update_question" as const, target: "Q4", required: true }] };
  const s3 = evaluateProposal({ base, steps: [step1, step2, step3] });
  assert.equal(s3.after.questions.find((q) => q.text === "Fifth?")!.required, true);
  assert.deepEqual(s3.errors, []);
  // existing questions are never renumbered
  assert.deepEqual(s3.after.questions.slice(0, 2).map((q) => q.code), ["Q1", "Q2"]);
});

import { SURVEY_ACTION_OPS, UX_ACTION_ALIASES } from "@rescript/engine";
test("the model is told about every action the engine accepts — and only those", () => {
  const both = COPILOT_SYSTEM_PROMPT + COPILOT_UX_GUIDE + COPILOT_ANALYSIS_GUIDE + COPILOT_TRANSLATION_GUIDE + COPILOT_QUOTA_GUIDE;
  for (const op of SURVEY_ACTION_OPS) assert.ok(both.includes(`"op":"${op}"`), `the prompt, the UX guide or the analysis guide documents ${op}`);
  for (const op of ["create_style", "create_animation", "create_behavior", "attach_behavior_to_question", "create_responsive_rule"]) assert.ok(COPILOT_SYSTEM_PROMPT.includes(op), `the system prompt names ${op}, so the model never says the platform cannot style`);
  const documented = [...both.matchAll(/"op":"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(documented.filter((o) => ![...SURVEY_ACTION_OPS, ...UX_ACTION_ALIASES].includes(o as never)), [], "no action is advertised that the engine would refuse");
  // the detail of each domain lives in its guide (UX, analysis, translation), sent only with requests about it; the system prompt only names the actions
  // 13_800: the Phase 2 option-level, mask, duplicate, settings, embedded and hypothesis actions are one compact line each
  assert.ok(COPILOT_SYSTEM_PROMPT.length < 13_800, `the system prompt stays compact: ${COPILOT_SYSTEM_PROMPT.length}`);
});

test("UX requests: recognised, look-only when they are, and given the UX guide only then", () => {
  const only = [
    "Make Q10 look better.",
    "Add a hover animation to the Q4 options",
    "For Q12, make the answer options look like modern cards. When someone selects an option, animate the card slightly. If they select Other, smoothly expand the text field. Don't change any survey logic.",
    "Make all questions in Block 3 appear one at a time with a fade",
    "The options in Q7 are overlapping on mobile. Fix it.",
    "When Q5 is answered, animate the next button",
    "Clean up the custom CSS",
    "Add JavaScript so selecting Other shows a confirmation animation",
    "Make the progress bar animate smoothly when the respondent moves forward",
  ];
  for (const t of only) { const c = classifyRequest(t, 20, 0); assert.equal(c.ux, true, t); assert.equal(c.uxOnly, true, `look-only: ${t}`); assert.equal(c.mode, "ux", t); }
  const mixed = [
    "Add a question about price and make its options look like cards",
    "Make Q3 required and highlight it",
    "Change Q5 into a card sort",
    "Make the options look like cards and randomize them",
  ];
  for (const t of mixed) { const c = classifyRequest(t, 20, 0); assert.equal(c.ux, true, t); assert.equal(c.uxOnly, false, `structure allowed: ${t}`); }
  assert.equal(uxIntent("Add a question about mobile banking apps").only, false, "a topic word is not a look-only request");
  assert.equal(uxIntent("Make the options look like cards, but don't change the question wording or the logic").only, true, "negated structure is look-only");
  assert.equal(classifyRequest("Create a survey about mobile banking", 0, 0).mode, "generate");
  const gen = classifyRequest("Create a new survey about skincare with an animated, card-style design", 0, 0);
  assert.equal(gen.mode, "generate"); assert.equal(gen.ux, true); assert.equal(gen.uxOnly, false, "generating a survey is never look-only");
  const p = copilotUserPrompt({ message: "fade in Q2", outline: "o", surveyLanguage: "en", mode: "ux", ux: true, uxOnly: true });
  assert.ok(p.includes("UX GUIDE") && p.includes("LOOK-AND-BEHAVIOUR ONLY"));
  assert.ok(!copilotUserPrompt({ message: "add Q", outline: "o", surveyLanguage: "en", mode: "edit" }).includes("UX GUIDE"), "no guide on a structural turn");
});

test("UX in the outline and the proposal: existing items by id, the proof the structure is unchanged, the preview scope", () => {
  const d = survey();
  const withUx = applySurveyActions(d, [
    { op: "create_style", label: "FREQ cards", target: "Q2.options", rules: [{ declarations: { "border-radius": "12px" } }, { state: "hover", declarations: { transform: "translateY(-2px)" } }] },
    { op: "create_animation", label: "Usage fade", target: "block:Usage.questions", preset: "fade-up", trigger: "appear", durationMs: 300, delayMs: 0, easing: "ease-out", staggerMs: 120, iterations: 1 },
    { op: "create_behavior", label: "Nudge", target: "Q2", on: "answer", effects: [{ do: "animate", target: "next", preset: "pulse" }] },
  ] as never, { ids }).def;
  const o = copilotOutline(withUx, { focusIds: [withUx.questions[1].id], ux: true });
  assert.match(o, /UX configuration \(3 items; change these by id/);
  assert.match(o, /style uxs_\d+ “FREQ cards” on Q2 options: base \{border-radius:12px\} · hover \{transform:translateY\(-2px\)\}/);
  assert.match(o, /animation uxa_\d+ “Usage fade” on every question in “Usage”: fade-up on appear, 300ms, stagger 120ms/);
  assert.match(o, /behaviour uxb_\d+ “Nudge” on Q2: on answer → animate the Next button pulse/);
  assert.match(o, /Q2 ux: layout: auto, 3 options/);
  assert.match(o, /Theme: primary/);
  assert.doesNotMatch(copilotOutline(withUx), /Theme: primary/, "the theme only for a UX turn");
  // a look-only proposal: refused structure, proven unchanged
  const st = evaluateProposal({ base: withUx, steps: [{ request: "slower, and reword Q2", uxOnly: true, actions: [{ op: "update_animation", id: "Usage fade", durationMs: 900 }, { op: "update_question", target: "Q2", text: "Changed" }] as never }] });
  assert.equal(st.uxOnly, true); assert.equal(st.structureUnchanged, true);
  assert.match(st.errors.join(" "), /look and behaviour only/);
  assert.deepEqual(st.uxNotes, ["Change animation “Usage fade”: 300ms → 900ms"]);
  assert.ok(st.diff.summary.some((l) => /Change animation “Usage fade”/.test(l)));
  const structural = evaluateProposal({ base: withUx, steps: [{ request: "reword", actions: [{ op: "update_question", target: "Q2", text: "Changed" }] as never }] });
  assert.equal(structural.structureUnchanged, false); assert.equal(structural.uxOnly, false);
  const rec = changeRecord(1, "slower", st, withUx);
  assert.deepEqual(rec.modified, ["animation “Usage fade”"]);
  const scope = uxPreviewScope(withUx, evaluateProposal({ base: d, steps: [{ request: "x", actions: withUx.ux ? [] : [] }] }).diff);
  assert.ok(scope.questionIds.length > 0);
  const full = evaluateProposal({ base: d, steps: [{ request: "ux", uxOnly: true, actions: [
    { op: "create_behavior", label: "Nudge", target: "Q2", on: "answer", effects: [{ do: "animate", target: "next", preset: "pulse" }] },
    { op: "create_animation", label: "Usage fade", target: "block:Usage.questions", preset: "fade-up" },
  ] as never }] });
  const sc = uxPreviewScope(full.after, full.diff);
  assert.deepEqual(sc.questionIds, [full.after.questions[1].id], "the question the behaviour listens to");
  assert.equal(sc.chrome, true, "the Next button it animates");
  assert.ok(sc.blockId && sc.pageId, "the block and page, so block-scoped rules match");
});

test("a theme request is look-only; a theme image is told as colours and a placeholder the Studio fills", async () => {
  const { describeThemeImage, withThemeImage, THEME_IMAGE_TOKEN } = await import("./themeImageText.ts");
  for (const t of ["Give the survey a premium dark theme", "Make the survey look like this", "Use this image as the background image", "Change the colour scheme to our palette", "Switch to dark mode"]) {
    const c = classifyRequest(t, 20, 0); assert.equal(c.ux, true, t); assert.equal(c.uxOnly, true, `look-only: ${t}`);
  }
  const text = describeThemeImage({ name: "mood.jpg", dominant: ["#1d1f20", "#dc3214"], palette: { primary: "#dc3214" }, dark: true });
  assert.match(text, /a dark image; dominant colours #1d1f20, #dc3214; .*primary #dc3214/);
  assert.ok(text.includes(`background.image "${THEME_IMAGE_TOKEN}"`));
  const acts = withThemeImage([{ op: "set_theme", background: { image: THEME_IMAGE_TOKEN, overlay: "rgba(0,0,0,.4)" }, colors: { primary: "#dc3214" } }], "https://cdn.example.com/a.jpg");
  assert.deepEqual(acts, [{ op: "set_theme", background: { image: "https://cdn.example.com/a.jpg", overlay: "rgba(0,0,0,.4)" }, colors: { primary: "#dc3214" } }]);
});

test("a default value request reaches the UX guide, which offers set_default_value — never a script that fills in answers", () => {
  for (const t of ["Set Q2's default value to 19", "Prefill the age question with 19", "Give Q3 a default answer of Yes"]) {
    const c = classifyRequest(t, 20, 0); assert.equal(c.ux, true, t);
  }
  assert.match(COPILOT_UX_GUIDE, /\{"op":"set_default_value","target":"Q2","value":19\}/);
  assert.match(COPILOT_UX_GUIDE, /A script CANNOT fill in or change an answer/);
});

test("punching and variables are structure: a request that mixes them with the look is not look-only", () => {
  for (const t of [
    // one structural signal each
    "Highlight Q4 and add a punch so Q6 is 1 when Q3 = 1",
    "Style Q3 as cards and autopunch Q6 from Q3",
    "Animate Q4 and fill the hidden variable RESP_TYPE from Q3",
    "Make the options rounded and code Q6 as 2 when Q3 = 2",
    "Highlight the Next button and put Yes-sayers in the Fans segment",
  ]) {
    const c = classifyRequest(t, 20, 0); assert.equal(c.ux, true, t); assert.equal(c.uxOnly, false, `structure allowed: ${t}`);
  }
  // look-only still means look-only
  assert.equal(classifyRequest("Make Q3's options rounded cards with a hover glow", 20, 0).uxOnly, true);
  assert.equal(classifyRequest("Set the default value of Q2 to 19", 20, 0).uxOnly, true, "a default value is look-and-behaviour");
  assert.equal(classifyRequest("Set the colour to navy and the font to Georgia", 20, 0).uxOnly, true, "“set … to” on the look is still look-only");
  // the look-only prompt tells the model where a structural change goes: this chat, as its own request
  const p = copilotUserPrompt({ message: "rounded cards", outline: "o", surveyLanguage: "en", mode: "ux", ux: true, uxOnly: true });
  assert.match(p, /ask for it as its own request in this same chat/);
  assert.match(p, /there is no other mode or session to switch to/);
});

/* ------------------------------------------------------------ the analysis framework (Phase 2) */

test("analysis turns: the intent is recognised, the guide and the plan go with it, and the actions are in the vocabulary", () => {
  for (const m of ["plan the analysis", "add a crosstab of purchase intent by country", "which test should I use for H2?", "is Q6 the dependent variable?", "show me the most important crosstabs", "run a regression on intent", "should I use MaxDiff or conjoint?"]) assert.ok(analysisIntent(m), m);
  for (const m of ["make Q7 a 5-point scale", "randomize the brands in Q12", "translate this section into German", "add an image to each option"]) assert.ok(!analysisIntent(m), m);
  const def = survey();
  const out = applySurveyActions(def, [{ op: "set_question_analysis", target: "FREQ", role: "dependent", hypotheses: ["H1"] }, { op: "propose_analysis_plan" }]).def;
  const o = copilotOutline(out, { analysis: true });
  assert.match(o, /hypotheses: H1 Social exposure drives purchase/, "hypotheses carry their labels");
  assert.match(o, /Variable roles \(set or inferred\): .*Q2=dependent\/nominal\[H1\]/);
  assert.match(o, /Analysis plan \(engine; name items by id\):/);
  const plain = copilotOutline(out, {});
  assert.ok(!plain.includes("Analysis plan ("), "a wording edit does not carry the plan");
  const p = copilotUserPrompt({ message: "plan the analysis", outline: "o", surveyLanguage: "en", mode: "edit", analysis: true });
  assert.ok(p.includes("ANALYSIS GUIDE") && p.includes("set_question_analysis") && p.includes("propose_analysis_plan"));
  assert.ok(!copilotUserPrompt({ message: "x", outline: "o", surveyLanguage: "en", mode: "edit" }).includes("ANALYSIS GUIDE"));
  for (const w of ["set_question_analysis", "propose_analysis_plan", "add_crosstab", "add_analysis_test", "add_derived_variable", "logistic_regression", "H1, H2"]) assert.ok(COPILOT_ANALYSIS_GUIDE.includes(w), w);
  assert.ok(COPILOT_SYSTEM_PROMPT.includes("THE ANALYSIS FRAMEWORK is planned BEFORE fieldwork"));
  for (const op of ["set_question_analysis", "propose_analysis_plan", "set_analysis_plan", "add_crosstab", "remove_crosstab", "add_analysis_test", "remove_analysis_test", "add_derived_variable", "remove_derived_variable"]) assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes(op), op);
  /* the reply gate passes analysis actions through the engine's gate */
  const r = coerceCopilotReply({ kind: "proposal", reply: "ok", actions: [{ op: "add_crosstab", rows: ["FREQ"], columns: ["BUY"] }, { op: "add_analysis_test", method: "wizardry" }] })!;
  assert.equal(r.actions.length, 1); assert.equal(r.rejected.length, 1);
});

test("translation turns: the intent, the guide, a block named in the request, and the outline's languages with the existing translations", () => {
  for (const m of ["translate the Usage block into German", "add Spanish and French", "which languages are ready?", "route Mexican respondents to es", "add 'Gold' to the glossary as do-not-translate", "approve the German translations", "localize this for India"]) assert.ok(translationIntent(m), m);
  for (const m of ["make Q7 a 5-point scale", "plan the analysis", "add a crosstab of FREQ by BUY", "randomize the options"]) assert.ok(!translationIntent(m), m);
  const def = survey();
  /* a block's title in the request focuses all of its questions */
  assert.deepEqual(referencedQuestions(def, "translate the Usage block into German").map((id) => def.questions.find((q) => q.id === id)!.code), ["Q2"]);
  assert.deepEqual(referencedQuestions(def, "translate Q1 into German").map((id) => def.questions.find((q) => q.id === id)!.code), ["Q1"]);
  /* the outline: no languages yet → says so; with a language, its state, the glossary, the routing and the named questions' elements */
  const none = copilotOutline(def, { translation: true });
  assert.match(none, /Source language: en.*Language versions: none yet \(add_language\)/);
  assert.match(none, /Language routing: order /);
  const out = applySurveyActions(def, [
    { op: "add_language", code: "de" },
    { op: "set_glossary", entries: [{ source: "Skincare", doNotTranslate: true }, { source: "Monthly", targets: { de: "Monatlich" } }] },
    { op: "set_translations", language: "de", entries: [{ target: "FREQ", text: "Wie oft kaufen Sie?" }, { target: "FREQ.option:2", text: "Monatlich" }] },
    { op: "set_language_routing", countryMap: { DE: "de" }, fallback: "en" },
  ], { ids });
  assert.deepEqual(out.errors, []);
  const o = copilotOutline(out.def, { translation: true, focusIds: referencedQuestions(out.def, "translate the Usage block") });
  assert.match(o, /Language versions: de\/de-DE Deutsch \(draft; \d+% translated, \d+ missing, 0 approved\)/);
  assert.match(o, /Glossary: Skincare \(never translate\); Monthly → de: Monatlich/);
  assert.match(o, /Language routing: .*countries DE → de.*fallback en/);
  assert.match(o, /Translatable elements of the named questions/);
  assert.match(o, /  Q2 → "How often do you buy\?" \| de \[ai\] "Wie oft kaufen Sie\?"/, "the existing translation and its status");
  assert.match(o, /  Q2\.option:2 → "Monthly" \| de \[ai\] "Monatlich"/);
  assert.match(o, /  Q2\.option:1 → "Weekly" \| de —/, "a missing one");
  assert.ok(!o.includes('Q1 → "Bought'), "the unnamed question is not listed");
  assert.ok(!copilotOutline(out.def, {}).includes("Language versions:"), "a wording edit does not carry the languages");
  /* the prompt */
  const p = copilotUserPrompt({ message: "translate the Usage block into German", outline: "o", surveyLanguage: "en", mode: "edit", translation: true });
  assert.ok(p.includes("TRANSLATION GUIDE") && p.includes("set_translations") && p.includes("approve_translations"));
  assert.ok(!copilotUserPrompt({ message: "x", outline: "o", surveyLanguage: "en", mode: "edit" }).includes("TRANSLATION GUIDE"));
  for (const w of ["add_language", "set_translations", "approve_translations", "confirm_translations", "set_language_routing", "set_glossary", "overwriteApproved", "Q5.option:2", "countryMap"]) assert.ok(COPILOT_TRANSLATION_GUIDE.includes(w), w);
  assert.ok(COPILOT_SYSTEM_PROMPT.includes("LANGUAGES are actions too"));
  for (const op of ["add_language", "remove_language", "set_language_status", "set_translations", "approve_translations", "confirm_translations", "set_language_routing", "set_glossary"]) assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes(op), op);
  /* the reply gate: a translation that drops the piping is refused by reason, the good one passes */
  const r = coerceCopilotReply({ kind: "proposal", reply: "ok", actions: [{ op: "set_translations", language: "de", entries: [{ target: "FREQ", text: "Wie oft?" }] }, { op: "set_translations", language: "de" }] })!;
  assert.equal(r.actions.length, 1); assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /entries/);
});

test("quota turns: the intent, the guide, the outline's quotas with their cells, checks, review and live counts — and the gate", () => {
  for (const m of ["set up quotas: 500 completes, 50/50 gender", "we need 300 completes nat rep by age", "which cells are full?", "interlock gender and age", "the sample plan is attached", "cap London at 200 — quota"]) assert.ok(quotaIntent(m), m);
  for (const m of ["make Q7 a 5-point scale", "translate Q5 into German", "plan the analysis", "add a question about income"]) assert.ok(!quotaIntent(m), m);
  const def = survey();
  const out = applySurveyActions(def, [{ op: "create_quota", name: "Usage", total: 300, dimensions: [{ question: "FREQ" }] }], { ids }).def;
  const q = out.quotas[0];
  assert.deepEqual(q.cells.map((c) => [c.label, c.limit]), [["Weekly", 100], ["Monthly", 100], ["Rarely", 100]]);
  /* the base context names the quotas on every turn; the full block only on a quota turn */
  assert.match(copilotOutline(out, {}), /Quotas: Usage \[quota_\d+\] \(3 cells\)/);
  assert.ok(!copilotOutline(out, {}).includes("name cells by label"));
  const o = copilotOutline(out, { quota: true });
  assert.match(o, /Quotas \(name cells by label; limits are counts unless %\):/);
  assert.match(o, new RegExp(`  Usage \\[id ${q.id}\\] — hard, when full: terminate, total 300, checked after “Usage”`));
  assert.match(o, /    Weekly: ≤ 100 when Q2 = 1/);
  assert.ok(!o.includes("Quota review"), "a clean quota: no review line");
  const gappy = applySurveyActions(def, [{ op: "create_quota", name: "Usage", total: 300, dimensions: [{ question: "FREQ", bands: [{ codes: [1] }, { codes: [2] }] }] }], { ids }).def;
  assert.match(copilotOutline(gappy, { quota: true }), /Quota review: \[warning\] 1 of 3 answer combinations falls outside every cell of “Usage” \(Rarely\)/);
  /* the live counts: the men… the cells so far, and the fieldwork advice */
  const counts = { [q.id]: { [q.cells[0].id]: 100, [q.cells[1].id]: 40, [q.cells[2].id]: 2 } };
  const oc = copilotOutline(out, { quota: true, quotaCounts: counts });
  assert.match(oc, /    Weekly: ≤ 100 \(100 so far\) when/);
  assert.match(oc, /Fieldwork \(from the live counts\): Usage: Weekly \(100\/100\) is full while 2 cells still need 158/);
  assert.match(oc, /Rarely has 2 of the ~47 expected at this point/);
  assert.match(copilotOutline(empty(), { quota: true }), /Quotas: none yet \(create_quota\)/);
  /* the prompt */
  const p = copilotUserPrompt({ message: "500 completes 50/50", outline: "o", surveyLanguage: "en", mode: "edit", quota: true });
  assert.ok(p.includes("QUOTA GUIDE") && p.includes("create_quota") && p.includes("set_quota_check"));
  assert.ok(!copilotUserPrompt({ message: "x", outline: "o", surveyLanguage: "en", mode: "edit" }).includes("QUOTA GUIDE"));
  for (const w of ["dimensions", "bands", "share", "INTERLOCKED", "update_quota", "add_quota_cells", "remove_quota_cells", "delete_quota", "set_quota_check", "percent"]) assert.ok(COPILOT_QUOTA_GUIDE.includes(w), w);
  for (const op of ["create_quota", "update_quota", "add_quota_cells", "remove_quota_cells", "delete_quota", "set_quota_check"]) assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes(op), op);
  /* the gate */
  const r = coerceCopilotReply({ kind: "proposal", reply: "ok", actions: [{ op: "create_quota", name: "G", total: 100, dimensions: ["FREQ"] }, { op: "create_quota", name: "H", dimensions: ["FREQ"] }, { op: "update_quota", quota: "G" }] })!;
  assert.equal(r.actions.length, 1); assert.equal(r.rejected.length, 2);
  assert.match(r.rejected[0].reason, /needs the total/); assert.match(r.rejected[1].reason, /changes nothing/);
});

test("findings turns: the intent, the run's brief in the outline (verdicts, then findings with their evidence), nothing invented when there is no run, the guide", () => {
  for (const m of ["what did we find?", "did H1 hold?", "is the gender difference significant?", "what drives satisfaction?", "summarise the results", "what does the data say about region?", "how did Brand A perform?", "write the client report", "draft me an executive summary", "prepare the debrief deck"]) assert.ok(findingsIntent(m), m);
  for (const m of ["make Q7 a 5-point scale", "translate Q5 into German", "add a crosstab of FREQ by BUY", "set up quotas: 500 completes"]) assert.ok(!findingsIntent(m), m);
  const def = survey();
  const run = {
    computedAt: "2026-10-05T09:00:00Z", n: 312, trigger: "halfway", environment: "LIVE" as const, warnings: ["Two analyses are based on fewer than 30 respondents."],
    verdicts: [{ label: "H1", text: "Social exposure drives purchase", verdict: "supported" as const, reason: "The planned test is significant: FREQ by BUY: a moderate difference (chi-square, p = .003, Cramér's V = 0.21).", findings: [], analyses: 1 }],
    findings: [
      { id: "a:0", kind: "difference" as const, strength: "moderate" as const, significant: true, headline: "FREQ by BUY: a moderate difference (chi-square, p = .003, Cramér's V = 0.21).", evidence: { test: "chi_square", statistic: 11.7, p: 0.003, effect: { name: "Cramér's V", value: 0.21 }, n: 312 }, variables: ["FREQ", "BUY"], hypotheses: ["H1"], analysis: { name: "FREQ by BUY", kind: "crosstab", hash: "a" } },
      { id: "b:0", kind: "no_correlation" as const, strength: "none" as const, significant: false, headline: "Age × FREQ: no significant correlation (r = 0.04, p = .480).", evidence: { test: "correlation", statistic: 0.04, p: 0.48, effect: { name: "r", value: 0.04 }, n: 312 }, variables: ["AGE", "FREQ"], hypotheses: [], analysis: { name: "Age × FREQ", kind: "correlation", hash: "b" } },
    ],
  };
  const o = copilotOutline(def, { findings: true, analysisRun: run });
  assert.match(o, /Analysis run \(halfway\) on 312 live completes, 2026-10-05 09:00:/);
  assert.match(o, /  H1 SUPPORTED — Social exposure drives purchase\. The planned test is significant/);
  assert.match(o, /  Findings \(strongest first\):\n    \[moderate\] FREQ by BUY: a moderate difference \(chi-square, p = \.003, Cramér's V = 0\.21\)\. \(H1\)\n    \[ns\] Age × FREQ: no significant correlation/);
  assert.match(o, /  Caveats: Two analyses are based on fewer than 30/);
  assert.ok(!copilotOutline(def, {}).includes("Analysis run"), "a wording edit carries no run");
  assert.match(copilotOutline(def, { findings: true, analysisRun: null }), /Analysis run: none yet — there is no analysis plan yet \(propose_analysis_plan\); there are no results to report\./);
  const planned = applySurveyActions(def, [{ op: "propose_analysis_plan" }], { ids }).def;
  assert.match(copilotOutline(planned, { findings: true, analysisRun: null }), /the plan has not been run on the responses/);
  assert.ok(copilotOutline(planned, { analysis: true, analysisRun: run }).includes("Analysis run (halfway)"), "an analysis turn with a run carries it too");
  assert.ok(!copilotOutline(planned, { analysis: true, analysisRun: null }).includes("Analysis run"), "but without one says nothing");
  const p = copilotUserPrompt({ message: "what did we find?", outline: "o", surveyLanguage: "en", mode: "edit", findings: true });
  assert.ok(p.includes("FINDINGS GUIDE") && p.includes("never invents") === false && p.includes("Never report a number that is not in the run"));
  assert.ok(!copilotUserPrompt({ message: "x", outline: "o", surveyLanguage: "en", mode: "edit" }).includes("FINDINGS GUIDE"));
  for (const w of ["VERDICT", "SUPPORTED", "p-value", "effect size", "not tested", "add_analysis_test", "\"kind\":\"answer\"", "Asked to WRITE", "Draft the report"]) assert.ok(COPILOT_FINDINGS_GUIDE.includes(w), w);
});
