import type { SurveyDefinition, CustomScript } from "@rescript/schema";
import type { ResponseState, LoopContext } from "./state.js";
import { createScriptCtx, loopItemView, selectScripts, type LoopItemView, type ElementView } from "./scripts.js";
import { codeGate, gateReason, LOGIC_PARAMS, logicScriptBody } from "./codeGate.js";
import { elementIndex } from "./elementIds.js";
import { loopContexts, loopNodes } from "./loops.js";
import type { ScriptWrite, ScriptWriteScope } from "./scriptWrites.js";
import { SCRIPT_LOOP_LIMIT } from "./uxScriptGuard.js";

/**
 * S1b — SCRIPTS-PANEL LOGIC SCRIPTS RUN IN THE SANDBOXED FRAME.
 *
 * Until S1b a logic script (`def.scripts`, the Scripts panel, imported scripts, `custom_script` validation rules)
 * ran on the respondent's page with `new Function` and mutated the response directly. Now the host (the Runner)
 * sends the gated code and a per-run SNAPSHOT of the data the `ctx` getters read to one sandboxed frame per page
 * (opaque origin, `default-src 'none'`), where `LOGIC_SHIM` gives the script the same `ctx` it always had —
 * `get`, `set`, `getCalc`, `setCalc`, `getEmbedded`, `setEmbedded`, `expr`, `pipe`, `flag`, `loop`, `log`, `error`,
 * the loop accessors and the element getters (`ScriptCtx` in scripts.ts, same names and signatures).
 *
 * A WRITE IS A REQUEST. `set` / `setCalc` / `setEmbedded` / `flag` are QUEUED while the synchronous body runs and
 * returned with it, in order; the host applies them one by one through the engine's write channel
 * (`applyScriptWrite`, S1a: scope rule, response model, limits, paradata) and only then continues. Inside the run
 * the shim keeps a LOCAL OVERLAY, so a later `get` / `getCalc` in the same run — and a later script of the same
 * batch — sees the run's own earlier writes, as the old synchronous runner did. A write the host then refuses is
 * logged with the reason; the overlay had shown it to the rest of the batch (the one visible difference).
 *
 * `expr(text)` and `pipe(text)` need the whole engine; the frame has none. The host evaluates every LITERAL
 * argument found in the code (`expr('Q1 + Q2')`, `pipe("Hi {{Q1}}")`) against the response before the run and
 * ships the results; a computed argument returns null (expr) / the text unchanged (pipe) and logs why.
 *
 * `LOGIC_SHIM` is source text so the unit test runs exactly what the frame runs, in a vm context of its own.
 */

/** what the frame is given once: how a question is addressed, and the element views the getters return */
export interface LogicStatics {
  questions: { id: string; code: string; variableName?: string }[];
  elements: Record<string, ElementView>;
}

/** the per-run data the ctx getters read (a copy — the frame cannot reach the live state) */
export interface LogicSnapshot {
  answers: Record<string, unknown>;
  calculated: Record<string, unknown>;
  embedded: Record<string, unknown>;
  flags: string[];
  loop: LoopContext | null;
  /** every iteration of each loop in the chain, by loop id (getLoopItems) */
  loopItems: Record<string, LoopItemView[]>;
  /** literal expr("…") / pipe("…") arguments, evaluated by the host */
  exprs: Record<string, unknown>;
  pipes: Record<string, string>;
  /** the answer under test (a custom_script validation rule) */
  value?: unknown;
}

/** one script, ready for the frame: gated, loop-guarded, wrapped */
export interface PreparedLogicScript {
  id: string;
  name: string;
  scope: CustomScript["scope"];
  ref?: string;
  params: string[];
  body: string;
}

/** what the frame answers for one script of a run */
export interface LogicScriptOutcome {
  name: string;
  writes: ScriptWrite[];
  logs: string[];
  errors: { message: string; questionRef?: string }[];
  failed?: string;
}

/** the engine's write scope for a logic script: what it is attached to */
export function logicScriptScope(s: Pick<CustomScript, "scope" | "ref">): ScriptWriteScope {
  if (s.scope === "question" && s.ref) return { kind: "question", questionId: s.ref };
  if (s.scope === "page" && s.ref) return { kind: "page", pageId: s.ref };
  return { kind: "survey" };
}

