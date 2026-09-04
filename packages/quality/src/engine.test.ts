import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { assess, assessSurvey } from "./engine.js";
import type { PeerRecord, ResponseRecord, ResponseTelemetry } from "./types.js";
import { RULES } from "./catalogue.js";
import { noisyOr, classify } from "./score.js";
import { gibberishScore, isGenericAnswer, polishedTextScore, textSimilarity, isDiagonal, repeatingPeriod } from "./metrics.js";
import { clusterSurvey, comparable, pairSimilarity, valueFrequencies } from "./similarity.js";

/* ------------------------------------------------------------- fixtures */

const scale = ["1", "2", "3", "4", "5"].map((c, i) => ({ code: c, label: ["Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree"][i] }));
const brands = [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }, { code: "c", label: "Gamma" }, { code: "d", label: "Delta" }, { code: "dk", label: "Don't know", flags: ["dont_know"] }];

const def = (quality: any = { enabled: true, strictness: "standard" }, extraQ: any[] = []) =>
  SurveyDefinition.parse({
    meta: { id: "qx", code: "QX", title: "Quality", version: "1.0" },
    quality,
    questions: [
      { id: "own", code: "S1", variableName: "S1", type: "single_select", text: "Do you own a car?", options: [{ code: "y", label: "Yes" }, { code: "n", label: "No" }],
        skipLogic: [{ id: "sk", when: { type: "rule", source: { kind: "question", ref: "own" }, operator: "eq", value: "n" }, target: { kind: "end", status: "screened" } }] },
      { id: "brand", code: "Q1", variableName: "Q1", type: "single_select", text: "Which car brand do you own?", options: brands,
        displayLogic: { type: "rule", source: { kind: "question", ref: "own" }, operator: "eq", value: "y" } },
      { id: "freq", code: "Q2", variableName: "Q2", type: "single_select", text: "How often do you drive?", options: [{ code: "never", label: "Never" }, { code: "some", label: "Sometimes" }, { code: "daily", label: "Daily" }] },
      { id: "grid", code: "Q3", variableName: "Q3", type: "matrix_single", text: "How much do you agree with each statement about your car?",
        rows: [{ code: "r1", label: "It is reliable" }, { code: "r2", label: "It is comfortable" }, { code: "r3", label: "It is not worth the money" }, { code: "r4", label: "It is fun to drive" }, { code: "r5", label: "It is easy to park" }, { code: "r6", label: "It is expensive to run" }],
        options: scale },
      { id: "grid2", code: "Q4", variableName: "Q4", type: "matrix_single", text: "And the dealer?",
        rows: [{ code: "r1", label: "Friendly" }, { code: "r2", label: "Fast" }, { code: "r3", label: "Honest" }, { code: "r4", label: "Convenient" }, { code: "r5", label: "Fair prices" }], options: scale },
      { id: "att", code: "Q5", variableName: "Q5", type: "single_select", text: "To show you are reading, please select 'Beta'.", options: brands.slice(0, 4),
        attentionCheck: { kind: "instruction", expected: ["b"] } },
      { id: "oe", code: "Q6", variableName: "Q6", type: "long_text", text: "Why did you choose this car brand? Please explain in a few sentences." },
      { id: "oe2", code: "Q7", variableName: "Q7", type: "long_text", text: "What would make you switch?" },
      { id: "s1", code: "Q8", variableName: "Q8", type: "single_select", text: "Satisfaction overall?", options: scale },
      { id: "s2", code: "Q9", variableName: "Q9", type: "single_select", text: "Likelihood to recommend?", options: scale },
      { id: "s3", code: "Q10", variableName: "Q10", type: "single_select", text: "Value for money?", options: scale },
      { id: "s4", code: "Q11", variableName: "Q11", type: "single_select", text: "Service quality?", options: scale },
      { id: "s5", code: "Q12", variableName: "Q12", type: "single_select", text: "Would buy again?", options: scale },
      { id: "s6", code: "Q13", variableName: "Q13", type: "single_select", text: "Brand image?", options: scale },
      ...extraQ,
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["own"] },
      { type: "page", id: "p2", questionIds: ["brand", "freq"] },
      { type: "page", id: "p3", questionIds: ["grid"] },
      { type: "page", id: "p4", questionIds: ["grid2"] },
      { type: "page", id: "p5", questionIds: ["att"] },
      { type: "page", id: "p6", questionIds: ["oe", "oe2"] },
      { type: "page", id: "p7", questionIds: ["s1", "s2", "s3"] },
      { type: "page", id: "p8", questionIds: ["s4", "s5", "s6", ...extraQ.map((q) => q.id)] },
      { type: "end", id: "e", status: "complete" },
    ],
  });

const PAGES = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
const PAGE_Q: Record<string, string[]> = { p1: ["own"], p2: ["brand", "freq"], p3: ["grid"], p4: ["grid2"], p5: ["att"], p6: ["oe", "oe2"], p7: ["s1", "s2", "s3"], p8: ["s4", "s5", "s6"] };

