/**
 * WHAT INTELLIGENT MODE IS FOR — read BEFORE anything is generated
 * (Intelligent engine reliability, 2026-10-17).
 *
 * One deterministic reading of a request's SCOPE, shared by the engine's
 * interpreter (which answers an unsupported request without a model call)
 * and the copilot route (which never pays for one, and tells the model which
 * part of a mixed request is outside):
 *
 *   supported    a research, survey, analysis, data-quality, reporting,
 *                translation or survey-scripting request — the categories it
 *                touches are listed (a hint for choosing context, never a gate)
 *   mixed        a supported request with a part that is clearly unrelated
 *                to the platform ("add an NPS question and book me a flight"):
 *                the supported part is done, the rest named as outside
 *   unsupported  clearly unrelated to the platform ("write me a poem", "what's
 *                the weather", "book a flight") and nothing supported in it:
 *                answered with UNSUPPORTED_MESSAGE, no model call, no charge
 *   ambiguous    a greeting or a bare "help": one focused question back
 *
 * CONSERVATIVE BY CONSTRUCTION. A false "unsupported" on a real research
 * request is worse than a model call, so a request is unsupported only when
 * it MATCHES an explicit off-topic pattern AND carries no research or survey
 * cue at all — in English, Hinglish or Devanagari. Everything else (follow-ups
 * like "yes, go ahead", a long pasted brief with tables and headings, a
 * sentence the cues miss) stays supported and goes on as before. A long text
 * (over 1,500 characters) is never unsupported.
 */

export type ScopeCategory =
  | "research_planning" | "hypotheses" | "qualitative_design" | "quantitative_design" | "mixed_methods"
  | "survey" | "advanced_methods" | "analysis" | "data_quality" | "reporting" | "translation" | "scripting";

export type RequestScope =
  | { scope: "supported"; categories: ScopeCategory[]; longBrief: boolean }
  | { scope: "mixed"; categories: ScopeCategory[]; longBrief: boolean; outside: string[] }
  | { scope: "unsupported"; categories: []; longBrief: false; outside: string[] }
  | { scope: "ambiguous"; categories: []; longBrief: false; question: string; choices: string[] };

export const UNSUPPORTED_MESSAGE = "This request is outside the supported capabilities of Intelligent Mode. You can use this engine for research planning, hypothesis development, survey design and programming, supported analysis, data-quality workflows, translation, and research reporting.";

/** the one question asked back for a greeting or a bare "help" — with sentences the engine reads as choices */
export const AMBIGUOUS_QUESTION = "What would you like to work on in this study — the research plan, the questionnaire, the analysis, data quality, translation or the report?";
export const AMBIGUOUS_CHOICES = ["Help me plan the research and its hypotheses", "Create a survey from my brief", "Review my survey", "Create an analysis framework"];

/* ------------------------------------------------------------ the cues */

/*
 * Devanagari words take no \b (JavaScript's word boundary is ASCII-only), so
 * each category has a Latin part with boundaries and a Devanagari part without.
 */
