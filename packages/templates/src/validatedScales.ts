/**
 * THE VALIDATED SCALE LIBRARY (audit 2026-11-17, P2-10).
 *
 * Published measures with their exact items, response options, recall period, scoring and the citation they come
 * from, so a survey that says "we measured stress with the PSS-10" measures it the way the paper does — and scores
 * it the same way. `scaleBlock` turns a scale into a page: one grid question whose rows are the items, every item
 * required (each scale is scored only when complete), and a calculation per score whose expression is the
 * published scoring. `scoreScale` is the same scoring as a plain function; the test holds the two equal.
 *
 * WHAT THIS IS NOT. It is not a licence. Each scale says what its authors say about use, and the ones free only for
 * non-commercial research say so. Clinical screeners (GAD-7, WHO-5) are screening measures, not diagnoses; a study
 * using them needs a plan for a respondent who scores high. Item wording is the published English wording; a
 * translation of a validated scale is its own validation question.
 *
 * Citations were written from the published sources as known to the authors of this file; verify them against the
 * originals before quoting them in a client document (they are not machine-checked).
 */

export interface ScaleCitation { authors: string; year: number; title: string; source: string; doi?: string }
export interface ScaleItem { code: string; text: string; reverse?: boolean; subscale?: string }
export interface ScaleScore {
  id: string; label: string;
  /** which items, and how: "sum" / "mean" of the (reverse-keyed) item values, then × multiplier + offset */
  items: string[];
  method: "sum" | "mean";
  /** applied after the sum: (sum + shift) × multiplier — SUS: per-item shift, so it is kept in `itemShift` */
  multiplier?: number;
  shift?: number;
  /** subtracted from each item value before summing (SUS: 1, so a 1–5 item counts 0–4) */
  itemShift?: number;
  range: [number, number];
  bands?: { upTo: number; label: string }[];
  /** where the bands come from */
  bandsSource?: string;
}
export interface ValidatedScale {
  id: string; name: string; short: string; construct: string;
  citation: ScaleCitation;
  /** more sources: the validation of a short form, a review */
  alsoCite?: ScaleCitation[];
  licence: string;
  /** shown above the items */
  instructions: string;
  /** the prompt each item completes, when there is one ("I see myself as:") */
  stem?: string;
  items: ScaleItem[];
  options: { code: number; label: string }[];
  scores: ScaleScore[];
  /** what a researcher must know before using it */
  caution?: string;
}

const AGREE5 = [{ code: 1, label: "Strongly disagree" }, { code: 2, label: "Disagree" }, { code: 3, label: "Neither agree nor disagree" }, { code: 4, label: "Agree" }, { code: 5, label: "Strongly agree" }];
const AGREE7 = [{ code: 1, label: "Strongly disagree" }, { code: 2, label: "Disagree" }, { code: 3, label: "Slightly disagree" }, { code: 4, label: "Neither agree nor disagree" }, { code: 5, label: "Slightly agree" }, { code: 6, label: "Agree" }, { code: 7, label: "Strongly agree" }];
const n = (k: number) => Array.from({ length: k }, (_, i) => String(i + 1));

