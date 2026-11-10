import type { LoopReferenceColumn, Question, SurveyDefinition } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { resolvePiping } from "./piping.js";
import { safeExpression } from "./calcContext.js";
import { isOtherOption } from "./otherSpecify.js";
import { loopNodes } from "./loopModel.js";
import { coerceReference } from "./loops.js";
import {
  getQuestionByCodeOrVar, lookupAnswer, registerLoopReferenceResolver,
  type LoopContext, type LoopReferenceEnv, type LoopReferenceValue,
} from "./state.js";

/**
 * DYNAMIC LOOP REFERENCES (2026-11-10) — a reference column whose value is not typed into the loop's table but
 * resolved for the current iteration, at the moment it is read.
 *
 * A column's `source` says where the value comes from (schema flow.ts `LoopReferenceSource`): text with piping, a
 * calculation, a question's answer (value, label, Other text, or as displayed), the loop's own item (label, code, the
 * Other text typed for it, or displayed), or a variable. Everything is resolved through the engines that already
 * answer those questions elsewhere — `resolvePiping` for text and labels, `safeExpression` for calculations,
 * `lookupAnswer` for values — so a reference can never mean something different from the same value piped directly.
 *
 * The resolver is registered with `state.ts`'s `loopValue`, which every reader goes through (piping, conditions,
 * calculations, set expressions, scripts): `{{loop.Name}}` reads the live value wherever the survey and the
 * respondent's data are known. `loopContexts` also stores each dynamic value as of the last compile in the context's
 * `references`, which is what ordering by a column, positional exports and the script sandbox read.
 *
 * A reference may read another (a text column piping `{{loop.Other_Col}}`); a cycle is cut at a fixed depth and reads
 * as empty rather than hanging the page.
 */

const MAX_DEPTH = 6;
let depth = 0;

/** piping returns HTML (values escaped); a reference is text, escaped again where it is piped — decode once here */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

const pipe = (text: string, ctx: EvalContext): string => htmlToText(resolvePiping(text, ctx));

/** the codes of an answer, whatever its shape (single, multi, ranking object) */
function codesOf(v: unknown): string[] {
  if (v === undefined || v === null || v === "") return [];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "object") return Object.keys(v as object);
  return [String(v)];
}

/** an answer as the respondent saw it: each chosen option's (piped) label — or, for an "Other" choice with text, the text */
function displayedAnswer(q: Question, ctx: EvalContext, join: string): string {
  const raw = lookupAnswer(ctx.state.answers, q.id, ctx.loop ?? null);
  if (!q.options.length) return raw === undefined || raw === null ? "" : Array.isArray(raw) ? raw.join(join) : String(raw);
  const parts: string[] = [];
  for (const code of codesOf(raw)) {
    const opt = q.options.find((o) => String(o.code) === code);
    if (!opt) { parts.push(code); continue; }
    if (isOtherOption(opt)) {
      const typed = pipe(`{{${q.code}[${code}].other}}`, ctx).trim();
      if (typed) { parts.push(typed); continue; }
    }
    parts.push(pipe(opt.label, ctx));
  }
  return parts.join(join);
}

/** the question a loop iterates over, when its source is a question */
function loopSourceQuestion(def: SurveyDefinition, loopId: string | undefined): Question | null {
  if (!loopId) return null;
  const node = loopNodes(def).find((x) => x.node.id === loopId)?.node;
  if (!node || node.source.kind !== "question") return null;
  const qid = node.source.questionId;
  return def.questions.find((q) => q.id === qid) ?? null;
}

/** one dynamic column's value for one iteration */
export function resolveReferenceColumn(env: LoopReferenceEnv, loop: LoopContext, col: LoopReferenceColumn): LoopReferenceValue {
  const s = col.source;
  if (!s || s.kind === "static") return coerceReference(loop.references?.[col.name], col);
  if (depth >= MAX_DEPTH) return null;
  depth++;
  try {
    const ctx: EvalContext = { def: env.def, state: env.state, loop, quotaCounts: env.quotaCounts };
    let raw: unknown = null;
    switch (s.kind) {
      case "text":
        raw = pipe(s.text, ctx);
        break;
      case "calculation":
        raw = safeExpression(s.expr, env.def, env.state, loop);
        break;
      case "answer": {
        const q = getQuestionByCodeOrVar(env.def, s.question);
        if (!q) { raw = null; break; }
        const join = s.join ?? ", ";
        switch (s.part ?? "displayed") {
          case "value": {
            const v = lookupAnswer(env.state.answers, q.id, loop);
            raw = Array.isArray(v) ? v.join(join) : v && typeof v === "object" ? JSON.stringify(v) : v;
            break;
          }
          case "label": {
            /* the chosen options' labels as programmed (piped) — "Other (please specify)", not what was typed (that is `displayed` / `other`) */
            const v = lookupAnswer(env.state.answers, q.id, loop);
            raw = q.options.length
              ? codesOf(v).map((c) => { const o = q.options.find((x) => String(x.code) === c); return o ? pipe(o.label, ctx) : c; }).join(join)
              : Array.isArray(v) ? v.join(join) : v ?? null;
            break;
          }
          case "other": raw = pipe(`{{${q.code}.other}}`, ctx); break;
          case "displayed": raw = displayedAnswer(q, ctx, join); break;
        }
        break;
      }
      case "item": {
        if (s.part === "code") { raw = loop.code; break; }
        if (s.part === "label") { raw = loop.label; break; }
        /* the Other text typed for THIS item: the source question's box for this code, answered outside the loop */
        const q = loopSourceQuestion(env.def, loop.loopId);
        const opt = q?.options.find((o) => String(o.code) === loop.code);
        const typed = q && opt && isOtherOption(opt)
          ? pipe(`{{${q.code}[${loop.code}].other}}`, { ...ctx, loop: loop.parent ?? null }).trim()
          : "";
        raw = s.part === "other" ? typed : (typed || loop.label);
        break;
      }
      case "variable": {
        const n = s.name;
        if (Object.prototype.hasOwnProperty.call(env.state.calculated, n)) raw = env.state.calculated[n];
        else if (Object.prototype.hasOwnProperty.call(env.state.embedded, n)) raw = env.state.embedded[n];
        else {
          const q = getQuestionByCodeOrVar(env.def, n);
          const v = q ? lookupAnswer(env.state.answers, q.id, loop) : undefined;
          raw = Array.isArray(v) ? v.join(", ") : v ?? null;
        }
        break;
      }
    }
    return coerceReference(raw, col);
  } finally {
    depth--;
  }
}

function resolveByName(env: LoopReferenceEnv, loop: LoopContext, name: string): LoopReferenceValue {
  const col = loop.dynamic?.[name];
  return col ? resolveReferenceColumn(env, loop, col) : null;
}
registerLoopReferenceResolver(resolveByName);

/** a copy of a loop chain with every dynamic reference resolved into `references` — for a snapshot leaving the engine (the script sandbox) */
export function withResolvedReferences(env: LoopReferenceEnv, loop: LoopContext | null): LoopContext | null {
  if (!loop) return null;
  const parent = withResolvedReferences(env, loop.parent ?? null);
  const references = { ...(loop.references ?? {}) };
  if (loop.dynamic) for (const name of Object.keys(loop.dynamic)) references[name] = resolveByName(env, loop, name);
  return { ...loop, references, parent };
}
