"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { variantRegistry } from "@rescript/schema";
import {
  buildDependencyIndex, objectStatus, listBlocks, referencesToMany, pruneReferencesToMany,
  duplicateQuestion, moveQuestionTo, migrateQuestionType, type ObjectKey, type QuestionReference, type TypeMigration,
} from "@rescript/engine";
import { useStudio, uid } from "../studio/store";
import { useSelection } from "../studio/SelectionContext";
import { useCommands } from "../studio/CommandContext";
import { useMode } from "../studio/ModeContext";
import { DeleteQuestionDialog } from "../studio/DeleteQuestionDialog";
import { Icon } from "../ui/Icon";
import {
  buildGridRows, decorateGridRows, applyGridQuery, typesIn, visibleRange,
  GRID_COLUMNS, DEFAULT_VISIBLE_COLUMNS, EMPTY_FILTER, ROW_HEIGHT,
  type GridRow, type GridColumn, type GridColumnId, type GridFilter, type SortSpec, type Density,
} from "../../lib/grid/model";
import { TextCellEditor, VariableCellEditor, TypeCellEditor, BlockCellEditor, OptionsCellEditor, RequiredCell, StatusDot } from "./GridCells";

/**
 * GRID — the survey as a programmable research grid.
 *
 * One row per question, one column per thing a programmer scans for, and
 * hundreds of them on screen at once. This is the second environment over
 * the same survey: it holds no survey data of its own (rows are derived from
 * the store's definition on every change), it edits through the same engine
 * functions and the same `update` as the Questions panel (so every cell edit
 * is undoable, autosaved and refused in read-only exactly like a click
 * there), and its selection IS the Studio's selection, so selecting a row
 * here opens that question's properties on the right and switching back to
 * Studio lands on it.
 *
 * Scale is the point. Rows are windowed by hand — `visibleRange` says which
 * of the N rows to mount for the current scroll position, and only those
 * exist in the DOM — so 600 questions cost the same as 30. Status and
 * dependency counts, the expensive part of a row, are computed against a
 * DEFERRED copy of the definition, so a keystroke in a cell repaints the
 * cheap columns immediately and the dots catch up a frame later.
 */

const STORAGE_KEY = "rescript.grid";

interface Prefs { columns: GridColumnId[]; density: Density }

function loadPrefs(): Prefs {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (raw) {
      const p = JSON.parse(raw) as Partial<Prefs>;
      const known = new Set(GRID_COLUMNS.map((c) => c.id));
      return {
        columns: Array.isArray(p.columns) && p.columns.every((c) => known.has(c)) ? p.columns : DEFAULT_VISIBLE_COLUMNS,
        density: p.density && ROW_HEIGHT[p.density] ? p.density : "normal",
      };
    }
  } catch { /* storage unavailable */ }
  return { columns: DEFAULT_VISIBLE_COLUMNS, density: "normal" };
}

const EDITABLE: Record<string, boolean> = { text: true, variable: true, type: true, block: true, required: true };

