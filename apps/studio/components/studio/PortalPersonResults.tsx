"use client";
import React from "react";

/**
 * ONE RESPONDENT'S RESULTS, FOR A MEMBER WHO MAY OPEN THEM (phase 3, 2026-11-20). Scores and their history in this
 * survey — no answers. The server checks the permission and records the opening; this only draws what it sent.
 */
interface Dim { id: string; label: string; score: number | null; max: number | null; band: { label: string } | null; reason?: string }
interface Point { at: string; responseId: string; score: number; band: string | null; comparable: boolean }
interface Change { text: string; direction: "better" | "worse" | "same"; fromAt: string }
interface Trend { id: string; label: string; max: number | null; higherIsBetter: boolean; points: Point[]; change: Change | null; sinceFirst: Change | null; yearOnYear: Change | null; note: string | null }
interface View { available: boolean; why: string | null; person: { id: string; respondentId: string | null; name: string | null; email: string | null }; attempts: number; latestAt: string | null; latest: { dimensions: Dim[]; overall: { label: string; percent: number } | null } | null; trends: Trend[] }

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
const num = (n: number) => String(Math.round(n * 100) / 100);
const tone = (c: Change) => (c.direction === "better" ? "chip on" : c.direction === "worse" ? "chip warn" : "chip");

export function PortalPersonResults({ surveyId, respondent, onClose }: { surveyId: string; respondent: string; onClose: () => void }) {
  const [view, setView] = React.useState<View | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    setView(null); setError(null);
    void fetch(`/api/surveys/${surveyId}/portal/person?respondent=${encodeURIComponent(respondent)}`, { cache: "no-store" }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!live) return;
      if (r.ok) setView(j as View); else setError(j.error ?? `Could not open the results (${r.status}).`);
    });
    return () => { live = false; };
  }, [surveyId, respondent]);

  return (
    <div className="card" style={{ padding: 12, marginBottom: 10 }} data-testid="portal-person">
      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13.5 }}>{view ? view.person.name ?? view.person.respondentId ?? "Respondent" : "Results"}</strong>
        {view?.person.respondentId && view.person.name && <span className="mono muted" style={{ fontSize: 12 }}>{view.person.respondentId}</span>}
        {view?.latestAt && <span className="muted" style={{ fontSize: 12.5 }}>{view.attempts} completed · latest {day(view.latestAt)}</span>}
        <span className="grow" />
        <button type="button" className="btn small" onClick={onClose}>Close</button>
      </div>
      {error && <div className="chip warn qd-note" style={{ marginTop: 8 }}>{error}</div>}
      {!view && !error && <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }}>Loading…</p>}
      {view && !view.available && <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }}>{view.why}</p>}
      {view?.available && !view.latest && <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }}>This person has no completed, scored interview yet.</p>}
      {view?.latest && (
        <>
          <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse", marginTop: 8 }} data-testid="portal-person-scores">
            <thead><tr style={{ textAlign: "left" }}><th>Score</th><th>Latest</th><th>Range</th><th>Change from the previous</th><th>Since the first</th></tr></thead>
            <tbody>
              {view.latest.overall && (() => { const t = view.trends.find((x) => x.id === "__overall"); return (
                <tr style={{ borderTop: "1px solid var(--c-border, #e5e7eb)" }}><td><strong>{view.latest!.overall!.label}</strong></td><td>{num(view.latest!.overall!.percent)} of 100</td><td>—</td><td>{t?.change ? <span className={tone(t.change)}>{t.change.text}</span> : "—"}</td><td>{t?.sinceFirst?.text ?? "—"}</td></tr>
              ); })()}
              {view.latest.dimensions.map((d) => {
                const t = view.trends.find((x) => x.id === d.id);
                return (
                  <tr key={d.id} style={{ borderTop: "1px solid var(--c-border, #e5e7eb)" }}>
                    <td>{d.label}{t && !t.higherIsBetter ? <span className="muted"> (lower is better)</span> : null}</td>
                    <td>{d.score === null ? <span className="muted">{d.reason ?? "Not scored"}</span> : `${num(d.score)}${d.max !== null ? ` of ${num(d.max)}` : ""}`}</td>
                    <td>{d.band?.label ?? "—"}</td>
                    <td>{t?.change ? <span className={tone(t.change)}>{t.change.text}</span> : "—"}</td>
                    <td>{t?.sinceFirst?.text ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {view.trends.some((t) => t.points.length > 1) && (
            <details style={{ marginTop: 8, fontSize: 12.5 }}>
              <summary>Every result</summary>
              {view.trends.filter((t) => t.id !== "__overall").map((t) => (
                <p key={t.id} style={{ margin: "6px 0 0" }}>
                  <strong>{t.label}:</strong> {t.points.map((p) => `${day(p.at)} ${num(p.score)}${p.comparable ? "" : " (scored differently)"}`).join(" · ")}
                  {t.note ? <span className="muted"> {t.note}</span> : null}
                </p>
              ))}
            </details>
          )}
          <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>Scores in this survey only. A change is given only between results scored the same way, and says nothing about its cause.</p>
        </>
      )}
    </div>
  );
}
