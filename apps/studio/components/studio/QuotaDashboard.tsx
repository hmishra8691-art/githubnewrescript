"use client";
import React from "react";
import { questionTypeRegistry } from "@rescript/schema";
import type { Quota } from "@rescript/schema";
import {
  QUOTA_STATE_LABEL, filterQuotas, quotaDashboard, quotaEditDiff, sortQuotas, validateQuotaEdit,
  type QuotaCellRow, type QuotaEdit, type QuotaEditIssue, type QuotaFilter, type QuotaRow, type QuotaSort, type QuotaState,
} from "@rescript/engine";
import { useStudio, uid } from "./store";
import { QuotasPanel } from "./QuotasPanel";

/**
 * QUOTA DASHBOARD — the management layer over the existing quota system.
 *
 *   Quota Logic Builder (QuotasPanel, unchanged)
 *         ↓ writes def.quotas
 *   Quota configuration  +  quota_counts (the runtime's counters)
 *         ↓ quotaDashboard() — one pure function in the engine
 *   THIS VIEW: monitor · search / filter / sort · inline numeric edit · delete
 *
 * Nothing here is a second quota store. Every number is derived from the
 * definition in the Studio store and the counters the runtime writes, with
 * the same `effectiveLimit` the router uses. Numeric edits go through
 * `s.update()` — the same path as the Logic Builder — and are persisted by the
 * ordinary definition autosave, flushed immediately so "Save" can report
 * success or failure truthfully. Each saved change is also recorded in the
 * audit log with its before/after values.
 */

type Env = "TEST" | "LIVE";
type View = "cards" | "table";
type Mode = { kind: "dashboard" } | { kind: "logic"; focusQuotaId?: string };

interface CellDraft { cellId: string; label: string; limit: string; target: string; limitType: "count" | "percent" }
interface Draft { quotaId: string; name: string; targetTotal: string; cells: CellDraft[] }

const REFRESH_MS = 30_000;

const stateChipClass = (state: QuotaState) =>
  state === "FULL" ? "qd-state full" : state === "NEAR_FULL" ? "qd-state near" : state === "ACTIVE" ? "qd-state active" : state === "UNLIMITED" ? "qd-state unlimited" : "qd-state inactive";

function relative(iso?: string): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(iso).toLocaleDateString();
}

