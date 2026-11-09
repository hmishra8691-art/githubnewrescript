import { designAdvice, parseAttributes } from "@rescript/engine";
import type { ConjointAttribute } from "./conjoint.js";
import { mainEffectsParameters, recommendedRuns, type ExperimentType } from "./experiment.js";

/**
 * A DESIGN REQUEST IN PLAIN WORDS → A RECOMMENDED, GENERATABLE CONFIGURATION (2026-11-09).
 *
 * "A choice-based conjoint with six attributes and three to four levels each, efficient and balanced, 12 tasks and
 * three alternatives per task" is read into what was said (method, counts, named attributes and levels, items,
 * tasks, alternatives, design method, None, sample, time budget, constraints), then completed by the platform's own
 * rules (designAdvice: Orme's sample rule, three appearances per MaxDiff item, ACBC above six attributes, CVA for
 * specialist samples) into the exact configuration the generator takes — with every choice explained, what was
 * assumed said as an assumption, and what only the researcher can supply asked as a question.
 *
 * Deterministic: the same words give the same recommendation, with or without a model. Nothing is generated here;
 * the generators (conjoint, acbc, menu, cva, maxdiff, experiment) build the design from the configuration.
 */
export type DesignKind = "conjoint" | "acbc" | "menu" | "cva" | "maxdiff" | "experiment";
export const DESIGN_KIND_NAMES: Record<DesignKind, string> = {
  conjoint: "Choice-based conjoint (CBC)", acbc: "Adaptive CBC (ACBC)", menu: "Menu-based conjoint (MBC)", cva: "Rating-based conjoint (CVA)", maxdiff: "MaxDiff (best–worst scaling)", experiment: "Custom experimental design",
};

export interface DesignRequest {
  kind: DesignKind | null;
  kindNamed: boolean;
  attributes: ConjointAttribute[];
  attributeCount?: number;
  levels?: [number, number];
  items: string[];
  itemCount?: number;
  perTask?: number;
  tasks?: number;
  alternatives?: number;
  versions?: number;
  method?: "efficient" | "balanced";
  none?: boolean;
  dualNone?: boolean;
  holdouts?: number;
  sample?: number;
  minutes?: number;
  specialist?: boolean;
  designType?: ExperimentType;
  treatments: string[];
  runs?: number;
  prohibitions: { a: { attribute: string; level: string }; b: { attribute: string; level: string } }[];
  /** partial-profile CBC: asked for, and how many attributes per task */
  partial?: boolean;
  attributesPerTask?: number;
  /** what was read, in words — shown to the researcher */
  understood: string[];
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, eighteen: 18, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100 };
const NUM = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|eighteen|twenty|thirty|forty|fifty)";
const num = (s?: string) => (s == null ? undefined : /^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()]);
const re = (src: string) => new RegExp(src.replace(/N/g, NUM), "i");

