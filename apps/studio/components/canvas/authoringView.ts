import type { Question, SurveyDefinition } from "@rescript/schema";
import { effectiveQuestion, resolvePiping, type EvalContext } from "@rescript/engine";

/**
 * AUTHORING VIEW vs RESPONDENT SIMULATION — the same question, two readings.
 *
 * A programmer needs to see the structure they are programming: every option,
 * row and column, including the ones today's logic would hide. A respondent
 * needs to see the result of that logic. The canvas offers both, and this
 * module is the difference between them.
 *
 * Authoring renders a NEUTRALISED copy — display conditions, masking, carry
 * forward, list logic, punches and randomization switched off — so the whole
 * structure reaches the DOM and every part of it is clickable. The real logic
 * is then evaluated separately and reported as annotations, which is how an
 * option can be both visible to the programmer and marked "hidden by logic".
 *
 * Nothing here mutates the survey: every function returns a copy, and the copy
 * exists only for the duration of a render. The definition the programmer is
 * editing is untouched, so what is saved is always what they programmed.
 */

/** Everything the canvas needs to annotate one rendered question. */
export interface AuthoringAnnotations {
  /** option codes the current logic + sample answers would hide */
  hiddenOptions: Set<string>;
  /** row codes the current logic would hide */
  hiddenRows: Set<string>;
  /** column ids the current logic would hide */
  hiddenColumns: Set<string>;
  /** option codes carrying any programming (logic, flags, conditions) */
  programmedOptions: Set<string>;
  programmedRows: Set<string>;
  programmedColumns: Set<string>;
  /** the order the respondent would actually see, when randomization moves it */
  randomized: boolean;
}

const codesOf = (xs: { code: string | number }[]) => new Set(xs.map((x) => String(x.code)));

/**
 * A copy of the question with everything conditional switched off.
 *
 * The renderer runs `effectiveQuestion` internally — that is the point, it is
 * the respondent's renderer — so the only way to get a hidden option onto the
 * screen is to hand the renderer a question in which nothing is hidden.
 */
export function neutralised(q: Question): Question {
  const clean = <T extends { visibleIf?: unknown; logic?: unknown }>(x: T): T => {
    if (x.visibleIf === undefined && x.logic === undefined) return x;
    const { visibleIf: _v, logic: _l, ...rest } = x as Record<string, unknown>;
    return rest as T;
  };
  /* Carry-forward is deliberately KEPT. It is not a way of hiding things, it
     is where the question's options or rows come from — a carry-forward matrix
     has no rows of its own, so switching it off would empty the canvas of the
     very structure the programmer came to program. What is switched off is
     everything that FILTERS: conditions, option logic, masking, list logic,
     list operations, punches and randomization. */
  return {
    ...q,
    options: q.options.map(clean),
    rows: q.rows.map(clean),
    columns: q.columns.map(clean),
    mask: undefined,
    listLogic: [],
    optionPipeline: [],
    punches: [],
    randomization: q.randomization ? { ...q.randomization, enabled: false } : q.randomization,
  };
}

/**
 * A carry-forward question has no items of its own: it takes them from an
 * earlier answer. With no answer yet — which is the normal state while
 * programming — the engine correctly produces nothing, and the programmer is
 * shown an empty grid they cannot click.
 *
 * So when authoring, and only when the real pipeline came back empty, the
 * source question's own items stand in. They are the items that WILL arrive,
 * they carry the same codes, and seeing them is the difference between
 * programming a matrix and guessing at one. Giving the simulator a sample
 * answer replaces them with the genuine carried set.
 */
export function withCarriedFallback(q: Question, def: SurveyDefinition, ctx: EvalContext): Question {
  const cf = q.carryForward;
  if (!cf || cf.into === "columns") return q;
  const src = def.questions.find((x) => x.id === cf.sourceQuestionId);
  if (!src?.options.length) return q;

  let live: { options: unknown[]; rows: unknown[] };
  try {
    const v = effectiveQuestion(q, ctx);
    live = { options: v.options, rows: v.rows };
  } catch {
    live = { options: [], rows: [] };
  }

  /* The stand-in items have to REPLACE the carry-forward, not sit beside it:
     the engine reads carry-forward first and ignores the question's own list,
     so leaving it in place would hand back the empty set again. */
  if (cf.into === "rows" && live.rows.length === 0) {
    return {
      ...q,
      carryForward: undefined,
      rows: src.options.map((o) => ({
        code: o.code, label: o.label, flags: [], validation: [], required: false,
      })) as Question["rows"],
    };
  }
  if (cf.into === "options" && live.options.length === 0) {
    return {
      ...q,
      carryForward: undefined,
      options: src.options.map((o) => ({ code: o.code, label: o.label, flags: [] })) as Question["options"],
    };
  }
  return q;
}

