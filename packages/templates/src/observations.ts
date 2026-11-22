import type { SurveyDefinition } from "@rescript/schema";
import { conditionRefs, conditionSummary, evaluateCondition, questionConditions, reviewSurvey, type SurveyAction, type SurveyReview } from "@rescript/engine";
import { runSimulation, type Journey, type SimulationConfig, type SimulationRunReport } from "./simulationRun.js";

/**
 * VERIFIER FEEDBACK AS OBSERVATIONS (Level 5 roadmap A5 — 2026-11-24).
 *
 * A verification used to end in a list of sentences ("expectation broken — Q7 is shown: 3 of 40 respondents").
 * A person can read that; an agent cannot act on it without parsing prose, and neither can tell which respondent,
 * which answers and which condition. An OBSERVATION says the same thing as data:
 *
 *   kind          what was seen (a question nobody reached, a broken expectation, a script error, an invalid answer
 *                 accepted, nobody finishing, an unbalanced rotation, a finding of the rule review)
 *   where         the questions and the page
 *   condition     the condition involved, in words, and the questions it reads
 *   respondents   up to three simulated respondents it happened to, each with only the answers that matter
 *   seen          how often: n of N
 *   fix           the engine's own mechanical fix, when it has one — as actions, to be proposed, never applied here
 *   look          what to examine next, in one sentence
 *
 * Nothing here judges wording or method, and nothing is fixed: this is what the checks SAW. Respondents are
 * simulated and are labelled so; none of this is data about people.
 */
export type ObservationKind =
  | "never_shown" | "condition_never_true" | "expectation_broken" | "script_error" | "invalid_answer_accepted"
  | "nobody_completes" | "unbalanced_rotation" | "blocked_validation" | "review_finding" | "generation_issue";
export type ObservationSeverity = "blocker" | "problem" | "note";

export interface ObservedRespondent {
  /** the simulated respondent's code in the run (SIM-…) */
  code: string;
  endStatus: string;
  /** question code → answer, only for the questions the observation is about */
  answers: Record<string, unknown>;
  /** the last page they saw */
  lastPage?: string;
}
export interface Observation {
  id: string;
  kind: ObservationKind;
  severity: ObservationSeverity;
  message: string;
  where: { questionIds: string[]; codes: string[]; pageId?: string };
  condition?: { where: string; text: string; reads: string[] };
  respondents: ObservedRespondent[];
  seen?: { count: number; of: number };
  fix?: SurveyAction[];
  look: string;
  source: "simulation" | "review";
}
export interface Verification {
  ok: boolean;
  observations: Observation[];
  counts: Record<ObservationSeverity, number>;
  checked: { simulatedRespondents: number; completed: number; questions: number; questionsReached: number; conditions: number; conditionsTrueAtLeastOnce: number; expectations: number; invalidProbes: number; reviewFindings: number };
  /** always true: the respondents are simulated */
  simulated: true;
}

const RANK: Record<ObservationSeverity, number> = { blocker: 0, problem: 1, note: 2 };
const EXAMPLES = 3;

