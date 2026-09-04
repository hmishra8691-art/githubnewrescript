import type { RuleDef, RuleParamDef } from "./types.js";

/**
 * The rule catalogue — every built-in check, its category, default severity,
 * default points and its thresholds per strictness level. The Studio renders
 * this table for the Custom strictness editor; the engine reads it for the
 * presets. Adding a rule means adding an entry here and an implementation in
 * `rules/`; nothing else knows the list.
 *
 * Points: `riskPoints` is what one firing adds to the fraud-risk noisy-OR
 * (see score.ts) before the researcher's weight; `qualityPenalty` is what it
 * subtracts from the quality score. The two are deliberately separate — a
 * one-word open end hurts quality but says nothing about fraud; a duplicate
 * device signature says a lot about fraud and nothing about answer quality.
 */

type L = { relaxed: number | string | boolean; standard: number | string | boolean; strict: number | string | boolean; very_strict: number | string | boolean };
const lvl = (relaxed: number, standard: number, strict: number, very_strict: number): L =>
  ({ relaxed, standard, strict, very_strict });
const on = (relaxed: boolean, standard: boolean, strict: boolean, very_strict: boolean) =>
  ({ relaxed, standard, strict, very_strict });
const ALL = on(true, true, true, true);
const STD_UP = on(false, true, true, true);
const STRICT_UP = on(false, false, true, true);
const VSTRICT = on(false, false, false, true);

const p = (key: string, label: string, defaults: L, unit?: string, hint?: string): RuleParamDef =>
  ({ key, label, defaults, unit, hint });

