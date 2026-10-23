"use client";
import React from "react";
import "./reportLayout.css";
import {
  DOCUMENT_SECTIONS, DOCUMENT_FAMILIES, enforceTheme, themeContrastReport,
  type DocumentFamily, type StructureRequest, type ThemeSpec,
} from "@rescript/analytics";

/**
 * REPORT LAYOUT (2026-10-22, engine item #18): the order of a document family's sections, set by drag and
 * drop or the keyboard, stored with the project's report selection (`report_theme_selections.structure`,
 * the sandbox's tab store) and applied identically in every export of the family — the findings Word
 * report and the findings deck share one order; the qualitative report and deck another. Plus a LIVE
 * theme preview: switching or editing a theme redraws an in-page mock document at once (no file is
 * made), with the contrast rules checked as you type.
 */

export const FAMILY_LABEL: Record<DocumentFamily, string> = {
  findings: "Findings report + findings deck",
  research_plan: "Research plan (Word)",
  proposal: "Research proposal (Word)",
  sap: "Statistical analysis plan (Word)",
  qual: "Qualitative report + qualitative deck",
};

/** the family's sections in the stored order (unknown ids dropped, sections not named after, in their own order) */
export function orderedCatalog(family: DocumentFamily, order: readonly string[] | null | undefined) {
  const all = DOCUMENT_SECTIONS[family];
  if (!order?.length) return [...all];
  const named = order.map((id) => all.find((s) => s.id === id)).filter((s): s is (typeof all)[number] => !!s);
  return [...named, ...all.filter((s) => !order.includes(s.id))];
}

/**
 * A reorderable list: drag a row by its handle, or focus a row and press Alt+↑ / Alt+↓ (or use its ↑ ↓
 * buttons). Every move is announced (aria-live), and focus stays on the moved row.
 */
export function SortableList<T extends { id: string; title: string; when?: string }>({ items, onMove, testId, label }: {
  items: readonly T[]; onMove(from: number, to: number): void; testId: string; label: string;
}) {
  const [drag, setDrag] = React.useState<number | null>(null);
  const [over, setOver] = React.useState<number | null>(null);
  const [said, setSaid] = React.useState("");
  const refs = React.useRef<(HTMLLIElement | null)[]>([]);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    onMove(from, to);
    setSaid(`${items[from].title} moved to position ${to + 1} of ${items.length}.`);
    requestAnimationFrame(() => refs.current[to]?.focus());
  };
  return (
    <div>
      <ol className="rl-list" data-testid={testId} aria-label={label} role="listbox">
        {items.map((it, i) => (
          <li key={it.id} ref={(el) => { refs.current[i] = el; }} className={`rl-item${drag === i ? " dragging" : ""}${over === i && drag !== null && drag !== i ? " over" : ""}`}
            role="option" aria-selected={false} tabIndex={0} draggable data-testid={`${testId}-item`} data-id={it.id} aria-describedby={`${testId}-help`}
            onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", it.id); } catch { /* fine */ } }}
            onDragOver={(e) => { e.preventDefault(); setOver(i); }}
            onDragLeave={() => setOver((o) => (o === i ? null : o))}
            onDrop={(e) => { e.preventDefault(); if (drag !== null) move(drag, i); setDrag(null); setOver(null); }}
            onDragEnd={() => { setDrag(null); setOver(null); }}
            onKeyDown={(e) => {
              if (!e.altKey && !e.metaKey) return;
              if (e.key === "ArrowUp") { e.preventDefault(); move(i, i - 1); }
              if (e.key === "ArrowDown") { e.preventDefault(); move(i, i + 1); }
              if (e.key === "Home") { e.preventDefault(); move(i, 0); }
              if (e.key === "End") { e.preventDefault(); move(i, items.length - 1); }
            }}>
            <span className="rl-handle" aria-hidden="true">⋮⋮</span>
            <span className="rl-n">{i + 1}.</span>
            <span className="rl-title">{it.title}</span>
            {it.when && <span className="muted rl-when">only when {it.when}</span>}
            <span className="rl-btns">
              <button type="button" className="btn small" aria-label={`Move ${it.title} up`} disabled={i === 0} onClick={() => move(i, i - 1)} data-testid={`${testId}-up`}>↑</button>
              <button type="button" className="btn small" aria-label={`Move ${it.title} down`} disabled={i === items.length - 1} onClick={() => move(i, i + 1)} data-testid={`${testId}-down`}>↓</button>
            </span>
          </li>
        ))}
      </ol>
      <p id={`${testId}-help`} className="muted" style={{ fontSize: 12 }}>Drag a section, or focus it and press Alt + ↑ / ↓ (Home / End to the top / bottom).</p>
      <p className="sr-only" aria-live="polite" data-testid={`${testId}-said`}>{said}</p>
    </div>
  );
}

