import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTranscript, detectTranscriptFormat, parseTimestamp, formatTimestamp, transcriptSegments, openEndSegments,
  redactText, originalSpan, redactionSummary,
  locateQuote, quoteMatchesSegment, brokenQuotes,
  applyQualOp, coerceQualOp, reviewStatus, QualOpError,
  cohenKappa, agreement, kappaWords, codersOf,
  themeFrequency, negativeCases, representativeQuotes, themeSummaries, validateClaims, themeSentiment, FREQUENCY_NOTE,
  codingBatches, codingPrompt, readCodingReply, mergeCoding, fakeCodingReply, selectSegments, codingEstimate, QUAL_CODING_SYSTEM,
  emptyCodebook, type QualState, type QualSegment, type QualExcerpt,
} from "./index.js";

/* ============================================================ transcripts */

const VTT = `WEBVTT

NOTE exported from a video call

1
00:00:01.000 --> 00:00:04.500
<v Moderator>Thanks for joining. Tell me about your
provider.</v>

2
00:00:05.000 --> 00:00:09.000
<v Anna>We've been with them six years.</v>

3
00:00:09.200 --> 00:00:12.000
<v Anna>The price went up twice last year.</v>

00:00:13.000 --> 00:00:15.000
<v Moderator>What happened then?</v>
`;

test("WebVTT: voice tags give speakers, timestamps kept, a speaker's consecutive cues are one turn, NOTE and cue ids skipped", () => {
  const p = parseTranscript(VTT);
  assert.equal(p.format, "vtt");
  assert.deepEqual(p.turns, [
    { speaker: "Moderator", start: 1, end: 4.5, text: "Thanks for joining. Tell me about your provider." },
    { speaker: "Anna", start: 5, end: 12, text: "We've been with them six years. The price went up twice last year." },
    { speaker: "Moderator", start: 13, end: 15, text: "What happened then?" },
  ]);
  assert.deepEqual(p.speakers, ["Moderator", "Anna"]);
  assert.deepEqual(p.warnings, []);
});

test("SRT: numbered cues, comma milliseconds, 'Name: text' speakers; unlabelled captions say so", () => {
  const srt = "1\n00:00:01,000 --> 00:00:03,000\nInterviewer: How long have you had it?\n\n2\n00:00:03,500 --> 00:01:02,250\nP1: About two years, maybe three.\n";
  const p = parseTranscript(srt, { fileName: "session-1.srt" });
  assert.equal(p.format, "srt");
  assert.deepEqual(p.turns.map((t) => [t.speaker, t.start, t.end, t.text]), [["Interviewer", 1, 3, "How long have you had it?"], ["P1", 3.5, 62.25, "About two years, maybe three."]]);
  const bare = parseTranscript("1\n00:00:01,000 --> 00:00:02,000\nhello there\n\n2\n00:00:02,500 --> 00:00:04,000\nand welcome.\n");
  assert.deepEqual(bare.turns.map((t) => t.text), ["hello there and welcome."], "an unlabelled cue continuing a sentence joins it");
  assert.match(bare.warnings[0], /carry no speaker names/);
});

test("'Speaker: text' transcripts: timestamps before or after the name, continuation lines, a docx-style paste", () => {
  const txt = `[00:00:05] Moderator: Welcome. What do you use the internet for?
[00:00:11] Respondent 2: Mostly work calls.
And streaming in the evening.
P3 (00:01:02): I game a lot, so speed matters.
00:02:10 Anna: The router keeps dropping.
Moderator: Thank you.`;
  assert.equal(detectTranscriptFormat(txt), "speaker");
  const p = parseTranscript(txt);
  assert.deepEqual(p.turns.map((t) => [t.speaker, t.start ?? null, t.text]), [
    ["Moderator", 5, "Welcome. What do you use the internet for?"],
    ["Respondent 2", 11, "Mostly work calls. And streaming in the evening."],
    ["P3", 62, "I game a lot, so speed matters."],
    ["Anna", 130, "The router keeps dropping."],
    ["Moderator", null, "Thank you."],
  ]);
  const plain = parseTranscript("First paragraph\nstill first.\n\nSecond paragraph.");
  assert.equal(plain.format, "text");
  assert.deepEqual(plain.turns.map((t) => t.text), ["First paragraph still first.", "Second paragraph."]);
  assert.match(plain.warnings[0], /one turn per paragraph/);
  assert.equal(detectTranscriptFormat("Note: this is prose. It has a colon: here.\nAnd more prose."), "text");
});