export const RULES: RuleDef[] = [
  /* ------------------------------------------------------------ timing */
  {
    id: "timing.overall_speeding", category: "timing", title: "Overall speeding",
    description: "Total completion time far below the survey's benchmark (median of completes, or the reading-time estimate when there are too few).",
    defaultSeverity: "high", riskPoints: 35, qualityPenalty: 30, enabledIn: ALL, needs: ["timing"],
    params: [p("ratio", "Flag when total time is below this share of the benchmark", lvl(0.25, 0.4, 0.5, 0.6), "× benchmark")],
  },
  {
    id: "timing.page_speeding", category: "timing", title: "Page-level speeding",
    description: "Individual pages answered far faster than their benchmark.",
    defaultSeverity: "medium", riskPoints: 15, qualityPenalty: 12, enabledIn: STD_UP, needs: ["timing"],
    params: [
      p("ratio", "Page is a speed page below this share of its benchmark", lvl(0.2, 0.3, 0.4, 0.5), "× benchmark"),
      p("share", "Flag when this share of pages are speed pages", lvl(0.6, 0.4, 0.3, 0.2), "of pages"),
    ],
  },
  {
    id: "timing.question_speeding", category: "timing", title: "Question-level speeding",
    description: "Questions changed almost instantly after the page appeared — before the text could have been read.",
    defaultSeverity: "medium", riskPoints: 12, qualityPenalty: 10, enabledIn: STD_UP, needs: ["timing"],
    params: [
      p("minLatencyMs", "Reaction faster than this is implausible", lvl(500, 800, 1200, 1500), "ms"),
      p("share", "Flag when this share of answered questions are implausibly fast", lvl(0.6, 0.4, 0.3, 0.2), "of questions"),
    ],
  },
  {
    id: "timing.matrix_speeding", category: "timing", title: "Matrix speeding",
    description: "A grid answered in less time than its rows could be read.",
    defaultSeverity: "medium", riskPoints: 15, qualityPenalty: 15, enabledIn: ALL, needs: ["timing"],
    params: [p("secPerRow", "Fewer seconds per row than this", lvl(0.8, 1.2, 1.6, 2), "s/row")],
  },
  {
    id: "timing.openend_speeding", category: "timing", title: "Open-ended speeding",
    description: "Text answers produced faster than a person types (characters per second), or pasted whole.",
    defaultSeverity: "medium", riskPoints: 15, qualityPenalty: 10, enabledIn: STD_UP, needs: ["timing"],
    params: [p("charsPerSec", "Faster than this many characters per second", lvl(25, 15, 12, 10), "chars/s")],
  },
  {
    id: "timing.reading_time", category: "timing", title: "Reading vs answer time",
    description: "Pages left before the words on them could have been read at a fast reading speed.",
    defaultSeverity: "medium", riskPoints: 10, qualityPenalty: 10, enabledIn: STD_UP, needs: ["timing"],
    params: [
      p("wordsPerMin", "Reading speed assumed", lvl(500, 400, 350, 300), "wpm"),
      p("share", "Flag when this share of pages were left too early", lvl(0.7, 0.5, 0.4, 0.3), "of pages"),
    ],
  },
  {
    id: "timing.uniform", category: "timing", title: "Unnaturally uniform timing",
    description: "Every page took almost exactly the same time — people vary, scripts do not.",
    defaultSeverity: "high", riskPoints: 25, qualityPenalty: 5, enabledIn: STD_UP, needs: ["timing"],
    params: [
      p("maxCv", "Coefficient of variation of page times below this", lvl(0.08, 0.12, 0.18, 0.25)),
      p("minPages", "Only with at least this many pages", lvl(6, 5, 4, 4), "pages"),
    ],
  },
  {
    id: "timing.short_dwell", category: "timing", title: "Abnormally short dwell time",
    description: "Pages with real questions shown for under a second or two.",
    defaultSeverity: "medium", riskPoints: 12, qualityPenalty: 10, enabledIn: ALL, needs: ["timing"],
    params: [
      p("minMs", "A page shown for less than this", lvl(700, 1200, 1800, 2500), "ms"),
      p("share", "Flag when this share of pages were", lvl(0.5, 0.35, 0.25, 0.15), "of pages"),
    ],
  },
  {
    id: "timing.idle_then_rush", category: "timing", title: "Long idle, then sudden completion",
    description: "A long pause (or out-of-focus period) followed by the remaining pages being rushed.",
    defaultSeverity: "medium", riskPoints: 15, qualityPenalty: 8, enabledIn: STD_UP, needs: ["timing"],
    params: [
      p("idleSec", "An idle gap longer than this", lvl(900, 600, 300, 180), "s"),
      p("rushRatio", "…followed by pages at under this share of benchmark", lvl(0.3, 0.4, 0.5, 0.6), "× benchmark"),
    ],
  },
  {
    id: "timing.entropy", category: "timing", title: "Timing distribution anomaly",
    description: "Response-time entropy far below peers: times cluster on a few values.",
    defaultSeverity: "low", riskPoints: 10, qualityPenalty: 3, enabledIn: STRICT_UP, needs: ["timing", "peers"],
    params: [p("minEntropy", "Normalised entropy of page-time buckets below this", lvl(0.2, 0.3, 0.4, 0.5))],
  },
  {
    id: "timing.acceleration", category: "timing", title: "End-of-survey acceleration",
    description: "The second half was answered much faster than the first, relative to benchmark — attention ran out.",
    defaultSeverity: "low", riskPoints: 8, qualityPenalty: 12, enabledIn: STD_UP, needs: ["timing"],
    params: [p("ratio", "Second-half pace below this share of first-half pace", lvl(0.25, 0.35, 0.45, 0.55))],
  },
  {
    id: "timing.pattern_match", category: "timing", title: "Repeated timing pattern across respondents",
    description: "The per-page timing profile almost equals another respondent's — a signature of scripted or coordinated completion.",
    defaultSeverity: "high", riskPoints: 25, qualityPenalty: 0, enabledIn: STD_UP, needs: ["timing", "peers"],
    params: [p("tolerance", "Pages within this share of each other count as the same", lvl(0.03, 0.05, 0.08, 0.1)), p("minPages", "Only with at least this many common pages", lvl(8, 6, 6, 5), "pages")],
  },

  /* ------------------------------------------------------------ matrix */
  {
    id: "matrix.straightline", category: "matrix", title: "Straight-lining",
    description: "The same column chosen for (almost) every row of a grid.",
    defaultSeverity: "medium", riskPoints: 15, qualityPenalty: 20, enabledIn: ALL,
    params: [
      p("minRows", "Only grids with at least this many rows", lvl(6, 5, 4, 4), "rows"),
      p("sameShare", "Share of rows on one column at or above this", lvl(1, 0.95, 0.9, 0.85)),
      p("gridShare", "Flag when this share of the survey's grids straight-line", lvl(0.75, 0.51, 0.34, 0.25), "of grids"),
    ],
  },
  {
    id: "matrix.reverse_straightline", category: "matrix", title: "Reverse straight-lining",
    description: "Straight-lining on a grid whose rows include reverse-worded items (mixed polarity), where one column cannot be sincere for all rows.",
    defaultSeverity: "high", riskPoints: 20, qualityPenalty: 25, enabledIn: STD_UP, params: [],
  },
  {
    id: "matrix.diagonal", category: "matrix", title: "Diagonal / zig-zag pattern",
    description: "Columns chosen in a strict sequence down the grid (1,2,3,4… or 5,4,3,2…).",
    defaultSeverity: "high", riskPoints: 25, qualityPenalty: 25, enabledIn: ALL,
    params: [p("minRows", "Only grids with at least this many rows", lvl(6, 5, 4, 4), "rows")],
  },
  {
    id: "matrix.alternating", category: "matrix", title: "Alternating / repeating sequence",
    description: "A short repeating cycle of columns (a,b,a,b or a,b,c,a,b,c).",
    defaultSeverity: "high", riskPoints: 20, qualityPenalty: 20, enabledIn: STD_UP,
    params: [p("minRows", "Only grids with at least this many rows", lvl(6, 6, 5, 4), "rows")],
  },
  {
    id: "matrix.low_variance", category: "matrix", title: "Low response variance",
    description: "Answers across grids barely vary — not a straight line, but nearly.",
    defaultSeverity: "low", riskPoints: 8, qualityPenalty: 12, enabledIn: STD_UP,
    params: [p("maxEntropy", "Normalised entropy of columns used below this", lvl(0.15, 0.25, 0.35, 0.45))],
  },
  {
    id: "matrix.midpoint", category: "matrix", title: "Excessive midpoint selection",
    description: "The neutral / middle scale point chosen for most rows across grids.",
    defaultSeverity: "low", riskPoints: 5, qualityPenalty: 12, enabledIn: STD_UP,
    params: [p("share", "Midpoint share above this", lvl(0.9, 0.8, 0.7, 0.6))],
  },
  {
    id: "matrix.extremes", category: "matrix", title: "Excessive extreme-point selection",
    description: "Only the end points of scales are ever used.",
    defaultSeverity: "low", riskPoints: 5, qualityPenalty: 10, enabledIn: STRICT_UP,
    params: [p("share", "Extreme share above this", lvl(0.95, 0.9, 0.85, 0.8))],
  },
  {
    id: "matrix.signature_match", category: "matrix", title: "Identical matrix signature across respondents",
    description: "A grid answered exactly like another respondent's, row for row.",
    defaultSeverity: "high", riskPoints: 25, qualityPenalty: 0, enabledIn: ALL, needs: ["peers"],
    params: [p("minRows", "Only grids with at least this many rows", lvl(8, 6, 5, 4), "rows")],
  },

  /* ------------------------------------------------------- consistency */
  {
    id: "consistency.impossible_path", category: "consistency", title: "Answer where the question was hidden",
    description: "A question has an answer although its display logic is false for the final answers — the respondent changed an earlier gate answer and the later answer contradicts it (\"do you own a car: No\" with a car brand given).",
    defaultSeverity: "high", riskPoints: 20, qualityPenalty: 25, enabledIn: ALL, params: [],
  },
  {
    id: "consistency.attention_pair", category: "consistency", title: "Repeated-question disagreement",
    description: "Two questions marked as a repeat pair have different answers.",
    defaultSeverity: "high", riskPoints: 20, qualityPenalty: 20, enabledIn: ALL, params: [],
  },
  {
    id: "consistency.frequency_quantity", category: "consistency", title: "Frequency vs quantity contradiction",
    description: "\"Never\" / zero frequency alongside a positive quantity on a linked question (same block, numeric follow-up).",
    defaultSeverity: "medium", riskPoints: 10, qualityPenalty: 15, enabledIn: STD_UP, params: [],
  },
  {
    id: "consistency.piping", category: "consistency", title: "Piped-answer inconsistency",
    description: "A later question pipes an earlier answer that is now empty or changed after the later question was answered.",
    defaultSeverity: "medium", riskPoints: 8, qualityPenalty: 12, enabledIn: STD_UP, needs: ["timing"], params: [],
  },

  /* ------------------------------------------------------------ pattern */
  {
    id: "pattern.low_entropy", category: "pattern", title: "Low response entropy",
    description: "Across all closed questions the same option position is chosen far more than chance.",
    defaultSeverity: "medium", riskPoints: 12, qualityPenalty: 18, enabledIn: ALL,
    params: [
      p("minQuestions", "Only with at least this many closed questions", lvl(10, 8, 6, 5)),
      p("maxEntropy", "Normalised entropy of chosen positions below this", lvl(0.25, 0.35, 0.45, 0.55)),
    ],
  },
  {
    id: "pattern.high_entropy", category: "pattern", title: "Random-response pattern",
    description: "Answers look uniformly random: maximal entropy, no scale consistency, no relation between related items.",
    defaultSeverity: "medium", riskPoints: 15, qualityPenalty: 15, enabledIn: STRICT_UP,
    params: [p("minEntropy", "Normalised entropy above this AND grids inconsistent", lvl(0.99, 0.97, 0.95, 0.92))],
  },
  {
    id: "pattern.nonsubstantive", category: "pattern", title: "Excessive Don't know / Other / Prefer not to say",
    description: "Non-substantive options chosen for a large share of questions that offer them.",
    defaultSeverity: "low", riskPoints: 6, qualityPenalty: 15, enabledIn: ALL,
    params: [p("share", "Share above this", lvl(0.8, 0.6, 0.5, 0.4)), p("minOffered", "Only when offered on at least this many questions", lvl(4, 3, 3, 2))],
  },
  {
    id: "pattern.middle_bias", category: "pattern", title: "Middle-category bias",
    description: "The midpoint of scales chosen far more than the other points, across scale questions.",
    defaultSeverity: "low", riskPoints: 4, qualityPenalty: 10, enabledIn: STRICT_UP,
    params: [p("share", "Midpoint share above this", lvl(0.9, 0.8, 0.7, 0.6))],
  },
  {
    id: "pattern.extreme_bias", category: "pattern", title: "Extreme-category bias",
    description: "Only scale end points chosen, across scale questions.",
    defaultSeverity: "low", riskPoints: 4, qualityPenalty: 8, enabledIn: STRICT_UP,
    params: [p("share", "Extreme share above this", lvl(0.95, 0.9, 0.85, 0.8))],
  },
  {
    id: "pattern.acquiescence", category: "pattern", title: "Acquiescence / disacquiescence bias",
    description: "Agreement (or disagreement) chosen on nearly every agree-type item regardless of wording.",
    defaultSeverity: "low", riskPoints: 6, qualityPenalty: 12, enabledIn: STD_UP,
    params: [p("share", "Same polarity share above this", lvl(0.95, 0.9, 0.85, 0.8)), p("minItems", "Only with at least this many agree-type items", lvl(8, 6, 5, 4))],
  },
  {
    id: "pattern.mechanical", category: "pattern", title: "Mechanical alternation / repeated sequence",
    description: "Chosen option positions across consecutive single-choice questions cycle in a short period.",
    defaultSeverity: "medium", riskPoints: 15, qualityPenalty: 15, enabledIn: STD_UP,
    params: [p("minQuestions", "Only with at least this many consecutive questions", lvl(10, 8, 6, 6))],
  },
  {
    id: "pattern.rare_options", category: "pattern", title: "Rare-option abuse",
    description: "Options almost nobody else chooses, chosen again and again by this respondent.",
    defaultSeverity: "low", riskPoints: 6, qualityPenalty: 8, enabledIn: VSTRICT, needs: ["peers"],
    params: [p("peerShare", "An option chosen by fewer than this share of peers is rare", lvl(0.01, 0.02, 0.03, 0.05)), p("count", "Flag after this many rare choices", lvl(6, 5, 4, 3))],
  },

  /* ---------------------------------------------------------- attention */
  {
    id: "attention.failed", category: "attention", title: "Attention check failed",
    description: "A question marked as an attention / instruction / trap check was not answered as instructed.",
    defaultSeverity: "high", riskPoints: 25, qualityPenalty: 20, enabledIn: ALL, params: [],
  },
  {
    id: "attention.multiple_failed", category: "attention", title: "Several attention checks failed",
    description: "Two or more checks failed — beyond one slip.",
    defaultSeverity: "critical", riskPoints: 30, qualityPenalty: 20, enabledIn: ALL,
    params: [p("count", "Flag at this many failures", lvl(3, 2, 2, 2))],
  },
  {
    id: "attention.knowledge_gap", category: "attention", title: "Claimed expertise vs knowledge test",
    description: "A knowledge check failed by a respondent whose earlier answers claim expertise (the check's pairing).",
    defaultSeverity: "medium", riskPoints: 12, qualityPenalty: 15, enabledIn: STD_UP, params: [],
  },

  /* ----------------------------------------------------------- open end */
  {
    id: "openend.too_short", category: "open_end", title: "Minimum-length violation / one-word answers",
    description: "Open-ended answers of one word or under the minimum length where more was asked for.",
    defaultSeverity: "low", riskPoints: 3, qualityPenalty: 12, enabledIn: ALL,
    params: [p("minChars", "Fewer characters than this", lvl(3, 5, 8, 12), "chars"), p("share", "Flag when this share of open ends are", lvl(0.9, 0.7, 0.5, 0.4))],
  },
  {
    id: "openend.gibberish", category: "open_end", title: "Gibberish / keyboard smashing",
    description: "Text with the letter statistics of a keyboard mash rather than language.",
    defaultSeverity: "high", riskPoints: 20, qualityPenalty: 25, enabledIn: ALL,
    params: [p("score", "Gibberish score above this", lvl(0.7, 0.55, 0.45, 0.35))],
  },
  {
    id: "openend.repeated", category: "open_end", title: "Repeated words / phrases",
    description: "The same word or phrase repeated to fill the box, or the same text given to several questions.",
    defaultSeverity: "medium", riskPoints: 10, qualityPenalty: 15, enabledIn: ALL,
    params: [p("score", "Repetition score above this", lvl(0.7, 0.5, 0.4, 0.3))],
  },
  {
    id: "openend.generic", category: "open_end", title: "Generic / template answers",
    description: "Answers that say nothing (\"good\", \"nothing\", \"n/a\") across most open ends.",
    defaultSeverity: "low", riskPoints: 4, qualityPenalty: 12, enabledIn: STD_UP,
    params: [p("share", "Share of open ends that are generic above this", lvl(0.9, 0.7, 0.5, 0.4))],
  },
  {
    id: "openend.irrelevant", category: "open_end", title: "Irrelevant to the question",
    description: "No overlap at all between the answer's words and the question's words or option labels, on a long enough answer (a weak semantic relevance check).",
    defaultSeverity: "low", riskPoints: 5, qualityPenalty: 10, enabledIn: VSTRICT, params: [],
  },
  {
    id: "openend.contradiction", category: "open_end", title: "Text contradicts closed answers",
    description: "A text answer names an option the respondent explicitly did not select on the closed question it follows (e.g. names a brand marked unaware).",
    defaultSeverity: "medium", riskPoints: 8, qualityPenalty: 12, enabledIn: STRICT_UP, params: [],
  },
  {
    id: "openend.duplicate", category: "open_end", title: "Duplicate / near-duplicate text across respondents",
    description: "The same or nearly the same open-ended text as another respondent (beyond trivial answers).",
    defaultSeverity: "high", riskPoints: 25, qualityPenalty: 10, enabledIn: ALL, needs: ["peers"],
    params: [p("similarity", "Shingle similarity at or above this", lvl(0.95, 0.85, 0.75, 0.65)), p("minWords", "Ignore answers shorter than this", lvl(6, 5, 4, 3), "words")],
  },
  {
    id: "openend.ai_like", category: "open_end", title: "AI-generated text risk",
    description: "Unusually polished, connector-heavy, evenly structured prose — a risk signal only, never proof.",
    defaultSeverity: "medium", riskPoints: 12, qualityPenalty: 5, enabledIn: STD_UP,
    params: [p("score", "Polish score above this", lvl(0.8, 0.6, 0.5, 0.4))],
  },
  {
    id: "openend.pasted", category: "open_end", title: "Pasted with minimal editing",
    description: "Most of an open-ended answer arrived by paste and was barely edited.",
    defaultSeverity: "medium", riskPoints: 12, qualityPenalty: 5, enabledIn: STD_UP, needs: ["clipboard"],
    params: [p("share", "Pasted share of the text above this", lvl(0.95, 0.85, 0.7, 0.6))],
  },

  /* -------------------------------------------------------- interaction */
  {
    id: "interaction.paste_ratio", category: "interaction", title: "Paste-to-answer ratio",
    description: "Text answers filled mostly by pasting, across the survey.",
    defaultSeverity: "low", riskPoints: 8, qualityPenalty: 3, enabledIn: STD_UP, needs: ["clipboard"],
    params: [p("ratio", "Pasted questions / text questions above this", lvl(0.9, 0.7, 0.5, 0.4)), p("minPastes", "Only with at least this many pastes", lvl(3, 2, 2, 1))],
  },
  {
    id: "interaction.rapid_paste_submit", category: "interaction", title: "Rapid paste and submit",
    description: "A page submitted within moments of a paste into it.",
    defaultSeverity: "low", riskPoints: 6, qualityPenalty: 2, enabledIn: STRICT_UP, needs: ["clipboard", "timing"],
    params: [p("withinMs", "Submitted within this many ms of a paste", lvl(500, 1000, 1500, 2000), "ms")],
  },
  {
    id: "interaction.out_of_focus", category: "interaction", title: "Long time out of focus",
    description: "The survey tab was hidden for a large share of the session.",
    defaultSeverity: "low", riskPoints: 4, qualityPenalty: 6, enabledIn: STRICT_UP, needs: ["focus"],
    params: [p("share", "Out-of-focus share of total time above this", lvl(0.8, 0.6, 0.5, 0.4))],
  },

  /* --------------------------------------------------------- navigation */
  {
    id: "navigation.cycling", category: "navigation", title: "Rapid back/forward cycling",
    description: "Many back-and-forth moves in quick succession — probing logic or hunting a qualifying path.",
    defaultSeverity: "medium", riskPoints: 10, qualityPenalty: 4, enabledIn: STD_UP, needs: ["navigation"],
    params: [p("backs", "More back moves than this", lvl(8, 5, 4, 3)), p("withinSec", "…each within this many seconds of the previous move", lvl(3, 5, 8, 10), "s")],
  },
  {
    id: "navigation.reloads", category: "navigation", title: "Page reloads / session restarts",
    description: "The page was reloaded repeatedly during the session.",
    defaultSeverity: "low", riskPoints: 6, qualityPenalty: 2, enabledIn: STD_UP, needs: ["navigation"],
    params: [p("count", "More reloads than this", lvl(5, 3, 2, 1))],
  },
  {
    id: "navigation.fingerprint_match", category: "navigation", title: "Identical navigation fingerprint",
    description: "Exactly the same page sequence — including back moves — as another respondent, on a survey with branching.",
    defaultSeverity: "medium", riskPoints: 15, qualityPenalty: 0, enabledIn: STD_UP, needs: ["navigation", "peers"],
    params: [p("minBacks", "Only fingerprints with at least this many back moves count (a straight run is normal)", lvl(2, 1, 1, 1))],
  },
  {
    id: "navigation.screener_edits", category: "navigation", title: "Screener answers changed",
    description: "Answers to screening questions were changed after first being given.",
    defaultSeverity: "medium", riskPoints: 15, qualityPenalty: 5, enabledIn: ALL, needs: ["timing"], params: [],
  },

  /* ------------------------------------------------------------ device */
  {
    id: "device.duplicate", category: "device", title: "Same device signature across responses",
    description: "Other complete responses share this device signature (browser family, platform, screen, timezone, language).",
    defaultSeverity: "medium", riskPoints: 15, qualityPenalty: 0, enabledIn: ALL, needs: ["device", "peers"],
    params: [p("count", "Flag from this many other responses on the same signature", lvl(5, 3, 2, 1))],
  },
  {
    id: "device.webdriver", category: "device", title: "Automation flag in the browser",
    description: "The browser reports it is driven by automation (navigator.webdriver).",
    defaultSeverity: "critical", riskPoints: 60, qualityPenalty: 0, enabledIn: ALL, needs: ["device"], params: [],
  },
  {
    id: "device.locale_timezone", category: "device", title: "Timezone vs language mismatch",
    description: "Browser timezone and language point to different regions than the survey expects.",
    defaultSeverity: "low", riskPoints: 5, qualityPenalty: 0, enabledIn: STRICT_UP, needs: ["device"],
    params: [p("expectedTimezonePrefix", "Expected timezone region (e.g. 'America/', 'Europe/'); empty = any", { relaxed: "", standard: "", strict: "", very_strict: "" })],
  },

  /* ----------------------------------------------------------- network */
  {
    id: "network.duplicate_ip", category: "network", title: "Duplicate IP",
    description: "Other complete responses came from the same (hashed) IP address. Households and offices share addresses — a signal, not a verdict.",
    defaultSeverity: "low", riskPoints: 8, qualityPenalty: 0, enabledIn: ALL, needs: ["network", "peers"],
    params: [p("count", "Flag from this many other responses on the same IP", lvl(6, 3, 2, 1))],
  },
  {
    id: "network.ip_density", category: "network", title: "High respondent density from one IP",
    description: "A single IP accounts for an unusual share of the survey's completes.",
    defaultSeverity: "medium", riskPoints: 15, qualityPenalty: 0, enabledIn: STD_UP, needs: ["network", "peers"],
    params: [p("share", "Share of all completes above this", lvl(0.15, 0.08, 0.05, 0.03)), p("minCount", "…and at least this many responses", lvl(8, 5, 4, 3))],
  },
  {
    id: "network.risk_provider", category: "network", title: "VPN / proxy / datacenter risk",
    description: "Reported by the configured network-intelligence provider (SYSTEM_NETWORK_RISK). Not evaluated when none is configured.",
    defaultSeverity: "medium", riskPoints: 15, qualityPenalty: 0, enabledIn: ALL, needs: ["network"],
    params: [p("minRisk", "Provider risk at or above this", lvl(90, 75, 60, 50))],
  },

  /* --------------------------------------------------------------- bot */
  {
    id: "bot.machine_timing", category: "bot", title: "Machine-like timing",
    description: "Sub-second pages, near-zero variance and instant reactions together.",
    defaultSeverity: "critical", riskPoints: 40, qualityPenalty: 10, enabledIn: ALL, needs: ["timing"],
    params: [p("maxPageMs", "Median page time below this", lvl(600, 1000, 1500, 2000), "ms")],
  },
  {
    id: "bot.no_interaction", category: "bot", title: "No human interaction recorded",
    description: "Pages answered without pointer, key or scroll events.",
    defaultSeverity: "high", riskPoints: 30, qualityPenalty: 0, enabledIn: ALL, needs: ["interaction"],
    params: [p("share", "Share of answered pages with zero interaction events above this", lvl(0.9, 0.7, 0.5, 0.4))],
  },
  {
    id: "bot.impossible_sequence", category: "bot", title: "Impossible action sequence",
    description: "Answers recorded on a page before it was shown, or more changes than the time allowed.",
    defaultSeverity: "critical", riskPoints: 40, qualityPenalty: 0, enabledIn: ALL, needs: ["timing"], params: [],
  },

  /* ------------------------------------------------------- duplicates */
  {
    id: "duplicate.answers", category: "duplicate", title: "Near-identical answers to another respondent",
    description: "Closed-question answers agree with another respondent far beyond what the survey's answer distribution predicts.",
    defaultSeverity: "high", riskPoints: 30, qualityPenalty: 0, enabledIn: ALL, needs: ["peers"],
    params: [
      p("similarity", "Agreement share at or above this", lvl(0.98, 0.93, 0.88, 0.82)),
      p("minQuestions", "Only with at least this many comparable questions", lvl(15, 10, 8, 6)),
    ],
  },
  {
    id: "duplicate.multi_signal", category: "duplicate", title: "Multi-signal duplicate",
    description: "Similar answers AND a shared device or network signature or identical timing/navigation — the same person, or the same script.",
    defaultSeverity: "critical", riskPoints: 45, qualityPenalty: 0, enabledIn: ALL, needs: ["peers"],
    params: [p("similarity", "Answer agreement at or above this (with another shared signal)", lvl(0.9, 0.8, 0.7, 0.6))],
  },

  /* ----------------------------------------------------------- cluster */
  {
    id: "cluster.coordinated", category: "cluster", title: "Potential coordinated response cluster",
    description: "This response belongs to a group of respondents linked by similar answers, timing, navigation, device or network signals.",
    defaultSeverity: "high", riskPoints: 30, qualityPenalty: 0, enabledIn: ALL, needs: ["peers"],
    params: [p("minSize", "Clusters of at least this many responses", lvl(6, 4, 3, 3)), p("linkSimilarity", "Two responses are linked at answer similarity ≥ this plus one shared signal, or ≥ this + 0.1 alone", lvl(0.9, 0.8, 0.72, 0.65))],
  },
  {
    id: "cluster.burst", category: "cluster", title: "Burst submissions",
    description: "Many completes within a short window sharing a signal with this one.",
    defaultSeverity: "medium", riskPoints: 15, qualityPenalty: 0, enabledIn: STD_UP, needs: ["peers"],
    params: [p("windowSec", "Window", lvl(120, 300, 600, 900), "s"), p("count", "At least this many linked completes in the window", lvl(8, 5, 4, 3))],
  },

  /* ---------------------------------------------------------- screener */
  {
    id: "screener.repeat_attempts", category: "screener", title: "Repeated attempts to qualify",
    description: "Earlier sessions from the same device or IP signature were screened out before this one qualified.",
    defaultSeverity: "high", riskPoints: 30, qualityPenalty: 0, enabledIn: ALL, needs: ["peers"],
    params: [p("count", "Flag from this many earlier screened-out sessions", lvl(3, 2, 1, 1))],
  },
  {
    id: "screener.inconsistent", category: "screener", title: "Inconsistent screener responses across sessions",
    description: "Screening answers differ between this session and a sibling session on the same device signature.",
    defaultSeverity: "high", riskPoints: 25, qualityPenalty: 0, enabledIn: ALL, needs: ["peers"], params: [],
  },
  {
    id: "screener.fast", category: "screener", title: "Extremely fast screener",
    description: "The screening section was completed far below its benchmark.",
    defaultSeverity: "medium", riskPoints: 10, qualityPenalty: 5, enabledIn: STD_UP, needs: ["timing"],
    params: [p("ratio", "Below this share of benchmark", lvl(0.2, 0.3, 0.4, 0.5))],
  },

  /* ------------------------------------------------------ longitudinal */
  {
    id: "history.poor_record", category: "custom", title: "Poor quality history",
    description: "This external respondent was classified SUSPICIOUS or worse in earlier studies (longitudinal linking enabled).",
    defaultSeverity: "medium", riskPoints: 12, qualityPenalty: 0, enabledIn: ALL, needs: ["peers"],
    params: [p("count", "From this many prior suspicious studies", lvl(3, 2, 2, 1))],
  },
];

export const RULE_BY_ID: Record<string, RuleDef> = Object.fromEntries(RULES.map((r) => [r.id, r]));

export const CATEGORY_LABELS: Record<string, string> = {
  timing: "Timing", matrix: "Matrix / grid", consistency: "Consistency", pattern: "Response pattern",
  attention: "Attention", open_end: "Open ends", interaction: "Copy / paste & focus", navigation: "Navigation",
  device: "Device", network: "Network", bot: "Bot / automation", duplicate: "Duplicates", cluster: "Coordinated clusters",
  screener: "Screener gaming", custom: "Custom & history",
};

export const SEVERITY_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
