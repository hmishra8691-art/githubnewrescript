/**
 * THE INTELLIGENT IMPORT, ORCHESTRATED (Intelligent Mode upgrade, 2026-11-13).
 *
 *   Upload → Scan → Understand → Analyze → Clarify → Program → Validate → Test → Finalize
 *
 * One function runs the stages in order and returns what each one found, in words a person can read. Each stage
 * is a separate engine with one job, and they share ONE model of the survey (the source-neutral CanonicalSurvey):
 *
 *   scan        Document engine      sources.ts + the format adapters: bytes → the survey as the source wrote it
 *   understand  Document engine      intelligence/understand.ts: sections and their purpose, programming, methods
 *   analyze     Logic engine         graph.ts: every dependency, and what is missing, circular or out of order
 *               Framing engine       the adapters' type inference + mappingDecision.ts: each question's type and why
 *               Content engine       intelligence/content.ts: wording a researcher would query (flagged, never changed)
 *   clarify     Clarification engine clarify.ts (+ method questions here): one plain question per open decision
 *   program     Programming engine   map.ts: the native survey definition, with placeholders for exercises
 *   validate    Validation engine    verify.ts structure + the engine's own quality check
 *   test        Testing engine       verify.ts walks, equivalence.ts scenarios, dynamicSim.ts respondents
 *   finalize    —                    the report: completed, pending, unresolved, and whether it passed
 *
 * WHAT IS CLEAR IS PROGRAMMED AT ONCE. An open question never stops the run: everything that does not depend on
 * it is programmed, validated and tested, and the question waits in `clarifications`. Answering it —
 * `continueIntelligentImport(session, answers)` — re-applies EVERY answer given so far to the original model and
 * runs the stages again, so an answer reaches the questions, logic and variables that depend on it and the result
 * is re-tested, without re-uploading. The session is plain data (the model + the answers): it can be stored and
 * resumed, and the answers are the record of what was decided.
 */
import type { CanonicalSurvey } from "../canonical.js";
import type { Detection } from "../detect.js";
import { readSource } from "../sources.js";
import { buildImportGraph } from "../graph.js";
import { clarifications, applyDecisions, type Clarification, type Decision } from "../clarify.js";
import { mapCanonical, type MapResult, type ImportScope } from "../map.js";
import { buildReport, type MigrationReport } from "../report.js";
import { verifyImport, type VerificationReport } from "../verify.js";
import { detectMethodologies, applyMethodologies, pendingMethodology, isPlatformExport, METHODS, type MethodKey, type MethodologyFinding } from "./methodology.js";
import { understandDocument, type Understanding } from "./understand.js";
import { reviewContent, type ContentFinding } from "./content.js";

export type StageId = "scan" | "understand" | "analyze" | "clarify" | "program" | "validate" | "test" | "finalize";
export type StageState = "done" | "attention" | "waiting" | "failed" | "skipped";
export interface Stage {
  id: StageId;
  title: string;
  /** which engine did the work */
  engine: string;
  state: StageState;
  /** one sentence: what happened */
  summary: string;
  /** a few facts, for a compact list */
  facts: string[];
}

/** a question for the person, in plain words */
export interface PlainClarification {
  id: string;
  /** "logic": how the survey should behave; "method": which research method a question is */
  about: "logic" | "method";
  /** what was found, in a sentence */
  found: string;
  /** why it cannot be decided without the person */
  why: string;
  /** where in the document, and the source's own words */
  where: string;
  quote: string;
  options: { label: string; recommended: boolean; explains?: string }[];
  /** the person may type their own answer; it is recorded and the point is left for Studio, never guessed */
  allowsOwnAnswer: boolean;
  answered: { choice?: number; own?: string; label: string } | null;
}

export interface ClarificationAnswer { id: string; choice?: number; own?: string }

export interface FinalReport {
  verdict: "passed" | "passed_with_pending" | "waiting_for_answers" | "checks_failed";
  /** one sentence */
  headline: string;
  completed: string[];
  /** still to do by a person, each with what is needed */
  pending: { what: string; needs: string }[];
  /** could not be reproduced or failed a test */
  unresolved: { what: string; why: string }[];
  /** found wrong and corrected by the importer itself */
  corrected: string[];
  /** every instruction the source carries, and what became of it — detected = programmed + partial + not programmed */
  accounting: { detected: number; programmed: number; partial: number; notProgrammed: number };
  tests: { walks: number; walkErrors: number; scenarios: number; scenariosPassed: number; scenariosFailed: number; notTestable: number };
}

