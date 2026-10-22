import type { QualConditionalProbe, QualGuideQuestion, QualGuideSection, QualParticipantSegment, QualScreeningCriterion, QualStudy, SurveyDefinition } from "@rescript/schema";
import { QualStudy as QualStudySchema, QUAL_SECTION_KINDS } from "@rescript/schema";

/**
 * THE QUALITATIVE STUDY AS COPILOT ACTIONS (2026-10-18).
 *
 * A moderated interview or focus-group study is planned as `def.qualStudy`
 * (schema `qualStudy.ts`): objectives, protocol, the guide's sections with
 * timing, scripts, questions, probes, conditional probes, moderator
 * instructions, exercises and concepts, plus screening, consent and recording
 * disclosures, segments and the session plan. Two actions write it and nothing
 * else, through the same gate, preview and replay as every other action:
 *
 *   create_qual_guide   the whole guide from a request ("a 60-minute IDI guide
 *                       about switching"); refused when one exists unless
 *                       `replace: true` (then marked destructive)
 *   update_qual_guide   a PATCH: only what is named changes — scalar fields
 *                       replace, lists have add / remove forms, a section is
 *                       addressed by id or title and patched field by field,
 *                       its questions by id or text
 *
 * DETERMINISTIC: ids are the next free `s<n>` / `s<n>q<m>`, read from the
 * guide itself, so the server's preview and the browser's replay agree.
 * NOTHING LIVE: the guide is what a human moderator follows; Rescript runs no
 * conferencing or real-time moderation (the capability registry says so).
 */

export interface QualQuestionInput { target?: string; text?: string; probes?: string[]; addProbes?: string[]; removeProbes?: string[]; conditionalProbes?: QualConditionalProbe[]; addConditionalProbes?: QualConditionalProbe[]; moderatorNote?: string | null; minutes?: number | null }
export interface QualSectionInput {
  target?: string; title?: string; kind?: string; minutes?: number | null; purpose?: string | null; script?: string | null;
  instructions?: string[]; addInstructions?: string[];
  questions?: QualQuestionInput[]; addQuestions?: QualQuestionInput[]; updateQuestions?: QualQuestionInput[]; removeQuestions?: string[];
  exercise?: { title: string; instructions?: string; materials?: string[] } | null; stimuli?: string[]; after?: string;
}
export interface QualGuideFields {
  kind?: "interview" | "focus_group"; title?: string | null; objectives?: string[]; protocol?: string | null; durationMinutes?: number | null;
  groundRules?: string[]; screening?: QualScreeningCriterion[]; consent?: { statement?: string | null; recordingDisclosure?: string | null; dataUse?: string | null };
  segments?: { name: string; description?: string; target?: number }[]; sessionPlan?: { sessions?: number | null; participantsPerSession?: number | null; mode?: string | null; notes?: string | null };
  sections?: QualSectionInput[];
}
export interface QualGuidePatch extends QualGuideFields {
  addObjectives?: string[]; removeObjectives?: string[]; addGroundRules?: string[]; removeGroundRules?: string[];
  addScreening?: QualScreeningCriterion[]; removeScreening?: string[]; addSegments?: { name: string; description?: string; target?: number }[]; removeSegments?: string[];
  addSections?: QualSectionInput[]; removeSections?: string[];
}

export type QualAction =
  | ({ op: "create_qual_guide"; replace?: boolean } & QualGuideFields)
  | ({ op: "update_qual_guide" } & QualGuidePatch);

export const QUAL_ACTION_OPS = ["create_qual_guide", "update_qual_guide"] as const;
const OPS = new Set<string>(QUAL_ACTION_OPS);
export const isQualOp = (op: string): boolean => OPS.has(op);

/* ------------------------------------------------------------ the gate */

