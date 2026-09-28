import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions } from "@rescript/engine";
import { chunkResearchDocument, ResearchIndex } from "@rescript/import/research";
import { coerceCopilotReply, classifyRequest, copilotUserPrompt, referencedQuestions, surveyLanguageOf, COPILOT_SYSTEM_PROMPT } from "./prompt.ts";
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
  assert.deepEqual(classifyRequest("My hypothesis is that younger consumers buy premium skincare because of social media. Create a survey to test it.", 0, 0), { mode: "generate", research: false });
  assert.deepEqual(classifyRequest("Change Q18 to a matrix question", 30, 3), { mode: "edit", research: false }, "no papers for a type change");
  assert.deepEqual(classifyRequest("Based on the literature review, add three questions measuring trust", 30, 3), { mode: "edit", research: true });
  assert.deepEqual(classifyRequest("Review my survey", 30, 0), { mode: "review", research: false });
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
  assert.match(o, /Research design: objective: Understand premium skincare buying · hypotheses: Social exposure drives purchase · constructs: Purchase \(dependent: Q2\); Exposure \(independent, not measured\)/);
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

import { evaluateProposal, rebaseProposal, changeRecord, memoryFrom, linkify, structureRows, proposalCounts, sameSurvey } from "./client.ts";

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

import { SURVEY_ACTION_OPS } from "@rescript/engine";
test("the model is told about every action the engine accepts — and only those", () => {
  for (const op of SURVEY_ACTION_OPS) assert.ok(COPILOT_SYSTEM_PROMPT.includes(`"op":"${op}"`), `the prompt documents ${op}`);
  const documented = [...COPILOT_SYSTEM_PROMPT.matchAll(/"op":"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(documented.filter((o) => !(SURVEY_ACTION_OPS as readonly string[]).includes(o)), [], "no action is advertised that the engine would refuse");
  assert.ok(COPILOT_SYSTEM_PROMPT.length < 12_000, `the system prompt stays compact: ${COPILOT_SYSTEM_PROMPT.length}`);
});