export interface ImportSessionState {
  version: 1;
  detection: Detection;
  /** the survey exactly as the source wrote it — never modified; every run starts from it */
  canonical: CanonicalSurvey;
  /** every answer given so far, in the order given */
  answers: ClarificationAnswer[];
  scope: ImportScope;
  surveyId: string;
}

export interface IntelligentImport {
  ok: boolean;
  stages: Stage[];
  understanding: Understanding | null;
  methodologies: MethodologyFinding[];
  content: ContentFinding[];
  clarifications: PlainClarification[];
  /** how each question was framed: its source type, what it became, and how sure the reader is */
  framing: { total: number; exact: number; converted: number; review: { code: string; sourceType: string; became: string; why: string }[] };
  definition: MapResult["def"];
  /** the programming engine's full result (mapping, confidence, issues) — for callers that show the import map */
  result: MapResult | null;
  report: MigrationReport | null;
  verification: VerificationReport | null;
  final: FinalReport | null;
  /** answers that could not be applied, with the reason — nothing was changed for them */
  rejected: { id: string; reason: string }[];
  session: ImportSessionState | null;
  /** when the file could not be read at all */
  error?: string;
}

const STAGE_META: Record<StageId, { title: string; engine: string }> = {
  scan: { title: "Scan the file", engine: "Document intelligence" },
  understand: { title: "Understand the questionnaire", engine: "Document intelligence" },
  analyze: { title: "Analyze logic, question types and wording", engine: "Survey logic · Question framing · Content review" },
  clarify: { title: "Clarify what is unclear", engine: "Clarification" },
  program: { title: "Program the survey", engine: "Survey programming" },
  validate: { title: "Validate the result", engine: "Validation" },
  test: { title: "Test it as respondents", engine: "Testing" },
  finalize: { title: "Final report", engine: "Orchestration" },
};
const stage = (id: StageId, state: StageState, summary: string, facts: string[] = []): Stage => ({ id, ...STAGE_META[id], state, summary, facts: facts.filter(Boolean) });
const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const plain = (s: string | undefined) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const WHY: Record<Clarification["kind"], string> = {
  missing_condition: "The instruction says who should see this, but not which answer makes someone that kind of respondent.",
  missing_target: "The instruction says to skip, but not where to.",
  randomize_scope: "The instruction says to randomize, but not whether some answers stay in a fixed place.",
  embedded_source: "This value is used, but the document does not say where it comes from.",
  conflict: "Two instructions cannot both be followed.",
  undefined_reference: "The instruction names a question that is not in the document.",
  dynamic_list: "The answers depend on an earlier question, and the document can be read more than one way.",
  confirm_dynamic: "The reader worked this out from the wording rather than from an explicit instruction — please confirm.",
};

function plainOf(a: Clarification, answer: ClarificationAnswer | undefined): PlainClarification {
  const opts = [...(a.recommended ? [a.recommended] : []), ...a.alternatives.filter((o) => o !== a.recommended)];
  const options = opts.map((o, i) => ({ label: o.label, recommended: !!a.recommended && i === 0, ...(a.recommended && i === 0 && a.because ? { explains: a.because } : {}) }));
  const answered = answer ? { ...(answer.choice !== undefined ? { choice: answer.choice } : {}), ...(answer.own ? { own: answer.own } : {}), label: answer.own ? `Your answer: ${answer.own}` : options[answer.choice ?? -1]?.label ?? "" } : null;
  return { id: a.id, about: "logic", found: a.question, why: WHY[a.kind] ?? "The document leaves this open.", where: a.location, quote: plain(a.evidence), options, allowsOwnAnswer: true, answered: answered && answered.label ? answered : null };
}

