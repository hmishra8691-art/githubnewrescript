import type { SurveyDefinition, Question, Option } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { getQuestionByCodeOrVar } from "./state.js";
import { flattenVariables } from "./flatten.js";
import { evaluateExpression } from "./calc.js";
import { escapeHtml } from "./html.js";
import {
  PIPE_TOKEN_RE,
  parsePipeBody,
  formatPipeValues,
  type PipeToken,
} from "./pipingTokens.js";

/**
 * Piping (requirement §5, extended by §16–25).
 *
 * Token syntax — usable in question text, instructions, option labels,
 * HTML blocks, end messages and (via ctx.pipe()) custom scripts:
 *
 *   {{Q1}}                 answer label(s) of Q1 (labels for coded questions)
 *   {{Q1.value}}           raw answer code(s)/value
 *   {{Q1.label}}           label(s) — explicit form
 *   {{Q1.labels|join:, }}  multi-select labels with custom joiner
 *   {{Q1.labels|and}}      "Apple, Orange and Banana"        (req §25)
 *   {{Q1.labels|bullets}}  bulleted list
 *   {{Q1.count}}           number of selections
 *   {{Q1.first}} {{Q1.last}}
 *   {{Q1.rank}}            ranking order, best first
 *   {{Q1.displayed}}       options Q1 actually showed this respondent
 *   {{Q1.remaining}}       options shown but not selected
 *   {{Q1[2].label}}        label of the row "2" answer (matrix/composite)
 *   {{calc.TOTAL_SCORE}}   calculated variable
 *   {{ed.PANEL_ID}}        embedded data
 *   {{loop.label}} {{loop.code}} {{loop.index}}
 *   {{expr: Q1 + Q2}}      inline calc-DSL expression
 *
 * The structured form of these tokens lives in `pipingTokens.ts`; the visual
 * builder in Studio composes descriptors and serialises them here.
 */

/**
 * `displayed` / `remaining` need the option pipeline, which itself needs
 * piping to resolve labels. Rather than importing in a circle, the pipeline
 * registers itself here on load.
 */
type DisplayedResolver = (q: Question, ctx: EvalContext) => Option[];
let displayedResolver: DisplayedResolver | null = null;
export function registerDisplayedOptionsResolver(fn: DisplayedResolver): void {
  displayedResolver = fn;
}

export function resolvePiping(text: string, ctx: EvalContext): string {
  if (!text || !text.includes("{{")) return text;
  return text.replace(PIPE_TOKEN_RE, (_m, raw: string) => {
    try {
      const token = parsePipeBody(raw);
      return token ? renderToken(token, ctx) : "";
    } catch {
      return "";
    }
  });
}

/**
 * The set of option codes an answer represents, whatever its shape:
 * an array (multi / ranking), a scalar (single), or an object.
 *
 * Object answers come in two flavours — allocation and composite key their
 * entries BY option code, matrices key them by row code and store the chosen
 * option code as the value — so both sides of each entry count.
 */
function selectedCodes(value: unknown): Set<string> {
  if (value === null || value === undefined || value === "") return new Set();
  if (Array.isArray(value)) return new Set(value.map((c) => String(c)));
  if (typeof value === "object") {
    const out = new Set<string>();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined || v === "") continue;
      out.add(k);
      if (Array.isArray(v)) v.forEach((x) => out.add(String(x)));
      else if (typeof v !== "object") out.add(String(v));
    }
    return out;
  }
  return new Set([String(value)]);
}

function renderToken(t: PipeToken, ctx: EvalContext): string {
  const joiner = t.joiner ?? ", ";
  const fmt = (parts: string[]) => formatPipeValues(parts, t.format, joiner);

  if (t.kind === "expr") {
    const flat = flattenVariables(ctx.def, ctx.state);
    const v = evaluateExpression(t.ref, {
      resolver: (n) => flat[n],
      names: () => Object.keys(flat),
    });
    return v == null ? "" : escapeHtml(String(v));
  }
  if (t.kind === "calc") {
    const v = ctx.state.calculated[t.ref];
    return v == null ? "" : escapeHtml(String(v));
  }
  if (t.kind === "embedded") {
    const v = ctx.state.embedded[t.ref];
    return v == null ? "" : escapeHtml(String(v));
  }
  if (t.kind === "loop") {
    const l = ctx.loop;
    if (!l) return "";
    return t.ref === "code" ? l.code : t.ref === "index" ? String(l.index) : l.label;
  }

  const q = getQuestionByCodeOrVar(ctx.def, t.ref);
  if (!q) {
    // fall back to flat variable map (covers calculated & embedded by name)
    const flat = flattenVariables(ctx.def, ctx.state);
    const v = flat[t.ref];
    if (v == null) return "";
    // the joiner is escaped too — it lands in rendered HTML like any other text
    return Array.isArray(v)
      ? formatPipeValues(v.map((x) => escapeHtml(String(x))), t.format, escapeHtml(joiner))
      : escapeHtml(String(v));
  }

  const loopKey = ctx.loop ? `${q.id}@${ctx.loop.code}` : null;
  let value: unknown =
    (loopKey ? ctx.state.answers[loopKey] : undefined) ?? ctx.state.answers[q.id];

  if (t.rowCode != null && value && typeof value === "object" && !Array.isArray(value)) {
    value = (value as Record<string, unknown>)[t.rowCode];
  }

  // list properties are computed from the pipeline, not from the answer alone
  if (t.property === "displayed" || t.property === "remaining") {
    const shown = displayedResolver ? displayedResolver(q, ctx) : q.options;
    const selected = selectedCodes(value);
    const list =
      t.property === "displayed" ? shown : shown.filter((o) => !selected.has(String(o.code)));
    return fmt(list.map((o) => o.label));
  }
  if (value == null) return "";

  const codes = Array.isArray(value) ? value : [value];

  switch (t.property) {
    case "value":
    case "code":
      return fmt(codes.map((c) => escapeHtml(String(c))));
    case "count":
      return String(codes.length);
    case "first":
      return labelFor(ctx.def, q, codes[0]);
    case "last":
      return labelFor(ctx.def, q, codes[codes.length - 1]);
    case "rank":
      return fmt(codes.map((c) => labelFor(ctx.def, q, c)));
    case "label":
    case "labels":
    default:
      if (typeof value === "object" && !Array.isArray(value)) {
        // whole matrix/composite object without row — join row summaries
        return fmt(
          Object.entries(value as Record<string, unknown>).map(
            ([r, v]) => `${rowLabelFor(q, r)}: ${escapeHtml(String(v))}`,
          ),
        );
      }
      return fmt(codes.map((c) => labelFor(ctx.def, q, c)));
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
  for (const m of text.matchAll(PIPE_TOKEN_RE)) {
    const t = parsePipeBody(m[1], m[0]);
    if (!t) {
      problems.push(`Malformed piping token "${m[0]}"`);
      continue;
    }
    if (t.kind !== "question") continue;
    if (!getQuestionByCodeOrVar(def, t.ref)) {
      problems.push(`Unknown piping reference "${t.ref}"`);
    }
  }
  return problems;
}
