/**
 * A headless respondent.
 *
 * Walks a definition exactly the way the runtime's Runner does — start,
 * answer the visible questions, validate, run the page's on_submit scripts,
 * decide pending List Fills, advance — until an end step. Used by the template
 * tests to prove every test path (§53) runs to completion, and exported so a
 * browser suite can compare what it sees against what the engine predicts.
 *
 * Answers come from the path first; anything the path does not mention gets a
 * plausible default for its type, so a required question never blocks the
 * walk for want of an answer that has nothing to do with what is being tested.
 */
import type { LoopContext, QuotaCounts, ListFillCounts, ValidationError } from "@rescript/engine";
import {
  advance, answerKey, applyListFillDestinations, createResponseState, decideListFill, effectiveQuestion, listFillVariables,
  pendingListFills, resolvePiping, runScripts, setAnswer, start, validatePage, visibleQuestions,
} from "@rescript/engine";
import type { Question, SurveyDefinition } from "@rescript/schema";

export interface SimulationOptions {
  /** answers keyed by question id; a function receives the loop context and returns the answer for that iteration */
  answers: Record<string, unknown | ((loop: LoopContext | null, q: Question) => unknown)>;
  seed?: number;
  embedded?: Record<string, string>;
  quotaCounts?: QuotaCounts;
  listFillCounts?: ListFillCounts;
  /** stop after this many pages — a guard, not a feature */
  maxPages?: number;
}

export interface VisitedPage {
  pageId: string;
  loop: LoopContext | null;
  questionIds: string[];
  /** question text after piping, by question id */
  texts: Record<string, string>;
}

export interface SimulationResult {
  state: ReturnType<typeof createResponseState>;
  pages: VisitedPage[];
  endStatus?: string;
  /** validation errors the walk had to stop on, if any */
  blocked?: { pageId: string; errors: ValidationError[] };
  scriptErrors: { pageId: string; errors: { message: string; questionRef?: string }[] }[];
  logs: string[];
  listFills: { listFillId: string; items: { code: string; label: string }[] }[];
}

/** A plausible answer for a question nobody wrote one for. */
export function defaultAnswer(def: SurveyDefinition, q: Question, ctx: { state: SimulationResult["state"]; loop: LoopContext | null }): unknown {
  const view = effectiveQuestion(q, { def, state: ctx.state, loop: ctx.loop });
  const codes = view.options.filter((o) => !o.flags?.includes("exclusive") && !o.flags?.includes("other_specify")).map((o) => o.code);
  const rows = view.rows.map((r) => String(r.code));
  const s = q.settings ?? {};
  const first = codes[0] ?? view.options[0]?.code;
  const min = s.minSelections ?? 1;
  const some = codes.slice(0, Math.max(1, Math.min(min, s.maxSelections ?? codes.length)));
  const cell = (rt: string): unknown => {
    switch (rt) {
      case "single": case "dropdown": return 1;
      case "multi": case "multi_dropdown": case "checkbox": return [1];
      case "numeric": case "slider": return 5;
      case "date": return "2026-02-01";
      case "time": return "12:00";
      case "rank": return [1];
      default: return "ok";
    }
  };
  switch (q.type) {
    case "single_select": case "dropdown": case "experiment": return first;
    case "multi_select": case "multi_dropdown": case "image_select": return some;
    case "numeric": return s.minValue != null && s.maxValue != null ? Math.round((s.minValue + s.maxValue) / 2) : 10;
    case "slider": case "nps": return s.maxValue ?? 10;
    case "open_text": return q.variant === "text.email" ? "demo@example.com" : q.variant === "text.zip" ? "98101" : "Demo answer";
    case "long_text": return "Demo open-ended answer with enough text.";
    case "date": return "2026-02-01";
    case "time": return "12:00";
    case "ranking": case "image_ranking": return codes.slice(0, s.maxSelections ?? codes.length);
    case "matrix_single": case "matrix_dropdown": return Object.fromEntries(rows.map((r) => [r, first]));
    case "matrix_multi": return Object.fromEntries(rows.map((r) => [r, [first]]));
    case "matrix_numeric": return Object.fromEntries(rows.map((r) => [r, 3]));
    case "matrix_text": return Object.fromEntries(rows.map((r) => [r, "ok"]));
    case "allocation": { const t = s.sumTarget ?? 100; return Object.fromEntries(codes.map((c, i) => [String(c), i === 0 ? t : 0])); }
    case "numeric_list": return Object.fromEntries(rows.map((r) => [r, 100]));
    case "text_list": return Object.fromEntries(rows.map((r) => [r, "Demo"]));
    case "composite": case "custom_table": {
      const cols = view.columns.filter((c) => !c.expression && !c.readOnly);
      const share = s.rowSum && s.sumTarget ? s.sumTarget / Math.max(1, cols.length) : null;
      return Object.fromEntries(rows.map((r) => [r, Object.fromEntries(cols.map((c) => [c.id, share != null ? share : cell(c.responseType)]))]));
    }
    case "conjoint_task": {
      const d = def.designs.find((x) => x.id === s.designRef); const out: Record<string, string> = {};
      for (const r of d?.file?.rows ?? []) if (String(r.version ?? "1") === "1") out[String(r.task)] = "1";
      return out;
    }
    case "maxdiff_task": {
      const d = def.designs.find((x) => x.id === s.designRef); const out: Record<string, { best: string; worst: string }> = {};
      for (const r of d?.file?.rows ?? []) {
        if (String(r.version ?? "1") !== "1") continue;
        const t = String(r.task); const idx = String(r.item_index);
        if (!out[t]) out[t] = { best: idx, worst: idx }; else out[t].worst = idx;
      }
      return out;
    }
    case "repeating_group": return [Object.fromEntries(rows.map((r) => [r, r === "cost" ? 12 : r === "since" ? "2025-01-01" : "Demo"]))];
    case "hotspot": return [{ x: 50, y: 50 }];
    case "annotation": return { pins: [{ x: 10, y: 10, comment: "demo" }], strokes: [] };
    case "media_timeline": return [];
    case "upload": return null;
    default: return null;
  }
}

