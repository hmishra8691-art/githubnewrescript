import { declaredNames, tokenize, type Tok } from "./scriptAst.js";
import { exfiltrationProblems, guardScriptLoops, SCRIPT_LOOP_LIMIT } from "./uxScriptGuard.js";

/**
 * THE CODE GATE FOR AUTHOR JAVASCRIPT THAT RUNS ON THE RESPONDENT'S PAGE ITSELF (S0b, audit 2026-10-30 D2/D3).
 *
 * Two kinds of author code still run in the page's own realm, not in the sandboxed frame:
 *
 *   logic      `def.scripts[]` — the Scripts panel, imports (QSF / JSON / legacy), `custom_script` rules.
 *              Run by `runScript` as a `new Function` whose parameters SHADOW the globals.
 *   component  a Custom Component's `customJs` — run by the renderer with `el` (the component element) and
 *              `api` (getValue / setValue).
 *
 * Name shadowing alone is escaped in one line — `(()=>{}).constructor("return globalThis")()` reaches the real
 * `fetch`, `navigator.sendBeacon`, `document.cookie` (probe 1, S4 AP-02/AP-03). This gate reads the code with
 * the SAME tokenizer the behaviour checks use (`scriptAst.ts`) and refuses what that escape and its relatives
 * need. It is CONTAINMENT, not a boundary: S1 moves this code into the sandboxed frame. What it does:
 *
 *   - parse check (the code is compiled, never called, with the same wrapper it runs in);
 *   - forbidden names anywhere, as a name or a property (`x.constructor`, `ctx.get.constructor`, `navigator`,
 *     `globalThis`, `fetch`, `eval`, `Function`, `Reflect`, `Proxy`, `__proto__`, `prototype`, `cookie`,
 *     storage, `postMessage`, `sendBeacon`, `with`, `setInterval`, `import`, the paths from an element to its
 *     window: `ownerDocument`, `defaultView`, `contentWindow`, …);
 *   - the same names as a whole string literal (`x["constructor"]`);
 *   - globals the flavour has no business reaching, as a bare name (`window`, `self`, `top`, `location`, …);
 *   - computed member access `X[…]` whose object is a bare name the script did not declare and that is not one
 *     of its own roots (`navigator["send"+"Beacon"]`, `window[k]`, `this[k]`), and a computed key built by
 *     joining strings (`el["owner" + "Document"]`);
 *   - loops: rewritten by `guardScriptLoops` so every loop body calls `__g()` (bounded at SCRIPT_LOOP_LIMIT per
 *     run); a loop the guard cannot instrument is refused with its reason;
 *   - `exfiltrationProblems` (the regex check) is kept as an extra signal: its findings are reasons too.
 *
 * What it cannot see: a forbidden name assembled at run time in a variable (`const k = a + b; obj[k]` on an
 * object the script declared). The runtime CSP (`connect-src`) is what stops such code sending data anywhere.
 */

export type CodeFlavour = "logic" | "component";

/** the helpers a logic script receives (destructured from `ctx` by `runScript`) */
export const LOGIC_HELPERS = [
  "get", "set", "getCalc", "setCalc", "getEmbedded", "setEmbedded", "expr", "pipe", "flag", "loop", "log", "error",
  "getCurrentLoopItem", "getCurrentLoopIndex", "getLoopCount", "getCurrentLoopReference", "getLoopItems", "getLoopAnswer",
  "getElement", "getQuestion", "getOption", "getRow", "getColumn", "getGroup",
] as const;

/**
 * Globals a logic script must not reach. They are also bound to `undefined` as parameters when it runs, so a typo
 * throws a clear TypeError instead of silently reaching the real API.
 */
export const LOGIC_DENIED_GLOBALS = [
  "window", "document", "globalThis", "self", "top", "parent", "frames",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "navigator",
  "localStorage", "sessionStorage", "indexedDB", "caches",
  "process", "require", "module", "exports",
  "Function", "setTimeout", "setInterval", "queueMicrotask",
  "postMessage", "open", "alert", "confirm", "prompt",
];

/** the loop counter's name; an author may not use it */
export const LOOP_GUARD_NAME = "__g";

/** the body `runScript` compiles for a logic script (after the loop guard) */
export function logicScriptBody(guardedCode: string): string {
  return `"use strict";\nconst { ${LOGIC_HELPERS.join(", ")} } = ctx;\nconst value = ctx.value;\n${guardedCode}`;
}
/** the parameters, in order, of the compiled logic script */
export const LOGIC_PARAMS = ["ctx", LOOP_GUARD_NAME, ...LOGIC_DENIED_GLOBALS];

