"use client";
import React from "react";
import type { AnalysisMethod, AnalysisRole, MeasurementLevel, Question, QuestionAnalysis } from "@rescript/schema";
import { ANALYSIS_ROLES, MEASUREMENT_LEVELS, hypothesisLabel } from "@rescript/schema";
import { inferQuestionAnalysis, analysisDependencies } from "@rescript/engine";
import { useStudio } from "./store";

/**
 * WHAT THIS QUESTION IS FOR — Properties → Analysis.
 *
 * The question-level half of the analysis framework (the plan itself is in
 * the Intelligent copilot's Analysis tab). Every field shows the engine's
 * inference until the researcher sets it; a set field is marked and can be
 * returned to "inferred". Variables are chosen from the survey, so the
 * stored names are always real ones — the same resolution the copilot's
 * actions go through.
 */
const ROLE_WORDS: Record<AnalysisRole, string> = {
  dependent: "Dependent — an outcome the study explains", independent: "Independent — a factor that may explain an outcome",
  mediator: "Mediator — carries an effect", moderator: "Moderator — changes an effect", control: "Control — held constant in models",
  segmentation: "Segmentation — results are cut by it", screening: "Screening — decides who takes part", descriptive: "Descriptive — reported on its own",
};
const LEVEL_WORDS: Record<MeasurementLevel, string> = {
  nominal: "nominal (categories)", ordinal: "ordinal (an ordered scale)", interval: "interval (a number, equal steps)", ratio: "ratio (a count or amount)",
  multi: "multi-select (a set of categories)", text: "open text", rank: "a ranking", allocation: "an allocation", choice: "a choice exercise", date: "a date / time",
};
const METHOD_WORDS: Partial<Record<AnalysisMethod, string>> = { top_box: "top-2-box", chi_square: "chi-square", t_test: "t-test", text_themes: "text themes", maxdiff_scores: "MaxDiff scores", conjoint_utilities: "conjoint utilities", nps: "NPS", turf: "TURF", brand_funnel: "brand funnel", driver_analysis: "driver analysis", logistic_regression: "logistic regression", ranking_scores: "ranking scores", allocation_shares: "allocation shares" };
const word = (m: string) => METHOD_WORDS[m as AnalysisMethod] ?? m.replace(/_/g, " ");
const PRIMARY: AnalysisMethod[] = ["frequencies", "mean", "median", "top_box", "nps", "text_themes", "ranking_scores", "allocation_shares", "maxdiff_scores", "conjoint_utilities"];
const MODELING: AnalysisMethod[] = ["correlation", "regression", "logistic_regression", "chi_square", "t_test", "anova", "factor", "reliability", "cluster", "driver_analysis", "turf"];

