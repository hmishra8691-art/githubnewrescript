import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, interpretRequest, reviewSurvey } from "@rescript/engine";
import { runSimulation } from "@rescript/templates";
import { buildDataset, runAnalysis, type AnalyticsRow } from "@rescript/analytics";
import type { Suite } from "../core.js";

/**
 * PERFORMANCE — a very large survey and a large response set (roadmap P1 and M1).
 *
 * These time the engine itself, in one Node process: what a programmer's edit costs, what a simulated respondent
 * costs, what a crosstab costs. They are not the editor in a browser or the runtime on a phone on 3G — those need a
 * browser suite and a device — and the numbers depend on the machine, so a slower run warns instead of failing.
 */
export const LARGE = { questions: 500, loops: 50, pages: 100 } as const;

/** 500 questions over 100 pages, a display condition on two in five, and 50 loops over a multi-select */
export function largeSurvey(): SurveyDefinition {
  const scale = [1, 2, 3, 4, 5].map((c) => ({ code: String(c), label: `Point ${c}` }));
  const brands = Array.from({ length: 8 }, (_, i) => ({ code: `b${i + 1}`, label: `Brand ${i + 1}` }));
  const questions: Record<string, unknown>[] = [{ id: "q_brands", code: "B0", variableName: "B0", type: "multi_select", text: "Which brands do you know?", options: brands }];
  const flow: Record<string, unknown>[] = [{ type: "page", id: "p_brands", questionIds: ["q_brands"] }];
  const perPage = Math.ceil((LARGE.questions - LARGE.loops) / LARGE.pages);
  let n = 0;
  for (let p = 0; p < LARGE.pages; p++) {
    const ids: string[] = [];
    for (let k = 0; k < perPage && n < LARGE.questions - LARGE.loops; k++, n++) {
      const id = `q${n + 1}`;
      const kind = n % 5 === 0 ? "multi_select" : n % 7 === 0 ? "numeric" : "single_select";
      questions.push({
        id, code: `Q${n + 1}`, variableName: `Q${n + 1}`, type: kind, text: `Question ${n + 1} of the tracker`, ...(kind === "numeric" ? {} : { options: scale }),
        ...(n > 4 && n % 5 < 2 ? { displayLogic: { type: "rule", source: { kind: "question", ref: `q${n - 3}` }, operator: "ne", value: "1" } } : {}),
      });
      ids.push(id);
    }
    flow.push({ type: "page", id: `p${p + 1}`, questionIds: ids });
  }
  for (let l = 0; l < LARGE.loops; l++) {
    const id = `l${l + 1}`;
    questions.push({ id, code: `L${l + 1}`, variableName: `L${l + 1}`, type: "single_select", text: `About this brand, item ${l + 1}`, options: scale });
    flow.push({ type: "loop", id: `loop${l + 1}`, loopVar: `brand${l + 1}`, source: { kind: "question", questionId: "q_brands", filter: "selected" }, children: [{ type: "page", id: `lp${l + 1}`, questionIds: [id] }] });
  }
  flow.push({ type: "end", id: "end", status: "complete" });
  return SurveyDefinition.parse({ meta: { id: "bench-large", code: "BENCH", title: "Large tracker (benchmark)", version: "1.0" }, questions, flow });
}

export const conditioned = (def: SurveyDefinition): number => def.questions.filter((q) => (q as { displayLogic?: unknown }).displayLogic != null).length;

/** the median of several runs, in ms, after one warm-up */
function timed(f: () => unknown, runs = 5): number {
  f();
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); f(); ts.push(performance.now() - t); }
  ts.sort((a, b) => a - b);
  return Math.round(ts[Math.floor(ts.length / 2)]! * 10) / 10;
}

export const programmingPerf: Suite = {
  id: "programming.large_survey", area: "programming", title: "A 500-question survey with 50 loops, in the engine",
  run() {
    const raw = JSON.parse(JSON.stringify(largeSurvey()));
    const def = largeSurvey();
    const parse = timed(() => SurveyDefinition.parse(raw));
    const edit = timed(() => applySurveyActions(def, [{ op: "update_question", target: "Q250", required: true }]));
    const read = timed(() => interpretRequest(def, "Make Q250 required"));
    const review = timed(() => reviewSurvey(def), 3);
    /* one run of 1 and one of 3: the difference is what a respondent costs, the rest is what a run costs once */
    const t1 = performance.now();
    const one = runSimulation(def, { count: 1, seed: 7, completeShare: 1 });
    const first = performance.now() - t1;
    const t3 = performance.now();
    const sim = runSimulation(def, { count: 3, seed: 7, completeShare: 1 });
    const three = performance.now() - t3;
    const respondents = 3;
    const perRespondent = Math.max(0, (three - first) / 2);
    const pagesSeen = sim.journeys.reduce((n, j) => n + j.pages.length, 0) / Math.max(1, sim.journeys.length);
    const perPage = Math.round((perRespondent / Math.max(1, pagesSeen)) * 10) / 10;
    const applied = applySurveyActions(def, [{ op: "update_question", target: "Q250", required: true }]) as { def?: SurveyDefinition; errors?: unknown[] };
    return {
      status: "measured",
      caveat: "this is the engine in Node, not the editor in a browser or a respondent's phone. The roadmap's 100 ms edit and 1 second page targets need a browser suite on a real device to confirm.",
      metrics: [
        { id: "edit_ms", label: "Apply one edit", value: edit, unit: "ms", better: "lower", target: 100, machineDependent: true },
        { id: "read_ms", label: "Read one instruction (rule path)", value: read, unit: "ms", better: "lower", target: 2000, machineDependent: true },
        { id: "validate_ms", label: "Parse and validate the whole definition", value: parse, unit: "ms", better: "lower", target: 1000, machineDependent: true },
        { id: "review_ms", label: "Review the whole survey for contradictions", value: review, unit: "ms", better: "lower", target: 10000, machineDependent: true, note: "the roadmap's 10 seconds is for publish" },
        { id: "page_ms", label: "Working out one page for one simulated respondent", value: perPage, unit: "ms", better: "lower", target: 1000, machineDependent: true, note: `about ${Math.round(pagesSeen)} pages each; the roadmap's 1 second is a page on a phone, which this is not` },
        { id: "respondent_ms", label: "One simulated respondent, start to end", value: Math.round(perRespondent), unit: "ms", better: "lower", target: 5000, machineDependent: true, informational: true, note: "at this rate 1,000 simulated respondents take over an hour" },
      ],
      cases: [
        { id: "survey_size", pass: def.questions.length === LARGE.questions + 1 && conditioned(def) >= 170, detail: `${def.questions.length} questions, ${LARGE.loops} loops, ${conditioned(def)} with a display condition` },
        { id: "edit_applies", pass: !!applied.def || !(applied.errors?.length), detail: "the timed edit is a real, accepted change" },
        { id: "simulation_completes", pass: sim.produced === respondents && one.produced === 1, detail: `${sim.produced + one.produced} of ${respondents + 1} simulated respondents produced; ${sim.issues.length} issues` },
      ],
    };
  },
};

