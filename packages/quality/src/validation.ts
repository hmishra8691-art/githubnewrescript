import { SurveyDefinition } from "@rescript/schema";
import type { QualityVerdict } from "@rescript/schema";
import type { ResponseRecord, ResponseTelemetry, QualityAssessment } from "./types.js";
import { assessSurvey } from "./engine.js";

/**
 * VALIDATING THE QUALITY ENGINE AGAINST LABELLED RESPONSES (ResLens roadmap Phase 1, completion criterion).
 *
 * "The Research Quality Engine must be validated against a manually labelled test dataset containing genuine,
 * inattentive, duplicate, suspicious and fraudulent response examples. Measure precision, recall, false-positive
 * rates and performance across relevant respondent segments. Do not automatically reject responses until the
 * scoring system has passed validation."
 *
 * Two halves:
 *
 *   evaluateQuality(def, labelled)   runs the real engine (`assessSurvey`, every rule, peers and clusters) over
 *                                    responses whose truth is known and reports, per label and per segment, how
 *                                    often each verdict was given: precision and recall of FLAGGED (what an
 *                                    exclusion would act on) and of "not PASS" (what the review queue sees), the
 *                                    false-positive rate on genuine respondents — overall and in every segment —
 *                                    and the genuine respondents who were wrongly flagged, with the reasons given.
 *   exclusionGate(report)            the switch: automatic exclusion stays LOCKED unless the report clears every
 *                                    threshold (precision, genuine false positives overall AND per segment,
 *                                    recall on the clear-cut classes, a minimum sample). It returns the reasons
 *                                    when locked. Nothing in the product excludes anybody on its own today; this
 *                                    is the evidence any future automatic action must show first.
 *
 * And a corpus: `syntheticLabelledCorpus()` — SYNTHETIC, labelled by construction, clearly marked as such. It is a
 * regression benchmark for the engine's logic (including deliberate hard negatives: fast-but-careful readers,
 * people with strong opinions, an office sharing one IP address, terse mobile answers), not a substitute for a
 * manually labelled sample of real responses. `evaluateQuality` takes either; the real sample is what the gate
 * must ultimately be run on (see `LabelledResponse.source`).
 */

export type QualityLabel = "genuine" | "inattentive" | "duplicate" | "suspicious" | "fraudulent";

export interface LabelledResponse {
  response: ResponseRecord;
  label: QualityLabel;
  /** a finer description of how this case was built or why a reviewer labelled it so ("fast reader", "bot") */
  persona: string;
  /** segments the false-positive rate is broken down by */
  segments: Record<string, string>;
  /** "synthetic" (built by construction) or "manual" (a person labelled a real response) */
  source: "synthetic" | "manual";
  /** a genuine case where REVIEW is the right call (the earlier half of a duplicate pair): counted, but not as a review false positive */
  reviewAcceptable?: boolean;
}

export interface Rate { n: number; hits: number; rate: number }
const rate = (hits: number, n: number): Rate => ({ n, hits, rate: n ? hits / n : 0 });

export interface QualityValidationReport {
  responses: number;
  source: "synthetic" | "manual" | "mixed";
  byLabel: Record<string, { n: number; PASS: number; REVIEW: number; FLAGGED: number }>;
  byPersona: Record<string, { label: QualityLabel; n: number; PASS: number; REVIEW: number; FLAGGED: number }>;
  /** FLAGGED = the exclusion candidate set */
  flagged: { precision: Rate; recall: Rate; genuineFalsePositive: Rate };
  /** not PASS = the review queue */
  detected: { precision: Rate; recall: Rate; genuineFalsePositive: Rate };
  /** recall of "not PASS" per problem label */
  recallByLabel: Record<string, Rate>;
  /** genuine FLAGGED / REVIEW rates per segment value ("device=mobile") */
  genuineBySegment: Record<string, { flagged: Rate; detected: Rate }>;
  /** every genuine respondent who was not PASS, with what the engine said — what a reviewer reads first */
  falsePositives: { sessionId: string; persona: string; verdict: QualityVerdict; reasons: string[] }[];
  /** every problem respondent who passed */
  misses: { sessionId: string; label: QualityLabel; persona: string; riskScore: number }[];
}

