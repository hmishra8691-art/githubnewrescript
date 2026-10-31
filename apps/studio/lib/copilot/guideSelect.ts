import { ANALYSIS_ACTION_OPS, AI_INTERVIEW_ACTION_OPS, ASSESSMENT_ACTION_OPS, LIST_FILL_ACTION_OPS, LOCALIZATION_ACTION_OPS, METHOD_ACTION_OPS, QUAL_ACTION_OPS, QUOTA_ACTION_OPS, RESEARCH_ACTION_OPS } from "@rescript/engine";
import { COPILOT_ANALYSIS_GUIDE, COPILOT_FINDINGS_GUIDE, COPILOT_QUOTA_GUIDE, COPILOT_TRANSLATION_GUIDE, COPILOT_UX_GUIDE, UX_ACTION_OP, findingsIntent, quotaIntent, reportingIntent, translationIntent } from "./prompt.ts";
import { COPILOT_LIST_FILL_GUIDE, listFillIntent } from "./listFillGuide.ts";
import { COPILOT_METHODS_GUIDE, methodsIntent } from "./methodsGuide.ts";
import { COPILOT_QUAL_GUIDE, COPILOT_RESEARCH_GUIDE, qualIntent } from "./researchGuide.ts";
import { COPILOT_AI_INTERVIEW_GUIDE, aiInterviewIntent } from "./aiInterviewGuide.ts";
import { REPORTING_GUIDE } from "./reportingGuide.ts";
import { COPILOT_INTEGRATIONS_GUIDE, integrationsIntent } from "./integrationsGuide.ts";
import { COPILOT_ASSESSMENT_GUIDE, assessmentIntent } from "./assessmentGuide.ts";
import type { ChangePlanItem } from "./changePlan.ts";
/* S2b: the variant catalogue guide is chosen per turn from the sentence and the selected question (not a fixed GUIDE_TEXT: it carries only the families named) */
export { variantGuideFor, variantFamiliesNamed, variantGuide } from "./variantGuide.ts";

/**
 * PER-ITEM GUIDE SELECTION (engine weakness #11, 2026-10-22).
 *
 * A staged build sends one model call per approved plan item. Each of those calls used to carry every action guide
 * the BRIEF named — about 43k characters for a brief that mentions analysis, quotas, translation, List Fill,
 * MaxDiff, findings, research, qualitative work and reporting — although an item such as "Add the screening
 * block" writes questions, logic and a quota, never a MaxDiff, a translation or a report.
 *
 * Here each item gets the guides IT needs, read deterministically from the item itself (its kind, title, detail,
 * reason, objects) and from the brief's own passages for that item:
 *
 *   core   the guides every item of the build needs (a generation writes analysis tags on its questions, so the
 *          ANALYSIS guide; a look-and-behaviour build, the UX guide) — one cached block, the same bytes on every
 *          item, so the prefix [system prompt, research context, core] is read from the provider's cache
 *   item   what this item adds: the research guide for the design item, the quota guide for a screener, the
 *          methods guide for an item (or its brief section) that names a MaxDiff / conjoint, …
 *
 * Both are in the fixed guide order, so two items that need the same guides send the same bytes (a cache read, not
 * a second write). An item nothing can be read from (kind "other", no signal) gets the whole build's set — the old
 * behaviour, never less. And if the model still proposes an action whose guide was not sent, the engine's gate
 * judges it as always (`guideMisses` names it, the route logs it and the repair call carries the missing guide).
 *
 * `COPILOT_ITEM_GUIDES=off` (server env) restores the old behaviour: every item gets the build's guides.
 */

export type GuideId = "ux" | "analysis" | "translation" | "quota" | "listFill" | "methods" | "findings" | "research" | "qual" | "aiInterview" | "integrations" | "assessment" | "reporting";
/** the order `copilotUserPrompt` adds them in (and `COPILOT_STABLE_GUIDES` lists them in) */
export const GUIDE_ORDER: readonly GuideId[] = ["ux", "analysis", "translation", "quota", "listFill", "methods", "findings", "research", "qual", "aiInterview", "integrations", "assessment", "reporting"];
export const GUIDE_TEXT: Record<GuideId, string> = {
  ux: COPILOT_UX_GUIDE, analysis: COPILOT_ANALYSIS_GUIDE, translation: COPILOT_TRANSLATION_GUIDE, quota: COPILOT_QUOTA_GUIDE, listFill: COPILOT_LIST_FILL_GUIDE,
  methods: COPILOT_METHODS_GUIDE, findings: COPILOT_FINDINGS_GUIDE, research: COPILOT_RESEARCH_GUIDE, qual: COPILOT_QUAL_GUIDE, aiInterview: COPILOT_AI_INTERVIEW_GUIDE, integrations: COPILOT_INTEGRATIONS_GUIDE, assessment: COPILOT_ASSESSMENT_GUIDE, reporting: REPORTING_GUIDE,
};

