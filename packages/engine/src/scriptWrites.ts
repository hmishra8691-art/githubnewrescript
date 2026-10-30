/**
 * THE ENGINE-CHECKED WRITE CHANNEL FOR SCRIPTS (S1a, audit 2026-10-30 step S1, decisions D2/D3).
 *
 * Owner decision 1 (2026-10-30): the Scripts panel (`def.scripts`) and Custom Component code MOVE INTO the
 * sandboxed frame that already runs UX scripts. This module is the half of that move that lives in the engine:
 * the one function that decides whether a write a script asks for is allowed, and applies it.
 *
 * ## The rule every write follows
 *
 * A script never writes state. It sends a REQUEST (`rs.setAnswer`, `rs.setEmbedded`, `rs.setCalc`, `rs.flag`);
 * the host asks `applyScriptWrite`, exactly as `rs.goToPage` asks the engine's navigation rule. An accepted write
 * goes through the SAME functions a respondent's own input goes through — `setAnswer` (which runs the on_change
 * calculations and tidies "Other, specify" text) and `recomputePunchesAfterChange` — so punches, calculations,
 * validation and the save/replay behave as if the respondent had given the value.
 *
 * ## Scope (what a script may write)
 *
 *   · hidden / calculated / embedded targets (a `hidden`, `embedded_data` or `experiment` question, one set
 *     `settings.hidden`, an embedded field, a calculated variable) — any script, whatever it is attached to;
 *   · a question-scoped script — its OWN question, even while it is on screen;
 *   · a page- or block-scoped script — the questions of its page / block that the respondent is NOT looking at;
 *   · a survey-scoped script — any question the respondent is NOT looking at;
 *   · NEVER a question the respondent is looking at, unless it is the script's own question. The respondent is
 *     the author of what they see: a value changing under their eyes, put there by code they cannot see, is a
 *     silent overwrite of their answer. A script attached to that question is the explicit exception — its
 *     author wrote it for that question, and the change happens where the respondent is looking.
 *
 * Refused outright: a calculated question with an expression and a calculation that recomputes on every change
 * (the engine would overwrite the value at once), a hidden question whose punch rule says `recompute: "always"`
 * (the rule owns it), engine-computed variables (`LOOP_…`, `MASK_…`), and answer shapes the respondent alone
 * can give (choice tasks, points on a stimulus, places, uploads, recorded interviews).
 *
 * ## The value must fit the question's response model
 *
 * options are real codes of the question (as defined, or as the option pipeline resolves them), multi-valued
 * answers are arrays of distinct codes, numbers are finite numbers, grids are keyed by real rows (and cells by
 * real columns), allocations are numbers keyed by real option codes. Sizes are bounded (`SCRIPT_WRITE_LIMITS`).
 *
 * ## Paradata
 *
 * Every accepted write is recorded in `state.scriptWrites` — script id, kind, target, time — NEVER the value
 * (an open end's text must not travel into a log). The save posts it, the server replay reads it
 * (`checkSubmission` reports a value it cannot derive but a script wrote as `script_written`, not a mismatch),
 * and an analyst can tell script-made values from respondent-made ones.
 */
import type { Question, SurveyDefinition } from "@rescript/schema";
import { effectiveResponseModel } from "@rescript/schema";
import type { LoopContext, ResponseState } from "./state.js";
import { answerKey, getQuestion, getQuestionByCodeOrVar, loopKeySuffix } from "./state.js";
import { setAnswer, recomputePunchesAfterChange, runCalculations, punchDerivedQuestions } from "./flow.js";
import { innermostLoopOf, everyLoopContext } from "./loops.js";
import { allEmbeddedFields, coerceEmbedded, embeddedTypeOf } from "./embedded.js";
import { effectiveQuestion } from "./carryforward.js";
import { gridScaleOptions } from "./gridAxes.js";
import type { EvalContext } from "./evaluate.js";