const CUES: [ScopeCategory, RegExp][] = [
  ["research_planning", /\b(?:research\w*|stud(?:y|ies)|objectives?|brief|business (?:problem|question|objective)|background|methodolog\w*|methods?|sampl(?:e|es|ing)|population|respondents?|participants?|target (?:audience|group|market|segment)|audience|fieldwork|insights?|market (?:research|sizing|study)|consumers?|customers?|shoppers?|users?|personas?|segments?|u&a|usage (?:and|&) attitudes?|brand (?:health|tracking|tracker|funnel|equity|perception)|awareness|nps|satisfaction|loyalty|churn|panel|incidence|recruit\w*|stakeholders?|deliverables?|kpis?|tracker|wave|benchmark\w*|competitors?|pricing|willingness to pay)\b|शोध|अनुसंधान|रिसर्च|अध्ययन|सर्वे|सर्वेक्षण|उत्तरदाता|नमूना|ग्राहक|उपभोक्ता|लोगों/i],
  ["hypotheses", /\b(?:hypothes\w*|we (?:believe|expect|assume|think)|i (?:believe|expect|assume|think)|predict\w*|mera manna|meri soch)\b|परिकल्पना|हाइपोथीसिस|हाइपोथिसिस|मानना|मेरा मानना/i],
  ["qualitative_design", /\b(?:qualitative|qual|in[- ]depth interviews?|idis?|focus groups?|discussion guides?|interview guides?|moderator guides?|ethnograph\w*|diary stud(?:y|ies)|usability (?:tests?|testing|stud(?:y|ies))|open[- ]ended)\b|गुणात्मक|फोकस ग्रुप|इंटरव्यू|साक्षात्कार/i],
  ["quantitative_design", /\b(?:quantitative|quant|statistic\w*|sample sizes?|margin of error|power analysis|confidence (?:level|interval)|representative|weighting)\b|मात्रात्मक/i],
  ["mixed_methods", /\bmixed[- ]methods?\b/i],
  ["survey", /\b(?:surveys?|questionnaires?|screeners?|screening|questions?|q\d+|options?|answers?|scales?|likert|matrix|grids?|blocks?|page ?breaks?|pages?|logic|skips?|display|branch\w*|loops?|piping|pipe|quotas?|randomi[sz]\w*|rotat\w*|validation|required|mandatory|variables?|embedded data|terminat\w*|screen ?outs?|programm?\w*|routing|flow|items?|statements?|sawaa?l|prashn|banao|banana|bana do|jodo|hatao|rescript|studio|intelligent mode|this (?:project|survey|study)|my (?:project|survey|study)|minutes? (?:long|survey|interview)|loi)\b|प्रश्न|सवाल|क्वेश्चन|क्वेशन|कोशन|ऑप्शन|विकल्प|लूप|स्क्रीन|लॉजिक|सर्वे|पेज|ब्लॉक|बनाओ|बनाइए|बनाना|डिज़ाइन|डिजाइन/i],
  ["advanced_methods", /\b(?:max[- ]?diff|best[- ]worst|conjoint|cbc|acbc|discrete choice|turf|van westendorp|gabor[- ]granger|price sensitivity|kano|segmentation|cluster\w*|driver analysis|key drivers?|list fill|least fill|card sort|implicit|monadic|sequential monadic|a\/b test)\b/i],
  ["analysis", /\b(?:analy[sz]\w*|crosstabs?|cross[- ]tabs?|banners?|tabulat\w*|regression|correlat\w*|anova|t[- ]tests?|chi[- ]?square|significan\w*|frequenc\w*|means?|median|top[- ]?2?[- ]?box|derived variables?|weighting|test (?:the|this|it|whether))\b|विश्लेषण|एनालिसिस/i],
  ["data_quality", /\b(?:data quality|data[- ]cleaning|clean(?:ing)? (?:the )?data|speeders?|straight[- ]?lin\w*|bots?|fraud\w*|duplicates?|attention checks?|trap questions?|red herring|outliers?|missing data|imputation|quality checks?|bad responses|gibberish)\b/i],
  ["reporting", /\b(?:reports?|reporting|decks?|presentations?|slides?|charts?|graphs?|visuali[sz]\w*|dashboards?|executive summary|debrief|topline|word (?:doc|document|file)|docx|pptx|powerpoint|infographics?|findings|results?|storytelling)\b|रिपोर्ट|परिणाम/i],
  ["translation", /\b(?:translat\w*|languages?|locali[sz]\w*|multilingual|bilingual|glossary|hindi|spanish|french|german|japanese|arabic|chinese|portuguese|italian|tamil|telugu|bengali|marathi|gujarati|urdu)\b|अनुवाद|भाषा|हिंदी/i],
  ["scripting", /\b(?:javascript|js|css|html|scripts?|styl(?:e|es|ing)|themes?|animat\w*|behaviou?rs?|branding|layout|buttons?|pop-?ups?|colou?rs?|fonts?|mobile|responsive|hover|ui|ux)\b|जावास्क्रिप्ट|स्क्रिप्ट|सीएसएस|एनिमेशन|थीम|बटन|डिज़ाइन|डिजाइन|लेआउट/i],
];

