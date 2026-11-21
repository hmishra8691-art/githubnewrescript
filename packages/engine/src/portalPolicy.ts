import type { PortalSettings, Question, SurveyDefinition } from "@rescript/schema";
import { isAssessment } from "./assessment.js";
import { enforcePortalTemplate } from "./portalTemplates.js";
import { htmlToText } from "./validate.js";

/**
 * WHAT A SIGNED-IN RESPONDENT MAY SEE AND CHANGE (Respondent Intelligence Engine, phase 1, 2026-11-20).
 *
 * One function per decision, pure, used by the portal's server routes and by the Studio (so the researcher's
 * settings screen says exactly what the portal will do). Every default is the careful one: without a permission
 * the answer is "no", with the reason in the respondent's words.
 *
 * Editing rules, in order (the first that refuses wins):
 *
 *   1. the survey has a portal, and the interview was COMPLETED (a screen-out or a half-finished interview has
 *      nothing to edit — the second is resumed in the survey itself);
 *   2. a scored test is never edited after submission: the results show the answer key;
 *   3. the researcher locked this respondent's assessment  →  no, unless they reopened it until a time;
 *   4. the survey's editing mode: none / until a deadline / a window after submission / until the researcher locks
 *      everyone — a reopening by the researcher overrides the mode, never the question locks below;
 *   5. the question is not locked itself, nor inside a locked section, and is on the "only these" list when one
 *      is set; calculated and hidden questions are never editable.
 */
export function portalSettings(def: Pick<SurveyDefinition, "portal">): PortalSettings | null {
  /* phase 4: a template's fixed rules are applied HERE, where every reader of the settings passes */
  return def.portal?.enabled ? enforcePortalTemplate(def.portal) : null;
}

/** question id → the ids of the page, block and sections that contain it (innermost first) */
export function questionContainers(def: Pick<SurveyDefinition, "flow">): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (nodes: unknown, path: string[]) => {
    if (!Array.isArray(nodes)) return;
    for (const raw of nodes) {
      const n = raw as { id?: string; questionIds?: unknown; children?: unknown; questionId?: unknown };
      const here = typeof n?.id === "string" ? [n.id, ...path] : path;
      if (Array.isArray(n?.questionIds)) for (const q of n.questionIds) if (typeof q === "string" && !out.has(q)) out.set(q, here);
      if (typeof n?.questionId === "string" && !out.has(n.questionId)) out.set(n.questionId, here);
      if (n?.children) walk(n.children, here);
    }
  };
  walk(def.flow, []);
  return out;
}

export interface PortalResponseFacts {
  status: string;
  completedAt: string | null;
}
export interface PortalEnrolmentFacts {
  /** the researcher locked this respondent's assessment */
  lockedAt: string | null;
  /** the researcher reopened it for editing until this time */
  reopenedUntil: string | null;
}

export type EditRefusal = "no_portal" | "not_completed" | "scored_test" | "locked_by_researcher" | "editing_off" | "deadline_passed" | "window_passed" | "locked_for_all" | "question_locked" | "section_locked" | "not_editable" | "unknown_question";
export type EditDecision =
  | { allowed: true; until: string | null; reopened: boolean }
  | { allowed: false; code: EditRefusal; reason: string };

const no = (code: EditRefusal, reason: string): EditDecision => ({ allowed: false, code, reason });

/** may the respondent still change ANY answer of this completed interview — the time and lock rules, before any one question */
export function editWindow(def: SurveyDefinition, response: PortalResponseFacts, enrolment: PortalEnrolmentFacts, now: number): EditDecision {
  const portal = portalSettings(def);
  if (!portal) return no("no_portal", "Answers cannot be changed after they are submitted.");
  if (response.status !== "complete") return no("not_completed", response.status === "in_progress" ? "This assessment is not finished yet. Continue it to change your answers." : "This assessment was not completed, so there are no answers to change.");
  if (isAssessment(def)) return no("scored_test", "Answers to a scored test are final once it is submitted.");

  const reopened = !!enrolment.reopenedUntil && Date.parse(enrolment.reopenedUntil) > now;
  if (reopened) return { allowed: true, until: enrolment.reopenedUntil, reopened: true };
  if (enrolment.lockedAt) return no("locked_by_researcher", "Your answers have been locked by the organiser.");

  const e = portal.editing;
  if (e.mode === "none") return no("editing_off", "Answers cannot be changed after they are submitted.");
  if (e.mode === "until_deadline") {
    if (!e.deadline || Date.parse(e.deadline) <= now) return no("deadline_passed", "The time for changing answers has ended.");
    return { allowed: true, until: e.deadline, reopened: false };
  }
  if (e.mode === "window") {
    const until = response.completedAt && e.windowHours ? Date.parse(response.completedAt) + e.windowHours * 3_600_000 : 0;
    if (until <= now) return no("window_passed", "The time for changing answers has ended.");
    return { allowed: true, until: new Date(until).toISOString(), reopened: false };
  }
  /* until_locked */
  if (e.lockedAt && Date.parse(e.lockedAt) <= now) return no("locked_for_all", "Answers have been locked by the organiser.");
  return { allowed: true, until: null, reopened: false };
}

const NEVER_EDITABLE = new Set(["calculated", "hidden", "embedded", "descriptive", "text_display", "instruction"]);