function methodAsk(f: MethodologyFinding, sourceId: string, code: string, answer: ClarificationAnswer | undefined): PlainClarification {
  const def = METHODS.find((m) => m.key === f.method)!;
  const options = [
    { label: `Keep ${code} as an ordinary question, exactly as written`, recommended: true, explains: "The document does not name the method, so nothing is changed unless you say so." },
    { label: `Treat ${code} as a ${def.label} exercise (a placeholder is created; the design is added later)`, recommended: false },
  ];
  const answered = answer ? { ...(answer.choice !== undefined ? { choice: answer.choice } : {}), ...(answer.own ? { own: answer.own } : {}), label: answer.own ? `Your answer: ${answer.own}` : options[answer.choice ?? -1]?.label ?? "" } : null;
  return { id: `method:${sourceId}`, about: "method", found: `${code} looks like a ${def.label} task.`, why: "It has the shape of the method, but the document does not call it one — converting it would change how it is asked and analysed.", where: code, quote: f.evidence[0] ?? "", options, allowsOwnAnswer: true, answered: answered && answered.label ? answered : null };
}

/** run every stage on a model already read (the resume path, and the second half of the first run) */
export function advanceIntelligentImport(session: ImportSessionState): IntelligentImport {
  const stages: Stage[] = [];
  const source = session.canonical;
  const answers = new Map(session.answers.map((a) => [a.id, a]));
  const rejected: { id: string; reason: string }[] = [];

  /* ---- scan */
  const el = source.elements ?? [];
  const unread = el.filter((e) => e.handled !== "read");
  stages.push(stage("scan", "done", `Read ${session.detection.label || source.source.format} “${source.source.fileName}”: ${n(source.questions.length, "question")}${el.length ? `, ${n(el.reduce((t, e) => t + e.count, 0), "element")} of ${n(el.length, "kind")}` : ""}.`,
    [session.detection.reasons?.[0] ?? "", unread.length ? `${n(unread.length, "kind")} of element not read: ${unread.slice(0, 4).map((e) => `${e.type} (${e.handled})`).join(", ")}` : el.length ? "every kind of element in the file was read" : ""]));

  /* ---- understand */
  const graph = buildImportGraph(source);
  const methods = detectMethodologies(source);
  const understanding = understandDocument(source, graph, methods);
  stages.push(stage("understand", "done", understanding.summary, [
    `Purpose (inferred): ${understanding.objective.text}`,
    ...understanding.sections.slice(0, 8).map((s) => `${s.title} — ${s.purpose}${s.questions ? `, ${n(s.questions, "question")}` : ""}${s.looped ? ", repeated in a loop" : ""}${s.conditional ? ", shown on a condition" : ""}`),
    understanding.sections.length > 8 ? `…and ${understanding.sections.length - 8} more sections` : "",
  ]));

  /* ---- analyze: logic, framing, content */
  const content = reviewContent(source);
  const logicHigh = understanding.problems.filter((p) => p.severity === "high");
  stages.push(stage("analyze", logicHigh.length ? "attention" : "done",
    `${n(graph.edges.length, "dependency", "dependencies")} between questions traced; ${understanding.problems.length ? `${n(understanding.problems.length, "problem")} found (${n(logicHigh.length, "important one")})` : "no missing, circular or out-of-order logic"}; ${content.length ? `${n(content.length, "wording point")} flagged for the researcher (nothing was changed)` : "no wording points"}.`,
    [...logicHigh.slice(0, 5).map((p) => `${p.where}: ${p.message}`), ...content.filter((f) => f.severity === "high").slice(0, 3).map((f) => f.message),
      understanding.dependencies.mostRead.length ? `Most depended on: ${understanding.dependencies.mostRead.map((m) => `${m.code} (read by ${m.readBy})`).join(", ")}` : ""]));

  /* ---- clarify: every open decision, and the answers given so far */
  const asks = clarifications(source);
  const decisions: Decision[] = [];
  const ownNotes: { id: string; where: string; text: string }[] = [];
  const plainAsks: PlainClarification[] = [];
  for (const a of asks) {
    const ans = answers.get(a.id);
    const p = plainOf(a, ans);
    plainAsks.push(p);
    if (!ans) continue;
    if (ans.own && ans.own.trim()) { decisions.push({ id: a.id, type: "dismiss" }); ownNotes.push({ id: a.id, where: a.location, text: ans.own.trim() }); continue; }
    const opts = [...(a.recommended ? [a.recommended] : []), ...a.alternatives.filter((o) => o !== a.recommended)];
    const picked = opts[ans.choice ?? -1];
    if (!picked) { rejected.push({ id: a.id, reason: "that answer is not one of the choices offered" }); p.answered = null; continue; }
    decisions.push({ ...picked.decision, id: a.id } as Decision);
  }
  /*
   * AN INSTRUCTION THE READER COULD NOT TURN INTO LOGIC is never left as a line in a report: it is put to the
   * person. The importer does not guess what it means — the choices are to program it by hand, or to say it needs
   * no programming; a typed answer is recorded with it.
   */
  const unreadDismissed = new Set<number>();
  source.issues.forEach((i, at) => {
    if (i.type !== "dropped" || !/was not turned into logic/.test(i.message)) return;
    const quote = /“([^”]+)”/.exec(i.location)?.[1] ?? /“([^”]+)”/.exec(i.message)?.[1] ?? "";
    const where = i.location.split(" · ")[0];
    const id = `unread:${where}:${quote.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`;
    const ans = answers.get(id);
    const options = [
      { label: "I will program this in Studio — keep it on the to-do list", recommended: true, explains: "The importer could not read this instruction, so it will not guess what it means." },
      { label: "It needs no programming — ignore it", recommended: false },
    ];
    const answered = ans ? (ans.own?.trim() ? { own: ans.own.trim(), label: `Your answer: ${ans.own.trim()}` } : options[ans.choice ?? -1] ? { choice: ans.choice, label: options[ans.choice!].label } : null) : null;
    if (ans && !answered) rejected.push({ id, reason: "that answer is not one of the choices offered" });
    plainAsks.push({ id, about: "logic", found: `An instruction at ${where} could not be turned into survey logic.`, why: "Its wording is not one the reader understands, and guessing could change who sees the question.", where, quote, options, allowsOwnAnswer: true, answered });
    if (answered?.own) ownNotes.push({ id, where, text: answered.own });
    if (answered?.choice === 1) unreadDismissed.add(at);
  });
  const methodDecisions: Record<string, MethodKey | "none"> = {};
  const byId = new Map(source.questions.map((q) => [q.sourceId, q]));
  for (const f of methods) {
    /* asked only of a document: an export already states how the question is built */
    if (f.certainty !== "inferred" || f.support === "native" || isPlatformExport(source)) continue;
    for (const id of f.sourceIds) {
      const q = byId.get(id);
      if (!q) continue;
      const ans = answers.get(`method:${id}`);
      plainAsks.push(methodAsk(f, id, q.code ?? q.variable, ans));
      if (!ans) continue;
      if (ans.own && ans.own.trim()) { methodDecisions[id] = "none"; ownNotes.push({ id: `method:${id}`, where: q.code ?? q.variable, text: ans.own.trim() }); }
      else methodDecisions[id] = ans.choice === 1 ? f.method : "none";
    }
  }
  for (const a of session.answers) if (!plainAsks.some((p) => p.id === a.id)) rejected.push({ id: a.id, reason: "there is no such question in this import" });
  const open = plainAsks.filter((p) => !p.answered);
  stages.push(stage("clarify", open.length ? "waiting" : "done",
    plainAsks.length === 0 ? "Nothing needed asking — every instruction could be read." : open.length ? `${n(open.length, "question")} for you${plainAsks.length > open.length ? `; ${plainAsks.length - open.length} answered` : ""}. Everything that does not depend on them is already programmed.` : `All ${n(plainAsks.length, "question")} answered and applied.`,
    open.slice(0, 5).map((p) => `${p.where}: ${p.found}`)));

  /* ---- program */
  const decided = applyDecisions(unreadDismissed.size ? { ...source, issues: source.issues.map((i, at) => (unreadDismissed.has(at) ? { ...i, type: "inferred" as const, severity: "info" as const, message: `Decided during the import — no programming needed: ${i.message}` } : i)) } : source, decisions);
  for (const r of decided.rejected) { rejected.push(r); const p = plainAsks.find((x) => x.id === r.id); if (p) p.answered = null; }
  for (const note of ownNotes) decided.canonical.issues.push({ location: note.where, type: "reference", severity: "medium", autoAttempted: false, message: `Your instruction for ${note.where}: “${note.text}” — recorded; it is not programmed automatically, apply it in Studio.` });
  const withMethods = applyMethodologies(decided.canonical, detectMethodologies(decided.canonical), methodDecisions);
  const canonical = withMethods.canonical;
  let result: MapResult | null = null;
  let programError = "";
  try { result = mapCanonical(canonical, { surveyId: session.surveyId, scope: session.scope }); } catch (e) { programError = (e as Error).message; }
  const def = result?.def ?? null;
  const report = result ? buildReport(session.detection, canonical, result, session.scope) : null;
  const placeholders = pendingMethodology(canonical);
  const framingDecisions = report?.mapping?.decisions ?? [];
  const framing: IntelligentImport["framing"] = {
    total: framingDecisions.length, exact: framingDecisions.filter((d) => d.decision === "exact").length, converted: framingDecisions.filter((d) => d.decision === "components").length,
    review: framingDecisions.filter((d) => d.decision !== "exact" && d.decision !== "components").slice(0, 40).map((d) => ({ code: d.variable, sourceType: d.sourceType, became: d.target, why: d.note })),
  };
  const fid = report?.fidelity;
  stages.push(stage("program", !def ? "failed" : placeholders.length || framing.review.length ? "attention" : "done",
    !def ? `The survey could not be built${programError ? `: ${programError}` : ""}.` : `Built ${n(def.questions.length, "question")}${fid ? `; ${fid.totals.imported} of ${fid.totals.detected} source items programmed, ${fid.totals.partial} partly, ${fid.totals.unsupported} not` : ""}${placeholders.length ? `; ${n(placeholders.length, "exercise placeholder")} created` : ""}${decided.applied.length ? `; ${n(decided.applied.length, "of your answers", "of your answers")} applied` : ""}.`,
    [...placeholders.slice(0, 4).map((p) => `${p.code}: ${p.label} — ${p.support === "pending" ? "not available yet" : "design to add"}`), ...framing.review.slice(0, 4).map((r) => `${r.code} (${r.sourceType}): ${r.why}`)]));

  /* ---- validate + test */
  let verification: VerificationReport | null = null;
  let verifyError = "";
  if (def && result) { try { verification = verifyImport(canonical, result); } catch (e) { verifyError = (e as Error).message; } }
  /*
   * A PLACEHOLDER IS PENDING, NOT A FAILURE. An exercise without its design cannot be answered and the survey's own
   * check says "no design is selected" — both are the placeholder doing its job. They are reported once, under
   * pending, and never counted as a failed check (nor as a pass).
   */
  const placeholderCodes = new Set(placeholders.map((p) => p.code));
  const NO_DESIGN = /renders tasks from a design file, but no design is selected/;
  const rawQuality = result?.quality ?? null;
  const quality = rawQuality ? { ...rawQuality, errors: rawQuality.errors.filter((e) => !NO_DESIGN.test(e)) } : null;
  const structural = verification?.structure.findings ?? [];
  const sErrors = structural.filter((f) => f.level === "error");
  stages.push(stage("validate", !def ? "skipped" : verifyError ? "failed" : sErrors.length || (quality && quality.errors.length) ? "attention" : "done",
    !def ? "Not run — there is no survey to validate." : verifyError ? `Validation could not run: ${verifyError}` : `${verification!.structure.ok} of ${verification!.structure.checked} questions match the source (type, answers, codes, variables)${sErrors.length ? `; ${n(sErrors.length, "mismatch", "mismatches")}` : ""}${quality ? `; the survey's own quality check: ${n(quality.errors.length, "error")}, ${n(quality.warnings.length, "warning")}` : ""}.`,
    [...sErrors.slice(0, 4).map((f) => `${f.sourceId}: ${f.message}`), ...(quality?.errors ?? []).slice(0, 3)]));

  const rt = verification?.runtime;
  const beh = verification?.behaviour;
  const walkErrors = rt ? rt.walks.filter((w) => w.error).length + rt.errors.length : 0;
  const unanswerable = (rt?.unanswerable ?? []).filter((u) => !placeholderCodes.has(u.code));
  const noWalk = (rt?.unreachable ?? []).filter((u) => u.reason === "no_walk");
  stages.push(stage("test", !verification ? "skipped" : walkErrors || (beh?.failed ?? 0) || unanswerable.length ? "attention" : "done",
    !verification ? "Not run." : `${n(rt!.walks.length, "simulated interview")} run end to end (${rt!.reached} of ${rt!.placed} questions reached${walkErrors ? `, ${n(walkErrors, "error")}` : ", no errors"})${beh ? `; ${beh.passed} of ${beh.scenarios.length} logic scenarios behave as the source says${beh.failed ? `, ${beh.failed} do not` : ""}${beh.notTestable ? `, ${beh.notTestable} could not be tested automatically` : ""}` : ""}.`,
    [...(beh?.scenarios ?? []).filter((s) => s.result === "fail").slice(0, 4).map((s) => `${s.rule}: ${s.observed}`), ...unanswerable.slice(0, 3).map((u) => `${u.code} could not be answered: ${u.message}`), noWalk.length ? `${n(noWalk.length, "question")} no simulated interview reached: ${noWalk.slice(0, 6).map((u) => u.code).join(", ")}` : ""]));

  /* ---- finalize */
  let final: FinalReport | null = null;
  if (def && report) {
    const completed: string[] = [];
    const t = fid?.totals;
    completed.push(`${n(def.questions.length, "question")} programmed in ${n(understanding.sections.length, "section")}`);
    for (const f of fid?.features ?? []) if (f.feature !== "question" && f.imported > 0) completed.push(`${f.label}: ${f.imported} of ${f.detected}`);
    if (decided.applied.length) completed.push(`${n(decided.applied.length, "clarification")} answered and applied`);
    const pending: FinalReport["pending"] = [];
    for (const p of placeholders) pending.push({ what: `${p.code} — ${p.label} placeholder`, needs: p.needs.join("; ") });
    /* an exercise an export already builds its own way: reported with what it still needs, not re-built */
    for (const m of methods) if (m.support !== "native" && m.certainty === "stated" && !m.sourceIds.some((id) => placeholders.some((p) => p.sourceId === id))) pending.push({ what: `${m.label}${m.questions.length ? ` at ${m.questions.slice(0, 4).join(", ")}` : ""}`, needs: m.needs.join("; ") });
    for (const f of canonical.requiredFiles ?? []) pending.push({ what: `File needed: ${f.name}`, needs: f.why });
    for (const p of open) pending.push({ what: `Your answer: ${p.found}`, needs: `${p.where}${p.options.find((o) => o.recommended) ? ` — suggested: ${p.options.find((o) => o.recommended)!.label}` : ""}` });
    for (const note of ownNotes) pending.push({ what: `Your instruction for ${note.where}`, needs: `“${note.text}” — apply it in Studio` });
    for (const c of content.filter((x) => x.severity === "high")) pending.push({ what: `Wording to check at ${c.question}`, needs: c.message });
    const unresolved: FinalReport["unresolved"] = [];
    for (const f of fid?.features ?? []) if (f.unsupported > 0) unresolved.push({ what: `${f.label}: ${f.unsupported} not programmed${f.examples.unsupported.length ? ` (${f.examples.unsupported.slice(0, 4).join(", ")})` : ""}`, why: f.reasons.slice(0, 2).join(" ") || "no equivalent" });
    for (const s of (beh?.scenarios ?? []).filter((x) => x.result === "fail")) unresolved.push({ what: `Behaves differently from the source: ${s.rule}`, why: s.observed });
    for (const f of sErrors) unresolved.push({ what: `${f.sourceId} does not match the source`, why: f.message });
    for (const e of rt?.errors ?? []) unresolved.push({ what: "A simulated interview failed", why: e });
    for (const u of unanswerable) unresolved.push({ what: `${u.code} could not be answered in testing`, why: u.message });
    const corrected = (result?.reconstruction as { corrections?: { message?: string; what?: string }[] } | undefined)?.corrections?.map((x) => x.message ?? x.what ?? "").filter(Boolean) ?? [];
    const failed = sErrors.length > 0 || (beh?.failed ?? 0) > 0 || walkErrors > 0 || unanswerable.length > 0;
    const verdict: FinalReport["verdict"] = failed ? "checks_failed" : open.length ? "waiting_for_answers" : pending.length || unresolved.length ? "passed_with_pending" : "passed";
    final = {
      verdict,
      headline: verdict === "passed" ? "Programmed, validated and tested — nothing is pending."
        : verdict === "passed_with_pending" ? `Programmed, validated and tested. ${n(pending.length, "item")} still to complete${unresolved.length ? ` and ${unresolved.length} not reproduced` : ""}.`
          : verdict === "waiting_for_answers" ? `Everything clear is programmed and tested. ${n(open.length, "question")} waiting for your answer.`
            : `Programmed, but ${n(unresolved.length, "check")} did not pass — see what is unresolved.`,
      completed, pending, unresolved, corrected,
      accounting: { detected: t?.detected ?? 0, programmed: t?.imported ?? 0, partial: t?.partial ?? 0, notProgrammed: t?.unsupported ?? 0 },
      tests: { walks: rt?.walks.length ?? 0, walkErrors, scenarios: beh?.scenarios.length ?? 0, scenariosPassed: beh?.passed ?? 0, scenariosFailed: beh?.failed ?? 0, notTestable: beh?.notTestable ?? 0 },
    };
  }
  stages.push(stage("finalize", !final ? "failed" : final.verdict === "passed" ? "done" : final.verdict === "checks_failed" ? "attention" : final.verdict === "waiting_for_answers" ? "waiting" : "attention", final?.headline ?? "No survey was produced.",
    final ? [`Source items: ${final.accounting.detected} found = ${final.accounting.programmed} programmed + ${final.accounting.partial} partly + ${final.accounting.notProgrammed} not`, final.pending.length ? `${n(final.pending.length, "pending item")}` : "", final.unresolved.length ? `${n(final.unresolved.length, "unresolved item")}` : ""] : []));

  return { ok: !!def, stages, understanding, methodologies: methods, content, clarifications: plainAsks, framing, definition: def, result, report, verification, final, rejected, session };
}