export function simulateRespondent(def: SurveyDefinition, opts: SimulationOptions): SimulationResult {
  const state = createResponseState(def, { seed: opts.seed ?? 1, embedded: opts.embedded ?? {} });
  const quotaCounts = opts.quotaCounts ?? {};
  const lfCounts = opts.listFillCounts ?? {};
  const out: SimulationResult = { state, pages: [], scriptErrors: [], logs: [], listFills: [] };

  const load = runScripts(def, state, "on_load");
  out.logs.push(...load.logs);

  let nav = start(def, state, quotaCounts);
  let guard = 0;
  while (!nav.done && guard++ < (opts.maxPages ?? 400)) {
    const step = nav.steps[nav.stepIndex];
    if (step.kind !== "page") break;
    const loop = step.loop ?? null;
    const visible = visibleQuestions(def, step, state, quotaCounts);
    const visited: VisitedPage = { pageId: step.pageId, loop, questionIds: visible.map((q) => q.id), texts: {} };

    for (const q of visible) {
      if (q.type === "html") continue;
      const key = answerKey(q.id, loop);
      const already = state.answers[key];
      const given = opts.answers[q.id];
      let value: unknown;
      if (typeof given === "function") value = (given as (l: LoopContext | null, q: Question) => unknown)(loop, q);
      else if (given !== undefined) value = given;
      else if (already !== undefined) value = already; // punched / list-fill-written / defaulted earlier
      else value = defaultAnswer(def, q, { state, loop });
      if (value !== undefined && value !== null) {
        setAnswer(def, state, q.id, value, loop);
        const r = runScripts(def, state, "on_change", { scopeRef: q.id, loop });
        out.logs.push(...r.logs);
      }
    }
    // piped texts as the respondent would have seen them
    for (const q of visible) visited.texts[q.id] = resolvePiping(q.text, { def, state, loop, quotaCounts });
    out.pages.push(visited);

    const errors = validatePage(def, visible, { def, state, loop, quotaCounts });
    const scripts = runScripts(def, state, "on_submit", { scopeRef: step.pageId.split("@")[0], loop });
    out.logs.push(...scripts.logs);
    if (scripts.errors.length) out.scriptErrors.push({ pageId: step.pageId, errors: scripts.errors });
    if (errors.length || scripts.errors.length) {
      out.blocked = { pageId: step.pageId, errors: [...errors, ...scripts.errors.map((e) => ({ questionId: e.questionRef ?? "", message: e.message }))] };
      return out;
    }
    for (const lf of pendingListFills(def, state)) {
      const res = decideListFill({ def, listFill: lf, state, counts: lfCounts, quotaCounts });
      Object.assign(state.calculated, listFillVariables(lf, res));
      applyListFillDestinations(lf, res, state);
      out.listFills.push({ listFillId: lf.id, items: res.items.map((it) => ({ code: it.code, label: it.label })) });
    }
    nav = advance(def, state, quotaCounts, { fromPageId: step.pageId });
  }
  out.endStatus = nav.endStatus ?? state.status;
  return out;
}
