"use client";
import React from "react";
import { useStudio } from "./store";
import { QualityPanel } from "./QualityPanel";
import { ResponseManager } from "./ResponseManager";

/**
 * Response data browser (requirement §23/§26) — test and live sessions,
 * flattened into the programmed variable structure.
 */

type Include = "live" | "test" | "all";

interface Row {
  sessionId: string;
  status: string;
  isTest: boolean;
  startedAt: string | null;
  completedAt: string | null;
  durationSec: number | null;
  flags: string[];
  vars: Record<string, unknown>;
  quality?: { classification: string; qualityScore: number; riskScore: number; flags: number } | null;
  review?: string | null;
}

/**
 * Which responses form the dataset shown and exported (the hand-off to
 * analysis): everything, the clean dataset (KEEP + unreviewed CLEAN, REMOVED
 * out), or everything except the chosen classifications (and REMOVED).
 */
type Dataset = "all" | "clean" | "custom";
const ALL_CLASSES = ["CLEAN", "REVIEW", "SUSPICIOUS", "HIGHLY_SUSPICIOUS", "CRITICAL"];
const CLASS_TONE: Record<string, string> = { CLEAN: "on", REVIEW: "", SUSPICIOUS: "warn", HIGHLY_SUSPICIOUS: "warn", CRITICAL: "warn" };

interface Summary {
  in_progress: number; complete: number; screened: number;
  quota_full: number; terminated: number; total: number;
}

const STATUS_CHIP: Record<string, string> = {
  complete: "on",
  in_progress: "",
  screened: "warn",
  quota_full: "warn",
  terminated: "warn",
};

