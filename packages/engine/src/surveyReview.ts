import type { Question, SurveyDefinition } from "@rescript/schema";
import { runQualityCheck } from "./qualityCheck.js";
import { diagnoseQuestion } from "./diagnose.js";
import { buildLogicFlow, unreachableLogicNodes } from "./logicGraph.js";
import { listBlocks } from "./blocks.js";
import { questionOrder } from "./dependencies.js";
import type { SurveyAction } from "./surveyActions.js";
import { reviewUx } from "./ux.js";
import { reviewAnalysisPlan } from "./analysisFramework.js";
import { lintLocalization } from "./localization.js";
import { reviewQuotas } from "./quotaActions.js";

/**
 * "REVIEW MY SURVEY" — the part of a survey review that is a matter of fact.
 *
 * The copilot's review has two halves. The model reads for meaning —
 * research alignment, wording nuance, sequencing, analysis limits. THIS is
 * the other half, and it runs first and for free: every check that can be
 * decided from the definition alone, so the model is never asked what the
 * engine already knows, and so a review works with no model configured.
 *
 *   critical     the survey is broken or cannot answer its question:
 *                logic errors, questions no one can reach, conditions that
 *                can never be true, choice questions with no options, a
 *                hypothesis construct no question measures
 *   warning      it works but the data will be worse: leading wording,
 *                overlapping or gapped ranges, inconsistent scales in one
 *                block, near-duplicate questions, excessive length
 *   suggestion   worth a look: possibly double-barreled, no "None"/"Other"
 *                on a long multi-select, no screening, demographics first,
 *                a dependent variable measured by a single item
 *
 * Findings name their questions (ids, for the Studio to link) and, where the
 * fix is mechanical, carry the actions that would make it — offered, never
 * applied by the review.
 */

export type ReviewSeverity = "critical" | "warning" | "suggestion";
export interface ReviewFinding {
  severity: ReviewSeverity;
  category: "logic" | "reachability" | "structure" | "wording" | "options" | "scales" | "duplicates" | "length" | "screening" | "sequencing" | "hypothesis" | "analysis" | "ux" | "localization" | "quota";
  message: string;
  questionIds: string[];
  suggestion?: string;
  /** a mechanical fix, as copilot actions — shown for approval, never applied here */
  fix?: SurveyAction[];
  source: "rules";
}
export interface SurveyReview {
  findings: ReviewFinding[];
  counts: Record<ReviewSeverity, number>;
  /** estimated median completion time, minutes */
  minutes: number;
  questions: number;
}

const plain = (s: string | undefined) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const ASKED = (q: Question) => !["hidden", "calculated", "embedded_data", "html"].includes(q.type);

