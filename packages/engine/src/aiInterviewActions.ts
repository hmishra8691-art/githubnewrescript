import type { AiModeration, AiProbingDepth, AiQuota, AiScreenerQuestion, AiStimulus, QualStudy, SurveyDefinition } from "@rescript/schema";
import { AiModeration as AiModerationSchema, AI_INTERVIEW_MODES, AI_PROBING_DEPTHS } from "@rescript/schema";
import { estimateInterviewCostUsd, launchProblems, safeHttpsUrl } from "./aiInterviewStudy.js";
import { buildModeratorPlan } from "./aiModerator.js";

/**
 * AI-MODERATED INTERVIEWS AS AN INTELLIGENT-MODE ACTION (2026-10-22).
 *
 *   configure_ai_interviews   turns the interview guide (`def.qualStudy`, kind interview) into an
 *                             AI-moderated study, or patches its configuration: modes (text / voice /
 *                             video), minutes, turns, probing depth (overall and per question), the
 *                             objectives to cover, languages, the screener (simple questions, or copied
 *                             from a survey question), quotas, completes wanted, persona, stimuli, the
 *                             thank-you / incentive / redirect, the cost caps. Writes
 *                             `def.qualStudy.aiModeration` and NOTHING else — consent stays the guide's.
 *
 * Patch semantics like `update_qual_guide`: a field given replaces; `addObjectives`,
 * `addLanguages`, `addScreener`, `addQuotas`, `addStimuli` append; `probing` per question merges by
 * question. Deterministic (ids are `scr<n>`), so the server's preview is the browser's replay. It never
 * launches anything: launching (a link, real participants, real money) is the researcher's button in
 * Research Tools → Qualitative → AI interviews, after the consent check.
 *
 * External URLs (redirect, stimuli) are https-only here, and the provenance gate (provenance.ts) holds
 * any external URL that came from document content rather than the researcher's own words.
 */

export const AI_INTERVIEW_ACTION_OPS = ["configure_ai_interviews"] as const;
export const isAiInterviewOp = (op: string): boolean => op === "configure_ai_interviews";

export interface AiInterviewAction {
  op: "configure_ai_interviews";
  enabled?: boolean;
  modes?: AiModeration["modes"];
  targetMinutes?: number | null;
  maxTurns?: number;
  defaultProbing?: AiProbingDepth;
  /** per guide question: its id or the start of its text */
  probing?: { question: string; depth: AiProbingDepth; maxFollowUps?: number }[];
  /** drop every per-question rule first (the Studio's form sends the whole list) */
  resetProbing?: boolean;
  objectives?: string[];
  addObjectives?: string[];
  languages?: string[];
  addLanguages?: string[];
  screener?: ScreenerInput[];
  addScreener?: ScreenerInput[];
  quotas?: AiQuota[];
  targetCompletes?: number | null;
  recordingConsent?: "optional" | "required";
  incentive?: string | null;
  thankYouMessage?: string | null;
  redirectUrl?: string | null;
  persona?: { name?: string; tone?: AiModeration["persona"]["tone"]; style?: string | null };
  stimuli?: AiStimulus[];
  addStimuli?: AiStimulus[];
  costCapUsd?: number;
  studyBudgetUsd?: number | null;
  silenceSeconds?: number;
}
export interface ScreenerInput { text?: string; kind?: "single" | "multi" | "number"; options?: { label: string; qualifies?: boolean; segment?: string }[]; min?: number; max?: number; fromQuestion?: string; qualifying?: string[]; segments?: Record<string, string> }

const str = (v: unknown, max = 2000): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v.replace(/[$,]/g, ""))) ? Number(v.replace(/[$,]/g, "")) : undefined);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const list = (v: unknown, max = 40): string[] | undefined => (Array.isArray(v) ? v.map((x) => str(typeof x === "object" && x ? (x as Record<string, unknown>).text ?? (x as Record<string, unknown>).name : x, 600)).filter((x): x is string => !!x).slice(0, max) : typeof v === "string" && v.trim() ? v.split(/\s*,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean).slice(0, max) : undefined);

