"use client";
import React from "react";
import type { AnalysisDefinition, AnalysisResult, DatasetSpec, ResultTable, VariableMeta } from "@rescript/analytics";
import { maxdiffShares, priceWhatIf } from "@rescript/analytics";
import { AxApi, downloadBlob, type Row } from "./api";
import { ProTable } from "./ProTable";

/**
 * TAB BOOK AND SIMULATORS (Level 5 roadmap M2, M3 — screens 2026-11-22), in Explore.
 *
 *   Tab book     pick the banner (the columns every table is cut by); the Studio drafts a table for every question
 *                (nets, top/bottom boxes and means on scales, NPS rows, ranked grid summaries), runs it over the data
 *                and shows each table; download it as one workbook (contents + a sheet per table)
 *   Simulators   MaxDiff: preference shares for a chosen set of items (from a saved MaxDiff analysis)
 *                TURF: reach and frequency of a line-up, each item's unique reach, the best addition and swap
 *                Price: demand and revenue index at a price (Gabor–Granger or Van Westendorp with NMS), where the price
 *                sits in the acceptable range
 * MaxDiff and price read the saved analysis's result; TURF and the tab book are computed on the server
 * (/api/surveys/[id]/analytics-tools), which never returns respondent rows.
 */
export function TabBookPanel({ api, variables, dataset, canExport }: { api: AxApi; variables: VariableMeta[]; dataset: DatasetSpec; canExport: boolean }) {
  /* a banner is a question people answered: not an option flag of a multi-select, not a system variable (_status…) */
  const bannerable = variables.filter((v) => (v.role === "categorical" || v.role === "scale") && !v.rowCode && !v.optionCode && !v.name.startsWith("_") && (v.categories?.length ?? 0) >= 2 && (v.categories?.length ?? 0) <= 12);
  const [banner, setBanner] = React.useState<string[]>([]);
  const [out, setOut] = React.useState<{ tables: { id: string; number: number; title: string; kind: string; base: { n: number }; warnings: string[]; table: ResultTable }[]; problems: string[]; respondents: number; truncated?: number } | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const call = async (format: "json" | "xlsx") => {
    setBusy(format); setError(null);
    try {
      const r = await fetch(`/api/surveys/${api.surveyId}/analytics-tools`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "tab_plan", banner: { columns: banner }, dataset, format }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `(${r.status})`); }
      if (format === "xlsx") downloadBlob(await r.blob(), /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "tab_book.xlsx");
      else { const j = await r.json(); setOut(j); setOpen(j.tables[0]?.id ?? null); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <div className="ax-panel" data-testid="ax-tabbook">
      <div className="row" style={{ marginBottom: 6 }}><h2 style={{ margin: 0 }}>Tab book</h2><span className="muted" style={{ fontSize: 13 }}>Every question cut by the same banner, with nets, boxes, means and significance letters — one workbook.</span></div>
      <div className="flabel">Banner (up to 8 columns)</div>
      <div className="ax-chips" data-testid="ax-tabbook-banner">
        {bannerable.map((v) => { const on = banner.includes(v.name); return <button key={v.name} type="button" className={`ax-chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setBanner(on ? banner.filter((x) => x !== v.name) : [...banner, v.name].slice(0, 8))}>{v.label}</button>; })}
        {!bannerable.length && <span className="muted">No question with 2–12 answers to cut by.</span>}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button className="btn primary small" disabled={!banner.length || !!busy} onClick={() => void call("json")} data-testid="ax-tabbook-run">{busy === "json" ? "Running…" : "Run the tables"}</button>
        <button className="btn small" disabled={!banner.length || !!busy || !canExport} title={canExport ? "One workbook: contents and a sheet per table" : "Your role cannot download"} onClick={() => void call("xlsx")} data-testid="ax-tabbook-xlsx">{busy === "xlsx" ? "Building…" : "Download the tab book"}</button>
        <span className="muted" style={{ fontSize: 12.5 }}>{dataset.environment === "TEST" ? "Test" : "Live"} data, {dataset.dataset === "clean" ? "clean base" : "all completes"}.</span>
      </div>
      {error && <div className="ax-error" style={{ marginTop: 8 }}>{error}</div>}
      {out && (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: 13 }}>{out.tables.length} tables over {out.respondents} respondents{out.truncated ? ` (showing the first ${out.tables.length} of ${out.truncated}; the download has them all)` : ""}.</div>
          {out.problems.length > 0 && <div className="ax-warn" data-testid="ax-tabbook-problems">{out.problems.slice(0, 6).join(" ")}</div>}
          <div className="ax-tabbook-layout">
            <ol className="ax-tabbook-list">{out.tables.map((t) => <li key={t.id}><button type="button" className={`btn small ghost ${open === t.id ? "on" : ""}`} onClick={() => setOpen(t.id)}>{t.number}. {t.title} <span className="muted">n={t.base.n}</span></button></li>)}</ol>
            <div>{out.tables.filter((t) => t.id === open).map((t) => (
              <div key={t.id} className="card ax-table-card" data-testid="ax-tabbook-table">
                <div className="card-title">{t.number}. {t.title}</div>
                {t.warnings.map((w, i) => <div key={i} className="ax-warn">{w}</div>)}
                <ProTable table={t.table} />
              </div>
            ))}</div>
          </div>
        </div>
      )}
    </div>
  );
}

export function SimulatorsPanel({ api, analyses, variables, dataset }: { api: AxApi; analyses: Row[]; variables: VariableMeta[]; dataset: DatasetSpec }) {
  return (
    <div className="ax-panel" data-testid="ax-simulators">
      <div className="row" style={{ marginBottom: 6 }}><h2 style={{ margin: 0 }}>Simulators</h2><span className="muted" style={{ fontSize: 13 }}>What-if questions answered from the study's own results.</span></div>
      <MaxDiffSim api={api} analyses={analyses.filter((a) => (a.definition as AnalysisDefinition | undefined)?.kind === "maxdiff")} dataset={dataset} />
      <TurfSim api={api} variables={variables.filter((v) => v.role === "multi" && !v.optionCode)} dataset={dataset} />
      <PriceSim api={api} analyses={analyses.filter((a) => (a.definition as AnalysisDefinition | undefined)?.kind === "pricing")} dataset={dataset} />
    </div>
  );
}

function useResult(api: AxApi, analyses: Row[], dataset: DatasetSpec) {
  const [id, setId] = React.useState<string>(String(analyses[0]?.id ?? ""));
  const [result, setResult] = React.useState<AnalysisResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    const a = analyses.find((x) => String(x.id) === id);
    if (!a) { setResult(null); return; }
    let live = true;
    setError(null);
    api.run({ ...(a.definition as AnalysisDefinition), dataset }).then((r) => { if (live) setResult(r.result as AnalysisResult); }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [api, analyses, id, dataset]);
  return { id, setId, result, error };
}

const Notes = ({ notes }: { notes: { level: string; text: string }[] }) => <>{notes.map((n, i) => <div key={i} className={n.level === "caution" ? "ax-warn" : "muted"} style={{ fontSize: 12.5 }}>{n.text}</div>)}</>;

function MaxDiffSim({ api, analyses, dataset }: { api: AxApi; analyses: Row[]; dataset: DatasetSpec }) {
  const { id, setId, result, error } = useResult(api, analyses, dataset);
  const items = result?.chart.categories ?? [];
  const [subset, setSubset] = React.useState<string[]>([]);
  const [rule, setRule] = React.useState<"rescaled" | "logit">("rescaled");
  React.useEffect(() => { setSubset(items.slice(0, Math.min(5, items.length))); }, [result]); // eslint-disable-line react-hooks/exhaustive-deps
  const out = result && subset.length >= 2 ? maxdiffShares(result, subset, { rule }) : null;
  return (
    <section className="card" style={{ marginTop: 10 }} data-testid="ax-sim-maxdiff">
      <div className="card-title">MaxDiff: preference share in a set</div>
      {!analyses.length ? <div className="muted">Save a MaxDiff analysis first.</div> : <>
        <div className="row" style={{ gap: 6 }}>
          <select className="select small" value={id} onChange={(e) => setId(e.target.value)}>{analyses.map((a) => <option key={String(a.id)} value={String(a.id)}>{String(a.name)}</option>)}</select>
          <select className="select small" value={rule} onChange={(e) => setRule(e.target.value as "rescaled" | "logit")}><option value="rescaled">Shares from rescaled scores</option><option value="logit">Logit choice rule</option></select>
        </div>
        {error && <div className="ax-error">{error}</div>}
        <div className="ax-chips" style={{ marginTop: 6 }}>{items.map((it) => { const on = subset.includes(it); return <button key={it} type="button" className={`ax-chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setSubset(on ? subset.filter((x) => x !== it) : [...subset, it])}>{it}</button>; })}</div>
        {out && ("error" in out ? <div className="ax-warn">{out.error}</div> : <>
          <table className="ax-table dense"><thead><tr><th>Item</th><th className="num">Share of preference</th></tr></thead><tbody>{out.items.map((x) => <tr key={x.item}><td>{x.item}</td><td className="num">{x.share.toFixed(1)}%</td></tr>)}</tbody></table>
          <Notes notes={out.notes} />
        </>)}
      </>}
    </section>
  );
}