/** may THIS answer be changed now */
export function editDecision(def: SurveyDefinition, questionId: string, response: PortalResponseFacts, enrolment: PortalEnrolmentFacts, now: number, containers = questionContainers(def)): EditDecision {
  const window = editWindow(def, response, enrolment, now);
  if (!window.allowed) return window;
  const q = def.questions.find((x) => x.id === questionId);
  if (!q) return no("unknown_question", "That question is not part of this assessment.");
  const s = (q.settings ?? {}) as { hidden?: boolean; readOnly?: boolean };
  if (NEVER_EDITABLE.has(q.type) || s.hidden || s.readOnly) return no("not_editable", "This answer cannot be changed.");
  const e = portalSettings(def)!.editing;
  if (e.lockedQuestions.includes(questionId)) return no("question_locked", "This answer has been locked by the organiser.");
  const inside = containers.get(questionId) ?? [];
  if (inside.some((id) => e.lockedSections.includes(id))) return no("section_locked", "This section has been locked by the organiser.");
  if (e.onlyQuestions && !e.onlyQuestions.includes(questionId)) return no("question_locked", "This answer cannot be changed.");
  return window;
}

/* ------------------------------------------------------------------ showing answers back */

/** how the portal offers to change an answer; null = this kind of answer cannot be changed in the portal yet */
export type PortalEditInput =
  | { kind: "single"; options: { code: string | number; label: string }[]; value: string | number | null }
  | { kind: "multi"; options: { code: string | number; label: string }[]; value: (string | number)[] }
  | { kind: "text"; long: boolean; value: string }
  | { kind: "number"; value: number | null };

export interface PortalAnswerLine { questionId: string; code: string; text: string; answer: string; answered: boolean; edit: EditDecision; input: PortalEditInput | null }

const SINGLE = new Set(["single_select", "dropdown"]);
const TEXT = new Set(["open_text", "text", "long_text", "short_text"]);

/**
 * The control for the simple answer kinds: one choice, several choices, text, a number. Everything else (grids,
 * rankings, uploads, recordings …) is shown but not changed here; the server would still check any value by the
 * survey's own rules. Only plain stored values are offered — an answer with an "other, specify" companion is not.
 */
export function portalEditInput(q: Question, value: unknown): PortalEditInput | null {
  const options = (q.options ?? []).map((o) => ({ code: o.code, label: htmlToText(String(o.label ?? o.code)) }));
  if (SINGLE.has(q.type) && options.length && (value == null || typeof value === "string" || typeof value === "number")) return { kind: "single", options, value: (value as string | number | null) ?? null };
  if (q.type === "multi_select" && options.length && (value == null || (Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number")))) return { kind: "multi", options, value: (value as (string | number)[] | null) ?? [] };
  if (TEXT.has(q.type) && (value == null || typeof value === "string")) return { kind: "text", long: q.type !== "short_text", value: (value as string | null) ?? "" };
  if ((q.type === "numeric" || q.type === "number") && (value == null || typeof value === "number")) return { kind: "number", value: (value as number | null) ?? null };
  return null;
}

const short = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** a stored answer as words: option labels for codes, rows for grids — never raw JSON */
export function answerAsText(q: Question, value: unknown): string {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return "";
  const optionLabel = new Map((q.options ?? []).map((o) => [String(o.code), htmlToText(String(o.label ?? o.code))]));
  const columnLabel = new Map(((q as unknown as { columns?: { code?: string | number; id?: string; label?: string }[] }).columns ?? []).filter((c) => c.code !== undefined || c.id !== undefined).map((c) => [String(c.code ?? c.id), htmlToText(String(c.label ?? c.code ?? c.id))]));
  const rowLabel = new Map(((q as unknown as { rows?: { code: string | number; label?: string }[] }).rows ?? []).map((r) => [String(r.code), htmlToText(String(r.label ?? r.code))]));
  const one = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (typeof v === "string" || typeof v === "number") return optionLabel.get(String(v)) ?? columnLabel.get(String(v)) ?? String(v);
    if (Array.isArray(v)) return v.map(one).filter(Boolean).join(", ");
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      /* a recorded or uploaded answer is described, not dumped */
      if ("mediaId" in o || "path" in o || "url" in o) return typeof o.transcript === "string" && o.transcript ? o.transcript : typeof (o.transcript as { text?: unknown })?.text === "string" ? String((o.transcript as { text: string }).text) : "A file or recording was provided.";
      return Object.entries(o).map(([k, x]) => { const t = one(x); return t ? `${rowLabel.get(k) ?? optionLabel.get(k) ?? k}: ${t}` : ""; }).filter(Boolean).join("; ");
    }
    return "";
  };
  return short(one(value).trim());
}

/**
 * The respondent's own answers, in questionnaire order, each with whether it may still be changed. Only questions
 * they answered are listed. Hidden and calculated questions never appear.
 */
export function portalAnswerLines(def: SurveyDefinition, answers: Record<string, unknown>, response: PortalResponseFacts, enrolment: PortalEnrolmentFacts, now: number): PortalAnswerLine[] {
  const containers = questionContainers(def);
  const out: PortalAnswerLine[] = [];
  for (const q of def.questions) {
    const s = (q.settings ?? {}) as { hidden?: boolean };
    if (NEVER_EDITABLE.has(q.type) || s.hidden) continue;
    const answer = answerAsText(q, answers[q.id]);
    if (!answer) continue;
    const edit = editDecision(def, q.id, response, enrolment, now, containers);
    out.push({ questionId: q.id, code: q.code, text: short(htmlToText(q.text ?? ""), 400), answer, answered: true, edit, input: edit.allowed ? portalEditInput(q, answers[q.id]) : null });
  }
  return out;
}
