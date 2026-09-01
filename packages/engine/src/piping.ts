import type { SurveyDefinition, Question } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { getQuestionByCodeOrVar } from "./state.js";
import { flattenVariables } from "./flatten.js";
import { evaluateExpression } from "./calc.js";
import { escapeHtml } from "./html.js";

/**
 * Piping (requirement §5).
 *
 * Token syntax — usable in question text, instructions, option labels,
 * HTML blocks, end messages and (via ctx.pipe()) custom scripts:
 *
 *   {{Q1}}                 answer label(s) of Q1 (labels for coded questions)
 *   {{Q1.value}}           raw answer code(s)/value
 *   {{Q1.label}}           label(s) — explicit form
 *   {{Q1.labels|join:, }}  multi-select labels with custom joiner
 *   {{Q1.count}}           number of selections
 *   {{Q1.first}} {{Q1.last}}
 *   {{Q1[2].label}}        label of the row "2" answer (matrix/composite)
 *   {{calc.TOTAL_SCORE}}   calculated variable
 *   {{ed.PANEL_ID}}        embedded data
 *   {{loop.label}} {{loop.code}} {{loop.index}}
 *   {{expr: Q1 + Q2}}      inline calc-DSL expression
 */

const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

export function resolvePiping(text: string, ctx: EvalContext): string {
  if (!text || !text.includes("{{")) return text;
  return text.replace(TOKEN_RE, (_m, raw: string) => {
    try {
      return renderToken(raw, ctx);
    } catch {
      return "";
    }
  });
}

function renderToken(raw: string, ctx: EvalContext): string {
  // {{expr: ...}}
  if (raw.startsWith("expr:")) {
    const flat = flattenVariables(ctx.def, ctx.state);
    const v = evaluateExpression(raw.slice(5).trim(), {
      resolver: (n) => flat[n],
      names: () => Object.keys(flat),
    });
    return v == null ? "" : escapeHtml(String(v));
  }

  // split off |join:xxx modifier
  let joiner = ", ";
  let body = raw;
  const pipeIdx = raw.indexOf("|");
  if (pipeIdx >= 0) {
    body = raw.slice(0, pipeIdx).trim();
    const mod = raw.slice(pipeIdx + 1).trim();
    if (mod.startsWith("join:")) joiner = mod.slice(5);
  }

  // namespaces
  if (body.startsWith("calc.")) {
    const v = ctx.state.calculated[body.slice(5)];
    return v == null ? "" : escapeHtml(String(v));
  }
  if (body.startsWith("ed.") || body.startsWith("embedded.")) {
    const v = ctx.state.embedded[body.split(".").slice(1).join(".")];
    return v == null ? "" : escapeHtml(String(v));
  }
  if (body.startsWith("loop.")) {
    const l = ctx.loop;
    if (!l) return "";
    const f = body.slice(5);
    return f === "code" ? l.code : f === "index" ? String(l.index) : l.label;
  }

  // question reference: REF | REF.field | REF[row].field
  const m = body.match(/^([A-Za-z0-9_]+)(?:\[([^\]]+)\])?(?:\.([A-Za-z_]+))?$/);
  if (!m) return "";
  const [, ref, rowCode, fieldRaw] = m;
  const field = fieldRaw ?? "label";

  const q = getQuestionByCodeOrVar(ctx.def, ref);
  if (!q) {
    // fall back to flat variable map (covers calculated & embedded by name)
    const flat = flattenVariables(ctx.def, ctx.state);
    const v = flat[ref];
    return v == null ? "" : escapeHtml(Array.isArray(v) ? v.join(joiner) : String(v));
  }

  const loopKey = ctx.loop ? `${q.id}@${ctx.loop.code}` : null;
  let value: unknown =
    (loopKey ? ctx.state.answers[loopKey] : undefined) ?? ctx.state.answers[q.id];

  if (rowCode != null && value && typeof value === "object" && !Array.isArray(value)) {
    value = (value as Record<string, unknown>)[rowCode];
  }
  if (value == null) return "";

  const codes = Array.isArray(value) ? value : [value];

  switch (field) {
    case "value":
    case "code":
      return codes.map((c) => escapeHtml(String(c))).join(joiner);
    case "count":
      return String(codes.length);
    case "first":
      return labelFor(ctx.def, q, codes[0]);
    case "last":
      return labelFor(ctx.def, q, codes[codes.length - 1]);
    case "label":
    case "labels":
    default:
      if (typeof value === "object" && !Array.isArray(value)) {
        // whole matrix/composite object without row — join row summaries
        return Object.entries(value as Record<string, unknown>)
          .map(([r, v]) => `${rowLabelFor(q, r)}: ${escapeHtml(String(v))}`)
          .join(joiner);
      }
      return codes.map((c) => labelFor(ctx.def, q, c)).join(joiner);
  }
}

/** Resolve an option label, following carry-forward to the source question
 *  when the question's own option list is dynamic. */
function labelFor(def: SurveyDefinition, q: Question, code: unknown): string {
  const seen = new Set<string>();
  let cur: Question | undefined = q;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const opt = cur.options.find((o) => String(o.code) === String(code));
    if (opt) return opt.label;
    const row = cur.rows.find((r) => String(r.code) === String(code));
    if (row) return row.label;
    cur = cur.carryForward
      ? def.questions.find((x) => x.id === cur!.carryForward!.sourceQuestionId)
      : undefined;
  }
  // no matching definition label: the value is respondent-derived free text
  return code == null ? "" : escapeHtml(String(code));
}

function rowLabelFor(q: Question, rowCode: string): string {
  const row = q.rows.find((r) => String(r.code) === rowCode);
  return row ? row.label : rowCode;
}

/** Find unresolved / malformed tokens — used by Studio validation. */
export function lintPipingTokens(def: SurveyDefinition, text: string): string[] {
  const problems: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const body = m[1].split("|")[0].trim();
    if (body.startsWith("expr:") || body.startsWith("calc.") || body.startsWith("ed.") || body.startsWith("loop.")) continue;
    const ref = body.match(/^([A-Za-z0-9_]+)/)?.[1];
    if (ref && !getQuestionByCodeOrVar(def, ref)) {
      problems.push(`Unknown piping reference "${ref}"`);
    }
  }
  return problems;
}