/** the guide switches of `copilotUserPrompt`, by their own names */
export interface GuideFlags {
  ux?: boolean; analysis?: boolean; translation?: boolean; quota?: boolean; listFill?: boolean; methods?: boolean; findings?: boolean;
  researchPlan?: boolean; qual?: boolean; aiInterview?: boolean; integrations?: boolean; assessment?: boolean; reporting?: boolean; qualSynthesis?: boolean;
}
const FLAG_OF: Record<GuideId, keyof GuideFlags> = { ux: "ux", analysis: "analysis", translation: "translation", quota: "quota", listFill: "listFill", methods: "methods", findings: "findings", research: "researchPlan", qual: "qual", aiInterview: "aiInterview", integrations: "integrations", assessment: "assessment", reporting: "reporting" };

export const guidesOf = (f: GuideFlags): GuideId[] => GUIDE_ORDER.filter((g) => !!f[FLAG_OF[g]]);
/** every switch set explicitly — so `copilotUserPrompt` reads nothing from the message for an item */
export function flagsOf(ids: readonly GuideId[], qualSynthesis = false): Required<GuideFlags> {
  const on = new Set(ids);
  return { ux: on.has("ux"), analysis: on.has("analysis"), translation: on.has("translation"), quota: on.has("quota"), listFill: on.has("listFill"), methods: on.has("methods"), findings: on.has("findings"), researchPlan: on.has("research"), qual: on.has("qual"), aiInterview: on.has("aiInterview"), integrations: on.has("integrations"), assessment: on.has("assessment"), reporting: on.has("reporting"), qualSynthesis };
}
/** guide texts, in order — what `copilotCall` lifts into the cached core block */
export const guideTexts = (ids: readonly GuideId[]): string[] => GUIDE_ORDER.filter((g) => ids.includes(g)).map((g) => GUIDE_TEXT[g]);

/* ------------------------------------------------------------ what an action needs */

const OPS_OF: [GuideId, readonly string[]][] = [
  ["analysis", ANALYSIS_ACTION_OPS], ["translation", LOCALIZATION_ACTION_OPS], ["quota", QUOTA_ACTION_OPS], ["listFill", LIST_FILL_ACTION_OPS],
  ["methods", METHOD_ACTION_OPS], ["qual", [...QUAL_ACTION_OPS, ...RESEARCH_ACTION_OPS]], ["aiInterview", AI_INTERVIEW_ACTION_OPS],
  ["research", ["set_research", "add_hypothesis", "set_hypothesis", "remove_hypothesis"]],
  ["integrations", ["connect_panel", "disconnect_panel", "configure_alerts"]],
  ["assessment", ASSESSMENT_ACTION_OPS],
];
/** the guide whose shapes an action op is written from (null: the system prompt's own vocabulary — questions, blocks, logic) */
export function guideForOp(op: string): GuideId | null {
  if (UX_ACTION_OP.test(op)) return "ux";
  for (const [g, ops] of OPS_OF) if (ops.includes(op)) return g;
  return null;
}
/**
 * THE MISSES: actions a reply proposed whose guide was not sent. `set_question_analysis` is described in the system
 * prompt itself and every generation's core carries the analysis guide, so only a guide that was really absent is a
 * miss. Pure: the route logs these and offers them to the repair call.
 */
export function guideMisses(ops: readonly string[], sent: readonly GuideId[]): { guide: GuideId; ops: string[] }[] {
  const out = new Map<GuideId, Set<string>>();
  for (const op of ops) {
    const g = guideForOp(op);
    if (!g || sent.includes(g)) continue;
    if (g === "analysis" && op === "set_question_analysis") continue;
    if (g === "research" && op === "set_research") continue;   // the system prompt describes set_research in full
    out.set(g, (out.get(g) ?? new Set()).add(op));
  }
  return GUIDE_ORDER.filter((g) => out.has(g)).map((g) => ({ guide: g, ops: [...out.get(g)!] }));
}

/* ------------------------------------------------------------ what an item needs */

const RESEARCH_WORDS = /\bresearch (?:design|objectives?|questions?|plan)\b|\bobjectives?\b|\bhypothes[ie]s\b|\bH\d+\b|\bconstructs?\b|\bmethodolog\w*|\bpopulation\b|\bsampl(?:e|ing)\b(?! question)|\bkpis?\b|\btraceab\w*/i;
const SCREENER_WORDS = /\bscreen(?:er|ing)?\b|\bqualif\w*|\beligib\w*|\bfirmographic\w*|\bdemographic\w*|\bquotas?\b|\bsample (?:targets?|plan)\b|\bregions?\b/i;
/** the look and behaviour, strictly (a section called "Questionnaire design" is not a theme request) */
const UX_WORDS = /\b(?:themes?|branding|css|styl(?:e|es|ing)|animat\w*|javascript|js|scripts?|pop-?ups?|modals?|tool-?tips?|look and feel|colou?r scheme|fonts?|custom (?:html|code))\b/i;

