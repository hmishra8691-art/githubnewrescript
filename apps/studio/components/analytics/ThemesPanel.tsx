"use client";
import React from "react";
import type { ReportTheme } from "@rescript/analytics";
import { DEFAULT_THEME } from "@rescript/analytics";
import { AxApi, type Row } from "./api";

/**
 * REPORT THEMES (§11, §27): company / client branding for charts, reports and
 * exports — deliberately separate from the survey's respondent-facing branding.
 */
export function ThemesPanel({ api, items, onChange }: { api: AxApi; items: Row[]; onChange: () => void }) {
  const [editing, setEditing] = React.useState<Row | null>(null);
  const [theme, setTheme] = React.useState<ReportTheme>(DEFAULT_THEME);
  const [scope, setScope] = React.useState<"workspace" | "survey">("workspace");
  const [error, setError] = React.useState<string | null>(null);
  const start = (t?: Row) => { setEditing(t ?? { id: null }); setTheme(t ? { ...DEFAULT_THEME, ...(t.theme as ReportTheme), colors: { ...DEFAULT_THEME.colors, ...(t.theme as ReportTheme).colors }, name: t.name } : { ...DEFAULT_THEME, name: "New theme" }); setScope(t?.survey_id ? "survey" : "workspace"); setError(null); };
  const set = (patch: Partial<ReportTheme>) => setTheme((t) => ({ ...t, ...patch }));
  const setColor = (k: keyof ReportTheme["colors"], v: string) => setTheme((t) => ({ ...t, colors: { ...t.colors, [k]: v } }));
  const save = async () => {
    if (!theme.name.trim()) return setError("Name the theme.");
    try { const body = { name: theme.name.trim(), theme, scope, isDefault: false }; if (editing?.id) await api.update("themes", editing.id, body); else await api.create("themes", body); setEditing(null); onChange(); } catch (e) { setError((e as Error).message); }
  };
  const onLogo = (f: File | null) => { if (!f) return set({ logoUrl: undefined }); if (f.size > 400_000) return setError("Logo must be under 400 KB."); const r = new FileReader(); r.onload = () => set({ logoUrl: String(r.result) }); r.readAsDataURL(f); };
  const C = ({ k, label }: { k: keyof ReportTheme["colors"]; label: string }) => <label className="ax-field"><span>{label}</span><span className="row" style={{ gap: 4 }}><input type="color" value={String(theme.colors[k])} onChange={(e) => setColor(k, e.target.value)} /><input className="input small" value={String(theme.colors[k])} onChange={(e) => setColor(k, e.target.value)} style={{ width: 90 }} /></span></label>;
  return (
    <div className="ax-panel" data-testid="ax-themes">
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Report themes</h2>
        <span className="muted" style={{ fontSize: 13 }}>Company or client branding for charts, reports, PowerPoint and Excel — independent of the survey's respondent-facing branding.</span>
        <span className="grow" />
        <button className="btn primary small" onClick={() => start()} data-testid="ax-new-theme">+ New theme</button>
      </div>
      {editing && (
        <div className="card" data-testid="ax-theme-editor">
          <div className="ax-theme-grid">
            <div>
              <label className="ax-field"><span>Theme name</span><input className="input" value={theme.name} onChange={(e) => set({ name: e.target.value })} data-testid="ax-theme-name" /></label>
              <label className="ax-field"><span>Scope</span><select className="select small" value={scope} onChange={(e) => setScope(e.target.value as "workspace" | "survey")}><option value="workspace">Whole workspace (all surveys)</option><option value="survey">This survey only</option></select></label>
              <div className="ax-cust-grid"><C k="primary" label="Primary" /><C k="secondary" label="Secondary" /><C k="accent" label="Accent" /><C k="background" label="Background" /><C k="text" label="Text" /><C k="subtle" label="Subtle text" /></div>
              <label className="ax-field"><span>Chart palette (comma-separated)</span><input className="input small" value={theme.colors.palette.join(", ")} onChange={(e) => setColor("palette", e.target.value.split(",").map((x) => x.trim()).filter(Boolean) as never)} /></label>
              <div className="ax-cust-grid">
                <label className="ax-field"><span>Font family</span><input className="input small" value={theme.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })} /></label>
                <label className="ax-field"><span>Heading font</span><input className="input small" value={theme.headingFontFamily ?? ""} onChange={(e) => set({ headingFontFamily: e.target.value || undefined })} placeholder="same as body" /></label>
                <label className="ax-field"><span>Base size</span><input className="input small" type="number" value={theme.typography?.baseSize ?? 12} onChange={(e) => set({ typography: { ...theme.typography, baseSize: Number(e.target.value) } })} /></label>
                <label className="ax-field"><span>Title size</span><input className="input small" type="number" value={theme.typography?.titleSize ?? 16} onChange={(e) => set({ typography: { ...theme.typography, titleSize: Number(e.target.value) } })} /></label>
                <label className="ax-field"><span>Header text</span><input className="input small" value={theme.header ?? ""} onChange={(e) => set({ header: e.target.value || undefined })} /></label>
                <label className="ax-field"><span>Footer text</span><input className="input small" value={theme.footer ?? ""} onChange={(e) => set({ footer: e.target.value || undefined })} placeholder="© Client · Confidential" /></label>
                <label className="ax-field"><span>Cover background</span><input className="input small" value={theme.cover?.background ?? ""} onChange={(e) => set({ cover: { ...theme.cover, background: e.target.value || undefined } })} placeholder="primary colour" /></label>
                <label className="ax-field"><span>Cover layout</span><select className="select small" value={theme.cover?.layout ?? "left"} onChange={(e) => set({ cover: { ...theme.cover, layout: e.target.value as "left" | "center" } })}><option value="left">Left</option><option value="center">Centered</option></select></label>
                <label className="ax-field"><span>Chart decimals</span><input className="input small" type="number" min={0} max={3} value={theme.chart?.decimals ?? 0} onChange={(e) => set({ chart: { ...theme.chart, decimals: Number(e.target.value) } })} /></label>
                <label className="ax-field"><span>Logo</span><input type="file" accept="image/*" onChange={(e) => onLogo(e.target.files?.[0] ?? null)} /></label>
              </div>
              <div className="ax-toggles"><label className="ax-toggle"><input type="checkbox" checked={theme.chart?.gridLines !== false} onChange={(e) => set({ chart: { ...theme.chart, gridLines: e.target.checked } })} /> Grid lines</label><label className="ax-toggle"><input type="checkbox" checked={theme.chart?.dataLabels !== false} onChange={(e) => set({ chart: { ...theme.chart, dataLabels: e.target.checked } })} /> Data labels</label></div>
              <label className="ax-field"><span>Brand guidelines / notes</span><textarea className="ta" rows={2} value={theme.guidelines ?? ""} onChange={(e) => set({ guidelines: e.target.value || undefined })} /></label>
            </div>
            <ThemePreview theme={theme} />
          </div>
          <div className="row" style={{ marginTop: 10 }}>{error && <span className="ax-error">{error}</span>}<span className="grow" /><button className="btn small" onClick={() => setEditing(null)}>Cancel</button><button className="btn primary small" onClick={save} data-testid="ax-theme-save">{editing.id ? "Save theme" : "Create theme"}</button></div>
        </div>
      )}
      <div className="ax-cards">
        <div className="card ax-theme-card"><ThemeSwatch theme={DEFAULT_THEME} /><div className="card-title">Rescript default</div><div className="muted" style={{ fontSize: 13 }}>Built-in theme used when none is chosen.</div></div>
        {items.map((t) => <div key={t.id} className="card ax-theme-card" data-testid="ax-theme-card"><ThemeSwatch theme={t.theme as ReportTheme} /><div className="card-title">{t.name}</div><div className="muted" style={{ fontSize: 13 }}>{t.survey_id ? "This survey" : "Workspace"} · {(t.theme as ReportTheme).fontFamily?.split(",")[0]}</div><div className="card-actions" style={{ marginTop: 8 }}><button className="btn small" onClick={() => start(t)}>Edit</button><button className="btn small danger" onClick={async () => { if (confirm(`Delete theme “${t.name}”?`)) { await api.remove("themes", t.id); onChange(); } }}>Delete</button></div></div>)}
      </div>
    </div>
  );
}

