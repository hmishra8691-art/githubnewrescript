"use client";
import React from "react";
import type { AnalysisDefinition, AnalysisResult, ChartSpec, DashboardDefinition, DashboardWidget, ExportSettings, ReportBlock, ReportDefinition, ReportTheme } from "@rescript/analytics";
import { CHART_CATALOG, DEFAULT_EXPORT_SETTINGS, describeTemplate, type ReportTemplate } from "@rescript/analytics";
import { AxApi, type Row, timeAgo } from "./api";
import { ReportView } from "./ReportView";

/**
 * REPORT & DASHBOARD BUILDER (§12, §16, §17, §26, §34, §35). A report is an
 * ordered list of blocks over saved analyses; a dashboard is a grid of widgets.
 * Publishing freezes a version (definition + theme + computed results); share
 * links point at versions, never at the editable draft. The export dialog
 * hands the same definition and settings to the server-side PPT / Excel
 * builders.
 */

const uid = () => Math.random().toString(36).slice(2, 10);

export function ExportDialog({ api, reportId, analysisId, definition, chart, themes, versions, onClose }: { api: AxApi; reportId?: string; analysisId?: string; definition?: unknown; chart?: ChartSpec; themes: Row[]; versions?: number[]; onClose: () => void }) {
  const [settings, setSettings] = React.useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS);
  const [themeId, setThemeId] = React.useState<string>("");
  const [version, setVersion] = React.useState<string>("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inc = settings.include;
  const setInc = (k: keyof ExportSettings["include"], v: boolean) => setSettings({ ...settings, include: { ...inc, [k]: v } });
  const go = async () => { setBusy(true); setError(null); try { await api.export({ format: settings.format, reportId, analysisId, definition, chart, themeId: themeId || null, settings, version: version ? Number(version) : undefined }); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return (
    <div className="modal-back" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()} data-testid="ax-export-dialog">
      <h2>Export</h2>
      <div className="ax-cust-grid">
        <label className="ax-field"><span>Format</span><div className="row"><label className="ax-toggle"><input type="radio" checked={settings.format === "pptx"} onChange={() => setSettings({ ...settings, format: "pptx" })} /> PowerPoint</label><label className="ax-toggle"><input type="radio" checked={settings.format === "xlsx"} onChange={() => setSettings({ ...settings, format: "xlsx" })} /> Excel</label></div></label>
        <label className="ax-field"><span>Theme</span><select className="select small" value={themeId} onChange={(e) => setThemeId(e.target.value)}><option value="">Report's theme / default</option>{themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        {versions && versions.length > 0 && <label className="ax-field"><span>Version</span><select className="select small" value={version} onChange={(e) => setVersion(e.target.value)}><option value="">Live (current data)</option>{versions.map((v) => <option key={v} value={v}>Published v{v}</option>)}</select></label>}
      </div>
      <div className="flabel" style={{ marginTop: 8 }}>Include</div>
      <div className="ax-toggles">{([["executiveSummary", "Executive summary"], ["charts", "Charts"], ["tables", "Tables"], ["tests", "Statistical tests"], ["sampleProfile", "Sample profile"], ["methodology", "Methodology"], ["footnotes", "Footnotes"]] as [keyof ExportSettings["include"], string][]).map(([k, l]) => <label key={k} className="ax-toggle"><input type="checkbox" checked={inc[k]} onChange={(e) => setInc(k, e.target.checked)} /> {l}</label>)}</div>
      {settings.format === "pptx" ? (
        <div className="ax-cust-grid" style={{ marginTop: 8 }}>
          <label className="ax-field"><span>Slide size</span><select className="select small" value={settings.pptx?.slideSize ?? "16x9"} onChange={(e) => setSettings({ ...settings, pptx: { ...settings.pptx, slideSize: e.target.value as "16x9" | "4x3" | "16x10" } })}><option value="16x9">16:9</option><option value="16x10">16:10</option><option value="4x3">4:3</option></select></label>
          <label className="ax-field"><span>Font</span><input className="input small" value={settings.pptx?.fontFamily ?? ""} onChange={(e) => setSettings({ ...settings, pptx: { ...settings.pptx, fontFamily: e.target.value || undefined } })} placeholder="theme font" /></label>
          <label className="ax-field"><span>Footer</span><input className="input small" value={settings.pptx?.footer ?? ""} onChange={(e) => setSettings({ ...settings, pptx: { ...settings.pptx, footer: e.target.value || undefined } })} placeholder="theme footer" /></label>
          <label className="ax-field"><span>Background</span><input className="input small" value={settings.pptx?.background ?? ""} onChange={(e) => setSettings({ ...settings, pptx: { ...settings.pptx, background: e.target.value || undefined } })} placeholder="#ffffff" /></label>
          <label className="ax-field"><span>Chart height (in)</span><input className="input small" type="number" step={0.1} value={settings.pptx?.chartHeight ?? ""} onChange={(e) => setSettings({ ...settings, pptx: { ...settings.pptx, chartHeight: e.target.value ? Number(e.target.value) : undefined } })} placeholder="3.7" /></label>
          <div className="ax-toggles"><label className="ax-toggle"><input type="checkbox" checked={settings.pptx?.sectionDividers !== false} onChange={(e) => setSettings({ ...settings, pptx: { ...settings.pptx, sectionDividers: e.target.checked } })} /> Section dividers</label><label className="ax-toggle"><input type="checkbox" checked={settings.pptx?.slideNumbers !== false} onChange={(e) => setSettings({ ...settings, pptx: { ...settings.pptx, slideNumbers: e.target.checked } })} /> Slide numbers</label></div>
        </div>
      ) : (
        <div className="ax-cust-grid" style={{ marginTop: 8 }}>
          <label className="ax-field"><span>Summary sheet name</span><input className="input small" value={settings.xlsx?.sheetNames?.summary ?? ""} onChange={(e) => setSettings({ ...settings, xlsx: { ...settings.xlsx, sheetNames: { ...settings.xlsx?.sheetNames, summary: e.target.value } } })} placeholder="Summary" /></label>
          <label className="ax-field"><span>Decimals</span><input className="input small" type="number" min={0} max={4} value={settings.xlsx?.decimals ?? 1} onChange={(e) => setSettings({ ...settings, xlsx: { ...settings.xlsx, decimals: Number(e.target.value) } })} /></label>
          <label className="ax-field"><span>Percent format</span><select className="select small" value={settings.xlsx?.percentFormat ?? "0.0%"} onChange={(e) => setSettings({ ...settings, xlsx: { ...settings.xlsx, percentFormat: e.target.value as "0%" | "0.0%" | "0.00%" } })}><option>0%</option><option>0.0%</option><option>0.00%</option></select></label>
          <label className="ax-field"><span>Table style</span><select className="select small" value={settings.xlsx?.tableStyle ?? "striped"} onChange={(e) => setSettings({ ...settings, xlsx: { ...settings.xlsx, tableStyle: e.target.value as "plain" | "striped" | "bordered" } })}><option value="plain">Plain</option><option value="striped">Striped</option><option value="bordered">Bordered</option></select></label>
          <label className="ax-field"><span>Font</span><input className="input small" value={settings.xlsx?.fontFamily ?? ""} onChange={(e) => setSettings({ ...settings, xlsx: { ...settings.xlsx, fontFamily: e.target.value || undefined } })} placeholder="theme font" /></label>
          <div className="ax-toggles"><label className="ax-toggle"><input type="checkbox" checked={settings.xlsx?.freezePanes !== false} onChange={(e) => setSettings({ ...settings, xlsx: { ...settings.xlsx, freezePanes: e.target.checked } })} /> Freeze panes</label><label className="ax-toggle"><input type="checkbox" checked={settings.xlsx?.autoFilter !== false} onChange={(e) => setSettings({ ...settings, xlsx: { ...settings.xlsx, autoFilter: e.target.checked } })} /> Auto-filter</label><label className="ax-toggle"><input type="checkbox" checked={settings.xlsx?.includeNotes !== false} onChange={(e) => setSettings({ ...settings, xlsx: { ...settings.xlsx, includeNotes: e.target.checked } })} /> Notes</label><label className="ax-toggle"><input type="checkbox" checked={settings.xlsx?.includeMetadata !== false} onChange={(e) => setSettings({ ...settings, xlsx: { ...settings.xlsx, includeMetadata: e.target.checked } })} /> Metadata sheet</label></div>
        </div>
      )}
      <div className="row" style={{ marginTop: 14 }}>{error && <span className="ax-error">{error}</span>}<span className="grow" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={go} data-testid="ax-export-go">{busy ? "Generating…" : "Generate export"}</button></div>
    </div></div>
  );
}

export function ShareDialog({ api, report, onClose, onCreated }: { api: AxApi; report: Row; onClose: () => void; onCreated: () => void }) {
  const [access, setAccess] = React.useState<"private" | "users" | "link">("link");
  const [permission, setPermission] = React.useState<"viewer" | "download">("viewer");
  const [emails, setEmails] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [expires, setExpires] = React.useState("");
  const [pin, setPin] = React.useState(true);
  const [label, setLabel] = React.useState("");
  const [link, setLink] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const create = async () => {
    setError(null);
    try {
      const r = await api.create("shares", { reportId: report.id, access, permission, emails: emails.split(/[,\s]+/).filter(Boolean), password: password || undefined, expiresAt: expires ? new Date(expires).toISOString() : null, pinVersion: pin, label: label || undefined });
      setLink(`${window.location.origin}/share/${r.item.token}`); onCreated();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <div className="modal-back" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()} data-testid="ax-share-dialog">
      <h2>Share “{report.name}”</h2>
      {!report.published_version ? <div className="ax-warnings">Publish a version first — a share link always shows a published snapshot, never the editable draft.</div> : <div className="muted" style={{ fontSize: 13 }}>Viewers get the read-only presentation of published version {report.published_version}. Editing the report later does not change what they see until you republish.</div>}
      <div className="flabel" style={{ marginTop: 10 }}>Sharing</div>
      <div className="ax-toggles"><label className="ax-toggle"><input type="radio" checked={access === "private"} onChange={() => setAccess("private")} /> Private (project members only)</label><label className="ax-toggle"><input type="radio" checked={access === "users"} onChange={() => setAccess("users")} /> Specific users</label><label className="ax-toggle"><input type="radio" checked={access === "link"} onChange={() => setAccess("link")} /> Anyone with the link</label></div>
      {access === "users" && <label className="ax-field"><span>Emails or user IDs (comma separated) — they sign in to view</span><textarea className="ta" rows={2} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="client@example.com, colleague@example.com" /></label>}
      <div className="ax-cust-grid">
        <label className="ax-field"><span>Permission</span><select className="select small" value={permission} onChange={(e) => setPermission(e.target.value as "viewer" | "download")}><option value="viewer">Viewer (view only)</option><option value="download">Download only (view + PPT / Excel)</option></select></label>
        <label className="ax-field"><span>Expires</span><input className="input small" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
        <label className="ax-field"><span>Password (optional)</span><input className="input small" type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="none" /></label>
        <label className="ax-field"><span>Label</span><input className="input small" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Client A" /></label>
      </div>
      <label className="ax-toggle"><input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} /> Pin to version {report.published_version ?? "—"} (unpinned links follow the latest published version when you republish)</label>
      {link && <div className="ax-link" data-testid="ax-share-link"><input className="input" readOnly value={link} onFocus={(e) => e.target.select()} /><button className="btn small" onClick={() => navigator.clipboard?.writeText(link)}>Copy</button></div>}
      <div className="row" style={{ marginTop: 14 }}>{error && <span className="ax-error">{error}</span>}<span className="grow" /><button className="btn" onClick={onClose}>Close</button>{!link && <button className="btn primary" disabled={!report.published_version} onClick={create} data-testid="ax-share-create">Create share link</button>}</div>
    </div></div>
  );
}

