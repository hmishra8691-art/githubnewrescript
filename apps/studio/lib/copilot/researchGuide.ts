import { capabilityBrief } from "@rescript/engine";
import { COPILOT_QUAL_STUDY_GUIDE } from "./qualStudyGuide.ts";

/**
 * THE RESEARCH GUIDE AND THE QUALITATIVE GUIDE (Research intelligence, 2026-10-17).
 *
 * Sent only when a request needs them (`researchPlanIntent`, `qualIntent`), like the methods and
 * List Fill guides, and lifted into the cached system prefix by `aiPromptCache.ts`. The system
 * prompt says to generate from an objective; it did not say in what order a study is planned, how
 * a method is chosen for a pair of variables, what may be called applied or executed, how a
 * qualitative guide or a phased mixed-methods plan is built here, or which methods the platform
 * runs only partly. The engine checks all of it — `validateResearch` (blocking / warnings /
 * recommendations), `researchTraceability` (objective → … → limitations, with its gaps),
 * `planItemSuitability` (the selection rules) and the capability registry, whose generated brief
 * ends the research guide so the model is told what exists from the registry, not from prose.
 * Every `{"op":…}` line is applied by the engine as written (`researchGuide.test.ts`).
 */

export const COPILOT_RESEARCH_GUIDE = `RESEARCH GUIDE — planning a study end to end. Work in this order, every link as an action, nothing left implicit:
1 PROBLEM → set_research "brief" (businessQuestion, decision, background), "population", "audience".
2 OBJECTIVES: ONE primary "objective"; the supporting objectives as "researchQuestions".
3 HYPOTHESES: testable — a direction, an independent and a dependent construct (set_hypothesis records the reading). A descriptive aim needs none; qualitative work states propositions as researchQuestions, not hypotheses.
4 METHODOLOGY: "methodology" names the design AND why it fits ("online survey, n=400, monadic concept test: a clean read per concept"); what you assumed goes in "assumptions".
5 CONSTRUCTS: "constructs" with role independent / dependent / mediator / moderator / control (a confounder) — set_question_analysis links each question to its construct and hypotheses.
6 INSTRUMENT: balanced, complete scales; None / Other / Don't know where an answer can fall outside the list; validation (ranges; analysis variables required); routing; quotas; randomisation (option order; monadic arms recorded by create_embedded in each block).
7 SAMPLING: "sampleSize" (or quotas) and its limits.
8 ANALYSIS: one planned item per hypothesis carrying "hypotheses", chosen by the rules below; the engine picks each method's chart.
9 The Studio then VALIDATES the study (blocking / warnings / recommendations) and builds its TRACEABILITY matrix (objective → hypothesis → construct → questions → variables → analysis → chart → interpretation → limitations). Never claim either passes.
SELECTION RULES (the engine flags the rest): 2 groups × scale → t_test; 3+ groups × scale → anova (ordinal or skewed: mann_whitney / kruskal_wallis); categories × categories → chi_square (≥ 5 expected per cell — state the sample); scale × scale → correlation; one outcome, several predictors → ONE regression (numeric or two-category predictors; a multi-select or 3+ category predictor is dummy-coded first); a two-category outcome → logistic_regression; a multi-item construct → reliability; open text → text_themes only. NEVER a multi-select as the groups of a test (its options overlap — crosstab each option), a mean of unordered categories, a test on open text.
STATUS WORDS — say which applies, never more: RECOMMENDED (your advice, not built), GENERATED (the actions in this reply, awaiting the researcher's approval), APPLIED (only after the researcher applied them — never in a proposal), EXECUTED (only when the outline shows an analysis run). Until a run's verdict says otherwise a hypothesis is PLANNED: never write that the data shows, supports or rejects anything.
MIXED METHODS — a phased plan: phase 1 qualitative (open questions with probes, QUALITATIVE GUIDE) → propositions → phase 2 quantitative hypotheses. The methodology says "Phase 1 … → Phase 2 …"; phase 1's questions are researchQuestions, phase 2's are hypotheses; qualitative themes are evidence, never population percentages or a hypothesis verdict.
ADVANCED METHODS — state objective → design parameters → questions / variables → randomisation → data capture → analysis → chart. MaxDiff, conjoint → METHODS GUIDE actions. Monadic concept test: one block per concept under create_randomizer show 1, an arm variable (create_embedded) set in each block, anova / t_test across it. Sequential monadic: a randomizer showing every concept block. TURF: a multi-select reach question + turf. Van Westendorp: four numeric price questions (too cheap, cheap, expensive, too expensive) + ONE pricing item over them in that order. Gabor–Granger: purchase intent at ascending prices. Segmentation: a needs battery + factor and cluster. Brand funnel: one multi-select per stage over the same brands + brand_funnel. Drivers: attribute ratings + the outcome + regression. What the registry below marks partial or not supported: write the specification into "assumptions", say "not executable in Rescript" in the reply, offer the supported alternative.
{"op":"set_research","objective":"Decide whether a price cut reduces switching among broadband customers","brief":{"businessQuestion":"Should we cut the price of the Basic plan?","decision":"whether to cut the Basic price in Q2"},"researchQuestions":["How do customers judge the value of their plan?"],"hypotheses":["Higher price perception increases switching intention"],"population":"UK broadband bill payers aged 18+","sampleSize":400,"methodology":"Online quantitative survey, n=400: a regression of switching intention on price perception, tenure held constant","constructs":[{"name":"Price perception","role":"independent","definition":"how expensive the plan feels for what it gives"},{"name":"Switching intention","role":"dependent"},{"name":"Tenure","role":"control"}],"assumptions":["Stated intention stands in for switching behaviour"]}
{"op":"set_hypothesis","hypothesis":"H1","detail":{"type":"causal","direction":"positive","independent":"Price perception","dependent":"Switching intention","expectedEffect":"medium"}}
{"op":"set_question_analysis","target":"PRICE_PERC","role":"independent","construct":"Price perception","hypotheses":["H1"]}
{"op":"set_question_analysis","target":"SWITCH","role":"dependent","construct":"Switching intention","hypotheses":["H1"]}
{"op":"set_question_analysis","target":"TENURE","role":"control","construct":"Tenure"}
{"op":"add_analysis_test","method":"regression","outcome":"SWITCH","variables":["PRICE_PERC","TENURE"],"hypotheses":["H1"],"reason":"does price perception drive switching, tenure held constant"}
${capabilityBrief()}`;