/** A plausible human telemetry: given page seconds, builds visits + question timings. */
function telemetry(pageSecs: number[], opts: Partial<{ pastes: Record<string, number>; latencyMs: number; device: Partial<ResponseTelemetry["device"]>; backs: number; pointer: number; webdriver: boolean }> = {}): ResponseTelemetry {
  const start = 1_700_000_000_000;
  let t = start;
  const pages: ResponseTelemetry["pages"] = [];
  const questions: ResponseTelemetry["questions"] = {};
  PAGES.forEach((pid, i) => {
    const dur = pageSecs[i] * 1000;
    const enteredAt = t;
    const leftAt = t + dur;
    pages.push({ pageId: pid, step: i, enteredAt, leftAt, via: i === 0 ? "start" : "next", questionIds: PAGE_Q[pid], outOfFocusMs: 0, blurs: 0, pointerEvents: opts.pointer ?? 6, keyEvents: pid === "p6" ? 40 : 0, scrollEvents: opts.pointer === 0 ? 0 : 1 });
    PAGE_Q[pid].forEach((qid, j) => {
      const lat = (opts.latencyMs ?? Math.max(900, dur * 0.3)) + j * 400;
      const first = enteredAt + Math.min(lat, Math.max(100, dur - 100));
      questions[qid] = { firstChangeAt: first, lastChangeAt: Math.min(leftAt - 50, first + Math.max(100, dur * 0.3)), changes: 1, latencyMs: j === 0 ? lat : undefined, pastes: opts.pastes?.[qid] ?? 0, pasteChars: opts.pastes?.[qid] ? 120 : 0, typedChars: qid.startsWith("oe") ? 40 : 0, copies: 0 };
    });
    t = leftAt;
  });
  // back moves: append revisits of p2
  for (let b = 0; b < (opts.backs ?? 0); b++) {
    pages.push({ pageId: "p2", step: 1, enteredAt: t, leftAt: t + 1500, via: "back", questionIds: PAGE_Q.p2, outOfFocusMs: 0, blurs: 0, pointerEvents: 2, keyEvents: 0, scrollEvents: 0 });
    t += 1500;
    pages.push({ pageId: "p3", step: 2, enteredAt: t, leftAt: t + 1500, via: "next", questionIds: PAGE_Q.p3, outOfFocusMs: 0, blurs: 0, pointerEvents: 2, keyEvents: 0, scrollEvents: 0 });
    t += 1500;
  }
  return {
    v: 1, startedAt: start, submittedAt: t, pages, questions,
    focus: { blurs: 0, totalOutOfFocusMs: 0, longestOutOfFocusMs: 0 },
    clipboard: { copies: 0, pastes: Object.values(opts.pastes ?? {}).reduce((s, x) => s + x, 0), pasteChars: Object.values(opts.pastes ?? {}).length * 120, largePastes: 0, pasteQuestions: Object.keys(opts.pastes ?? {}).length },
    navigation: { back: opts.backs ?? 0, forward: 7 + (opts.backs ?? 0), reloads: 0, jumps: 0, sequence: [] },
    interaction: { pointerEvents: 50, keyEvents: 40, scrollEvents: 8 },
    device: { type: "desktop", browser: "Chrome", os: "macOS", screen: "1440x900", viewport: "1200x800", dpr: 2, locale: "en-GB", language: "en", timezone: "Europe/London", tzOffset: 0, touch: false, webdriver: opts.webdriver ?? false, ...(opts.device ?? {}) },
    disabled: [],
  };
}

const GOOD_ANSWERS = {
  own: "y", brand: "a", freq: "daily",
  grid: { r1: "4", r2: "5", r3: "2", r4: "4", r5: "3", r6: "4" },
  grid2: { r1: "4", r2: "3", r3: "5", r4: "4", r5: "2" },
  att: "b",
  oe: "I chose Alpha because my parents drove one and it has never let me down on long trips.",
  oe2: "A much cheaper electric model with the same boot space would make me switch.",
  s1: "4", s2: "5", s3: "3", s4: "4", s5: "4", s6: "5",
};
const HUMAN_SECS = [6, 10, 45, 30, 8, 70, 20, 22]; // ~211 s

let seq = 0;
function response(over: Partial<ResponseRecord> & { secs?: number[]; tel?: ResponseTelemetry | null } = {}): ResponseRecord {
  const secs = over.secs ?? HUMAN_SECS;
  const tel = over.tel === undefined ? telemetry(secs) : over.tel;
  const total = secs.reduce((s, x) => s + x, 0);
  const started = new Date(1_700_000_000_000).toISOString();
  return {
    sessionId: over.sessionId ?? `s${String(++seq).padStart(4, "0")}`,
    status: "complete", answers: { ...GOOD_ANSWERS }, startedAt: started,
    completedAt: new Date(1_700_000_000_000 + total * 1000).toISOString(),
    telemetry: tel, ipHash: `ip${seq}`, deviceHash: `dev${seq}`,
    ...over,
  };
}

