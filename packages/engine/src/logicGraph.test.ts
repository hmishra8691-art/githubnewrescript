import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import { buildLogicFlow, logicFlowText, unreachableLogicNodes } from "./index.js";

/**
 * THE LOGIC FLOW, DERIVED (§8).
 *
 * `def.logicFlow` was stored and interpreted by nothing. These tests pin the
 * decision that replaced it: the graph is GENERATED from the flow, the skip
 * rules and the branch conditions, so it cannot drift from the survey — and
 * the one thing a generator has no opinion about, where a person dragged a
 * node, is merged back from whatever was stored.
 *
 * The properties worth pinning are structural rather than cosmetic: that a
 * skip rule appears as an edge (the flow tree cannot show those), that a
 * branch's arms rejoin, that a loop closes, and that an End is a sink.
 */

function survey(extra: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Graph", version: "1.0" },
    questions: [
      {
        id: "q_age", code: "Q1", variableName: "AGE", type: "numeric", text: "Your age?",
        skipLogic: [
          { id: "sk1", when: cond.rule("q_age", "lt", 18), target: { kind: "terminate", status: "screened" } },
        ],
      },
      { id: "q_use", code: "Q2", variableName: "USE", type: "single_select", text: "Do you use it?",
        options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q_why", code: "Q3", variableName: "WHY", type: "open_text", text: "Why?" },
      { id: "q_last", code: "Q4", variableName: "LAST", type: "open_text", text: "Anything else?" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q_age", "q_use"] },
      {
        type: "branch", id: "br", title: "Users vs non-users",
        branches: [
          {
            id: "arm_user", label: "uses it", when: cond.rule("q_use", "eq", 1),
            children: [{ type: "page", id: "p_why", questionIds: ["q_why"] }],
          },
        ],
        otherwise: [{ type: "page", id: "p_skip", questionIds: [] }],
      },
      { type: "page", id: "p_last", questionIds: ["q_last"] },
      { type: "end", id: "e_done", status: "complete" },
      { type: "end", id: "e_screen", status: "screened" },
    ],
    ...extra,
  });
}

const ids = (g: ReturnType<typeof buildLogicFlow>) => g.nodes.map((n) => n.id);
const hasEdge = (g: ReturnType<typeof buildLogicFlow>, from: string, to: string) =>
  g.edges.some((e) => e.from === from && e.to === to);

/* =========================================================== the structure */

test("every question becomes a node, chained in the order it is asked", () => {
  const g = buildLogicFlow(survey());
  assert.ok(ids(g).includes("q_age"));
  assert.ok(ids(g).includes("q_use"));
  assert.ok(hasEdge(g, "q_age", "q_use"), "Q1 leads to Q2");
});

test("the page-level map drops the questions, for the version a client reads", () => {
  const g = buildLogicFlow(survey(), { questions: false });
  assert.ok(ids(g).includes("p1"));
  assert.ok(!ids(g).includes("q_age"));
  assert.ok(g.nodes.find((n) => n.id === "p1")?.label?.includes("Q1"), "the label still names the questions");
});

test("A SKIP RULE IS AN EDGE — the thing the flow tree cannot show", () => {
  const g = buildLogicFlow(survey());
  const skip = g.edges.find((e) => e.from === "q_age" && e.to !== "q_use");
  assert.ok(skip, "the jump out of Q1 is drawn");
  assert.equal(g.nodes.find((n) => n.id === skip!.to)?.kind, "terminate");
  assert.match(skip!.label ?? "", /screen|Q1|18/i);
  assert.ok(skip!.when, "the condition travels with the edge, not just its wording");
});

test("a branch is a decision whose arms rejoin whatever follows it", () => {
  const g = buildLogicFlow(survey());
  assert.equal(g.nodes.find((n) => n.id === "br")?.kind, "decision");
  assert.ok(hasEdge(g, "br", "q_why"), "the arm is entered from the decision");
  assert.ok(hasEdge(g, "q_why", "q_last"), "and rejoins the trunk afterwards");
});

test("the arm's own label is preferred over a restatement of its condition", () => {
  const g = buildLogicFlow(survey());
  const e = g.edges.find((x) => x.from === "br" && x.to === "q_why");
  assert.equal(e?.label, "uses it");
});

