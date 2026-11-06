import type { SurveyDefinition } from "@rescript/schema";
import { runQualityCheck } from "./qualityCheck.js";
import { adviseSettings, briefOfSurvey } from "./settingsAdvice.js";
import { fieldworkWindow, identifyingQuestions, isAnonymous } from "./deploymentActions.js";
import { languageCode } from "./aiInterviewActions.js";

/**
 * THE STUDY'S LIFECYCLE, AFTER THE DESIGN (Intelligent Mode IM7, 2026-11-06).
 *
 * Two pure readings the planner, the action layer and the publish gate share:
 *
 *   downstreamOf(before, after)  what a change to WHO is asked (the audience, the population, the markets, the
 *                                languages) or HOW (the method, the designs, the sample size) leaves to update
 *                                elsewhere — quotas, screeners, settings, the fieldwork plan, translations, the
 *                                analysis plan — each named with the sentence that does it. Said with the change,
 *                                never applied by it.
 *   launchReadiness(def, opts)   what stands between this survey and a live link: blockers (a launch would fail or
 *                                mislead) and warnings (a launch would work but something the study asked for is
 *                                missing), each with its fix.
 */
export interface Downstream { area: "quotas" | "screeners" | "settings" | "fieldwork" | "translations" | "analysis" | "length"; what: string; sentence?: string }

const audienceText = (d: SurveyDefinition) => JSON.stringify([d.audience?.demographics ?? null, d.audience?.naturalLanguage ?? null, d.research?.population ?? null, d.research?.audience?.description ?? null]);
const methodText = (d: SurveyDefinition) => JSON.stringify([d.research?.methodology ?? null, (d.designs ?? []).map((x) => (x as { kind?: string; type?: string }).kind ?? (x as { type?: string }).type ?? "design").sort()]);
const langs = (d: SurveyDefinition) => (d.localization?.languages ?? []).map((l) => l.code).sort().join(",");

export function downstreamOf(before: SurveyDefinition, after: SurveyDefinition): Downstream[] {
  const out: Downstream[] = [];
  const audienceChanged = audienceText(before) !== audienceText(after);
  const methodChanged = methodText(before) !== methodText(after);
  const sizeChanged = (before.research?.sampleSize ?? null) !== (after.research?.sampleSize ?? null);
  const langChanged = langs(before) !== langs(after);
  if (!audienceChanged && !methodChanged && !sizeChanged && !langChanged) return out;

  if (audienceChanged) {
    if (after.quotas.length) out.push({ area: "quotas", what: `the audience changed — ${after.quotas.length === 1 ? `the quota “${after.quotas[0].name}” was` : `${after.quotas.length} quotas were`} set for the old one; check its cells and limits still describe who is asked`, sentence: "Review the quotas" });
    const screeners = after.questions.filter((q) => (q.skipLogic ?? []).some((s) => s.target.kind === "terminate" || s.target.status === "screened"));
    if (screeners.length) out.push({ area: "screeners", what: `${screeners.map((q) => q.code).join(", ")} screen${screeners.length === 1 ? "s" : ""} respondents out — their conditions may exclude the new audience or admit the old one` });
    const b = adviseSettings(before).filter((a) => a.status !== "keep").map((a) => `${a.id}:${a.recommended}`);
    const a = adviseSettings(after).filter((x) => x.status !== "keep");
    const fresh = a.filter((x) => !b.includes(`${x.id}:${x.recommended}`));
    if (fresh.length) out.push({ area: "settings", what: `the settings the new audience calls for: ${fresh.map((x) => `${x.setting.toLowerCase()} → ${x.recommended} (${x.because.split(/[;.—]/)[0]})`).join("; ")}`, sentence: "Recommend the settings for this study" });
  }
  if (methodChanged) {
    const plan = after.research?.analysisPlan;
    out.push({ area: "analysis", what: `the method changed${after.research?.methodology ? ` (now “${after.research.methodology.slice(0, 60)}”)` : ""} — the analysis plan${plan ? ` (${plan.tests.length} tests, ${plan.crosstabs.length} crosstabs)` : ""} was planned for the old one`, sentence: "Plan the analysis" });
    out.push({ area: "length", what: "a different method changes the interview length — the fieldwork plan's length and cost follow it" });
  }
  if ((audienceChanged || methodChanged || sizeChanged) && after.research?.fieldwork) {
    const f = after.research.fieldwork;
    out.push({ area: "fieldwork", what: `the fieldwork plan (${f.completes} completes, ${f.startDate} → ${f.endDate}) was written before this change${sizeChanged && after.research?.sampleSize ? ` — the study now plans ${after.research.sampleSize}` : ""}`, sentence: "Plan the fieldwork" });
  }
  if (sizeChanged && after.quotas.length && after.research?.sampleSize) {
    const tot = after.quotas.map((q) => q.targetTotal ?? q.cells.filter((c) => c.limitType === "count").reduce((s, c) => s + c.limit, 0));
    if (tot.some((t) => t && t !== after.research!.sampleSize)) out.push({ area: "quotas", what: `the sample size is now ${after.research.sampleSize} but the quotas add up to ${[...new Set(tot)].join(" / ")}` });
  }
  if (langChanged && (after.localization?.languages ?? []).length > (before.localization?.languages ?? []).length) out.push({ area: "translations", what: "a language was added — every question, option and message needs its translation before that market launches", sentence: "Which questions are untranslated?" });
  return out;
}

