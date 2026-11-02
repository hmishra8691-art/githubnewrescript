import type { CanonicalSurvey, CanonicalQuestion, CExpr, CSkipTarget, PendingInstruction } from "./canonical.js";
import { buildImportGraph } from "./graph.js";

/**
 * THE CLARIFICATION ENGINE (import brief §13, I5).
 *
 * When the source leaves a programming decision open — an "ASK IF" that names no answer, a skip with no
 * destination, a randomization that does not say what stays fixed, a variable whose value comes from nowhere,
 * two instructions that cannot both hold, a reference to a question that is not there — the importer does not
 * guess. It asks ONE specific question per decision, offers a recommended answer and the alternatives, each as
 * a structured DECISION, and applies only the decisions a person accepted. Every decision is checked against
 * the real survey before it is applied (a question or answer that does not exist is refused, never approximated),
 * and the survey is re-analysed after each round.
 *
 * Decisions are plain data, so an import session can remember them (I4) and the same answers re-apply on a
 * re-run.
 */
export type Decision =
  | { id: string; type: "display"; questionId: string; when: CExpr }
  | { id: string; type: "skip"; questionId: string; when: CExpr; to: CSkipTarget }
  | { id: string; type: "randomize"; questionId: string; mode: "all" | "fix_special" | "none"; fixed?: string[] }
  | { id: string; type: "embedded"; name: string; source: "url" | "static" | "question"; value?: string; questionId?: string }
  | { id: string; type: "or_instead_of_and"; questionId: string }
  | { id: string; type: "replace_reference"; questionId: string; from: string; to: string }
  | { id: string; type: "dismiss" };

