"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { useStudio } from "./store";

/**
 * LINKED LIBRARY ITEMS — the screen for roadmap P5 (2026-11-27; the engine is packages/engine/src/library.ts, the
 * route app/api/surveys/[id]/library).
 *
 * Two views inside "Insert from a library":
 *
 *   LinkedInsert   pick a library survey (its latest SAVED version), pick a block, a question or an option list, see
 *                  what inserting it would do — the notes and the source diff — and insert it. The copy keeps a link.
 *   LibraryLinks   every link in this survey: up to date, update available, edited here, both, removed from the
 *                  library, library missing — with what an update would add, remove, change, break elsewhere and
 *                  overwrite. An update is previewed the same way and applied only when asked.
 *
 * Both preview against the survey as it is in this editor (unsaved edits included) and apply the route's result
 * through the editor — undo, autosave and the revision guard as for any other change. The route writes nothing.
 */

export interface LibraryItemRow { id: string; kind: "block" | "question" | "list"; name: string; questionIds: string[]; summary: string }
interface LinkImpact { added: string[]; removed: string[]; changed: { code: string; what: string[] }[]; broken: string[]; overwrites: string[] }
export interface LinkStatusRow {
  link: { id: string; library: { surveyId?: string; title?: string }; itemId: string; kind: "block" | "question" | "list"; version: number | string; insertedAt?: string; optionsOf?: string; keys: Record<string, string> };
  state: "up_to_date" | "update_available" | "changed_here" | "both" | "item_removed" | "library_missing";
  libraryVersion?: number | string;
  impact?: LinkImpact;
  message: string;
}
interface Preview { notes: string[]; diff: string; definition: SurveyDefinition }

const STATE_LABEL: Record<LinkStatusRow["state"], string> = {
  up_to_date: "Up to date", update_available: "Update available", changed_here: "Edited here", both: "Update available · edited here",
  item_removed: "Removed from the library", library_missing: "Library not found",
};
const STATE_TONE: Record<LinkStatusRow["state"], string> = {
  up_to_date: "var(--c-success-fg, #15803d)", update_available: "var(--c-warning-fg, #b45309)", changed_here: "var(--c-muted, #6b7280)",
  both: "var(--c-warning-fg, #b45309)", item_removed: "var(--c-danger-fg, #b91c1c)", library_missing: "var(--c-danger-fg, #b91c1c)",
};
export const canUpdate = (st: LinkStatusRow["state"]) => st === "update_available" || st === "both";

async function post(surveyId: string, body: Record<string, unknown>): Promise<any> {
  const r = await fetch(`/api/surveys/${surveyId}/library`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let d: any = null;
  try { d = await r.json(); } catch { /* not JSON */ }
  if (!r.ok || d?.ok === false || d?.error) throw new Error(d?.error ?? `The library request failed (${r.status}).`);
  return d;
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre data-testid="library-diff" style={{ maxHeight: 220, overflow: "auto", fontSize: 12, background: "var(--c-surface-2, #f8fafc)", border: "1px solid var(--c-border, #e5e7eb)", borderRadius: 6, padding: 8, margin: "6px 0 0" }}>
      {lines.slice(0, 400).map((l, i) => (
        <div key={i} style={{ color: l.startsWith("+") ? "var(--c-success-fg, #15803d)" : l.startsWith("-") ? "var(--c-danger-fg, #b91c1c)" : undefined, whiteSpace: "pre-wrap" }}>{l || " "}</div>
      ))}
      {lines.length > 400 && <div className="muted">… {lines.length - 400} more lines</div>}
    </pre>
  );
}

