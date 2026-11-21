import { PortalSettings } from "@rescript/schema";

/**
 * THE PORTAL TEMPLATES (Respondent Intelligence Engine, phase 4, 2026-11-20).
 *
 * A template is CONFIGURATION, not code: there is one portal, one scorecard, one comparison and one history
 * engine, and a template only says how a kind of study uses them —
 *
 *   words      what things are called for these respondents ("check-in", "your care team", "My feedback")
 *   note       the sentence under a person's results (what the scores are, and are not)
 *   accent     the colour of the pages of this assessment
 *   defaults   the settings a researcher starts from (they can change every one of them)
 *   enforce    the few settings this kind of study must not loosen, applied wherever the settings are READ
 *              (`portalSettings`), so no screen, route or later edit can get round them
 *   suggests   the scores such a study usually defines — names only; the researcher maps their own questions
 *
 * Nothing here knows a question, a client or a person. Adding a template is adding an entry to this list.
 */
export type PortalSector = "work" | "learning" | "health" | "research" | "customer" | "public" | "sport";

export interface PortalWords {
  /** one of them, lower case: "assessment", "check-in", "test" */
  one: string;
  many: string;
  /** who runs it, as the respondent would say it: "the organiser", "your care team" */
  organiser: string;
  /** the heading over a person's scores */
  results: string;
  /** the button that begins it, and the one that begins it again */
  start: string;
  again: string;
}

export interface PortalTemplate {
  id: string;
  name: string;
  sector: PortalSector;
  /** one of the six industry portals offered first */
  featured: boolean;
  summary: string;
  words: PortalWords;
  note: string | null;
  accent: string;
  defaults: {
    identity: PortalSettings["identity"];
    show: PortalSettings["show"];
    editing: { mode: PortalSettings["editing"]["mode"]; windowHours?: number };
    maxAttempts?: number;
    minCohort: number;
    repeatEveryDays?: number;
  };
  enforce: {
    /** a comparison is never shown below this many people (never under the platform's 10) */
    minCohort?: number;
    /** respondents are never compared with others */
    noComparison?: true;
    /** submitted answers are never changed */
    noEditing?: true;
    /** submitted answers are never shown back */
    noAnswers?: true;
  };
  suggests: string[];
}

export const STANDARD_WORDS: PortalWords = { one: "assessment", many: "assessments", organiser: "the organiser", results: "My results", start: "Start", again: "Take it again" };
export const NOTE_NOT_ADVICE = "Scores describe the answers you gave. They are not a diagnosis or professional advice.";
const HEALTH_NOTE = "These scores describe the answers you gave. They are not a diagnosis or medical advice. If you are worried about your health, speak to a health professional.";
export const STANDARD_ACCENT = "#1f4fd8";

const show = (s: Partial<PortalSettings["show"]>): PortalSettings["show"] => ({ answers: false, history: false, scores: false, bands: true, comparison: false, trends: false, ...s });