test("timestamps and segments: ids in order, the moderator role suggested, groups from the speaker map; open ends as segments", () => {
  assert.equal(parseTimestamp("01:02:03.5"), 3723.5);
  assert.equal(parseTimestamp("02:03,450"), 123.45);
  assert.equal(parseTimestamp("2:75"), null);
  assert.equal(formatTimestamp(3723.5), "1:02:03");
  assert.equal(formatTimestamp(62), "01:02");
  const segs = transcriptSegments("tr1", parseTranscript(VTT).turns, { Anna: { group: "Switchers" } });
  assert.deepEqual(segs.map((s) => [s.id, s.speaker, s.role, s.group ?? null, s.index]), [["t1", "Moderator", "moderator", null, 0], ["t2", "Anna", "participant", "Switchers", 1], ["t3", "Moderator", "moderator", null, 2]]);
  const oe = openEndSegments("oe1", [{ responseId: "r-123456789", answers: { q1: "Too expensive", q2: "" }, group: "North" }, { responseId: "r-2", answers: { Q1: { text: "Slow" } } }], [{ id: "q1", code: "Q1" }, { id: "q2" }]);
  assert.deepEqual(oe.map((s) => [s.id, s.responseId, s.text, s.group ?? null]), [["r-123456789:q1", "r-123456789", "Too expensive", "North"], ["r-2:q1", "r-2", "Slow", null]]);
});

/* ============================================================ redaction */

test("redaction: emails, phone numbers and the names list are replaced; times, years and prices are not; spans map back exactly", () => {
  const t = "I'm Anna Smith, call me on +44 20 7946 0958 or anna.smith@example.com. Anna's bill was £45 in 2024, at 10:30.";
  const r = redactText(t, { names: ["Anna Smith", "Anna"] });
  assert.equal(r.text, "I'm [name], call me on [phone] or [email]. [name]'s bill was £45 in 2024, at 10:30.");
  assert.deepEqual(redactionSummary([r]), { email: 1, phone: 1, name: 2 });
  const at = r.text.indexOf("[name]'s bill was £45");
  const span = originalSpan(r, at, at + "[name]'s bill was £45".length);
  assert.equal(t.slice(span.start, span.end), "Anna's bill was £45");
  const inside = originalSpan(r, r.text.indexOf("[phone]") + 2, r.text.indexOf("[phone]") + 4);
  assert.equal(t.slice(inside.start, inside.end), "+44 20 7946 0958", "a span inside a label covers the whole replaced text");
  assert.equal(redactText("no identifiers here").replacements.length, 0);
  assert.equal(redactText("Call 555-0100 now", { phones: false }).text, "Call 555-0100 now");
});

/* ============================================================ quotes */

test("quotes: exact substrings are found; case, curly quotes and spacing are forgiven but the SOURCE's span is returned; paraphrases and ellipses are rejected", () => {
  const src = "Honestly, the price went up — twice — and nobody told us why.";
  assert.deepEqual(locateQuote(src, "the price went up"), { start: 10, end: 27, exact: true });
  const folded = locateQuote(src, "THE PRICE went up - twice -  and nobody told us why");
  assert.ok(folded && !folded.exact);
  assert.equal(src.slice(folded!.start, folded!.end), "the price went up — twice — and nobody told us why");
  assert.equal(locateQuote(src, "the cost increased twice"), null, "a paraphrase");
  assert.equal(locateQuote(src, "the price went up ... nobody told us"), null, "an ellipsis");
  assert.equal(locateQuote(src, "price went up and nobody told us"), null, "stitched");
  assert.equal(locateQuote(src, "   "), null);
  assert.ok(quoteMatchesSegment({ charStart: 10, charEnd: 27, quote: "the price went up" }, src));
  assert.ok(!quoteMatchesSegment({ charStart: 10, charEnd: 27, quote: "the price went UP" }, src));
});