/**
 * The scripts an event runs (the same selection, `when` guards and scope rules as `runScripts`), through the code
 * gate (`codeGate(code, "logic")`) BEFORE any code leaves the host: a refused script is reported, never sent.
 */
export function prepareLogicScripts(
  def: SurveyDefinition,
  state: ResponseState,
  event: CustomScript["event"],
  opts?: { scopeRef?: string | string[]; loop?: LoopContext | null; only?: "scoped"; ids?: string[] },
): { scripts: PreparedLogicScript[]; refused: { name: string; reason: string }[] } {
  const scripts: PreparedLogicScript[] = [];
  const refused: { name: string; reason: string }[] = [];
  const list = opts?.ids ? def.scripts.filter((s) => opts.ids!.includes(s.id) && s.enabled !== false) : selectScripts(def, state, event, opts);
  for (const s of list) {
    const gate = codeGate(s.code, "logic");
    if (!gate.ok) { refused.push({ name: s.name, reason: gateReason(gate) }); continue; }
    scripts.push({ id: s.id, name: s.name, scope: s.scope, ...(s.ref ? { ref: s.ref } : {}), params: [...LOGIC_PARAMS], body: logicScriptBody(gate.guarded) });
  }
  return { scripts, refused };
}

export function logicStatics(def: SurveyDefinition): LogicStatics {
  const elements: Record<string, ElementView> = {};
  for (const [id, hit] of elementIndex(def)) {
    const el = hit.element as { code?: string | number } | null;
    elements[id] = { kind: hit.kind, id: hit.id, ...(el?.code !== undefined ? { code: el.code } : {}), ...(hit.label !== undefined ? { label: hit.label } : {}), ...(hit.parentId ? { parentId: hit.parentId } : {}) };
  }
  return {
    questions: def.questions.map((q) => ({ id: q.id, code: String(q.code), ...(q.variableName ? { variableName: q.variableName } : {}) })),
    elements,
  };
}

/** the literal first arguments of `fn(…)` calls in the code — `expr('a + b')`, `pipe("{{Q1}}")` */
export function literalCallArgs(code: string, fn: "expr" | "pipe"): string[] {
  const out = new Set<string>();
  const re = new RegExp(`(?<![\\w$.])${fn}\\(\\s*(?:'((?:\\\\.|[^'\\\\])*)'|"((?:\\\\.|[^"\\\\])*)"|\`((?:\\\\.|[^\`\\\\$])*)\`)\\s*\\)`, "g");
  for (const m of code.matchAll(re)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    try { out.add(m[3] !== undefined ? raw.replace(/\\(.)/g, "$1") : JSON.parse(`"${raw.replace(/"/g, '\\"').replace(/\\'/g, "'")}"`)); }
    catch { out.add(raw); }
  }
  return [...out];
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);

/** the snapshot for one run of these scripts, from the iteration they run in */
export function logicSnapshot(def: SurveyDefinition, state: ResponseState, loop: LoopContext | null, codes: string[], value?: unknown): LogicSnapshot {
  const ctx = createScriptCtx(def, state, loop, { logs: [], errors: [] });
  const exprs: Record<string, unknown> = {};
  const pipes: Record<string, string> = {};
  for (const code of codes) {
    for (const e of literalCallArgs(code, "expr")) { try { exprs[e] = clone(ctx.expr(e) ?? null); } catch { exprs[e] = null; } }
    for (const t of literalCallArgs(code, "pipe")) { try { pipes[t] = ctx.pipe(t); } catch { pipes[t] = t; } }
  }
  const loopItems: Record<string, LoopItemView[]> = {};
  if (loop && codes.some((c) => c.includes("getLoopItems"))) {
    for (let l: LoopContext | null | undefined = loop; l; l = l.parent) {
      if (!l.loopId || loopItems[l.loopId]) continue;
      const node = loopNodes(def).find((x) => x.node.id === l!.loopId)?.node;
      if (node) loopItems[l.loopId] = loopContexts(def, state, node, l.parent ?? null).map(loopItemView);
    }
  }
  return {
    answers: clone(state.answers) as Record<string, unknown>,
    calculated: clone(state.calculated) as Record<string, unknown>,
    embedded: clone(state.embedded) as Record<string, unknown>,
    flags: [...state.flags],
    loop: loop ? clone(loop) : null,
    loopItems, exprs, pipes,
    ...(value !== undefined ? { value: clone(value) } : {}),
  };
}

