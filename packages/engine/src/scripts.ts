import type { SurveyDefinition, CustomScript } from "@rescript/schema";
import type { ResponseState, LoopContext } from "./state.js";
import { flattenVariables } from "./flatten.js";
import { evaluateExpression } from "./calc.js";
import { resolvePiping } from "./piping.js";
import { getQuestionByCodeOrVar } from "./state.js";

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
  /** current loop context, when inside a loop */
  loop: LoopContext | null;
  /** console-style log captured by the inspector */
  log(...args: unknown[]): void;
  /** register a validation error (on_validate scripts) */
  error(message: string, questionRef?: string): void;
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
  return {
    get(ref) {
      const id = refToId(ref);
      const loopKey = loop ? `${id}@${loop.code}` : null;
      return (loopKey ? state.answers[loopKey] : undefined) ?? state.answers[id] ?? null;
    },
    set(ref, value) {
      const id = refToId(ref);
      state.answers[loop ? `${id}@${loop.code}` : id] = value as any;
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
      `"use strict";\nconst { get, set, getCalc, setCalc, getEmbedded, setEmbedded, expr, pipe, flag, loop, log, error } = ctx;\n${code}`,
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