const str = (v: unknown, max = 2000): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const nullable = (v: unknown, max = 2000): string | null | undefined => (v === null ? null : str(v, max));
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const nonNeg = (v: unknown, what: string): number | null | undefined | { error: string } => { if (v === undefined) return undefined; if (v === null) return null; const n = num(v); return n === undefined || n < 0 ? { error: `${what} must be a number of 0 or more` } : n; };
const strList = (v: unknown, max = 60): string[] | undefined => (Array.isArray(v) ? v.map((x) => str(typeof x === "object" && x ? (x as Record<string, unknown>).text ?? (x as Record<string, unknown>).name ?? (x as Record<string, unknown>).criterion : x, 1000)).filter((x): x is string => !!x).slice(0, max) : typeof v === "string" && v.trim() ? [v.trim()] : undefined);
const isErr = (x: unknown): x is { error: string } => !!x && typeof x === "object" && "error" in (x as object);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function kindOf(v: unknown): "interview" | "focus_group" | undefined | { error: string } {
  if (v === undefined) return undefined;
  const t = String(v).toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(interview|idi|in_depth|in_depth_interview|depth_interview|interviews)$/.test(t)) return "interview";
  if (/^(focus_group|focus_groups|group|fg|discussion)$/.test(t)) return "focus_group";
  return { error: `kind is "interview" or "focus_group" (got ${JSON.stringify(v)})` };
}
const SECTION_KIND = new Set<string>(QUAL_SECTION_KINDS);
const sectionKind = (v: unknown): string | undefined => { const t = str(v, 40)?.toLowerCase().replace(/[\s-]+/g, "_"); if (!t) return undefined; if (SECTION_KIND.has(t)) return t; if (/^(intro|introduction|welcome)$/.test(t)) return "opening"; if (/^(warmup|warm)$/.test(t)) return "warm_up"; if (/^(wrap_up|wrapup|close|thanks|ending)$/.test(t)) return "closing"; if (/^(concept_test|concept_evaluation|stimulus|concepts)$/.test(t)) return "concept"; if (/^(task|activity|projective)$/.test(t)) return "exercise"; return "main"; };

function condProbes(v: unknown): QualConditionalProbe[] | undefined | { error: string } {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return { error: "conditionalProbes is a list of {\"ifMentions\":…, \"ask\":…}" };
  const out: QualConditionalProbe[] = [];
  for (const x of v) {
    const o = obj(x);
    const ifMentions = str(o?.ifMentions ?? o?.if ?? o?.when ?? o?.mentions, 400), ask = str(o?.ask ?? o?.then ?? o?.probe, 600);
    if (!ifMentions || !ask) return { error: "a conditional probe needs ifMentions (what the participant says) and ask (the follow-up)" };
    out.push({ ifMentions, ask });
  }
  return out.slice(0, 20);
}

function questionIn(x: unknown, needText: boolean): QualQuestionInput | { error: string } {
  if (typeof x === "string") return x.trim() ? { text: x.trim().slice(0, 1000) } : { error: "an empty question" };
  const o = obj(x);
  if (!o) return { error: "a question is text or an object with text" };
  const text = str(o.text ?? o.question, 1000), target = str(o.target ?? o.id, 200);
  if (needText && !text) return { error: "a question needs text" };
  if (!needText && !target) return { error: "updateQuestions needs a target (the question's id or text)" };
  const cp = condProbes(o.conditionalProbes); if (isErr(cp)) return cp;
  const acp = condProbes(o.addConditionalProbes); if (isErr(acp)) return acp;
  const minutes = nonNeg(o.minutes, "a question's minutes"); if (isErr(minutes)) return minutes;
  const note = nullable(o.moderatorNote ?? o.note, 1000);
  return { ...(target ? { target } : {}), ...(text ? { text } : {}), ...(strList(o.probes, 10) ? { probes: strList(o.probes, 10) } : {}), ...(strList(o.addProbes, 10) ? { addProbes: strList(o.addProbes, 10) } : {}), ...(strList(o.removeProbes, 10) ? { removeProbes: strList(o.removeProbes, 10) } : {}), ...(cp ? { conditionalProbes: cp } : {}), ...(acp ? { addConditionalProbes: acp } : {}), ...(note !== undefined ? { moderatorNote: note } : {}), ...(minutes !== undefined ? { minutes } : {}) };
}
function questionsIn(v: unknown, needText: boolean, what: string): QualQuestionInput[] | undefined | { error: string } {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return { error: `${what} is a list` };
  const out: QualQuestionInput[] = [];
  for (const x of v) { const q = questionIn(x, needText); if (isErr(q)) return { error: `${what}: ${q.error}` }; out.push(q); }
  return out.slice(0, 40);
}