/* ============================================================ codebook review */

const SEGS: QualSegment[] = [
  { id: "t1", sourceKind: "transcript", sourceId: "A", index: 0, speaker: "Moderator", role: "moderator", text: "What made you think about switching?" },
  { id: "t2", sourceKind: "transcript", sourceId: "A", index: 1, speaker: "Anna", role: "participant", group: "Switchers", text: "The price went up twice and the speed was awful in the evenings." },
  { id: "t3", sourceKind: "transcript", sourceId: "A", index: 2, speaker: "Anna", role: "participant", group: "Switchers", text: "Customer service never called back." },
  { id: "t1", sourceKind: "transcript", sourceId: "B", index: 0, speaker: "Ben", role: "participant", group: "Stayers", text: "The price is fine for what we get, honestly." },
  { id: "t2", sourceKind: "transcript", sourceId: "B", index: 1, speaker: "Ben", role: "participant", group: "Stayers", text: "Speed drops sometimes but it's tolerable." },
];
const segOf = (src: string, id: string) => SEGS.find((s) => s.sourceId === src && s.id === id);
const env = (actor = "u1") => ({ actor, now: "2026-10-18T09:00:00Z", segment: segOf });
const ex = (id: string, codeId: string, src: string, seg: string, quote: string, coder = "ai", status: QualExcerpt["status"] = "ai_suggested"): QualExcerpt => {
  const s = segOf(src, seg)!; const at = s.text.indexOf(quote); assert.ok(at >= 0, quote);
  return { id, codeId, sourceKind: "transcript", sourceId: src, segmentId: seg, speaker: s.speaker, charStart: at, charEnd: at + quote.length, quote, coder, status };
};
const baseState = (): QualState => ({
  codebook: { ...emptyCodebook(), version: 1, codes: [
    { id: "c1", name: "Price", definition: "cost", status: "ai_suggested", origin: "inductive", themeId: "th1" },
    { id: "c2", name: "Cost", definition: "money", status: "ai_suggested", origin: "inductive", themeId: "th1" },
    { id: "c3", name: "Speed", definition: "speed", status: "ai_suggested", origin: "inductive", themeId: "th2" },
    { id: "c4", name: "Value for money", definition: "fair price", status: "human_reviewed", origin: "manual", themeId: "th1" },
  ], themes: [{ id: "th1", name: "Money", status: "ai_suggested" }, { id: "th2", name: "Network quality", status: "ai_suggested" }], relationships: [{ id: "r1", from: "c1", to: "c4", kind: "contradicts" }] },
  excerpts: [
    ex("x1", "c1", "A", "t2", "The price went up twice"),
    ex("x2", "c2", "B", "t1", "The price is fine for what we get"),
    ex("x3", "c3", "A", "t2", "the speed was awful in the evenings"),
    ex("x4", "c3", "B", "t2", "Speed drops sometimes"),
    ex("x5", "c4", "B", "t1", "The price is fine for what we get, honestly.", "u1", "human_reviewed"),
  ],
});

