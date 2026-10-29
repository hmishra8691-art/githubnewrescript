import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import {
  readGenerationRequest, normalizeOutline, fallbackOutline, buildSkeleton, planBatches, splitSlots, planEditBatches, generationPolicyFrom,
  normalizeBatchActions, checkBatch, seededIds, orderMoves, slotPlacement, questionDigest, duplicateTexts, referencedCodes, DEFAULT_GENERATION_POLICY, type SkeletonSlot,
} from "./generationPlan.js";
import { validateSurveyDeliverable, parseCompletionCriteria, compactCodes, expandCodes } from "./deliverableValidation.js";
import { listBlocks } from "./blocks.js";

/*
 * LARGE GENERATION AS SMALL STEPS (K2, 2026-10-25): the request read for its OUTPUT size, an outline that adds up,
 * a skeleton that fixes codes / variables / blocks before any model call, adaptive batches, and the batch check.
 */

const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "T" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });

test("the request is read for its output size, kind and complexity — English and Hindi", () => {
  const a = readGenerationRequest("Create a 300-question survey on streaming with display logic, skips, quotas and randomization", empty());
  assert.equal(a.kind, "generate"); assert.equal(a.count, 300); assert.equal(a.hints.logic, true); assert.equal(a.hints.quotas, true); assert.equal(a.hints.randomization, true); assert.equal(a.assessment, false);
  const upsc = readGenerationRequest("UPSC प्रीलिम्स के लिए 100 प्रश्न बनाओ, General Studies, answer key के साथ", empty());
  assert.equal(upsc.count, 100); assert.equal(upsc.assessment, true); assert.equal(upsc.kind, "generate");
  const md = readGenerationRequest("Design a MaxDiff study for smartphone features", empty());
  assert.equal(md.kind, "methods"); assert.equal(md.method, "maxdiff");
  const cbc = readGenerationRequest("Set up a CBC conjoint for electric scooters", empty());
  assert.equal(cbc.method, "cbc");
  assert.equal(readGenerationRequest("Add an NPS question", empty()).kind, "none");
  assert.equal(readGenerationRequest("Translate the survey to Urdu", empty()).translation, true);
});

test("a bulk edit: every question, or a range Q20–Q80, on a survey that has them", () => {
  let def = empty();
  def = applySurveyActions(def, [{ op: "create_block", title: "B" } as SurveyAction, ...Array.from({ length: 90 }, (_, i) => ({ op: "create_question", type: "single", text: `Question ${i + 1} about things?`, options: ["A", "B"] }) as SurveyAction)], { ids: seededIds("x") }).def;
  const all = readGenerationRequest("Add an explanation to every question", def);
  assert.equal(all.kind, "bulk_edit"); assert.equal(all.targets.length, 90); assert.equal(all.editKind, "text");
  const range = readGenerationRequest("add display logic to Q20–Q80", def);
  assert.equal(range.kind, "bulk_edit"); assert.equal(range.targets.length, 61); assert.equal(range.targets[0], "Q20"); assert.equal(range.editKind, "logic");
  const opts = readGenerationRequest("rewrite all options to be shorter", def);
  assert.equal(opts.editKind, "options");
  const batches = planEditBatches(def, range.targets, DEFAULT_GENERATION_POLICY, "logic");
  assert.deepEqual(batches.flat(), range.targets);
  assert.ok(batches.every((b) => b.length <= DEFAULT_GENERATION_POLICY.logicBatch));
});