function sectionIn(x: unknown, mode: "new" | "patch"): QualSectionInput | { error: string } {
  const o = obj(x);
  if (!o) return { error: "a section is an object with a title" };
  const title = str(o.title ?? o.name, 200), target = str(o.target ?? o.id, 200);
  if (mode === "new" && !title) return { error: "a section needs a title" };
  if (mode === "patch" && !target && !title) return { error: "a section patch names its section (target: id or title)" };
  const minutes = nonNeg(o.minutes, "a section's minutes"); if (isErr(minutes)) return minutes;
  const questions = questionsIn(o.questions, true, "questions"); if (isErr(questions)) return questions;
  const addQuestions = questionsIn(o.addQuestions, true, "addQuestions"); if (isErr(addQuestions)) return addQuestions;
  const updateQuestions = questionsIn(o.updateQuestions, false, "updateQuestions"); if (isErr(updateQuestions)) return updateQuestions;
  const ex = o.exercise === undefined ? undefined : o.exercise === null ? null : obj(o.exercise);
  if (ex && !str(ex.title)) return { error: "an exercise needs a title" };
  const exercise = ex === null ? null : ex ? { title: str(ex.title, 200)!, ...(str(ex.instructions) ? { instructions: str(ex.instructions) } : {}), ...(strList(ex.materials, 20) ? { materials: strList(ex.materials, 20) } : {}) } : undefined;
  const k = o.kind ?? o.type;
  return {
    ...(target ? { target } : {}), ...(title ? { title } : {}), ...(k !== undefined ? { kind: sectionKind(k) } : {}),
    ...(minutes !== undefined ? { minutes } : {}),
    ...(nullable(o.purpose) !== undefined ? { purpose: nullable(o.purpose) } : {}),
    ...(nullable(o.script ?? o.say, 4000) !== undefined ? { script: nullable(o.script ?? o.say, 4000) } : {}),
    ...(strList(o.instructions, 20) ? { instructions: strList(o.instructions, 20) } : {}),
    ...(strList(o.addInstructions, 20) ? { addInstructions: strList(o.addInstructions, 20) } : {}),
    ...(questions ? { questions } : {}), ...(addQuestions ? { addQuestions } : {}), ...(updateQuestions ? { updateQuestions } : {}),
    ...(strList(o.removeQuestions, 40) ? { removeQuestions: strList(o.removeQuestions, 40) } : {}),
    ...(exercise !== undefined ? { exercise } : {}), ...(strList(o.stimuli ?? o.concepts, 20) ? { stimuli: strList(o.stimuli ?? o.concepts, 20) } : {}),
    ...(str(o.after, 200) ? { after: str(o.after, 200) } : {}),
  };
}
function sectionsIn(v: unknown, mode: "new" | "patch", what: string): QualSectionInput[] | undefined | { error: string } {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return { error: `${what} is a list of sections` };
  const out: QualSectionInput[] = [];
  for (const x of v) { const s = sectionIn(x, mode); if (isErr(s)) return { error: `${what}: ${s.error}` }; out.push(s); }
  return out.slice(0, 30);
}
function screeningIn(v: unknown): QualScreeningCriterion[] | undefined {
  if (v === undefined || !Array.isArray(v)) return undefined;
  return v.map((x) => {
    if (typeof x === "string") return x.trim() ? { criterion: x.trim().slice(0, 500), rule: /^(exclude|no |not |never )/i.test(x.trim()) ? "exclude" as const : "include" as const } : null;
    const o = obj(x); const criterion = str(o?.criterion ?? o?.text ?? o?.name, 500);
    return criterion ? { criterion, rule: o?.rule === "exclude" ? "exclude" as const : "include" as const, ...(str(o?.quota, 200) ? { quota: str(o?.quota, 200) } : {}) } : null;
  }).filter((x): x is QualScreeningCriterion => !!x).slice(0, 40);
}
function segmentsIn(v: unknown): { name: string; description?: string; target?: number }[] | undefined {
  if (v === undefined || !Array.isArray(v)) return undefined;
  return v.map((x) => {
    if (typeof x === "string") return x.trim() ? { name: x.trim().slice(0, 200) } : null;
    const o = obj(x); const name = str(o?.name ?? o?.label, 200); const t = num(o?.target);
    return name ? { name, ...(str(o?.description, 500) ? { description: str(o?.description, 500) } : {}), ...(t !== undefined && t >= 0 ? { target: Math.round(t) } : {}) } : null;
  }).filter((x): x is { name: string } => !!x).slice(0, 20);
}

