/**
 * THE AUDIENCE GUIDE (2026-11-03) — how Intelligent Mode turns "US adults 25–45 who bought a car last year"
 * into a structured `definition.audience` the recruitment exchange can price (engine `recruitmentActions.ts`).
 *
 * Sent only when a request is about who a study is recruiting (`audienceIntent`), lifted into the cached system
 * prefix like every other guide (`aiPromptCache.ts`); the system prompt is not touched.
 *
 * The two things this guide exists to prevent:
 *
 *   1. A model inventing a country code. "UK" is not one — GB is — and a rate card keyed on a code that does not
 *      exist prices nothing and looks like a vendor problem. The engine refuses an unrecognised country rather
 *      than guessing, and the guide says so, so the model asks instead of inventing.
 *   2. A model treating a refinement as a replacement. "Also make it 50/50 men and women" must not drop the
 *      income band the researcher set two turns ago. The engine merges by default; the guide tells the model it
 *      only needs to send what CHANGED.
 */
export const COPILOT_AUDIENCE_GUIDE = `AUDIENCE — who a study recruits. The structured specification the sample vendors are priced and bought against (Fieldwork → Recruitment).
define_audience {audience: {demographics: {countries: ["US","GB"], ageMin, ageMax, genders: ["male"|"female"|"other"], incomeBands: [], education: [], employment: [], occupation: [], householdSize: [], maritalStatus: [], children: "with"|"without", regions: [], cities: []}, advanced: {industries: [], jobTitles: [], seniority: [], decisionAuthority: "influencer"|"decision_maker"|"sole_decision_maker", companySize: [], productOwnership: [], brandUsage: [], purchaseBehaviour: [], technologyUsage: [], lifestyle: []}, screeners: [{id, text, qualifyingAnswers: [], expectedIncidence}], quotas: [{id, label, target, mode: "count"|"percent"}]}, from: "<what the researcher typed>", replace?: true}
clear_audience {} — removes it (destructive, confirmed).
COUNTRIES are ISO alpha-2: US, GB, DE, FR, IN, AU. "UK" is NOT a code — the United Kingdom is GB. Full names work ("United States", "Germany"). An unrecognised country is REFUSED, not guessed: if you are unsure what country they mean, ask.
REFINING MERGES. Send only what changed — a later "make it women" keeps the income band and the age range already set. Only send replace: true when the researcher asks to start the audience again.
Targeting the vendor cannot express belongs in screeners (asked inside the survey), not in demographics. A screener costs incidence, so say when you add one.
Several countries means several markets: say that a completes target per market is set in Fieldwork → Recruitment, or the whole study is priced against the first one.
Never say sample was bought, a vendor was contacted or feasibility was checked — this writes a specification, nothing more.
{"op":"define_audience","audience":{"demographics":{"countries":["US"],"ageMin":25,"ageMax":45}},"from":"US adults 25 to 45"}
{"op":"define_audience","audience":{"demographics":{"countries":["US"],"genders":["female"]},"quotas":[{"id":"q1","label":"Women 25-34","target":50,"mode":"percent"}]}}
{"op":"clear_audience"}
THE FIELDWORK PLAN (IM5) — set_fieldwork_plan {plan: {completes, startDate, endDate (YYYY-MM-DD), fieldDays, softLaunch, dailyTarget, loiMinutes?, incidence?, invitations?, cpi?, budget?, currency?, cost?, markets [{market, completes}], milestones [{date, what}], risks [{risk, because, mitigation}], basis {field: where the number came from}}} | {plan: null}. Prefer the engine's own plan ("Plan the fieldwork: …" is read without you); never write a cost without a CPI or budget the researcher gave — the rate cards price it in Recruitment → Plan.
{"op":"set_fieldwork_plan","plan":{"completes":600,"startDate":"2026-12-01","endDate":"2026-12-14","fieldDays":14,"softLaunch":60,"dailyTarget":45,"markets":[{"market":"GB","completes":600}],"milestones":[{"date":"2026-12-01","what":"Soft launch: 60 completes"}],"risks":[],"basis":{"completes":"the brief"}}}`;

/** a request about who a study is recruiting */
export function audienceIntent(text: string): boolean {
  if (/\bfieldwork\s+plan\b|\bplan\s+the\s+fieldwork\b|\bset_fieldwork_plan\b|\bdaily\s+(?:completes|targets?)\b/i.test(text)) return true;
  return /\b(?:target |define |set |change |build |who is )?(?:the )?audience\b|\btarget(?:ing| group| market| respondents?)\b|\bwho (?:are we|should we|do we want to|we) (?:recruit|target|survey|interview)\b|\brecruit(?:ing)? (?:people|respondents?|adults?|consumers?|men|women)\b|\bsample (?:specification|spec|definition|criteria)\b|\bscreen(?:er|ing) (?:question|criteria)\b|\bincidence rate\b|\bquota cells?\b|\bnat(?:ional)?ly representative\b|\bdefine_audience\b|\bclear_audience\b/i.test(text)
    || /ऑडियंस|लक्षित/.test(text);
}
