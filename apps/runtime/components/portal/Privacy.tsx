"use client";
import React from "react";
import { portalApi, when } from "./api";
import { Note } from "./Shell";

/**
 * MY PRIVACY (phase 5, 2026-11-20) — on the account page: the notice the person agreed to and how to withdraw it,
 * their requests to organisers (a copy of their data, a correction, deletion) with the answers, and when an
 * organiser's staff opened their results.
 */
interface Data {
  consent: { available: boolean; given: boolean; givenAt: string | null; version: string; title: string; paragraphs: string[] };
  assessments: { id: string; title: string }[];
  requests: { id: string; assessment: string; kind: string; status: string; message: string | null; answer: string | null; createdAt: string; resolvedAt: string | null }[];
  viewed: { at: string; assessment: string }[];
}
const KIND: Record<string, string> = { access: "A copy of my data", correction: "A correction", deletion: "Deletion of my data" };
const STATUS: Record<string, string> = { open: "Waiting for an answer", done: "Done", declined: "Declined" };

export function Privacy() {
  const [d, setD] = React.useState<Data | null>(null);
  const [note, setNote] = React.useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [form, setForm] = React.useState({ assessmentId: "", kind: "access", message: "" });
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(async () => { const r = await portalApi<Data>("me?part=privacy"); if (r.ok) { setD(r.data); setForm((f) => ({ ...f, assessmentId: f.assessmentId || r.data.assessments[0]?.id || "" })); } }, []);
  React.useEffect(() => { void load(); }, [load]);
  const act = async (body: Record<string, unknown>, ok: string) => { setBusy(true); setNote(null); const r = await portalApi("me", body); setBusy(false); setNote(r.ok ? { kind: "ok", text: ok } : { kind: "bad", text: r.error.error }); if (r.ok) await load(); return r.ok; };
  if (!d) return null;
  return (
    <>
      <h2>My privacy</h2>
      {note && <Note kind={note.kind}>{note.text}</Note>}
      {d.consent.available && (
        <div className="pt-card" data-testid="pt-privacy-consent">
          <p className="pt-q">{d.consent.title}</p>
          {d.consent.paragraphs.map((t, i) => <p key={i} className="pt-why" style={{ fontSize: 14 }}>{t}</p>)}
          {d.consent.given
            ? <p style={{ margin: "10px 0 0" }}>You agreed to this{d.consent.givenAt && !d.consent.givenAt.startsWith("1970") ? ` on ${when(d.consent.givenAt)}` : ""}. <button type="button" className="pt-btn is-quiet" disabled={busy} onClick={() => { if (window.confirm("Withdraw your agreement? Your assessments will be hidden in the portal until you agree again. Your data is not deleted by this; ask for deletion below.")) void act({ action: "withdraw_consent" }, "Your agreement has been withdrawn. Your assessments are hidden until you agree again."); }} data-testid="pt-withdraw">Withdraw my agreement</button></p>
            : <p style={{ margin: "10px 0 0" }}>You have not agreed to this notice. <a href="/portal">Read and agree on the Overview page</a> to see your assessments.</p>}
        </div>
      )}

      <h2>Requests about my data</h2>
      <div className="pt-card" data-testid="pt-requests">
        {d.assessments.length > 0 ? (
          <form onSubmit={(e) => { e.preventDefault(); void act({ action: "request", ...form }, "Your request has been sent to the organiser.").then((ok) => { if (ok) setForm((f) => ({ ...f, message: "" })); }); }}>
            <p className="pt-why" style={{ marginTop: 0, fontSize: 14 }}>A request goes to the organiser of one assessment, who answers it here. To delete your whole portal account, ask each organiser to delete your data first.</p>
            <div className="pt-field"><label htmlFor="pt-req-a">Assessment</label>
              <select id="pt-req-a" className="pt-input" value={form.assessmentId} onChange={(e) => setForm({ ...form, assessmentId: e.target.value })} data-testid="pt-req-assessment">{d.assessments.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}</select></div>
            <div className="pt-field"><label htmlFor="pt-req-k">I am asking for</label>
              <select id="pt-req-k" className="pt-input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} data-testid="pt-req-kind">{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="pt-field"><label htmlFor="pt-req-m">{form.kind === "correction" ? "What should be corrected" : "Anything to add (optional)"}</label>
              <textarea id="pt-req-m" className="pt-input" maxLength={2000} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} data-testid="pt-req-message" /></div>
            <button type="submit" className="pt-btn is-primary" disabled={busy || !form.assessmentId} data-testid="pt-req-send">Send the request</button>
          </form>
        ) : <p className="pt-empty">You have no assessments to make a request about.</p>}
        {d.requests.length > 0 && (
          <table className="pt-table" style={{ marginTop: 14 }} data-testid="pt-req-list">
            <thead><tr><th>Sent</th><th>Assessment</th><th>Request</th><th>Status</th></tr></thead>
            <tbody>{d.requests.map((r) => (<tr key={r.id}><td>{when(r.createdAt)}</td><td>{r.assessment}</td><td>{KIND[r.kind] ?? r.kind}{r.message ? <div className="pt-why">{r.message}</div> : null}</td><td>{STATUS[r.status] ?? r.status}{r.answer ? <div className="pt-why">{r.answer}</div> : null}</td></tr>))}</tbody>
          </table>
        )}
      </div>

      <h2>Who has opened my results</h2>
      <div className="pt-card" data-testid="pt-viewed">
        {d.viewed.length === 0 ? <p className="pt-empty">No organiser's staff have opened your individual results.</p> : (
          <table className="pt-table"><thead><tr><th>When</th><th>Assessment</th></tr></thead><tbody>{d.viewed.map((v, i) => (<tr key={i}><td>{when(v.at, true)}</td><td>{v.assessment}</td></tr>))}</tbody></table>
        )}
        <p className="pt-why">An organiser can always work with the answers you give them. This list is of the times a member of their staff opened your personal results page.</p>
      </div>
    </>
  );
}