export function evaluateQuality(def: SurveyDefinition, labelled: LabelledResponse[], now?: number): QualityValidationReport {
  const result = assessSurvey(def, labelled.map((l) => l.response), undefined, now);
  const verdictOf = (l: LabelledResponse): QualityAssessment | undefined => result.bySession.get(l.response.sessionId);
  const byLabel: QualityValidationReport["byLabel"] = {};
  const byPersona: QualityValidationReport["byPersona"] = {};
  const seg: Record<string, { n: number; f: number; d: number }> = {};
  const falsePositives: QualityValidationReport["falsePositives"] = [];
  const misses: QualityValidationReport["misses"] = [];
  let flaggedProblem = 0, flaggedAll = 0, detectedProblem = 0, detectedAll = 0, problems = 0, genuine = 0, genuineFlagged = 0, genuineDetected = 0;
  const recall: Record<string, { n: number; hits: number }> = {};
  for (const l of labelled) {
    const a = verdictOf(l);
    const v: QualityVerdict = a?.verdict ?? "PASS";
    (byLabel[l.label] ??= { n: 0, PASS: 0, REVIEW: 0, FLAGGED: 0 }).n++;
    byLabel[l.label]![v]++;
    (byPersona[l.persona] ??= { label: l.label, n: 0, PASS: 0, REVIEW: 0, FLAGGED: 0 }).n++;
    byPersona[l.persona]![v]++;
    const isProblem = l.label !== "genuine";
    if (v === "FLAGGED") { flaggedAll++; if (isProblem) flaggedProblem++; }
    if (v !== "PASS") { detectedAll++; if (isProblem) detectedProblem++; }
    if (isProblem) {
      problems++;
      const r = (recall[l.label] ??= { n: 0, hits: 0 });
      r.n++; if (v !== "PASS") r.hits++;
      if (v === "PASS") misses.push({ sessionId: l.response.sessionId, label: l.label, persona: l.persona, riskScore: a?.riskScore ?? 0 });
    } else {
      genuine++;
      if (v === "FLAGGED") genuineFlagged++;
      if (v !== "PASS" && !(v === "REVIEW" && l.reviewAcceptable)) { genuineDetected++; falsePositives.push({ sessionId: l.response.sessionId, persona: l.persona, verdict: v, reasons: (a?.reasons ?? []).slice(0, 4) }); }
      for (const [k, val] of Object.entries(l.segments)) {
        const s = (seg[`${k}=${val}`] ??= { n: 0, f: 0, d: 0 });
        s.n++; if (v === "FLAGGED") s.f++; if (v !== "PASS" && !(v === "REVIEW" && l.reviewAcceptable)) s.d++;
      }
    }
  }
  const sources = new Set(labelled.map((l) => l.source));
  return {
    responses: labelled.length,
    source: sources.size > 1 ? "mixed" : ([...sources][0] ?? "synthetic"),
    byLabel, byPersona,
    flagged: { precision: rate(flaggedProblem, flaggedAll), recall: rate(flaggedProblem, problems), genuineFalsePositive: rate(genuineFlagged, genuine) },
    detected: { precision: rate(detectedProblem, detectedAll), recall: rate(detectedProblem, problems), genuineFalsePositive: rate(genuineDetected, genuine) },
    recallByLabel: Object.fromEntries(Object.entries(recall).map(([k, r]) => [k, rate(r.hits, r.n)])),
    genuineBySegment: Object.fromEntries(Object.entries(seg).map(([k, s]) => [k, { flagged: rate(s.f, s.n), detected: rate(s.d, s.n) }])),
    falsePositives, misses,
  };
}

/* ------------------------------------------------------------------ the gate */