export const PORTAL_TEMPLATES: readonly PortalTemplate[] = [
  /* ---------------------------------------------------------------- work */
  {
    id: "employee_engagement", name: "Employee engagement", sector: "work", featured: true,
    summary: "A yearly or half-yearly engagement survey. People see their own scores against the organisation and their own department, in groups large enough that nobody can be picked out.",
    words: { one: "survey", many: "surveys", organiser: "your employer", results: "My results", start: "Start the survey", again: "Take it again" },
    note: "Your answers are reported to your employer only as part of a group. These scores are for you.", accent: "#1f4fd8",
    defaults: { identity: "persistent", show: show({ scores: true, comparison: true, trends: true }), editing: { mode: "none" }, minCohort: 10 },
    enforce: { minCohort: 10 },
    suggests: ["Engagement", "Manager support", "Growth", "Workload", "Belonging"],
  },
  {
    id: "pulse_check", name: "Pulse check", sector: "work", featured: false,
    summary: "A few questions every few weeks. The same person answers again and again and watches their own line move.",
    words: { one: "pulse check", many: "pulse checks", organiser: "your employer", results: "My pulse", start: "Start", again: "Answer this period's" },
    note: "Your answers are reported to your employer only as part of a group. These scores are for you.", accent: "#0369a1",
    defaults: { identity: "persistent", show: show({ scores: true, trends: true }), editing: { mode: "none" }, minCohort: 10, repeatEveryDays: 30 },
    enforce: { minCohort: 10 },
    suggests: ["Mood", "Workload", "Support"],
  },
  {
    id: "feedback_360", name: "360 feedback", sector: "work", featured: false,
    summary: "A self-rating beside ratings from others. The person sees their own profile; comparisons with other people are not offered.",
    words: { one: "feedback round", many: "feedback rounds", organiser: "your organisation", results: "My feedback", start: "Start", again: "Start the next round" },
    note: "This is feedback to reflect on, not a judgement of you. It describes how answers were given at one point in time.", accent: "#6d28d9",
    defaults: { identity: "persistent", show: show({ answers: true, scores: true, trends: true }), editing: { mode: "until_deadline" }, minCohort: 10 },
    enforce: { noComparison: true },
    suggests: ["Communication", "Collaboration", "Decision making", "Developing others"],
  },
  {
    id: "training_certification", name: "Training and certification", sector: "learning", featured: true,
    summary: "A scored test after a course. The learner sees marks, topics to revise and whether they passed, and can retake within the allowed attempts.",
    words: { one: "test", many: "tests", organiser: "your training provider", results: "My marks", start: "Start the test", again: "Retake the test" },
    note: null, accent: "#15803d",
    defaults: { identity: "persistent", show: show({ scores: true, history: true, trends: true }), editing: { mode: "none" }, maxAttempts: 3, minCohort: 10 },
    enforce: { noEditing: true },
    suggests: ["Total marks", "One score per topic"],
  },
  {
    id: "compliance_test", name: "Compliance and safety test", sector: "work", featured: false,
    summary: "A mandatory test that must be passed and renewed. Shows the result and when the next one is due.",
    words: { one: "test", many: "tests", organiser: "your employer", results: "My result", start: "Start the test", again: "Take the renewal" },
    note: null, accent: "#b45309",
    defaults: { identity: "persistent", show: show({ scores: true }), editing: { mode: "none" }, maxAttempts: 3, minCohort: 10, repeatEveryDays: 365 },
    enforce: { noEditing: true, noComparison: true },
    suggests: ["Total marks"],
  },
  {
    id: "skills_assessment", name: "Skills assessment", sector: "work", featured: false,
    summary: "A profile of skills from a self-rating or a test, tracked as the person develops.",
    words: { one: "assessment", many: "assessments", organiser: "your organisation", results: "My skills profile", start: "Start", again: "Reassess" },
    note: "This profile describes your answers at one point in time. It is a guide for development, not a verdict.", accent: "#0f766e",
    defaults: { identity: "persistent", show: show({ answers: true, scores: true, trends: true }), editing: { mode: "window", windowHours: 48 }, minCohort: 10, repeatEveryDays: 180 },
    enforce: {},
    suggests: ["One score per skill", "Overall"],
  },
  {
    id: "candidate_assessment", name: "Candidate assessment", sector: "work", featured: false,
    summary: "An assessment for a job applicant. One attempt, an account for this assessment only, no comparison with other candidates, nothing changed after submission.",
    words: { one: "assessment", many: "assessments", organiser: "the recruiting team", results: "My results", start: "Start the assessment", again: "Start" },
    note: "These results are one part of an application and are read together with everything else you provide.", accent: "#334155",
    defaults: { identity: "assessment", show: show({}), editing: { mode: "none" }, maxAttempts: 1, minCohort: 10 },
    enforce: { noComparison: true, noEditing: true, noAnswers: true },
    suggests: ["Total", "One score per competency"],
  },

  /* ---------------------------------------------------------------- learning */
  {
    id: "student_assessment", name: "Student assessment", sector: "learning", featured: true,
    summary: "Tests and quizzes across a term. The student sees marks by topic, what to revise, and how they have moved from one test to the next.",
    words: { one: "test", many: "tests", organiser: "your teacher", results: "My marks", start: "Start the test", again: "Try again" },
    note: null, accent: "#7c3aed",
    defaults: { identity: "persistent", show: show({ scores: true, history: true, trends: true }), editing: { mode: "none" }, minCohort: 10 },
    enforce: { noEditing: true },
    suggests: ["Total marks", "One score per topic"],
  },
  {
    id: "course_feedback", name: "Course feedback and learning progress", sector: "learning", featured: false,
    summary: "Learners rate a course and their own confidence at intervals, and see their confidence change.",
    words: { one: "questionnaire", many: "questionnaires", organiser: "your course team", results: "My progress", start: "Start", again: "Answer again" },
    note: "Your ratings are reported to the course team only as part of a group.", accent: "#0369a1",
    defaults: { identity: "persistent", show: show({ answers: true, scores: true, trends: true }), editing: { mode: "window", windowHours: 24 }, minCohort: 10 },
    enforce: { minCohort: 10 },
    suggests: ["Confidence", "Understanding", "Course quality"],
  },

  /* ---------------------------------------------------------------- health */
  {
    id: "patient_outcomes", name: "Patient-reported outcomes", sector: "health", featured: true,
    summary: "Questionnaires a person completes before and after care, at set intervals. They see their own scores over time. Comparison with other people is off unless switched on, and then only in larger groups.",
    words: { one: "questionnaire", many: "questionnaires", organiser: "your care team", results: "My scores", start: "Start the questionnaire", again: "Complete the next one" },
    note: HEALTH_NOTE, accent: "#0f766e",
    defaults: { identity: "persistent", show: show({ answers: true, scores: true, trends: true }), editing: { mode: "window", windowHours: 24 }, minCohort: 20, repeatEveryDays: 90 },
    enforce: { minCohort: 20 },
    suggests: ["Symptoms", "Function", "Quality of life"],
  },
  {
    id: "wellbeing_checkin", name: "Wellbeing check-in", sector: "health", featured: false,
    summary: "A short, regular check-in on how someone is doing. Their own line over time, with a plain statement of what the scores are not.",
    words: { one: "check-in", many: "check-ins", organiser: "the organiser", results: "How I am doing", start: "Start the check-in", again: "Check in again" },
    note: HEALTH_NOTE, accent: "#0f766e",
    defaults: { identity: "persistent", show: show({ scores: true, trends: true }), editing: { mode: "none" }, minCohort: 20, repeatEveryDays: 14 },
    enforce: { minCohort: 20 },
    suggests: ["Wellbeing", "Sleep", "Stress"],
  },
  {
    id: "health_appraisal", name: "Health and lifestyle appraisal", sector: "health", featured: false,
    summary: "A yearly questionnaire on lifestyle and health habits, with a profile the person can act on.",
    words: { one: "appraisal", many: "appraisals", organiser: "the organiser", results: "My profile", start: "Start the appraisal", again: "Start this year's" },
    note: HEALTH_NOTE, accent: "#be123c",
    defaults: { identity: "persistent", show: show({ answers: true, scores: true, trends: true }), editing: { mode: "window", windowHours: 72 }, minCohort: 20, repeatEveryDays: 365 },
    enforce: { minCohort: 20 },
    suggests: ["Activity", "Nutrition", "Sleep", "Stress"],
  },

  /* ---------------------------------------------------------------- research */
  {
    id: "study_diary", name: "Study diary", sector: "research", featured: false,
    summary: "A participant in a study completes an entry every day or week. They see what they have completed and what is due; scores are off unless the study shares them.",
    words: { one: "diary entry", many: "diary entries", organiser: "the study team", results: "My entries", start: "Start today's entry", again: "Add the next entry" },
    note: "This diary is part of a research study. What you see here is not an assessment of you.", accent: "#334155",
    defaults: { identity: "assessment", show: show({ answers: true, history: true }), editing: { mode: "window", windowHours: 12 }, minCohort: 20, repeatEveryDays: 1 },
    enforce: { noComparison: true },
    suggests: [],
  },
  {
    id: "tracking_panel", name: "Tracking panel", sector: "research", featured: true,
    summary: "The same panel answers a new wave each quarter or year. Each wave is a survey in one series; a member sees the waves they took and how their answers have moved.",
    words: { one: "wave", many: "waves", organiser: "the research team", results: "My results", start: "Start this wave", again: "Start the next wave" },
    note: "Your answers are reported only as part of a group. These results are for you.", accent: "#1f4fd8",
    defaults: { identity: "persistent", show: show({ scores: true, trends: true }), editing: { mode: "none" }, minCohort: 10, repeatEveryDays: 90 },
    enforce: { minCohort: 10 },
    suggests: ["One score per tracked measure"],
  },
  {
    id: "consumer_panel", name: "Consumer panel member", sector: "research", featured: false,
    summary: "A member of a consumer panel sees the surveys open to them and what they have completed. No scores by default.",
    words: { one: "survey", many: "surveys", organiser: "the panel team", results: "My results", start: "Start the survey", again: "Take it again" },
    note: null, accent: "#b45309",
    defaults: { identity: "persistent", show: show({}), editing: { mode: "none" }, minCohort: 10 },
    enforce: { minCohort: 10 },
    suggests: [],
  },

  /* ---------------------------------------------------------------- development */
  {
    id: "coaching_progress", name: "Coaching progress", sector: "work", featured: false,
    summary: "A person and their coach follow a few measures between sessions. No comparison with anyone else.",
    words: { one: "reflection", many: "reflections", organiser: "your coach", results: "My progress", start: "Start", again: "Add a reflection" },
    note: "These scores describe your own answers over time. They are a starting point for a conversation, not a judgement.", accent: "#6d28d9",
    defaults: { identity: "persistent", show: show({ answers: true, history: true, scores: true, trends: true }), editing: { mode: "window", windowHours: 48 }, minCohort: 10, repeatEveryDays: 14 },
    enforce: { noComparison: true },
    suggests: ["Goal progress", "Confidence", "Energy"],
  },
  {
    id: "personality_profile", name: "Personality profile", sector: "work", featured: false,
    summary: "A profile across several traits. No trait is better or worse; the person sees where they sit and what each range means.",
    words: { one: "questionnaire", many: "questionnaires", organiser: "the organiser", results: "My profile", start: "Start the questionnaire", again: "Take it again" },
    note: "A profile describes preferences in your answers. No result is better or worse than another, and it is not a diagnosis.", accent: "#7c3aed",
    defaults: { identity: "persistent", show: show({ scores: true }), editing: { mode: "none" }, maxAttempts: 1, minCohort: 20 },
    enforce: { noEditing: true, minCohort: 20 },
    suggests: ["One score per trait"],
  },

  /* ---------------------------------------------------------------- customer and public */
  {
    id: "customer_satisfaction", name: "Customer satisfaction", sector: "customer", featured: true,
    summary: "Customers who are asked more than once — after each order, visit or quarter — see what they told you and can correct it for a short time.",
    words: { one: "survey", many: "surveys", organiser: "the team that sent it", results: "My feedback", start: "Give feedback", again: "Give feedback again" },
    note: null, accent: "#1f4fd8",
    defaults: { identity: "persistent", show: show({ answers: true, history: true }), editing: { mode: "window", windowHours: 24 }, minCohort: 10 },
    enforce: { noComparison: true },
    suggests: ["Satisfaction", "Likelihood to recommend"],
  },
  {
    id: "community_survey", name: "Community and citizen survey", sector: "public", featured: false,
    summary: "Residents or members answer a regular survey and can see what they said and how their area compares, in large groups only.",
    words: { one: "survey", many: "surveys", organiser: "the survey team", results: "My results", start: "Start the survey", again: "Take this year's survey" },
    note: "Your answers are reported only as part of a group.", accent: "#15803d",
    defaults: { identity: "persistent", show: show({ answers: true, scores: true, comparison: true }), editing: { mode: "none" }, minCohort: 30, repeatEveryDays: 365 },
    enforce: { minCohort: 30 },
    suggests: ["Satisfaction with services", "Safety", "Belonging"],
  },

  /* ---------------------------------------------------------------- sport */
  {
    id: "athlete_tracking", name: "Athlete and performance tracking", sector: "sport", featured: false,
    summary: "Readiness, load and recovery reported every day or week, followed by the athlete and their coach.",
    words: { one: "check-in", many: "check-ins", organiser: "your coach", results: "My readiness", start: "Start the check-in", again: "Check in again" },
    note: "These scores describe what you reported. They are not medical advice; speak to a medical professional about pain or injury.", accent: "#be123c",
    defaults: { identity: "persistent", show: show({ answers: true, scores: true, trends: true }), editing: { mode: "window", windowHours: 6 }, minCohort: 10, repeatEveryDays: 1 },
    enforce: {},
    suggests: ["Readiness", "Sleep", "Soreness", "Training load"],
  },
];