/** the body the renderer compiles for a component (after the loop guard) — strict, so a top-level `this` is not the window */
export function componentScriptBody(guardedCode: string): string {
  return `"use strict";\n${guardedCode}`;
}
export const COMPONENT_PARAMS = ["el", "api", LOOP_GUARD_NAME];

/** refused wherever they appear, as a name or as a property */
const FORBIDDEN_ANYWHERE = [
  "constructor", "__proto__", "prototype", "globalThis", "Function", "eval", "fetch", "XMLHttpRequest", "WebSocket",
  "EventSource", "navigator", "cookie", "cookieStore", "localStorage", "sessionStorage", "indexedDB", "caches", "postMessage",
  "sendBeacon", "Reflect", "Proxy", "with", "setInterval", "importScripts", "Worker", "SharedWorker", "ServiceWorker",
  "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "getPrototypeOf", "setPrototypeOf",
  "ownerDocument", "defaultView", "contentWindow", "contentDocument", "opener", "AsyncFunction", "GeneratorFunction",
  LOOP_GUARD_NAME,
];
const ANYWHERE = new Set(FORBIDDEN_ANYWHERE);

/** refused as a bare name (a root), per flavour — as a property (`style.top`, `x.parent`) they are ordinary */
const BARE: Record<CodeFlavour, Set<string>> = {
  logic: new Set(["window", "document", "self", "top", "parent", "frames", "location", "process", "require", "module", "exports", "open", "alert", "confirm", "prompt", "setTimeout", "queueMicrotask", "Image", "history"]),
  component: new Set(["window", "self", "top", "parent", "frames", "location", "process", "require", "module", "exports", "open", "Image", "history", "document"]),
};
/** a component may use `document` only to make nodes it then puts in its own element */
const COMPONENT_DOCUMENT_OK = new Set(["createElement", "createElementNS", "createTextNode", "createDocumentFragment"]);

const ROOTS: Record<CodeFlavour, Set<string>> = {
  logic: new Set(["ctx", "value", ...LOGIC_HELPERS]),
  component: new Set(["el", "api"]),
};

export interface CodeGateVerdict {
  ok: boolean;
  /** why it is refused (empty when ok) */
  errors: string[];
  /** the code as it runs: loops instrumented with the guard */
  guarded: string;
}

/** every token, with each template literal's `${…}` tokens spliced in after it */
function flat(t: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (const x of t) { out.push(x); if (x.k === "tpl") for (const p of x.parts ?? []) out.push(...flat(p)); }
  return out;
}

const say = (flavour: CodeFlavour) => flavour === "logic"
  ? "survey scripts reach the survey through get/set/getCalc/setCalc/… only"
  : "component code works on its element (el) and its answer (api.getValue / api.setValue) only";

/** the matching `]` of the `[` at i (token index), or -1 */
function closeBracket(t: Tok[], i: number): number {
  let d = 0;
  for (let j = i; j < t.length; j++) { if (t[j]!.v === "[") d++; else if (t[j]!.v === "]" && --d === 0) return j; }
  return -1;
}

