import { test } from "node:test";
import assert from "node:assert/strict";
import { actionTargets, claimsAFile, detectLanguage, factsOf, scoreTurn, type TurnOutcome } from "./score.ts";
import type { EvalTurn } from "./cases.ts";

/* the scorer: pure — a turn's expectations and what came back in, named checks out; it must FAIL bad answers, not only pass good ones */
const call = (o: Partial<TurnOutcome["calls"][number]> = {}) => ({ operation: "copilot_edit", model: "m", provider: "p", inputTokens: 9000, outputTokens: 300, cacheReadTokens: 4000, cacheWriteTokens: 0, requests: 1, providerCostUsd: 0.01, chargeUsd: 0.02, latencyMs: 900, ...o });
const outcome = (reply: Record<string, unknown>, extra: Record<string, unknown> = {}, calls = [call()]): TurnOutcome => ({
  status: 200, latencyMs: 1000, calls,
  body: { ok: true, reply, validation: { valid: true, results: (reply.actions as unknown[] ?? []).map((_, i) => ({ index: i, ok: true })) }, context: { mode: "edit" }, ...extra },
});
const risk = {
  highRisk: (_def: unknown, actions: readonly unknown[]) => (actions as { op: string }[]).filter((a) => a.op === "delete_question").map((a) => ({ kind: "delete", op: a.op, why: "deletes a question" })),
  asked: (kind: string, text: string) => kind === "delete" && /delete|remove/i.test(text),
};

test("a good single edit passes every check it asks for", () => {
  const turn: EvalTurn = { message: "Make Q6 required", expect: { modelCalled: true, mode: "edit", opsPresent: ["update_question"], opsAbsent: ["delete_question"], targets: ["Q6"], appliedMin: 1, valid: true, parse: "clean", language: "en", clarify: "forbidden" } };
  const { checks } = scoreTurn(turn, outcome({ kind: "edit", reply: "Q6 is now required.", actions: [{ op: "update_question", target: "Q6", required: true }] }), { defBefore: {}, risk });
  assert.deepEqual(checks.filter((c) => !c.ok), []);
  assert.ok(checks.length >= 12);
});

test("wrong op, wrong target, nothing applied, a clarify, a repair, a file claim and the wrong language each fail by name", () => {
  const turn: EvalTurn = { message: "Make Q6 required", expect: { opsPresent: ["update_question"], targets: ["Q6"], appliedMin: 1, parse: "clean", language: "hi", clarify: "forbidden" } };
  const out = outcome({ kind: "clarify", reply: "I've attached the Excel file with the changes. Which question did you mean?", actions: [{ op: "set_display_logic", target: "Q7", expression: "Q1 = 1" }] }, { validation: { valid: false, results: [{ index: 0, ok: false }] }, context: { mode: "edit", repair: { refused: ["x"], fixed: false } } });
  const failed = scoreTurn(turn, out, { defBefore: {}, risk }).checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed.sort(), ["applied_min", "language", "no_clarify", "no_file_claim", "op_present:update_question", "parse_clean", "target:Q6"].sort());
});

test("a high-risk action the researcher did not ask for fails; the same action asked for passes", () => {
  const reply = { kind: "edit", reply: "Done.", actions: [{ op: "delete_question", target: "Q2" }] };
  assert.equal(scoreTurn({ message: "Fix the typos in Q5" }, outcome(reply), { defBefore: {}, risk }).checks.find((c) => c.name === "no_high_risk")!.ok, false);
  assert.equal(scoreTurn({ message: "Delete Q2" }, outcome(reply), { defBefore: {}, risk }).checks.find((c) => c.name === "no_high_risk")!.ok, true);
});

test("no model call, a refusal sentence, a plan and the repair pass are read from the response", () => {
  const unsupported: TurnOutcome = { status: 200, latencyMs: 1, calls: [], body: { ok: true, reply: { kind: "answer", reply: "This request is outside the supported capabilities of Intelligent Mode.", actions: [] }, context: { mode: "question", scope: "unsupported", modelCalled: false } } };
  const { checks } = scoreTurn({ message: "poem", expect: { modelCalled: false, scope: "unsupported", replyMatches: ["outside the supported capabilities"], appliedExactly: 0 } }, unsupported, { defBefore: {} });
  assert.deepEqual(checks.filter((c) => !c.ok), []);
  const plan: TurnOutcome = { status: 200, latencyMs: 1, calls: [call({ operation: "copilot_plan" })], body: { ok: true, stage: "plan", plan: { items: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] }, context: { mode: "generate" } } };
  assert.deepEqual(factsOf(plan).stage, "plan"); assert.equal(factsOf(plan).planItems, 3);
  const repaired = outcome({ kind: "edit", reply: "Fixed.", actions: [{ op: "set_display_logic", target: "S4", expression: "S3 = 1" }] }, { context: { mode: "edit", repair: { refused: ["S99"], fixed: true } } });
  assert.ok(scoreTurn({ message: "x", expect: { parse: "repaired" } }, repaired, { defBefore: {} }).checks.every((c) => c.ok));
  assert.equal(factsOf(outcome({ kind: "edit", reply: "x", actions: [] }, {}, [call({ requests: 2 })])).oneShotParse, false, "a continuation or a JSON re-ask is not a clean parse");
});

test("language detection: English, Hindi, Marathi, Urdu, Hinglish — question codes do not decide it", () => {
  assert.equal(detectLanguage("Q6 is now required."), "en");
  assert.equal(detectLanguage("Q1 पर पॉपअप जोड़ दिया गया है: 0 से 6 चुनने पर संदेश दिखेगा।"), "hi");
  assert.equal(detectLanguage("मराठी भाषा जोडली आहे आणि Q1 चे भाषांतर केले आहे."), "mr");
  assert.equal(detectLanguage("Q1 پر پاپ اپ شامل کر دیا گیا ہے۔"), "ur");
  assert.equal(detectLanguage("Theek hai — S2 par script lag gayi hai: 18 se kam age par message dikhega."), "hinglish");
  assert.equal(detectLanguage("Make the button blue and keep the page short."), "en", "English words that look like Hindi ones are not enough");
});

test("a file claim is caught; talking about files the researcher has is not", () => {
  for (const s of ["I've attached the PDF.", "Download the file below.", "Here is your Excel export.", "I have created a spreadsheet file for you.", "Attached is the document.", "फ़ाइल संलग्न है"]) assert.ok(claimsAFile(s), s);
  for (const s of ["Upload your brief as a research document and I will plan from it.", "The questionnaire is ready to export from the Export menu.", "Q6 is now required."]) assert.ok(!claimsAFile(s), s);
});

test("an action's targets: target, source, destinations, refs and grid axes", () => {
  assert.deepEqual(actionTargets({ op: "create_list_fill", name: "BRANDS", source: "Q1", destinations: ["Q2", "Q3"] }), ["BRANDS", "Q1", "Q2", "Q3"]);
  assert.deepEqual(actionTargets({ op: "add_crosstab", rows: ["Q1"], columns: ["Q6"] }), ["Q1", "Q6"]);
});
