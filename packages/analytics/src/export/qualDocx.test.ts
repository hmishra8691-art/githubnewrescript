import { test } from "node:test";
import assert from "node:assert/strict";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions } from "@rescript/engine";
import { buildQualGuideDocx, buildQualReportDocx, readDocxText } from "./qualDocx.js";
import { checkDocx } from "./docxCheck.js";
import { parseTranscript, transcriptSegments, codingBatches, fakeCodingReply, readCodingReply, mergeCoding, applyQualOp, agreement, emptyCodebook, redactText, type QualState, type QualHistoryEntry } from "../qual/index.js";

/*
 * THE QUALITATIVE EDITIONS (2026-10-18): the interview / discussion guide and the qualitative report,
 * through the same Word kit and the same package check as every Rescript document — and a .docx
 * transcript read back to text for import.
 */

const base = () => SurveyDefinition.parse({ meta: { id: "s", code: "QS", title: "Broadband switching" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
const withGuide = (kind: "interview" | "focus_group") => {
  const c = coerceSurveyActions([{
    op: "create_qual_guide", kind, title: "Why customers switch", durationMinutes: kind === "focus_group" ? 90 : 60,
    objectives: ["Understand what triggers switching"], protocol: "Remote sessions moderated by a senior researcher.",
    screening: ["Pays the broadband bill", "Exclude: works in telecoms"], consent: { statement: "Taking part is voluntary.", recordingDisclosure: "Audio and video are recorded for the research team only." },
    segments: [{ name: "Recent switchers", target: 4 }], sessionPlan: { sessions: kind === "focus_group" ? 2 : 8, participantsPerSession: kind === "focus_group" ? 6 : 1, mode: "remote" },
    ...(kind === "focus_group" ? { groundRules: ["One person speaks at a time", "No right or wrong answers"] } : {}),
    sections: [
      { title: "Introduction", kind: "opening", minutes: 5, script: "Thank you for joining; this session is recorded." },
      { title: "Triggers", minutes: 30, instructions: ["Let the story unfold before probing"], questions: [{ text: "Think about the last time you considered switching. What happened?", probes: ["What tipped the decision?"], conditionalProbes: [{ ifMentions: "price", ask: "What would a fair price be?" }], moderatorNote: "Allow silence" }] },
      { title: "Card sort", kind: "exercise", minutes: 15, exercise: { title: "Rank the benefits", instructions: "Sort the cards", materials: ["10 benefit cards"] } },
      { title: "Close", kind: "closing", minutes: 5, questions: ["Anything else?"] },
    ],
  }]);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(base(), c.actions);
  assert.deepEqual(r.errors, []);
  return r.def;
};

test("the interview guide: a valid Word document with the protocol, screening, consent and every section, question, probe and conditional probe", async () => {
  const def = withGuide("interview");
  const buf = await buildQualGuideDocx(def, { client: "Acme", date: "2026-10-18" });
  const c = checkDocx(buf);
  assert.ok(c.ok, c.problems.join("; "));
  for (const w of ["INTERVIEW GUIDE", "Why customers switch", "Objectives and protocol", "Understand what triggers switching", "Remote sessions moderated", "8 interviews, 1 participant each, remote (video call), 60 minutes", "Recent switchers", "Pays the broadband bill", "Exclude", "Taking part is voluntary.", "Audio and video are recorded", "4.2 Triggers (30 min)", "Let the story unfold before probing", "Think about the last time you considered switching. What happened?", "Probe: What tipped the decision?", "If the participant mentions price → ask: What would a fair price be?", "Note: Allow silence", "Exercise: Rank the benefits", "Materials: 10 benefit cards", "does not run live sessions"]) assert.ok(c.text.toUpperCase().includes(w.toUpperCase()), w);
  assert.ok(c.headings >= 5);
  /* the same document read back as an import would read it */
  const text = readDocxText(buf);
  assert.match(text, /\nQ2\.1\s+Think about the last time you considered switching\. What happened\?\n/);
});

test("the focus-group discussion guide carries its ground rules; a survey with no guide is refused", async () => {
  const c = checkDocx(await buildQualGuideDocx(withGuide("focus_group"), { date: "2026-10-18" }));
  assert.ok(c.ok);
  for (const w of ["FOCUS-GROUP DISCUSSION GUIDE", "Ground rules", "One person speaks at a time", "2 groups, 6 participants each"]) assert.ok(c.text.toUpperCase().includes(w.toUpperCase()), w);
  assert.throws(() => buildQualGuideDocx(base()), /no interview or focus-group guide/);
});

test("a .docx transcript in 'Speaker: text' form is read to text and parsed with its speakers", async () => {
  const doc = new Document({ sections: [{ children: ["Moderator: Welcome, tell me about your provider.", "Anna: We switched last spring.", "Because of the price.", "Moderator: Thanks & goodbye."].map((t) => new Paragraph({ children: [new TextRun(t)] })) }] });
  const text = readDocxText(await Packer.toBuffer(doc));
  const p = parseTranscript(text, { fileName: "session.docx" });
  assert.equal(p.format, "speaker");
  assert.deepEqual(p.turns.map((t) => [t.speaker, t.text]), [["Moderator", "Welcome, tell me about your provider."], ["Anna", "We switched last spring. Because of the price."], ["Moderator", "Thanks & goodbye."]]);
  assert.throws(() => readDocxText(Buffer.from("not a zip at all, definitely not a document".repeat(3))), /ZIP|Word/);
});

test("the qualitative report: method, codebook, themes with cited claims and exact quotes, contradictory evidence, groups, interpretation left to the researcher, limitations, review history", async () => {
  const def = withGuide("interview");
  const turnsA = parseTranscript("Moderator: Why did you switch?\nAnna: The price went up twice and nobody explained it. Call me on 020 7946 0958.\nModerator: Anything else?\nAnna: The speed was awful every evening.").turns;
  const turnsB = parseTranscript("Moderator: Why did you stay?\nBen: The price is fine for what we get.\nBen: The speed is good enough for us.").turns;
  const segments = [...transcriptSegments("A", turnsA, { Anna: { group: "Switchers" } }), ...transcriptSegments("B", turnsB, { Ben: { group: "Stayers" } })];
  const { batches } = codingBatches(segments);
  const read = readCodingReply(fakeCodingReply(batches[0], { mode: "inductive" }), batches[0], { mode: "inductive" });
  let state: QualState = mergeCoding({ codebook: emptyCodebook(), excerpts: [] }, [read], { now: "2026-10-18T10:00:00Z", mode: "inductive", segmentCount: segments.length }).state;
  const history: QualHistoryEntry[] = [{ at: "2026-10-18T10:00:00Z", actor: "ai", action: "ai_coding", detail: "AI inductive coding", ids: [] }];
  const price = state.codebook.codes.find((c) => c.name === "Price")!;
  const r1 = applyQualOp(state, { op: "review_code", codeId: price.id, decision: "accept" }, { actor: "u1", now: "2026-10-18T10:05:00Z" });
  state = r1.state; history.push(r1.entry);
  const neg = state.excerpts.find((e) => e.sourceId === "B" && e.codeId === price.id)!;
  const r2 = applyQualOp(state, { op: "review_excerpt", excerptId: neg.id, decision: "accept", negativeCase: true }, { actor: "u1", now: "2026-10-18T10:06:00Z" });
  state = r2.state; history.push(r2.entry);
  const sources = [{ id: "A", title: "IDI 1 — Anna", kind: "transcript" as const, date: "2026-10-10", segments: 4 }, { id: "B", title: "IDI 2 — Ben", kind: "transcript" as const, segments: 3 }];
  const buf = await buildQualReportDocx(def, { state, segments, sources, history, agreement: agreement(state, "ai", "u1"), coderName: (id) => (id === "ai" ? "AI" : "Reviewer"), date: "2026-10-18" });
  const c = checkDocx(buf);
  assert.ok(c.ok, c.problems.join("; "));
  for (const w of ["QUALITATIVE REPORT", "Objectives", "Understand what triggers switching", "Method and coding", "Inductive: the codes were developed from the data", "exact span of its source", "Codebook", "Price", "Themes", "Supporting excerpts", "Contradictory evidence", "The price is fine for what we get.", "Group differences", "Switchers", "Stayers", "Frequency is not importance", "Interpretation", "the interpretation is the researcher's", "Limitations", "Review status and history", "Reviewer", "Accepted code “Price”", "IDI 1 — Anna · Anna"]) assert.ok(c.text.toUpperCase().includes(w.toUpperCase()), w);
  /* every printed quote is an exact span of its source */
  for (const e of state.excerpts) { const seg = segments.find((s) => s.sourceId === e.sourceId && s.id === e.segmentId)!; assert.equal(seg.text.slice(e.charStart, e.charEnd), e.quote); }
  assert.match(c.text, /was coded in \d of 2 sources .*\[x\d+/);
  /* printed for a reader without the contact-details permission */
  const redacted = checkDocx(await buildQualReportDocx(def, { state, segments, sources, redact: (t) => redactText(t, { names: ["Anna", "Ben"] }).text, date: "2026-10-18" }));
  assert.ok(redacted.ok);
  assert.ok(!/020 7946 0958/.test(redacted.text), "no phone number in the redacted copy");
  assert.match(redacted.text, /Personal details are redacted in this copy/);
});
