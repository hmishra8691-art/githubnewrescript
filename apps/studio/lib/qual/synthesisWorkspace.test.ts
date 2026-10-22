import test from "node:test";
import assert from "node:assert/strict";
import { interpretQualRequest } from "@rescript/engine";
import { transcriptSegments, parseTranscript, themePack, readThemeSynthesis, fakeThemeSynthesisReply, insightPack, readInsights, fakeInsightsReply, type QualState } from "@rescript/analytics";
import { synthesisWorkspace, parseSynthesisRequest, parseAskRequest, parseCorrection, parseReelOp, parseModeratorOp, parseAssignmentCreate, parseCoderOp, joinCode, redactTheme, type SynthesisRow } from "./synthesisWorkspace.ts";
import { qualPreview } from "../copilot/qualCard.ts";
import { COPILOT_QUAL_SYNTHESIS_GUIDE, qualSynthesisIntent } from "../copilot/qualSynthesisGuide.ts";

/*
 * QUALITATIVE SYNTHESIS, SHAPED (2026-10-22): the routes' request bodies and views, the copilot's preview cards
 * and the synthesis guide — pure, no database.
 */
const T = `[00:00:05] Moderator: What made you think about switching?
[00:00:12] Asha: The price went up twice and Anna Smith never explained why. Call me on 98765 43210.
[00:00:40] Vikram: Price matters most, the bill keeps rising.
[00:01:00] Neha: I do not mind paying more for a reliable connection.`;
const segs = transcriptSegments("S1", parseTranscript(T).turns, { Asha: { group: "Mumbai" }, Vikram: { group: "Mumbai" }, Neha: { group: "Delhi" } });
const seg = (id: string) => segs.find((s) => s.id === id)!;
const ex = (id: string, codeId: string, segId: string, quote: string) => { const s = seg(segId); const at = s.text.indexOf(quote); return { id, codeId, sourceKind: "transcript" as const, sourceId: "S1", segmentId: segId, speaker: s.speaker, charStart: at, charEnd: at + quote.length, quote, coder: "ai", status: "human_reviewed" as const }; };
const state: QualState = {
  codebook: { version: 2, method: "inductive", themes: [{ id: "th1", name: "Cost", status: "human_reviewed" }], codes: [{ id: "c1", name: "Price rise", definition: "price up", themeId: "th1", status: "human_reviewed", origin: "inductive" }], relationships: [] },
  excerpts: [ex("x1", "c1", "t2", "The price went up twice and Anna Smith never explained why."), ex("x2", "c1", "t3", "Price matters most, the bill keeps rising."), ex("x3", "c1", "t4", "I do not mind paying more")],
};
const NOW = "2026-10-22T10:00:00.000Z";
const study = { objectives: ["Understand how price drives switching"], hypotheses: [] };