/** The gate: the model's JSON as a typed action, a reason, or null when the op is not one of these. */
export function coerceQualAction(op: string, o: Record<string, unknown>): QualAction | string | null {
  if (!isQualOp(op)) return null;
  const kind = kindOf(o.kind ?? o.type ?? o.method);
  if (isErr(kind)) return `${op}: ${kind.error}`;
  if (op === "create_qual_guide" && !kind) return "create_qual_guide needs a kind: \"interview\" (in-depth interviews) or \"focus_group\"";
  const dur = nonNeg(o.durationMinutes ?? o.duration ?? o.minutes, "durationMinutes"); if (isErr(dur)) return `${op}: ${dur.error}`;
  const mode = op === "create_qual_guide" ? "new" : "patch";
  const sections = sectionsIn(o.sections, mode, "sections"); if (isErr(sections)) return `${op}: ${sections.error}`;
  if (op === "create_qual_guide" && !sections?.length) return "create_qual_guide needs sections (opening, the topics, closing) — each with a title and its questions";
  const addSections = sectionsIn(o.addSections, "new", "addSections"); if (isErr(addSections)) return `${op}: ${addSections.error}`;
  const c = obj(o.consent); const sp = obj(o.sessionPlan);
  const consent = c ? { ...(nullable(c.statement, 4000) !== undefined ? { statement: nullable(c.statement, 4000) } : {}), ...(nullable(c.recordingDisclosure ?? c.recording, 4000) !== undefined ? { recordingDisclosure: nullable(c.recordingDisclosure ?? c.recording, 4000) } : {}), ...(nullable(c.dataUse, 4000) !== undefined ? { dataUse: nullable(c.dataUse, 4000) } : {}) } : undefined;
  let sessionPlan: QualGuideFields["sessionPlan"];
  if (sp) {
    const s = nonNeg(sp.sessions ?? sp.groups ?? sp.interviews, "sessions"); if (isErr(s)) return `${op}: ${s.error}`;
    const p = nonNeg(sp.participantsPerSession ?? sp.perGroup, "participantsPerSession"); if (isErr(p)) return `${op}: ${p.error}`;
    const m = sp.mode === null ? null : str(sp.mode, 20)?.toLowerCase().replace(/[\s-]+/g, "_");
    if (m && !["in_person", "remote", "phone", "mixed"].includes(m)) return `${op}: sessionPlan.mode is in_person, remote, phone or mixed`;
    sessionPlan = { ...(s !== undefined ? { sessions: s === null ? null : Math.round(s) } : {}), ...(p !== undefined ? { participantsPerSession: p === null ? null : Math.round(p) } : {}), ...(m !== undefined ? { mode: m } : {}), ...(nullable(sp.notes) !== undefined ? { notes: nullable(sp.notes) } : {}) };
  }
  const fields: QualGuidePatch = {
    ...(kind ? { kind } : {}),
    ...(nullable(o.title, 200) !== undefined ? { title: nullable(o.title, 200) } : {}),
    ...(strList(o.objectives) ? { objectives: strList(o.objectives) } : {}),
    ...(nullable(o.protocol, 4000) !== undefined ? { protocol: nullable(o.protocol, 4000) } : {}),
    ...(dur !== undefined ? { durationMinutes: dur === null ? null : Math.round(dur) } : {}),
    ...(strList(o.groundRules) ? { groundRules: strList(o.groundRules) } : {}),
    ...(screeningIn(o.screening) ? { screening: screeningIn(o.screening) } : {}),
    ...(consent ? { consent } : {}),
    ...(segmentsIn(o.segments) ? { segments: segmentsIn(o.segments) } : {}),
    ...(sessionPlan ? { sessionPlan } : {}),
    ...(sections ? { sections } : {}),
  };
  if (op === "create_qual_guide") return { op, ...(o.replace === true ? { replace: true } : {}), ...fields };
  const patch: QualGuidePatch = {
    ...fields,
    ...(strList(o.addObjectives) ? { addObjectives: strList(o.addObjectives) } : {}), ...(strList(o.removeObjectives) ? { removeObjectives: strList(o.removeObjectives) } : {}),
    ...(strList(o.addGroundRules) ? { addGroundRules: strList(o.addGroundRules) } : {}), ...(strList(o.removeGroundRules) ? { removeGroundRules: strList(o.removeGroundRules) } : {}),
    ...(screeningIn(o.addScreening) ? { addScreening: screeningIn(o.addScreening) } : {}), ...(strList(o.removeScreening) ? { removeScreening: strList(o.removeScreening) } : {}),
    ...(segmentsIn(o.addSegments) ? { addSegments: segmentsIn(o.addSegments) } : {}), ...(strList(o.removeSegments) ? { removeSegments: strList(o.removeSegments) } : {}),
    ...(addSections ? { addSections } : {}), ...(strList(o.removeSections) ? { removeSections: strList(o.removeSections) } : {}),
  };
  if (Object.keys(patch).length === 0) return "update_qual_guide names nothing to change";
  return { op: "update_qual_guide", ...patch };
}

/* ------------------------------------------------------------ applying */

export interface QualEnv { now?: string }
export interface QualApplied { description: string; destructive?: string; warnings: string[]; touched: string[] }
class QualActionError extends Error {}
const fail = (m: string): never => { throw new QualActionError(m); };
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const nextId = (taken: Iterable<string>, prefix: string): string => { const used = new Set(taken); let i = 1; while (used.has(`${prefix}${i}`)) i++; return `${prefix}${i}`; };

