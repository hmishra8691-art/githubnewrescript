"use client";
import React from "react";
import type { ThemeSpec } from "@rescript/analytics";
import { Icon } from "../../ui/Icon";
import type { CopilotEntry } from "./useCopilot";

/**
 * THE COPILOT'S DOCUMENT AND THEME CARDS (2026-10-18).
 *
 *   DocumentOutput   a produced (or kept, after a reload) document: Download takes the stored file —
 *                    never a regeneration; "a new version is available" + Regenerate when what it is made
 *                    from changed; a clear message when the stored file is missing or damaged.
 *   ThemeTurnCard    a report theme read from words: the preview (colours by role, fonts, tables, the
 *                    chart palette), what was understood and adjusted, then Apply / Save as.
 *   ThemeSwatches    the preview itself, shared with the Research tab's theme panel.
 */
export interface DocumentActions {
  download(entryId: string): Promise<{ ok: boolean; error?: string }>;
  regenerate(entryId: string): Promise<void>;
  theme(entryId: string, action: { kind: "apply" } | { kind: "save"; name: string; scope: "user" | "org" } | { kind: "model" }): Promise<void>;
  /** run a qualitative request's previewed action (F2 2026-10-22) */
  qual?(entryId: string): Promise<void>;
}

export function DocumentOutput({ entry, actions }: { entry: CopilotEntry; actions?: DocumentActions }) {
  const o = entry.output!;
  const [busy, setBusy] = React.useState<"download" | "regenerate" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const download = async () => {
    if (!actions) return;
    setBusy("download"); setError(null);
    const r = await actions.download(entry.id);
    if (!r.ok) setError(r.error ?? "The document could not be downloaded.");
    setBusy(null);
  };
  return (
    <div className="cp-data cp-output" data-testid="cp-output" data-kind={o.kind} data-size={o.size} data-artifact={o.artifactId ?? ""} data-version={o.version ?? ""} data-reused={o.reused ? "1" : "0"} data-restored={o.restored ? "1" : "0"} data-stale={o.stale ? "1" : "0"}>
      <Icon name="download" size={12} />{" "}
      {o.url && !o.restored
        /* the bytes this page holds: a plain link, as before (the browser suites click it) */
        ? <a className="iq-btn primary" href={o.url} download={o.name} data-testid="cp-output-download">Download {o.name}</a>
        : <button type="button" className="iq-btn primary" onClick={() => void download()} disabled={busy !== null || !actions} data-testid="cp-output-download" title="The stored file — nothing is regenerated">{busy === "download" ? "Preparing…" : `Download ${o.name}`}</button>}
      <span className="iqi-dim">{Math.round(o.size / 1024)} KB{o.version ? ` · version ${o.version}` : ""}{o.reused ? " · kept from earlier, not regenerated" : ""}{o.theme ? ` · ${o.theme} theme` : ""} · {o.summary}</span>
      {o.narrative ? <span className="iqi-dim" data-testid="cp-output-narrative"> · Narrative gate: {o.narrative}</span> : null}
      {o.stale && (
        <span className="iq-warning" data-testid="cp-output-stale"> · A new version is available — the design, the data or the theme changed since this one was made.{" "}
          <button type="button" className="iq-btn" onClick={async () => { if (!actions) return; setBusy("regenerate"); await actions.regenerate(entry.id); setBusy(null); }} disabled={busy !== null || !actions} data-testid="cp-output-regenerate">{busy === "regenerate" ? "Making it…" : "Make the new version"}</button>
        </span>
      )}
      {(error ?? o.note) ? <span className="iq-warning" data-testid="cp-output-note"> · {error ?? o.note}</span> : null}
    </div>
  );
}

const SW = ({ c, label }: { c: string; label: string }) => (
  <span className="rt-sw" title={`${label} ${c}`} data-role={label} data-color={c} style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 8, fontSize: 11.5 }}>
    <span style={{ width: 14, height: 14, borderRadius: 3, background: c, border: "1px solid rgba(0,0,0,.15)", display: "inline-block" }} />{label}
  </span>
);

