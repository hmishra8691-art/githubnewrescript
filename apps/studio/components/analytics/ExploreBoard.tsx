"use client";
import React from "react";
import type { AnalysisDefinition, ChartSpec, ChartType, DatasetSpec, ReportTheme, VariableMeta } from "@rescript/analytics";
import type { AxApi, Row, RunResult } from "./api";
import { Chart, ResultTableView } from "./charts/Chart";
import { MAX_PICK, chartChoices, combinedFilter, crossFilter, exploreDefinition, exploreRole, type CrossFilterState } from "@/lib/analyticsExplore";
import { conditionText } from "./FilterBuilder";
import { InterpretationPanel } from "./InterpretationPanel";

/**
 * EXPLORE — the interactive board (Analytics upgrade M3).
 *
 * Pick variables; the board says which analysis fits them and why, runs it server-side and draws it. Each
 * panel switches between the charts that fit its result, shows its table, and can be saved as an analysis (and
 * its chart) — the same saved objects the builder and Architect work on. Click a bar and every other panel is
 * filtered to that group (cross-filtering); the clicked panel keeps its selection highlighted; the filter chips
 * clear one by one or all at once. Nothing is computed in the browser.
 */
interface Panel { id: string; definition: AnalysisDefinition; because: string; spec: ChartSpec; result: RunResult | null; error: string | null; loading: boolean; table: boolean; explain: boolean; savedId: string | null; /** the variable a click on a category means */ clickVariable: string | null }

const ROLE_WORD: Record<string, string> = { category: "category", quantity: "quantity", text: "text", other: "" };