/*
 * CLEARLY UNRELATED TO THE PLATFORM — explicit shapes only. Each must be
 * unmistakable on its own; a request that also names a survey, a question,
 * a study or any cue above is never unsupported (at most mixed).
 */
const OFF_TOPIC: RegExp[] = [
  /\b(?:write|compose|make|create|give|tell|recite|sing)\s+(?:me\s+|us\s+)?(?:a\s+|an\s+|some\s+|the\s+)?(?:short\s+|funny\s+|love\s+|little\s+|nice\s+)?(?:poems?|poetry|haikus?|limericks?|sonnets?|song|songs|song lyrics|lyrics|rap|jokes?|riddles?|(?:bedtime |short |love )?stor(?:y|ies)|fairy ?tales?|novel|screenplay)\b/i,
  /\b(?:poem|poetry|haiku|limerick|sonnet|lyrics|joke|riddle)\s+(?:about|on|for)\b/i,
  /\btell me a (?:joke|story|riddle)\b/i,
  /\b(?:book|reserve|find me|get me|buy)\s+(?:me\s+|us\s+)?(?:a\s+|an\s+|the\s+|two\s+|cheap\s+)?(?:flights?|plane tickets?|air ?tickets?|hotels?|hotel rooms?|train tickets?|bus tickets?|movie tickets?|tickets? to|cabs?|taxis?|ubers?|tables? (?:at|for)|restaurants?)\b/i,
  /\bflights? (?:from|to) [a-z]/i,
  /\b(?:what(?:'s| is)|how(?:'s| is)|tell me|show me|check)\s+(?:the\s+)?weather\b|\bweather (?:forecast|today|tomorrow|this week|in [a-z])/i,
  /\bwill it rain\b/i,
  /\b(?:recipe|recipes) (?:for|of)\b|\bhow (?:do i|to) (?:cook|bake|make) (?:a |an |the )?(?:cake|pizza|pasta|curry|biryani|bread|cookies|dinner|lunch|breakfast)\b/i,
  /\b(?:cricket|football|soccer|nba|ipl|match) scores?\b|\bwho won the (?:match|game|world cup|election|super bowl)\b/i,
  /\b(?:stock|share|bitcoin|crypto|ethereum|gold) prices?\b(?! sensitivity)|\bexchange rate\b/i,
  /\b(?:set|create) (?:an? )?(?:alarm|timer|reminder)\b/i,
  /\b(?:play|stream) (?:some )?(?:music|a song|songs|a movie|netflix|spotify)\b/i,
  /\border (?:me )?(?:food|pizza|a pizza|groceries|dinner|lunch)\b/i,
  /\b(?:directions|navigate|route) to (?:the )?(?:airport|station|nearest|[a-z]+ (?:street|road|mall))\b/i,
  /\bwrite (?:me |my )?(?:an? )?(?:cover letter|resume|cv|wedding speech|love letter|birthday (?:message|wish))\b/i,
  /\b(?:do|solve|finish) (?:my )?(?:homework|assignment)\b/i,
  /\b(?:generate|draw|create|make) (?:me )?(?:an? )?(?:image|picture|photo|drawing|painting|logo|avatar|wallpaper) of\b/i,
  /\b(?:medical|legal|tax|investment) advice\b|\bfile my tax(?:es| return)\b/i,
  /\b(?:build|make|code|write) (?:me )?(?:a |an )?(?:website|web app|mobile app|android app|ios app|video game|game|chatbot|discord bot|telegram bot)\b(?! survey)/i,
  /\bwho is the (?:president|prime minister|ceo) of\b|\bwhat is the capital of\b/i,
  /कविता|चुटकुला|मौसम कैसा|मौसम क्या|टिकट बुक|फ्लाइट बुक|होटल बुक|गाना सुनाओ|कहानी सुनाओ/,
  /\b(?:kavita|shayari) (?:likho|sunao)\b|\bjoke sunao\b|\bmausam (?:kaisa|kya)\b|\b(?:ticket|flight|hotel) book karo\b/i,
];

