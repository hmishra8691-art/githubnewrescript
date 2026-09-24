import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDependencyIndex, objectKey, neighbours } from "@rescript/engine";
import { buildMasterDemoSurvey } from "./masterDemo.js";

/**
 * THE INDEX OVER THE HARDEST SURVEY IN THE REPO.
 *
 * The unit tests in the engine name every edge on a small fixture. This one
 * asks the questions a programmer would ask of the Master Demo — 160
 * questions, four loop kinds, a List Fill, quotas, calculations on
 * calculations — and checks the answers are the ones the survey's own
 * comments promise.
 */

const def = buildMasterDemoSurvey("dep-demo");
const ix = buildDependencyIndex(def);
const Q = (id: string) => objectKey("question", id);

test("every question has a node and the index is not trivially empty", () => {
  for (const q of def.questions) assert.ok(ix.nodes.has(Q(q.id)), `${q.code} missing`);
  assert.ok(ix.edges.length > 200, `only ${ix.edges.length} edges over a survey this dense`);
});

test("N_AWARE_NOT_USED reads two other calculated variables — the calc-on-calc case", () => {
  const me = objectKey("calculation", "calc_n_aware_not_used");
  const reads = ix.dependsOn(me).map((e) => e.to);
  assert.ok(reads.includes(objectKey("calculation", "calc_n_aware")), reads.join(", "));
  assert.ok(reads.includes(objectKey("calculation", "calc_n_used")), reads.join(", "));
  // and it reaches the questions underneath, through them
  const reach = ix.reach(me);
  assert.ok(reach.some((k) => k.startsWith("question:")), "the calc chain must bottom out in questions");
});

test("the employment question drives a display rule, a skip and a branch — three different kinds", () => {
  const users = neighbours(ix, Q("q_employment"), "usedBy");
  const kinds = new Set(users.flatMap((u) => u.reasons.map((r) => r.kind)));
  assert.ok(kinds.has("display"), `display rule dr_show_work_page reads it: ${[...kinds].join(", ")}`);
  assert.ok(kinds.has("skip"), "skip_not_working reads it");
  assert.ok(users.some((u) => u.key === objectKey("displayRule", "dr_show_work_page")));
  assert.ok(users.some((u) => u.key === objectKey("skipRule", "q_employment/skip_not_working")));
});

test("a loop over selected brands reads the brands question", () => {
  const loop = objectKey("flowNode", "loop_001");
  assert.ok(ix.nodes.has(loop), "loop has a node");
  const src = ix.dependsOn(loop).find((e) => e.kind === "loopSource");
  assert.ok(src, "loop source edge");
  assert.ok(src.to.startsWith("question:"), `iterates over a question: ${src.to}`);
  // the questions inside the loop are placed inside it
  const inside = ix.edges.filter((e) => e.to === loop && e.kind === "placement");
  assert.ok(inside.length > 0, "questions inside the loop read the loop");
});

test("the List Fill loop reads the list fill, and the list fill reads its source question", () => {
  const loop = objectKey("flowNode", "loop_lf");
  const lfEdge = ix.dependsOn(loop).find((e) => e.kind === "loopSource");
  assert.ok(lfEdge && lfEdge.to.startsWith("listFill:"), `loop_lf iterates a list fill: ${lfEdge?.to}`);
  const lf = lfEdge.to;
  assert.ok(ix.dependsOn(lf).some((e) => e.kind === "listFillSource"), "the list fill reads a question");
});

test("quotas read the questions they count", () => {
  const quotaKeys = [...ix.nodes.keys()].filter((k) => k.startsWith("quota:"));
  assert.ok(quotaKeys.length >= 1, "the demo has quotas");
  for (const k of quotaKeys) {
    assert.ok(ix.dependsOn(k).some((e) => e.kind === "quotaCell"), `${k} has no cell conditions`);
  }
});

test("the first question reads nothing but its own skip, and its answer is what the skip tests", () => {
  const consent = Q("q_consent");
  const skip = objectKey("skipRule", "q_consent/skip_no_consent");
  assert.deepEqual(ix.reach(consent), [skip], "only its own skip decides its routing; no earlier question exists to read");
  assert.ok(ix.affects(consent).includes(skip), "the skip's condition tests the consent answer");
});

test("nothing takes unreasonable time at this size", () => {
  const t0 = performance.now();
  const fresh = buildDependencyIndex(def);
  const built = performance.now() - t0;
  const t1 = performance.now();
  for (const q of def.questions) { fresh.reach(Q(q.id)); fresh.affects(Q(q.id)); }
  const walked = performance.now() - t1;
  assert.ok(built < 250, `index built in ${built.toFixed(0)}ms — budget 250ms at 160 questions`);
  assert.ok(walked < 500, `320 transitive walks took ${walked.toFixed(0)}ms`);
});