/**
 * THE SHIM — runs inside the sandboxed frame (and, in the unit test, inside a vm context). Declares
 * `__rsLogic = { statics(s), run(req, compile) }`; `run` returns one `LogicScriptOutcome` per script, in order.
 * `compile(params, body)` is how the frame turns the gated body into a function (`Function.apply(null, …)`).
 */
export const LOGIC_SHIM = String.raw`
var __rsLogic = (function () {
  "use strict";
  var LIMIT = ${SCRIPT_LOOP_LIMIT};
  var statics = { questions: [], elements: {} }, byRef = {};
  var own = function (o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); };
  function setStatics(s) {
    statics = s || statics; byRef = {};
    (statics.questions || []).forEach(function (q) {
      [q.id, q.code, q.variableName].forEach(function (k) { if (k != null && k !== "" && !own(byRef, k)) byRef[k] = q; });
    });
  }
  function plain(v) { if (v === undefined) return null; try { var s = JSON.stringify(v); return s === undefined ? null : JSON.parse(s); } catch (e) { return null; } }
  function copy(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function freeze(o) { if (o && typeof o === "object") { Object.keys(o).forEach(function (k) { freeze(o[k]); }); Object.freeze(o); } return o; }
  function suffix(l) { var c = []; for (; l; l = l.parent) c.unshift("@" + l.code); return c.join(""); }
  function keyOf(id, l) { return id + suffix(l); }
  function lookup(ans, id, loop) { for (var l = loop; l; l = l.parent) { var k = id + suffix(l); if (ans[k] !== undefined) return ans[k]; } return ans[id]; }
  function depth(l) { var d = 0; for (; l; l = l.parent) d++; return d; }
  function lval(l, ref) {
    switch (ref) {
      case "code": return l.code;
      case "label": case "item": return l.label;
      case "index": return l.index;
      case "count": return l.count == null ? null : l.count;
      case "first": return l.index === 1;
      case "last": return typeof l.count === "number" && l.count > 0 ? l.index === l.count : null;
      case "depth": return depth(l);
      default: return own(l.references, ref) ? l.references[ref] : null;
    }
  }
  function scopeOf(loop, scope) { if (!loop) return null; if (!scope) return loop; for (var l = loop; l; l = l.parent) if (l.loopVar === scope) return l; return null; }
  function viewOf(l) {
    return { code: l.code, label: l.label, item: l.label, index: l.index, count: l.count == null ? 0 : l.count,
      first: lval(l, "first") === true, last: lval(l, "last"), depth: depth(l), references: copy(l.references || {}) };
  }
  function idOf(ref) { var q = own(byRef, ref) ? byRef[ref] : null; return q ? q.id : ref; }
  function counter() { var n = 0; return function () { if (++n > LIMIT) throw new Error("a loop ran more than " + LIMIT.toLocaleString("en-US") + " times and was stopped"); }; }
  function fmt(a) { if (typeof a === "object" && a !== null) { try { return JSON.stringify(a); } catch (e) { return String(a); } } return typeof a === "object" ? "null" : String(a); }

  function run(req, compile) {
    var snap = req.snap || {};
    /* THE OVERLAY: one copy for the whole batch — a later get (and a later script) sees this run's own writes */
    var answers = copy(snap.answers || {}), calculated = copy(snap.calculated || {}), embedded = copy(snap.embedded || {});
    var flags = (snap.flags || []).slice();
    var loop = snap.loop ? freeze(copy(snap.loop)) : null;
    var results = [];
    (req.scripts || []).forEach(function (script) {
      var out = { name: script.name, writes: [], logs: [], errors: [] };
      var told = {};
      var note = function (k, text) { if (told[k]) return; told[k] = 1; out.logs.push(text); };
      var lookupEl = function (id, kind) { var v = own(statics.elements, id) ? statics.elements[id] : null; if (!v || (kind && v.kind !== kind)) return null; return copy(v); };
      var ctx = {
        get: function (ref) { var v = lookup(answers, idOf(ref), loop); return v === undefined ? null : copy(v); },
        set: function (ref, value) { var v = plain(value); answers[keyOf(idOf(ref), loop)] = v; out.writes.push({ kind: "answer", ref: ref == null ? "" : String(ref), value: v, loopKey: null }); },
        getCalc: function (name) { var v = calculated[name]; return v === undefined ? null : copy(v); },
        setCalc: function (name, value) { var v = plain(value); calculated[name] = v; out.writes.push({ kind: "calculated", name: name == null ? "" : String(name), value: v }); },
        getEmbedded: function (name) { var v = embedded[name]; return v === undefined ? null : copy(v); },
        setEmbedded: function (name, value) { var v = plain(value); embedded[name] = v; out.writes.push({ kind: "embedded", name: name == null ? "" : String(name), value: v }); },
        expr: function (text) { if (own(snap.exprs, text)) return copy(snap.exprs[text]); note("expr:" + text, "expr(" + JSON.stringify(String(text)) + ") is not available: in the sandbox expr() takes the expression written out as a literal string"); return null; },
        pipe: function (text) { if (own(snap.pipes, text)) return snap.pipes[text]; note("pipe:" + text, "pipe(" + JSON.stringify(String(text)) + ") is not available: in the sandbox pipe() takes the text written out as a literal string"); return text == null ? "" : String(text); },
        flag: function (name) { var n = name == null ? "" : String(name); if (flags.indexOf(n) < 0) flags.push(n); out.writes.push({ kind: "flag", name: n }); },
        loop: loop,
        getCurrentLoopItem: function (scope) { var l = scopeOf(loop, scope); return l ? viewOf(l) : null; },
        getCurrentLoopIndex: function (scope) { var l = scopeOf(loop, scope); return l ? l.index : 0; },
        getLoopCount: function (scope) { var l = scopeOf(loop, scope); return l && l.count != null ? l.count : 0; },
        getCurrentLoopReference: function (name, scope) { var l = scopeOf(loop, scope); return l ? copy(lval(l, name)) : null; },
        getLoopItems: function (scope) { var l = scopeOf(loop, scope); if (!l || !l.loopId) return []; return copy((snap.loopItems || {})[l.loopId] || []); },
        getLoopAnswer: function (ref, itemCode, scope) {
          var l = scopeOf(loop, scope); if (!l) return null;
          var t = { loopVar: l.loopVar, code: itemCode, label: l.label, index: l.index, parent: l.parent || null };
          var v = answers[keyOf(idOf(ref), t)]; return v === undefined ? null : copy(v);
        },
        getElement: function (id) { return lookupEl(id); },
        getQuestion: function (ref) { var q = own(byRef, ref) ? byRef[ref] : null; return q ? { kind: "question", id: q.id, code: q.code, label: q.code } : null; },
        getOption: function (id) { return lookupEl(id, "option"); },
        getRow: function (id) { return lookupEl(id, "row"); },
        getColumn: function (id) { return lookupEl(id, "column"); },
        getGroup: function (id) { return lookupEl(id, "group"); },
        log: function () { out.logs.push(Array.prototype.map.call(arguments, fmt).join(" ")); },
        error: function (message, questionRef) { var e = { message: message == null ? "" : String(message).slice(0, 2000) }; if (questionRef != null) e.questionRef = String(questionRef); out.errors.push(e); },
        value: snap.value === undefined ? undefined : copy(snap.value)
      };
      try { compile(script.params, script.body)(Object.freeze(ctx), counter()); }
      catch (e) { out.failed = e && e.message ? String(e.message) : String(e); }
      if (out.logs.length > 200) out.logs = out.logs.slice(0, 200).concat(["… " + (out.logs.length - 200) + " more log lines"]);
      if (out.writes.length > 500) { out.failed = out.failed || "more than 500 writes in one run — the rest were dropped"; out.writes = out.writes.slice(0, 500); }
      results.push(out);
    });
    return results;
  }
  return { statics: setStatics, run: run };
})();
`;