test("merge, rename, split, accept / reject, reassign — each with a history entry; excerpts move, never vanish", () => {
  let st = baseState();
  const m = applyQualOp(st, { op: "merge_codes", intoId: "c1", fromIds: ["c2"] }, env());
  st = m.state;
  assert.equal(m.entry.detail, "Merged “Cost” into “Price” (1 excerpt moved)");
  assert.deepEqual([m.entry.actor, m.entry.action, m.entry.at, m.entry.ids], ["u1", "merge_codes", "2026-10-18T09:00:00Z", ["c1", "c2"]]);
  assert.deepEqual(st.codebook.codes.map((c) => c.id), ["c1", "c3", "c4"]);
  assert.deepEqual(st.excerpts.filter((e) => e.codeId === "c1").map((e) => e.id), ["x1", "x2"]);
  assert.equal(st.codebook.codes[0].status, "human_reviewed");
  assert.equal(st.codebook.version, 2);
  const ren = applyQualOp(st, { op: "update_theme", themeId: "th1", name: "Cost and value" }, env());
  assert.equal(ren.entry.detail, "Edited theme “Cost and value”: renamed “Money” → “Cost and value”");
  st = ren.state;
  const sp = applyQualOp(st, { op: "split_code", codeId: "c1", into: [{ name: "Price rises", excerptIds: ["x1"] }, { name: "Price acceptable", excerptIds: ["x2"] }], removeOriginal: true }, env());
  assert.match(sp.entry.detail, /^Split “Price” into “Price rises”, “Price acceptable” \(2 excerpts moved; original removed\)$/);
  st = sp.state;
  assert.ok(!st.codebook.codes.some((c) => c.id === "c1"));
  const rises = st.codebook.codes.find((c) => c.name === "Price rises")!;
  assert.equal(st.excerpts.find((e) => e.id === "x1")!.codeId, rises.id);
  assert.equal(rises.themeId, "th1", "a split keeps the theme");
  assert.throws(() => applyQualOp(st, { op: "split_code", codeId: "c3", into: [{ name: "Evening speed", excerptIds: ["x3"] }], removeOriginal: true }, env()), /still has 1 excerpt/);
  const rej = applyQualOp(st, { op: "review_code", codeId: "c3", decision: "reject" }, env());
  assert.equal(rej.entry.detail, "Rejected code “Speed” and its 2 suggested excerpts");
  assert.deepEqual(rej.state.excerpts.filter((e) => e.codeId === "c3").map((e) => e.status), ["rejected", "rejected"]);
  const re = applyQualOp(st, { op: "reassign_excerpt", excerptId: "x4", codeId: rises.id }, env());
  assert.equal(re.entry.detail, "Moved excerpt x4 from “Speed” to “Price rises”");
  assert.equal(re.state.excerpts.find((e) => e.id === "x4")!.status, "human_reviewed");
  assert.throws(() => applyQualOp(st, { op: "add_code", name: "price rises" }, env()), (e: unknown) => e instanceof QualOpError && e.status === 409);
  assert.deepEqual(reviewStatus(baseState()).excerpts, { ai_suggested: 4, human_reviewed: 1, rejected: 0 });
});

test("a hand-made excerpt is checked like a model's: the quote must be the segment's exact words", () => {
  const st = baseState();
  const ok = applyQualOp(st, { op: "add_excerpt", codeId: "c3", sourceId: "A", segmentId: "t2", quote: "SPEED WAS AWFUL" }, env("u2"));
  const x = ok.state.excerpts.at(-1)!;
  assert.deepEqual([x.id, x.quote, x.coder, x.status, x.speaker], ["x6", "speed was awful", "u2", "human_reviewed", "Anna"], "the source's own casing is stored");
  assert.ok(quoteMatchesSegment(x, segOf("A", "t2")!.text));
  assert.throws(() => applyQualOp(st, { op: "add_excerpt", codeId: "c3", sourceId: "A", segmentId: "t2", quote: "the connection was slow" }, env()), /not in the segment/);
  assert.throws(() => applyQualOp(st, { op: "add_excerpt", codeId: "c3", sourceId: "A", segmentId: "t9", quote: "x" }, env()), /no segment t9/);
  const bySpan = applyQualOp(st, { op: "add_excerpt", codeId: "c3", sourceId: "B", segmentId: "t2", charStart: 0, charEnd: 5 }, env());
  assert.equal(bySpan.state.excerpts.at(-1)!.quote, "Speed");
  assert.deepEqual(brokenQuotes(bySpan.state.excerpts, SEGS), []);
  assert.deepEqual(brokenQuotes([{ ...x, quote: "speed was AWFUL" }], SEGS).map((e) => e.id), ["x6"]);
  assert.equal(typeof coerceQualOp({ op: "merge_codes", intoId: "c1" }), "string");
  assert.equal(typeof coerceQualOp({ op: "drop_table" }), "string");
  assert.deepEqual(coerceQualOp({ op: "review_excerpt", excerptId: "x1", decision: "accept" }), { op: "review_excerpt", excerptId: "x1", decision: "accept" });
});