test("an End is a sink — nothing continues past it by falling through", () => {
  const g = buildLogicFlow(survey());
  assert.equal(g.edges.filter((e) => e.from === "e_done").length, 0);
  assert.equal(g.nodes.find((n) => n.id === "e_done")?.kind, "end");
  assert.equal(g.nodes.find((n) => n.id === "e_screen")?.kind, "terminate");
});

test("a branch with no otherwise leaves the decision itself as an exit", () => {
  // a respondent matching no arm continues past the branch, and the graph says so
  const def = survey({
    flow: [
      { type: "page", id: "p1", questionIds: ["q_age"] },
      {
        type: "branch", id: "br2",
        branches: [{ id: "a", when: cond.rule("q_age", "gt", 40), children: [{ type: "page", id: "p_x", questionIds: ["q_why"] }] }],
      },
      { type: "page", id: "p_after", questionIds: ["q_last"] },
    ],
  });
  const g = buildLogicFlow(def);
  assert.ok(hasEdge(g, "br2", "q_last"), "the fall-through path is drawn");
  assert.ok(hasEdge(g, "q_why", "q_last"), "and so is the path through the arm");
});

/* ================================================================== loops */

test("a loop closes — the edge back is what makes it a loop", () => {
  const def = survey({
    flow: [
      {
        type: "loop", id: "lp", title: "Per brand", loopVar: "BRAND",
        source: { kind: "question", questionId: "q_use" },
        children: [{ type: "page", id: "p_in", questionIds: ["q_why"] }],
      },
      { type: "end", id: "e_done", status: "complete" },
    ],
  });
  const g = buildLogicFlow(def);
  assert.ok(hasEdge(g, "lp", "q_why"), "into the body");
  assert.ok(hasEdge(g, "q_why", "lp"), "and back for the next iteration");
  assert.equal(g.edges.find((e) => e.from === "q_why" && e.to === "lp")?.label, "next iteration");
});

/* ========================================================== randomizers */

test("a randomizer's children hang off it, never off each other", () => {
  // chaining them would present one arbitrary order as fact
  const def = survey({
    flow: [
      {
        type: "randomizer", id: "rnd", show: 2, children: [
          { type: "page", id: "pa", questionIds: ["q_use"] },
          { type: "page", id: "pb", questionIds: ["q_why"] },
        ],
      },
    ],
  });
  const g = buildLogicFlow(def);
  assert.ok(hasEdge(g, "rnd", "q_use"));
  assert.ok(hasEdge(g, "rnd", "q_why"));
  assert.ok(!hasEdge(g, "q_use", "q_why"), "no invented order between them");
  assert.match(g.nodes.find((n) => n.id === "rnd")?.label ?? "", /shows 2 of 2/);
});

/* ============================================================== actions */

test("embedded data, quota checks and redirects are actions and decisions", () => {
  const def = survey({
    flow: [
      { type: "embedded_data", id: "ed", fields: [{ name: "SRC", source: "url" }, { name: "PID", source: "url" }] },
      { type: "quota_check", id: "qc", quotaIds: ["qa"], onFull: { kind: "terminate" } },
      { type: "page", id: "p1", questionIds: ["q_age"] },
      { type: "redirect", id: "rd", url: "https://panel.example.com/done" },
    ],
  });
  const g = buildLogicFlow(def);
  assert.equal(g.nodes.find((n) => n.id === "ed")?.kind, "action");
  assert.match(g.nodes.find((n) => n.id === "ed")?.label ?? "", /SRC, PID/);
  assert.equal(g.nodes.find((n) => n.id === "qc")?.kind, "decision");
  assert.ok(
    g.edges.some((e) => e.from === "qc" && e.label === "full"),
    "a quota that terminates draws the exit it terminates to",
  );
  assert.equal(g.nodes.find((n) => n.id === "rd")?.kind, "action");
});

/* ============================================================== layout */

test("a stored graph contributes POSITIONS and nothing else", () => {
  const def = survey({
    logicFlow: {
      nodes: [
        { id: "q_age", kind: "question", x: 120, y: 40, label: "a stale hand-written label" },
        { id: "gone", kind: "question", x: 999, y: 999 },
      ],
      edges: [{ id: "stale", from: "q_age", to: "gone" }],
    },
  });
  const g = buildLogicFlow(def);
  const age = g.nodes.find((n) => n.id === "q_age")!;
  assert.equal(age.x, 120);
  assert.equal(age.y, 40);
  assert.match(age.label ?? "", /^Q1/, "the label is regenerated, so it cannot go stale");
  assert.ok(!ids(g).includes("gone"), "a node the survey no longer has is not resurrected");
  assert.ok(!g.edges.some((e) => e.id === "stale"), "and neither is a stale edge");
});

