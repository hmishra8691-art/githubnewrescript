import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  locateNode, findNode, allContainers, subtreeIds, ancestorsOf,
  canDropFlowNode, moveFlowNode, insertFlowNode, removeFlowNode,
  cloneFlowSubtree, summarizeFlowNode, validateFlowStructure, containerSlots,
} from "./flowTree.js";
import {
  coerceEmbedded, normalizeExpression, checkEmbeddedExpression, applyEmbeddedField,
  embeddedCatalog, embeddedTypeOf, referencedNames,
} from "./embedded.js";
import { resolveUrlTemplate, validateRedirectUrl, urlVariableCatalog } from "./redirect.js";
import { createResponseState } from "./state.js";
import { compileFlow, start, advance } from "./flow.js";

/* ------------------------------------------------------------- fixtures */

/**
 * A flow with one of everything, nested: the shape the brief's §24 diagram
 * describes. Every test below moves pieces of this around and then checks the
 * survey still says what it said.
 */
const flowFixture = () => [
  {
    type: "section", id: "grp_intro", title: "Introduction",
    children: [
      { type: "page", id: "p1", title: "Welcome", questionIds: ["q1"] },
      { type: "page", id: "p2", title: "Screener", questionIds: ["q2"] },
    ],
  },
  { type: "embedded_data", id: "ed1", fields: [{ name: "SCORE", source: "static", value: "10" }] },
  {
    type: "branch", id: "br1",
    branches: [
      {
        id: "cond_a", label: "Qualified",
        when: { type: "rule", source: { kind: "question", ref: "q2" }, operator: "eq", value: "1" },
        children: [{ type: "page", id: "p3", questionIds: ["q3"] }],
      },
    ],
    otherwise: [],
  },
  {
    type: "randomizer", id: "rnd1", show: 2,
    children: [
      { type: "page", id: "p4", questionIds: [] },
      { type: "page", id: "p5", questionIds: [] },
    ],
  },
  { type: "end", id: "end1", status: "complete" },
];

const defFixture = () =>
  SurveyDefinition.parse({
    meta: { id: "ft", code: "FT", title: "Flow tree", version: "1.0" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "One",
        options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Two",
        options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "Three" },
    ],
    flow: flowFixture(),
  });

/* ---------------------------------------------------------- addressing */

test("locateNode finds nodes at every depth, with the container that holds them", () => {
  const flow = flowFixture() as any;

  assert.equal(locateNode(flow, "grp_intro")?.container.ownerId, null);
  assert.equal(locateNode(flow, "p1")?.container.ownerId, "grp_intro");
  assert.equal(locateNode(flow, "p1")?.container.slot, "children");
  assert.equal(locateNode(flow, "p3")?.container.slot, "branch:cond_a");
  assert.equal(locateNode(flow, "p3")?.container.ownerId, "br1");
  assert.equal(locateNode(flow, "p5")?.index, 1);
  assert.equal(locateNode(flow, "nope"), null);
});

test("every container is addressable, including a branch's otherwise", () => {
  const flow = flowFixture() as any;
  const slots = allContainers(flow).map((c) => `${c.ownerId ?? "root"}/${c.slot}`);
  assert.ok(slots.includes("root/children"));
  assert.ok(slots.includes("grp_intro/children"));
  assert.ok(slots.includes("br1/branch:cond_a"));
  assert.ok(slots.includes("br1/otherwise"));
  assert.ok(slots.includes("rnd1/children"));
  // a block's pages are NOT a drop container — they are the Questions tab's
  assert.deepEqual(containerSlots({ type: "block", id: "b", children: [] } as any), []);
});

test("ancestorsOf gives the containment path outermost first", () => {
  const flow = flowFixture() as any;
  assert.deepEqual(ancestorsOf(flow, "p3").map((n) => n.id), ["br1"]);
  assert.deepEqual(ancestorsOf(flow, "p1").map((n) => n.id), ["grp_intro"]);
  assert.deepEqual(ancestorsOf(flow, "rnd1").map((n) => n.id), []);
});

/* ------------------------------------------------- the moves the brief asks for */

