"use client";
import React from "react";
import type { Condition, Question, SurveyDefinition } from "@rescript/schema";
import { useStudio } from "./store";
import { ConditionEditor, conditionToText } from "./ConditionBuilder";

/**
 * Data → Manage: the Response Data Management screen.
 *
 *   header    the environment — TEST, LIVE or ALL — stated, never inferred,
 *             with the counts of each so it is obvious which dataset is open
 *   search    one box over respondent codes, ids and every exported value
 *   filter    an ordinary survey Condition (the same builder as display logic
 *             and quotas) → "Find matching" → a COUNT, and only then the
 *             offer to delete exactly that many
 *   grid      one page at a time, sortable, selectable; a cell is editable in
 *             place, a row opens the full editor
 *   editor    every answer by its question type, validated by the survey's
 *             own schema on save, with the row's audit trail beneath it
 *   import    paste or choose a file → map columns → preview → commit
 *   bin       soft-deleted responses, restorable
 *
 * Nothing is filtered, counted or deleted in the browser: every operation is
 * a request whose answer is a number or a page. A 100 000-response survey
 * behaves the same as a 10-response one.
 */

type Env = "TEST" | "LIVE" | "ALL";
type Sort = { field: "started_at" | "completed_at" | "updated_at" | "respondent_code" | "status"; dir: "asc" | "desc" };

const STATUSES = ["complete", "in_progress", "screened", "quota_full", "terminated"];
const STATUS_CHIP: Record<string, string> = { complete: "on", in_progress: "", screened: "warn", quota_full: "warn", terminated: "warn" };

interface Rec {
  id: string; respondentCode: string | null; sessionId: string; respondentId: string | null;
  status: string; environment: "TEST" | "LIVE"; revision: number; source: string;
  startedAt: string | null; completedAt: string | null; updatedAt: string | null;
  deletedAt: string | null; deletedBy: string | null; deletionReason: string | null;
  answers: Record<string, unknown>; calculated: Record<string, unknown>; embedded: Record<string, unknown>;
  vars: Record<string, unknown>;
  quality: { classification: string; qualityScore: number; riskScore: number } | null;
  reviewStatus: string | null;
}
interface Page {
  rows: Rec[]; total: number; exact: boolean; filterNote?: string; limit: number; offset: number;
  columns: { name: string; label: string }[];
  counts: Record<string, { total: number; complete: number; in_progress: number; deleted: number }> | null;
  error?: string; migration?: string;
}