const LEADING = [
  /\b(?:don['’]?t|wouldn['’]?t|isn['’]?t|aren['’]?t|won['’]?t|shouldn['’]?t) you (?:agree|think|feel|say)\b/i,
  /\bhow (?:much|great|amazing|wonderful|excellent|good) (?:do you (?:love|enjoy|like)|is|was|were)\b/i,
  /\bhow much do you (?:love|enjoy|adore)\b/i,
  /\b(?:our|the) (?:excellent|amazing|award[- ]winning|wonderful|outstanding|great|innovative) (?:product|service|team|brand|experience)/i,
  /\bmost people (?:agree|think|prefer|believe)\b/i,
  /\bdo you agree that .+ (?:is|are) (?:good|great|important|better|beneficial|harmful|bad)\b/i,
  /\bhow (?:has|did|does|much has) .{0,40}(?:influenced|improved|helped|increased|changed) (?:your|you)\b/i,
];
const DOUBLE = /\b(?:satisfied|agree|rate|likely|important|happy|easy|useful|value)\b.{0,60}?\b([a-z]{3,}) (?:and|&) ([a-z]{3,})\b/i;
const NONE_OR_OTHER = /^(?:none|none of (?:the above|these)|other|don['’]?t know|not applicable|n\/a|prefer not)/i;

export function reviewSurvey(def: SurveyDefinition): SurveyReview {
  const findings: ReviewFinding[] = [];
  const add = (f: Omit<ReviewFinding, "source">) => findings.push({ ...f, source: "rules" });
  const qs = [...new Set(questionOrder(def))].map((id) => def.questions.find((q) => q.id === id)!).filter(Boolean);
  const asked = qs.filter(ASKED);
  const quality = runQualityCheck(def);
  const dead = unreachableLogicNodes(buildLogicFlow(def));

  /* ---------------------------------------------------------- critical */
  for (const area of quality.areas) for (const i of area.issues) {
    if (i.level !== "error") continue;
    add({ severity: "critical", category: "logic", message: `${i.questionCode ? `${i.questionCode}: ` : ""}${i.message}`, questionIds: i.questionId ? [i.questionId] : [] });
  }
  for (const q of asked) {
    const d = diagnoseQuestion(def, q.id, { quality, dead });
    if (d?.verdict !== "never") continue;
    add({ severity: "critical", category: "reachability", message: d.summary, questionIds: [q.id], suggestion: "Ask “why is " + q.code + " not showing?” for every reason, or fix the condition that blocks it." });
  }
  // (an empty option list is the quality check's to report: it knows which lists are built at runtime)
  for (const q of asked) {
    if (!plain(q.text)) add({ severity: "critical", category: "wording", message: `${q.code} has no question text.`, questionIds: [q.id] });
  }
  const r = def.research;
  if (r) {
    for (const c of r.constructs ?? []) {
      const live = c.questionIds.filter((id) => def.questions.some((q) => q.id === id));
      if ((c.role === "independent" || c.role === "dependent") && !live.length) {
        add({ severity: "critical", category: "hypothesis", message: `The ${c.role} variable “${c.name}” is not measured by any question, so ${r.hypotheses.length ? "the hypothesis" : "the design"} cannot be tested.`, questionIds: [], suggestion: `Add a question that measures ${c.name}${c.definition ? ` (${c.definition})` : ""}.` });
      } else if (c.role === "dependent" && live.length === 1) {
        add({ severity: "suggestion", category: "analysis", message: `“${c.name}” (the dependent variable) is measured by a single item.`, questionIds: live, suggestion: "A short multi-item scale makes the measure more reliable and lets you check it (Cronbach's α)." });
      }
    }
  }

  /* the analysis framework against the survey: dead references, tests on the wrong level, untested hypotheses */
  for (const i of reviewAnalysisPlan(def)) add({ severity: i.level, category: /hypothes/i.test(i.message) ? "hypothesis" : "analysis", message: i.message, questionIds: i.questionIds, ...(i.suggestion ? { suggestion: i.suggestion } : {}) });

  /* the languages: a version respondents can be routed to must be complete and intact */
  /* ------------------------------------------------------------ quotas: can they fill, and do they stop anyone */
  for (const f of reviewQuotas(def)) add({ severity: f.severity, category: "quota", message: f.message, questionIds: f.questionIds ?? [], ...(f.suggestion ? { suggestion: f.suggestion } : {}), ...(f.action ? { fix: [f.action as SurveyAction] } : {}) });

  for (const rep of lintLocalization(def)) {
    if (rep.language === (def.localization?.sourceLanguage ?? "en")) continue;
    const by = (kind: string) => rep.issues.filter((i) => i.kind === kind);
    const ids = (xs: { questionId?: string }[]) => [...new Set(xs.map((x) => x.questionId).filter((x): x is string => !!x))];
    const missing = by("missing"), stale = by("stale_source"), pipes = by("placeholder_mismatch"), dup = by("duplicate"), same = by("untranslated"), incons = by("inconsistent"), html = by("html_mismatch");
    const live = (def.localization?.languages ?? []).find((l) => l.code === rep.language)?.status === "live";
    if (missing.length) add({ severity: live ? "critical" : "warning", category: "localization", message: `${rep.name}: ${missing.length} element${missing.length === 1 ? " has" : "s have"} no translation (${rep.completion}% complete)${live ? " — and the language is live" : ""}.`, questionIds: ids(missing), suggestion: `Ask “translate the missing ${rep.name} text”, or translate in Localization.` });
    if (stale.length) add({ severity: "warning", category: "localization", message: `${rep.name}: ${stale.length} translation${stale.length === 1 ? " is" : "s are"} outdated — the source text changed after they were made.`, questionIds: ids(stale), suggestion: `Ask “re-translate the outdated ${rep.name} text”, or confirm them in Localization.` });
    if (pipes.length) add({ severity: "critical", category: "localization", message: `${rep.name}: ${pipes.length} translation${pipes.length === 1 ? "" : "s"} lost or changed a piping token — respondents would see a gap or a wrong value.`, questionIds: ids(pipes) });
    if (dup.length) add({ severity: "critical", category: "localization", message: `${rep.name}: ${dup.map((d) => d.message).join(" ")}`, questionIds: ids(dup) });
    if (html.filter((i) => i.blocking).length) add({ severity: "critical", category: "localization", message: `${rep.name}: ${html.filter((i) => i.blocking).length} translation${html.filter((i) => i.blocking).length === 1 ? " has" : "s have"} unbalanced HTML.`, questionIds: ids(html) });
    if (same.length) add({ severity: "suggestion", category: "localization", message: `${rep.name}: ${same.length} translation${same.length === 1 ? " is" : "s are"} identical to the source — still in the original language?`, questionIds: ids(same) });
    if (incons.length) add({ severity: "suggestion", category: "localization", message: `${rep.name}: ${incons.map((i) => i.message).slice(0, 3).join(" ")}${incons.length > 3 ? ` (+${incons.length - 3} more)` : ""}`, questionIds: ids(incons), suggestion: "Add the term to the glossary so every occurrence uses one wording." });
  }

  /* ---------------------------------------------------------- warnings */
  for (const q of asked) {
    const t = plain(q.text);
    const lead = LEADING.find((re) => re.test(t));
    if (lead) add({ severity: "warning", category: "wording", message: `${q.code} may be leading: “${t.length > 90 ? `${t.slice(0, 89)}…` : t}”.`, questionIds: [q.id], suggestion: "Ask neutrally — let the respondent supply the judgement." });
  }
  for (const q of asked) {
    const ranges = (q.options ?? []).map((o) => ({ o, r: rangeOf(o.label) })).filter((x) => x.r);
    if (ranges.length < 2 || ranges.length < (q.options?.length ?? 0) * 0.6) continue;
    const sorted = [...ranges].sort((a, b) => a.r!.lo - b.r!.lo);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i];
      if (b.r!.lo <= a.r!.hi && a.r!.hi !== Infinity) add({ severity: "warning", category: "options", message: `${q.code}: options “${a.o.label}” and “${b.o.label}” overlap — a respondent at ${b.r!.lo} fits both.`, questionIds: [q.id], suggestion: "Make the ranges mutually exclusive." });
      else if (a.r!.int && b.r!.int && b.r!.lo > a.r!.hi + 1) add({ severity: "warning", category: "options", message: `${q.code}: nothing between “${a.o.label}” and “${b.o.label}” — ${a.r!.hi + 1}${b.r!.lo - 1 > a.r!.hi + 1 ? `–${b.r!.lo - 1}` : ""} has no answer.`, questionIds: [q.id], suggestion: "Close the gap so every value has exactly one option." });
    }
  }
  for (const b of listBlocks(def.flow as unknown[])) {
    const scales = b.pages.flatMap((p) => p.node.questionIds).map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q && isScale(q));
    const points = new Set(scales.map((q) => q.options.length));
    if (scales.length >= 2 && points.size > 1) add({ severity: "warning", category: "scales", message: `Block “${b.title ?? b.id}” mixes ${[...points].sort().map((p) => `${p}-point`).join(" and ")} scales (${scales.map((q) => q.code).join(", ")}).`, questionIds: scales.map((q) => q.id), suggestion: "Use one scale length within a block so answers are comparable." });
  }
  const seen: { q: Question; words: Set<string> }[] = [];
  for (const q of asked) {
    // a piped token is part of what the question is about: "{{BRAND_1}}" and "{{BRAND_2}}" are different questions
    const text = plain(q.text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, t: string) => ` pipe:${t.toLowerCase()} `);
    const words = new Set(text.toLowerCase().split(/\s+/).map((w) => (w.startsWith("pipe:") ? w : w.replace(/[^\p{L}\p{N}]/gu, ""))).filter((w) => (w.length > 2 && !STOP.has(w))));
    if (words.size < 2) continue;
    for (const p of seen) {
      const inter = [...words].filter((w) => p.words.has(w)).length;
      const jac = inter / (words.size + p.words.size - inter);
      // near-identical wording, or one question's words wholly inside the other's
      const contained = inter === Math.min(words.size, p.words.size);
      if (jac >= 0.75 || (contained && jac >= 0.6)) { add({ severity: "warning", category: "duplicates", message: `${p.q.code} and ${q.code} look like the same question.`, questionIds: [p.q.id, q.id], suggestion: "If they measure the same thing, keep one.", fix: [{ op: "delete_question", target: q.code }] }); break; }
    }
    seen.push({ q, words });
  }
  const minutes = Math.round(asked.reduce((s, q) => s + secondsFor(q), 0) / 6) / 10;
  if (minutes > 20) add({ severity: "warning", category: "length", message: `The survey takes about ${minutes} minutes — long enough that completion and data quality fall off.`, questionIds: [], suggestion: "Aim for 15 minutes or less: cut questions that do not serve the objective." });
  else if (minutes > 15) add({ severity: "suggestion", category: "length", message: `The survey takes about ${minutes} minutes.`, questionIds: [], suggestion: "Consider trimming to 15 minutes or less." });

  /* ---------------------------------------------------------- suggestions */
  for (const q of asked) {
    if (/matrix/.test(q.type)) continue;
    const m = DOUBLE.exec(plain(q.text));
    if (m && !/\b(?:between|both)\b/i.test(q.text)) add({ severity: "suggestion", category: "wording", message: `${q.code} may be double-barreled: it asks about “${m[1]}” and “${m[2]}” in one answer.`, questionIds: [q.id], suggestion: `Split it, or make it a grid with ${m[1]} and ${m[2]} as rows.` });
    if (q.type === "multi_select" && (q.options?.length ?? 0) >= 4 && !q.options.some((o) => NONE_OR_OTHER.test(o.label) || o.flags?.includes("exclusive") || o.flags?.includes("other_specify"))) {
      add({ severity: "suggestion", category: "options", message: `${q.code} has no “None of these” or “Other” — a respondent whose answer is not listed must pick something untrue.`, questionIds: [q.id], fix: [{ op: "update_question", target: q.code, addOptions: [{ label: "Other (please specify)", other: true }, { label: "None of these", exclusive: true }] }] });
    }
    if ((q.type === "long_text" || q.variant === "text.multi_line") && q.required) add({ severity: "suggestion", category: "wording", message: `${q.code} is a required open end — required open ends invite junk answers.`, questionIds: [q.id], fix: [{ op: "update_question", target: q.code, required: false }] });
  }
  const screens = def.questions.some((q) => (q.skipLogic ?? []).some((s) => s.target.kind === "terminate" || (s.target.kind === "end" && s.target.status && s.target.status !== "complete"))) || JSON.stringify(def.flow).includes('"status":"screened"');
  if (!screens && (asked.length >= 8 || def.research?.population)) add({ severity: "suggestion", category: "screening", message: `Nothing screens respondents out${def.research?.population ? `, but the target population is “${def.research.population}”` : ""}.`, questionIds: [], suggestion: "Add screening questions that end the survey for people outside the population." });
  const blocks = listBlocks(def.flow as unknown[]);
  if (blocks.length >= 3 && /demograph|about you|profile/i.test(blocks[0].title ?? "") && !/screen/i.test(blocks[0].title ?? "")) add({ severity: "suggestion", category: "sequencing", message: `Demographics come first (“${blocks[0].title}”).`, questionIds: [], suggestion: "Ask demographics at the end, unless they screen — early personal questions cost completes." });

  /* ---------------------------------------------------------- the look and behaviour */
  for (const f of reviewUx(def)) add({ severity: f.level, category: "ux", message: f.message, questionIds: [], ...(f.fix ? { fix: [f.fix as SurveyAction] } : {}) });

  const order: Record<ReviewSeverity, number> = { critical: 0, warning: 1, suggestion: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = { critical: 0, warning: 0, suggestion: 0 } as Record<ReviewSeverity, number>;
  for (const f of findings) counts[f.severity]++;
  return { findings, counts, minutes, questions: asked.length };
}

