import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildQualReportDocx, buildHighlightsDocx, buildHighlightsPptx, buildQualDeckPptx, checkDocx, checkPptx } from "./index.js";
import { themePack, readThemeSynthesis, fakeThemeSynthesisReply, insightPack, readInsights, fakeInsightsReply, compareGroups, applyReelOp, reelItemStates, newAssignment, assignmentAgreement, type HighlightReel } from "../qual/index.js";
import { fixtureSegments, fixtureState } from "../qual/fixture.js";

/* F2 2026-10-22: the qualitative report carries the AI synthesis (labelled), key findings with quotes, the segment
 * comparison, double-coding agreement, method and limitations; highlight reels export to Word and PowerPoint. */

const def = SurveyDefinition.parse({ meta: { id: "s", code: "QS", title: "Broadband switching" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }], research: { objective: "Understand how price changes drive switching", hypotheses: ["Price rises drive switching"] } });
const NOW = "2026-10-22T10:00:00.000Z";

test("the qualitative report: key findings per objective with quotes, AI theme summaries (stale marked), comparison, double-coding, limitations", async () => {
  const st = fixtureState(), segs = fixtureSegments();
  const sy = readThemeSynthesis(fakeThemeSynthesisReply(themePack(st, segs, "th1")), themePack(st, segs, "th1"), { now: NOW });
  const pack = insightPack(st, segs, { objectives: ["Understand how price changes drive switching", "Explore rural coverage"], hypotheses: ["Price rises drive switching"] });
  const ins = readInsights(fakeInsightsReply(pack), pack, { now: NOW });
  const a = { ...newAssignment({ id: "d", coderA: "u1", coderB: "ai", segments: segs, overlapPct: 100, seed: 1, codebook: st.codebook, actor: "l", now: NOW }), submitted: { u1: NOW, ai: NOW } };
  const agr = assignmentAgreement(a, [{ coder: "u1", excerpts: st.excerpts.slice(0, 2) }, { coder: "ai", excerpts: st.excerpts.slice(0, 1) }], st.codebook);
  const buf = await buildQualReportDocx(def, { state: st, segments: segs, sources: [{ id: "src1", title: "IDI 1", kind: "transcript" }], syntheses: [{ ...sy, state: "stale" }], insights: { ...ins, state: "current" }, comparison: compareGroups(st, segs, "Mumbai", "Delhi"), doubleCoding: { ...agr, name: "Pilot" }, date: "2026-10-22" });
  const c = checkDocx(buf);
  assert.ok(c.ok, c.problems.join("; "));
  for (const w of ["Key findings", "O1. Understand how price changes drive switching", "Not enough evidence in the coded data", "AI theme summary", "THE CODING HAS CHANGED SINCE THIS SUMMARY WAS WRITTEN", "Mumbai compared with Delhi", "Blind double-coding", "AI synthesis", "The price went up twice last year", "checked mechanically"]) assert.ok(c.text.toUpperCase().includes(w.toUpperCase()), w);
  /* redacted copy */
  const r = checkDocx(await buildQualReportDocx(def, { state: st, segments: segs, sources: [], insights: ins, redact: (t) => t.replace(/price/gi, "[name]"), date: "2026-10-22" }));
  assert.ok(r.ok);
});

test("highlight reels: a Word list with clip ranges and changed items, and a PowerPoint of quotes", async () => {
  const st = fixtureState(), segs = fixtureSegments();
  let reel: HighlightReel = { id: "r", name: "Pricing complaints", items: [], createdBy: "u", createdAt: NOW, updatedAt: NOW, version: 0 };
  reel = applyReelOp(reel, { op: "add", excerptIds: ["x1", "x2"], note: "lead quote" }, st, segs, NOW);
  const states = reelItemStates(reel, { ...st, excerpts: st.excerpts.filter((e) => e.id !== "x2") }, segs);
  const sources = { src1: { title: "IDI 1" }, src2: { title: "IDI 2" } };
  const d = checkDocx(await buildHighlightsDocx(def, { reel, states, sources, date: "2026-10-22" }));
  assert.ok(d.ok, d.problems.join("; "));
  for (const w of ["HIGHLIGHT REEL", "Pricing complaints", "The price went up twice last year", "clip 00:12–00:40", "removed or rejected since", "Clip list", "joining them into one video is not done"]) assert.ok(d.text.toUpperCase().includes(w.toUpperCase()), w);
  const p = await buildHighlightsPptx(def, { reel, states, sources });
  assert.ok(checkPptx(p).ok);
  const deck = await buildQualDeckPptx(def, { state: st, segments: segs, sources, comparison: compareGroups(st, segs, "Mumbai", "Delhi") });
  assert.ok(checkPptx(deck).ok, checkPptx(deck).problems.join("; "));
});
