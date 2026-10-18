/**
 * A ~25,000-character ChatGPT-style "master prompt" research brief, written
 * for the tests (modelled on the production evidence of 2026-10-16: a pasted
 * brief with a role, a business problem, objectives, hypotheses, methods,
 * questionnaire requirements, analysis and reporting instructions — headings,
 * numbered sections, bold, rules, tables). Plain JavaScript so the Studio's lib
 * tests (type-stripped TypeScript) and the browser suites (.mjs) share it.
 */

const tools = [
  ["Survey programming", "Rescript, Qualtrics, Decipher (Forsta), Confirmit, SurveyMonkey, Alchemer, QuestionPro, Typeform"],
  ["Panel and sample", "Cint, Dynata, PureSpectrum, Toluna, Lucid marketplace, proprietary communities, client CRM lists"],
  ["Qualitative platforms", "Recollective, itracks, Discuss.io, Zoom with transcription, FocusVision, Remesh"],
  ["Data processing", "SPSS, Q Research Software, Displayr, WinCross, Quantum, R, Python (pandas), Excel macros"],
  ["Text analytics", "Ascribe, Canvs, Relative Insight, in-house coding frames, LLM-assisted coding"],
  ["Visualisation and reporting", "PowerPoint templates, Tableau, Power BI, Displayr dashboards, Infogram, Flourish"],
  ["Project management", "Asana, Jira, Monday.com, Smartsheet, email and spreadsheets"],
  ["Quality and fraud control", "Research Defender, Imperium, digital fingerprinting, speeder and straight-liner rules, open-end checks"],
  ["Translation and localisation", "agency translators, machine translation with review, back-translation, glossary management"],
  ["AI and automation", "LLM questionnaire drafting, automated charting, AI summarisation of open ends, synthetic sample pilots"],
];

const stages = [
  ["Briefing", "Receiving and clarifying the client brief, aligning on the business decision, scoping budget and timing"],
  ["Proposal", "Writing the research proposal, choosing the methodology, costing sample and fieldwork, getting sign-off"],
  ["Research design", "Translating objectives into hypotheses, constructs and the sampling plan; defining quotas and incidence"],
  ["Questionnaire design", "Drafting the questionnaire, reviewing it with the client, iterating wording and flow"],
  ["Programming", "Scripting the survey, logic, piping, loops, quotas and randomisation; building the test links"],
  ["Testing and QA", "Link testing, logic checks, soft launch, dummy data, translation checks, device testing"],
  ["Fieldwork", "Launching, monitoring incidence, length of interview, quotas and drop-outs; managing the panel"],
  ["Data cleaning", "Removing speeders, straight-liners, duplicates and bots; checking open ends; final data sign-off"],
  ["Data processing", "Coding open ends, building tables and banners, weighting, derived variables"],
  ["Analysis", "Significance testing, drivers, segmentation, MaxDiff and conjoint where used, synthesis"],
  ["Reporting", "Charts, storyline, executive summary, recommendations, the final deck and the debrief"],
  ["Delivery and follow-up", "Dashboards, data files, workshops, archiving, client feedback and the next wave"],
];

const regions = ["North America", "Latin America", "Western Europe", "Central and Eastern Europe", "Middle East and Africa", "South Asia (incl. India)", "South-East Asia", "Greater China", "Japan and Korea", "Oceania"];