export function readDesignRequest(text: string): DesignRequest {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  const lines = String(text ?? "").split("\n");
  const understood: string[] = [];
  /* the method */
  let kind: DesignKind | null = null, kindNamed = true;
  if (/\bacbc\b|\badaptive (?:choice[- ]based )?conjoint|\badaptive cbc\b/i.test(t)) kind = "acbc";
  else if (/\bmenu[- ]based|\bmbc\b|\bbuild[- ]your[- ]own|\bà la carte|\ba la carte|\badd-?ons? with prices/i.test(t)) kind = "menu";
  else if (/\brating[- ]based conjoint|\bcva\b|\btraditional conjoint|\bratings?[- ]based\b|\bfull[- ]profile rating/i.test(t)) kind = "cva";
  else if (/\bmax ?diff|\bbest[- ]worst|\bmaximum difference/i.test(t)) kind = "maxdiff";
  else if (/\bcbc\b|\bchoice[- ]based|\bconjoint|\bdiscrete choice|\bchoice (?:tasks|sets|experiment)/i.test(t)) kind = "conjoint";
  else if (/\bfactorial|\bfractional|\blatin square|\bwilliams|\bincomplete block|\bbibd\b|\bexperimental design|\bcustom (?:experimental )?design|\bd-?optimal (?:design|fraction)|\bcarry-?over|\border (?:effects?|bias|rotation)|\bin sequence\b/i.test(t)) kind = "experiment";
  else kindNamed = false;
  if (kind) understood.push(`Method: ${DESIGN_KIND_NAMES[kind]}`);

  /* named attributes: "Brand: A, B, C" lines, or "brand (A, B, C)" inline */
  let attributes = parseAttributes(lines.filter((l) => /:[^,;|]+[,;|]/.test(l)).join("\n")).filter((a) => a.levels.length >= 2 && a.name.length <= 40 && a.name.trim().split(/\s+/).length <= 5 && a.levels.every((l) => l.length <= 40) && !/^(?:attributes?|levels?|items?|treatments?|factors?)$/i.test(a.name));
  if (!attributes.length) for (const m of t.matchAll(/\b([A-Za-z][\w /-]{1,30}?)\s*\(([^()]{3,200})\)/g)) { const lv = m[2].split(/[,;|/]| or /).map((x) => x.trim()).filter(Boolean); if (lv.length >= 2 && !/^(?:e\.?g|i\.?e)/i.test(m[1])) attributes.push({ name: m[1].trim().replace(/^(?:and|with)\s+/i, ""), levels: lv }); }
  attributes = attributes.filter((a, i, all) => all.findIndex((b) => b.name.toLowerCase() === a.name.toLowerCase()) === i);
  if (attributes.length) understood.push(`Attributes: ${attributes.map((a) => `${a.name} (${a.levels.length})`).join(", ")}`);
  const attributeCount = num(re("\\bN (?:different |main )?(?:attributes|features|factors|dimensions)\\b").exec(t)?.[1]);
  const lv = re("\\bN(?:\\s*(?:to|-|–|or|and)\\s*N)? levels?\\b").exec(t);
  const levels: [number, number] | undefined = lv ? [num(lv[1])!, num(lv[2] ?? lv[1])!].sort((a, b) => a - b) as [number, number] : undefined;
  if (attributeCount) understood.push(`${attributeCount} attributes${levels ? `, ${levels[0] === levels[1] ? levels[0] : `${levels[0]}–${levels[1]}`} levels each` : ""}`);

  /* items / treatments: an explicit list after "items:" or "treatments:", or lines when the method is a list method */
  const listAfter = (label: RegExp) => { const m = new RegExp(`\\b(?:${label.source})\\s*:\\s*(.+)`, "i").exec(String(text ?? "")); return m ? m[1].split(/\n|[,;|]/).map((x) => x.trim()).filter(Boolean) : []; };
  let items = listAfter(/items|features|claims|statements|benefits|messages/);
  const bareLines = lines.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter((l) => l && l.length < 120 && !/[:?]$/.test(l) && l.split(" ").length <= 12);
  if (!items.length && kind === "maxdiff" && lines.length >= 4) { const listed = bareLines.filter((l) => !/\bmax ?diff|\bbest[- ]worst|\bper task\b|\btasks?\b|\bversions?\b/i.test(l)); if (listed.length >= 4) items = listed; }
  if (items.length) understood.push(`${items.length} items listed`);
  const itemCount = num(re("\\bN (?:items|features|claims|statements|benefits|messages|attributes to rank)\\b").exec(t)?.[1]);
  let treatments = listAfter(/treatments|concepts|ads|products|designs|stimuli/);
  const treatmentCount = num(re("\\bN (?:treatments|concepts|ads|products|packaging designs|designs|stimuli|cells)\\b").exec(t)?.[1]);
  if (!treatments.length && treatmentCount && kind === "experiment") treatments = Array.from({ length: treatmentCount }, (_, i) => `Treatment ${String.fromCharCode(65 + (i % 26))}`);

  /* the task structure */
  const tasks = num(re("\\bN (?:choice |rating |maxdiff |best[- ]worst )?(?:tasks|choice sets|sets|screens|exercises|questions)(?: per (?:respondent|person|version))?\\b").exec(t)?.[1]);
  const alternatives = num(re("\\bN (?:alternatives|concepts|options|profiles|products|cards)(?: per (?:task|set|screen|question))?\\b").exec(t)?.[1]) ?? num(re("\\bper task:? N\\b").exec(t)?.[1]);
  const perTask = num(re("\\bN (?:items )?per (?:task|set|screen)\\b").exec(t)?.[1]);
  const versions = num(re("\\bN (?:versions|blocks)\\b").exec(t)?.[1]);
  const holdouts = num(re("\\bN holdouts?\\b").exec(t)?.[1]);
  const sample = num(re("\\b(?:sample (?:of|size)?|n ?=)\\s*(\\d+)\\b|\\b(\\d+) (?:completes|respondents|interviews|participants)\\b").exec(t)?.slice(1).find(Boolean));
  const minutes = num(re("\\b(\\d+)[- ]?(?:minutes?|mins?)\\b").exec(t)?.[1]);
  const runs = num(re("\\bN runs\\b").exec(t)?.[1]);
  const attributesPerTask = num(re("\\b(?:show(?:ing)?|only) N attributes(?: per (?:task|screen|concept))?\\b|\\bN attributes per (?:task|screen|concept)\\b").exec(t)?.[1]);
  const partial = /\bpartial[- ]profile\b/i.test(t) || !!attributesPerTask || undefined;
  if (partial) understood.push(`Partial profile${attributesPerTask ? `: ${attributesPerTask} attributes per task` : ""}`);
  if (tasks) understood.push(`${tasks} tasks per respondent`);
  if (alternatives) understood.push(`${alternatives} alternatives per task`);
  if (perTask) understood.push(`${perTask} per task`);
  if (sample) understood.push(`Sample ≈ ${sample}`);
  if (minutes) understood.push(`About ${minutes} minutes`);
  const method = /\befficien|\boptimi[sz]|\bd-?optimal|\bd-?efficien/i.test(t) ? "efficient" : /\bbalanced|\borthogonal|\blevel balance/i.test(t) ? "balanced" : undefined;
  if (method) understood.push(/\bbalanced/i.test(t) && method === "efficient" ? "Efficient and level-balanced" : method === "efficient" ? "An efficient (optimized) design" : "A balanced design");
  const none = /\bno none\b|\bwithout (?:a |the )?none|\bforced choice\b(?!.{0,30}would)/i.test(t) ? false : /\bnone (?:option|alternative)|\bno[- ]choice|\bopt[- ]?out|\bnone of these\b/i.test(t) ? true : undefined;
  const dualNone = /\bdual[- ]response|\bwould you (?:actually )?buy/i.test(t) || undefined;
  const specialist = /\bspecialists?\b|\bphysicians?\b|\bdoctors?\b|\bb2b\b|\bit decision makers?\b|\bsmall sample\b/i.test(t) || undefined;
  /* the experimental design type */
  const designType: ExperimentType | undefined = /\bwilliams|\bcarry-?over/i.test(t) ? "williams" : /\blatin square|\border (?:effects?|bias|rotation)/i.test(t) ? "latin_square" : /\bincomplete block|\bbibd\b/i.test(t) ? "bibd" : /\bfull factorial|\ball combinations\b/i.test(t) ? "full_factorial" : /\bfractional|\bd-?optimal|\bmain[- ]effects\b|\bfactorial\b/i.test(t) ? "fractional" : undefined;
  if (designType) understood.push(`Design type: ${designType.replace("_", " ")}`);
  /* constraints: "never show X with Y" over named levels */
  const prohibitions: DesignRequest["prohibitions"] = [];
  for (const m of t.matchAll(/\b(?:never (?:show|combine|pair)|not (?:show|combine)|prohibit(?:ed)?|exclude)\s+["“]?([^"”,.;]+?)["”]?\s+(?:with|and|together with)\s+["“]?([^"”,.;]+?)["”]?(?=[,.;]|$| together)/gi)) {
    const find = (s: string) => { for (const a of attributes) { const l = a.levels.find((x) => x.toLowerCase() === s.trim().toLowerCase()); if (l) return { attribute: a.name, level: l }; } return null; };
    const a = find(m[1]), b = find(m[2]);
    if (a && b && a.attribute !== b.attribute) prohibitions.push({ a, b });
  }
  if (prohibitions.length) understood.push(`${prohibitions.length} prohibited combination${prohibitions.length === 1 ? "" : "s"}`);
  if (partial && (kind === "acbc" || !kind)) { kind = "conjoint"; kindNamed = true; }
  return { kind, kindNamed, attributes, attributeCount, levels, items, itemCount, perTask, tasks, alternatives, versions, method, none, dualNone, holdouts, sample, minutes, specialist, designType, treatments, runs, prohibitions, partial, attributesPerTask, understood };
}

