import { SurveyDefinition } from "@rescript/schema";
import type { ResponseRecord, ResponseTelemetry } from "./types.js";

/**
 * A REPRESENTATIVE RESPONDENT DATASET, AS CODE.
 *
 * The Quality Checks engine had been marking most respondents as bad. The
 * only honest way to say an engine does not do that is to run it over people
 * whose quality is KNOWN — because they were written that way — and count.
 * This module is that population: a fourteen-question car survey and a few
 * hundred respondents, each labelled with what they are and what verdict a
 * fair reviewer would give them.
 *
 *   valid      — should PASS. Careful people at every pace: fast readers,
 *                slow readers, satisfied customers who agree with every item,
 *                someone who switched tabs once, someone who skipped the
 *                optional question, whole offices behind one IP.
 *   borderline — REVIEW is fine; FLAGGED is not. Genuinely quick with one
 *                thin answer; a straight-liner on ONE grid; a pasted answer.
 *   invalid    — should be FLAGGED. Bots, speeders below any human floor,
 *                gibberish, failed attention checks, duplicate submissions,
 *                straight-lining every grid including the reverse-worded row.
 *
 * The test (`dataset.test.ts`) asserts the rates; the Studio's settings page
 * can run the same population against a survey's own settings to show what
 * they would do before they are applied to real people.
 */

export type DatasetLabel = "valid" | "borderline" | "invalid";

export interface DatasetRespondent {
  response: ResponseRecord;
  label: DatasetLabel;
  /** the one-line description of who this is, for the report */
  persona: string;
}

export interface QualityDataset {
  def: SurveyDefinition;
  respondents: DatasetRespondent[];
}

/* ------------------------------------------------------------ the survey */

const scale = ["1", "2", "3", "4", "5"].map((c, i) => ({ code: c, label: ["Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree"][i] }));
const brands = [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }, { code: "c", label: "Gamma" }, { code: "d", label: "Delta" }, { code: "dk", label: "Don't know", flags: ["dont_know"] }];

export const PAGES = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
export const PAGE_Q: Record<string, string[]> = { p1: ["own"], p2: ["brand", "freq"], p3: ["grid"], p4: ["grid2"], p5: ["att"], p6: ["oe", "oe2"], p7: ["s1", "s2", "s3"], p8: ["s4", "s5", "s6"] };