test("the synthesis view: the latest version per theme with its history, current or stale, redacted for a member without contact details", () => {
  const pack = themePack(state, segs, "th1");
  const rec = readThemeSynthesis({ summary: [{ text: "Anna Smith's price complaint stands out.", excerpts: ["x1"] }] }, pack, { now: NOW });
  const older = readThemeSynthesis(fakeThemeSynthesisReply(pack), pack, { now: NOW });
  const ins = readInsights(fakeInsightsReply(insightPack(state, segs, study)), insightPack(state, segs, study), { now: NOW });
  const rows: SynthesisRow[] = [
    { kind: "theme", target: "th1", version: 1, status: "ai", content: older, fingerprint: older.fingerprint },
    { kind: "theme", target: "th1", version: 2, status: "edited", content: { ...rec, status: "edited" }, fingerprint: rec.fingerprint, created_at: NOW },
    { kind: "insights", target: "study", version: 1, status: "ai", content: ins, fingerprint: ins.fingerprint },
  ];
  const v = synthesisWorkspace(rows, state, segs, study, { pii: true, names: ["Anna Smith"] });
  assert.equal(v.themes.th1.version, 2);
  assert.deepEqual(v.themes.th1.versions.map((x) => x.version), [2, 1]);
  assert.equal(v.themes.th1.record.status, "edited");
  assert.equal(v.themes.th1.record.state, "current");
  assert.equal(v.insights!.record.state, "current");
  const red = synthesisWorkspace(rows, state, segs, study, { pii: false, names: ["Anna Smith"] });
  assert.match(red.themes.th1.record.summary[0].text, /\[name\]'s price complaint/);
  /* the coding changes → stale */
  const changed = { ...state, excerpts: state.excerpts.slice(0, 2) };
  assert.equal(synthesisWorkspace(rows, changed, segs, study, { pii: true, names: [] }).themes.th1.record.state, "stale");
  assert.equal(redactTheme(rec, ["Anna Smith"]).summary[0].text.includes("Anna"), false);
});

test("request bodies: synthesis actions, edits, ask, corrections, reel ops, moderator ops, assignments, coder ops", () => {
  assert.deepEqual(parseSynthesisRequest({ action: "themes" }), { ok: true, value: { action: "themes", themeIds: null, estimateOnly: false } });
  assert.deepEqual(parseSynthesisRequest({ action: "insights", compare: ["Mumbai", "Delhi"], estimate: true }), { ok: true, value: { action: "insights", compare: ["Mumbai", "Delhi"], estimateOnly: true } });
  const e = parseSynthesisRequest({ action: "edit_theme", themeId: "th1", version: 2, edit: { section: "summary", index: 0, text: "New words" } });
  assert.ok(e.ok && e.value.action === "edit_theme" && "text" in e.value.edit && e.value.edit.text === "New words");
  assert.equal(parseSynthesisRequest({ action: "edit_theme", themeId: "th1", version: 0, edit: { section: "summary", index: 0 } }).ok, false);
  assert.equal(parseSynthesisRequest({ action: "edit_theme", themeId: "th1", version: 1, edit: { section: "poem", index: 0 } }).ok, false);
  assert.equal(parseSynthesisRequest({ action: "delete" }).ok, false);
  assert.equal(parseAskRequest({ question: "hi" }).ok, false);
  assert.deepEqual(parseCorrection({ transcriptId: "t", segmentId: "t2", text: "x\r\ny", revision: 3 }), { ok: true, value: { transcriptId: "t", segmentId: "t2", text: "x\ny", revision: 3 } });
  assert.equal(parseCorrection({ transcriptId: "t", segmentId: "t2", text: "x" }).ok, false);
  assert.deepEqual(parseReelOp({ op: "add", excerptIds: ["x1", 3] }), { op: "add", excerptIds: ["x1"] }, "only string ids");
  assert.equal(typeof parseReelOp({ op: "explode" }), "string");
  assert.deepEqual(parseModeratorOp({ op: "approve_followup", id: "f1", askNow: true }), { op: "approve_followup", id: "f1", askNow: true });
  assert.equal(typeof parseModeratorOp({ op: "ask" }), "string");
  assert.deepEqual(parseAssignmentCreate({ coderB: "ai", overlapPct: 20 }, "me"), { ok: true, value: { coderA: "me", coderB: "ai", overlapPct: 20 } });
  assert.equal(parseAssignmentCreate({ coderB: "me" }, "me").ok, false);
  assert.equal(parseAssignmentCreate({ coderB: "ai", overlapPct: 0 }, "me").ok, false);
  assert.equal(typeof parseCoderOp({ op: "add_code", name: "x" }), "string");
  assert.equal(joinCode(new Uint8Array(24).fill(7)).length, 24);
  assert.match(joinCode(crypto.getRandomValues(new Uint8Array(24))), /^[A-Za-z0-9]{24}$/);
});

test("the copilot's preview cards read the coded data by code: what would run, on what, how many model calls — or why not", () => {
  const data = { state, segments: segs, objectives: study.objectives, aiReady: true, sandbox: true };
  const sum = qualPreview(interpretQualRequest("summarise the themes")!, data);
  assert.equal(sum.runnable, true); assert.equal(sum.calls, 1); assert.deepEqual(sum.themeIds, ["th1"]);
  assert.equal(qualPreview(interpretQualRequest("Write a summary of the onboarding theme")!, data).runnable, false);
  const ins = qualPreview(interpretQualRequest("what are the key insights for objective 2")!, data);
  assert.equal(ins.runnable, false); assert.match(ins.lines[0], /no objective 2/);
  const cmp = qualPreview(interpretQualRequest("compare Mumbai vs Delhi participants")!, data);
  assert.equal(cmp.calls, 0); assert.deepEqual(cmp.groups, ["Mumbai", "Delhi"]); assert.match(cmp.lines[1], /^Cost: Mumbai 2 \(100%\) · Delhi 1 \(100%\)/);
  assert.equal(qualPreview(interpretQualRequest("compare Mumbai vs Pune participants")!, data).runnable, false);
  const reel = qualPreview(interpretQualRequest("make a highlight reel of pricing complaints")!, data);
  assert.ok(reel.excerptIds!.length >= 1); assert.equal(reel.calls, 0);
  const dc = qualPreview(interpretQualRequest("set up double coding with 50% overlap")!, data);
  assert.equal(dc.runnable, true); assert.equal(dc.units, 2);
  const ask = qualPreview(interpretQualRequest("What did Delhi participants say about satellites?")!, data);
  assert.equal(ask.runnable, false); assert.match(ask.lines[0], /^Not enough evidence/);
  assert.equal(qualPreview(interpretQualRequest("summarise the themes")!, { ...data, aiReady: false }).runnable, false);
});

test("the synthesis guide: sent for synthesis requests, never asks the model to write a summary or numbers itself", () => {
  for (const s of ["can you summarise the interviews for me", "how does double-coding work here", "I want a highlight reel", "run a group session like Remesh"]) assert.ok(qualSynthesisIntent(s), s);
  for (const s of ["add a question about price", "make Q3 required"]) assert.ok(!qualSynthesisIntent(s), s);
  assert.match(COPILOT_QUAL_SYNTHESIS_GUIDE, /never write a theme summary, a finding, a quote, a count or a percentage yourself/);
  assert.match(COPILOT_QUAL_SYNTHESIS_GUIDE, /Video conferencing is NOT supported/);
  assert.ok(COPILOT_QUAL_SYNTHESIS_GUIDE.length < 2_200, `guide ${COPILOT_QUAL_SYNTHESIS_GUIDE.length}`);
});