/** the section-order editor for one project (saved: the report-themes route; sandbox: the tab's store) */
export function SectionOrderEditor({ structure, onSave, busy, family, setFamily }: {
  structure: StructureRequest | null; onSave(next: StructureRequest): void | Promise<void>; busy?: boolean;
  family: DocumentFamily; setFamily(f: DocumentFamily): void;
}) {
  const [items, setItems] = React.useState(() => orderedCatalog(family, structure?.sections?.[family]));
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => { setItems(orderedCatalog(family, structure?.sections?.[family])); setDirty(false); }, [family, structure]);
  const onMove = (from: number, to: number) => { setItems((cur) => { const next = [...cur]; const [x] = next.splice(from, 1); next.splice(to, 0, x); return next; }); setDirty(true); };
  const save = () => onSave({
    order: structure?.order ?? [], understood: structure?.understood ?? "section order set in the Research tab",
    sections: { ...(structure?.sections ?? {}), [family]: items.map((s) => s.id) },
  });
  const reset = () => {
    const sections = { ...(structure?.sections ?? {}) };
    delete sections[family];
    void onSave({ order: structure?.order ?? [], understood: structure?.understood ?? "section order set in the Research tab", sections });
  };
  return (
    <div className="rl-sections" data-testid="section-order" data-family={family}>
      <div className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 12.5 }}>Section order for</span>
        <select className="select" style={{ width: 280 }} value={family} onChange={(e) => setFamily(e.target.value as DocumentFamily)} data-testid="section-order-family" aria-label="Which documents">
          {DOCUMENT_FAMILIES.map((f) => <option key={f} value={f}>{FAMILY_LABEL[f]}</option>)}
        </select>
        <button type="button" className="btn small primary" disabled={busy || !dirty} onClick={() => void save()} data-testid="section-order-save">Save this order</button>
        {structure?.sections?.[family] && <button type="button" className="btn small" disabled={busy} onClick={reset} data-testid="section-order-reset">Back to the standard order</button>}
        {structure?.sections?.[family] && !dirty && <span className="badge success" data-testid="section-order-saved">Custom order in use</span>}
      </div>
      <SortableList items={items} onMove={onMove} testId="section-order-list" label={`Sections of the ${FAMILY_LABEL[family]}`} />
      <p className="muted" style={{ fontSize: 12 }}>Every export of these documents uses this order — Word and PowerPoint alike; the content of each section does not change. Kept documents say “a new version is available”.</p>
    </div>
  );
}

const THEME_FIELDS: { key: keyof ThemeSpec["colors"]; label: string }[] = [
  { key: "heading", label: "Headings" }, { key: "text", label: "Body text" }, { key: "accent", label: "Accent" },
  { key: "primary", label: "Primary" }, { key: "background", label: "Page" }, { key: "tableHeaderBg", label: "Table header" }, { key: "tableHeaderText", label: "Table header text" },
];
const FONTS = ["Calibri", "Arial", "Georgia", "Cambria", "Garamond", "Verdana", "Segoe UI", "Times New Roman", "Aptos"];

/**
 * THE LIVE PREVIEW: a mock page drawn from the theme as it is being edited — cover band, headings in the
 * section order, body, an annotation, a table in the theme's style, a bar chart in its palette. Nothing is
 * generated; every edit redraws it, and the contrast check runs on every keystroke.
 */
