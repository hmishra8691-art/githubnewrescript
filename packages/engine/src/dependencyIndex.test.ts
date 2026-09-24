import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import {
  buildDependencyIndex, neighbours, objectKey, parseObjectKey,
  dependencyGraph, dependentsGraph,
} from "./index.js";
import type { DependencyEdge, EdgeKind } from "./index.js";

/**
 * THE DEPENDENCY INDEX SAYS WHO READS WHOM, AND WHY.
 *
 * Every test here names the exact edge it expects — reader, read, kind and
 * path — because the point of the index over `dependencyGraph` is that the
 * edge carries its reason. A test that only checked "Q7 depends on Q3" would
 * pass against the lossy graph too.
 */

const survey = () =>
  SurveyDefinition.parse({
    meta: { id: "svy", code: "DEP", title: "Dependencies" },
    questions: [
      { id: "q_age", code: "Q1", variableName: "AGE", type: "numeric", text: "Age?" },
      {
        id: "q_brands", code: "Q2", variableName: "BRANDS", type: "multi_select", text: "Brands?",
        options: [{ code: "A", label: "Apple" }, { code: "B", label: "Bosch" }, { code: "C", label: "Candy" }],
      },
      {
        id: "q_fav", code: "Q3", variableName: "FAV", type: "single_select", text: "Favourite of {{Q2}}?",
        options: [{ code: "A", label: "Apple" }, { code: "B", label: "Bosch" }, { code: "C", label: "Candy" }],
        // reads Q2 through carry-forward
        carryForward: { sourceQuestionId: "q_brands", mode: "selected" },
      },
      {
        id: "q_why", code: "Q4", variableName: "WHY", type: "text", text: "Why?",
        displayLogic: cond.rule("q_fav", "eq", "A"),
        skipLogic: [{ id: "sk1", when: cond.rule("q_age", "lt", 18), target: { kind: "question", ref: "q_end_note" } }],
      },
      { id: "q_spend", code: "Q5", variableName: "SPEND", type: "numeric", text: "Spend?" },
      {
        id: "q_check", code: "Q6", variableName: "CHECK", type: "numeric", text: "Confirm spend",
        validation: [{ kind: "custom_expression", value: "CHECK <= SPEND", message: "Not more than {{Q5}}" }],
      },
      { id: "q_end_note", code: "Q7", variableName: "NOTE", type: "text", text: "Anything else?" },
      { id: "q_hidden", code: "Q8", variableName: "HID", type: "text", text: "Never referenced" },
    ],
    displayRules: [
      { id: "dr1", label: "Adults only", target: { kind: "question", ref: "q_spend" }, action: "show", when: cond.rule("q_age", "gte", 18) },
    ],
    calculations: [
      { id: "c_total", targetVariable: "TOTAL", expression: "SPEND * 12" },
      { id: "c_band", targetVariable: "BAND", expression: "TOTAL / 100" },
    ],
    namedExpressions: [
      { id: "ne1", name: "IS_ADULT", when: cond.rule("q_age", "gte", 18) },
    ],
    quotas: [
      { id: "qt1", name: "Adults", cells: [{ id: "cell1", label: "18+", when: cond.rule("q_age", "gte", 18), limit: 100 }] },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q_age", "q_brands"] },
      {
        type: "branch", id: "br1", title: "Has a favourite",
        branches: [{ id: "arm1", label: "picked", when: cond.rule("q_brands", "selected", "A"), children: [
          { type: "page", id: "p2", questionIds: ["q_fav", "q_why"] },
        ] }],
        otherwise: [{ type: "page", id: "p3", questionIds: ["q_spend", "q_check"] }],
      },
      { type: "block", id: "blk_plain", title: "Plain block", children: [{ type: "page", id: "p4", questionIds: ["q_end_note", "q_hidden"] }] },
      { type: "end", id: "e1", status: "complete" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

const Q = (id: string) => objectKey("question", id);

function edge(edges: DependencyEdge[], from: string, to: string, kind?: EdgeKind): DependencyEdge | undefined {
  return edges.find((e) => e.from === from && e.to === to && (!kind || e.kind === kind));
}

test("display logic: the gated question reads the gate, with kind and path", () => {
  const ix = buildDependencyIndex(survey());
  const e = edge(ix.edges, Q("q_why"), Q("q_fav"), "display");
  assert.ok(e, "Q4's display logic reads Q3");
  assert.match(e.path, /^questions\[3\]\.displayLogic/);
  assert.equal(e.label, "Q4 — display logic");
});

test("a named display rule is its own node: it reads its condition and its target reads it", () => {
  const ix = buildDependencyIndex(survey());
  const rule = objectKey("displayRule", "dr1");
  assert.ok(ix.nodes.has(rule), "the rule has a node");
  assert.ok(edge(ix.edges, rule, Q("q_age"), "display"), "rule reads Q1");
  const t = edge(ix.edges, Q("q_spend"), rule, "target");
  assert.ok(t, "Q5's visibility is decided by the rule");
  assert.match(t.label, /shows this/);
  // and so, transitively, Q5 reaches Q1 THROUGH the rule — the rule comes first, nearest-first
  const r = ix.reach(Q("q_spend"));
  assert.ok(r.indexOf(rule) >= 0 && r.indexOf(rule) < r.indexOf(Q("q_age")), r.join(", "));
});

test("a skip rule is a node: it reads its condition and its owner, and the jump target reads it", () => {
  const ix = buildDependencyIndex(survey());
  const sk = objectKey("skipRule", "q_why/sk1");
  assert.ok(ix.nodes.has(sk));
  assert.ok(edge(ix.edges, sk, Q("q_age"), "skip"), "skip condition reads Q1");
  assert.ok(edge(ix.edges, Q("q_why"), sk, "skip"), "the owner's routing is decided by the skip");
  assert.ok(edge(ix.edges, Q("q_end_note"), sk, "target"), "the jump target reads the skip");
  // so "what does Q1 affect?" answers: the skip, then Q4 (its owner) and Q7 (its target)
  const aff = ix.affects(Q("q_age"));
  assert.ok(aff.includes(sk) && aff.includes(Q("q_why")) && aff.includes(Q("q_end_note")), aff.join(", "));
});

test("calculations chain: BAND reads TOTAL reads SPEND, each edge separate", () => {
  const ix = buildDependencyIndex(survey());
  const total = objectKey("calculation", "c_total");
  const band = objectKey("calculation", "c_band");
  assert.ok(edge(ix.edges, total, Q("q_spend"), "calculation"));
  assert.ok(edge(ix.edges, band, total, "calculation"), "a calc reading a calc is an edge to the CALC node, not flattened to the question");
  const r = ix.reach(band);
  assert.equal(r[0], total, "the nearest thing BAND reads is TOTAL");
  assert.equal(r[1], Q("q_spend"), "then, through TOTAL, SPEND");
  assert.ok(ix.affects(Q("q_spend")).includes(band), "changing SPEND affects BAND");
});

test("validation: a custom expression and a piped message both read", () => {
  const ix = buildDependencyIndex(survey());
  const byKind = ix.dependsOn(Q("q_check")).map((e) => `${e.kind}→${parseObjectKey(e.to).id}`);
  assert.ok(byKind.includes("validation→q_spend"), `expected a validation edge to Q5, saw ${byKind.join(", ")}`);
  const paths = ix.dependsOn(Q("q_check")).map((e) => e.path);
  assert.ok(paths.some((p) => p.endsWith(".value")), "the expression string");
  assert.ok(paths.some((p) => p.endsWith(".message")), "the piped message");
});

test("piping and carry-forward are edges with their own kinds", () => {
  const ix = buildDependencyIndex(survey());
  assert.ok(edge(ix.edges, Q("q_fav"), Q("q_brands"), "piping"), "{{Q2}} in Q3's text");
  assert.ok(edge(ix.edges, Q("q_fav"), Q("q_brands"), "carryForward"));
  // two different reasons, grouped as one neighbour with two reasons
  const n = neighbours(ix, Q("q_fav"), "dependsOn").find((x) => x.key === Q("q_brands"));
  assert.ok(n);
  assert.deepEqual(n.reasons.map((r) => r.kind).sort(), ["carryForward", "piping"]);
});

test("a branch is a node; questions under a conditional arm are placed inside it", () => {
  const ix = buildDependencyIndex(survey());
  const br = objectKey("flowNode", "br1");
  assert.ok(edge(ix.edges, br, Q("q_brands"), "flowCondition"), "the arm's condition reads Q2");
  assert.ok(edge(ix.edges, Q("q_fav"), br, "placement"), "Q3 sits inside the branch");
  assert.ok(edge(ix.edges, Q("q_spend"), br, "placement"), "the otherwise arm counts too");
  // so Q2 affects everything routed by the branch
  const aff = ix.affects(Q("q_brands"));
  for (const id of ["q_fav", "q_why", "q_spend", "q_check"]) assert.ok(aff.includes(Q(id)), `${id} should be affected by Q2`);
});

test("an UNconditional block is grouping, not dependency", () => {
  const ix = buildDependencyIndex(survey());
  assert.ok(!ix.nodes.has(objectKey("flowNode", "blk_plain")), "a plain block has no node");
  assert.deepEqual(ix.dependsOn(Q("q_end_note")).filter((e) => e.kind === "placement"), [],
    "Q7 under a plain block is not 'inside' anything");
});

test("quotas and named expressions read their conditions", () => {
  const ix = buildDependencyIndex(survey());
  assert.ok(edge(ix.edges, objectKey("quota", "qt1"), Q("q_age"), "quotaCell"));
  assert.ok(edge(ix.edges, objectKey("namedExpression", "ne1"), Q("q_age"), "namedExpression"));
});

test("a question nothing mentions has no edges either way", () => {
  const ix = buildDependencyIndex(survey());
  assert.deepEqual(ix.dependsOn(Q("q_hidden")), []);
  assert.deepEqual(ix.usedBy(Q("q_hidden")), []);
  assert.deepEqual(ix.reach(Q("q_hidden")), []);
  assert.deepEqual(ix.affects(Q("q_hidden")), []);
});

test("reach and affects never include the start and never loop forever on a cycle", () => {
  const def = survey();
  // make a cycle: Q1 display reads Q4, Q4 already reads Q1 through its skip
  def.questions[0] = { ...def.questions[0], displayLogic: cond.rule("q_why", "eq", "x") } as never;
  const ix = buildDependencyIndex(def);
  const r = ix.reach(Q("q_age"));
  assert.ok(!r.includes(Q("q_age")), "start excluded");
  assert.ok(r.includes(Q("q_why")));
  assert.equal(new Set(r).size, r.length, "no duplicates");
});

test("the index agrees with the runtime's question graph on question→question edges", () => {
  /*
   * `dependencyGraph` is what the runtime trusts for recalculation. The index
   * must not claim a question dependency the runtime does not have, and every
   * runtime edge must appear in the index (possibly via an intermediate node).
   */
  const def = survey();
  const ix = buildDependencyIndex(def);
  const g = dependencyGraph(def);
  for (const [qid, deps] of Object.entries(g)) {
    for (const d of deps) {
      assert.ok(ix.reach(Q(qid)).includes(Q(d)), `runtime says ${qid} reads ${d}; the index does not reach it`);
    }
  }
  const rev = dependentsGraph(def);
  for (const [qid, users] of Object.entries(rev)) {
    for (const u of users) {
      assert.ok(ix.affects(Q(qid)).includes(Q(u)), `runtime says ${u} depends on ${qid}; the index does not list it under affects`);
    }
  }
});

test("forName resolves codes, variable names and calc variables to keys", () => {
  const ix = buildDependencyIndex(survey());
  assert.equal(ix.forName("Q1"), Q("q_age"));
  assert.equal(ix.forName("AGE"), Q("q_age"));
  assert.equal(ix.forName("TOTAL"), objectKey("calculation", "c_total"));
  assert.equal(ix.forName("IS_ADULT"), objectKey("namedExpression", "ne1"));
  assert.equal(ix.forName("NOPE"), null);
});

test("an edge is recorded once even when the same reference appears twice at one site", () => {
  const def = survey();
  // the same pipe twice in one text: one reason, not two rows in "used by"
  def.questions[6] = { ...def.questions[6], text: "You said {{Q1}} — really {{Q1}}?" } as never;
  const ix = buildDependencyIndex(def);
  const piped = ix.edges.filter((e) => e.from === Q("q_end_note") && e.to === Q("q_age") && e.kind === "piping");
  assert.equal(piped.length, 1, `the same pipe was recorded ${piped.length} times`);
  const sigs = ix.edges.map((e) => `${e.from}→${e.to}|${e.kind}|${e.path}`);
  assert.equal(new Set(sigs).size, sigs.length, "duplicate edges");
});
