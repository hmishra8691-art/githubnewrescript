import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions } from "@rescript/engine";
import { COPILOT_METHODS_GUIDE, methodsIntent } from "./methodsGuide.ts";
import { COPILOT_LIST_FILL_GUIDE, listFillIntent } from "./listFillGuide.ts";
import { COPILOT_SYSTEM_PROMPT, coerceCopilotReply, copilotUserPrompt, repairPrompt } from "./prompt.ts";
import { copilotOutline } from "./outline.ts";
import { evaluateProposal } from "./client.ts";
import { copilotCall } from "../aiPromptCache.ts";

/*
 * PRIORITY 5 (2026-10-17): MaxDiff, conjoint and List Fill / LEAST as structured research designs in
 * Intelligent Mode. The guide is chosen by the request's words, rides in the cached prefix, stays
 * small, and every example it teaches is applied by the engine as written — with the real design
 * generators, which client.ts registers for the browser's replay (as the route does on the server).
 */

const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Phones", version: "1" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
const BRIEF = [
  "Create a MaxDiff study to identify the most and least important product features.",
  "Create a choice-based conjoint with four attributes and three levels per attribute.",
  "Configure a LEAST List Fill setup based on the existing eligible-item counts and allocation rules.",
];
const base = { outline: "(survey)", surveyLanguage: "English", mode: "edit" as const };

test("the brief's three requests: MaxDiff and CBC get the methods guide, LEAST List Fill the List Fill guide", () => {
  assert.equal(methodsIntent(BRIEF[0]), true);
  assert.equal(methodsIntent(BRIEF[1]), true);
  assert.equal(listFillIntent(BRIEF[2]), true);
  const yes = [
    "set up a best-worst exercise for these 10 claims", "add a max diff on the benefits", "best/worst scaling of the messages",
    "make it 5 items per task in the MaxDiff", "prohibit Brand A and Brand B together in the maxdiff", "add a None option to the conjoint",
    "build a CBC with brand, price and battery", "I need choice tasks with 3 concepts each", "menu-based conjoint for the add-ons", "an ACBC study for laptops",
    "discrete choice experiment on fares", "4 attributes and 3 levels each", "pricing configurator with a base plan",
    "maxdiff banao in 12 features ke saath", "conjoint chahiye price aur brand pe", "मैक्सडिफ बनाओ फीचर्स के लिए", "कंजॉइंट स्टडी बनाओ",
    /* F4 2026-10-22 */
    "make a rating-based conjoint with 4 attributes", "add a none option as dual response", "run the menu simulator with the premium bundle at ₹499", "a CVA study of laptops", "brand-specific attributes for the 5G phones",
  ];
  for (const m of yes) assert.ok(methodsIntent(m), m);
  const no = ["make Q7 a 5-point scale", "rank the features in Q5", "add a question about the most important feature", "randomize the options of Q5", "set up quotas: 500 completes, 50/50 gender", "translate Q5 into Hindi", "show Q10 only to people who chose Apple"];
  for (const m of no) assert.ok(!methodsIntent(m), m);
  assert.ok(copilotUserPrompt({ ...base, message: BRIEF[0], methods: true }).includes("METHODS GUIDE"));
  assert.ok(!copilotUserPrompt({ ...base, message: "make Q7 a 5-point scale" }).includes("METHODS GUIDE"), "sent only when the request needs it");
});

test("sizes and caching: the system prompt is unchanged and under its cap; the guide is small and rides in the cached prefix", () => {
  assert.ok(COPILOT_SYSTEM_PROMPT.length < 14_800, `${COPILOT_SYSTEM_PROMPT.length}`);
  /* F4 2026-10-22: + CVA, dual-response None, labelled / brand-specific CBC, summed price, menu sections, simulate_conjoint (was < 4,600) */
  assert.ok(COPILOT_METHODS_GUIDE.length < 7_000, `methods guide ${COPILOT_METHODS_GUIDE.length}`);
  assert.ok(COPILOT_LIST_FILL_GUIDE.length < 4_200, `List Fill guide ${COPILOT_LIST_FILL_GUIDE.length}`);
  const prompt = copilotUserPrompt({ ...base, message: BRIEF[0], methods: true, listFill: true });
  const [system, user] = copilotCall(prompt);
  assert.deepEqual(system, [COPILOT_SYSTEM_PROMPT, [COPILOT_LIST_FILL_GUIDE, COPILOT_METHODS_GUIDE].join("\n\n")]);
  assert.equal(user.includes(COPILOT_METHODS_GUIDE), false);
  assert.ok(user.includes(BRIEF[0]));
});

