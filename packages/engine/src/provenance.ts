import type { SurveyDefinition } from "@rescript/schema";
import type { SurveyAction } from "./surveyActions.js";
import { getQuestionByCodeOrVar } from "./state.js";

/**
 * THE PROVENANCE GATE FOR HIGH-RISK ACTIONS (prompt-injection audit, 2026-10-18).
 *
 * A copilot turn that carried untrusted content (an uploaded document's
 * passages, a flagged brief or survey text) may have been steered by it. The
 * model's actions are still validated by the engine — but some changes are
 * dangerous even when valid: a bulk delete, an external URL that carries piped
 * respondent data, a script, a terminate rule on an existing question, a
 * quota's redirect. Such an action is kept only when the RESEARCHER'S OWN
 * MESSAGE asks for that kind of change — a deterministic reading of the
 * researcher's words, never of the document. Otherwise it is left out of the
 * proposal with a reason that says so.
 *
 *   highRiskActions   which actions are high-risk, and why (a `strict` set
 *                     when the scanner flagged the content)
 *   researcherAsked   does the researcher's text ask for that kind of change
 *                     (English, Hindi, Hinglish)
 *   provenanceGate    the actions kept and the ones excluded, with reasons
 *
 * Runs after the reply is read and normalised, before the engine applies
 * anything — so the browser never receives an excluded action to replay.
 */

export type HighRiskKind = "delete" | "research_design" | "external_url" | "piped_url" | "script" | "terminate_logic" | "quota" | "access";
export interface HighRiskFinding { index: number; op: string; kind: HighRiskKind; why: string }
export interface ProvenanceExclusion extends HighRiskFinding { reason: string }

export const PROVENANCE_REASON = "Not requested by you; came from document content — ask explicitly if you want it.";