const STOP = new Set(["the", "and", "you", "your", "are", "for", "with", "how", "what", "which", "that", "this", "have", "has", "was", "were", "did", "does", "about", "from", "any", "all", "our", "who", "when", "would", "please", "select", "one", "most", "last"]);

const SCALE_WORDS = /\b(?:agree|disagree|satisf|dissatisf|likely|unlikely|important|unimportant|poor|fair|good|excellent|never|rarely|sometimes|often|always|very|extremely|somewhat|not at all|slightly|moderately|completely|neutral|neither)/i;
/** a rating scale: consecutive numeric codes AND labels that read as a scale (numbers, or scale words at both ends) */
function isScale(q: Question): boolean {
  if (!/single_select|matrix/.test(q.type) || !q.options?.length) return false;
  const n = q.options.length;
  if (n < 3 || n > 11) return false;
  const codes = q.options.map((o) => Number(o.code));
  if (!codes.every((c, i) => Number.isFinite(c) && (i === 0 || c === codes[i - 1] + 1))) return false;
  const labels = q.options.map((o) => plain(o.label));
  const numeric = labels.filter((l) => /^\d+$/.test(l)).length;
  return numeric >= n - 2 || (SCALE_WORDS.test(labels[0]) && SCALE_WORDS.test(labels[n - 1]));
}