function findSection(study: QualStudy, ref: string): QualGuideSection | undefined {
  const r = norm(ref);
  return study.sections.find((s) => s.id === ref) ?? study.sections.find((s) => norm(s.title) === r) ?? study.sections.find((s) => norm(s.title).startsWith(r));
}
function findQuestion(sec: QualGuideSection, ref: string): QualGuideQuestion | undefined {
  const r = norm(ref);
  return sec.questions.find((q) => q.id === ref) ?? sec.questions.find((q) => norm(q.text) === r) ?? sec.questions.find((q) => norm(q.text).startsWith(r));
}
const allQuestionIds = (study: QualStudy) => study.sections.flatMap((s) => s.questions.map((q) => q.id));
function newQuestion(study: QualStudy, sec: QualGuideSection, q: QualQuestionInput): QualGuideQuestion {
  const id = nextId(allQuestionIds(study), `${sec.id}q`);
  return { id, text: q.text!, probes: [...(q.probes ?? []), ...(q.addProbes ?? [])], conditionalProbes: [...(q.conditionalProbes ?? []), ...(q.addConditionalProbes ?? [])], ...(q.moderatorNote ? { moderatorNote: q.moderatorNote } : {}), ...(typeof q.minutes === "number" ? { minutes: q.minutes } : {}) };
}
function newSection(study: QualStudy, s: QualSectionInput): QualGuideSection {
  const sec: QualGuideSection = { id: nextId(study.sections.map((x) => x.id), "s"), title: s.title!, kind: (s.kind as QualGuideSection["kind"]) ?? "main", instructions: [...(s.instructions ?? []), ...(s.addInstructions ?? [])], questions: [], stimuli: s.stimuli ?? [], ...(typeof s.minutes === "number" ? { minutes: s.minutes } : {}), ...(s.purpose ? { purpose: s.purpose } : {}), ...(s.script ? { script: s.script } : {}), ...(s.exercise ? { exercise: { title: s.exercise.title, materials: s.exercise.materials ?? [], ...(s.exercise.instructions ? { instructions: s.exercise.instructions } : {}) } } : {}) };
  study.sections.push(sec);
  for (const q of [...(s.questions ?? []), ...(s.addQuestions ?? [])]) sec.questions.push(newQuestion(study, sec, q));
  return sec;
}
function patchQuestion(q: QualGuideQuestion, p: QualQuestionInput): void {
  if (p.text) q.text = p.text;
  if (p.probes) q.probes = [...p.probes];
  if (p.addProbes) q.probes.push(...p.addProbes.filter((x) => !q.probes.some((y) => norm(y) === norm(x))));
  if (p.removeProbes) q.probes = q.probes.filter((x) => !p.removeProbes!.some((r) => norm(r) === norm(x)));
  if (p.conditionalProbes) q.conditionalProbes = [...p.conditionalProbes];
  if (p.addConditionalProbes) q.conditionalProbes.push(...p.addConditionalProbes);
  if (p.moderatorNote === null) delete q.moderatorNote; else if (p.moderatorNote) q.moderatorNote = p.moderatorNote;
  if (p.minutes === null) delete q.minutes; else if (typeof p.minutes === "number") q.minutes = p.minutes;
}
function patchSection(study: QualStudy, sec: QualGuideSection, p: QualSectionInput, changes: string[]): void {
  if (p.target && p.title) { sec.title = p.title; changes.push(`renamed to “${p.title}”`); }
  if (p.kind) sec.kind = p.kind as QualGuideSection["kind"];
  if (p.minutes === null) delete sec.minutes; else if (typeof p.minutes === "number") { sec.minutes = p.minutes; changes.push(`${p.minutes} min`); }
  for (const k of ["purpose", "script"] as const) { const v = p[k]; if (v === null) delete sec[k]; else if (v) { sec[k] = v; changes.push(k); } }
  if (p.instructions) { sec.instructions = [...p.instructions]; changes.push("instructions"); }
  if (p.addInstructions) { sec.instructions.push(...p.addInstructions); changes.push(`+${p.addInstructions.length} instruction${p.addInstructions.length === 1 ? "" : "s"}`); }
  if (p.questions) { sec.questions = []; for (const q of p.questions) sec.questions.push(newQuestion(study, sec, q)); changes.push(`${p.questions.length} questions (replaced)`); }
  for (const r of p.removeQuestions ?? []) { const q = findQuestion(sec, r) ?? fail(`“${sec.title}” has no question “${r}”`); sec.questions = sec.questions.filter((x) => x !== q); changes.push(`removed “${q.text.slice(0, 40)}”`); }
  for (const u of p.updateQuestions ?? []) { const q = findQuestion(sec, u.target!) ?? fail(`“${sec.title}” has no question “${u.target}”`); patchQuestion(q, u); changes.push(`edited “${q.text.slice(0, 40)}”`); }
  for (const a of p.addQuestions ?? []) { sec.questions.push(newQuestion(study, sec, a)); changes.push(`+“${a.text!.slice(0, 40)}”`); }
  if (p.exercise === null) { delete sec.exercise; changes.push("exercise removed"); } else if (p.exercise) { sec.exercise = { title: p.exercise.title, materials: p.exercise.materials ?? [], ...(p.exercise.instructions ? { instructions: p.exercise.instructions } : {}) }; changes.push(`exercise “${p.exercise.title}”`); }
  if (p.stimuli) { sec.stimuli = [...p.stimuli]; changes.push("stimuli"); }
}
const segment = (study: QualStudy, s: { name: string; description?: string; target?: number }): QualParticipantSegment => ({ id: nextId(study.segments.map((x) => x.id), "seg"), name: s.name, ...(s.description ? { description: s.description } : {}), ...(typeof s.target === "number" ? { target: s.target } : {}) });