/** n respondents with a banner, a scale and a multi-select: the shape of a tracker's tab */
export function manyRows(n: number): AnalyticsRow[] {
  let s = 12345;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const rows: AnalyticsRow[] = [];
  for (let i = 0; i < n; i++) {
    const gender = r() < 0.5 ? 1 : 2, region = 1 + Math.floor(r() * 4);
    rows.push({ id: `r${i}`, session_id: `s${i}`, status: "complete", is_test: false, started_at: "2026-06-01T10:00:00.000Z", completed_at: "2026-06-01T10:08:00.000Z",
      answers: { g: gender, reg: region, sat: Math.max(1, Math.min(5, Math.round((gender === 2 ? 3.7 : 3.1) + (r() - 0.5) * 3))), aw: [1, 2, 3, 4].filter(() => r() < 0.5) }, calculated: {}, embedded: {}, flags: [] } as AnalyticsRow);
  }
  return rows;
}
const TAB_DEF = () => SurveyDefinition.parse({
  meta: { id: "bench-tab", code: "TAB", title: "Tab benchmark", version: "1.0" },
  questions: [
    { id: "g", code: "Q1", variableName: "GENDER", type: "single_select", text: "Gender", options: [{ code: 1, label: "Male" }, { code: 2, label: "Female" }] },
    { id: "reg", code: "Q2", variableName: "REGION", type: "single_select", text: "Region", options: [1, 2, 3, 4].map((c) => ({ code: c, label: `Region ${c}` })) },
    { id: "sat", code: "Q3", variableName: "SAT", type: "single_select", text: "Satisfaction", options: [1, 2, 3, 4, 5].map((c) => ({ code: c, label: String(c) })) },
    { id: "aw", code: "Q4", variableName: "AWARE", type: "multi_select", text: "Aware of", options: [1, 2, 3, 4].map((c) => ({ code: c, label: `Brand ${c}` })) },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["g", "reg", "sat", "aw"] }, { type: "end", id: "e", status: "complete" }],
});

export const analyticsPerf: Suite = {
  id: "analytics.large_data", area: "analytics", title: "Crosstabs on a large response set, in the engine",
  run() {
    const def = TAB_DEF();
    const spec = { environment: "LIVE" as const, dataset: "all" as const };
    const N = 200_000;
    const rows = manyRows(N);
    const t0 = performance.now();
    const ds = buildDataset(def, rows, { spec });
    const build = Math.round(performance.now() - t0);
    const xt = { name: "xt", kind: "crosstab" as const, dataset: spec, variables: [], rows: ["SAT"], columns: ["GENDER", "REGION"], options: {} };
    let result: ReturnType<typeof runAnalysis> | null = null;
    const tab = timed(() => { result = runAnalysis(xt, ds); }, 3);
    const base = (result as unknown as { n?: number } | null)?.n ?? 0;
    return {
      status: "measured",
      caveat: `measured at ${N.toLocaleString("en-US")} responses by 4 variables, not the roadmap's 1,000,000 by 2,000: the present engine holds every response in memory as an object, which is what the columnar store (M1) replaces. The figure scaled to a million is an estimate, not a measurement.`,
      metrics: [
        { id: "crosstab_ms", label: `Crosstab with a two-variable banner, ${N.toLocaleString("en-US")} responses`, value: tab, unit: "ms", better: "lower", target: 400, machineDependent: true, note: "400 ms here is the 2-second target scaled to a fifth of the rows" },
        { id: "crosstab_1m_estimate_ms", label: "The same, scaled linearly to 1,000,000", value: Math.round(tab * (1_000_000 / N)), unit: "ms", better: "lower", target: 2000, machineDependent: true, note: "estimate" },
        { id: "dataset_build_ms", label: "Build the dataset from stored responses", value: build, unit: "ms", better: "lower", target: 5000, machineDependent: true, informational: true },
      ],
      cases: [{ id: "all_rows_counted", pass: base === N || ds.cases.length === N, detail: `${ds.cases.length.toLocaleString("en-US")} cases in the dataset` }],
    };
  },
};