function check(code: string, flavour: CodeFlavour): CodeGateVerdict {
  const errors: string[] = [];
  const src = String(code ?? "");
  const guard = guardScriptLoops(src);
  errors.push(...guard.errors);
  const top = tokenize(src);
  const t = flat(top);
  const declared = new Set(declaredNames(top));
  const why = say(flavour);
  for (let i = 0; i < t.length; i++) {
    const x = t[i]!;
    const prev = t[i - 1];
    const afterDot = prev?.k === "punct" && (prev.v === "." || prev.v === "?.");
    if (x.k === "kw" && x.v === "import") { errors.push(`import is not available — ${why}`); continue; }
    if ((x.k === "id" || x.k === "kw") && ANYWHERE.has(x.v)) { errors.push(`${x.v} is not available — ${why}`); continue; }
    if (x.k === "id" && !afterDot && BARE[flavour].has(x.v) && !declared.has(x.v)) {
      if (flavour === "component" && x.v === "document" && t[i + 1]?.v === "." && COMPONENT_DOCUMENT_OK.has(t[i + 2]?.v ?? "")) continue;
      errors.push(`${x.v} is not available — ${why}`);
      continue;
    }
    if ((x.k === "str" || (x.k === "tpl" && !x.parts?.length)) && ANYWHERE.has(x.v.trim())) { errors.push(`"${x.v.trim()}" is not available, not even as a string — ${why}`); continue; }
    if (x.k === "punct" && x.v === "[") {
      const obj = prev;
      const objAfterDot = t[i - 2]?.k === "punct" && (t[i - 2]!.v === "." || t[i - 2]!.v === "?.");
      // `X[…]` (not `a.X[…]`, not an array literal): X must be the script's own name or one of its roots
      if (obj && ((obj.k === "id" && !objAfterDot) || (obj.k === "kw" && obj.v === "this"))) {
        if (obj.v === "this" || (!declared.has(obj.v) && !ROOTS[flavour].has(obj.v))) {
          errors.push(`computed access on ${obj.v}[…] is not available — use a name the script declared — ${why}`);
          continue;
        }
      }
      // a key spelled by joining strings is how a forbidden name is smuggled past the name check
      if (obj && (obj.k === "id" || obj.k === "kw" || obj.v === ")" || obj.v === "]")) {
        const end = closeBracket(t, i);
        const key = end > 0 ? t.slice(i + 1, end) : [];
        const strs = key.some((k) => k.k === "str" || k.k === "tpl");
        const joins = key.some((k) => (k.k === "punct" && k.v === "+") || (k.k === "id" && (k.v === "concat" || k.v === "join" || k.v === "fromCharCode" || k.v === "atob" || k.v === "reverse")));
        if ((strs && joins) || key.some((k) => k.k === "tpl" && (k.parts?.length ?? 0) > 0)) {
          errors.push(`a computed property name built from strings (x["a" + "b"]) is not available — write the property name out — ${why}`);
        }
      }
    }
  }
  /* the regex check stays as an extra signal: a request by attribute, an address built from answers … */
  errors.push(...exfiltrationProblems(src));
  if (!errors.length) {
    try {
      // compiled, never called: the same wrapper it runs in, so a clash with a helper name is caught here
      // eslint-disable-next-line no-new-func
      if (flavour === "logic") new Function(...LOGIC_PARAMS, logicScriptBody(guard.code));
      // eslint-disable-next-line no-new-func
      else new Function(...COMPONENT_PARAMS, componentScriptBody(guard.code));
    } catch (e) { errors.push(`the code does not parse: ${(e as Error).message}`); }
  }
  const uniq = [...new Set(errors)];
  return { ok: uniq.length === 0, errors: uniq, guarded: guard.code };
}

/* the runtime asks for the same code on every event: remember the last few hundred verdicts */
const memo = new Map<string, CodeGateVerdict>();
const MEMO_MAX = 400;

/** The gate for author JavaScript that runs on the page itself. Pure; cached per (flavour, code). */
export function codeGate(code: string, flavour: CodeFlavour): CodeGateVerdict {
  const key = `${flavour}\u0000${code}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const v = check(code, flavour);
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
  memo.set(key, v);
  return v;
}

/** a loop counter for one run: throws past SCRIPT_LOOP_LIMIT iterations, like the sandbox's */
export function loopCounter(limit = SCRIPT_LOOP_LIMIT): () => void {
  let n = 0;
  return () => { if (++n > limit) throw new Error(`a loop ran more than ${limit.toLocaleString("en-US")} times and was stopped`); };
}

/** one line for a refusal: the first reasons, joined */
export const gateReason = (v: Pick<CodeGateVerdict, "errors">, n = 3) => v.errors.slice(0, n).join("; ");

/**
 * IMPORTED / PASTED SCRIPTS: the gate's verdict attached, never silently run.
 *
 * A script that fails the gate is switched off (`enabled: false`) and its notes say why; a script that was
 * already off (an import, "pending review") keeps that and gets the verdict in its notes too, so the person who
 * reviews it sees it before switching it on. A script that passes is left exactly as it was. Returns the names
 * of the scripts it switched off or annotated.
 */
export function gateSurveyScripts<D extends { scripts?: { name: string; code: string; enabled: boolean; notes?: string }[] }>(def: D): { def: D; refused: { name: string; reason: string; wasEnabled: boolean }[] } {
  const refused: { name: string; reason: string; wasEnabled: boolean }[] = [];
  if (!def.scripts?.length) return { def, refused };
  const scripts = def.scripts.map((s) => {
    const v = codeGate(s.code ?? "", "logic");
    if (v.ok) return s;
    const reason = gateReason(v);
    refused.push({ name: s.name, reason, wasEnabled: !!s.enabled });
    const tag = `Script check: refused — ${reason}.`;
    const notes = s.notes?.includes("Script check: refused") ? s.notes : `${tag}${s.notes ? ` ${s.notes}` : ""}`.slice(0, 1000);
    return { ...s, enabled: false, notes };
  });
  return { def: { ...def, scripts }, refused };
}