export const VALIDATED_SCALES: readonly ValidatedScale[] = [
  {
    id: "sus", name: "System Usability Scale", short: "SUS", construct: "Perceived usability of a product or system",
    citation: { authors: "Brooke, J.", year: 1996, title: "SUS: A “quick and dirty” usability scale", source: "In P. W. Jordan, B. Thomas, B. A. Weerdmeester & I. L. McClelland (Eds.), Usability Evaluation in Industry (pp. 189–194). London: Taylor & Francis" },
    licence: "Free to use; the author asks that the source be acknowledged.",
    instructions: "Please tell us how much you agree or disagree with each statement about the system.",
    items: [
      { code: "1", text: "I think that I would like to use this system frequently." },
      { code: "2", text: "I found the system unnecessarily complex.", reverse: true },
      { code: "3", text: "I thought the system was easy to use." },
      { code: "4", text: "I think that I would need the support of a technical person to be able to use this system.", reverse: true },
      { code: "5", text: "I found the various functions in this system were well integrated." },
      { code: "6", text: "I thought there was too much inconsistency in this system.", reverse: true },
      { code: "7", text: "I would imagine that most people would learn to use this system very quickly." },
      { code: "8", text: "I found the system very cumbersome to use.", reverse: true },
      { code: "9", text: "I felt very confident using the system." },
      { code: "10", text: "I needed to learn a lot of things before I could get going with this system.", reverse: true },
    ],
    options: AGREE5,
    scores: [{ id: "SCORE", label: "SUS score (0–100)", items: n(10), method: "sum", itemShift: 1, multiplier: 2.5, range: [0, 100] }],
    caution: "The SUS score is not a percentage; 68 is often quoted as the average across published studies.",
  },
  {
    id: "umux_lite", name: "UMUX-LITE", short: "UMUX-LITE", construct: "Perceived usability (two items)",
    citation: { authors: "Lewis, J. R., Utesch, B. S., & Maher, D. E.", year: 2013, title: "UMUX-LITE: When there's no time for the SUS", source: "Proceedings of the SIGCHI Conference on Human Factors in Computing Systems (CHI '13), 2099–2102", doi: "10.1145/2470654.2481287" },
    licence: "Published for use; cite the paper.",
    instructions: "Please tell us how much you agree or disagree with each statement about the system.",
    items: [
      { code: "1", text: "This system's capabilities meet my requirements." },
      { code: "2", text: "This system is easy to use." },
    ],
    options: AGREE7,
    scores: [{ id: "SCORE", label: "UMUX-LITE (0–100)", items: n(2), method: "sum", shift: -2, multiplier: 100 / 12, range: [0, 100] }],
  },
  {
    id: "swls", name: "Satisfaction With Life Scale", short: "SWLS", construct: "Global life satisfaction",
    citation: { authors: "Diener, E., Emmons, R. A., Larsen, R. J., & Griffin, S.", year: 1985, title: "The Satisfaction With Life Scale", source: "Journal of Personality Assessment, 49(1), 71–75", doi: "10.1207/s15327752jpa4901_13" },
    licence: "Free to use without permission; credit the authors.",
    instructions: "Below are five statements that you may agree or disagree with. Please indicate your agreement with each.",
    items: [
      { code: "1", text: "In most ways my life is close to my ideal." },
      { code: "2", text: "The conditions of my life are excellent." },
      { code: "3", text: "I am satisfied with my life." },
      { code: "4", text: "So far I have gotten the important things I want in life." },
      { code: "5", text: "If I could live my life over, I would change almost nothing." },
    ],
    options: AGREE7,
    scores: [{ id: "SCORE", label: "SWLS total (5–35)", items: n(5), method: "sum", range: [5, 35], bands: [{ upTo: 9, label: "Extremely dissatisfied" }, { upTo: 14, label: "Dissatisfied" }, { upTo: 19, label: "Slightly dissatisfied" }, { upTo: 20, label: "Neutral" }, { upTo: 25, label: "Slightly satisfied" }, { upTo: 30, label: "Satisfied" }, { upTo: 35, label: "Extremely satisfied" }], bandsSource: "Diener's published interpretation guide for the SWLS" }],
  },
  {
    id: "rses", name: "Rosenberg Self-Esteem Scale", short: "RSES", construct: "Global self-esteem",
    citation: { authors: "Rosenberg, M.", year: 1965, title: "Society and the Adolescent Self-Image", source: "Princeton, NJ: Princeton University Press" },
    licence: "Free for research and education; check terms before commercial use.",
    instructions: "Below is a list of statements dealing with your general feelings about yourself. Please indicate how strongly you agree or disagree with each.",
    items: [
      { code: "1", text: "On the whole, I am satisfied with myself." },
      { code: "2", text: "At times I think I am no good at all.", reverse: true },
      { code: "3", text: "I feel that I have a number of good qualities." },
      { code: "4", text: "I am able to do things as well as most other people." },
      { code: "5", text: "I feel I do not have much to be proud of.", reverse: true },
      { code: "6", text: "I certainly feel useless at times.", reverse: true },
      { code: "7", text: "I feel that I'm a person of worth, at least on an equal plane with others." },
      { code: "8", text: "I wish I could have more respect for myself.", reverse: true },
      { code: "9", text: "All in all, I am inclined to feel that I am a failure.", reverse: true },
      { code: "10", text: "I take a positive attitude toward myself." },
    ],
    options: [{ code: 1, label: "Strongly disagree" }, { code: 2, label: "Disagree" }, { code: 3, label: "Agree" }, { code: 4, label: "Strongly agree" }],
    scores: [{ id: "SCORE", label: "Self-esteem (0–30)", items: n(10), method: "sum", itemShift: 1, range: [0, 30] }],
  },
  {
    id: "pss10", name: "Perceived Stress Scale (10-item)", short: "PSS-10", construct: "Perceived stress in the last month",
    citation: { authors: "Cohen, S., & Williamson, G.", year: 1988, title: "Perceived stress in a probability sample of the United States", source: "In S. Spacapan & S. Oskamp (Eds.), The Social Psychology of Health (pp. 31–67). Newbury Park, CA: Sage" },
    alsoCite: [{ authors: "Cohen, S., Kamarck, T., & Mermelstein, R.", year: 1983, title: "A global measure of perceived stress", source: "Journal of Health and Social Behavior, 24(4), 385–396", doi: "10.2307/2136404" }],
    licence: "Free for non-profit academic research; check terms before commercial use.",
    instructions: "The questions in this scale ask you about your feelings and thoughts during the last month. In each case, please indicate how often you felt or thought a certain way.",
    stem: "In the last month, how often have you…",
    items: [
      { code: "1", text: "been upset because of something that happened unexpectedly?" },
      { code: "2", text: "felt that you were unable to control the important things in your life?" },
      { code: "3", text: "felt nervous and “stressed”?" },
      { code: "4", text: "felt confident about your ability to handle your personal problems?", reverse: true },
      { code: "5", text: "felt that things were going your way?", reverse: true },
      { code: "6", text: "found that you could not cope with all the things that you had to do?" },
      { code: "7", text: "been able to control irritations in your life?", reverse: true },
      { code: "8", text: "felt that you were on top of things?", reverse: true },
      { code: "9", text: "been angered because of things that happened that were outside of your control?" },
      { code: "10", text: "felt difficulties were piling up so high that you could not overcome them?" },
    ],
    options: [{ code: 0, label: "Never" }, { code: 1, label: "Almost never" }, { code: 2, label: "Sometimes" }, { code: 3, label: "Fairly often" }, { code: 4, label: "Very often" }],
    scores: [{ id: "SCORE", label: "PSS-10 total (0–40)", items: n(10), method: "sum", range: [0, 40] }],
    caution: "PSS scores are compared with norms for the population studied; the scale has no diagnostic cut-off.",
  },
  {
    id: "gad7", name: "Generalized Anxiety Disorder 7-item scale", short: "GAD-7", construct: "Anxiety symptoms over the last two weeks",
    citation: { authors: "Spitzer, R. L., Kroenke, K., Williams, J. B. W., & Löwe, B.", year: 2006, title: "A brief measure for assessing generalized anxiety disorder: the GAD-7", source: "Archives of Internal Medicine, 166(10), 1092–1097", doi: "10.1001/archinte.166.10.1092" },
    licence: "No permission required to reproduce, translate, display or distribute.",
    instructions: "Over the last 2 weeks, how often have you been bothered by the following problems?",
    items: [
      { code: "1", text: "Feeling nervous, anxious, or on edge" },
      { code: "2", text: "Not being able to stop or control worrying" },
      { code: "3", text: "Worrying too much about different things" },
      { code: "4", text: "Trouble relaxing" },
      { code: "5", text: "Being so restless that it is hard to sit still" },
      { code: "6", text: "Becoming easily annoyed or irritable" },
      { code: "7", text: "Feeling afraid, as if something awful might happen" },
    ],
    options: [{ code: 0, label: "Not at all" }, { code: 1, label: "Several days" }, { code: 2, label: "More than half the days" }, { code: 3, label: "Nearly every day" }],
    scores: [{ id: "SCORE", label: "GAD-7 total (0–21)", items: n(7), method: "sum", range: [0, 21], bands: [{ upTo: 4, label: "Minimal" }, { upTo: 9, label: "Mild" }, { upTo: 14, label: "Moderate" }, { upTo: 21, label: "Severe" }], bandsSource: "Spitzer et al. (2006): cut-points 5, 10 and 15" }],
    caution: "A screening measure, not a diagnosis. Plan what the study does when a respondent scores in the moderate or severe range (signposting to support), and get ethics approval where it applies.",
  },
  {
    id: "who5", name: "WHO-5 Well-Being Index", short: "WHO-5", construct: "Subjective well-being over the last two weeks",
    citation: { authors: "World Health Organization Regional Office for Europe", year: 1998, title: "Wellbeing measures in primary health care: the DepCare project", source: "Copenhagen: WHO Regional Office for Europe" },
    alsoCite: [{ authors: "Topp, C. W., Østergaard, S. D., Søndergaard, S., & Bech, P.", year: 2015, title: "The WHO-5 Well-Being Index: a systematic review of the literature", source: "Psychotherapy and Psychosomatics, 84(3), 167–176", doi: "10.1159/000376585" }],
    licence: "Free to use; no permission required.",
    instructions: "Please indicate for each of the five statements which is closest to how you have been feeling over the last two weeks.",
    stem: "Over the last two weeks…",
    items: [
      { code: "1", text: "I have felt cheerful and in good spirits" },
      { code: "2", text: "I have felt calm and relaxed" },
      { code: "3", text: "I have felt active and vigorous" },
      { code: "4", text: "I woke up feeling fresh and rested" },
      { code: "5", text: "My daily life has been filled with things that interest me" },
    ],
    options: [{ code: 5, label: "All of the time" }, { code: 4, label: "Most of the time" }, { code: 3, label: "More than half of the time" }, { code: 2, label: "Less than half of the time" }, { code: 1, label: "Some of the time" }, { code: 0, label: "At no time" }],
    scores: [{ id: "SCORE", label: "WHO-5 (0–100)", items: n(5), method: "sum", multiplier: 4, range: [0, 100], bands: [{ upTo: 50, label: "Poor well-being (screening threshold)" }, { upTo: 100, label: "Above the screening threshold" }], bandsSource: "Topp et al. (2015): a score of 50 or below is the usual screening cut-off" }],
    caution: "A screening measure, not a diagnosis. Plan what the study does for a respondent at or below 50.",
  },
  {
    id: "tipi", name: "Ten-Item Personality Inventory", short: "TIPI", construct: "The Big Five personality domains (very brief)",
    citation: { authors: "Gosling, S. D., Rentfrow, P. J., & Swann, W. B., Jr.", year: 2003, title: "A very brief measure of the Big-Five personality domains", source: "Journal of Research in Personality, 37(6), 504–528", doi: "10.1016/S0092-6566(03)00046-1" },
    licence: "Free for non-commercial research; cite the paper.",
    instructions: "Here are a number of personality traits that may or may not apply to you. Please indicate the extent to which you agree or disagree with each statement. Rate the extent to which the pair of traits applies to you, even if one characteristic applies more strongly than the other.",
    stem: "I see myself as:",
    items: [
      { code: "1", text: "Extraverted, enthusiastic.", subscale: "E" },
      { code: "2", text: "Critical, quarrelsome.", reverse: true, subscale: "A" },
      { code: "3", text: "Dependable, self-disciplined.", subscale: "C" },
      { code: "4", text: "Anxious, easily upset.", reverse: true, subscale: "ES" },
      { code: "5", text: "Open to new experiences, complex.", subscale: "O" },
      { code: "6", text: "Reserved, quiet.", reverse: true, subscale: "E" },
      { code: "7", text: "Sympathetic, warm.", subscale: "A" },
      { code: "8", text: "Disorganized, careless.", reverse: true, subscale: "C" },
      { code: "9", text: "Calm, emotionally stable.", subscale: "ES" },
      { code: "10", text: "Conventional, uncreative.", reverse: true, subscale: "O" },
    ],
    options: [{ code: 1, label: "Disagree strongly" }, { code: 2, label: "Disagree moderately" }, { code: 3, label: "Disagree a little" }, { code: 4, label: "Neither agree nor disagree" }, { code: 5, label: "Agree a little" }, { code: 6, label: "Agree moderately" }, { code: 7, label: "Agree strongly" }],
    scores: [
      { id: "E", label: "Extraversion (1–7)", items: ["1", "6"], method: "mean", range: [1, 7] },
      { id: "A", label: "Agreeableness (1–7)", items: ["2", "7"], method: "mean", range: [1, 7] },
      { id: "C", label: "Conscientiousness (1–7)", items: ["3", "8"], method: "mean", range: [1, 7] },
      { id: "ES", label: "Emotional stability (1–7)", items: ["4", "9"], method: "mean", range: [1, 7] },
      { id: "O", label: "Openness to experiences (1–7)", items: ["5", "10"], method: "mean", range: [1, 7] },
    ],
    caution: "Two items per domain: fine for a covariate, too short for a precise individual measure.",
  },
];

