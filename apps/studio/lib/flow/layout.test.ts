import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import { buildLogicFlow } from "@rescript/engine";
import { buildScaleSurvey, buildMasterDemoSurvey } from "@rescript/templates";
import { layoutFlow, assignLayers, upstream, downstream, edgeKind, fitTransform, NODE_W } from "./layout.ts";

/**
 * THE FLOW LAYOUT is deterministic, respects the graph's direction, honours
 * pinned positions, and stays affordable at 600 questions.
 */

const survey = () =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Laid out" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "One" },
      { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Two", options: [{ code: "A", label: "A" }, { code: "B", label: "B" }],
        skipLogic: [{ id: "sk", when: cond.rule("q2", "eq", "B"), target: { kind: "question", ref: "q5" } }] },
      { id: "q3", code: "Q3", variableName: "Q3", type: "text", text: "Three" },
      { id: "q4", code: "Q4", variableName: "Q4", type: "text", text: "Four" },
      { id: "q5", code: "Q5", variableName: "Q5", type: "text", text: "Five" },
      { id: "q6", code: "Q6", variableName: "Q6", type: "text", text: "Per item" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2"] },
      { type: "branch", id: "br", branches: [
        { id: "a1", label: "A", when: cond.rule("q2", "eq", "A"), children: [{ type: "page", id: "p2", questionIds: ["q3"] }] },
      ], otherwise: [{ type: "page", id: "p3", questionIds: ["q4"] }] },
      { type: "page", id: "p4", questionIds: ["q5"] },
      { type: "loop", id: "lp", loopVar: "item", source: { kind: "static", items: [{ code: "x", label: "X" }, { code: "y", label: "Y" }] }, children: [{ type: "page", id: "p5", questionIds: ["q6"] }] },
      { type: "end", id: "e1", status: "complete" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

test("edges carry their kind from the engine, and old graphs are classified by label", () => {
  const g = buildLogicFlow(survey());
  const kinds = new Set(g.edges.map((e) => e.kind));
  for (const k of ["sequence", "branch", "otherwise", "skip", "loop"]) assert.ok(kinds.has(k as never), `missing edge kind ${k}: ${[...kinds].join(",")}`);
  assert.equal(edgeKind({ id: "x", from: "a", to: "b", label: "next iteration" }), "loop");
  assert.equal(edgeKind({ id: "x", from: "a", to: "b", label: "otherwise" }), "otherwise");
  assert.equal(edgeKind({ id: "x", from: "a", to: "b", label: "skip: Q2 is B" }), "skip");
  assert.equal(edgeKind({ id: "x", from: "a", to: "b" }), "sequence");
});

test("layers follow the flow: every forward edge goes to a strictly later layer; loop back-edges are the exception", () => {
  const g = buildLogicFlow(survey());
  const { layer, backEdges } = assignLayers(g.nodes, g.edges);
  for (const e of g.edges) {
    if (backEdges.has(e.id)) continue;
    assert.ok(layer.get(e.to)! > layer.get(e.from)!, `${e.from} (L${layer.get(e.from)}) → ${e.to} (L${layer.get(e.to)}) must go down`);
  }
  const loopBack = g.edges.find((e) => e.kind === "loop")!;
  assert.ok(backEdges.has(loopBack.id), "the loop's next-iteration edge is a back edge");
  assert.equal(layer.get("q1"), 0, "the first question is at the top");
  assert.ok(layer.get("q3")! > layer.get("br")!, "an arm's page sits below its branch");
  assert.ok(layer.get("q4")! > layer.get("br")!, "so does the otherwise page");
});

test("coordinates: no two nodes overlap, the canvas box contains everything, and the result is deterministic", () => {
  const g = buildLogicFlow(survey());
  const a = layoutFlow(g);
  const b = layoutFlow(g);
  assert.deepEqual(a.nodes.map((n) => [n.id, n.x, n.y]), b.nodes.map((n) => [n.id, n.x, n.y]), "same input, same layout");
  for (let i = 0; i < a.nodes.length; i++) for (let j = i + 1; j < a.nodes.length; j++) {
    const p = a.nodes[i], q = a.nodes[j];
    const overlap = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
    assert.ok(!overlap, `${p.id} and ${q.id} overlap`);
  }
  for (const n of a.nodes) { assert.ok(n.x >= 0 && n.y >= 0); assert.ok(n.x + n.w <= a.width && n.y + n.h <= a.height); }
  assert.equal(a.edges.length, g.edges.length, "every edge is drawn");
  for (const e of a.edges) assert.match(e.d, /^M [\d.]+ [\d.]+ C /);
});

test("a stored position pins the node; the rest still lay out around it", () => {
  const def = survey();
  def.logicFlow = { nodes: [{ id: "q5", kind: "question", x: 900, y: 50 }], edges: [] } as never;
  const g = buildLogicFlow(def, { layout: def.logicFlow });
  const l = layoutFlow(g);
  const q5 = l.byId.get("q5")!;
  assert.equal(q5.pinned, true);
  assert.equal(q5.x, 900); assert.equal(q5.y, 50);
  assert.ok(l.width >= 900 + NODE_W, "the canvas grows to hold the pinned node");
  assert.equal(l.byId.get("q1")!.pinned, false);
  const unpinned = layoutFlow(g, { pinned: false });
  assert.notEqual(unpinned.byId.get("q5")!.x, 900, "pinning can be switched off for 'auto-arrange'");
});

test("a skip drawn backwards and a loop edge are marked back and routed round the side", () => {
  const def = survey();
  // a skip from Q5 back to Q1
  def.questions[4] = { ...def.questions[4], skipLogic: [{ id: "back", when: cond.rule("q5", "eq", "x"), target: { kind: "question", ref: "q1" } }] } as never;
  const l = layoutFlow(buildLogicFlow(def));
  const back = l.edges.filter((e) => e.back);
  assert.ok(back.some((e) => e.kind === "skip" && e.to === "q1"), "the backward skip is a back edge");
  assert.ok(back.some((e) => e.kind === "loop"), "the loop's return is a back edge");
  for (const e of back) assert.ok(e.lx > l.byId.get(e.from)!.x + NODE_W, "a back edge's label sits out to the right");
});

test("upstream / downstream answer 'what can reach this' and 'what can this affect'", () => {
  const g = buildLogicFlow(survey());
  const up = upstream(g, "q5");
  assert.ok(up.has("q1") && up.has("br") && up.has("q3") && up.has("q4"), [...up].join(","));
  assert.ok(!up.has("q6"), "the loop comes after Q5");
  const down = downstream(g, "q2");
  assert.ok(down.has("q5") && down.has("q3") && down.has("q4") && down.has("q6"), [...down].join(","));
  assert.ok(!down.has("q1"), "Q1 is before Q2 and nothing routes back to it");
  assert.ok(!upstream(g, "q1").has("q1"), "a node never reaches itself");
});

test("fitTransform scales the whole graph into the viewport with a margin, never past 2×", () => {
  const t = fitTransform(2000, 1000, 1000, 800);
  assert.ok(Math.abs(t.k - (1000 - 48) / 2000) < 1e-9);
  assert.ok(t.tx >= 0);
  assert.equal(fitTransform(100, 100, 1000, 800).k, 2, "a tiny graph is not blown up past 2×");
});

test("the Master Demo lays out cleanly, and the 600-question fixture inside budget", () => {
  const demo = buildLogicFlow(buildMasterDemoSurvey("layout-demo"));
  const t0 = performance.now();
  const l = layoutFlow(demo);
  const demoMs = performance.now() - t0;
  assert.ok(l.nodes.length > 150, `${l.nodes.length} nodes`);
  assert.ok(demoMs < 300, `Master Demo laid out in ${demoMs.toFixed(0)}ms`);
  const big = buildLogicFlow(buildScaleSurvey(600));
  const t1 = performance.now();
  const L = layoutFlow(big);
  const bigMs = performance.now() - t1;
  assert.ok(L.nodes.length >= 600, `${L.nodes.length} nodes at 600 questions`);
  assert.ok(bigMs < 1500, `600 questions laid out in ${bigMs.toFixed(0)}ms (budget 1.5s)`);
  // the page-level graph is the one a 600-question canvas opens on
  const pages = layoutFlow(buildLogicFlow(buildScaleSurvey(600), { questions: false }));
  assert.ok(pages.nodes.length < 200 && pages.nodes.length > 50, `${pages.nodes.length} page nodes`);
});