export function QuestionAnalysisSection({ q, patch }: { q: Question; patch(p: Partial<Question>): void }) {
  const s = useStudio();
  const def = s.def;
  const a = React.useMemo(() => inferQuestionAnalysis(def, q), [def, q]);
  const deps = React.useMemo(() => analysisDependencies(def, q.id), [def, q.id]);
  const hyps = def.research?.hypotheses ?? [];
  const others = def.questions.filter((o) => o.id !== q.id && !["html", "custom_component"].includes(o.type));
  const set = (p: Partial<QuestionAnalysis>) => {
    const next: QuestionAnalysis = { primary: [], crosstabBy: [], modeling: [], relatedTo: [], hypotheses: [], ...(q.analysis ?? {}), ...p };
    for (const k of Object.keys(next) as (keyof QuestionAnalysis)[]) if (next[k] === undefined) delete next[k];
    const empty = !next.role && !next.measurement && !next.construct && !next.notes && !next.primary.length && !next.crosstabBy.length && !next.modeling.length && !next.relatedTo.length && !next.hypotheses.length;
    patch({ analysis: empty ? undefined : next });
    if (def.research?.analysisPlan) s.update((d) => { if (d.research?.analysisPlan) d.research.analysisPlan.source = "researcher"; });
  };
  const inferred = (k: keyof QuestionAnalysis) => a.inferred.includes(k);
  // a plain function, not a nested component: a component defined in render remounts on every render, and a remount between mousedown and mouseup swallows the click
  const tag = (k: keyof QuestionAnalysis) => inferred(k)
    ? <span className="muted" style={{ fontSize: 11 }} data-testid={`qa-inferred-${k}`}>inferred</span>
    : <button type="button" className="btn ghost small" style={{ fontSize: 11, padding: "0 6px" }} data-testid={`qa-reset-${k}`} title="Back to the engine's inference" onClick={() => set({ [k]: Array.isArray(a[k as keyof typeof a]) ? [] : undefined } as Partial<QuestionAnalysis>)}>set · reset</button>;
  const toggle = (k: "primary" | "modeling" | "crosstabBy" | "relatedTo" | "hypotheses", v: string) => {
    const cur = a[k] as string[];
    set({ [k]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] } as Partial<QuestionAnalysis>);
  };
  const chips = (k: "primary" | "modeling", list: AnalysisMethod[]) => (
    <div className="row" style={{ flexWrap: "wrap", gap: 4 }} data-testid={`qa-${k}`}>
      {list.map((m) => <button key={m} type="button" className={`chip${(a[k] as string[]).includes(m) ? " on" : ""}`} style={{ cursor: "pointer" }} data-testid={`qa-${k}-${m}`} onClick={() => toggle(k, m)}>{word(m)}</button>)}
    </div>
  );
  const vars = (k: "crosstabBy" | "relatedTo") => (
    <div className="row" style={{ flexWrap: "wrap", gap: 4 }} data-testid={`qa-${k}`}>
      {others.map((o) => <button key={o.id} type="button" className={`chip${(a[k] as string[]).includes(o.variableName) || (a[k] as string[]).includes(String(o.code)) ? " on" : ""}`} style={{ cursor: "pointer" }} title={o.text.replace(/<[^>]+>/g, "")} data-testid={`qa-${k}-${o.code}`} onClick={() => toggle(k, o.variableName)}>{o.code}</button>)}
      {!others.length && <span className="muted" style={{ fontSize: 12.5 }}>No other questions yet.</span>}
    </div>
  );
  return (
    <div data-testid="qa-section">
      <label className="f"><span>Role in the design {tag("role")}</span>
        <select className="select" data-testid="qa-role" value={a.role} onChange={(e) => set({ role: e.target.value as AnalysisRole })}>
          {ANALYSIS_ROLES.map((r) => <option key={r} value={r}>{ROLE_WORDS[r]}</option>)}
        </select></label>
      <label className="f"><span>Measured as {tag("measurement")}</span>
        <select className="select" data-testid="qa-measurement" value={a.measurement} onChange={(e) => set({ measurement: e.target.value as MeasurementLevel })}>
          {MEASUREMENT_LEVELS.map((m) => <option key={m} value={m}>{LEVEL_WORDS[m]}</option>)}
        </select></label>
      <label className="f"><span>Construct it measures {tag("construct")}</span>
        <input className="input" list={`qa-constructs-${q.id}`} data-testid="qa-construct" value={a.construct ?? ""} placeholder="e.g. Brand trust"
          onChange={(e) => set({ construct: e.target.value || undefined })} />
        <datalist id={`qa-constructs-${q.id}`}>{(def.research?.constructs ?? []).map((c) => <option key={c.name} value={c.name} />)}</datalist></label>
      <div className="f"><span>Reported as {tag("primary")}</span>{chips("primary", PRIMARY)}</div>
      <div className="f"><span>Tabulated against {tag("crosstabBy")}</span>{vars("crosstabBy")}</div>
      <div className="f"><span>Expected to relate to {tag("relatedTo")}</span>{vars("relatedTo")}</div>
      <div className="f"><span>Modelled with {tag("modeling")}</span>{chips("modeling", MODELING)}</div>
      <div className="f"><span>Hypotheses it serves {tag("hypotheses")}</span>
        {hyps.length ? (
          <div data-testid="qa-hypotheses">
            {hyps.map((h, i) => { const l = hypothesisLabel(i); return (
              <label key={l} className="row" style={{ gap: 6, fontSize: 12.5, alignItems: "flex-start" }}>
                <input type="checkbox" data-testid={`qa-hyp-${l}`} checked={a.hypotheses.includes(l)} onChange={() => toggle("hypotheses", l)} />
                <span><b>{l}</b> {h}</span>
              </label>); })}
          </div>
        ) : <span className="muted" style={{ fontSize: 12.5 }}>No hypotheses in the research design yet — ask Intelligent mode to record the design, or write them in its Analysis tab.</span>}
      </div>
      <label className="f"><span>Analysis notes</span>
        <textarea className="ta" style={{ minHeight: 48 }} data-testid="qa-notes" value={a.notes ?? ""} placeholder="e.g. recode 6–10 as top box; compare US and UK separately" onChange={(e) => set({ notes: e.target.value || undefined })} /></label>
      {(deps.crosstabs.length > 0 || deps.tests.length > 0 || deps.derived.length > 0) && (
        <p className="muted" style={{ fontSize: 12.5 }} data-testid="qa-plan-uses">
          In the analysis plan: {[deps.crosstabs.length && `${deps.crosstabs.length} crosstab${deps.crosstabs.length === 1 ? "" : "s"}`, deps.tests.length && `${deps.tests.length} test${deps.tests.length === 1 ? "" : "s"} (${[...new Set(deps.tests.map((t) => word(t.method)))].join(", ")})`, deps.derived.length && `derived ${deps.derived.map((d) => d.name).join(", ")}`].filter(Boolean).join(" · ")}.
        </p>
      )}
    </div>
  );
}