export type ScriptWrite =
  | { kind: "answer"; ref: string; value: unknown; loopKey?: string | null }
  | { kind: "embedded"; name: string; value: unknown }
  | { kind: "calculated"; name: string; value: unknown }
  | { kind: "flag"; name: string };

/** what a script is attached to — a UX behaviour's target, or a logic script's scope */
export type ScriptWriteScope =
  | { kind: "survey" }
  | { kind: "question"; questionId: string }
  | { kind: "page"; pageId: string }
  | { kind: "block"; blockId: string };

export interface ScriptWriteContext {
  /** the script asking (a behaviour id, later a logic script id) — recorded with the write */
  scriptId: string;
  scope: ScriptWriteScope;
  /** the questions the respondent is looking at right now (the page's shown questions) */
  shown: string[];
  /** the iteration the page is shown in */
  loop?: LoopContext | null;
  /** the page's questions, for the same-page punch recompute a respondent change runs */
  pageQuestions?: Question[];
  quotaCounts?: Record<string, Record<string, number>>;
  /** the time to record (tests); default now */
  at?: string;
}

export interface ScriptWriteResult { ok: boolean; reason?: string; /** the answer key / name written */ target?: string }

/** one accepted write, as paradata — never the value */
export interface ScriptWriteRecord { script: string; kind: ScriptWrite["kind"]; target: string; at: string }

export const SCRIPT_WRITE_LIMITS = {
  /** characters of one text value */
  text: 10_000,
  /** items in one list / keys in one object */
  items: 500,
  /** characters of the JSON of one value */
  json: 50_000,
  /** a variable / flag / embedded name */
  name: 64,
  /** paradata records kept per response (the oldest are dropped past this; `scriptWritesDropped` counts them) */
  records: 1000,
  /** distinct calculated variables a script may create */
  newVariables: 100,
  /** flags on a response */
  flags: 200,
} as const;

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ENGINE_COMPUTED = /^(LOOP_|MASK_)/;
/** answers only the respondent can give */
const RESPONDENT_ONLY = new Set(["tasks", "coordinates", "geo", "media", "interview", "none"]);

const refuse = (reason: string): ScriptWriteResult => ({ ok: false, reason });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const finite = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** hidden-like: never drawn for the respondent */
export function isScriptDerivedTarget(q: Question): boolean {
  return effectiveResponseModel(q) === "derived" || !!q.settings?.hidden;
}

/** every question id under a flow node (page, block, loop…), by the node's id */
function questionsUnder(flow: unknown[], nodeId: string): Set<string> | null {
  const walk = (nodes: unknown[], inside: boolean, out: Set<string>): boolean => {
    let found = false;
    for (const n of nodes as { id?: string; questionIds?: string[]; children?: unknown[] }[]) {
      if (!n || typeof n !== "object") continue;
      const here = inside || n.id === nodeId;
      if (here) for (const id of n.questionIds ?? []) out.add(id);
      if (n.id === nodeId) found = true;
      if (Array.isArray(n.children) && walk(n.children, here, out)) found = true;
    }
    return found;
  };
  const out = new Set<string>();
  return walk(flow, false, out) ? out : null;
}

/** the iteration an answer lands in: the page's own, or the one `loopKey` names ("apple", "apple@pro", "@apple") */
function iterationFor(def: SurveyDefinition, state: ResponseState, q: Question, loopKey: string | null | undefined, pageLoop: LoopContext | null): LoopContext | null | string {
  const info = innermostLoopOf(def, q.id);
  if (!info) return loopKey ? `${q.code} is not inside a loop, so it takes no loop key` : null;
  const all = everyLoopContext(def, state, info.node, info.ancestors);
  if (loopKey == null || loopKey === "") {
    if (pageLoop) { const want = loopKeySuffix(pageLoop); const hit = all.find((c) => loopKeySuffix(c) === want || want.startsWith(loopKeySuffix(c) + "@")); if (hit) return hit; }
    return `${q.code} is inside a loop — name the iteration (rs.setAnswer(ref, value, loopKey))`;
  }
  const want = "@" + String(loopKey).replace(/^@/, "");
  // the full path ("@apple@pro"), else the item code within the enclosing iteration the page is in
  const exact = all.find((c) => loopKeySuffix(c) === want);
  if (exact) return exact;
  const pageSuffix = loopKeySuffix(pageLoop);
  const byCode = all.filter((c) => `@${c.code}` === want && (!c.parent || pageSuffix === loopKeySuffix(c.parent) || pageSuffix.startsWith(loopKeySuffix(c.parent) + "@")));
  return byCode.length === 1 ? byCode[0] : `"${loopKey}" is not an iteration of the loop around ${q.code}`;
}

