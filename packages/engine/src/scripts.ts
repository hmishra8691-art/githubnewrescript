import type { SurveyDefinition, CustomScript } from "@rescript/schema";
import type { ResponseState, LoopContext } from "./state.js";
import { flattenVariables } from "./flatten.js";
import { evaluateExpression } from "./calc.js";
import { resolvePiping } from "./piping.js";
import { answerKey, findLoopScope, getQuestionByCodeOrVar, lookupAnswer, loopValue } from "./state.js";
import { loopContexts, loopNodes } from "./loops.js";

/**
 * Custom script host (requirement §13).
 *
 * Scripts receive a controlled `ctx` API — they never touch the database,
 * network, or globals directly. On the server they are additionally executed
 * inside `node:vm` with a frozen sandbox; in the browser they run as a
 * plain Function scoped to the ctx object only.
 */

export interface ScriptCtx {
  /** read an answer by question id / code / variable name */
  get(ref: string): unknown;
  /** set an answer (e.g. populate a hidden variable) */
  set(ref: string, value: unknown): void;
  /** read/write calculated variables */
  getCalc(name: string): unknown;
  setCalc(name: string, value: unknown): void;
  /** embedded data */
  getEmbedded(name: string): unknown;
  setEmbedded(name: string, value: string | number | null): void;
  /** evaluate a calc-DSL expression */
  expr(expression: string): unknown;
  /** resolve piping tokens in a string */
  pipe(text: string): string;
  /** raise a flag on the session */
  flag(name: string): void;
  /** current loop context, when inside a loop (innermost, with `parent` for nesting) */
  loop: LoopContext | null;
  /*
   * THE LOOP ACCESSORS (§31). Reference names are whatever the loop declared —
   * nothing here knows or cares what the columns are called.
   *
   *   getCurrentLoopItem()             { code, label, index, count, references } or null
   *   getCurrentLoopIndex()            1-based, 0 outside a loop
   *   getLoopCount()                   iterations this loop is running, 0 outside a loop
   *   getCurrentLoopReference(name)    the item's value for that column, null if none
   *   getLoopItems()                   every iteration of the current loop, in order
   *   getLoopAnswer(ref, code)         another iteration's answer to a question
   *
   * Each takes an optional trailing `scope` — a loopVar — to address an OUTER
   * loop when loops nest (§32): getCurrentLoopReference("Region", "brand").
   */
  getCurrentLoopItem(scope?: string): LoopItemView | null;
  getCurrentLoopIndex(scope?: string): number;
  getLoopCount(scope?: string): number;
  getCurrentLoopReference(name: string, scope?: string): unknown;
  getLoopItems(scope?: string): LoopItemView[];
  getLoopAnswer(ref: string, itemCode: string, scope?: string): unknown;
  /** console-style log captured by the inspector */
  log(...args: unknown[]): void;
  /** register a validation error (on_validate scripts) */
  error(message: string, questionRef?: string): void;
}

/** What a script sees of one iteration — a plain object, never the live context. */
export interface LoopItemView {
  code: string;
  label: string;
  index: number;
  count: number;
  references: Record<string, unknown>;
}

export interface ScriptRunResult {
  logs: string[];
  errors: { message: string; questionRef?: string }[];
  failed?: string;
}

