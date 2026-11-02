"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import type { ImportJob, ImportClarification, ImportReconstruction, ImportVerification } from "./ImportCard";

/**
 * I7 — THE IMPORT REVIEW: everything the import would create, before it is created.
 *
 *   Summary         what was read and what would be created, in counts and sentences
 *   Compatibility   every element in one of six categories, with the reason
 *   Flow & logic    the source flow in order: blocks, questions with their conditions and skips in words,
 *                   branches, randomizers, embedded data, ends and redirects, and what each question depends on
 *   Reconstruction  the dynamic relationships (carried and masked lists, loops, piping) in three groups:
 *                   A mapped natively as the source states it (counts by feature, and the synthetic respondents),
 *                   B rebuilt another native way by the importer's self-correction (original, reading,
 *                   implementation, why), C requiring attention (to confirm, partial, not possible) — each C item
 *                   opens the decision that edits it when the source left one, or says what to do
 *   Questions       the decisions the source leaves open (the same panel as the card)
 *   Blocks          choose which blocks to import; re-run the analysis
 *
 * Clicking an element opens the inspector: the element as the reader understood the source, beside the
 * reconstructed Rescript element. Nothing here writes a survey: Create project / Add to this survey stay on the
 * card, after the review.
 */
type Cat = "full" | "converted" | "configure" | "partial" | "unsupported" | "clarify";
const CATS: [Cat, string][] = [["full", "Fully supported"], ["converted", "Supported with conversion"], ["configure", "Requires additional configuration"], ["partial", "Partially supported"], ["unsupported", "Unsupported"], ["clarify", "Requires your clarification"]];
interface OutlineNode { depth: number; kind: string; sourceId: string; label: string; condition?: string; skips?: string[]; redirect?: string }
interface CompatItem { category: Cat; feature: string; sourceId: string; label: string; note?: string }
interface Edge { from: string; to: string; kind: string; location: string }
export interface ReviewExtras {
  compatibility?: { counts: Record<Cat, number>; items: CompatItem[] };
  outline?: OutlineNode[];
  blocks?: { id: string; title: string; questions: number }[];
  graph?: { edges: Edge[]; findings: { kind: string; severity: string; location: string; message: string }[] };
  mapping?: { summary: Record<string, number> };
}