function BlockEditor({ block, analyses, onChange, onClose }: { block: ReportBlock | DashboardWidget; analyses: Row[]; onChange: (b: ReportBlock | DashboardWidget) => void; onClose: () => void }) {
  const b = block as Record<string, unknown> & { type: string };
  const set = (patch: Record<string, unknown>) => onChange({ ...(block as object), ...patch } as ReportBlock);
  const chartTypes = CHART_CATALOG;
  return (
    <div className="modal-back" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}>
      <h2>Edit {b.type.replace("_", " ")}</h2>
      {"title" in b || ["chart", "table", "kpi", "text", "section", "cover", "insights", "executive_summary", "methodology"].includes(b.type) ? <label className="ax-field"><span>Title</span><input className="input" value={(b.title as string) ?? ""} onChange={(e) => set({ title: e.target.value })} /></label> : null}
      {(b.type === "cover" || b.type === "section") && <label className="ax-field"><span>Subtitle</span><input className="input" value={(b.subtitle as string) ?? ""} onChange={(e) => set({ subtitle: e.target.value })} /></label>}
      {b.type === "cover" && <label className="ax-field"><span>Author</span><input className="input" value={(b.author as string) ?? ""} onChange={(e) => set({ author: e.target.value })} /></label>}
      {b.type === "text" && <label className="ax-field"><span>Text (markdown: #, **bold**, - lists)</span><textarea className="ta" rows={6} value={(b.markdown as string) ?? (b.text as string) ?? ""} onChange={(e) => set(b.markdown !== undefined || !("text" in b) ? { markdown: e.target.value } : { text: e.target.value })} /></label>}
      {(b.type === "chart" || b.type === "table" || b.type === "kpi") && <label className="ax-field"><span>Analysis</span><select className="select" value={(b.analysisId as string) ?? ""} onChange={(e) => set({ analysisId: e.target.value })}><option value="">—</option>{analyses.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.kind})</option>)}</select></label>}
      {b.type === "chart" && <label className="ax-field"><span>Chart type</span><select className="select" value={((b.chart as ChartSpec | undefined)?.type) ?? "bar_vertical"} onChange={(e) => set({ chart: { ...((b.chart as ChartSpec) ?? { options: {} }), type: e.target.value } })}>{chartTypes.map((c) => <option key={c.type} value={c.type}>{c.label}</option>)}</select></label>}
      {(b.type === "chart" || b.type === "table") && <label className="ax-field"><span>Caption</span><input className="input" value={(b.caption as string) ?? ""} onChange={(e) => set({ caption: e.target.value })} /></label>}
      {(b.type === "insights" || b.type === "executive_summary") && <div className="ax-field"><span>Analyses</span><div className="ax-chips">{analyses.map((a) => { const ids = (b.analysisIds as string[]) ?? []; const on = ids.includes(a.id); return <button key={a.id} type="button" className={`ax-chip ${on ? "on" : ""}`} onClick={() => set({ analysisIds: on ? ids.filter((x) => x !== a.id) : [...ids, a.id] })}>{a.name}</button>; })}</div></div>}
      {b.type === "executive_summary" && <label className="ax-field"><span>Introduction</span><textarea className="ta" rows={3} value={(b.text as string) ?? ""} onChange={(e) => set({ text: e.target.value })} /></label>}
      {/*
        * §36 — the methodology, in the team's own words.
        *
        * These fields replace the four lines of boilerplate the PowerPoint
        * export used to assert on every deck: who generated it, that
        * percentages are of valid responses, how the significance letters
        * work. The last two are true of how this platform computes and are
        * kept as the "standard notes" toggle. Everything above them is a
        * claim about THIS study — its fieldwork dates, its sample frame, its
        * weighting — which only the research team can make, and which a
        * client reading a table without it is reading wrong.
        */}
      {b.type === "methodology" && <>
        <div className="ax-cust-grid">
          <label className="ax-field"><span>Fieldwork from</span><input className="input" type="date" value={((b.fieldwork as { from?: string } | undefined)?.from) ?? ""} onChange={(e) => set({ fieldwork: { ...((b.fieldwork as object) ?? {}), from: e.target.value } })} /></label>
          <label className="ax-field"><span>to</span><input className="input" type="date" value={((b.fieldwork as { to?: string } | undefined)?.to) ?? ""} onChange={(e) => set({ fieldwork: { ...((b.fieldwork as object) ?? {}), to: e.target.value } })} /></label>
        </div>
        <label className="ax-field"><span>Sample frame</span><input className="input" placeholder="n = 1,004 UK adults 18+, nationally representative" value={(b.sampleFrame as string) ?? ""} onChange={(e) => set({ sampleFrame: e.target.value })} /></label>
        <label className="ax-field"><span>Weighting</span><input className="input" placeholder="Weighted to age, gender and region (ONS mid-2024)" value={(b.weighting as string) ?? ""} onChange={(e) => set({ weighting: e.target.value })} /></label>
        <label className="ax-field"><span>Notes</span><textarea className="ta" rows={3} placeholder="Anything a reader needs to know to read these numbers correctly — what was excluded, how a derived measure was built, a caveat about one question." value={(b.notes as string) ?? ""} onChange={(e) => set({ notes: e.target.value })} /></label>
        <div className="ax-field">
          <span>Your own rows</span>
          {((b.items as { label: string; value: string }[]) ?? []).map((it, i) => (
            <div className="row" key={i} style={{ gap: 4, marginBottom: 4 }}>
              <input className="input small" style={{ maxWidth: 160 }} placeholder="Label" value={it.label} onChange={(e) => { const items = [...((b.items as { label: string; value: string }[]) ?? [])]; items[i] = { ...items[i], label: e.target.value }; set({ items }); }} />
              <input className="input small" placeholder="Value" value={it.value} onChange={(e) => { const items = [...((b.items as { label: string; value: string }[]) ?? [])]; items[i] = { ...items[i], value: e.target.value }; set({ items }); }} />
              <button className="btn small ghost" onClick={() => set({ items: ((b.items as unknown[]) ?? []).filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <button className="btn small" onClick={() => set({ items: [...(((b.items as unknown[]) ?? [])), { label: "", value: "" }] })}>+ row</button>
        </div>
        <label className="ax-toggle"><input type="checkbox" checked={b.includeStandardNotes !== false} onChange={(e) => set({ includeStandardNotes: e.target.checked })} /> Also show the standard statistical notes (base sizes, significance letters)</label>
      </>}
      {b.type === "page_break" && <p className="muted" style={{ fontSize: 13 }}>A page break has nothing to configure. It ends the page here — on screen, in print, and as a new slide in the PowerPoint export.</p>}
      {"w" in b && <div className="ax-cust-grid"><label className="ax-field"><span>Width (of 12)</span><input className="input small" type="number" min={2} max={12} value={b.w as number} onChange={(e) => set({ w: Number(e.target.value) })} /></label><label className="ax-field"><span>Height (rows)</span><input className="input small" type="number" min={2} max={10} value={b.h as number} onChange={(e) => set({ h: Number(e.target.value) })} /></label></div>}
      <div className="row" style={{ marginTop: 12 }}><span className="grow" /><button className="btn primary" onClick={onClose}>Done</button></div>
    </div></div>
  );
}

export function ReportsPanel({ api, analyses, themes, items, onChange, pendingAdd, clearPending, surveyTitle }: { api: AxApi; analyses: Row[]; themes: Row[]; items: Row[]; onChange: () => void; pendingAdd?: { analysis: Row; spec: ChartSpec } | null; clearPending?: () => void; surveyTitle: string }) {
  const [open, setOpen] = React.useState<Row | null>(null);
  const [def, setDef] = React.useState<ReportDefinition | DashboardDefinition | null>(null);
  const [results, setResults] = React.useState<Record<string, AnalysisResult>>({});
  const [loading, setLoading] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [versions, setVersions] = React.useState<Row[]>([]);
  const [viewVersion, setViewVersion] = React.useState<number | null>(null);
  /**
   * WHICH VERSION THE BODY IS ACTUALLY SHOWING (§35).
   *
   * `viewVersion` is the SELECTION — it changes the instant the dropdown
   * changes, so the control stays responsive. `shownVersion` is what has been
   * FETCHED AND RENDERED, and it is what labels the report.
   *
   * They were the same state, and that was wrong in a way that matters for a
   * versioning feature: selecting "Published v1" flipped the heading to
   * "Snapshot · v1" synchronously while `load()` was still in flight, so for
   * the length of that round trip the DRAFT's blocks sat under a snapshot
   * label — the reader was told they were looking at exactly what was
   * published while looking at unpublished edits. Splitting the two means the
   * label and the content can never disagree: until the snapshot is in hand
   * the body honestly reads "Live data", which is what it still is.
   */
  const [shownVersion, setShownVersion] = React.useState<number | null>(null);
  const [share, setShare] = React.useState(false);
  const [exp, setExp] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState<"report" | "dashboard" | null>(null);
  const [newName, setNewName] = React.useState("");
  /* §36 — report templates, and the saved filters a viewer may switch */
  const [templates, setTemplates] = React.useState<ReportTemplate[]>([]);
  const [templatesOpen, setTemplatesOpen] = React.useState(false);
  const [savedFilters, setSavedFilters] = React.useState<Row[]>([]);
  const isDash = open?.kind === "dashboard";
  const theme = (open?.theme_id ? (themes.find((t) => t.id === open.theme_id)?.theme as ReportTheme | undefined) : undefined) ?? null;

  const load = React.useCallback(async (r: Row, version?: number | null) => {
    setLoading(true); setError(null);
    try {
      const res = await api.results(r.id, version ?? undefined);
      setResults(res.results);
      /*
       * The definition and the label it is shown under are set together, in
       * one commit, so the body is never a version other than the one it
       * claims to be.
       */
      if (version) { setDef(res.definition as ReportDefinition); setShownVersion(version); }
      else setShownVersion(null);
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [api]);

  /** Results for analyses referenced by unsaved blocks: computed server-side per analysis. */
  const ensure = React.useCallback(async (ids: (string | undefined)[]) => {
    for (const id of ids) {
      if (!id || results[id]) continue;
      const a = analyses.find((x) => x.id === id); if (!a) continue;
      try { const { result } = await api.run({ ...(a.definition as AnalysisDefinition), name: a.name }); setResults((r) => ({ ...r, [id]: result })); } catch (e) { setError((e as Error).message); }
    }
  }, [api, analyses, results]);

  const openReport = async (r: Row) => {
    setOpen(r); setDef(r.definition as ReportDefinition); setDirty(false); setViewVersion(null); setShownVersion(null); setMsg(null);
    await load(r);
    const v = await api.versions("reports", r.id).catch(() => ({ versions: [] })); setVersions(v.versions);
    /*
     * §36 — the templates and the workspace's saved FILTERS (not segments:
     * `analytics_segments` holds both, and only the filter kind can be
     * offered to a viewer, because a segment is a breakdown of the base and
     * a filter is a restriction of it).
     */
    api.reportTemplates().then((t) => setTemplates(t.templates ?? [])).catch(() => {});
    api.list("segments", "kind=filter").then((f) => setSavedFilters(f.items ?? [])).catch(() => {});
  };

  const applyTemplateTo = async (templateId: string, name: string) => {
    if (!open) return;
    if (dirty && !confirm("Apply the template over unsaved changes? Blocks that already point at an analysis are kept.")) return;
    try {
      const r = await api.applyReportTemplate(open.id, templateId);
      setDef(r.definition as ReportDefinition);
      setDirty(false);
      setTemplatesOpen(false);
      setMsg(`Applied “${name}”. Blocks that already had an analysis were kept; the rest are placeholders waiting for one.`);
      const fresh = await api.get("reports", open.id); setOpen(fresh.item);
      onChange();
    } catch (e) { setError((e as Error).message); }
  };

  const saveAsTemplate = async () => {
    if (!open) return;
    const name = prompt("Name this report shape, so the team can reuse it:", `${open.name} shape`);
    if (!name?.trim()) return;
    if (dirty) await save();
    try {
      await api.saveReportTemplate({ name: name.trim(), fromReportId: open.id });
      setMsg(`Saved “${name.trim()}” as a report template for this workspace. Analysis references were stripped — a template is a shape, not a study.`);
      const t = await api.reportTemplates(); setTemplates(t.templates ?? []);
    } catch (e) { setError((e as Error).message); }
  };

  React.useEffect(() => {
    if (pendingAdd && open && def && !isDash) {
      const blocks = (def as ReportDefinition).blocks;
      setDef({ ...(def as ReportDefinition), blocks: [...blocks, { id: uid(), type: "chart", title: pendingAdd.analysis.name, analysisId: pendingAdd.analysis.id, chart: pendingAdd.spec }] }); setDirty(true); clearPending?.();
      void ensure([pendingAdd.analysis.id]);
    }
  }, [pendingAdd, open, def, isDash, clearPending, ensure]);

  const save = async () => { if (!open || !def) return; try { const r = await api.update("reports", open.id, { definition: def, name: (def as ReportDefinition).title || open.name }); setOpen(r.item); setDirty(false); setMsg("Saved."); onChange(); } catch (e) { setError((e as Error).message); } };
  const publish = async () => { if (!open) return; if (dirty) await save(); try { const r = await api.publish(open.id, prompt("Version note (optional)") ?? undefined); setMsg(`Published version ${r.version}. Share links pinned to older versions keep showing those; unpinned links now show v${r.version}.`); const v = await api.versions("reports", open.id); setVersions(v.versions); setOpen({ ...open, published_version: r.version }); onChange(); } catch (e) { setError((e as Error).message); } };
  const create = async () => { if (!newName.trim() || !creating) return; try { const r = await api.create("reports", { name: newName.trim(), kind: creating, mode: "live" }); setCreating(null); setNewName(""); onChange(); await openReport(r.item); } catch (e) { setError((e as Error).message); } };

  const addBlock = (type: ReportBlock["type"]) => {
    if (!def || isDash) return;
    const first = analyses[0]?.id ?? "", firstName = analyses[0]?.name;
    const b: ReportBlock = type === "cover" ? { id: uid(), type, title: (def as ReportDefinition).title } : type === "section" ? { id: uid(), type, title: "New section" } : type === "text" ? { id: uid(), type, markdown: "Write here…" } : type === "page_break" ? { id: uid(), type } : type === "methodology" ? { id: uid(), type, title: "Methodology", includeStandardNotes: true, items: [] } : type === "chart" ? { id: uid(), type, title: firstName, analysisId: first, chart: { type: (analyses[0]?.kind === "nps" ? "gauge" : "bar_vertical"), options: {} } } : type === "table" ? { id: uid(), type, title: firstName, analysisId: first } : type === "kpi" ? { id: uid(), type, title: firstName, analysisId: first } : type === "insights" ? { id: uid(), type, analysisIds: analyses.slice(0, 3).map((a) => a.id) } : { id: uid(), type: "executive_summary", analysisIds: analyses.slice(0, 5).map((a) => a.id) };
    setDef({ ...(def as ReportDefinition), blocks: [...(def as ReportDefinition).blocks, b] }); setDirty(true); setEditing(b.id);
    void ensure("analysisId" in b ? [b.analysisId] : "analysisIds" in b ? b.analysisIds : []);
  };
  const addWidget = (type: DashboardWidget["type"]) => {
    if (!def || !isDash) return;
    const w: DashboardWidget = { id: uid(), type, analysisId: type === "text" || type === "filter" ? undefined : analyses[0]?.id, w: type === "kpi" ? 3 : 6, h: type === "kpi" ? 2 : 4, x: 0, y: 0, title: type === "text" ? "Summary" : undefined, text: type === "text" ? "Summary text…" : undefined };
    setDef({ ...(def as DashboardDefinition), widgets: [...(def as DashboardDefinition).widgets, w] }); setDirty(true); setEditing(w.id); void ensure([w.analysisId]);
  };
  const items_ = isDash ? (def as DashboardDefinition | null)?.widgets ?? [] : (def as ReportDefinition | null)?.blocks ?? [];
  const setItems = (list: (ReportBlock | DashboardWidget)[]) => { setDef(isDash ? { ...(def as DashboardDefinition), widgets: list as DashboardWidget[] } : { ...(def as ReportDefinition), blocks: list as ReportBlock[] }); setDirty(true); };
  const onBlockAction = (id: string, action: "up" | "down" | "remove" | "edit") => {
    const i = items_.findIndex((b) => b.id === id); if (i < 0) return;
    if (action === "edit") return setEditing(id);
    if (action === "remove") return setItems(items_.filter((b) => b.id !== id));
    const j = action === "up" ? i - 1 : i + 1; if (j < 0 || j >= items_.length) return;
    const next = [...items_]; [next[i], next[j]] = [next[j], next[i]]; setItems(next);
  };
  // drag-and-drop ordering
  const dragId = React.useRef<string | null>(null);
  const onDrop = (targetId: string) => { const from = items_.findIndex((b) => b.id === dragId.current), to = items_.findIndex((b) => b.id === targetId); if (from < 0 || to < 0 || from === to) return; const next = [...items_]; const [m] = next.splice(from, 1); next.splice(to, 0, m); setItems(next); };

  if (!open) return (
    <div className="ax-panel" data-testid="ax-reports">
      <div className="row" style={{ marginBottom: 10 }}><h2 style={{ margin: 0 }}>Reports & dashboards</h2><span className="grow" /><button className="btn primary small" onClick={() => setCreating("report")} data-testid="ax-new-report">+ Report</button><button className="btn small" onClick={() => setCreating("dashboard")} data-testid="ax-new-dashboard">+ Dashboard</button></div>
      {creating && <div className="card row"><input className="input" autoFocus placeholder={`${creating === "report" ? "Report" : "Dashboard"} name`} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} data-testid="ax-report-name" /><button className="btn primary small" onClick={create} data-testid="ax-report-create">Create</button><button className="btn small" onClick={() => setCreating(null)}>Cancel</button></div>}
      {error && <div className="ax-error">{error}</div>}
      <div className="ax-cards">
        {items.map((r) => <div key={r.id} className="card selectable" onClick={() => openReport(r)} data-testid="ax-report-card"><div className="card-title">{r.kind === "dashboard" ? "▦" : "▤"} {r.name}</div><div className="muted" style={{ fontSize: 13 }}>{r.kind} · {r.mode} · {r.published_version ? `published v${r.published_version}` : "not published"} · updated {timeAgo(r.updated_at)}</div></div>)}
        {!items.length && <div className="muted">No reports yet. Create one, then add saved analyses as charts, tables and KPIs.</div>}
      </div>
    </div>
  );

  const rd = def as ReportDefinition, dd = def as DashboardDefinition;
  const publishedVersions = versions.map((v) => v.version as number);
  return (
    <div className="ax-panel ax-report-builder" data-testid="ax-report-builder">
      <div className="ax-rb-bar">
        <button className="btn small" onClick={() => { if (!dirty || confirm("Discard unsaved changes?")) { setOpen(null); setDef(null); } }}>← Reports</button>
        <input className="input" value={(rd?.title as string) ?? open.name} onChange={(e) => { setDef({ ...(def as ReportDefinition), title: e.target.value }); setDirty(true); }} style={{ maxWidth: 300, fontWeight: 600 }} />
        {!isDash && <input className="input" placeholder="Subtitle" value={rd?.subtitle ?? ""} onChange={(e) => { setDef({ ...rd, subtitle: e.target.value }); setDirty(true); }} style={{ maxWidth: 240 }} />}
        <select className="select small" value={open.theme_id ?? ""} onChange={async (e) => { const r = await api.update("reports", open.id, { themeId: e.target.value || null }); setOpen(r.item); onChange(); }} title="Report theme"><option value="">Default theme</option>{themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        {!isDash && <select className="select small" value={open.mode} onChange={async (e) => { const r = await api.update("reports", open.id, { mode: e.target.value }); setOpen(r.item); setDef({ ...rd, mode: e.target.value as "live" | "snapshot" }); onChange(); }} title="Live reports recompute on open; snapshot reports show the published version"><option value="live">Live report</option><option value="snapshot">Snapshot report</option></select>}
        <span className="grow" />
        {versions.length > 0 && <select className="select small" value={viewVersion ?? ""} onChange={(e) => { const v = e.target.value ? Number(e.target.value) : null; setViewVersion(v); if (v) void load(open, v); else { setShownVersion(null); setDef(open.definition as ReportDefinition); void load(open); } }} data-testid="ax-version-select"><option value="">Editing draft (live data)</option>{versions.map((v) => <option key={v.version} value={v.version}>Published v{v.version} · {new Date(v.published_at).toLocaleDateString()}</option>)}</select>}
        <button className="btn small" onClick={save} disabled={!dirty} data-testid="ax-report-save">{dirty ? "Save" : "Saved"}</button>
        <button className="btn primary small" onClick={publish} data-testid="ax-report-publish">Publish {open.published_version ? `v${open.published_version + 1}` : "v1"}</button>
        {!isDash && <button className="btn small" onClick={() => setTemplatesOpen((o) => !o)} data-testid="ax-templates">Templates</button>}
        <button className="btn small" onClick={() => setShare(true)} data-testid="ax-report-share">Share</button>
        <button className="btn small" onClick={() => setExp(true)} data-testid="ax-report-export">Export</button>
      </div>
      {(msg || error) && <div className={error ? "ax-error" : "ax-ok"} style={{ margin: "6px 0" }}>{error ?? msg}</div>}
      <div className="ax-rb-body">
        <aside className="ax-rb-side">
          <div className="flabel">Add {isDash ? "widget" : "block"}</div>
          <div className="ax-addlist">{isDash
            ? (["kpi", "chart", "table", "text", "filter"] as DashboardWidget["type"][]).map((t) => <button key={t} className="btn small" onClick={() => addWidget(t)} disabled={t !== "text" && t !== "filter" && !analyses.length}>{t}</button>)
            : (["cover", "executive_summary", "section", "chart", "table", "kpi", "insights", "text", "methodology", "page_break"] as ReportBlock["type"][]).map((t) => <button key={t} className="btn small" onClick={() => addBlock(t)} disabled={["chart", "table", "kpi", "insights", "executive_summary"].includes(t) && !analyses.length} data-testid={`ax-add-${t}`}>{t === "page_break" ? "page break" : t.replace("_", " ")}</button>)}</div>
          {!analyses.length && <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>Save an analysis first to add charts, tables and KPIs.</div>}
          <div className="flabel" style={{ marginTop: 12 }}>Order (drag to reorder)</div>
          <ol className="ax-order">{items_.map((b) => <li key={b.id} draggable onDragStart={() => { dragId.current = b.id; }} onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(b.id)} className={editing === b.id ? "on" : ""} onClick={() => setEditing(b.id)} data-testid="ax-order-item"><span className="ax-order-type">{b.type.replace("_", " ")}</span> {("title" in b && b.title) || ("analysisId" in b && b.analysisId ? analyses.find((a) => a.id === b.analysisId)?.name : "") || ""}</li>)}</ol>
          {!isDash && <>
            <div className="flabel" style={{ marginTop: 12 }}>Viewer segment switching</div>
            <div className="muted" style={{ fontSize: 12.5 }}>Segments a shared viewer may switch between (from analyses with segments). Empty = all available.</div>
            <div className="ax-chips">{[...new Set(Object.values(results).flatMap((r) => r.segments?.map((s) => s.name) ?? []))].map((s) => { const on = rd.viewerSegments?.includes(s); return <button key={s} type="button" className={`ax-chip ${on ? "on" : ""}`} onClick={() => { setDef({ ...rd, viewerSegments: on ? (rd.viewerSegments ?? []).filter((x) => x !== s) : [...(rd.viewerSegments ?? []), s] }); setDirty(true); }}>{s}</button>; })}</div>
            {/*
              * §36 — the filters a shared VIEWER may apply.
              *
              * Each one is computed when the report is published and frozen
              * beside the base numbers, so a client switching filter reads a
              * pre-computed answer rather than reaching the dataset. That is
              * why this is a list of allowed filters and not a filter builder
              * in the viewer — and why the count is worth knowing before
              * publishing, since each one is a full recompute.
              */}
            <div className="flabel" style={{ marginTop: 12 }}>Viewer filters</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Saved filters a shared viewer may apply. Each is computed at publish time and frozen, so the shared page
              never touches response data.
            </div>
            <div className="ax-chips" data-testid="ax-viewer-filters">
              {savedFilters.map((f) => {
                const on = rd.viewerFilters?.includes(f.id);
                return <button key={f.id} type="button" className={`ax-chip ${on ? "on" : ""}`} data-testid={`ax-vf-${f.id}`}
                  onClick={() => { setDef({ ...rd, viewerFilters: on ? (rd.viewerFilters ?? []).filter((x) => x !== f.id) : [...(rd.viewerFilters ?? []), f.id] }); setDirty(true); }}>
                  {f.name}
                </button>;
              })}
              {!savedFilters.length && <span className="muted" style={{ fontSize: 12.5 }}>No saved filters yet — save one under Filters.</span>}
            </div>
            {(rd.viewerFilters?.length ?? 0) > 0 && (
              <div className="muted" style={{ fontSize: 12 }}>
                Publishing will compute {rd.viewerFilters!.length + 1} sets of results (the whole sample, plus each filter).
              </div>
            )}

            {/*
              * §36 — one filter applied to EVERY analysis in this report:
              * "the North region report". Merged in at compute time, so the
              * same saved analyses serve the national report and the regional
              * one instead of being duplicated and drifting apart.
              */}
            <div className="flabel" style={{ marginTop: 12 }}>This whole report is filtered to</div>
            <select className="select small" value={rd.filterId ?? ""} data-testid="ax-report-filter"
              onChange={(e) => { setDef({ ...rd, filterId: e.target.value || null }); setDirty(true); void load(open!); }}>
              <option value="">The whole sample</option>
              {savedFilters.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>

            <div className="flabel" style={{ marginTop: 12 }}>Branding</div>
            <label className="ax-field"><span>Header</span><input className="input small" value={rd.branding?.header ?? ""} onChange={(e) => { setDef({ ...rd, branding: { ...rd.branding, header: e.target.value } }); setDirty(true); }} /></label>
            <label className="ax-field"><span>Footer</span><input className="input small" value={rd.branding?.footer ?? ""} onChange={(e) => { setDef({ ...rd, branding: { ...rd.branding, footer: e.target.value } }); setDirty(true); }} /></label>
            <label className="ax-toggle"><input type="checkbox" checked={rd.branding?.showLogo !== false} onChange={(e) => { setDef({ ...rd, branding: { ...rd.branding, showLogo: e.target.checked } }); setDirty(true); }} /> Show theme logo</label>
          </>}
          {isDash && <label className="ax-toggle" style={{ marginTop: 12 }}><input type="checkbox" checked={dd.crossFilter !== false} onChange={(e) => { setDef({ ...dd, crossFilter: e.target.checked }); setDirty(true); }} /> Cross-filter highlighting between charts</label>}
          {versions.length > 0 && <><div className="flabel" style={{ marginTop: 12 }}>Published versions</div><ul className="ax-versions">{versions.map((v) => <li key={v.version}>v{v.version} · {new Date(v.published_at).toLocaleString()}{v.note ? ` — ${v.note}` : ""}{v.dataset?.responses != null ? ` · ${v.dataset.responses} responses` : ""}</li>)}</ul></>}
        </aside>
        <div className="ax-rb-main">
          {loading && <div className="muted" style={{ padding: 8 }}>Computing…</div>}
          {def && <ReportView title={rd.title ?? open.name} subtitle={rd.subtitle} blocks={isDash ? undefined : rd.blocks} widgets={isDash ? dd.widgets : undefined} crossFilter={isDash ? dd.crossFilter !== false : false} results={results} theme={theme} mode={shownVersion ? "snapshot" : "live"} version={shownVersion} publishedAt={shownVersion ? versions.find((v) => v.version === shownVersion)?.published_at : undefined} branding={rd.branding} viewerSegments={rd.viewerSegments} onBlockAction={viewVersion ? undefined : onBlockAction} />}
        </div>
      </div>
      {editing && items_.find((b) => b.id === editing) && <BlockEditor block={items_.find((b) => b.id === editing)!} analyses={analyses} onChange={(nb) => { setItems(items_.map((b) => (b.id === nb.id ? nb : b))); void ensure([(nb as { analysisId?: string }).analysisId, ...(((nb as { analysisIds?: string[] }).analysisIds) ?? [])]); }} onClose={() => setEditing(null)} />}
      {templatesOpen && (
        <div className="modal-back" onClick={() => setTemplatesOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} data-testid="ax-template-dialog">
            <h3 style={{ marginTop: 0 }}>Report templates</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              The shape of a deliverable, without the study in it. Applying one keeps every block that already points at
              an analysis and leaves the rest as placeholders — so this is never the action that loses your work.
            </p>
            <div className="ax-cards">
              {templates.map((t) => (
                <div key={t.id} className="card" data-testid="ax-template-card">
                  <div className="card-title">{t.name}{t.builtIn ? <span className="chip" style={{ marginLeft: 6 }}>built in</span> : null}</div>
                  {t.description && <div className="muted" style={{ fontSize: 13 }}>{t.description}</div>}
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{describeTemplate(t)}</div>
                  <div className="row" style={{ gap: 4, marginTop: 8 }}>
                    <button className="btn small primary" data-testid={`ax-apply-${t.id}`} onClick={() => void applyTemplateTo(t.id!, t.name)}>Apply</button>
                    {!t.builtIn && (
                      <button className="btn small ghost danger"
                        onClick={async () => { if (!confirm(`Remove the template “${t.name}”?`)) return; try { await api.removeReportTemplate(t.id!); setTemplates(templates.filter((x) => x.id !== t.id)); } catch (e) { setError((e as Error).message); } }}>
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="row" style={{ marginTop: 12, gap: 6 }}>
              <button className="btn small" onClick={() => void saveAsTemplate()} data-testid="ax-save-template">Save this report&apos;s shape</button>
              <span className="grow" />
              <button className="btn small" onClick={() => setTemplatesOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {share && <ShareDialog api={api} report={open} onClose={() => setShare(false)} onCreated={onChange} />}
      {exp && <ExportDialog api={api} reportId={open.id} themes={themes} versions={publishedVersions} onClose={() => setExp(false)} />}
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>{surveyTitle}</div>
    </div>
  );
}
