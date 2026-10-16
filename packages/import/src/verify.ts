import type { SurveyDefinition, Question } from "@rescript/schema";
import { createResponseState, start, advance, setAnswer, visibleQuestions, validatePage, runQualityCheck, constantCondition, type ResponseState, type RuntimeStep } from "@rescript/engine";
import type { CanonicalSurvey } from "./canonical.js";
import type { MapResult } from "./map.js";
import { plainText } from "./canonical.js";

/**
 * POST-IMPORT VERIFICATION (QSF brief, Phase 4): is the survey that came out
 * of the import one the engine can run, and does it still have the shape the
 * source had?
 *
 * Two checks, both facts:
 *
 *   structure   every source question has a Rescript question with the same
 *               family, the same number of choices and rows, the variable
 *               name the source used (or a recorded rename), every option
 *               code the source data carried; every block in the source flow
 *               has a page; every quota a quota
 *
 *   runtime     the engine walks the survey — start, answer every visible
 *               question with a value its own validation accepts, advance —
 *               under several answering strategies (first choice, last
 *               choice, random), and reports what it reached: pages, questions,
 *               the end status; questions no walk reached; validation the
 *               walker could not satisfy; any exception the engine threw
 *
 * Nothing here is a judgement. "Unreachable" means no strategy reached it —
 * a question behind a branch the strategies never took is unreachable here
 * and may be perfectly fine; the report says which walks were made.
 */

export interface StructureFinding { level: "error" | "warning"; sourceId: string; message: string }
export interface RuntimeWalk { strategy: string; seed: number; pages: number; questions: number; end: string | null; refusals: { questionId: string; code: string; message: string }[]; error: string | null; loops: number }
export interface VerificationReport {
  structure: { checked: number; ok: number; findings: StructureFinding[] };
  runtime: {
    walks: RuntimeWalk[];
    /** every question the flow places, by Rescript id */
    placed: number;
    reached: number;
    /** `by_source`: the source itself never shows it (a block outside the Survey Flow, a never-true branch); `no_walk`: no strategy got there */
    unreachable: { id: string; code: string; reason: "by_source" | "no_walk" }[];
    /** questions the walker could not answer to the engine's satisfaction — the validation message it got */
    unanswerable: { id: string; code: string; message: string }[];
    errors: string[];
    endStatuses: string[];
  };
  /** analysis compatibility: variable names and codes the data will carry, compared with the source's */
  analysis: { variablesKept: number; variablesRenamed: { source: string; rescript: string }[]; codesKept: number; codesChanged: { question: string; source: string; rescript: string }[]; rowsKept: number };
  ok: boolean;
}

/* ------------------------------------------------------------ structure */

const FAMILY: Record<string, string> = {
  single: "single", dropdown: "single", nps: "single", stars: "numeric", slider: "numeric", numeric: "numeric",
  multi: "multi", multi_dropdown: "multi", text: "text", textarea: "text", email: "text", date: "date", time: "time",
  matrix_single: "matrix", matrix_multi: "matrix", matrix_text: "matrix", matrix_numeric: "matrix", matrix_dropdown: "matrix", matrix_mixed: "matrix",
  ranking: "ranking", constant_sum: "allocation", descriptive: "content", hidden: "hidden", calculated: "hidden",
  file_upload: "upload", signature: "upload", hotspot: "hotspot", conjoint: "task", maxdiff: "task", acbc: "task", bucket: "matrix", unknown: "content",
};
const familyOf = (type: string): string => /^matrix|^composite$|^custom_table$/.test(type) ? "matrix" : /^(single_select|dropdown|nps)$/.test(type) ? "single" : /^(multi_select|multi_dropdown)$/.test(type) ? "multi" : /^(open_text|long_text|text_list)$/.test(type) ? "text" : /^(numeric|slider|numeric_list)$/.test(type) ? "numeric" : type === "html" ? "content" : /^(hidden|calculated)$/.test(type) ? "hidden" : type === "upload" ? "upload" : /task$/.test(type) ? "task" : type;