export interface DesignQuestion { key: "attributes" | "items" | "treatments" | "factors" | "kind" | "prices"; ask: string; example: string }
export interface DesignRecommendation {
  kind: DesignKind;
  config: Record<string, unknown>;
  /** each choice and why */
  why: string[];
  /** what was not said and was decided by the rules */
  assumptions: string[];
  /** what only the researcher can supply; the config holds clearly named placeholders until then */
  questions: DesignQuestion[];
  warnings: string[];
  minSample: number | null;
  minutes: number | null;
  placeholders: boolean;
}

const placeholderAttributes = (n: number, lv: [number, number]) => Array.from({ length: n }, (_, i) => {
  const k = lv[0] + (lv[1] > lv[0] ? i % (lv[1] - lv[0] + 1) : 0);
  return { name: `Attribute ${i + 1}`, levels: Array.from({ length: k }, (_, j) => `Level ${j + 1}`) };
});

/** the recommendation; `answers` merges what the researcher added (named attributes, items…) */
export function recommendDesign(req: DesignRequest, answers: { attributes?: ConjointAttribute[]; items?: string[]; treatments?: string[]; kind?: DesignKind } = {}): DesignRecommendation {
  const why: string[] = [], assumptions: string[] = [], questions: DesignQuestion[] = [], warnings: string[] = [];
  const attrs = answers.attributes?.length ? answers.attributes : req.attributes;
  const items = answers.items?.length ? answers.items : req.items;
  const treatments = answers.treatments?.length ? answers.treatments : req.treatments;
  /* the method: as named, else the rules' choice from what was described */
  let kind: DesignKind | null = answers.kind ?? req.kind;
  if (!kind) {
    if (items.length || req.itemCount) kind = "maxdiff";
    else if (treatments.length || req.designType) kind = "experiment";
    else if (attrs.length || req.attributeCount) {
      const n = attrs.length || req.attributeCount!;
      kind = req.specialist || (req.sample && req.sample < 150) ? "cva" : n >= 7 ? "acbc" : "conjoint";
    } else kind = "conjoint";
    assumptions.push(`No method was named — ${DESIGN_KIND_NAMES[kind]} fits what was described.`);
  }
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  if (kind === "maxdiff") {
    let list = items;
    let placeholders = false;
    if (!list.length) {
      const n = req.itemCount ?? 12;
      list = Array.from({ length: n }, (_, i) => `Item ${i + 1}`); placeholders = true;
      questions.push({ key: "items", ask: `List the ${req.itemCount ? `${req.itemCount} ` : ""}items to rank (features, claims, benefits…), one per line.`, example: "Free delivery\nLonger warranty\n24/7 support" });
      if (!req.itemCount) assumptions.push("No number of items was given — 12 placeholders until you list them.");
    }
    const adv = designAdvice({ items: list, ...(req.sample ? { sample: req.sample } : {}), ...(req.minutes ? { maxMinutes: req.minutes } : {}) });
    const perTask = req.perTask ?? adv?.perTask ?? 4;
    const tasks = req.tasks ?? adv?.tasks ?? Math.ceil((3 * list.length) / perTask);
    const appearances = Math.round(((tasks * perTask) / list.length) * 10) / 10;
    why.push(`${perTask} items per task${req.perTask ? " (as asked)" : ` — ${list.length <= 8 ? "few items: 3" : list.length <= 15 ? "4 keeps each choice easy with 9–15 items" : "5 for a long list"}`}.`);
    why.push(`${tasks} tasks so each item is seen about ${appearances} times per respondent${appearances < 2.5 ? " — below the 3 that individual (HB) scores need" : " (≈ 3 is the standard for individual-level HB scores)"}.`);
    if (appearances < 2.5) warnings.push(`Each item is seen only ≈ ${appearances} times: add tasks or use more versions and aggregate (sample-level) scores.`);
    const versions = req.versions ?? Math.min(300, Math.max(10, list.length * 5));
    why.push(`${versions} versions so item combinations and positions vary across respondents.`);
    warnings.push(...(adv?.warnings ?? []));
    return { kind, config: { items: list, itemsPerTask: perTask, tasks, versions }, why, assumptions, questions, warnings, minSample: adv?.minSample ?? 200, minutes: adv?.minutes ?? null, placeholders };
  }

  if (kind === "experiment") {
    const designType: ExperimentType = req.designType ?? (treatments.length ? "williams" : "fractional");
    if (!req.designType) assumptions.push(treatments.length ? "Treatments shown in sequence: a Williams design balances both position and which treatment follows which." : "Factors with levels: a D-optimal fractional factorial estimates every main effect in the fewest runs.");
    if (designType === "full_factorial" || designType === "fractional") {
      let f = attrs, placeholders = false;
      if (!f.length) { f = placeholderAttributes(req.attributeCount ?? 4, req.levels ?? [2, 3]); placeholders = true; questions.push({ key: "factors", ask: "Name the factors and their levels, one per line.", example: "Colour: Red, Blue, Green\nClaim: Natural, Clinically proven" }); }
      const full = f.reduce((t, a) => t * a.levels.length, 1);
      const p = mainEffectsParameters(f);
      const runs = designType === "full_factorial" ? full : req.runs ?? recommendedRuns(f);
      if (designType === "full_factorial" && full > 64) warnings.push(`A full factorial of ${full} runs is a lot for respondents — a D-optimal fraction of ${recommendedRuns(f)} runs estimates every main effect.`);
      why.push(designType === "full_factorial" ? `Full factorial: all ${full} combinations, so main effects and interactions are all estimable.` : `D-optimal fraction: ${runs} of ${full} combinations for ${p} main-effect parameters${runs === recommendedRuns(f) ? " — the smallest size that lets every level and every pair of levels appear equally often" : ""}.`);
      why.push("Run order is shuffled within each version so position effects do not line up with any factor.");
      return { kind, config: { designType, factors: f, ...(designType === "fractional" ? { runs } : {}), versions: req.versions ?? 1, randomizeOrder: true, ...(req.prohibitions.length ? { prohibitions: req.prohibitions } : {}) }, why, assumptions, questions, warnings, minSample: null, minutes: null, placeholders };
    }
    let tr = treatments, placeholders = false;
    if (!tr.length) { tr = ["Treatment A", "Treatment B", "Treatment C", "Treatment D"]; placeholders = true; questions.push({ key: "treatments", ask: "List the treatments (concepts, ads, products…), one per line.", example: "Concept A\nConcept B\nConcept C" }); }
    const n = tr.length;
    if (designType === "williams") why.push(`Williams design: ${n % 2 ? 2 * n : n} sequences — each treatment in every position and after every other treatment equally often, so order and carry-over effects cancel.`);
    if (designType === "latin_square") why.push(`Latin square: ${n} sequences, each treatment once in each position. Carry-over is not balanced; choose Williams when one exposure can colour the next.`);
    if (designType === "bibd") { const k = req.perTask ?? (n <= 6 ? 3 : n <= 12 ? 4 : 5); why.push(`Balanced incomplete blocks: ${k} of ${n} per respondent, each treatment and each pair as equally often as the sizes allow.`); return { kind, config: { designType, treatments: tr, blockSize: k, ...(req.versions ? { blocks: req.versions } : {}) }, why, assumptions, questions, warnings, minSample: null, minutes: null, placeholders }; }
    if (n > 6) warnings.push(`${n} treatments in sequence is long for one respondent — consider balanced incomplete blocks (each respondent sees a subset).`);
    return { kind, config: { designType, treatments: tr }, why, assumptions, questions, warnings, minSample: null, minutes: null, placeholders };
  }

  /* attribute-based: conjoint, acbc, menu, cva */
  let a = attrs, placeholders = false;
  if (!a.length) {
    const n = req.attributeCount ?? (kind === "acbc" ? 8 : 5);
    a = placeholderAttributes(n, req.levels ?? (kind === "menu" ? [2, 3] : [3, 4]));
    placeholders = true;
    questions.push(kind === "menu"
      ? { key: "prices", ask: "List the menu items and their price points, one item per line.", example: "Extra storage: $2, $4, $6\nPriority support: $5, $9" }
      : { key: "attributes", ask: `Name the ${req.attributeCount ? `${req.attributeCount} ` : ""}attributes and their levels, one per line.`, example: "Brand: Acme, Globex, Initech\nPrice: $9, $14, $19\nStorage: 64 GB, 128 GB, 256 GB" });
    if (!req.attributeCount) assumptions.push(`No number of attributes was given — ${n} placeholders until you name them.`);
  }
  if (req.attributeCount && a.length && a.length !== req.attributeCount && !placeholders) warnings.push(`You said ${req.attributeCount} attributes and named ${a.length}.`);
  const adv = designAdvice({ attributes: a, ...(kind === "menu" ? { menu: true } : {}), ...(req.sample ? { sample: req.sample } : {}), ...(req.minutes ? { maxMinutes: req.minutes } : {}), ...(kind === "cva" ? { specialist: true } : {}) });
  warnings.push(...(adv?.warnings ?? []).filter((w) => !(kind === "acbc" && /ACBC/.test(w))));
  const maxLevels = Math.max(...a.map((x) => x.levels.length));
  const params = a.reduce((t, x) => t + x.levels.length - 1, 0);

  if (kind === "conjoint") {
    const alternatives = req.alternatives ?? adv?.alternatives ?? 3;
    /* partial profile: k attributes per task (4–5 typical, never more than A − 1), and ≈ 1.5× the tasks */
    const k = req.partial ? Math.max(2, Math.min(a.length - 1, req.attributesPerTask ?? (a.length >= 9 ? 5 : 4))) : null;
    const tasks = req.tasks ?? (k ? Math.min(24, Math.ceil(((adv?.tasks ?? 12) * 1.5) / 2) * 2) : adv?.tasks ?? 12);
    if (k) why.push(`Partial profile: each task shows ${k} of the ${a.length} attributes${req.attributesPerTask ? " (as asked)" : ""}, the others left out, balanced so every attribute and every pair appears about equally often — respondents compare fewer things at once, so full-profile overload is avoided. Partial profiles carry less information per task, hence ${tasks} tasks.`);
    const minSample = Math.max(300, Math.ceil((500 * maxLevels) / (tasks * alternatives) / 10) * 10);
    const method = req.method ?? "efficient";
    why.push(`${alternatives} alternatives per task${req.alternatives ? " (as asked)" : ""} — ${alternatives <= 3 ? "easy to compare in full profile" : "more information per task, still readable"}${a.length >= 6 && alternatives > 3 ? "; with this many attributes, 3 is kinder to respondents" : ""}.`);
    why.push(`${tasks} tasks per respondent${req.tasks ? " (as asked)" : ""}: ${tasks * alternatives} profiles for ${params} part-worth parameters — ${tasks * alternatives >= 3 * params ? "enough for individual-level (HB) estimates" : "thin for individual-level estimates; HB borrows strength across respondents"}.`);
    why.push(`${method === "efficient" ? "Efficient design" : "Balanced design"}: ${method === "efficient" ? "levels balanced and overlap minimised, then pairs swapped to raise D-efficiency" : "every level shown equally often, with minimal overlap within a task"}${req.method ? " (as asked)" : ""}.`);
    const versions = req.versions ?? 300;
    why.push(`${versions} versions: respondents see different task sets, which estimates the design more precisely than one fixed set.`);
    why.push(`A None option${req.none === false ? " is left out (forced choice, as asked)" : req.dualNone ? " as a dual response (choose, then “would you buy it?”), keeping full information from the forced choice" : " lets respondents say they would buy none — needed for volume and share simulations"}.`);
    why.push(`Sample: at least ${minSample} completes (Orme: n ≥ 500 × ${maxLevels} ÷ (${tasks} × ${alternatives}), and 300 in practice for main effects).`);
    if (a.length >= 7 && !k) warnings.push(`${a.length} attributes in full profile is demanding; consider a partial-profile CBC (4–5 attributes per task) or ACBC.`);
    if (tasks > 20) warnings.push(`${tasks} tasks risks fatigue; 8–15 is usual.`);
    if (alternatives > 5) warnings.push(`${alternatives} alternatives per task is hard to read; 3–4 is usual.`);
    if (req.sample && req.sample < minSample) warnings.push(`${req.sample} completes is below the ≈ ${minSample} this design needs.`);
    return { kind, config: { method, attributes: a, tasks, alternativesPerTask: alternatives, versions, ...(k ? { attributesPerTask: k } : {}), noneOption: req.none !== false && !req.dualNone ? true : false, dualResponseNone: !!req.dualNone, holdoutTasks: req.holdouts ?? 0, ...(req.prohibitions.length ? { prohibitions: req.prohibitions } : {}) }, why, assumptions, questions, warnings, minSample, minutes: Math.round((tasks * 25) / 60), placeholders };
  }
  if (kind === "acbc") {
    why.push(`ACBC for ${a.length} attributes: a build-your-own step, screening screens and a choice tournament adapt to what each respondent cares about, so many attributes stay manageable.`);
    why.push("6 screening screens of 4 concepts, each concept differing from the respondent's own build in at most 2 attributes — the standard ACBC configuration.");
    if (a.length < 5) warnings.push(`ACBC earns its length with many attributes; with ${a.length}, standard CBC is quicker.`);
    return { kind, config: { attributes: a, screeningTasks: 6, conceptsPerScreen: 4, maxAttributesVaried: 2, tournamentAlternatives: 3, ...(req.prohibitions.length ? { prohibitions: req.prohibitions } : {}) }, why, assumptions, questions, warnings, minSample: adv?.minSample ?? 150, minutes: adv?.minutes ?? 12, placeholders };
  }
  if (kind === "menu") {
    const tasks = req.tasks ?? 8;
    why.push(`Menu-based conjoint: every task shows the whole menu with varying prices; respondents pick what they would buy. ${tasks} tasks${req.tasks ? " (as asked)" : " is the usual length"}.`);
    why.push("Each item's price points are balanced across tasks, and no two tasks in a version repeat the same price combination.");
    return { kind, config: { items: a, tasks, versions: req.versions ?? 1, noneOption: true }, why, assumptions, questions, warnings, minSample: adv?.minSample ?? 300, minutes: adv?.minutes ?? 8, placeholders };
  }
  /* cva */
  const profiles = Math.max(12, Math.ceil(params * 1.5) + 1);
  why.push(`Rating-based conjoint: each respondent rates ${profiles} profiles (1.5 × the ${params} parameters, at least 12), enough for individual part-worths from a small or specialist sample.`);
  if (a.length > 6) warnings.push(`${a.length} attributes in rated full profiles is heavy; keep CVA to 6 or fewer.`);
  return { kind, config: { attributes: a, mode: "single", profiles, versions: req.versions ?? 1 }, why, assumptions, questions, warnings, minSample: 60, minutes: Math.round(profiles * 0.25), placeholders };
}