/* ============================================================ kappa */

test("Cohen's kappa against a hand-computed example: 10 segments, A codes 1–5, B codes 1–3 and 6 → po .7, pe .5, κ .4", () => {
  const k = cohenKappa({ both: 3, onlyA: 2, onlyB: 1, neither: 4 });
  assert.deepEqual(k, { both: 3, onlyA: 2, onlyB: 1, neither: 4, n: 10, po: 0.7, pe: 0.5, kappa: 0.4 });
  assert.equal(kappaWords(0.4), "fair");
  assert.equal(cohenKappa({ both: 5, onlyA: 0, onlyB: 0, neither: 0 }).kappa, null, "no variation: undefined, not 1");
  assert.equal(cohenKappa({ both: 0, onlyA: 2, onlyB: 2, neither: 0 }).kappa, -1);
  /* the same example through the state: two coders on ten segments of one source */
  const segs: QualSegment[] = Array.from({ length: 10 }, (_, i) => ({ id: `t${i + 1}`, sourceKind: "transcript", sourceId: "S", index: i, speaker: "P", role: "participant", text: `segment number ${i + 1} text` }));
  const mk = (coder: string, n: number, k2: number): QualExcerpt => ({ id: `${coder}${n}`, codeId: "c1", sourceKind: "transcript", sourceId: "S", segmentId: `t${n}`, charStart: 0, charEnd: 7, quote: "segment", coder, status: "human_reviewed", ...(k2 ? {} : {}) });
  const state: QualState = { codebook: { ...emptyCodebook(), codes: [{ id: "c1", name: "Price", definition: "", status: "human_reviewed", origin: "manual" }] }, excerpts: [...[1, 2, 3, 4, 5].map((n) => mk("u1", n, 0)), ...[1, 2, 3, 6].map((n) => mk("u2", n, 0))] };
  const rep = agreement(state, "u1", "u2", { allUnits: segs.map((s) => `S|${s.id}`) });
  assert.equal(rep.units.length, 10);
  assert.deepEqual([rep.codes[0].kappa, rep.codes[0].po, rep.codes[0].pe], [0.4, 0.7, 0.5]);
  assert.deepEqual(rep.codes[0].disagreements, [{ segmentKey: "S|t4", appliedBy: "A" }, { segmentKey: "S|t5", appliedBy: "A" }, { segmentKey: "S|t6", appliedBy: "B" }]);
  assert.equal(rep.meanKappa, 0.4);
  assert.deepEqual(codersOf(state), ["u1", "u2"]);
  const none = agreement(state, "u1", "u3");
  assert.deepEqual([none.units.length, none.codes.length], [0, 0], "a coder who coded nothing shares no units");
});

/* ============================================================ analysis */

