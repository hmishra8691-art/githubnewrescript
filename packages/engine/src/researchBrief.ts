/**
 * THE RESEARCH BRIEF, READ (Intelligent Mode upgrade IM1, 2026-11-06).
 *
 * "I am conducting healthcare research among doctors in India. I need 1,000 completed responses, with age,
 * specialty, and geographic quotas. I want a production-like test before launching the survey." used to be read as
 * a QUESTION — the audit's measurement: 9 of 10 research briefs under 1,500 characters were classified as a
 * question or an edit, so plan-first never engaged and nothing downstream (settings, testing, quotas, fieldwork)
 * had a structured reading to work from.
 *
 * This is that reading: deterministic, cheap, no model. It says whether a sentence is a research brief and pulls
 * out what every later module needs, each with the words it was read from so a proposal can say WHY:
 *
 *   types        healthcare · pharma · advertising · brand · political · consumer · product · cx · employee ·
 *                academic · market · qualitative · mixed (several may apply; the first is the primary)
 *   method       quantitative | qualitative | mixed
 *   population   "doctors in India", "practising doctors", "first-time home buyers in Mumbai"
 *   professional the population is a professional / B2B audience (doctors, physicians, oncologists, employees…)
 *   sampleSize   1,000 (with "per cell" / "per country" / "each" as a multiplier note)
 *   countries    India, Germany, France …; markets: "12 countries"
 *   quotas       the dimensions named for quotas: age, gender, region, specialty …
 *   languages    the languages named
 *   loiMinutes   "25-minute survey", "60 minutes each"
 *   timelineDays "finish in three weeks", "in 10 days"
 *   testing      "production-like" | "live-like" | "preview" — what kind of test was asked for
 *   constraints  noBack, consent, anonymous, saveResume, mobileFirst, timeLimit, ethics, weighting, translation
 *   methods      maxdiff, conjoint, van_westendorp, nps, brand_funnel, tracking, ad_exposure, validated_scale
 *
 * `isBrief` is true when the text describes a STUDY (at least two of: a study type, a population, a sample size,
 * quotas, a method, a stated aim) rather than one change. A brief that only asks for a qualitative guide is a brief
 * with `method: "qualitative"` and `survey: false` — it must not be treated as a request to build a questionnaire.
 */

export type ResearchType = "healthcare" | "pharma" | "advertising" | "brand" | "political" | "consumer" | "product" | "cx" | "employee" | "academic" | "market" | "qualitative" | "mixed";
export type ResearchMethod = "quantitative" | "qualitative" | "mixed";
export type BriefConstraint = "noBack" | "consent" | "anonymous" | "saveResume" | "mobileFirst" | "timeLimit" | "ethics" | "weighting" | "translation" | "randomization" | "duplicatePrevention" | "botProtection";
export type BriefMethodology = "maxdiff" | "conjoint" | "van_westendorp" | "nps" | "brand_funnel" | "tracking" | "ad_exposure" | "validated_scale" | "concept_test" | "segmentation" | "driver_analysis";

export interface BriefSignal { what: string; value: string; words: string }

