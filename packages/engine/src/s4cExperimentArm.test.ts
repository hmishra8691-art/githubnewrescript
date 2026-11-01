import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  createResponseState, compileFlow, exactBalanceSlots, balanceSlotsDue, MemoryBalanceStore, claimRequestFor, writeAssignment,
  applyClaimedArms, claimedExperimentArm, seededExperimentArm, experimentArmVariable, balanceVariableForKey, hasExactBalance,
  pickArm, buildVariableDictionary, mulberry32,
} from "./index.js";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";

/* S4c item 4 (RA-08): the A/B experiment arm claimed exactly at page entry (weighted), stored in <VAR>_ARM */

const arms = [{ code: "A", label: "Control", weight: 2 }, { code: "B", label: "Treatment", weight: 1 }, { code: "C", label: "Parked", weight: 0 }];
const def = (armBalance?: object) => SurveyDefinition.parse({
  meta: { id: "ab", code: "AB", title: "AB", version: "1" },
  questions: [
    { id: "q0", code: "Q0", variableName: "Q0", type: "open_text", text: "q0", settings: {} },
    { id: "qx", code: "Q1", variableName: "EXP", type: "experiment", variant: "experimental.ab", text: "exp", settings: { arms, ...(armBalance ? { armBalance } : {}) } },
  ],
  flow: [{ type: "page", id: "p0", questionIds: ["q0"] }, { type: "page", id: "p1", questionIds: ["qx"] }, { type: "end", id: "end", status: "complete" }],
});

test("no armBalance: no slot, no claim, nothing changes (the renderer's seeded draw stays)", () => {
  const d = def();
  assert.equal(hasExactBalance(d), false);
  assert.deepEqual(exactBalanceSlots(d, createResponseState(d, { seed: 3 })), []);
});

test("armBalance.exact: the experiment's page needs the arm: slot arm:<qid>, variable EXP_ARM, weights 2:1, the parked arm excluded", () => {
  const d = def({ exact: true });
  assert.equal(hasExactBalance(d), true);
  const st = createResponseState(d, { seed: 9 });
  const steps = compileFlow(d, st);
  const p1 = steps.find((s) => s.kind === "page" && s.pageId === "p1")!;
  assert.deepEqual((p1 as { balance?: string[] }).balance, ["arm:qx"]);
  const [slot] = balanceSlotsDue(d, st, p1);
  assert.equal(slot!.variable, "EXP_ARM");
  assert.deepEqual(slot!.arms, ["A", "B"]);
  assert.deepEqual(slot!.weights, [2, 1]);
  assert.equal(balanceVariableForKey(d, slot!.key), "EXP_ARM");
  assert.equal(experimentArmVariable({ id: "qx", variableName: "EXP" }, { code: "x1" } as never), "EXP_X1_ARM");
  assert.ok(buildVariableDictionary(d).some((v) => v.name === "EXP_ARM"));
});

test("the fallback is exactly the renderer's seeded draw (FNV + mulberry32 + pickArm)", () => {
  const d = def({ exact: true });
  const q = d.questions[1]!;
  for (let seed = 1; seed < 200; seed++) {
    const s = `${seed}:${q.id}:arm`;
    let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    const want = pickArm(arms as never, mulberry32(h >>> 0)())?.code;
    assert.equal(seededExperimentArm(q, seed), String(want));
  }
});

test("1,200 respondents through the claim at page entry: arms exactly 800 / 400 (weights 2:1); the answer IS the claimed arm", () => {
  const d = def({ exact: true });
  const store = new MemoryBalanceStore();
  const n: Record<string, number> = {};
  for (let i = 1; i <= 1200; i++) {
    const st = createResponseState(d, { seed: i * 17, sessionId: `ab-session-${i}` });
    const p1 = compileFlow(d, st).find((s) => s.kind === "page" && s.pageId === "p1")!;
    for (const slot of balanceSlotsDue(d, st, p1)) writeAssignment(st, slot, store.claim(claimRequestFor(slot, "ab", st.sessionId, st.seed)));
    assert.deepEqual(applyClaimedArms(d, st, p1), ["qx"]);
    assert.equal(st.answers.qx, st.calculated.EXP_ARM);
    assert.equal(claimedExperimentArm(st, d.questions[1]!), st.calculated.EXP_ARM);
    n[String(st.answers.qx)] = (n[String(st.answers.qx)] ?? 0) + 1;
    assert.deepEqual(applyClaimedArms(d, st, p1), [], "idempotent");
  }
  assert.deepEqual(n, { A: 800, B: 400 });
});

test("IM: update_question settings armBalance on an A/B experiment", () => {
  const d = def();
  const r = applySurveyActions(d, coerceSurveyActions([{ op: "update_question", target: "Q1", settings: { armBalance: { exact: true } } }]).actions, { ids: (p: string) => `${p}_1` });
  assert.equal(r.results[0]!.ok, true, r.results[0]!.error);
  assert.equal((r.def.questions[1]!.settings as { armBalance?: { exact: boolean } }).armBalance?.exact, true);
});