export function LiveThemePreview({ theme, onChange, sections, testId = "theme-live" }: {
  theme: ThemeSpec; onChange(next: ThemeSpec): void; sections?: string[]; testId?: string;
}) {
  const report = themeContrastReport(theme);
  const enforced = React.useMemo(() => enforceTheme(theme), [theme]);
  const c = theme.colors;
  const set = (k: keyof ThemeSpec["colors"], v: string) => onChange({ ...theme, colors: { ...theme.colors, [k]: v } });
  const bad = report.filter((r) => !r.ok);
  return (
    <div className="rl-live" data-testid={testId}>
      <div className="rl-live-controls" role="group" aria-label="Edit the theme">
        {THEME_FIELDS.map((f) => (
          <label key={f.key} className="rl-swatch">
            <input type="color" value={/^#[0-9a-f]{6}$/i.test(c[f.key]) ? c[f.key] : "#000000"} onChange={(e) => set(f.key, e.target.value.toUpperCase())} data-testid={`${testId}-color-${f.key}`} aria-label={`${f.label} colour`} />
            <span>{f.label}</span>
          </label>
        ))}
        <label className="rl-swatch">Headings
          <select className="select small" value={theme.typography.heading} onChange={(e) => onChange({ ...theme, typography: { ...theme.typography, heading: e.target.value } })} data-testid={`${testId}-heading-font`}>
            {[...new Set([theme.typography.heading, ...FONTS])].map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label className="rl-swatch">Body
          <select className="select small" value={theme.typography.body} onChange={(e) => onChange({ ...theme, typography: { ...theme.typography, body: e.target.value } })} data-testid={`${testId}-body-font`}>
            {[...new Set([theme.typography.body, ...FONTS])].map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label className="rl-swatch">Tables
          <select className="select small" value={theme.table.style} onChange={(e) => onChange({ ...theme, table: { ...theme.table, style: e.target.value as ThemeSpec["table"]["style"] } })} data-testid={`${testId}-table`}>
            <option value="grid">grid</option><option value="minimal">minimal</option><option value="striped">striped</option>
          </select>
        </label>
      </div>
      <div className="rl-contrast" data-testid={`${testId}-contrast`} data-problems={bad.length} aria-live="polite">
        {bad.length === 0
          ? <span className="badge success" data-testid={`${testId}-contrast-ok`}>Contrast OK: every text and accent meets its minimum</span>
          : bad.map((r) => <div key={r.token} className="rl-warn" data-testid={`${testId}-contrast-warning`} data-token={r.token}>⚠ {r.why}: {r.ratio.toFixed(2)}:1, needs {r.min}:1 — it will be darkened to {enforced.theme.colors[r.token as keyof ThemeSpec["colors"]]} in the documents</div>)}
      </div>
      <div className="rl-page" data-testid={`${testId}-page`} data-heading={c.heading} data-accent={c.accent} data-background={c.background} data-text={c.text} data-heading-font={theme.typography.heading} data-table={theme.table.style}
        style={{ background: c.background, color: c.text, fontFamily: theme.typography.body, borderColor: c.border }}>
        <div className="rl-cover" style={{ background: c.primary, color: "#fff", fontFamily: theme.typography.heading }}>{theme.name || "Report"}</div>
        {(sections?.length ? sections.slice(0, 4) : ["Executive summary", "Key findings"]).map((h, i) => (
          <div key={`${h}-${i}`} className="rl-sec" data-testid={`${testId}-section`}>
            <div className="rl-h1" style={{ color: c.heading, fontFamily: theme.typography.heading, fontWeight: theme.typography.headingWeight === "bold" ? 700 : 400, textTransform: theme.typography.headingCase === "upper" ? "uppercase" : "none", borderBottom: theme.layout.titleRule ? `2px solid ${c.accent}` : "none" }}>{i + 1}. {h}</div>
            {i === 0 && <p style={{ margin: "4px 0" }}>Satisfaction is higher among recent customers. <span style={{ color: c.accent, fontWeight: 600 }}>Key point</span> · <span style={{ color: c.muted, fontStyle: theme.annotations.emphasis === "clear" ? "normal" : "italic" }}>t = 2.41, p = .016, n = 412</span></p>}
          </div>
        ))}
        <table className="rl-table">
          <thead><tr>{["Group", "Mean", "n"].map((h) => <th key={h} style={{ background: theme.table.style === "minimal" ? "transparent" : c.tableHeaderBg, color: c.tableHeaderText, borderTop: theme.table.style === "minimal" ? `2px solid ${c.text}` : undefined, borderBottom: `1px solid ${c.border}` }}>{h}</th>)}</tr></thead>
          <tbody>{[["Women", "4.1", "208"], ["Men", "3.7", "204"], ["Other", "3.9", "31"]].map((r, i) => <tr key={i} style={{ background: theme.table.style === "striped" && i % 2 === 1 ? c.tableStripe : "transparent" }}>{r.map((v, j) => <td key={j} style={{ border: theme.table.style === "grid" ? `1px solid ${c.border}` : undefined }}>{v}</td>)}</tr>)}</tbody>
        </table>
        <div className="rl-chart" aria-hidden="true">{theme.chartPalette.slice(0, 6).map((p, i) => <span key={p + i} style={{ background: p, height: `${30 + ((i * 37) % 50)}%` }} />)}</div>
        {theme.branding.footer && <div className="rl-foot" style={{ color: c.muted }}>{theme.branding.footer}</div>}
      </div>
    </div>
  );
}