function setTop(study: QualStudy, a: QualGuideFields, changes: string[]): void {
  if (a.kind && a.kind !== study.kind) { study.kind = a.kind; changes.push(a.kind === "focus_group" ? "now a focus-group study" : "now an interview study"); }
  for (const k of ["title", "protocol"] as const) { const v = a[k]; if (v === null) { delete study[k]; changes.push(`${k} cleared`); } else if (v) { study[k] = v; changes.push(k); } }
  if (a.durationMinutes === null) delete study.durationMinutes; else if (typeof a.durationMinutes === "number") { study.durationMinutes = a.durationMinutes; changes.push(`${a.durationMinutes} minutes`); }
  if (a.objectives) { study.objectives = [...a.objectives]; changes.push(`${a.objectives.length} objective${a.objectives.length === 1 ? "" : "s"}`); }
  if (a.groundRules) { study.groundRules = [...a.groundRules]; changes.push("ground rules"); }
  if (a.screening) { study.screening = a.screening.map((x) => ({ ...x })); changes.push("screening"); }
  if (a.segments) { study.segments = []; for (const s of a.segments) study.segments.push(segment(study, s)); changes.push(`${a.segments.length} segment${a.segments.length === 1 ? "" : "s"}`); }
  if (a.consent) { const c = study.consent as Record<string, string | undefined>; for (const [k, v] of Object.entries(a.consent)) { if (v === null) delete c[k]; else if (v) c[k] = v; } changes.push("consent"); }
  if (a.sessionPlan) { const s = study.sessionPlan as Record<string, unknown>; for (const [k, v] of Object.entries(a.sessionPlan)) { if (v === null) delete s[k]; else if (v !== undefined) s[k] = v; } changes.push("session plan"); }
}

