import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { SURVEY_ACTION_OPS } from "@rescript/engine";
import { DEFAULT_BUDGETS, GOLDEN_CASES, LOCAL_INJECTION_CORPUS, adminCases, injectionCases, productionCorpusCases, productionPromptCases, type EvalCategory } from "./cases.ts";
import { fixtureOf } from "./harness.ts";

/* the golden set holds together: unique ids, real fixtures, real ops, every required category, a small admin subset */
const OPS = new Set<string>(SURVEY_ACTION_OPS);

test("ids are unique, fixtures exist, every op named in an expectation is a real action op", () => {
  const ids = GOLDEN_CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of GOLDEN_CASES) {
    assert.ok(fixtureOf(c.fixture), c.id);
    for (const t of c.turns) for (const op of [...(t.expect?.opsPresent ?? []), ...(t.expect?.opsAbsent ?? [])]) assert.ok(OPS.has(op), `${c.id}: ${op} is not an action op`);
  }
});

test("every category the brief names is covered", () => {
  const have = new Set(GOLDEN_CASES.map((c) => c.category));
  for (const cat of ["single_edit", "ux_script", "translation", "long_brief", "staged_generation", "analysis_plan", "methods", "qualitative", "scope", "multi_turn", "undo", "repair"] as EvalCategory[]) assert.ok(have.has(cat), cat);
  for (const lang of ["hinglish", "hi", "ur", "mr"]) assert.ok(GOLDEN_CASES.some((c) => c.turns.some((t) => t.expect?.language === lang)), `a reply-language check for ${lang}`);
  for (const cat of Object.keys(DEFAULT_BUDGETS)) assert.ok(DEFAULT_BUDGETS[cat as EvalCategory].maxCostUsd > 0);
});

test("the admin subset: at most ten cases, no generation, no build", () => {
  const a = adminCases();
  assert.ok(a.length > 0 && a.length <= 10);
  for (const c of a) assert.ok(!c.turns.some((t) => t.stage === "execute" || t.mode === "generate"), c.id);
});

test("injection cases come from E2's corpus when it is in the tree, else from the local minimal set", () => {
  const path = new URL("../../../../packages/engine/src/fixtures/prompt-injection-corpus.json", import.meta.url);
  const corpus = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : LOCAL_INJECTION_CORPUS;
  const cs = injectionCases(corpus);
  assert.ok(cs.length >= 3 && cs.length <= 10);
  assert.ok(cs.every((c) => c.category === "injection" && c.turns[0].inject && c.turns[0].fake && c.turns[0].expect?.noHighRisk));
  assert.ok(new Set(cs.map((c) => c.tags?.find((t) => t.startsWith("payload:")))).size === cs.length);
  assert.equal(injectionCases(LOCAL_INJECTION_CORPUS).length, 3);
});

test("production prompts become single-turn cases scored on the safety invariants", () => {
  const cs = productionPromptCases([{ id: "p1", prompt: "S2 pe JS lagao", expect: { mode: "ux", nonsense: 1 } }, { id: "p2", text: "" }]);
  assert.equal(cs.length, 1);
  assert.deepEqual(cs[0].turns[0].expect, { noHighRisk: true, noFileClaim: true, mode: "ux" });
});

test("E3's corpus: a spread by tag, duplicated prompts once, its survey as the fixture, its route-visible expectations", () => {
  const path = new URL("../copilot/fixtures/productionPrompts.json", import.meta.url);
  const corpus = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { survey: [{ ref: "A", type: "single", text: "a", options: ["x", "y"] }], cases: [
    { id: "1", prompt: "Make A required", context: { questions: 1 }, tags: ["engine"], expect: { scope: "supported", mode: "edit", ux: false, uxOnly: false, guides: {} } },
    { id: "2", prompt: "Make A required", context: { questions: 1 }, tags: ["engine"], expect: { mode: "edit" } },
    { id: "3", prompt: "hindi me translate karo", context: { questions: 0 }, tags: ["#1 translation"], expect: { mode: "question", guides: { translation: true } } },
  ] };
  const all = productionCorpusCases(corpus, 0);
  assert.equal(all.length, new Set(corpus.cases.map((c: { prompt: string }) => c.prompt.trim())).size, "a prompt logged twice is one case");
  const twelve = productionCorpusCases(corpus, 12);
  assert.ok(twelve.length <= 12);
  const tags = new Set(corpus.cases.map((c: { tags: string[] }) => c.tags[0]));
  assert.equal(new Set(twelve.map((c) => c.tags?.[0])).size, Math.min(12, tags.size), "one per tag first");
  for (const c of all) {
    assert.equal(c.category, "production_prompt");
    assert.ok(c.fixture === "blank" || (c.fixture === "spec" && c.fixtureSpec?.length), c.id);
    const e = c.turns[0].expect!;
    assert.ok(e.noHighRisk && e.noFileClaim && e.mode && e.context && "ux" in e.context && "translation" in e.context, c.id);
    assert.ok(c.turns[0].fake, "a neutral fake answer, so the route reports its full reading");
  }
});
