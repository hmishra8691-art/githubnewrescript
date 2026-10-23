import type { AiLanguagePack, QualStudy } from "@rescript/schema";
import { buildModeratorPlan, moderationOf, type ModeratorPlan } from "./aiModerator.js";
import { EN_MESSAGES, PARTICIPANT_MESSAGE_KEYS } from "./aiInterviewMessages.js";
import { EN_WORDS, MODERATOR_WORD_KEYS } from "./aiInterviewWords.js";
import { baseLanguage, BUILTIN_MESSAGES, BUILTIN_WORDS } from "./aiInterviewLanguages.js";
import type { PublicStudyView } from "./aiInterviewStudy.js";

/**
 * THE GUIDE IN EVERY STUDY LANGUAGE (G1 2026-10-22). At launch each study language other than the guide's
 * gets a LANGUAGE PACK: the guide's own words (questions, leads, probes, conditional probes, opening,
 * closing, thank-you, incentive, objectives, text stimuli, consent, screener) machine-translated through
 * the configured translation provider (the Studio's metered `/api/ai/translate`), plus the moderator's rule
 * wording and the participant page's labels when the language has no built-in ones. The pack is kept with
 * the guide (`aiModeration.translations[lang]`) and in the launch snapshot, and the researcher can review
 * and edit it in the Studio. The runtime localizes the moderator's PLAN with it, so when the AI provider
 * fails the interview continues on the guide's scripted questions in the participant's language.
 *
 * The model still reads the guide in its own language (one cached prefix per study); the pack only
 * changes what the RULES say.
 */

export interface PackItem { key: string; text: string; kind: string }

/** the guide's own words a pack translates, by key */
export function guideSourceTexts(study: QualStudy, plan: ModeratorPlan = buildModeratorPlan(study)): PackItem[] {
  const cfg = moderationOf(study);
  const out: PackItem[] = [];
  const add = (key: string, text: string | undefined, kind: string) => { const t = String(text ?? "").trim(); if (t) out.push({ key, text: t, kind }); };
  add("title", plan.title, "the interview's title, shown to the participant");
  for (const s of plan.steps) {
    add(`q:${s.key}`, s.text, "interview question");
    add(`lead:${s.key}`, s.lead, "what the interviewer says before a section");
    s.probes.forEach((p, i) => add(`probe:${s.key}:${i}`, p, "follow-up question"));
    s.conditional.forEach((c, i) => { add(`if:${s.key}:${i}`, c.ifMentions, "a topic the participant may mention"); add(`ask:${s.key}:${i}`, c.ask, "follow-up question"); });
  }
  add("opening", plan.opening, "the interviewer's opening words");
  add("closing", plan.closingScript, "the interviewer's closing words");
  add("thanks", plan.thankYou, "thank-you message");
  add("incentive", plan.incentive, "incentive description");
  for (const o of plan.objectives) add(`obj:${o.id}`, o.text, "a research objective (said as a topic)");
  for (const st of cfg.stimuli) if (st.kind === "text") add(`stim:${st.name}`, st.text ?? st.name, "a concept shown to the participant");
  add("consent.statement", study.consent.statement, "consent statement");
  add("consent.recording", study.consent.recordingDisclosure, "recording disclosure");
  add("consent.dataUse", study.consent.dataUse, "data use statement");
  for (const q of cfg.screener) { add(`scr:${q.id}`, q.text, "screening question"); q.options.forEach((o, i) => add(`scr:${q.id}:${i}`, o.label, "answer option")); }
  return out;
}

/** everything a pack for `language` needs translated: the guide, and the rule wording / page labels unless built in */
export function packSourceItems(study: QualStudy, language: string, plan?: ModeratorPlan): PackItem[] {
  const lang = baseLanguage(language);
  const items = guideSourceTexts(study, plan);
  if (!BUILTIN_WORDS[lang]) for (const k of MODERATOR_WORD_KEYS) items.push({ key: `w:${k}`, text: EN_WORDS[k], kind: "an AI interviewer's words ({name}/{topic} are placeholders)" });
  if (!BUILTIN_MESSAGES[lang]) for (const k of PARTICIPANT_MESSAGE_KEYS) items.push({ key: `ui:${k}`, text: EN_MESSAGES[k], kind: "a label or message on the participant's interview page" });
  return items;
}

/** a stable fingerprint of the guide wording a pack was made from */
export function packSourceHash(study: QualStudy): string {
  const t = guideSourceTexts(study).map((i) => `${i.key}=${i.text}`).join("\n");
  let h1 = 2166136261, h2 = 5381;
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); h1 ^= c; h1 = Math.imul(h1, 16777619); h2 = (Math.imul(h2, 33) ^ c) >>> 0; }
  return `${(h1 >>> 0).toString(36)}${h2.toString(36)}`;
}

/** key → translation (from the provider, or edited) → a pack */
export function buildLanguagePack(study: QualStudy, language: string, translations: Record<string, string>, o: { provider?: string; at?: string; source?: "machine" | "edited" } = {}): AiLanguagePack {
  const texts: Record<string, string> = {}, words: Record<string, string> = {}, ui: Record<string, string> = {};
  for (const [k, v] of Object.entries(translations)) {
    const t = String(v ?? "").trim();
    if (!t) continue;
    if (k.startsWith("w:")) words[k.slice(2)] = t;
    else if (k.startsWith("ui:")) ui[k.slice(3)] = t;
    else texts[k] = t;
  }
  return { language: baseLanguage(language), source: o.source ?? "machine", ...(o.provider ? { provider: o.provider } : {}), ...(o.at ? { translatedAt: o.at } : {}), sourceHash: packSourceHash(study), texts, words, ui };
}