export function ImportReview({ job, onClose, onRerun, renderQuestions }: {
  job: ImportJob;
  onClose(): void;
  onRerun(blocks: string[] | undefined): void;
  renderQuestions(): React.ReactNode;
}) {
  const r = job.report as (NonNullable<ImportJob["report"]> & ReviewExtras) | undefined;
  const [tab, setTab] = React.useState<"summary" | "compat" | "recon" | "flow" | "questions" | "blocks">("summary");
  const [inspect, setInspect] = React.useState<{ source: string; data?: { kind: string; source: unknown; issues: { message: string }[] } | { error: string } } | null>(null);
  const [chosen, setChosen] = React.useState<Set<string> | null>(job.blocks ? new Set(job.blocks) : null);
  const dialog = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { dialog.current?.focus(); const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc); }, [onClose]);
  if (!r) return null;
  const clar: ImportClarification[] = r.clarifications ?? [];
  const recon = (r as { reconstruction?: ImportReconstruction }).reconstruction;
  const dyn = job.verification && !("error" in job.verification) ? (job.verification as ImportVerification).dynamics : undefined;

  const open = async (source: string) => {
    setInspect({ source });
    try {
      const res = await fetch(`/api/import/sessions/${encodeURIComponent(job.sessionId ?? "")}/inspect?source=${encodeURIComponent(source)}`);
      setInspect({ source, data: await res.json() });
    } catch (e) { setInspect({ source, data: { error: (e as Error).message } }); }
  };
  const rebuilt = (source: string): unknown => {
    const m = job.mapping?.find((x) => x.source === source || x.source.startsWith(`${source} (`));
    const def = job.definition as SurveyDefinition | null | undefined;
    if (!m || !def) return null;
    const q = def.questions.find((x) => x.id === m.rescript);
    if (q) return q;
    let found: unknown = null;
    const walk = (ns: unknown[]) => { for (const n of ns as { id?: string; children?: unknown[]; branches?: { children: unknown[] }[]; otherwise?: unknown[] }[]) { if (n.id === m.rescript) { found = n; return; } if (n.children) walk(n.children); for (const b of n.branches ?? []) walk(b.children); if (n.otherwise) walk(n.otherwise); } };
    walk(def.flow as unknown[]);
    return found;
  };
  const dependsOn = (sourceId: string) => (r.graph?.edges ?? []).filter((e) => e.from === `q:${sourceId}` && e.kind !== "inside").map((e) => `${e.kind.replace(/_/g, " ")} ← ${e.to.replace(/^\w+:/, "")}`);
  const counts = r.compatibility?.counts;
  const blocks = job.allBlocks ?? r.blocks ?? [];
  const sel = chosen ?? new Set(blocks.map((b) => b.id));

  return (
    <div className="iqr-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="iqr" role="dialog" aria-modal="true" aria-label={`Import review — ${job.fileName}`} tabIndex={-1} ref={dialog} data-testid="iqr">
        <header className="iqr-head">
          <b>Import review — {job.fileName}</b>{r.source.title ? <span className="iqi-dim"> · “{r.source.title}”</span> : null}
          <span className="iq-spacer" />
          <button type="button" className="iq-btn" onClick={onClose} data-testid="iqr-close">Close</button>
        </header>
        <nav className="iqr-tabs" role="tablist">
          {([["summary", "Summary"], ["compat", "Compatibility"], ["recon", `Reconstruction${recon ? ` (${recon.items.length})` : ""}`], ["flow", "Flow & logic"], ["questions", `Questions (${clar.length})`], ["blocks", `Blocks (${blocks.length})`]] as const).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={`iq-btn${tab === k ? " on" : ""}`} onClick={() => setTab(k)} data-testid={`iqr-tab-${k}`}>{l}</button>
          ))}
        </nav>
        <div className="iqr-body">
          <section className="iqr-main">
            {tab === "summary" && (
              <div data-testid="iqr-summary">
                <ul>{r.summary.map((x, i) => <li key={i}>{x}</li>)}</ul>
                <table className="iqr-table"><tbody>
                  {([["Questions", r.detected.questions], ["Blocks", r.detected.blocks], ["Embedded variables", r.detected.embeddedFields], ["Branches", r.detected.branches], ["Display logic", r.detected.displayLogic], ["Skip rules", r.detected.skipLogic], ["Randomizers", r.detected.randomizers], ["Validation rules", r.detected.validations], ["Redirects", (r.outline ?? []).filter((n) => n.redirect).length], ["Custom scripts", r.detected.customLogic ?? 0]] as [string, number][]).map(([k, v]) => <tr key={k}><th scope="row">{k}</th><td data-testid={`iqr-count-${k.toLowerCase().replace(/\s+/g, "-")}`}>{v ?? 0}</td></tr>)}
                </tbody></table>
                {counts && <p className="iqr-cats">{CATS.map(([k, l]) => <span key={k} className={`iqi-badge c-${k}`} data-testid={`iqr-cat-count-${k}`}>{l} <b>{counts[k]}</b></span>)}</p>}
              </div>
            )}
            {tab === "compat" && r.compatibility && (
              <div data-testid="iqr-compat">
                {CATS.map(([k, l]) => {
                  const its = r.compatibility!.items.filter((i) => i.category === k);
                  return (
                    <details key={k} open={k !== "full" && its.length > 0} data-testid={`iqr-compat-${k}`}>
                      <summary>{l} ({its.length})</summary>
                      <ul>{its.slice(0, 300).map((i, n) => <li key={n}><button type="button" className="iqr-link" onClick={() => void open(i.sourceId)} data-testid="iqr-compat-item">{i.label}</button>{i.note ? <span className="iqi-dim"> — {i.note}</span> : null}</li>)}</ul>
                    </details>
                  );
                })}
              </div>
            )}
            {tab === "recon" && (
              <div data-testid="iqr-recon">
                {!recon || recon.items.length === 0 ? <p className="iqi-dim">The source has no carried or masked list, loop or piping to reconstruct.</p> : (() => {
                  const A = recon.items.filter((i) => i.category === "reconstructed");
                  const B = recon.items.filter((i) => i.category === "alternative");
                  const C = recon.items.filter((i) => i.category === "confirm" || i.category === "partial" || i.category === "unsupported");
                  const decisionFor = (loc: string, qid?: string) => clar.find((x) => x.location === loc || (qid && x.questionId === qid) || x.location.split(/[\s—-]/)[0] === loc);
                  const tested = (loc: string) => (dyn?.scenarios ?? []).filter((x) => x.target.split(", ").includes(loc));
                  const testLine = (loc: string) => { const t = tested(loc); return t.length ? <span className={t.some((x) => x.result === "fail") ? "iq-error" : "iqi-dim"} data-testid="iqr-recon-tested"> · respondents: {t.filter((x) => x.result === "pass").length}/{t.length} behave</span> : null; };
                  const row = (i: ImportReconstruction["items"][number], n: number) => (
                    <li key={n} data-category={i.category} data-feature={i.feature} data-testid="iqr-recon-item">
                      <b>{i.location}</b> <span className={`iqi-badge c-${i.category}`}>{i.category === "confirm" ? "to confirm" : i.category}</span> <span className="iqi-dim">{i.feature.replace(/_/g, " ")}</span>{testLine(i.location)}
                      <dl className="iqr-recon-dl">
                        <dt>Source</dt><dd>“{i.original}”</dd>
                        <dt>Read as</dt><dd>{i.interpretation}</dd>
                        <dt>Rescript</dt><dd className="mono">{i.implementation}</dd>
                        <dt>Why</dt><dd>{i.why}</dd>
                        {i.action && <><dt>To do</dt><dd>{i.action}</dd></>}
                      </dl>
                      {i.category !== "reconstructed" && (decisionFor(i.location, i.questionId)
                        ? <button type="button" className="iq-btn" onClick={() => setTab("questions")} data-testid="iqr-recon-edit">Change this reading…</button>
                        : <span className="iqi-dim"> No choice was left open here — edit {i.location} in the survey after it is created.</span>)}
                    </li>
                  );
                  return (
                    <>
                      <p className="iqr-cats">
                        <span className="iqi-badge c-full" data-testid="iqr-recon-count-a">A · mapped <b>{A.length}</b></span>
                        <span className="iqi-badge c-converted" data-testid="iqr-recon-count-b">B · rebuilt another way <b>{B.length}</b></span>
                        <span className="iqi-badge c-clarify" data-testid="iqr-recon-count-c">C · requires attention <b>{C.length}</b></span>
                        <span className="iqi-dim"> · checked in {recon.passes} pass{recon.passes === 1 ? "" : "es"}{dyn ? ` · ${dyn.passed} of ${dyn.scenarios.length} respondent scenarios behave as expected${dyn.failed ? `, ${dyn.failed} do not` : ""}` : ""}</span>
                      </p>
                      <details open={C.length > 0} data-testid="iqr-recon-c">
                        <summary>C · Requires attention ({C.length})</summary>
                        {C.length ? <ul>{C.map(row)}</ul> : <p className="iqi-dim">Nothing.</p>}
                      </details>
                      <details open={B.length > 0} data-testid="iqr-recon-b">
                        <summary>B · Rebuilt with another native feature ({B.length})</summary>
                        {B.length ? <ul>{B.map(row)}</ul> : <p className="iqi-dim">Nothing.</p>}
                      </details>
                      <details data-testid="iqr-recon-a">
                        <summary>A · Mapped natively as the source states it ({A.length})</summary>
                        <table className="iqr-table"><tbody>
                          {Object.entries(recon.byFeature).map(([f, k]) => <tr key={f}><th scope="row">{f.replace(/_/g, " ")}</th><td>{k.reconstructed ?? 0} mapped</td><td className="iqi-dim">{(k.alternative ?? 0) + (k.confirm ?? 0) + (k.partial ?? 0) + (k.unsupported ?? 0)} other</td></tr>)}
                        </tbody></table>
                        <ul>{A.map(row)}</ul>
                      </details>
                    </>
                  );
                })()}
              </div>
            )}
            {tab === "flow" && (
              <ol className="iqr-outline" data-testid="iqr-flow">
                {(r.outline ?? []).map((n, i) => (
                  <li key={i} style={{ paddingLeft: n.depth * 18 }} data-kind={n.kind} data-testid="iqr-flow-node">
                    <button type="button" className="iqr-link" onClick={() => void open(n.sourceId)}><span className={`iqr-kind k-${n.kind}`}>{n.kind.replace("_", " ")}</span> {n.label}</button>
                    {n.condition && <span className="iqr-chip" data-testid="iqr-cond">{n.kind === "branch" ? "when" : "shown if"} {n.condition}</span>}
                    {n.skips?.map((x, j) => <span key={j} className="iqr-chip">skip {x}</span>)}
                    {n.redirect && <span className="iqr-chip" data-testid="iqr-redirect">→ {n.redirect}</span>}
                    {n.kind === "question" && dependsOn(n.sourceId).length > 0 && <span className="iqi-dim"> · depends on {dependsOn(n.sourceId).join(", ")}</span>}
                  </li>
                ))}
              </ol>
            )}
            {tab === "questions" && <div data-testid="iqr-questions">{clar.length ? renderQuestions() : <p className="iqi-dim">No open questions — the source decided everything it could be read for.</p>}</div>}
            {tab === "blocks" && (
              <div data-testid="iqr-blocks">
                <p className="iqi-dim">Import only some blocks. What the chosen blocks refer to outside the selection is reported after the re-run, never rewritten.</p>
                <ul className="iqr-blocklist">{blocks.map((b) => (
                  <li key={b.id}><label><input type="checkbox" checked={sel.has(b.id)} onChange={(e) => { const s = new Set(sel); if (e.target.checked) s.add(b.id); else s.delete(b.id); setChosen(s); }} data-testid="iqr-block" /> {b.title} <span className="iqi-dim">({b.questions} question{b.questions === 1 ? "" : "s"})</span></label></li>
                ))}</ul>
                <div className="iq-actions">
                  <span className="iqi-dim">{sel.size} of {blocks.length} selected</span><span className="iq-spacer" />
                  <button type="button" className="iq-btn" disabled={job.deciding || !job.sessionId} onClick={() => onRerun(undefined)} data-testid="iqr-rerun-all">Re-run with every block</button>
                  <button type="button" className="iq-btn primary" disabled={job.deciding || !job.sessionId || sel.size === 0 || sel.size === blocks.length} onClick={() => onRerun([...sel])} data-testid="iqr-rerun-selected">{job.deciding ? "Re-analysing…" : "Import selected blocks"}</button>
                </div>
              </div>
            )}
          </section>
          {inspect && (
            <aside className="iqr-inspect" data-testid="iqr-inspect" aria-label={`Inspector — ${inspect.source}`}>
              <header><b>{inspect.source}</b><span className="iq-spacer" /><button type="button" className="iq-btn" onClick={() => setInspect(null)}>×</button></header>
              <h4>As read from the source</h4>
              <pre data-testid="iqr-inspect-source">{inspect.data ? JSON.stringify("error" in inspect.data ? inspect.data : inspect.data.source, null, 2).slice(0, 20000) : "Loading…"}</pre>
              {inspect.data && "issues" in inspect.data && inspect.data.issues.length > 0 && <ul>{inspect.data.issues.map((x, i) => <li key={i} className="iqi-dim">{x.message}</li>)}</ul>}
              <h4>Reconstructed in Rescript</h4>
              <pre data-testid="iqr-inspect-rebuilt">{JSON.stringify(rebuilt(inspect.source), null, 2)?.slice(0, 20000) ?? "— not created (see the source's issues)"}</pre>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