export function applyQualAction(def: SurveyDefinition, a: QualAction, env: QualEnv = {}): QualApplied {
  const changes: string[] = [];
  let destructive: string | undefined;
  let study: QualStudy;
  if (a.op === "create_qual_guide") {
    if (def.qualStudy && !a.replace) fail(`this survey already has ${def.qualStudy.kind === "focus_group" ? "a focus-group discussion" : "an interview"} guide — change it with update_qual_guide (only what you name changes), or create with "replace": true to start again`);
    if (def.qualStudy) destructive = `Replaces the existing ${def.qualStudy.kind === "focus_group" ? "discussion" : "interview"} guide (${def.qualStudy.sections.length} sections)`;
    study = QualStudySchema.parse({ kind: a.kind });
    const { sections, ...top } = a;
    setTop(study, top, []);
    for (const s of sections ?? []) newSection(study, s);
  } else {
    if (!def.qualStudy) fail("there is no interview or focus-group guide yet — create one with create_qual_guide");
    study = JSON.parse(JSON.stringify(def.qualStudy)) as QualStudy;
    const { sections, ...top } = a;
    setTop(study, top, changes);
    for (const o of a.addObjectives ?? []) if (!study.objectives.some((x) => norm(x) === norm(o))) { study.objectives.push(o); changes.push(`+objective “${o.slice(0, 40)}”`); }
    for (const o of a.removeObjectives ?? []) { const before = study.objectives.length; study.objectives = study.objectives.filter((x) => norm(x) !== norm(o)); if (before === study.objectives.length) fail(`there is no objective “${o}”`); changes.push(`−objective “${o.slice(0, 40)}”`); }
    for (const g of a.addGroundRules ?? []) { study.groundRules.push(g); changes.push("+ground rule"); }
    for (const g of a.removeGroundRules ?? []) { study.groundRules = study.groundRules.filter((x) => norm(x) !== norm(g)); changes.push("−ground rule"); }
    for (const s of a.addScreening ?? []) { study.screening.push({ ...s }); changes.push(`+screening “${s.criterion.slice(0, 40)}”`); }
    for (const s of a.removeScreening ?? []) { const before = study.screening.length; study.screening = study.screening.filter((x) => norm(x.criterion) !== norm(s)); if (before === study.screening.length) fail(`there is no screening criterion “${s}”`); changes.push("−screening criterion"); }
    for (const s of a.addSegments ?? []) { study.segments.push(segment(study, s)); changes.push(`+segment “${s.name}”`); }
    for (const s of a.removeSegments ?? []) { const before = study.segments.length; study.segments = study.segments.filter((x) => x.id !== s && norm(x.name) !== norm(s)); if (before === study.segments.length) fail(`there is no segment “${s}”`); changes.push(`−segment “${s}”`); }
    for (const p of sections ?? []) {
      const sec = findSection(study, p.target ?? p.title!) ?? fail(`there is no section “${p.target ?? p.title}” — add it with addSections`);
      const sub: string[] = [];
      patchSection(study, sec, p.target ? p : { ...p, title: undefined }, sub);
      changes.push(`“${sec.title}”: ${sub.join(", ") || "unchanged"}`);
    }
    for (const s of a.addSections ?? []) {
      const sec = newSection(study, s);
      if (s.after) {
        const anchor = findSection(study, s.after) ?? fail(`there is no section “${s.after}” to put “${s.title}” after`);
        study.sections = study.sections.filter((x) => x !== sec);
        study.sections.splice(study.sections.indexOf(anchor) + 1, 0, sec);
      } else {
        /* a new topic goes before the closing section, not after it */
        const close = study.sections.findIndex((x) => x.kind === "closing" && x !== sec);
        if (close >= 0 && sec.kind !== "closing") { study.sections = study.sections.filter((x) => x !== sec); study.sections.splice(close, 0, sec); }
      }
      changes.push(`+section “${sec.title}” (${sec.questions.length} question${sec.questions.length === 1 ? "" : "s"})`);
    }
    const removed: string[] = [];
    for (const r of a.removeSections ?? []) { const sec = findSection(study, r) ?? fail(`there is no section “${r}”`); study.sections = study.sections.filter((x) => x !== sec); removed.push(sec.title); changes.push(`−section “${sec.title}”`); }
    if (removed.length) destructive = `Removes ${removed.map((t) => `“${t}”`).join(", ")} from the guide`;
  }
  if (env.now) study.updatedAt = env.now;
  const parsed = QualStudySchema.safeParse(study);
  if (!parsed.success) fail(`the guide is not valid: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message ?? ""}`);
  def.qualStudy = parsed.data!;
  const s = def.qualStudy;
  const nQ = s.sections.reduce((n, x) => n + x.questions.length, 0);
  const planned = guideMinutes(s);
  const what = s.kind === "focus_group" ? "focus-group discussion guide" : "interview guide";
  const description = a.op === "create_qual_guide"
    ? `${a.replace ? "Replace" : "Create"} the ${what}: ${s.sections.length} sections, ${nQ} questions${planned ? `, ${planned} minutes timed` : ""}${s.durationMinutes ? ` of ${s.durationMinutes}` : ""}`
    : `Update the ${what}: ${changes.join("; ") || "no change"}`;
  return { description, ...(destructive ? { destructive } : {}), warnings: lintQualStudy(s), touched: [] };
}

/** the minutes the sections are timed for (a section's own minutes, else its questions') */
export function guideMinutes(s: QualStudy): number {
  return s.sections.reduce((n, x) => n + (x.minutes ?? x.questions.reduce((m, q) => m + (q.minutes ?? 0), 0)), 0);
}

/**
 * What a methodologist would say about the guide before it goes to a moderator — warnings, never
 * refusals: timing that does not add up, no opening or closing, a focus group with no ground rules,
 * no recording disclosure, a section with nothing in it, a leading question.
 */