test("the outline adds up EXACTLY to the count asked for; titles unique; unknown randomize titles dropped", () => {
  const o = normalizeOutline({ sections: [{ title: "Screening", count: 7 }, { title: "Brand", count: 50, complexity: "complex" }, { title: "Brand", count: 50 }, { title: "Profile", count: 3 }], randomize: ["Brand", "Nope"], quotas: ["gender"] }, 250)!;
  assert.equal(o.sections.reduce((n, s) => n + s.count, 0), 250);
  assert.deepEqual(o.sections.map((s) => s.title), ["Screening", "Brand", "Brand (2)", "Profile"]);
  assert.equal(o.sections[1].complexity, "complex");
  assert.deepEqual(o.randomize, ["Brand"]);
  assert.ok(o.sections.every((s) => s.count >= 1));
  assert.equal(normalizeOutline({ sections: [] }, 100), null);
  assert.equal(normalizeOutline("prose", 100), null);
  const f = fallbackOutline(300, { hints: { logic: true, grids: false, scripts: false, quotas: true, randomization: true, piping: false, calculations: false }, assessment: false });
  assert.equal(f.sections.reduce((n, s) => n + s.count, 0), 300);
  assert.equal(f.sections[0].title, "Screening"); assert.equal(f.sections[f.sections.length - 1].title, "Profile");
  assert.ok(f.randomize.length >= 2);
  const exam = fallbackOutline(100, { hints: { logic: false, grids: false, scripts: false, quotas: false, randomization: false, piping: false, calculations: false }, assessment: true });
  assert.equal(exam.sections.reduce((n, s) => n + s.count, 0), 100);
});

test("the skeleton: codes continue after the survey's own, skip anything taken, blocks never collide — 250 questions", () => {
  let def = empty();
  def = applySurveyActions(def, [{ op: "create_block", title: "Screening" } as SurveyAction, { op: "create_question", type: "single", text: "x?", options: ["a", "b"], code: "Q3" } as SurveyAction, { op: "create_question", type: "single", text: "y?", options: ["a", "b"], code: "Q5", variable: "Q6" } as SurveyAction], { ids: seededIds("s") }).def;
  const o = normalizeOutline({ sections: [{ title: "Screening", count: 10 }, { title: "Main", count: 240, complexity: "complex" }] }, 250)!;
  const sk = buildSkeleton(o, def);
  assert.equal(sk.slots.length, 250);
  assert.equal(sk.slots[0].code, "Q7", "after Q5 (and the variable Q6)");
  assert.equal(new Set(sk.slots.map((s) => s.code)).size, 250);
  assert.ok(sk.slots.every((s) => s.variable === s.code));
  assert.deepEqual(sk.blocks.map((b) => b.title), ["Screening (2)", "Main"]);
  assert.ok(sk.slots.slice(0, 10).every((s) => s.block === "Screening (2)"));
  /* deterministic: the same outline on the same survey → the same skeleton */
  assert.deepEqual(buildSkeleton(o, def), sk);
});

test("batches adapt: ~20 simple or ~6 complex per call; a mostly-full batch closes at a section boundary; env policy clamped", () => {
  const o = normalizeOutline({ sections: [{ title: "S", count: 45 }, { title: "Grid", count: 30, complexity: "complex" }, { title: "P", count: 25 }] }, 100)!;
  const sk = buildSkeleton(o, empty());
  const b = planBatches(sk.slots);
  assert.deepEqual(b.flat().map((s) => s.code), sk.slots.map((s) => s.code), "every slot once, in order");
  for (const batch of b) {
    const complex = batch.filter((s) => s.complexity === "complex").length, simple = batch.length - complex;
    assert.ok(complex / 6 + simple / 20 <= 1 + 1e-9, `batch of ${simple} simple + ${complex} complex is within one unit`);
    assert.ok(!(complex && simple), "complex and simple questions are not mixed in one call");
  }
  assert.equal(b.filter((x) => x[0].complexity === "complex").length, 5, "30 complex questions → 5 calls of 6");
  assert.equal(b.filter((x) => x[0].complexity === "simple").reduce((n, x) => n + x.length, 0), 70);
  const p = generationPolicyFrom({ TASK_BATCH_SIMPLE: "500", TASK_BATCH_COMPLEX: "1", TASK_BATCH_EDIT: "x" });
  assert.equal(p.simpleBatch, 40); assert.equal(p.complexBatch, 2); assert.equal(p.editBatch, DEFAULT_GENERATION_POLICY.editBatch);
  const small = planBatches(sk.slots, { ...DEFAULT_GENERATION_POLICY, simpleBatch: 15, complexBatch: 5 });
  assert.ok(small.length > b.length);
});

