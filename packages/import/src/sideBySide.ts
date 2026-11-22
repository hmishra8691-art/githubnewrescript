import type { SurveyDefinition, Question } from "@rescript/schema";
import type { CanonicalSurvey, CanonicalQuestion } from "./canonical.js";
import { plainText } from "./canonical.js";
import type { MapResult } from "./map.js";
import type { MappingDecision } from "./mappingDecision.js";
import { exprText } from "./review.js";

/**
 * SIDE-BY-SIDE REVIEW (Level 5 roadmap I6 — 2026-11-29).
 *
 * The review screen already lists every element by compatibility category and opens one at a time in the inspector.
 * This is the comparison a reviewer works down: each source question beside the Rescript question it became, with
 * a confidence for EACH part — the type, the wording, the options, the rows, the logic — and the overall level the
 * weakest part allows. `bulkAccept` picks what can be accepted in one action (every element at or above a level,
 * or a category of elements), and never accepts an element with an unresolved reference or a part that did not
 * convert.
 */
export type PartLevel = "same" | "converted" | "check" | "lost";
export interface PartCheck { part: "type" | "text" | "options" | "rows" | "logic"; level: PartLevel; detail: string }
export interface SidePair {
  sourceId: string;
  questionId: string | null;
  source: { variable: string; type: string; text: string; options: string[]; rows: string[]; logic: string | null };
  result: { code: string; type: string; text: string; options: string[]; rows: string[]; logic: boolean } | null;
  parts: PartCheck[];
  /** the weakest part */
  level: PartLevel;
  /** a reference this question makes that the import could not satisfy */
  unresolved: string[];
}

const RANK: Record<PartLevel, number> = { same: 3, converted: 2, check: 1, lost: 0 };
const weakest = (ps: PartCheck[]): PartLevel => ps.reduce<PartLevel>((w, p) => (RANK[p.level] < RANK[w] ? p.level : w), "same");
const norm = (s: string) => plainText(s).toLowerCase().replace(/\{\{[^}]*\}\}/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function words(a: string, b: string): number {
  const A = new Set(norm(a).split(" ").filter(Boolean)), B = new Set(norm(b).split(" ").filter(Boolean));
  if (!A.size && !B.size) return 1;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / Math.max(A.size, B.size);
}
function listCheck(part: "options" | "rows", src: string[], res: string[]): PartCheck {
  if (!src.length && !res.length) return { part, level: "same", detail: `no ${part}` };
  const a = src.map(norm), b = res.map(norm);
  if (a.length === b.length && a.every((x, i) => x === b[i])) return { part, level: "same", detail: `${src.length} ${part}, same wording and order` };
  const sa = [...a].sort().join("\u0000"), sb = [...b].sort().join("\u0000");
  if (sa === sb) return { part, level: "converted", detail: `${src.length} ${part}, same wording, different order` };
  const missing = a.filter((x) => !b.includes(x)).length, extra = b.filter((x) => !a.includes(x)).length;
  if (!res.length && src.length) return { part, level: "lost", detail: `${src.length} ${part} in the source, none in the result` };
  return { part, level: missing > src.length / 2 ? "lost" : "check", detail: `${missing} source ${part} not found as written${extra ? `, ${extra} new` : ""}` };
}

export function sideBySide(c: CanonicalSurvey, m: MapResult, decisions: MappingDecision[] = []): SidePair[] {
  const def = m.def as SurveyDefinition | null;
  const qById = new Map((def?.questions ?? []).map((q) => [q.id, q]));
  const decision = new Map(decisions.map((d) => [d.sourceId, d]));
  const target = new Map(m.mapping.filter((x) => x.kind === "question").map((x) => [x.source, x.rescript]));
  return c.questions.map((cq: CanonicalQuestion) => {
    const qid = target.get(cq.sourceId) ?? null;
    const rq: Question | undefined = qid ? qById.get(qid) : undefined;
    const srcLogic = cq.displayLogic ? exprText(cq.displayLogic, c) : null;
    const source = { variable: cq.variable, type: cq.sourceType || cq.kind, text: plainText(cq.text), options: cq.options.map((o) => plainText(o.label)), rows: cq.rows.map((r) => plainText(r.label)), logic: srcLogic };
    const unresolved = (m.unresolved ?? []).filter((u) => u.location === cq.sourceId || u.location === cq.variable || u.location === rq?.code).map((u) => u.message);
    if (!rq) {
      return { sourceId: cq.sourceId, questionId: null, source, result: null, parts: [{ part: "type", level: "lost", detail: "no question was created for it" }], level: "lost", unresolved };
    }
    const result = { code: rq.code, type: rq.type, text: plainText(rq.text), options: (rq.options ?? []).map((o) => plainText(o.label)), rows: (rq.rows ?? []).map((r) => plainText(r.label)), logic: !!rq.displayLogic };
    const parts: PartCheck[] = [];
    const d = decision.get(cq.sourceId);
    parts.push(!d || d.decision === "exact" ? { part: "type", level: "same", detail: `${source.type} → ${rq.type}` } : d.decision === "components" ? { part: "type", level: "converted", detail: d.note } : d.decision === "unsupported" ? { part: "type", level: "lost", detail: d.note } : { part: "type", level: "check", detail: d.note });
    const sim = words(cq.text, rq.text);
    parts.push(sim === 1 ? { part: "text", level: "same", detail: "same wording" } : sim >= 0.8 ? { part: "text", level: "converted", detail: `wording ${Math.round(sim * 100)}% the same (formatting or piping rewritten)` } : { part: "text", level: "check", detail: `wording only ${Math.round(sim * 100)}% the same` });
    parts.push(listCheck("options", source.options, result.options));
    parts.push(listCheck("rows", source.rows, result.rows));
    if (cq.displayLogic) {
      const raw = cq.displayLogic.t === "raw";
      parts.push(!result.logic ? { part: "logic", level: "lost", detail: `the source shows it when ${srcLogic}; the result has no display logic` } : raw ? { part: "logic", level: "check", detail: `kept from text the reader could not parse: ${srcLogic}` } : { part: "logic", level: "converted", detail: `shown when ${srcLogic}` });
    }
    const level = unresolved.length ? (weakest(parts) === "lost" ? "lost" : "check") : weakest(parts);
    return { sourceId: cq.sourceId, questionId: rq.id, source, result, parts, level, unresolved };
  });
}

export interface BulkRule { atLeast?: PartLevel; sourceIds?: string[] }
/** what one action may accept: never a lost part or an unresolved reference, whatever the rule */
export function bulkAccept(pairs: SidePair[], rule: BulkRule): { accept: string[]; held: { sourceId: string; why: string }[] } {
  const accept: string[] = [], held: { sourceId: string; why: string }[] = [];
  for (const p of pairs) {
    const wanted = rule.sourceIds ? rule.sourceIds.includes(p.sourceId) : rule.atLeast ? RANK[p.level] >= RANK[rule.atLeast] : false;
    if (!wanted) continue;
    if (p.unresolved.length) { held.push({ sourceId: p.sourceId, why: `unresolved: ${p.unresolved[0]}` }); continue; }
    const lost = p.parts.find((x) => x.level === "lost");
    if (lost) { held.push({ sourceId: p.sourceId, why: `${lost.part}: ${lost.detail}` }); continue; }
    accept.push(p.sourceId);
  }
  return { accept, held };
}
