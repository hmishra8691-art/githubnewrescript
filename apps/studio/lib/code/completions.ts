import type { SurveyDefinition } from "@rescript/schema";
import { UX_PRESETS } from "@rescript/schema";
import { COMPONENT_API, LOGIC_HELPER_DOCS, SANDBOX_API, SANDBOX_EVENTS, UX_DOM_HOOKS } from "@rescript/engine";
import type { CodeCompletion, CodeKind, CompletionAt } from "./types.ts";

export type { CodeKind, CompletionAt, CodeCompletion } from "./types.ts";

/**
 * THE CODE EDITOR'S COMPLETION SOURCE (S3a item 2) — from the platform, not a list typed here:
 *
 *   rs.*                 `SANDBOX_API` (capability registry): every method with its signature and effect
 *   rs.listen("…")       `SANDBOX_EVENTS`; its second argument "self" or a question code
 *   rs.animate(t, "…")   the motion presets (`UX_PRESETS`)
 *   logic helpers        `LOGIC_HELPER_DOCS` (keyed by the code gate's `LOGIC_HELPERS`)
 *   component            `COMPONENT_API` — el, api.getValue / setValue / onChange
 *   page hooks           `UX_DOM_HOOKS` (Next, Back, card, progress) and each question's `[data-qid="…"]`
 *   survey names         the CURRENT definition: question codes (with their text), calculations, embedded fields,
 *                        and a question's option codes after `getAnswer("Q1") === "`
 *
 * Pure: (kind, definition, document, cursor) → what to offer and where the replaced text starts. CodeMirror's
 * `CompletionContext` is adapted to it in `codeEditorSetup.ts`.
 */

const plain = (html: unknown, n = 70) => String(html ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

function questionOptions(def: SurveyDefinition | undefined): CodeCompletion[] {
  return (def?.questions ?? []).map((q, i) => ({ label: String(q.code), type: "variable" as const, detail: q.type, info: plain(q.text) || undefined, boost: -i / 1000 }));
}
function calcOptions(def: SurveyDefinition | undefined): CodeCompletion[] {
  return (def?.calculations ?? []).map((c) => ({ label: c.targetVariable, type: "variable" as const, detail: "calculation", info: c.label ?? plain(c.expression, 60) }));
}
function embeddedOptions(def: SurveyDefinition | undefined): CodeCompletion[] {
  const list = ((def as unknown as { embeddedData?: { name: string; source?: string }[] })?.embeddedData ?? []);
  return list.map((e) => ({ label: e.name, type: "variable" as const, detail: "embedded field", info: e.source ? `from ${e.source}` : undefined }));
}
function findQuestion(def: SurveyDefinition | undefined, ref: string) {
  return def?.questions.find((q) => String(q.code) === ref || q.id === ref);
}

/** the page hooks a script can select: the platform's fixed ones, then each question's card */
export function pageHooks(def: SurveyDefinition | undefined): CodeCompletion[] {
  const fixed: CodeCompletion[] = [];
  for (const h of UX_DOM_HOOKS) {
    for (const m of h.use.matchAll(/\[[^\]]+\]|\.rs-[\w-]+/g)) {
      if (m[0].includes("<")) continue;
      if (!fixed.some((x) => x.label === m[0])) fixed.push({ label: m[0], type: "constant", detail: "page hook", info: h.what });
    }
  }
  if (!fixed.some((x) => x.label === '[data-rs-el="option"]')) fixed.push({ label: '[data-rs-el="option"]', type: "constant", detail: "page hook", info: "an option (with [data-rs-id=\"<code>\"])" });
  const cards = (def?.questions ?? []).map((q) => ({ label: `[data-qid="${q.id}"]`, type: "constant" as const, detail: String(q.code), info: plain(q.text) || "question card" }));
  return [...fixed, ...cards];
}

const TARGET_FIRST = new Set(["addClass", "removeClass", "toggleClass", "animate", "setStyle", "clearStyle", "show", "hide", "showMessage", "hideMessage", "scrollTo", "focus", "getQuestion"]);
const QUESTION_REF = new Set(["getAnswer", "setAnswer", "getQuestion", "get", "set", "getLoopAnswer"]);
const CALC_REF = new Set(["getCalc", "setCalc"]);
const EMBEDDED_REF = new Set(["getEmbedded", "setEmbedded"]);

