import type { SurveyDefinition, CustomScript } from "@rescript/schema";
import type { ResponseState, LoopContext } from "./state.js";
import { flattenVariables } from "./flatten.js";
import { evaluateExpression } from "./calc.js";
import { evaluateCondition } from "./evaluate.js";
import { resolvePiping } from "./piping.js";
import { answerKey, findLoopScope, getQuestionByCodeOrVar, lookupAnswer, loopDepth, loopValue } from "./state.js";
import { loopContexts, loopNodes } from "./loops.js";
import { elementIndex, type ElementRef } from "./elementIds.js";
import { codeGate, gateReason, LOGIC_PARAMS, logicScriptBody, loopCounter } from "./codeGate.js";

/**
 * Custom script host (requirement §13).
 *
 * Scripts receive a controlled `ctx` API and reach the survey only through it.
 * They run as a Function whose parameter list SHADOWS the globals a script has
 * no business touching — `window`, `document`, `fetch`, `XMLHttpRequest`,
 * `globalThis`, `process`, `require`, `eval`, `Function`, the timers and the
 * storage APIs are all bound to `undefined` inside the body, so reaching for
 * one gets nothing rather than the real thing.
 *
 * BEFORE IT RUNS, THE CODE GATE (S0b, audit D3). Shadowing alone was escaped
 * in one line (`(()=>{}).constructor("return globalThis")()` reached the
 * real `fetch` and, on the server, `process`). `runScript` now refuses code
 * that fails `codeGate(code, "logic")` — no `constructor` / `__proto__` /
 * `prototype`, no `globalThis` / `Function` / `eval` / network / storage /
 * `navigator`, no computed access on a global — and runs the gate's
 * loop-guarded form, so an endless loop throws after SCRIPT_LOOP_LIMIT
 * iterations instead of hanging the page.
 *
 * What this still is NOT: a security boundary. It runs in the page's realm;
 * the gate is static and a name assembled at run time on an object the
 * script declared is not seen. The runtime CSP stops such code from sending
 * anything off the page.
 *
 * READ THIS FIRST — LEGACY FLAG AND TESTS ONLY. Nothing in the product calls
 * this runner by default (S1b/S1c, 2026-10-30): a respondent's page runs logic
 * scripts in the sandboxed logic frame, the Studio canvas runs none, and the
 * server's replay runs none (`serverValidation.ts`, `scripts: "skip"`).
 *
 * S1b (2026-10-30): THIS MAIN-THREAD RUNNER IS NO LONGER HOW A RESPONDENT'S
 * PAGE RUNS SCRIPTS. The runtime sends logic scripts to a sandboxed frame
 * (`logicSandbox.ts` — the same `ctx`, writes as requests through
 * `applyScriptWrite`). `runScript` / `runScripts` remain for exactly two
 * callers: the runtime's temporary escape hatch `RUNTIME_LEGACY_SCRIPTS=main`
 * (one release) and unit tests. `createScriptCtx` is also what the host uses to
 * evaluate a script's literal `expr()` / `pipe()` arguments for the frame.
 */

/*
 * The globals a script must not reach, the helpers it receives and the wrapper it is compiled in live in
 * `codeGate.ts`, with the gate that reads the code before it runs (S0b D3).
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
  /*
   * ADDRESSING ELEMENTS BY THEIR STABLE ID (§46).
   *
   * Until now a script could reach a QUESTION — by id, code or variable name,
   * all three accepted — and nothing below it. There was no way to ask what an
   * option's label is, which rows a grid has, or what a group contains, so
   * every script that needed one hard-coded a code and broke when the list was
   * renumbered.
   *
   * These return PLAIN COPIES, not live definition objects. A script that
   * mutated the definition would change what every other respondent on the
   * same server sees, which is not a facility anybody asked for.
   */
  getElement(id: string): ElementView | null;
  getQuestion(ref: string): ElementView | null;
  getOption(id: string): ElementView | null;
  getRow(id: string): ElementView | null;
  getColumn(id: string): ElementView | null;
  getGroup(id: string): ElementView | null;
  /** console-style log captured by the inspector */
  log(...args: unknown[]): void;
  /** register a validation error (on_validate scripts, custom_script rules) */
  error(message: string, questionRef?: string): void;
  /** the answer under test, when this script is running as a validation rule */
  value?: unknown;
}