test("layout can be suppressed, for a diff between two versions of a survey", () => {
  const def = survey({
    logicFlow: { nodes: [{ id: "q_age", kind: "question", x: 7, y: 7 }], edges: [] },
  });
  const g = buildLogicFlow(def, { layout: null });
  assert.equal(g.nodes.find((n) => n.id === "q_age")?.x, undefined);
});

/* =============================================================== output */

test("the text rendering is generated from the graph, so the two cannot disagree", () => {
  const g = buildLogicFlow(survey());
  const text = logicFlowText(g);
  assert.match(text, /Q1/);
  assert.match(text, /Screened out/);
  assert.match(text, /→/);
  for (const n of g.nodes) assert.ok(text.includes(n.label ?? n.id), `missing ${n.id}`);
});

test("an empty survey produces an empty graph rather than throwing", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s0", code: "S0", title: "Empty", version: "1.0" },
    questions: [], flow: [],
  });
  const g = buildLogicFlow(def);
  assert.deepEqual(g, { nodes: [], edges: [] });
  assert.deepEqual(unreachableLogicNodes(g), []);
  assert.equal(logicFlowText(g), "");
});

/* ========================================================= reachability */

test("reachability follows EDGES, so a page reached only by a jump counts as reached", () => {
  // validateFlowStructure walks in document order and would call this unreachable
  const def = survey({
    questions: [
      {
        id: "q_age", code: "Q1", variableName: "AGE", type: "numeric", text: "Age?",
        skipLogic: [{ id: "sk", when: cond.rule("q_age", "gt", 65), target: { kind: "page", ref: "p_senior" } }],
      },
      { id: "q_s", code: "Q9", variableName: "SENIOR", type: "open_text", text: "Senior only" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q_age"] },
      { type: "end", id: "e_done", status: "complete" },
      { type: "page", id: "p_senior", questionIds: ["q_s"] },
    ],
  });
  const g = buildLogicFlow(def);
  assert.ok(hasEdge(g, "q_age", "q_s"), "the jump lands on the first question inside the target page");
  assert.deepEqual(unreachableLogicNodes(g).map((n) => n.id), []);
});

test("something genuinely orphaned is still reported", () => {
  const def = survey({
    questions: [
      { id: "q_age", code: "Q1", variableName: "AGE", type: "numeric", text: "Age?" },
      { id: "q_orphan", code: "Q9", variableName: "ORPH", type: "open_text", text: "Nobody reaches me" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q_age"] },
      { type: "end", id: "e_done", status: "complete" },
      { type: "page", id: "p_orphan", questionIds: ["q_orphan"] },
    ],
  });
  const g = buildLogicFlow(def);
  assert.deepEqual(unreachableLogicNodes(g).map((n) => n.id), ["q_orphan"]);
});

/* ===================================================== display rules mark */

test("a page a display rule targets is marked conditional in the page-level map", () => {
  const def = survey({
    displayRules: [
      { id: "dr1", action: "hide", target: { kind: "page", ref: "p_last" }, when: cond.rule("q_use", "eq", 2) },
    ],
  });
  const g = buildLogicFlow(def, { questions: false });
  assert.match(g.nodes.find((n) => n.id === "p_last")?.label ?? "", /conditional/);
});

test("a terminate jump lands on the End that CARRIES that status, not a new one", () => {
  // the flow interpreter resolves terminate by status; a graph that invents its
  // own terminal draws two boxes for one destination
  const g = buildLogicFlow(survey());
  const screened = g.nodes.filter((n) => n.label === "Screened out");
  assert.equal(screened.length, 1, "exactly one screened-out destination");
  assert.equal(screened[0].id, "e_screen", "and it is the End the survey declares");
  assert.ok(hasEdge(g, "q_age", "e_screen"));
});

test("with no declared End for a status, one is synthesised rather than dropped", () => {
  const def = survey({
    flow: [
      { type: "page", id: "p1", questionIds: ["q_age"] },
      { type: "end", id: "e_done", status: "complete" },
    ],
  });
  const g = buildLogicFlow(def);
  const screened = g.nodes.filter((n) => n.label === "Screened out");
  assert.equal(screened.length, 1);
  assert.equal(screened[0].kind, "terminate");
  assert.ok(hasEdge(g, "q_age", screened[0].id), "the jump is still drawn");
});