/** inside a string literal: which call (and which argument) it belongs to */
function stringContext(before: string): { partial: string; call?: string; argIndex: number; firstArg?: string; selector?: boolean; compareWith?: string } | null {
  const tail = before.slice(-400);
  const open = /(["'`])([^"'`\\\n]*)$/.exec(tail);
  if (!open) return null;
  // the quote must open a string, not close one: count the quotes of that kind on the line before it
  const line = tail.slice(tail.lastIndexOf("\n") + 1, tail.length - open[0].length);
  const quotes = (line.replace(/\\./g, "").match(new RegExp(open[1] === "`" ? "`" : open[1], "g")) ?? []).length;
  if (quotes % 2 === 1) return null;
  const partial = open[2];
  const head = tail.slice(0, tail.length - open[0].length);
  /* a comparison with an answer: getAnswer("Q1") === "…" / get("Q1") == '…' */
  const cmp = /(?:getAnswer|\bget)\s*\(\s*["']([^"']+)["']\s*\)\s*(?:===?|!==?)\s*$/.exec(head);
  if (cmp) return { partial, argIndex: -1, compareWith: cmp[1] };
  /* a selector: querySelector("…"), closest(…), matches(…), or text that is already a [data-…] selector */
  if (/(?:querySelector(?:All)?|closest|matches)\s*\(\s*$/.test(head)) return { partial, argIndex: 0, selector: true };
  /* the call the string is an argument of: name( "a", "b", "|" */
  const call = /(?:\b(rs|api|ctx)\s*\.\s*|(?<![\w$])(?<!\.\s*))([A-Za-z_$][\w$]*)\s*\(\s*((?:(["'])(?:[^"'\\\n])*\4\s*,\s*)*)$/.exec(head);
  if (!call) return { partial, argIndex: 0 };
  const prior = [...call[3].matchAll(/(["'])([^"'\\\n]*)\1/g)].map((m) => m[2]);
  return { partial, call: `${call[1] ? `${call[1]}.` : ""}${call[2]}`, argIndex: prior.length, firstArg: prior[0] };
}

/** what to offer at `pos`, or null */
export function codeCompletions(kind: CodeKind, def: SurveyDefinition | undefined, doc: string, pos: number, explicit = false): CompletionAt | null {
  if (kind === "css" || kind === "html") return null;
  const before = doc.slice(0, pos);
  const s = stringContext(before);
  if (s) {
    const from = pos - s.partial.length;
    const at = (options: CodeCompletion[]): CompletionAt | null => (options.length ? { from, options, inString: true } : null);
    if (s.compareWith) {
      const q = findQuestion(def, s.compareWith);
      return at((q?.options ?? []).map((o) => ({ label: String(o.code), type: "enum" as const, detail: `${q!.code} option`, info: plain(o.label) || undefined })));
    }
    if (s.selector) return kind === "ux" || kind === "component" ? at(pageHooks(def)) : null;
    const name = s.call?.replace(/^(?:rs|ctx|api)\./, "") ?? "";
    const isRs = s.call?.startsWith("rs.") ?? false;
    if (kind === "ux" && isRs) {
      if (name === "listen" && s.argIndex === 0) return at(Object.entries(SANDBOX_EVENTS).map(([ev, d]) => ({ label: ev, type: "enum" as const, detail: "event", info: d })));
      if (name === "listen" && s.argIndex === 1) return at([{ label: "self", type: "keyword", detail: "this script's target", boost: 1 }, ...questionOptions(def)]);
      if (name === "animate" && s.argIndex === 1) return at(UX_PRESETS.map((p) => ({ label: p, type: "enum" as const, detail: "preset" })));
      if (TARGET_FIRST.has(name) && s.argIndex === 0) return at([{ label: "self", type: "keyword", detail: "this script's target", boost: 1 }, ...questionOptions(def)]);
    }
    if (s.argIndex === 0 && (kind === "ux" ? isRs : kind === "logic" && !s.call?.startsWith("api."))) {
      if (QUESTION_REF.has(name)) return at(kind === "logic" && name === "get" ? [...questionOptions(def), ...calcOptions(def)] : questionOptions(def));
      if (CALC_REF.has(name)) return at(calcOptions(def));
      if (EMBEDDED_REF.has(name)) return at(embeddedOptions(def));
    }
    /* a selector being typed in any string: [data-qid="… */
    if (/\[data-qid=\\?$/.test(before.slice(0, from - 1)) && (kind === "ux" || kind === "component")) {
      return at((def?.questions ?? []).map((q) => ({ label: q.id, type: "constant" as const, detail: String(q.code), info: plain(q.text) || undefined })));
    }
    return null;
  }
  /* a member: rs.… / api.… */
  const member = /\b(rs|api)\s*\.\s*([\w$]*)$/.exec(before);
  if (member) {
    const from = pos - member[2].length;
    if (member[1] === "rs" && kind === "ux") {
      return { from, inString: false, options: Object.entries(SANDBOX_API).map(([m, d]) => ({ label: m, type: "method" as const, detail: d.sig, info: d.write ? `${d.effect} (a write request)` : d.effect })) };
    }
    if (member[1] === "api" && kind === "component") {
      return { from, inString: false, options: Object.entries(COMPONENT_API).filter(([k]) => k.startsWith("api.")).map(([k, d]) => ({ label: k.slice(4), type: "method" as const, detail: d.sig, info: d.effect })) };
    }
    return null;
  }
  /* a bare name being typed (not a property of something else) */
  const word = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)$/.exec(before);
  if (!word && !explicit) return null;
  const typed = word?.[1] ?? "";
  const from = pos - typed.length;
  if (kind === "logic") {
    return { from, inString: false, options: Object.entries(LOGIC_HELPER_DOCS).map(([h, d]) => ({ label: h, type: (h === "loop" ? "variable" : "function") as CodeCompletion["type"], detail: d.sig, info: d.write ? `${d.effect}` : d.effect })) };
  }
  if (kind === "component") {
    return { from, inString: false, options: (["el", "api"] as const).map((k) => ({ label: k, type: "variable" as const, detail: COMPONENT_API[k]!.sig, info: COMPONENT_API[k]!.effect })) };
  }
  return { from, inString: false, options: [{ label: "rs", type: "variable", detail: "the survey api", info: "rs.listen, rs.getAnswer, rs.addClass … (type rs. for the list)" }, { label: "document", type: "variable", detail: "the page (a sandboxed mirror)", info: "querySelector with the page hooks" }] };
}