test("P2: a block drags into a randomizer, and the randomizer keeps what it had", () => {
  const flow = flowFixture() as any;
  const r = moveFlowNode(flow, "p1", { kind: "inside", ownerId: "rnd1", slot: "children" });
  assert.ok(r.moved, r.reason);

  const rnd = findNode(r.flow, "rnd1") as any;
  assert.deepEqual(rnd.children.map((c: any) => c.id), ["p4", "p5", "p1"]);
  // and it left the group it came from
  assert.deepEqual((findNode(r.flow, "grp_intro") as any).children.map((c: any) => c.id), ["p2"]);
  // the original flow is untouched — callers get a new tree, never a mutation
  assert.deepEqual((findNode(flow, "grp_intro") as any).children.map((c: any) => c.id), ["p1", "p2"]);
});

test("P2: a whole group drags into a randomizer with its blocks intact", () => {
  const flow = flowFixture() as any;
  const r = moveFlowNode(flow, "grp_intro", { kind: "inside", ownerId: "rnd1", slot: "children", index: 0 });
  assert.ok(r.moved, r.reason);

  const rnd = findNode(r.flow, "rnd1") as any;
  assert.deepEqual(rnd.children.map((c: any) => c.id), ["grp_intro", "p4", "p5"]);
  const grp = rnd.children[0];
  assert.deepEqual(grp.children.map((c: any) => c.id), ["p1", "p2"]);
  assert.equal(grp.children[0].title, "Welcome");
  assert.deepEqual(grp.children[0].questionIds, ["q1"]);
});

test("P3: randomizers nest inside randomizers", () => {
  let flow = flowFixture() as any;
  const inner = { type: "randomizer", id: "rnd2", children: [{ type: "page", id: "p9", questionIds: [] }] };
  flow = insertFlowNode(flow, inner as any, { kind: "after", refId: "rnd1" }).flow;

  const r = moveFlowNode(flow, "rnd2", { kind: "inside", ownerId: "rnd1", slot: "children" });
  assert.ok(r.moved, r.reason);
  const outer = findNode(r.flow, "rnd1") as any;
  assert.deepEqual(outer.children.map((c: any) => c.id), ["p4", "p5", "rnd2"]);
  assert.deepEqual(outer.children[2].children.map((c: any) => c.id), ["p9"]);
});

test("P4: a group moves into a branch condition and back out again", () => {
  const flow = flowFixture() as any;
  const into = moveFlowNode(flow, "grp_intro", { kind: "inside", ownerId: "br1", slot: "branch:cond_a" });
  assert.ok(into.moved, into.reason);
  const br = findNode(into.flow, "br1") as any;
  assert.deepEqual(br.branches[0].children.map((c: any) => c.id), ["p3", "grp_intro"]);

  const out = moveFlowNode(into.flow, "grp_intro", { kind: "before", refId: "br1" });
  assert.ok(out.moved, out.reason);
  assert.equal(locateNode(out.flow, "grp_intro")?.container.ownerId, null);
  // its two blocks travelled with it, twice
  assert.deepEqual((findNode(out.flow, "grp_intro") as any).children.map((c: any) => c.id), ["p1", "p2"]);
});

test("a node drops into a branch's otherwise path", () => {
  const flow = flowFixture() as any;
  const r = moveFlowNode(flow, "rnd1", { kind: "inside", ownerId: "br1", slot: "otherwise" });
  assert.ok(r.moved, r.reason);
  assert.deepEqual((findNode(r.flow, "br1") as any).otherwise.map((c: any) => c.id), ["rnd1"]);
});

test("before / after place a node exactly where the indicator showed", () => {
  const flow = flowFixture() as any;
  const before = moveFlowNode(flow, "end1", { kind: "before", refId: "ed1" });
  assert.deepEqual(before.flow.map((n: any) => n.id), ["grp_intro", "end1", "ed1", "br1", "rnd1"]);

  const after = moveFlowNode(flow, "grp_intro", { kind: "after", refId: "br1" });
  assert.deepEqual(after.flow.map((n: any) => n.id), ["ed1", "br1", "grp_intro", "rnd1", "end1"]);
});