const URL_RE = /\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*|\bwww\.[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi;
const PIPE_RE = /\{\{[^}]{1,80}\}\}|\$\{[^}]{1,80}\}|\[\[[^\]]{1,80}\]\]|%7B%7B/i;
const SCRIPT_DANGER = /\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|eval|Function|postMessage|import)\s*\(|\bnew\s+(?:Image|WebSocket|XMLHttpRequest|Worker)\b|document\s*\.\s*(?:cookie|domain|location|write)|document\s*\[|\b(?:local|session)Storage\b|\bindexedDB\b|\bnavigator\s*\.|\bwindow\s*\.\s*(?:open|location|parent|top)|\.src\s*=|srcdoc|\blocation\s*(?:\.|=)/;

/** every string inside an action, with the key it sits under */
function strings(v: unknown, key = "", out: { key: string; value: string }[] = [], depth = 0): { key: string; value: string }[] {
  if (depth > 8 || out.length > 400) return out;
  if (typeof v === "string") out.push({ key, value: v });
  else if (Array.isArray(v)) for (const x of v) strings(x, key, out, depth + 1);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) strings(x, k, out, depth + 1);
  return out;
}

/** the external addresses in an action (relative paths, data: images and the allowed ones excepted) */
export function externalUrlsIn(action: unknown, allow: readonly string[] = []): string[] {
  const urls: string[] = [];
  for (const { value } of strings(action)) for (const m of value.matchAll(URL_RE)) if (!allow.some((a) => a && (m[0] === a || a.startsWith(m[0]) || m[0].startsWith(a)))) urls.push(m[0]);
  return [...new Set(urls)];
}

const SCRIPT_KEYS = new Set(["script", "js", "javascript", "code"]);
const DELETE_OPS = new Set(["delete_question", "delete_block", "delete_quota", "remove_language", "remove_embedded", "remove_list_fill", "remove_punches"]);
const TERMINAL = /^(?:terminate|screen_?out|screenout|end|disqualify|reject)$/i;

/**
 * The high-risk actions of a batch. `strict` (the content was flagged as
 * instruction-like): every delete, every script, every skip to the end — not
 * only bulk deletes and dangerous scripts.
 */
export function highRiskActions(def: SurveyDefinition, actions: readonly SurveyAction[], opts: { strict?: boolean; allowUrls?: readonly string[] } = {}): HighRiskFinding[] {
  const out: HighRiskFinding[] = [];
  const strict = !!opts.strict;
  const deletes = actions.filter((a) => a.op === "delete_question" || a.op === "delete_block").length;
  const existing = (ref: unknown) => typeof ref === "string" && !!getQuestionByCodeOrVar(def, ref);
  actions.forEach((a, index) => {
    const op = String(a.op);
    const o = a as unknown as Record<string, unknown>;
    const add = (kind: HighRiskKind, why: string) => out.push({ index, op, kind, why });
    if (/collaborat|access|permission|publish|deploy|invite|share|owner/i.test(op)) { add("access", "changes access or publishes"); return; }
    if (DELETE_OPS.has(op)) {
      const bulk = deletes >= 2;
      const always = op === "delete_block" || op === "remove_language" || (op === "delete_question" && bulk);
      if (op !== "delete_quota" && (always || strict)) add("delete", op === "delete_question" ? (bulk ? `deletes ${deletes} questions/blocks in one batch` : "deletes a question") : op.replace(/_/g, " "));
    }
    if (op === "remove_hypothesis") add("research_design", "removes a hypothesis from the research design");
    if (op === "set_research") {
      const had = def.research?.hypotheses?.length ?? 0;
      const now = Array.isArray(o.hypotheses) ? o.hypotheses.length : had;
      if (had && now < had) add("research_design", `replaces the research design with fewer hypotheses (${had} → ${now})`);
      else if (def.research?.objective && typeof o.objective === "string" && !o.objective.trim()) add("research_design", "clears the research objective");
    }
    if (op === "clear_skips") add("terminate_logic", "removes skip logic");
    if (op === "add_skip" && TERMINAL.test(String(o.to ?? "")) && (strict || existing(o.from))) add("terminate_logic", `ends the survey for respondents at ${String(o.from)}`);
    if (op === "delete_quota" || ((op === "update_quota" || op === "set_quota_check") && o.onFull && typeof o.onFull === "object")) add("quota", "changes what happens when a quota is full");
    const urls = externalUrlsIn(a, opts.allowUrls);
    if (urls.length) {
      const piped = strings(a).some(({ value }) => [...value.matchAll(URL_RE)].some((m) => PIPE_RE.test(m[0])));
      add(piped ? "piped_url" : "external_url", piped ? `sends piped respondent data to ${hostOf(urls[0])}` : `points to an external address (${hostOf(urls[0])})`);
    }
    const scripts = strings(a).filter(({ key }) => SCRIPT_KEYS.has(key)).map((s) => s.value).filter((s) => s.trim());
    const html = strings(a).filter(({ key }) => key === "html").map((s) => s.value);
    const dangerous = scripts.some((s) => SCRIPT_DANGER.test(s));
    if (scripts.length && (strict || dangerous)) add("script", dangerous ? "a script that reaches the network, storage or the page" : "adds or changes a script");
    else if (html.some((h) => /<script|\bon[a-z]+\s*=|javascript:/i.test(h))) add("script", "custom HTML with script");
  });
  return out;
}

const hostOf = (u: string) => { const m = /^(?:https?:)?\/\/([^/?#]+)|^www\.([^/?#]+)/i.exec(u); return (m?.[1] ?? (m?.[2] ? `www.${m[2]}` : u)).slice(0, 60); };

/* what the researcher's own words must say, per kind — English, Hindi (Devanagari) and Hinglish */
const ASKED: Record<HighRiskKind, RegExp> = {
  delete: /\b(?:delete|deleting|remove|removing|drop|erase|get rid of|take out|clear|cut|shorten|shorter|trim|reduce|fewer|merge|consolidate|replace|rebuild|start over|from scratch|restructure|hata(?:o|do|na|ye|en)?|nikaa?l(?:o|do)?|mita(?:o|do)?|kam kar(?:o|do)?|chhota)\b|हटा|मिटा|निकाल|छोटा|कम कर|डिलीट/i,
  research_design: /\b(?:hypothes[ie]s|research design|objective|research questions?|replace (?:the )?(?:research|design)|remove h\d|delete h\d|h\d)\b|परिकल्पना|उद्देश्य/i,
  external_url: /\b(?:url|urls|link|links|redirect|https?|www|website|web ?site|domain|web ?page|panel|image|images|logo|video|embed|address)\b|लिंक|यूआरएल|वेबसाइट|रीडायरेक्ट/i,
  piped_url: /\b(?:url|link|redirect|https?|panel|website)\b|लिंक|यूआरएल|रीडायरेक्ट/i,
  script: /\b(?:script|scripts|javascript|js|code|custom code|behaviou?rs?|interactions?|interactive|animat\w*|popups?|pop-ups?|tooltips?|on click|when (?:they|the respondent|someone) (?:click|select|hover|choose)\w*|hover|highlight|show and hide|effects?)\b|स्क्रिप्ट|कोड|जावास्क्रिप्ट/i,
  terminate_logic: /\b(?:terminat\w*|screen ?out|screen(?:er|ing)?|disqualif\w*|skip\w*|logic|rout(?:e|ing)|branch\w*|end the survey|end survey|kick out|exclude|qualif\w*|eligib\w*|close the survey for)\b|बाहर|स्क्रीन|टर्मिनेट|अयोग्य/i,
  quota: /\bquotas?\b|कोटा/i,
  access: /(?!)/, // never from the copilot
};

/** Does the researcher's text ask for this kind of change? (`piped_url` also needs the piping named) */
export function researcherAsked(kind: HighRiskKind, researcherText: string): boolean {
  const t = String(researcherText ?? "");
  if (!ASKED[kind].test(t)) return false;
  if (kind === "piped_url") return /\b(?:pipe|piped|piping|pass|passing|append|parameter|param|query|id|rid|pid|uid)\b|\{\{|पाइप/i.test(t);
  if (kind === "research_design") return ASKED.delete.test(t) || /\breplace|rewrite|new research design|start over\b/i.test(t);
  return true;
}

/**
 * The gate. With no untrusted content in the turn every action passes. With
 * it, each high-risk action stays only if the researcher's own text asks for
 * that kind of change; the rest are excluded with `PROVENANCE_REASON`.
 */
export function provenanceGate<A extends SurveyAction>(def: SurveyDefinition, actions: readonly A[], opts: { untrusted: boolean; strict?: boolean; researcherText: string; allowUrls?: readonly string[] }): { kept: A[]; excluded: ProvenanceExclusion[] } {
  if (!opts.untrusted || !actions.length) return { kept: [...actions], excluded: [] };
  const risky = highRiskActions(def, actions, { strict: opts.strict, allowUrls: opts.allowUrls });
  const drop = new Map<number, ProvenanceExclusion>();
  for (const f of risky) {
    if (drop.has(f.index)) continue;
    if (f.kind !== "access" && researcherAsked(f.kind, opts.researcherText)) continue;
    drop.set(f.index, { ...f, reason: `${f.why}: ${PROVENANCE_REASON}` });
  }
  return { kept: actions.filter((_a, i) => !drop.has(i)), excluded: [...drop.values()].sort((a, b) => a.index - b.index) };
}
