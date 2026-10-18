"use client";
import { stableStringify } from "@/lib/stableJson";
import React from "react";
import type { Condition } from "@rescript/schema";
import type { AnalysisDefinition, AnalysisKind, ChartSpec, DatasetSpec, ReportTheme, SegmentDef, VariableMeta, VariableRole } from "@rescript/analytics";
import { ANALYSIS_KINDS, analysisReadiness } from "@rescript/analytics";
import { AxApi, type Row, type RunResult } from "./api";
import { FilterBuilder, conditionText, emptyCondition, isEmptyCondition } from "./FilterBuilder";
import { ResultView, downloadPng, downloadSvg } from "./ResultView";
import { Chart } from "./charts/Chart";
import type { TableFormatting } from "./ProTable";
import type { ModelJobView } from "@/lib/modelJobState";

/**
 * THE ANALYSIS BUILDER (§3–§5). Analysis type → variables → filters → segments →
 * options → Run. The definition it assembles is the whole reproducible object
 * (§39); running posts it to the server and shows the result. Saving keeps the
 * definition; saving a chart keeps a ChartSpec linked to the saved analysis.
 */

export interface BuilderProps {
  api: AxApi;
  variables: VariableMeta[];
  counts: Record<string, number>;
  segments: Row[];
  themes: Row[];
  dataset: DatasetSpec;
  initial?: { analysis?: Row; definition?: AnalysisDefinition; kind?: AnalysisKind };
  onSaved?: (analysis: Row) => void;
  onChartSaved?: (chart: Row) => void;
  onAddToReport?: (analysis: Row, spec: ChartSpec) => void;
  /** the rail shows the unsaved dot beside the open analysis */
  onDirty?: (dirty: boolean) => void;
  canEdit?: boolean;
  canExport?: boolean;
}

const ROLE_FOR_KIND: Record<AnalysisKind, VariableRole[]> = {
  descriptive: ["categorical", "multi", "scale", "numeric", "text", "date"], topbox: ["scale"], crosstab: ["categorical", "multi", "scale", "numeric"], test: ["categorical", "scale", "numeric"],
  correlation: ["scale", "numeric"], regression: ["scale", "numeric", "categorical"], segmentation: ["categorical", "multi", "scale", "numeric"], cluster: ["scale", "numeric"], factor: ["scale", "numeric"], reliability: ["scale", "numeric"],
  trend: ["scale", "numeric", "categorical"], nps: ["scale", "numeric"], csat: ["scale"], turf: ["multi", "categorical"], gap: ["scale", "numeric"], pricing: ["numeric", "scale", "categorical"], brand: ["multi"], ranking: ["complex", "numeric"], allocation: ["complex", "numeric"],
  text: ["text"], quality: [], weighting: ["categorical"], conjoint: ["complex"], maxdiff: ["complex"],
  hb: ["complex"], lca: ["categorical", "scale"], sem: ["scale", "numeric"],
};

const HINT: Partial<Record<AnalysisKind, string>> = {
  descriptive: "Pick any variables — frequencies for categories, moments for numbers.", topbox: "Pick one or more scale items.", crosstab: "Drag variables to Rows and Columns; optionally a Layer for three-way tables.",
  test: "First variable = outcome; second = grouping (or second measure for paired tests).", correlation: "Two variables for a pair, three or more for a matrix.", regression: "First variable = dependent; the rest are predictors.",
  segmentation: "Pick the variables to profile, then add segments in the Segments step.", cluster: "Pick the numeric / scale variables to cluster on.", factor: "Pick the battery of items.", reliability: "Pick the items of one scale.",
  trend: "Pick the metric variable; period is chosen in Options.", nps: "Pick the 0–10 recommend question.", csat: "Pick the satisfaction / effort question(s).", turf: "Pick a multi-select question.", gap: "Set importance and performance items in Options.",
  pricing: "Van Westendorp: four price questions in order (too cheap, bargain, expensive, too expensive). Gabor-Granger: purchase-intent items.", brand: "Pick the brand-list questions in funnel order (awareness, consideration, …).",
  ranking: "Pick the ranking question.", allocation: "Pick the allocation question.", text: "Pick an open-ended question.", quality: "No variables needed.", weighting: "Pick the variables to weight on; targets in Options.", conjoint: "Pick the conjoint task question.", maxdiff: "Pick the MaxDiff task question.",
  hb: "Pick the CBC (conjoint) or MaxDiff task question. HB runs as a background job with progress; chains, burn-in and draws are in Options.", lca: "Pick the categorical indicators (three or more). The class range and random starts are in Options.", sem: "The model is written in Options (lavaan-style syntax); the variables it names are read from the data — no selection needed here.",
};

const ROLE_LABEL: Record<VariableRole, string> = { categorical: "Categorical", multi: "Multi-select", numeric: "Numeric", scale: "Scale", text: "Text", date: "Date", system: "System", complex: "Question" };

function VariablePicker({ variables, selected, onChange, roles, max, label }: { variables: VariableMeta[]; selected: string[]; onChange: (v: string[]) => void; roles?: VariableRole[]; max?: number; label?: string }) {
  const [q, setQ] = React.useState("");
  const [onlyFit, setOnlyFit] = React.useState(true);
  const fits = (v: VariableMeta) => !roles || !roles.length || roles.includes(v.role);
  const list = variables.filter((v) => (!onlyFit || fits(v)) && (!q || v.label.toLowerCase().includes(q.toLowerCase()) || v.name.toLowerCase().includes(q.toLowerCase())));
  const groups = new Map<string, VariableMeta[]>();
  for (const v of list) { const key = v.questionCode ? `${v.questionCode}` : v.derived ? "System" : "Other"; groups.set(key, [...(groups.get(key) ?? []), v]); }
  const toggle = (name: string) => { if (selected.includes(name)) onChange(selected.filter((x) => x !== name)); else if (!max || selected.length < max) onChange([...selected, name]); else onChange([...selected.slice(1), name]); };
  return (
    <div className="ax-varpicker" data-testid="ax-variables">
      <div className="row" style={{ gap: 6, marginBottom: 6 }}>
        {label && <span className="flabel" style={{ marginBottom: 0 }}>{label}</span>}
        <input className="input small" placeholder="Search variables…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
        <label className="ax-toggle"><input type="checkbox" checked={onlyFit} onChange={(e) => setOnlyFit(e.target.checked)} /> Only suitable types</label>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 13 }}>{selected.length} selected{max ? ` (max ${max})` : ""}</span>
      </div>
      <div className="ax-varlist">
        {[...groups.entries()].map(([g, vs]) => (
          <div key={g} className="ax-vargroup">
            <div className="ax-vargroup-head">{g}</div>
            {vs.map((v) => <label key={v.name} className={`ax-var ${selected.includes(v.name) ? "on" : ""} ${fits(v) ? "" : "dim"}`} draggable onDragStart={(e) => e.dataTransfer.setData("text/variable", v.name)}>
              <input type="checkbox" checked={selected.includes(v.name)} onChange={() => toggle(v.name)} />
              <span className="ax-var-label">{v.itemLabel ?? v.label}</span>
              <span className="ax-var-meta">{v.name} · {ROLE_LABEL[v.role]}</span>
            </label>)}
          </div>
        ))}
        {!list.length && <div className="muted" style={{ padding: 8 }}>No variables match.</div>}
      </div>
    </div>
  );
}

