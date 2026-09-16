import type { SurveyDefinition, Question, Option } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { findLoopScope, getQuestionByCodeOrVar, lookupAnswer, loopValue } from "./state.js";
import { flattenVariables } from "./flatten.js";
import { evaluateExpression } from "./calc.js";
import { escapeHtml } from "./html.js";
import { isGeoAnswer, geoText, round6, formatMetres } from "./geo.js";
import { interviewText, isInterviewAnswer } from "./interview.js";
import { isOtherOption, otherOptions, otherTextFor } from "./otherSpecify.js";
import {
  PIPE_TOKEN_RE,
  parsePipeBody,
  formatPipeValues,
  type PipeToken,
} from "./pipingTokens.js";
import { embeddedCatalog } from "./embedded.js";

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
 *   {{Q1.other}}           what they typed in the first "Other, specify" box
 *   {{Q1[97].other}}       what they typed in option 97's box, specifically
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

/**
 * FIRST / LAST / Nth row & option addressing (`evaluate.ts`'s
 * `resolveSourceValue`, for `ConditionSource.rowPosition` / `optionPosition`)
 * needs the question's EFFECTIVE, carry-forward resolved list, which lives in
 * `carryforward.ts`.
 *
 * Registered HERE rather than inside `evaluate.ts` itself, even though this
 * is only consumed by `evaluate.ts`: `evaluate.ts` sits on a real runtime
 * cycle (evaluate.ts -> countCondition.ts -> carryforward.ts -> evaluate.ts,
 * via `evaluateCount`/`effectiveQuestion`), so a registration call made from
 * carryforward.ts's own top level reaching back into a `let` inside
 * evaluate.ts can hit that variable before evaluate.ts has finished its own
 * module initialization, depending on which module in the cycle happens to
 * load first (`ReferenceError: Cannot access '...' before initialization`).
 * `piping.ts` has no runtime edge back to `evaluate.ts` — only a type import,
 * erased at compile time — so it is a safe, cycle-free place for both
 * `evaluate.ts` and `carryforward.ts` to share this without either importing
 * the other.
 */
type EffectiveListsResolver = (
  q: Question,
  ctx: EvalContext,
) => { rows: { code: string | number }[]; options: { code: string | number }[] };
let effectiveListsResolver: EffectiveListsResolver | null = null;
export function registerEffectiveRowsResolver(fn: EffectiveListsResolver): void {
  effectiveListsResolver = fn;
}
export function getEffectiveListsResolver(): EffectiveListsResolver | null {
  return effectiveListsResolver;
}

/**
 * "Does this bare `{{NAME}}` reach anything?" — the SAME predicate
 * `lintSurveyLogic` uses, reached through a registration hook rather than an
 * import.
 *
 * The import was the obvious spelling and it deadlocks the package:
 * `lintLogic` reaches `carryforward`, `carryforward` registers itself here on
 * load, and `piping` importing `lintLogic` closes that into a cycle whose
 * initialisation order depends on which module is entered first — the exact
 * `Cannot access '...' before initialization` the long comment above this
 * describes. `lintLogic` registers itself instead, the same way
 * `carryforward` already does, and nothing new imports anything.
 *
 * Unregistered (a deep import of this module alone, outside the package
 * barrel), the answer is "no" and the lint falls back to checking questions
 * only — what it did before this existed.
 */
