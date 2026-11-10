import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCoding } from "./validation.js";
import { applyQualOp } from "./codebook.js";
import type { QualExcerpt, QualSegment, QualState } from "./types.js";

/**
 * Tested on a realistic transcript: two interviews about cancelling a streaming subscription, with a moderator, short
 * acknowledgements, a repeated sentence, and a codebook carrying the mistakes a real one accumulates.
 */
const T1: [string, string][] = [
  ["Moderator", "Thanks for joining. Can you tell me why you cancelled your subscription last month?"],
  ["P1", "Honestly I only ever used it for one show, and once that finished I completely forgot I was paying for it until the charge came through."],
  ["Moderator", "What did you feel when you saw the charge?"],
  ["P1", "Annoyed, mostly at myself. It was not a lot of money but it felt like paying for nothing, so I cancelled the same evening."],
  ["P1", "Yes."],
  ["Moderator", "Was there anything that would have kept you?"],
  ["P1", "If they had reminded me there was more to watch, something like the shows my friends talk about, I might have stayed another month or two."],
  ["P1", "The price went up as well, which did not help, although I would not say the price was the main reason I left."],
];
const T2: [string, string][] = [
  ["Moderator", "Why did you decide to cancel?"],
  ["P2", "The price went up twice in a year and I could not justify it any more when we already pay for two other services at home."],
  ["P2", "It was not a lot of money but it felt like paying for nothing, so I cancelled the same evening."],
  ["Moderator", "Did you look at cheaper plans?"],
  ["P2", "I looked at the plan with adverts but the saving was tiny, and my partner hates adverts, so we did not bother switching to it."],
  ["P2", "The app itself was fine, I never had a problem finding things, and the picture quality was always good on our television."],
];
const segs = (src: string, rows: [string, string][]): QualSegment[] => rows.map(([speaker, text], i) => ({ id: `t${i + 1}`, sourceKind: "transcript", sourceId: src, index: i, speaker, role: speaker === "Moderator" ? "moderator" : "participant", text }));
const SEGMENTS = [...segs("int1", T1), ...segs("int2", T2)];
let n = 0;
const ex = (codeId: string, src: string, segId: string, phrase: string, extra: Partial<QualExcerpt> = {}): QualExcerpt => {
  const seg = SEGMENTS.find((s) => s.sourceId === src && s.id === segId)!;
  const at = seg.text.indexOf(phrase);
  assert.ok(at >= 0, `“${phrase}” is in ${src} ${segId}`);
  return { id: `e${++n}`, codeId, sourceKind: "transcript", sourceId: src, segmentId: segId, charStart: at, charEnd: at + phrase.length, quote: phrase, coder: "u1", status: "human_reviewed", ...extra };
};
const code = (id: string, name: string, definition: string, themeId: string | null = null, status: "human_reviewed" | "ai_suggested" | "rejected" = "human_reviewed") => ({ id, name, definition, themeId, status, origin: "inductive" as const });

function messy(): QualState {
  return {
    codebook: {
      version: 3, method: "inductive",
      themes: [{ id: "th_use", name: "Low engagement", status: "human_reviewed" }, { id: "th_price", name: "Price", status: "human_reviewed" }, { id: "th_empty", name: "Competitors", status: "human_reviewed" }],
      codes: [
        code("c_single", "Single-title usage", "Subscribed for one show and did not watch anything else", "th_use"),
        code("c_forgot", "Forgotten subscription", "Did not remember they were paying", "th_use"),
        code("c_price", "Price increase", "Mentions that the price went up", "th_price"),
        code("c_price2", "Price increases", "", "th_price"),
        code("c_notprice", "Price not the reason", "Says price was not why they left", "th_price"),
        code("c_value", "Paying for nothing", "Feels the subscription gave no value", "th_use"),
        code("c_waste", "Wasted money", "Money spent without use"),
        code("c_ads", "Ad-supported plan", "", null, "ai_suggested"),
        code("c_old", "Old idea", "No longer used", null, "rejected"),
      ],
      relationships: [{ id: "r1", from: "c_price", to: "c_notprice", kind: "contradicts" }],
    },
    excerpts: [
      ex("c_single", "int1", "t2", "I only ever used it for one show"),
      ex("c_forgot", "int1", "t2", "I completely forgot I was paying for it"),
      /* the same words in two interviews, coded differently */
      ex("c_value", "int1", "t4", "It was not a lot of money but it felt like paying for nothing"),
      ex("c_waste", "int2", "t3", "It was not a lot of money but it felt like paying for nothing"),
      /* two codes on the same passages */
      ex("c_value", "int1", "t4", "so I cancelled the same evening"), ex("c_waste", "int1", "t4", "I cancelled the same evening"),
      ex("c_value", "int2", "t3", "so I cancelled the same evening"), ex("c_waste", "int2", "t3", "cancelled the same evening"),
      ex("c_waste", "int1", "t2", "until the charge came through"), ex("c_value", "int1", "t2", "the charge came through"),
      /* one passage coded to two codes that contradict */
      ex("c_price", "int1", "t8", "The price went up as well, which did not help"),
      ex("c_notprice", "int1", "t8", "which did not help, although I would not say the price was the main reason"),
      ex("c_price", "int2", "t2", "The price went up twice in a year"),
      /* support and negative case for the same theme on one passage */
      ex("c_price2", "int2", "t2", "I could not justify it any more", { negativeCase: true }),
      ex("c_price", "int2", "t2", "could not justify it any more when we already pay for two other services"),
      ex("c_ads", "int2", "t5", "I looked at the plan with adverts but the saving was tiny", { status: "ai_suggested", coder: "ai" }),
      ex("c_old", "int1", "t7", "I might have stayed another month or two"),
    ],
  };
}

