import { test } from "node:test";
import assert from "node:assert/strict";
import { alignWords, attachWords, excerptClip, realignAfterEdit, tokenSpans } from "./wordTimings.js";
import { editSegmentExcerpts } from "./transcriptEdit.js";
import type { QualExcerpt, QualSegment } from "./types.js";

/* #17 — word timings on a transcript: a clip plays exactly the excerpt's words, and stays right after corrections */

const W = (list: [string, number, number][]) => list.map(([word, start, end]) => ({ word, start, end }));
const text = "Honestly, the price went up too fast.";
const provider = W([["Honestly", 10.0, 10.5], ["the", 10.6, 10.7], ["price", 10.8, 11.2], ["went", 11.3, 11.5], ["up", 11.6, 11.8], ["too", 11.9, 12.1], ["fast", 12.2, 12.6]]);

test("alignWords: the provider's words land on the text's tokens (punctuation and case ignored), with their character spans", () => {
  const ws = alignWords(text, provider, 10, 12.8);
  assert.equal(ws.length, tokenSpans(text).length);
  const price = ws[2];
  assert.equal(text.slice(price.c0, price.c1), "price");
  assert.equal(price.s, 10.8);
  assert.equal(price.e, 11.2);
  assert.ok(ws.every((w) => w.a === undefined), "every token matched exactly");
});

test("alignWords: a token the provider did not return is interpolated and marked approximate; a split token is joined", () => {
  const ws = alignWords("we don't like waiting", W([["we", 0, 0.2], ["don", 0.3, 0.4], ["t", 0.4, 0.5], ["waiting", 1.0, 1.4]]), 0, 1.5);
  assert.equal(ws[1].s, 0.3); assert.equal(ws[1].e, 0.5); assert.equal(ws[1].a, undefined, "don + t = don't, exact");
  assert.equal(ws[2].a, 1, "“like” was not returned: interpolated");
  assert.ok(ws[2].s >= 0.5 && ws[2].e <= 1.0);
});

const seg = (over: Partial<QualSegment> = {}): QualSegment => ({ id: "t3", sourceKind: "transcript", sourceId: "tr1", index: 2, start: 10, end: 12.8, text, words: alignWords(text, provider, 10, 12.8), ...over });
const ex = (quote: string, s: string = text): QualExcerpt => { const c = s.indexOf(quote); return { id: "x1", codeId: "c1", sourceKind: "transcript", sourceId: "tr1", segmentId: "t3", charStart: c, charEnd: c + quote.length, quote, coder: "u", status: "human_reviewed" }; };

test("excerptClip: exactly the excerpt's words, not the turn; without words (or stale) the turn", () => {
  const c = excerptClip(ex("price went up"), [seg()])!;
  assert.deepEqual({ start: c.start, end: c.end, byWords: c.byWords, approximate: c.approximate }, { start: 10.8, end: 11.8, byWords: true, approximate: false });
  const turn = excerptClip(ex("price went up"), [seg({ words: undefined })])!;
  assert.deepEqual([turn.start, turn.end, turn.byWords], [10, 12.8, false]);
  assert.equal(excerptClip(ex("price went up"), [seg({ wordsStale: true })])!.byWords, false);
});

test("attachWords: a transcript's words go to the segments they fall in", () => {
  const segs = attachWords([{ start: 0, end: 5, text: "hello there" }, { start: 10, end: 12.8, text }], [...W([["hello", 0.1, 0.4], ["there", 0.5, 0.9]]), ...provider]);
  assert.equal(segs[0].words?.length, 2);
  assert.equal(segs[1].words?.length, 7);
});

test("after a correction: unchanged words keep their timings (offsets moved), the corrected word is re-aligned (approximate), the clip still plays the quote", () => {
  const before = text, after = "Honestly, the prices went way up too fast.";
  const r = realignAfterEdit(before, after, seg().words, 10, 12.8);
  assert.equal(r.stale, false);
  const ws = r.words!;
  assert.equal(ws.length, tokenSpans(after).length);
  const at = (w: string) => ws.find((x) => after.slice(x.c0, x.c1) === w)!;
  assert.equal(at("Honestly,").s, 10.0);
  assert.equal(at("went").s, 11.3, "an untouched word keeps its exact timing");
  assert.equal(at("went").a, undefined);
  assert.equal(at("prices").a, 1, "the corrected word is approximate");
  assert.ok(at("prices").s >= 10.7 && at("prices").e <= 11.3);
  assert.equal(at("way").a, 1, "an inserted word is timed between its neighbours");
  assert.ok(at("way").s >= 11.5 && at("way").e <= 11.6);
  // the excerpt moved through the same edit (transcriptEdit) and its clip follows the words
  const moved = editSegmentExcerpts([ex("went up")], "tr1", "t3", before, after, { now: "now", revision: 1 }).excerpts[0];
  const c = excerptClip(moved, [seg({ text: after, words: ws })])!;
  assert.equal(c.byWords, true);
  assert.equal(c.start, 11.3);
  assert.equal(c.end, 11.8);
  assert.equal(c.approximate, true, "“way” inside the quote is interpolated, so the clip says approximate");
});

test("a correction with no timed word left to bound it marks the timings stale", () => {
  const r = realignAfterEdit("price", "cost", alignWords("price", W([["price", 1, 2]])), undefined, undefined);
  assert.equal(r.stale, true);
  assert.deepEqual(realignAfterEdit("a b", "a b", undefined), { stale: false, approximate: 0 });
});
