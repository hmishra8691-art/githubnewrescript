"use client";
import React from "react";
import { useStudio } from "./store";
import {
  ALL_FIELDS, FIELD_GROUPS, FIELD_LABELS, EXPORT_PRESETS, PRESET_LABELS,
  matchPreset, type ExportFields, type PresetName,
} from "@rescript/exporters";

/**
 * Export the programmed survey.
 *
 * One configuration, two formats. Both are rendered on the server from the
 * definition currently in the editor — not from the last saved version — so
 * what you export is what you are looking at.
 *
 * Nothing is ticked on your behalf beyond the preset you pick: an export that
 * omits skip logic does so because it was not asked for, and the JSON says as
 * much in its own header rather than letting a reviewer assume the survey has
 * none.
 */
export function ExportDialog({ onClose }: { onClose(): void }) {
  const s = useStudio();
  const [format, setFormat] = React.useState<"docx" | "json">("docx");
  const [fields, setFields] = React.useState<ExportFields>(EXPORT_PRESETS.spec);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const preset = matchPreset(fields);
  const count = ALL_FIELDS.filter((f) => fields[f]).length;

  const toggle = (f: keyof ExportFields) => setFields((x) => ({ ...x, [f]: !x[f] }));

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/surveys/${s.surveyDbId ?? "sandbox"}/export/survey`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definition: s.def, fields, format, version: s.def.meta.version }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error([j.error, ...(j.issues ?? [])].filter(Boolean).join(" — ") || `export failed (${res.status})`);
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1]
        ?? `survey.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      s.toast(`Exported ${name}`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal export-modal" role="dialog" aria-label="Export survey"
        data-testid="export-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 12px" }}>Export survey</h3>

        <div className="flabel">Format</div>
        <div className="row" style={{ gap: 8, marginBottom: 6 }}>
          <label className={`move-opt fmt ${format === "docx" ? "on" : ""}`}>
            <input type="radio" name="fmt" checked={format === "docx"} onChange={() => setFormat("docx")} />
            <span><strong>Word (.docx)</strong><br />
              <span className="muted" style={{ fontSize: 11 }}>for review, QA and client handover</span></span>
          </label>
          <label className={`move-opt fmt ${format === "json" ? "on" : ""}`} data-testid="fmt-json">
            <input type="radio" name="fmt" checked={format === "json"} onChange={() => setFormat("json")} />
            <span><strong>JSON (.json)</strong><br />
              <span className="muted" style={{ fontSize: 11 }}>the structured definition</span></span>
          </label>
        </div>

        <div className="flabel" style={{ marginTop: 10 }}>Preset</div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {(Object.keys(EXPORT_PRESETS) as PresetName[]).map((p) => (
            <button key={p} data-testid={`preset-${p}`}
              className={`btn small ${preset === p ? "primary" : ""}`}
              title={PRESET_LABELS[p].hint}
              onClick={() => setFields(EXPORT_PRESETS[p])}>
              {PRESET_LABELS[p].label}
            </button>
          ))}
          <span className="chip" data-testid="preset-state">
            {preset ? PRESET_LABELS[preset].label : "Custom"} · {count} field{count === 1 ? "" : "s"}
          </span>
        </div>

        <div className="flabel" style={{ marginTop: 12 }}>What should be included?</div>
        <div className="export-fields">
          {FIELD_GROUPS.map((g) => (
            <div key={g.title} className="export-group">
              <div className="eg-title">{g.title}</div>
              {g.fields.map((f) => (
                <label key={f} className="export-check">
                  <input type="checkbox" checked={fields[f]} data-testid={`field-${f}`}
                    onChange={() => toggle(f)} />
                  <span>{FIELD_LABELS[f]}</span>
                </label>
              ))}
            </div>
          ))}
        </div>

        {format === "json" && count < ALL_FIELDS.length && (
          <p className="muted" style={{ fontSize: 11.5, marginBottom: 0 }}>
            A filtered JSON export is for reading, not for re-importing — it is missing
            fields the survey needs. Choose <em>Full export</em> for a file that round-trips.
          </p>
        )}

        {error && <div className="chip warn" style={{ display: "block", marginTop: 10, padding: "7px 10px", whiteSpace: "normal" }}>{error}</div>}

        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" data-testid="do-export" onClick={run} disabled={busy || count === 0}>
            {busy ? "Exporting…" : `Export ${format === "docx" ? "Word" : "JSON"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