function DropZone({ label, items, onChange, variables, hint }: { label: string; items: string[]; onChange: (v: string[]) => void; variables: VariableMeta[]; hint?: string }) {
  const [over, setOver] = React.useState(false);
  return (
    <div className={`ax-drop ${over ? "over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); const n = e.dataTransfer.getData("text/variable"); if (n && !items.includes(n)) onChange([...items, n]); }} data-testid={`ax-drop-${label.toLowerCase()}`}>
      <div className="ax-drop-label">{label}</div>
      {items.map((n) => <span key={n} className="ax-pill">{variables.find((v) => v.name === n)?.label ?? n}<button onClick={() => onChange(items.filter((x) => x !== n))}>×</button></span>)}
      {!items.length && <span className="muted" style={{ fontSize: 13 }}>{hint ?? "Drag a variable here"}</span>}
    </div>
  );
}

type Sel = (k: string, label: string, opts: [string, string][], dflt?: string) => React.ReactNode;
type Num = (k: string, label: string, ph?: string) => React.ReactNode;

/** the crosstab's controls, grouped the way a researcher thinks about a table */
function CrosstabOptions({ def, set, o, alpha, sel, num }: { def: AnalysisDefinition; set: (o: Record<string, unknown>) => void; o: Record<string, unknown>; alpha: React.ReactNode; sel: Sel; num: Num }) {
  const summary = (o.summaryRows as string[] | undefined) ?? [];
  const toggleSummary = (k: string) => set({ summaryRows: summary.includes(k) ? summary.filter((x) => x !== k) : [...summary, k] });
  const check = (k: string, label: string, dflt = false, title?: string) => <label className="ax-toggle" title={title}><input type="checkbox" checked={(o[k] as boolean | undefined) ?? dflt} onChange={(e) => set({ [k]: e.target.checked })} /> {label}</label>;
  const nRows = def.rows?.length ?? 0, nCols = def.columns?.length ?? 0;
  return (
    <div className="ax-optgroups" data-testid="ax-xt-options">
      <fieldset className="ax-optgroup"><legend>Measure &amp; base</legend>
        {sel("measure", "Measure", [["pct_col", "Column %"], ["pct_row", "Row %"], ["pct_total", "Total %"], ["count", "Counts"], ["mean", "Means"]], def.measure ?? "pct_col")}
        {sel("base", "Base", [["answered", "Answered both questions"], ["all", "Everyone in the column (adds a No answer row)"]], "answered")}
        {num("decimals", "Decimals", "1")}
      </fieldset>
      <fieldset className="ax-optgroup"><legend>Layout</legend>
        {sel("layout", "Column variables", [["banner", nCols > 1 ? "Banner — side by side in one table" : "Banner (one table)"], ["separate", "Separate tables per pair"]], "banner")}
        {check("stackRows", "Stack row variables in one table", false, "Banner only: every row question under a section heading in the same table")}
        {check("nestRows", `Nest the second row variable inside the first${nRows < 2 ? " (needs two row variables)" : ""}`, false)}
      </fieldset>
      <fieldset className="ax-optgroup"><legend>Significance</legend>
        {check("significance", "Column letters (a, b, c…)", true)}
        {alpha}
        {sel("correction", "Multiple comparisons", [["holm", "Holm (default)"], ["bonferroni", "Bonferroni"], ["bh", "Benjamini–Hochberg (FDR)"], ["none", "None — raw p-values"]], "holm")}
        {check("sigVsTotal", "Mark cells above / below the rest of the sample (▲ ▼)", false)}
      </fieldset>
      <fieldset className="ax-optgroup"><legend>Rows</legend>
        {sel("sortRows", "Sort categories", [["none", "Questionnaire order"], ["desc", "Total, highest first"], ["asc", "Total, lowest first"]], "none")}
        {check("hideEmptyRows", "Hide rows that are empty everywhere")}
        {check("totalRow", "Total row (100% check)")}
        <div className="ax-field"><span>Summary rows for scales</span><div className="ax-chips">{([["mean", "Mean"], ["top1", "Top box"], ["top2", "Top 2 box"], ["bottom1", "Bottom box"], ["bottom2", "Bottom 2 box"], ["net", "Net (T2B − B2B)"]] as [string, string][]).map(([k, l]) => <button key={k} type="button" className={`ax-chip ${summary.includes(k) ? "on" : ""}`} onClick={() => toggleSummary(k)} data-testid={`ax-summary-${k}`}>{l}</button>)}</div></div>
      </fieldset>
      <fieldset className="ax-optgroup"><legend>Suppression</legend>
        {num("minBase", "Minimum column base (blank = none)", "e.g. 30")}
        <div className="muted" style={{ fontSize: 12.5 }}>Columns with fewer respondents are shown with their base only; their cells are hidden and the column is starred.</div>
      </fieldset>
    </div>
  );
}

function Options({ def, set, variables }: { def: AnalysisDefinition; set: (o: Record<string, unknown>) => void; variables: VariableMeta[] }) {
  const o = def.options ?? {};
  const num = (k: string, label: string, ph?: string) => <label className="ax-field"><span>{label}</span><input className="input small" type="number" value={(o[k] as number | undefined) ?? ""} onChange={(e) => set({ [k]: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder={ph} /></label>;
  const sel = (k: string, label: string, opts: [string, string][], dflt = "") => <label className="ax-field"><span>{label}</span><select className="select small" value={(o[k] as string | undefined) ?? dflt} onChange={(e) => set({ [k]: e.target.value || undefined })}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
  const varSel = (k: string, label: string, roles?: VariableRole[], multi = false) => {
    const list = variables.filter((v) => !roles || roles.includes(v.role));
    if (multi) { const cur = (o[k] as string[] | undefined) ?? []; return <div className="ax-field"><span>{label}</span><div className="ax-chips">{list.slice(0, 80).map((v) => <button key={v.name} type="button" className={`ax-chip ${cur.includes(v.name) ? "on" : ""}`} onClick={() => set({ [k]: cur.includes(v.name) ? cur.filter((x) => x !== v.name) : [...cur, v.name] })}>{v.itemLabel ?? v.label}</button>)}</div></div>; }
    return <label className="ax-field"><span>{label}</span><select className="select small" value={(o[k] as string | undefined) ?? ""} onChange={(e) => set({ [k]: e.target.value || undefined })}><option value="">—</option>{list.map((v) => <option key={v.name} value={v.name}>{v.label}</option>)}</select></label>;
  };
  const alpha = sel("alpha", "Significance level", [["0.1", "90%"], ["0.05", "95%"], ["0.01", "99%"]], "0.05");
  switch (def.kind) {
    case "descriptive": return <>{num("bins", "Histogram bins", "10")}{sel("confidence", "Confidence", [["0.9", "90%"], ["0.95", "95%"], ["0.99", "99%"]], "0.95")}<label className="ax-toggle"><input type="checkbox" checked={!!o.scaleAsNumeric} onChange={(e) => set({ scaleAsNumeric: e.target.checked })} /> Treat scales as numeric (means)</label></>;
    case "topbox": return <>{sel("primaryBox", "Primary box", [["1", "Top / bottom 1"], ["2", "Top / bottom 2"], ["3", "Top / bottom 3"]], "2")}</>;
    case "crosstab": return <CrosstabOptions def={def} set={set} o={o} alpha={alpha} sel={sel} num={num} />;
    case "test": return <>{sel("test", "Test", [["auto", "Auto-select"], ["chi_square", "Chi-square"], ["fisher_exact", "Fisher's exact"], ["trend_proportion", "Trend in a proportion (Cochran–Armitage)"], ["t_one_sample", "One-sample t"], ["t_independent", "Independent t (equal variance)"], ["t_welch", "Welch t"], ["t_paired", "Paired t"], ["anova_one_way", "One-way ANOVA"], ["anova_two_way", "Two-way ANOVA (outcome, factor A, factor B)"], ["mann_whitney", "Mann-Whitney U"], ["wilcoxon_signed_rank", "Wilcoxon signed-rank"], ["kruskal_wallis", "Kruskal-Wallis"], ["friedman", "Friedman"], ["proportion_one_sample", "One-sample proportion"]], "auto")}{alpha}{sel("correction", "Pairwise comparisons after ANOVA / Kruskal–Wallis", [["holm", "Holm (default)"], ["bonferroni", "Bonferroni"], ["bh", "Benjamini–Hochberg (FDR)"], ["none", "None (omnibus test only)"]], "holm")}{num("mu", "Test value (one-sample t)", "0")}{num("p0", "Test proportion (0–1)", "0.5")}</>;
    case "correlation": return <>{sel("method", "Method", [["pearson", "Pearson"], ["spearman", "Spearman"], ["kendall", "Kendall"]], "pearson")}{alpha}</>;
    case "regression": return <>{sel("model", "Model", [["linear", "Linear (OLS)"], ["logistic", "Logistic (binary)"], ["multinomial", "Multinomial logistic"], ["mediation", "Mediation (Y, X, M)"]], "linear")}<label className="ax-toggle"><input type="checkbox" checked={!!o.moderation} onChange={(e) => set({ moderation: e.target.checked })} /> Moderation (interaction of first two predictors)</label>{def.options?.model === "logistic" && <label className="ax-field"><span>Target category code</span><input className="input small" value={(o.target as string | undefined) ?? ""} onChange={(e) => set({ target: e.target.value || undefined })} placeholder="last category" /></label>}</>;
    case "cluster": return <>{num("k", "Clusters (k)", "3")}{sel("method", "Method", [["kmeans", "K-means"], ["hierarchical", "Hierarchical (Ward)"]], "kmeans")}{varSel("profile", "Profile by", ["categorical"], true)}<label className="ax-toggle"><input type="checkbox" checked={o.standardize !== false} onChange={(e) => set({ standardize: e.target.checked })} /> Standardize variables</label></>;
    case "factor": return <>{num("factors", "Factors (blank = eigenvalue > 1)")}{sel("method", "Extraction", [["pca", "Principal components"], ["principal_axis", "Principal axis"]], "pca")}{sel("rotation", "Rotation", [["varimax", "Varimax"], ["none", "None"]], "varimax")}</>;
    case "trend": return <>{sel("period", "Period", [["_started_month", "Month"], ["_started_week", "Week"], ["_started_date", "Day"], ...variables.filter((v) => v.role === "categorical" && !v.derived).slice(0, 40).map((v) => [v.name, `Wave: ${v.label}`] as [string, string])], "_started_month")}{sel("metric", "Metric", [["mean", "Mean"], ["top2", "Top-2 box %"], ["pct", "% selecting a category"], ["nps", "NPS"], ["count", "Response count"]], "mean")}{num("rolling", "Rolling average (periods)", "0")}{num("baseline", "Baseline value")}</>;
    case "nps": return <>{varSel("by", "Break by", ["categorical"])}{varSel("drivers", "Driver variables", ["scale", "numeric"], true)}{sel("period", "Trend period", [["_started_month", "Month"], ["_started_week", "Week"]], "_started_month")}{num("target", "Target NPS")}</>;
    case "csat": return <>{sel("metric", "Metric", [["csat", "CSAT (satisfaction)"], ["ces", "CES (effort)"]], "csat")}{varSel("by", "Break by", ["categorical"])}{varSel("drivers", "Driver variables", ["scale", "numeric"], true)}{num("target", "Target %")}</>;
    case "turf": return <>{num("maxSize", "Max combination size", "5")}</>;
    case "gap": return <>{varSel("importance", "Importance items (in order)", ["scale", "numeric"], true)}{varSel("performance", "Performance items (same order)", ["scale", "numeric"], true)}</>;
    case "pricing": return <>{sel("method", "Method", [["van_westendorp", "Van Westendorp PSM"], ["gabor_granger", "Gabor-Granger"]], "van_westendorp")}{def.options?.method === "gabor_granger" && <><label className="ax-field"><span>Price points (comma-separated, in item order)</span><input className="input small" value={((o.prices as number[] | undefined) ?? []).join(", ")} onChange={(e) => set({ prices: e.target.value.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) })} placeholder="10, 20, 30" /></label><label className="ax-field"><span>Codes counted as “would buy”</span><input className="input small" value={((o.acceptCodes as string[] | undefined) ?? []).join(", ")} onChange={(e) => set({ acceptCodes: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="4, 5" /></label></>}</>;
    case "brand": return <>{varSel("image", "Image attributes (multi-select over brands)", ["multi"], true)}</>;
    case "text": return <><label className="ax-field"><span>Themes (name: keyword, keyword; one per line)</span><textarea className="ta" rows={4} value={((o.themes as { name: string; keywords: string[] }[] | undefined) ?? []).map((t) => `${t.name}: ${t.keywords.join(", ")}`).join("\n")} onChange={(e) => set({ themes: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [n, k = ""] = l.split(":"); return { name: n.trim(), keywords: k.split(",").map((x) => x.trim()).filter(Boolean) }; }) })} placeholder={"Service: service, support, staff\nPrice: expensive, cheap, value"} /></label>{varSel("by", "Sentiment by", ["categorical"])}{num("topN", "Top words", "30")}</>;
    case "quality": return <>{num("speedSeconds", "Speeder threshold (seconds; blank = 40% of median)")}</>;
    case "weighting": return <div className="muted" style={{ fontSize: 13 }}>Set rim targets in the Weighting section below; this analysis reports the weighting diagnostics and the weighted vs unweighted profile.</div>;
    case "conjoint": return <><label className="ax-toggle"><input type="checkbox" checked={!!o.includeHoldouts} onChange={(e) => set({ includeHoldouts: e.target.checked })} /> Include holdout tasks in estimation</label><label className="ax-field"><span>Price attribute (for WTP)</span><input className="input small" value={(o.priceAttribute as string | undefined) ?? ""} onChange={(e) => set({ priceAttribute: e.target.value || undefined })} placeholder="auto-detect" /></label><label className="ax-field"><span>Scenario profiles (JSON: [{"{"}name, levels{"}"}])</span><textarea className="ta" rows={3} value={o.scenario ? JSON.stringify(o.scenario) : ""} onChange={(e) => { try { set({ scenario: e.target.value ? JSON.parse(e.target.value) : undefined }); } catch { /* keep typing */ } }} placeholder='[{"name":"Product A","levels":{"Price":"$20","Brand":"Alpha"}}]' /></label></>;
    case "maxdiff": return <>{varSel("by", "Compare by", ["categorical"])}</>;
    case "hb": return <AdvancedHbOptions o={o} set={set} num={num} sel={sel} />;
    case "lca": return <>{num("minClasses", "Fewest classes", "1")}{num("maxClasses", "Most classes (≤ 8)", "4")}{num("starts", "Random starts per K", "20")}{num("seed", "Seed", "1")}{num("classes", "Show the solution with K classes (blank = lowest BIC)")}<div className="muted" style={{ fontSize: 12.5 }}>Every K in the range is fitted and compared (log-likelihood, AIC, BIC, SABIC, entropy); the lowest BIC is recommended, with the trade-offs shown — not chosen automatically. Respondents missing an indicator are left out (listwise).</div></>;
    case "sem": return <AdvancedSemOptions o={o} set={set} sel={sel} variables={variables} />;
    case "segmentation": return <>{alpha}</>;
    case "reliability": case "ranking": case "allocation": return <div className="muted" style={{ fontSize: 13 }}>No additional options.</div>;
    default: return null;
  }
}

/** HB options: chains, burn-in, draws, thinning, seed, prior (Sawtooth defaults), holdouts, simulator scenarios */
function AdvancedHbOptions({ o, set, num, sel }: { o: Record<string, unknown>; set: (o: Record<string, unknown>) => void; num: Num; sel: Sel }) {
  return (
    <div className="ax-optgroups" data-testid="ax-hb-options">
      <fieldset className="ax-optgroup"><legend>Sampler</legend>
        {sel("chains", "Chains", [["2", "2 (recommended — needed for R̂)"], ["1", "1"], ["3", "3"], ["4", "4"]], "2")}
        {num("burnIn", "Burn-in iterations per chain", "5000")}
        {num("draws", "Iterations kept from, per chain", "5000")}
        {num("thin", "Thinning (keep every k-th)", "5")}
        {num("seed", "Seed (same seed + data = same result)", "1")}
      </fieldset>
      <fieldset className="ax-optgroup"><legend>Prior</legend>
        {num("priorVariance", "Prior variance", "1")}
        {num("priorDf", "Additional prior degrees of freedom", "5")}
        <div className="muted" style={{ fontSize: 12.5 }}>Σ ~ inverse-Wishart; every level (reference included) gets the same prior variance. With few tasks per respondent, a smaller prior variance shrinks individual utilities more.</div>
      </fieldset>
      <fieldset className="ax-optgroup"><legend>Data &amp; simulation</legend>
        <label className="ax-toggle"><input type="checkbox" checked={!!o.includeHoldouts} onChange={(e) => set({ includeHoldouts: e.target.checked })} /> Include holdout tasks in estimation</label>
        <label className="ax-field"><span>Scenario profiles for the simulator (JSON: [{"{"}name, levels{"}"}])</span><textarea className="ta" rows={3} value={o.scenario ? JSON.stringify(o.scenario) : ""} onChange={(e) => { try { set({ scenario: e.target.value ? JSON.parse(e.target.value) : undefined }); } catch { /* keep typing */ } }} placeholder='[{"name":"Product A","levels":{"Price":"$20","Brand":"Alpha"}}]' /></label>
      </fieldset>
    </div>
  );
}

/** SEM options: the model in lavaan-style syntax, the scaling, and the variable names to write it with */
function AdvancedSemOptions({ o, set, sel, variables }: { o: Record<string, unknown>; set: (o: Record<string, unknown>) => void; sel: Sel; variables: VariableMeta[] }) {
  const syntax = (o.syntax as string | undefined) ?? "";
  const usable = variables.filter((v) => v.role === "scale" || v.role === "numeric").slice(0, 60);
  return (
    <div className="ax-optgroups" data-testid="ax-sem-options">
      <label className="ax-field" style={{ gridColumn: "1 / -1" }}><span>Model</span>
        <textarea className="ta" rows={7} value={syntax} onChange={(e) => set({ syntax: e.target.value })} data-testid="ax-sem-syntax" spellCheck={false} style={{ fontFamily: "var(--font-mono, monospace)" }}
          placeholder={"# measurement\nQuality =~ Q1 + Q2 + Q3\nLoyalty =~ L1 + L2 + L3\n# structural\nLoyalty ~ b*Quality\n# residual covariance\nQ1 ~~ Q2\n# defined effect\nind := a*b"} />
      </label>
      <div className="muted" style={{ fontSize: 12.5 }}>=~ measured by · ~ regressed on · ~~ covariance · := defined (indirect) effect · a* labels a path, 1* fixes it, NA* frees it. Estimated by maximum likelihood on complete cases; non-identified models are refused before running.</div>
      {sel("scaling", "Scale each factor by", [["marker", "its first loading (fixed to 1)"], ["unit_variance", "unit variance (all loadings free)"]], "marker")}
      {usable.length > 0 && <div className="ax-field"><span>Variables (click to add)</span><div className="ax-chips">{usable.map((v) => <button key={v.name} type="button" className="ax-chip" title={v.label} onClick={() => set({ syntax: `${syntax}${syntax && !/[\s+~]$/.test(syntax) ? " + " : ""}${v.name}` })}>{v.name}</button>)}</div></div>}
    </div>
  );
}

/** the four stages of an analysis, after the rail */
type Stage = "builder" | "results" | "chart" | "export";
const STAGES: { key: Stage; label: string }[] = [{ key: "builder", label: "Builder" }, { key: "results", label: "Results" }, { key: "chart", label: "Visualization" }, { key: "export", label: "Export" }];
const SECTIONS = ["Analysis type", "Variables", "Filters", "Segments & weighting", "Options"];

/** what "unsaved" compares: the definition as it would be saved */
const snapshotOf = (def: AnalysisDefinition, name: string, filter: Condition) => stableStringify({ ...def, name, filter: isEmptyCondition(filter) ? null : filter });
/** what "out of date" compares: the same, minus the name and how the table is formatted — neither changes a number */
const runSnapshotOf = (def: AnalysisDefinition, filter: Condition) => { const { formatting: _f, ...options } = (def.options ?? {}) as Record<string, unknown>; void _f; return stableStringify({ ...def, name: "", options, filter: isEmptyCondition(filter) ? null : filter }); };

export function AnalysisBuilder(p: BuilderProps) {
  const initialDef: AnalysisDefinition = p.initial?.definition ?? (p.initial?.analysis?.definition as AnalysisDefinition) ?? { name: "", kind: p.initial?.kind ?? "descriptive", dataset: p.dataset, variables: [], options: p.initial?.kind === "crosstab" ? { layout: "banner" } : {} };
  const [def, setDef] = React.useState<AnalysisDefinition>({ ...initialDef, dataset: initialDef.dataset ?? p.dataset });
  const [stage, setStage] = React.useState<Stage>(p.initial?.analysis ? "results" : "builder");
  const [section, setSection] = React.useState<number>(0);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<RunResult | null>(null);
  const [spec, setSpec] = React.useState<ChartSpec>({ type: "bar_vertical", options: {} });
  const [saved, setSaved] = React.useState<Row | null>(p.initial?.analysis ?? null);
  const [name, setName] = React.useState(initialDef.name ?? "");
  const [filter, setFilter] = React.useState<Condition>(initialDef.filter ?? emptyCondition());
  const [msg, setMsg] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [savedSnap, setSavedSnap] = React.useState<string | null>(p.initial?.analysis ? snapshotOf({ ...initialDef, dataset: initialDef.dataset ?? p.dataset }, initialDef.name ?? "", initialDef.filter ?? emptyCondition()) : null);
  const kindInfo = ANALYSIS_KINDS.find((k) => k.kind === def.kind)!;
  const themeId = spec.themeId ?? null;
  const theme = React.useMemo(() => (themeId ? (p.themes.find((t) => t.id === themeId)?.theme as ReportTheme | undefined) ?? null : null), [themeId, p.themes]);
  const canEdit = p.canEdit !== false;

  /*
   * The workspace's environment/quality selector SEEDS a new analysis and, when
   * the researcher changes it, re-points the one on screen. It must NOT run on
   * mount: opening a saved analysis used to overwrite its stored dataset with
   * the selector's default (LIVE / all), so the same analysis read n = 33 in the
   * builder and 0 in the report that was built from what had been saved.
   */
  const lastSelector = React.useRef(stableStringify(p.dataset));
  React.useEffect(() => {
    /* compares VALUES, not "is this the first run": React strict mode runs an effect twice on mount */
    const now = stableStringify(p.dataset);
    if (now === lastSelector.current) return;
    lastSelector.current = now;
    setDef((d) => ({ ...d, dataset: p.dataset }));
  }, [p.dataset]);
  // a saved analysis opens on its results: recompute from its stored definition
  const autoRan = React.useRef(false);
  React.useEffect(() => { if (p.initial?.analysis && !autoRan.current) { autoRan.current = true; void run(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* UNSAVED: the definition on screen differs from the one last saved (or nothing was saved yet and something was built) */
  const snap = snapshotOf(def, name, filter);
  const dirty = savedSnap ? snap !== savedSnap : (def.variables.length > 0 || (def.rows?.length ?? 0) > 0 || (def.columns?.length ?? 0) > 0 || !!name);
  React.useEffect(() => { p.onDirty?.(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  /* the run on screen is older than the definition — say so */
  const ranSnap = React.useRef<string | null>(null);
  const stale = !!result && ranSnap.current !== null && ranSnap.current !== runSnapshotOf(def, filter);

  const update = (patch: Partial<AnalysisDefinition>) => setDef((d) => ({ ...d, ...patch }));
  const setOpt = (o: Record<string, unknown>) => setDef((d) => ({ ...d, options: { ...(d.options ?? {}), ...o }, ...(o.measure ? { measure: o.measure as AnalysisDefinition["measure"] } : {}) }));
  const formatting = ((def.options?.formatting as TableFormatting | undefined) ?? {});
  const setFormatting = (f: TableFormatting) => setOpt({ formatting: f });
  const current = (): AnalysisDefinition => ({ ...def, name: name || def.name || kindInfo.label, filter: isEmptyCondition(filter) ? null : filter });

  /* only the LATEST run may land: an earlier, slower response must not overwrite a newer result or clear `running` under it */
  const runSeq = React.useRef(0);
  /*
   * CHUNKED MODEL RUNS (HB, migration 0066): the server advances the chains ≤ 40 s per request and keeps their state;
   * the builder keeps asking until the run is done, showing progress, and can cancel. A newer Run or Cancel stops the loop.
   */
  const [job, setJob] = React.useState<ModelJobView | null>(null);
  const cancelJob = React.useRef(false);
  const runJob = async (d: AnalysisDefinition, mine: number): Promise<{ result: RunResult }> => {
    cancelJob.current = false;
    let j = (await p.api.modelStart(d, saved?.id ?? null)).job;
    setJob(j);
    while (j.status === "running") {
      if (mine !== runSeq.current) throw new Error("superseded");
      if (cancelJob.current) { j = (await p.api.modelCancel(j.id)).job; setJob(null); throw new Error("The hierarchical Bayes run was cancelled."); }
      j = (await p.api.modelContinue(j.id)).job;
      setJob(j);
    }
    setJob(null);
    if ((j.status === "done" || j.status === "refused") && j.result) return { result: j.result as RunResult };
    throw new Error(j.error ?? `The model run ${j.status}.`);
  };
  const run = async () => {
    const mine = ++runSeq.current;
    setRunning(true); setError(null); setMsg(null);
    try {
      const d = current();
      const snapAtStart = runSnapshotOf(def, filter);
      const { result } = d.kind === "hb" ? await runJob(d, mine) : await p.api.run(d);
      if (mine !== runSeq.current) return;
      setResult(result); ranSnap.current = snapAtStart;
      setSpec((s) => ({ ...s, type: result.recommendations[0]?.type ?? result.recommendedCharts[0] ?? "bar_vertical" }));
      setStage("results");
    } catch (e) { if (mine === runSeq.current) setError((e as Error).message); } finally { if (mine === runSeq.current) setRunning(false); }
  };

  /*
   * ONE save at a time. A second click (or "Save chart" racing "Add to report")
   * used to POST a second create for an analysis that had no id yet — two
   * copies. Callers that arrive while a save is in flight share its promise.
   */
  const [saving, setSaving] = React.useState(false);
  const inflight = React.useRef<Promise<Row> | null>(null);
  const persist = (): Promise<Row> => {
    if (inflight.current) return inflight.current;
    const d = current(); const snapNow = snapshotOf(def, name, filter);
    setSaving(true);
    const op = (async () => {
      const r = saved ? await p.api.update("analyses", saved.id, { name: d.name, definition: d }) : await p.api.create("analyses", { name: d.name, definition: d });
      setSaved(r.item); setSavedSnap(snapNow); p.onSaved?.(r.item);
      return r.item as Row;
    })().finally(() => { inflight.current = null; setSaving(false); });
    inflight.current = op;
    return op;
  };
  const save = async () => {
    try { const item = await persist(); setMsg(saved ? `Saved as version ${item.version}.` : "Analysis saved."); } catch (e) { setError((e as Error).message); }
  };
  const ensureSaved = async (): Promise<Row> => {
    if (saved && !dirty && !inflight.current) return saved;
    return persist();
  };
  /* what leaves this screen (an export, a saved chart, a report block) must describe the numbers on it */
  const notCurrent = stale || running;
  const refuseStale = (): boolean => { if (!notCurrent) return false; setError(running ? "The analysis is still running — wait for it to finish." : "Results are out of date — run the analysis again before exporting or saving a chart from it."); return true; };
  const saveChart = async () => {
    if (!result || refuseStale()) return;
    try {
      const a = await ensureSaved();
      const r = await p.api.create("charts", { analysisId: a.id, name: spec.options.title ?? `${a.name} — ${spec.type}`, spec, themeId: spec.themeId ?? null });
      setMsg("Chart saved and linked to this analysis."); p.onChartSaved?.(r.item);
    } catch (e) { setError((e as Error).message); }
  };
  const exportAs = (format: "pptx" | "xlsx") => refuseStale() ? Promise.resolve() : p.api.export({ format, ...(saved && !dirty ? { analysisId: saved.id } : { definition: current() }), chart: spec, themeId: spec.themeId ?? null }).then(() => undefined).catch((e) => setError(e.message));

  const segmentsChosen = def.segments ?? [];
  const toggleSegment = (s: Row) => { const cur = segmentsChosen; update({ segments: cur.some((x) => x.id === s.id) ? cur.filter((x) => x.id !== s.id) : [...cur, { id: s.id, name: s.name, condition: s.condition as Condition, color: s.color ?? undefined }] }); };
  const roles = ROLE_FOR_KIND[def.kind];
  /*
   * ONE RULE (the Apply audit, 2026-10-17): Run is enabled exactly when the analytics package's
   * `analysisReadiness` — the same check the run route, the plan editor and the plan's item states
   * read — says the definition can be computed; when it cannot, the footer names what is missing.
   * The old local rule enabled any kind with one variable (a correlation of one variable "ran" into
   * a warning) and disabled weighting by rim targets and segment profiles, which need no variables.
   */
  const readiness = React.useMemo(() => analysisReadiness(def, p.variables), [def, p.variables]);
  const canRun = readiness.ready;
  const goSection = (i: number) => { if (i === 5) { if (result) setStage("results"); else void run(); return; } setStage("builder"); setSection(i); };
  const chartHost = React.useRef<HTMLDivElement | null>(null);
  /* where a variable ticked in the picker lands: Rows until one is there, then Columns — or wherever the researcher points */
  const [xtTarget, setXtTarget] = React.useState<"auto" | "rows" | "columns" | "layers">("auto");

  const summary = `${kindInfo.label} · ${def.kind === "crosstab" ? `${(def.rows ?? []).length} row${(def.rows ?? []).length === 1 ? "" : "s"} × ${(def.columns ?? []).length} column${(def.columns ?? []).length === 1 ? "" : "s"}` : `${def.variables.length} variable${def.variables.length === 1 ? "" : "s"}`}${!isEmptyCondition(filter) || def.filterIds?.length ? " · filtered" : ""}${segmentsChosen.length ? ` · ${segmentsChosen.length} segments` : ""}${def.weighting ? " · weighted" : ""} · ${def.dataset.environment === "LIVE" ? "Production" : def.dataset.environment === "TEST" ? "Test" : "All"} data${saved ? ` · saved v${saved.version}` : ""}`;

  const actions = (
    <>
      {canEdit && <button className="btn small" onClick={save} disabled={saving} data-testid="ax-save" title={dirty ? "Save the definition (a real change creates a new version)" : "Nothing to save"}>{saved ? "Save changes" : "Save analysis"}{dirty && <span className="ax-dirty" aria-label="unsaved" />}</button>}
      <button className="btn small" onClick={saveChart} data-testid="ax-save-chart" disabled={!canEdit}>Save chart</button>
      {p.onAddToReport && canEdit && <button className="btn small" onClick={async () => { if (refuseStale()) return; try { const a = await ensureSaved(); p.onAddToReport!(a, spec); } catch (e) { setError((e as Error).message); } }}>Add to report</button>}
      <button className="btn small" onClick={() => exportAs("pptx")} data-testid="ax-export-pptx" disabled={p.canExport === false}>PPT</button>
      <button className="btn small" onClick={() => exportAs("xlsx")} data-testid="ax-export-xlsx" disabled={p.canExport === false}>Excel</button>
    </>
  );

  return (
    <div className="ax-builder" data-testid="ax-builder" data-stage={stage} data-dirty={dirty ? "1" : "0"}>
      {/* the stages: Builder → Results → Visualization → Export */}
      <div className="ax-stages" role="tablist">
        {STAGES.map((s, i) => {
          const needsResult = s.key !== "builder";
          const off = needsResult && !result;
          return <button key={s.key} role="tab" aria-selected={stage === s.key} className={`ax-stage ${stage === s.key ? "on" : ""} ${off ? "dim" : ""}`} onClick={() => (off ? (canRun ? run() : setStage("builder")) : setStage(s.key))} data-testid={`ax-stage-${s.key}`} title={off ? "Run the analysis first" : undefined}><span className="ax-stage-n">{i + 1}</span>{s.label}</button>;
        })}
        <span className="grow" />
        {stale && <span className="ax-stale" data-testid="ax-stale" title="The definition changed since this result was computed">Results are out of date — run again</span>}
        <span className={`ax-savestate ${dirty ? "dirty" : ""}`} data-testid="ax-savestate">{dirty ? <><span className="ax-dirty" /> Unsaved changes</> : saved ? `Saved · v${saved.version}` : "New analysis"}</span>
      </div>

      {stage === "builder" && (
        <div className="ax-builder-grid">
          <nav className="ax-sections" aria-label="Builder sections">
            {SECTIONS.map((s, i) => <button key={s} className={`ax-step ${section === i ? "on" : ""}`} onClick={() => goSection(i)} data-testid={`ax-step-${i}`}><span className="ax-step-n">{i + 1}</span>{s}</button>)}
            <button className={`ax-step ${!result ? "dim" : ""}`} onClick={() => goSection(5)} data-testid="ax-step-5"><span className="ax-step-n">6</span>Results</button>
          </nav>
          <div className="ax-builder-body">
            {section === 0 && (
              <div>
                <div className="row" style={{ marginBottom: 10 }}><input className="input" placeholder="Analysis name (e.g. Brand preference by gender)" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 460 }} data-testid="ax-name" /></div>
                {[...new Set(ANALYSIS_KINDS.map((k) => k.group))].map((g) => (
                  <div key={g} className="ax-kind-group"><div className="ax-vargroup-head">{g}</div>
                    <div className="ax-kinds">{ANALYSIS_KINDS.filter((k) => k.group === g).map((k) => <button key={k.kind} className={`ax-kind ${def.kind === k.kind ? "on" : ""}`} onClick={() => { update({ kind: k.kind, variables: def.kind === k.kind ? def.variables : [], options: def.kind === k.kind ? def.options : k.kind === "crosstab" ? { layout: "banner" } : {} }); setResult(null); }} data-testid={`ax-kind-${k.kind}`}><div className="ax-kind-label">{k.label}</div><div className="ax-kind-desc">{k.description}</div></button>)}</div>
                  </div>
                ))}
              </div>
            )}
            {section === 1 && (
              <div>
                <div className="muted" style={{ marginBottom: 8 }}>{HINT[def.kind]}</div>
                {def.kind === "crosstab" ? (
                  <div className="ax-xt-layout">
                    <div className="ax-xt-zones">
                      <DropZone label="Rows" items={def.rows ?? []} onChange={(v) => update({ rows: v })} variables={p.variables} hint="The questions down the side" />
                      <DropZone label="Columns" items={def.columns ?? []} onChange={(v) => update({ columns: v })} variables={p.variables} hint="The banner across the top" />
                      <DropZone label="Layers" items={def.layers ?? []} onChange={(v) => update({ layers: v.slice(0, 1) })} variables={p.variables} hint="Optional: one table per category" />
                      <div className="ax-xt-target" role="radiogroup" aria-label="Ticked variables go to" data-testid="ax-xt-target">
                        <span className="muted" style={{ fontSize: 12.5 }}>Ticked variables go to</span>
                        {(["auto", "rows", "columns", "layers"] as const).map((t) => <button key={t} type="button" role="radio" aria-checked={xtTarget === t} className={`ax-chip ${xtTarget === t ? "on" : ""}`} onClick={() => setXtTarget(t)} data-testid={`ax-xt-target-${t}`}>{t === "auto" ? "Auto" : t[0].toUpperCase() + t.slice(1)}</button>)}
                      </div>
                      <div className="ax-xt-summary">
                        <span>{MEASURE_LABEL[def.measure ?? "pct_col"]}</span>
                        <span>·</span><span>{def.options?.layout === "banner" ? "Banner" : "Separate tables"}</span>
                        {def.options?.nestRows && (def.rows?.length ?? 0) >= 2 ? <><span>·</span><span>Nested rows</span></> : null}
                        <span>·</span><span>{def.options?.significance === false ? "No letters" : `Letters at ${Math.round((1 - ((def.options?.alpha as number | undefined) ?? 0.05)) * 100)}%`}</span>
                        <button type="button" className="ax-linkbtn" onClick={() => setSection(4)}>Options ›</button>
                      </div>
                    </div>
                    <VariablePicker variables={p.variables} selected={[...(def.rows ?? []), ...(def.columns ?? []), ...(def.layers ?? [])]} onChange={(v) => {
                      const rows = def.rows ?? [], cols = def.columns ?? [], lays = def.layers ?? [];
                      const added = v.find((x) => !rows.includes(x) && !cols.includes(x) && !lays.includes(x));
                      const removed = [...rows, ...cols, ...lays].find((x) => !v.includes(x));
                      if (added) {
                        const where = xtTarget === "auto" ? (rows.length === 0 ? "rows" : "columns") : xtTarget;
                        update(where === "rows" ? { rows: [...rows, added] } : where === "columns" ? { columns: [...cols, added] } : { layers: [added] });
                      }
                      if (removed) update({ rows: rows.filter((x) => x !== removed), columns: cols.filter((x) => x !== removed), layers: lays.filter((x) => x !== removed) });
                    }} roles={roles} />
                  </div>
                ) : <VariablePicker variables={p.variables} selected={def.variables} onChange={(v) => update({ variables: v })} roles={roles} max={["nps", "turf", "ranking", "allocation", "text", "conjoint", "maxdiff", "hb"].includes(def.kind) ? 1 : undefined} />}
              </div>
            )}
            {section === 2 && (
              <div>
                <div className="muted" style={{ marginBottom: 8 }}>Filter the dataset before the analysis runs. Saved filters can be applied alongside an ad-hoc filter; everything combines with AND.</div>
                <FilterBuilder value={filter} onChange={setFilter} variables={p.variables} />
                {p.segments.filter((s) => s.kind === "filter").length > 0 && <div style={{ marginTop: 10 }}><div className="flabel">Saved filters</div><div className="ax-chips">{p.segments.filter((s) => s.kind === "filter").map((s) => { const on = def.filterIds?.includes(s.id); return <button key={s.id} type="button" className={`ax-chip ${on ? "on" : ""}`} onClick={() => update({ filterIds: on ? (def.filterIds ?? []).filter((x) => x !== s.id) : [...(def.filterIds ?? []), s.id] })} title={conditionText(s.condition as Condition, p.variables)} data-testid="ax-saved-filter">{s.name}</button>; })}</div></div>}
                {(!isEmptyCondition(filter) || def.filterIds?.length) ? (
                  <div className="ax-summary" data-testid="ax-filter-text">
                    {[...(def.filterIds ?? []).map((id) => p.segments.find((s) => s.id === id)).filter(Boolean).map((s) => `[${s!.name}] ${conditionText(s!.condition as Condition, p.variables)}`), ...(!isEmptyCondition(filter) ? [conditionText(filter, p.variables)] : [])].join("  AND  ")}
                  </div>
                ) : null}
              </div>
            )}
            {section === 3 && (
              <div>
                <div className="muted" style={{ marginBottom: 8 }}>Segments are compared side by side (and drive segment switching on charts). Create reusable segments in the Segments tab.</div>
                <div className="ax-chips">{p.segments.filter((s) => s.kind !== "filter").map((s) => <button key={s.id} type="button" className={`ax-chip ${segmentsChosen.some((x) => x.id === s.id) ? "on" : ""}`} onClick={() => toggleSegment(s)} title={conditionText(s.condition as Condition, p.variables)} data-testid="ax-segment-chip">{s.name}</button>)}{!p.segments.filter((s) => s.kind !== "filter").length && <span className="muted">No saved segments yet.</span>}</div>
                <div style={{ marginTop: 14 }}>
                  <div className="flabel">Weighting</div>
                  <WeightingEditor value={def.weighting ?? null} onChange={(w) => update({ weighting: w })} variables={p.variables} />
                </div>
              </div>
            )}
            {section === 4 && <div className="ax-options"><Options def={def} set={setOpt} variables={p.variables} /></div>}
          </div>
        </div>
      )}

      {stage === "results" && result && (
        <ResultView result={result} recommendations={result.recommendations} advice={result.advice} spec={spec} onSpec={setSpec} theme={theme} themes={p.themes.map((t) => ({ id: t.id, name: t.name }))} selected={selected} onSelectCategory={setSelected} view="results" formatting={formatting} onFormatting={setFormatting} actions={actions} />
      )}
      {stage === "chart" && result && (
        <div ref={chartHost}>
          <ResultView result={result} recommendations={result.recommendations} advice={result.advice} spec={spec} onSpec={setSpec} theme={theme} themes={p.themes.map((t) => ({ id: t.id, name: t.name }))} selected={selected} onSelectCategory={setSelected} view="chart" actions={actions} />
        </div>
      )}
      {stage === "export" && result && (
        <div className="ax-export-stage" data-testid="ax-export-stage">
          <div className="card">
            <div className="card-title">Deliverables</div>
            <p className="muted" style={{ fontSize: 13.5 }}>Every export is rebuilt from the definition — the same numbers as the tables on screen, in the current theme.</p>
            <div className="ax-export-grid">
              <button type="button" className="ax-export-tile" onClick={() => exportAs("pptx")} disabled={p.canExport === false} data-testid="ax-export-pptx"><span className="ax-export-k">PowerPoint</span><span className="ax-export-d">Chart slide + one slide per table, styled by the report theme.</span></button>
              <button type="button" className="ax-export-tile" onClick={() => exportAs("xlsx")} disabled={p.canExport === false} data-testid="ax-export-xlsx"><span className="ax-export-k">Excel</span><span className="ax-export-d">Every table on its own sheet, significance in the cells.</span></button>
              <button type="button" className="ax-export-tile" onClick={() => { const host = document.querySelector('[data-testid="ax-export-preview"]') as HTMLElement | null; downloadPng(host, (spec.options.title ?? result.name).replace(/[^\w.-]+/g, "_")); }} data-testid="ax-export-png"><span className="ax-export-k">PNG</span><span className="ax-export-d">The chart at 3× resolution for a document or a slide.</span></button>
              <button type="button" className="ax-export-tile" onClick={() => { const host = document.querySelector('[data-testid="ax-export-preview"]') as HTMLElement | null; downloadSvg(host, (spec.options.title ?? result.name).replace(/[^\w.-]+/g, "_")); }} data-testid="ax-export-svg"><span className="ax-export-k">SVG</span><span className="ax-export-d">The chart as a vector, editable in design tools.</span></button>
            </div>
          </div>
          <div className="card">
            <div className="card-title">Keep &amp; share</div>
            <div className="row" style={{ flexWrap: "wrap", gap: 8, marginTop: 6 }}>
              {canEdit && <button className="btn" onClick={save} disabled={saving} data-testid="ax-save-export">{saved ? "Save changes" : "Save analysis"}{dirty && <span className="ax-dirty" />}</button>}
              <button className="btn" onClick={saveChart} disabled={!canEdit}>Save chart to library</button>
              {p.onAddToReport && canEdit && <button className="btn" onClick={async () => { if (refuseStale()) return; try { const a = await ensureSaved(); p.onAddToReport!(a, spec); } catch (e) { setError((e as Error).message); } }}>Add to a report</button>}
              <span className="muted" style={{ fontSize: 13 }}>Reports are published and shared from the Reports and Sharing tabs.</span>
            </div>
          </div>
          <div className="card" data-testid="ax-export-preview">
            <div className="card-title">Preview</div>
            <Chart result={result} spec={spec} theme={theme} />
          </div>
        </div>
      )}
      {stage !== "builder" && !result && <div className="ax-empty"><div className="ax-empty-t">No results yet</div><div className="ax-empty-d">Run the analysis to see its tables and charts.</div></div>}

      <div className="ax-builder-foot">
        {error && <span className="ax-error" data-testid="ax-error">{error}</span>}
        {msg && <span className="ax-ok" data-testid="ax-msg">{msg}</span>}
        <span className="muted" style={{ fontSize: 13 }}>{summary}</span>
        <span className="grow" />
        {stage === "builder" && section > 0 && <button className="btn small" onClick={() => setSection(section - 1)}>Back</button>}
        {stage === "builder" && section < 4 && <button className="btn small" onClick={() => setSection(section + 1)}>Next</button>}
        {job && job.status === "running" && <span className="ax-job" data-testid="ax-job-progress" data-pct={job.progress.pct} role="status">Hierarchical Bayes: {job.progress.done.toLocaleString()} of {job.progress.total.toLocaleString()} iterations per chain ({job.progress.pct}%){job.progress.projectedMs && job.progress.done ? ` · about ${Math.max(1, Math.round((job.progress.projectedMs * (1 - job.progress.done / Math.max(1, job.progress.total))) / 1000))} s left` : ""} <button type="button" className="btn small" onClick={() => { cancelJob.current = true; }} data-testid="ax-job-cancel">Cancel</button></span>}
        {!canRun && <span className="ax-error" data-testid="ax-run-missing" role="status">{readiness.missing.join(" ")}</span>}
        {canRun && readiness.warnings.length > 0 && <span className="muted" style={{ fontSize: 12.5 }} data-testid="ax-run-warning">{readiness.warnings.join(" ")}</span>}
        <button className="btn primary" disabled={!canRun || running} onClick={run} data-testid="ax-run" data-ready={canRun ? "1" : "0"} title={canRun ? undefined : readiness.missing.join(" ")}>{running ? "Running…" : stale ? "Run again" : "Run analysis"}</button>
      </div>
    </div>
  );
}

const MEASURE_LABEL: Record<string, string> = { pct_col: "Column %", pct_row: "Row %", pct_total: "Total %", count: "Counts", mean: "Means" };

export function WeightingEditor({ value, onChange, variables }: { value: AnalysisDefinition["weighting"]; onChange: (w: AnalysisDefinition["weighting"]) => void; variables: VariableMeta[] }) {
  const cats = variables.filter((v) => v.role === "categorical" && v.categories?.length && !v.derived);
  const rim = value?.rim ?? [];
  return (
    <div className="ax-weighting" data-testid="ax-weighting">
      <div className="row" style={{ gap: 6, marginBottom: 6 }}>
        <select className="select small" value={value?.variable ?? ""} onChange={(e) => onChange(e.target.value ? { variable: e.target.value } : rim.length ? { rim } : null)}><option value="">No weight variable</option>{variables.filter((v) => v.role === "numeric").map((v) => <option key={v.name} value={v.name}>Use {v.label} as weight</option>)}</select>
        <select className="select small" value="" onChange={(e) => { const v = cats.find((x) => x.name === e.target.value); if (v) onChange({ ...(value ?? {}), variable: undefined, rim: [...rim, { variable: v.name, targets: Object.fromEntries((v.categories ?? []).map((c) => [c.code, Math.round(100 / (v.categories!.length))])) }] }); }}><option value="">+ Add rim target…</option>{cats.filter((c) => !rim.some((r) => r.variable === c.name)).map((v) => <option key={v.name} value={v.name}>{v.label}</option>)}</select>
        {!!rim.length && <label className="ax-field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><span>Cap weights</span><input className="input small" style={{ width: 60 }} type="number" step={0.1} value={value?.cap?.[0] ?? ""} placeholder="min" onChange={(e) => onChange({ ...value!, cap: [Number(e.target.value) || 0.2, value?.cap?.[1] ?? 5] })} /><input className="input small" style={{ width: 60 }} type="number" step={0.1} value={value?.cap?.[1] ?? ""} placeholder="max" onChange={(e) => onChange({ ...value!, cap: [value?.cap?.[0] ?? 0.2, Number(e.target.value) || 5] })} /></label>}
      </div>
      {rim.map((r, i) => { const v = variables.find((x) => x.name === r.variable); const sum = Object.values(r.targets).reduce((a, b) => a + b, 0); return (
        <div key={r.variable} className="ax-rim" data-testid="ax-rim">
          <div className="row" style={{ marginBottom: 4 }}><strong>{v?.label ?? r.variable}</strong><span className={`muted ${Math.abs(sum - 100) > 0.5 ? "ax-error" : ""}`} style={{ fontSize: 13 }}>targets sum to {sum.toFixed(1)}%</span><span className="grow" /><button className="btn small" onClick={() => onChange(rim.length === 1 && !value?.variable ? null : { ...value!, rim: rim.filter((_, j) => j !== i) })}>Remove</button></div>
          <div className="ax-rim-cells">{(v?.categories ?? Object.keys(r.targets).map((c) => ({ code: c, label: c }))).map((c) => <label key={c.code} className="ax-field"><span>{c.label}</span><input className="input small" type="number" step={0.1} value={r.targets[c.code] ?? ""} onChange={(e) => onChange({ ...value!, rim: rim.map((x, j) => (j === i ? { ...x, targets: { ...x.targets, [c.code]: Number(e.target.value) } } : x)) })} /></label>)}</div>
        </div>); })}
      {!value && <div className="muted" style={{ fontSize: 13 }}>Unweighted. Add rim targets (e.g. gender 49 / 51) or pick a weight variable; tables and charts then report weighted n.</div>}
    </div>
  );
}

export type { SegmentDef };