/* ------------------------------------------------------------------ samples */

/** a worked sample for every generator: the request a researcher might write, and its configuration */
/**
 * VARIANTS of a design kind that the library lists as methods of their own (Design Generators phase 2): the same
 * generator with the variant's setting — partial-profile CBC is the CBC generator with attributesPerTask.
 */
export const DESIGN_VARIANTS: Record<string, { kind: DesignKind; name: string; description: string; title: string; objective: string; request: string; config: Record<string, unknown> }> = {
  "conjoint@partial": {
    kind: "conjoint", name: "Partial-profile CBC",
    description: "Choice tasks that show only some of many attributes at a time — 8–20 attributes without overload.",
    title: "Electric car", objective: "Which of ten car features drive choice, without showing all ten in every task?",
    request: "A partial-profile conjoint for an electric car with 10 attributes, showing 5 attributes per task, 3 alternatives.",
    config: { method: "efficient", attributes: [
      { name: "Brand", levels: ["Volta", "Ampère", "Faraday"] }, { name: "Body", levels: ["Hatchback", "Sedan", "SUV"] }, { name: "Range", levels: ["300 km", "450 km", "600 km"] },
      { name: "Charging (10–80%)", levels: ["45 min", "30 min", "18 min"] }, { name: "Battery warranty", levels: ["5 years", "8 years"] }, { name: "Seats", levels: ["4", "5", "7"] },
      { name: "Driver assistance", levels: ["Basic", "Highway assist", "Full self-parking"] }, { name: "Home charger", levels: ["Not included", "Included"] },
      { name: "Service plan", levels: ["Pay as you go", "3 years included"] }, { name: "Price", levels: ["$32,000", "$38,000", "$44,000", "$50,000"] },
    ], attributesPerTask: 5, tasks: 18, alternativesPerTask: 3, versions: 50, noneOption: true, holdoutTasks: 0 },
  },
};

