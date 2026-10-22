"use client";
import React from "react";
import { allSegments } from "@/lib/qual/qualWorkspace";
import type { WorkspaceView } from "./qualApi";
import type { SynthesisApi, AssignmentView } from "./synthesisApi";

/**
 * BLIND DOUBLE-CODING (2026-10-22) — set up an assignment (a seeded x % of each source's participant segments, two
 * coders: two people, or you and the AI), code it without seeing the other coder, submit; when both have
 * submitted: Cohen's κ and Krippendorff's α per code, pooled and mean, and each disagreement to resolve — apply or
 * not, with a note — then merge the agreed and resolved codings into the coding as reviewed excerpts.
 */
type Run = <T>(label: string, fn: () => Promise<T>, done?: (v: T) => void) => Promise<T | undefined>;
const k2 = (x: number | null) => (x == null ? "—" : x.toFixed(2));

export function DoubleCodingTab({ ws, api, run, setWs }: { ws: WorkspaceView; api: SynthesisApi; run: Run; setWs: (w: WorkspaceView) => void }) {
  const [data, setData] = React.useState<{ me: string; assignments: AssignmentView[] } | null>(null);
  const [form, setForm] = React.useState({ coderB: "ai", other: "", overlapPct: 20, name: "" });
  const reload = React.useCallback(() => run("Loading assignments", () => api.assignments(), setData), [api, run]);
  React.useEffect(() => { void reload(); }, [reload]);
  const segs = React.useMemo(() => allSegments(ws), [ws]);
  const codes = ws.state.codebook.codes;
  const who = (id: string) => (id === "ai" ? "AI" : id === data?.me ? "You" : ws.people[id] ?? id.slice(0, 8));
  const after = (p: Promise<unknown>) => p.then(() => reload());
  return (
    <div data-testid="qual-double">
      {!ws.can.code && <div className="alert info">Double-coding needs Data: View and Data Analytics: Edit.</div>}
      {ws.can.code && (
        <div className="card ql-section" data-testid="dc-form">
          <div className="eyebrow">Set up blind double-coding</div>
          <p className="ql-muted">A seeded sample of each source's participant segments is coded by two coders who cannot see each other's coding until both submit. The codes are the current codebook.</p>
          <div className="ql-row">
            <label>Overlap <input className="input small" type="number" min={1} max={100} style={{ width: 70 }} value={form.overlapPct} data-testid="dc-overlap" onChange={(e) => setForm({ ...form, overlapPct: Number(e.target.value) })} /> %</label>
            <label>Second coder <select className="select small" value={form.coderB} data-testid="dc-coder-b" onChange={(e) => setForm({ ...form, coderB: e.target.value })}><option value="ai">The AI</option><option value="other">A colleague (user id)…</option>{Object.entries(ws.people).filter(([id]) => id !== "ai" && id !== data?.me).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></label>
            {form.coderB === "other" && <input className="input small" placeholder="colleague's user id" value={form.other} onChange={(e) => setForm({ ...form, other: e.target.value })} />}
            <input className="input small" placeholder="Name (optional)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <button type="button" className="btn primary small" data-testid="dc-create" disabled={!codes.length} onClick={() => run("Setting up", () => api.createAssignment({ coderB: form.coderB === "other" ? form.other : form.coderB, overlapPct: form.overlapPct, ...(form.name ? { name: form.name } : {}) }), () => void reload())}>Set up</button>
          </div>
          {!codes.length && <p className="ql-muted">Propose or add codes first.</p>}
        </div>
      )}
      {data?.assignments.map((a) => (
        <div key={a.id} className="card ql-section" data-testid="dc-assignment" data-status={a.status} data-role={a.role} data-blind={a.blind ? "1" : "0"}>
          <div className="ql-row">
            <b>{a.name}</b><span className="chip">{a.units.length} segments · {a.overlapPct}%</span><span className="badge neutral">{a.status}</span>
            <span className="ql-muted">{who(a.coderA)} {a.submitted[a.coderA] ? "✓ submitted" : `(${a.progress[a.coderA] ?? 0} coded)`} · {who(a.coderB)} {a.submitted[a.coderB] ? "✓ submitted" : `(${a.progress[a.coderB] ?? 0} coded)`}</span>
            <span className="grow" />
            {(a.coderA === "ai" || a.coderB === "ai") && !a.submitted.ai && a.status === "coding" && <button type="button" className="btn small" data-testid="dc-ai-code" onClick={() => void run("The AI is coding blind", () => after(api.aiCode(a.id)))}>Let the AI code</button>}
            {a.role !== "lead" && !a.submitted[data.me] && a.status === "coding" && <button type="button" className="btn small primary" data-testid="dc-submit" onClick={() => void run("Submitting", () => after(api.submit(a.id)))}>Submit my coding</button>}
          </div>
          {a.blind && <p className="ql-muted" data-testid="dc-blind">Blind: {a.role === "lead" ? "you see progress only" : "you see only your own coding"} until both coders submit.</p>}
          {a.role !== "lead" && a.status === "coding" && !a.submitted[data.me] && (
            <div className="table-wrap"><table className="grid ql-segments" data-testid="dc-units"><thead><tr><th>Segment</th><th>Text</th>{a.codeIds.map((c) => <th key={c}>{codes.find((x) => x.id === c)?.name ?? c}</th>)}</tr></thead><tbody>
              {a.units.slice(0, 200).map((u) => {
                const [src, sid] = u.split("|");
                const seg = segs.find((s) => s.sourceId === src && s.id === sid);
                return (
                  <tr key={u} data-testid="dc-unit" data-unit={u}>
                    <td>{sid}</td><td>{seg?.text ?? ""}</td>
                    {a.codeIds.map((c) => {
                      const mine = a.mine.find((e) => e.codeId === c && e.sourceId === src && e.segmentId === sid);
                      return <td key={c}><input type="checkbox" checked={!!mine} data-testid="dc-apply" data-code={c} onChange={() => void run("Coding", () => after(mine ? api.coderOp(a.id, { op: "remove_excerpt", excerptId: mine.id }) : api.coderOp(a.id, { op: "add_excerpt", codeId: c, sourceId: src, segmentId: sid, charStart: 0, charEnd: seg?.text.length ?? 0 })))} /></td>;
                    })}
                  </tr>
                );
              })}
            </tbody></table><p className="ql-muted">Ticking a code applies it to the whole turn.</p></div>
          )}
          {a.agreement && (
            <div data-testid="dc-agreement" data-pooled-kappa={a.agreement.pooled.kappa ?? ""} data-pooled-alpha={a.agreement.pooled.alpha ?? ""}>
              <p className="ql-muted">{a.agreement.note} Pooled κ {k2(a.agreement.pooled.kappa)}, pooled α {k2(a.agreement.pooled.alpha)}, mean κ {k2(a.agreement.meanKappa)}.</p>
              <div className="table-wrap"><table className="grid"><thead><tr><th>Code</th><th>κ</th><th>α</th><th>Reading</th><th>Both</th><th>Only {who(a.coderA)}</th><th>Only {who(a.coderB)}</th><th>Neither</th></tr></thead><tbody>
                {a.agreement.codes.map((c) => <tr key={c.codeId} data-testid="dc-row" data-kappa={c.kappa ?? ""} data-alpha={c.alpha ?? ""}><td>{c.codeName}</td><td>{k2(c.kappa)}</td><td>{k2(c.alpha)}</td><td>{c.kappaWords} / {c.alphaWords}</td><td>{c.table.both}</td><td>{c.table.onlyA}</td><td>{c.table.onlyB}</td><td>{c.table.neither}</td></tr>)}
              </tbody></table></div>
            </div>
          )}
          {a.disagreements && a.disagreements.length > 0 && (
            <div data-testid="dc-disagreements">
              <div className="eyebrow">Disagreements ({a.disagreements.filter((d) => !d.resolution).length} to resolve)</div>
              {a.disagreements.map((d) => <Disagreement key={`${d.unit}|${d.codeId}`} d={d} a={a} who={who} onResolve={(decision, note) => void run("Resolving", () => after(api.resolveDisagreement(a.id, { unit: d.unit, codeId: d.codeId, decision, note })))} text={segs.find((s) => `${s.sourceId}|${s.id}` === d.unit)?.text ?? ""} />)}
            </div>
          )}
          {a.agreement && a.status !== "merged" && (a.disagreements ?? []).every((d) => d.resolution) && ws.can.code && <button type="button" className="btn small primary" data-testid="dc-merge" onClick={() => run("Merging", () => api.merge(a.id), (r) => { if (r.ws) setWs(r.ws); void reload(); })}>Merge into the coding</button>}
          {a.resolutions.length > 0 && <details><summary className="ql-muted">Resolution history ({a.resolutions.length})</summary><ul className="ql-list">{a.resolutions.map((r, i) => <li key={i} data-testid="dc-history-item">{r.at.slice(0, 16).replace("T", " ")} · {who(r.by)} — {r.unit.split("|")[1]} / {codes.find((c) => c.id === r.codeId)?.name ?? r.codeId}: {r.decision === "apply" ? "apply" : "do not apply"}{r.note ? ` — ${r.note}` : ""}</li>)}</ul></details>}
        </div>
      ))}
    </div>
  );
}

function Disagreement({ d, a, who, onResolve, text }: { d: NonNullable<AssignmentView["disagreements"]>[number]; a: AssignmentView; who: (id: string) => string; onResolve: (decision: "apply" | "not_apply", note?: string) => void; text: string }) {
  const [note, setNote] = React.useState("");
  return (
    <div className="ql-excerpt" data-testid="dc-disagreement" data-unit={d.unit} data-code={d.codeId} data-resolved={d.resolution ? d.resolution.decision : ""}>
      <div><b>{d.codeName}</b> on {d.unit.split("|")[1]}: applied by {who(d.appliedBy === "A" ? a.coderA : a.coderB)} only</div>
      <blockquote>“{d.quoteA ?? d.quoteB ?? text}”</blockquote>
      {d.resolution ? <span className="badge success">{d.resolution.decision === "apply" ? "Apply" : "Do not apply"}{d.resolution.note ? ` — ${d.resolution.note}` : ""}</span> : (
        <div className="ql-row">
          <input className="input small" placeholder="why (optional)" value={note} data-testid="dc-note" onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn small" data-testid="dc-apply-code" onClick={() => onResolve("apply", note || undefined)}>Apply the code</button>
          <button type="button" className="btn small" data-testid="dc-not-apply" onClick={() => onResolve("not_apply", note || undefined)}>Do not apply</button>
        </div>
      )}
    </div>
  );
}
