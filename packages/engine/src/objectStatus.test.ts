import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import { objectStatus, runQualityCheck, objectKey, worseOf } from "./index.js";

/**
 * A STATUS DOT MUST SIT ON THE OBJECT THE PROBLEM IS ABOUT.
 *
 * `runQualityCheck` groups by area for the publish gate. `objectStatus`
 * regroups the SAME issues by object for badges. The two invariants: nothing
 * the gate reports goes missing, and every issue lands on the most specific
 * object it can be pinned to.
 */

const sound = () =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "Age?" },
      { id: "q2", code: "Q2", variableName: "CITY", type: "text", text: "City?" },
      { id: "q3", code: "Q3", variableName: "WHY", type: "text", text: "Why?" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2"] },
      { type: "page", id: "p2", questionIds: ["q3"] },
      { type: "end", id: "e1", status: "complete" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

const Q = (id: string) => objectKey("question", id);

test("a sound survey has no statuses and nothing unattributed", () => {
  const st = objectStatus(sound());
  assert.equal(st.byKey.size, 0, [...st.byKey.keys()].join(", "));
  assert.deepEqual(st.unattributed, []);
  assert.equal(st.statusOf(Q("q1")).level, "ok");
});

test("a question's own logic problem lands on that question", () => {
  const def = sound();
  // Q3 shown when a question that does not exist equals 1 — a per-question lint error
  def.questions[2] = { ...def.questions[2], displayLogic: cond.rule("q_missing", "eq", 1) } as never;
  const st = objectStatus(def);
  const s = st.statusOf(Q("q3"));
  assert.notEqual(s.level, "ok", "Q3 must carry the issue");
  assert.ok(s.issues.some((i) => /q_missing|unknown|not found|does not exist/i.test(i.message)),
    s.issues.map((i) => i.message).join(" | "));
  assert.equal(st.statusOf(Q("q1")).level, "ok", "an unrelated question stays healthy");
});

test("a duplicate variable lands on BOTH questions that write it", () => {
  const def = sound();
  def.questions[1] = { ...def.questions[1], variableName: "AGE" } as never;
  const st = objectStatus(def);
  assert.equal(st.statusOf(Q("q1")).level, "error", "the first owner");
  assert.equal(st.statusOf(Q("q2")).level, "error", "the second owner");
  assert.ok(st.statusOf(Q("q1")).issues.some((i) => /duplicate variable/i.test(i.message)));
  assert.equal(st.unattributed.filter((i) => /duplicate variable/i.test(i.message)).length, 0,
    "the duplicate must not fall through to unattributed");
});

test("a flow structure problem lands on the flow node, not on the whole flow", () => {
  const def = sound();
  // a page after the End is unreachable by falling through
  def.flow = [
    { type: "page", id: "p1", questionIds: ["q1", "q2"] },
    { type: "end", id: "e1", status: "complete" },
    { type: "page", id: "p2", questionIds: ["q3"] },
  ] as never;
  const st = objectStatus(def);
  const key = objectKey("flowNode", "p2");
  const s = st.statusOf(key);
  assert.notEqual(s.level, "ok", `p2 should carry the unreachable warning; keys: ${[...st.byKey.keys()].join(", ")}`);
  assert.ok(s.issues.every((i) => i.objectKey === key), "the issue carries its key");
});

test("a dead display rule lands on the rule", () => {
  const def = sound();
  def.displayRules = [{ id: "dr1", label: "Ghost", target: { kind: "question", ref: "q_gone" }, action: "show", when: cond.rule("q1", "gte", 18) }] as never;
  const st = objectStatus(def);
  const s = st.statusOf(objectKey("displayRule", "dr1"));
  assert.notEqual(s.level, "ok", [...st.byKey.keys()].join(", "));
});

test("nothing the gate reports is lost: attributed + unattributed = every issue", () => {
  const def = sound();
  def.questions[1] = { ...def.questions[1], variableName: "AGE" } as never;
  def.questions[2] = { ...def.questions[2], displayLogic: cond.rule("q_missing", "eq", 1) } as never;
  def.deployment = { clientSlug: "", studySlug: "" } as never;
  const q = runQualityCheck(def);
  const st = objectStatus(def, q);
  const total = q.areas.reduce((n, a) => n + a.issues.length, 0);
  // a duplicate-variable issue is recorded once per owner, so count distinct issue objects
  const seen = new Set<unknown>();
  for (const s of st.byKey.values()) for (const i of s.issues) seen.add(i);
  for (const i of st.unattributed) seen.add(i);
  assert.equal(seen.size, total, `gate reported ${total}, status map holds ${seen.size}`);
  // the deployment problem has no object and stays visible as unattributed
  assert.ok(st.unattributed.some((i) => i.path === "deployment"));
});

test("worstOf gives a block the colour of its worst question", () => {
  const def = sound();
  def.questions[2] = { ...def.questions[2], displayLogic: cond.rule("q_missing", "eq", 1) } as never;
  const st = objectStatus(def);
  assert.equal(st.worstOf([Q("q1"), Q("q2")]), "ok");
  assert.notEqual(st.worstOf([Q("q1"), Q("q3")]), "ok");
  assert.equal(worseOf("warning", "error"), "error");
  assert.equal(worseOf("ok", "warning"), "warning");
});