function sizeProblem(v: unknown): string | null {
  let json: string;
  try { json = JSON.stringify(v ?? null); } catch { return "the value cannot be stored (it is not plain data)"; }
  if (json.length > SCRIPT_WRITE_LIMITS.json) return `the value is larger than ${SCRIPT_WRITE_LIMITS.json.toLocaleString("en")} characters`;
  return null;
}

/**
 * The value, checked against the question's response model and normalised to what the renderer itself stores
 * (option codes as the definition spells them). A string is the reason it does not fit.
 */
export function scriptValueFor(def: SurveyDefinition, state: ResponseState, q: Question, value: unknown, loop: LoopContext | null): { value: unknown } | string {
  const model = effectiveResponseModel(q);
  const ctx: EvalContext = { def, state, loop };
  if (RESPONDENT_ONLY.has(model)) return `${q.code} is a ${model === "none" ? "display-only item" : `${model} question`} — only the respondent can answer it`;
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return { value: null }; // clearing an answer is a write too
  const size = sizeProblem(value);
  if (size) return size;
  let eff: ReturnType<typeof effectiveQuestion> | null = null;
  try { eff = effectiveQuestion(q, ctx); } catch { eff = null; }
  const codeMap = (opts: { code: string | number }[]) => { const m = new Map<string, string | number>(); for (const o of opts) m.set(String(o.code), o.code); return m; };
  const options = codeMap([...(q.options ?? []), ...(eff?.options ?? []), ...gridScaleOptions(q)]);
  const rows = codeMap([...(q.rows ?? []), ...(eff?.rows ?? [])]);
  const cols = new Set([...(q.columns ?? []), ...(eff?.columns ?? [])].map((c) => String((c as { id: string }).id)));
  const code = (v: unknown, what = "option"): string | number | string => {
    if (!(typeof v === "string" || typeof v === "number")) return `${JSON.stringify(v)} is not an ${what} code`;
    const hit = options.get(String(v));
    return hit !== undefined ? hit : `"${String(v)}" is not an ${what} code of ${q.code} (${[...options.keys()].slice(0, 12).join(", ")})`;
  };
  const codes = (v: unknown): (string | number)[] | string => {
    if (!Array.isArray(v)) return `${q.code} holds several codes — send an array of codes`;
    if (v.length > SCRIPT_WRITE_LIMITS.items) return `more than ${SCRIPT_WRITE_LIMITS.items} codes`;
    const out: (string | number)[] = [];
    for (const x of v) { const c = code(x); if (typeof c === "string" && !options.has(c)) return c; if (out.some((y) => String(y) === String(c))) return `"${String(x)}" is listed twice`; out.push(c); }
    return out;
  };
  const text = (v: unknown): string | { bad: string } => {
    if (typeof v === "number" || typeof v === "boolean") v = String(v);
    if (typeof v !== "string") return { bad: `${q.code} takes text` };
    if (v.length > SCRIPT_WRITE_LIMITS.text) return { bad: `the text is longer than ${SCRIPT_WRITE_LIMITS.text.toLocaleString("en")} characters` };
    return v;
  };
  const rowKeyed = (v: unknown, each: (x: unknown, row: string) => unknown | { bad: string }): { value: unknown } | string => {
    if (!isObj(v)) return `${q.code} is answered per row — send an object keyed by row code (${[...rows.keys()].slice(0, 12).join(", ")})`;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (!rows.has(k)) return `"${k}" is not a row code of ${q.code} (${[...rows.keys()].slice(0, 12).join(", ")})`;
      if (x === null || x === undefined || x === "") continue;
      const r = each(x, k);
      if (isObj(r) && typeof (r as { bad?: unknown }).bad === "string") return `row ${k}: ${(r as { bad: string }).bad}`;
      out[k] = r;
    }
    return { value: out };
  };
  const asCode = (x: unknown) => { const c = code(x); return typeof c === "string" && !options.has(c) ? { bad: c } : c; };
  const asNumber = (x: unknown) => { const n = finite(x); return n == null ? { bad: `${JSON.stringify(x)} is not a number` } : n; };
  const asText = (x: unknown) => { const t = text(x); return t; };

  switch (model) {
    case "single_choice": { const c = code(value); return typeof c === "string" && !options.has(c) ? c : { value: c }; }
    case "multiple_choice": case "rank_order": { const c = codes(value); return typeof c === "string" ? c : { value: c }; }
    case "numeric": { const n = finite(value); return n == null ? `${JSON.stringify(value)} is not a number` : { value: n }; }
    case "text": { const t = text(value); return typeof t === "string" ? { value: t } : t.bad; }
    case "allocation": {
      if (!isObj(value)) return `${q.code} is an allocation — send an object of numbers keyed by option code`;
      const out: Record<string, number> = {};
      for (const [k, x] of Object.entries(value)) { if (!options.has(k)) return `"${k}" is not an option code of ${q.code}`; const n = finite(x); if (n == null) return `${k}: ${JSON.stringify(x)} is not a number`; out[k] = n; }
      return { value: out };
    }
    case "per_row": {
      const multi = q.type === "matrix_multi" || /multi/.test(String(q.variant ?? ""));
      const each = q.type === "matrix_numeric" ? asNumber : q.type === "matrix_text" ? asText
        : multi ? (x: unknown) => { const c = codes(x); return typeof c === "string" ? { bad: c } : c; } : asCode;
      return rowKeyed(value, each);
    }
    case "cells": return rowKeyed(value, (x) => {
      if (!isObj(x)) return { bad: "send an object keyed by column id" };
      const o: Record<string, unknown> = {};
      for (const [c, y] of Object.entries(x)) { if (!cols.has(c)) return { bad: `"${c}" is not a column of ${q.code}` }; if (!isScalar(y) && !(Array.isArray(y) && y.every(isScalar))) return { bad: `column ${c}: a cell holds a value, not an object` }; o[c] = y; }
      return o;
    });
    case "fields": {
      if (q.type === "repeating_group") {
        if (!Array.isArray(value)) return `${q.code} is a repeating group — send an array of entries`;
        const max = Math.min(q.settings?.maxRepeats ?? 50, 50);
        if (value.length > max) return `more than ${max} entries`;
        const out: unknown[] = [];
        for (const e of value) { const r = rowKeyed(e, (x) => (isScalar(x) ? x : { bad: "a field holds a value" })); if (typeof r === "string") return r; out.push(r.value); }
        return { value: out };
      }
      return rowKeyed(value, (x) => (q.type === "numeric_list" ? asNumber(x) : isScalar(x) ? (typeof x === "string" && x.length > SCRIPT_WRITE_LIMITS.text ? { bad: "too long" } : x) : { bad: "a field holds a value" }));
    }
    case "derived": default: {
      // a hidden variable with a code list takes its codes; one without takes a value
      if (options.size) {
        if (Array.isArray(value)) { const c = codes(value); return typeof c === "string" ? c : { value: c }; }
        const c = code(value); return typeof c === "string" && !options.has(c) ? c : { value: c };
      }
      if (typeof value === "string" && value.length > SCRIPT_WRITE_LIMITS.text) return `the text is longer than ${SCRIPT_WRITE_LIMITS.text.toLocaleString("en")} characters`;
      if (isScalar(value)) return { value };
      if (Array.isArray(value) && value.length <= SCRIPT_WRITE_LIMITS.items && value.every(isScalar)) return { value };
      return `${q.code} holds a single value or a list of values`;
    }
  }
}