export function lintQualStudy(s: QualStudy): string[] {
  const out: string[] = [];
  const what = s.kind === "focus_group" ? "discussion guide" : "interview guide";
  if (!s.objectives.length) out.push(`The ${what} records no objectives — each section should serve one.`);
  if (!s.sections.some((x) => x.kind === "opening")) out.push(`The ${what} has no opening section (introductions, purpose, consent and recording reminder).`);
  if (!s.sections.some((x) => x.kind === "closing")) out.push(`The ${what} has no closing section (summary, anything to add, thanks).`);
  const planned = guideMinutes(s);
  if (s.durationMinutes && planned > s.durationMinutes * 1.1) out.push(`The sections are timed for ${planned} minutes but the session is ${s.durationMinutes} — cut or shorten a section.`);
  if (s.durationMinutes && planned && planned < s.durationMinutes * 0.6) out.push(`Only ${planned} of the ${s.durationMinutes} minutes are timed — time the remaining sections.`);
  if (s.kind === "focus_group" && !s.groundRules.length) out.push("A focus group has no ground rules (one person at a time, no right or wrong answers, confidentiality, phones away).");
  if (!s.consent.recordingDisclosure) out.push("No recording disclosure: say what is recorded, who will see it and how long it is kept, before the session starts.");
  for (const x of s.sections) if (!x.questions.length && !x.exercise && !x.script && !x.stimuli.length) out.push(`“${x.title}” has no questions, script, exercise or stimuli.`);
  for (const x of s.sections) for (const q of x.questions) if (/\b(?:don't you (?:think|agree)|wouldn't you|isn't it true|surely|how (?:much|great) (?:do you love|is))\b/i.test(q.text)) out.push(`“${q.text.slice(0, 60)}” leads the participant — ask it neutrally.`);
  const seen = new Map<string, string>();
  for (const x of s.sections) for (const q of x.questions) { const k = norm(q.text); if (seen.has(k)) out.push(`“${q.text.slice(0, 60)}” is asked twice (${seen.get(k)} and ${x.title}).`); else seen.set(k, x.title); }
  return out;
}

export function describeQualAction(a: QualAction): string {
  if (a.op === "create_qual_guide") return `${a.replace ? "Replace" : "Create"} the ${a.kind === "focus_group" ? "focus-group discussion" : "interview"} guide (${a.sections?.length ?? 0} sections)`;
  const named = Object.keys(a).filter((k) => k !== "op");
  return `Update the qualitative guide (${named.join(", ")})`;
}

/** the review lines for a proposal that changes the qualitative guide (`diffSurveys`) */
export function qualGuideDiff(before: SurveyDefinition, after: SurveyDefinition): string[] {
  const a = before.qualStudy, b = after.qualStudy;
  const strip = (s: QualStudy | undefined) => (s ? JSON.stringify({ ...s, updatedAt: undefined }) : null);
  if (strip(a) === strip(b)) return [];
  const what = (s: QualStudy) => (s.kind === "focus_group" ? "focus-group discussion guide" : "interview guide");
  if (!a && b) return [`Create the ${what(b)}: ${b.sections.length} sections, ${b.sections.reduce((n, x) => n + x.questions.length, 0)} questions`];
  if (a && !b) return [`Remove the ${what(a)}`];
  const out: string[] = [];
  const ids = new Set(a!.sections.map((s) => s.id));
  const added = b!.sections.filter((s) => !ids.has(s.id)), removed = a!.sections.filter((s) => !b!.sections.some((x) => x.id === s.id));
  if (added.length) out.push(`Add guide section${added.length === 1 ? "" : "s"} ${added.map((s) => `“${s.title}”`).join(", ")}`);
  if (removed.length) out.push(`Remove guide section${removed.length === 1 ? "" : "s"} ${removed.map((s) => `“${s.title}”`).join(", ")}`);
  const changed = b!.sections.filter((s) => ids.has(s.id) && JSON.stringify(s) !== JSON.stringify(a!.sections.find((x) => x.id === s.id)));
  if (changed.length) out.push(`Change guide section${changed.length === 1 ? "" : "s"} ${changed.map((s) => `“${s.title}”`).join(", ")}`);
  const top = (["kind", "title", "objectives", "protocol", "durationMinutes", "groundRules", "screening", "consent", "segments", "sessionPlan"] as const).filter((k) => JSON.stringify(a![k]) !== JSON.stringify(b![k]));
  if (top.length) out.push(`Change the ${what(b!)}'s ${top.join(", ")}`);
  /* 2026-10-22: the guide run as AI-moderated interviews (aiInterviewActions.ts) */
  if (JSON.stringify(a!.aiModeration) !== JSON.stringify(b!.aiModeration)) out.push(b!.aiModeration ? `${a!.aiModeration ? "Change" : "Set up"} AI-moderated interviews for the ${what(b!)}` : "Remove the AI-moderated interview settings");
  return out;
}

/** the guide's sections added, removed and changed by id — what the proposal's structure view marks */
export function qualSectionChanges(before: SurveyDefinition, after: SurveyDefinition): { added: string[]; removed: string[]; changed: string[] } {
  const b = new Map((before.qualStudy?.sections ?? []).map((s) => [s.id, JSON.stringify(s)]));
  const a = new Map((after.qualStudy?.sections ?? []).map((s) => [s.id, JSON.stringify(s)]));
  return { added: [...a.keys()].filter((id) => !b.has(id)), removed: [...b.keys()].filter((id) => !a.has(id)), changed: [...a.keys()].filter((id) => b.has(id) && b.get(id) !== a.get(id)) };
}
