import { test } from "node:test";
import assert from "node:assert/strict";
import {
  krippendorffAlpha, alphaWords, cohenKappa, sampleUnits, newAssignment, coderView, applyCoderOp, assignmentAgreement, disagreements, resolve, mergeResolved, bothSubmitted,
  editSegmentExcerpts, diffHunks, mapOffset, checkCorrection, needsAnchorReview, quoteMatchesSegment,
  type CoderSet, type QualExcerpt,
} from "./index.js";
import { fixtureSegments, fixtureState } from "./fixture.js";

const NOW = "2026-10-22T10:00:00.000Z";

/* ============================================================ Krippendorff's alpha, against values computed by hand */

test("alpha: Krippendorff's published nominal example (4 coders, 12 units, missing data) is .743", () => {
  /* Krippendorff (2011), "Computing Krippendorff's Alpha-Reliability", the reliability data matrix for nominal data */
  const _ = null;
  const data = [
    [1, 1, _, 1], [2, 2, 3, 2], [3, 3, 3, 3], [3, 3, 3, 3], [2, 2, 2, 2], [1, 2, 3, 4],
    [4, 4, 4, 4], [1, 1, 2, 1], [2, 2, 2, 2], [_, 5, 5, 5], [_, _, 1, 1], [_, 3, _, _],
  ];
  const r = krippendorffAlpha(data);
  assert.equal(r.units, 11, "the 12th unit has one value and is not pairable");
  assert.equal(r.n, 40);
  assert.equal(Math.round(r.alpha! * 1000) / 1000, 0.743);
});

test("alpha: two coders, binary — hand-computed from the 2×2 table (both 3, only A 2, only B 1, neither 4)", () => {
  /*
   * n = 20 values; o11 = 6, o00 = 8, o10 = o01 = 3; n1 = 9, n0 = 11;
   * α = 1 − (n − 1)·(o10 + o01) / (2·n1·n0) = 1 − 19·6 / 198 = 1 − 0.5758 = 0.4242.
   * The same table gives κ = .4 (po .7, pe .5) — α corrects for the small sample.
   */
  const rows: [number, number][] = [];
  for (let i = 0; i < 3; i++) rows.push([1, 1]);
  for (let i = 0; i < 2; i++) rows.push([1, 0]);
  rows.push([0, 1]);
  for (let i = 0; i < 4; i++) rows.push([0, 0]);
  assert.equal(krippendorffAlpha(rows).alpha, 0.4242);
  assert.equal(cohenKappa({ both: 3, onlyA: 2, onlyB: 1, neither: 4 }).kappa, 0.4);
  assert.equal(krippendorffAlpha([[1, 1], [1, 1]]).alpha, null, "no variation: undefined, not 1");
  assert.equal(krippendorffAlpha([[1, 1], [0, 0], [1, 1], [0, 0]]).alpha, 1);
  assert.equal(alphaWords(0.85), "reliable (≥ .80)");
  assert.equal(alphaWords(0.7), "tentative (.667–.80)");
});

/* ============================================================ the blind assignment */

const segs = fixtureSegments();
const seg = (src: string, id: string) => segs.find((s) => s.sourceId === src && s.id === id)!;

test("sampling: x % of each source's participant segments, at least one each, seeded and reproducible, no moderator turns", () => {
  const a = sampleUnits(segs, 50, 42), b = sampleUnits(segs, 50, 42), c = sampleUnits(segs, 50, 7);
  assert.deepEqual(a, b);
  assert.equal(a.length, 2 + 1 + 1, "src1 has 3 participant turns → 2 (rounded); src2 2 → 1; src3 2 → 1");
  assert.ok(a.every((k) => segs.find((s) => `${s.sourceId}|${s.id}` === k)!.role !== "moderator"));
  assert.equal(sampleUnits(segs, 1, 1).length, 3, "at least one per source");
  assert.equal(sampleUnits(segs, 100, 1).length, 7);
  void c;
});

