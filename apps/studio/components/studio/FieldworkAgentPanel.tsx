"use client";
import React from "react";

/**
 * THE FIELDWORK AGENT'S PROPOSALS (audit 2026-11-17, P3-03) on the fieldwork dashboard. Each says what it saw, what
 * it suggests and why. Accept or reject — with a reason, always; both are logged. A proposal that names a
 * questionnaire tool shows its dry run first; nothing changes until you approve it.
 */
type Proposal = { id: string; kind: string; severity: "high" | "medium" | "low"; saw: string; propose: string; why: string; tool?: { name: string; input: Record<string, unknown> } };
type Dry = { ok: boolean; description: string[]; destructive: string[]; approval: string; refused?: string; route?: { method: string; path: string } };

export function FieldworkAgentPanel({ surveyId, pace, fieldTo }: { surveyId: string; pace: unknown; fieldTo: string | null }) {
  const [proposals, setProposals] = React.useState<Proposal[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState<Record<string, string>>({});
  const [dry, setDry] = React.useState<Record<string, Dry>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const r = await fetch(`/api/surveys/${surveyId}/fieldwork/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pace, fieldTo }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setError(j.error ?? `The agent could not read the field (${r.status}).`); return; }
    setProposals(j.proposals ?? []);
  }, [surveyId, pace, fieldTo]);
  React.useEffect(() => { void load(); }, [load]);
  const decide = async (p: Proposal, decision: "accept" | "reject") => {
    setBusy(p.id);
    const r = await fetch(`/api/surveys/${surveyId}/fieldwork/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decide: { proposal: p, decision, reason: reason[p.id] ?? "" } }) });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) { setError(j.error ?? "Could not record the decision."); return; }
    setProposals((ps) => (ps ?? []).filter((x) => x.id !== p.id));
  };
  const dryRun = async (p: Proposal) => {
    if (!p.tool) return;
    setBusy(p.id);
    const r = await fetch(`/api/surveys/${surveyId}/tools`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: p.tool.name, input: p.tool.input, mode: "dry_run", agent: "fieldwork" }) });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    setDry((d) => ({ ...d, [p.id]: j }));
  };
  if (error) return <div className="chip warn qd-note" data-testid="fw-agent-error">{error}</div>;
  if (!proposals) return null;
  return (
    <div className="card" style={{ padding: 12, margin: "12px 0" }} data-testid="fw-agent">
      <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
        <strong>Suggestions</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>The fieldwork agent watches pace, quotas, quality and suppliers. It suggests; you decide.</span>
      </div>
      {proposals.length === 0 && <div className="muted" style={{ fontSize: 13, marginTop: 6 }} data-testid="fw-agent-none">Nothing needs attention.</div>}
      {proposals.map((p) => {
        const d = dry[p.id];
        return (
          <div key={p.id} className="card" style={{ padding: 10, marginTop: 8, borderColor: p.severity === "high" ? "var(--c-error-fg)" : p.severity === "medium" ? "var(--c-warning-fg)" : undefined }} data-testid={`fw-agent-${p.kind}`}>
            <div style={{ fontSize: 13 }}><strong>{p.severity === "high" ? "Act now" : p.severity === "medium" ? "Worth a look" : "For information"}:</strong> {p.saw}</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Suggestion: {p.propose}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>Why: {p.why}</div>
            {p.tool && (
              <div style={{ fontSize: 12.5, marginTop: 6 }}>
                <button type="button" className="btn small" disabled={busy === p.id} onClick={() => dryRun(p)} data-testid="fw-agent-dry">See what “{p.tool.name}” would do</button>
                {d && <div className="muted" style={{ marginTop: 4 }}>{d.ok ? `${d.description.join("; ")} — needs ${d.approval} approval${d.destructive.length ? `; removes: ${d.destructive.join(", ")}` : ""}. Apply it from the questionnaire's tools, or ask the copilot.` : d.route ? `Runs through ${d.route.method} ${d.route.path}, on its own screen.` : d.refused}</div>}
              </div>
            )}
            <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Your reason (required)" value={reason[p.id] ?? ""} onChange={(e) => setReason((r) => ({ ...r, [p.id]: e.target.value }))} data-testid="fw-agent-reason" />
              <button type="button" className="btn small" disabled={busy === p.id || !(reason[p.id] ?? "").trim()} onClick={() => decide(p, "accept")} data-testid="fw-agent-accept">Accept</button>
              <button type="button" className="btn small" disabled={busy === p.id || !(reason[p.id] ?? "").trim()} onClick={() => decide(p, "reject")} data-testid="fw-agent-reject">Reject</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
