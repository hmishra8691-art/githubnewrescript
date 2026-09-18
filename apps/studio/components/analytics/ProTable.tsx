"use client";
import React from "react";
import type { AnalysisResult, ResultColumn } from "@rescript/analytics";

/**
 * THE RESULTS TABLE a research studio expects to read: sticky header and
 * stub, header groups for a banner, expandable nested groups, one-click
 * column sort, counts under percentages, heat shading, highlighted
 * significance, suppressed columns greyed — and windowed rows once a table
 * is long enough to matter, so a 2 000-row stack scrolls like a short one.
 *
 * It reads the crosstab's row markers (`__kind`, `__level`, `__group`,
 * `<key>__sig`, `<key>__vs`, `<key>__n`) but needs none of them: any
 * ResultTable renders, which is what lets every analysis kind share it.
 */

export interface TableFormatting {
  /** shade percentage cells by value */
  heat?: boolean;
  /** tint cells that carry a significance mark */
  highlightSig?: boolean;
  /** print the unweighted count under each percentage */
  showCounts?: boolean;
  /** override the column decimals */
  decimals?: number;
  /** compact rows */
  dense?: boolean;
}

type Table = AnalysisResult["tables"][number];
type Row = Record<string, unknown>;

const ROW_H = 34, ROW_H_DENSE = 27, WINDOW_AT = 150, OVERSCAN = 12;

function fmtCell(v: unknown, type: string | undefined, decimals: number): string {
  if (v == null) return "";
  if (typeof v !== "number") return String(v);
  if (!Number.isFinite(v)) return "—";
  if (type === "pct") return `${v.toFixed(decimals)}%`;
  if (type === "count") return Math.round(v).toLocaleString("en-US");
  if (type === "sig") return String(v);
  return v.toLocaleString("en-US", { maximumFractionDigits: Math.max(decimals, type === "number" ? 2 : decimals), minimumFractionDigits: 0 });
}

/** the heat colour of a percentage: white at 0, the primary tint at the table's maximum */
function heatStyle(v: unknown, max: number): React.CSSProperties | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || max <= 0) return undefined;
  const t = Math.max(0, Math.min(1, v / max));
  return { background: `rgba(79, 70, 229, ${(0.04 + t * 0.32).toFixed(3)})`, color: t > 0.7 ? "#1e1b4b" : undefined };
}