test("blind double-coding: a coder never sees the other's set until both submit; κ, α, disagreements, resolution with history, merge", () => {
  const main = fixtureState();
  const a = newAssignment({ id: "da1", coderA: "u-anna", coderB: "u-ben", segments: segs, overlapPct: 100, seed: 1, codebook: main.codebook, actor: "lead", now: NOW });
  assert.equal(a.units.length, 7);
  let A: CoderSet = { coder: "u-anna", excerpts: [] }, B: CoderSet = { coder: "u-ben", excerpts: [] };
  const env = { now: NOW, segment: (s: string, id: string) => seg(s, id) };
  /* Anna: price rise on src1/t2 and src2/t2, support on src1/t5 */
  A = applyCoderOp(a, A, { op: "add_excerpt", codeId: "c1", sourceId: "src1", segmentId: "t2", quote: "price went up twice" }, main.codebook, env);
  A = applyCoderOp(a, A, { op: "add_excerpt", codeId: "c1", sourceId: "src2", segmentId: "t2", quote: "the bill keeps rising" }, main.codebook, env);
  A = applyCoderOp(a, A, { op: "add_excerpt", codeId: "c3", sourceId: "src1", segmentId: "t5", quote: "Customer service kept me waiting" }, main.codebook, env);
  /* Ben: price rise on src1/t2 only, support on src1/t5 and src3/t3 */
  B = applyCoderOp(a, B, { op: "add_excerpt", codeId: "c1", sourceId: "src1", segmentId: "t2", quote: "The price went up twice last year" }, main.codebook, env);
  B = applyCoderOp(a, B, { op: "add_excerpt", codeId: "c3", sourceId: "src1", segmentId: "t5", quote: "kept me waiting for an hour" }, main.codebook, env);
  B = applyCoderOp(a, B, { op: "add_excerpt", codeId: "c3", sourceId: "src3", segmentId: "t3", quote: "support never answers" }, main.codebook, env);
  for (const e of [...A.excerpts, ...B.excerpts]) assert.ok(quoteMatchesSegment(e, seg(e.sourceId, e.segmentId).text));
  assert.throws(() => applyCoderOp(a, A, { op: "add_code", name: "New" }, main.codebook, env), /only applies or removes codes/);
  assert.throws(() => applyCoderOp(a, A, { op: "add_excerpt", codeId: "c1", sourceId: "src1", segmentId: "t1", quote: "What made you" }, main.codebook, env), /not in this assignment/);

  /* blind: before both submit, each sees only their own; the lead sees progress, not codes */
  const sets = () => [A, B];
  let v = coderView(a, sets(), "u-anna");
  assert.equal(v.role, "A"); assert.equal(v.mine.length, 3); assert.equal(v.other, null); assert.equal(v.blind, true);
  v = coderView(a, sets(), "lead");
  assert.equal(v.role, "lead"); assert.equal(v.other, null); assert.deepEqual(v.progress, { "u-anna": 3, "u-ben": 3 });
  assert.throws(() => resolve(a, { unit: "src2|t2", codeId: "c1", decision: "apply" }, { actor: "lead", now: NOW }), /blind until then/);

  const done = { ...a, submitted: { "u-anna": NOW, "u-ben": NOW } };
  assert.ok(bothSubmitted(done));
  assert.throws(() => applyCoderOp(done, A, { op: "remove_excerpt", excerptId: A.excerpts[0].id }, main.codebook, env), /submitted/);
  assert.equal(coderView(done, sets(), "u-anna").other!.length, 3);

  /*
   * c1 over 7 units: both 1 (src1|t2), onlyA 1 (src2|t2), neither 5 → po 6/7, pA 2/7, pB 1/7, pe = 2/49 + 30/49 = 32/49;
   * κ = (42/49 − 32/49)/(17/49) = 10/17 = .5882. c3: both 1, onlyB 1, neither 5 → κ .5882 too. c2: no variation → null.
   */
  const agr = assignmentAgreement(done, sets(), main.codebook);
  const row = (id: string) => agr.codes.find((c) => c.codeId === id)!;
  assert.equal(row("c1").kappa, 0.5882);
  assert.equal(row("c3").kappa, 0.5882);
  assert.equal(row("c2").kappa, null);
  /* α for c1: n = 14, n1 = 3, n0 = 11, o10 + o01 = 2 → 1 − 13·2 / (2·3·11) = 1 − 26/66 = .6061 */
  assert.equal(row("c1").alpha, 0.6061);
  assert.deepEqual(agr.pooled.table, { both: 2, onlyA: 1, onlyB: 1, neither: 17 });
  assert.equal(agr.meanKappa, 0.5882);
  assert.equal(agr.report.codes.length, 2, "the classic κ report lists the codes either applied");

  const dis = disagreements(done, sets(), main.codebook);
  assert.deepEqual(dis.map((d) => `${d.codeId}@${d.unit}:${d.appliedBy}`).sort(), ["c1@src2|t2:A", "c3@src3|t3:B"]);
  assert.throws(() => mergeResolved(main, done, sets(), { actor: "lead", now: NOW }), /2 disagreements are not resolved/);
  let r = resolve(done, { unit: "src2|t2", codeId: "c1", decision: "apply", note: "a rising bill is a price rise" }, { actor: "lead", now: NOW });
  assert.match(r.entry.detail, /apply the code — a rising bill is a price rise/);
  r = resolve(r.assignment, { unit: "src3|t3", codeId: "c3", decision: "not_apply" }, { actor: "lead", now: NOW });
  r = resolve(r.assignment, { unit: "src3|t3", codeId: "c3", decision: "apply", note: "on reflection" }, { actor: "lead", now: NOW });
  assert.equal(r.assignment.resolutions.length, 3, "a later decision supersedes; both stay in the history");
  const m = mergeResolved({ ...main, excerpts: main.excerpts.filter((e) => e.codeId !== "c1") }, r.assignment, sets(), { actor: "lead", now: NOW });
  /* c1: src1|t2 (agreed) and src2|t2 (resolved apply) are new; c3: src1|t5 and src3|t3 are already coded in main */
  assert.equal(m.added, 2);
  const merged = m.state.excerpts.filter((e: QualExcerpt) => e.rationale?.startsWith("double-coded"));
  assert.ok(merged.every((e) => e.status === "human_reviewed" && quoteMatchesSegment(e, seg(e.sourceId, e.segmentId).text)));
});