function TurfSim({ api, variables, dataset }: { api: AxApi; variables: VariableMeta[]; dataset: DatasetSpec }) {
  const [battery, setBattery] = React.useState<string>(variables[0]?.name ?? "");
  const items = variables.find((v) => v.name === battery)?.categories?.map((c) => c.label) ?? [];
  const [portfolio, setPortfolio] = React.useState<string[]>([]);
  const [out, setOut] = React.useState<Row | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { setPortfolio([]); setOut(null); }, [battery]);
  const run = async (line: string[]) => {
    setError(null);
    try {
      const r = await fetch(`/api/surveys/${api.surveyId}/analytics-tools`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "turf_portfolio", battery: [battery], portfolio: line, dataset }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `(${r.status})`);
      setOut(j);
    } catch (e) { setError((e as Error).message); }
  };
  const toggle = (it: string) => { const next = portfolio.includes(it) ? portfolio.filter((x) => x !== it) : [...portfolio, it]; setPortfolio(next); if (next.length) void run(next); else setOut(null); };
  return (
    <section className="card" style={{ marginTop: 10 }} data-testid="ax-sim-turf">
      <div className="card-title">TURF: reach of a line-up</div>
      {!variables.length ? <div className="muted">TURF needs a multi-select question.</div> : <>
        <select className="select small" value={battery} onChange={(e) => setBattery(e.target.value)}>{variables.map((v) => <option key={v.name} value={v.name}>{v.label}</option>)}</select>
        <div className="ax-chips" style={{ marginTop: 6 }}>{items.map((it) => { const on = portfolio.includes(it); return <button key={it} type="button" className={`ax-chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => toggle(it)}>{it}</button>; })}</div>
        {error && <div className="ax-error">{error}</div>}
        {out && (<>
          <div style={{ marginTop: 6 }}><b>{String(out.reach)}%</b> reached (at least one item chosen), {String(out.frequency)} items each on average, of {String(out.base)} respondents.</div>
          <table className="ax-table dense"><thead><tr><th>In the line-up</th><th className="num">Reach alone</th><th className="num">Only this item</th></tr></thead><tbody>{(out.items as Row[]).map((x) => <tr key={String(x.item)}><td>{String(x.item)}</td><td className="num">{String(x.reach)}%</td><td className="num">{String(x.unique)}%</td></tr>)}</tbody></table>
          {(out.add as Row[]).length > 0 && <div className="muted" style={{ fontSize: 13 }}>Best to add: {(out.add as Row[]).slice(0, 3).map((x) => `${x.item} (+${x.gain} points)`).join(", ")}.</div>}
          {out.bestSwap ? <div className="muted" style={{ fontSize: 13 }}>Best swap: {String((out.bestSwap as Row).out)} → {String((out.bestSwap as Row).in)} (+{String((out.bestSwap as Row).gain)} points).</div> : null}
          <Notes notes={(out.notes as { level: string; text: string }[]) ?? []} />
        </>)}
      </>}
    </section>
  );
}

function PriceSim({ api, analyses, dataset }: { api: AxApi; analyses: Row[]; dataset: DatasetSpec }) {
  const { id, setId, result, error } = useResult(api, analyses, dataset);
  const [price, setPrice] = React.useState<number>(0);
  const [market, setMarket] = React.useState<string>("");
  const out = result && price > 0 ? priceWhatIf(result, price, market ? { marketSize: Number(market) } : {}) : null;
  const named = (result?.chart.categories ?? []).map(Number).filter((x) => Number.isFinite(x));
  const range = named.length ? `${Math.min(...named)}–${Math.max(...named)}` : null;
  return (
    <section className="card" style={{ marginTop: 10 }} data-testid="ax-sim-price">
      <div className="card-title">Price: what if we charged…</div>
      {!analyses.length ? <div className="muted">Save a pricing analysis (Gabor–Granger or Van Westendorp) first.</div> : <>
        <div className="row" style={{ gap: 6 }}>
          <select className="select small" value={id} onChange={(e) => setId(e.target.value)}>{analyses.map((a) => <option key={String(a.id)} value={String(a.id)}>{String(a.name)}</option>)}</select>
          <input className="input small" type="number" min={0} step="any" style={{ width: 110 }} placeholder={range ? `Price (${range})` : "Price"} value={price || ""} onChange={(e) => setPrice(Number(e.target.value))} aria-label="Price" />
          <input className="input small" type="number" min={0} style={{ width: 140 }} placeholder="Market size (optional)" value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Market size" />
        </div>
        {range && <div className="muted" style={{ fontSize: 12.5 }}>Respondents named prices from {range}; outside that the curves are not read.</div>}
        {error && <div className="ax-error">{error}</div>}
        {out && ("error" in out ? <div className="ax-warn">{out.error}</div> : <div style={{ marginTop: 6 }}>
          {out.demand && <div><b>{out.demand.wouldBuy.toFixed(1)}%</b> would buy at {price} ({out.demand.method}, read between {out.demand.between[0]} and {out.demand.between[1]}); revenue index {out.demand.revenueIndex.toFixed(1)}{out.demand.buyers != null ? `; about ${Math.round(out.demand.buyers).toLocaleString()} buyers` : ""}.</div>}
          {out.vanWestendorp && <div>{out.vanWestendorp.tooCheap.toFixed(1)}% find it too cheap, {out.vanWestendorp.tooExpensive.toFixed(1)}% too expensive{out.vanWestendorp.inRange ? `; ${out.vanWestendorp.inRange}` : ""}.</div>}
          <Notes notes={out.notes} />
        </div>)}
      </>}
    </section>
  );
}

