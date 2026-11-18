"use client";
import React from "react";

/**
 * ERASE A PERSON (audit 2026-11-17, P1-11) — for a data-subject request. Find them by what you know, see how many
 * responses and invitations that names, then erase. The result says what was removed, that a re-check found nothing
 * left, and how many exports were made earlier (copies outside the platform are yours to delete).
 */
type Kind = "email" | "respondent_code" | "panel_id" | "session_id";
const KINDS: [Kind, string, string][] = [
  ["email", "Email address", "the address on the invitation list"],
  ["respondent_code", "Respondent code", "as shown in the data, e.g. R-7F3K"],
  ["panel_id", "Panel / supplier id", "the sample supplier's id for this person"],
  ["session_id", "Session id", "from a support request or a log"],
];

export function ErasureDialog({ surveyId, onClose, onDone }: { surveyId: string; onClose(): void; onDone(text: string): void }) {
  const [kind, setKind] = React.useState<Kind>("email");
  const [value, setValue] = React.useState("");
  const [found, setFound] = React.useState<{ responses: number; invitations: number } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ verified: boolean; removed: Record<string, number>; mediaObjects: number; note: string | null; remaining: Record<string, number> } | null>(null);
  const call = async (extra: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/surveys/${surveyId}/erasure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: { kind, value }, ...extra }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok && !("verified" in j)) { setError(j.error ?? `Failed (${r.status}).`); if (typeof j.responses === "number") setFound({ responses: j.responses, invitations: j.invitations }); return null; }
      return j;
    } catch { setError("Could not reach the Studio."); return null; } finally { setBusy(false); }
  };
  const check = async () => { setFound(null); setResult(null); const j = await call({ dryRun: true }); if (j) setFound({ responses: j.responses, invitations: j.invitations }); };
  const erase = async () => {
    const j = await call({ confirm: found });
    if (!j) return;
    setResult(j);
    if (j.verified) onDone(`Erased: ${j.removed.responses ?? 0} response(s), ${j.removed.respondents ?? 0} invitation(s), ${j.mediaObjects} file(s). Re-check found nothing left.`);
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" style={{ width: 560, maxWidth: "calc(100vw - 32px)" }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Erase a person" data-testid="erasure-dialog">
        <h3 style={{ marginTop: 0 }}>Erase a person from this project</h3>
        <p className="muted" style={{ marginTop: -6 }}>For a request to erase someone's data. This removes their responses, recordings and uploads, their invitation, the mail sent to them and every hold or slot they took. It cannot be undone.</p>
        <div className="row" style={{ gap: 8 }}>
          <select className="select" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setFound(null); setResult(null); }} data-testid="erasure-kind" style={{ width: 200 }}>
            {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input className="input" style={{ flex: 1 }} value={value} placeholder={KINDS.find((k) => k[0] === kind)![2]} onChange={(e) => { setValue(e.target.value); setFound(null); setResult(null); }} data-testid="erasure-value" />
          <button className="btn" disabled={busy || !value.trim()} onClick={check} data-testid="erasure-check">Find</button>
        </div>
        {error && <div className="callout err" role="alert" style={{ marginTop: 8 }}>{error}</div>}
        {found && !result && (
          <div style={{ marginTop: 10 }} data-testid="erasure-found">
            {found.responses + found.invitations === 0
              ? <span className="muted">Nothing in this project matches.</span>
              : <>This names <b>{found.responses}</b> response{found.responses === 1 ? "" : "s"} and <b>{found.invitations}</b> invitation{found.invitations === 1 ? "" : "s"}.</>}
          </div>
        )}
        {result && (
          <div style={{ marginTop: 10 }} data-testid="erasure-result" data-verified={result.verified ? "1" : "0"}>
            <div className={result.verified ? "chip ok" : "callout err"}>{result.verified ? "Erased and verified: a re-check found nothing left." : `Not fully verified — still found: ${Object.entries(result.remaining).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(", ")}`}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>Removed: {Object.entries(result.removed).map(([t, n]) => `${t.replace(/_/g, " ")} ${n}`).join(" · ") || "—"} · files {result.mediaObjects}</div>
            {result.note && <div className="callout warn" style={{ marginTop: 6 }}>{result.note}</div>}
          </div>
        )}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button className="btn" onClick={onClose}>{result ? "Close" : "Cancel"}</button>
          {!result && <button className="btn danger" disabled={busy || !found || found.responses + found.invitations === 0} onClick={erase} data-testid="erasure-confirm">Erase permanently</button>}
        </div>
      </div>
    </div>
  );
}