/** the questions a scope owns (null: the scope names something that does not exist) */
function ownQuestions(def: SurveyDefinition, scope: ScriptWriteScope): Set<string> | null {
  if (scope.kind === "survey") return new Set();
  if (scope.kind === "question") return getQuestion(def, scope.questionId) ? new Set([scope.questionId]) : null;
  const id = scope.kind === "page" ? scope.pageId.split("@")[0] : scope.blockId;
  return questionsUnder(def.flow as unknown[], id);
}

function record(state: ResponseState, ctx: ScriptWriteContext, kind: ScriptWrite["kind"], target: string) {
  const list = (state.scriptWrites ??= []);
  list.push({ script: String(ctx.scriptId).slice(0, 120), kind, target, at: ctx.at ?? new Date().toISOString() });
  if (list.length > SCRIPT_WRITE_LIMITS.records) {
    const drop = list.length - SCRIPT_WRITE_LIMITS.records;
    list.splice(0, drop);
    state.scriptWritesDropped = (state.scriptWritesDropped ?? 0) + drop;
  }
}

/** after an embedded / calculated write: what a respondent change would recompute downstream */
function settleVariables(def: SurveyDefinition, state: ResponseState, ctx: ScriptWriteContext) {
  runCalculations(def, state, "on_change");
  punchDerivedQuestions(def, state, ctx.quotaCounts ?? {});
}