test("theme frequency by group, labelled; moderator turns never counted; negative cases; representative quotes from different sources", () => {
  const st = baseState();
  const t = themeFrequency(st, SEGS);
  assert.equal(t.note, FREQUENCY_NOTE);
  assert.match(t.note, /not importance/);
  assert.deepEqual(t.groups, ["Stayers", "Switchers"]);
  assert.deepEqual(t.base, { segments: 4, sources: 2 }, "the moderator turn is not in the base");
  const money = t.rows.find((r) => r.id === "th1")!;
  assert.deepEqual(money.total, { excerpts: 3, segments: 2, sources: 2, share: 50 });
  assert.deepEqual(money.byGroup.Switchers, { excerpts: 1, segments: 1, sources: 1, share: 50 });
  assert.deepEqual(money.byGroup.Stayers, { excerpts: 2, segments: 1, sources: 1, share: 50 });
  assert.ok(t.rows.some((r) => r.level === "code" && r.name === "Speed"));
  assert.deepEqual(negativeCases(st, "th1").map((e) => e.id), [], "contradicting codes inside the same theme are not counter-evidence to it");
  const st2: QualState = { ...st, excerpts: st.excerpts.map((e) => e.id === "x2" ? { ...e, negativeCase: true } : e) };
  assert.deepEqual(negativeCases(st2, "th1").map((e) => e.id), ["x2"]);
  const q = representativeQuotes(st, SEGS, { themeId: "th1" }, 2);
  assert.equal(new Set(q.map((e) => e.sourceId)).size, 2, "one per source first");
  assert.equal(q[0].status, "human_reviewed", "reviewed before suggested");
  for (const e of q) assert.ok(quoteMatchesSegment(e, segOf(e.sourceId, e.segmentId)!.text));
  const sums = themeSummaries(st, SEGS);
  const s1 = sums.find((x) => x.themeId === "th1")!;
  assert.match(s1.claims[0].text, /^“Money” was coded in 2 of 2 sources \(2 participant segments, 3 excerpts\)\.$/);
  for (const c of s1.claims) assert.ok(c.excerptIds.length > 0 && c.excerptIds.every((id) => st.excerpts.some((e) => e.id === id)), c.text);
  assert.equal(s1.status, "contains AI suggestions not yet reviewed");
  const v = validateClaims([{ text: "Price rises drive switching.", excerptIds: ["x1"] }, { text: "Everyone hates the price.", excerptIds: [] }, { text: "Made up.", excerptIds: ["x99"] }], st);
  assert.deepEqual(v.kept.map((c) => c.text), ["Price rises drive switching."]);
  assert.deepEqual(v.dropped.map((d) => d.reason), ["cites no excerpt", "cites excerpts that do not exist or were rejected: x99"]);
  const sent = themeSentiment(st, "th2");
  assert.equal(sent.n, 2);
  assert.match(sent.label, /indicative only/);
});

/* ============================================================ AI coding */

