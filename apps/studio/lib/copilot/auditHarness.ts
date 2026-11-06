/**
 * THE INTELLIGENT-MODE AUDIT HARNESS (2026-11-06) — the measurements behind the audit record
 * (`claude/intelligent-mode-audit-2026-11-06.md`): 47 sentences across the sixteen modules and ten research briefs,
 * each run through the engine's deterministic reader (`interpretRequest`), the Studio's request classifier and
 * guide intents, and the task estimator — what the platform does BEFORE and AROUND a language model. No model is
 * called. Run from apps/studio:
 *
 *   node --experimental-strip-types --no-warnings lib/copilot/auditHarness.ts            (the sentences)
 *   node --experimental-strip-types --no-warnings lib/copilot/auditHarness.ts briefs     (the briefs + the planner)
 *
 * Re-run it after a roadmap item lands; a sentence that moves from "model" to "actions" is the measure.
 */
import { interpretRequest, estimateTaskSize, researchWorkflow } from "@rescript/engine";
import { SurveyDefinition } from "@rescript/schema";
import { classifyRequest, quotaIntent, analysisIntent, translationIntent, findingsIntent, reportingIntent, uxIntent } from "./prompt.ts";
import { researchPlanIntent as researchIntent, qualIntent as qualStudyIntent } from "./researchGuide.ts";
import { audienceIntent } from "./audienceGuide.ts";
import { qualityIntent } from "./qualityGuide.ts";
import { methodsIntent } from "./methodsGuide.ts";