/** every action line of a guide, parsed as JSON (the comment after it dropped) */
const exampleLines = (guide: string) => guide.split("\n").filter((l) => l.startsWith('{"op":')).map((l) => JSON.parse(l.split("   //")[0]));

test("the guide's worked examples pass the engine's gate and apply as written, with the measured diagnostics", () => {
  const examples = exampleLines(COPILOT_METHODS_GUIDE);
  assert.deepEqual(examples.map((a) => a.op), ["create_maxdiff", "update_maxdiff", "create_conjoint", "update_conjoint", "create_conjoint", "create_conjoint", "create_conjoint", "update_conjoint", "simulate_conjoint"]);
  const creates = examples.filter((a) => a.op.startsWith("create_")), updates = examples.filter((a) => a.op.startsWith("update_")).slice(0, 2);
  const c1 = coerceSurveyActions(creates);
  assert.deepEqual(c1.rejected, []);
  const made = applySurveyActions(empty(), c1.actions);
  assert.deepEqual(made.errors, []);
  assert.deepEqual(made.def.designs.map((d) => d.kind), ["maxdiff", "conjoint", "menu", "acbc", "cva"]);
  assert.match(made.results[4].description, /rating-based conjoint \(CVA\).*D-optimal/);
  assert.match(made.results[0].description, /8 items, 4 per task, 6 tasks, 10 versions; each respondent sees every item 3 times/);
  assert.match(made.results[1].description, /D-efficiency \d+(\.\d)?% per version/);
  const c2 = coerceSurveyActions(updates);
  assert.deepEqual(c2.rejected, []);
  const changed = applySurveyActions(made.def, c2.actions);
  assert.deepEqual(changed.errors, []);
  assert.equal(changed.def.designs[0].config.itemsPerTask, 5);
  assert.equal(changed.def.designs[1].config.noneOption, true);
  assert.deepEqual(changed.def.questions.map((q) => [q.code, q.text, q.required]), made.def.questions.map((q) => [q.code, q.text, q.required]), "the questions are untouched");
  /* F4 2026-10-22: "add a none option as dual response" replaces the None; the menu scenario is checked and saved */
  const [dual, sim] = examples.slice(7);
  const d2 = applySurveyActions(changed.def, coerceSurveyActions([dual, sim]).actions);
  assert.deepEqual(d2.errors, []);
  assert.equal(d2.def.designs[1].config.dualResponseNone, true);
  assert.equal(d2.def.designs[1].config.noneOption, false, "the None alternative is replaced by the dual-response question");
  assert.equal((d2.def.designs[2].config.simulations as { name: string }[])[0].name, "Premium bundle at $12");
  // the clarify replies: a question back, no actions
  const clarify = coerceCopilotReply({ kind: "clarify", reply: "To build the conjoint I need the attributes.", questions: ["What are the four attributes and their three levels?"] });
  assert.equal(clarify!.kind, "clarify");
  assert.deepEqual(clarify!.actions, []);
  for (const w of ["NEVER SUBSTITUTE", "NOT AVAILABLE", "ranking-based conjoint", "HB", "simulate_conjoint", "dualResponse", "\"method\":\"cva\"", "ASK", "INFER", "\"kind\":\"clarify\"", "itemsFrom", "update_maxdiff", "update_conjoint", "Designs:"]) assert.ok(COPILOT_METHODS_GUIDE.includes(w), w);
});