const fmt = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export function ResponseManager({ environment, onEnvironment }: { environment: Env; onEnvironment(e: Env): void }) {
  const s = useStudio();
  const [page, setPage] = React.useState<Page | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [offset, setOffset] = React.useState(0);
  const [limit, setLimit] = React.useState(50);
  const [sort, setSort] = React.useState<Sort>({ field: "started_at", dir: "desc" });
  const [search, setSearch] = React.useState("");
  const [searchLive, setSearchLive] = React.useState("");
  const [statuses, setStatuses] = React.useState<string[]>([]);
  const [bin, setBin] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [filter, setFilter] = React.useState<Condition | null>(null);
  const [match, setMatch] = React.useState<{ busy: boolean; total?: number; exact?: boolean; note?: string; error?: string } | null>(null);
  const [confirm, setConfirm] = React.useState<PendingDelete | null>(null);
  const [toast, setToast] = React.useState<{ text: string; ok: boolean } | null>(null);

  // debounce the search box: one request per pause, not per keystroke
  React.useEffect(() => {
    const t = setTimeout(() => { setSearch(searchLive); setOffset(0); }, 350);
    return () => clearTimeout(t);
  }, [searchLive]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ environment, limit: String(limit), offset: String(offset), sort: sort.field, dir: sort.dir });
      if (search.trim()) qs.set("search", search.trim());
      for (const st of statuses) qs.append("status", st);
      if (bin) qs.set("deleted", "1");
      const r = await fetch(`/api/surveys/${s.surveyDbId}/data?${qs}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? `Server returned ${r.status}`); setPage(null); return; }
      setPage(j);
    } catch (e) { setError((e as Error).message || "Could not load responses."); }
    finally { setLoading(false); }
  }, [s.surveyDbId, environment, limit, offset, sort, search, statuses, bin]);
  React.useEffect(() => { void load(); }, [load]);

  // the environment changing is a different dataset: nothing carries over
  React.useEffect(() => { setSelected(new Set()); setOffset(0); setMatch(null); }, [environment, bin]);

  const say = (text: string, ok = true) => { setToast({ text, ok }); setTimeout(() => setToast(null), 6000); };

  const findMatching = async () => {
    setMatch({ busy: true });
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/data`, {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ environment, filter, search: search.trim() || undefined, statuses: statuses.length ? statuses : undefined, deleted: bin }),
      });
      const j = await r.json();
      if (!r.ok) { setMatch({ busy: false, error: j.error ?? `Server returned ${r.status}` }); return; }
      setMatch({ busy: false, total: j.total, exact: j.exact, note: j.note });
    } catch (e) { setMatch({ busy: false, error: (e as Error).message }); }
  };

  /** Every destructive path lands here — with a count the researcher has seen. */
  const runDelete = async () => {
    if (!confirm) return;
    const action = bin ? (confirm.purge ? "purge" : "restore") : "delete";
    const body: Record<string, unknown> = { environment, action, reason: confirm.reason || undefined };
    if (confirm.kind === "filter") { body.filter = filter; body.search = search.trim() || undefined; body.statuses = statuses.length ? statuses : undefined; body.confirmCount = confirm.count; }
    else body.ids = confirm.ids;
    setConfirm(null);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/data/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) { say(j.error ?? `The operation failed (${r.status})`, false); if (typeof j.recount === "number") setMatch({ busy: false, total: j.recount, exact: true }); return; }
      const verb = action === "purge" ? "permanently deleted" : action === "restore" ? "restored" : "deleted";
      say(`${j.affected} response${j.affected === 1 ? "" : "s"} ${verb}.${j.quotas && Object.keys(j.quotas).length ? " Quota counts were recalculated." : ""}`);
      setSelected(new Set());
      setMatch(null);
      await load();
    } catch (e) { say((e as Error).message, false); }
  };

  const counts = page?.counts;
  const columns = page?.columns ?? [];
  const rows = page?.rows ?? [];
  // only columns that carry a value on this page — a 400-variable dictionary
  // is unreadable, and the full set is one click away
  const [allColumns, setAllColumns] = React.useState(false);
  const shown = React.useMemo(
    () => (allColumns ? columns : columns.filter((c) => rows.some((r) => fmt(r.vars[c.name]) !== ""))),
    [columns, rows, allColumns],
  );
  const pageFrom = page ? Math.min(page.offset + 1, page.total) : 0;
  const pageTo = page ? Math.min(page.offset + rows.length, page.total) : 0;
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  if (error) {
    return (
      <div className="card" style={{ borderColor: "var(--red)" }} data-testid="rm-error">
        <strong style={{ color: "var(--red)" }}>{error}</strong>
        {/0006|migration/i.test(error) && (
          <p className="muted" style={{ fontSize: 12 }}>
            Run <span className="mono">supabase/migrations/0006_response_management.sql</span> on the database, then reload. Until
            then the Responses and Quality views keep working read-only.
          </p>
        )}
        <button className="btn small" style={{ marginTop: 8 }} onClick={() => void load()}>Try again</button>
      </div>
    );
  }

  return (
    <div data-testid="response-manager" className="rm">
      {/* ------------------------------------------------------ environment */}
      <div className="card rm-envbar" data-testid="rm-envbar">
        <div>
          <div className="qd-config-title">Dataset</div>
          <div className="row" style={{ gap: 4, marginTop: 6 }} data-testid="rm-env">
            {(["TEST", "LIVE", "ALL"] as Env[]).map((e) => (
              <button key={e} className={`btn small ${environment === e ? "primary" : ""}`} data-testid={`rm-env-${e}`} onClick={() => onEnvironment(e)}>
                {e === "TEST" ? "Test data" : e === "LIVE" ? "Live data" : "All data"}
                {counts?.[e] ? <span className="rm-count">{counts[e].total}</span> : null}
              </button>
            ))}
          </div>
          <div className="qd-config-source" data-testid="rm-env-note">
            {environment === "ALL"
              ? <>Test and live responses together — every row is labelled. Editing and deleting still act on the row's own environment.</>
              : <>Only <strong>{environment === "TEST" ? "test" : "live"}</strong> responses. {counts?.[environment] ? `${counts[environment].complete} complete, ${counts[environment].in_progress} in progress${counts[environment].deleted ? `, ${counts[environment].deleted} in the bin` : ""}.` : ""} Test and live are separated in the database, not by this filter.</>}
          </div>
        </div>
        <div className="qd-config-actions">
          <button className="btn small" data-testid="rm-import-open" onClick={() => setImportOpen(true)}>⬆ Import responses</button>
          <button className={`btn small ${bin ? "primary" : ""}`} data-testid="rm-bin" onClick={() => setBin((b) => !b)}>
            🗑 {bin ? "Back to responses" : `Recycle bin${counts?.[environment]?.deleted ? ` (${counts[environment].deleted})` : ""}`}
          </button>
        </div>
      </div>

      {toast && <div className={`chip ${toast.ok ? "on" : "warn"} qd-note`} data-testid="rm-toast">{toast.text}</div>}

      {/* ------------------------------------------------------ search + filters */}
      <div className="rm-tools">
        <input className="input rm-search" data-testid="rm-search" value={searchLive} onChange={(e) => setSearchLive(e.target.value)}
          placeholder="Search respondent id, variable or value…" />
        <select className="select" style={{ width: 150 }} data-testid="rm-status" value={statuses.length === 1 ? statuses[0] : ""}
          onChange={(e) => { setStatuses(e.target.value ? [e.target.value] : []); setOffset(0); }}>
          <option value="">Any status</option>
          {STATUSES.map((st) => <option key={st} value={st}>{st.replace("_", " ")}</option>)}
        </select>
        <select className="select" style={{ width: 165 }} value={`${sort.field}:${sort.dir}`}
          onChange={(e) => { const [f, d] = e.target.value.split(":"); setSort({ field: f as Sort["field"], dir: d as "asc" | "desc" }); }}>
          <option value="started_at:desc">Newest first</option>
          <option value="started_at:asc">Oldest first</option>
          <option value="updated_at:desc">Recently changed</option>
          <option value="respondent_code:asc">Respondent id</option>
          <option value="status:asc">Status</option>
        </select>
        <button className={`btn small ${filterOpen || filter ? "primary" : ""}`} data-testid="rm-filter-open" onClick={() => setFilterOpen((o) => !o)}>
          {filter ? "Filter: on" : "+ Add filter"}
        </button>
        {/* a `grow` spacer fights wrapping — this group moves down as a unit */}
        <div className="rm-tools-right">
          <label className="qs-check rm-allcols">
            <input type="checkbox" checked={allColumns} onChange={(e) => setAllColumns(e.target.checked)} />
            <span>All columns</span>
          </label>
          <button className="btn small" onClick={() => void load()} data-testid="rm-refresh">{loading ? "Loading…" : "↻ Refresh"}</button>
        </div>
      </div>

      {filterOpen && (
        <div className="card rm-filter" data-testid="rm-filter">
          <div className="flabel">Find responses where</div>
          <ConditionEditor value={filter ?? { type: "group", op: "and", children: [] }} onChange={(c) => { setFilter(c); setMatch(null); }} />
          <div className="rm-filter-foot">
            <button className="btn small primary" data-testid="rm-find" disabled={match?.busy} onClick={findMatching}>
              {match?.busy ? "Counting…" : "Find matching responses"}
            </button>
            {filter && <span className="muted" style={{ fontSize: 11 }}>{conditionToText(filter, s.def)}</span>}
            <span className="grow" />
            {filter && <button className="btn small" onClick={() => { setFilter(null); setMatch(null); }}>Clear filter</button>}
          </div>
          {match?.error && <div className="chip warn qd-note" data-testid="rm-find-error">{match.error}</div>}
          {typeof match?.total === "number" && (
            <div className="rm-found" data-testid="rm-found">
              <strong>{match.total} response{match.total === 1 ? "" : "s"} found</strong>
              <span className="muted" style={{ fontSize: 11 }}>
                in {environment === "ALL" ? "test and live" : environment.toLowerCase()} data
                {match.exact ? "" : " · part of this filter was evaluated by the survey engine"}
              </span>
              <span className="grow" />
              {match.total > 0 && !bin && (
                <button className="btn small danger" data-testid="rm-delete-matching"
                  onClick={() => setConfirm({ kind: "filter", count: match.total!, label: `${match.total} response${match.total === 1 ? "" : "s"} matching this filter`, reason: "" })}>
                  Delete {match.total} response{match.total === 1 ? "" : "s"}
                </button>
              )}
            </div>
          )}
          {page?.filterNote && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{page.filterNote}</div>}
        </div>
      )}

      {/* ------------------------------------------------------ selection actions */}
      {selected.size > 0 && (
        <div className="rm-selbar" data-testid="rm-selbar">
          <strong>{selected.size} selected</strong>
          <button className="btn small" onClick={() => setSelected(new Set())}>Clear selection</button>
          <span className="grow" />
          {bin ? (
            <>
              <button className="btn small" data-testid="rm-restore-selected"
                onClick={() => setConfirm({ kind: "selection", count: selected.size, ids: [...selected], label: `${selected.size} response${selected.size === 1 ? "" : "s"}`, reason: "" })}>
                Restore {selected.size}
              </button>
              <button className="btn small danger" data-testid="rm-purge-selected"
                onClick={() => setConfirm({ kind: "selection", count: selected.size, ids: [...selected], label: `${selected.size} response${selected.size === 1 ? "" : "s"}`, reason: "", purge: true })}>
                Delete permanently
              </button>
            </>
          ) : (
            <button className="btn small danger" data-testid="rm-delete-selected"
              onClick={() => setConfirm({ kind: "selection", count: selected.size, ids: [...selected], label: `${selected.size} selected response${selected.size === 1 ? "" : "s"}`, reason: "" })}>
              Delete {selected.size} selected
            </button>
          )}
        </div>
      )}

      {/* ------------------------------------------------------ grid */}
      <div className="table-wrap rm-grid">
        <table className="grid" data-testid="rm-table">
          <thead>
            <tr>
              <th style={{ width: 28 }}>
                <input type="checkbox" aria-label="Select all on this page" data-testid="rm-select-page" checked={allOnPageSelected}
                  onChange={(e) => setSelected((prev) => {
                    const next = new Set(prev);
                    for (const r of rows) { if (e.target.checked) next.add(r.id); else next.delete(r.id); }
                    return next;
                  })} />
              </th>
              <th>Respondent</th>
              <th>Status</th>
              {environment === "ALL" && <th>Env</th>}
              {shown.map((c) => <th key={c.name} title={c.label}>{c.name}</th>)}
              <th>Started</th>
              <th style={{ width: 120 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid="rm-row" data-code={r.respondentCode ?? r.sessionId}>
                <td>
                  <input type="checkbox" aria-label={`Select ${r.respondentCode ?? r.sessionId}`} data-testid="rm-row-select" checked={selected.has(r.id)}
                    onChange={(e) => setSelected((prev) => { const n = new Set(prev); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
                </td>
                <td className="mono">
                  <button className="rm-code" data-testid="rm-open" onClick={() => setOpenId(r.id)} title="Open the full response editor">
                    {r.respondentCode ?? r.sessionId.slice(0, 10)}
                  </button>
                  {r.source !== "runtime" && <span className="chip" title={`This response was ${r.source === "import" ? "imported" : "edited by hand"}`}>{r.source}</span>}
                </td>
                <td><span className={`chip ${STATUS_CHIP[r.status] ?? ""}`}>{r.status.replace("_", " ")}</span></td>
                {environment === "ALL" && <td><span className={`chip ${r.environment === "TEST" ? "warn" : "on"}`}>{r.environment}</span></td>}
                {shown.map((c) => (
                  <Cell key={c.name} rec={r} column={c.name} def={s.def} disabled={!!r.deletedAt}
                    onSaved={(msg) => { say(msg); void load(); }} onError={(msg) => say(msg, false)} surveyDbId={s.surveyDbId} />
                ))}
                <td className="rm-when">{when(r.startedAt)}</td>
                <td>
                  <div className="row" style={{ gap: 4 }}>
                    <button className="btn small ghost" data-testid="rm-edit" onClick={() => setOpenId(r.id)}>Edit</button>
                    {bin ? (
                      <button className="btn small ghost" data-testid="rm-restore-one"
                        onClick={() => setConfirm({ kind: "one", count: 1, ids: [r.id], label: r.respondentCode ?? r.sessionId, reason: "" })}>Restore</button>
                    ) : (
                      <button className="btn small danger" data-testid="rm-delete-one"
                        onClick={() => setConfirm({ kind: "one", count: 1, ids: [r.id], label: r.respondentCode ?? r.sessionId, reason: "" })}>Delete</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && !loading && (
          <p className="muted rm-empty" data-testid="rm-empty">
            {bin ? "The recycle bin is empty." : search || filter || statuses.length
              ? "No responses match. Clear the search or filter to see the whole dataset."
              : environment === "TEST"
                ? "No test responses yet. Click Test Survey, answer a few questions, and refresh."
                : "No live responses yet."}
          </p>
        )}
      </div>

      {/* ------------------------------------------------------ pagination */}
      {page && page.total > 0 && (
        <div className="rm-pager" data-testid="rm-pager">
          <span className="muted" style={{ fontSize: 12 }}>
            {pageFrom}–{pageTo} of {page.total}{page.exact ? "" : " matching"}
          </span>
          <span className="grow" />
          <select className="select" style={{ width: 110 }} value={String(limit)} onChange={(e) => { setLimit(Number(e.target.value)); setOffset(0); }}>
            {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} per page</option>)}
          </select>
          <button className="btn small" disabled={offset === 0} data-testid="rm-prev" onClick={() => setOffset(Math.max(0, offset - limit))}>← Previous</button>
          <button className="btn small" disabled={pageTo >= page.total} data-testid="rm-next" onClick={() => setOffset(offset + limit)}>Next →</button>
        </div>
      )}

      {openId && (
        <ResponseEditor surveyDbId={s.surveyDbId} def={s.def} responseId={openId}
          onClose={() => setOpenId(null)}
          onSaved={(msg) => { say(msg); void load(); }} />
      )}
      {importOpen && (
        <ImportDialog surveyDbId={s.surveyDbId} environment={environment === "ALL" ? "TEST" : environment}
          onClose={() => setImportOpen(false)}
          onDone={(msg) => { setImportOpen(false); say(msg); void load(); }} />
      )}
      {confirm && (
        <ConfirmDelete confirm={confirm} environment={environment} bin={bin}
          onChange={(c) => setConfirm(c)} onCancel={() => setConfirm(null)} onRun={runDelete} />
      )}
    </div>
  );
}

/* ================================================================ one cell */

/**
 * A cell the researcher can change in place.
 *
 * Only where a single answer maps to a single value: a scalar question, or one
 * row of a grid. Anything with an internal shape (a ranking, an allocation, a
 * repeating group) opens the full editor instead of pretending a text box is
 * enough. The save goes through the same validated PATCH as the editor.
 */
function Cell({ rec, column, def, disabled, surveyDbId, onSaved, onError }: {
  rec: Rec; column: string; def: SurveyDefinition; disabled?: boolean; surveyDbId: string;
  onSaved(msg: string): void; onError(msg: string): void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const text = fmt(rec.vars[column]);

  // which question (and grid row) does this column belong to?
  const target = React.useMemo(() => {
    for (const q of def.questions) {
      if (q.variableName === column) return { q, rowCode: undefined as string | undefined };
      for (const r of q.rows ?? []) if (`${q.variableName}_${r.code}` === column) return { q, rowCode: String(r.code) };
    }
    return null;
  }, [def, column]);

  const editable = !disabled && !!target && isSimple(target.q, target.rowCode);

  const start = () => {
    if (!editable || !target) return;
    const raw = target.rowCode
      ? (rec.answers[target.q.id] as Record<string, unknown> | undefined)?.[target.rowCode]
      : rec.answers[target.q.id];
    setValue(raw === undefined || raw === null ? "" : String(raw));
    setEditing(true);
  };

  const commit = async () => {
    if (!target) return;
    const before = target.rowCode
      ? (rec.answers[target.q.id] as Record<string, unknown> | undefined)?.[target.rowCode]
      : rec.answers[target.q.id];
    const next = value === "" ? undefined : coerceCell(target.q, value);
    if (String(before ?? "") === String(next ?? "")) { setEditing(false); return; }
    setBusy(true);
    try {
      const answers: Record<string, unknown> = target.rowCode
        ? { [target.q.id]: { ...((rec.answers[target.q.id] as Record<string, unknown>) ?? {}), [target.rowCode]: next } }
        : { [target.q.id]: next };
      if (target.rowCode && next === undefined) delete (answers[target.q.id] as Record<string, unknown>)[target.rowCode];
      const r = await fetch(`/api/surveys/${surveyDbId}/data/${rec.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers, expectedRevision: rec.revision, reason: "edited in the data grid" }),
      });
      const j = await r.json();
      if (!r.ok) { onError(j.issues?.[0]?.message ?? j.error ?? `The change was not saved (${r.status})`); return; }
      setEditing(false);
      onSaved(j.unchanged ? "No change." : `${rec.respondentCode ?? "Response"} · ${column} saved.`);
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (editing && target) {
    const opts = target.q.options ?? [];
    return (
      <td className="rm-cell editing">
        {opts.length > 0 ? (
          <select className="select" autoFocus data-testid="rm-cell-input" value={value} disabled={busy}
            onChange={(e) => setValue(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); if (e.key === "Enter") void commit(); }}>
            <option value="">— empty —</option>
            {opts.map((o) => <option key={String(o.code)} value={String(o.code)}>{o.code}: {stripTags(o.label)}</option>)}
          </select>
        ) : (
          <input className="input" autoFocus data-testid="rm-cell-input" value={value} disabled={busy}
            onChange={(e) => setValue(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); if (e.key === "Enter") void commit(); }} />
        )}
      </td>
    );
  }
  return (
    <td className={`rm-cell ${editable ? "editable" : ""}`} data-testid="rm-cell" title={editable ? "Click to edit" : text}
      onClick={editable ? start : undefined}>
      {text}
    </td>
  );
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").trim();

/** Can this answer be represented by one value in one box? */
function isSimple(q: Question, rowCode?: string): boolean {
  const t = String(q.type);
  if (rowCode) return /^matrix_(single|numeric|text|dropdown)$/.test(t);
  return /^(single_select|dropdown|numeric|open_text|long_text|date|time|slider|nps|image_select|hidden)$/.test(t);
}

function coerceCell(q: Question, raw: string): unknown {
  const t = String(q.type);
  if (/^(numeric|slider|nps|matrix_numeric)$/.test(t)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

/* ================================================================ full editor */

/**
 * The full response editor: every answer, by its own question type, so an
 * edit can only ever produce a value the survey itself would accept — and the
 * server validates it again with the runtime's validator before storing it.
 * `expectedRevision` makes a stale editor fail loudly instead of overwriting
 * a newer change.
 */
function ResponseEditor({ surveyDbId, def, responseId, onClose, onSaved }: {
  surveyDbId: string; def: SurveyDefinition; responseId: string; onClose(): void; onSaved(msg: string): void;
}) {
  const [data, setData] = React.useState<any | null>(null);
  const [draft, setDraft] = React.useState<Record<string, unknown>>({});
  const [issues, setIssues] = React.useState<{ code: string; message: string }[]>([]);
  const [conflict, setConflict] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState<"answers" | "audit">("answers");
  const [reason, setReason] = React.useState("");

  const load = React.useCallback(async () => {
    const r = await fetch(`/api/surveys/${surveyDbId}/data/${responseId}`, { cache: "no-store" });
    const j = await r.json();
    if (r.ok) { setData(j); setDraft({}); setIssues([]); setConflict(null); }
  }, [surveyDbId, responseId]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rec = data?.response;
  const answers: Record<string, unknown> = { ...(rec?.answers ?? {}), ...draft };
  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    setBusy(true); setIssues([]); setConflict(null);
    try {
      const r = await fetch(`/api/surveys/${surveyDbId}/data/${responseId}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: draft, expectedRevision: rec.revision, reason: reason || undefined }),
      });
      const j = await r.json();
      if (r.status === 409) { setConflict(j.error ?? "This response changed elsewhere."); return; }
      if (r.status === 422) { setIssues((j.issues ?? []).map((i: any) => ({ code: i.code, message: i.message }))); return; }
      if (!r.ok) { setIssues([{ code: "", message: j.error ?? `Save failed (${r.status})` }]); return; }
      onSaved(j.unchanged ? "No change to save." : `${rec.respondentCode ?? "Response"} saved (${j.changed.length} answer${j.changed.length === 1 ? "" : "s"} changed).`);
      await load();
    } catch (e) { setIssues([{ code: "", message: (e as Error).message }]); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal rm-editor" role="dialog" aria-modal="true" data-testid="rm-editor" onClick={(e) => e.stopPropagation()}>
        {!rec ? <p className="muted">Loading…</p> : (
          <>
            <div className="row" style={{ alignItems: "center", gap: 10 }}>
              <h2 style={{ fontSize: 15, margin: 0 }}>
                <span className="mono">{rec.respondentCode ?? rec.sessionId.slice(0, 12)}</span>
              </h2>
              <span className={`chip ${rec.environment === "TEST" ? "warn" : "on"}`} data-testid="rm-editor-env">{rec.environment}</span>
              <span className={`chip ${STATUS_CHIP[rec.status] ?? ""}`}>{rec.status.replace("_", " ")}</span>
              <span className="chip" title="Every save increases this; an edit made against an older revision is refused">rev {rec.revision}</span>
              {rec.deletedAt && <span className="chip warn">deleted {when(rec.deletedAt)}</span>}
              <span className="grow" />
              <button className="btn small" onClick={onClose}>Close</button>
            </div>
            <div className="qd-config-source" style={{ marginTop: 4 }}>
              Started {when(rec.startedAt)} · {rec.completedAt ? `completed ${when(rec.completedAt)}` : "not completed"} · last changed {when(rec.updatedAt)} · source {rec.source}
              {rec.quality ? ` · quality ${rec.quality.qualityScore}/100, risk ${rec.quality.riskScore}/100 (${rec.quality.classification.replace("_", " ")})` : ""}
            </div>

            <div className="row" style={{ gap: 4, margin: "10px 0 6px" }}>
              <button className={`btn small ${tab === "answers" ? "primary" : ""}`} onClick={() => setTab("answers")}>Answers</button>
              <button className={`btn small ${tab === "audit" ? "primary" : ""}`} data-testid="rm-editor-audit-tab" onClick={() => setTab("audit")}>
                History{data.edits?.length ? ` (${data.edits.length})` : ""}
              </button>
            </div>

            {conflict && (
              <div className="chip warn qd-note" data-testid="rm-editor-conflict">
                {conflict} <button className="btn small" style={{ marginLeft: 6 }} onClick={() => void load()}>Reload this response</button>
              </div>
            )}
            {issues.length > 0 && (
              <div className="card rm-issues" data-testid="rm-editor-issues">
                <strong style={{ color: "var(--red)", fontSize: 12 }}>Not saved — the survey does not accept this:</strong>
                <ul>{issues.map((i, n) => <li key={n}>{i.code ? <span className="mono">{i.code}</span> : null} {i.message}</li>)}</ul>
              </div>
            )}

            {tab === "answers" ? (
              <>
                <div className="rm-answers">
                  {def.questions.map((q) => (
                    <AnswerField key={q.id} q={q} value={answers[q.id]} disabled={!!rec.deletedAt}
                      onChange={(v) => setDraft((d) => ({ ...d, [q.id]: v }))} />
                  ))}
                  {!def.questions.length && <p className="muted">This survey has no questions yet.</p>}
                </div>
                {Object.keys(rec.calculated ?? {}).length > 0 && (
                  <details className="qs-details">
                    <summary>Calculated &amp; embedded values ({Object.keys(rec.calculated).length + Object.keys(rec.embedded ?? {}).length})</summary>
                    <table className="grid qs-sysvars"><tbody>
                      {Object.entries({ ...(rec.calculated ?? {}), ...(rec.embedded ?? {}) }).map(([k, v]) => (
                        <tr key={k}><td className="mono">{k}</td><td>{fmt(v)}</td></tr>
                      ))}
                    </tbody></table>
                  </details>
                )}
                <div className="rm-editor-foot">
                  <input className="input" style={{ maxWidth: 320 }} data-testid="rm-editor-reason" placeholder="Why (kept in the history)" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <span className="grow" />
                  {dirty && <span className="muted" style={{ fontSize: 11 }}>{Object.keys(draft).length} answer{Object.keys(draft).length === 1 ? "" : "s"} changed</span>}
                  <button className="btn small" onClick={() => setDraft({})} disabled={!dirty || busy}>Discard</button>
                  <button className="btn small primary" data-testid="rm-editor-save" onClick={save} disabled={!dirty || busy || !!rec.deletedAt}>
                    {busy ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </>
            ) : (
              <div className="table-wrap" data-testid="rm-editor-audit">
                <table className="grid">
                  <thead><tr><th>When</th><th>What</th><th>Change</th><th>By</th><th>Why</th></tr></thead>
                  <tbody>
                    {(data.edits ?? []).map((e: any, i: number) => (
                      <tr key={i}>
                        <td>{when(e.edited_at)}</td>
                        <td>{String(e.action).replace("_", " ")}</td>
                        <td>{e.changes ? changeSummary(def, e.changes) : "—"}</td>
                        <td>{e.edited_by}</td>
                        <td>{e.reason ?? ""}</td>
                      </tr>
                    ))}
                    {!data.edits?.length && <tr><td colSpan={5} className="muted">No edits — this response is as it was submitted.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function changeSummary(def: SurveyDefinition, changes: Record<string, any>): string {
  if (changes.before || changes.after) {
    const before = Object.keys(changes.before ?? {}).length;
    const after = Object.keys(changes.after ?? {}).length;
    return `${after} answer${after === 1 ? "" : "s"} written${before ? ` (was ${before})` : ""}`;
  }
  return Object.entries(changes).map(([qid, c]) => {
    const q = def.questions.find((x) => x.id === qid);
    return `${q?.code ?? qid}: ${fmt(c?.from) || "—"} → ${fmt(c?.to) || "—"}`;
  }).join("; ");
}

/* ---------------------------------------------------------- one answer field */

/** One answer, edited the way its question type is answered. */
function AnswerField({ q, value, disabled, onChange }: { q: Question; value: unknown; disabled?: boolean; onChange(v: unknown): void }) {
  const t = String(q.type);
  const opts = q.options ?? [];
  const label = (
    <span className="rm-q">
      <span className="mono">{q.code}</span> <span className="rm-qtext">{stripTags(q.text ?? "")}</span>
      <span className="chip">{t.replace(/_/g, " ")}</span>
    </span>
  );
  const wrap = (control: React.ReactNode) => (
    <label className="rm-field" data-testid={`rm-field-${q.code}`}>{label}{control}</label>
  );

  if (/^(single_select|dropdown|image_select)$/.test(t) && opts.length) {
    return wrap(
      <select className="select" disabled={disabled} data-testid="rm-answer" value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}>
        <option value="">— no answer —</option>
        {opts.map((o) => <option key={String(o.code)} value={String(o.code)}>{o.code}: {stripTags(o.label)}</option>)}
      </select>,
    );
  }
  if (/^(multi_select|multi_dropdown)$/.test(t) && opts.length) {
    const arr = Array.isArray(value) ? value.map(String) : [];
    return wrap(
      <div className="qs-chips" data-testid="rm-answer">
        {opts.map((o) => (
          <label key={String(o.code)} className={`chip qs-chip-check ${arr.includes(String(o.code)) ? "on" : ""}`}>
            <input type="checkbox" disabled={disabled} checked={arr.includes(String(o.code))}
              onChange={(e) => {
                const next = e.target.checked ? [...arr, String(o.code)] : arr.filter((c) => c !== String(o.code));
                onChange(next.length ? next : undefined);
              }} /> {o.code}: {stripTags(o.label)}
          </label>
        ))}
      </div>,
    );
  }
  if (/^matrix_/.test(t) && (q.rows?.length ?? 0) > 0) {
    const cells = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
    const multi = t === "matrix_multi";
    return wrap(
      <div className="rm-matrix" data-testid="rm-answer">
        {(q.rows ?? []).map((r) => {
          const rc = String(r.code);
          const cur = cells[rc];
          return (
            <div key={rc} className="rm-matrix-row">
              <span className="rm-matrix-label">{stripTags(r.label)}</span>
              {t === "matrix_numeric" ? (
                <input className="input" type="number" disabled={disabled} value={cur === undefined || cur === null ? "" : String(cur)}
                  onChange={(e) => onChange(setCell(cells, rc, e.target.value === "" ? undefined : Number(e.target.value)))} />
              ) : t === "matrix_text" ? (
                <input className="input" disabled={disabled} value={cur === undefined || cur === null ? "" : String(cur)}
                  onChange={(e) => onChange(setCell(cells, rc, e.target.value || undefined))} />
              ) : multi ? (
                <div className="qs-chips">
                  {opts.map((o) => {
                    const arr = Array.isArray(cur) ? cur.map(String) : [];
                    return (
                      <label key={String(o.code)} className={`chip qs-chip-check ${arr.includes(String(o.code)) ? "on" : ""}`}>
                        <input type="checkbox" disabled={disabled} checked={arr.includes(String(o.code))}
                          onChange={(e) => {
                            const next = e.target.checked ? [...arr, String(o.code)] : arr.filter((c) => c !== String(o.code));
                            onChange(setCell(cells, rc, next.length ? next : undefined));
                          }} /> {o.code}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <select className="select" disabled={disabled} value={cur === undefined || cur === null ? "" : String(cur)}
                  onChange={(e) => onChange(setCell(cells, rc, e.target.value === "" ? undefined : e.target.value))}>
                  <option value="">—</option>
                  {opts.map((o) => <option key={String(o.code)} value={String(o.code)}>{o.code}: {stripTags(o.label)}</option>)}
                </select>
              )}
            </div>
          );
        })}
      </div>,
    );
  }
  if (/^(numeric|slider|nps)$/.test(t)) {
    return wrap(
      <input className="input" type="number" disabled={disabled} data-testid="rm-answer" value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />,
    );
  }
  if (t === "date" || t === "time") {
    return wrap(
      <input className="input" type={t} disabled={disabled} data-testid="rm-answer" value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value || undefined)} />,
    );
  }
  if (t === "long_text") {
    return wrap(
      <textarea className="ta" disabled={disabled} data-testid="rm-answer" rows={3} value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value || undefined)} />,
    );
  }
  if (/^(open_text|hidden)$/.test(t)) {
    return wrap(
      <input className="input" disabled={disabled} data-testid="rm-answer" value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value || undefined)} />,
    );
  }
  // everything with its own internal shape (ranking, allocation, upload,
  // repeating group, annotation…) is edited as the value it actually is,
  // rather than through a control that would quietly reshape it
  return wrap(
    <JsonField value={value} disabled={disabled} onChange={onChange} />,
  );
}

function setCell(cells: Record<string, unknown>, rowCode: string, v: unknown): Record<string, unknown> {
  const next = { ...cells };
  if (v === undefined) delete next[rowCode]; else next[rowCode] = v;
  return next;
}

/** A value edited as JSON, refused until it parses. */
function JsonField({ value, disabled, onChange }: { value: unknown; disabled?: boolean; onChange(v: unknown): void }) {
  const [text, setText] = React.useState(() => (value === undefined ? "" : JSON.stringify(value, null, 1)));
  const [bad, setBad] = React.useState(false);
  return (
    <>
      <textarea className="ta mono" rows={3} disabled={disabled} data-testid="rm-answer" value={text}
        style={bad ? { borderColor: "var(--red)" } : undefined}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === "") { setBad(false); onChange(undefined); return; }
          try { onChange(JSON.parse(e.target.value)); setBad(false); } catch { setBad(true); }
        }} />
      {bad && <span className="qs-help err">Not valid JSON yet — the value is unchanged until it is.</span>}
    </>
  );
}

/* ================================================================ confirm */

interface PendingDelete {
  kind: "filter" | "selection" | "one";
  count: number;
  ids?: string[];
  label: string;
  reason: string;
  purge?: boolean;
}

function ConfirmDelete({ confirm, environment, bin, onChange, onCancel, onRun }: {
  confirm: PendingDelete; environment: Env; bin: boolean;
  onChange(c: PendingDelete): void; onCancel(): void; onRun(): void;
}) {
  const restoring = bin && !confirm.purge;
  const purging = !!confirm.purge;
  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal rm-confirm" role="dialog" aria-modal="true" data-testid="rm-confirm" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontSize: 15, marginTop: 0 }}>
          {restoring ? "Restore" : purging ? "Delete permanently" : "Delete"} {confirm.count === 1 ? confirm.label : `${confirm.count} responses`}?
        </h2>
        <p style={{ fontSize: 13 }}>
          {restoring ? <>They will return to the <strong>{environment}</strong> dataset and be counted again.</>
            : purging ? <>This removes {confirm.count === 1 ? "the response" : `${confirm.count} responses`} from the database for good. Only responses already in the recycle bin can be removed this way, and it cannot be undone.</>
              : <>
                {confirm.count === 1 ? "This response" : `These ${confirm.count} responses`} will be removed from the <strong>{environment}</strong> dataset,
                from exports and from quota counts. Nothing is erased: the data stays in the recycle bin and can be restored,
                and the deletion is recorded with your reason.
              </>}
        </p>
        <div className="rm-confirm-facts">
          <span className="chip">Environment: {environment}</span>
          <span className="chip">{confirm.count} response{confirm.count === 1 ? "" : "s"}</span>
          {confirm.kind === "filter" && <span className="chip">matched by filter</span>}
        </div>
        {!restoring && !purging && (
          <label className="f" style={{ marginTop: 10 }}><span>Reason (kept in the audit trail)</span>
            <input className="input" data-testid="rm-confirm-reason" autoFocus value={confirm.reason}
              placeholder="e.g. test responses from a dry run"
              onChange={(e) => onChange({ ...confirm, reason: e.target.value })} /></label>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <span className="grow" />
          <button className="btn small" onClick={onCancel} data-testid="rm-confirm-cancel">Cancel</button>
          <button className={`btn small ${restoring ? "primary" : "danger"}`} data-testid="rm-confirm-run" onClick={onRun}>
            {restoring ? `Restore ${confirm.count}` : purging ? `Delete ${confirm.count} permanently` : `Delete ${confirm.count} response${confirm.count === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================================================================ import */

/**
 * Import: choose a file (or paste), check the mapping, look at the preview,
 * then commit. The commit sends back the rows the preview prepared, so what
 * is written is exactly what was shown — and it is one transaction, so a file
 * that fails writes nothing at all.
 */
function ImportDialog({ surveyDbId, environment, onClose, onDone }: {
  surveyDbId: string; environment: "TEST" | "LIVE"; onClose(): void; onDone(msg: string): void;
}) {
  const [text, setText] = React.useState("");
  const [format, setFormat] = React.useState<"csv" | "json">("csv");
  const [mode, setMode] = React.useState<"upsert" | "create" | "update">("upsert");
  const [preview, setPreview] = React.useState<any | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);

  const runPreview = async (mapping?: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/surveys/${surveyDbId}/data/import`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ environment, stage: "preview", format, text, mode, mapping }),
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? `Could not read the file (${r.status})`); setPreview(null); return; }
      setPreview(j);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/surveys/${surveyDbId}/data/import`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ environment, stage: "commit", mode, rows: preview.rows }),
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? `The import failed (${r.status}) — nothing was written.`); return; }
      onDone(`Imported into ${environment}: ${j.created ?? 0} created, ${j.updated ?? 0} updated${j.skipped ? `, ${j.skipped} skipped` : ""}.${j.quotas ? " Quota counts were recalculated." : ""}`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const onFile = async (f: File) => {
    setFileName(f.name);
    setFormat(/\.json$/i.test(f.name) ? "json" : "csv");
    const t = await f.text();
    setText(t);
    setPreview(null);
  };

  const sum = preview?.summary;
  const canCommit = !!preview && sum?.valid > 0 && !preview.blocking;

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal rm-import" role="dialog" aria-modal="true" data-testid="rm-import" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ alignItems: "center" }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Import responses</h2>
          <span className={`chip ${environment === "TEST" ? "warn" : "on"}`}>into {environment} data</span>
          <span className="grow" />
          <button className="btn small" onClick={onClose}>Close</button>
        </div>
        <p className="qs-help">
          CSV, TSV or JSON. A file exported from this survey maps itself; anything else is matched by variable name, question code
          or question text. Existing respondent ids are <strong>updated in place</strong> — never duplicated — and an update
          changes only the columns the file contains. Nothing is written until you confirm the preview.
        </p>

        <div className="rm-import-controls">
          <label className="btn small" style={{ cursor: "pointer" }}>
            Choose file…
            <input type="file" accept=".csv,.tsv,.txt,.json" style={{ display: "none" }} data-testid="rm-import-file"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
          </label>
          {fileName && <span className="chip mono">{fileName}</span>}
          <select className="select" style={{ width: 110 }} value={format} onChange={(e) => { setFormat(e.target.value as never); setPreview(null); }}>
            <option value="csv">CSV / TSV</option><option value="json">JSON</option>
          </select>
          <select className="select" style={{ width: 190 }} data-testid="rm-import-mode" value={mode} onChange={(e) => { setMode(e.target.value as never); setPreview(null); }}>
            <option value="upsert">Upsert — update or create</option>
            <option value="create">Create new responses only</option>
            <option value="update">Update existing only</option>
          </select>
          <span className="grow" />
          <button className="btn small primary" data-testid="rm-import-preview" disabled={!text.trim() || busy} onClick={() => void runPreview()}>
            {busy && !preview ? "Reading…" : "Validate & preview"}
          </button>
        </div>
        <textarea className="ta mono" rows={preview ? 3 : 8} data-testid="rm-import-text" placeholder="…or paste the rows here"
          value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} />

        {error && <div className="chip warn qd-note" data-testid="rm-import-error">{error}</div>}

        {preview && (
          <div data-testid="rm-import-preview-out">
            <div className="rm-import-summary">
              <span className="chip">Rows detected {sum.detected}</span>
              <span className="chip on" data-testid="rm-import-valid">Valid {sum.valid}</span>
              {sum.warnings > 0 && <span className="chip warn">Warnings {sum.warnings}</span>}
              {sum.errors > 0 && <span className="chip warn" data-testid="rm-import-errors">Errors {sum.errors}</span>}
              {sum.duplicates > 0 && <span className="chip warn">Duplicates {sum.duplicates}</span>}
              <span className="chip">Will create {sum.willCreate}</span>
              <span className="chip">Will update {sum.willUpdate}</span>
            </div>
            {preview.blocking && <div className="chip warn qd-note" data-testid="rm-import-blocking">{preview.blocking}</div>}

            <details className="qs-details" open={preview.unmapped?.length > 0}>
              <summary>Column mapping{preview.unmapped?.length ? ` — ${preview.unmapped.length} column${preview.unmapped.length === 1 ? "" : "s"} not mapped` : ""}</summary>
              <div className="table-wrap" style={{ maxHeight: 220 }}>
                <table className="grid" data-testid="rm-import-mapping">
                  <thead><tr><th>File column</th><th>Survey target</th></tr></thead>
                  <tbody>
                    {(preview.headers ?? []).map((h: string) => {
                      const t = preview.mapping?.[h] ?? { kind: "ignore" };
                      const val = t.kind === "question" ? `q:${t.questionId}${t.rowCode ? `@${t.rowCode}` : ""}` : t.kind === "embedded" ? `e:${t.name}` : t.kind;
                      return (
                        <tr key={h}>
                          <td className="mono">{h}</td>
                          <td>
                            <select className="select" data-testid={`rm-map-${h}`} value={val}
                              onChange={(e) => {
                                const v = e.target.value;
                                let target: Record<string, unknown> = { kind: v };
                                if (v.startsWith("q:")) {
                                  const [qid, rowCode] = v.slice(2).split("@");
                                  target = { kind: "question", questionId: qid, ...(rowCode ? { rowCode } : {}) };
                                } else if (v.startsWith("e:")) target = { kind: "embedded", name: v.slice(2) };
                                void runPreview({ ...preview.mapping, [h]: target });
                              }}>
                              <option value="ignore">— ignore this column —</option>
                              <option value="respondent_code">Respondent id</option>
                              <option value="session_id">Session id</option>
                              <option value="status">Status</option>
                              <option value="started_at">Started at</option>
                              <option value="completed_at">Completed at</option>
                              <optgroup label="Questions">
                                {(preview.questions ?? []).flatMap((q: any) => [
                                  <option key={q.id} value={`q:${q.id}`}>{q.code} — {q.variableName}</option>,
                                  ...(q.rows ?? []).map((r: any) => <option key={`${q.id}@${r.code}`} value={`q:${q.id}@${r.code}`}>{q.code} · row {r.code}</option>),
                                ])}
                              </optgroup>
                              {preview.embedded?.length > 0 && (
                                <optgroup label="Embedded data">
                                  {preview.embedded.map((n: string) => <option key={n} value={`e:${n}`}>{n}</option>)}
                                </optgroup>
                              )}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>

            {preview.issues?.length > 0 && (
              <details className="qs-details" open>
                <summary>{preview.issues.length} problem{preview.issues.length === 1 ? "" : "s"} to look at{preview.issuesTruncated ? " (first 500)" : ""}</summary>
                <div className="table-wrap" style={{ maxHeight: 220 }}>
                  <table className="grid">
                    <thead><tr><th>Row</th><th>Column</th><th>Value</th><th>Expected</th><th>Problem</th></tr></thead>
                    <tbody>
                      {preview.issues.map((i: any, n: number) => (
                        <tr key={n} data-testid="rm-import-issue">
                          <td>{i.row}</td><td className="mono">{i.column}</td><td>{fmt(i.value)}</td><td>{i.expected}</td>
                          <td style={{ color: i.severity === "error" ? "var(--red)" : "var(--amber)" }}>{i.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {sum.errors > 0 && <p className="qs-help">Rows with an error are not imported. Fix them in the file and preview again, or import the {sum.valid} valid row{sum.valid === 1 ? "" : "s"} now.</p>}
              </details>
            )}

            <div className="row" style={{ marginTop: 10 }}>
              <span className="muted" style={{ fontSize: 11 }}>
                {canCommit ? `${sum.valid} row${sum.valid === 1 ? "" : "s"} ready — ${sum.willCreate} created, ${sum.willUpdate} updated, in one transaction.` : "Nothing to import yet."}
              </span>
              <span className="grow" />
              <button className="btn small" onClick={onClose}>Cancel</button>
              <button className="btn small primary" data-testid="rm-import-commit" disabled={!canCommit || busy} onClick={commit}>
                {busy ? "Importing…" : `Import ${sum.valid} response${sum.valid === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