const LANGUAGE_NAMES: Record<string, string> = {
  english: "en", hindi: "hi", marathi: "mr", bengali: "bn", bangla: "bn", tamil: "ta", telugu: "te", kannada: "kn", malayalam: "ml", gujarati: "gu", punjabi: "pa", urdu: "ur", odia: "or", oriya: "or",
  spanish: "es", french: "fr", german: "de", portuguese: "pt", italian: "it", dutch: "nl", arabic: "ar", chinese: "zh", mandarin: "zh", japanese: "ja", korean: "ko", russian: "ru", turkish: "tr", indonesian: "id", vietnamese: "vi", thai: "th", polish: "pl", swahili: "sw", hebrew: "he", greek: "el",
  "हिंदी": "hi", "हिन्दी": "hi", "अंग्रेज़ी": "en", "अंग्रेजी": "en", "मराठी": "mr",
};
/** "Hindi" / "hi-IN" / "हिंदी" → "hi"; null when it is not a language */
export function languageCode(v: string): string | null {
  const t = v.trim().toLowerCase();
  if (LANGUAGE_NAMES[t]) return LANGUAGE_NAMES[t];
  if (/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?$/i.test(t)) return t.split(/[-_]/)[0];
  return null;
}

function modesOf(v: unknown): AiModeration["modes"] | { error: string } | undefined {
  if (v === undefined) return undefined;
  const raw = list(v, 6) ?? [];
  const out = new Set<AiModeration["modes"][number]>();
  for (const m of raw.map((x) => x.toLowerCase())) {
    if (/^(?:text|chat|typed|written)$/.test(m)) out.add("text");
    else if (/^(?:voice|audio|spoken|speech)$/.test(m)) out.add("voice");
    else if (/^(?:video|camera|voice\+camera|voice \+ camera|webcam)$/.test(m)) { out.add("video"); }
    else return { error: `modes are ${AI_INTERVIEW_MODES.join(", ")} (got “${m}”)` };
  }
  return out.size ? [...out] : { error: "modes needs at least one of text, voice, video" };
}
const depthOf = (v: unknown): AiProbingDepth | undefined => { const t = str(v, 20)?.toLowerCase(); if (!t) return undefined; if ((AI_PROBING_DEPTHS as readonly string[]).includes(t)) return t as AiProbingDepth; if (/^(?:off|no|zero)$/.test(t)) return "none"; if (/^(?:shallow|some|medium|moderate)$/.test(t)) return "light"; if (/^(?:deeper|high|thorough|in[- ]?depth)$/.test(t)) return "deep"; return undefined; };

function screenerIn(v: unknown, what: string): ScreenerInput[] | { error: string } | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return { error: `${what} is a list of questions` };
  const out: ScreenerInput[] = [];
  for (const x of v) {
    const o = obj(x);
    if (!o) return { error: `${what}: a screener question is {text, options:[{label, qualifies, segment}]} or {fromQuestion, qualifying}` };
    const from = str(o.fromQuestion ?? o.from ?? o.question, 120);
    const text = str(o.text, 600);
    if (!from && !text) return { error: `${what}: a screener question needs text (or fromQuestion: a survey question's code)` };
    const kind = o.kind === "multi" || o.kind === "number" ? o.kind : "single";
    const options = Array.isArray(o.options) ? o.options.map((p) => (typeof p === "string" ? { label: p.trim().slice(0, 200) } : (() => { const q = obj(p); const label = str(q?.label ?? q?.text, 200); return label ? { label, ...(q?.qualifies === false || q?.qualify === false || q?.disqualify === true ? { qualifies: false } : {}), ...(str(q?.segment, 120) ? { segment: str(q?.segment, 120) } : {}) } : null; })())).filter((p): p is NonNullable<typeof p> => !!p && !!p.label).slice(0, 30) : undefined;
    if (!from && kind !== "number" && !(options && options.length >= 2)) return { error: `${what}: “${text}” needs at least two options` };
    const segs = obj(o.segments);
    out.push({ ...(text ? { text } : {}), kind, ...(options ? { options } : {}), ...(num(o.min) !== undefined ? { min: num(o.min) } : {}), ...(num(o.max) !== undefined ? { max: num(o.max) } : {}), ...(from ? { fromQuestion: from } : {}), ...(list(o.qualifying ?? o.qualify, 30) ? { qualifying: list(o.qualifying ?? o.qualify, 30) } : {}), ...(segs ? { segments: Object.fromEntries(Object.entries(segs).map(([k, s]) => [k, String(s).slice(0, 120)])) } : {}) });
  }
  return out.slice(0, 12);
}
function stimuliIn(v: unknown): AiStimulus[] | { error: string } | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return { error: "stimuli is a list of {name, kind: image|video|text, url | text}" };
  const out: AiStimulus[] = [];
  for (const x of v) {
    const o = obj(x); const name = str(o?.name ?? o?.title, 200);
    if (!o || !name) return { error: "a stimulus needs a name (the name the guide's section uses)" };
    const kind = o.kind === "image" || o.kind === "video" ? o.kind : o.kind === "text" || !o.url ? "text" : /\.(?:mp4|webm|mov)(?:\?|$)/i.test(String(o.url)) ? "video" : "image";
    const url = str(o.url, 2000);
    if (kind !== "text" && (!url || !safeHttpsUrl(url))) return { error: `stimulus “${name}”: an ${kind} needs an https URL` };
    out.push({ name, kind, ...(kind !== "text" && url ? { url } : {}), ...(kind === "text" ? { text: str(o.text ?? o.description, 4000) ?? name } : {}), ...(str(o.alt, 300) ? { alt: str(o.alt, 300) } : {}) });
  }
  return out.slice(0, 20);
}