export function verifyStructure(c: CanonicalSurvey, m: MapResult): VerificationReport["structure"] & { analysis: VerificationReport["analysis"] } {
  const findings: StructureFinding[] = [];
  const def = m.def;
  const analysis: VerificationReport["analysis"] = { variablesKept: 0, variablesRenamed: [], codesKept: 0, codesChanged: [], rowsKept: 0 };
  if (!def) return { checked: 0, ok: 0, findings: [{ level: "error", sourceId: "survey", message: "No survey was produced." }], analysis };
  const idOf = new Map(m.mapping.filter((e) => e.kind === "question").map((e) => [e.source, e.rescript]));
  let checked = 0, ok = 0;
  for (const cq of c.questions) {
    checked++;
    const id = idOf.get(cq.sourceId);
    const q = id ? def.questions.find((x) => x.id === id) : undefined;
    if (!q) { findings.push({ level: "error", sourceId: cq.sourceId, message: `${cq.variable} has no question in the imported survey.` }); continue; }
    let fine = true;
    const fam = FAMILY[cq.kind] ?? cq.kind;
    const got = familyOf(q.type);
    if (cq.kind !== "unknown" && fam !== got && !(cq.kind === "text" && cq.rows.length && got === "text") && !(cq.kind === "numeric" && cq.rows.length && got === "numeric") && !(cq.kind === "matrix_numeric" && got === "numeric")) { findings.push({ level: "error", sourceId: cq.sourceId, message: `${cq.variable} is a ${cq.sourceType} in the source but a ${q.type} here.` }); fine = false; }
    const wantOpts = cq.kind === "matrix_numeric" ? 0 : cq.options.length;
    const gotOpts = (q.options ?? []).length;
    if (cq.kind !== "unknown" && cq.kind !== "nps" && wantOpts !== gotOpts && !(cq.kind === "matrix_numeric")) { findings.push({ level: "error", sourceId: cq.sourceId, message: `${cq.variable} has ${wantOpts} choices in the source and ${gotOpts} here.` }); fine = false; }
    if (cq.rows.length !== (q.rows ?? []).length) { findings.push({ level: "error", sourceId: cq.sourceId, message: `${cq.variable} has ${cq.rows.length} rows in the source and ${(q.rows ?? []).length} here.` }); fine = false; }
    else analysis.rowsKept += cq.rows.length;
    /* the variable name: kept, or renamed with a record */
    if (q.variableName.toUpperCase() === cq.variable.toUpperCase()) analysis.variablesKept++;
    else {
      const rec = m.mapping.find((e) => e.kind === "variable" && e.source === cq.variable);
      if (rec) analysis.variablesRenamed.push({ source: cq.variable, rescript: q.variableName });
      else { findings.push({ level: "error", sourceId: cq.sourceId, message: `${cq.variable} is exported as ${q.variableName} here and the rename was not recorded.` }); fine = false; }
    }
    /* every code the source data carries is a code here */
    if (cq.kind !== "matrix_numeric") for (const o of cq.options) {
      const here = (q.options ?? []).find((x) => String(x.code) === String(o.code));
      if (here) analysis.codesKept++;
      else {
        /* a duplicate code the mapper suffixed (`3_2`) is a recorded change — anything else is a lost code */
        const renamed = (q.options ?? []).find((x) => String(x.code).startsWith(`${o.code}_`) && m.mapping.some((e) => e.kind === "option" && e.source === `${cq.sourceId}/${o.sourceId}` && e.rescript.endsWith(`=${x.code}`)));
        if (renamed) analysis.codesChanged.push({ question: cq.sourceId, source: String(o.code), rescript: String(renamed.code) });
        else { findings.push({ level: "error", sourceId: cq.sourceId, message: `${cq.variable}: choice ${o.sourceId} (code ${o.code}) has no option here.` }); fine = false; }
      }
    }
    for (const r of cq.rows) if (!(q.rows ?? []).some((x) => String(x.code) === String(r.code))) { findings.push({ level: "error", sourceId: cq.sourceId, message: `${cq.variable}: row ${r.sourceId} (code ${r.code}) has no row here.` }); fine = false; }
    if (plainText(cq.text) && !plainText(q.text) && cq.kind !== "unknown") { findings.push({ level: "warning", sourceId: cq.sourceId, message: `${cq.variable} lost its text.` }); }
    if (cq.required && !q.required && !["descriptive", "hidden", "calculated"].includes(cq.kind)) { findings.push({ level: "warning", sourceId: cq.sourceId, message: `${cq.variable} was required in the source and is optional here.` }); }
    if (fine) ok++;
  }
  /* blocks → pages, quotas → quotas */
  const flowJson = JSON.stringify(def.flow);
  const blocks = (fs: CanonicalSurvey["flow"]): string[] => fs.flatMap((f) => f.t === "block" ? (f.pages.some((p) => p.length) ? [f.sourceId] : []) : "children" in f ? blocks(f.children) : []);
  for (const b of blocks(c.flow)) {
    checked++;
    const id = m.mapping.find((e) => e.kind === "block" && e.source.startsWith(b))?.rescript;
    if (id && flowJson.includes(`"id":"${id}"`)) ok++;
    else findings.push({ level: "error", sourceId: b, message: `Block ${b} has no page in the imported flow.` });
  }
  for (const q of c.quotas) {
    checked++;
    const id = m.mapping.find((e) => e.kind === "quota" && e.source === q.sourceId)?.rescript;
    if (id && def.quotas.some((x) => x.id === id)) ok++;
    else findings.push({ level: m.inventory.some((i) => i.feature === "quota" && i.sourceId === q.sourceId && i.status === "unsupported") ? "warning" : "error", sourceId: q.sourceId, message: `Quota “${q.name}” is not in the imported survey.` });
  }
  return { checked, ok, findings, analysis };
}