function Bar({ pct, state }: { pct: number | null; state: QuotaState }) {
  if (pct == null) return <div className="qbar qd-bar"><div className="unlimited" style={{ width: "100%" }} /></div>;
  return (
    <div className="qbar qd-bar" role="progressbar" aria-valuenow={Math.min(100, pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={state === "FULL" ? "full" : state === "NEAR_FULL" ? "near" : ""} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

const fmtPct = (pct: number | null) => (pct == null ? "—" : `${Math.round(pct)}%`);
const typeLabel = (type: string) => questionTypeRegistry.get(type)?.label ?? type;

export function QuotaDashboard() {
  const s = useStudio();
  const [mode, setMode] = React.useState<Mode>({ kind: "dashboard" });
  const [env, setEnv] = React.useState<Env>("TEST");
  const [counts, setCounts] = React.useState<Record<string, Record<string, number>>>({});
  const [updatedAt, setUpdatedAt] = React.useState<Record<string, string>>({});
  const [fetchedAt, setFetchedAt] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [view, setView] = React.useState<View>("cards");
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<QuotaFilter>("all");
  const [sort, setSort] = React.useState<QuotaSort>("status");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("asc");
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [issues, setIssues] = React.useState<{ errors: QuotaEditIssue[]; warnings: QuotaEditIssue[] } | null>(null);
  const [overCapAccepted, setOverCapAccepted] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState<{ quotaId: string; removeRefs: boolean } | null>(null);
  const [detail, setDetail] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = React.useState<null | "recount">(null);

  /* ------------------------------------------------------------ counts */

  const sandbox = s.surveyDbId === "sandbox";
  const refresh = React.useCallback(async () => {
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/quotas?environment=${env}`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { if (!sandbox) setLoadError(d.error ?? `Could not load quota counts (${r.status})`); return; }
      setCounts(d.counts ?? {});
      setUpdatedAt(d.updatedAt ?? {});
      setFetchedAt(d.fetchedAt ?? new Date().toISOString());
      setLoadError(null);
    } catch (e) { setLoadError((e as Error).message); }
  }, [s.surveyDbId, env, sandbox]);

  React.useEffect(() => { void refresh(); }, [refresh]);
  // live counts: poll while the tab is visible — the counters move as respondents complete
  React.useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") void refresh(); };
    const t = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [refresh]);

  const recount = async () => {
    setBusy("recount"); setNote(null);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/quotas/recount`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ environment: env }) });
      const j = await r.json();
      if (!r.ok) setNote({ text: j.error ?? `Recount failed (${r.status})`, ok: false });
      else { setNote({ text: `Recounted ${env.toLowerCase()} counters from ${j.results?.[env]?.responses ?? 0} completed responses.`, ok: true }); await refresh(); }
    } catch (e) { setNote({ text: (e as Error).message, ok: false }); }
    finally { setBusy(null); }
  };

  /* ------------------------------------------------------------ model */

  const dash = React.useMemo(() => quotaDashboard(s.def, counts, { updatedAt }), [s.def, counts, updatedAt]);
  const rows = React.useMemo(() => sortQuotas(filterQuotas(dash.quotas, search, filter), sort, sortDir), [dash, search, filter, sort, sortDir]);
  const quotaById = (id: string) => s.def.quotas.find((q) => q.id === id);

  /* ------------------------------------------------------------ editing */

  const dirty = draft != null;
  React.useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
  const confirmDiscard = () => !dirty || window.confirm("You have unsaved quota changes. Discard them?");
  // the leftnav asks before switching panels while an inline edit is open
  React.useEffect(() => {
    s.setLeaveGuard(dirty ? () => window.confirm("You have unsaved quota changes. Discard them?") : null);
    return () => s.setLeaveGuard(null);
  }, [dirty, s]);

  const beginEdit = (q: Quota) => {
    if (s.readOnly) { s.toast(s.readOnlyReason ?? "This project is read-only.", "err"); return; }
    if (!confirmDiscard()) return;
    setIssues(null); setOverCapAccepted(false);
    setDraft({
      quotaId: q.id, name: q.name, targetTotal: q.targetTotal == null ? "" : String(q.targetTotal),
      cells: q.cells.map((c) => ({ cellId: c.id, label: c.label, limit: String(c.limit), target: c.target == null ? "" : String(c.target), limitType: c.limitType })),
    });
  };
  const cancelEdit = () => { setDraft(null); setIssues(null); setOverCapAccepted(false); };

  const num = (v: string): number | null | undefined => {
    const t = v.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : Number.NaN;
  };
  const draftToEdit = (d: Draft, q: Quota): QuotaEdit => {
    const edit: QuotaEdit = { cells: [] };
    if (d.name !== q.name) edit.name = d.name;
    const tt = num(d.targetTotal);
    if (tt !== (q.targetTotal ?? null)) edit.targetTotal = tt === null ? null : (tt as number);
    for (const c of d.cells) {
      const orig = q.cells.find((x) => x.id === c.cellId); if (!orig) continue;
      const e: NonNullable<QuotaEdit["cells"]>[number] = { cellId: c.cellId };
      if (c.label !== orig.label) e.label = c.label;
      const lim = num(c.limit); if (lim !== orig.limit) e.limit = lim === null ? Number.NaN : (lim as number);
      const tgt = num(c.target); if (tgt !== (orig.target ?? null)) e.target = tgt === null ? null : (tgt as number);
      if (c.limitType !== orig.limitType) e.limitType = c.limitType;
      if (Object.keys(e).length > 1) edit.cells!.push(e);
    }
    return edit;
  };

  const save = async () => {
    if (!draft) return;
    if (s.readOnly) { setNote({ text: s.readOnlyReason ?? "This project is read-only. Your changes have not been applied.", ok: false }); return; }
    const q = quotaById(draft.quotaId); if (!q) { cancelEdit(); return; }
    const edit = draftToEdit(draft, q);
    const check = validateQuotaEdit(q, edit, counts);
    setIssues({ errors: check.errors, warnings: check.warnings });
    if (check.errors.length) return;
    if (check.warnings.length && !overCapAccepted) return; // needs the explicit "proceed"
    const diff = quotaEditDiff(q, check.next);
    if (!Object.keys(diff).length) { cancelEdit(); setNote({ text: "No changes to save.", ok: true }); return; }
    setSaving(true);
    s.labelNextEdit?.("quota dashboard edit");
    s.update((d) => { const i = d.quotas.findIndex((x) => x.id === q.id); if (i >= 0) d.quotas[i] = check.next; });
    const ok = await s.flushDraft();
    setSaving(false);
    if (!ok) {
      // the store still holds the edit; undo so what is on screen is what is on the server
      s.undo();
      const why = s.saveState.kind === "conflict" || s.saveState.kind === "lock_lost" || s.saveState.kind === "error" || s.saveState.kind === "signed_out" || s.saveState.kind === "unavailable"
        ? ` (${(s.saveState as { message?: string }).message ?? s.saveState.kind})` : "";
      setNote({ text: `Unable to save quota changes. Your changes have not been applied.${why}`, ok: false });
      return;
    }
    setNote({ text: "Quota updated successfully.", ok: true });
    cancelEdit();
    if (s.surveyDbId !== "sandbox") {
      void fetch(`/api/surveys/${s.surveyDbId}/quotas/audit`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "modified", quotaId: q.id, quotaName: check.next.name, changes: diff, environment: env, revision: s.currentRevision() }),
      }).catch(() => {});
    }
  };

  /* ------------------------------------------------------------ create / delete */

  const createQuota = () => {
    if (s.readOnly) { s.toast(s.readOnlyReason ?? "This project is read-only.", "err"); return; }
    if (!confirmDiscard()) return;
    const id = uid("quota");
    s.labelNextEdit?.("create quota");
    s.update((d) => {
      d.quotas.push({ id, name: `Quota ${d.quotas.length + 1}`, mode: "hard", cells: [], onFull: { kind: "terminate" }, countStatus: ["complete"] });
    });
    if (s.surveyDbId !== "sandbox") {
      void fetch(`/api/surveys/${s.surveyDbId}/quotas/audit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "created", quotaId: id, quotaName: `Quota ${s.def.quotas.length + 1}` }) }).catch(() => {});
    }
    setDraft(null);
    setMode({ kind: "logic", focusQuotaId: id });
  };

  const doDelete = async () => {
    if (!deleting) return;
    if (s.readOnly) { setDeleting(null); setNote({ text: s.readOnlyReason ?? "This project is read-only. Nothing was deleted.", ok: false }); return; }
    const q = quotaById(deleting.quotaId); if (!q) { setDeleting(null); return; }
    const row = dash.quotas.find((r) => r.id === q.id);
    s.labelNextEdit?.("delete quota");
    s.update((d) => {
      d.quotas = d.quotas.filter((x) => x.id !== q.id);
      if (deleting.removeRefs) {
        const strip = (nodes: any[]) => {
          for (const n of nodes ?? []) {
            if (n?.type === "quota_check") n.quotaIds = (n.quotaIds ?? []).filter((x: string) => x !== q.id);
            if (n?.children) strip(n.children);
            if (n?.otherwise) strip(n.otherwise);
            for (const b of n?.branches ?? []) strip(b.children);
          }
        };
        strip(d.flow as any[]);
        for (const lf of d.listFills) lf.tracking.quotaIds = lf.tracking.quotaIds.filter((x) => x !== q.id);
      }
    });
    const ok = await s.flushDraft();
    setDeleting(null);
    if (!ok) {
      s.undo();
      setNote({ text: "Unable to delete the quota. Nothing was changed.", ok: false });
      return;
    }
    setNote({ text: `Quota “${q.name}” deleted. Response data was not touched.`, ok: true });
    if (s.surveyDbId !== "sandbox") {
      void fetch(`/api/surveys/${s.surveyDbId}/quotas/audit`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "deleted", quotaId: q.id, quotaName: q.name, cells: q.cells.length, changes: { references: { before: row?.references ?? null, after: deleting.removeRefs ? "removed" : "kept" } }, revision: s.currentRevision() }),
      }).catch(() => {});
    }
  };

  /* ------------------------------------------------------------ logic builder */

  if (mode.kind === "logic") {
    return (
      <div data-testid="quota-logic-mode">
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn small" data-testid="quota-back-to-dashboard" onClick={() => { setMode({ kind: "dashboard" }); void refresh(); }}>← Back to dashboard</button>
          <span className="muted" style={{ fontSize: 12 }}>Quota Logic Builder — conditions, cells, modes and actions. Numbers can also be changed from the dashboard.</span>
        </div>
        <QuotasPanel focusQuotaId={mode.focusQuotaId} />
      </div>
    );
  }

  /* ------------------------------------------------------------ dashboard */

  const sum = dash.summary;
  const toggleExpand = (id: string) => setExpanded((x) => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const openLogic = (id?: string) => { if (!confirmDiscard()) return; setDraft(null); setMode({ kind: "logic", focusQuotaId: id }); };

  return (
    <div className="qd" data-testid="quota-dashboard">
      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Quota Dashboard</h2>
        <span className="grow" />
        <div className="row" style={{ gap: 4 }} data-testid="quota-env">
          {(["TEST", "LIVE"] as Env[]).map((e) => (
            <button key={e} className={`btn small ${env === e ? "primary" : ""}`} data-testid={`quota-env-${e}`}
              onClick={() => { if (confirmDiscard()) { setDraft(null); setEnv(e); } }}>{e === "TEST" ? "Test data" : "Live data"}</button>
          ))}
        </div>
        <button className="btn small" data-testid="quota-refresh" onClick={() => void refresh()}>↻ Refresh</button>
        <button className="btn small" data-testid="quota-recount" disabled={!!busy || s.surveyDbId === "sandbox"} onClick={recount}>{busy === "recount" ? "Recounting…" : "Recount from data"}</button>
        <button className="btn small" data-testid="quota-open-logic" onClick={() => openLogic()}>Logic Builder</button>
      </div>

      {/* ---------------------------------------------------- overview */}
      <div className="qd-summary" data-testid="quota-summary">
        <div className="qd-stat"><span className="qd-stat-n" data-testid="quota-total">{sum.total}</span><span className="qd-stat-l">Total quotas</span></div>
        <div className="qd-stat"><span className="qd-stat-n">{sum.byState.ACTIVE}</span><span className="qd-stat-l">Active</span></div>
        <div className="qd-stat"><span className="qd-stat-n near">{sum.byState.NEAR_FULL}</span><span className="qd-stat-l">Near full</span></div>
        <div className="qd-stat"><span className="qd-stat-n full">{sum.byState.FULL}</span><span className="qd-stat-l">Full</span></div>
        <div className="qd-stat"><span className="qd-stat-n muted">{sum.byState.INACTIVE + sum.byState.UNLIMITED}</span><span className="qd-stat-l">Inactive / unlimited</span></div>
        <div className="qd-stat"><span className="qd-stat-n" data-testid="quota-remaining-capacity">{sum.remainingCapacity}</span><span className="qd-stat-l">Remaining capacity</span></div>
        <div className="qd-stat wide">
          <span className="qd-stat-l">Overall utilization ({env.toLowerCase()} · {sum.currentTotal} / {sum.maximumTotal || "—"} across limited cells)</span>
          <Bar pct={sum.utilization} state={sum.utilization == null ? "UNLIMITED" : sum.utilization >= 100 ? "FULL" : sum.utilization >= 90 ? "NEAR_FULL" : "ACTIVE"} />
          <span className="mono" data-testid="quota-utilization">{sum.utilization == null ? "no maximums configured" : `${sum.utilization}%`}</span>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
        Counts are <strong>{env === "TEST" ? "test" : "live"}</strong> completes from the response data{fetchedAt ? ` · refreshed ${relative(fetchedAt)}` : ""} · auto-refreshes every 30 s.
        {loadError && <span className="chip warn" style={{ marginLeft: 8 }} data-testid="quota-load-error">{loadError}</span>}
      </div>
      {note && <div className={`chip ${note.ok ? "on" : "warn"} qd-note`} data-testid="quota-note">{note.text}</div>}

      {/* ---------------------------------------------------- toolbar */}
      <div className="row qd-toolbar" style={{ flexWrap: "wrap" }}>
        <button className="btn primary small" data-testid="quota-create" onClick={createQuota}>+ Create Quota</button>
        <input className="input qd-search" data-testid="quota-search" placeholder="Search quotas — name, question, variable, cell, condition…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="row" style={{ gap: 4 }}><span className="muted" style={{ fontSize: 11.5 }}>Filter</span>
          <select className="select" data-testid="quota-filter" value={filter} onChange={(e) => setFilter(e.target.value as QuotaFilter)}>
            <option value="all">All</option><option value="active">Active</option><option value="near_full">Near full</option>
            <option value="full">Full</option><option value="inactive">Inactive</option><option value="unlimited">Unlimited</option>
          </select></label>
        <label className="row" style={{ gap: 4 }}><span className="muted" style={{ fontSize: 11.5 }}>Sort</span>
          <select className="select" data-testid="quota-sort" value={sort} onChange={(e) => setSort(e.target.value as QuotaSort)}>
            <option value="status">Status (needs attention first)</option><option value="name">Quota name</option><option value="question">Question</option>
            <option value="current">Current count</option><option value="remaining">Remaining</option><option value="pct">% filled</option><option value="updated">Last updated</option>
          </select>
          <button className="btn small" title="reverse order" data-testid="quota-sort-dir" onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}>{sortDir === "asc" ? "↑" : "↓"}</button></label>
        <span className="grow" />
        <div className="row" style={{ gap: 4 }}>
          <button className={`btn small ${view === "cards" ? "primary" : ""}`} data-testid="quota-view-cards" onClick={() => setView("cards")}>Cards</button>
          <button className={`btn small ${view === "table" ? "primary" : ""}`} data-testid="quota-view-table" onClick={() => setView("table")}>Table</button>
        </div>
      </div>

      {dash.quotas.length === 0 && (
        <div className="card" data-testid="quota-empty">
          <div className="card-title">No quotas yet</div>
          <div className="muted" style={{ fontSize: 12.5 }}>Create a quota, then define its cells and conditions in the Logic Builder. Add a <em>quota check</em> node to the Survey Flow to enforce it.</div>
        </div>
      )}
      {dash.quotas.length > 0 && rows.length === 0 && <div className="card muted" data-testid="quota-no-match">No quotas match “{search}” with the current filter.</div>}

      {view === "table" ? (
        <TableView rows={rows} expanded={expanded} onToggle={toggleExpand} onEdit={(id) => { const q = quotaById(id); if (q) beginEdit(q); }} onLogic={openLogic} onDelete={(id) => setDeleting({ quotaId: id, removeRefs: true })} onDetail={setDetail} />
      ) : rows.map((row, i) => (
        <QuotaCard key={row.id} index={i + 1} row={row}
          expanded={expanded.has(row.id)} onToggle={() => toggleExpand(row.id)}
          draft={draft?.quotaId === row.id ? draft : null} setDraft={setDraft}
          issues={draft?.quotaId === row.id ? issues : null}
          overCapAccepted={overCapAccepted} setOverCapAccepted={setOverCapAccepted}
          saving={saving} onEdit={() => { const q = quotaById(row.id); if (q) beginEdit(q); }} onSave={save} onCancel={cancelEdit}
          onLogic={() => openLogic(row.id)} onDelete={() => setDeleting({ quotaId: row.id, removeRefs: true })} onDetail={() => setDetail(row.id)} />
      ))}

      {deleting && (() => {
        const row = dash.quotas.find((r) => r.id === deleting.quotaId); if (!row) return null;
        const refs = row.references;
        const nRefs = refs.quotaChecks.length + refs.listFills.length + refs.conditions.length;
        return (
          <div className="modal-back" onClick={() => setDeleting(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()} data-testid="quota-delete-confirm">
              <h3 style={{ marginTop: 0 }}>Delete “{row.name}”?</h3>
              <p>This will remove the quota configuration ({row.cells.length} cell{row.cells.length === 1 ? "" : "s"}) from this survey. It does <strong>not</strong> delete any responses, questions, variables or historical records — only the rule.</p>
              {nRefs > 0 && (
                <div className="chip warn qd-note" data-testid="quota-delete-refs">
                  This quota is currently referenced by{" "}
                  {[
                    ...refs.quotaChecks.map((c) => `quota check ${c.nodeId}`),
                    ...refs.listFills.map((l) => `List Fill ${l.name}${l.explicit ? "" : " (implicitly — it respects all hard quotas)"}`),
                    ...refs.conditions.map((c) => c.where),
                  ].join(", ")}. Deleting it may affect that programming.
                </div>
              )}
              {(refs.quotaChecks.length > 0 || refs.listFills.some((l) => l.explicit)) && (
                <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
                  <input type="checkbox" checked={deleting.removeRefs} onChange={(e) => setDeleting({ ...deleting, removeRefs: e.target.checked })} />
                  Also remove its id from those quota check nodes and List Fills (leaves no broken reference)
                </label>
              )}
              <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
                <button className="btn" onClick={() => setDeleting(null)}>Cancel</button>
                <button className="btn danger" data-testid="quota-delete-run" onClick={doDelete}>Delete Quota</button>
              </div>
            </div>
          </div>
        );
      })()}

      {detail && <QuotaDetail row={dash.quotas.find((r) => r.id === detail)} env={env} onClose={() => setDetail(null)} onLogic={() => { setDetail(null); openLogic(detail); }} />}
    </div>
  );
}

/* ================================================================ card */

function QuotaCard(p: {
  index: number; row: QuotaRow; expanded: boolean; onToggle: () => void;
  draft: Draft | null; setDraft: (d: Draft | null) => void; issues: { errors: QuotaEditIssue[]; warnings: QuotaEditIssue[] } | null;
  overCapAccepted: boolean; setOverCapAccepted: (v: boolean) => void; saving: boolean;
  onEdit: () => void; onSave: () => void; onCancel: () => void; onLogic: () => void; onDelete: () => void; onDetail: () => void;
}) {
  const { row, draft } = p;
  const complex = row.cells.length > 4 || row.dimensions >= 2;
  const showAll = !complex || p.expanded || !!draft;
  const cells = showAll ? row.cells : row.cells.slice(0, 3);
  const usesPercent = (draft ? draft.cells.some((c) => c.limitType === "percent") : row.cells.some((c) => c.limitType === "percent"));

  return (
    <div className={`card qd-card ${draft ? "editing" : ""}`} data-testid="quota-card" data-quota-id={row.id} data-state={row.state}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="grow">
          <div className="card-title">
            <span className="muted mono" style={{ fontSize: 12 }}>{p.index}.</span>
            {draft ? (
              <input className="input" data-testid="quota-edit-name" value={draft.name} style={{ width: 260 }} onChange={(e) => p.setDraft({ ...draft, name: e.target.value })} />
            ) : <span data-testid="quota-name">{row.name}</span>}
            <span className={stateChipClass(row.state)} data-testid="quota-state">{QUOTA_STATE_LABEL[row.state]}</span>
            <span className="chip">{row.mode} · on full: {row.onFull}</span>
            {row.dimensions >= 2 && <span className="chip">{row.dimensions}-dimensional</span>}
          </div>
          <div className="qd-source" data-testid="quota-source">
            {row.sources.length === 0 ? <span className="muted">Source: — (cells have no question conditions)</span> : (
              <>
                <span className="muted">Source{row.sources.length > 1 ? "s" : ""}: </span>
                {row.sources.map((src) => (
                  <span key={src.questionId} className="qd-src">
                    <strong>{src.code}</strong> – {src.text.slice(0, 80)}{src.text.length > 80 ? "…" : ""}
                    <span className="muted"> · {src.variableName} · {typeLabel(src.type)}</span>
                  </span>
                ))}
              </>
            )}
          </div>
        </div>
        <div className="card-actions">
          {draft ? (
            <>
              <button className="btn small primary" data-testid="quota-save" disabled={p.saving} onClick={p.onSave}>{p.saving ? "Saving…" : "Save Changes"}</button>
              <button className="btn small" data-testid="quota-cancel" disabled={p.saving} onClick={p.onCancel}>Cancel</button>
            </>
          ) : (
            <>
              <button className="btn small" data-testid="quota-edit" onClick={p.onEdit}>Edit</button>
              <button className="btn small" data-testid="quota-edit-logic" onClick={p.onLogic}>Edit Logic</button>
              <button className="btn small" data-testid="quota-detail" onClick={p.onDetail}>Details</button>
              <button className="btn small danger" data-testid="quota-delete" onClick={p.onDelete}>Delete</button>
            </>
          )}
        </div>
      </div>

      {draft && usesPercent && (
        <label className="row" style={{ gap: 6, marginTop: 8, fontSize: 12.5 }}>
          <span className="muted">Target total (base for % cells)</span>
          <input className="input mono" data-testid="quota-edit-target-total" style={{ width: 90 }} inputMode="numeric" value={draft.targetTotal} onChange={(e) => p.setDraft({ ...draft, targetTotal: e.target.value })} />
        </label>
      )}

      {/* quota total line */}
      <div className="qd-total" data-testid="quota-total-line">
        <span className="mono">{row.current} / {row.maximum ?? "∞"}</span>
        <Bar pct={row.pct} state={row.state} />
        <span className="mono">{fmtPct(row.pct)}</span>
        <span className="muted">Remaining: {row.remaining ?? "—"}</span>
        {!row.enforced && <span className="chip warn" title="No quota check node reads this quota and no List Fill consults it — it counts but never turns anyone away.">not enforced</span>}
      </div>

      {/* cells */}
      <div className="qd-cells">
        {cells.map((c) => (
          <CellRow key={c.cellId} cell={c} draft={draft?.cells.find((x) => x.cellId === c.cellId) ?? null}
            issues={p.issues?.errors.filter((e) => e.cellId === c.cellId) ?? []}
            onChange={(patch) => { if (!draft) return; p.setDraft({ ...draft, cells: draft.cells.map((x) => (x.cellId === c.cellId ? { ...x, ...patch } : x)) }); }} />
        ))}
        {row.cells.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No cells yet — open the Logic Builder to add cells and their conditions.</div>}
      </div>
      {complex && !draft && (
        <button className="btn small" data-testid="quota-expand" onClick={p.onToggle}>{p.expanded ? "Collapse ▲" : `Expand ▼ (${row.cells.length} cells)`}</button>
      )}

      {p.issues && (p.issues.errors.length > 0 || p.issues.warnings.length > 0) && (
        <div className="qd-issues" data-testid="quota-issues">
          {p.issues.errors.filter((e) => !e.cellId).map((e, i) => <div key={`e${i}`} className="chip warn qd-note">{e.message}</div>)}
          {p.issues.errors.filter((e) => e.cellId).map((e, i) => <div key={`c${i}`} className="chip warn qd-note">{e.message}</div>)}
          {p.issues.errors.length === 0 && p.issues.warnings.map((w, i) => (
            <div key={`w${i}`} className="chip warn qd-note" data-testid="quota-overcap-warning">{w.message}</div>
          ))}
          {p.issues.errors.length === 0 && p.issues.warnings.length > 0 && !p.overCapAccepted && (
            <label className="row" style={{ gap: 6, fontSize: 12.5 }} data-testid="quota-overcap-accept">
              <input type="checkbox" checked={p.overCapAccepted} onChange={(e) => p.setOverCapAccepted(e.target.checked)} />
              I understand — save anyway (no responses will be changed)
            </label>
          )}
        </div>
      )}

      <div className="qd-foot muted">
        <span>Last updated: {relative(row.updatedAt)}</span>
        <span>· Used by: {refsText(row) || "nothing (not enforced)"}</span>
      </div>
    </div>
  );
}

function refsText(row: QuotaRow): string {
  const r = row.references;
  return [
    ...r.quotaChecks.map((c) => `quota check ${c.nodeId} (${c.onFull})`),
    ...r.listFills.map((l) => `List Fill ${l.name}${l.explicit ? "" : " (all hard quotas)"}`),
    ...r.conditions.map((c) => c.where),
  ].join(", ");
}

function CellRow({ cell, draft, issues, onChange }: { cell: QuotaCellRow; draft: CellDraft | null; issues: QuotaEditIssue[]; onChange: (patch: Partial<CellDraft>) => void }) {
  return (
    <div className={`qd-cell ${issues.length ? "bad" : ""}`} data-testid="quota-cell" data-cell-id={cell.cellId} data-state={cell.state}>
      <div className="qd-cell-head">
        {draft ? <input className="input" style={{ width: 160 }} value={draft.label} onChange={(e) => onChange({ label: e.target.value })} data-testid="quota-cell-label-input" /> : <strong data-testid="quota-cell-label">{cell.label}</strong>}
        <span className="muted qd-cond" title={cell.condition}>{cell.condition}</span>
        <span className={stateChipClass(cell.state)} data-testid="quota-cell-state">{QUOTA_STATE_LABEL[cell.state]}</span>
      </div>
      <div className="qd-cell-body">
        <span className="mono qd-count" data-testid="quota-cell-count">{cell.current} / {cell.maximum > 0 ? cell.maximum : "∞"}</span>
        <Bar pct={cell.pct} state={cell.state} />
        <span className="mono">{fmtPct(cell.pct)}</span>
      </div>
      <div className="qd-cell-nums">
        <span>Current <strong className="mono">{cell.current}</strong></span>
        {draft ? (
          <>
            <label>Target <input className="input mono" data-testid="quota-cell-target" style={{ width: 70 }} inputMode="numeric" placeholder="—" value={draft.target} onChange={(e) => onChange({ target: e.target.value })} /></label>
            <label>Maximum <input className="input mono" data-testid="quota-cell-limit" style={{ width: 70 }} inputMode="numeric" value={draft.limit} onChange={(e) => onChange({ limit: e.target.value })} /></label>
            <select className="select" data-testid="quota-cell-unit" value={draft.limitType} onChange={(e) => onChange({ limitType: e.target.value as "count" | "percent" })}>
              <option value="count">count</option><option value="percent">% of target total</option>
            </select>
          </>
        ) : (
          <>
            <span>Target <strong className="mono">{cell.targetCount == null ? "—" : `${cell.targetCount}${cell.limitType === "percent" ? ` (${cell.target}%)` : ""}`}</strong></span>
            <span>Maximum <strong className="mono" data-testid="quota-cell-max">{cell.maximum > 0 ? `${cell.maximum}${cell.limitType === "percent" ? ` (${cell.limit}%)` : ""}` : "unlimited"}</strong></span>
            <span>Remaining to target <strong className="mono">{cell.remainingToTarget ?? "—"}</strong></span>
            <span>Remaining to maximum <strong className="mono" data-testid="quota-cell-remaining">{cell.remainingToMaximum ?? "—"}</strong></span>
          </>
        )}
      </div>
    </div>
  );
}

/* ================================================================ table */

function TableView(p: { rows: QuotaRow[]; expanded: Set<string>; onToggle: (id: string) => void; onEdit: (id: string) => void; onLogic: (id: string) => void; onDelete: (id: string) => void; onDetail: (id: string) => void }) {
  return (
    <div className="table-wrap" data-testid="quota-table">
      <table className="grid">
        <thead>
          <tr><th>Quota</th><th>Source question</th><th>Cell</th><th>Condition</th><th>Target</th><th>Maximum</th><th>Current</th><th>Remaining</th><th>%</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {p.rows.map((row) => {
            const complex = row.cells.length > 4;
            const cells = complex && !p.expanded.has(row.id) ? row.cells.slice(0, 3) : row.cells;
            return (
              <React.Fragment key={row.id}>
                <tr className="qd-trow" data-testid="quota-table-row" data-quota-id={row.id}>
                  <td style={{ fontFamily: "var(--sans)", fontWeight: 600 }}>{row.name}<div className="muted" style={{ fontSize: 11 }}>{row.mode} · {row.cells.length} cells{row.dimensions >= 2 ? ` · ${row.dimensions}-dim` : ""}</div></td>
                  <td>{row.sources.map((s) => s.code).join(" + ") || "—"}</td>
                  <td className="muted">all</td><td className="muted">—</td>
                  <td>—</td><td>{row.maximum ?? "∞"}</td><td>{row.current}</td><td>{row.remaining ?? "—"}</td><td>{fmtPct(row.pct)}</td>
                  <td><span className={stateChipClass(row.state)}>{QUOTA_STATE_LABEL[row.state]}</span></td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="btn small" onClick={() => p.onEdit(row.id)}>Edit</button>{" "}
                    <button className="btn small" onClick={() => p.onLogic(row.id)}>Logic</button>{" "}
                    <button className="btn small" onClick={() => p.onDetail(row.id)}>Details</button>{" "}
                    <button className="btn small danger" onClick={() => p.onDelete(row.id)}>Delete</button>
                  </td>
                </tr>
                {cells.map((c) => (
                  <tr key={c.cellId} className="qd-tcell" data-testid="quota-table-cell">
                    <td className="muted">↳</td><td></td>
                    <td style={{ fontFamily: "var(--sans)" }}>{c.label}</td>
                    <td className="muted" style={{ fontFamily: "var(--sans)", fontSize: 11.5 }}>{c.condition}</td>
                    <td>{c.targetCount ?? "—"}</td><td>{c.maximum > 0 ? c.maximum : "∞"}</td><td>{c.current}</td><td>{c.remainingToMaximum ?? "—"}</td>
                    <td><div className="row" style={{ gap: 6 }}><Bar pct={c.pct} state={c.state} /><span>{fmtPct(c.pct)}</span></div></td>
                    <td><span className={stateChipClass(c.state)}>{QUOTA_STATE_LABEL[c.state]}</span></td><td></td>
                  </tr>
                ))}
                {complex && (
                  <tr><td colSpan={11}><button className="btn small" onClick={() => p.onToggle(row.id)}>{p.expanded.has(row.id) ? "Collapse ▲" : `Expand ▼ (${row.cells.length} cells)`}</button></td></tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ================================================================ detail */

function QuotaDetail({ row, env, onClose, onLogic }: { row: QuotaRow | undefined; env: Env; onClose: () => void; onLogic: () => void }) {
  const s = useStudio();
  const [history, setHistory] = React.useState<{ id: string | number; text: string; createdAt: string; actorName: string | null; detail: Record<string, unknown> | null }[] | null>(null);
  React.useEffect(() => {
    if (!row || s.surveyDbId === "sandbox") { setHistory([]); return; }
    fetch(`/api/surveys/${s.surveyDbId}/quotas/history?quotaId=${encodeURIComponent(row.id)}`, { cache: "no-store" })
      .then((r) => r.json()).then((d) => setHistory(d.events ?? [])).catch(() => setHistory([]));
  }, [row, s.surveyDbId]);
  if (!row) return null;
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal qd-detail" onClick={(e) => e.stopPropagation()} data-testid="quota-detail">
        <div className="row"><h3 style={{ margin: 0 }}>{row.name}</h3><span className={stateChipClass(row.state)}>{QUOTA_STATE_LABEL[row.state]}</span><span className="grow" /><button className="btn small" onClick={onClose}>✕</button></div>
        <table className="grid" style={{ marginTop: 10 }}>
          <tbody>
            <tr><th>Quota id</th><td>{row.id}</td></tr>
            <tr><th>Question(s)</th><td style={{ fontFamily: "var(--sans)" }}>{row.sources.map((q) => `${q.code} – ${q.text} (${q.variableName}, ${typeLabel(q.type)})`).join("; ") || "—"}</td></tr>
            <tr><th>Quota type</th><td>{row.mode} · {row.dimensions >= 2 ? `${row.dimensions}-dimensional` : "single dimension"} · on full: {row.onFull} · counts: {row.countStatus.join(", ")}</td></tr>
            <tr><th>Target total</th><td>{row.targetTotal ?? "—"}</td></tr>
            <tr><th>Current / Maximum</th><td>{row.current} / {row.maximum ?? "∞"} ({fmtPct(row.pct)}) · remaining {row.remaining ?? "—"} · {env.toLowerCase()} data</td></tr>
            <tr><th>Last counter change</th><td>{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "never"}</td></tr>
            <tr><th>Used by</th><td style={{ fontFamily: "var(--sans)" }}>{refsText(row) || "nothing — not enforced"}</td></tr>
            <tr><th>Definition version</th><td>{s.def.meta.version} · revision {s.revision ?? "—"}</td></tr>
          </tbody>
        </table>
        <h4 style={{ margin: "12px 0 6px" }}>Conditions</h4>
        <table className="grid">
          <thead><tr><th>Cell</th><th>Condition</th><th>Target</th><th>Maximum</th><th>Current</th><th>Remaining</th><th>Status</th></tr></thead>
          <tbody>
            {row.cells.map((c) => (
              <tr key={c.cellId}><td style={{ fontFamily: "var(--sans)" }}>{c.label}</td><td style={{ fontFamily: "var(--sans)", fontSize: 11.5 }}>{c.condition}</td>
                <td>{c.targetCount ?? "—"}</td><td>{c.maximum > 0 ? c.maximum : "∞"}</td><td>{c.current}</td><td>{c.remainingToMaximum ?? "—"}</td>
                <td><span className={stateChipClass(c.state)}>{QUOTA_STATE_LABEL[c.state]}</span></td></tr>
            ))}
          </tbody>
        </table>
        <h4 style={{ margin: "12px 0 6px" }}>Change history</h4>
        {history == null ? <div className="muted">Loading…</div> : history.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>No recorded changes yet (changes made from this dashboard are recorded with who, when, before and after).</div> : (
          <ul className="qd-history" data-testid="quota-history">
            {history.map((h) => (
              <li key={String(h.id)}><span className="muted mono">{new Date(h.createdAt).toLocaleString()}</span> — {h.text}
                {h.detail?.changes != null && typeof h.detail.changes === "object" && (
                  <div className="mono" style={{ fontSize: 11 }}>
                    {Object.entries(h.detail.changes as Record<string, { before: unknown; after: unknown }>).map(([k, v]) => (
                      <div key={k}>{k}: {String(v?.before ?? "—")} → {String(v?.after ?? "—")}</div>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn small" onClick={onLogic}>Edit Logic</button>
          <button className="btn small" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