/** The gate: the model's JSON as a typed action, a reason, or null when the op is not this one. */
export function coerceAiInterviewAction(op: string, o: Record<string, unknown>): AiInterviewAction | string | null {
  if (!isAiInterviewOp(op)) return null;
  const a: AiInterviewAction = { op: "configure_ai_interviews" };
  if (typeof o.enabled === "boolean") a.enabled = o.enabled;
  if (o.resetProbing === true) a.resetProbing = true;
  const modes = modesOf(o.modes ?? o.mode); if (modes && "error" in modes) return `${op}: ${modes.error}`; if (modes) a.modes = modes;
  const mins = o.targetMinutes ?? o.minutes ?? o.durationMinutes;
  if (mins === null) a.targetMinutes = null; else if (mins !== undefined) { const n = num(mins); if (n === undefined || n < 3 || n > 120) return `${op}: targetMinutes is 3–120`; a.targetMinutes = Math.round(n); }
  if (o.maxTurns !== undefined) { const n = num(o.maxTurns); if (n === undefined || n < 4 || n > 200) return `${op}: maxTurns is 4–200`; a.maxTurns = Math.round(n); }
  const dp = o.defaultProbing ?? (typeof o.probing === "string" ? o.probing : undefined) ?? o.probingDepth ?? o.depth;
  if (dp !== undefined) { const d = depthOf(dp); if (!d) return `${op}: probing depth is none, light or deep`; a.defaultProbing = d; }
  if (Array.isArray(o.probing)) {
    const rules: NonNullable<AiInterviewAction["probing"]> = [];
    for (const x of o.probing) { const r = obj(x); const q = str(r?.question ?? r?.questionId ?? r?.target, 400); const d = depthOf(r?.depth); if (!q || !d) return `${op}: a probing rule is {question: id or text, depth: none|light|deep}`; const m = num(r?.maxFollowUps); rules.push({ question: q, depth: d, ...(m !== undefined ? { maxFollowUps: Math.max(0, Math.min(5, Math.round(m))) } : {}) }); }
    a.probing = rules;
  }
  for (const k of ["objectives", "addObjectives"] as const) { const v = list(o[k], 20); if (v) a[k] = v; }
  for (const k of ["languages", "addLanguages"] as const) {
    const v = list(o[k] ?? (k === "languages" ? o.language : undefined), 20);
    if (!v) continue;
    const codes = v.map(languageCode);
    const bad = v.filter((_, i) => !codes[i]);
    if (bad.length) return `${op}: not a language: ${bad.join(", ")} (use a name like “Hindi” or a code like “hi”)`;
    a[k] = [...new Set(codes as string[])];
  }
  for (const k of ["screener", "addScreener"] as const) { const s = screenerIn(o[k], k); if (s && "error" in s) return `${op}: ${s.error}`; if (s) a[k] = s; }
  if (o.quotas !== undefined) {
    if (!Array.isArray(o.quotas)) return `${op}: quotas is a list of {segment, target}`;
    const qs: AiQuota[] = [];
    for (const x of o.quotas) { const q = obj(x); const segment = str(q?.segment ?? q?.name ?? q?.group, 120); const target = num(q?.target ?? q?.n ?? q?.count); if (!segment || target === undefined || target < 0) return `${op}: a quota is {segment, target}`; qs.push({ segment, target: Math.round(target) }); }
    a.quotas = qs;
  }
  const tc = o.targetCompletes ?? o.participants ?? o.completes ?? o.sampleSize;
  if (tc === null) a.targetCompletes = null; else if (tc !== undefined) { const n = num(tc); if (n === undefined || n < 1 || n > 100_000) return `${op}: targetCompletes is a number of interviews`; a.targetCompletes = Math.round(n); }
  if (o.recordingConsent === "optional" || o.recordingConsent === "required") a.recordingConsent = o.recordingConsent;
  for (const k of ["incentive", "thankYouMessage"] as const) { if (o[k] === null) a[k] = null; else { const v = str(o[k], 600); if (v) a[k] = v; } }
  if (o.redirectUrl === null) a.redirectUrl = null; else if (o.redirectUrl !== undefined) { const u = str(o.redirectUrl, 2000); if (!u || !safeHttpsUrl(u)) return `${op}: redirectUrl must be an https address (only {{pid}} may be piped)`; if (/\{\{(?!\s*pid\s*\}\})|\$\{|\[\[/.test(u)) return `${op}: redirectUrl may pipe only {{pid}}`; a.redirectUrl = u; }
  const p = obj(o.persona);
  if (p) { const tone = str(p.tone, 20)?.toLowerCase(); if (tone && !["warm", "neutral", "professional", "casual"].includes(tone)) return `${op}: persona.tone is warm, neutral, professional or casual`; a.persona = { ...(str(p.name, 40) ? { name: str(p.name, 40) } : {}), ...(tone ? { tone: tone as AiModeration["persona"]["tone"] } : {}), ...(p.style === null ? { style: null } : str(p.style, 200) ? { style: str(p.style, 200) } : {}) }; }
  for (const k of ["stimuli", "addStimuli"] as const) { const s = stimuliIn(o[k]); if (s && "error" in s) return `${op}: ${s.error}`; if (s) a[k] = s; }
  if (o.costCapUsd !== undefined) { const n = num(o.costCapUsd); if (n === undefined || n <= 0 || n > 50) return `${op}: costCapUsd is a dollar amount above 0 and at most 50 per interview`; a.costCapUsd = n; }
  if (o.studyBudgetUsd === null) a.studyBudgetUsd = null; else if (o.studyBudgetUsd !== undefined) { const n = num(o.studyBudgetUsd); if (n === undefined || n <= 0) return `${op}: studyBudgetUsd is a dollar amount`; a.studyBudgetUsd = n; }
  if (o.silenceSeconds !== undefined) { const n = num(o.silenceSeconds); if (n === undefined || n < 20 || n > 600) return `${op}: silenceSeconds is 20–600`; a.silenceSeconds = Math.round(n); }
  if (Object.keys(a).length === 1) return `${op} names nothing to configure`;
  return a;
}

/* ------------------------------------------------------------ applying */

class AiInterviewActionError extends Error {}
const fail = (m: string): never => { throw new AiInterviewActionError(m); };
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function guideQuestion(study: QualStudy, ref: string): string {
  const r = norm(ref);
  for (const s of study.sections) for (const q of s.questions) if (q.id === ref) return q.id;
  for (const s of study.sections) for (const q of s.questions) if (norm(q.text) === r || norm(q.text).startsWith(r)) return q.id;
  return fail(`the guide has no question “${ref}” (use its id, e.g. s2q1, or the start of its text)`);
}

function screenerQuestion(def: SurveyDefinition, input: ScreenerInput, id: string): AiScreenerQuestion {
  if (input.fromQuestion) {
    const ref = input.fromQuestion;
    const q = def.questions.find((x) => x.id === ref || x.code === ref || (x as { variableName?: string }).variableName === ref) ?? fail(`there is no survey question “${ref}” to copy into the screener`);
    if (!q.options.length) fail(`“${ref}” has no options to screen on`);
    const label = (o: { label?: string; text?: string; code?: unknown }) => String(o.label ?? o.text ?? o.code ?? "").replace(/<[^>]+>/g, "").trim().slice(0, 200);
    const qualifying = input.qualifying?.map(norm);
    const options = q.options.map((o) => {
      const l = label(o as never);
      const code = String((o as { code?: unknown }).code ?? "");
      const ok = !qualifying || qualifying.includes(norm(l)) || qualifying.includes(norm(code));
      const seg = input.segments?.[l] ?? input.segments?.[code];
      return { label: l, qualifies: ok, ...(seg ? { segment: seg } : {}) };
    }).filter((o) => o.label);
    return { id, text: String(input.text ?? q.text).replace(/<[^>]+>/g, "").trim().slice(0, 600), kind: q.type === "multi_select" ? "multi" : "single", options, fromQuestionId: q.id };
  }
  return { id, text: input.text!, kind: input.kind ?? "single", options: (input.options ?? []).map((o) => ({ label: o.label, qualifies: o.qualifies !== false, ...(o.segment ? { segment: o.segment } : {}) })), ...(input.min !== undefined ? { min: input.min } : {}), ...(input.max !== undefined ? { max: input.max } : {}) };
}

export interface AiInterviewApplied { description: string; warnings: string[]; touched: string[] }

export function applyAiInterviewAction(def: SurveyDefinition, a: AiInterviewAction): AiInterviewApplied {
  const study = def.qualStudy ?? fail("there is no interview guide yet — create one with create_qual_guide (kind \"interview\"), then configure AI interviews on it");
  if (study.kind !== "interview") fail("AI-moderated interviews are one-to-one: the guide is a focus-group discussion guide. Make it an interview guide (create_qual_guide kind \"interview\", replace: true) to run it with an AI moderator");
  const before = study.aiModeration;
  const cur = AiModerationSchema.parse(before ?? {});
  const changes: string[] = [];
  const next: AiModeration = JSON.parse(JSON.stringify(cur));
  if (a.enabled !== undefined) { next.enabled = a.enabled; changes.push(a.enabled ? "on" : "off"); }
  if (a.modes) { next.modes = a.modes; changes.push(`modes ${a.modes.join(" / ")}`); }
  if (a.targetMinutes === null) { delete next.targetMinutes; changes.push("time: the guide's duration"); } else if (a.targetMinutes !== undefined) { next.targetMinutes = a.targetMinutes; changes.push(`${a.targetMinutes} minutes`); }
  if (a.maxTurns !== undefined) { next.maxTurns = a.maxTurns; changes.push(`at most ${a.maxTurns} turns`); }
  if (a.defaultProbing) { next.defaultProbing = a.defaultProbing; changes.push(`${a.defaultProbing} probing`); }
  if (a.resetProbing && next.probing.length) { next.probing = []; changes.push("per-question probing reset"); }
  for (const r of a.probing ?? []) {
    const qid = guideQuestion(study, r.question);
    next.probing = next.probing.filter((x) => x.questionId !== qid);
    next.probing.push({ questionId: qid, depth: r.depth, ...(r.maxFollowUps !== undefined ? { maxFollowUps: r.maxFollowUps } : {}) });
    changes.push(`${qid}: ${r.depth} probing`);
  }
  if (a.objectives) { next.objectives = a.objectives; changes.push(`${a.objectives.length} objectives to cover`); }
  for (const o of a.addObjectives ?? []) if (!next.objectives.some((x) => norm(x) === norm(o))) { if (!next.objectives.length) next.objectives = [...study.objectives]; next.objectives.push(o); changes.push(`+objective “${o.slice(0, 40)}”`); }
  if (a.languages) { next.languages = a.languages; changes.push(`languages ${a.languages.join(", ")}`); }
  for (const l of a.addLanguages ?? []) if (!next.languages.includes(l)) { next.languages.push(l); changes.push(`+language ${l}`); }
  const nextId = () => { let i = 1; while (next.screener.some((q) => q.id === `scr${i}`)) i++; return `scr${i}`; };
  if (a.screener) { next.screener = []; for (const s of a.screener) next.screener.push(screenerQuestion(def, s, nextId())); changes.push(`screener: ${a.screener.length} question${a.screener.length === 1 ? "" : "s"}`); }
  for (const s of a.addScreener ?? []) { next.screener.push(screenerQuestion(def, s, nextId())); changes.push("+screener question"); }
  if (a.quotas) { next.quotas = a.quotas; changes.push(`quotas ${a.quotas.map((q) => `${q.segment} ${q.target}`).join(", ")}`); }
  if (a.targetCompletes === null) { delete next.targetCompletes; changes.push("no completes target"); } else if (a.targetCompletes !== undefined) { next.targetCompletes = a.targetCompletes; changes.push(`${a.targetCompletes} interviews`); }
  if (a.recordingConsent) { next.recordingConsent = a.recordingConsent; changes.push(`recording consent ${a.recordingConsent}`); }
  for (const k of ["incentive", "thankYouMessage", "redirectUrl"] as const) { const v = a[k]; if (v === null) { delete next[k]; changes.push(`${k} cleared`); } else if (v !== undefined) { next[k] = v; changes.push(k === "redirectUrl" ? "redirect URL" : k === "incentive" ? "incentive" : "thank-you message"); } }
  if (a.persona) { const { style, ...rest } = a.persona; next.persona = { ...next.persona, ...rest }; if (style === null) delete next.persona.style; else if (style) next.persona.style = style; changes.push(`persona ${next.persona.name} (${next.persona.tone})`); }
  if (a.stimuli) { next.stimuli = a.stimuli; changes.push(`${a.stimuli.length} stimuli`); }
  for (const s of a.addStimuli ?? []) { next.stimuli = next.stimuli.filter((x) => norm(x.name) !== norm(s.name)); next.stimuli.push(s); changes.push(`stimulus “${s.name}”`); }
  if (a.costCapUsd !== undefined) { next.costCapUsd = a.costCapUsd; changes.push(`AI cap $${a.costCapUsd} per interview`); }
  if (a.studyBudgetUsd === null) { delete next.studyBudgetUsd; changes.push("no study budget"); } else if (a.studyBudgetUsd !== undefined) { next.studyBudgetUsd = a.studyBudgetUsd; changes.push(`study budget $${a.studyBudgetUsd}`); }
  if (a.silenceSeconds !== undefined) { next.silenceSeconds = a.silenceSeconds; changes.push(`nudge after ${a.silenceSeconds}s`); }
  const parsed = AiModerationSchema.safeParse(next);
  if (!parsed.success) fail(`the AI interview settings are not valid: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message ?? ""}`);
  def.qualStudy = { ...study, aiModeration: parsed.data! };
  const check = launchProblems(def.qualStudy);
  const plan = buildModeratorPlan(def.qualStudy);
  const warnings = [
    ...check.blocking.filter((b) => !/not configured/.test(b)).map((b) => `Before launch: ${b}`),
    ...check.warnings,
  ];
  const description = `${before ? "Update" : "Set up"} AI-moderated interviews: ${changes.join("; ") || "no change"} (≈ $${estimateInterviewCostUsd(plan).toFixed(2)} AI per interview; launched from Research Tools → Qualitative → AI interviews)`;
  return { description, warnings, touched: [] };
}

export function describeAiInterviewAction(a: AiInterviewAction): string {
  return `Configure AI-moderated interviews (${Object.keys(a).filter((k) => k !== "op").join(", ")})`;
}

/** the AI-interview settings in words — the proposal's review line */
export function aiModerationWords(m: AiModeration | undefined): string {
  if (!m) return "";
  const c = AiModerationSchema.parse(m);
  return [
    c.enabled ? "" : "off",
    c.modes.join(" / "),
    c.targetMinutes ? `${c.targetMinutes} min` : "",
    `${c.defaultProbing} probing${c.probing.length ? ` (+${c.probing.length} per question)` : ""}`,
    c.languages.length ? c.languages.join(", ") : "any language",
    c.targetCompletes ? `${c.targetCompletes} interviews` : "",
    c.screener.length ? `screener ${c.screener.length}` : "",
    c.quotas.length ? `quotas ${c.quotas.map((q) => `${q.segment} ${q.target}`).join(", ")}` : "",
    c.stimuli.length ? `${c.stimuli.length} stimuli` : "",
    `cap $${c.costCapUsd}`,
  ].filter(Boolean).join(" · ");
}