export function ProTable({ table, formatting, testId = "ax-table", maxHeight }: { table?: Table; formatting?: TableFormatting; testId?: string; maxHeight?: number }) {
  const f = formatting ?? {};
  const [sort, setSort] = React.useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = React.useState(0);
  const [q, setQ] = React.useState("");
  const [widths, setWidths] = React.useState<Record<string, number>>({});
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  /* drag a header's right edge to resize the column (pointer events, no library) */
  const startResize = (key: string, e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault(); e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    const startX = e.clientX, startW = th.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => setWidths((w) => ({ ...w, [key]: Math.max(56, startW + ev.clientX - startX) }));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  if (!table) return <div className="muted">No table.</div>;

  const cols = table.columns;
  const stub = cols[0];
  const dataCols = cols.slice(1);
  const hasGroups = dataCols.some((c) => c.group);
  const groups: { label: string; span: number }[] = [];
  if (hasGroups) for (const c of dataCols) { const g = groups[groups.length - 1]; if (g && g.label === (c.group ?? "")) g.span++; else groups.push({ label: c.group ?? "", span: 1 }); }
  const decimalsOf = (c: ResultColumn, row: Row) => f.decimals ?? c.decimals ?? ((row.__format as string) === "count" ? 0 : 1);
  const typeOf = (c: ResultColumn, row: Row) => (row.__format as string | undefined) ?? c.type;

  /* rows: the crosstab's kinds decide what sorts and what collapses */
  const kinds = new Set(table.rows.map((r) => r.__kind as string | undefined));
  const structured = kinds.has("category") || kinds.has("group") || kinds.has("section");
  let rows: Row[] = table.rows;
  if (sort) {
    const dir = sort.dir === "asc" ? 1 : -1;
    const cmp = (a: Row, b: Row) => { const x = a[sort.key], y = b[sort.key]; if (typeof x === "number" && typeof y === "number") return (x - y) * dir; return String(x ?? "").localeCompare(String(y ?? "")) * dir; };
    if (structured) {
      // sort category rows inside their own group / level; everything else keeps its place
      const out: Row[] = []; let run: Row[] = [];
      const flush = () => { if (run.length) { out.push(...run.sort(cmp)); run = []; } };
      for (const r of table.rows) { if (r.__kind === "category") run.push(r); else { flush(); out.push(r); } }
      flush(); rows = out;
    } else rows = [...table.rows].sort(cmp);
  }
  if (collapsed.size) rows = rows.filter((r) => !(r.__group && collapsed.has(String(r.__group))));
  // search keeps the rows whose label matches, plus the structural rows that frame them
  if (q.trim()) { const needle = q.trim().toLowerCase(); rows = rows.filter((r) => { const k = r.__kind as string | undefined; if (k && k !== "category" && k !== "summary" && k !== "noanswer" && k !== "total") return true; return String(r[stub.key] ?? "").toLowerCase().includes(needle); }); }

  /* heat: the maximum of the percentage cells among category rows */
  let heatMax = 0;
  if (f.heat) for (const r of table.rows) { if (r.__kind && r.__kind !== "category" && r.__kind !== "summary") continue; for (const c of dataCols) { const v = r[c.key]; if (typeof v === "number" && typeOf(c, r) === "pct" && v > heatMax) heatMax = v; } }

  /* windowing */
  const rowH = f.dense ? ROW_H_DENSE : ROW_H;
  const windowed = rows.length > WINDOW_AT;
  const viewH = maxHeight ?? 560;
  const first = windowed ? Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN) : 0;
  const last = windowed ? Math.min(rows.length, Math.ceil((scrollTop + viewH) / rowH) + OVERSCAN) : rows.length;
  const visible = rows.slice(first, last);
  const padTop = first * rowH, padBottom = (rows.length - last) * rowH;

  const toggleSort = (key: string) => setSort((s) => (s?.key !== key ? { key, dir: "desc" } : s.dir === "desc" ? { key, dir: "asc" } : null));
  const toggleGroup = (key: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const hasCounts = f.showCounts && table.rows.some((r) => dataCols.some((c) => typeof r[`${c.key}__n`] === "number"));

  return (
    <div className={`ax-pro ${f.dense ? "dense" : ""}`} data-testid={`${testId}-wrap`}>
      {table.rows.length > 12 && (
        <div className="ax-pro-bar">
          <input className="input small" placeholder="Find a row…" value={q} onChange={(e) => setQ(e.target.value)} data-testid={`${testId}-search`} aria-label="Find a row" />
          <span className="muted" style={{ fontSize: 12.5 }}>{rows.length} of {table.rows.length} rows{sort ? " · sorted" : ""}{collapsed.size ? ` · ${collapsed.size} collapsed` : ""}</span>
          {(sort || q || collapsed.size > 0) && <button type="button" className="btn small ghost" onClick={() => { setSort(null); setQ(""); setCollapsed(new Set()); }}>Reset</button>}
        </div>
      )}
      <div className="ax-pro-scroll" ref={wrapRef} style={windowed ? { maxHeight: viewH } : { maxHeight: maxHeight ?? undefined }} onScroll={windowed ? (e) => setScrollTop((e.target as HTMLDivElement).scrollTop) : undefined}>
        <table className="ax-pro-table" data-testid={testId} data-rows={rows.length}>
          <thead>
            {hasGroups && (
              <tr className="ax-pro-groups">
                <th className="stub" />
                {groups.map((g, i) => <th key={i} colSpan={g.span} className={g.label ? "grp" : "grp empty"}>{g.label}</th>)}
              </tr>
            )}
            <tr>
              <th className="stub" onClick={() => toggleSort(stub.key)} title="Sort by label" style={widths[stub.key] ? { minWidth: widths[stub.key], maxWidth: widths[stub.key], width: widths[stub.key] } : undefined}>{stub.label}{sort?.key === stub.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}<span className="ax-pro-grip" onPointerDown={(e) => startResize(stub.key, e)} title="Drag to resize" /></th>
              {dataCols.map((c) => (
                <th key={c.key} className={`num ${c.suppressed ? "sup" : ""} ${sort?.key === c.key ? "sorted" : ""}`} onClick={() => toggleSort(c.key)} title={c.suppressed ? "Base below the minimum — cells suppressed" : `Sort by ${c.label}`} style={widths[c.key] ? { minWidth: widths[c.key], width: widths[c.key] } : undefined}>
                  {c.label}{sort?.key === c.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}<span className="ax-pro-grip" onPointerDown={(e) => startResize(c.key, e)} title="Drag to resize" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {padTop > 0 && <tr aria-hidden="true" style={{ height: padTop }}><td colSpan={cols.length} /></tr>}
            {visible.map((r, i) => {
              const kind = (r.__kind as string | undefined) ?? "";
              const level = (r.__level as number | undefined) ?? 0;
              const isGroup = kind === "group", isSection = kind === "section";
              const gkey = isGroup ? String(r.__key) : null;
              return (
                <tr key={first + i} className={`k-${kind || "plain"} lvl-${level}`} style={windowed ? { height: rowH } : undefined}>
                  <td className="stub" style={{ paddingLeft: 10 + level * 18 }}>
                    {isGroup && <button type="button" className="ax-pro-caret" onClick={() => toggleGroup(gkey!)} aria-expanded={!collapsed.has(gkey!)} title={collapsed.has(gkey!) ? "Expand" : "Collapse"}>{collapsed.has(gkey!) ? "▸" : "▾"}</button>}
                    {String(r[stub.key] ?? "")}
                  </td>
                  {dataCols.map((c) => {
                    const v = r[c.key];
                    const sig = r[`${c.key}__sig`]; const vs = r[`${c.key}__vs`]; const n = r[`${c.key}__n`];
                    const type = typeOf(c, r);
                    const heat = f.heat && !isGroup && !isSection && kind !== "base" && kind !== "total" && type === "pct" ? heatStyle(v, heatMax) : undefined;
                    const cls = ["num", typeof v === "number" ? "" : "txt", c.suppressed ? "sup" : "", (sig || vs) && f.highlightSig !== false ? "has-sig" : "", vs === "+" ? "up" : vs === "−" ? "down" : ""].filter(Boolean).join(" ");
                    return (
                      <td key={c.key} className={cls} style={heat} title={typeof n === "number" ? `n = ${n}` : undefined}>
                        {isSection ? "" : v == null && c.suppressed ? <span className="ax-pro-supp">·</span> : fmtCell(v, type, decimalsOf(c, r))}
                        {sig ? <sup className="ax-sig">{String(sig)}</sup> : null}
                        {vs ? <span className={`ax-vs ${vs === "+" ? "up" : "down"}`}>{vs === "+" ? "▲" : "▼"}</span> : null}
                        {hasCounts && typeof n === "number" && type === "pct" && !isGroup && <span className="ax-pro-n">{n.toLocaleString("en-US")}</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {padBottom > 0 && <tr aria-hidden="true" style={{ height: padBottom }}><td colSpan={cols.length} /></tr>}
          </tbody>
        </table>
      </div>
      {(table.base || table.notes?.length) && (
        <div className="ax-table-notes">
          {table.base ? `Base: n = ${table.base.n}${table.base.weightedN != null && table.base.weightedN !== table.base.n ? ` · weighted n = ${table.base.weightedN}` : ""}${table.base.label ? ` · ${table.base.label}` : ""}` : ""}
          {table.notes?.map((n, i) => <div key={i}>{n}</div>)}
        </div>
      )}
    </div>
  );
}

/** the table as tab-separated text — what a spreadsheet paste wants */
export function tableToTsv(table: Table, decimals?: number): string {
  const head = table.columns.map((c) => c.label).join("\t");
  const lines = table.rows.map((r) => table.columns.map((c, i) => { const v = r[c.key]; const type = (r.__format as string | undefined) ?? c.type; const s = i === 0 ? String(v ?? "") : fmtCell(v, type, decimals ?? c.decimals ?? 1); const sig = r[`${c.key}__sig`]; return sig ? `${s} ${String(sig)}` : s; }).join("\t"));
  return [head, ...lines].join("\n");
}