/* ------------------------------------------------------------ runtime */

type Strategy = "first" | "last" | "random" | "deepest";

/** a value the engine's validation should accept for this question, under the strategy */
export function answerFor(q: Question, strategy: Strategy, rnd: () => number): unknown {
  const pick = <T>(xs: T[]): T | undefined => !xs.length ? undefined : strategy === "first" || strategy === "deepest" ? xs[0] : strategy === "last" ? xs[xs.length - 1] : xs[Math.floor(rnd() * xs.length)];
  /* a plain choice: not exclusive, not hidden, not an "other, specify" (whose box the walker would also have to fill) */
  const plain = (q.options ?? []).filter((o) => !o.flags?.includes("exclusive") && !o.flags?.includes("other_specify") && o.logic?.visibility !== "always_hide");
  const opts = plain.length ? plain : (q.options ?? []);
  const code = pick(opts)?.code;
  const kinds = new Set(q.validation.map((v) => v.kind));
  const s = q.settings as Record<string, unknown>;
  const num = () => {
    const min = typeof s.minValue === "number" ? s.minValue : q.validation.find((v) => v.kind === "min_value")?.value;
    const max = typeof s.maxValue === "number" ? s.maxValue : q.validation.find((v) => v.kind === "max_value")?.value;
    const lo = typeof min === "number" ? min : 1, hi = typeof max === "number" ? max : Math.max(lo, 10);
    const v = strategy === "first" ? lo : strategy === "last" ? hi : lo + Math.floor(rnd() * (hi - lo + 1));
    return kinds.has("integer") || typeof s.decimalPlaces !== "number" ? Math.round(v) : v;
  };
  const text = () => kinds.has("email") || q.variant === "text.email" ? "respondent@example.com" : kinds.has("url") ? "https://example.com" : kinds.has("zip") ? "12345" : kinds.has("phone") ? "5551234567" : kinds.has("pattern") && /0-9/.test(String(q.validation.find((v) => v.kind === "pattern")?.value)) ? "Sample" : "Sample answer";
  const minSel = q.validation.find((v) => v.kind === "min_selections")?.value;
  const multi = () => { const n = Math.max(1, typeof minSel === "number" ? minSel : 1); const chosen: (string | number)[] = []; const pool = [...opts]; while (chosen.length < n && pool.length) { const o = pick(pool)!; pool.splice(pool.indexOf(o), 1); chosen.push(o.code); } return chosen; };
  switch (q.type) {
    case "single_select": case "dropdown": return code ?? null;
    case "nps": return (q.options ?? []).length ? code : strategy === "first" ? 0 : strategy === "last" ? 10 : Math.floor(rnd() * 11);
    case "multi_select": case "multi_dropdown": return multi();
    case "numeric": return q.variant === "single_select.stars" ? (strategy === "first" ? 1 : strategy === "last" ? (typeof s.maxValue === "number" ? s.maxValue : 5) : 3) : num();
    case "slider": return num();
    case "open_text": case "long_text": return text();
    case "date": return "2026-03-15";
    case "time": return "10:30";
    case "matrix_single": case "matrix_dropdown": return Object.fromEntries((q.rows ?? []).map((r) => [String(r.code), code ?? null]));
    case "matrix_multi": return Object.fromEntries((q.rows ?? []).map((r) => [String(r.code), multi()]));
    case "matrix_text": return Object.fromEntries((q.rows ?? []).map((r) => [String(r.code), "Sample"]));
    case "matrix_numeric": return Object.fromEntries((q.rows ?? []).map((r) => [String(r.code), (q.columns ?? []).length ? Object.fromEntries((q.columns ?? []).map((c) => [c.id, 1])) : 1]));
    case "numeric_list": return Object.fromEntries((q.rows ?? []).map((r) => [String(r.code), num()]));
    case "text_list": return Object.fromEntries((q.rows ?? []).map((r) => [String(r.code), text()]));
    case "ranking": { const codes = opts.map((o) => o.code); return strategy === "last" ? [...codes].reverse() : codes; }
    case "composite": case "custom_table": return Object.fromEntries((q.rows ?? []).map((r) => [String(r.code), Object.fromEntries((q.columns ?? []).map((c) => { const co = c.options.filter((o) => !o.flags?.includes("exclusive")); const first = co.length ? co : c.options; return [c.id, c.responseType === "multi" || c.responseType === "multi_dropdown" ? (first.length ? [pick(first)!.code] : []) : c.responseType === "single" || c.responseType === "dropdown" ? (first.length ? pick(first)!.code : null) : c.responseType === "numeric" || c.responseType === "slider" ? 1 : c.responseType === "date" ? "2026-03-15" : c.responseType === "time" ? "10:30" : "Sample"]; }))]));
    case "allocation": { const total = typeof s.sumTarget === "number" ? s.sumTarget : (q.validation.find((v) => v.kind === "sum_equals")?.value as number | undefined) ?? 100; const n = opts.length || 1; const each = Math.floor(total / n); const out: Record<string, number> = {}; opts.forEach((o, i) => { out[String(o.code)] = i === n - 1 ? total - each * (n - 1) : each; }); return out; }
    default: return undefined; // uploads, hotspots, tasks, content — the walker does not answer these
  }
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function walkSurvey(def: SurveyDefinition, strategy: Strategy, seed: number, opts: { maxPages?: number; embedded?: Record<string, string> } = {}): RuntimeWalk & { seen: Set<string> } {
  const rnd = mulberry(seed);
  const walk: RuntimeWalk & { seen: Set<string> } = { strategy, seed, pages: 0, questions: 0, end: null, refusals: [], error: null, loops: 0, seen: new Set() };
  const state: ResponseState = createResponseState(def, { seed, embedded: opts.embedded ?? {} });
  try {
    let nav = start(def, state, {});
    const max = opts.maxPages ?? 500;
    while (!nav.done && walk.pages < max) {
      const step: RuntimeStep | undefined = nav.steps[nav.stepIndex];
      if (!step || step.kind !== "page") { nav = advance(def, state, {}); continue; }
      walk.pages++;
      if (step.loop) walk.loops++;
      const qs = visibleQuestions(def, step, state, {});
      for (const q of qs) {
        walk.seen.add(q.id);
        walk.questions++;
        const v = answerFor(q, strategy, rnd);
        if (v !== undefined) setAnswer(def, state, q.id, v, step.loop ?? null);
      }
      /*
       * "Deepest": a screener's first choice is often the one that screens
       * out. For each single-choice question on the page, try every plain
       * choice on a copy of the state and keep the one that leaves the most
       * survey ahead — the walk that gets furthest, which is the walk that
       * shows whether the pages behind the screener run at all.
       */
      if (strategy === "deepest") {
        for (const q of qs) {
          if (!["single_select", "dropdown", "multi_select", "multi_dropdown"].includes(q.type)) continue;
          const cands = (q.options ?? []).filter((o) => !o.flags?.includes("other_specify") && o.logic?.visibility !== "always_hide").slice(0, 12);
          if (cands.length < 2) continue;
          let best: { value: unknown; ahead: number } | null = null;
          const isMulti = q.type === "multi_select" || q.type === "multi_dropdown";
          /* a multi-select also tries "everything plain at once" — a count condition ("selected 2 or more") only opens that way */
          const values: unknown[] = [...cands.map((o) => (isMulti ? [o.code] : o.code)), ...(isMulti ? [cands.filter((o) => !o.flags?.includes("exclusive")).map((o) => o.code)] : [])];
          for (const value of values) {
            const trial: ResponseState = structuredClone(state);
            setAnswer(def, trial, q.id, value, step.loop ?? null);
            const nav2 = advance(def, trial, {}, { fromPageId: step.pageId });
            /* the pages before the first end the compiled flow now contains — an end inside a branch is a step like any other */
            const rest = nav2.steps.slice(nav2.stepIndex);
            const endAt = rest.findIndex((x) => x.kind === "end");
            const pagesAhead = (endAt >= 0 ? rest.slice(0, endAt) : rest).filter((x) => x.kind === "page");
            const endKind = endAt >= 0 ? (rest[endAt] as { status?: string }).status : nav2.endStatus;
            /* …and the questions those pages would show — a count condition ("2 or more selected") opens a question, not a page */
            let shown = 0;
            for (const pg of pagesAhead.slice(0, 40)) if (pg.kind === "page") shown += visibleQuestions(def, pg, trial, {}).length;
            const ahead = nav2.done ? (nav2.endStatus === "complete" ? 0.5 : 0) : pagesAhead.length + (endKind === "complete" || endKind === undefined ? 0.5 : 0) + shown * 0.001;
            if (!best || ahead > best.ahead) best = { value, ahead };
          }
          if (best) setAnswer(def, state, q.id, best.value, step.loop ?? null);
        }
      }
      const errors = validatePage(def, qs, { def, state, loop: step.loop ?? null });
      for (const e of errors) { const q = qs.find((x) => x.id === e.questionId); if (q && !walk.refusals.some((r) => r.questionId === q.id)) walk.refusals.push({ questionId: q.id, code: q.code, message: e.message }); }
      nav = advance(def, state, {}, { fromPageId: step.pageId });
    }
    walk.end = nav.done ? (nav.endStatus ?? state.status ?? "complete") : `stopped after ${walk.pages} pages`;
  } catch (e) {
    walk.error = (e as Error).message;
  }
  return walk;
}

/** the questions the flow places, by id — what a walk could reach at all */
export function placedQuestions(def: SurveyDefinition): Set<string> {
  const out = new Set<string>();
  const walk = (ns: unknown[]) => { for (const n of ns as Record<string, unknown>[]) { if (n.type === "page") for (const id of n.questionIds as string[]) out.add(id); if (Array.isArray(n.children)) walk(n.children); if (Array.isArray(n.branches)) for (const b of n.branches as { children: unknown[] }[]) walk(b.children); if (Array.isArray(n.otherwise)) walk(n.otherwise); } };
  walk(def.flow as unknown[]);
  return out;
}

/** questions behind a branch arm whose condition is the constant FALSE — what the import writes for a block the source keeps out of its flow */
export function neverShown(def: SurveyDefinition): Set<string> {
  const out = new Set<string>();
  const isFalse = (w: unknown) => JSON.stringify(w) === JSON.stringify(constantCondition(false));
  const collect = (ns: unknown[]) => { for (const n of ns as Record<string, unknown>[]) { if (n.type === "page") for (const id of n.questionIds as string[]) out.add(id); if (Array.isArray(n.children)) collect(n.children); if (Array.isArray(n.branches)) for (const b of n.branches as { children: unknown[] }[]) collect(b.children); if (Array.isArray(n.otherwise)) collect(n.otherwise); } };
  const walk = (ns: unknown[]) => { for (const n of ns as Record<string, unknown>[]) { if (Array.isArray(n.children)) walk(n.children); if (Array.isArray(n.branches)) for (const b of n.branches as { when: unknown; children: unknown[] }[]) { if (isFalse(b.when)) collect(b.children); else walk(b.children); } if (Array.isArray(n.otherwise)) walk(n.otherwise); } };
  walk(def.flow as unknown[]);
  return out;
}

export function verifyRuntime(def: SurveyDefinition, opts: { seeds?: number[]; embedded?: Record<string, string> } = {}): VerificationReport["runtime"] {
  const walks: RuntimeWalk[] = [];
  const seen = new Set<string>();
  const unanswerable = new Map<string, { id: string; code: string; message: string }>();
  const errors: string[] = [];
  const plans: [Strategy, number][] = [["deepest", 0], ["first", 1], ["last", 2], ...(opts.seeds ?? [11, 23, 37, 51, 79]).map((s): [Strategy, number] => ["random", s])];
  for (const [strategy, seed] of plans) {
    const w = walkSurvey(def, strategy, seed, { embedded: opts.embedded });
    for (const id of w.seen) seen.add(id);
    for (const r of w.refusals) if (!unanswerable.has(r.questionId)) unanswerable.set(r.questionId, { id: r.questionId, code: r.code, message: r.message });
    if (w.error) errors.push(`${strategy}/${seed}: ${w.error}`);
    const { seen: _s, ...rest } = w; void _s;
    walks.push(rest);
  }
  const placed = placedQuestions(def);
  const never = neverShown(def);
  const answerable = [...placed].filter((id) => { const q = def.questions.find((x) => x.id === id); return q && !["hidden", "calculated", "embedded_data"].includes(q.type) && !q.settings.hidden; });
  const unreachable = answerable.filter((id) => !seen.has(id)).map((id) => ({ id, code: def.questions.find((x) => x.id === id)?.code ?? id, reason: never.has(id) ? "by_source" as const : "no_walk" as const }));
  /* a question only the walker could not answer (an upload, a task) is not a refusal of the survey — it is listed, and counted apart */
  return { walks, placed: answerable.length, reached: answerable.length - unreachable.length, unreachable, unanswerable: [...unanswerable.values()], errors, endStatuses: [...new Set(walks.map((w) => w.end ?? "").filter(Boolean))] };
}

export function verifyImport(c: CanonicalSurvey, m: MapResult, opts: { embedded?: Record<string, string> } = {}): VerificationReport {
  const s = verifyStructure(c, m);
  const { analysis, ...structure } = s;
  const runtime = m.def ? verifyRuntime(m.def, opts) : { walks: [], placed: 0, reached: 0, unreachable: [], unanswerable: [], errors: ["no survey"], endStatuses: [] };
  const quality = m.def ? runQualityCheck(m.def) : null;
  const ok = !!m.def && structure.findings.every((f) => f.level !== "error") && runtime.errors.length === 0 && (quality?.errors ?? 1) === 0 && runtime.unreachable.every((u) => u.reason === "by_source");
  return { structure, runtime, analysis, ok };
}
