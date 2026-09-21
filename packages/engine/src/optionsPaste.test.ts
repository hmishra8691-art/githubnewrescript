import test from "node:test";
import assert from "node:assert/strict";
import { planPaste, parsePastedOptions, optionsToPaste } from "./optionsPaste.js";

const existing = () => [
  { code: "1", label: "Coke", flags: [] as any[], imageUrl: "https://x/coke.png" },
  { code: "2", label: "Pepsi", flags: [] as any[], logic: { anything: true } as any },
  { code: "3", label: "Fanta", flags: [] as any[] },
  { code: "99", label: "None of these", flags: ["none_of_above"] as any[] },
] as any[];

test("parsePastedOptions strips numbering and bullets, honours code<TAB>label", () => {
  const p = parsePastedOptions("1. Alpha\n- Beta\n\n7\tGamma\n• Delta", 4);
  assert.deepEqual(p.map((o) => [o.code, o.label]), [["4", "Alpha"], ["5", "Beta"], ["7", "Gamma"], ["6", "Delta"]]);
});

test("replace keeps identity by code — flags, image, logic survive; the label follows the paste", () => {
  const plan = planPaste(existing(), "2\tPepsi Max\n1\tCoca-Cola\n4\tSprite", "replace");
  assert.deepEqual(plan.options.map((o) => [o.code, o.label]), [["2", "Pepsi Max"], ["1", "Coca-Cola"], ["4", "Sprite"]]);
  assert.equal((plan.options[0].logic as any)?.anything, true);
  assert.equal(plan.options[1].imageUrl, "https://x/coke.png");
  assert.deepEqual({ kept: plan.kept, added: plan.added, removed: plan.removed }, { kept: 2, added: 1, removed: 2 });
  assert.deepEqual(plan.removedCodes, ["3", "99"]);
});

test("replace without codes matches by label, so a re-paste of the same list changes nothing", () => {
  const plan = planPaste(existing(), "Coke\nPepsi\nFanta\nNone of these", "replace");
  assert.deepEqual(plan.options, existing());
  assert.deepEqual({ kept: plan.kept, added: plan.added, removed: plan.removed }, { kept: 4, added: 0, removed: 0 });
  // reorder + one new + one gone
  const plan2 = planPaste(existing(), "fanta\nCoke\nDr Pepper", "replace");
  assert.deepEqual(plan2.options.map((o) => [o.code, o.label]), [["3", "fanta"], ["1", "Coke"], ["100", "Dr Pepper"]]);
  assert.deepEqual(plan2.removedCodes, ["2", "99"]);
});

test("append leaves the existing list alone and never writes a duplicate code", () => {
  const plan = planPaste(existing(), "1\tSprite\nDr Pepper", "append");
  assert.deepEqual(plan.options.slice(0, 4), existing());
  const codes = plan.options.map((o) => String(o.code));
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual(plan.options.slice(4).map((o) => o.label), ["Sprite", "Dr Pepper"]);
  assert.deepEqual({ kept: plan.kept, added: plan.added, removed: plan.removed }, { kept: 4, added: 2, removed: 0 });
});

test("optionsToPaste prints what planPaste reads back as identity", () => {
  const text = optionsToPaste(existing());
  assert.equal(text.split("\n")[0], "1\tCoke");
  const plan = planPaste(existing(), text, "replace");
  assert.deepEqual(plan.options, existing());
  assert.equal(planPaste(existing(), "   \n", "replace").options.length, 4);
});

/*
 * THE REPORT: "When options are pasted directly into the question, the option
 * numbering is starting from 2 instead of 1. Please fix the option numbering
 * so that whenever options are pasted directly, the first option always starts
 * at 1 and subsequent options increment sequentially (1, 2, 3, 4…)."
 *
 * The starter question — one option coded 1 — is exactly where this bit.
 */
test("a replace that keeps nothing numbers from 1, not from the old high-water mark", () => {
  const starter = [{ code: "1", label: "Option 1", flags: [] as any[] }] as any[];
  const plan = planPaste(starter, "Camera quality\nBattery life\nPerformance\nDesign", "replace");
  assert.deepEqual(
    plan.options.map((o) => [String(o.code), o.label]),
    [["1", "Camera quality"], ["2", "Battery life"], ["3", "Performance"], ["4", "Design"]],
  );
  assert.deepEqual({ kept: plan.kept, added: plan.added, removed: plan.removed }, { kept: 0, added: 4, removed: 1 });
});

test("a replace onto an empty list also starts at 1", () => {
  const plan = planPaste([], "Alpha\nBeta", "replace");
  assert.deepEqual(plan.options.map((o) => String(o.code)), ["1", "2"]);
});

/*
 * The other half of the same rule, and why the fix is scoped to "keeps
 * nothing": a paste that KEEPS options must not hand a removed option's code
 * to a different option, or every condition, quota and stored answer naming
 * that code changes meaning underneath the survey.
 */
test("a replace that keeps options never reuses a removed option's code", () => {
  const before = [
    { code: "1", label: "Coke", flags: [] as any[] },
    { code: "2", label: "Pepsi", flags: [] as any[] },
  ] as any[];
  const plan = planPaste(before, "Coke\nDr Pepper", "replace");
  const codes = plan.options.map((o) => String(o.code));
  assert.deepEqual(codes[0], "1");            // Coke kept its identity
  assert.notEqual(codes[1], "2");             // Dr Pepper did NOT inherit Pepsi's code
  assert.deepEqual(plan.removedCodes.map(String), ["2"]);
});