/** the whole run from a file */
export async function runIntelligentImport(bytes: Uint8Array, fileName: string, opts: { scope?: ImportScope; surveyId?: string; answers?: ClarificationAnswer[] } = {}): Promise<IntelligentImport> {
  const read = await readSource(bytes, fileName);
  if (!read.canonical) {
    const why = read.issues.map((i) => i.message).join(" ") || "the file could not be read as a survey";
    return { ok: false, stages: [stage("scan", "failed", why)], understanding: null, methodologies: [], content: [], clarifications: [], framing: { total: 0, exact: 0, converted: 0, review: [] }, definition: null, result: null, report: null, verification: null, final: null, rejected: [], session: null, error: why };
  }
  return advanceIntelligentImport({ version: 1, detection: read.detection, canonical: read.canonical, answers: opts.answers ?? [], scope: opts.scope ?? "full", surveyId: opts.surveyId ?? "import_preview" });
}

/** answer one or more clarifications and carry on: every answer so far is re-applied and the stages run again */
export function continueIntelligentImport(session: ImportSessionState, answers: ClarificationAnswer[]): IntelligentImport {
  const byId = new Map(session.answers.map((a) => [a.id, a]));
  for (const a of answers) byId.set(a.id, a);
  return advanceIntelligentImport({ ...session, answers: [...byId.values()] });
}

/** what a client needs of a run: everything a person reads, without the model, the definition or the raw verification */
export type IntelligenceView = Pick<IntelligentImport, "ok" | "stages" | "understanding" | "methodologies" | "clarifications" | "framing" | "final" | "rejected"> & { content: ContentFinding[] };
export function intelligenceView(run: IntelligentImport): IntelligenceView {
  return { ok: run.ok, stages: run.stages, understanding: run.understanding, methodologies: run.methodologies, content: run.content.slice(0, 200), clarifications: run.clarifications, framing: run.framing, final: run.final, rejected: run.rejected };
}
