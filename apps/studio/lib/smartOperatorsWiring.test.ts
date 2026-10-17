import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ONE OPERATOR ENGINE EVERYWHERE A CONDITION IS BUILT (smart operators, document 16/10).
 *
 * Every Studio surface that edits a comparison rule — display, skip, branch,
 * survey flow, quotas, validation, auto-punch, masking `when`, option logic,
 * loops, list fills, named expressions, response filters … — renders
 * `ConditionEditor` / `OptionalCondition` from ConditionBuilder.tsx, and that
 * one RuleEditor takes its operators from the engine's `operatorMenu`. This
 * guard keeps it that way: no other component builds its own comparison-
 * operator dropdown or asks `operatorsForQuestion` for one.
 */

const ROOT = join(import.meta.dirname, "..", "components");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

test("the condition builder takes its operators from the engine's operatorMenu", () => {
  const src = readFileSync(join(ROOT, "studio", "ConditionBuilder.tsx"), "utf8");
  assert.match(src, /operatorMenu\(s\.def, rule\.source\)/, "RuleEditor asks the engine for the source's menu");
  assert.match(src, /operatorStatus\(s\.def, rule\)/, "…and whether the stored operator still fits");
  assert.match(src, /data-testid="cond-needs-update"/, "a stale operator is marked, not replaced");
  assert.match(src, /ConditionTester/, "the Test condition control is part of every editor");
});

test("no other component builds a comparison-operator dropdown of its own", () => {
  const offenders: string[] = [];
  for (const f of files(ROOT)) {
    if (/ConditionBuilder\.tsx$/.test(f)) continue;
    const src = readFileSync(f, "utf8");
    if (/className="[^"]*\bop-select\b/.test(src) || /data-testid="cond-operator"/.test(src)) offenders.push(`${f}: op-select`);
    if (/\boperatorsForQuestion\(/.test(src)) offenders.push(`${f}: operatorsForQuestion`);
  }
  assert.deepEqual(offenders, []);
});

test("the condition-building surfaces all render the shared editor", () => {
  const hosts = ["FlowNodeEditors", "QuotasPanel", "AutoPunchEditor", "MaskingBuilder", "LoopEditor", "LogicPanel",
    "PropertiesPanel", "OptionLogicEditor", "ListFillPanel", "NamedExpressionsPanel", "QuestionsPanel"];
  for (const h of hosts) {
    const src = readFileSync(join(ROOT, "studio", `${h}.tsx`), "utf8");
    assert.match(src, /\b(ConditionEditor|OptionalCondition)\b/, `${h} edits conditions with the shared editor`);
  }
});