const BY_ID = new Map(PORTAL_TEMPLATES.map((t) => [t.id, t]));
export const portalTemplate = (id: string | null | undefined): PortalTemplate | null => (id ? BY_ID.get(id) ?? null : null);

/**
 * The settings as they are in force: the researcher's, with the template's few fixed rules applied on top. A
 * survey with no template, or an unknown one, is returned untouched (the same object).
 */
export function enforcePortalTemplate(portal: PortalSettings): PortalSettings {
  const e = portalTemplate(portal.template)?.enforce;
  if (!e || !Object.keys(e).length) return portal;
  const out: PortalSettings = { ...portal, show: { ...portal.show }, benchmark: { ...portal.benchmark }, editing: { ...portal.editing } };
  if (e.minCohort && out.benchmark.minCohort < e.minCohort) out.benchmark.minCohort = e.minCohort;
  if (e.noComparison) { out.show.comparison = false; out.benchmark.enabled = false; }
  if (e.noEditing) out.editing.mode = "none";
  if (e.noAnswers) { out.show.answers = false; out.show.history = false; out.editing.mode = "none"; }
  return out;
}

/**
 * Start a survey's portal from a template. Everything the researcher BUILT is kept — the scores, the comparison
 * groups, the series, the lists of locked questions; the switches and limits are set to the template's.
 */