/**
 * Run the REAL pipeline to find out what a respondent would be shown, and what
 * carries programming — the annotations the authoring view draws on top.
 */
export function annotate(q: Question, ctx: EvalContext): AuthoringAnnotations {
  let view: ReturnType<typeof effectiveQuestion>;
  try {
    view = effectiveQuestion(q, ctx);
  } catch {
    // a half-written condition must not blank the canvas — show everything
    view = { options: q.options, rows: q.rows, columns: q.columns };
  }
  const visibleO = codesOf(view.options);
  const visibleR = codesOf(view.rows);
  const visibleC = new Set(view.columns.map((c) => c.id));

  const programmed = <T extends { logic?: unknown; visibleIf?: unknown; flags?: unknown[] }>(x: T) =>
    x.logic !== undefined || x.visibleIf !== undefined || (Array.isArray(x.flags) && x.flags.length > 0);

  return {
    hiddenOptions: new Set(q.options.map((o) => String(o.code)).filter((c) => !visibleO.has(c))),
    hiddenRows: new Set(q.rows.map((r) => String(r.code)).filter((c) => !visibleR.has(c))),
    hiddenColumns: new Set(q.columns.map((c) => c.id).filter((id) => !visibleC.has(id))),
    programmedOptions: new Set(q.options.filter(programmed).map((o) => String(o.code))),
    programmedRows: new Set(q.rows.filter(programmed).map((r) => String(r.code))),
    programmedColumns: new Set(q.columns.filter((c) => c.visibleIf !== undefined || c.expression).map((c) => c.id)),
    randomized: !!q.randomization?.enabled,
  };
}

const TOKEN = /\{\{([^{}]+)\}\}/g;

/**
 * Show piping honestly while authoring.
 *
 * A token that resolves against the sample answers is left to the renderer, so
 * the programmer sees the real substitution. A token with nothing behind it
 * would otherwise resolve to empty and the text would silently lose a word, so
 * it is replaced with a marked chip carrying the token's own name — visible,
 * obviously a placeholder, and impossible to mistake for respondent data.
 */
export function markPiping(text: string, ctx: EvalContext): string {
  if (!text || !text.includes("{{")) return text;
  return text.replace(TOKEN, (whole, body: string) => {
    let resolved = "";
    try {
      resolved = resolvePiping(whole, ctx);
    } catch {
      resolved = "";
    }
    if (resolved.trim()) return whole; // real value — let the renderer pipe it
    return `<span class="lc-pipe" data-lc-pipe="${String(body).trim().replace(/"/g, "&quot;")}">${String(body).trim()}</span>`;
  });
}

/** Apply the authoring reading of piping to the parts of a question that pipe. */
export function withMarkedPiping(q: Question, ctx: EvalContext): Question {
  const t = markPiping(q.text, ctx);
  const i = q.instruction ? markPiping(q.instruction, ctx) : q.instruction;
  const opts = q.options.some((o) => o.label.includes("{{"))
    ? q.options.map((o) => (o.label.includes("{{") ? { ...o, label: markPiping(o.label, ctx) } : o))
    : q.options;
  const rows = q.rows.some((r) => r.label.includes("{{"))
    ? q.rows.map((r) => (r.label.includes("{{") ? { ...r, label: markPiping(r.label, ctx) } : r))
    : q.rows;
  // content blocks pipe through customHtml, which is what their renderer draws
  const html = q.customHtml ? markPiping(q.customHtml, ctx) : q.customHtml;
  if (t === q.text && i === q.instruction && opts === q.options && rows === q.rows && html === q.customHtml) return q;
  return { ...q, text: t, instruction: i, options: opts, rows, customHtml: html };
}

/** Questions whose answers this one depends on — what the simulator asks for. */
export function sampleTargets(def: SurveyDefinition, q: Question): Question[] {
  const ids = new Set<string>();
  const scan = (v: unknown) => {
    if (!v) return;
    const s = JSON.stringify(v);
    for (const m of s.matchAll(/"(?:questionId|sourceQuestionId|ref|left)"\s*:\s*"([^"]+)"/g)) ids.add(m[1]);
    for (const m of s.matchAll(/\{\{\s*([A-Za-z0-9_]+)/g)) ids.add(m[1]);
  };
  scan(q.displayLogic); scan(q.options); scan(q.rows); scan(q.columns);
  scan(q.carryForward); scan(q.mask); scan(q.listLogic); scan(q.punches);
  scan(q.optionPipeline); scan(q.validation); scan(q.text); scan(q.instruction);
  const out: Question[] = [];
  for (const other of def.questions) {
    if (other.id === q.id) continue;
    if (ids.has(other.id) || ids.has(other.code) || ids.has(other.variableName)) out.push(other);
  }
  return out;
}