test("AI coding: redacted batches, the reply read with every quote located — a paraphrase rejected, a redacted quote mapped to the original span", () => {
  const segs: QualSegment[] = [
    { id: "t1", sourceKind: "transcript", sourceId: "A", index: 0, speaker: "Moderator", role: "moderator", text: "Why did you leave?" },
    { id: "t2", sourceKind: "transcript", sourceId: "A", index: 1, speaker: "Anna", role: "participant", text: "Anna Smith here — the price went up and anna@example.com got no reply." },
  ];
  const { batches } = codingBatches(segs, { redact: { names: ["Anna Smith"] } });
  assert.equal(batches.length, 1);
  const prompt = codingPrompt(batches[0], { mode: "inductive" });
  assert.ok(!prompt.includes("Anna Smith") && !prompt.includes("anna@example.com"), "no identifier reaches the model");
  assert.match(prompt, /\[S2\] Anna: \[name\] here — the price went up and \[email\] got no reply\./);
  assert.match(QUAL_CODING_SYSTEM, /CHARACTER FOR CHARACTER/);
  const read = readCodingReply({
    themes: [{ name: "Money" }],
    codes: [{ name: "Price rise", definition: "the price went up", theme: "Money" }, { name: "No definition" }],
    excerpts: [
      { segment: "S2", code: "Price rise", quote: "[name] here — the price went up" },
      { segment: "S2", code: "Price rise", quote: "the cost increased" },
      { segment: "S1", code: "Price rise", quote: "Why did you leave?" },
      { segment: "S9", code: "Price rise", quote: "x" },
      { segment: "S2", code: "Service", quote: "got no reply" },
    ],
  }, batches[0], { mode: "inductive" });
  assert.equal(read.excerpts.length, 1);
  assert.equal(read.excerpts[0].quote, "Anna Smith here — the price went up", "the original span, exactly");
  assert.equal(segs[1].text.slice(read.excerpts[0].charStart, read.excerpts[0].charEnd), read.excerpts[0].quote);
  assert.deepEqual(read.rejected.map((r) => r.reason), ["not an exact quote from the segment (paraphrased, shortened or from elsewhere)", "a moderator turn is context, not a participant's view", "there is no segment S9 in this batch", "“Service” is not a code in the codebook or the proposal"]);
  assert.deepEqual(read.problems, ["code “No definition” came without a definition and was left out"]);
  const merged = mergeCoding({ codebook: emptyCodebook(), excerpts: [] }, [read], { now: "2026-10-18T10:00:00Z", mode: "inductive", segmentCount: 2 });
  assert.deepEqual(merged.added, { codes: 1, themes: 1, excerpts: 1 });
  assert.equal(merged.state.codebook.codes[0].status, "ai_suggested");
  assert.equal(merged.state.codebook.codes[0].themeId, merged.state.codebook.themes[0].id);
  assert.equal(merged.state.excerpts[0].coder, "ai");
  assert.match(merged.entry.detail, /^AI inductive coding of 2 segments: 1 new code, 1 new theme, 1 excerpt suggested; 4 quotes rejected/);
  const again = mergeCoding(merged.state, [read], { now: "2026-10-18T11:00:00Z", mode: "inductive", segmentCount: 2 });
  assert.deepEqual(again.added, { codes: 0, themes: 0, excerpts: 0 }, "a re-run adds nothing twice");
});

test("the fake provider's answer is deterministic, verbatim and goes through the same reader; deductive re-runs use the codebook", () => {
  const { batches } = codingBatches(SEGS);
  const r1 = fakeCodingReply(batches[0], { mode: "inductive" }), r2 = fakeCodingReply(batches[0], { mode: "inductive" });
  assert.deepEqual(r1, r2);
  const read = readCodingReply(r1, batches[0], { mode: "inductive" });
  assert.deepEqual(read.rejected, []);
  assert.ok(read.codes.length >= 2 && read.excerpts.length >= 2);
  for (const e of read.excerpts) assert.ok(quoteMatchesSegment(e, e.segment.text), e.quote);
  assert.ok(read.excerpts.every((e) => e.segment.role !== "moderator"));
  const st = baseState();
  const sel = selectSegments(SEGS, { sourceIds: ["B"] });
  assert.deepEqual(sel.map((s) => `${s.sourceId}|${s.id}`), ["B|t1", "B|t2"]);
  const b2 = codingBatches(sel).batches[0];
  const ded = readCodingReply(fakeCodingReply(b2, { mode: "deductive", codebook: st.codebook }), b2, { mode: "deductive", codebook: st.codebook });
  assert.deepEqual([...new Set(ded.excerpts.map((e) => e.code))].sort(), ["Price", "Speed"], "a code is applied where its words are");
  const est = codingEstimate(codingBatches(SEGS).batches, { mode: "inductive" });
  assert.equal(est.calls, 1);
  assert.ok(est.inputTokens > 100);
  const many = codingBatches(Array.from({ length: 30 }, (_, i) => ({ ...SEGS[1], id: `t${i}`, text: "x".repeat(1000) })), { maxChars: 3000, maxBatches: 2 });
  assert.equal(many.batches.length, 2);
  assert.ok(many.skipped > 0, "what does not fit the bound is reported, not sent");
});