test("a 250-question plan: stable codes, ≤ 25 per batch, splitting halves a batch and never loses a slot", () => {
  const sk = buildSkeleton(fallbackOutline(250, { hints: { logic: true, grids: true, scripts: false, quotas: false, randomization: false, piping: false, calculations: false }, assessment: false }), empty());
  const b = planBatches(sk.slots);
  assert.ok(b.length >= 10 && b.length <= 60, `${b.length} batches`);
  assert.ok(b.every((x) => x.length <= 25));
  const [l, r] = splitSlots(b[0])!;
  assert.deepEqual([...l, ...r], b[0]);
  assert.ok(Math.abs(l.length - r.length) <= 1);
  assert.equal(splitSlots([b[0][0]]), null);
});

const slotsOf = (codes: string[], block: string): SkeletonSlot[] => codes.map((code, i) => ({ n: i + 1, code, variable: code, block, section: 0, complexity: "simple" }));

test("normalizeBatchActions: the i-th question takes the i-th slot's code, variable and block; the model's own codes in its logic are rewritten; forbidden ops and extras dropped", () => {
  const slots = slotsOf(["Q37", "Q38"], "Brand");
  const n = normalizeBatchActions({ actions: [
    { op: "create_block", title: "Mine" },
    { op: "create_question", ref: "AWARE", code: "Q1", type: "single", text: "Which brands do you know?", options: ["A", "B"], after: "Q0" },
    { op: "create_question", code: "Q2", type: "single", text: "Which brand do you prefer?", options: ["A", "B"] },
    { op: "set_display_logic", target: "Q2", expression: "AWARE = 1 OR Q1 = 2" },
    { op: "create_question", type: "text", text: "An extra one" },
    { op: "delete_question", target: "Q9" },
  ] }, slots);
  assert.deepEqual(n.filled, ["Q37", "Q38"]); assert.deepEqual(n.missing, []);
  const creates = n.actions.filter((a) => a.op === "create_question") as Extract<SurveyAction, { op: "create_question" }>[];
  assert.deepEqual(creates.map((c) => [c.code, c.variable, c.block]), [["Q37", "Q37", "Brand"], ["Q38", "Q38", "Brand"]]);
  assert.ok(!creates.some((c) => "after" in c && c.after));
  const logic = n.actions.find((a) => a.op === "set_display_logic") as { target: string; expression: string };
  assert.equal(logic.target, "Q38"); assert.equal(logic.expression, "Q37 = 1 OR Q37 = 2");
  assert.ok(n.notes.some((x) => /create_block/.test(x)) && n.notes.some((x) => /delete_question/.test(x)) && n.notes.some((x) => /extra question/.test(x)));
  const short = normalizeBatchActions([{ op: "create_question", type: "single", text: "Only one", options: ["a", "b"] }], slots);
  assert.deepEqual(short.missing, ["Q38"]);
});

