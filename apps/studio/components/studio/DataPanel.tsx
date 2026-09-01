"use client";
import React from "react";
import { useStudio } from "./store";

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
}

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

  const load = React.useCallback(async () => {
    setError(null);
    setRows(null);
    try {
      const [sumRes, dataRes] = await Promise.all([
        fetch(`/api/surveys/${s.surveyDbId}/responses?format=summary`),
        fetch(`/api/surveys/${s.surveyDbId}/responses?format=json&include=${include}`),
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
    } catch {
      setError("Could not load responses.");
      setRows([]);
    }
  }, [s.surveyDbId, include]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Hide columns nobody answered — a wide dictionary is unreadable otherwise.
  const shownColumns = React.useMemo(() => {
    if (!rows || !onlyAnswered) return columns;
    return columns.filter((c) => rows.some((r) => fmtVal(r.vars[c]) !== ""));
  }, [columns, rows, onlyAnswered]);

  const csvHref = `/api/surveys/${s.surveyDbId}/responses?format=csv&include=${include}`;
  const active = include === "test" ? summary?.test : include === "live" ? summary?.live : null;

  return (
    <div>
      <div className="row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Data</h2>
        <span className="grow" />
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
        <a className="btn small" href={csvHref} target="_blank">⬇ CSV</a>
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
                  <th>Session</th><th>Status</th><th>Started</th><th>Secs</th>
                  {shownColumns.map((c) => <th key={c}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.sessionId} style={{ cursor: "pointer" }}
                    onClick={() => setOpen(open === r.sessionId ? null : r.sessionId)}>
                    <td>{r.sessionId.slice(0, 8)}{r.isTest ? " ·test" : ""}</td>
                    <td><span className={`chip ${STATUS_CHIP[r.status] ?? ""}`}>{r.status}</span></td>
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
    </div>
  );
}
