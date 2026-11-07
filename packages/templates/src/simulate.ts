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
  pendingListFills, resolvePiping, questionTextTemplate, runScripts, setAnswer, start, validatePage, visibleQuestions, designRowsFor,
  normalizeAcbc, emptyAcbcAnswer, submitByo, submitScreen, answerRule, chooseInTournament, recordDisplayOrders,
} from "@rescript/engine";
import type { AcbcConfig, AcbcAnswer } from "@rescript/engine";
import type { Question, SurveyDefinition } from "@rescript/schema";

/**
 * What an answer function is told when it is asked to produce a value.
 *
 * The loop context and the question were always passed. `state` is the
 * addition, and it is the one that matters for a sampler: a respondent's
 * REAL option list is whatever masking, carry-forward and list fill left
 * them, and `effectiveQuestion(q, { def, state, loop })` is the only way to
 * see it. Without the state a generator would offer answers the respondent
 * was never shown, and the walk would reject them.
 *
 * Additive, so the existing two-argument functions in the test paths keep
 * working untouched.
 */
export interface AnswerContext {
  def: SurveyDefinition;
  state: ReturnType<typeof createResponseState>;
  loop: LoopContext | null;
}

export type AnswerFn = (loop: LoopContext | null, q: Question, ctx: AnswerContext) => unknown;