export const DESIGN_SAMPLES: Record<DesignKind | "custom", { title: string; objective: string; request: string; config: Record<string, unknown> }> = {
  conjoint: {
    title: "Streaming subscription", objective: "Which plan features drive choice, and how price-sensitive are subscribers?",
    request: "A choice-based conjoint for a streaming plan with 5 attributes, an efficient design, 12 tasks and 3 alternatives per task, with a None option.",
    config: { method: "efficient", attributes: [
      { name: "Monthly price", levels: ["$8.99", "$12.99", "$16.99"] }, { name: "Library", levels: ["Movies only", "Movies + series", "Everything + live sport"] },
      { name: "Ads", levels: ["With ads", "No ads"] }, { name: "Screens at once", levels: ["1", "2", "4"] }, { name: "Downloads", levels: ["No downloads", "Downloads included"] },
    ], tasks: 12, alternativesPerTask: 3, versions: 50, noneOption: true, holdoutTasks: 0 },
  },
  acbc: {
    title: "Laptop for students", objective: "Which of many laptop specifications matter, and what would students pay?",
    request: "An adaptive CBC for laptops with 8 attributes.",
    config: { attributes: [
      { name: "Brand", levels: ["Acme", "Globex", "Initech", "Umbrella"] }, { name: "Screen", levels: ["13 inch", "14 inch", "16 inch"] }, { name: "Battery", levels: ["8 h", "12 h", "18 h"] },
      { name: "Memory", levels: ["8 GB", "16 GB", "32 GB"] }, { name: "Storage", levels: ["256 GB", "512 GB", "1 TB"] }, { name: "Weight", levels: ["1.1 kg", "1.4 kg", "1.8 kg"] },
      { name: "Warranty", levels: ["1 year", "2 years", "3 years"] }, { name: "Price", levels: ["$699", "$899", "$1,099", "$1,299"] },
    ], screeningTasks: 6, conceptsPerScreen: 4, maxAttributesVaried: 2, tournamentAlternatives: 3 },
  },
  menu: {
    title: "Mobile plan add-ons", objective: "Which add-ons would customers buy at which prices?",
    request: "A menu-based conjoint for mobile plan add-ons with prices, 8 tasks.",
    config: { items: [
      { name: "Extra data 10 GB", levels: ["$3", "$5", "$7"] }, { name: "International calls", levels: ["$4", "$6", "$9"] },
      { name: "Device insurance", levels: ["$6", "$9", "$12"] }, { name: "Music streaming", levels: ["$5", "$8", "free"] },
    ], tasks: 8, versions: 1, noneOption: true },
  },
  cva: {
    title: "Clinical software for physicians", objective: "What do physicians value in a prescribing tool? (small specialist sample)",
    request: "A rating-based conjoint for physicians with 4 attributes.",
    config: { attributes: [
      { name: "Integration", levels: ["Standalone", "Integrates with the EHR"] }, { name: "Alerts", levels: ["Basic", "Drug–drug", "Drug–drug + allergy"] },
      { name: "Support", levels: ["Email", "Phone", "On-site"] }, { name: "Annual fee", levels: ["$600", "$900", "$1,200"] },
    ], mode: "single", versions: 1 },
  },
  maxdiff: {
    title: "Banking app features", objective: "Which of 12 planned features matter most to customers?",
    request: "A MaxDiff of 12 banking app features, 4 per task.",
    config: { items: ["Instant transfers", "Spending insights", "Savings goals", "Card freeze", "Virtual cards", "Bill reminders", "Cashback offers", "Joint accounts", "Investing", "24/7 chat support", "Biometric login", "Travel notifications"], itemsPerTask: 4, tasks: 9, versions: 60 },
  },
  experiment: {
    title: "Packaging test (fractional factorial)", objective: "Which packaging elements raise purchase intent?",
    request: "A D-optimal fractional factorial for a packaging test with 4 factors.",
    config: { designType: "fractional", factors: [
      { name: "Colour", levels: ["Green", "Blue", "White"] }, { name: "Claim", levels: ["Natural", "Clinically proven", "No claim"] },
      { name: "Image", levels: ["Product", "Lifestyle"] }, { name: "Badge", levels: ["None", "New", "Award"] },
    ], versions: 1, randomizeOrder: true },
  },
  custom: {
    title: "Design file from columns", objective: "A free-form file: rotation cells and a block number for a fielding plan.",
    request: "",
    config: { rows: 12, columnsSpec: ["Row: sequence", "Cell: random_level A | B | C", "Block: block 4"], versions: 1 },
  },
};