/** Deterministic pseudo-random 1..5 per (respondent, item) — no periodic duplicates. */
const pick = (i: number, k: number, n = 5) => {
  let h = (Math.imul(i + 1, 73856093) ^ Math.imul(k + 1, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return 1 + (h % n);
};
function variedAnswers(i: number) {
  return {
    ...GOOD_ANSWERS, brand: brands[pick(i, 0, 4) - 1].code,
    s1: String(pick(i, 1)), s2: String(pick(i, 2)), s3: String(pick(i, 3)), s4: String(pick(i, 4)), s5: String(pick(i, 5)), s6: String(pick(i, 6)),
    grid: { r1: String(pick(i, 7)), r2: String(pick(i, 8)), r3: String(pick(i, 9)), r4: String(pick(i, 10)), r5: String(pick(i, 11)), r6: String(pick(i, 12)) },
    // r5 repeats r4 so a random draw can never form a strict diagonal
    grid2: { r1: String(pick(i, 13)), r2: String(pick(i, 14)), r3: String(pick(i, 15)), r4: String(pick(i, 16)), r5: String(pick(i, 16)) },
    oe: OE_TEXTS[i % OE_TEXTS.length], oe2: OE2_TEXTS[i % OE2_TEXTS.length],
  };
}
const OE_TEXTS = [
  "My brother recommended it after years of trouble-free driving.", "The boot fits our pram and the weekly shop with room to spare.",
  "Cheapest insurance group of everything we test drove.", "We wanted a hybrid and the local garage services them.",
  "It was the only one available quickly when our old car died.", "Loved the colour and the seats are very comfortable.",
  "Good reviews for reliability and the warranty is seven years.", "The dealer threw in winter tyres and a service plan.",
  "It is small enough for our street but still seats five.", "Company car list, so it was the best of a short list.",
  "Bought it used from a neighbour who kept every receipt.", "Fuel economy on the motorway is outstanding.",
  "Safety rating mattered most with two kids in the back.", "Honestly, the finance offer was too good to pass up.",
  "I have always driven this brand and see no reason to change.", "Test drive sold it: quiet, quick and easy to park.",
];
const OE2_TEXTS = [
  "A real electric range of 300 miles at this price.", "Cheaper servicing would tempt me.", "Nothing, unless they stop making the estate.",
  "A dealer closer to home.", "Better resale values elsewhere.", "If the next model gets uglier I am gone.",
  "A proper seven seater.", "Lower road tax.", "Free charging at work for another brand.", "Reliability problems would do it.",
  "Someone offering a great trade in.", "More boot space.", "A convertible version.", "If the kids leave home I would go smaller.",
  "Nothing really.", "Better infotainment and a bigger screen.",
];

/** N ordinary peers with varied answers and timings. */
function peers(n: number, d = def()): PeerRecord[] {
  const out: PeerRecord[] = [];
  for (let i = 0; i < n; i++) {
    const r = response({
      secs: HUMAN_SECS.map((s, k) => s * (0.6 + pick(i, k + 20, 41) / 50)),
      answers: variedAnswers(i),
    });
    const a = assess({ def: d, response: r, peers: [] });
    out.push({ sessionId: r.sessionId, status: "complete", answers: r.answers, startedAt: r.startedAt, completedAt: r.completedAt, ipHash: r.ipHash, deviceHash: r.deviceHash, system: a.system });
  }
  return out;
}

const ruleIds = (a: ReturnType<typeof assess>) => a.flags.map((f) => f.ruleId).sort();
const has = (a: ReturnType<typeof assess>, id: string) => a.flags.some((f) => f.ruleId === id);

/* ------------------------------------------------------------- metrics */

test("metrics: gibberish, generic, polished, similarity, sequences", () => {
  assert.ok(gibberishScore("asdfghjkl qwerty zxcvb") > 0.5);
  assert.ok(gibberishScore("I really liked the reliability of this car and the dealer was kind") < 0.2);
  assert.ok(isGenericAnswer("good"));
  assert.ok(isGenericAnswer("N/A"));
  assert.ok(!isGenericAnswer("The seats are uncomfortable on long drives"));
  assert.ok(polishedTextScore("Furthermore, the vehicle demonstrates exceptional reliability. Moreover, the dealership experience was consistently professional. Additionally, the overall value proposition remains compelling. In conclusion, it is important to note that the ownership experience has been overwhelmingly positive across every dimension.") > 0.5);
  assert.equal(textSimilarity("I love the car", "I love the car!"), 1);
  assert.ok(textSimilarity("I love the reliability of this car", "I love the reliability of that car") > 0.7);
  assert.ok(isDiagonal([0, 1, 2, 3, 4]) && isDiagonal([4, 3, 2, 1]) && !isDiagonal([0, 2, 4]));
  assert.equal(repeatingPeriod([0, 1, 0, 1, 0, 1]), 2);
  assert.equal(repeatingPeriod([0, 0, 0, 0]), null);
  assert.equal(noisyOr([30, 30]), 51);
  assert.equal(noisyOr([]), 0);
  assert.equal(noisyOr([100, 5]), 100);
});

test("catalogue: every rule has an id, a category, points and per-level defaults", () => {
  const ids = new Set<string>();
  for (const r of RULES) {
    assert.ok(!ids.has(r.id), `duplicate ${r.id}`); ids.add(r.id);
    assert.ok(r.riskPoints >= 0 && r.riskPoints <= 100);
    for (const p of r.params) for (const lvl of ["relaxed", "standard", "strict", "very_strict"] as const) assert.notEqual(p.defaults[lvl], undefined, `${r.id}.${p.key}.${lvl}`);
  }
  assert.ok(RULES.length >= 60);
});

/* ------------------------------------------------------------- baseline */

test("a careful human respondent is CLEAN with no flags", () => {
  const a = assess({ def: def(), response: response(), peers: peers(12) });
  assert.deepEqual(ruleIds(a), [], JSON.stringify(a.reasons));
  assert.equal(a.classification, "CLEAN");
  assert.equal(a.qualityScore, 100);
  assert.equal(a.riskScore, 0);
  assert.equal(a.recommendation, "INCLUDE");
  assert.equal(a.system.SYSTEM_ATTENTION_PASSED, 1);
  assert.ok(a.system.SYSTEM_TOTAL_DURATION! > 200);
  assert.ok(a.benchmarks.peers >= 8 && a.benchmarks.medianDurationSec !== null, "peers give a median benchmark");
});

test("disabled engine assesses nothing but still records SYSTEM_* metadata", () => {
  const a = assess({ def: def({ enabled: false }), response: response({ secs: HUMAN_SECS.map((s) => s / 20) }), peers: [] });
  assert.equal(a.enabled, false);
  assert.deepEqual(a.flags, []);
  assert.equal(a.classification, "CLEAN");
  assert.ok(a.system.SYSTEM_TOTAL_DURATION! > 0);
});

/* ------------------------------------------------------------- timing */

test("speeder: 20× faster than the median is flagged with the benchmark named; a relaxed profile needs more", () => {
  const p = peers(12);
  const fast = response({ secs: HUMAN_SECS.map((s) => s / 20), tel: telemetry(HUMAN_SECS.map((s) => s / 20), { latencyMs: 150 }) });
  const a = assess({ def: def(), response: fast, peers: p });
  assert.ok(has(a, "timing.overall_speeding"), ruleIds(a).join());
  const f = a.flags.find((x) => x.ruleId === "timing.overall_speeding")!;
  assert.match(f.explanation, /below the benchmark/);
  assert.match(f.expected!, /median of 12 completes/);
  assert.ok(has(a, "timing.page_speeding") || has(a, "timing.short_dwell"));
  assert.ok(has(a, "timing.question_speeding"));
  assert.ok(has(a, "bot.machine_timing") || a.riskScore >= 40);
  assert.notEqual(a.classification, "CLEAN");
  assert.ok(a.system.SYSTEM_SPEEDER_SCORE > 0);
  // moderately fast (60% of median) is fine at standard, still fine at relaxed
  const mid = response({ secs: HUMAN_SECS.map((s) => s * 0.6) });
  assert.ok(!has(assess({ def: def(), response: mid, peers: p }), "timing.overall_speeding"));
  // 35% of median: flagged at standard (ratio .4), not at relaxed (.25)
  const q = response({ secs: HUMAN_SECS.map((s) => s * 0.35) });
  assert.ok(has(assess({ def: def(), response: q, peers: p }), "timing.overall_speeding"));
  assert.ok(!has(assess({ def: def({ enabled: true, strictness: "relaxed" }), response: q, peers: p }), "timing.overall_speeding"));
});

test("with too few peers the estimate is the benchmark and the explanation says so", () => {
  const a = assess({ def: def(), response: response({ secs: HUMAN_SECS.map(() => 0.6), tel: telemetry(HUMAN_SECS.map(() => 0.6), { latencyMs: 100 }) }), peers: [] });
  const f = a.flags.find((x) => x.ruleId === "timing.overall_speeding");
  assert.ok(f, ruleIds(a).join());
  assert.match(f!.expected!, /estimated reading time/);
});

test("uniform timing: identical page durations are a script's signature", () => {
  const a = assess({ def: def(), response: response({ secs: HUMAN_SECS.map(() => 12) }), peers: peers(12) });
  assert.ok(has(a, "timing.uniform"), ruleIds(a).join());
});

test("acceleration: a second half rushed relative to benchmark", () => {
  const secs = [8, 12, 50, 40, 1.2, 4, 1.5, 1.5];
  const a = assess({ def: def(), response: response({ secs }), peers: peers(12) });
  assert.ok(has(a, "timing.acceleration"), ruleIds(a).join());
});

test("timing pattern match: the same per-page profile as another respondent", () => {
  const p = peers(12);
  const twinSecs = HUMAN_SECS.map((s) => s * 0.95);
  const twin = response({ secs: twinSecs });
  const twinA = assess({ def: def(), response: twin, peers: p });
  p.push({ sessionId: twin.sessionId, status: "complete", answers: twin.answers, startedAt: twin.startedAt, completedAt: twin.completedAt, ipHash: "ipX", deviceHash: "devX", system: twinA.system });
  const a = assess({ def: def(), response: response({ secs: twinSecs.map((s) => s * 1.02) }), peers: p });
  assert.ok(has(a, "timing.pattern_match"), ruleIds(a).join());
  assert.deepEqual(a.flags.find((f) => f.ruleId === "timing.pattern_match")!.relatedSessionIds, [twin.sessionId]);
});

/* ------------------------------------------------------------- matrix */

test("straight-lining both grids, with a reverse-worded row, is flagged twice; one grid at standard is not", () => {
  const both = response({ answers: { ...GOOD_ANSWERS, grid: { r1: "4", r2: "4", r3: "4", r4: "4", r5: "4", r6: "4" }, grid2: { r1: "4", r2: "4", r3: "4", r4: "4", r5: "4" } } });
  const a = assess({ def: def(), response: both, peers: peers(12) });
  assert.ok(has(a, "matrix.straightline"), ruleIds(a).join());
  assert.ok(has(a, "matrix.reverse_straightline"), "r3 'not worth the money' makes one column insincere");
  assert.ok(a.qualityScore < 70);
  const one = response({ answers: { ...GOOD_ANSWERS, grid2: { r1: "4", r2: "4", r3: "4", r4: "4", r5: "4" } } });
  const b = assess({ def: def(), response: one, peers: peers(12) });
  assert.ok(!has(b, "matrix.straightline"), "one of two grids is under the 50% grid share");
  assert.ok(has(assess({ def: def({ enabled: true, strictness: "very_strict" }), response: one, peers: peers(12) }), "matrix.straightline"));
});

test("diagonal and alternating grids", () => {
  const diag = response({ answers: { ...GOOD_ANSWERS, grid: { r1: "1", r2: "2", r3: "3", r4: "4", r5: "5", r6: "4" } } });
  assert.ok(!has(assess({ def: def(), response: diag, peers: [] }), "matrix.diagonal"), "broken by the last row");
  const diag2 = response({ answers: { ...GOOD_ANSWERS, grid: { r1: "5", r2: "4", r3: "3", r4: "2", r5: "1", r6: "1" } } });
  assert.ok(!has(assess({ def: def(), response: diag2, peers: [] }), "matrix.diagonal"));
  const diag3 = response({ answers: { ...GOOD_ANSWERS, grid2: { r1: "1", r2: "2", r3: "3", r4: "4", r5: "5" } } });
  assert.ok(has(assess({ def: def(), response: diag3, peers: [] }), "matrix.diagonal"));
  const alt = response({ answers: { ...GOOD_ANSWERS, grid: { r1: "1", r2: "5", r3: "1", r4: "5", r5: "1", r6: "5" } } });
  assert.ok(has(assess({ def: def(), response: alt, peers: [] }), "matrix.alternating"));
});

test("identical matrix signature across respondents", () => {
  const p = peers(12);
  const a = assess({ def: def(), response: response({ answers: { ...GOOD_ANSWERS, grid: { r1: "1", r2: "2", r3: "3", r4: "4", r5: "5", r6: "3" } } }), peers: p });
  p.push({ sessionId: "twin", status: "complete", answers: { ...GOOD_ANSWERS, grid: { r1: "1", r2: "2", r3: "3", r4: "4", r5: "5", r6: "3" } }, startedAt: null, completedAt: null, ipHash: "ipT", deviceHash: "devT", system: a.system });
  const b = assess({ def: def(), response: response({ answers: { ...GOOD_ANSWERS, grid: { r1: "1", r2: "2", r3: "3", r4: "4", r5: "5", r6: "3" } } }), peers: p });
  assert.ok(has(b, "matrix.signature_match"), ruleIds(b).join());
});

/* ------------------------------------------------------------- attention & consistency */

test("attention check failed: explained with observed vs expected; two failures escalate", () => {
  const a = assess({ def: def(), response: response({ answers: { ...GOOD_ANSWERS, att: "a" } }), peers: peers(12) });
  const f = a.flags.find((x) => x.ruleId === "attention.failed")!;
  assert.ok(f);
  assert.equal(f.observed, "Alpha");
  assert.equal(f.expected, "Beta");
  assert.deepEqual(f.questionIds, ["att"]);
  assert.equal(a.system.SYSTEM_ATTENTION_FAILED, 1);
  assert.notEqual(a.classification, "CLEAN");
  const d2 = def(undefined, [{ id: "att2", code: "Q14", variableName: "Q14", type: "single_select", text: "Select Gamma", options: brands.slice(0, 4), attentionCheck: { kind: "trap", expected: ["d"] } }]);
  const b = assess({ def: d2, response: response({ answers: { ...GOOD_ANSWERS, att: "a", att2: "d" } }), peers: [] });
  assert.ok(has(b, "attention.multiple_failed"));
  assert.equal(b.flags.filter((x) => x.ruleId === "attention.failed").length, 2);
});

test("consistency: an answer where the question was hidden (owns no car, names a brand)", () => {
  const a = assess({ def: def(), response: response({ status: "complete", answers: { ...GOOD_ANSWERS, own: "n", brand: "a", freq: "daily" } }), peers: [] });
  const f = a.flags.find((x) => x.ruleId === "consistency.impossible_path")!;
  assert.ok(f, ruleIds(a).join());
  assert.match(f.explanation, /owns a car: No/);
  assert.ok(f.questionIds.includes("brand") && f.questionIds.includes("own"));
});

/* ------------------------------------------------------------- pattern */

test("pattern: every single-choice on position 4 → low entropy; DK everywhere → non-substantive", () => {
  const same = response({ answers: { ...GOOD_ANSWERS, s1: "4", s2: "4", s3: "4", s4: "4", s5: "4", s6: "4" } });
  const a = assess({ def: def({ enabled: true, strictness: "very_strict" }), response: same, peers: [] });
  assert.ok(has(a, "pattern.low_entropy") || has(a, "pattern.acquiescence"), ruleIds(a).join());
  const dkDef = def(undefined, [1, 2, 3].map((i) => ({ id: `dk${i}`, code: `D${i}`, variableName: `D${i}`, type: "single_select", text: `Brand ${i}?`, options: brands })));
  const dk = response({ answers: { ...GOOD_ANSWERS, brand: "dk", dk1: "dk", dk2: "dk", dk3: "dk" } });
  const b = assess({ def: dkDef, response: dk, peers: [] });
  assert.ok(has(b, "pattern.nonsubstantive"), ruleIds(b).join());
});

test("pattern: mechanical 1-5-1-5 across consecutive questions", () => {
  const d = def(undefined, [1, 2, 3, 4].map((i) => ({ id: `x${i}`, code: `X${i}`, variableName: `X${i}`, type: "single_select", text: `Item ${i}?`, options: scale })));
  const r = response({ answers: { ...GOOD_ANSWERS, own: "y", brand: "a", freq: "never", att: "b", s1: "1", s2: "5", s3: "1", s4: "5", s5: "1", s6: "5", x1: "1", x2: "5", x3: "1", x4: "5" } });
  const a = assess({ def: d, response: r, peers: [] });
  assert.ok(has(a, "pattern.mechanical") || has(a, "pattern.extreme_bias"), ruleIds(a).join());
});

/* ------------------------------------------------------------- open ends */

test("open ends: gibberish, generic, repeated, duplicates across respondents, pasted", () => {
  const gib = response({ answers: { ...GOOD_ANSWERS, oe: "asdfgh jkl qwerty", oe2: "zxcvbnm asdf" } });
  const a = assess({ def: def(), response: gib, peers: [] });
  assert.ok(has(a, "openend.gibberish"), ruleIds(a).join());
  assert.ok(a.qualityScore < 80);

  const gen = response({ answers: { ...GOOD_ANSWERS, oe: "good", oe2: "nothing" } });
  const b = assess({ def: def(), response: gen, peers: [] });
  assert.ok(has(b, "openend.generic") || has(b, "openend.too_short"), ruleIds(b).join());

  const rep = response({ answers: { ...GOOD_ANSWERS, oe: "good good good good good good", oe2: "same text here for both" } });
  const c = assess({ def: def(), response: rep, peers: [] });
  assert.ok(has(c, "openend.repeated"), ruleIds(c).join());

  const p = peers(12);
  const text = "The dealer near my office gave me a very fair trade-in price and free servicing for two years.";
  const first = response({ answers: { ...GOOD_ANSWERS, oe: text } });
  const firstA = assess({ def: def(), response: first, peers: p });
  p.push({ sessionId: first.sessionId, status: "complete", answers: first.answers, startedAt: first.startedAt, completedAt: first.completedAt, ipHash: "ipA", deviceHash: "devA", system: firstA.system });
  const dup = response({ answers: { ...GOOD_ANSWERS, brand: "c", oe: text } });
  const d = assess({ def: def(), response: dup, peers: p });
  const f = d.flags.find((x) => x.ruleId === "openend.duplicate")!;
  assert.ok(f, ruleIds(d).join());
  assert.deepEqual(f.relatedSessionIds, [first.sessionId]);
  const near = response({ answers: { ...GOOD_ANSWERS, brand: "c", oe: text.replace("two years", "three years") } });
  assert.ok(has(assess({ def: def(), response: near, peers: p }), "openend.duplicate"), "near-duplicate by shingles");

  const pasted = response({ tel: telemetry(HUMAN_SECS, { pastes: { oe: 1, oe2: 1 } }) });
  const e = assess({ def: def(), response: pasted, peers: [] });
  assert.ok(has(e, "openend.pasted"), ruleIds(e).join());
  assert.ok(has(e, "interaction.paste_ratio"));
  assert.equal(e.system.SYSTEM_PASTE_COUNT, 2);
});

test("AI-like polish is a risk signal, worded as such", () => {
  const polished = "Furthermore, the vehicle demonstrates exceptional reliability across diverse driving conditions. Moreover, the dealership experience was consistently professional and transparent. Additionally, the overall value proposition remains compelling when compared with alternatives. In conclusion, it is important to note that the ownership experience has been overwhelmingly positive across every dimension considered.";
  const a = assess({ def: def(), response: response({ answers: { ...GOOD_ANSWERS, oe: polished } }), peers: [] });
  const f = a.flags.find((x) => x.ruleId === "openend.ai_like")!;
  assert.ok(f, ruleIds(a).join());
  assert.match(f.explanation, /not proof/);
});

/* ------------------------------------------------------------- behaviour */

test("device / network: webdriver is critical; shared device signature and IP count peers", () => {
  const bot = response({ tel: telemetry(HUMAN_SECS, { webdriver: true }) });
  const a = assess({ def: def(), response: bot, peers: [] });
  assert.ok(has(a, "device.webdriver"));
  assert.ok(a.riskScore >= 60 && a.classification !== "CLEAN");

  const p = peers(12);
  for (let i = 0; i < 4; i++) p[i].deviceHash = "shared-dev";
  for (let i = 0; i < 3; i++) p[i].ipHash = "shared-ip";
  const b = assess({ def: def(), response: response({ deviceHash: "shared-dev", ipHash: "shared-ip" }), peers: p });
  assert.ok(has(b, "device.duplicate"), ruleIds(b).join());
  assert.ok(has(b, "network.duplicate_ip"));
  assert.equal(b.flags.find((f) => f.ruleId === "device.duplicate")!.relatedSessionIds!.length, 4);
  assert.match(b.flags.find((f) => f.ruleId === "network.duplicate_ip")!.explanation, /a signal, not a verdict/);
});

test("navigation: rapid cycling; no-interaction pages read as automation", () => {
  const a = assess({ def: def(), response: response({ tel: telemetry(HUMAN_SECS, { backs: 7 }) }), peers: [] });
  assert.ok(has(a, "navigation.cycling"), ruleIds(a).join());
  assert.equal(a.system.SYSTEM_BACK_COUNT, 7);
  const b = assess({ def: def(), response: response({ tel: telemetry(HUMAN_SECS, { pointer: 0 }) }), peers: [] });
  // key events on p6 keep that page alive; the rest have no interaction
  assert.ok(has(b, "bot.no_interaction"), ruleIds(b).join());
});

test("screener gaming: earlier screened-out sessions on the same device, and changed screener answers", () => {
  const p = peers(12);
  p.push({ sessionId: "try1", status: "screened", answers: { own: "n" }, startedAt: new Date(1_600_000_000_000).toISOString(), completedAt: null, ipHash: "ipG", deviceHash: "devG" });
  p.push({ sessionId: "try2", status: "screened", answers: { own: "n" }, startedAt: new Date(1_600_000_100_000).toISOString(), completedAt: null, ipHash: "ipG", deviceHash: "devG" });
  const a = assess({ def: def(), response: response({ deviceHash: "devG", ipHash: "ipG" }), peers: p });
  assert.ok(has(a, "screener.repeat_attempts"), ruleIds(a).join());
  assert.ok(has(a, "screener.inconsistent"));
  assert.ok(a.system.SYSTEM_SCREENER_SCORE > 0);
});

test("telemetry the survey disabled is 'not measured', never a flag", () => {
  const d = def({ enabled: true, strictness: "very_strict", telemetry: { clipboard: false, navigation: false } });
  const a = assess({ def: d, response: response({ tel: telemetry(HUMAN_SECS, { pastes: { oe: 1, oe2: 1 }, backs: 9 }) }), peers: [] });
  assert.ok(!has(a, "openend.pasted") && !has(a, "navigation.cycling"), ruleIds(a).join());
  assert.ok(a.notMeasured.includes("clipboard") && a.notMeasured.includes("navigation"));
  assert.equal(a.system.SYSTEM_PASTE_COUNT, null);
  const b = assess({ def: def(), response: response({ tel: null }), peers: peers(12) });
  assert.ok(b.notMeasured.includes("timing"));
  assert.ok(!has(b, "timing.page_speeding"));
});

/* ------------------------------------------------------------- similarity & clusters */

test("similarity: exact duplicate answers are flagged; blended score and cluster reported", () => {
  const p = peers(12);
  const original = response({ answers: { ...GOOD_ANSWERS, brand: "d", s1: "1", s2: "1", s3: "5", s4: "1", s5: "5", s6: "1" } });
  const oa = assess({ def: def(), response: original, peers: p });
  p.push({ sessionId: original.sessionId, status: "complete", answers: original.answers, startedAt: original.startedAt, completedAt: original.completedAt, ipHash: "ipO", deviceHash: "devO", system: oa.system });
  const copy = response({ answers: { ...original.answers }, deviceHash: "devO" });
  const a = assess({ def: def(), response: copy, peers: p });
  assert.ok(has(a, "duplicate.answers"), ruleIds(a).join());
  assert.ok(has(a, "duplicate.multi_signal"), "shared device + identical answers");
  assert.ok(a.system.SYSTEM_SIMILARITY_SCORE! >= 90);
  assert.ok(a.cluster.similarSessionIds.includes(original.sessionId));
  assert.equal(a.classification === "CRITICAL" || a.classification === "HIGHLY_SUSPICIOUS", true);
  assert.equal(a.recommendation, "LIKELY EXCLUDE");
  // an honest peer is not caught by agreeing on common answers
  const honest = assess({ def: def(), response: response(), peers: p });
  assert.ok(!has(honest, "duplicate.answers"), ruleIds(honest).join());
});

test("pairSimilarity weights rare agreements above common ones", () => {
  const d = def();
  const a = comparable(d, { s1: "5", s2: "5", s3: "1" });
  const b = comparable(d, { s1: "5", s2: "5", s3: "1" });
  const crowd = Array.from({ length: 20 }, (_, i) => comparable(d, { s1: "5", s2: "5", s3: String(1 + (i % 5)) }));
  const freq = valueFrequencies([a, b, ...crowd]);
  const s = pairSimilarity(a, b, freq);
  assert.equal(s.agreement, 1);
  assert.ok(s.weighted > 0.9);
  const c = comparable(d, { s1: "5", s2: "5", s3: "3" });
  const s2 = pairSimilarity(a, c, freq);
  assert.ok(s2.weighted < 0.3, `agreeing only on the ubiquitous values is worth little: ${s2.weighted}`);
});

test("assessSurvey: a coordinated group becomes one cluster with a shared id; honest respondents stay out", () => {
  const d = def({ enabled: true, strictness: "standard" });
  const responses: ResponseRecord[] = [];
  for (let i = 0; i < 14; i++) {
    responses.push(response({ secs: HUMAN_SECS.map((s, k) => s * (0.6 + pick(i, k + 20, 41) / 50)), answers: variedAnswers(i) }));
  }
  const ring = { ...GOOD_ANSWERS, brand: "d", s1: "2", s2: "2", s3: "5", s4: "2", s5: "5", s6: "2", grid: { r1: "2", r2: "5", r3: "2", r4: "5", r5: "2", r6: "4" } };
  for (let i = 0; i < 5; i++) responses.push(response({ answers: { ...ring }, deviceHash: `ring-dev-${i % 2}`, ipHash: "ring-ip", secs: HUMAN_SECS.map((s) => s * 0.5) }));
  const sa = assessSurvey(d, responses);
  const ringIds = responses.slice(14).map((r) => r.sessionId);
  const clusterIds = new Set(ringIds.map((id) => sa.bySession.get(id)!.cluster.clusterId));
  assert.equal(clusterIds.size, 1, `ring members share one cluster id: ${[...clusterIds]}`);
  assert.ok(![...clusterIds][0] === false && [...clusterIds][0] !== null);
  for (const id of ringIds) {
    const a = sa.bySession.get(id)!;
    assert.ok(has(a, "cluster.coordinated") || has(a, "duplicate.answers"), ruleIds(a).join());
    assert.equal(a.cluster.size, 5);
    assert.ok(a.system.SYSTEM_CLUSTER_ID);
  }
  for (const r of responses.slice(0, 14)) {
    const a = sa.bySession.get(r.sessionId)!;
    assert.equal(a.cluster.clusterId, null, `honest ${r.sessionId}: ${ruleIds(a).join()}`);
    assert.equal(a.classification, "CLEAN", `honest ${r.sessionId}: ${a.reasons.join(" | ")}`);
  }
  assert.equal(sa.clusters.size, 5);
});

test("clusterSurvey closes links transitively", () => {
  const m = clusterSurvey([{ sessionId: "a", similarIds: ["b"] }, { sessionId: "b", similarIds: ["c"] }, { sessionId: "c", similarIds: [] }, { sessionId: "d", similarIds: [] }]);
  assert.equal(m.get("a")!.clusterId, m.get("c")!.clusterId);
  assert.equal(m.get("a")!.size, 3);
  assert.equal(m.has("d"), false);
});

/* ------------------------------------------------------------- scoring, bands, custom rules */

test("classification bands are configurable; quality and risk stay separate", () => {
  const cfg: any = { enabled: true, strictness: "standard", bands: { review: 10, suspicious: 20, highlySuspicious: 30, critical: 40 } };
  const a = assess({ def: def(cfg), response: response({ answers: { ...GOOD_ANSWERS, att: "a" } }), peers: [] });
  assert.ok(["SUSPICIOUS", "HIGHLY_SUSPICIOUS", "CRITICAL"].includes(a.classification), a.classification);
  const b = assess({ def: def(), response: response({ answers: { ...GOOD_ANSWERS, att: "a" } }), peers: [] });
  assert.ok(["REVIEW", "SUSPICIOUS"].includes(b.classification), b.classification);
  // pure quality problem: generic open ends hurt quality, barely touch risk
  const c = assess({ def: def(), response: response({ answers: { ...GOOD_ANSWERS, oe: "good", oe2: "ok" } }), peers: [] });
  assert.ok(c.qualityScore < 100 && c.riskScore < 15, `${c.qualityScore}/${c.riskScore}`);
  assert.equal(classify(0, { bands: { review: 20, suspicious: 40, highlySuspicious: 60, critical: 80 } } as any), "CLEAN");
  assert.equal(classify(85, { bands: { review: 20, suspicious: 40, highlySuspicious: 60, critical: 80 } } as any), "CRITICAL");
});

test("rule overrides: disable a rule, change a threshold, weight it, restrict to questions", () => {
  const speedy = response({ secs: HUMAN_SECS.map((s) => s / 20), tel: telemetry(HUMAN_SECS.map((s) => s / 20), { latencyMs: 150 }) });
  const off = assess({ def: def({ enabled: true, strictness: "standard", rules: { "timing.overall_speeding": { enabled: false } } }), response: speedy, peers: peers(12) });
  assert.ok(!has(off, "timing.overall_speeding"));
  const heavy = assess({ def: def({ enabled: true, strictness: "standard", rules: { "attention.failed": { weight: 2, severity: "critical" } } }), response: response({ answers: { ...GOOD_ANSWERS, att: "a" } }), peers: [] });
  const light = assess({ def: def(), response: response({ answers: { ...GOOD_ANSWERS, att: "a" } }), peers: [] });
  assert.ok(heavy.riskScore > light.riskScore);
  const only = assess({ def: def({ enabled: true, strictness: "standard", rules: { "openend.gibberish": { questionIds: ["oe2"] } } }), response: response({ answers: { ...GOOD_ANSWERS, oe: "asdfgh jkl qwerty zxcv", oe2: "asdfgh jkl qwerty zxcv" } }), peers: [] });
  const g = only.flags.find((f) => f.ruleId === "openend.gibberish")!;
  assert.deepEqual(g.questionIds, ["oe2"]);
});

test("custom rule: IF calc.SYSTEM_DURATION_RATIO < 0.3 AND calc.SYSTEM_ATTENTION_FAILED >= 1 THEN +40 risk, floor HIGHLY_SUSPICIOUS", () => {
  const cfg: any = {
    enabled: true, strictness: "relaxed",
    customRules: [{
      id: "cr1", name: "Speeder who failed the check", enabled: true, severity: "high", riskPoints: 40, qualityPenalty: 10, minClass: "HIGHLY_SUSPICIOUS",
      when: { type: "group", op: "and", children: [
        { type: "rule", source: { kind: "calculation", ref: "SYSTEM_DURATION_RATIO" }, operator: "lt", value: 0.3 },
        { type: "rule", source: { kind: "calculation", ref: "SYSTEM_ATTENTION_FAILED" }, operator: "gte", value: 1 },
      ] },
      explanation: "Fast and inattentive.",
    }],
  };
  const fast = response({ secs: HUMAN_SECS.map((s) => s / 10), answers: { ...GOOD_ANSWERS, att: "a" } });
  const a = assess({ def: def(cfg), response: fast, peers: peers(12) });
  const f = a.flags.find((x) => x.ruleId === "custom.cr1")!;
  assert.ok(f, ruleIds(a).join());
  assert.equal(f.riskPoints, 40);
  assert.equal(f.title, "Speeder who failed the check");
  assert.match(f.observed, /SYSTEM_DURATION_RATIO = 0\.\d+/);
  assert.ok(["HIGHLY_SUSPICIOUS", "CRITICAL"].includes(a.classification));
  const slow = assess({ def: def(cfg), response: response({ answers: { ...GOOD_ANSWERS, att: "a" } }), peers: peers(12) });
  assert.ok(!has(slow, "custom.cr1"));
});

test("explainability: every flag carries rule, observed, severity, points, explanation, time and questions; reasons are ordered by weight", () => {
  const a = assess({ def: def(), response: response({ secs: HUMAN_SECS.map((s) => s / 20), tel: telemetry(HUMAN_SECS.map((s) => s / 20), { latencyMs: 150 }), answers: { ...GOOD_ANSWERS, att: "a", oe: "asdfgh jkl qwerty" } }), peers: peers(12) });
  assert.ok(a.flags.length >= 3);
  for (const f of a.flags) {
    assert.ok(f.ruleId && f.category && f.severity && f.title && f.explanation && f.observed !== undefined && f.at);
    assert.ok(typeof f.riskPoints === "number" && typeof f.qualityPenalty === "number");
    assert.ok(Array.isArray(f.questionIds));
  }
  assert.equal(a.reasons.length, a.flags.length);
  const weights = a.flags.map((f) => f.riskPoints + f.qualityPenalty);
  const sorted = [...a.flags].sort((x, y) => (y.riskPoints + y.qualityPenalty) - (x.riskPoints + x.qualityPenalty));
  assert.equal(a.reasons[0], `${sorted[0].title}: ${sorted[0].observed}${sorted[0].expected ? ` (expected ${sorted[0].expected})` : ""}.`);
  assert.ok(weights.length);
  assert.equal(a.system.SYSTEM_FLAG_COUNT, a.flags.length);
  assert.equal(a.system.SYSTEM_QUALITY_STATUS, a.classification);
});