export function datasetDefinition(quality: Record<string, unknown> = { enabled: true, strictness: "standard" }): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "qds", code: "QDS", title: "Quality dataset", version: "1.0" },
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
      { id: "oe2", code: "Q7", variableName: "Q7", type: "long_text", text: "What would make you switch?", required: false },
      { id: "s1", code: "Q8", variableName: "Q8", type: "single_select", text: "Satisfaction overall?", options: scale },
      { id: "s2", code: "Q9", variableName: "Q9", type: "single_select", text: "Likelihood to recommend?", options: scale },
      { id: "s3", code: "Q10", variableName: "Q10", type: "single_select", text: "Value for money?", options: scale },
      { id: "s4", code: "Q11", variableName: "Q11", type: "single_select", text: "Service quality?", options: scale },
      { id: "s5", code: "Q12", variableName: "Q12", type: "single_select", text: "Would buy again?", options: scale },
      { id: "s6", code: "Q13", variableName: "Q13", type: "single_select", text: "Brand image?", options: scale },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["own"] },
      { type: "page", id: "p2", questionIds: ["brand", "freq"] },
      { type: "page", id: "p3", questionIds: ["grid"] },
      { type: "page", id: "p4", questionIds: ["grid2"] },
      { type: "page", id: "p5", questionIds: ["att"] },
      { type: "page", id: "p6", questionIds: ["oe", "oe2"] },
      { type: "page", id: "p7", questionIds: ["s1", "s2", "s3"] },
      { type: "page", id: "p8", questionIds: ["s4", "s5", "s6"] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

/* ------------------------------------------------------------ builders */

/** Deterministic pseudo-random 1..n per (respondent, item) — the same population every run. */
export const pick = (i: number, k: number, n = 5): number => {
  let h = (Math.imul(i + 1, 73856093) ^ Math.imul(k + 1, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return 1 + (h % n);
};

/** Seconds a careful person spends per page. About 3½ minutes in all. */
export const HUMAN_SECS = [6, 10, 45, 30, 8, 70, 20, 22];
const START = 1_700_000_000_000;

export interface TelemetryOptions {
  pastes?: Record<string, number>;
  latencyMs?: number;
  device?: Partial<NonNullable<ResponseTelemetry["device"]>>;
  backs?: number;
  pointer?: number;
  webdriver?: boolean;
  blurs?: number;
  outOfFocusMs?: number;
  reloads?: number;
  /** when this person started, seconds after the fieldwork opened — real completes arrive over hours, not at once */
  startOffsetSec?: number;
}

export function telemetry(pageSecs: number[], opts: TelemetryOptions = {}): ResponseTelemetry {
  const startAt = START + (opts.startOffsetSec ?? 0) * 1000;
  let t = startAt;
  const pages: ResponseTelemetry["pages"] = [];
  const questions: ResponseTelemetry["questions"] = {};
  PAGES.forEach((pid, i) => {
    const dur = pageSecs[i]! * 1000;
    const enteredAt = t;
    const leftAt = t + dur;
    const blursHere = opts.blurs && i === 3 ? opts.blurs : 0;
    pages.push({
      pageId: pid, step: i, enteredAt, leftAt, via: i === 0 ? "start" : "next", questionIds: PAGE_Q[pid]!,
      outOfFocusMs: blursHere ? (opts.outOfFocusMs ?? 20_000) : 0, blurs: blursHere,
      pointerEvents: opts.pointer ?? 6, keyEvents: pid === "p6" ? 40 : 0, scrollEvents: opts.pointer === 0 ? 0 : 1,
    });
    PAGE_Q[pid]!.forEach((qid, j) => {
      const lat = (opts.latencyMs ?? Math.max(900, dur * 0.3)) + j * 400;
      const first = enteredAt + Math.min(lat, Math.max(100, dur - 100));
      questions[qid] = {
        firstChangeAt: first, lastChangeAt: Math.min(leftAt - 50, first + Math.max(100, dur * 0.3)), changes: 1,
        latencyMs: j === 0 ? lat : undefined, pastes: opts.pastes?.[qid] ?? 0, pasteChars: opts.pastes?.[qid] ? 120 : 0,
        typedChars: qid.startsWith("oe") ? 40 : 0, copies: 0,
      };
    });
    t = leftAt;
  });
  for (let b = 0; b < (opts.backs ?? 0); b++) {
    pages.push({ pageId: "p2", step: 1, enteredAt: t, leftAt: t + 1500, via: "back", questionIds: PAGE_Q.p2!, outOfFocusMs: 0, blurs: 0, pointerEvents: 2, keyEvents: 0, scrollEvents: 0 });
    t += 1500;
    pages.push({ pageId: "p3", step: 2, enteredAt: t, leftAt: t + 1500, via: "next", questionIds: PAGE_Q.p3!, outOfFocusMs: 0, blurs: 0, pointerEvents: 2, keyEvents: 0, scrollEvents: 0 });
    t += 1500;
  }
  const blurs = opts.blurs ?? 0;
  return {
    v: 1, startedAt: startAt, submittedAt: t, pages, questions,
    focus: { blurs, totalOutOfFocusMs: blurs ? (opts.outOfFocusMs ?? 20_000) : 0, longestOutOfFocusMs: blurs ? (opts.outOfFocusMs ?? 20_000) : 0 },
    clipboard: { copies: 0, pastes: Object.values(opts.pastes ?? {}).reduce((s, x) => s + x, 0), pasteChars: Object.values(opts.pastes ?? {}).length * 120, largePastes: 0, pasteQuestions: Object.keys(opts.pastes ?? {}).length },
    navigation: { back: opts.backs ?? 0, forward: 7 + (opts.backs ?? 0), reloads: opts.reloads ?? 0, jumps: 0, sequence: [] },
    interaction: { pointerEvents: opts.pointer === 0 ? 0 : 50, keyEvents: opts.pointer === 0 ? 0 : 40, scrollEvents: opts.pointer === 0 ? 0 : 8 },
    device: { type: "desktop", browser: "Chrome", os: "macOS", screen: "1440x900", viewport: "1200x800", dpr: 2, locale: "en-GB", language: "en", timezone: "Europe/London", tzOffset: 0, touch: false, webdriver: opts.webdriver ?? false, ...(opts.device ?? {}) },
    disabled: [],
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
  "Needed something automatic after the knee operation and this was in stock.", "The lease deal through work made it the obvious choice.",
  "Our last one did 200,000 miles so we went straight back.", "Big enough for the dog crate without folding the seats.",
];
const OE2_TEXTS = [
  "A real electric range of 300 miles at this price.", "Cheaper servicing would tempt me.", "Nothing, unless they stop making the estate.",
  "A dealer closer to home.", "Better resale values elsewhere.", "If the next model gets uglier I am gone.",
  "A proper seven seater.", "Lower road tax.", "Free charging at work for another brand.", "Reliability problems would do it.",
  "Someone offering a great trade in.", "More boot space.", "A convertible version.", "If the kids leave home I would go smaller.",
  "Nothing really.", "Better infotainment and a bigger screen.", "A hybrid with a longer warranty.", "Honestly nothing at the moment.",
  "A decent van conversion.", "Lower insurance for my son.",
];

const BASE = {
  own: "y", brand: "a", freq: "daily",
  grid: { r1: "4", r2: "5", r3: "2", r4: "4", r5: "3", r6: "4" },
  grid2: { r1: "4", r2: "3", r3: "5", r4: "4", r5: "2" },
  att: "b",
  oe: OE_TEXTS[0], oe2: OE2_TEXTS[0],
  s1: "4", s2: "5", s3: "3", s4: "4", s5: "4", s6: "5",
};

/**
 * An open end nobody else wrote. Real people do not produce identical
 * sentences; two respondents with the same twenty-word answer ARE suspicious,
 * and the engine says so. So each respondent's text is composed from a stem,
 * a detail and a closing clause chosen by their own index.
 */
const OE_DETAILS = ["after a long test drive", "on a friend's advice", "because the old one died", "for the fuel economy", "mostly for the boot space",
  "since the dealer is nearby", "for the warranty", "because it was in stock", "after reading the reviews", "for the price"];
const OE_CLOSERS = ["and so far no regrets.", "and it has been fine.", "though the seats could be softer.", "and the kids like it.", "and I would do it again.",
  "which turned out well.", "and it suits our street.", "even if it is a bit thirsty.", "and the service has been good.", "and it still feels new."];
const OE_OPENERS = ["Well,", "To be honest,", "Mainly", "In the end", "Simple:", "Long story short,", "For us", "Basically", "Looking back,", "Truthfully,", "My wife says", "As a family"];
function uniqueOpenEnd(i: number): string {
  const stem = OE_TEXTS[i % OE_TEXTS.length]!.replace(/\.$/, "").replace(/^[A-Z]/, (c) => c.toLowerCase());
  /* the index itself makes the sentence this person's own: no two share mileage and month */
  const miles = 8_000 + i * 137;
  const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][i % 12];
  return `${OE_OPENERS[pick(i, 73, OE_OPENERS.length) - 1]} ${stem}, ${OE_DETAILS[pick(i, 70, OE_DETAILS.length) - 1]} ${OE_CLOSERS[pick(i, 71, OE_CLOSERS.length) - 1]} We picked it up in ${month} and it has done ${miles.toLocaleString("en-GB")} miles since.`;
}
const SW_WHEN = ["when the lease ends", "at the next service", "once the kids are older", "if prices keep rising", "in a couple of years", "when this one gives up", "before the next winter", "if work changes"];
const SW_WHY = ["mostly for the money", "for the space", "for the running costs", "because of the dealer", "for a change", "for the tech", "for reliability"];
function uniqueSwitch(i: number): string {
  const stem = OE2_TEXTS[(i * 7) % OE2_TEXTS.length]!.replace(/\.$/, "").replace(/^[A-Z]/, (c) => c.toLowerCase());
  const when = SW_WHEN[pick(i, 75, SW_WHEN.length) - 1];
  const why = SW_WHY[pick(i, 76, SW_WHY.length) - 1];
  const year = 2027 + (i % 7);
  const n = 20 + (i % 41);
  /* a clause only this respondent writes: three word lists indexed three different ways off the same index */
  const A = ["My sister", "A colleague", "The neighbour", "Our mechanic", "My dad", "A mate", "My partner", "The kids", "My boss", "An old friend", "The dealer", "My brother", "A customer"];
  const B = ["keeps saying", "mentioned", "reckons", "warned me", "joked", "insists", "predicted", "wrote", "agrees", "doubts", "hopes"];
  const C = ["the same thing", "otherwise", "it will be sooner", "we will keep it forever", "prices will drop", "the next model is better", "leasing is smarter", "electric is not there yet", "diesel is finished"];
  const own = `${A[i % A.length]} ${B[Math.floor(i / 3) % B.length]} ${C[(i * 5) % C.length]}.`;
  /* three sentence shapes, so two people with the same stem still write different sentences */
  switch (i % 3) {
    case 0: return `Probably ${stem}, ${when}, ${why} — say ${year} or so, after ${n} more services. ${own}`;
    case 1: return `${why.charAt(0).toUpperCase()}${why.slice(1)}, ${when}: ${stem}. I would guess around ${year}, having spent ${n} weekends thinking about it. ${own}`;
    default: return `Hard to say. ${stem.charAt(0).toUpperCase()}${stem.slice(1)} might do it ${when}, ${why}; ${n} people have asked me and I always say ${year}. ${own}`;
  }
}

export function variedAnswers(i: number): Record<string, unknown> {
  return {
    ...BASE, brand: brands[pick(i, 0, 4) - 1]!.code, freq: ["some", "daily", "daily", "never"][pick(i, 40, 4) - 1],
    s1: String(pick(i, 1)), s2: String(pick(i, 2)), s3: String(pick(i, 3)), s4: String(pick(i, 4)), s5: String(pick(i, 5)), s6: String(pick(i, 6)),
    grid: { r1: String(pick(i, 7)), r2: String(pick(i, 8)), r3: String(pick(i, 9)), r4: String(pick(i, 10)), r5: String(pick(i, 11)), r6: String(pick(i, 12)) },
    grid2: { r1: String(pick(i, 13)), r2: String(pick(i, 14)), r3: String(pick(i, 15)), r4: String(pick(i, 16)), r5: String(pick(i, 16)) },
    oe: uniqueOpenEnd(i), oe2: uniqueSwitch(i),
  };
}

/** A satisfied customer: agrees or strongly agrees with everything positive, disagrees with the reverse-worded rows. */
function satisfiedAnswers(i: number): Record<string, unknown> {
  /* agree or strongly agree, item by item — a real satisfied customer is not uniform */
  const hi = (k: number) => String(4 + (pick(i, 50 + k, 2) - 1));
  const lo = (k: number) => String(1 + (pick(i, 60 + k, 2) - 1));
  return {
    ...variedAnswers(i),
    grid: { r1: hi(1), r2: hi(2), r3: lo(1), r4: hi(3), r5: hi(4), r6: lo(2) },
    grid2: { r1: hi(5), r2: hi(6), r3: hi(7), r4: hi(8), r5: hi(9) },
    s1: hi(10), s2: hi(11), s3: hi(12), s4: hi(13), s5: hi(14), s6: hi(15),
  };
}

let seq = 0;
/** Fieldwork opens at START; this person starts `offset` seconds later — spread over two days. */
const startOffset = (i: number) => pick(i, 80, 48 * 60) * 60;

function make(i: number, opts: {
  secs?: number[]; answers?: Record<string, unknown>; tel?: ResponseTelemetry | null;
  ipHash?: string; deviceHash?: string; sessionId?: string; startOffsetSec?: number;
}): ResponseRecord {
  const secs = opts.secs ?? HUMAN_SECS;
  const offset = opts.startOffsetSec ?? startOffset(i);
  const tel = opts.tel === undefined ? telemetry(secs, { startOffsetSec: offset }) : opts.tel;
  const total = secs.reduce((s, x) => s + x, 0);
  seq++;
  return {
    sessionId: opts.sessionId ?? `ds${String(seq).padStart(4, "0")}`,
    status: "complete",
    answers: opts.answers ?? variedAnswers(i),
    startedAt: new Date(START + offset * 1000).toISOString(),
    completedAt: new Date(START + offset * 1000 + total * 1000).toISOString(),
    telemetry: tel,
    ipHash: opts.ipHash ?? `ip-${seq}`,
    deviceHash: opts.deviceHash ?? `dev-${seq}`,
  };
}

/** Human variation in pace: each page between 0.6× and 1.4× the careful person's, per respondent, per page. */
const humanPace = (i: number, factor = 1) => HUMAN_SECS.map((s, k) => s * factor * (0.6 + pick(i, k + 20, 41) / 50));

/* ------------------------------------------------------------ the population */

export function buildQualityDataset(): QualityDataset {
  seq = 0;
  const def = datasetDefinition();
  const R: DatasetRespondent[] = [];
  const add = (label: DatasetLabel, persona: string, response: ResponseRecord) => R.push({ label, persona, response });

  /* ---- valid: 150 people, at every pace, from every kind of network */
  for (let i = 0; i < 90; i++) add("valid", "ordinary respondent, human pace", make(i, { secs: humanPace(i) }));
  for (let i = 90; i < 110; i++) {
    /* fast readers: 45–55% of the careful person's time, still reading, still varied */
    add("valid", "fast but legitimate reader", make(i, { secs: humanPace(i, 0.5), tel: telemetry(humanPace(i, 0.5), { latencyMs: 1400 }) }));
  }
  for (let i = 110; i < 122; i++) add("valid", "slow, careful respondent", make(i, { secs: humanPace(i, 2.2) }));
  for (let i = 122; i < 134; i++) add("valid", "satisfied customer who agrees with every positive item", make(i, { secs: humanPace(i), answers: satisfiedAnswers(i) }));
  for (let i = 134; i < 140; i++) {
    /* one tab switch mid-survey, twenty seconds away */
    add("valid", "switched tabs once", make(i, { secs: humanPace(i), tel: telemetry(humanPace(i), { blurs: 1, outOfFocusMs: 20_000 }) }));
  }
  for (let i = 140; i < 146; i++) {
    /* skipped the optional open end */
    const a = variedAnswers(i); delete a.oe2;
    add("valid", "skipped the optional question", make(i, { secs: humanPace(i), answers: a }));
  }
  for (let i = 146; i < 154; i++) {
    /* an office: eight people behind one IP, three sharing a device signature (same laptop model) */
    add("valid", "office worker behind a shared IP", make(i, { secs: humanPace(i), ipHash: "ip-office", deviceHash: i < 149 ? "dev-office-laptop" : `dev-${i}` }));
  }
  for (let i = 154; i < 158; i++) {
    /* reloaded once, went back once to check an answer */
    add("valid", "went back once, reloaded once", make(i, { secs: humanPace(i), tel: telemetry(humanPace(i), { backs: 1, reloads: 1 }) }));
  }

  /* ---- borderline: 20 people a reviewer might want to glance at */
  for (let i = 200; i < 206; i++) {
    /* quick (40%) AND a one-word answer to the required open end */
    add("borderline", "quick with a thin open end", make(i, { secs: humanPace(i, 0.4), answers: { ...variedAnswers(i), oe: "Price" }, tel: telemetry(humanPace(i, 0.4), { latencyMs: 1100 }) }));
  }
  for (let i = 206; i < 212; i++) {
    /* straight-lined ONE grid (the dealer one, no reverse-worded rows), everything else varied */
    add("borderline", "straight-lined one grid", make(i, { secs: humanPace(i), answers: { ...variedAnswers(i), grid2: { r1: "4", r2: "4", r3: "4", r4: "4", r5: "4" } } }));
  }
  for (let i = 212; i < 216; i++) {
    /* pasted the open end from notes */
    add("borderline", "pasted an answer from notes", make(i, { secs: humanPace(i), tel: telemetry(humanPace(i), { pastes: { oe: 1 } }) }));
  }
  for (let i = 216; i < 220; i++) {
    /* three tab switches, a long time away, then finished at a normal pace */
    add("borderline", "away from the tab several times", make(i, { secs: humanPace(i), tel: telemetry(humanPace(i), { blurs: 3, outOfFocusMs: 400_000 }) }));
  }

  /* ---- invalid: 40 people a reviewer would exclude */
  for (let i = 300; i < 310; i++) {
    /* a script: every page in about a second, no pointer events, instant answers */
    const secs = HUMAN_SECS.map(() => 0.9 + (pick(i, 60, 3) - 1) * 0.05);
    add("invalid", "bot: uniform sub-second pages, no interaction", make(i, { secs, tel: telemetry(secs, { latencyMs: 120, pointer: 0 }) }));
  }
  for (let i = 310; i < 318; i++) {
    /* a speeder at 15% of human time, failing the attention check */
    const secs = humanPace(i, 0.15);
    add("invalid", "speeder who failed the attention check", make(i, { secs, answers: { ...variedAnswers(i), att: "a" }, tel: telemetry(secs, { latencyMs: 300 }) }));
  }
  for (let i = 318; i < 324; i++) {
    /* straight-lines BOTH grids, one column, including the reverse-worded rows; extreme on every scale */
    add("invalid", "straight-liner on every grid including reverse-worded rows", make(i, { secs: humanPace(i, 0.5), answers: {
      ...variedAnswers(i),
      grid: { r1: "5", r2: "5", r3: "5", r4: "5", r5: "5", r6: "5" }, grid2: { r1: "5", r2: "5", r3: "5", r4: "5", r5: "5" },
      s1: "5", s2: "5", s3: "5", s4: "5", s5: "5", s6: "5", att: "a",
    } }));
  }
  for (let i = 324; i < 330; i++) {
    /* gibberish in both open ends, fast */
    add("invalid", "gibberish open ends", make(i, { secs: humanPace(i, 0.35), answers: { ...variedAnswers(i), oe: "asdkjh askdjh qwlekj zxmcn", oe2: "kjhsdf lkjsdf qwpeoi" }, tel: telemetry(humanPace(i, 0.35), { latencyMs: 400 }) }));
  }
  /* duplicate submissions: the same answers, the same device, twice each */
  for (let i = 330; i < 336; i++) {
    const answers = variedAnswers(i);
    add("invalid", "duplicate submission (original)", make(i, { secs: humanPace(i, 0.6), answers, deviceHash: `dev-dup-${i}`, ipHash: `ip-dup-${i}` }));
    add("invalid", "duplicate submission (copy)", make(i, { secs: humanPace(i, 0.55), answers: { ...answers }, deviceHash: `dev-dup-${i}`, ipHash: `ip-dup-${i}` }));
  }
  for (let i = 340; i < 344; i++) {
    /* browser reports automation */
    add("invalid", "automation flag set in the browser", make(i, { secs: humanPace(i, 0.5), tel: telemetry(humanPace(i, 0.5), { webdriver: true }) }));
  }

  return { def, respondents: R };
}

/* ------------------------------------------------------------ the report */

export interface DatasetOutcome {
  label: DatasetLabel;
  persona: string;
  sessionId: string;
  verdict: "PASS" | "REVIEW" | "FLAGGED";
  classification: string;
  risk: number;
  quality: number;
  because: string;
  rules: string[];
}

export interface DatasetReport {
  total: number;
  byLabel: Record<DatasetLabel, { n: number; PASS: number; REVIEW: number; FLAGGED: number }>;
  /** the two numbers the brief asks about */
  validFlaggedRate: number;
  invalidFlaggedRate: number;
  validPassRate: number;
  borderlineFlaggedRate: number;
  outcomes: DatasetOutcome[];
  /** persona → verdict counts, so a settings change can be read persona by persona */
  byPersona: Record<string, { PASS: number; REVIEW: number; FLAGGED: number }>;
}

export function summarizeDataset(outcomes: DatasetOutcome[]): DatasetReport {
  const byLabel = { valid: { n: 0, PASS: 0, REVIEW: 0, FLAGGED: 0 }, borderline: { n: 0, PASS: 0, REVIEW: 0, FLAGGED: 0 }, invalid: { n: 0, PASS: 0, REVIEW: 0, FLAGGED: 0 } };
  const byPersona: DatasetReport["byPersona"] = {};
  for (const o of outcomes) {
    byLabel[o.label].n++;
    byLabel[o.label][o.verdict]++;
    (byPersona[o.persona] ??= { PASS: 0, REVIEW: 0, FLAGGED: 0 })[o.verdict]++;
  }
  const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    total: outcomes.length,
    byLabel,
    validFlaggedRate: rate(byLabel.valid.FLAGGED, byLabel.valid.n),
    validPassRate: rate(byLabel.valid.PASS, byLabel.valid.n),
    invalidFlaggedRate: rate(byLabel.invalid.FLAGGED, byLabel.invalid.n),
    borderlineFlaggedRate: rate(byLabel.borderline.FLAGGED, byLabel.borderline.n),
    outcomes,
    byPersona,
  };
}

/* ------------------------------------------------------ early fieldwork */

/**
 * THE PRODUCTION SYMPTOM, REPRODUCED.
 *
 * The complaint that started this work: on a real project, the first
 * completes — the research team and their colleagues testing the live link
 * from one office, quickly, one of them pasting a prepared answer — came out
 * HIGHLY SUSPICIOUS almost to a person. Seven of seven completes from one IP,
 * two or three per device signature, every page "too fast" against a
 * reading-time estimate that assumes each word is read, a paste. Each signal
 * was small; together, under a noisy-OR that treated them as independent
 * facts, they passed 60.
 *
 * Twelve such people. Every one is a legitimate respondent.
 */
export function buildEarlyFieldworkDataset(): QualityDataset {
  seq = 5000;
  const def = datasetDefinition();
  const R: DatasetRespondent[] = [];
  for (let i = 0; i < 12; i++) {
    const secs = humanPace(400 + i, 0.5);
    const tel = telemetry(secs, {
      latencyMs: 1300,
      startOffsetSec: i * 900,
      pastes: i % 4 === 0 ? { oe: 1 } : undefined,
    });
    R.push({
      label: "valid",
      persona: "early fieldwork: office colleague on the shared IP, quick, against an estimate",
      response: make(400 + i, { secs, tel, ipHash: "ip-office-hq", deviceHash: `dev-office-${i % 3}`, startOffsetSec: i * 900 }),
    });
  }
  return { def, respondents: R };
}