test("reordering within one list accounts for the gap the removal leaves", () => {
  const flow = [
    { type: "page", id: "a", questionIds: [] },
    { type: "page", id: "b", questionIds: [] },
    { type: "page", id: "c", questionIds: [] },
  ] as any;
  // drag A to sit after C: naive splicing puts it before C
  const r = moveFlowNode(flow, "a", { kind: "after", refId: "c" });
  assert.deepEqual(r.flow.map((n: any) => n.id), ["b", "c", "a"]);
});

/* ------------------------------------------------------- refusing bad drops */

test("an element cannot be dropped inside itself or its own descendants", () => {
  const flow = flowFixture() as any;

  const self = canDropFlowNode(flow, "rnd1", { kind: "inside", ownerId: "rnd1", slot: "children" });
  assert.equal(self.ok, false);
  assert.match(self.reason ?? "", /inside itself/);

  // dropping a group next to its own child means dropping it inside itself
  const child = canDropFlowNode(flow, "grp_intro", { kind: "before", refId: "p1" });
  assert.equal(child.ok, false);
  assert.match(child.reason ?? "", /inside itself/);

  // one level deeper: into a container the dragged node contains
  const deep = flowFixture() as any;
  deep[0].children.push({ type: "randomizer", id: "rnd_inner", children: [] });
  const nested = canDropFlowNode(deep, "grp_intro", { kind: "inside", ownerId: "rnd_inner", slot: "children" });
  assert.equal(nested.ok, false);
  assert.match(nested.reason ?? "", /already contains/);

  // and the refused move changes nothing
  const attempt = moveFlowNode(flow, "grp_intro", { kind: "before", refId: "p1" });
  assert.equal(attempt.moved, false);
  assert.deepEqual(attempt.flow.map((n: any) => n.id), flow.map((n: any) => n.id));
});

test("an End of survey is refused inside a randomizer or a loop", () => {
  const flow = flowFixture() as any;
  const r = canDropFlowNode(flow, "end1", { kind: "inside", ownerId: "rnd1", slot: "children" });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /unreachable/);

  const withLoop = insertFlowNode(
    flow,
    { type: "loop", id: "lp1", loopVar: "item", source: { kind: "static", items: [] }, children: [] } as any,
    { kind: "before", refId: "end1" },
  ).flow;
  assert.equal(canDropFlowNode(withLoop, "end1", { kind: "inside", ownerId: "lp1", slot: "children" }).ok, false);
});

test("dropping into a container that has gone is refused, not guessed at", () => {
  const flow = flowFixture() as any;
  assert.equal(canDropFlowNode(flow, "p1", { kind: "inside", ownerId: "ghost", slot: "children" }).ok, false);
  assert.equal(canDropFlowNode(flow, "ghost", { kind: "before", refId: "p1" }).ok, false);
  // a slot the owner does not have
  assert.equal(canDropFlowNode(flow, "p1", { kind: "inside", ownerId: "rnd1", slot: "otherwise" }).ok, false);
});

/* ------------------------------------------------- structure preservation */

test("every setting inside a moved subtree survives the move unchanged", () => {
  const flow = flowFixture() as any;
  const beforeBranch = JSON.stringify(findNode(flow, "br1"));

  let r = moveFlowNode(flow, "br1", { kind: "inside", ownerId: "grp_intro", slot: "children", index: 0 });
  assert.ok(r.moved, r.reason);
  r = moveFlowNode(r.flow, "br1", { kind: "inside", ownerId: "rnd1", slot: "children" });
  assert.ok(r.moved, r.reason);
  r = moveFlowNode(r.flow, "br1", { kind: "after", refId: "grp_intro" });
  assert.ok(r.moved, r.reason);

  // three moves across three containers: the condition, its label, the page
  // inside it and every id are the same JSON they started as
  assert.equal(JSON.stringify(findNode(r.flow, "br1")), beforeBranch);
});

test("subtreeIds sees pages inside blocks, not just container children", () => {
  const node = {
    type: "section", id: "g", children: [
      { type: "block", id: "b", children: [{ type: "page", id: "pp", questionIds: [] }] },
    ],
  } as any;
  assert.deepEqual(subtreeIds(node).sort(), ["b", "g", "pp"]);
});

/* -------------------------------------------------------- insert / clone */