/** turn a simulation run (and the rule review) into observations */
export function observe(def: SurveyDefinition, run: SimulationRunReport, review?: SurveyReview): Verification {
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  const code = (id: string) => byId.get(id)?.code ?? id;
  const pageOf = new Map<string, string>();
  const walk = (nodes: unknown[]) => { for (const n of nodes as { id?: string; questionIds?: string[]; children?: unknown[] }[]) { if (n.questionIds && n.id) for (const q of n.questionIds) if (!pageOf.has(q)) pageOf.set(q, n.id); if (n.children) walk(n.children); } };
  walk(def.flow as unknown[]);
  const respondent = (j: Journey, about: Iterable<string>): ObservedRespondent => {
    const answers: Record<string, unknown> = {};
    for (const id of about) if (j.answers[id] !== undefined) answers[code(id)] = j.answers[id];
    return { code: j.code, endStatus: j.endStatus, answers, ...(j.pages.length ? { lastPage: j.pages[j.pages.length - 1]!.pageId } : {}) };
  };
  const displayCondition = (id: string) => {
    const q = byId.get(id);
    const own = q ? questionConditions(def, q).find((c) => /display/i.test(c.where)) : undefined;
    if (!own) return undefined;
    return { where: own.where, text: conditionSummary(def, own.c), reads: [...conditionRefs(def, own.c)], c: own.c };
  };
  /** would the condition be true on the answers this respondent ended with? (false when it cannot be told) */
  const holdsFor = (c: Parameters<typeof evaluateCondition>[0], j: Journey): boolean => {
    try { return evaluateCondition(c, { def, state: { answers: j.answers, calculated: j.calculated, embedded: {}, vars: j.vars } as never, loop: null }); } catch { return false; }
  };
  const pub = (c: { where: string; text: string; reads: string[] }) => ({ where: c.where, text: c.text, reads: c.reads.map(code) });
  const out: Observation[] = [];
  const N = run.produced;

  /* ---- a question no simulated respondent was shown */
  for (const m of run.coverage.questions.missing) {
    const cond = displayCondition(m.id);
    const page = pageOf.get(m.id);
    /* who got to its page and did not see it, and who never got to the page */
    const hidden = run.journeys.filter((j) => j.pages.some((p) => p.hiddenByLogic.includes(m.id)));
    const reached = run.journeys.filter((j) => page && j.pages.some((p) => p.pageId === page));
    const reads = cond?.reads ?? [];
    /* the respondents whose answers WOULD show it: where did they go instead? That is the path that failed */
    const would = cond ? run.journeys.filter((j) => reads.every((r) => j.answers[r] !== undefined) && holdsFor(cond.c, j)) : [];
    const ends = new Map<string, number>();
    for (const j of would) { const k = `${j.endStatus} after page ${j.pages[j.pages.length - 1]?.pageId ?? "?"}`; ends.set(k, (ends.get(k) ?? 0) + 1); }
    const wentTo = [...ends.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ended ${k}`).join(", ");
    const examples = (would.length ? would : hidden.length ? hidden : run.journeys).slice(0, EXAMPLES).map((j) => respondent(j, reads));
    out.push({
      id: `never_shown:${m.id}`, kind: "never_shown", severity: "problem", source: "simulation",
      message: `${m.code} was shown to none of ${N} simulated respondents${hidden.length ? `: ${hidden.length} reached its page and its display logic hid it` : page && !reached.length ? ": nobody reached its page" : ""}.${would.length ? ` ${would.length} answered so that it should show, and never reached it: ${wentTo}.` : ""}`,
      where: { questionIds: [m.id], codes: [m.code], ...(page ? { pageId: page } : {}) },
      ...(cond ? { condition: pub(cond) } : {}),
      respondents: examples, seen: { count: 0, of: N },
      look: would.length ? `The answers that should show ${m.code} (“${cond!.text}”) also end the interview or skip past it. Find the skip, screen-out or quota on ${reads.map(code).join(", ")} that fires first; the respondents above are the ones it happened to.`
        : cond ? `Nobody answered so that “${cond.text}” was true${reads.length ? `: it reads ${reads.map(code).join(", ")}, and the respondents above show what those were answered` : ""}. Check that it can be true at all.`
        : page && !reached.length ? `Find what ends the interview or skips past the page before ${m.code}: the respondents above show where they stopped.` : `Check the route to ${m.code}.`,
    });
  }

  /* ---- an expectation the survey's author wrote that did not hold */
  for (const e of run.expectations.filter((x) => x.broken)) {
    const broke = run.journeys.filter((j) => j.checks[e.id] === false);
    const cond = displayCondition(e.question);
    out.push({
      id: `expectation:${e.id}`, kind: "expectation_broken", severity: "blocker", source: "simulation",
      message: `${e.label}: broken for ${e.broken} of ${e.applicable} simulated respondents it applied to.`,
      where: { questionIds: [e.question], codes: [code(e.question)], ...(pageOf.get(e.question) ? { pageId: pageOf.get(e.question)! } : {}) },
      ...(cond ? { condition: pub(cond) } : {}),
      respondents: broke.slice(0, EXAMPLES).map((j) => respondent(j, [...(cond?.reads ?? []), e.question])),
      seen: { count: e.broken, of: e.applicable },
      look: `${code(e.question)} should be ${e.expect} here and was not. Compare the answers above with ${cond ? `its display logic (“${cond.text}”)` : "the logic that routes to it"}.`,
    });
  }

  /* ---- a script that threw */
  const scripted = run.journeys.filter((j) => j.scriptErrors.length);
  const byError = new Map<string, Journey[]>();
  for (const j of scripted) for (const e of j.scriptErrors) byError.set(e, [...(byError.get(e) ?? []), j]);
  for (const [error, js] of byError) {
    const pageId = error.split(":")[0]!;
    out.push({
      id: `script_error:${pageId}:${out.length}`, kind: "script_error", severity: "blocker", source: "simulation",
      message: `A script failed for ${js.length} of ${N} simulated respondents — ${error}`,
      where: { questionIds: [], codes: [], pageId }, respondents: js.slice(0, EXAMPLES).map((j) => respondent(j, [])), seen: { count: js.length, of: N },
      look: `Open the script on page ${pageId}. The respondents above reached it; a script error on a live survey stops the page from working as written.`,
    });
  }

  /* ---- an answer that should have been refused and was not */
  for (const p of run.probes.filter((x) => !x.rejected)) out.push({
    id: `invalid:${p.question}:${p.probe}`, kind: "invalid_answer_accepted", severity: "problem", source: "simulation",
    message: `${p.code} accepted an invalid answer: ${p.probe}.`,
    where: { questionIds: [p.question], codes: [p.code], ...(pageOf.get(p.question) ? { pageId: pageOf.get(p.question)! } : {}) }, respondents: [],
    look: `Add or correct the validation on ${p.code} so that ${p.probe} is refused.`,
  });

  /* ---- nobody finishes */
  const completed = run.endings.complete ?? 0;
  if (N >= 5 && completed === 0) {
    const top = Object.entries(run.endings).sort((a, b) => b[1] - a[1])[0];
    const stuck = run.journeys.filter((j) => j.endStatus === top?.[0]);
    const lastPages = new Map<string, number>();
    for (const j of stuck) { const p = j.pages[j.pages.length - 1]?.pageId ?? "(no page)"; lastPages.set(p, (lastPages.get(p) ?? 0) + 1); }
    const where = [...lastPages.entries()].sort((a, b) => b[1] - a[1])[0];
    const onPage: string[] = where ? [...pageOf.entries()].filter(([, p]) => p === where[0]).map(([q]) => q) : [];
    out.push({
      id: "nobody_completes", kind: "nobody_completes", severity: "blocker", source: "simulation",
      message: `None of ${N} simulated respondents completed. ${top ? `${top[1]} ended “${top[0]}”` : ""}${where ? `, most often after page ${where[0]} (${where[1]})` : ""}.`,
      where: { questionIds: onPage, codes: onPage.map(code), ...(where ? { pageId: where[0] } : {}) },
      respondents: stuck.slice(0, EXAMPLES).map((j) => respondent(j, onPage)), seen: { count: 0, of: N },
      look: where ? `Look at what happens after page ${where[0]}: a screen-out, a quota or a skip there ends every interview. The respondents above show the answers they gave on it.` : "No respondent got past the start.",
    });
  }

  /* ---- a rotation that is not rotating */
  for (const r of run.randomization.filter((x) => !x.balanced)) out.push({
    id: `rotation:${r.variable}`, kind: "unbalanced_rotation", severity: "problem", source: "simulation",
    message: `${r.variable}: “${r.items[0]?.item}” came first for ${Math.round((r.items[0]?.firstShare ?? 0) * 100)}% of respondents, where ${r.items.length} items in rotation would each lead about ${Math.round(100 / Math.max(1, r.items.length))}%.`,
    where: { questionIds: [], codes: [] }, respondents: [],
    look: `Check the randomization that sets ${r.variable}: an anchored item, a fixed seed or a group that is not rotated would explain it.`,
  });

  /* ---- what the population generator could not do */
  for (const i of run.issues) {
    if (i.kind === "unsupported_type" || i.kind === "unreachable_question" || i.kind === "script_error") continue; /* said above, with respondents */
    const cond = i.questionId ? displayCondition(i.questionId) : undefined;
    out.push({
      id: `${i.kind}:${i.questionId ?? out.length}`, kind: i.kind === "blocked_validation" ? "blocked_validation" : "generation_issue", severity: i.kind === "blocked_validation" || i.kind === "no_options" ? "blocker" : "problem", source: "simulation",
      message: i.message, where: { questionIds: i.questionId ? [i.questionId] : [], codes: i.questionId ? [code(i.questionId)] : [], ...(i.questionId && pageOf.get(i.questionId) ? { pageId: pageOf.get(i.questionId)! } : {}) },
      ...(cond ? { condition: pub(cond) } : {}), respondents: [], seen: { count: i.count, of: N },
      look: i.kind === "blocked_validation" ? `No answer satisfies the validation on ${i.questionId ? code(i.questionId) : "this question"}: a respondent would be stuck on the page. Check its rules against each other.` : i.kind === "no_options" ? "The question has no option left to choose after its option logic ran." : "Check the condition: as written it cannot be true.",
    });
  }

  /* ---- conditions that were never true for anybody (and are not already explained by a question nobody saw) */
  const explained = new Set(out.filter((o) => o.kind === "never_shown").map((o) => o.condition?.text));
  for (const never of run.coverage.conditions.never) {
    if ([...explained].some((t) => t && never.includes(t))) continue;
    out.push({
      id: `condition_never:${out.length}`, kind: "condition_never_true", severity: "note", source: "simulation",
      message: `A condition was true for none of ${N} simulated respondents: ${never}.`, where: { questionIds: [], codes: [] }, respondents: [], seen: { count: 0, of: N },
      look: "It may be rare rather than wrong. Run more respondents, or aim them at it, before changing it.",
    });
  }

  /* ---- the rule review's findings, with the engine's own fix when it has one */
  const findings = review?.findings ?? [];
  findings.forEach((f, i) => {
    if (f.severity !== "critical" && !f.blocks) return; /* advice (wording, duplicates, method) is the review's own screen, not a failed check — even when it comes with a fix */
    out.push({
      id: `review:${f.category}:${i}`, kind: "review_finding", severity: "blocker", source: "review",
      message: f.message, where: { questionIds: f.questionIds, codes: f.questionIds.map(code), ...(f.questionIds[0] && pageOf.get(f.questionIds[0]) ? { pageId: pageOf.get(f.questionIds[0])! } : {}) },
      respondents: [], ...(f.fix?.length ? { fix: f.fix } : {}),
      look: f.suggestion ?? (f.fix?.length ? "The engine has a mechanical fix: propose it." : `Look at ${f.questionIds.map(code).join(", ") || "the survey"}.`),
    });
  });

  out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const counts = { blocker: 0, problem: 0, note: 0 };
  for (const o of out) counts[o.severity]++;
  return {
    ok: counts.blocker === 0 && counts.problem === 0, observations: out, counts, simulated: true,
    checked: {
      simulatedRespondents: N, completed, questions: run.coverage.questions.total, questionsReached: run.coverage.questions.exercised,
      conditions: run.coverage.conditions.total, conditionsTrueAtLeastOnce: run.coverage.conditions.fired, expectations: run.expectations.length, invalidProbes: run.probes.length, reviewFindings: findings.length,
    },
  };
}

/** simulate, review and report what was seen. Nothing is written and nothing is fixed */
export function verifySurvey(def: SurveyDefinition, cfg: Partial<SimulationConfig> & { review?: boolean } = {}): Verification {
  const { review, ...sim } = cfg;
  const run = runSimulation(def, { count: 60, seed: 11, ...sim });
  return observe(def, run, review === false ? undefined : reviewSurvey(def));
}

/** an observation as the two or three lines a person (or a model's context) reads */
export function observationLines(o: Observation): string[] {
  const lines = [`[${o.severity}] ${o.message}`];
  if (o.condition) lines.push(`  ${o.condition.where}: ${o.condition.text}`);
  for (const r of o.respondents) lines.push(`  ${r.code} (simulated, ended ${r.endStatus}${r.lastPage ? ` on ${r.lastPage}` : ""})${Object.keys(r.answers).length ? `: ${Object.entries(r.answers).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")}` : ""}`);
  lines.push(`  Look: ${o.look}`);
  return lines;
}