test("checkBatch: the engine's own gate on the draft — a valid batch passes; a missing option list, a missing slot, a bad reference and a duplicate are each named by code", () => {
  const base = applySurveyActions(empty(), [{ op: "create_block", title: "Brand" } as SurveyAction, { op: "create_question", code: "Q1", type: "single", text: "Have you heard of brand X?", options: ["Yes", "No"], block: "Brand" } as SurveyAction], { ids: seededIds("b") }).def;
  const slots = slotsOf(["Q2", "Q3"], "Brand");
  const good = normalizeBatchActions([{ op: "create_question", type: "single", text: "How often do you buy brand X?", options: ["Often", "Rarely"] }, { op: "create_question", type: "multi", text: "Where do you buy it?", options: ["Online", "Store"] }, { op: "set_display_logic", target: "Q3", expression: "Q2 = 1 AND (Q1 = 1 OR NOT Q1 = 2)" }], slots);
  const ok = checkBatch(base, good.actions, slots, { seed: "t1" });
  assert.equal(ok.ok, true, ok.errors.join("; "));
  assert.equal(ok.def.questions.length, 3);
  assert.equal(listBlocks(ok.def.flow as unknown[]).find((b) => b.title === "Brand")!.pages.flatMap((p) => p.node.questionIds).length, 3);
  /* the same batch on the same draft: the same result (deterministic ids) */
  assert.deepEqual(checkBatch(base, good.actions, slots, { seed: "t1" }).def, ok.def);

  const bad = normalizeBatchActions([{ op: "create_question", type: "single", text: "Have you heard of brand X?", options: ["Yes", "No"] }, { op: "create_question", type: "single", text: "Which one do you prefer?" }, { op: "set_display_logic", target: "Q2", expression: "Q99 = 1" }], slots);
  const r = checkBatch(base, bad.actions, slots, { seed: "t2" });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.kind === "missing_options" && p.code === "Q3"), "Q3 has no options (refused by the gate)");
  assert.ok(r.problems.some((p) => p.kind === "missing_code" && p.code === "Q3"), "…so Q3 was not written");
  assert.ok(r.problems.some((p) => p.kind === "duplicate_text" && p.code === "Q2"), "Q2 repeats Q1");
  assert.ok(r.errors.some((e) => /Q99/.test(e)), "the bad reference is refused by the gate");
  const short = normalizeBatchActions([{ op: "create_question", type: "single", text: "Only one here?", options: ["a", "b"] }], slots);
  assert.ok(checkBatch(base, short.actions, slots, { seed: "t3" }).problems.some((p) => p.kind === "missing_code" && p.code === "Q3"));
});

test("checkBatch touchOnly: an edit that changes a question outside its range is an error", () => {
  const base = applySurveyActions(empty(), [{ op: "create_block", title: "B" } as SurveyAction, ...["Q1", "Q2", "Q3"].map((code) => ({ op: "create_question", code, type: "single", text: `Text ${code} here please?`, options: ["a", "b"] }) as SurveyAction)], { ids: seededIds("c") }).def;
  const r = checkBatch(base, [{ op: "update_question", target: "Q1", instruction: "ok" } as SurveyAction, { op: "update_question", target: "Q3", instruction: "not mine" } as SurveyAction], [], { touchOnly: ["Q1", "Q2"] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /Q3/.test(e) && /outside/.test(e)));
});

test("digests, duplicates and references: deterministic helpers", () => {
  const base = applySurveyActions(empty(), [{ op: "create_block", title: "B" } as SurveyAction, { op: "create_question", code: "Q1", type: "single", text: "Same text for both questions?", options: ["a", "b"] } as SurveyAction, { op: "create_question", code: "Q2", type: "single", text: "Same text for both questions?", options: ["a", "b"] } as SurveyAction], { ids: seededIds("d") }).def;
  assert.deepEqual(duplicateTexts(base), [["Q1", "Q2"]]);
  assert.match(questionDigest(base)[0], /^Q1 \[single_select\] Same text.*\{1=a; 2=b\}$/);
  assert.deepEqual(referencedCodes(base, [{ op: "set_display_logic", target: "Q2", expression: "Q1 = 1" } as SurveyAction]).sort(), ["Q1", "Q2"]);
});