export interface GateThresholds {
  /** of everything FLAGGED, at least this share must be a real problem */
  minFlaggedPrecision: number;
  /** at most this share of genuine respondents FLAGGED, overall */
  maxGenuineFlagged: number;
  /** …and in any segment with at least `minSegmentN` genuine respondents */
  maxGenuineFlaggedInSegment: number;
  minSegmentN: number;
  /** at most this share of genuine respondents sent to review */
  maxGenuineReview: number;
  /** recall ("not PASS") required for the clear-cut classes */
  minRecall: Partial<Record<QualityLabel, number>>;
  /** labelled responses needed before any verdict about the engine counts */
  minResponses: number;
  /** a synthetic corpus can never unlock automatic exclusion on its own */
  requireManualLabels: boolean;
}

export const DEFAULT_GATE: GateThresholds = {
  minFlaggedPrecision: 0.95,
  maxGenuineFlagged: 0.01,
  maxGenuineFlaggedInSegment: 0.03,
  minSegmentN: 20,
  maxGenuineReview: 0.10,
  minRecall: { fraudulent: 0.9, duplicate: 0.9, inattentive: 0.75 },
  minResponses: 300,
  requireManualLabels: true,
};

export interface GateResult { open: boolean; checks: { name: string; ok: boolean; detail: string }[]; reasons: string[] }

const pct = (x: number) => `${(x * 100).toFixed(1)} %`;

/** Automatic exclusion stays locked unless every check passes. */
export function exclusionGate(r: QualityValidationReport, t: GateThresholds = DEFAULT_GATE): GateResult {
  const checks: GateResult["checks"] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  add("sample", r.responses >= t.minResponses, `${r.responses} labelled responses (need ${t.minResponses})`);
  add("manual labels", !t.requireManualLabels || r.source === "manual" || r.source === "mixed", `source: ${r.source}${t.requireManualLabels ? " (a person-labelled sample of real responses is required)" : ""}`);
  add("flagged precision", r.flagged.precision.n > 0 && r.flagged.precision.rate >= t.minFlaggedPrecision, `${pct(r.flagged.precision.rate)} of ${r.flagged.precision.n} flagged were real problems (need ${pct(t.minFlaggedPrecision)})`);
  add("genuine flagged", r.flagged.genuineFalsePositive.rate <= t.maxGenuineFlagged, `${pct(r.flagged.genuineFalsePositive.rate)} of ${r.flagged.genuineFalsePositive.n} genuine respondents flagged (max ${pct(t.maxGenuineFlagged)})`);
  add("genuine sent to review", r.detected.genuineFalsePositive.rate <= t.maxGenuineReview, `${pct(r.detected.genuineFalsePositive.rate)} of genuine respondents not PASS (max ${pct(t.maxGenuineReview)})`);
  for (const [k, s] of Object.entries(r.genuineBySegment)) {
    if (s.flagged.n < t.minSegmentN) continue;
    add(`segment ${k}`, s.flagged.rate <= t.maxGenuineFlaggedInSegment, `${pct(s.flagged.rate)} of ${s.flagged.n} genuine flagged (max ${pct(t.maxGenuineFlaggedInSegment)})`);
  }
  for (const [label, min] of Object.entries(t.minRecall)) {
    const got = r.recallByLabel[label];
    add(`recall ${label}`, !!got && got.n > 0 && got.rate >= (min ?? 0), got ? `${pct(got.rate)} of ${got.n} caught (need ${pct(min ?? 0)})` : "no labelled cases");
  }
  const failed = checks.filter((c) => !c.ok);
  return { open: failed.length === 0, checks, reasons: failed.map((c) => `${c.name}: ${c.detail}`) };
}

/* ------------------------------------------------------------------ a synthetic labelled corpus */

