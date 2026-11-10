"use client";
import React from "react";
import { journeyLines, runSimulation, type SimulationConfig, type SimulationRunReport, type Journey } from "@rescript/templates";
import { useStudio } from "./store";
import { parseDistributions, parseExpectations, parseProfiles, simulationRequest, takePendingSimulation } from "../../lib/intelligent/simulationRequest";

/**
 * SIMULATED TEST RESPONDENTS (2026-11-09) — Research tools → Tests.
 *
 *   Intelligent   one sentence ("generate 200 test responses and test every path, including screen-outs") → the
 *                 configuration, shown before it runs
 *   Manual        the count, seed, the mix of normal and edge-case respondents, the share steered to complete,
 *                 profiles, answer distributions, questions or blocks to focus on, and the expectations to check
 *   Run           in the browser, on the survey as it is open, through the real engine (runSimulation) — nothing saved
 *   Review        verdict and problems, endings, coverage, never-reached questions, conditions that never fired,
 *                 expected vs actual (with the respondents that broke each expectation), invalid-answer probes,
 *                 randomization balance, and every respondent's journey (open one: what was shown, hidden by logic,
 *                 not reached, the answers)
 *   Download      Excel or CSV of the simulated respondents (TEST-marked), from the same definition and seed
 *   Save          as TEST data on a saved project (the saved version the test link serves) — never LIVE, never in
 *                 reports, quotas or deliverables; each run listed with its count and cleared on one click
 */
const COUNTS = [50, 100, 200, 500];