const sections = [
  { title: "Screening and firmographics", purpose: "qualify respondents as market research professionals and profile their organisation", asks: ["current role and seniority", "type of organisation (full-service agency, specialist agency, field and tab supplier, client-side insights team, independent consultant, technology vendor)", "company size in employees and annual research revenue", "countries and regions covered", "years of experience in market research", "industries served (FMCG, healthcare, technology, financial services, media, automotive, retail, public sector)"] },
  { title: "Research portfolio", purpose: "measure the mix of work and how it is changing", asks: ["share of projects that are quantitative, qualitative and mixed methods", "share of online, telephone, face-to-face and mobile fieldwork", "the methodologies used in the last 12 months (U&A, brand tracking, ad testing, concept testing, pricing, segmentation, customer experience, UX research)", "expected change in each over the next two years"] },
  { title: "Technology stack", purpose: "map the tools used at each stage and satisfaction with them", asks: ["the platforms used for each workflow stage, as a grid of stages by tools", "primary platform for survey programming and why it was chosen", "satisfaction with each primary tool on a 0–10 scale", "the main frustrations with the current stack", "integrations used and integrations missing"] },
  { title: "End-to-end workflow", purpose: "measure the time, effort and pain at each stage of a typical project", asks: ["for a typical 20-minute online survey, the elapsed days and person-hours per stage", "the stages that cause the most delays and rework", "how often a questionnaire is re-programmed after client changes", "the share of projects with a soft launch and the issues it finds"] },
  { title: "Questionnaire design and programming", purpose: "understand how questionnaires are written and scripted", asks: ["who writes questionnaires and who programs them", "use of templates and question libraries", "use of advanced logic (loops, piping, quotas, randomisation, MaxDiff, conjoint)", "how long programming and testing take", "the most common programming errors that reach the field"] },
  { title: "Data quality", purpose: "measure the size of the data-quality problem and the controls used", asks: ["estimated share of completes removed for poor quality", "the checks used (speeders, straight-lining, attention checks, open-end review, digital fingerprinting)", "who makes the final call on removal", "confidence in the quality of online sample on a 5-point scale"] },
  { title: "Analysis and reporting", purpose: "map how data becomes insight", asks: ["tools used for tables, statistics and charting", "time spent on charting versus interpretation", "use of dashboards and automated reports", "the deliverables clients value most"] },
  { title: "AI adoption", purpose: "measure current and planned use of AI across the workflow", asks: ["the stages where AI is used today, piloted, planned or not considered", "the perceived benefits and risks of AI in research", "policies on client data and AI", "willingness to adopt an AI-native research platform"] },
  { title: "Buying process and pricing", purpose: "understand how platforms are chosen and what they are worth", asks: ["who is involved in choosing a research platform", "the decision criteria and their relative importance (MaxDiff of 12 criteria)", "current annual spend on research technology", "price sensitivity for an end-to-end platform (Van Westendorp)"] },
  { title: "Demographics and close", purpose: "profile the respondent and close the interview", asks: ["age band", "gender", "highest education", "country of residence", "willingness to take part in a follow-up interview"] },
];

const hypotheses = [
  "Agencies that use three or more separate tools across the workflow report more delays between questionnaire sign-off and field launch than agencies on an integrated platform.",
  "Programming and testing account for more person-hours than questionnaire writing for projects with advanced logic (loops, quotas, MaxDiff or conjoint).",
  "Client-side insights teams are more likely than agencies to have piloted AI for questionnaire drafting, but less likely to use it in production.",
  "Concern about data quality is higher among respondents who rely on marketplace sample than among those using proprietary panels or communities.",
  "Satisfaction with the primary survey platform is driven more by logic flexibility and support than by price.",
  "Respondents in South Asia and South-East Asia expect faster growth in mobile-first fieldwork than respondents in Western Europe and North America.",
  "Willingness to adopt an AI-native platform is higher among smaller agencies (under 50 employees) than among large networks.",
  "Time spent on charting and report production is the stage researchers most want to automate.",
];

