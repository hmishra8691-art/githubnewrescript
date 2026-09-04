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
