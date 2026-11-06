import type { SurveyDefinition } from "@rescript/schema";
import type { SurveyAction } from "./surveyActions.js";
import { readResearchBrief, type ResearchBrief } from "./researchBrief.js";
import { identifyingQuestions, isAnonymous } from "./deploymentActions.js";
import { languageCode } from "./aiInterviewActions.js";
import { QUESTIONS_PER_MINUTE } from "./relevance.js";

/**
 * SETTINGS ADVICE FROM THE RESEARCH CONTEXT (Intelligent Mode IM2, 2026-11-06).
 *
 * Each recommendation is keyed on a PROPERTY of this study — what its questions ask, where its respondents come
 * from, how long it is, what the brief says about time, languages and constraints — never on a research-type
 * table ("healthcare ⇒ X"). Every one says *because* in the study's own terms, names the evidence it read, and
 * carries the action that applies it (or the sentence that would, when no single action does). Nothing is
 * applied here: the caller proposes; a person applies.
 *
 *   status  change    the survey differs from the recommendation — `actions` apply it
 *           keep      the survey already does this — said, so a researcher sees it was considered
 *           conflict  two things the study asks for cannot both hold — `because` names both
 */
export interface SettingAdvice {
  id: "anonymous" | "access" | "retakes" | "back_button" | "progress_bar" | "closing_date" | "quality_checks" | "languages" | "consent" | "save_resume" | "dictation";
  setting: string;
  status: "change" | "keep" | "conflict";
  recommended: string;
  current: string;
  because: string;
  evidence: string[];
  actions: SurveyAction[];
  /** when no single action applies it: the sentence Intelligent Mode would act on */
  sentence?: string;
}

const SENSITIVE = [
  { words: /\b(?:diagnos\w*|illness|disease|symptom\w*|medication|prescri\w*|mental\s+health|depress\w*|anxiety|hiv|cancer|treatment|therap\w*|disabilit\w*)\b/i, what: "health" },
  { words: /\b(?:income|salary|salaries|debt|loan|savings|earn(?:ings)?)\b/i, what: "money" },
  { words: /\b(?:vote[ds]?|voting|party|politic\w*|election)\b/i, what: "political views" },
  { words: /\b(?:religio\w*|faith|caste|ethnic\w*|sexual\w*|gender\s+identity)\b/i, what: "identity" },
  { words: /\b(?:your\s+manager|line\s+manager|your\s+employer|leadership|workplace|colleagues|your\s+team|harass\w*|discriminat\w*)\b/i, what: "their employer" },
  { words: /\b(?:alcohol|drugs?|smok\w*|gambl\w*|illegal)\b/i, what: "behaviour people under-report" },
];
const CONSENT = /\b(?:consent|agree\s+to\s+(?:take\s+part|participate)|participation\s+is\s+voluntary|i\s+agree|information\s+sheet)\b/i;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** the brief this survey carries, as text the brief reader can read: objective, business question, background, audience */
export function briefTextOfSurvey(def: SurveyDefinition): string {
  const r = def.research;
  return [r?.brief?.businessQuestion, r?.brief?.background, r?.objective, r?.population, r?.audience?.description, r?.methodology, r?.sampleSize ? `${r.sampleSize} completes` : "", def.audience?.naturalLanguage]
    .filter((x): x is string => !!x && !!x.trim()).join(". ");
}
export function briefOfSurvey(def: SurveyDefinition, extra = ""): ResearchBrief {
  const text = [extra, briefTextOfSurvey(def)].filter((x) => x.trim()).join(". ");
  return readResearchBrief(text || def.meta.title);
}