const glossary = [
  ["Full-service agency", "an agency that designs, fields, analyses and reports research end to end, usually across several methodologies"],
  ["Field and tab supplier", "a supplier that programs, fields and tabulates studies designed by someone else"],
  ["Client-side insights team", "the research or insights function inside a brand owner, retailer, bank, publisher or public body"],
  ["Stack fragmentation", "the number of distinct software products a project passes through from brief to debrief"],
  ["Person-hours", "the total working hours of everyone involved in a stage, not the elapsed calendar time"],
  ["Elapsed days", "calendar days from the start of a stage to its sign-off, including waiting for the client"],
  ["Rework", "any stage repeated because of a change or an error found later (for example re-programming after a wording change)"],
  ["Soft launch", "the first 5–10% of fieldwork, after which the data are checked before the rest is released"],
  ["Advanced logic", "loops, piping, quotas, randomisation, MaxDiff, conjoint, or custom scripting"],
  ["AI adoption stage", "not considered / considering / piloting / in production for some projects / in production for most projects"],
  ["Primary platform", "the survey platform used for the majority of the respondent's projects in the last 12 months"],
  ["Data-quality removal rate", "the share of completes removed before analysis for any quality reason"],
];

const stageQuestions = stages.map(([name]) => `- **${name}:** elapsed days and person-hours for a typical 20-minute online study; the tools used (multi-select from the reference list); satisfaction with how the stage runs today (5-point); the single biggest frustration (open end, coded later); whether AI is used at this stage (adoption stage scale).`);

const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

export const MASTER_PROMPT_BRIEF = `# Master Prompt: Global Market Research Industry Survey, Technology Stack & End-to-End Research Workflow Analysis

---

## 1. Your Role

Act as a **senior market research consultant**, survey methodologist, quantitative and qualitative research expert, research operations specialist, data analyst, and B2B market strategist. You have 20+ years of experience designing global B2B studies among research professionals. You write questionnaires that are unbiased, mobile-friendly, logically programmed and analysable, and you challenge assumptions where the brief is weak.

---

## 2. Business Problem

Our company is planning an **AI-native, end-to-end research platform** that covers research design, questionnaire writing, survey programming, fieldwork management, data cleaning, analysis and reporting in one place. Before we commit the product roadmap and the go-to-market budget for the next 24 months, we need **robust, quantified evidence** of:

- how market research agencies and client-side insights teams work today, stage by stage;
- which tools they use at each stage, how satisfied they are, and where the stack breaks;
- where time, money and quality are lost across the workflow;
- how far AI has already been adopted, and what would make researchers trust it;
- how platforms are bought, by whom, and at what price points.

**The decision this research supports:** which workflow stages to build first, which segments to target first, and how to price the platform.

---

## 3. Background

The research industry is fragmented: a typical project moves through a proposal in a word processor, a questionnaire in a document, programming in one platform, sample from a marketplace, tables in a separate tool, charts in presentation software and a dashboard in a BI tool. Hand-offs between these steps create rework and errors. At the same time, AI tools are entering every stage, client budgets are under pressure, and data-quality concerns about online sample are rising. Previous studies by industry associations covered tool usage at a high level but did not measure **time and effort by stage**, nor the **interaction between the stack and the workflow**.

---

## 4. Research Objectives

**Primary objective:** quantify the end-to-end research workflow and technology stack of market research professionals globally, and identify the stages with the greatest unmet need.

**Secondary objectives:**
1. Profile the market by organisation type, size, region and research portfolio.
2. Map the technology stack at each workflow stage, with satisfaction and switching intent.
3. Measure elapsed time and person-hours per stage for a typical project.
4. Size the data-quality problem and the controls in use.
5. Measure current, piloted and planned AI use by stage, with perceived benefits and risks.
6. Rank the decision criteria for choosing a research platform (MaxDiff).
7. Estimate price sensitivity for an end-to-end platform (Van Westendorp).
8. Identify segments with distinct needs (cluster analysis on workflow pain and attitudes).

---

## 5. Hypotheses to Test

${hypotheses.map((h, i) => `**H${i + 1}.** ${h}`).join("\n\n")}

---

## 6. Target Audience and Screening Criteria

- **Who:** professionals working in market research or consumer/customer insights, at agencies, field and tab suppliers, independent consultancies, technology vendors or client-side insights teams.
- **Include:** respondents who have personally worked on at least **two research projects in the last 12 months**, and who are involved in at least one of: research design, questionnaire writing, programming, fieldwork, data processing, analysis or reporting.
- **Exclude:** students, people who only commission research occasionally, and people working in advertising or PR without a research role. Terminate respondents who fail the attention check or who work for a competitor of the sponsor (list to be supplied).
- **Seniority mix:** at least 30% director level or above.
- **Regions:** ${regions.join(", ")}.

### Quotas (n = 1,200 completes)

${table(["Region", "Minimum completes", "Notes"], regions.map((r, i) => [r, String(i < 3 ? 160 : i < 7 ? 110 : 80), i === 5 ? "include Hindi-speaking respondents; offer the survey in English and Hindi" : i === 7 ? "Simplified Chinese version required" : "English master questionnaire"]))}

Soft quotas on organisation type: agencies 50%, client-side 30%, others 20%.

---

## 7. Methodology

- **Mode:** online quantitative survey, mobile-first, **25–30 minutes** maximum length of interview.
- **Sample:** a blend of B2B panel sample and the sponsor's opt-in research community; de-duplicated across sources.
- **Languages:** English master; Hindi, Simplified Chinese, Japanese, Spanish (Latin America) and Portuguese (Brazil) versions.
- **Advanced methods:** a **MaxDiff** exercise on 12 platform selection criteria (each respondent sees 9 screens of 4 items), and **Van Westendorp** price sensitivity questions with a Newton–Miller–Smith purchase-intent extension.
- **Loops:** the stage-level questions (time, effort, tools, satisfaction) are asked in a **loop over the workflow stages the respondent is involved in** — not over all twelve.
- **Qualitative follow-up:** 20 in-depth interviews with respondents who opt in, to explore the biggest pain points (discussion guide to follow later; not part of this questionnaire).

---

## 8. Questionnaire Requirements

Write the questionnaire in the following sections, in this order. Every question must have a code, a variable name, the question type, the full wording, the answer options with codes, the instruction text, and the programming notes (logic, piping, randomisation, validation).

${sections.map((s, i) => `### 8.${i + 1} ${s.title}