test("the List Fill guide teaches least fill (basis, ties, onChange) and its examples apply", () => {
  for (const w of ["least_fill", "\"basis\":\"completed\"", "tieBreak", "onChange", "never random or balanced instead"]) assert.ok(COPILOT_LIST_FILL_GUIDE.includes(w), w);
  const brands = ["Apple", "Samsung", "Xiaomi", "OnePlus", "Vivo", "Oppo", "Realme", "Motorola", "Nokia", "Google"];
  const [create, ...updates] = exampleLines(COPILOT_LIST_FILL_GUIDE).filter((a) => a.op !== "remove_list_fill");
  const made = applySurveyActions(empty(), coerceSurveyActions([
    { op: "create_question", type: "grid", code: "Q37", text: "How familiar are you with each brand?", rows: brands, scale: { points: 5, labels: ["Never heard of", "Heard of", "Somewhat familiar", "Familiar", "Very familiar"] } },
    { op: "create_question", type: "ranking", code: "Q38", text: "Rank these brands", options: brands, newPage: true },
    create,
  ]).actions);
  assert.deepEqual(made.errors, []);
  const least = updates.find((u) => u.method === "least_fill")!;
  const out = applySurveyActions(made.def, coerceSurveyActions([least]).actions);
  assert.deepEqual(out.errors, []);
  const before = made.def.listFills[0], after = out.def.listFills[0];
  assert.equal(after.selection.method, "least_filled");
  assert.deepEqual(after.selection.leastFilled, { basis: "completed", tieBreak: "priority" }, "Apple's priority now only breaks ties");
  assert.deepEqual(after.options, before.options, "eligibility, priority and items are untouched");
  assert.deepEqual(after.destinations, before.destinations);
  assert.deepEqual(after.selection.count, before.selection.count);
});

test("the repair carries the methods guide when the model wrote a MaxDiff as create_question without it", () => {
  const prompt = copilotUserPrompt({ ...base, message: "add a ranking of features" });
  const refused = ["Create maxdiff question “x”: a Best–Worst (MaxDiff) question renders a generated design — use create_maxdiff (items, perTask, tasks, versions …), which generates and attaches the design"];
  const rp = repairPrompt({ prompt, raw: { actions: [{ op: "create_question", type: "maxdiff" }] }, refused, total: 1, uxGuideSent: false, ops: ["create_question"] });
  assert.equal(rp.addedMethodsGuide, true);
  assert.ok(rp.text.includes(COPILOT_METHODS_GUIDE));
  const sent = repairPrompt({ prompt: copilotUserPrompt({ ...base, message: BRIEF[0], methods: true }), raw: {}, refused, total: 1, uxGuideSent: false, methodsGuideSent: true, ops: ["create_question"] });
  assert.equal(sent.addedMethodsGuide, undefined, "not twice");
});

test("the outline names each design with its settings, so a modification patches it; the browser replay generates the identical design", () => {
  const actions = coerceSurveyActions([{ op: "create_block", title: "Features" }, { op: "create_maxdiff", ref: "FEAT_MD", items: ["Battery", "Camera", "Price", "Screen", "Storage", "Weight"], prohibitedPairs: [["Price", "Camera"]] }]).actions;
  const server = applySurveyActions(empty(), actions);
  assert.deepEqual(server.errors, []);
  const outline = copilotOutline(server.def);
  assert.match(outline, /Designs: Q1 MaxDiff \[design Q1 MaxDiff design, v1, seed \d+\]: 6 items \(Battery \| Camera \| Price \| Screen \| Storage \| Weight\), 3 per task, 6 tasks, 10 versions, best_worst, prohibited Price\/Camera/);
  const replay = evaluateProposal({ base: empty(), steps: [{ request: BRIEF[0], actions }] });
  assert.deepEqual(replay.errors, []);
  assert.deepEqual(replay.after.designs.map((d) => [d.seed, d.config, d.file!.rows]), server.def.designs.map((d) => [d.seed, d.config, d.file!.rows]), "Apply replays the same design the card described");
  assert.ok(replay.diff.summary.some((l) => /Add design “Q1 MaxDiff design” \(MaxDiff, \d+ rows\)/.test(l)), JSON.stringify(replay.diff.summary));
});