/** the benchmark survey: a consumer car study with grids (one reversed item), an attention check, two open ends */
export function validationSurvey(): SurveyDefinition {
  const scale = ["Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree"].map((label, i) => ({ code: String(i + 1), label }));
  const brands = [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }, { code: "c", label: "Gamma" }, { code: "d", label: "Delta" }, { code: "dk", label: "Don't know", flags: ["dont_know"] }];
  return SurveyDefinition.parse({
    meta: { id: "quality-validation", code: "QV", title: "Quality validation benchmark (synthetic)", version: "1.0" },
    quality: { enabled: true, strictness: "standard" },
    questions: [
      { id: "own", code: "S1", variableName: "S1", type: "single_select", text: "Do you own a car?", options: [{ code: "y", label: "Yes" }, { code: "n", label: "No" }] },
      { id: "brand", code: "Q1", variableName: "Q1", type: "single_select", text: "Which car brand do you own?", options: brands },
      { id: "freq", code: "Q2", variableName: "Q2", type: "single_select", text: "How often do you drive?", options: [{ code: "never", label: "Never" }, { code: "some", label: "Sometimes" }, { code: "daily", label: "Daily" }] },
      { id: "grid", code: "Q3", variableName: "Q3", type: "matrix_single", text: "How much do you agree with each statement about your car?",
        rows: [{ code: "r1", label: "It is reliable" }, { code: "r2", label: "It is comfortable" }, { code: "r3", label: "It is not worth the money" }, { code: "r4", label: "It is fun to drive" }, { code: "r5", label: "It is easy to park" }, { code: "r6", label: "It is expensive to run" }], options: scale },
      { id: "grid2", code: "Q4", variableName: "Q4", type: "matrix_single", text: "And the dealer?",
        rows: [{ code: "r1", label: "Friendly" }, { code: "r2", label: "Fast" }, { code: "r3", label: "Honest" }, { code: "r4", label: "Convenient" }, { code: "r5", label: "Fair prices" }], options: scale },
      { id: "att", code: "Q5", variableName: "Q5", type: "single_select", text: "To show you are reading, please select 'Beta'.", options: brands.slice(0, 4), attentionCheck: { kind: "instruction", expected: ["b"] } },
      { id: "oe", code: "Q6", variableName: "Q6", type: "long_text", text: "Why did you choose this car brand? Please explain in a few sentences." },
      { id: "oe2", code: "Q7", variableName: "Q7", type: "long_text", text: "What would make you switch to another brand?" },
      ...["Satisfaction overall?", "Likelihood to recommend?", "Value for money?", "Service quality?", "Would buy again?", "Brand image?"].map((text, i) => ({ id: `s${i + 1}`, code: `Q${8 + i}`, variableName: `Q${8 + i}`, type: "single_select", text, options: scale })),
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["own"] }, { type: "page", id: "p2", questionIds: ["brand", "freq"] },
      { type: "page", id: "p3", questionIds: ["grid"] }, { type: "page", id: "p4", questionIds: ["grid2"] },
      { type: "page", id: "p5", questionIds: ["att"] }, { type: "page", id: "p6", questionIds: ["oe", "oe2"] },
      { type: "page", id: "p7", questionIds: ["s1", "s2", "s3"] }, { type: "page", id: "p8", questionIds: ["s4", "s5", "s6"] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

const PAGES = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
const PAGE_Q: Record<string, string[]> = { p1: ["own"], p2: ["brand", "freq"], p3: ["grid"], p4: ["grid2"], p5: ["att"], p6: ["oe", "oe2"], p7: ["s1", "s2", "s3"], p8: ["s4", "s5", "s6"] };
/** a careful human's seconds per page (median ≈ 210 s) */
const BASE_SECS = [6, 10, 45, 30, 8, 70, 20, 22];

/** a small seeded generator: the corpus is the same on every run */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface TelOpts { secs: number[]; device: "desktop" | "mobile" | "tablet"; locale: string; timezone: string; tzOffset: number; webdriver?: boolean; pointer?: number; keys?: number; pastes?: Record<string, number>; outOfFocusMs?: number; uniform?: boolean; typed?: number }

function telemetry(o: TelOpts, startAt: number): ResponseTelemetry {
  let t = startAt;
  const pages: ResponseTelemetry["pages"] = [];
  const questions: ResponseTelemetry["questions"] = {};
  PAGES.forEach((pid, i) => {
    const dur = o.secs[i]! * 1000;
    const enteredAt = t, leftAt = t + dur;
    pages.push({ pageId: pid, step: i, enteredAt, leftAt, via: i === 0 ? "start" : "next", questionIds: PAGE_Q[pid]!, outOfFocusMs: pid === "p6" ? (o.outOfFocusMs ?? 0) : 0, blurs: o.outOfFocusMs ? 1 : 0, pointerEvents: o.pointer ?? 6, keyEvents: pid === "p6" ? (o.keys ?? 60) : 0, scrollEvents: o.pointer === 0 ? 0 : 1 });
    PAGE_Q[pid]!.forEach((qid, j) => {
      const lat = o.uniform ? 300 : Math.max(700, dur * 0.3) + j * 400;
      const first = enteredAt + Math.min(lat, Math.max(100, dur - 100));
      questions[qid] = { firstChangeAt: first, lastChangeAt: Math.min(leftAt - 50, first + Math.max(100, dur * 0.3)), changes: 1, latencyMs: j === 0 ? lat : undefined, pastes: o.pastes?.[qid] ?? 0, pasteChars: o.pastes?.[qid] ? 140 : 0, typedChars: qid.startsWith("oe") ? (o.typed ?? 60) : 0, copies: 0 };
    });
    t = leftAt;
  });
  const pastes = Object.values(o.pastes ?? {}).reduce((s, x) => s + x, 0);
  return {
    v: 1, startedAt: startAt, submittedAt: t, pages, questions,
    focus: { blurs: o.outOfFocusMs ? 1 : 0, totalOutOfFocusMs: o.outOfFocusMs ?? 0, longestOutOfFocusMs: o.outOfFocusMs ?? 0 },
    clipboard: { copies: 0, pastes, pasteChars: pastes * 140, largePastes: pastes, pasteQuestions: Object.keys(o.pastes ?? {}).length },
    navigation: { back: 0, forward: 7, reloads: 0, jumps: 0, sequence: [] },
    interaction: { pointerEvents: (o.pointer ?? 6) * 8, keyEvents: o.keys ?? 60, scrollEvents: o.pointer === 0 ? 0 : 8 },
    device: {
      type: o.device, browser: o.device === "desktop" ? "Chrome" : "Safari", os: o.device === "desktop" ? "Windows" : "iOS",
      screen: o.device === "desktop" ? "1920x1080" : o.device === "tablet" ? "820x1180" : "390x844", viewport: o.device === "desktop" ? "1600x900" : o.device === "tablet" ? "820x1100" : "390x750",
      dpr: o.device === "desktop" ? 1 : 3, locale: o.locale, language: o.locale.slice(0, 2), timezone: o.timezone, tzOffset: o.tzOffset, touch: o.device !== "desktop", webdriver: o.webdriver ?? false,
    },
    disabled: [],
  };
}

const REASONS = ["my family has always trusted it", "it held its value when I sold my last one", "the dealer near me gives honest advice", "it was the safest option for my children", "a friend recommended it after years without problems", "the fuel economy suits my long commute", "it had the best warranty when I compared them", "the interior is roomy enough for our dog"];
const DETAILS = ["I test drove three others first.", "Servicing has been cheap so far.", "It still feels solid after six years.", "The boot fits our camping gear.", "Parking in the city is easy with it.", "It handled the winter roads well."];
const SWITCH = ["A cheaper electric version with the same range", "Better after-sales service from another dealer", "If the running costs went up much more", "A model with more space for a growing family", "Proper software updates and a better app", "A much lower price for the same quality", "If a rival offered a longer warranty", "Lower insurance costs on another brand"];
const SHORT_OK = ["Reliable and cheap to run.", "Good value, never broke down.", "Price. Simple as that.", "Trusted brand.", "Comfortable seats, fair price."];
const POLISHED = "As a discerning consumer, I selected this brand because it seamlessly combines reliability, performance, and value. Furthermore, its commitment to innovation and customer satisfaction makes it an excellent choice for my lifestyle.";
const GIBBERISH = ["asdf jkl qwe", "sdfsdf", "good good good", "nice", "jjjjjj kkk"];

const SEGMENTS: { device: TelOpts["device"]; locale: string; timezone: string; tzOffset: number }[] = [
  { device: "desktop", locale: "en-GB", timezone: "Europe/London", tzOffset: 0 },
  { device: "mobile", locale: "en-IN", timezone: "Asia/Kolkata", tzOffset: -330 },
  { device: "mobile", locale: "en-US", timezone: "America/New_York", tzOffset: 300 },
  { device: "tablet", locale: "en-GB", timezone: "Europe/London", tzOffset: 0 },
  { device: "desktop", locale: "en-IN", timezone: "Asia/Kolkata", tzOffset: -330 },
];

/**
 * A SYNTHETIC labelled corpus (labels are true by construction). Default ≈ 360 responses: 240 genuine of which
 * 80 are hard negatives, and 120 problem cases across inattentive, duplicate, suspicious and fraudulent.
 */
export function syntheticLabelledCorpus(opts: { seed?: number; genuine?: number; perProblem?: number } = {}): { def: SurveyDefinition; responses: LabelledResponse[] } {
  const R = rng(opts.seed ?? 20261107);
  const nGenuine = opts.genuine ?? 240;
  const nProblem = opts.perProblem ?? 30;
  const out: LabelledResponse[] = [];
  const base = 1_790_000_000_000;
  let seq = 0;
  const scaleCode = (lo: number, hi: number) => String(lo + Math.floor(R() * (hi - lo + 1)));
  const jitter = (secs: number[], factor: number) => secs.map((s) => Math.max(2, Math.round(s * factor * (0.75 + R() * 0.5))));
  const add = (label: QualityLabel, persona: string, answers: Record<string, unknown>, tel: TelOpts, ids?: { ip?: string; dev?: string }) => {
    const i = ++seq;
    const startAt = base + i * 611_000 + Math.floor(R() * 300_000);
    const t = telemetry(tel, startAt);
    const segIdx = SEGMENTS.findIndex((s) => s.device === tel.device && s.locale === tel.locale);
    out.push({
      label, persona, source: "synthetic",
      segments: { device: tel.device, locale: tel.locale, ...(segIdx >= 0 ? {} : {}) },
      response: {
        sessionId: `qv${String(i).padStart(4, "0")}`, status: "complete", answers, startedAt: new Date(startAt).toISOString(), completedAt: new Date(t.submittedAt!).toISOString(),
        telemetry: t, ipHash: ids?.ip ?? `ip-${i}`, deviceHash: ids?.dev ?? `dev-${i}`,
      },
    });
  };
  /* real people do not write the same sentence: every genuine answer is assembled from independent parts */
  const pickOf = <T,>(xs: readonly T[]) => xs[Math.floor(R() * xs.length)]!;
  const OPENERS = ["I chose it because", "Mainly because", "Honestly,", "We went with it since", "I picked this one as", "For me it was that", "The main reason is"];
  const PLACES = ["in Pune", "around Leeds", "in our village", "on the motorway", "for the school run", "in heavy traffic", "on weekend trips", "to my office"];
  /*
   * Independent short clauses from large pools, in shuffled order: two genuine answers share a clause about one
   * time in ten and almost never share two, as real free text does — a templated corpus would be flagged, rightly,
   * as duplicate text.
   */
  const W1 = ["my dad swore by them", "the resale value was strong", "our dealer was patient with us", "it scored well on safety", "a colleague had one for years", "the mileage is decent", "it came with a long warranty", "there is room for the dog", "spare parts are easy to find", "the hybrid was in stock", "it was on offer that month", "the seats suit my back"];
  const W2 = ["servicing has been cheap", "it still feels solid", "the boot takes our bikes", "parking is easy", "it coped with the monsoon", "the brakes feel sharp", "the app is a bit clunky though", "road noise is low", "the infotainment is dated", "it rarely needs repairs", "the paint chips easily", "it starts first time in winter"];
  const W3 = ["I drive to Pune most weeks", "we live outside Leeds", "I do the school run daily", "my commute is about 40 km", "we tow a small caravan", "I use it for deliveries on weekends", "we visit family in Jaipur often", "I park on a narrow street", "my wife drives it more than me", "I mostly use it in town", "we take it to the hills each summer", "I share it with my son"];
  const genuineWhy = () => {
    const years = 2 + Math.floor(R() * 14);
    const parts = [`${pickOf(OPENERS)} ${pickOf(W1)}`, pickOf(W2), pickOf(W3), `we have had it ${years} years`];
    for (let k = parts.length - 1; k > 1; k--) { const j = 1 + Math.floor(R() * k); [parts[k], parts[j]] = [parts[j]!, parts[k]!]; }
    const text = parts.slice(0, 2 + Math.floor(R() * 3)).join(R() < 0.5 ? ". " : ", and ");
    return text.charAt(0).toUpperCase() + text.slice(1) + ".";
  };
  const S1 = ["a cheaper electric model", "better after-sales service", "lower running costs", "more space for the kids", "a proper app and updates", "a longer warranty", "lower insurance", "a nicer interior", "an automatic gearbox", "seven seats", "better fuel economy", "a bigger discount"];
  const S2 = ["from a brand I trust", "if the price was right", "once my loan is paid off", "when the lease ends", "if a friend recommended it", "after a good test drive", "if charging gets easier here", "if my dealer closes", "for my next car in a few years", "if prices keep rising", "if the reviews were good", "if it held its value"];
  const genuineSwitch = () => {
    const t = `${pickOf(["Probably", "Maybe", "Only", "I would consider", "Honestly"])} ${pickOf(S1)} ${pickOf(S2)}`;
    return R() < 0.5 ? `${t}.` : `${t}, ${pickOf(["not much else", "nothing else really", "or a big recall", `around ${10 + Math.floor(R() * 30)} lakh`, "and good reviews"])}.`;
  };
  /* a genuine, attentive person: varied but coherent answers (the reversed item r3 runs against r1), relevant text */
  const genuineAnswers = (lean = 0) => {
    const pos = (bias: number) => scaleCode(Math.max(1, 2 + bias), Math.min(5, 4 + bias));
    const r1 = Number(pos(lean));
    return {
      own: "y", brand: ["a", "b", "c", "d"][Math.floor(R() * 4)], freq: R() < 0.7 ? "daily" : "some",
      grid: { r1: String(r1), r2: pos(lean), r3: String(Math.max(1, Math.min(5, 6 - r1 + (R() < 0.5 ? 0 : -1)))), r4: pos(lean), r5: scaleCode(1, 5), r6: scaleCode(2, 4) },
      grid2: { r1: pos(lean), r2: scaleCode(2, 5), r3: pos(lean), r4: scaleCode(2, 5), r5: scaleCode(1, 4) },
      att: "b",
      oe: genuineWhy(), oe2: genuineSwitch(),
      s1: pos(lean), s2: pos(lean), s3: scaleCode(2, 5), s4: pos(lean), s5: pos(lean), s6: scaleCode(2, 5),
    };
  };
  const seg = (i: number) => SEGMENTS[i % SEGMENTS.length]!;
  const typical = nGenuine - 80;
  for (let i = 0; i < typical; i++) add("genuine", "typical", genuineAnswers(), { secs: jitter(BASE_SECS, 1), ...seg(i) });
  /* hard negatives: people a careless engine would flag */
  for (let i = 0; i < 20; i++) add("genuine", "fast careful reader", genuineAnswers(), { secs: jitter(BASE_SECS, 0.6), ...seg(i) });
  for (let i = 0; i < 20; i++) {
    const a = genuineAnswers(1);
    a.s1 = "5"; a.s2 = "5"; a.s4 = "5"; a.s5 = "5";
    add("genuine", "strong opinions", a, { secs: jitter(BASE_SECS, 1), ...seg(i + 1) });
  }
  for (let i = 0; i < 20; i++) add("genuine", "shared office IP", genuineAnswers(), { secs: jitter(BASE_SECS, 1), ...SEGMENTS[0]! }, { ip: `ip-office-${Math.floor(i / 10)}` });
  for (let i = 0; i < 20; i++) {
    const a = genuineAnswers();
    a.oe = SHORT_OK[i % SHORT_OK.length]!; a.oe2 = ["Lower price.", "Electric option.", "Better service.", "More space."][i % 4]!;
    add("genuine", "terse mobile answers", a, { secs: jitter(BASE_SECS, 0.8), ...SEGMENTS[1 + (i % 2)]!, keys: 15, typed: 20 });
  }
  /* inattentive: speeding through, straightlining the grids, missing the attention check */
  for (let i = 0; i < nProblem; i++) {
    const v = String(3 + (i % 3));
    add("inattentive", "speeder + straightliner", {
      own: "y", brand: "a", freq: "daily", grid: { r1: v, r2: v, r3: v, r4: v, r5: v, r6: v }, grid2: { r1: v, r2: v, r3: v, r4: v, r5: v },
      att: i % 3 === 0 ? "b" : "a", oe: GIBBERISH[i % GIBBERISH.length], oe2: "dont know", s1: v, s2: v, s3: v, s4: v, s5: v, s6: v,
    }, { secs: jitter(BASE_SECS, 0.18), ...seg(i), keys: 6, typed: 8 });
  }
  /* duplicates: a genuine respondent's answers and device submitted again */
  /* the earlier half of each pair is a genuine person; REVIEW of the pair is the right call, FLAGGED is not */
  const originals = out.filter((l) => l.persona === "typical").slice(0, nProblem);
  for (const o of originals) { o.persona = "earlier half of a duplicate pair"; o.reviewAcceptable = true; }
  originals.forEach((o, i) => {
    const t = o.response.telemetry!;
    add("duplicate", "same device, same answers", JSON.parse(JSON.stringify(o.response.answers)), { secs: jitter(BASE_SECS, 0.9), device: t.device!.type as TelOpts["device"], locale: t.device!.locale, timezone: t.device!.timezone, tzOffset: t.device!.tzOffset }, { ip: o.response.ipHash!, dev: o.response.deviceHash! });
    void i;
  });
  /* suspicious: inconsistent identity (locale vs timezone), pasted polished text, long time away */
  for (let i = 0; i < nProblem; i++) {
    const a = genuineAnswers();
    a.oe = POLISHED; a.oe2 = "Furthermore, a superior value proposition and seamless innovation would compel me to reconsider my choice.";
    add("suspicious", "pasted polished text, locale/timezone mismatch", a, { secs: jitter(BASE_SECS, 0.7), device: "desktop", locale: "en-US", timezone: "Asia/Shanghai", tzOffset: -480, pastes: { oe: 1, oe2: 1 }, keys: 2, typed: 0, outOfFocusMs: 40_000 });
  }
  /* fraudulent: automation — webdriver, no pointer movement, machine-regular timing, gibberish, failed check */
  for (let i = 0; i < nProblem; i++) {
    const c = String(1 + (i % 5));
    add("fraudulent", "bot", {
      own: "y", brand: "c", freq: "never", grid: { r1: "1", r2: "2", r3: "3", r4: "4", r5: "5", r6: "1" }, grid2: { r1: "2", r2: "3", r3: "4", r4: "5", r5: "1" },
      att: "d", oe: GIBBERISH[(i + 2) % GIBBERISH.length], oe2: GIBBERISH[(i + 3) % GIBBERISH.length], s1: c, s2: c, s3: c, s4: c, s5: c, s6: c,
    }, { secs: [2, 2, 2, 2, 2, 2, 2, 2], device: "desktop", locale: "en-US", timezone: "America/New_York", tzOffset: 300, webdriver: true, pointer: 0, keys: 0, typed: 0, uniform: true }, { ip: `ip-farm-${i % 3}` });
  }
  return { def: validationSurvey(), responses: out };
}