export const COPILOT_QUAL_GUIDE = `QUALITATIVE GUIDE — two forms. Inside a survey, qualitative research is a SELF-COMPLETION INTERVIEW GUIDE: open questions the respondent types or dictates, each followed by AI probes the runtime writes from the answer (set_probe). A study run by a moderator is planned with create_qual_guide (end of this guide). The self-completion guide:
• set_research: "objective", the topics as "researchQuestions", "methodology" ("Qualitative self-completion interview guide with AI follow-up probes"), and one construct per topic (role "descriptive", "questions" = the refs that explore it) — that is what maps the guide to its objectives.
• FLOW: a warm-up block (an easy question about the respondent's context) → one block per research question (2–4 open questions, broad then specific, neutral, one idea each) → a wrap-up ("Is there anything else you would like to add?"). long_text for stories, open_text for short answers; not required.
• PROBES: set_probe on each topic question — maxProbes 1–3, an "instruction" for what to dig for (an example, the reason, the feeling, what happened next); a fixed "prompt" only for one standard follow-up; "minWords" to skip one-word answers; "when" to probe only some answers; "probe": null removes it.
• ANALYSIS: add_analysis_test method text_themes per topic question — word and phrase counts, sentiment, a keyword coding frame. Themes are qualitative evidence: never population percentages, never a hypothesis verdict.
{"op":"create_question","ref":"TRIGGER","block":"Triggers","type":"long_text","text":"Think about the last time you considered switching provider. What happened?","required":false}
{"op":"set_probe","target":"TRIGGER","maxProbes":2,"minWords":3,"instruction":"Ask what tipped the decision and for a concrete example."}
{"op":"set_research","objective":"Explore why customers switch broadband provider","methodology":"Qualitative self-completion interview guide with AI follow-up probes","researchQuestions":["What triggers customers to consider switching?"],"constructs":[{"name":"Switching triggers","role":"descriptive","questions":["TRIGGER"]}]}
{"op":"add_analysis_test","method":"text_themes","variables":["TRIGGER"],"reason":"RQ1: what triggers switching"}
LIVE human-moderated interviews / focus groups run in Research Tools → Qualitative → Live sessions (the Interviews app is a hiring product). NOT SUPPORTED — say so plainly: video of the respondent in a survey, quotes in the survey findings deck (the qualitative report in Research Tools → Qualitative carries verbatim, reviewed quotes). Spoken answers: dictation is on for every open text field; a video_interview question (added in the Studio editor) plays a stimulus and records a transcribed spoken answer.
${COPILOT_QUAL_STUDY_GUIDE}`;

/**
 * A request that plans or designs research — a brief, objectives, hypotheses, a methodology, a
 * sample, a mixed or advanced design, the traceability — or any generation: the research guide
 * goes with it.
 */
export function researchPlanIntent(text: string, mode?: string): boolean {
  if (mode === "generate") return true;
  return /\bresearch (?:brief|plan|design|objectives?|questions?|proposal)\b|\b(?:study|survey) design\b|\bhypothes[ie]s\b|\bmethodolog\w*|\bsampl(?:e size|ing)\b|\bobjectives?\b|\bpropositions?\b|\bconstructs?\b|\bconfound\w*|\btraceab\w*|\bmixed[\s-]?methods?\b|\bqualitative\b|\bquantitative\b|\bconcept test\w*|\bmonadic\b|\bvan[\s-]?westendorp\b|\bgabor[\s-]?granger\b|\bturf\b|\bsegmentation\b|\bbrand (?:funnel|equity)\b|\bpricing (?:study|research)\b|\banalysis plan\b|\bwhich (?:test|method|methodology)\b|\bvalidate (?:the|my|this) (?:study|research|design|plan)\b/i.test(text) || /हाइपोथीसिस|हाइपोथिसिस|आइपोथीसिस|परिकल्पना|रिसर्च\s+(?:डिज़ाइन|डिजाइन|प्लान)|क्वालिटेटिव|क्वांटिटेटिव|गुणात्मक|मात्रात्मक/.test(text);
}

/** a request about qualitative research — an interview guide, probes, open-ended exploration, a mixed design */
export function qualIntent(text: string): boolean {
  return /\bqualitative\b|\bqual\b|\binterview guide\b|\bdiscussion guide\b|\bin[\s-]depth interviews?\b|\bidis?\b|\bfocus groups?\b|\bprob(?:e|es|ing)\b|\bfollow[\s-]?up questions?\b|\bopen[\s-]ended\b|\bexplorator\w*\b|\bethnograph\w*|\bdiary stud\w*|\bmixed[\s-]?methods?\b|\bthemes? (?:analysis|coding)\b|\bverbatims?\b|\bmoderat\w*|\btranscripts?\b|\bcodebook\b|\bthematic\b/i.test(text) || /क्वालिटेटिव|क्वालीटेटिव|गुणात्मक|इंटरव्यू\s+गाइड|फोकस\s+ग्रुप|کوالیٹیٹو/.test(text);
}