/**
 * Decide and apply one script write. Never throws: a refusal is `{ ok: false, reason }` (the host logs it to the
 * script's console); nothing in `state` changes unless the write is accepted.
 */
export function applyScriptWrite(def: SurveyDefinition, state: ResponseState, write: ScriptWrite, ctx: ScriptWriteContext): ScriptWriteResult {
  try {
    return applyOne(def, state, write, ctx);
  } catch (e) {
    return refuse(`the write could not be applied: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function checkName(name: unknown, what: string): string | null {
  if (typeof name !== "string" || !name.trim()) return `${what} needs a name`;
  if (name.length > SCRIPT_WRITE_LIMITS.name) return `${what} "${name.slice(0, 20)}…" is longer than ${SCRIPT_WRITE_LIMITS.name} characters`;
  if (!NAME.test(name) || name === "__proto__" || name === "constructor" || name === "prototype") return `"${name}" is not a valid ${what} name (letters, digits, _ . -)`;
  return null;
}

function applyOne(def: SurveyDefinition, state: ResponseState, write: ScriptWrite, ctx: ScriptWriteContext): ScriptWriteResult {
  if (!write || typeof write !== "object") return refuse("not a write");
  const pageLoop = ctx.loop ?? null;
  switch (write.kind) {
    case "answer": {
      const ref = typeof write.ref === "string" ? write.ref.trim() : "";
      if (!ref) return refuse("rs.setAnswer needs a question code");
      const q = getQuestionByCodeOrVar(def, ref);
      if (!q) return refuse(`"${ref}" is not a question of this survey`);
      const derived = isScriptDerivedTarget(q);
      if (q.type === "calculated" && q.settings?.expression) return refuse(`${q.code} is calculated by its expression — a script value would be overwritten at once; change the expression instead`);
      if ((q.punches ?? []).some((p) => (p as { recompute?: string }).recompute === "always")) return refuse(`${q.code} is owned by its punch rule (recompute: always) — change the rule instead`);
      const own = ownQuestions(def, ctx.scope);
      if (!own) return refuse(`the script's ${ctx.scope.kind} no longer exists`);
      const onScreen = ctx.shown.includes(q.id) && !derived;
      if (!derived) {
        if (onScreen && !(ctx.scope.kind === "question" && own.has(q.id))) return refuse(`${q.code} is on screen — a script may change a question the respondent is looking at only when it is attached to that question (no silent overwrites of what the respondent sees)`);
        if ((ctx.scope.kind === "page" || ctx.scope.kind === "block") && !own.has(q.id)) return refuse(`${q.code} is not on this script's ${ctx.scope.kind} — a ${ctx.scope.kind} script writes its own questions and hidden variables`);
        if (ctx.scope.kind === "question" && !own.has(q.id)) return refuse(`${q.code} is not this script's question — a question script writes its own question and hidden variables`);
      }
      const loop = iterationFor(def, state, q, write.loopKey, pageLoop);
      if (typeof loop === "string") return refuse(loop);
      const v = scriptValueFor(def, state, q, write.value, loop);
      if (typeof v === "string") return refuse(v);
      const key = answerKey(q.id, loop);
      // the respondent's own path: setAnswer (on_change calculations, Other text), then the punch cascade
      setAnswer(def, state, q.id, v.value, loop);
      if (v.value === null) delete state.answers[key];
      const sameIteration = loopKeySuffix(loop) === loopKeySuffix(pageLoop);
      const evalCtx: EvalContext = { def, state, loop: pageLoop, quotaCounts: ctx.quotaCounts };
      recomputePunchesAfterChange(def, state, q.id, sameIteration ? (ctx.pageQuestions ?? []) : [], evalCtx, pageLoop);
      record(state, ctx, "answer", key);
      return { ok: true, target: key };
    }
    case "embedded": {
      const bad = checkName(write.name, "embedded field"); if (bad) return refuse(bad);
      const declared = allEmbeddedFields(def).some((f) => f.name === write.name) || (def.embeddedData ?? []).some((e) => e.name === write.name) || Object.prototype.hasOwnProperty.call(state.embedded, write.name);
      if (!declared) return refuse(`"${write.name}" is not an embedded field of this survey (declare it in the flow's Embedded Data element)`);
      if (!isScalar(write.value)) return refuse(`embedded field ${write.name} holds text, a number or true/false`);
      if (typeof write.value === "string" && write.value.length > SCRIPT_WRITE_LIMITS.text) return refuse(`the text is longer than ${SCRIPT_WRITE_LIMITS.text.toLocaleString("en")} characters`);
      const c = coerceEmbedded(embeddedTypeOf(def, write.name), write.value);
      if (c.error) return refuse(`embedded field ${write.name}: ${c.error}`);
      state.embedded[write.name] = c.value;
      settleVariables(def, state, ctx);
      record(state, ctx, "embedded", write.name);
      return { ok: true, target: write.name };
    }
    case "calculated": {
      const bad = checkName(write.name, "variable"); if (bad) return refuse(bad);
      if (ENGINE_COMPUTED.test(write.name)) return refuse(`${write.name} is computed by the engine (loop / masking variable)`);
      if (getQuestionByCodeOrVar(def, write.name)) return refuse(`${write.name} is a question — use rs.setAnswer`);
      if (allEmbeddedFields(def).some((f) => f.name === write.name)) return refuse(`${write.name} is an embedded field — use rs.setEmbedded`);
      const calc = def.calculations.find((c) => c.targetVariable === write.name);
      // a declared calculation recomputes its variable whenever its trigger runs (on_change, on_page_submit, on_complete)
      if (calc) return refuse(`${write.name} is computed by calculation ${calc.id} (${calc.trigger}) — a script value would be overwritten when it runs; change the calculation, or write a variable of the script's own`);
      /*
       * S1b: a list or a record of plain values is accepted too — the Scripts panel always could (the master demo's
       * INVALID_BRANDS, `[{code, label}]`, is the `variable` source of a loop) — within the size limits.
       */
      if (!isScalar(write.value)) {
        if (!Array.isArray(write.value) && !isObj(write.value)) return refuse(`variable ${write.name} holds text, a number, true/false, or a list / record of them`);
        let json = "";
        try { json = JSON.stringify(write.value) ?? ""; } catch { return refuse(`variable ${write.name}: the value cannot be stored`); }
        if (json.length > SCRIPT_WRITE_LIMITS.json) return refuse(`variable ${write.name}: the value is longer than ${SCRIPT_WRITE_LIMITS.json.toLocaleString("en")} characters of JSON`);
        if ((Array.isArray(write.value) ? write.value.length : Object.keys(write.value).length) > SCRIPT_WRITE_LIMITS.items) return refuse(`variable ${write.name}: more than ${SCRIPT_WRITE_LIMITS.items} items`);
      }
      if (typeof write.value === "string" && write.value.length > SCRIPT_WRITE_LIMITS.text) return refuse(`the text is longer than ${SCRIPT_WRITE_LIMITS.text.toLocaleString("en")} characters`);
      const value = write.value as string | number | boolean | null;
      const isNew = !Object.prototype.hasOwnProperty.call(state.calculated, write.name);
      if (isNew) {
        const created = new Set((state.scriptWrites ?? []).filter((r) => r.kind === "calculated").map((r) => r.target));
        if (created.size >= SCRIPT_WRITE_LIMITS.newVariables) return refuse(`a script may create at most ${SCRIPT_WRITE_LIMITS.newVariables} variables`);
      }
      state.calculated[write.name] = value;
      settleVariables(def, state, ctx);
      record(state, ctx, "calculated", write.name);
      return { ok: true, target: write.name };
    }
    case "flag": {
      const bad = checkName(write.name, "flag"); if (bad) return refuse(bad);
      if (!state.flags.includes(write.name)) {
        if (state.flags.length >= SCRIPT_WRITE_LIMITS.flags) return refuse(`a response may carry at most ${SCRIPT_WRITE_LIMITS.flags} flags`);
        state.flags.push(write.name);
      }
      record(state, ctx, "flag", write.name);
      return { ok: true, target: write.name };
    }
    default:
      return refuse(`unknown write kind ${JSON.stringify((write as { kind?: unknown }).kind)}`);
  }
}

