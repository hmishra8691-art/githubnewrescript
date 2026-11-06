"use client";
import React from "react";
import type { AxApi, Row } from "./api";
import { useSelection } from "./selection";
import type { WsTab } from "./navigation";

/**
 * PRESENT (Analytics upgrade M6) — the selection becomes a deliverable. Everything selected anywhere (Overview's
 * findings, Explore's saved panels, Architect's ticks, whole reports) is listed here in order: retitle it, add
 * your own observation under it, reorder, drop. Then one export — PowerPoint, PDF, Excel or CSV — with the
 * engine's interpretation under every chart when wanted, or "Save as report" to keep editing it in Reports with
 * templates, branding and publishing. Nothing is exported one chart at a time.
 */
const CATEGORY_WORD: Record<string, string> = { crosstabs: "Crosstab", tests: "Statistical test", models: "Model", correlations: "Correlation", charts: "Chart", hypotheses: "Hypothesis", findings: "Finding", themes: "Theme", reports: "Report", dashboards: "Dashboard" };

export function PresentWorkbench(p: { api: AxApi; surveyTitle: string; canExport: boolean; canEdit: boolean; themes: Row[]; onTab: (t: WsTab) => void; onSaved: () => void }) {
  const s = useSelection();
  const [title, setTitle] = React.useState("");
  const [interpretations, setInterpretations] = React.useState(true);
  const [themeId, setThemeId] = React.useState<string>("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  const payload = () => ({ selection: s.items.map((i) => ({ key: i.key, ...(i.title ? { title: i.title } : {}), ...(i.note ? { note: i.note } : {}) })), title: title.trim() || `${p.surveyTitle} — selection`, interpretations, ...(themeId ? { themeId } : {}) });

  const exportAs = async (format: "pptx" | "pdf" | "xlsx" | "csv") => {
    if (!s.items.length) return;
    setBusy(format); setNotice(null);
    try {
      const { notes } = await p.api.export({ ...payload(), format });
      setNotice({ tone: notes.length ? "warn" : "ok", text: notes.length ? `Exported ${format.toUpperCase()} — ${s.items.length} item${s.items.length === 1 ? "" : "s"}. Left out: ${notes.join("; ")}` : `Exported ${format.toUpperCase()} with ${s.items.length} item${s.items.length === 1 ? "" : "s"}${interpretations ? ", interpretations included" : ""}.` });
    } catch (e) { setNotice({ tone: "error", text: (e as Error).message }); } finally { setBusy(null); }
  };
  const saveReport = async () => {
    if (!s.items.length) return;
    setBusy("save"); setNotice(null);
    try {
      const d = await p.api.selectionDefinition(payload());
      const name = title.trim() || `${p.surveyTitle} — selection`;
      await p.api.create("reports", { name, kind: "report", definition: d.definition, themeId: themeId || null, mode: "live" });
      setNotice({ tone: d.skipped.length ? "warn" : "ok", text: `Saved “${name}” as a report with ${d.definition.blocks.length - 1} blocks${d.skipped.length ? ` (left out: ${d.skipped.map((x) => x.reason).join("; ")})` : ""} — open it in Reports to template, brand and publish it.` });
      p.onSaved();
    } catch (e) { setNotice({ tone: "error", text: (e as Error).message }); } finally { setBusy(null); }
  };

  return (
    <div className="ax-present" data-testid="ax-present">
      <div className="ax-present-head">
        <div>
          <h2 style={{ margin: 0 }}>Present</h2>
          <div className="muted" style={{ fontSize: 13 }}>{s.items.length ? `${s.items.length} item${s.items.length === 1 ? "" : "s"} selected across the workspace — one deliverable.` : "Select charts, tables, hypotheses, findings and themes anywhere in Analytics; they gather here."}</div>
        </div>
        <span className="grow" />
        <button className="btn small ghost" onClick={() => p.onTab("reports")}>Reports</button>
        <button className="btn small ghost" onClick={() => p.onTab("exports")}>Export settings</button>
      </div>
      {notice && <div className={`ax-notice ${notice.tone}`} onClick={() => setNotice(null)} data-testid="ax-present-notice">{notice.text}</div>}
      <div className="ax-present-grid">
        <section className="ax-present-list">
          {!s.items.length && (
            <div className="axa-empty">
              <b>Nothing selected yet.</b>
              <p className="muted">Tick entries in Architect's Explorer, press "Select" on a finding in Overview or on a saved panel in Explore, or add a whole report. Then export everything at once, or save it as a report.</p>
              <div className="row" style={{ gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
                <button className="btn small" onClick={() => p.onTab("architect")}>Open Architect</button>
                <button className="btn small" onClick={() => p.onTab("home")}>Open Overview</button>
              </div>
            </div>
          )}
          {s.items.map((it, i) => {
            const category = it.key.split(":")[0];
            const open = editing === it.key;
            return (
              <div key={it.key} className="ax-present-item" data-testid="ax-present-item" data-key={it.key}>
                <div className="ax-present-item-head">
                  <span className="ax-present-n">{i + 1}</span>
                  <span className="axa-chip">{CATEGORY_WORD[category] ?? category}</span>
                  <span className="ax-present-item-title">{it.title || it.label}</span>
                  <span className="grow" />
                  <button className="btn small ghost" onClick={() => s.move(it.key, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                  <button className="btn small ghost" onClick={() => s.move(it.key, 1)} disabled={i === s.items.length - 1} aria-label="Move down">↓</button>
                  <button className="btn small ghost" onClick={() => setEditing(open ? null : it.key)} data-testid="ax-present-edit">{open ? "Done" : "Edit"}</button>
                  <button className="btn small ghost" onClick={() => s.remove(it.key)} aria-label="Remove">×</button>
                </div>
                {it.note && !open && <div className="ax-present-note muted">{it.note}</div>}
                {open && (
                  <div className="ax-present-edit">
                    <label className="ax-field"><span>Title in the deliverable</span><input className="input" value={it.title ?? ""} placeholder={it.label} onChange={(e) => s.update(it.key, { title: e.target.value })} data-testid="ax-present-title" /></label>
                    <label className="ax-field"><span>Your observation (printed under it)</span><textarea className="input" rows={3} value={it.note ?? ""} onChange={(e) => s.update(it.key, { note: e.target.value })} data-testid="ax-present-note" /></label>
                  </div>
                )}
              </div>
            );
          })}
          {s.items.length > 0 && <div className="row" style={{ marginTop: 8 }}><button className="btn small ghost" onClick={() => { if (window.confirm("Clear the whole selection?")) s.clear(); }}>Clear selection</button></div>}
        </section>
        <aside className="ax-present-side">
          <div className="card">
            <div className="card-title">Deliverable</div>
            <label className="ax-field"><span>Title</span><input className="input" value={title} placeholder={`${p.surveyTitle} — selection`} onChange={(e) => setTitle(e.target.value)} data-testid="ax-present-doc-title" /></label>
            <label className="ax-field"><span>Report theme</span><select className="select" value={themeId} onChange={(e) => setThemeId(e.target.value)}><option value="">Default</option>{p.themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            <label className="ax-toggle" style={{ display: "block", margin: "8px 0" }}><input type="checkbox" checked={interpretations} onChange={(e) => setInterpretations(e.target.checked)} data-testid="ax-present-interp" /> Print the plain-language interpretation and the statistics under every analysis</label>
            <div className="ax-present-actions">
              {(["pptx", "pdf", "xlsx", "csv"] as const).map((f) => (
                <button key={f} className={`btn ${f === "pptx" ? "primary" : ""} ${busy === f ? "loading" : ""}`} disabled={!p.canExport || !s.items.length || !!busy} onClick={() => void exportAs(f)} data-testid={`ax-present-export-${f}`} title={!p.canExport ? "Your role cannot export" : f === "csv" ? "Every table, one CSV" : f === "xlsx" ? "Tables and charts in a workbook" : f === "pdf" ? "A document with vector charts, tables and interpretations" : "A deck, one slide per chart and table"}>{f.toUpperCase()}</button>
              ))}
            </div>
            <button className={`btn ${busy === "save" ? "loading" : ""}`} style={{ width: "100%", marginTop: 8 }} disabled={!p.canEdit || !s.items.length || !!busy} onClick={() => void saveReport()} data-testid="ax-present-save" title={!p.canEdit ? "Your role cannot create reports" : "Keep editing it in Reports: templates, branding, publishing, sharing"}>Save as report</button>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Charts keep their styling, tables their significance letters; every number comes from a fresh computation of the saved analysis. The interpretation is the engine's; nothing is written by a model unless you asked for it elsewhere.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