export function adviseSettings(def: SurveyDefinition, given?: ResearchBrief | string | null, now: number = Date.now()): SettingAdvice[] {
  const brief = typeof given === "string" ? readResearchBrief(given) : given ?? briefOfSurvey(def);
  const out: SettingAdvice[] = [];
  const dep = def.deployment;
  const questions = def.questions.filter((q) => q.type !== "html" && q.type !== "hidden" && q.type !== "calculated" && q.type !== "embedded_data");
  const corpus = [def.research?.objective ?? "", ...questions.map((q) => q.text ?? "")].join("\n");

  /* 1 · anonymity — from what the questions ask about, or the brief's own word */
  const sensitive = SENSITIVE.filter((s) => s.words.test(corpus)).map((s) => s.what);
  const asksAnon = brief.constraints.includes("anonymous");
  const ids = identifyingQuestions(def);
  if (sensitive.length || asksAnon) {
    const why = asksAnon ? "the brief asks for anonymity" : `the questions ask about ${sensitive.slice(0, 3).join(", ")} — people answer such questions more honestly when nothing ties the answers to them`;
    if (ids.length) out.push({ id: "anonymous", setting: "Anonymity", status: "conflict", recommended: "anonymous", current: isAnonymous(def) ? "anonymous, but identifying questions remain" : "identifiable", because: `${why}; but ${ids.map((q) => q.code).join(", ")} ${ids.length === 1 ? "asks" : "ask"} for something that identifies the respondent. Remove ${ids.length === 1 ? "it" : "them"} for an anonymous survey, or keep ${ids.length === 1 ? "it" : "them"} and call the survey confidential.`, evidence: [...sensitive.map((s) => `questions about ${s}`), ...ids.map((q) => `${q.code} asks for an identifier`)], actions: [] });
    else if (!isAnonymous(def)) out.push({ id: "anonymous", setting: "Anonymity", status: "change", recommended: "anonymous (no IP or device hash)", current: "IP and device hashes recorded", because: `${why}. The duplicate-device and shared-network checks stop running; the other quality checks keep working.`, evidence: asksAnon ? ["the brief: anonymous"] : sensitive.map((s) => `questions about ${s}`), actions: [{ op: "set_deployment", anonymous: true } as SurveyAction] });
    else out.push({ id: "anonymous", setting: "Anonymity", status: "keep", recommended: "anonymous", current: "anonymous", because: why, evidence: [], actions: [] });
  }

  /* 2 · access — from where respondents come from */
  const panels = (def.panels ?? []).length;
  const listed = brief.professional || panels > 0 || /\b(?:panel|vendor|database|customer\s+list|crm|employees?|members?)\b/i.test(`${def.research?.population ?? ""} ${def.audience?.naturalLanguage ?? ""}`);
  if (listed && dep.access.mode === "open" && !(sensitive.length && !brief.professional && !panels)) {
    const src = panels ? plural(panels, "panel source") : brief.professional ? `a professional population (${brief.population ?? "named in the brief"})` : "a list of known respondents";
    out.push({ id: "access", setting: "Access", status: "change", recommended: "unique links", current: "open link", because: `respondents come from ${src}: a link per respondent cannot be forwarded, and each complete stays tied to its source for incentives and reconciliation.`, evidence: [src], actions: [{ op: "set_deployment", access: "unique_links" } as SurveyAction] });
  } else if (dep.access.mode !== "open") out.push({ id: "access", setting: "Access", status: "keep", recommended: dep.access.mode.replace("_", " "), current: dep.access.mode.replace("_", " "), because: "respondents already need their own link or the password", evidence: [], actions: [] });

  /* 3 · retakes — from the counts the study depends on */
  const counted = !!(brief.sampleSize || def.research?.sampleSize || def.quotas.length);
  if (counted) {
    if (dep.access.allowRetake) out.push({ id: "retakes", setting: "Retakes", status: "change", recommended: "one response per respondent", current: "retakes allowed", because: `the study counts completes${def.quotas.length ? ` against ${plural(def.quotas.length, "quota")}` : ""}${brief.sampleSize ? ` towards n = ${brief.sampleSize.toLocaleString("en")}` : ""}; a second response from the same person would be counted twice.`, evidence: ["a target sample or quotas"], actions: [{ op: "set_deployment", allowRetake: false } as SurveyAction] });
    else out.push({ id: "retakes", setting: "Retakes", status: "keep", recommended: "one response per respondent", current: "one response per respondent", because: "the study counts completes, so each respondent answers once", evidence: [], actions: [] });
  }

  /* 4 · the back button — only from the brief's own words */
  if (brief.constraints.includes("noBack")) {
    const shown = def.branding?.buttons?.showBack !== false;
    out.push({ id: "back_button", setting: "Back button", status: shown ? "change" : "keep", recommended: "hidden", current: shown ? "shown" : "hidden", because: "the brief asks that respondents cannot go back — typical when later questions would reveal what earlier ones measured (unaided before aided awareness, a concept before its evaluation).", evidence: ["the brief: no back button"], actions: shown ? [{ op: "set_theme", patch: { buttons: { showBack: false } }, label: "Back button hidden" } as SurveyAction] : [] });
  }

  /* 5 · the progress bar — from the length */
  const minutes = brief.loiMinutes ?? Math.round(questions.length / QUESTIONS_PER_MINUTE);
  const bar = def.branding?.layout?.progressBar ?? "top";
  if (minutes >= 8 && bar === "none") out.push({ id: "progress_bar", setting: "Progress bar", status: "change", recommended: "shown", current: "hidden", because: `the survey takes about ${minutes} minutes; respondents who can see how far they are break off less often.`, evidence: [brief.loiMinutes ? `the brief: ${brief.loiMinutes} minutes` : `${questions.length} questions`], actions: [{ op: "set_theme", patch: { layout: { progressBar: "top" } }, label: "Progress bar top" } as SurveyAction] });
  if (minutes >= 15) out.push({ id: "save_resume", setting: "Save and resume", status: "keep", recommended: "on", current: "on (always)", because: `about ${minutes} minutes is long enough that some respondents stop part-way; every answer is saved as they go and the resume link continues where they left off.`, evidence: [], actions: [] });

  /* 6 · the closing date — from the brief's timeline */
  if (brief.timelineDays && !dep.activeUntil) {
    const until = new Date(now + brief.timelineDays * 86_400_000).toISOString().slice(0, 10);
    out.push({ id: "closing_date", setting: "Closing date", status: "change", recommended: `close at the end of ${until}`, current: "no closing date", because: `the brief gives ${brief.timelineDays} days of fieldwork; a closing date stops late arrivals being counted after the analysis has started. Move it if the launch moves.`, evidence: [`the brief: ${brief.timelineDays} days`], actions: [{ op: "set_deployment", activeUntil: `${until}T23:59:59Z` } as SurveyAction] });
  }

  /* 7 · quality checks — from where the sample comes from */
  if (def.quality?.enabled === false && (panels || brief.isBrief || counted)) out.push({ id: "quality_checks", setting: "Response quality checks", status: "change", recommended: "on", current: "off", because: "completes that count towards a target should be checked for speeding, straight-lining, duplicates and bots before they are analysed; the checks flag and explain, a person decides.", evidence: ["quality checks are off"], actions: [{ op: "set_quality_settings", enabled: true } as SurveyAction] });

  /* 8 · languages — from the brief's languages */
  if (brief.languages.length > 1 || (brief.languages.length === 1 && languageCode(brief.languages[0]) !== (def.localization?.sourceLanguage ?? "en"))) {
    const have = new Set([def.localization?.sourceLanguage ?? "en", ...(def.localization?.languages ?? []).map((l) => l.code)]);
    const missing = brief.languages.filter((l) => { const c = languageCode(l); return c && !have.has(c); });
    if (missing.length) out.push({ id: "languages", setting: "Languages", status: "change", recommended: brief.languages.join(", "), current: [...have].join(", "), because: `the brief names ${brief.languages.join(", ")}; respondents answer in the language they read best, and each version is checked for completeness before launch.`, evidence: [`the brief: ${brief.languages.join(", ")}`], actions: [], sentence: `Add ${missing.join(" and ")}` });
  }

  /* 9 · consent — from the brief, or a professional / sensitive study with no consent screen */
  const hasConsent = def.questions.some((q) => CONSENT.test(q.text ?? ""));
  if (!hasConsent && (brief.constraints.includes("consent") || brief.constraints.includes("ethics") || (brief.professional && sensitive.length))) {
    out.push({ id: "consent", setting: "Consent screen", status: "change", recommended: "a consent question first, ending the survey on No", current: "none", because: brief.constraints.includes("consent") || brief.constraints.includes("ethics") ? "the brief asks for consent / ethics approval; nothing in the survey records it." : `the respondents are professionals answering about ${sensitive.join(", ")}: informed consent is recorded before the first question.`, evidence: ["no question mentions consent"], actions: [], sentence: "Add a consent question at the start that ends the survey when the answer is No" });
  }

  /* 10 · dictation — on mobile-first studies with open ends */
  const openEnds = def.questions.filter((q) => q.type === "open_text" || q.type === "long_text").length;
  if (brief.constraints.includes("mobileFirst") && openEnds && dep.speechInput === false) out.push({ id: "dictation", setting: "Dictation", status: "change", recommended: "on", current: "off", because: `the study is mobile-first with ${plural(openEnds, "open end")}; speaking an answer on a phone gives longer answers than typing it. Audio stays on the device.`, evidence: ["the brief: mobile-first"], actions: [{ op: "set_deployment", speechInput: true } as SurveyAction] });

  return out;
}

/** the advice as lines for a card or a model's context: one line per setting, its status and its because */
export function describeSettingsAdvice(list: SettingAdvice[]): string {
  if (!list.length) return "No setting needs to change for what this study is.";
  return list.map((a) => `${a.status === "change" ? "→" : a.status === "conflict" ? "!" : "✓"} ${a.setting}: ${a.status === "keep" ? a.current : `${a.current} → ${a.recommended}`} — because ${a.because}`).join("\n");
}
