import { test } from "node:test";
import assert from "node:assert/strict";
import { variableMetadata, type VariableMeta } from "./dataset.js";
import { allQuestionsTable, applyTablePreset, itemTableFor, tabulableVariables, variableGroups } from "./tablePresets.js";
import type { AnalysisDefinition } from "./types.js";
import { def } from "./analyses/fixture.js";

const vars = variableMetadata(def);
const spec = { environment: "LIVE" as const, dataset: "all" as const };

test("every question that can be tabulated, minus the banner, in one stacked banner table", () => {
  const names = tabulableVariables(vars).map((v) => v.name);
  assert.ok(names.includes("SAT") && names.includes("AGE") && names.includes("ITEMS_a"));
  assert.ok(!names.includes("TEXT"), "open text is not tabulated");
  assert.ok(!names.includes("ITEMS"), "a grid's parent is not a column of data");
  assert.ok(names.every((n) => !n.startsWith("_")), "no system variables");
  const p = allQuestionsTable(vars, ["GENDER"]);
  assert.ok(!p.rows.includes("GENDER"));
  assert.equal(p.rows.length, names.length - 1);
  assert.deepEqual(p.options, { layout: "banner", stackRows: true });
});

test("the sets that ask one thing many times: a grid's statements, a loop's passes", () => {
  const grid = variableGroups(vars).find((g) => g.kind === "grid" && g.questionId === "q_items")!;
  assert.deepEqual(grid.variables, ["ITEMS_a", "ITEMS_b", "ITEMS_c"]);
  assert.equal(grid.nps, false);
  const m = (p: number): VariableMeta => ({ name: `REC_${p}`, label: `Q7 — Recommend (brand ${p})`, role: "scale", questionId: "q7", questionCode: "Q7", derived: false, hidden: false, nps: true, loopId: "L", loopVar: "brand", iteration: p });
  const loops = variableGroups([m(1), m(2), m(3), { name: "LOOP_BRAND_ITEM_1_CODE", label: "x", role: "categorical", derived: true, hidden: true, loopId: "L", iteration: 1 }]);
  assert.equal(loops.length, 1);
  assert.deepEqual([loops[0].kind, loops[0].label, loops[0].size, loops[0].nps], ["loop", "Q7 — Recommend", 3, true]);
  assert.deepEqual(itemTableFor(loops[0], ["SEG"]).options, { layout: "items", itemStat: "nps" }, "an NPS loop against a banner leads with NPS");
  assert.deepEqual(itemTableFor(loops[0]).options, { layout: "items" });
});

test("a preset replaces rows, columns and layout and keeps the table's other settings", () => {
  const before: AnalysisDefinition = { name: "t", kind: "crosstab", dataset: spec, variables: [], rows: ["SAT"], columns: ["GENDER"], options: { decimals: 0, minBase: 30, layout: "items", itemStat: "mean", transpose: true } };
  const after = applyTablePreset(before, allQuestionsTable(vars, ["GENDER"]));
  assert.equal(after.options!.decimals, 0); assert.equal(after.options!.minBase, 30);
  assert.equal(after.options!.layout, "banner"); assert.equal(after.options!.stackRows, true);
  assert.ok(!("itemStat" in after.options!) && !("transpose" in after.options!), "the item layout's own switches leave with it");
});