export interface ClarificationOption { label: string; decision: Decision }
export interface Clarification {
  /** stable across re-runs of the same file: kind + question + instruction words */
  id: string;
  kind: "missing_condition" | "missing_target" | "randomize_scope" | "embedded_source" | "conflict" | "undefined_reference";
  /** the question asked of the person, specific to this survey */
  question: string;
  /** the source's own words */
  evidence: string;
  questionId?: string;
  location: string;
  recommended: ClarificationOption | null;
  /** why the recommended answer is recommended */
  because?: string;
  alternatives: ClarificationOption[];
  /** where the AI's suggestion came from, when it supplied the recommendation (I6) */
  suggestedBy?: "rules" | "ai";
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const sel = (q: CanonicalQuestion, choice: string): CExpr => ({ t: "cmp", ref: { kind: "question", id: q.sourceId, choice }, op: "selected" });
const closed = (q: CanonicalQuestion) => q.options.length > 0 && /^(single|multi|dropdown|nps)$/.test(q.kind);
const label = (q: CanonicalQuestion) => q.code ?? q.variable;
const SPECIAL = /\b(?:other|none|none of (?:the|these)|don'?t know|not sure|prefer not|refused|n\/?a)\b/i;

/** the words of a condition that name an answer: "No" → the option labelled No */
function optionsNamed(text: string, q: CanonicalQuestion) {
  const t = ` ${text.toLowerCase()} `;
  return q.options.filter((o) => o.label.length > 1 && t.includes(` ${o.label.toLowerCase()} `));
}

export function clarifications(c: CanonicalSurvey): Clarification[] {
  const out: Clarification[] = [];
  const qs = c.questions;
  const idx = new Map(qs.map((q, i) => [q.sourceId, i]));
  const byId = new Map(qs.map((q) => [q.sourceId, q]));
  const recentClosed = (qid: string, n: number) => { const r: CanonicalQuestion[] = []; for (let k = (idx.get(qid) ?? 0) - 1; k >= 0 && r.length < n; k--) if (closed(qs[k])) r.push(qs[k]); return r; };
  const previousClosed = (qid: string) => { const i = idx.get(qid) ?? 0; for (let k = i - 1; k >= 0; k--) if (closed(qs[k])) return qs[k]; return null; };
  const seen = new Set<string>();
  const decided = new Set(c.decidedIds ?? []);
  const push = (x: Clarification) => { if (!seen.has(x.id) && !decided.has(x.id)) { seen.add(x.id); out.push(x); } };

  for (const issue of c.issues) {
    const ins: PendingInstruction | undefined = issue.instruction;
    if (issue.type !== "ambiguous" || !ins) continue;
    const q = byId.get(ins.questionId);
    if (!q) continue;
    const id = `${ins.kind}:${q.sourceId}:${slug(ins.text)}`;
    const nextQ = qs[(idx.get(q.sourceId) ?? -1) + 1];
    switch (ins.kind) {
      case "display": case "terminate": case "skip": {
        /* the condition is unknown: offer the answers of the question it most likely reads */
        const self = ins.kind !== "display" && closed(q) ? q : null;
        const src = self ?? previousClosed(q.sourceId);
        const what = ins.kind === "display" ? `whether ${label(q)} is shown` : ins.kind === "terminate" ? `who is screened out at ${label(q)}` : `when respondents skip from ${label(q)}${ins.target ? ` to ${describeTarget(ins.target, byId)}` : ""}`;
        const make = (e: CExpr): Decision => ins.kind === "display" ? { id, type: "display", questionId: q.sourceId, when: e } : { id, type: "skip", questionId: q.sourceId, when: e, to: ins.kind === "terminate" ? { kind: "end", status: "screened" } : ins.target! };
        /* the answers of the question it most likely reads first, then of the two closed questions before that */
        const sources = [...new Set([src, ...recentClosed(q.sourceId, 3)].filter((x): x is CanonicalQuestion => !!x))].slice(0, 3);
        const alternatives: ClarificationOption[] = sources.flatMap((s) => s.options.slice(0, 8).map((o) => ({ label: `${label(s)} = ${o.label}`, decision: make(sel(s, o.sourceId)) })));
        const named = src ? optionsNamed(ins.condition ?? ins.text, src) : [];
        const rec = named.length === 1 ? alternatives.find((a) => a.label === `${label(src!)} = ${named[0].label}`) ?? null : null;
        push({
          id, kind: "missing_condition", location: issue.location, questionId: q.sourceId, evidence: ins.text,
          question: `Which question and which answer decide ${what}? The document says “${ins.text}”.`,
          recommended: rec, ...(rec ? { because: `“${named[0].label}” is an answer of ${label(src!)}, the closest question before it that has answers.`, suggestedBy: "rules" as const } : {}),
          alternatives: [...alternatives.filter((a) => a !== rec), { label: "Leave it — I will add the rule in Studio", decision: { id, type: "dismiss" } }],
        });
        break;
      }
      case "skip_target": {
        const src = previousClosed(q.sourceId);
        const named = src ? optionsNamed(ins.condition ?? "", src) : [];
        const cond: CExpr | null = src && named.length === 1 ? sel(src, named[0].sourceId) : null;
        const alternatives: ClarificationOption[] = [];
        if (cond) {
          alternatives.push({ label: `Do not show ${label(q)} when ${label(src!)} = ${named[0].label}`, decision: { id, type: "display", questionId: q.sourceId, when: { t: "group", op: "not", children: [cond] } } });
          if (nextQ) alternatives.push({ label: `Go to ${label(nextQ)} (the next question) when ${label(src!)} = ${named[0].label}`, decision: { id, type: "skip", questionId: src!.sourceId, when: cond, to: { kind: "question", id: nextQ.sourceId } } });
          alternatives.push({ label: `End the survey (screened out) when ${label(src!)} = ${named[0].label}`, decision: { id, type: "skip", questionId: src!.sourceId, when: cond, to: { kind: "end", status: "screened" } } });
        }
        push({
          id, kind: "missing_target", location: issue.location, questionId: q.sourceId, evidence: ins.text,
          question: `Where should respondents go when “${ins.condition ?? ins.text}”? The document says “${ins.text}” but names no question or section.`,
          recommended: alternatives[0] ?? null, ...(alternatives[0] ? { because: `“Skip this question” most often means: do not ask it.`, suggestedBy: "rules" as const } : {}),
          alternatives: [...alternatives.slice(1), { label: "Leave it — I will add the rule in Studio", decision: { id, type: "dismiss" } }],
        });
        break;
      }
      case "randomize": {
        const special = (ins.options ?? []).filter((o) => q.options.some((x) => x.sourceId === o));
        const names = special.map((o) => `“${q.options.find((x) => x.sourceId === o)!.label}”`).join(", ");
        const fix: ClarificationOption = { label: `Randomize, but keep ${names || "Other / None"} fixed at the end`, decision: { id, type: "randomize", questionId: q.sourceId, mode: "fix_special", fixed: special } };
        push({
          id, kind: "randomize_scope", location: issue.location, questionId: q.sourceId, evidence: ins.text,
          question: `Should all of ${label(q)}'s options be randomized, or should ${names || "options such as Other and None"} stay fixed at the end?`,
          recommended: special.length ? fix : null, because: "Answers like Other, None and Don't know conventionally stay at the end of the list.", suggestedBy: "rules",
          alternatives: [{ label: "Randomize every option", decision: { id, type: "randomize", questionId: q.sourceId, mode: "all" } }, { label: "Do not randomize", decision: { id, type: "randomize", questionId: q.sourceId, mode: "none" } }],
        });
        break;
      }
      case "embedded": {
        const name = ins.name ?? "the field";
        const word = name.toLowerCase();
        const asking = qs.filter((x) => x.sourceId !== q.sourceId && (x.variable.toLowerCase().includes(word) || x.text.toLowerCase().includes(word)) && x.kind !== "hidden").slice(0, 4);
        const fromQ = asking.map((x) => ({ label: `From the answer to ${label(x)} (“${x.text.replace(/<[^>]+>/g, "").slice(0, 60)}”)`, decision: { id, type: "embedded", name, source: "question", questionId: x.sourceId } as Decision }));
        const url: ClarificationOption = { label: `From the survey link (…?${name}=…)`, decision: { id, type: "embedded", name, source: "url" } };
        push({
          id, kind: "embedded_source", location: issue.location, questionId: q.sourceId, evidence: ins.text,
          question: `Where does ${name} come from: a parameter in the survey link, an earlier question, or a fixed value?`,
          recommended: fromQ[0] ?? url, because: fromQ[0] ? `${label(asking[0])} asks about ${word}.` : "Panel and sample variables usually arrive in the link.", suggestedBy: "rules",
          alternatives: [...fromQ.slice(1), ...(fromQ[0] ? [url] : []), { label: "A fixed value (type it in Studio)", decision: { id, type: "embedded", name, source: "static" } }],
        });
        break;
      }
    }
  }

  /* CONFLICTS: one rule that asks for two different answers of the same single-choice question at once */
  for (const q of qs) {
    const e = q.displayLogic;
    if (!e || e.t !== "group" || e.op !== "and") continue;
    const cmps = e.children.filter((x): x is Extract<CExpr, { t: "cmp" }> => x.t === "cmp" && x.op === "selected" && x.ref.kind === "question");
    const bySrc = new Map<string, Set<string>>();
    for (const x of cmps) { const t = byId.get(x.ref.id); if (t && (t.kind === "single" || t.kind === "dropdown") && x.ref.choice) (bySrc.get(t.sourceId) ?? bySrc.set(t.sourceId, new Set()).get(t.sourceId)!).add(x.ref.choice); }
    for (const [src, set] of bySrc) if (set.size > 1) {
      const t = byId.get(src)!;
      const id = `conflict:${q.sourceId}:${src}`;
      const names = [...set].map((ch) => `“${t.options.find((o) => o.sourceId === ch)?.label ?? ch}”`).join(" and ");
      push({
        id, kind: "conflict", location: `${label(q)} · display logic`, questionId: q.sourceId, evidence: names,
        question: `${label(q)} is asked only if ${label(t)} is ${names} at the same time, which no respondent can answer (it is a single choice). Did the document mean either of them?`,
        recommended: { label: `Ask ${label(q)} if ${label(t)} is ${names.replace(" and ", " or ")}`, decision: { id, type: "or_instead_of_and", questionId: q.sourceId } },
        because: "Two instructions for one question are usually alternatives.", suggestedBy: "rules",
        alternatives: [{ label: "Leave it as written (the question will never be shown)", decision: { id, type: "dismiss" } }],
      });
    }
  }

  /* UNDEFINED REFERENCES the dependency graph found: a rule that names a question the source does not have */
  const g = buildImportGraph(c);
  for (const f of g.findings) {
    if (f.kind !== "missing_reference" || !/question/.test(f.message)) continue;
    const missing = f.refs[0];
    const ownerVar = f.location.split(" · ")[0];
    const owner = qs.find((x) => x.variable === ownerVar);
    if (!owner || !missing) continue;
    const near = qs.filter((x) => x.sourceId !== owner.sourceId && similar(missing, x)).slice(0, 4);
    const id = `ref:${owner.sourceId}:${missing}`;
    push({
      id, kind: "undefined_reference", location: f.location, questionId: owner.sourceId, evidence: f.message,
      question: `${f.message} Which question did it mean?`,
      recommended: near.length === 1 ? { label: `${label(near[0])} — “${near[0].text.replace(/<[^>]+>/g, "").slice(0, 60)}”`, decision: { id, type: "replace_reference", questionId: owner.sourceId, from: missing, to: near[0].sourceId } } : null,
      ...(near.length === 1 ? { because: `${label(near[0])} is the only question with a similar code.`, suggestedBy: "rules" as const } : {}),
      alternatives: [...near.slice(near.length === 1 ? 1 : 0).map((x) => ({ label: `${label(x)} — “${x.text.replace(/<[^>]+>/g, "").slice(0, 60)}”`, decision: { id, type: "replace_reference", questionId: owner.sourceId, from: missing, to: x.sourceId } as Decision })), { label: "Leave it — the rule stays out", decision: { id, type: "dismiss" } }],
    });
  }
  return out;
}

const describeTarget = (t: CSkipTarget, byId: Map<string, CanonicalQuestion>) => t.kind === "question" ? (byId.get(t.id) ? label(byId.get(t.id)!) : t.id) : t.kind === "end" ? "the end" : t.kind === "block" ? `section ${t.id}` : t.kind === "url" ? t.url : "the end of the block";
/** "QID42" ~ "QID4" / "Q42"; "Q5a" ~ "Q5" */
function similar(missing: string, q: CanonicalQuestion): boolean {
  const n = missing.replace(/\D+/g, ""), m = (q.code ?? q.variable).replace(/\D+/g, ""), s = q.sourceId.replace(/\D+/g, "");
  if (!n) return false;
  /* the letters before the number must agree when both have them: S11 is near S1, not Q1 (QID counts as Q) */
  const lead = (x: string) => x.replace(/^QID/i, "Q").match(/^[A-Za-z]+/)?.[0]?.toUpperCase() ?? "";
  const lm = lead(missing), lq = lead(q.code ?? q.variable) || lead(q.sourceId);
  if (lm && lq && lm !== lq) return false;
  return [m, s].some((x) => x && (x === n || (n.length > 1 && (x === n.slice(0, -1) || n === x.slice(0, -1)))));
}

export interface ApplyResult { canonical: CanonicalSurvey; applied: string[]; rejected: { id: string; reason: string }[] }

/**
 * Apply the accepted decisions to a COPY of the canonical survey. Each is checked first: the questions and
 * answers it names must exist; a decision that does not fit is rejected with the reason and changes nothing.
 * The ambiguous issue a decision answers is removed (replaced by an "inferred" line saying who decided).
 */
export function applyDecisions(source: CanonicalSurvey, decisions: Decision[]): ApplyResult {
  const c: CanonicalSurvey = JSON.parse(JSON.stringify(source));
  const byId = new Map(c.questions.map((q) => [q.sourceId, q]));
  const applied: string[] = [], rejected: { id: string; reason: string }[] = [];
  const checkExpr = (e: CExpr): string | null => {
    if (e.t === "group") { for (const ch of e.children) { const r = checkExpr(ch); if (r) return r; } return null; }
    if (e.t === "cmp" && e.ref.kind === "question") {
      const q = byId.get(e.ref.id);
      if (!q) return `question ${e.ref.id} is not in the survey`;
      if (e.ref.choice && !q.options.some((o) => o.sourceId === e.ref.choice)) return `${q.variable} has no answer ${e.ref.choice}`;
    }
    if (e.t === "raw") return "an unread condition cannot be a decision";
    return null;
  };
  const resolved = (d: Decision) => {
    const n = c.issues.findIndex((i) => i.type === "ambiguous" && i.instruction && `${i.instruction.kind}:${i.instruction.questionId}:${slug(i.instruction.text)}` === d.id);
    if (n >= 0) { const was = c.issues[n]; c.issues.splice(n, 1, { location: was.location, type: "inferred", severity: "info", message: `Decided during the import: ${was.message.replace(/^Logic cannot be determined with certainty: /, "")}`, autoAttempted: false, refs: was.refs }); }
  };
  for (const d of decisions) {
    const q = "questionId" in d ? byId.get(d.questionId ?? "") : undefined;
    if ("questionId" in d && d.type !== "embedded" && !q) { rejected.push({ id: d.id, reason: `question ${d.questionId} is not in the survey` }); continue; }
    switch (d.type) {
      case "dismiss": {
        applied.push(d.id);
        /* left for Studio: still on the review list, no longer a question */
        const n = c.issues.findIndex((i) => i.type === "ambiguous" && i.instruction && `${i.instruction.kind}:${i.instruction.questionId}:${slug(i.instruction.text)}` === d.id);
        if (n >= 0) c.issues.splice(n, 1, { ...c.issues[n], type: "reference", severity: "medium", message: `Left to do in Studio: ${c.issues[n].message.replace(/^Logic cannot be determined with certainty: /, "")}`, instruction: undefined });
        break;
      }
      case "display": {
        const why = checkExpr(d.when); if (why) { rejected.push({ id: d.id, reason: why }); break; }
        q!.displayLogic = q!.displayLogic ? { t: "group", op: "and", children: [q!.displayLogic, d.when] } : d.when;
        if (q!.confidence === "ambiguous") q!.confidence = "review";
        applied.push(d.id); resolved(d); break;
      }
      case "skip": {
        const why = checkExpr(d.when); if (why) { rejected.push({ id: d.id, reason: why }); break; }
        if (d.to.kind === "question" && !byId.has(d.to.id)) { rejected.push({ id: d.id, reason: `question ${d.to.id} is not in the survey` }); break; }
        q!.skips.push({ when: d.when, to: d.to, label: "decided during the import" });
        if (q!.confidence === "ambiguous") q!.confidence = "review";
        applied.push(d.id); resolved(d); break;
      }
      case "randomize": {
        const fixed = (d.fixed ?? []).filter((o) => q!.options.some((x) => x.sourceId === o));
        if (d.mode === "none") { q!.randomizeOptions = false; q!.randomization = undefined; }
        else { q!.randomizeOptions = true; q!.randomization = d.mode === "fix_special" && fixed.length ? { anchorsTop: [], anchorsBottom: fixed, undisplayed: [], sourceType: "decided during the import" } : undefined; }
        applied.push(d.id); resolved(d); break;
      }
      case "embedded": {
        const f = c.embedded.find((x) => x.name.toUpperCase() === d.name.toUpperCase());
        if (!f) { rejected.push({ id: d.id, reason: `there is no embedded field ${d.name}` }); break; }
        if (d.source === "question") {
          const src = d.questionId ? byId.get(d.questionId) : undefined;
          if (!src) { rejected.push({ id: d.id, reason: `question ${d.questionId} is not in the survey` }); break; }
          f.source = "expression"; f.value = `{{@${src.sourceId}}}`;
        } else { f.source = d.source; if (d.value !== undefined) f.value = d.value; }
        applied.push(d.id);
        const n = c.issues.findIndex((i) => i.instruction?.kind === "embedded" && i.instruction.name?.toUpperCase() === d.name.toUpperCase());
        if (n >= 0) c.issues.splice(n, 1, { location: c.issues[n].location, type: "inferred", severity: "info", message: `Decided during the import: ${d.name} comes from ${d.source === "question" ? `the answer to ${d.questionId}` : d.source === "url" ? "the survey link" : "a fixed value"}.`, autoAttempted: false });
        break;
      }
      case "or_instead_of_and": {
        const e = q!.displayLogic;
        if (!e || e.t !== "group" || e.op !== "and") { rejected.push({ id: d.id, reason: `${q!.variable} has no AND display rule to change` }); break; }
        q!.displayLogic = { ...e, op: "or" };
        applied.push(d.id); break;
      }
      case "replace_reference": {
        if (!byId.has(d.to)) { rejected.push({ id: d.id, reason: `question ${d.to} is not in the survey` }); break; }
        const fix = (e: CExpr | undefined): CExpr | undefined => !e ? e : e.t === "group" ? { ...e, children: e.children.map((x) => fix(x)!) } : e.t === "cmp" && e.ref.kind === "question" && e.ref.id === d.from ? { ...e, ref: { ...e.ref, id: d.to, choice: e.ref.choice && byId.get(d.to)!.options.some((o) => o.sourceId === e.ref.choice) ? e.ref.choice : undefined } } : e;
        q!.displayLogic = fix(q!.displayLogic);
        q!.skips = q!.skips.map((s) => ({ ...s, when: fix(s.when)!, to: s.to.kind === "question" && s.to.id === d.from ? { kind: "question", id: d.to } : s.to }));
        applied.push(d.id); break;
      }
    }
  }
  c.decidedIds = [...new Set([...(c.decidedIds ?? []), ...applied])];
  return { canonical: c, applied, rejected };
}