export interface ReadinessCheck { id: string; ok: boolean; level: "blocker" | "warning"; message: string; fix?: string }
export interface LaunchReadiness { ready: boolean; blockers: number; warnings: number; checks: ReadinessCheck[]; summary: string }

export function launchReadiness(def: SurveyDefinition, opts: { tested?: boolean; links?: number | null; now?: number } = {}): LaunchReadiness {
  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck) => checks.push(c);
  const asked = def.questions.filter((q) => !["html", "hidden", "calculated", "embedded_data"].includes(q.type));
  add(asked.length ? { id: "questions", ok: true, level: "blocker", message: `${asked.length} questions.` } : { id: "questions", ok: false, level: "blocker", message: "The survey has no questions." });
  let lint: ReturnType<typeof runQualityCheck> | null = null;
  try { lint = runQualityCheck(def); } catch { lint = null; }
  const errors = lint ? lint.areas.flatMap((a) => a.issues.filter((i) => i.level === "error")) : [];
  add(lint === null ? { id: "lint", ok: false, level: "blocker", message: "The survey check could not run." } : errors.length ? { id: "lint", ok: false, level: "blocker", message: `${errors.length} error${errors.length === 1 ? "" : "s"} in the survey check: ${errors.slice(0, 3).map((e) => `${e.questionCode ? `${e.questionCode}: ` : ""}${e.message}`).join("; ")}`, fix: "Review the survey" } : { id: "lint", ok: true, level: "blocker", message: "The survey check passes." });
  const acc = def.deployment.access;
  if (acc.mode === "password") add(acc.password ? { id: "password", ok: true, level: "blocker", message: "Password set." } : { id: "password", ok: false, level: "blocker", message: "Access is by password and no password is set — nobody could start.", fix: "Password protect the survey with <password>" });
  if (acc.mode === "unique_links" || acc.mode === "invitation") add(opts.links === undefined || opts.links === null ? { id: "links", ok: false, level: "warning", message: `Access is by ${acc.mode === "invitation" ? "invitation" : "unique link"} — create or import the respondents before launch.` } : opts.links > 0 ? { id: "links", ok: true, level: "blocker", message: `${opts.links} respondent links exist.` } : { id: "links", ok: false, level: "blocker", message: `Access is by ${acc.mode === "invitation" ? "invitation" : "unique link"} and no links exist — nobody could start.` });
  const win = fieldworkWindow(def.deployment, opts.now ?? Date.now());
  if (!win.open && win.reason === "closed") add({ id: "window", ok: false, level: "blocker", message: `The closing date (${win.at.slice(0, 10)}) has passed — the live link would refuse everyone.`, fix: "Remove the fieldwork dates" });
  const brief = briefOfSurvey(def);
  const wantsConsent = brief.constraints.includes("consent") || brief.constraints.includes("ethics");
  const hasConsent = def.questions.some((q) => /\b(?:consent|agree\s+to\s+(?:take\s+part|participate))\b/i.test(q.text ?? ""));
  if (wantsConsent) add(hasConsent ? { id: "consent", ok: true, level: "blocker", message: "A consent question is in the survey." } : { id: "consent", ok: false, level: "blocker", message: "The study asks for consent / ethics approval and no question records consent.", fix: "Add a consent screen at the start" });
  if (isAnonymous(def)) { const ids = identifyingQuestions(def); if (ids.length) add({ id: "anonymity", ok: false, level: "warning", message: `The survey is anonymous but ${ids.map((q) => q.code).join(", ")} ask${ids.length === 1 ? "s" : ""} for an identifier — do not call it anonymous to respondents.` }); }
  for (const c of adviseSettings(def).filter((a) => a.status === "conflict")) add({ id: `settings:${c.id}`, ok: false, level: "warning", message: c.because });
  if (brief.quotas.length && !def.quotas.length) add({ id: "quotas", ok: false, level: "warning", message: `The study asks for ${brief.quotas.join(", ")} quotas and the survey has none.`, fix: `${brief.sampleSize ?? 500} completes split equally by ${brief.quotas[0]}` });
  const size = def.research?.sampleSize;
  if (size && def.quotas.length) { const tot = def.quotas.map((q) => q.targetTotal ?? q.cells.filter((c) => c.limitType === "count").reduce((s, c) => s + c.limit, 0)).filter((t) => t > 0); if (tot.some((t) => t !== size)) add({ id: "quota_totals", ok: false, level: "warning", message: `The sample size is ${size} but the quotas add up to ${[...new Set(tot)].join(" / ")}.` }); }
  const have = new Set([def.localization?.sourceLanguage ?? "en", ...(def.localization?.languages ?? []).map((l) => l.code)]);
  const missing = brief.languages.filter((l) => { const c = languageCode(l); return c && !have.has(c); });
  if (missing.length) add({ id: "languages", ok: false, level: "warning", message: `The study names ${missing.join(", ")} and the survey has no ${missing.length === 1 ? "version" : "versions"} in ${missing.length === 1 ? "it" : "them"}.`, fix: `Add ${missing.join(" and ")}` });
  if (!def.research?.fieldwork && (size || brief.sampleSize)) add({ id: "fieldwork", ok: false, level: "warning", message: "No fieldwork plan — the daily targets, the closing date and the risks are not written down.", fix: "Plan the fieldwork" });
  if (def.quality?.enabled === false) add({ id: "quality", ok: false, level: "warning", message: "Response quality checks are off — speeders, duplicates and bots will not be flagged.", fix: "Add bot protection" });
  add(opts.tested ? { id: "tested", ok: true, level: "warning", message: "A production-like test was run." } : { id: "tested", ok: false, level: "warning", message: "No production-like test has been run on this version.", fix: "Run a production-like test" });
  const blockers = checks.filter((c) => !c.ok && c.level === "blocker").length;
  const warnings = checks.filter((c) => !c.ok && c.level === "warning").length;
  return { ready: blockers === 0, blockers, warnings, checks, summary: blockers ? `Not ready to launch: ${blockers} blocker${blockers === 1 ? "" : "s"}${warnings ? ` and ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}.` : warnings ? `Ready to launch, with ${warnings} warning${warnings === 1 ? "" : "s"} to read first.` : "Ready to launch." };
}

/**
 * THE LAUNCH PLAN FROM A BRIEF (IM7): what happens between "build this study" and a live link, in order, each step
 * with what it will do — read from the brief and the survey as it stands, nothing applied. The master prompt's
 * healthcare sentence gets: the questionnaire drafted, the settings its respondents call for, the age / specialty /
 * region quotas once the questions exist, the fieldwork plan, the production-like test, and the launch checks.
 */
export function launchPlan(def: SurveyDefinition, brief: import("./researchBrief.js").ResearchBrief, now: number = Date.now()): string[] {
  const out: string[] = [];
  const n = brief.sampleSize ?? def.research?.sampleSize;
  out.push(`1 · Questionnaire — drafted from the brief${brief.loiMinutes ? ` to about ${brief.loiMinutes} minutes` : ""}${brief.methods.length ? `, with ${brief.methods.join(", ").replace(/_/g, " ")}` : ""}; reviewed and applied step by step.`);
  const advice = adviseSettings(def, brief, now).filter((a) => a.status !== "keep");
  out.push(`2 · Settings — ${advice.length ? advice.map((a) => `${a.setting.toLowerCase()}: ${a.recommended} (because ${a.because.split(/[;—]/)[0].trim()})`).join("; ") : "the defaults fit what the brief says"}. Say “Recommend the settings for this study” once the questions exist.`);
  out.push(brief.quotas.length ? `3 · Quotas — ${brief.quotas.join(", ")}${n ? ` over ${n.toLocaleString("en")} completes` : ""}: once the questions that define them exist, e.g. “${n ?? 1000} completes split equally by ${brief.quotas[0]}”; then “Is there enough sample for the quotas?” with the panel's numbers.` : "3 · Quotas — none asked for.");
  out.push(n ? `4 · Fieldwork — ${n.toLocaleString("en")} completes${brief.timelineDays ? ` in ${brief.timelineDays} days` : " (no timeline given: two weeks assumed)"}${brief.professional ? "; a professional audience fills slowly — the plan names the risk" : ""}. Say “Plan the fieldwork”.` : "4 · Fieldwork — give the number of completes to plan it.");
  out.push(`5 · Production-like test — ${brief.testing === "production-like" ? "as the brief asks: " : ""}simulated respondents against the live quota counts, the dates and the access settings; nothing written. Say “Run a production-like test”.`);
  out.push("6 · Launch — the readiness checks (survey errors, access, consent, quotas, languages, the test) must pass; publish from Versions & Deploy.");
  out.push("7 · After launch — the quality checks assess each complete on arrival; “Mark the flagged responses for review” reviews them as a batch; the findings deck comes from a run of the analysis plan.");
  return out;
}