export interface PackStatus { language: string; builtinUi: boolean; builtinWords: boolean; hasPack: boolean; stale: boolean; missing: string[]; source?: "machine" | "edited" }

/** what a study language still needs before launch: nothing, a pack, or a fresh one (the guide changed) */
export function languagePackStatus(study: QualStudy, language: string, guideLanguage = "en"): PackStatus {
  const lang = baseLanguage(language);
  const pack = moderationOf(study).translations?.[lang];
  const builtinUi = !!BUILTIN_MESSAGES[lang], builtinWords = !!BUILTIN_WORDS[lang];
  if (lang === baseLanguage(guideLanguage)) return { language: lang, builtinUi, builtinWords, hasPack: true, stale: false, missing: [] };
  const need = packSourceItems(study, lang);
  const have = (k: string) => (k.startsWith("w:") ? pack?.words?.[k.slice(2)] : k.startsWith("ui:") ? pack?.ui?.[k.slice(3)] : pack?.texts?.[k]);
  const missing = need.filter((i) => !have(i.key)).map((i) => i.key);
  return { language: lang, builtinUi, builtinWords, hasPack: !!pack, stale: !!pack && !!pack.sourceHash && pack.sourceHash !== packSourceHash(study), missing, ...(pack ? { source: pack.source } : {}) };
}

/** the study languages that need a pack made (or remade) before launch */
export function languagesNeedingPacks(study: QualStudy, guideLanguage = "en"): string[] {
  return moderationOf(study).languages.map(baseLanguage).filter((l, i, a) => l && a.indexOf(l) === i && l !== baseLanguage(guideLanguage))
    .filter((l) => { const s = languagePackStatus(study, l, guideLanguage); return !s.hasPack || s.stale || s.missing.length > 0; });
}

/**
 * The moderator's plan in a study language: the rules' wording (questions, probes, conditional probes,
 * leads, opening, closing, thank-you, incentive, objectives) from the pack; any text the pack lacks stays
 * in the guide's language. The guide language and the objective ids never change.
 */
export function localizePlan(plan: ModeratorPlan, language: string, pack: AiLanguagePack | null | undefined): ModeratorPlan {
  const lang = baseLanguage(language);
  if (!pack || !lang || lang === baseLanguage(plan.guideLanguage)) return plan;
  const t = (k: string, fallback: string) => pack.texts?.[k]?.trim() || fallback;
  return {
    ...plan,
    title: t("title", plan.title),
    opening: plan.opening ? t("opening", plan.opening) : plan.opening,
    closingScript: plan.closingScript ? t("closing", plan.closingScript) : plan.closingScript,
    ...(plan.thankYou ? { thankYou: t("thanks", plan.thankYou) } : {}),
    ...(plan.incentive ? { incentive: t("incentive", plan.incentive) } : {}),
    objectives: plan.objectives.map((o) => ({ ...o, text: t(`obj:${o.id}`, o.text) })),
    steps: plan.steps.map((s) => ({
      ...s,
      text: t(`q:${s.key}`, s.text),
      ...(s.lead ? { lead: t(`lead:${s.key}`, s.lead) } : {}),
      probes: s.probes.map((p, i) => t(`probe:${s.key}:${i}`, p)),
      conditional: s.conditional.map((c, i) => ({ ifMentions: t(`if:${s.key}:${i}`, c.ifMentions), ask: t(`ask:${s.key}:${i}`, c.ask) })),
      stimuli: s.stimuli.map((x) => (x.kind === "text" && pack.texts?.[`stim:${x.name}`] ? { ...x, text: pack.texts[`stim:${x.name}`] } : x)),
    })),
    localized: lang,
    ...(Object.keys(pack.words ?? {}).length ? { words: pack.words } : {}),
  };
}

/** what the participant page shows before the interview, in a study language (consent, title, screener) */
export interface LocalizedPublicText { title?: string; consent?: { statement?: string; recordingDisclosure?: string; dataUse?: string }; screener?: Record<string, { text?: string; options?: string[] }>; incentive?: string; ui?: Record<string, string> }
export function publicTextFor(view: PublicStudyView, pack: AiLanguagePack | null | undefined, cfgScreener: { id: string; options: unknown[] }[]): LocalizedPublicText {
  if (!pack) return {};
  const tx = pack.texts ?? {};
  const screener: NonNullable<LocalizedPublicText["screener"]> = {};
  for (const q of cfgScreener) {
    const opts = q.options.map((_, i) => tx[`scr:${q.id}:${i}`] ?? "");
    if (tx[`scr:${q.id}`] || opts.some(Boolean)) screener[q.id] = { ...(tx[`scr:${q.id}`] ? { text: tx[`scr:${q.id}`] } : {}), options: opts };
  }
  return {
    ...(tx.title ? { title: tx.title } : {}),
    consent: { ...(tx["consent.statement"] ? { statement: tx["consent.statement"] } : {}), ...(tx["consent.recording"] && view.consent.recordingDisclosure ? { recordingDisclosure: tx["consent.recording"] } : {}), ...(tx["consent.dataUse"] && view.consent.dataUse ? { dataUse: tx["consent.dataUse"] } : {}) },
    ...(Object.keys(screener).length ? { screener } : {}),
    ...(tx.incentive && view.incentive ? { incentive: tx.incentive } : {}),
    ...(Object.keys(pack.ui ?? {}).length ? { ui: pack.ui } : {}),
  };
}
