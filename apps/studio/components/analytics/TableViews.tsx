"use client";
import React from "react";
import type { RunResult } from "./api";
import { ProTable } from "./ProTable";

/**
 * TABLES, SEEN AND WORKED WITH (Analytics UX overhaul, 2026-11-07).
 *
 * Two experiences over the same ProTable, never one squeezed into the other:
 *
 *   TablePreview   a clean, sized preview for inspection — one scroll container at most (ProTable's own), the first
 *                  table of the result, a "Expand" affordance; it never collapses inside a nested scroller.
 *   TableDialog    the table opened large: every table of the result as tabs, the formatting controls (heat,
 *                  counts, dense, decimals), and the actions that change it — edit the configuration, open the full
 *                  builder, export — without leaving the page.
 */
export type TableFormat = { heat?: boolean; showCounts?: boolean; dense?: boolean; decimals?: number };

export function TablePreview(p: { result: RunResult; maxHeight?: number; onExpand?: () => void; dense?: boolean; testId?: string }) {
  const t = p.result.tables[0];
  if (!t) return <div className="muted ax-tv-empty">This analysis produced no table.</div>;
  return (
    <div className="ax-tv-preview" data-testid={p.testId ?? "ax-table-preview"}>
      <ProTable table={t} formatting={{ dense: p.dense ?? true, heat: p.result.kind === "crosstab" }} maxHeight={p.maxHeight ?? 320} testId={`${p.testId ?? "ax-table-preview"}-table`} />
      {(p.onExpand || p.result.tables.length > 1) && (
        <div className="ax-tv-foot">
          {p.result.tables.length > 1 && <span className="muted">{p.result.tables.length - 1} more table{p.result.tables.length === 2 ? "" : "s"}</span>}
          <span className="grow" />
          {p.onExpand && <button type="button" className="btn small" onClick={p.onExpand} data-testid="ax-table-expand">Expand table ⤢</button>}
        </div>
      )}
    </div>
  );
}

export function TableFormatBar({ f, onChange }: { f: TableFormat; onChange: (f: TableFormat) => void }) {
  return (
    <div className="ax-fmt ax-tv-fmt" role="group" aria-label="Table formatting">
      <label className="ax-toggle"><input type="checkbox" checked={!!f.heat} onChange={(e) => onChange({ ...f, heat: e.target.checked })} /> Heat</label>
      <label className="ax-toggle"><input type="checkbox" checked={!!f.showCounts} onChange={(e) => onChange({ ...f, showCounts: e.target.checked })} /> Counts</label>
      <label className="ax-toggle"><input type="checkbox" checked={!!f.dense} onChange={(e) => onChange({ ...f, dense: e.target.checked })} /> Dense</label>
      <label className="ax-toggle">Decimals <input className="input small" type="number" min={0} max={4} style={{ width: 52 }} value={f.decimals ?? ""} placeholder="1" onChange={(e) => onChange({ ...f, decimals: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
    </div>
  );
}

export function TableDialog(p: { title: string; result: RunResult; onClose: () => void; actions?: React.ReactNode; initialTable?: string }) {
  const r = p.result;
  const [tableId, setTableId] = React.useState(p.initialTable ?? r.tables[0]?.id ?? "");
  const [f, setF] = React.useState<TableFormat>({ heat: r.kind === "crosstab" });
  const t = r.tables.find((x) => x.id === tableId) ?? r.tables[0];
  /* the table is the one scroller in the dialog: it gets the height the dialog leaves it */
  const [h, setH] = React.useState(560);
  React.useEffect(() => { const fit = () => setH(Math.max(260, window.innerHeight - 230)); fit(); window.addEventListener("resize", fit); return () => window.removeEventListener("resize", fit); }, []);
  React.useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") p.onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [p]);
  return (
    <div className="modal-back" onClick={p.onClose}>
      <div className="ax-tv-dialog" role="dialog" aria-modal="true" aria-label={p.title} onClick={(e) => e.stopPropagation()} data-testid="ax-table-dialog">
        <header className="ax-tv-dhead">
          <h2>{p.title}</h2>
          <span className="grow" />
          {p.actions}
          <button type="button" className="btn small" onClick={p.onClose} aria-label="Close" data-testid="ax-table-dialog-close">Close ✕</button>
        </header>
        <div className="ax-tv-dtools">
          {r.tables.length > 1 && (
            <div className="ax-tv-tabs" role="tablist" aria-label="Tables">
              {r.tables.map((x) => <button key={x.id} type="button" role="tab" aria-selected={x.id === t?.id} className={`ax-tv-tab ${x.id === t?.id ? "on" : ""}`} onClick={() => setTableId(x.id)}>{x.title}</button>)}
            </div>
          )}
          <TableFormatBar f={f} onChange={setF} />
          <span className="muted" style={{ fontSize: 12.5 }}>n = {r.base.n.toLocaleString("en-US")}</span>
        </div>
        <div className="ax-tv-dbody">
          {t ? <ProTable table={t} formatting={f} maxHeight={h} testId="ax-table-dialog-table" /> : <div className="muted">This analysis produced no table.</div>}
          {r.warnings.length > 0 && <ul className="ax-tv-warn">{r.warnings.slice(0, 4).map((w, i) => <li key={i}>{w}</li>)}</ul>}
        </div>
      </div>
    </div>
  );
}
