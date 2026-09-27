import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPageAfter, joinPageAfter, boundaryAfter, pagePositionOf, wrapBlock, unwrapIfSingle } from "./pageBreaks.js";
import { listBlocks } from "./blocks.js";

/** a survey: block A (one page: q1 q2 q3), block B (two pages: q4 q5 | q6) */
function survey(): any {
  const q = (id: string) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "single_select", text: id, options: [], required: false });
  return {
    meta: { title: "t" },
    questions: ["q1", "q2", "q3", "q4", "q5", "q6"].map(q),
    flow: [
      { type: "page", id: "pA", title: "Block A", questionIds: ["q1", "q2", "q3"], visibleIf: { type: "rule", questionId: "q1", op: "answered" } },
      { type: "block", id: "bB", title: "Block B", children: [
        { type: "page", id: "pB1", questionIds: ["q4", "q5"] },
        { type: "page", id: "pB2", questionIds: ["q6"] },
      ] },
    ],
    displayRules: [], calculations: [], quotas: [],
  };
}
let n = 0;
const ids = (p: string) => `${p}_${++n}`;

test("boundaryAfter: middle of a page, a break inside a block, the end of a block", () => {
  const d = survey();
  assert.equal(boundaryAfter(d, "q1"), "none");
  assert.equal(boundaryAfter(d, "q3"), "block");
  assert.equal(boundaryAfter(d, "q5"), "page");
  assert.equal(boundaryAfter(d, "q6"), "block");
  assert.equal(boundaryAfter(d, "nope"), null);
  assert.deepEqual(pagePositionOf(d, "q5") && { pageIndex: pagePositionOf(d, "q5")!.pageIndex, index: pagePositionOf(d, "q5")!.index }, { pageIndex: 0, index: 1 });
});

test("splitPageAfter on a bare page wraps it into a block and moves the tail to a new page; the page keeps its id and the block takes its title and condition", () => {
  const d = survey();
  const r = splitPageAfter(d, "q1", ids);
  assert.equal(r.ok, true);
  const blocks = listBlocks(d.flow);
  assert.equal(blocks.length, 2);
  const a = blocks[0];
  assert.equal(a.wrapped, true);
  assert.equal(a.node.type, "block");
  assert.equal(a.node.title, "Block A", "the title moved up to the block");
  assert.ok(a.node.visibleIf, "the condition moved up to the block");
  assert.deepEqual(a.pages.map((p) => p.node.questionIds), [["q1"], ["q2", "q3"]]);
  assert.equal(a.pages[0].node.id, "pA", "the original page keeps its id — skip rules still land on it");
  assert.equal(a.pages[1].node.id, (r as { pageId: string }).pageId);
  assert.equal(boundaryAfter(d, "q1"), "page");
  assert.equal(d.flow.length, 2, "the flow still has two entries: block A, block B");
});

test("splitPageAfter inside an already-wrapped block adds a page without re-wrapping", () => {
  const d = survey();
  const r = splitPageAfter(d, "q4", ids);
  assert.equal(r.ok, true);
  const b = listBlocks(d.flow)[1];
  assert.equal(b.node.id, "bB");
  assert.deepEqual(b.pages.map((p) => p.node.questionIds), [["q4"], ["q5"], ["q6"]]);
});

test("splitPageAfter refuses the last question of a page, and says why", () => {
  const d = survey();
  const atBreak = splitPageAfter(d, "q5", ids);
  assert.equal(atBreak.ok, false);
  assert.match((atBreak as { reason: string }).reason, /already a page break/);
  const atEnd = splitPageAfter(d, "q3", ids);
  assert.equal(atEnd.ok, false);
  assert.match((atEnd as { reason: string }).reason, /block ends/);
  assert.equal(splitPageAfter(d, "ghost", ids).ok, false);
  assert.deepEqual(listBlocks(d.flow).map((b) => b.pages.length), [1, 2], "nothing changed");
});

test("joinPageAfter merges the page with the next page of the same block, and unwraps a block left with one page", () => {
  const d = survey();
  const r = joinPageAfter(d, "q5");
  assert.equal(r.ok, true);
  const b = listBlocks(d.flow)[1];
  assert.equal(b.wrapped, false, "one page left: back to a bare page");
  assert.equal(b.node.type, "page");
  assert.equal(b.node.title, "Block B", "the title came back down to the page");
  assert.deepEqual(b.node.questionIds, ["q4", "q5", "q6"]);
  assert.equal(d.flow[1], b.node, "the page sits where the block was");
});

test("joinPageAfter refuses where there is no break, and never crosses a block boundary", () => {
  const d = survey();
  const mid = joinPageAfter(d, "q4");
  assert.equal(mid.ok, false);
  assert.match((mid as { reason: string }).reason, /no page break/);
  const end = joinPageAfter(d, "q3");
  assert.equal(end.ok, false);
  assert.match((end as { reason: string }).reason, /next block/);
  assert.equal(d.flow.length, 2);
  assert.deepEqual(listBlocks(d.flow).map((b) => b.pages.length), [1, 2]);
});

test("split then join is the identity on the flow's shape", () => {
  const d = survey();
  const before = JSON.stringify(listBlocks(d.flow).map((b) => b.pages.map((p) => p.node.questionIds)));
  assert.equal(splitPageAfter(d, "q2", ids).ok, true);
  assert.equal(joinPageAfter(d, "q2").ok, true);
  assert.equal(JSON.stringify(listBlocks(d.flow).map((b) => b.pages.map((p) => p.node.questionIds))), before);
  assert.equal(d.flow[0].type, "page", "unwrapped again");
  assert.equal(d.flow[0].id, "pA");
});

test("wrapBlock is idempotent on a wrapped block and unwrapIfSingle leaves a multi-page block alone", () => {
  const d = survey();
  const b = listBlocks(d.flow)[1];
  assert.equal(wrapBlock(b, ids), b.node);
  unwrapIfSingle(b);
  assert.equal(d.flow[1].type, "block");
});