export const scaleById = (id: string) => VALIDATED_SCALES.find((s) => s.id === id) ?? null;

const optionRange = (s: ValidatedScale): [number, number] => { const c = s.options.map((o) => o.code); return [Math.min(...c), Math.max(...c)]; };

/** one score of a scale from the item answers (by item code); null when an item it needs is missing */
export function scoreScale(scale: ValidatedScale, answers: Record<string, number | null | undefined>, scoreId = scale.scores[0].id): number | null {
  const sc = scale.scores.find((x) => x.id === scoreId);
  if (!sc) return null;
  const [lo, hi] = optionRange(scale);
  let total = 0;
  for (const code of sc.items) {
    const v = answers[code];
    if (v == null || !Number.isFinite(v)) return null;
    const item = scale.items.find((i) => i.code === code)!;
    const keyed = item.reverse ? lo + hi - v : v;
    total += keyed - (sc.itemShift ?? 0);
  }
  const base = sc.method === "mean" ? total / sc.items.length : total;
  return Math.round(((base + (sc.shift ?? 0)) * (sc.multiplier ?? 1)) * 1e6) / 1e6;
}

/** the band a score falls in, when the scale publishes bands */
export const bandOf = (scale: ValidatedScale, score: number | null, scoreId = scale.scores[0].id): string | null => {
  const sc = scale.scores.find((x) => x.id === scoreId);
  if (score == null || !sc?.bands) return null;
  return sc.bands.find((b) => score <= b.upTo)?.label ?? null;
};