export function SimulationPanel() {
  const s = useStudio();
  const sandbox = s.surveyDbId === "sandbox";
  const [mode, setMode] = React.useState<"intelligent" | "manual">("intelligent");
  const [say, setSay] = React.useState("Generate 100 test responses and thoroughly test the questionnaire, including skip logic, display conditions, quotas, randomization, validation and terminations.");
  const [count, setCount] = React.useState(100);
  const [seed, setSeed] = React.useState(20261109);
  const [edge, setEdge] = React.useState(20);
  const [complete, setComplete] = React.useState(75);
  const [profiles, setProfiles] = React.useState("");
  const [dists, setDists] = React.useState("");
  const [focus, setFocus] = React.useState("");
  const [expect, setExpect] = React.useState("");
  const [probe, setProbe] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [run, setRun] = React.useState<{ config: SimulationConfig; report: SimulationRunReport } | null>(() => takePendingSimulation());
  const [open, setOpen] = React.useState<Journey | null>(null);
  const [only, setOnly] = React.useState<"all" | "broken" | string>("all");
  const [stored, setStored] = React.useState<{ runId: string; respondents: number; complete: number; at: string | null }[] | null>(null);

  const loadRuns = React.useCallback(async () => {
    if (sandbox) return;
    const r = await fetch(`/api/surveys/${encodeURIComponent(s.surveyDbId)}/simulation`, { cache: "no-store" }).catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    if (r?.ok) setStored(j?.runs ?? []);
  }, [s.surveyDbId, sandbox]);
  React.useEffect(() => { void loadRuns(); }, [loadRuns]);

  const manualConfig = (): SimulationConfig | null => {
    const p = parseProfiles(s.def, profiles), d = parseDistributions(s.def, dists), e = parseExpectations(s.def, expect);
    const errors = [...p.errors, ...d.errors, ...e.errors];
    if (errors.length) { setErr(errors.slice(0, 4).join(" ")); return null; }
    return { count, seed, edgeRate: edge / 100, completeShare: complete / 100, probeInvalid: probe, ...(p.profiles.length ? { profiles: p.profiles } : {}), ...(Object.keys(d.distributions).length ? { distributions: d.distributions } : {}), ...(focus.trim() ? { focus: focus.split(/[,\s]+/).filter(Boolean) } : {}), ...(e.expectations.length ? { expectations: e.expectations } : {}) };
  };
  const understood = mode === "intelligent" ? simulationRequest(say, s.def) : null;
  const start = () => {
    setErr(null); setNote(null); setOpen(null);
    const config = mode === "intelligent" ? (understood?.config ?? null) : manualConfig();
    if (!config) { if (mode === "intelligent") setErr("Say how many test respondents to simulate — for example “Generate 100 test responses and test every path”."); return; }
    setBusy("Simulating");
    setTimeout(() => {
      try { setRun({ config, report: runSimulation(s.def, config) }); }
      catch (e) { setErr(`The simulation could not run: ${(e as Error).message}`); }
      setBusy(null);
    }, 20);
  };
  const download = async (format: "xlsx" | "csv") => {
    if (!run) return;
    setBusy(format === "xlsx" ? "Preparing Excel" : "Preparing CSV");
    try {
      const r = await fetch("/api/simulation/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: s.surveyDbId, definition: s.def, config: run.config, format, runId: run.report.runId }) });
      if (!r.ok) { const j = await r.json().catch(() => null); setErr(String(j?.error ?? `The file could not be made (${r.status}).`)); return; }
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a"); a.href = url; a.download = `${s.def.meta.code || "survey"}_simulated_${run.report.runId}.${format}`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } finally { setBusy(null); }
  };
  const store = async () => {
    if (!run) return;
    setBusy("Saving as test data"); setErr(null);
    try {
      const r = await fetch(`/api/surveys/${encodeURIComponent(s.surveyDbId)}/simulation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "store", config: run.config }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) { setErr(String(j?.error ?? `They could not be saved (${r.status}).`)); return; }
      setNote(`Saved ${j.stored} simulated respondents as TEST data (run ${j.runId}, on the survey as it is now). They are in Data → TEST only — never LIVE data, live quotas, reports or deliverables.`);
      void loadRuns();
    } finally { setBusy(null); }
  };
  const clear = async (runId?: string) => {
    if (!window.confirm(runId ? `Remove the simulated respondents of run ${runId} from TEST data? (They go to the recycle bin.)` : "Remove every simulated respondent from TEST data? (They go to the recycle bin.)")) return;
    setBusy("Clearing");
    try {
      const r = await fetch(`/api/surveys/${encodeURIComponent(s.surveyDbId)}/simulation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "clear", ...(runId ? { runId } : {}) }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) setErr(String(j?.error ?? `Not cleared (${r.status}).`)); else setNote(`Cleared ${j.cleared} simulated respondent${j.cleared === 1 ? "" : "s"} from TEST data.`);
      void loadRuns();
    } finally { setBusy(null); }
  };

  const rep = run?.report;
  const label = (id: string) => s.def.questions.find((q) => q.id === id)?.code ?? id;
  const journeys = rep ? rep.journeys.filter((j) => only === "all" || (only === "broken" ? Object.values(j.checks).some((v) => !v) || j.scriptErrors.length > 0 : j.endStatus === only)) : [];

  return (
    <section className="sim" data-testid="sim-panel">
      <h3 className="sec">Simulated respondents</h3>
      <p className="muted" style={{ fontSize: 13 }}>Test the questionnaire with any number of simulated respondents. Each one goes through the real survey logic — display and skip logic, quotas, randomization, piping, validation, scripts, terminations — and you see where every respondent went and what broke. Saved runs are TEST data only.</p>
      <div className="sim-mode" role="tablist" aria-label="How to configure the simulation">
        <button type="button" role="tab" aria-selected={mode === "intelligent"} className={`btn small ${mode === "intelligent" ? "primary" : ""}`} data-testid="sim-mode-intelligent" onClick={() => setMode("intelligent")}>Intelligent</button>
        <button type="button" role="tab" aria-selected={mode === "manual"} className={`btn small ${mode === "manual" ? "primary" : ""}`} data-testid="sim-mode-manual" onClick={() => setMode("manual")}>Manual</button>
      </div>
      {mode === "intelligent" ? (
        <div className="sim-say">
          <textarea className="ta" rows={2} data-testid="sim-say" value={say} onChange={(e) => setSay(e.target.value)} aria-label="Say what to simulate" />
          <p className="muted" data-testid="sim-understood">{understood ? understood.understood : "Say how many test respondents and what to test."}</p>
        </div>
      ) : (
        <div className="sim-grid">
          <label className="f"><span>Respondents</span><span className="row" style={{ gap: 4 }}>{COUNTS.map((n) => <button key={n} type="button" className={`btn tiny ${count === n ? "primary" : ""}`} onClick={() => setCount(n)}>{n}</button>)}<input className="input" type="number" min={1} max={2000} value={count} data-testid="sim-count" onChange={(e) => setCount(Math.max(1, Math.min(2000, Number(e.target.value) || 1)))} style={{ width: 90 }} /></span></label>
          <label className="f"><span>Seed (same seed → same respondents)</span><input className="input" type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 1)} /></label>
          <label className="f"><span>Edge-case respondents: {edge}%</span><input type="range" min={0} max={100} value={edge} data-testid="sim-edge" onChange={(e) => setEdge(Number(e.target.value))} /></label>
          <label className="f"><span>Steered to complete: {complete}% (the rest may screen out or hit full quotas)</span><input type="range" min={0} max={100} value={complete} onChange={(e) => setComplete(Number(e.target.value))} /></label>
          <label className="f"><span>Profiles — “Name, share %, Q=answer; Q=answer” per line</span><textarea className="ta" rows={3} data-testid="sim-profiles" value={profiles} onChange={(e) => setProfiles(e.target.value)} placeholder={"Young drivers, 40%, AGE=22\nFamilies, 60%, KIDS=2"} /></label>
          <label className="f"><span>Answer distributions — “Q: code=weight, …” per line</span><textarea className="ta" rows={3} data-testid="sim-dists" value={dists} onChange={(e) => setDists(e.target.value)} placeholder={"GENDER: 1=48, 2=52\nREGION: 1=25, 2=25, 3=50"} /></label>
          <label className="f"><span>Focus on (question codes, page or block ids)</span><input className="input" data-testid="sim-focus" value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Q12, block_usage" /></label>
          <label className="f"><span>Expectations — “Q2 shown when Q1 = 1” per line</span><textarea className="ta" rows={3} data-testid="sim-expect" value={expect} onChange={(e) => setExpect(e.target.value)} placeholder={"Q2 shown when Q1 = 1\nQ2 hidden when Q1 = 2"} /></label>
          <label className="check"><input type="checkbox" checked={probe} onChange={(e) => setProbe(e.target.checked)} /> Also try invalid answers (the survey's own validation must refuse them)</label>
        </div>
      )}
      <div className="row" style={{ gap: 8, margin: "8px 0", flexWrap: "wrap" }}>
        <button type="button" className="btn primary" data-testid="sim-run" disabled={!!busy} onClick={start}>{busy === "Simulating" ? "Simulating…" : "Run the simulation"}</button>
        {rep && <>
          <button type="button" className="btn small" data-testid="sim-xlsx" disabled={!!busy} onClick={() => void download("xlsx")}>Download Excel</button>
          <button type="button" className="btn small" data-testid="sim-csv" disabled={!!busy} onClick={() => void download("csv")}>Download CSV</button>
          <button type="button" className="btn small" data-testid="sim-store" disabled={!!busy || sandbox} title={sandbox ? "Saving test data needs a saved project" : "Run again on the survey as it is now (the same build the test link serves) and store the respondents as TEST data"} onClick={() => void store()}>Save as test data</button>
        </>}
        {busy && busy !== "Simulating" && <span className="muted">{busy}…</span>}
      </div>
      {err && <div className="auth-note err" data-testid="sim-error">{err}</div>}
      {note && <div className="auth-note" data-testid="sim-note">{note}</div>}

      {rep && (
        <div className="sim-report" data-testid="sim-report" data-ok={rep.verdict.ok ? "1" : "0"}>
          <div className={`sim-verdict ${rep.verdict.ok ? "ok" : "bad"}`} data-testid="sim-verdict">
            <b>{rep.verdict.ok ? "No problems found" : `${rep.verdict.problems.length} problem${rep.verdict.problems.length === 1 ? "" : "s"} found`}</b>
            <span className="muted"> · run {rep.runId} · {rep.produced} respondents · simulated, not saved</span>
            {rep.verdict.problems.length > 0 && <ul>{rep.verdict.problems.slice(0, 20).map((p, i) => <li key={i}>{p}</li>)}</ul>}
          </div>
          <div className="sim-stats">
            <div><b>Endings</b>{Object.entries(rep.endings).map(([k, v]) => <div key={k}>{k.replace(/_/g, " ")}: {v}</div>)}</div>
            <div><b>Coverage</b><div>questions {rep.coverage.questions.exercised} / {rep.coverage.questions.total}</div><div>pages {rep.coverage.pages.exercised} / {rep.coverage.pages.total}</div><div>conditions fired {rep.coverage.conditions.fired} / {rep.coverage.conditions.total}</div></div>
            <div><b>Validation probes</b><div>{rep.probes.filter((p) => p.rejected).length} of {rep.probes.length} invalid answers refused</div>{rep.probes.filter((p) => !p.rejected).slice(0, 4).map((p, i) => <div key={i} className="bad">{label(p.question)} accepted {p.probe}</div>)}</div>
          </div>
          {rep.coverage.questions.missing.length > 0 && <details open><summary>Never reached ({rep.coverage.questions.missing.length})</summary><ul>{rep.coverage.questions.missing.map((m) => <li key={m.id}><b>{m.code}</b> {m.text.slice(0, 90)}</li>)}</ul></details>}
          {rep.expectations.length > 0 && (
            <details open data-testid="sim-expectations"><summary>Expected vs actual</summary>
              <table className="sim-table"><thead><tr><th>Expectation</th><th>Applied to</th><th>Met</th><th>Broken</th><th>Examples</th></tr></thead>
                <tbody>{rep.expectations.map((e) => <tr key={e.id} className={e.broken ? "bad" : ""} data-testid="sim-expectation" data-broken={e.broken}><td>{e.label}</td><td>{e.applicable}</td><td>{e.met}</td><td>{e.broken}</td><td>{e.examples.join(", ")}</td></tr>)}</tbody></table>
            </details>
          )}
          {rep.randomization.length > 0 && <details><summary>Randomization ({rep.randomization.length})</summary><ul>{rep.randomization.map((r) => <li key={r.variable}><b>{r.variable}</b> {r.balanced ? "balanced" : "UNBALANCED"} — {r.items.map((i) => `${i.item} first ${Math.round(i.firstShare * 100)}%`).join(", ")}</li>)}</ul></details>}
          <details open data-testid="sim-journeys"><summary>Respondents ({rep.journeys.length})</summary>
            <div className="row" style={{ gap: 6, margin: "6px 0" }}>
              <select className="select small" value={only} onChange={(e) => setOnly(e.target.value)} aria-label="Show respondents"><option value="all">all</option><option value="broken">with a broken expectation or script error</option>{Object.keys(rep.endings).map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}</select>
            </div>
            <table className="sim-table"><thead><tr><th>Respondent</th><th>Profile</th><th>Ending</th><th>Pages</th><th>Shown</th><th>Hidden by logic</th><th></th></tr></thead>
              <tbody>{journeys.slice(0, 200).map((j) => (
                <tr key={j.code} data-testid="sim-journey-row"><td>{j.code}</td><td>{j.profile ?? "—"}</td><td>{j.endStatus.replace(/_/g, " ")}</td><td>{j.pages.length}</td><td>{j.pages.reduce((a, p) => a + p.shown.length, 0)}</td><td>{j.pages.reduce((a, p) => a + p.hiddenByLogic.length, 0)}</td><td><button type="button" className="btn tiny" data-testid="sim-open" onClick={() => setOpen(j)}>Open</button></td></tr>
              ))}</tbody></table>
            {journeys.length > 200 && <p className="muted">The first 200 are listed; the downloads hold all {journeys.length}.</p>}
          </details>
          {open && (
            <div className="sim-journey" data-testid="sim-journey">
              <div className="row"><b>{open.code}</b><span className="grow" /><button type="button" className="btn tiny ghost" onClick={() => setOpen(null)} aria-label="Close">×</button></div>
              <ol>{journeyLines(s.def, open).slice(1).map((l, i) => <li key={i}>{l}</li>)}</ol>
              <details><summary>Answers</summary><pre>{JSON.stringify(Object.fromEntries(Object.entries(open.answers).map(([k, v]) => [label(k.split("@")[0]) + (k.includes("@") ? `@${k.split("@")[1]}` : ""), v])), null, 1)}</pre></details>
            </div>
          )}
        </div>
      )}

      {!sandbox && stored && (
        <div className="sim-stored" data-testid="sim-stored">
          <b>Saved as TEST data</b>
          {stored.length === 0 ? <p className="muted">No simulated respondents are stored on this survey.</p> : (
            <ul>{stored.map((r) => <li key={r.runId}>run {r.runId}: {r.respondents} respondents ({r.complete} complete) {r.at ? `· ${new Date(r.at).toLocaleString()}` : ""} <button type="button" className="btn tiny" onClick={() => void clear(r.runId)} data-testid="sim-clear-run">Clear</button></li>)}
              <li><button type="button" className="btn tiny danger" onClick={() => void clear()}>Clear every simulated respondent</button></li></ul>
          )}
        </div>
      )}
    </section>
  );
}