function PreviewBox({ p }: { p: Preview }) {
  return (
    <div style={{ marginTop: 10, fontSize: 13 }} data-testid="library-linked-preview">
      {p.notes.map((n, i) => <div key={i}>{n}</div>)}
      {p.diff.trim() ? <DiffView diff={p.diff} /> : <div className="muted">The survey's source would not change.</div>}
    </div>
  );
}

/** insert a block, question or option list from a library survey, keeping a link */
export function LinkedInsert({ projects, intoBlock, onDone }: { projects: { surveyId: string; code: string; title: string }[] | null; intoBlock?: string; onDone(): void }) {
  const s = useStudio();
  const [libId, setLibId] = React.useState("");
  const [lib, setLib] = React.useState<{ title: string; version: string } | null>(null);
  const [items, setItems] = React.useState<LibraryItemRow[] | null>(null);
  const [itemId, setItemId] = React.useState("");
  const [into, setInto] = React.useState("");
  const [filter, setFilter] = React.useState("");
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  /* the survey the preview was worked out on: applying is refused if the editor moved on since */
  const basis = React.useRef<SurveyDefinition | null>(null);

  React.useEffect(() => {
    setItems(null); setLib(null); setItemId(""); setPreview(null); setErr(null);
    if (!libId) return;
    let live = true;
    post(s.surveyDbId, { action: "items", library: libId })
      .then((d) => { if (live) { setItems(d.items as LibraryItemRow[]); setLib({ title: d.library?.title ?? "", version: String(d.library?.version ?? "") }); } })
      .catch((e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [libId, s.surveyDbId]);

  const item = items?.find((x) => x.id === itemId) ?? null;
  const choiceQuestions = React.useMemo(() => s.def.questions.filter((q) => ["single_select", "multi_select", "dropdown", "ranking", "matrix_single", "matrix_multi"].includes(q.type) || (q.options ?? []).length > 0), [s.def.questions]);

  React.useEffect(() => {
    setPreview(null); setErr(null);
    if (!libId || !item || (item.kind === "list" && !into)) return;
    let live = true;
    setBusy(true);
    const def = s.currentDef();
    post(s.surveyDbId, { action: "insert", library: libId, itemId: item.id, ...(item.kind === "list" ? { into } : intoBlock ? { after: intoBlock } : {}), definition: def })
      .then((d) => { if (live) { basis.current = def; setPreview({ notes: d.notes ?? [], diff: d.diff ?? "", definition: d.definition }); } })
      .catch((e: Error) => { if (live) setErr(e.message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libId, itemId, into, intoBlock, s.surveyDbId]);

  const insert = () => {
    if (!preview || !item) return;
    if (basis.current !== s.currentDef()) { setErr("The survey changed since this preview. Pick the item again to preview it on the survey as it is now."); setPreview(null); return; }
    s.labelNextEdit(`insert ${item.name} from the library ${lib?.title ?? ""}`.trim());
    s.replace(preview.definition);
    s.toast(preview.notes[0] ?? "Inserted from the library.");
    onDone();
  };

  const f = filter.trim().toLowerCase();
  const groups: { kind: LibraryItemRow["kind"]; label: string }[] = [{ kind: "block", label: "Blocks" }, { kind: "question", label: "Questions" }, { kind: "list", label: "Option lists" }];
  return (
    <div data-testid="library-linked">
      <p className="muted" style={{ marginTop: -6 }}>A library is a survey kept for reuse; its latest <b>saved version</b> is used. What you insert keeps a link, so this survey can tell when the library's version changes and what an update would do.</p>
      {err && <div className="callout err" role="alert" data-testid="library-linked-error">{err}</div>}
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <select className="input" value={libId} onChange={(e) => setLibId(e.target.value)} data-testid="library-linked-source" style={{ flex: 1 }} aria-label="Library survey">
          <option value="">{projects ? "Choose the library survey…" : "Loading your projects…"}</option>
          {(projects ?? []).map((p) => <option key={p.surveyId} value={p.surveyId}>{p.code} — {p.title}</option>)}
        </select>
        {items && <input className="input" placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 180 }} aria-label="Filter items" />}
      </div>
      {libId && !items && !err && <div className="muted">Opening the library…</div>}
      {lib && <div className="muted" style={{ fontSize: 12, marginBottom: 6 }} data-testid="library-linked-version">{lib.title} · saved version {lib.version}</div>}
      {items && items.length === 0 && <div className="muted">This library has no blocks, questions or option lists.</div>}
      {items && items.length > 0 && (
        <div style={{ maxHeight: "36vh", overflow: "auto", border: "1px solid var(--c-border, #e5e7eb)", borderRadius: 8, padding: 8 }} data-testid="library-linked-items">
          {groups.map((g) => {
            const rows = items.filter((x) => x.kind === g.kind && (!f || x.name.toLowerCase().includes(f) || x.summary.toLowerCase().includes(f)));
            if (!rows.length) return null;
            return (
              <div key={g.kind} style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{g.label}</div>
                {rows.map((x) => (
                  <label key={x.id} className="row" style={{ gap: 6, fontSize: 13, padding: "2px 0", alignItems: "flex-start" }}>
                    <input type="radio" name="library-item" checked={itemId === x.id} onChange={() => setItemId(x.id)} data-testid="library-linked-item" data-item={x.id} style={{ marginTop: 3 }} />
                    <span><b>{x.name}</b> <span className="muted">· {x.summary}</span></span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      )}
      {item?.kind === "list" && (
        <div className="row" style={{ gap: 8, marginTop: 8, alignItems: "center", fontSize: 13 }}>
          <span>Replace the options of</span>
          <select className="input" value={into} onChange={(e) => setInto(e.target.value)} data-testid="library-linked-into" aria-label="Question that receives the options">
            <option value="">choose a question…</option>
            {choiceQuestions.map((q) => <option key={q.id} value={q.id}>{q.code}</option>)}
          </select>
        </div>
      )}
      {busy && <div className="muted" style={{ marginTop: 8 }}>Working out what it would change…</div>}
      {preview && <PreviewBox p={preview} />}
      <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button className="btn" onClick={onDone}>Cancel</button>
        <button className="btn primary" disabled={!preview || busy || s.readOnly} onClick={insert} data-testid="library-linked-insert">Insert with a link</button>
      </div>
    </div>
  );
}

/** every library link in this survey, its state, and updates previewed then applied */
export function LibraryLinks({ onDone }: { onDone(): void }) {
  const s = useStudio();
  const [rows, setRows] = React.useState<LinkStatusRow[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [busy, setBusy] = React.useState(false);
  const basis = React.useRef<SurveyDefinition | null>(null);
  const count = (s.def.libraryLinks ?? []).length;

  const load = React.useCallback(() => {
    setErr(null);
    if (!count) { setRows([]); return; }
    setRows(null);
    post(s.surveyDbId, { action: "status", definition: s.currentDef() }).then((d) => setRows(d.links as LinkStatusRow[])).catch((e: Error) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.surveyDbId, count]);
  React.useEffect(() => { load(); }, [load]);

  const previewUpdate = (linkId: string) => {
    setOpen(linkId); setPreview(null); setErr(null); setBusy(true);
    const def = s.currentDef();
    post(s.surveyDbId, { action: "update", linkId, definition: def })
      .then((d) => { basis.current = def; setPreview({ notes: d.notes ?? [], diff: d.diff ?? "", definition: d.definition }); })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  const apply = (row: LinkStatusRow) => {
    if (!preview) return;
    if (basis.current !== s.currentDef()) { setErr("The survey changed since this preview. Preview the update again."); setPreview(null); return; }
    s.labelNextEdit(`update ${row.link.itemId} from the library ${row.link.library.title ?? ""} to version ${row.libraryVersion ?? ""}`.trim());
    s.replace(preview.definition);
    s.toast(preview.notes[0] ?? "Updated from the library.");
    setOpen(null); setPreview(null);
    load();
  };
  const codeOf = (id: string) => s.def.questions.find((q) => q.id === id)?.code ?? id;
  const what = (r: LinkStatusRow) => r.link.kind === "list" ? `options of ${codeOf(r.link.optionsOf ?? "")}` : r.link.kind === "question" ? Object.values(r.link.keys).map(codeOf).join(", ") : `block (${Object.keys(r.link.keys).length} questions: ${Object.values(r.link.keys).slice(0, 4).map(codeOf).join(", ")}${Object.keys(r.link.keys).length > 4 ? " …" : ""})`;

  return (
    <div data-testid="library-links">
      {err && <div className="callout err" role="alert" data-testid="library-links-error">{err}</div>}
      {count === 0 && <p className="muted" data-testid="library-links-none">Nothing in this survey is linked to a library yet. Items inserted with “Linked from a library” appear here, with whether the library has a newer version.</p>}
      {count > 0 && !rows && !err && <div className="muted">Checking each library…</div>}
      {rows && rows.length > 0 && (
        <div style={{ maxHeight: "52vh", overflow: "auto" }}>
          {rows.map((r) => (
            <div key={r.link.id} data-testid="library-link" data-state={r.state} style={{ border: "1px solid var(--c-border, #e5e7eb)", borderRadius: 8, padding: 10, marginBottom: 8, fontSize: 13 }}>
              <div className="row" style={{ justifyContent: "space-between", gap: "4px 8px", alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ flex: "1 1 300px", minWidth: 0 }}><b>{r.link.library.title ?? "Library"}</b> <span className="muted">· {what(r)} · inserted at version {String(r.link.version)}</span></span>
                <span data-testid="library-link-state" style={{ color: STATE_TONE[r.state], fontWeight: 600, whiteSpace: "nowrap", marginLeft: "auto" }}>{STATE_LABEL[r.state]}</span>
              </div>
              <div style={{ marginTop: 4 }}>{r.message}</div>
              {r.impact && (
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }} data-testid="library-link-impact">
                  {r.impact.added.length > 0 && <li>Would add: {r.impact.added.join(", ")}</li>}
                  {r.impact.removed.length > 0 && <li>Would remove: {r.impact.removed.join(", ")}</li>}
                  {r.impact.changed.map((c) => <li key={c.code}>{c.code}: {c.what.join("; ")}</li>)}
                  {r.impact.broken.map((b) => <li key={b} style={{ color: "var(--c-danger-fg, #b91c1c)" }}>{b}</li>)}
                  {r.impact.overwrites.length > 0 && <li style={{ color: "var(--c-warning-fg, #b45309)" }}>Would overwrite edits made here to: {r.impact.overwrites.join(", ")}</li>}
                </ul>
              )}
              {canUpdate(r.state) && (
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <button className="btn small" onClick={() => previewUpdate(r.link.id)} disabled={busy} data-testid="library-link-preview">Preview the update</button>
                  {open === r.link.id && preview && <button className="btn small primary" onClick={() => apply(r)} disabled={s.readOnly} data-testid="library-link-apply">Apply the update</button>}
                </div>
              )}
              {open === r.link.id && busy && <div className="muted" style={{ marginTop: 6 }}>Working out the update…</div>}
              {open === r.link.id && preview && <PreviewBox p={preview} />}
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        {count > 0 && <button className="btn" onClick={load} data-testid="library-links-refresh">Check again</button>}
        <button className="btn" onClick={onDone}>Close</button>
      </div>
    </div>
  );
}