/** a small study with a research design, the questions the sentences name, and a plan — enough for every reader to have something to resolve against */
function pricingStudy(): SurveyDefinition {
  const opt = (labels: string[]) => labels.map((label, i) => ({ code: i + 1, label, flags: [] }));
  const q = (code: string, variableName: string, type: string, text: string, extra: Record<string, unknown> = {}) => ({ id: `q_${code.toLowerCase()}`, code, variableName, type, text, options: [], rows: [], columns: [], validation: [], required: false, settings: {}, ...extra });
  return SurveyDefinition.parse({
    meta: { id: "audit", code: "AUD", title: "Pricing study", version: "1.0", schemaVersion: 1, status: "draft" },
    questions: [
      q("Q1", "GENDER", "single_select", "Gender", { options: opt(["Male", "Female"]) }),
      q("Q2", "AGE_GROUP", "single_select", "Age group", { options: opt(["18-34", "35-54", "55+"]) }),
      q("Q3", "BOUGHT", "single_select", "Did you buy in the last year?", { options: opt(["Yes", "No"]) }),
      q("Q4", "BRANDS", "multi_select", "Which brands do you know?", { options: opt(["Alpha", "Beta", "Gamma"]) }),
      q("Q5", "SAT", "single_select", "How satisfied are you?", { options: opt(["1", "2", "3", "4", "5"]) }),
      q("Q6", "SPEND", "numeric", "How much did you spend?"),
      q("Q7", "INTENT", "single_select", "How likely are you to buy again?", { options: opt(["1", "2", "3", "4", "5"]) }),
      q("Q8", "REGION", "single_select", "Region", { options: opt(["North", "South", "East"]) }),
      q("Q9", "WHY", "open_text", "Why?"),
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_q1", "q_q2", "q_q3", "q_q4", "q_q5", "q_q6", "q_q7", "q_q8", "q_q9"] }],
    deployment: { clientSlug: "c", studySlug: "s", access: { mode: "open", allowRetake: false, captureAnonymous: true }, languages: ["en"], sample: {} },
    research: { objective: "What drives repeat purchase", hypotheses: ["Satisfaction raises repeat purchase intent", "Region affects satisfaction"], hypothesisDetails: [], researchQuestions: [], kpis: [], assumptions: [], sources: [], analysis: [],
      constructs: [{ name: "Satisfaction", role: "independent", questionIds: ["q_q5"] }, { name: "Purchase intent", role: "dependent", questionIds: ["q_q7"] }, { name: "Region", role: "independent", questionIds: ["q_q8"] }],
      analysisPlan: { crosstabs: [{ id: "x1", rows: ["INTENT"], columns: ["SAT"], priority: 1, hypotheses: ["H1"] }], tests: [{ id: "t1", method: "anova", outcome: "SAT", variables: [], groupBy: "REGION", priority: 1, hypotheses: ["H2"] }], derived: [], segments: [] } },
  });
}

function sentences() {

const def = pricingStudy();
const S: [string, string][] = [
  ["settings", "Disable the back button and show a progress bar"],
  ["settings", "Respondents should be able to save and resume later"],
  ["settings", "Prevent duplicate responses and add bot protection"],
  ["settings", "Add a consent screen at the start and set the survey to expire on 30 November"],
  ["settings", "Randomize the order of the options in Q2"],
  ["settings", "This is pharmaceutical research among physicians; configure the survey settings appropriately"],
  ["testing", "I want a production-like test before launching the survey"],
  ["testing", "Let me test the survey exactly as a live respondent will see it, with the live quotas"],
  ["quotas", "Set a quota of 500 completes split 50/50 by gender"],
  ["quotas", "Create interlocking quotas for age group and region with 1,000 completes"],
  ["quotas", "Make the age quota soft and stop when the gender quota is full"],
  ["fieldwork", "Plan the fieldwork: 1,000 doctors in India, 15-minute survey, finish in three weeks"],
  ["fieldwork", "Estimate the cost and the daily completes we need"],
  ["programming", "Add a single-select question asking which brand they bought last, with Other specify"],
  ["programming", "Show Q5 only if Q3 is Yes"],
  ["programming", "Skip to the end if the respondent is under 18"],
  ["programming", "Add a 1-7 agreement matrix with five statements about service quality"],
  ["programming", "Create a MaxDiff with 12 items and 10 tasks"],
  ["programming", "Loop the brand rating questions for every brand selected in Q4"],
  ["programming", "Require a number between 1 and 100 in Q6"],
  ["programming", "Auto-punch Q9 as High when the total score is above 20"],
  ["js", "Add JavaScript on Q3 that shows a popup when the respondent picks option 2"],
  ["js", "Change the Next button colour to dark blue and make the cards rounded"],
  ["js", "Why is my script on Q7 not firing?"],
  ["cleaning", "Flag speeders and straightliners and exclude duplicates"],
  ["cleaning", "Remove the gibberish open-ended responses"],
  ["cleaning", "Why was respondent 123 flagged?"],
  ["analytics", "Plan the analysis"],
  ["analytics", "Cross-tab satisfaction by age and gender with significance testing"],
  ["analytics", "Which test should I use to compare purchase intent across regions?"],
  ["analysis", "What are the key findings?"],
  ["analysis", "Does awareness differ by region?"],
  ["qual", "Create a discussion guide for focus groups with young parents about snacking"],
  ["qual", "Add a probe to the second question of the guide"],
  ["qual", "Code the open ends into themes"],
  ["themes", "Make the survey look like our brand: dark blue, rounded buttons, Inter font"],
  ["themes", "Use a calm healthcare look with large text"],
  ["preview", "Preview the survey on mobile"],
  ["preview", "Check the survey for accessibility problems"],
  ["reporting", "Prepare a findings deck for the client"],
  ["reporting", "Write the research proposal as a Word document"],
  ["workflow", "Start the research workflow for understanding why customers churn"],
  ["workflow", "I changed the target audience to Gen Z; what else needs to change?"],
  ["ux", "I am conducting healthcare research among doctors in India. I need 1,000 completed responses, with age, specialty, and geographic quotas. I want a production-like test before launching the survey."],
  ["ux", "Undo the last change"],
  ["invalid", "Book me a flight to Delhi"],
  ["conflict", "Make the survey anonymous but record every respondent's email"],
];
const out: Record<string, unknown>[] = [];
for (const [area, text] of S) {
  let kind = "?", category: string | null = null, reason = "", actions = 0, understood = "";
  try { const i = interpretRequest(def, text); kind = i.kind; category = i.category; reason = (i as { reason?: string }).reason ?? ""; actions = (i as { actions?: unknown[] }).actions?.length ?? 0; understood = (i as { understood?: string }).understood ?? ""; } catch (e) { kind = "throws"; reason = (e as Error).message; }
  const c = classifyRequest(text, def.questions.length, 0);
  const guides: string[] = [];
  if (uxIntent(text).ux) guides.push("ux"); if (analysisIntent(text)) guides.push("analysis"); if (translationIntent(text)) guides.push("translation"); if (quotaIntent(text)) guides.push("quota"); if (findingsIntent(text)) guides.push("findings"); if (researchIntent(text)) guides.push("research"); if (qualStudyIntent(text)) guides.push("qual"); if (audienceIntent(text)) guides.push("audience"); if (qualityIntent(text)) guides.push("quality"); if (methodsIntent(text)) guides.push("methods"); if (reportingIntent(text)) guides.push("reporting");
  const est = estimateTaskSize({ message: text, questions: def.questions.length } as never);
  out.push({ area, text: text.slice(0, 70), engine: kind, category, actions, reason: reason.slice(0, 60), mode: c.mode, guides: guides.join(","), task: (est as { task?: boolean }).task ?? (est as { isTask?: boolean }).isTask });
}
console.table(out);
const wf = researchWorkflow(def);
console.log("workflow steps:", wf.steps.map((s) => `${s.id}:${s.status}/${s.executor}`).join(" "));
}

function briefs() {
const empty = { meta: { id: "x", code: "X", title: "New", version: "1.0", schemaVersion: 1, status: "draft" }, questions: [], flow: [], deployment: { clientSlug: "c", studySlug: "s", access: { mode: "open", allowRetake: false, captureAnonymous: true }, languages: ["en"], sample: {} } } as never;
const B: [string, string][] = [
  ["healthcare", "Design a 25-minute survey for 1,000 practising doctors in India on adoption of telemedicine: objectives, hypotheses on specialty and city tier, age/specialty/region quotas, consent screen, no back button, production-like test before launch."],
  ["pharma", "Pharmaceutical research among 300 oncologists in Germany and France about a new biologic: treatment pathways, prescribing drivers, adverse-event concerns, and a MaxDiff on 10 product attributes; translate to German and French."],
  ["advertising", "Advertising effectiveness study: exposed vs control cells for a TV campaign in the UK, 800 completes per cell, ad recall, brand funnel, message takeout, with randomised ad exposure and quotas by age and gender."],
  ["consumer", "Consumer research on snacking habits among 1,500 urban Indian adults: usage and attitudes, brand awareness, purchase intent, a conjoint on pack size and price, and an open end on reasons."],
  ["brand", "Brand tracking wave 3 for a bank in Singapore: awareness, consideration, usage, NPS, image statements, 600 completes monthly, compare against the previous wave."],
  ["political", "Political opinion poll in Maharashtra: voting intention, party favourability, issue importance, 2,000 completes with quotas by age, gender, region and urban/rural, and weighting to the census."],
  ["academic", "Academic study measuring the relation between perceived stress and academic performance among 400 university students, with validated scales (PSS-10), demographics, and an ethics consent page."],
  ["qual", "Create an in-depth interview guide for 20 interviews with first-time home buyers in Mumbai: opening, warm-up, decision journey, barriers, and closing, with probes, 60 minutes each."],
  ["mixed", "Mixed-method study on employee engagement: 8 focus groups then a 15-minute survey for 3,000 employees across 5 countries, in English, Hindi and Spanish, with department and tenure quotas."],
  ["multi-country", "Multi-country consumer study in 12 countries with 1,000 completes each, local languages, country quotas, a global brand funnel and 60 questions."],
];
for (const [name, text] of B) {
  const est = estimateTaskSize({ message: text, survey: empty });
  const i = interpretRequest(empty, text);
  const c = classifyRequest(text, 0, 0);
  console.log(name.padEnd(14), "task:", String(est.task).padEnd(6), "mode:", c.mode.padEnd(9), "engine:", i.kind, i.category ?? "", "| reasons:", est.reasons.slice(0, 2).join("; ").slice(0, 90), "| deliverables:", est.deliverables.join(","), est.requestedCount ?? "");
}
const wf = researchWorkflow(empty, { objective: "Understand telemedicine adoption among doctors in India" });
console.log("\nempty survey + objective → workflow:", wf.summary);
console.log(wf.steps.map((s) => `${s.id}:${s.status}`).join("  "));
console.log("\nfixture (pricing study) → workflow:", researchWorkflow(pricingStudy()).summary);
}

if (process.argv[2] === "briefs") briefs(); else sentences();