export interface ItemGuideSelection {
  /** the guides every item of this build gets (one cached block) */
  core: GuideId[];
  /** this item's own, beyond the core */
  item: GuideId[];
  /** core + item, in order */
  all: GuideId[];
  /** why each guide was chosen (for the log and the eval) */
  why: Partial<Record<GuideId, string>>;
  /** nothing could be read from the item: the whole build's set was sent */
  fallback: boolean;
}

/** the guides every item of a build gets: what each item writes whatever it is about */
export function coreGuides(build: GuideFlags, mode: string): GuideId[] {
  const core: GuideId[] = [];
  if (build.ux && mode === "ux") core.push("ux");
  if (build.analysis && (mode === "generate" || mode === "edit" || mode === "question")) core.push("analysis");
  return GUIDE_ORDER.filter((g) => core.includes(g));
}

/**
 * The guides ONE plan item needs. `build` is what the whole turn would have sent (the brief's guides); `passages` is
 * the brief's text for this item (its own section, verbatim). Deterministic: the same item always gets the same set.
 */
export function itemGuideSelection(input: { item: ChangePlanItem; build: GuideFlags; mode: string; passages?: string }): ItemGuideSelection {
  const { item, build } = input;
  /* what the item IS (its title, detail and objects) — a reason such as "to test H2" says why, not what is written */
  const head = [item.title, item.detail ?? "", ...item.objects].join(" \n ");
  const text = `${head} \n ${item.reason}`;
  /* the item's OWN brief section — the first (best-matching) passage; the others are context (the objectives, a definitions table) that name everything */
  const withPassages = `${text}\n${ownPassage(input.passages ?? "")}`;
  const core = coreGuides(build, input.mode);
  const why: Partial<Record<GuideId, string>> = {};
  for (const g of core) why[g] = "core";
  const want = (g: GuideId, reason: string) => { if (!why[g]) why[g] = reason; };
  const buildingOutputs = item.kind === "analysis" || item.kind === "other";
  if (item.kind === "design" || RESEARCH_WORDS.test(head)) want("research", item.kind === "design" ? "design item" : "names the research design");
  if (quotaIntent(withPassages) || (build.quota && SCREENER_WORDS.test(text))) want("quota", quotaIntent(text) ? "names quotas" : build.quota && SCREENER_WORDS.test(text) ? "a screener of a build with quotas" : "its brief section names quotas");
  if (translationIntent(text)) want("translation", "names a language");
  if (listFillIntent(withPassages)) want("listFill", listFillIntent(text) ? "names a List Fill" : "its brief section names a List Fill");
  if (methodsIntent(withPassages)) want("methods", methodsIntent(text) ? "names MaxDiff / conjoint" : "its brief section names MaxDiff / conjoint");
  if (UX_WORDS.test(head)) want("ux", "names the look or a behaviour");
  if (qualIntent(text)) want("qual", "names qualitative work");
  if (aiInterviewIntent(text)) want("aiInterview", "names AI interviews");
  if (integrationsIntent(text)) want("integrations", "names a panel or alerts");
  if (assessmentIntent(withPassages) || build.assessment) want("assessment", assessmentIntent(text) ? "names a test / answer key" : "an assessment build");
  if (item.kind === "analysis" || /\banaly[sz]\w*|\bcrosstabs?\b|\bderived variables?\b|\bsignificance tests?\b/i.test(head)) want("analysis", "the analysis plan");
  if (buildingOutputs && findingsIntent(text)) want("findings", "answers from results");
  if (buildingOutputs && reportingIntent(text)) want("reporting", "a document or report");
  let all = GUIDE_ORDER.filter((g) => !!why[g]);
  let fallback = false;
  /* nothing read from an item of an unknown kind: the build's whole set, as before — never less than needed */
  if (item.kind === "other" && all.every((g) => core.includes(g))) {
    for (const g of guidesOf(build)) if (!why[g]) why[g] = "fallback: nothing read from the item";
    all = GUIDE_ORDER.filter((g) => !!why[g]);
    fallback = true;
  }
  return { core, item: all.filter((g) => !core.includes(g)), all, why, fallback };
}

/** the first passage of `renderBriefPassages` text ("[§8.2 Heading]\n…"), or the text itself when it has no such headings */
export function ownPassage(text: string): string {
  const m = /\[§[^\]\n]*\]\n([\s\S]*?)(?=\n\n\[§|$)/.exec(text);
  return m ? m[1]! : text;
}

/** `COPILOT_ITEM_GUIDES=off` turns per-item selection off (every item gets the build's guides, as before 2026-10-22) */
export function itemGuidesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(?:off|0|false|no)$/i.test((env.COPILOT_ITEM_GUIDES ?? "").trim());
}