test("insert refuses the same combinations a drag does", () => {
  const flow = flowFixture() as any;
  const bad = insertFlowNode(flow, { type: "end", id: "e2", status: "complete" } as any,
    { kind: "inside", ownerId: "rnd1", slot: "children" });
  assert.equal(bad.moved, false);

  const good = insertFlowNode(flow, { type: "page", id: "pnew", questionIds: [] } as any,
    { kind: "inside", ownerId: "rnd1", slot: "children", index: 1 });
  assert.ok(good.moved);
  assert.deepEqual((findNode(good.flow, "rnd1") as any).children.map((c: any) => c.id), ["p4", "pnew", "p5"]);
});

test("duplicating a subtree gives every node inside it a fresh id", () => {
  const flow = flowFixture() as any;
  let n = 0;
  const copy = cloneFlowSubtree(findNode(flow, "br1")!, (p) => `${p}_copy${n++}`);
  const original = subtreeIds(findNode(flow, "br1")!);
  const copied = subtreeIds(copy);
  assert.equal(copied.length, original.length);
  assert.equal(copied.some((id) => original.includes(id)), false);
  // the branch's own condition id is regenerated too, or both branches would
  // answer to one id
  assert.notEqual((copy as any).branches[0].id, "cond_a");
});

test("removeFlowNode returns what it took out", () => {
  const flow = flowFixture() as any;
  const { flow: next, removed } = removeFlowNode(flow, "rnd1");
  assert.equal(removed?.id, "rnd1");
  assert.equal(findNode(next, "rnd1"), null);
  assert.equal(findNode(next, "p4"), null);
});

/* ------------------------------------------------------------ describing */

test("summaries say what is being dragged", () => {
  const flow = flowFixture() as any;
  const grp = summarizeFlowNode(findNode(flow, "grp_intro")!);
  assert.equal(grp.label, "Introduction");
  assert.equal(grp.blocks, 2);
  assert.equal(grp.detail, "2 blocks");

  const rnd = summarizeFlowNode(findNode(flow, "rnd1")!);
  assert.equal(rnd.detail, "show 2 of 2");

  const page = summarizeFlowNode(findNode(flow, "p1")!);
  assert.equal(page.label, "Welcome");
  assert.equal(page.detail, "1 question");
});

/* ------------------------------------------------------------ validation */

test("structure validation catches duplicate ids and unreachable tails", () => {
  const flow = [
    { type: "page", id: "dup", questionIds: [] },
    { type: "end", id: "end1", status: "complete" },
    { type: "page", id: "dup", questionIds: [] },
  ] as any;
  const issues = validateFlowStructure(flow);
  assert.ok(issues.some((i) => i.level === "error" && /share the id/.test(i.message)));
  assert.ok(issues.some((i) => i.level === "warning" && /no respondent reaches it/.test(i.message)));
});

test("a valid flow reports nothing", () => {
  assert.deepEqual(validateFlowStructure(flowFixture() as any), []);
});

/* ------------------------------------------------- typed embedded data */

test("each declared type reads its text the way the type means", () => {
  assert.equal(coerceEmbedded("integer", "25").value, 25);
  assert.equal(coerceEmbedded("integer", "abc").value, null);
  assert.match(coerceEmbedded("integer", "abc").error ?? "", /not a number/);
  assert.equal(coerceEmbedded("integer", "25.7").value, 25);
  assert.equal(coerceEmbedded("decimal", "12.5").value, 12.5);
  assert.equal(coerceEmbedded("boolean", "yes").value, true);
  assert.equal(coerceEmbedded("boolean", "0").value, false);
  assert.equal(coerceEmbedded("boolean", "maybe").value, null);
  assert.equal(coerceEmbedded("date", "2026-09-03").value, "2026-09-03");
  assert.equal(coerceEmbedded("datetime", "2026-09-03T10:00:00Z").value, "2026-09-03T10:00:00.000Z");
  // untyped means NO conversion — not "convert to string". A field that
  // already held a number must still hold that number.
  assert.equal(coerceEmbedded(undefined, "007").value, "007");
  assert.equal(coerceEmbedded(undefined, 42).value, 42);
  assert.equal(coerceEmbedded("string", 42).value, "42");
  assert.equal(coerceEmbedded("integer", "").value, null);
});