/** a greeting, thanks, or a bare request for help — nothing to act on yet */
const GREETING = /^(?:hi+|hello+|hey+|hiya|yo|namaste|namaskar|नमस्ते|नमस्कार|good (?:morning|afternoon|evening)|greetings|help|help me|can you help(?: me)?|what can you do|what do you do|how does this work)[\s!?.,]*$/i;

/** the categories a text touches — every cue that matches */
export function scopeCategories(text: string): ScopeCategory[] {
  return CUES.filter(([, re]) => re.test(text)).map(([c]) => c);
}

const offTopic = (text: string): boolean => OFF_TOPIC.some((re) => re.test(text));

/** the clauses of a request: sentences, and the parts joined by "and also", "and then", ";", "also" — enough to name the outside part */
function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?।])\s+|\s*;\s*|\s*\n+\s*|,?\s+(?:and\s+(?:also\s+|then\s+)?|also\s+|then\s+|plus\s+|aur\s+(?:phir\s+)?|और\s+)(?=\S)/i)
    .map((s) => s.trim().replace(/^(?:and|also|then|plus|aur|और)\s+/i, ""))
    .filter((s) => s.length > 1);
}

/**
 * A pasted brief: long, or structured like one (headings, numbered sections,
 * bullet lists, tables) with research words. Never a reason to reject — a
 * reason to plan first and to keep every section.
 */
export function isLongBrief(text: string): boolean {
  const t = text.trim();
  if (t.length >= 1500) return true;
  const structure = (t.match(/^\s*(?:#{1,6}\s|\d+[.)]\s|[-*•]\s|\|)/gm) ?? []).length;
  return t.length >= 600 && structure >= 4 && scopeCategories(t).length >= 2;
}

/** The scope of one request. Pure, deterministic, cheap — read before any model is called. */
export function requestScope(text: string): RequestScope {
  const t = (text ?? "").normalize("NFC").trim();
  const longBrief = isLongBrief(t);
  const categories = scopeCategories(t);
  if (!t) return { scope: "supported", categories, longBrief };
  if (GREETING.test(t)) return { scope: "ambiguous", categories: [], longBrief: false, question: AMBIGUOUS_QUESTION, choices: AMBIGUOUS_CHOICES };
  if (longBrief || !offTopic(t)) return { scope: "supported", categories, longBrief };
  if (!categories.length) return { scope: "unsupported", categories: [], longBrief: false, outside: [t.slice(0, 200)] };
  /* both: the clauses that are off-topic and carry no cue are the outside part; when no clause stands apart, the off-topic words serve the survey ("a poem-style intro for the survey") */
  const outside = clauses(t).filter((c) => offTopic(c) && !scopeCategories(c).length).map((c) => c.slice(0, 200));
  return outside.length ? { scope: "mixed", categories, longBrief, outside } : { scope: "supported", categories, longBrief };
}

/** the sentence a mixed request's answer ends with: which part was outside, and what Intelligent Mode is for */
export function outsideNote(outside: readonly string[]): string {
  const parts = outside.slice(0, 3).map((p) => `“${p.replace(/[.!?।]+$/, "")}”`).join(", ");
  return `${outside.length === 1 ? "This part of your request is" : "These parts of your request are"} outside the supported capabilities of Intelligent Mode and ${outside.length === 1 ? "was" : "were"} not done: ${parts}. You can use this engine for research planning, hypothesis development, survey design and programming, supported analysis, data-quality workflows, translation, and research reporting.`;
}
