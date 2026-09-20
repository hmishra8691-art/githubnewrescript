"use client";
import React from "react";
import { Loading } from "@/components/ui/Loading";
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
  /*
   * How coded answers are written into the downloaded file. `code` is the
   * default and always has been — a data processor's file — so a researcher
   * who never opens this control keeps getting exactly what they got before.
   */
  const [values, setValues] = React.useState<"code" | "label" | "code_label">("code");
  const [showExports, setShowExports] = React.useState(false);
  /* §44.4 — saved delivery settings, workspace-wide */
  const [presets, setPresets] = React.useState<any[] | null>(null);
  const [presetsSaveable, setPresetsSaveable] = React.useState(true);
  const [presetName, setPresetName] = React.useState("");
  const [presetNote, setPresetNote] = React.useState<string | null>(null);
  const [withDictionary, setWithDictionary] = React.useState(false);
  const [format, setFormat] = React.useState<"csv" | "xlsx" | "json" | "sav" | "sas">("csv");
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
  const loadPresets = React.useCallback(async () => {
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/export-presets`);
      const j = await r.json();
      setPresets(j.presets ?? []);
      setPresetsSaveable(j.saveable !== false);
      setPresetNote(j.note ?? null);
    } catch {
      setPresets([]);
    }
  }, [s.surveyDbId]);

  React.useEffect(() => { if (showExports && presets === null) void loadPresets(); }, [showExports, presets, loadPresets]);

  /** Put a preset's choices into the controls; the user still presses download. */
  const usePreset = (p: any) => {
    setFormat(p.format ?? "csv");
    setValues(p.values ?? "code");
    setWithDictionary(!!p.includeDictionary);
    if (p.dataset === "clean") setDataset("clean");
    else if (typeof p.dataset === "string" && p.dataset.startsWith("custom:")) {
      setDataset("custom");
      setExclude(p.dataset.slice(7).split(",").filter(Boolean));
    } else setDataset("all");
  };

  const savePreset = async () => {
    const name = presetName.trim();
    if (!name) return;
    const r = await fetch(`/api/surveys/${s.surveyDbId}/export-presets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name, format, values, headers: "name",
        dataset: datasetParam, quality: hasQuality || dataset !== "all",
        includeDictionary: withDictionary,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setPresetNote(j.error ?? "That preset could not be saved."); return; }
    setPresetName("");
    setPresetNote(null);
    await loadPresets();
  };

  const deletePreset = async (id: string) => {
    await fetch(`/api/surveys/${s.surveyDbId}/export-presets?preset=${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadPresets();
  };

  const exportUrl = (format: string, extra = "") =>
    `/api/surveys/${s.surveyDbId}/responses?format=${format}&include=${include}&dataset=${encodeURIComponent(datasetParam)}${extra}`;
  /*
   * `values` is sent only to the formats it applies to. SPSS and SAS carry
   * the codes with the labels attached as metadata, which is the reason to
   * ask for those formats at all; passing the parameter to them would imply
   * a choice that does not exist there.
   */
  const valuesParam = values === "code" ? "" : `&values=${values}`;
  const csvHref = exportUrl("csv", `${hasQuality || dataset !== "all" ? "&quality=1" : ""}${valuesParam}`);
  const xlsxHref = exportUrl("xlsx", `&quality=1${valuesParam}`);
  const dictParam = withDictionary ? "&dictionary=1" : "";
  const savHref = exportUrl("sav", dictParam);
  const sasHref = exportUrl("sas", dictParam);
  /* the one the preset selected, so "download" means what the preset says */
  const presetHref =
    format === "sav" ? savHref
    : format === "sas" ? sasHref
    : format === "xlsx" ? xlsxHref
    : format === "json" ? exportUrl("json", valuesParam)
    : csvHref;
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
            <button className={`btn small ${showExports ? "primary" : ""}`} data-testid="export-more"
              onClick={() => setShowExports((v) => !v)}
              title="SPSS, SAS, and how coded answers are written">⋯ More formats</button>
          </>
        )}
      </div>

      {view === "manage" ? (
        <ResponseManager
          environment={include === "test" ? "TEST" : include === "live" ? "LIVE" : "ALL"}
          onEnvironment={(e) => setInclude(e === "TEST" ? "test" : e === "LIVE" ? "live" : "all")} />
      ) : view === "quality" ? <QualityPanel include={include} /> : (
      <>
      {showExports && (
        <div data-testid="export-panel"
          style={{ marginBottom: 10, padding: "12px 14px", border: "1px solid var(--border, #e5e9f0)", borderRadius: 8, background: "var(--surface-2, #fafbfc)" }}>
          {/* ---------------------------------------------- saved deliveries */}
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Export presets</div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 6 }} data-testid="export-presets">
            {(presets ?? []).map((p) => (
              <span key={p.id} className="row" style={{ gap: 2 }}>
                <button className="btn small" data-testid="export-preset"
                  title={p.description ?? ""} onClick={() => usePreset(p)}>{p.name}</button>
                {!String(p.id).startsWith("builtin_") && (
                  <button className="btn small" data-testid="export-preset-delete"
                    title="Delete this preset" onClick={() => void deletePreset(p.id)}>×</button>
                )}
              </span>
            ))}
            {presets !== null && presets.length === 0 && (
              <span className="muted" style={{ fontSize: 12 }}>No presets yet.</span>
            )}
            <a className="btn small primary" href={presetHref} target="_blank" data-testid="export-preset-download">
              ⬇ Download as {format.toUpperCase()}
            </a>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 4, alignItems: "center" }}>
            <input className="input" style={{ width: 200 }} placeholder="Save these settings as…"
              data-testid="export-preset-name" value={presetName}
              disabled={!presetsSaveable}
              onChange={(e) => setPresetName(e.target.value)} />
            <button className="btn small" data-testid="export-preset-save"
              disabled={!presetsSaveable || !presetName.trim()}
              onClick={() => void savePreset()}>Save preset</button>
            <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
              <input type="checkbox" data-testid="export-with-dictionary"
                checked={withDictionary} onChange={(e) => setWithDictionary(e.target.checked)} />
              Include the data dictionary
            </label>
          </div>
          {presetNote && (
            <div className="muted" data-testid="export-preset-note" style={{ fontSize: 12, marginBottom: 10 }}>{presetNote}</div>
          )}
          <p className="muted" style={{ fontSize: 12, margin: "2px 0 14px" }}>
            A preset is a saved set of these choices, shared across every study in the workspace.
            Selecting one fills the controls; the download still happens when you press it.
            {withDictionary ? " With the dictionary included, SPSS and SAS download as a zip." : ""}
          </p>

          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>Statistical formats</div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            <a className="btn small" href={savHref} target="_blank" data-testid="export-sav"
              title="SPSS system file — variable labels, value labels and missing values as metadata">⬇ SPSS (.sav)</a>
            <a className="btn small" href={sasHref} target="_blank" data-testid="export-sas"
              title="Zip: SAS transport file, CSV, and a .sas program with PROC FORMAT and LABEL">⬇ SAS (.xpt + syntax)</a>
            <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
              Codes stay codes in these; the labels travel as metadata, so frequencies come out labelled.
            </span>
          </div>

          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Coded answers in CSV and Excel</div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }} data-testid="export-values">
            {([
              ["code", "Codes only", "1, 2 — what the survey stored"],
              ["label", "Labels only", "Male, Female — readable on its own"],
              ["code_label", "Codes + labels", "2 - Male — both, for reconciling"],
            ] as const).map(([mode, label, hint]) => (
              <button key={mode} className={`btn small ${values === mode ? "primary" : ""}`}
                data-testid={`export-values-${mode}`} title={hint}
                onClick={() => setValues(mode)}>{label}</button>
            ))}
            <span className="muted" style={{ fontSize: 12 }}>
              {values === "code" ? "The default — what data processing expects."
                : values === "label" ? "Open text and numbers are untouched; only coded answers change."
                : "Separated by \u201c - \u201d."}
            </span>
          </div>
        </div>
      )}

      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap", gap: 6, alignItems: "center" }} data-testid="dataset-selector">
        <span className="muted" style={{ fontSize: 12.5 }}>Dataset for table &amp; exports:</span>
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

      <p className="muted" style={{ fontSize: 13 }}>
        Every run of the Test Survey link is stored here, flattened into the programmed variables —
        the same shape the CSV export produces. Test sessions never count toward quotas.
      </p>

      {error && <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>{error}</div>}
      {rows === null && !error && <Loading label="Loading responses…" rows={4} />}
      {rows?.length === 0 && !error && (
        <p className="muted">
          No {include === "all" ? "" : include} responses yet.{" "}
          {include === "test" && "Open the Test Survey link and answer a few questions, then refresh."}
        </p>
      )}

      {!!rows?.length && (
        <>
          <label className="row" style={{ gap: 6, fontSize: 13, marginBottom: 8 }}>
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