test("an untyped field with nothing to store does not invent a null", () => {
  const def = defFixture();
  const state = createResponseState(def);
  // the historical behaviour of a URL field that received nothing: no key at
  // all, so exports do not gain a column of nulls
  applyEmbeddedField(def, state, { name: "LEGACY", source: "url" } as any);
  assert.equal("LEGACY" in state.embedded, false);

  // declaring a type means the field is intentional, so it is recorded
  applyEmbeddedField(def, state, { name: "TYPED", source: "url", dataType: "integer" } as any);
  assert.equal(state.embedded.TYPED, null);
});

test("a typed embedded field makes numeric comparison numeric", () => {
  const def = defFixture();
  const state = createResponseState(def, { embedded: { SCORE: "9" } });
  applyEmbeddedField(def, state, { name: "SCORE", source: "url", dataType: "integer" } as any);
  assert.equal(state.embedded.SCORE, 9);
  // the bug this prevents: as text, "9" > "80"
  assert.equal((state.embedded.SCORE as number) > 80, false);
});

test("a default value fills in when the source produced nothing", () => {
  const def = defFixture();
  const state = createResponseState(def);
  applyEmbeddedField(def, state, {
    name: "SEGMENT", source: "url", dataType: "string", defaultValue: "Premium",
  } as any);
  assert.equal(state.embedded.SEGMENT, "Premium");

  // and does not override a value that DID arrive
  const state2 = createResponseState(def, { embedded: { SEGMENT: "Standard" } });
  applyEmbeddedField(def, state2, {
    name: "SEGMENT", source: "url", dataType: "string", defaultValue: "Premium",
  } as any);
  assert.equal(state2.embedded.SEGMENT, "Standard");
});

test("IF / THEN / ELSE rewrites to the calc DSL, nesting included", () => {
  assert.equal(normalizeExpression("IF Q1 > 10 THEN \"High\" ELSE \"Low\""),
    'if(Q1 > 10, "High", "Low")');
  assert.equal(normalizeExpression("Q1 + Q2"), "Q1 + Q2");
  // already-a-call form is left alone
  assert.equal(normalizeExpression("if(Q1 > 1, 2, 3)"), "if(Q1 > 1, 2, 3)");
  // a variable whose name contains the letters if/then is not a keyword
  assert.equal(normalizeExpression("IFRAME_COUNT + 1"), "IFRAME_COUNT + 1");
  const nested = normalizeExpression('IF Q1 > 10 THEN "High" ELSE IF Q1 > 5 THEN "Mid" ELSE "Low"');
  assert.equal(nested, 'if(Q1 > 10, "High", if(Q1 > 5, "Mid", "Low"))');
});

test("an expression is checked against the survey's real variables", () => {
  const def = defFixture();
  const ok = checkEmbeddedExpression(def, "Q1 + Q3", "integer");
  assert.equal(ok.ok, true);
  assert.equal(ok.resultNote, "Result is stored as integer.");

  const bad = checkEmbeddedExpression(def, "Q1 + NOPE", "integer");
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unknownRefs, ["NOPE"]);

  const syntax = checkEmbeddedExpression(def, "Q1 +", "integer");
  assert.equal(syntax.ok, false);
  assert.ok(syntax.error);

  // functions are not variables
  assert.deepEqual(referencedNames("sum(Q1, Q3) + SCORE").sort(), ["Q1", "Q3", "SCORE"]);
});

test("an expression field computes, then stores as its declared type", () => {
  const def = defFixture();
  const state = createResponseState(def);
  state.answers.q3 = 7;
  applyEmbeddedField(def, state, {
    name: "DOUBLE", source: "expression", value: "Q3 * 2", dataType: "integer",
  } as any);
  assert.equal(state.embedded.DOUBLE, 14);

  applyEmbeddedField(def, state, {
    name: "BAND", source: "expression", value: 'IF Q3 > 5 THEN "High" ELSE "Low"', dataType: "string",
  } as any);
  assert.equal(state.embedded.BAND, "High");
});

test("the embedded catalog lists every field with its type, flow and registry alike", () => {
  const def = defFixture();
  def.flow.push({
    type: "embedded_data", id: "ed2",
    fields: [{ name: "AGE", source: "url", dataType: "integer" }],
  } as any);
  const cat = embeddedCatalog(def);
  assert.ok(cat.some((c) => c.name === "AGE" && c.dataType === "integer"));
  assert.ok(cat.some((c) => c.name === "SCORE" && c.dataType === "string"));
  assert.equal(embeddedTypeOf(def, "AGE"), "integer");
  assert.equal(embeddedTypeOf(def, "SCORE"), undefined);
});