/** the calc-engine expression for a score, from the grid's variable stem ("PSS" → PSS_1 … PSS_10) */
export function scoreExpression(scale: ValidatedScale, stem: string, scoreId = scale.scores[0].id): string {
  const sc = scale.scores.find((x) => x.id === scoreId)!;
  const [lo, hi] = optionRange(scale);
  const terms = sc.items.map((code) => {
    const item = scale.items.find((i) => i.code === code)!;
    const v = `${stem}_${code}`;
    const keyed = item.reverse ? `(${lo + hi} - ${v})` : v;
    return sc.itemShift ? `(${keyed} - ${sc.itemShift})` : keyed;
  });
  let e = `(${terms.join(" + ")})`;
  if (sc.method === "mean") e = `(${e} / ${sc.items.length})`;
  if (sc.shift) e = `(${e} ${sc.shift < 0 ? "-" : "+"} ${Math.abs(sc.shift)})`;
  if (sc.multiplier && sc.multiplier !== 1) e = `${e} * ${Number.isInteger(sc.multiplier) ? sc.multiplier : `${sc.multiplier * 12} / 12`}`;
  return e;
}

/** "Cohen, S., & Williamson, G. (1988). Perceived stress … Sage." */
export const citationText = (c: ScaleCitation) => `${c.authors} (${c.year}). ${c.title}. ${c.source}.${c.doi ? ` https://doi.org/${c.doi}` : ""}`;

