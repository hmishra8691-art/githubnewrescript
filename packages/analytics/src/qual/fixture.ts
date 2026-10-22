import type { QualSegment, QualState } from "./types.js";
import { transcriptSegments, parseTranscript } from "./transcripts.js";

/*
 * A small coded study for the synthesis tests (2026-10-22): two interviews in Mumbai, one in Delhi; a codebook
 * with two themes; excerpts that are exact spans of their segments (checked by the tests).
 */
const T1 = `[00:00:05] Moderator: What made you think about switching provider?
[00:00:12] Asha: The price went up twice last year and nobody explained why.
[00:00:40] Asha: The speed is fine, honestly.
[00:01:10] Moderator: Anything else?
[00:01:20] Asha: Customer service kept me waiting for an hour.`;
const T2 = `[00:00:03] Moderator: Tell me about your provider.
[00:00:09] Vikram: Price matters most to me, the bill keeps rising.
[00:00:30] Vikram: Support was helpful when I called them.`;
const T3 = `[00:00:04] Moderator: How do you feel about your provider?
[00:00:10] Neha: I do not mind paying more for a reliable connection.
[00:00:25] Neha: The app is confusing and support never answers.`;

export function fixtureSegments(): QualSegment[] {
  const mk = (id: string, text: string, group: string) => transcriptSegments(id, parseTranscript(text).turns).map((s) => (s.role === "moderator" ? s : { ...s, group }));
  return [...mk("src1", T1, "Mumbai"), ...mk("src2", T2, "Mumbai"), ...mk("src3", T3, "Delhi")];
}

export function fixtureState(): QualState {
  const segs = fixtureSegments();
  const seg = (src: string, id: string) => segs.find((s) => s.sourceId === src && s.id === id)!;
  const ex = (id: string, codeId: string, src: string, segId: string, quote: string, extra: Record<string, unknown> = {}) => {
    const s = seg(src, segId);
    const at = s.text.indexOf(quote);
    if (at < 0) throw new Error(`fixture: “${quote}” not in ${src}/${segId}`);
    return { id, codeId, sourceKind: "transcript" as const, sourceId: src, segmentId: segId, speaker: s.speaker, start: s.start, charStart: at, charEnd: at + quote.length, quote, coder: "ai", status: "human_reviewed" as const, ...extra };
  };
  return {
    codebook: {
      version: 3, method: "inductive",
      themes: [{ id: "th1", name: "Cost and value", status: "human_reviewed" }, { id: "th2", name: "Service problems", status: "human_reviewed" }],
      codes: [
        { id: "c1", name: "Price rise", definition: "the price went up", themeId: "th1", status: "human_reviewed", origin: "inductive" },
        { id: "c2", name: "Willing to pay", definition: "accepts paying more", themeId: "th1", status: "human_reviewed", origin: "inductive" },
        { id: "c3", name: "Support", definition: "customer support experience", themeId: "th2", status: "human_reviewed", origin: "inductive" },
      ],
      relationships: [{ id: "r1", from: "c1", to: "c2", kind: "contradicts" }],
    },
    excerpts: [
      ex("x1", "c1", "src1", "t2", "The price went up twice last year"),
      ex("x2", "c1", "src2", "t2", "Price matters most to me, the bill keeps rising."),
      ex("x3", "c2", "src3", "t2", "I do not mind paying more for a reliable connection."),
      ex("x4", "c3", "src1", "t5", "Customer service kept me waiting for an hour."),
      ex("x5", "c3", "src2", "t3", "Support was helpful when I called them.", { negativeCase: true }),
      ex("x6", "c3", "src3", "t3", "support never answers", { status: "ai_suggested" }),
    ],
  };
}