test("completion criteria: parsed from a plan's strings (only listed checks are judged); codes compact and expand", () => {
  const c = parseCompletionCriteria(["questions>=300", "codes:Q1..Q3,Q7", "unique_codes", "logic_refs", "quotas>=1", "randomizers>=1", "design_valid:CBC1@0.6", "design_valid:maxdiff", "assessment:100"]);
  assert.equal(c.minQuestions, 300); assert.deepEqual(c.requiredCodes, ["Q1", "Q2", "Q3", "Q7"]); assert.equal(c.unique, true); assert.equal(c.logic, true);
  assert.equal(c.runtime, false, "not listed → not judged");
  assert.equal(c.minQuotas, 1); assert.equal(c.minRandomizers, 1);
  assert.deepEqual(c.designs, [{ target: "CBC1", minEfficiency: 0.6 }, { kind: "maxdiff" }]);
  assert.deepEqual(c.assessment, { expectedCount: 100, requireExplanations: true, requireTopics: true });
  assert.equal(compactCodes(["Q1", "Q2", "Q3", "Q5", "AGE", "Q6"]), "Q1..Q3,Q5,AGE,Q6");
  assert.deepEqual(expandCodes(compactCodes(Array.from({ length: 300 }, (_, i) => `Q${i + 1}`))).length, 300);
  void validateSurveyDeliverable;
});

test("the planned order restored: a repaired question created at the end of its block is moved back; the order check names it", () => {
  const acts = [{ op: "create_block", title: "B" } as SurveyAction, ...["Q1", "Q2", "Q4", "Q5", "Q3"].map((code) => ({ op: "create_question", code, block: "B", type: "single", text: `Text of ${code} here?`, options: ["a", "b"] }) as SurveyAction)];
  const def = applySurveyActions(empty(), acts, { ids: seededIds("o") }).def;
  const planned = ["Q1", "Q2", "Q3", "Q4", "Q5"];
  const bad = validateSurveyDeliverable(def, parseCompletionCriteria([`codes:${compactCodes(planned)}`]));
  assert.deepEqual(bad.errors.map((e) => [e.kind, e.code]), [["order", "Q3"]]);
  const moves = orderMoves(def, planned);
  const fixed = applySurveyActions(def, moves, { ids: seededIds("o2") }).def;
  assert.deepEqual(listBlocks(fixed.flow as unknown[])[0].pages.flatMap((p) => p.node.questionIds).map((id) => fixed.questions.find((q) => q.id === id)!.code), planned);
  assert.ok(validateSurveyDeliverable(fixed, parseCompletionCriteria([`codes:${compactCodes(planned)}`])).ok);
  assert.deepEqual(orderMoves(fixed, planned), [], "no moves when the order is right");
});

test("slot placement: after the nearest known planned neighbour, else before the next known one; `before` places a created question", () => {
  const plan = ["Q5", "Q6", "Q7", "Q8"];
  assert.deepEqual(slotPlacement("Q7", plan, new Set(["Q5", "Q6"])), { after: "Q6" });
  assert.deepEqual(slotPlacement("Q5", plan, new Set(["Q6", "Q8"])), { before: "Q6" });
  assert.deepEqual(slotPlacement("Q5", plan, new Set()), {});
  const base = applySurveyActions(empty(), [{ op: "create_block", title: "B" } as SurveyAction, ...["Q6", "Q7"].map((code) => ({ op: "create_question", code, block: "B", type: "single", text: `T ${code}?`, options: ["a", "b"] }) as SurveyAction)], { ids: seededIds("p") }).def;
  const n = normalizeBatchActions([{ op: "create_question", type: "single", text: "First of the block?", options: ["a", "b"] }], slotsOf(["Q5"], "B"), { place: (slot, created) => slotPlacement(slot.code, plan, new Set(["Q6", "Q7", ...created])) });
  const r = checkBatch(base, n.actions, slotsOf(["Q5"], "B"), { seed: "p2" });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.deepEqual(listBlocks(r.def.flow as unknown[])[0].pages.flatMap((p) => p.node.questionIds).map((id) => r.def.questions.find((q) => q.id === id)!.code), ["Q5", "Q6", "Q7"]);
});