export function ThemeSwatches({ theme }: { theme: ThemeSpec }) {
  const c = theme.colors;
  return (
    <div className="rt-preview" data-testid="theme-preview" data-name={theme.name} data-heading={c.heading} data-accent={c.accent} data-font={theme.typography.heading} style={{ border: `1px solid ${c.border}`, borderRadius: 6, padding: 10, margin: "6px 0", background: c.background, color: c.text }}>
      <div style={{ fontFamily: theme.typography.heading, color: c.heading, fontWeight: theme.typography.headingWeight === "bold" ? 700 : 400, fontSize: 15, textTransform: theme.typography.headingCase === "upper" ? "uppercase" : "none", borderBottom: theme.layout.titleRule ? `2px solid ${c.accent}` : "none", paddingBottom: 2 }}>{theme.name}</div>
      <div style={{ fontFamily: theme.typography.body, fontSize: 12.5, margin: "4px 0" }}>Body text in {theme.typography.body} · <span style={{ color: c.accent, fontWeight: 600 }}>accent</span> · <span style={{ color: c.muted, fontStyle: theme.annotations.emphasis === "clear" ? "normal" : "italic" }}>t = 2.41, p = .016, n = 412</span></div>
      <table style={{ borderCollapse: "collapse", fontSize: 11.5, fontFamily: theme.typography.body, margin: "4px 0" }}>
        <thead><tr>{["Group", "Mean", "n"].map((h) => <th key={h} style={{ background: theme.table.style === "minimal" ? "transparent" : c.tableHeaderBg, color: c.tableHeaderText, padding: "2px 8px", borderTop: theme.table.style === "minimal" ? `2px solid ${c.text}` : undefined, borderBottom: `1px solid ${c.border}` }}>{h}</th>)}</tr></thead>
        <tbody>{[["Women", "4.1", "208"], ["Men", "3.7", "204"]].map((r, i) => <tr key={i} style={{ background: theme.table.style === "striped" && i % 2 === 1 ? c.tableStripe : "transparent" }}>{r.map((v, j) => <td key={j} style={{ padding: "2px 8px", border: theme.table.style === "grid" ? `1px solid ${c.border}` : undefined }}>{v}</td>)}</tr>)}</tbody>
      </table>
      <div style={{ marginTop: 4 }}>
        <SW c={c.heading} label="headings" /><SW c={c.primary} label="primary" /><SW c={c.accent} label="accent" /><SW c={c.background} label="background" /><SW c={c.tableHeaderBg} label="table header" />
        <span style={{ fontSize: 11.5, marginLeft: 4 }}>chart: {theme.chartPalette.slice(0, 6).map((p) => <span key={p} data-chart={p} style={{ display: "inline-block", width: 12, height: 12, background: p, marginRight: 2, borderRadius: 2 }} />)}</span>
      </div>
      <div className="iqi-dim" style={{ fontSize: 11.5, marginTop: 4 }}>{theme.table.style} tables · {theme.layout.density} spacing{theme.branding.logo.placement !== "none" ? ` · logo in the ${theme.branding.logo.placement}` : ""}{theme.branding.footer ? ` · footer “${theme.branding.footer}”` : ""}</div>
    </div>
  );
}

export function ThemeTurnCard({ entry, actions }: { entry: CopilotEntry; actions?: DocumentActions }) {
  const t = entry.theme!;
  const r = t.reading;
  const [name, setName] = React.useState(r?.saveAs ?? r?.proposedName ?? r?.preview?.name ?? "");
  const [scope, setScope] = React.useState<"user" | "org">("user");
  const [busy, setBusy] = React.useState(false);
  const act = async (a: Parameters<DocumentActions["theme"]>[1]) => { if (!actions) return; setBusy(true); await actions.theme(entry.id, a); setBusy(false); };
  return (
    <div className="cp-data cp-theme" data-testid="cp-theme" data-status={t.status} data-intent={r?.intent ?? t.op}>
      {t.themes && <ul className="iqi-dim" data-testid="cp-theme-list" style={{ margin: "4px 0 0 16px" }}>{t.themes.map((x) => <li key={`${x.kind}:${x.name}`}><b>{x.name}</b> · {x.kind}{x.version && x.kind !== "built-in" ? ` v${x.version}` : ""}{x.description ? ` — ${x.description}` : ""}</li>)}</ul>}
      {r?.preview && <ThemeSwatches theme={r.preview} />}
      {r?.structure && <p className="iqi-dim" data-testid="cp-theme-structure">Section order: {r.structure.order.join(" → ")}, then the rest as they were.</p>}
      {r && r.understood.length > 0 && <p className="iqi-dim" data-testid="cp-theme-understood">Understood: {r.understood.join(" · ")}</p>}
      {r && r.adjustments.length > 0 && <p className="iqi-dim" data-testid="cp-theme-adjusted">Adjusted for legibility: {r.adjustments.map((a) => `${a.token} ${a.from} → ${a.to}`).join(" · ")}</p>}
      {t.error && <p className="iq-warning" data-testid="cp-theme-error">{t.error}</p>}
      {r?.needsModel && t.status !== "applied" && <button type="button" className="iq-btn" disabled={busy} onClick={() => void act({ kind: "model" })} data-testid="cp-theme-model" title="Only the words of the request (the look, never the data) are sent">Let the AI read the look</button>}
      {(t.status === "preview" || t.status === "applied" || t.status === "saved") && r && (r.preview || r.structure) && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
          {t.status === "preview" && r.intent !== "save_as" && <button type="button" className="iq-btn primary" disabled={busy || t.canApply === false} onClick={() => void act({ kind: "apply" })} data-testid="cp-theme-apply" title={t.canApply === false ? "Applying a theme needs Data Analytics & Reports: Edit" : "Use this look for the project's documents — their content does not change"}>{r.intent === "structure" ? "Apply this order" : "Apply theme"}</button>}
          {t.status === "applied" && <span className="iq-label" data-testid="cp-theme-applied"><Icon name="check" size={11} /> Applied{t.appliedName ? `: ${t.appliedName}` : ""}</span>}
          {t.status === "saved" && t.savedAs && <span className="iq-label" data-testid="cp-theme-saved"><Icon name="check" size={11} /> Saved “{t.savedAs.name}” v{t.savedAs.version}</span>}
          {r.preview && t.status !== "saved" && <>
            <input className="input" style={{ width: 170 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Theme name" data-testid="cp-theme-name" aria-label="Theme name" />
            <select className="select" style={{ width: 150 }} value={scope} onChange={(e) => setScope(e.target.value as "user" | "org")} data-testid="cp-theme-scope" aria-label="Save for">
              <option value="user">Just for me</option>
              <option value="org" disabled={!t.canSaveOrg}>My organisation</option>
            </select>
            <button type="button" className="iq-btn" disabled={busy || !name.trim()} onClick={() => void act({ kind: "save", name: name.trim(), scope })} data-testid="cp-theme-save">Save as theme</button>
          </>}
        </div>
      )}
    </div>
  );
}
