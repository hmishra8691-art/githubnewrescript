"use client";
import React from "react";
import { AccountHeader } from "@/components/AccountHeader";
import { api, useSession } from "@/lib/useSession";

/**
 * THE FRAUD INTELLIGENCE CENTRE (2026-11-03, Phase 5) — §19 and §20 given a screen.
 *
 * Phases 3 and 4 built a review queue nobody could see. A case that opens, holds a supplier's money and waits
 * for a human is only as good as the human's ability to find it, understand it, and answer it — and until this
 * screen existed the answer was a database row.
 *
 * Three things it tries to do that a plain table would not:
 *
 *   THE RING IS THE UNIT.    Forty identities from one click farm are shown as one network with one decision,
 *                            not as forty cases a reviewer has to recognise as related. §19's actual point.
 *   THE EVIDENCE IS THERE.   Every case shows the reasons and the arithmetic that produced its score. A reviewer
 *                            being asked to withhold a supplier's payment should not have to take the number on
 *                            trust, and the respondent they are marking has an appeal right (§20) that needs a
 *                            stated reason to appeal against.
 *   IT SAYS WHAT IT DOES     NOT KNOW. The banner at the top is not decoration: no traffic has been through
 *                            shadow mode yet, so the false-positive rate of every score on this page is
 *                            unmeasured. The model evaluation panel says so in numbers, and keeps saying so
 *                            until reviewers have resolved enough cases for it to say anything else.
 *
 * Upholding needs a typed reason. That is not friction for its own sake: it is the difference between a record
 * someone can appeal and an accusation with nothing behind it.
 */

interface FraudCase {
  id: string;
  survey_id: string | null;
  trust_id: string | null;
  kind: string;
  risk_score: number;
  reasons: string[];
  evidence: Record<string, unknown>;
  status: string;
  holds_payment: boolean;
  opened_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  appealed_at: string | null;
  appeal_note: string | null;
  cluster_id: string | null;
}

interface Cluster {
  id: string;
  survey_id: string | null;
  signature: string;
  members: string[];
  member_count: number;
  devices: number;
  networks: number;
  identities_per_device: number | null;
  score: number;
  signals: string[];
  evidence: Record<string, unknown>;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
}

interface QualityRow {
  integration_id: string;
  vendorName: string | null;
  market: string | null;
  window_days: number;
  completes: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  fraud_cases: number;
  rejection_rate: number | null;
  rejection_low: number | null;
  rejection_high: number | null;
  quality_score: number | null;
  confidence: string;
  computed_at: string;
}

interface Evaluation {
  status?: string;
  resolved_cases?: number;
  true_positives?: number;
  false_positives?: number;
  precision?: number | null;
  false_positive_rate?: number | null;
  note?: string;
}

interface Admission {
  id: string; survey_id: string; trust_id: string | null; integration_id: string | null;
  decision: string; risk_score: number; risk_band: string; reasons: string[]; evidence: Record<string, unknown>;
  resolution: string | null; decided_in_ms: number | null; occurred_at: string; project: string | null; vendorName: string | null;
}
interface Payload {
  cases: FraudCase[];
  clusters: Cluster[];
  quality: QualityRow[];
  evaluation: Evaluation;
  counts: Record<string, number>;
  calibration: string | null;
  admissions?: {
    recent: Admission[];
    sevenDays: { decisions: Record<string, number>; bands: Record<string, number>; identity: Record<string, number>; shadowBlocks: number; available: boolean };
  };
}

const DECISION_WORDS: Record<string, string> = {
  admitted: "admitted", admitted_flagged: "admitted, case opened", duplicate: "refused as a duplicate",
  observed: "would have been refused (shadow)", not_eligible: "not eligible",
};

const when = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "—" : new Date(ms).toLocaleString();
};

const pct = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : `${Number(v).toFixed(1)}%`;

/** Bands, not a traffic light: the point is that none of these are verdicts. */
function band(score: number): { label: string; tone: string } {
  if (score >= 85) return { label: "Severe", tone: "#b42318" };
  if (score >= 70) return { label: "High", tone: "#b54708" };
  if (score >= 50) return { label: "Elevated", tone: "#854a0e" };
  return { label: "Low", tone: "#475467" };
}