/* ------------------------------------------------------------ the model's reading, merged (Design Generators phase 2) */

/**
 * MODEL-ASSISTED READING (2026-11-09). A model reads the request into the same fields as `readDesignRequest`; the
 * two are merged here so the model can only ADD what the rules missed, never overrule them or invent content:
 *   · a field the rules read stays as read; the model fills only empty ones — except attributes, which the model's
 *     reading replaces when it found more of them (each said) or the rules' reading is a sentence split at commas;
 *   · every attribute, level, item and treatment name must occur in the researcher's own words (case and spacing
 *     ignored) — a name the model made up is dropped and counted;
 *   · numbers must be whole and in range (tasks 1–40, alternatives 2–6, versions 1–999, items per task 2–10,
 *     attributes per task 2–(attributes − 1), sample 10–100,000, minutes 1–120, runs 2–5,000).
 * What the model added is listed in `understood` with "(read by the AI)" so the researcher sees where it came from.
 */
export interface DesignReadingMerge { read: DesignRequest; added: string[]; dropped: number }

const KINDS: DesignKind[] = ["conjoint", "acbc", "menu", "cva", "maxdiff", "experiment"];
const EXP_TYPES: ExperimentType[] = ["fractional", "full_factorial", "latin_square", "williams", "bibd"];
const squash = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[\s ]+/g, " ").trim();