export function createScriptCtx(
  def: SurveyDefinition,
  state: ResponseState,
  loop: LoopContext | null,
  result: ScriptRunResult,
): ScriptCtx {
  const refToId = (ref: string) => getQuestionByCodeOrVar(def, ref)?.id ?? ref;
  const viewOf = (l: LoopContext): LoopItemView => ({
    code: l.code, label: l.label, index: l.index, count: l.count ?? 0, references: { ...(l.references ?? {}) },
  });
  return {
    get(ref) {
      return lookupAnswer(state.answers, refToId(ref), loop) ?? null;
    },
    set(ref, value) {
      state.answers[answerKey(refToId(ref), loop)] = value as any;
    },
    getCalc: (name) => state.calculated[name] ?? null,
    setCalc(name, value) {
      state.calculated[name] = value as any;
    },
    getEmbedded: (name) => state.embedded[name] ?? null,
    setEmbedded(name, value) {
      state.embedded[name] = value;
    },
    expr(expression) {
      const flat = flattenVariables(def, state);
      return evaluateExpression(expression, {
        resolver: (n) => flat[n],
        names: () => Object.keys(flat),
      });
    },
    pipe: (text) => resolvePiping(text, { def, state, loop }),
    flag(name) {
      state.flags.push(name);
    },
    loop,
    getCurrentLoopItem(scope) {
      const l = findLoopScope(loop, scope);
      return l ? viewOf(l) : null;
    },
    getCurrentLoopIndex: (scope) => findLoopScope(loop, scope)?.index ?? 0,
    getLoopCount: (scope) => findLoopScope(loop, scope)?.count ?? 0,
    getCurrentLoopReference(name, scope) {
      const l = findLoopScope(loop, scope);
      return l ? loopValue(l, name) : null;
    },
    getLoopItems(scope) {
      /*
       * Re-resolved from the same function the flow uses, with the SAME parent
       * context, so a script sees exactly the iterations the respondent will
       * walk — including ones not reached yet.
       */
      const l = findLoopScope(loop, scope);
      if (!l?.loopId) return [];
      const node = loopNodes(def).find((x) => x.node.id === l.loopId)?.node;
      if (!node) return [];
      return loopContexts(def, state, node, l.parent ?? null).map(viewOf);
    },
    getLoopAnswer(ref, itemCode, scope) {
      /*
       * Another iteration's answer: the key that iteration wrote under. Built
       * from the scoped loop's parent chain plus the given code, so it is
       * right for nested loops too — and it is the only sanctioned way to
       * cross iterations, so the `@` convention stays an engine detail.
       */
      const l = findLoopScope(loop, scope);
      if (!l) return null;
      const target: LoopContext = { ...l, code: itemCode };
      return state.answers[answerKey(refToId(ref), target)] ?? null;
    },
    log(...args) {
      result.logs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
    },
    error(message, questionRef) {
      result.errors.push({ message, questionRef });
    },
  };
}

/** Execute one script body against a ctx. Time-boxed on the server. */
export function runScript(code: string, ctx: ScriptCtx): ScriptRunResult {
  const result: ScriptRunResult = { logs: [], errors: [] };
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "ctx",
      `"use strict";\nconst { get, set, getCalc, setCalc, getEmbedded, setEmbedded, expr, pipe, flag, loop, log, error, `
        + `getCurrentLoopItem, getCurrentLoopIndex, getLoopCount, getCurrentLoopReference, getLoopItems, getLoopAnswer } = ctx;\n${code}`,
    );
    fn(ctx);
  } catch (e) {
    result.failed = e instanceof Error ? e.message : String(e);
  }
  return result;
}

/** Run every enabled script matching scope/event/ref. */
export function runScripts(
  def: SurveyDefinition,
  state: ResponseState,
  event: CustomScript["event"],
  opts?: { scopeRef?: string; loop?: LoopContext | null },
): ScriptRunResult {
  const combined: ScriptRunResult = { logs: [], errors: [] };
  for (const script of def.scripts) {
    if (!script.enabled || script.event !== event) continue;
    if (script.scope !== "survey" && script.ref !== opts?.scopeRef) continue;
    const ctx = createScriptCtx(def, state, opts?.loop ?? null, combined);
    const r = runScript(script.code, ctx);
    combined.logs.push(...r.logs.map((l) => `[${script.name}] ${l}`));
    combined.errors.push(...r.errors);
    if (r.failed) combined.logs.push(`[${script.name}] ERROR: ${r.failed}`);
  }
  return combined;
}