export function GridView() {
  const s = useStudio();
  const sel = useSelection();
  const cmd = useCommands();
  const mode = useMode();
  const readOnly = s.readOnly;

  /* ------------------------------------------------------------ rows */
  const rows = React.useMemo(() => buildGridRows(s.def), [s.def]);
  // the expensive layer follows a deferred definition — typing never waits on it
  const deferredDef = React.useDeferredValue(s.def);
  const decoration = React.useMemo(() => ({ status: objectStatus(deferredDef), index: buildDependencyIndex(deferredDef) }), [deferredDef]);
  const decorated = React.useMemo(() => decorateGridRows(rows, decoration.status, decoration.index), [rows, decoration]);

  /* ------------------------------------------------------------ prefs, query */
  const [prefs, setPrefs] = React.useState<Prefs>(loadPrefs);
  const savePrefs = (p: Prefs) => { setPrefs(p); try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch { /* fine */ } };
  const [filter, setFilter] = React.useState<GridFilter>(EMPTY_FILTER);
  const [search, setSearch] = React.useState("");
  React.useEffect(() => { const t = setTimeout(() => setFilter((f) => ({ ...f, search })), 120); return () => clearTimeout(t); }, [search]);
  const [sort, setSort] = React.useState<SortSpec | null>(null);
  const shown = React.useMemo(() => applyGridQuery(decorated, filter, sort), [decorated, filter, sort]);
  const columns = React.useMemo(() => GRID_COLUMNS.filter((c) => prefs.columns.includes(c.id)), [prefs.columns]);
  const rowHeight = ROW_HEIGHT[prefs.density];
  const byId = React.useMemo(() => new Map(s.def.questions.map((q) => [q.id, q])), [s.def]);
  const blocks = React.useMemo(() => listBlocks(s.def.flow as unknown[]), [s.def]);
  const types = React.useMemo(() => typesIn(decorated), [decorated]);

  /* ------------------------------------------------------------ scroll + window */
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewport, setViewport] = React.useState(600);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => setScrollTop((e.target as HTMLDivElement).scrollTop);
  const headerH = 34;
  const win = visibleRange(scrollTop, Math.max(0, viewport - headerH), rowHeight, shown.length);

  /* ------------------------------------------------------------ active cell + editing */
  const [active, setActive] = React.useState<{ row: number; col: number }>({ row: 0, col: 1 });
  const [editing, setEditing] = React.useState<{ id: string; col: GridColumnId } | null>(null);
  const [hover, setHover] = React.useState<string | null>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    // keep the active row inside the list when the query shrinks it
    setActive((a) => ({ row: Math.min(a.row, Math.max(0, shown.length - 1)), col: Math.min(a.col, columns.length - 1) }));
  }, [shown.length, columns.length]);

  const scrollRowIntoView = React.useCallback((i: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = i * rowHeight;
    const bottom = top + rowHeight;
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight - headerH;
    if (top < viewTop) el.scrollTop = top;
    else if (bottom > viewBottom) el.scrollTop = bottom - (el.clientHeight - headerH);
  }, [rowHeight]);

  /* ------------------------------------------------------------ selection */
  const orderKeys = React.useMemo(() => shown.map((r) => r.key), [shown]);
  const selectRow = (row: GridRow, e?: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (!sel) { s.select(row.id); return; }
    if (e?.shiftKey) sel.dispatch({ type: "range", key: row.key, order: orderKeys });
    else if (e?.metaKey || e?.ctrlKey) sel.dispatch({ type: "toggle", key: row.key });
    else sel.dispatch({ type: "select", key: row.key });
  };
  const selectedKeys = sel?.keys ?? (s.selectedQuestionId ? [`question:${s.selectedQuestionId}` as ObjectKey] : []);
  const selectedIds = React.useMemo(() => selectedKeys.filter((k) => k.startsWith("question:")).map((k) => k.slice(9)), [selectedKeys]);
  const isSelected = (row: GridRow) => sel ? sel.isSelected(row.key) : s.selectedQuestionId === row.id;

  /* ------------------------------------------------------------ actions */
  const openInStudio = (row: GridRow) => {
    selectRow(row);
    mode?.setMode("studio");
  };
  const startEdit = (row: GridRow, col: GridColumn) => {
    if (readOnly || !col.editable || col.id === "required") return;
    if (col.id === "text" && !row.plainText) { openInStudio(row); return; }
    setEditing({ id: row.id, col: col.id });
  };
  const rowCtx = (row: GridRow) => ({ questionId: row.id, primary: row.key });

  const [pendingDelete, setPendingDelete] = React.useState<{ ids: string[]; code: string; refs: QuestionReference[] } | null>(null);
  const askDelete = (ids: string[]) => {
    if (!ids.length || readOnly) return;
    const code = ids.length === 1 ? (byId.get(ids[0])?.code ?? "this question") : `${ids.length} questions`;
    setPendingDelete({ ids, code, refs: referencesToMany(s.def, ids) });
  };
  const confirmDelete = () => {
    if (!pendingDelete) return;
    const { ids, code } = pendingDelete;
    setPendingDelete(null);
    s.labelNextEdit(`delete ${code}`);
    s.update((d) => {
      pruneReferencesToMany(d, ids);
      const gone = new Set(ids);
      d.questions = d.questions.filter((q) => !gone.has(q.id));
      for (const b of listBlocks(d.flow as unknown[])) for (const p of b.pages) p.node.questionIds = p.node.questionIds.filter((x) => !gone.has(x));
    });
    sel?.dispatch({ type: "drop", keys: ids.map((id) => `question:${id}` as ObjectKey) });
  };

  /* bulk */
  const [bulkType, setBulkType] = React.useState<{ to: string; migrations: { q: Question; m: TypeMigration }[] } | null>(null);
  const bulkSetRequired = (to: boolean) => {
    const ids = new Set(selectedIds);
    s.labelNextEdit(`${to ? "require" : "make optional"} ${ids.size} questions`);
    s.update((d) => { d.questions = d.questions.map((q) => ids.has(q.id) ? { ...q, required: to } : q); });
  };
  const bulkMove = (blockId: string) => {
    const b = blocks.find((x) => x.id === blockId);
    if (!b) return;
    const last = b.pages[b.pages.length - 1].node;
    const ordered = shown.filter((r) => selectedIds.includes(r.id)).map((r) => r.id);
    s.labelNextEdit(`move ${ordered.length} questions to ${b.title ?? "block"}`);
    s.update((d) => {
      for (const id of ordered) {
        const page = listBlocks(d.flow as unknown[]).find((x) => x.id === blockId)!.pages.slice(-1)[0].node;
        moveQuestionTo(d, id, last.id, page.questionIds.length);
      }
    });
  };
  const bulkDuplicate = () => {
    const ordered = shown.filter((r) => selectedIds.includes(r.id)).map((r) => r.id);
    s.labelNextEdit(`duplicate ${ordered.length} questions`);
    s.update((d) => { for (const id of ordered) duplicateQuestion(d, id, uid); });
  };
  const bulkChangeType = (variantId: string) => {
    const to = variantRegistry.get(variantId);
    if (!to) return;
    const migrations = selectedIds.map((id) => byId.get(id)).filter((q): q is Question => !!q).map((q) => ({ q, m: migrateQuestionType(q, to) }));
    const risky = migrations.some(({ m }) => !m.safe || m.changes.length > 0);
    if (risky) { setBulkType({ to: variantId, migrations }); return; }
    applyBulkType(migrations, to.name);
  };
  const applyBulkType = (migrations: { q: Question; m: TypeMigration }[], name: string) => {
    s.labelNextEdit(`change ${migrations.length} questions to ${name}`);
    s.update((d) => {
      for (const { q, m } of migrations) {
        const i = d.questions.findIndex((x) => x.id === q.id);
        if (i >= 0) d.questions[i] = m.q;
      }
    });
    setBulkType(null);
    s.toast(`${migrations.length} question${migrations.length === 1 ? "" : "s"} changed to ${name}`);
  };

  /* ------------------------------------------------------------ keyboard */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const row = shown[active.row];
    const col = columns[active.col];
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      const nr = Math.max(0, Math.min(shown.length - 1, active.row + dr));
      const nc = Math.max(0, Math.min(columns.length - 1, active.col + dc));
      setActive({ row: nr, col: nc });
      if (dr) {
        scrollRowIntoView(nr);
        const target = shown[nr];
        if (target) {
          if (e.shiftKey && sel) sel.dispatch({ type: "range", key: target.key, order: orderKeys });
          else selectRow(target);
        }
      }
    };
    switch (e.key) {
      case "ArrowDown": move(1, 0); break;
      case "ArrowUp": move(-1, 0); break;
      case "ArrowRight": move(0, 1); break;
      case "ArrowLeft": move(0, -1); break;
      case "PageDown": move(Math.floor((viewport - headerH) / rowHeight), 0); break;
      case "PageUp": move(-Math.floor((viewport - headerH) / rowHeight), 0); break;
      case "Home": if (e.metaKey || e.ctrlKey) move(-shown.length, 0); else move(0, -columns.length); break;
      case "End": if (e.metaKey || e.ctrlKey) move(shown.length, 0); else move(0, columns.length); break;
      case "Tab": move(0, e.shiftKey ? -1 : 1); break;
      case "Enter":
        if (row && col) { e.preventDefault(); if (col.editable && col.id !== "required") startEdit(row, col); else openInStudio(row); }
        break;
      case " ":
        if (row && sel) { e.preventDefault(); sel.dispatch({ type: "toggle", key: row.key }); }
        break;
      case "Escape":
        if (sel && sel.keys.length) { e.preventDefault(); sel.dispatch({ type: "clear" }); }
        break;
      case "Delete":
      case "Backspace":
        if (selectedIds.length) { e.preventDefault(); askDelete(selectedIds); }
        break;
      default: break;
    }
  };

  /* ------------------------------------------------------------ layout helpers */
  const frozenLeft = React.useMemo(() => {
    const out: Partial<Record<GridColumnId, number>> = {};
    let x = 0;
    for (const c of columns) { if (c.frozen) { out[c.id] = x; x += c.width; } }
    return out;
  }, [columns]);
  const cellStyle = (c: GridColumn): React.CSSProperties => ({
    width: c.grow ? undefined : c.width,
    minWidth: c.minWidth,
    flex: c.grow ? "1 1 360px" : `0 0 ${c.width}px`,
    textAlign: c.align,
    ...(c.frozen ? { position: "sticky", left: frozenLeft[c.id] } : {}),
  });
  const totalMin = columns.reduce((n, c) => n + c.width, 0);

  const cycleSort = (col: GridColumn) => {
    if (!col.sortable) return;
    setSort((cur) => !cur || cur.column !== col.id ? { column: col.id, dir: "asc" } : cur.dir === "asc" ? { column: col.id, dir: "desc" } : null);
  };

  /* ------------------------------------------------------------ cells */
  const renderCell = (row: GridRow, c: GridColumn, ri: number, ci: number) => {
    const q = byId.get(row.id);
    const isEditing = editing?.id === row.id && editing.col === c.id;
    const isActive = active.row === ri && active.col === ci;
    let body: React.ReactNode;
    if (isEditing && q) {
      const done = () => { setEditing(null); gridRef.current?.focus(); };
      body = c.id === "text" ? <TextCellEditor q={q} onDone={done} />
        : c.id === "variable" ? <VariableCellEditor q={q} onDone={done} />
          : c.id === "type" ? <TypeCellEditor q={q} onDone={done} />
            : c.id === "block" ? <BlockCellEditor q={q} row={row} onDone={done} />
              : c.id === "options" ? <OptionsCellEditor q={q} onDone={done} onOpenInStudio={() => { done(); openInStudio(row); }} />
                : null;
    } else {
      switch (c.id) {
        case "status": body = <StatusDot row={row} />; break;
        case "code": body = <span className="mono sg-code">{row.code}</span>; break;
        case "type": body = <span className="sg-type" title={row.familyLabel}>{row.typeLabel}</span>; break;
        case "variable": body = <span className="mono">{row.variableName}</span>; break;
        case "text": body = <span className={row.text ? "" : "muted"} title={row.plainText ? undefined : "Rich text — press Enter to open in the Studio editor"}>{row.text || "—"}{!row.plainText && <span className="sg-rich" aria-hidden="true">¶</span>}</span>; break;
        case "options": body = <span className={row.options ? "sg-opts" : "muted"}>{row.options || "—"}</span>; break;
        case "display": body = row.display ? <span className="sg-logic" title={row.display}><span className="sg-kw">IF</span> {row.display}</span> : <span className="muted">—</span>; break;
        case "skip": body = row.skip ? <span className="sg-logic" title={row.skip}>{row.skip}</span> : <span className="muted">—</span>; break;
        case "validation": body = <span className={row.validation ? "" : "muted"}>{row.validation || "—"}</span>; break;
        case "required": body = q ? <RequiredCell q={q} disabled={readOnly} /> : null; break;
        case "deps": body = (row.dependsOn || row.usedBy)
          ? <span className="sg-deps" title={`reads ${row.dependsOn} · read by ${row.usedBy}`}><span>←{row.dependsOn}</span><span>→{row.usedBy}</span></span>
          : <span className="muted">—</span>; break;
        case "block": body = <span className={row.unplaced ? "sg-unplaced" : ""} title={row.unplaced ? "On no page — respondents never see this" : undefined}>{row.unplaced ? "unplaced" : row.blockTitle}</span>; break;
      }
    }
    return (
      <div
        key={c.id}
        className={`sg-cell sg-col-${c.id}${c.frozen ? " frozen" : ""}${isActive ? " active" : ""}${c.editable && !readOnly ? " editable" : ""}`}
        style={cellStyle(c)}
        data-col={c.id}
        onDoubleClick={() => startEdit(row, c)}
        onClick={() => setActive({ row: ri, col: ci })}
      >
        {body}
      </div>
    );
  };

  const bulk = selectedIds.length >= 2;
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <div className={`sg sg-${prefs.density}`} data-testid="grid-view">
      {/* ------------------------------------------------------------ toolbar */}
      <div className="sg-toolbar">
        <div className="sg-search">
          <Icon name="search" size={14} />
          <input className="sg-search-input" data-testid="grid-search" placeholder="Search code, variable, text, options, logic…"
            value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          {search && <button className="sg-clear" onClick={() => setSearch("")} aria-label="Clear search"><Icon name="close" size={12} /></button>}
        </div>
        <Menu label={filter.types ? `Type · ${filter.types.length}` : "Type"} testId="grid-filter-type" active={!!filter.types}>
          {types.map((t) => (
            <label key={t.type} className="sg-menu-item">
              <input type="checkbox" checked={!filter.types || filter.types.includes(t.type)}
                onChange={(e) => setFilter((f) => {
                  const cur = new Set(f.types ?? types.map((x) => x.type));
                  if (e.target.checked) cur.add(t.type); else cur.delete(t.type);
                  const all = cur.size === types.length;
                  return { ...f, types: all ? null : [...cur] };
                })} />
              <span>{t.label}</span><span className="muted">{t.count}</span>
            </label>
          ))}
        </Menu>
        <select className="sg-select" data-testid="grid-filter-block" value={filter.block ?? ""} onChange={(e) => setFilter((f) => ({ ...f, block: e.target.value || null }))}>
          <option value="">All blocks</option>
          {blocks.map((b, i) => <option key={b.id} value={b.id}>{b.title ?? `Block ${i + 1}`}</option>)}
        </select>
        <button className={`sg-chip${filter.withLogic ? " on" : ""}`} data-testid="grid-filter-logic" onClick={() => setFilter((f) => ({ ...f, withLogic: !f.withLogic }))}>With logic</button>
        <button className={`sg-chip${filter.withIssues ? " on" : ""}`} data-testid="grid-filter-issues" onClick={() => setFilter((f) => ({ ...f, withIssues: !f.withIssues }))}>Issues</button>
        <span className="sg-count" data-testid="grid-count">{shown.length === rows.length ? `${rows.length} questions` : `${shown.length} of ${rows.length}`}</span>
        <span className="grow" />
        <Menu label="Columns" testId="grid-columns">
          {GRID_COLUMNS.map((c) => (
            <label key={c.id} className="sg-menu-item" title={c.description}>
              <input type="checkbox" checked={prefs.columns.includes(c.id)} disabled={c.frozen}
                onChange={(e) => savePrefs({ ...prefs, columns: e.target.checked ? GRID_COLUMNS.filter((x) => x.id === c.id || prefs.columns.includes(x.id)).map((x) => x.id) : prefs.columns.filter((x) => x !== c.id) })} />
              <span>{c.label || "Status"}</span>
            </label>
          ))}
        </Menu>
        <div className="sg-density" role="radiogroup" aria-label="Density" data-testid="grid-density">
          {(["compact", "normal", "comfortable"] as Density[]).map((d) => (
            <button key={d} role="radio" aria-checked={prefs.density === d} className={prefs.density === d ? "on" : ""} data-density={d}
              onClick={() => savePrefs({ ...prefs, density: d })} title={d}>{d[0].toUpperCase()}</button>
          ))}
        </div>
        <kbd className="palette-kbd" title="Command palette">{mac ? "⌘K" : "Ctrl+K"}</kbd>
      </div>

      {/* ------------------------------------------------------------ bulk bar */}
      {bulk && (
        <div className="sg-bulk" data-testid="grid-bulk">
          <strong>{selectedIds.length} selected</strong>
          <span className="sg-bulk-sep" />
          <button className="btn small" disabled={readOnly} data-testid="grid-bulk-required-on" onClick={() => bulkSetRequired(true)}>Required</button>
          <button className="btn small" disabled={readOnly} data-testid="grid-bulk-required-off" onClick={() => bulkSetRequired(false)}>Optional</button>
          <select className="sg-select" disabled={readOnly} data-testid="grid-bulk-type" value="" onChange={(e) => { if (e.target.value) bulkChangeType(e.target.value); }}>
            <option value="">Change type…</option>
            {[...variantRegistry.all()].filter((v) => !v.presetOf).map((v) => <option key={v.id} value={v.id}>{v.familyLabel} — {v.name}</option>)}
          </select>
          <select className="sg-select" disabled={readOnly} data-testid="grid-bulk-move" value="" onChange={(e) => { if (e.target.value) bulkMove(e.target.value); }}>
            <option value="">Move to block…</option>
            {blocks.map((b, i) => <option key={b.id} value={b.id}>{b.title ?? `Block ${i + 1}`}</option>)}
          </select>
          <button className="btn small" disabled={readOnly} data-testid="grid-bulk-duplicate" onClick={bulkDuplicate}>Duplicate</button>
          <button className="btn small danger" disabled={readOnly} data-testid="grid-bulk-delete" onClick={() => askDelete(selectedIds)}>Delete</button>
          <span className="grow" />
          <button className="btn small" onClick={() => sel?.dispatch({ type: "clear" })}>Clear</button>
        </div>
      )}

      {/* ------------------------------------------------------------ the grid */}
      <div className="sg-scroll" ref={scrollRef} onScroll={onScroll}>
        <div ref={gridRef} className="sg-table" role="grid" tabIndex={0} onKeyDown={onKeyDown} style={{ minWidth: totalMin }}
          aria-rowcount={shown.length} aria-colcount={columns.length} data-testid="grid-table">
          <div className="sg-head" role="row" style={{ height: headerH }}>
            {columns.map((c) => (
              <div key={c.id} role="columnheader" className={`sg-cell sg-h${c.frozen ? " frozen" : ""}${sort?.column === c.id ? " sorted" : ""}`}
                style={cellStyle(c)} title={c.description} onClick={() => cycleSort(c)} data-testid={`grid-head-${c.id}`}>
                {c.label}{sort?.column === c.id && <span className="sg-sort">{sort.dir === "asc" ? "▲" : "▼"}</span>}
              </div>
            ))}
          </div>
          <div className="sg-body" style={{ height: win.totalHeight, position: "relative" }}>
            {shown.length === 0 && (
              <div className="sg-empty">{rows.length === 0 ? "No questions yet — press ⌘⇧A or use the palette to add one." : "Nothing matches these filters."}</div>
            )}
            {shown.slice(win.start, win.end).map((row, k) => {
              const ri = win.start + k;
              const selected = isSelected(row);
              const isHover = hover === row.id;
              return (
                <div
                  key={row.id}
                  role="row"
                  aria-selected={selected}
                  data-testid="grid-row"
                  data-qid={row.id}
                  data-code={row.code}
                  className={`sg-row${selected ? " selected" : ""}${active.row === ri ? " active" : ""}${row.unplaced ? " unplaced" : ""}`}
                  style={{ position: "absolute", top: ri * rowHeight, height: rowHeight, left: 0, right: 0 }}
                  onMouseEnter={() => setHover(row.id)}
                  onMouseLeave={() => setHover((h) => (h === row.id ? null : h))}
                  onClick={(e) => { selectRow(row, e); }}
                >
                  {columns.map((c, ci) => renderCell(row, c, ri, ci))}
                  {(isHover || (hover === null && active.row === ri && !editing)) && (
                    <div className="sg-actions" data-testid="grid-row-actions" onClick={(e) => e.stopPropagation()}>
                      <button title="Open in Studio" onClick={() => openInStudio(row)} data-testid="grid-action-open"><Icon name="questions" size={13} /></button>
                      <button title="Move up" disabled={readOnly} onClick={() => cmd?.run("question.moveUp", rowCtx(row))}>↑</button>
                      <button title="Move down" disabled={readOnly} onClick={() => cmd?.run("question.moveDown", rowCtx(row))}>↓</button>
                      <button title="Duplicate" disabled={readOnly} onClick={() => cmd?.run("question.duplicate", rowCtx(row))} data-testid="grid-action-duplicate">⧉</button>
                      <button title="Delete" disabled={readOnly} className="danger" onClick={() => askDelete([row.id])} data-testid="grid-action-delete">×</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {pendingDelete && (
        <DeleteQuestionDialog code={pendingDelete.code} refs={pendingDelete.refs}
          onCancel={() => setPendingDelete(null)} onConfirm={confirmDelete} />
      )}
      {bulkType && (
        <div className="modal-back" onClick={() => setBulkType(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} data-testid="grid-bulk-type-dialog">
            <h3>Change {bulkType.migrations.length} questions to {variantRegistry.get(bulkType.to)?.name}?</h3>
            <p className="muted">Some of these change the shape of the answer, or drop settings the new type cannot read:</p>
            <ul className="sg-bulk-list">
              {bulkType.migrations.filter(({ m }) => !m.safe || m.changes.length).slice(0, 12).map(({ q, m }) => (
                <li key={q.id}><strong className="mono">{q.code}</strong> {m.from.label} → {m.to.label}{!m.safe ? " — answer shape changes" : ""}{m.changes.length ? ` — ${m.changes.length} setting${m.changes.length === 1 ? "" : "s"} removed` : ""}</li>
              ))}
            </ul>
            <div className="row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button className="btn" onClick={() => setBulkType(null)}>Cancel</button>
              <button className="btn primary" data-testid="grid-bulk-type-confirm" onClick={() => applyBulkType(bulkType.migrations, variantRegistry.get(bulkType.to)?.name ?? "")}>Change all</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** a small click-to-open menu; closes on outside click or Escape */
function Menu({ label, children, testId, active }: { label: string; children: React.ReactNode; testId?: string; active?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey, true); };
  }, [open]);
  return (
    <div className="sg-menu" ref={ref}>
      <button className={`sg-chip${active ? " on" : ""}${open ? " open" : ""}`} data-testid={testId} onClick={() => setOpen((o) => !o)}>{label} <Icon name="chevron-down" size={12} /></button>
      {open && <div className="sg-menu-pop" data-testid={testId ? `${testId}-menu` : undefined}>{children}</div>}
    </div>
  );
}