function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function DataPanel() {
  const s = useStudio();
  const [include, setInclude] = React.useState<Include>("test");
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [columns, setColumns] = React.useState<string[]>([]);
  const [summary, setSummary] = React.useState<{ live: Summary; test: Summary } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [onlyAnswered, setOnlyAnswered] = React.useState(true);
  const [view, setView] = React.useState<"responses" | "manage" | "quality">("responses");
  const [dataset, setDataset] = React.useState<Dataset>("all");
  const [exclude, setExclude] = React.useState<string[]>(["SUSPICIOUS", "HIGHLY_SUSPICIOUS", "CRITICAL"]);
  const [meta, setMeta] = React.useState<{ total: number; included: number } | null>(null);
  const datasetParam = dataset === "custom" ? `custom:${exclude.join(",")}` : dataset;

  const load = React.useCallback(async () => {
    setError(null);
    setRows(null);
    try {
      const [sumRes, dataRes] = await Promise.all([
        fetch(`/api/surveys/${s.surveyDbId}/responses?format=summary`),
        fetch(`/api/surveys/${s.surveyDbId}/responses?format=json&include=${include}&dataset=${encodeURIComponent(datasetParam)}`),
      ]);
      const sum = await sumRes.json();
      const data = await dataRes.json();
      if (!dataRes.ok) {
        setError(data.error ?? `Server returned ${dataRes.status}`);
        setRows([]);
        return;
      }
      setSummary(sum);
      setColumns(data.columns ?? []);
      setRows(data.rows ?? []);
      setMeta(typeof data.total === "number" ? { total: data.total, included: data.included ?? data.rows?.length ?? 0 } : null);
    } catch {
      setError("Could not load responses.");
      setRows([]);
    }
  }, [s.surveyDbId, include, datasetParam]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Hide columns nobody answered — a wide dictionary is unreadable otherwise.
  const shownColumns = React.useMemo(() => {
    if (!rows || !onlyAnswered) return columns;
    return columns.filter((c) => rows.some((r) => fmtVal(r.vars[c]) !== ""));
  }, [columns, rows, onlyAnswered]);

  const hasQuality = !!rows?.some((r) => r.quality);
  const csvHref = `/api/surveys/${s.surveyDbId}/responses?format=csv&include=${include}&dataset=${encodeURIComponent(datasetParam)}${hasQuality || dataset !== "all" ? "&quality=1" : ""}`;
  const xlsxHref = `/api/surveys/${s.surveyDbId}/responses?format=xlsx&include=${include}&dataset=${encodeURIComponent(datasetParam)}&quality=1`;
  const active = include === "test" ? summary?.test : include === "live" ? summary?.live : null;

  return (
    <div>
      <div className="row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Data</h2>
        <div className="row" style={{ gap: 4, marginLeft: 12 }} data-testid="data-view">
          <button className={`btn small ${view === "responses" ? "primary" : ""}`} data-testid="data-view-responses" onClick={() => setView("responses")}>Responses</button>
          <button className={`btn small ${view === "manage" ? "primary" : ""}`} data-testid="data-view-manage" onClick={() => setView("manage")}>Manage</button>
          <button className={`btn small ${view === "quality" ? "primary" : ""}`} data-testid="data-view-quality" onClick={() => setView("quality")}>Quality</button>
        </div>
        <span className="grow" />
        {view !== "manage" && (
          <>
            <div className="row" style={{ gap: 4 }}>
              {(["test", "live", "all"] as Include[]).map((k) => (
                <button key={k}
                  className={`btn small ${include === k ? "primary" : ""}`}
                  onClick={() => setInclude(k)}>
                  {k === "test" ? "Test data" : k === "live" ? "Live data" : "All"}
                </button>
              ))}
            </div>
            <button className="btn small" onClick={() => void load()}>↻ refresh</button>
            <a className="btn small" href={csvHref} target="_blank" data-testid="export-csv">⬇ CSV</a>
            <a className="btn small" href={xlsxHref} target="_blank" data-testid="export-xlsx" title="Main Data + Response Quality sheets">⬇ XLSX (data + quality)</a>
          </>
        )}
      </div>

      {view === "manage" ? (
        <ResponseManager
          environment={include === "test" ? "TEST" : include === "live" ? "LIVE" : "ALL"}
          onEnvironment={(e) => setInclude(e === "TEST" ? "test" : e === "LIVE" ? "live" : "all")} />
      ) : view === "quality" ? <QualityPanel include={include} /> : (
      <>
      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap", gap: 6, alignItems: "center" }} data-testid="dataset-selector">
        <span className="muted" style={{ fontSize: 11 }}>Dataset for table &amp; exports:</span>
        <select className="select" style={{ width: 300 }} data-testid="dataset-select" value={dataset} onChange={(e) => setDataset(e.target.value as Dataset)}>
          <option value="all">All responses (removed included)</option>
          <option value="clean">Clean dataset — approved + unreviewed CLEAN; removed out</option>
          <option value="custom">Custom — exclude selected classifications</option>
        </select>
        {dataset === "custom" && ALL_CLASSES.map((c) => (
          <label key={c} className={`chip ${exclude.includes(c) ? "warn" : ""}`} style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={exclude.includes(c)} onChange={(e) => setExclude((x) => e.target.checked ? [...x, c] : x.filter((y) => y !== c))} /> exclude {c.replace("_", " ")}
          </label>
        ))}
        {meta && dataset !== "all" && <span className="chip" data-testid="dataset-count">{meta.included} of {meta.total} in this dataset</span>}
      </div>

      {summary && (
        <div className="row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
          <span className="chip">test: {summary.test.total}</span>
          <span className="chip">live: {summary.live.total}</span>
          {active && (
            <>
              <span className="chip on">complete {active.complete}</span>
              <span className="chip">in progress {active.in_progress}</span>
              <span className="chip warn">screened {active.screened}</span>
              <span className="chip warn">quota full {active.quota_full}</span>
              <span className="chip warn">terminated {active.terminated}</span>
            </>
          )}
        </div>
      )}

      <p className="muted" style={{ fontSize: 12 }}>
        Every run of the Test Survey link is stored here, flattened into the programmed variables —
        the same shape the CSV export produces. Test sessions never count toward quotas.
      </p>

      {error && <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>{error}</div>}
      {rows === null && !error && <p className="muted">Loading…</p>}
      {rows?.length === 0 && !error && (
        <p className="muted">
          No {include === "all" ? "" : include} responses yet.{" "}
          {include === "test" && "Open the Test Survey link and answer a few questions, then refresh."}
        </p>
      )}

      {!!rows?.length && (
        <>
          <label className="row" style={{ gap: 6, fontSize: 12, marginBottom: 8 }}>
            <input type="checkbox" checked={onlyAnswered}
              onChange={(e) => setOnlyAnswered(e.target.checked)} />
            hide columns with no data ({columns.length - shownColumns.length} hidden)
          </label>
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Session</th><th>Status</th>{hasQuality && <><th>Quality</th><th>Risk</th><th>Class</th><th>Decision</th></>}<th>Started</th><th>Secs</th>
                  {shownColumns.map((c) => <th key={c}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.sessionId} style={{ cursor: "pointer" }}
                    onClick={() => setOpen(open === r.sessionId ? null : r.sessionId)}>
                    <td>{r.sessionId.slice(0, 8)}{r.isTest ? " ·test" : ""}</td>
                    <td><span className={`chip ${STATUS_CHIP[r.status] ?? ""}`}>{r.status}</span></td>
                    {hasQuality && (
                      <>
                        <td>{r.quality?.qualityScore ?? ""}</td>
                        <td>{r.quality?.riskScore ?? ""}</td>
                        <td>{r.quality ? <span className={`chip ${CLASS_TONE[r.quality.classification] ?? ""}`}>{r.quality.classification.replace("_", " ")}</span> : ""}</td>
                        <td>{r.review ? <span className={`chip ${r.review === "KEEP" ? "on" : "warn"}`}>{r.review.replace("_", " ")}</span> : ""}</td>
                      </>
                    )}
                    <td>{r.startedAt ? new Date(r.startedAt).toLocaleString() : ""}</td>
                    <td>{r.durationSec ?? ""}</td>
                    {shownColumns.map((c) => <td key={c}>{fmtVal(r.vars[c])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {open && (() => {
            const r = rows.find((x) => x.sessionId === open);
            if (!r) return null;
            const answered = columns.filter((c) => fmtVal(r.vars[c]) !== "");
            return (
              <div className="card" style={{ marginTop: 12 }}>
                <div className="row" style={{ marginBottom: 8 }}>
                  <strong className="mono">{r.sessionId}</strong>
                  <span className={`chip ${STATUS_CHIP[r.status] ?? ""}`}>{r.status}</span>
                  {r.isTest && <span className="chip warn">test</span>}
                  {r.flags.map((f) => <span key={f} className="chip warn">{f}</span>)}
                  <span className="grow" />
                  <button className="btn small" onClick={() => setOpen(null)}>close</button>
                </div>
                <div className="table-wrap">
                  <table className="grid">
                    <thead><tr><th>Variable</th><th>Value</th></tr></thead>
                    <tbody>
                      {answered.map((c) => (
                        <tr key={c}><td><strong>{c}</strong></td><td>{fmtVal(r.vars[c])}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </>
      )}
      </>
      )}
    </div>
  );
}