/**
 * The scale as survey content: a grid question (rows = items, every one required), a page holding it, and one
 * calculation per score with the published scoring. Codes are `${prefix}` (the grid) and `${prefix}_${score}` (each
 * score), so two copies of a scale in one survey can coexist.
 */
export function scaleBlock(scale: ValidatedScale, opts: { prefix?: string; idPrefix?: string } = {}) {
  const stem = (opts.prefix ?? scale.short.replace(/[^A-Za-z0-9]+/g, "")).toUpperCase();
  const id = opts.idPrefix ?? `q_${scale.id}`;
  const question = {
    id, code: stem, variableName: stem, type: "matrix_single" as const,
    text: scale.stem ? `${scale.instructions}\n\n${scale.stem}` : scale.instructions,
    required: true,
    rows: scale.items.map((i) => ({ code: i.code, label: i.text })),
    options: scale.options.map((o) => ({ code: o.code, label: o.label })),
    notes: `${scale.name} (${scale.short}). ${citationText(scale.citation)} Licence: ${scale.licence}${scale.caution ? ` Note: ${scale.caution}` : ""}`,
  };
  const calculations = scale.scores.map((sc) => ({
    id: `c_${scale.id}_${sc.id.toLowerCase()}`, targetVariable: `${stem}_${sc.id}`, label: sc.label,
    expression: scoreExpression(scale, stem, sc.id), dataType: "numeric" as const,
    notes: `Published scoring (${scale.short}): ${sc.method} of ${sc.items.length} items${scale.items.some((i) => i.reverse && sc.items.includes(i.code)) ? `, items ${scale.items.filter((i) => i.reverse && sc.items.includes(i.code)).map((i) => i.code).join(", ")} reverse-keyed` : ""}; range ${sc.range[0]}–${sc.range[1]}.`,
  }));
  return { question, page: { type: "page" as const, id: `p_${scale.id}`, questionIds: [id] }, calculations };
}