test("a realistic, messy codebook: every kind of problem is found, with where it is and what to do", () => {
  const v = validateCoding(messy(), SEGMENTS);
  const of = (k: string) => v.checks.filter((c) => c.kind === k);
  assert.equal(v.ok, false);
  /* duplicates: "Price increase" / "Price increases" */
  assert.deepEqual(of("duplicate_codes")[0].codeIds!.sort(), ["c_price", "c_price2"]);
  assert.match(of("duplicate_codes")[0].action, /Merge/);
  /* overlap: "Paying for nothing" and "Wasted money" sit on the same passages */
  assert.deepEqual(of("overlapping_codes").map((c) => c.codeIds!.sort()), [["c_value", "c_waste"]]);
  /* definitions, use, themes */
  assert.deepEqual(of("undefined_code").map((c) => c.codeIds![0]).sort(), ["c_ads", "c_price2"]);
  assert.deepEqual(of("unthemed_code").map((c) => c.codeIds![0]).sort(), ["c_ads", "c_waste"]);
  assert.deepEqual(of("empty_theme").map((c) => c.themeIds![0]), ["th_empty"]);
  /* uncoded: P1's "what would have kept me" (its only excerpt is on a rejected code) and P2's remark about the app; "Yes." and the moderator are not counted */
  const un = of("uncoded_segments")[0];
  assert.deepEqual(un.segmentKeys!.sort(), ["int1#t7", "int2#t6"]);
  assert.deepEqual(v.coverage, { participantSegments: 8, coded: 6, uncoded: 2, share: 0.75 });
  /* contradictions: the two price codes on one passage; support and negative case on one passage */
  assert.equal(of("contradiction").length, 2);
  assert.match(of("contradiction")[0].message, /“Price increase” and “Price not the reason”/);
  assert.match(of("contradiction")[1].message, /both as support and as a negative case/);
  /* the same sentence coded differently in two interviews */
  assert.match(of("inconsistent_coding")[0].message, /It was not a lot of money but it felt like paying for nothing.*coded differently in 2 places/);
  assert.match(of("unreviewed")[0].message, /1 code and 1 coded passage are AI suggestions/);
  /* highest severity first */
  assert.equal(v.checks[0].severity, "high");
  assert.ok(v.checks.every((c) => c.message.length > 20 && c.action.length > 10));
});

test("the codebook's own actions resolve the findings: merge the duplicates and the overlap, define, theme, delete, review", () => {
  let s = messy();
  const ctx = { actor: "u1", now: "2026-11-10T00:00:00.000Z", segment: (src: string, id: string) => SEGMENTS.find((x) => x.sourceId === src && x.id === id) };
  const run = (op: Record<string, unknown>) => { const r = applyQualOp(s, op as never, ctx as never) as { ok?: boolean; state?: QualState; error?: string }; assert.ok(r.state, `${String(op.op)}: ${r.error ?? ""}`); s = r.state!; };
  run({ op: "merge_codes", fromIds: ["c_price2"], intoId: "c_price" });
  run({ op: "merge_codes", fromIds: ["c_waste"], intoId: "c_value" });
  const after = validateCoding(s, SEGMENTS);
  assert.equal(after.counts.duplicate_codes, 0);
  assert.equal(after.counts.overlapping_codes, 0);
  assert.equal(after.counts.inconsistent_coding, 0, "the repeated sentence now carries one code in both interviews");
  assert.ok(after.checks.length < validateCoding(messy(), SEGMENTS).checks.length);
});

test("a clean codebook passes, and an empty one reports only what is uncoded", () => {
  const clean: QualState = { codebook: { version: 1, method: "inductive", themes: [{ id: "t", name: "Low engagement", status: "human_reviewed" }], relationships: [], codes: [code("a", "Single-title usage", "Subscribed for one show", "t")] }, excerpts: SEGMENTS.filter((x) => x.role === "participant" && x.text.split(" ").length >= 12).map((x) => ({ id: `k${x.sourceId}${x.id}`, codeId: "a", sourceKind: "transcript" as const, sourceId: x.sourceId, segmentId: x.id, charStart: 0, charEnd: 10, quote: x.text.slice(0, 10), coder: "u1", status: "human_reviewed" as const })) };
  const v = validateCoding(clean, SEGMENTS);
  assert.deepEqual(v.checks, []);
  assert.equal(v.ok, true);
  assert.equal(v.coverage.share, 1);
  const empty = validateCoding({ codebook: { version: 0, method: "inductive", codes: [], themes: [], relationships: [] }, excerpts: [] }, SEGMENTS);
  assert.deepEqual(empty.checks.map((c) => c.kind), ["uncoded_segments"]);
  assert.equal(empty.checks[0].severity, "high");
});
