import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapInLoop, addEmbeddedField, findEmbeddedNode, embeddedFieldNames, blockLabel } from "./structureOps.js";
import { listBlocks } from "./blocks.js";

function survey(): any {
  const q = (id: string) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "single_select", text: id, options: [], required: false });
  return {
    meta: { title: "t" },
    questions: ["q1", "q2", "q3", "q4", "q5", "q6"].map(q),
    flow: [
      { type: "page", id: "pA", title: "A", questionIds: ["q1", "q2", "q3", "q4", "q5"] },
      { type: "page", id: "pB", questionIds: ["q6"] },
      { type: "end", id: "e", status: "complete" },
    ],
    displayRules: [], calculations: [], quotas: [],
  };
}
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const shape = (d: any) => d.flow.map((x: any) => x.type === "loop" ? `loop(${x.children.map((c: any) => c.questionIds.join(",")).join("|")})` : x.type === "page" ? `page(${x.questionIds.join(",")})` : x.type === "block" ? `block(${x.children.map((c: any) => c.questionIds.join(",")).join("|")})` : x.type);

test("wrapInLoop around the middle of a page: the run becomes a loop between the two remaining parts", () => {
  const d = survey();
  const r = wrapInLoop(d, "q2", "q4", { loopVar: "brand", title: "Per brand" }, ids);
  assert.equal(r.ok, true);
  assert.deepEqual(shape(d), ["page(q1)", "loop(q2,q3,q4)", "page(q5)", "page(q6)", "end"]);
  const loop = d.flow[1];
  assert.equal(loop.loopVar, "brand"); assert.equal(loop.title, "Per brand");
  assert.deepEqual(loop.source, { kind: "static", items: [] }, "which items to repeat over is the Studio's choice");
  assert.equal(d.flow[0].id, "pA", "the first part keeps the page's id and title");
  assert.equal(d.flow[0].title, "A");
  assert.equal(d.questions.length, 6, "no question was created or lost");
});

test("wrapInLoop at the start and at the end of a page, and around a whole page", () => {
  const a = survey();
  assert.equal(wrapInLoop(a, "q1", "q2", {}, ids).ok, true);
  assert.deepEqual(shape(a), ["loop(q1,q2)", "page(q3,q4,q5)", "page(q6)", "end"]);
  const b = survey();
  assert.equal(wrapInLoop(b, "q4", "q5", {}, ids).ok, true);
  assert.deepEqual(shape(b), ["page(q1,q2,q3)", "loop(q4,q5)", "page(q6)", "end"]);
  const c = survey();
  assert.equal(wrapInLoop(c, "q6", "q6", {}, ids).ok, true);
  assert.deepEqual(shape(c), ["page(q1,q2,q3,q4,q5)", "loop(q6)", "end"], "a whole page: the loop takes its place");
  const dd = survey();
  assert.equal(wrapInLoop(dd, "q5", "q3", {}, ids).ok, true, "the range may be named in either order");
  assert.deepEqual(shape(dd), ["page(q1,q2)", "loop(q3,q4,q5)", "page(q6)", "end"]);
});

test("wrapInLoop refuses questions on different pages, or off any page, and changes nothing", () => {
  const d = survey();
  const before = JSON.stringify(d.flow);
  const r = wrapInLoop(d, "q5", "q6", {}, ids);
  assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, /one page/);
  assert.equal(wrapInLoop(d, "q1", "ghost", {}, ids).ok, false);
  assert.equal(JSON.stringify(d.flow), before);
});

test("wrapInLoop inside an already-wrapped block keeps the other pages as a block", () => {
  const d = survey();
  d.flow[0] = { type: "block", id: "bA", title: "A", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "page", id: "p2", questionIds: ["q3", "q4"] }, { type: "page", id: "p3", questionIds: ["q5"] }] };
  assert.equal(wrapInLoop(d, "q3", "q4", {}, ids).ok, true);
  assert.deepEqual(shape(d), ["page(q1,q2)", "loop(q3,q4)", "page(q5)", "page(q6)", "end"], "one page before and one after: each is a bare page again");
  const e = survey();
  e.flow[0] = { type: "block", id: "bA", title: "A", children: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "page", id: "p3", questionIds: ["q3"] }, { type: "page", id: "p4", questionIds: ["q4", "q5"] }] };
  assert.equal(wrapInLoop(e, "q2", "q2", {}, ids).ok, true);
  assert.deepEqual(shape(e), ["page(q1)", "loop(q2)", "block(q3|q4,q5)", "page(q6)", "end"], "two pages after: they stay a block with their break");
  assert.equal(listBlocks(e.flow).length, 4, "the loop's own page counts as a block too");
});

test("addEmbeddedField joins the first embedded-data node, or creates one at the top of the flow; names must be valid and unused", () => {
  const d = survey();
  assert.equal(findEmbeddedNode(d), null);
  const r = addEmbeddedField(d, { name: "country", source: "static", value: "India", dataType: "string" } as never, ids);
  assert.equal(r.ok, true);
  assert.equal(d.flow[0].type, "embedded_data", "created first in the flow");
  assert.deepEqual(d.flow[0].fields, [{ name: "country", source: "static", value: "India", dataType: "string" }]);
  const r2 = addEmbeddedField(d, { name: " wave ", source: "url" } as never, ids);
  assert.equal(r2.ok, true);
  assert.equal(d.flow.filter((x: any) => x.type === "embedded_data").length, 1, "the second field joins the same node");
  assert.deepEqual(embeddedFieldNames(d), ["country", "wave"]);
  assert.match((addEmbeddedField(d, { name: "country", source: "url" } as never, ids) as { reason: string }).reason, /already exists/);
  assert.match((addEmbeddedField(d, { name: "Q1", source: "url" } as never, ids) as { reason: string }).reason, /question's name/);
  assert.match((addEmbeddedField(d, { name: "9lives", source: "url" } as never, ids) as { reason: string }).reason, /not a valid variable name/);
  assert.equal(d.flow[0].fields.length, 2, "refusals add nothing");
});

test("blockLabel numbers blocks in flow order", () => {
  const d = survey();
  assert.equal(blockLabel(d, "pA"), "Block 1 · A");
  assert.equal(blockLabel(d, "pB"), "Block 2");
  assert.equal(blockLabel(d, "zzz"), "zzz");
});