/** What a script sees of one iteration — a plain object, never the live context. */
export interface LoopItemView {
  code: string;
  label: string;
  /** the label again, under the brief's name */
  item: string;
  index: number;
  count: number;
  /** first / last iteration of this loop — `last` is null when the count is unknown */
  first: boolean;
  last: boolean | null;
  /** how many loops enclose this iteration, counting itself */
  depth: number;
  references: Record<string, unknown>;
}

/**
 * What a script sees of an element. A copy, and only the fields a script has
 * any business reading — no conditions, no nested logic, nothing that would
 * let a script rewrite the questionnaire it is running inside.
 */
export interface ElementView {
  kind: string;
  id: string;
  /** code for options and rows, question code for a question */
  code?: string | number;
  label?: string;
  /** the id of the element that owns this one */
  parentId?: string;
}

export interface ScriptRunResult {
  logs: string[];
  errors: { message: string; questionRef?: string }[];
  failed?: string;
  /** how many scripts ran — a caller that re-renders on state changes needs to know whether anything could have changed it */
  ran?: number;
  /** the code gate refused the script (it did not run): why */
  refused?: string;
  /** the names of the scripts the gate refused in this run (runScripts) */
  refusedScripts?: string[];
}

/** what a script sees of one iteration (shared with the sandbox snapshot, logicSandbox.ts) */
export function loopItemView(l: LoopContext): LoopItemView {
  return {
    code: l.code, label: l.label, item: l.label, index: l.index, count: l.count ?? 0,
    first: loopValue(l, "first") === true, last: loopValue(l, "last") as boolean | null, depth: loopDepth(l),
    references: { ...(l.references ?? {}) },
  };
}