export function mergeDesignReading(rules: DesignRequest, model: unknown, text: string): DesignReadingMerge {
  const read: DesignRequest = structuredClone(rules);
  const added: string[] = [];
  let dropped = 0;
  const m = (model && typeof model === "object" ? model : {}) as Record<string, unknown>;
  const said = squash(String(text ?? ""));
  const grounded = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= 120 && said.includes(squash(s));
  const names = (v: unknown, max: number): string[] => {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const x of v.slice(0, max)) { if (grounded(x)) { if (!out.some((o) => squash(o) === squash(x))) out.push(String(x).trim()); } else dropped++; }
    return out;
  };
  const whole = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
  const note = (s: string) => { added.push(s); read.understood.push(`${s} (read by the AI)`); };

  if (!read.kind && typeof m.kind === "string" && (KINDS as string[]).includes(m.kind)) { read.kind = m.kind as DesignKind; note(`Method: ${DESIGN_KIND_NAMES[read.kind]}`); }
  /* the rules' attributes stand unless the model found more of them, all said, or the rules' look like a sentence split at commas */
  const sentence = read.attributes.some((a) => a.levels.some((l) => l.length > 30 || l.split(/\s+/).length > 4));
  if (Array.isArray(m.attributes) && (!read.attributes.length || sentence || m.attributes.length > read.attributes.length)) {
    const attrs: ConjointAttribute[] = [];
    for (const a of m.attributes.slice(0, 30)) {
      const r = (a ?? {}) as Record<string, unknown>;
      if (!grounded(r.name)) { dropped++; continue; }
      const levels = names(r.levels, 20);
      if (levels.length >= 2) attrs.push({ name: String(r.name).trim(), levels });
      else dropped++;
    }
    if (attrs.length && (!read.attributes.length || sentence || attrs.length > read.attributes.length)) { if (read.attributes.length) read.understood = read.understood.filter((u) => !/^Attributes?:/.test(u)); read.attributes = attrs; note(`${attrs.length} attributes: ${attrs.map((a) => `${a.name} (${a.levels.length} levels)`).join(", ")}`); }
  }
  if (!read.items.length) { const it = names(m.items, 60); if (it.length >= 2) { read.items = it; note(`${it.length} items: ${it.slice(0, 6).join(", ")}${it.length > 6 ? ", …" : ""}`); } }
  if (!read.treatments.length) { const tr = names(m.treatments, 30); if (tr.length >= 2) { read.treatments = tr; note(`${tr.length} treatments: ${tr.join(", ")}`); } }
  const nums: [keyof DesignRequest, string, number, number, string][] = [
    ["tasks", "tasks", 1, 40, "tasks"], ["alternatives", "alternatives", 2, 6, "alternatives per task"], ["versions", "versions", 1, 999, "versions"],
    ["perTask", "perTask", 2, 10, "items per task"], ["sample", "sample", 10, 100_000, "sample"], ["minutes", "minutes", 1, 120, "minutes"], ["runs", "runs", 2, 5000, "runs"],
    ["attributeCount", "attributeCount", 2, 30, "attributes"], ["itemCount", "itemCount", 2, 100, "items"],
  ];
  for (const [key, src, lo, hi, words] of nums) {
    if (read[key] !== undefined) continue;
    const v = whole(m[src], lo, hi);
    if (v !== undefined) { (read as unknown as Record<string, unknown>)[key] = v; note(`${words}: ${v}`); }
  }
  if (read.none === undefined && typeof m.none === "boolean") { read.none = m.none; note(m.none ? "a None option" : "no None option"); }
  if (!read.method && (m.method === "efficient" || m.method === "balanced")) { read.method = m.method; note(`${m.method} design`); }
  if (!read.designType && typeof m.designType === "string" && (EXP_TYPES as string[]).includes(m.designType)) { read.designType = m.designType as ExperimentType; note(`design type: ${m.designType.replace("_", " ")}`); }
  if (!read.partial && m.partial === true) { read.partial = true; note("partial profile"); }
  if (read.attributesPerTask === undefined) {
    const A = read.attributes.length || read.attributeCount || 0;
    const v = whole(m.attributesPerTask, 2, Math.max(2, A - 1));
    if (v !== undefined && A > v) { read.attributesPerTask = v; read.partial = true; note(`${v} attributes shown per task`); }
  }
  if (read.partial && read.kind && read.kind !== "conjoint") read.partial = undefined;
  return { read, added, dropped };
}