type BareNameResolver = (def: SurveyDefinition, name: string, q?: Question) => boolean;
let bareNameResolver: BareNameResolver | null = null;
export function registerBareNameResolver(fn: BareNameResolver): void {
  bareNameResolver = fn;
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
    const l = findLoopScope(ctx.loop, t.scope);
    if (!l) return "";
    const v = loopValue(l, t.ref || "label");
    // escaped like every other branch — this was the one pipe that was not,
    // and a reference column is programmer-entered text landing in HTML
    return v == null ? "" : escapeHtml(String(v));
  }

  const q = getQuestionByCodeOrVar(ctx.def, t.ref);
  /*
   * `{{brand.Category}}` — an OUTER loop addressed by its loopVar (§32). The
   * parser cannot tell a loopVar from a question code, so it parses this as a
   * question token; here, where the loop stack is known, a ref that is no
   * question but IS the name of a loop on the stack is the loop. A ref that is
   * neither renders "" exactly as an unknown question always has.
   */
  if (!q && t.kind === "question") {
    const scoped = findLoopScope(ctx.loop, t.ref);
    if (scoped) {
      // the "property" is whatever followed the dot — a reference column name
      // is not one of the question properties, and that is fine here
      const v = loopValue(scoped, String(t.property));
      return v == null ? "" : escapeHtml(String(v));
    }
  }
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

  // this iteration's answer first, then each enclosing iteration's, then the
  // survey-level one — the one rule for every loop-scoped read
  let value: unknown = lookupAnswer(ctx.state.answers, q.id, ctx.loop);

  /*
   * `{{Q1.other}}` / `{{Q1[97].other}}` — the text in one Other box, read
   * BEFORE the row-code narrowing below, because for this property the
   * bracket holds an option code rather than a row.
   */
  if (t.property === "other") {
    const flagged = otherOptions(q);
    if (!flagged.length) return "";
    const code = t.rowCode ?? String(flagged[0]!.code);
    return escapeHtml(otherTextFor(ctx.state, q, code, ctx.loop ?? null));
  }

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
  /**
   * A COUNT IS A NUMBER, WHATEVER THE ANSWER IS.
   *
   * It sat below the `value == null` guard and above `codes = [value]`, so it
   * managed to be wrong in both directions at once: an unanswered question
   * piped "" — not a number at all — while a question holding an empty string
   * piped "1", counting a selection nobody made. Both are §3's "values must
   * not be converted into one another", seen from the counting side.
   *
   * Nothing selected is 0. One scalar answer is 1. An array is its length.
   */
  if (t.property === "count") {
    if (value == null || value === "") return "0";
    if (Array.isArray(value)) return String(value.length);
    if (typeof value === "object") return String(Object.values(value as Record<string, unknown>).filter((v) => v != null && v !== "").length);
    return "1";
  }
  if (value == null) return "";

  // a place: the address or "lat,lng"; {{Q1.lat}} / {{Q1.lng}} / {{Q1.address}} / {{Q1.city}} / {{Q1.radius}} for the parts
  if (q.type === "geo" && isGeoAnswer(value)) {
    const g = value;
    switch (t.property) {
      case "lat": return g.lat == null ? "" : String(round6(g.lat));
      case "lng": return g.lng == null ? "" : String(round6(g.lng));
      case "address": return escapeHtml(g.address?.formatted ?? "");
      case "city": return escapeHtml(g.address?.city ?? "");
      case "country": return escapeHtml(g.address?.country ?? "");
      case "radius": return g.radiusM == null ? "" : formatMetres(g.radiusM);
      default: return escapeHtml(geoText(g));
    }
  }

  /*
   * An interview pipes as what was SAID. `{{Q5}}` inside a follow-up probe
   * reads the transcript, which is the only part of the record a sentence
   * can be built from — a signed URL piped into a question would be both
   * meaningless and a leak.
   */
  if (q.type === "video_interview" && isInterviewAnswer(value)) {
    return escapeHtml(interviewText(value));
  }

  const codes = Array.isArray(value) ? value : [value];

  /**
   * WHAT A SELECTED "OTHER" PIPES.
   *
   * This is the bug the brief calls Others Specify piping. `{{Q1.other}}` has
   * always worked; what nobody could make work was `{{Q1}}` — the token every
   * researcher reaches for first, and the one the picker offers first. A
   * respondent who ticked Other and typed "Tesla Model Y" saw the next
   * question ask about "Other, please specify", because a selected code was
   * resolved to its option LABEL and an other-specify option's label is the
   * invitation to type, never the thing typed.
   *
   * So a flagged option resolves to the respondent's own words when there are
   * any. With an empty box it stays the label: the option IS selected, and
   * piping nothing would lose that fact — an empty box is handled by
   * `{{Q1.other}}`, whose whole contract (§3) is to give back exactly what is
   * in the box, `""` included.
   *
   * `.value` and `.code` are deliberately untouched: they are the stored
   * code, which is how a programmer distinguishes the four things an option
   * has — id, code, label, other text — and a piped code that silently became
   * free text would break every exported cross-break.
   */
  const labelOrOther = (c: unknown): string => {
    const opt = (q.options ?? []).find((o) => String(o.code) === String(c));
    if (opt && isOtherOption(opt)) {
      const text = otherTextFor(ctx.state, q, opt.code, ctx.loop ?? null).trim();
      if (text) return escapeHtml(text);
    }
    return labelFor(ctx.def, q, c);
  };

  switch (t.property) {
    case "value":
    case "code":
      return fmt(codes.map((c) => escapeHtml(String(c))));
    case "first":
      return labelOrOther(codes[0]);
    case "last":
      return labelOrOther(codes[codes.length - 1]);
    case "rank":
      return fmt(codes.map((c) => labelOrOther(c)));
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
      return fmt(codes.map((c) => labelOrOther(c)));
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

/**
 * Find unresolved / malformed tokens — used by Studio validation, live, as
 * someone types question text.
 *
 * A bare `{{NAME}}` parses as `kind: "question"` because that is the common
 * case, but the flat variable map a pipe actually resolves against carries
 * more than questions: calculations, embedded fields, `LISTFILL_*`,
 * `LOOP_*`, and a loop's own variable. This used to check only the question
 * list and so underlined every one of those as unknown — a warning on a
 * token that pipes correctly, which teaches a programmer to ignore the
 * warnings. `bareNameResolves` is the same predicate `lintSurveyLogic` uses,
 * so the two linters cannot disagree about what resolves.
 *
 * Pass `q` when the text belongs to a question: it is what lets `{{brand}}`
 * be recognised as the enclosing loop's variable for that question and not
 * for one outside it.
 */
export function lintPipingTokens(def: SurveyDefinition, text: string, q?: Question): string[] {
  const problems: string[] = [];
  for (const m of text.matchAll(PIPE_TOKEN_RE)) {
    const t = parsePipeBody(m[1], m[0]);
    if (!t) {
      problems.push(`Malformed piping token "${m[0]}"`);
      continue;
    }
    if (t.kind === "calc") {
      if (!(def.calculations ?? []).some((c) => c.targetVariable === t.ref)) {
        problems.push(`No calculation named "${t.ref}"`);
      }
      continue;
    }
    if (t.kind === "embedded") {
      /*
       * The catalog, not `def.embeddedData` — see `embeddedNames` in
       * lintLogic. The registry is empty in every survey the Studio has ever
       * produced, so checking it told programmers their own embedded fields
       * did not exist while they were typing.
       */
      if (!embeddedCatalog(def).some((e) => e.name === t.ref)) {
        problems.push(`No embedded data field named "${t.ref}"`);
      }
      continue;
    }
    if (t.kind !== "question") continue;
    if (!getQuestionByCodeOrVar(def, t.ref) && !(bareNameResolver?.(def, t.ref, q) ?? false)) {
      problems.push(`Unknown piping reference "${t.ref}"`);
    }
  }
  return problems;
}