export interface ResearchBrief {
  isBrief: boolean;
  /** the brief asks for a questionnaire / survey to be built (false for a qual guide on its own) */
  survey: boolean;
  types: ResearchType[];
  method: ResearchMethod | null;
  population: string | null;
  professional: boolean;
  sampleSize: number | null;
  /** "per cell", "per country", "each", "per wave", "monthly" — how the size multiplies */
  sampleBasis: string | null;
  countries: string[];
  /** "12 countries", "5 countries" — markets counted but not named */
  marketCount: number | null;
  quotas: string[];
  languages: string[];
  loiMinutes: number | null;
  timelineDays: number | null;
  testing: "production-like" | "preview" | null;
  constraints: BriefConstraint[];
  methods: BriefMethodology[];
  /** every reading with the words it came from — what a proposal quotes as its reason */
  signals: BriefSignal[];
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, hundred: 100 };
const num = (s: string): number | null => {
  const t = s.trim().toLowerCase().replace(/,(?=\d{3}\b)/g, "");
  const k = /^(\d+(?:\.\d+)?)\s*k$/.exec(t); if (k) return Math.round(Number(k[1]) * 1000);
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] ?? null;
};
const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s*k|\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|hundred)`;

const TYPE_RULES: [ResearchType, RegExp][] = [
  ["pharma", /\bpharma(?:ceutical)?\b|\bdrugs?\b|\boncologists?\b|\bprescrib\w*|\bbiologics?\b|\bmolecules?\b|\badverse[- ]events?\b|\bkols?\b|\btherap(?:y|ies)\b|\bclinical trials?\b/i],
  ["healthcare", /\bhealth ?care\b|\bdoctors?\b|\bphysicians?\b|\bpatients?\b|\bhospitals?\b|\bclinics?\b|\bhcps?\b|\bnurses?\b|\btelemedicine\b|\bmedical\b|\bspecialt(?:y|ies)\b/i],
  ["advertising", /\badvertis\w*|\bad (?:recall|test|campaign)\b|\bcampaign\b|\bexposed\b|\bcontrol (?:cell|group)\b|\bad recall\b|\bcreative test\w*|\btv (?:ad|spot|campaign)\b|\bcommercials?\b/i],
  ["brand", /\bbrand (?:track\w*|health|funnel|awareness|equity|image)\b|\btracker\b|\bwaves?\b.{0,40}\bbrand\b|\bbrand\b.{0,40}\bwaves?\b/i],
  ["political", /\bpolitic\w*|\bvot(?:e|ing|ers?)\b|\belections?\b|\bpart(?:y|ies)\b.{0,20}\bfavourab|\bpoll(?:ing)?\b|\bpublic opinion\b|\bconstituenc\w*/i],
  ["consumer", /\bconsumers?\b|\bshoppers?\b|\busage and attitudes?\b|\bu&a\b|\bpurchase (?:intent\w*|behaviou?r)\b|\bsnack\w*|\bhousehold\b|\bfmcg\b|\bcpg\b/i],
  ["product", /\bproduct test\w*|\bconcept test\w*|\bprototype\b|\bin[- ]home use\b|\bihut\b|\bpack(?:aging)? test\w*|\bnew product\b/i],
  ["cx", /\bcustomer (?:experience|satisfaction|journey|feedback)\b|\bcx\b|\bcsat\b|\bces\b|\bpost[- ](?:purchase|visit|call)\b|\bsupport experience\b/i],
  ["employee", /\bemployees?\b|\bstaff\b|\bworkforce\b|\bengagement survey\b|\bpulse survey\b|\bhr\b|\bteam members\b/i],
  ["academic", /\bacademic\b|\buniversity\b|\bstudents?\b|\bthesis\b|\bdissertation\b|\bethics\b|\birb\b|\bscholarly\b|\bvalidated scales?\b|\bpss-?10\b/i],
  ["market", /\bmarket (?:research|sizing|study|segmentation)\b|\bsegmentation\b|\bmarket share\b/i],
];
const QUAL = /\bin[- ]depth interviews?\b|\bidis?\b|\bfocus groups?\b|\bdiscussion guides?\b|\binterview guides?\b|\bqualitative\b|\bethnograph\w*|\bdiary stud\w*|\bdepth interviews?\b/i;
const QUANT = /\bsurveys?\b|\bquestionnaires?\b|\bpoll\b|\btracker\b|\bcompletes?\b|\bcompleted (?:responses|interviews|surveys)\b|\brespondents\b|\bquantitative\b|\bscreener\b/i;
const MIXED = /\bmixed[- ]methods?\b|\bqual(?:itative)?\b.{0,60}\b(?:then|followed by|and then)\b.{0,40}\b(?:survey|quant)/i;
const STUDY = /\b(?:research|study|survey|questionnaire|poll|tracker|tracking|evaluation|assessment|interviews?|focus groups?)\b/i;
const AIM = /\b(?:conduct\w*|understand\w*|measur\w*|evaluat\w*|explor\w*|assess\w*|investigat\w*|track\w*|test(?:ing)?|identify\w*|estimat\w*|compar\w*)\b/i;

const POPULATION_NOUNS = String.raw`(?:practi[sc]ing\s+|general\s+|first[- ]time\s+|urban\s+|rural\s+|young\s+|senior\s+|female\s+|male\s+|active\s+|current\s+|lapsed\s+|registered\s+|indian\s+|uk\s+|us\s+|university\s+|college\s+|school\s+|medical\s+|nursing\s+|graduate\s+|undergraduate\s+|postgraduate\s+|working\s+|older\s+|new\s+|existing\s+|online\s+)*(?:doctors|physicians|gps|oncologists|cardiologists|specialists|surgeons|nurses|pharmacists|hcps|patients|caregivers|consumers|shoppers|customers|buyers|users|adults|parents|mothers|women|men|teens|students|employees|staff|voters|citizens|residents|households|respondents|decision[- ]makers|it decision[- ]makers|owners|homeowners|home buyers|smokers|drivers|travell?ers|investors|farmers|retailers|businesses|smes|participants|professionals|millennials|gen z)`;
const POP_RE = new RegExp(String.raw`(?:\bamong\s+(?:${NUM}\s+)?|\bwith\s+(?:${NUM}\s+)?|\bof\s+(?:${NUM}\s+)?|\bfor\s+(?:${NUM}\s+)?|\b${NUM}\s+)(${POPULATION_NOUNS}(?:\s+(?:in|from|across|aged|who|with|at)\s+[^.,;:]{2,60})?)`, "i");
const PROFESSIONAL = /\b(?:doctors|physicians|gps|oncologists|cardiologists|specialists|surgeons|nurses|pharmacists|hcps|employees|staff|decision[- ]makers|professionals|retailers|businesses|smes|owners|farmers|kols)\b/i;

const SAMPLE_RE = new RegExp(String.raw`\b${NUM}\s*(?:\+\s*)?(?:completed\s+(?:responses|interviews|surveys)|completes?|complete\s+responses|responses|respondents|interviews|participants|people|n\b)`, "i");
const SAMPLE_N_RE = /\bn\s*=\s*(\d{1,3}(?:,\d{3})+|\d+)/i;
const BASIS_RE = /\b(per|each)\s+(cell|country|market|wave|month|segment|group|region)\b|\b(monthly|quarterly|weekly|per wave|each wave)\b/i;

const COUNTRIES = ["India", "Germany", "France", "Spain", "Italy", "United Kingdom", "UK", "United States", "US", "USA", "Canada", "Brazil", "Mexico", "Argentina", "China", "Japan", "South Korea", "Korea", "Singapore", "Malaysia", "Indonesia", "Thailand", "Vietnam", "Philippines", "Australia", "New Zealand", "South Africa", "Nigeria", "Kenya", "Egypt", "Saudi Arabia", "UAE", "United Arab Emirates", "Turkey", "Russia", "Poland", "Netherlands", "Sweden", "Norway", "Denmark", "Belgium", "Switzerland", "Austria", "Ireland", "Portugal", "Pakistan", "Bangladesh", "Sri Lanka", "Nepal",
  "Maharashtra", "Delhi", "Mumbai", "Bangalore", "Bengaluru", "Chennai", "Kolkata", "Hyderabad", "Pune", "Gujarat", "Karnataka", "Tamil Nadu", "Kerala", "Uttar Pradesh", "West Bengal", "Rajasthan"];
const COUNTRY_RE = new RegExp(String.raw`\b(${COUNTRIES.map((c) => c.replace(/ /g, "\\s+")).join("|")})\b`, "g");
const MARKETS_RE = new RegExp(String.raw`\b${NUM}\s+(?:countries|markets)\b`, "i");

const QUOTA_DIMS: [string, RegExp][] = [
  ["age", /\bage(?:[- ]group|[- ]band)?s?\b/i], ["gender", /\bgender\b|\bsex\b/i], ["region", /\bregion(?:al)?s?\b|\bgeograph\w*|\bzones?\b|\bstates?\b/i],
  ["specialty", /\bspecialt(?:y|ies)\b/i], ["city tier", /\bcity[- ]tiers?\b|\btier[- ]?\d\b/i], ["urban/rural", /\burban\b.{0,10}\brural\b/i],
  ["income", /\bincome\b|\bsec\b|\bsocio[- ]?economic\b|\bnccs\b/i], ["department", /\bdepartments?\b/i], ["tenure", /\btenure\b/i],
  ["country", /\bcountr(?:y|ies)\b/i], ["cell", /\bexposed\b|\bcontrol\b/i], ["usage", /\busers?\b.{0,10}\bnon[- ]users?\b|\bheavy\b.{0,10}\blight\b/i],
];
const LANGUAGES = ["English", "Hindi", "Marathi", "Tamil", "Telugu", "Bengali", "Gujarati", "Kannada", "Malayalam", "Punjabi", "Urdu", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Arabic", "Chinese", "Mandarin", "Japanese", "Korean", "Russian", "Turkish", "Polish", "Swedish", "Indonesian", "Malay", "Thai", "Vietnamese"];
const LANG_RE = new RegExp(String.raw`\b(${LANGUAGES.join("|")})\b`, "g");

const CONSTRAINTS: [BriefConstraint, RegExp][] = [
  ["noBack", /\bno back(?:[- ]button)?\b|\b(?:disable|without|remove|hide)\s+(?:the\s+)?back(?:[- ]button)?\b|\bback button (?:off|disabled)\b|\bcannot go back\b/i],
  ["consent", /\bconsent\b|\binformed consent\b|\bopt[- ]in\b/i],
  ["anonymous", /\banonym\w*|\bconfidential\b/i],
  ["saveResume", /\bsave and (?:resume|continue)\b|\bresume later\b|\bcome back later\b/i],
  ["mobileFirst", /\bmobile[- ](?:first|friendly|optimi[sz]ed)\b|\bon (?:their )?(?:phones|mobiles)\b|\bsmartphones?\b/i],
  ["timeLimit", /\btime limit\b|\btimed\b|\bexpire\w*|\bclose (?:on|by)\b|\bdeadline\b/i],
  ["ethics", /\bethics\b|\birb\b|\bethical approval\b/i],
  ["weighting", /\bweight(?:ed|ing)?\b/i],
  ["translation", /\btranslat\w*|\blocal languages?\b|\bmultilingual\b/i],
  ["randomization", /\brandomi[sz]\w*|\brotat\w*/i],
  ["duplicatePrevention", /\bduplicates?\b|\bonly once\b|\bone response per\b/i],
  ["botProtection", /\bbots?\b|\bcaptcha\b|\bfraud\w*/i],
];
const METHODS: [BriefMethodology, RegExp][] = [
  ["maxdiff", /\bmax[- ]?diff\b|\bbest[- ]worst\b/i], ["conjoint", /\bconjoint\b|\bcbc\b|\bchoice[- ]based\b/i], ["van_westendorp", /\bvan westendorp\b|\bprice sensitivity\b|\bpsm\b/i],
  ["nps", /\bnps\b|\bnet promoter\b/i], ["brand_funnel", /\bbrand funnel\b|\bawareness\b.{0,40}\bconsideration\b/i], ["tracking", /\btrack(?:er|ing)\b|\bwave \d+\b|\bwaves?\b/i],
  ["ad_exposure", /\bexposed\b|\bcontrol cells?\b|\bad exposure\b|\bad recall\b/i], ["validated_scale", /\bvalidated scales?\b|\bpss-?10\b|\bphq-?9\b|\bgad-?7\b|\blikert\b/i],
  ["concept_test", /\bconcept test\w*|\bconcepts?\b.{0,20}\btest\w*/i], ["segmentation", /\bsegmentation\b|\bsegments?\b/i], ["driver_analysis", /\bdrivers?\b|\bkey driver\b/i],
];

export function readResearchBrief(text: string): ResearchBrief {
  const t = (text ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  const signals: BriefSignal[] = [];
  const sig = (what: string, value: string, words: string) => signals.push({ what, value, words: words.trim().slice(0, 120) });

  const types: ResearchType[] = [];
  for (const [ty, re] of TYPE_RULES) { const m = re.exec(t); if (m) { types.push(ty); sig("type", ty, m[0]); } }
  const qualHit = QUAL.exec(t), quantHit = QUANT.exec(t), mixedHit = MIXED.exec(t);
  const method: ResearchMethod | null = mixedHit || (qualHit && quantHit && /\bsurvey|questionnaire\b/i.test(t)) ? "mixed" : qualHit && !quantHit ? "qualitative" : quantHit ? "quantitative" : qualHit ? "qualitative" : null;
  if (method) sig("method", method, (mixedHit ?? qualHit ?? quantHit)![0]);
  if (method === "qualitative") types.push("qualitative");
  if (method === "mixed") types.push("mixed");

  const popM = POP_RE.exec(t);
  const population = popM ? popM[popM.length - 1].replace(/\s+(?:and|with|who need|i need|we need)\b.*$/i, "").trim() : null;
  if (population) sig("population", population, popM![0]);
  const professional = !!population && PROFESSIONAL.test(population) || /\bb2b\b/i.test(t);

  let sampleSize: number | null = null;
  const sm = SAMPLE_RE.exec(t) ?? SAMPLE_N_RE.exec(t);
  if (sm) { sampleSize = num(sm[1]); if (sampleSize != null) sig("sample size", String(sampleSize), sm[0]); }
  /* "300 oncologists" — a count of the population itself */
  if (sampleSize == null && popM) { const pre = new RegExp(String.raw`\b${NUM}\s+${POPULATION_NOUNS}`, "i").exec(t); if (pre) { sampleSize = num(pre[1]); if (sampleSize != null) sig("sample size", String(sampleSize), pre[0]); } }
  const bm = BASIS_RE.exec(t); const sampleBasis = bm ? bm[0].toLowerCase() : null;
  if (sampleBasis) sig("sample basis", sampleBasis, bm![0]);

  const countries = [...new Set([...t.matchAll(COUNTRY_RE)].map((m) => m[1].replace(/\s+/g, " ")).map((c) => (c === "UK" ? "United Kingdom" : c === "US" || c === "USA" ? "United States" : c === "UAE" ? "United Arab Emirates" : c === "Bengaluru" ? "Bangalore" : c)))];
  for (const c of countries) sig("market", c, c);
  const mm = MARKETS_RE.exec(t); const marketCount = mm ? num(mm[1]) : null;
  if (marketCount) sig("market count", String(marketCount), mm![0]);

  const quotaZone = /\bquotas?\b/i.test(t) ? t : "";
  const quotas: string[] = [];
  if (quotaZone) {
    /* the dimensions named in the sentence(s) that mention quotas */
    const zone = t.split(/(?<=[.!?])\s+/).filter((s) => /\bquotas?\b|\binterlock\w*|\bsplit\b.{0,20}\bby\b/i.test(s)).join(" ");
    for (const [dim, re] of QUOTA_DIMS) { const m = re.exec(zone); if (m) { quotas.push(dim); sig("quota", dim, m[0]); } }
  }

  const languages = [...new Set([...t.matchAll(LANG_RE)].map((m) => m[1]))].filter((l) => !(l === "English" && !/\btranslat|\blanguages?\b|\bin english\b/i.test(t)));
  for (const l of languages) sig("language", l, l);

  const lm = new RegExp(String.raw`\b${NUM}[- ]?(?:minute|min)s?\b`, "i").exec(t);
  const loiMinutes = lm ? num(lm[1]) : null;
  if (loiMinutes) sig("length", `${loiMinutes} minutes`, lm![0]);

  let timelineDays: number | null = null;
  const tm = new RegExp(String.raw`\b(?:in|within|over|finish(?:ed)? in|complete(?:d)? in|field(?:work)? (?:of|in|for))\s+(?:the next\s+)?${NUM}\s+(days?|weeks?|months?)\b`, "i").exec(t);
  if (tm) { const n = num(tm[1]); if (n != null) { timelineDays = n * (/week/i.test(tm[2]) ? 7 : /month/i.test(tm[2]) ? 30 : 1); sig("timeline", `${timelineDays} days`, tm[0]); } }

  const tst = /\bproduction[- ]like\b|\blive[- ]like\b|\bas (?:a )?live respondents?\b|\bexactly as (?:a )?(?:live )?respondents?\b|\bsoft launch\b|\bpilot\b|\bdry run\b/i.exec(t);
  const testing = tst ? "production-like" as const : /\bpreview\b/i.test(t) ? "preview" as const : null;
  if (testing) sig("testing", testing, tst?.[0] ?? "preview");

  const constraints: BriefConstraint[] = [];
  for (const [c, re] of CONSTRAINTS) { const m = re.exec(t); if (m) { constraints.push(c); sig("constraint", c, m[0]); } }
  if (languages.length > 1 && !constraints.includes("translation")) constraints.push("translation");
  const methods: BriefMethodology[] = [];
  for (const [mth, re] of METHODS) { const m = re.exec(t); if (m) { methods.push(mth); sig("methodology", mth, m[0]); } }

  /* a brief: it describes a study — at least two of a type, a population, a size, quotas, a method, an aim — and is not a one-object edit */
  const parts = [types.length > 0, !!population, sampleSize != null, quotas.length > 0, !!method && STUDY.test(t), AIM.test(t) && STUDY.test(t), countries.length > 0 || marketCount != null, loiMinutes != null].filter(Boolean).length;
  const oneObject = /^(?:please\s+)?(?:add|insert|change|rename|delete|remove|move|show|hide|skip|require)\b.{0,80}\b(?:q\d+|question|option|row|block|page)\b/i.test(t) && t.length < 160;
  const isBrief = !oneObject && parts >= 3 && STUDY.test(t);
  /* a study of a population with a size and no qualitative method is measured with a questionnaire */
  const survey = isBrief && method !== "qualitative";
  if (isBrief && method == null) { (signals as BriefSignal[]).push({ what: "method", value: "quantitative", words: sampleSize != null ? `${sampleSize} respondents` : "a study of a population" }); }

  return { isBrief, survey, types, method: method ?? (isBrief ? "quantitative" : null), population, professional, sampleSize, sampleBasis, countries, marketCount, quotas, languages, loiMinutes, timelineDays, testing, constraints, methods, signals };
}

/** one line for a card: "Healthcare · quantitative · doctors in India · n = 1,000 · quotas age, specialty, region · production-like test" */
export function describeBrief(b: ResearchBrief): string {
  const parts: string[] = [];
  if (b.types.length) parts.push(b.types.slice(0, 2).map((x) => x[0].toUpperCase() + x.slice(1)).join(" / "));
  if (b.method) parts.push(b.method);
  if (b.population) parts.push(b.population);
  if (b.sampleSize != null) parts.push(`n = ${b.sampleSize.toLocaleString("en-US")}${b.sampleBasis ? ` ${b.sampleBasis}` : ""}`);
  if (b.marketCount) parts.push(`${b.marketCount} markets`); else if (b.countries.length > 1) parts.push(b.countries.join(", "));
  if (b.quotas.length) parts.push(`quotas ${b.quotas.join(", ")}`);
  if (b.loiMinutes) parts.push(`${b.loiMinutes} min`);
  if (b.timelineDays) parts.push(`${b.timelineDays} days of fieldwork`);
  if (b.languages.length) parts.push(b.languages.join(", "));
  if (b.testing) parts.push(`${b.testing} test`);
  return parts.join(" · ");
}