/** the JSON a model returns for a design request (the same fields `mergeDesignReading` accepts) */
export const DESIGN_READING_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    kind: { type: ["string", "null"], enum: [...KINDS, null] },
    attributes: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, levels: { type: "array", items: { type: "string" } } }, required: ["name", "levels"] } },
    items: { type: "array", items: { type: "string" } },
    treatments: { type: "array", items: { type: "string" } },
    tasks: { type: ["integer", "null"] }, alternatives: { type: ["integer", "null"] }, versions: { type: ["integer", "null"] }, perTask: { type: ["integer", "null"] },
    attributeCount: { type: ["integer", "null"] }, itemCount: { type: ["integer", "null"] }, sample: { type: ["integer", "null"] }, minutes: { type: ["integer", "null"] }, runs: { type: ["integer", "null"] },
    none: { type: ["boolean", "null"] }, method: { type: ["string", "null"], enum: ["efficient", "balanced", null] },
    designType: { type: ["string", "null"], enum: [...EXP_TYPES, null] }, partial: { type: ["boolean", "null"] }, attributesPerTask: { type: ["integer", "null"] },
  },
  required: ["kind", "attributes", "items", "treatments"],
} as const;

export const DESIGN_READING_RULES = `You read a market researcher's description of a design (conjoint, MaxDiff, menu-based, ACBC, rating-based conjoint, or a custom experimental design) into JSON.
EXTRACT ONLY WHAT IS SAID. Never invent attributes, levels, items or treatments: copy each name exactly as the researcher wrote it (spoken requests may say levels in a sentence — "brand with Apple, Samsung and Google" → Brand: Apple, Samsung, Google). If something is not stated, use null or an empty list.
kind: conjoint (choice-based / CBC, including partial profile), acbc (adaptive), menu (menu-based, add-ons with prices), cva (rating-based), maxdiff (best–worst), experiment (factorial, fractional, D-optimal, Latin square, Williams, BIBD) — or null when no method is named or clearly implied.
Numbers: tasks, alternatives per task, versions, perTask (MaxDiff items per task), attributeCount / itemCount (when only a count is given), sample, minutes, runs, attributesPerTask (partial profile: attributes shown per task). "a dozen" = 12.
Return JSON only.`;