export interface SimulationOptions {
  /** answers keyed by question id; a function receives the loop context and returns the answer for that iteration */
  answers: Record<string, unknown | AnswerFn>;
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

/*
 * A DEFAULT THAT PASSES THE QUESTION'S OWN RULES (audit 2026-11-07). The simulated respondent — the production-like
 * test, the IM3 simulation — gave every text "Demo answer" and every number 10, so an Essay (min 100 characters),
 * an age question with min_value 18 or a US-state field blocked a survey that is programmed correctly.
 */
/** a form field's value by its declared type (an email field gets an email address, a date field a date) */
function fieldValue(r: { code: string | number; fieldType?: string; label?: string }): unknown {
  const t = String(r.fieldType ?? "").toLowerCase(), c = `${r.code} ${r.label ?? ""}`.toLowerCase();
  if (t === "email" || /e-?mail/.test(c)) return "demo@example.com";
  if (t === "phone" || t === "tel" || /phone|mobile/.test(c)) return "+1 206 555 0100";
  if (t === "date" || /\b(date|from|to|since|start|end)\b/.test(c)) return /\bto\b|end/.test(c) ? "2026-02-09" : "2026-02-02";
  if (t === "integer" || t === "number" || t === "numeric" || t === "currency") return 30;
  if (t === "url" || /website|url/.test(c)) return "https://example.com";
  if (t === "zip" || t === "postal" || /zip|postal/.test(c)) return "98101";
  return "Demo";
}
function numberFor(q: Question): number {
  const s = q.settings ?? {};
  const v = q.validation ?? [];
  const lo = Math.max(...[s.minValue, ...v.filter((r) => r.kind === "min_value").map((r) => Number(r.value))].filter((x): x is number => typeof x === "number" && Number.isFinite(x)), -Infinity);
  const hi = Math.min(...[s.maxValue, ...v.filter((r) => r.kind === "max_value").map((r) => Number(r.value))].filter((x): x is number => typeof x === "number" && Number.isFinite(x)), Infinity);
  if (Number.isFinite(lo) && Number.isFinite(hi)) return Math.round((lo + hi) / 2);
  if (Number.isFinite(lo)) return Math.ceil(lo) + (lo < 10 ? 10 - Math.ceil(lo) : 0);
  if (Number.isFinite(hi)) return Math.min(10, Math.floor(hi));
  return 10;
}
function textFor(q: Question, fallback: string): string {
  const v = q.validation ?? [];
  const has = (k: string) => v.some((r) => r.kind === k);
  if (has("email")) return "demo@example.com";
  if (has("url")) return "https://example.com";
  if (has("zip")) return "98101";
  if (has("phone")) return "+1 206 555 0100";
  if (has("us_state")) return "California";
  if (has("number_only")) return "42";
  if (has("date_format")) { const f = String(v.find((r) => r.kind === "date_format")?.value || "MM/DD/YYYY").toUpperCase(); return f.replace("YYYY", "2026").replace("MM", "02").replace("DD", "01"); }
  let t = has("text_only") ? "Demo answer" : fallback;
  const range = v.find((r) => r.kind === "length_range")?.value as { min?: number; max?: number } | undefined;
  const min = Math.max(0, ...v.filter((r) => r.kind === "min_length").map((r) => Number(r.value) || 0), range?.min ?? 0);
  const max = Math.min(...v.filter((r) => r.kind === "max_length").map((r) => Number(r.value) || Infinity), range?.max ?? Infinity);
  while (t.length < min) t += has("text_only") ? " more words" : " More detail for the simulated respondent.";
  return Number.isFinite(max) ? t.slice(0, max) : t;
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
    /* S5c: a price ladder's answer is one of its prices (or 0) — the middle one, the ladder's own start */
    case "numeric": if (q.variant === "numeric.price_ladder") { const ps = ((s as { priceLadder?: { prices?: number[] } }).priceLadder?.prices ?? []).slice().sort((x, y) => x - y); return ps.length ? ps[Math.floor((ps.length - 1) / 2)] : 0; }
      return numberFor(q);
    case "slider": case "nps": return s.maxValue ?? 10;
    case "open_text": return textFor(q, q.variant === "text.email" ? "demo@example.com" : q.variant === "text.zip" ? "98101" : q.variant === "text.phone" ? "+1 206 555 0100" : q.variant === "text.url" ? "https://example.com" : "Demo answer");
    case "long_text": return textFor(q, "Demo open-ended answer with enough text.");
    /* a Monday (a calendar that books weekdays only accepts it); a date-and-time takes both parts */
    case "date": return q.variant === "datetime.datetime" ? "2026-02-02T12:00" : "2026-02-02";
    case "time": return "12:00";
    case "ranking": case "image_ranking": return codes.slice(0, s.maxSelections ?? codes.length);
    case "matrix_single": case "matrix_dropdown": return Object.fromEntries(rows.map((r) => [r, first]));
    case "matrix_multi": return Object.fromEntries(rows.map((r) => [r, [first]]));
    case "matrix_numeric": return Object.fromEntries(rows.map((r) => [r, 3]));
    case "matrix_text": return Object.fromEntries(rows.map((r) => [r, "ok"]));
    case "allocation": { const t = s.sumTarget ?? 100; return Object.fromEntries(codes.map((c, i) => [String(c), i === 0 ? t : 0])); }
    case "numeric_list": return Object.fromEntries(rows.map((r) => [r, 100]));
    case "text_list": return Object.fromEntries(view.rows.map((r) => [String(r.code), fieldValue(r)]));
    case "composite": case "custom_table": {
      const cols = view.columns.filter((c) => !c.expression && !c.readOnly);
      const share = s.rowSum && s.sumTarget ? s.sumTarget / Math.max(1, cols.length) : null;
      return Object.fromEntries(rows.map((r) => [r, Object.fromEntries(cols.map((c) => [c.id, share != null ? share : cell(c.responseType)]))]));
    }
    case "conjoint_task": {
      // the tasks THIS respondent sees: their design version follows the seed (designVersion.ts), not version 1
      const d = def.designs.find((x) => x.id === s.designRef); const out: Record<string, string> = {};
      for (const r of designRowsFor(q, (d?.file?.rows ?? []) as Record<string, unknown>[], ctx.state.seed, ctx.state.calculated)) out[String(r.task)] = "1";
      return out;
    }
    case "maxdiff_task": {
      const d = def.designs.find((x) => x.id === s.designRef);
      const out: Record<string, { best: string; worst: string; anchor?: string }> = {};
      for (const r of designRowsFor(q, (d?.file?.rows ?? []) as Record<string, unknown>[], ctx.state.seed, ctx.state.calculated)) {
        const t = String(r.task); const idx = String(r.item_index);
        if (!out[t]) out[t] = { best: idx, worst: idx }; else out[t].worst = idx; // first item best, last worst — never the same one
      }
      /*
       * An anchored design asks a follow-up per task (§17). A headless
       * respondent that skips it leaves the question incomplete, so the
       * simulation would report a required-answer failure for a survey that
       * is programmed correctly. "some" is the honest default: it is the
       * modal answer and the one that constrains least.
       */
      if ((d?.config as { anchored?: boolean } | undefined)?.anchored) {
        for (const t of Object.keys(out)) out[t].anchor = "some";
      }
      return out;
    }
    case "acbc_task": {
      /*
       * METHOD-13: an ADAPTIVE exercise has no fixed design rows to answer — it
       * is a stage machine. A headless respondent walks it the same way the
       * renderer does: BYO = each attribute's first level, accept the first
       * concept of every screen, decline every rule, take the first concept of
       * every tournament set — so the answer is complete (`acbcDone`).
       */
      const d = def.designs.find((x) => x.id === s.designRef);
      if (!d || d.kind !== "acbc") return null;
      const cfg = normalizeAcbc((d.config ?? {}) as AcbcConfig);
      if (!cfg.attributes.length) return null;
      const seed = ctx.state.seed;
      const byo = Object.fromEntries(cfg.attributes.filter((a) => a.levels.length).map((a) => [a.name, a.levels[0]]));
      let a: AcbcAnswer = submitByo(cfg, emptyAcbcAnswer(), seed, byo);
      for (let guard = 0; guard < 400 && a.stage !== "done"; guard++) {
        if (a.stage === "screen") {
          const screen = a.screens[a.screens.length - 1];
          const verdicts = Object.fromEntries(screen.concepts.map((c, i) => [c.id, i === 0 ? "yes" : "no"] as const));
          a = submitScreen(cfg, { ...a, screens: [...a.screens.slice(0, -1), { ...screen, verdicts }] }, seed);
        } else if (a.stage === "rule") a = answerRule(cfg, a, seed, false);
        else if (a.stage === "tournament") {
          const round = a.tournament[a.tournament.length - 1];
          if (!round?.concepts.length) break;
          a = chooseInTournament(cfg, a, seed, round.concepts[0].id);
        } else break;
      }
      return a;
    }
    case "repeating_group": return [Object.fromEntries(view.rows.map((r) => [String(r.code), String(r.code) === "cost" ? 12 : String(r.code) === "since" ? "2025-01-01" : fieldValue(r)]))];
    case "hotspot": return [{ x: 50, y: 50 }];
    case "geo": return q.settings.geoMode === "address"
      ? { lat: 51.5007, lng: -0.1246, address: { formatted: "Westminster, London SW1A 0AA, United Kingdom", city: "London", country: "United Kingdom", postal: "SW1A 0AA" }, source: "search" }
      : { lat: 51.5007, lng: -0.1246, ...(q.settings.geoMode === "radius" ? { radiusM: q.settings.radiusDefaultM ?? 5000 } : {}), source: "pin" };
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
    /*
     * A page is answered the way a respondent fills it in: questions that
     * appear BECAUSE of an answer on the same page — a carry-forward list
     * that is empty until its source is chosen, a question whose display
     * logic reads a sibling — are answered too, until nothing new appears.
     * The browser re-renders on every change, so by the time Next is pressed
     * those questions are visible and their rules apply; the server replay
     * (`checkSubmission`) sees the same, and a walk that skipped them would
     * produce a "complete" interview the real runtime refuses.
     */
    /* the Runner writes the page's display orders (ORDER_<ID>) every time it shows it; the server replay does too */
    recordDisplayOrders(def, state, step);
    let visible = visibleQuestions(def, step, state, quotaCounts);
    const visited: VisitedPage = { pageId: step.pageId, loop, questionIds: visible.map((q) => q.id), texts: {} };
    const answeredHere = new Set<string>();
    for (let pass = 0; pass < 5; pass++) {
    for (const q of visible) {
      if (answeredHere.has(q.id)) continue;
      answeredHere.add(q.id);
      if (q.type === "html") continue;
      const key = answerKey(q.id, loop);
      const already = state.answers[key];
      const given = opts.answers[q.id];
      let value: unknown;
      if (typeof given === "function") value = (given as AnswerFn)(loop, q, { def, state, loop });
      else if (given !== undefined) value = given;
      else if (already !== undefined) value = already; // punched / list-fill-written / defaulted earlier
      else value = defaultAnswer(def, q, { state, loop });
      if (value !== undefined && value !== null) {
        setAnswer(def, state, q.id, value, loop);
        const r = runScripts(def, state, "on_change", { scopeRef: [q.id, step.pageId.split("@")[0]], loop });
        out.logs.push(...r.logs);
      }
    }
    const now = visibleQuestions(def, step, state, quotaCounts);
    if (now.every((q) => answeredHere.has(q.id))) { visible = now; break; }
    visible = now;
    }
    visited.questionIds = visible.map((q) => q.id);
    // piped texts as the respondent would have seen them
    for (const q of visible) visited.texts[q.id] = resolvePiping(questionTextTemplate(q, { def, state, loop, quotaCounts }), { def, state, loop, quotaCounts });
    out.pages.push(visited);

    const errors = validatePage(def, visible, { def, state, loop, quotaCounts });
    // as the runner does: on_validate first (its purpose is to add errors), then on_submit — for the page and every question on it
    const submitScope = [step.pageId.split("@")[0], ...visible.map((q) => q.id)];
    const validate = runScripts(def, state, "on_validate", { scopeRef: submitScope, loop });
    // LOGIC-11: on_submit runs only when built-in validation and on_validate found nothing blocking (its errors still block)
    const submit = errors.length || validate.errors.length
      ? { logs: [] as string[], errors: [] as typeof validate.errors }
      : runScripts(def, state, "on_submit", { scopeRef: submitScope, loop });
    const scripts = { logs: [...validate.logs, ...submit.logs], errors: [...validate.errors, ...submit.errors] };
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