/** "18-24", "25–34", "35+", "Under 18", "65 or older", "$0–$50,000", "Less than 1 year" → a numeric range */
export function rangeOf(label: string): { lo: number; hi: number; int: boolean } | null {
  const t = label.replace(/[,$€£₹]/g, "").replace(/\s+/g, " ").trim();
  const num = (s: string) => { const m = /^(\d+(?:\.\d+)?)\s*(k|m)?$/i.exec(s.trim()); if (!m) return NaN; return Number(m[1]) * (m[2]?.toLowerCase() === "k" ? 1000 : m[2]?.toLowerCase() === "m" ? 1e6 : 1); };
  let m: RegExpExecArray | null;
  if ((m = /^(\d+(?:\.\d+)?\s*[km]?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?\s*[km]?)(?:\s+[a-z]+)*$/i.exec(t))) { const lo = num(m[1]), hi = num(m[2]); if (Number.isFinite(lo) && Number.isFinite(hi)) return { lo, hi, int: Number.isInteger(lo) && Number.isInteger(hi) }; }
  if ((m = /^(\d+(?:\.\d+)?\s*[km]?)\s*(?:\+|or (?:more|older|over|above)|and (?:over|above|older))(?:\s+[a-z]+)*$/i.exec(t))) { const lo = num(m[1]); if (Number.isFinite(lo)) return { lo, hi: Infinity, int: Number.isInteger(lo) }; }
  if ((m = /^(?:under|less than|below|younger than)\s+(\d+(?:\.\d+)?\s*[km]?)(?:\s+[a-z]+)*$/i.exec(t))) { const hi = num(m[1]); if (Number.isFinite(hi)) return { lo: -Infinity, hi: Number.isInteger(hi) ? hi - 1 : hi, int: Number.isInteger(hi) }; }
  return null;
}

function secondsFor(q: Question): number {
  if (/matrix/.test(q.type)) return 6 + 5 * Math.max(1, q.rows?.length ?? 1);
  if (q.type === "long_text") return 40;
  if (q.type === "open_text") return 15;
  if (q.type === "multi_select") return 8 + 1.5 * (q.options?.length ?? 0);
  if (q.type === "ranking") return 10 + 3 * (q.options?.length ?? 0);
  return 8;
}