export function ThemeSwatch({ theme }: { theme: ReportTheme }) {
  const c = { ...DEFAULT_THEME.colors, ...(theme.colors ?? {}) };
  return <div className="ax-swatch">{[c.primary, c.secondary, c.accent, ...(c.palette ?? []).slice(0, 5)].map((x, i) => <span key={i} style={{ background: x }} />)}{theme.logoUrl && <img src={theme.logoUrl} alt="" style={{ height: 16, marginLeft: 6 }} />}</div>;
}

function ThemePreview({ theme }: { theme: ReportTheme }) {
  const c = theme.colors;
  return (
    <div className="ax-theme-preview" style={{ fontFamily: theme.fontFamily, color: c.text, background: c.background }}>
      <div style={{ background: theme.cover?.background ?? c.primary, color: theme.cover?.textColor ?? "#fff", padding: "18px 16px", borderRadius: 8, textAlign: theme.cover?.layout === "center" ? "center" : "left" }}>
        {theme.logoUrl && <img src={theme.logoUrl} alt="" style={{ height: 24, marginBottom: 8, display: "block", marginLeft: theme.cover?.layout === "center" ? "auto" : 0, marginRight: theme.cover?.layout === "center" ? "auto" : 0 }} />}
        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: theme.headingFontFamily ?? theme.fontFamily }}>Report title</div><div style={{ fontSize: 13, opacity: 0.85 }}>Cover slide preview</div>
      </div>
      <div style={{ marginTop: 10, fontWeight: 700, fontSize: theme.typography?.titleSize ?? 16 }}>Chart title<div style={{ width: 40, height: 3, background: c.primary, marginTop: 3 }} /></div>
      <svg viewBox="0 0 220 80" width="100%" style={{ marginTop: 6 }}>{[62, 48, 35, 22].map((h, i) => <rect key={i} x={10 + i * 52} y={72 - h} width={38} height={h} rx={2} fill={c.palette[i % c.palette.length]} />)}{[62, 48, 35, 22].map((h, i) => <text key={i} x={29 + i * 52} y={68 - h} textAnchor="middle" fontSize={9} fill={c.text}>{h}%</text>)}</svg>
      <div style={{ fontSize: 11.5, color: c.subtle }}>{theme.footer ?? "Footer text"} · n = 438</div>
    </div>
  );
}
