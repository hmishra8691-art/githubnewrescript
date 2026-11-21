"use client";
import React from "react";
import { REQUEST_HELP } from "@/lib/portalRequestsCore";
import { useStudio } from "./store";

/**
 * RESPONDENTS' PRIVACY REQUESTS (phase 5, 2026-11-20) — inside the Respondent portal section. What respondents of
 * this survey have asked for (a copy of their data, a correction, deletion) and the answer given. Marking a request
 * records the outcome and shows it to the respondent; the work itself is done with the project's own tools first.
 * Shown only to members who may see contact details.
 */
interface Req { id: string; kind: string; status: string; message: string | null; answer: string | null; createdAt: string; resolvedAt: string | null; respondent: { id: string; name: string | null; email: string | null } }
const KIND: Record<string, string> = { access: "A copy of their data", correction: "A correction", deletion: "Deletion" };
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function PortalRequestsPanel() {
  const s = useStudio();
  const [rows, setRows] = React.useState<Req[] | null>(null);
  const [notes, setNotes] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(async () => {
    if (!s.surveyDbId) return;
    const r = await fetch(`/api/surveys/${s.surveyDbId}/portal/requests`, { cache: "no-store" });
    if (!r.ok) { setRows(null); return; }   // no permission to see who asked: the section is simply not shown
    const j = await r.json();
    setRows(j.available ? j.rows : null);
  }, [s.surveyDbId]);
  React.useEffect(() => { void load(); }, [load]);
  const answer = async (id: string, status: "done" | "declined") => {
    setBusy(true); setError(null);
    const r = await fetch(`/api/surveys/${s.surveyDbId}/portal/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, status, note: notes[id] ?? "" }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setError(j.error ?? `That did not work (${r.status}).`); return; }
    await load();
  };
  if (!rows || !rows.length) return null;
  const open = rows.filter((r) => r.status === "open");
  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--c-border, #e5e7eb)" }} data-testid="portal-requests">
      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13.5 }}>Privacy requests</strong>
        {open.length > 0 ? <span className="chip warn">{open.length} waiting</span> : <span className="chip on">All answered</span>}
      </div>
      {error && <div className="chip warn qd-note" style={{ marginTop: 6 }}>{error}</div>}
      {rows.map((r) => (
        <div key={r.id} className="card" style={{ padding: 10, marginTop: 8, fontSize: 12.5 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <strong>{KIND[r.kind] ?? r.kind}</strong>
            <span>{r.respondent.name ?? r.respondent.email ?? "A respondent no longer on the list"}</span>
            <span className="muted">{day(r.createdAt)}</span>
            <span className="grow" />
            <span className={r.status === "open" ? "chip warn" : "chip"}>{r.status === "open" ? "Waiting" : r.status === "done" ? "Done" : "Declined"}</span>
          </div>
          {r.message && <p style={{ margin: "6px 0 0" }}>"{r.message}"</p>}
          {r.status !== "open" && r.answer && <p className="muted" style={{ margin: "6px 0 0" }}>Answered: {r.answer}</p>}
          {r.status === "open" && (
            <>
              <p className="muted" style={{ margin: "6px 0" }}>{REQUEST_HELP[r.kind]}</p>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <input className="input grow" style={{ minWidth: 220 }} maxLength={2000} placeholder="Your answer to the respondent (needed to decline)" value={notes[r.id] ?? ""} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} aria-label="Answer to the respondent" />
                <button type="button" className="btn small" disabled={busy} onClick={() => answer(r.id, "done")}>Mark done</button>
                <button type="button" className="btn small" disabled={busy} onClick={() => answer(r.id, "declined")}>Decline</button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