**Purpose:** ${s.purpose}.

Must cover:
${s.asks.map((a) => `- ${a}`).join("\n")}
`).join("\n")}

### General questionnaire rules

- Use **5-point balanced scales** with labelled end points unless stated otherwise; NPS on 0–10.
- Randomise the order of option lists where order could bias the answer; keep "Other (please specify)" and "None of these" anchored at the bottom.
- Add an **attention check** in the technology stack section.
- Use **display logic** so that questions about a tool are only shown to users of that tool.
- Pipe the respondent's organisation type and primary platform into later questions where it helps.
- Keep grids to a maximum of 8 rows on mobile; split longer grids.
- Every hypothesis above must be measurable from at least one question; tag each question with the hypotheses it serves.

---

## 9. Technology Stack Reference

Use these as the answer lists for the tool questions (add "Other (please specify)" and "None / not applicable" to each):

${table(["Workflow area", "Tools to list"], tools)}

---

## 10. Workflow Stages Reference

Use these stage definitions for the loop and the stage-level grids:

${table(["#", "Stage", "What it includes"], stages.map((s, i) => [String(i + 1), s[0], s[1]]))}

---

## 11. Analysis Plan

- **Crosstabs:** every key measure by region, organisation type, company size, seniority and primary platform; column percentages with significance testing at 95% (and 90% flagged).
- **Hypothesis tests:** chi-square for H1, H3, H4 and H6; t-tests / ANOVA on person-hours for H2 and H8; key driver analysis (regression on satisfaction) for H5; logistic regression on willingness to adopt for H7.
- **MaxDiff:** hierarchical Bayes utilities, rescaled to probability shares, by segment.
- **Price:** Van Westendorp ranges (PMC, OPP, IPP, PME) by region and organisation type.
- **Segmentation:** k-means or latent class on workflow pain, AI attitudes and stack fragmentation; 4–6 segments, profiled on everything.
- **Derived variables:** stack fragmentation index (number of distinct tools across stages), total person-hours per project, AI adoption stage.
- **Weighting:** weight to the regional quota targets; report unweighted bases.

---

## 12. Data Quality Requirements

Remove speeders (under 40% of the median length of interview), straight-liners on two or more grids, failed attention checks, duplicate devices and gibberish open ends. Report the removal rate by source. Keep a flag for every removal reason so the cleaned and raw datasets can be compared.

---

## 13. Reporting and Deliverables

1. A topline report within 3 days of field close.
2. A full **PowerPoint deck** (60–80 slides) with an executive summary, the workflow map, the stack heat-map, the AI adoption curve, the MaxDiff ranking, price ranges and the segment profiles.
3. An **interactive dashboard** with filters for region, organisation type and segment.
4. A **Word document** with the methodology, the questionnaire as fielded and the analysis plan.
5. Data files (SPSS and CSV) with a codebook.

---

## 14. Output Format for This Request

- First, show the **research plan**: objectives, hypotheses with the constructs they relate, the sample and quotas, the section structure with the number of questions per section, and the analysis plan.
- State your **assumptions** clearly wherever the brief leaves a choice open.
- Then build the questionnaire section by section, with **80–120 questions across 10+ blocks**, including the loop, the MaxDiff and the Van Westendorp questions.
- Do not ask me questions unless something essential is missing — make reasonable assumptions and list them.

---

## 15. Constraints

- Neutral, non-leading wording; no double-barrelled questions.
- Mobile-friendly: no more than 8 rows per grid, short option labels.
- GDPR and local data-protection compliance: consent at the start, no personal data beyond what is needed for the follow-up opt-in.
- Total length of interview must stay within **30 minutes**; flag any section that would push it over.
- Use British English in the master questionnaire.
- Respect the sponsor's brand guidelines in the survey look: navy and white, the logo top left, no animations that slow the page on low-end Android phones.

---

## 16. Stage-Level Questions (asked inside the loop)

For each stage the respondent is involved in, ask:

${stageQuestions.join("\n")}

Keep the loop to the stages selected at the screener question on involvement; if a respondent selects more than six stages, ask the full loop for the six they spend most time on (ranked) and only the tools question for the rest, so the interview stays within the time limit.

---

## 17. Definitions to Use in the Questionnaire

${table(["Term", "Definition shown to respondents"], glossary)}

---

## 18. Example Wording (style reference only)

- "Thinking about a typical online survey project of about 20 minutes in length, roughly how many working hours do you and your colleagues spend on **programming and testing** the survey?"
- "Which of the following tools, if any, does your organisation use for **data processing and tabulation**? Please select all that apply."
- "How satisfied or dissatisfied are you with your organisation's current **survey programming platform**?" (Very dissatisfied … Very satisfied)
- "At which of these stages, if any, does your organisation currently use AI-based tools in live client projects?"
- "If an end-to-end research platform cost the following per user per month, would you consider it to be so expensive that you would not consider buying it?" (Van Westendorp, four price questions)

These are examples of tone and precision, not final wording — improve them where you can.

---

*End of brief. Please be thorough, rigorous and practical — this study will shape a multi-million-dollar product decision.* ✅
`;

/** what the brief is, for assertions: its sections and hypotheses survive normalisation */
export const BRIEF_SECTIONS = ["Your Role", "Business Problem", "Background", "Research Objectives", "Hypotheses to Test", "Target Audience and Screening Criteria", "Methodology", "Questionnaire Requirements", "Technology Stack Reference", "Workflow Stages Reference", "Analysis Plan", "Data Quality Requirements", "Reporting and Deliverables", "Output Format for This Request", "Constraints", "Stage-Level Questions (asked inside the loop)", "Definitions to Use in the Questionnaire", "Example Wording (style reference only)"];
export const BRIEF_HYPOTHESES = hypotheses.length;