test("an assignment needs two different coders and a codebook", () => {
  const main = fixtureState();
  assert.throws(() => newAssignment({ id: "x", coderA: "u", coderB: "u", segments: segs, overlapPct: 20, codebook: main.codebook, actor: "l", now: NOW }), /two different coders/);
  assert.throws(() => newAssignment({ id: "x", coderA: "u", coderB: "ai", segments: segs, overlapPct: 20, codebook: { ...main.codebook, codes: [] }, actor: "l", now: NOW }), /no codes yet/);
});

/* ============================================================ transcript correction */

test("correction outside a quote shifts it; inside re-anchors it (old quote kept, flagged); deleting it invalidates it; the invariant always holds", () => {
  const before = "Well, the prize went up twice last year and nobody explained why.";
  const ex = (id: string, quote: string): QualExcerpt => { const at = before.indexOf(quote); return { id, codeId: "c1", sourceKind: "transcript", sourceId: "S", segmentId: "t2", charStart: at, charEnd: at + quote.length, quote, coder: "ai", status: "human_reviewed" }; };
  const list = [ex("a", "nobody explained why"), ex("b", "the prize went up twice"), ex("c", "Well"), { ...ex("d", "Well"), segmentId: "t9" }];
  /* two corrections: "Well, " removed, and "prize" → "price" */
  const after = "the price went up twice last year and nobody explained why.";
  const r = editSegmentExcerpts(list, "S", "t2", before, after, { now: NOW, revision: 1 });
  const by = (id: string) => r.excerpts.find((e) => e.id === id)!;
  assert.equal(by("a").quote, "nobody explained why");
  assert.equal(after.slice(by("a").charStart, by("a").charEnd), "nobody explained why");
  assert.equal(r.outcomes.find((o) => o.excerptId === "a")!.outcome, "shifted");
  assert.equal(by("b").quote, "the price went up twice");
  assert.equal(by("b").anchor!.state, "reanchored");
  assert.equal(by("b").anchor!.previousQuote, "the prize went up twice");
  assert.equal(by("c").status, "rejected");
  assert.equal(by("c").anchor!.state, "invalid");
  assert.deepEqual(by("d"), list[3], "another segment's excerpt is untouched");
  for (const e of r.excerpts.filter((x) => x.segmentId === "t2" && x.status !== "rejected")) assert.ok(quoteMatchesSegment(e, after), e.id);
  assert.deepEqual(needsAnchorReview(r.excerpts).map((e) => e.id), ["b"]);
  assert.match(r.summary, /1 re-anchored .* 1 invalidated/);
});

test("diff hunks: word-level, insertions at a quote's edges stay outside it", () => {
  const a = "price went up";
  assert.deepEqual(diffHunks(a, a), []);
  const ins = "really price went up";
  const h = diffHunks(a, ins);
  assert.equal(mapOffset(h, 0, "start"), 7, "an insertion before the quote shifts its start");
  const tail = "price went up a lot";
  const h2 = diffHunks(a, tail);
  assert.equal(mapOffset(h2, a.length, "end"), a.length, "an insertion after the quote is not part of it");
  assert.equal(checkCorrection("x", "x"), "nothing changed");
  assert.match(checkCorrection("x", "  ")!, /cannot be emptied/);
  assert.equal(checkCorrection("x", "y"), null);
});