export function createScriptCtx(
  def: SurveyDefinition,
  state: ResponseState,
  loop: LoopContext | null,
  result: ScriptRunResult,
): ScriptCtx {
  const refToId = (ref: string) => getQuestionByCodeOrVar(def, ref)?.id ?? ref;
  const viewOf = loopItemView;
  /*
   * Built once per script run and cached, because a script in a loop calls
   * these per iteration and walking the whole definition each time would turn
   * a lookup into a scan.
   */
  let index: Map<string, ElementRef> | null = null;
  const lookup = (id: string, kind?: string): ElementView | null => {
    index ??= elementIndex(def);
    const hit = index.get(id);
    if (!hit) return null;
    if (kind && hit.kind !== kind) return null;
    const el = hit.element as { code?: string | number };
    return {
      kind: hit.kind, id: hit.id, code: el?.code, label: hit.label, parentId: hit.parentId,
    };
  };

  return {
    getElement: (id) => lookup(id),
    /* a question stays addressable the three ways it always was */
    getQuestion(ref) {
      const q = getQuestionByCodeOrVar(def, ref);
      return q ? { kind: "question", id: q.id, code: q.code, label: q.code } : null;
    },
    getOption: (id) => lookup(id, "option"),
    getRow: (id) => lookup(id, "row"),
    getColumn: (id) => lookup(id, "column"),
    getGroup: (id) => lookup(id, "group"),
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
      /*
       * Seen from THIS iteration: a name that is a question answered inside
       * the loop body resolves to the iteration's answer, exactly as `get`
       * does, and falls through to the survey-level variables for everything
       * else. The bare flatten knew nothing of loops, so an expression run
       * from inside an iteration read the loop's questions as unanswered.
       */
      const flat = flattenVariables(def, state);
      const scoped = (n: string): unknown => {
        if (loop) {
          const q = getQuestionByCodeOrVar(def, n);
          if (q) {
            const v = lookupAnswer(state.answers, q.id, loop);
            if (v !== undefined) return v;
          }
        }
        return flat[n];
      };
      return evaluateExpression(expression, {
        resolver: scoped,
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

/**
 * Execute one script body against a ctx.
 *
 * `into` is the result the ctx was built with. Without it this function
 * returned a FRESH result while `ctx.log` and `ctx.error` wrote into the
 * caller's — so the returned `logs`/`errors` were always empty and every
 * caller that read them (the per-script name prefix below, among others)
 * quietly did nothing.
 */
export function runScript(code: string, ctx: ScriptCtx, into?: ScriptRunResult): ScriptRunResult {
  const result: ScriptRunResult = into ?? { logs: [], errors: [] };
  const gate = codeGate(code, "logic");
  if (!gate.ok) {
    result.refused = gateReason(gate);
    result.failed = `refused: ${result.refused}`;
    return result;
  }
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...LOGIC_PARAMS, logicScriptBody(gate.guarded));
    fn(ctx, loopCounter());
  } catch (e) {
    result.failed = e instanceof Error ? e.message : String(e);
  }
  return result;
}

/**
 * Run every enabled script matching scope/event/ref.
 *
 * `only: "scoped"` runs the page- and question-scoped scripts and leaves the
 * survey-wide ones alone. It exists for `on_load`: the survey-wide on_load
 * runs once per session, when the survey opens, but a PAGE's on_load can only
 * run when that page is shown — with the iteration it is shown in, so a loop
 * body's on_load sees `loop` and its `get`/`set` land on that iteration's
 * keys rather than on one bare key every iteration overwrites. Before this a
 * page-scoped on_load never ran at all (the session-open call passes no
 * scopeRef, so nothing matched).
 *
 * `scopeRef` is the id, or the ids, the event belongs to. A page's submit
 * belongs to the page AND to every question on it, so a question-scoped
 * on_validate / on_submit script runs when its question's page is submitted;
 * a change belongs to the question and to its page, so a page-scoped
 * on_change runs for any question on the page. Before this only the one id
 * was matched and those scripts — written, enabled, and listed in the editor
 * — silently never ran.
 */
/**
 * The scripts an event runs, in definition order: enabled, this event, in scope (see `runScripts`), and whose
 * `when` guard holds against the answers as they are now. Shared by the main-thread runner and the sandbox
 * (`prepareLogicScripts`), so both select exactly the same scripts.
 */
export function selectScripts(
  def: SurveyDefinition,
  state: ResponseState,
  event: CustomScript["event"],
  opts?: { scopeRef?: string | string[]; loop?: LoopContext | null; only?: "scoped" },
): CustomScript[] {
  const refs = opts?.scopeRef === undefined ? [] : Array.isArray(opts.scopeRef) ? opts.scopeRef : [opts.scopeRef];
  return def.scripts.filter((script) => {
    if (!script.enabled || script.event !== event) return false;
    if (script.scope === "survey" ? opts?.only === "scoped" : !(script.ref && refs.includes(script.ref))) return false;
    // the script's guard: an ordinary condition, any nesting, against the answers as they are now
    return !(script.when && !evaluateCondition(script.when, { def, state, loop: opts?.loop ?? null }));
  });
}

export function runScripts(
  def: SurveyDefinition,
  state: ResponseState,
  event: CustomScript["event"],
  opts?: { scopeRef?: string | string[]; loop?: LoopContext | null; only?: "scoped" },
): ScriptRunResult {
  const combined: ScriptRunResult = { logs: [], errors: [], ran: 0 };
  const refs = opts?.scopeRef === undefined ? [] : Array.isArray(opts.scopeRef) ? opts.scopeRef : [opts.scopeRef];
  for (const script of def.scripts) {
    if (!script.enabled || script.event !== event) continue;
    if (script.scope === "survey" ? opts?.only === "scoped" : !(script.ref && refs.includes(script.ref))) continue;
    // the script's guard: an ordinary condition, any nesting, against the answers as they are now (re-read per script: earlier scripts mutate the state here)
    if (script.when && !evaluateCondition(script.when, { def, state, loop: opts?.loop ?? null })) continue;
    const own: ScriptRunResult = { logs: [], errors: [] };
    const ctx = createScriptCtx(def, state, opts?.loop ?? null, own);
    const r = runScript(script.code, ctx, own);
    if (r.refused) {
      // not run: the inspector says so, and the caller warns in the console in live (S0b D3)
      combined.logs.push(`[${script.name}] refused: ${r.refused}`);
      (combined.refusedScripts ??= []).push(script.name);
      continue;
    }
    combined.ran = (combined.ran ?? 0) + 1;
    combined.logs.push(...own.logs.map((l) => `[${script.name}] ${l}`));
    combined.errors.push(...own.errors);
    if (r.failed) combined.logs.push(`[${script.name}] ERROR: ${r.failed}`);
  }
  return combined;
}