export default function FraudPage() {
  const { state, signOut } = useSession({ redirectOnSignOut: true });
  const [data, setData] = React.useState<Payload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState("open");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  /** the reason typed against each case or network, keyed by id */
  const [reasons, setReasons] = React.useState<Record<string, string>>({});

  const load = React.useCallback(async (status: string) => {
    const r = await api<Payload>(`/api/fraud?status=${encodeURIComponent(status)}&limit=100`);
    if (!r.ok) {
      if (r.status !== 401 && r.status !== 403) setError(r.error);
      else setError(r.error);
      return;
    }
    setError(null);
    setData(r.data);
  }, []);

  React.useEffect(() => { void load(filter); }, [load, filter]);

  const resolveCase = async (caseId: string, status: string) => {
    const reason = (reasons[caseId] ?? "").trim();
    if (status === "upheld" && !reason) {
      setError("Upholding withholds a supplier's payment and marks a respondent. Say why — they may appeal it.");
      return;
    }
    setBusy(caseId); setNote(null);
    try {
      const r = await api("/api/fraud", { method: "POST", json: { action: "resolve", caseId, status, note: reason || null } });
      if (!r.ok) { setError(r.error); return; }
      setError(null);
      setNote(status === "upheld" ? "Case upheld. The complete is not billable and the respondent may appeal."
        : status === "cleared" ? "Case cleared. The complete is billable again."
        : "Case withdrawn.");
      setReasons((s) => ({ ...s, [caseId]: "" }));
      await load(filter);
    } finally { setBusy(null); }
  };

  const resolveCluster = async (clusterId: string, status: string) => {
    const reason = (reasons[clusterId] ?? "").trim();
    if (status === "upheld" && !reason) {
      setError("Upholding a network withholds payment for every member. Say why.");
      return;
    }
    setBusy(clusterId); setNote(null);
    try {
      const r = await api<{ resolved: number }>("/api/fraud", {
        method: "POST", json: { action: "cluster", clusterId, status, note: reason || null },
      });
      if (!r.ok) { setError(r.error); return; }
      setError(null);
      setNote(`Network ${status}: ${r.data.resolved} case${r.data.resolved === 1 ? "" : "s"} resolved together.`);
      setReasons((s) => ({ ...s, [clusterId]: "" }));
      await load(filter);
    } finally { setBusy(null); }
  };

  const user = state.kind === "signed_in" ? state.user : null;
  const counts = data?.counts ?? {};

  return (
    <div className="acct-shell">
      <AccountHeader active="fraud" user={user} onSignOut={signOut} />

      {data?.calibration && (
        <div className="auth-note" data-testid="fraud-calibration" style={{ borderLeft: "3px solid #b54708" }}>
          <strong>These scores have not been validated.</strong>{" "}
          {data.calibration} Clearing a case is as useful to the platform as upholding one — both teach it
          something, and only resolved cases can measure whether any of this works.
        </div>
      )}

      {error && <div className="auth-note err">{error}</div>}
      {note && !error && <div className="auth-note ok">{note}</div>}

      {/* ------------------------------------------------------------ does it work */}
      <div className="row" style={{ margin: "14px 0 6px" }}>
        <strong className="grow">How the detector is doing</strong>
        <button className="btn small" onClick={() => void load(filter)}>Refresh</button>
      </div>
      <div className="card" data-testid="fraud-evaluation" style={{ padding: 12 }}>
        {data?.evaluation?.status === "computed" ? (
          <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
            <div><div className="muted" style={{ fontSize: 12 }}>Resolved cases</div><strong>{data.evaluation.resolved_cases}</strong></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Upheld</div><strong>{data.evaluation.true_positives ?? "—"}</strong></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Cleared (false positives)</div><strong>{data.evaluation.false_positives ?? "—"}</strong></div>
            <div><div className="muted" style={{ fontSize: 12 }}>Precision</div><strong>{data.evaluation.precision !== null && data.evaluation.precision !== undefined ? `${(Number(data.evaluation.precision) * 100).toFixed(1)}%` : "—"}</strong></div>
            <div><div className="muted" style={{ fontSize: 12 }}>False-positive rate</div><strong>{data.evaluation.false_positive_rate !== null && data.evaluation.false_positive_rate !== undefined ? `${(Number(data.evaluation.false_positive_rate) * 100).toFixed(1)}%` : "—"}</strong></div>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0, maxWidth: 760, lineHeight: 1.55 }}>
            {data?.evaluation?.note
              ?? "Precision and the false-positive rate are measured over cases a human has actually resolved. There are not enough of those yet, so there are no numbers here — which is the truthful state, not a loading failure."}
          </p>
        )}
      </div>

      {/* ------------------------------------------------------------ the rings */}
      {!!data?.clusters.length && (
        <>
          <div className="row" style={{ margin: "18px 0 6px" }}>
            <strong className="grow">Suspected networks</strong>
            <span className="muted" style={{ fontSize: 12.5 }}>one decision for the whole ring</span>
          </div>
          <div className="table-wrap">
            <table className="grid" data-testid="fraud-clusters">
              <thead>
                <tr>
                  <th>Network</th><th>Identities</th><th>Devices</th><th>Per device</th>
                  <th>Score</th><th>Linked by</th><th>Seen</th><th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {data.clusters.map((c) => {
                  const b = band(Number(c.score));
                  const open = expanded === c.id;
                  return (
                    <React.Fragment key={c.id}>
                      <tr>
                        <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                          <button className="btn small" onClick={() => setExpanded(open ? null : c.id)}>
                            {open ? "▾" : "▸"} {c.signature.slice(0, 10)}
                          </button>
                        </td>
                        <td><strong>{c.member_count}</strong></td>
                        <td>{c.devices}</td>
                        <td>{c.identities_per_device === null ? "—" : Number(c.identities_per_device).toFixed(1)}</td>
                        <td><span style={{ color: b.tone, fontWeight: 600 }}>{Number(c.score).toFixed(0)} · {b.label}</span></td>
                        <td style={{ fontSize: 12.5 }}>{c.signals.join(", ") || "—"}</td>
                        <td style={{ fontSize: 12.5 }}>{when(c.first_seen_at)}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {c.status === "open" ? (
                            <>
                              <button className="btn small" disabled={busy !== null}
                                onClick={() => void resolveCluster(c.id, "cleared")}>Clear all</button>{" "}
                              <button className="btn small danger" disabled={busy !== null}
                                onClick={() => void resolveCluster(c.id, "upheld")}>Uphold all</button>
                            </>
                          ) : <span className="muted" style={{ fontSize: 12.5 }}>{c.status}</span>}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={8} style={{ background: "rgba(0,0,0,.02)" }}>
                            <div style={{ padding: "8px 4px", maxWidth: 820 }}>
                              <p className="muted" style={{ marginTop: 0, lineHeight: 1.55 }}>
                                {c.member_count} identities sharing {c.devices} device{c.devices === 1 ? "" : "s"} and{" "}
                                {c.networks} network{c.networks === 1 ? "" : "s"}. A household is two or three identities
                                per device; this one is{" "}
                                {c.identities_per_device === null ? "unknown" : Number(c.identities_per_device).toFixed(1)}.
                                Addresses shared by very large numbers of people — a mobile carrier, a campus — carry no
                                information about who is behind them and were dropped before this was computed.
                              </p>
                              <pre style={{ fontSize: 11.5, overflowX: "auto", margin: "6px 0" }}>
                                {JSON.stringify(c.evidence, null, 2)}
                              </pre>
                              <input
                                className="input" style={{ width: "100%", maxWidth: 560 }}
                                placeholder="Why — required to uphold, and what the respondents will see if they appeal"
                                value={reasons[c.id] ?? ""}
                                onChange={(e) => setReasons((s) => ({ ...s, [c.id]: e.target.value }))}
                              />
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ------------------------------------------------------------ the queue */}
      <div className="row" style={{ margin: "18px 0 6px", alignItems: "center" }}>
        <strong className="grow">Review queue</strong>
        {["open", "appealed", "upheld", "cleared", "all"].map((s) => (
          <button key={s} className={`btn small${filter === s ? " primary" : ""}`} onClick={() => setFilter(s)}>
            {s[0].toUpperCase() + s.slice(1)}{counts[s] !== undefined ? ` (${counts[s]})` : ""}
          </button>
        ))}
      </div>

      {!data && !error && <p className="muted">Loading…</p>}

      {data && !data.cases.length && (
        <p className="muted" data-testid="fraud-empty" style={{ maxWidth: 720, lineHeight: 1.55 }}>
          Nothing in this queue. Cross-vendor deduplication starts in shadow mode, where duplicates are recorded
          and nobody is turned away, so an empty queue early on means the platform is watching rather than that
          there is nothing to see.
        </p>
      )}

      {data && !!data.cases.length && (
        <div className="table-wrap">
          <table className="grid" data-testid="fraud-cases">
            <thead>
              <tr>
                <th>Opened</th><th>Kind</th><th>Risk</th><th>Why</th>
                <th>Payment</th><th>Status</th><th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {data.cases.map((c) => {
                const b = band(Number(c.risk_score));
                const open = expanded === c.id;
                return (
                  <React.Fragment key={c.id}>
                    <tr>
                      <td style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>{when(c.opened_at)}</td>
                      <td style={{ fontSize: 12.5 }}>
                        {c.kind.replace(/_/g, " ")}
                        {c.cluster_id && <div className="muted" style={{ fontSize: 11.5 }}>part of a network</div>}
                      </td>
                      <td><span style={{ color: b.tone, fontWeight: 600 }}>{Number(c.risk_score).toFixed(0)} · {b.label}</span></td>
                      <td style={{ fontSize: 12.5, maxWidth: 320 }}>
                        <button className="btn small" onClick={() => setExpanded(open ? null : c.id)}>
                          {open ? "▾" : "▸"} {c.reasons.length ? c.reasons.slice(0, 2).join(", ") : "no reason recorded"}
                          {c.reasons.length > 2 ? ` +${c.reasons.length - 2}` : ""}
                        </button>
                      </td>
                      <td style={{ fontSize: 12.5 }}>{c.holds_payment ? "Held" : "Released"}</td>
                      <td style={{ fontSize: 12.5 }}>
                        {c.status}
                        {c.appealed_at && <div className="muted" style={{ fontSize: 11.5 }}>appealed {when(c.appealed_at)}</div>}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {c.status === "open" || c.status === "appealed" ? (
                          <>
                            <button className="btn small" disabled={busy !== null}
                              onClick={() => void resolveCase(c.id, "cleared")}>Clear</button>{" "}
                            <button className="btn small danger" disabled={busy !== null}
                              onClick={() => void resolveCase(c.id, "upheld")}>Uphold</button>
                          </>
                        ) : <span className="muted" style={{ fontSize: 12.5 }}>{when(c.resolved_at)}</span>}
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={7} style={{ background: "rgba(0,0,0,.02)" }}>
                          <div style={{ padding: "8px 4px", maxWidth: 820 }}>
                            <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
                              {c.reasons.map((r) => <li key={r}>{r}</li>)}
                            </ul>
                            <pre style={{ fontSize: 11.5, overflowX: "auto", margin: "6px 0" }}>
                              {JSON.stringify(c.evidence, null, 2)}
                            </pre>
                            {c.resolution_note && <p style={{ fontSize: 13 }}><strong>Resolution:</strong> {c.resolution_note}</p>}
                            {c.appeal_note && <p style={{ fontSize: 13 }}><strong>Appeal:</strong> {c.appeal_note}</p>}
                            {(c.status === "open" || c.status === "appealed") && (
                              <input
                                className="input" style={{ width: "100%", maxWidth: 560 }}
                                placeholder="Why — required to uphold, and what the respondent will see if they appeal"
                                value={reasons[c.id] ?? ""}
                                onChange={(e) => setReasons((s) => ({ ...s, [c.id]: e.target.value }))}
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ------------------------------------------------------------ the door's own record (audit 2026-11-05) */}
      {data?.admissions && (
        <>
          <div className="row" style={{ margin: "18px 0 6px" }}>
            <strong className="grow">At the door — the last seven days</strong>
          </div>
          <p className="muted" style={{ fontSize: 12.5, maxWidth: 760, lineHeight: 1.55, marginTop: 0 }}>
            What the admission gateway decided for each arrival, and the evidence it rested on. Nobody is ever refused
            on a risk score alone; a duplicate refusal is an identity decision. In shadow mode a &ldquo;would have blocked&rdquo;
            count is the false-positive exposure, measurable before anyone is turned away.
          </p>
          <div className="row" style={{ gap: 14, flexWrap: "wrap", marginBottom: 8 }} data-testid="admissions-tally">
            {Object.entries(data.admissions.sevenDays.decisions).map(([k, v]) => (
              <span key={k} className="chip">{v.toLocaleString()} {DECISION_WORDS[k] ?? k}</span>
            ))}
            {Object.keys(data.admissions.sevenDays.decisions).length === 0 && <span className="muted" style={{ fontSize: 13 }}>No arrivals have passed through the gateway in the last seven days{data.admissions.sevenDays.available ? "" : " (or the gateway's tables are not yet applied)"}.</span>}
            {data.admissions.sevenDays.shadowBlocks > 0 && (
              <span className="chip warn" title="identity matches that would have refused the arrival, had shadow mode been off">{data.admissions.sevenDays.shadowBlocks.toLocaleString()} would have been blocked in shadow mode</span>
            )}
            {Object.entries(data.admissions.sevenDays.identity).map(([k, v]) => (
              <span key={`id-${k}`} className="muted" style={{ fontSize: 12.5 }}>{v.toLocaleString()} identity {k}</span>
            ))}
          </div>
          {!!data.admissions.recent.length && (
            <div className="table-wrap">
              <table className="grid" data-testid="admissions-recent">
                <thead>
                  <tr><th>When</th><th>Project</th><th>Vendor</th><th>Decision</th><th>Risk</th><th>Linked by</th><th>Reasons</th><th>Took</th></tr>
                </thead>
                <tbody>
                  {data.admissions.recent.map((a) => (
                    <tr key={a.id} data-testid="admission-row" data-decision={a.decision}>
                      <td style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>{when(a.occurred_at)}</td>
                      <td style={{ fontSize: 12.5, whiteSpace: "normal" }}><a href={`/studio/${a.survey_id}`}>{a.project ?? a.survey_id.slice(0, 8)}</a></td>
                      <td style={{ fontSize: 12.5 }}>{a.vendorName ?? (a.integration_id ? a.integration_id.slice(0, 8) : "direct")}</td>
                      <td style={{ fontSize: 12.5 }}>{DECISION_WORDS[a.decision] ?? a.decision}</td>
                      <td><span style={{ color: band(Number(a.risk_score)).tone }}>{Number(a.risk_score).toFixed(0)}</span> <span className="muted" style={{ fontSize: 12 }}>{a.risk_band}</span></td>
                      <td style={{ fontSize: 12.5 }}>{a.resolution ?? "—"}</td>
                      <td style={{ fontSize: 12.5, whiteSpace: "normal" }}>
                        {a.reasons?.length ? a.reasons.join(", ") : <span className="muted">none</span>}
                        {a.evidence && Object.keys(a.evidence).length > 0 && (
                          <details style={{ marginTop: 2 }}>
                            <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>evidence</summary>
                            <pre className="mono" style={{ fontSize: 11.5, whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{JSON.stringify(a.evidence, null, 1)}</pre>
                          </details>
                        )}
                      </td>
                      <td className="mono" style={{ fontSize: 12.5 }}>{a.decided_in_ms === null ? "—" : `${a.decided_in_ms} ms`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ------------------------------------------------------------ vendor quality */}
      {!!data?.quality.length && (
        <>
          <div className="row" style={{ margin: "18px 0 6px" }}>
            <strong className="grow">Vendor quality, from real outcomes</strong>
          </div>
          <p className="muted" style={{ fontSize: 12.5, maxWidth: 760, lineHeight: 1.55, marginTop: 0 }}>
            Every rate carries the interval it was measured with. A 20% rejection rate over five completes and
            over five thousand are different claims; the optimiser ranks on the pessimistic end, so a vendor with
            little history is neither trusted nor punished — it is simply not bet on.
          </p>
          <div className="table-wrap">
            <table className="grid" data-testid="fraud-quality">
              <thead>
                <tr>
                  <th>Vendor</th><th>Market</th><th>Accepted</th><th>Rejection</th>
                  <th>Interval</th><th>Score</th><th>Confidence</th><th>Cases</th>
                </tr>
              </thead>
              <tbody>
                {data.quality.map((q) => (
                  <tr key={`${q.integration_id}:${q.market ?? "*"}`}>
                    <td style={{ fontSize: 12.5 }}>{q.vendorName ?? q.integration_id.slice(0, 8)}</td>
                    <td style={{ fontSize: 12.5 }}>{q.market ?? "all"}</td>
                    <td>{q.accepted.toLocaleString()}</td>
                    <td>{pct(q.rejection_rate)}</td>
                    <td style={{ fontSize: 12.5 }}>
                      {q.rejection_low === null || q.rejection_high === null
                        ? "—"
                        : `${pct(q.rejection_low)} – ${pct(q.rejection_high)}`}
                    </td>
                    <td>
                      {q.quality_score === null
                        ? <span className="muted" title="Not enough accepted completes to score. Unknown is not a score of zero.">not yet</span>
                        : Number(q.quality_score).toFixed(0)}
                    </td>
                    <td style={{ fontSize: 12.5 }}>{q.confidence}</td>
                    <td>{q.fraud_cases}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