export function ExploreBoard(p: { api: AxApi; dataset: DatasetSpec; variables: VariableMeta[]; themes: { id: string; name: string; theme: ReportTheme }[]; canEdit: boolean; onSaved: () => void; onOpenInBuilder: (a: Row) => void; onAsk: () => void }) {
  const [search, setSearch] = React.useState("");
  const [picked, setPicked] = React.useState<string[]>([]);
  const [panels, setPanels] = React.useState<Panel[]>([]);
  const [cross, setCross] = React.useState<(CrossFilterState & { panelId: string })[]>([]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const seq = React.useRef(0);

  const usable = React.useMemo(() => p.variables.filter((v) => !v.hidden && exploreRole(v) !== "other" && v.optionCode == null), [p.variables]);
  const shown = React.useMemo(() => { const q = search.trim().toLowerCase(); return (q ? usable.filter((v) => [v.name, v.label, v.questionCode ?? "", v.itemLabel ?? ""].join(" ").toLowerCase().includes(q)) : usable).slice(0, 200); }, [usable, search]);
  const choice = React.useMemo(() => exploreDefinition(picked, p.variables, p.dataset), [picked, p.variables, p.dataset]);

  const clickVariableFor = (d: AnalysisDefinition): string | null => d.kind === "crosstab" ? d.rows?.[0] ?? null : d.kind === "test" ? d.variables[1] ?? null : d.kind === "descriptive" ? d.variables[0] ?? null : null;

  const run = React.useCallback(async (panel: Panel, filter: AnalysisDefinition["filter"]) => {
    const definition: AnalysisDefinition = { ...panel.definition, ...(filter ? { filter } : {}) };
    if (!filter) delete (definition as { filter?: unknown }).filter;
    setPanels((ps) => ps.map((x) => (x.id === panel.id ? { ...x, loading: true, error: null } : x)));
    try {
      const { result } = await p.api.run(definition);
      setPanels((ps) => ps.map((x) => (x.id === panel.id ? { ...x, result, loading: false, spec: x.spec.type === "bar_vertical" && !x.result ? { ...x.spec, type: result.recommendations[0]?.type ?? result.recommendedCharts[0] ?? "bar_vertical" } : x.spec } : x)));
    } catch (e) { setPanels((ps) => ps.map((x) => (x.id === panel.id ? { ...x, loading: false, error: (e as Error).message } : x))); }
  }, [p.api]);

  /* the filter each panel runs under: every cross-filter that did not come from the panel itself */
  const filterFor = React.useCallback((panelId: string) => combinedFilter(null, cross.filter((c) => c.panelId !== panelId)), [cross]);

  const addPanel = () => {
    if (!choice) return;
    const panel: Panel = { id: `p${++seq.current}`, definition: choice.definition, because: choice.because, spec: { type: "bar_vertical", options: { title: choice.definition.name } }, result: null, error: null, loading: true, table: false, explain: false, savedId: null, clickVariable: clickVariableFor(choice.definition) };
    setPanels((ps) => [panel, ...ps]);
    void run(panel, filterFor(panel.id));
  };
  /* a changed cross-filter re-runs every panel it applies to */
  const crossKey = cross.map((c) => `${c.panelId}:${c.variable}=${c.category}`).join("|");
  const lastKey = React.useRef(crossKey);
  React.useEffect(() => {
    if (lastKey.current === crossKey) return;
    lastKey.current = crossKey;
    for (const panel of panels) void run(panel, filterFor(panel.id));
  }, [crossKey]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { for (const panel of panels) void run(panel, filterFor(panel.id)); }, [p.dataset.environment, p.dataset.dataset]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = (panel: Panel, category: string | null) => {
    if (!panel.clickVariable) return;
    const v = p.variables.find((x) => x.name === panel.clickVariable); if (!v) return;
    setCross((cs) => {
      const rest = cs.filter((c) => c.panelId !== panel.id);
      if (!category) return rest;
      const rule = crossFilter(v, category); if (!rule) return rest;
      return [...rest, { panelId: panel.id, variable: v.name, label: v.itemLabel ? `${v.label} — ${v.itemLabel}` : v.label, category, rule }];
    });
  };
  const save = async (panel: Panel) => {
    try {
      const r = await p.api.create("analyses", { name: panel.definition.name, definition: panel.definition });
      const a = r.item;
      if (panel.result) await p.api.create("charts", { analysisId: a.id, name: panel.spec.options.title ?? panel.definition.name, spec: panel.spec, themeId: panel.spec.themeId ?? null }).catch(() => null);
      setPanels((ps) => ps.map((x) => (x.id === panel.id ? { ...x, savedId: String(a.id) } : x)));
      setNotice(`“${panel.definition.name}” saved — it is in Architect and the builder now.`);
      p.onSaved();
    } catch (e) { setNotice((e as Error).message); }
  };
  const theme = (id: string | null | undefined) => p.themes.find((t) => t.id === id)?.theme ?? null;

  return (
    <div className="ax-explore" data-testid="ax-explore">
      <aside className="ax-explore-picker">
        <div className="ax-explore-pick-head"><b>Variables</b><span className="muted">{usable.length}</span></div>
        <input className="input" placeholder="Find a question…" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="ax-explore-search" />
        {picked.length > 0 && (
          <div className="ax-explore-picked" data-testid="ax-explore-picked">
            {picked.map((n) => { const v = p.variables.find((x) => x.name === n); return <span key={n} className="ax-chip on">{v?.itemLabel ? `${v.label} — ${v.itemLabel}` : v?.label ?? n} <button className="ax-explore-x" aria-label={`Remove ${n}`} onClick={() => setPicked((ps) => ps.filter((x) => x !== n))}>×</button></span>; })}
          </div>
        )}
        {choice && (
          <div className="ax-explore-choice" data-testid="ax-explore-choice">
            <div className="eyebrow">{choice.kind === "crosstab" ? "Crosstab" : choice.kind === "test" ? "Comparison of means" : choice.kind === "correlation" ? "Correlation" : choice.kind === "text" ? "Text analysis" : "Distribution"}</div>
            <p className="muted" style={{ fontSize: 12.5, margin: "2px 0 6px" }}>{choice.because}</p>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn primary small" onClick={addPanel} data-testid="ax-explore-add">Show it</button>
              <button className="btn small ghost" onClick={() => setPicked([])}>Clear</button>
            </div>
          </div>
        )}
        {!choice && <p className="muted" style={{ fontSize: 12.5, margin: "8px 0" }}>Pick one to {MAX_PICK} variables. One is described; a category by a category is a crosstab; a quantity by a category compares means; quantities together correlate.</p>}
        <div className="ax-explore-vars" role="list">
          {shown.map((v) => { const on = picked.includes(v.name); const role = exploreRole(v); return (
            <button key={v.name} role="listitem" className={`ax-explore-var ${on ? "on" : ""}`} disabled={!on && picked.length >= MAX_PICK} onClick={() => setPicked((ps) => (on ? ps.filter((x) => x !== v.name) : [...ps, v.name]))} title={v.label} data-testid="ax-explore-var" data-name={v.name}>
              <span className="ax-explore-var-code mono">{v.questionCode ?? v.name}</span>
              <span className="ax-explore-var-label">{v.itemLabel ? `${v.label} — ${v.itemLabel}` : v.label}</span>
              <span className={`ax-explore-role ${role}`}>{ROLE_WORD[role]}</span>
            </button>); })}
          {!shown.length && <div className="muted" style={{ padding: 8, fontSize: 12.5 }}>Nothing matches.</div>}
        </div>
      </aside>
      <main className="ax-explore-main">
        <div className="ax-explore-bar">
          <b>Board</b>
          <span className="muted" style={{ fontSize: 12.5 }}>{panels.length ? `${panels.length} panel${panels.length === 1 ? "" : "s"}` : "empty"}</span>
          {cross.length > 0 && <span className="ax-explore-filters" data-testid="ax-explore-filters">
            <span className="muted" style={{ fontSize: 12 }}>Filtered to</span>
            {cross.map((c) => <span key={c.panelId} className="ax-chip on">{c.label}: {c.category} <button className="ax-explore-x" aria-label="Remove filter" onClick={() => setCross((cs) => cs.filter((x) => x.panelId !== c.panelId))}>×</button></span>)}
            <button className="btn small ghost" onClick={() => setCross([])} data-testid="ax-explore-clear">Clear all</button>
          </span>}
          <span className="grow" />
          <button className="btn small" onClick={p.onAsk} title="Describe the chart you want in words — Ask proposes it, you review" data-testid="ax-explore-ask">Ask in words</button>
          {panels.length > 0 && <button className="btn small ghost" onClick={() => { setPanels([]); setCross([]); }}>Clear board</button>}
        </div>
        {notice && <div className="ax-notice" onClick={() => setNotice(null)} data-testid="ax-explore-notice">{notice}</div>}
        {!panels.length && (
          <div className="axa-empty"><b>Pick variables on the left.</b><p className="muted">For example Age group + Brand awareness + Purchase intention: the board picks the crosstab, draws it, and lets you switch the chart, filter by clicking, and save what is worth keeping. Or say it in words with Ask.</p></div>
        )}
        <div className="ax-explore-grid">
          {panels.map((panel) => {
            const r = panel.result;
            const choices = r ? chartChoices(r, r.recommendations) : [];
            const sel = cross.find((c) => c.panelId === panel.id)?.category ?? null;
            const filtered = cross.some((c) => c.panelId !== panel.id);
            return (
              <section key={panel.id} className="ax-explore-panel" data-testid="ax-explore-panel" data-kind={panel.definition.kind}>
                <header className="ax-explore-panel-head">
                  <div className="ax-explore-panel-title" title={panel.because}>{panel.definition.name}{panel.savedId && <span className="axa-chip" style={{ marginLeft: 6 }}>saved</span>}</div>
                  <span className="grow" />
                  {r && choices.length > 1 && <select className="select small" value={panel.spec.type} onChange={(e) => setPanels((ps) => ps.map((x) => (x.id === panel.id ? { ...x, spec: { ...x.spec, type: e.target.value as ChartType } } : x)))} aria-label="Chart type" data-testid="ax-explore-chart-type">{choices.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}</select>}
                  <button className={`btn small ghost ${panel.table ? "on" : ""}`} onClick={() => setPanels((ps) => ps.map((x) => (x.id === panel.id ? { ...x, table: !x.table } : x)))} data-testid="ax-explore-table">{panel.table ? "Chart" : "Table"}</button>
                  {r && <button className={`btn small ghost ${panel.explain ? "on" : ""}`} onClick={() => setPanels((ps) => ps.map((x) => (x.id === panel.id ? { ...x, explain: !x.explain } : x)))} data-testid="ax-explore-explain">Explain</button>}
                  {p.canEdit && !panel.savedId && <button className="btn small" onClick={() => void save(panel)} data-testid="ax-explore-save">Save</button>}
                  {panel.savedId && <button className="btn small" onClick={() => p.onOpenInBuilder({ id: panel.savedId, name: panel.definition.name, kind: panel.definition.kind, definition: panel.definition })}>Open in builder</button>}
                  <button className="btn small ghost" aria-label="Remove panel" onClick={() => { setPanels((ps) => ps.filter((x) => x.id !== panel.id)); setCross((cs) => cs.filter((c) => c.panelId !== panel.id)); }}>×</button>
                </header>
                <div className="ax-explore-panel-why muted">{panel.because}{filtered ? ` Filtered: ${conditionText(filterFor(panel.id), p.variables)}.` : ""}</div>
                {panel.loading && !r && <div className="muted" style={{ padding: 24 }}>Computing…</div>}
                {panel.error && <div className="ax-error">{panel.error}</div>}
                {r && !panel.table && <div className={`ax-explore-chart ${panel.loading ? "stale" : ""}`}><Chart result={r} spec={panel.spec} theme={theme(panel.spec.themeId)} height={300} onSelect={panel.clickVariable ? (c) => select(panel, c) : undefined} selected={sel} /></div>}
                {r && panel.table && <div className="ax-explore-table"><ResultTableView table={r.tables[0]} dense /></div>}
                {r && (r.insights[0] || r.warnings[0]) && !panel.explain && <div className="ax-explore-insight">{r.insights[0] ?? r.warnings[0]}</div>}
                {r && panel.explain && <InterpretationPanel api={p.api} definition={{ ...panel.definition, ...(filterFor(panel.id) ? { filter: filterFor(panel.id) } : {}) }} compact />}
                {r && panel.clickVariable && !panel.table && <div className="muted" style={{ fontSize: 11.5 }}>Click a {panel.definition.kind === "crosstab" ? "row" : "bar"} to filter the other panels · n = {r.base.n.toLocaleString("en-US")}</div>}
              </section>
            );
          })}
        </div>
      </main>
    </div>
  );
}
