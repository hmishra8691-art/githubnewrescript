"use client";
import React from "react";

/**
 * MIGRATE LEGACY DATA (I4) — responses from another platform (an SPSS-exported CSV, a CSV or a workbook of a past
 * wave), mapped onto the current version: preview the map, the values that matched nothing and the reconciliation,
 * see the price, then store them in one go. Migrated responses are data, not interviews: billed per response,
 * never counted in quotas, and marked "migration" in the list.
 */
interface Preview {
  rows: number; version: string | null; batch: string;
  summary: { rows: number; mappedColumns: number; variablesMatching: number; variablesDiffering: number; valuesLost: number; weighted: boolean };
  plan: { columns: { column: string; target: string; how: string }[]; unmatchedColumns: string[]; unfilledQuestions: string[]; weight: string | null; idColumn: string | null };
  reconciliation: { variable: string; column: string; matches: boolean }[];
  quote: { amount: number; perResponse: number; environment: string; testAdjustment: string } | null;
}

const money = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

export function MigrateLegacyDialog({ surveyDbId, environment, onClose, onDone }: { surveyDbId: string; environment: "TEST" | "LIVE"; onClose: () => void; onDone: (msg: string) => void }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [env, setEnv] = React.useState<"TEST" | "LIVE">(environment);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const send = async (commit: boolean) => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.set("file", file); fd.set("environment", env);
      if (commit && preview) { fd.set("commit", "1"); fd.set("batch", preview.batch); fd.set("expectedRows", String(preview.rows)); }
      const r = await fetch(`/api/surveys/${surveyDbId}/import-data`, { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(String(j.error ?? `The request failed (${r.status}).`)); if (j.code === "rows_changed") setPreview(null); return; }
      if (commit) onDone(`${j.stored} legacy response${j.stored === 1 ? "" : "s"} migrated into ${env === "TEST" ? "test" : "live"} data${j.charged ? ` — ${money(j.charged.amount)} charged` : ""}. They are not counted in quotas.`);
      else setPreview(j as Preview);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal rm-import" role="dialog" aria-modal="true" data-testid="migrate" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Migrate legacy data</h2>
          <button className="btn small" onClick={onClose}>Close</button>
        </div>
        <p className="qs-help">Responses from another platform or a past wave — a CSV or workbook (from SPSS, export it as CSV with value labels or codes). Columns are matched to this survey's current version by name and label; codes and labels are recoded; a weight column becomes WEIGHT. Migrated responses are analysed and exported like any other, but they are <strong>not counted in quotas</strong> and are billed per migrated response, not as completes.</p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label className="btn small">Choose file
            <input type="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm" style={{ display: "none" }} data-testid="migrate-file" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setError(null); }} />
          </label>
          <span className="muted" style={{ fontSize: 12.5 }}>{file ? file.name : "no file chosen"}</span>
          <select className="select" style={{ width: 150 }} value={env} data-testid="migrate-env" onChange={(e) => { setEnv(e.target.value as "TEST" | "LIVE"); setPreview(null); }}>
            <option value="LIVE">into live data</option>
            <option value="TEST">into test data</option>
          </select>
          <button className="btn small primary" data-testid="migrate-preview" disabled={!file || busy} onClick={() => void send(false)}>{busy && !preview ? "Reading…" : "Preview"}</button>
        </div>
        {error && <div className="alert error" style={{ marginTop: 10 }} data-testid="migrate-error">{error}</div>}
        {preview && (
          <div style={{ marginTop: 12 }} data-testid="migrate-preview-result">
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className="chip">{preview.rows.toLocaleString("en")} responses</span>
              <span className="chip">{preview.summary.mappedColumns} columns mapped{preview.version ? ` onto version ${preview.version}` : ""}</span>
              <span className={`chip${preview.summary.variablesDiffering ? "" : " on"}`}>{preview.summary.variablesMatching} variables reconcile{preview.summary.variablesDiffering ? `, ${preview.summary.variablesDiffering} differ` : ""}</span>
              {preview.summary.valuesLost > 0 && <span className="chip" title="Values with no matching option — listed per row in the reconciliation">{preview.summary.valuesLost} values matched nothing</span>}
              {preview.plan.weight && <span className="chip">weight: {preview.plan.weight}</span>}
              {preview.plan.idColumn && <span className="chip">id: {preview.plan.idColumn} → LEGACY_ID</span>}
            </div>
            {preview.plan.unmatchedColumns.length > 0 && <p className="qs-help">Not carried over (no matching question): {preview.plan.unmatchedColumns.slice(0, 20).join(", ")}{preview.plan.unmatchedColumns.length > 20 ? ` and ${preview.plan.unmatchedColumns.length - 20} more` : ""}.</p>}
            {preview.reconciliation.some((x) => !x.matches) && <p className="qs-help">Differ after migration: {preview.reconciliation.filter((x) => !x.matches).map((x) => `${x.variable} (from ${x.column})`).slice(0, 12).join(", ")} — check these before storing.</p>}
            <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 10 }}>
              <button className="btn small primary" data-testid="migrate-commit" disabled={busy || !preview.rows || !preview.summary.mappedColumns} onClick={() => void send(true)}>
                {busy ? "Storing…" : `Store ${preview.rows.toLocaleString("en")} responses${preview.quote ? ` — ${preview.quote.amount > 0 ? money(preview.quote.amount) : "free"}` : ""}`}
              </button>
              {preview.quote && <span className="muted" style={{ fontSize: 12 }} data-testid="migrate-quote">{preview.quote.amount > 0 ? `${money(preview.quote.perResponse)} per migrated response` : env === "TEST" ? "Test data is not charged" : "Not charged"}. Stored in one step: all of them or none.</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