export function applyPortalTemplate(current: PortalSettings | undefined, id: string): PortalSettings | null {
  const t = portalTemplate(id);
  if (!t) return null;
  const base = current ?? PortalSettings.parse({ enabled: true });
  const d = t.defaults;
  const next: PortalSettings = {
    ...base, enabled: true, template: t.id, identity: d.identity, show: { ...d.show },
    editing: { ...base.editing, mode: d.editing.mode, windowHours: d.editing.mode === "window" ? d.editing.windowHours ?? base.editing.windowHours ?? 24 : base.editing.windowHours },
    maxAttempts: d.maxAttempts,
    benchmark: { ...base.benchmark, enabled: d.show.comparison, minCohort: Math.max(d.minCohort, t.enforce.minCohort ?? 0, 10) },
    series: base.series ? { ...base.series, repeatEveryDays: d.repeatEveryDays ?? base.series.repeatEveryDays } : base.series,
  };
  if (next.maxAttempts === undefined) delete next.maxAttempts;
  return enforcePortalTemplate(next);
}

export interface PortalPresentation { template: string | null; name: string | null; words: PortalWords; note: string | null; accent: string }

/** how an assessment presents itself to its respondents; `note: null` = the standard rule decides (not a test → the standard note) */
export function portalPresentation(portal: Pick<PortalSettings, "template"> | null | undefined): PortalPresentation {
  const t = portalTemplate(portal?.template);
  return t ? { template: t.id, name: t.name, words: t.words, note: t.note, accent: t.accent } : { template: null, name: null, words: STANDARD_WORDS, note: null, accent: STANDARD_ACCENT };
}

/** what a template fixes, in the researcher's words — for the Studio */
export function templateRules(t: PortalTemplate): string[] {
  const out: string[] = [];
  if (t.enforce.minCohort) out.push(`A comparison is never shown for fewer than ${t.enforce.minCohort} people.`);
  if (t.enforce.noComparison) out.push("Respondents are never compared with other people.");
  if (t.enforce.noEditing) out.push("Submitted answers can never be changed.");
  if (t.enforce.noAnswers) out.push("Submitted answers are never shown back.");
  return out;
}