test("the runtime captures typed embedded data as it walks the flow", () => {
  const def = defFixture();
  // in front of the first page, so advancing to that page passes through it
  def.flow.unshift({
    type: "embedded_data", id: "ed0",
    fields: [
      { name: "SCORE", source: "static", value: "42", dataType: "integer" },
      { name: "VIP", source: "static", value: "yes", dataType: "boolean" },
    ],
  } as any);
  const state = createResponseState(def);
  start(def, state, {});
  assert.equal(state.embedded.SCORE, 42);
  assert.equal(state.embedded.VIP, true);
});

/* -------------------------------------------------------------- redirect */

test("redirect URLs resolve tokens and encode them for a query string", () => {
  const def = defFixture();
  const state = createResponseState(def, { embedded: { PANEL_ID: "abc 123&x=1" } });
  const ctx = { def, state, loop: null } as any;
  const url = resolveUrlTemplate("https://p.com/done?id={{ed.PANEL_ID}}", ctx);
  assert.equal(url, "https://p.com/done?id=abc%20123%26x%3D1");
  // no tokens, no change
  assert.equal(resolveUrlTemplate("https://p.com/done", ctx), "https://p.com/done");
});

test("URL validation accepts templates and rejects what a panel would reject", () => {
  assert.equal(validateRedirectUrl("https://example.com/done").ok, true);
  assert.equal(validateRedirectUrl("https://example.com/r?id={{ed.PANEL_ID}}").ok, true);
  assert.deepEqual(validateRedirectUrl("https://x.com/r?a={{ed.A}}&b={{Q1.value}}").tokens,
    ["{{ed.A}}", "{{Q1.value}}"]);
  assert.equal(validateRedirectUrl("example.com").ok, false);
  assert.equal(validateRedirectUrl("https://").ok, false);
  assert.equal(validateRedirectUrl("").ok, false);
  assert.equal(validateRedirectUrl("https://localhost").ok, false);
  assert.ok(validateRedirectUrl("http://example.com").warning);
});

test("the variable picker offers embedded data, answers and calculations", () => {
  const def = defFixture();
  const cat = urlVariableCatalog(def);
  assert.ok(cat.some((v) => v.token === "{{ed.SCORE}}"));
  assert.ok(cat.some((v) => v.token === "{{Q1.label}}" && v.group === "Question answers"));
  assert.ok(cat.some((v) => v.group === "System"));
});

test("a redirect node sends the resolved URL, and can ask for a new window", () => {
  const def = defFixture();
  def.flow.splice(4, 0, {
    type: "redirect", id: "rd1", url: "https://p.com/end?s={{ed.SCORE}}", newWindow: true,
  } as any);
  // the value the URL carries is whatever has been captured by the time the
  // respondent reaches the redirect
  const state = createResponseState(def, { embedded: { SCORE: 10 } });
  const steps = compileFlow(def, state, {});
  const rd = steps.find((s) => s.kind === "redirect") as any;
  assert.equal(rd.url, "https://p.com/end?s=10");
  assert.equal(rd.newWindow, true);
});

/* --------------------------------------------------- backward compatibility */

test("a flow with none of the new fields compiles to exactly what it did", () => {
  const def = defFixture();
  const state = createResponseState(def);
  const steps = compileFlow(def, state, {});
  const pages = steps.filter((s) => s.kind === "page").map((s: any) => s.pageId);
  // the group's pages first, in order; the branch page is absent because its
  // condition is false; the randomizer's two are shuffled in behind them
  assert.deepEqual(pages.slice(0, 2), ["p1", "p2"]);
  assert.equal(pages.includes("p3"), false);
  assert.deepEqual([...pages.slice(2)].sort(), ["p4", "p5"]);
  // untyped static embedded data still stores its text — the capture node
  // sits after the group, so the respondent reaches it by finishing both pages
  start(def, state, {});
  advance(def, state, {});
  advance(def, state, {});
  assert.equal(state.embedded.SCORE, "10");
});