/**
 * Could a script EVER have written this answer / variable through this channel? The server replay honours a posted
 * `scriptWrites` claim only for such targets — a claim on a value the channel always refuses (a calculated
 * question's expression, a punch rule that owns its question, a declared calculation, an engine variable) is not
 * believed, so forged paradata cannot shield a tampered derived value.
 */
export function scriptMayWriteAnswer(def: SurveyDefinition, questionId: string): boolean {
  const q = getQuestion(def, questionId);
  if (!q || RESPONDENT_ONLY.has(effectiveResponseModel(q))) return false;
  if (q.type === "calculated" && q.settings?.expression) return false;
  return !(q.punches ?? []).some((p) => (p as { recompute?: string }).recompute === "always");
}
export function scriptMayWriteVariable(def: SurveyDefinition, name: string): boolean {
  return !checkName(name, "variable") && !ENGINE_COMPUTED.test(name) && !def.calculations.some((c) => c.targetVariable === name) && !getQuestionByCodeOrVar(def, name);
}

/** a posted `scriptWrites` list, checked: shape, size, names — what the save route may store and the replay read */
export function sanitizeScriptWrites(raw: unknown): ScriptWriteRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: ScriptWriteRecord[] = [];
  for (const r of raw.slice(-SCRIPT_WRITE_LIMITS.records)) {
    if (!isObj(r)) continue;
    const kind = r.kind;
    if (kind !== "answer" && kind !== "embedded" && kind !== "calculated" && kind !== "flag") continue;
    if (typeof r.target !== "string" || !r.target || r.target.length > 200) continue;
    out.push({ script: typeof r.script === "string" ? r.script.slice(0, 120) : "", kind, target: r.target, at: typeof r.at === "string" ? r.at.slice(0, 40) : "" });
  }
  return out;
}
