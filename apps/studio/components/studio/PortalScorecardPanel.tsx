"use client";
import React from "react";
import { isAssessment, scorecardProblems } from "@rescript/engine";
import { PortalSettings, type ScoreDimension } from "@rescript/schema";
import { calculatedVariables, groupingQuestions, itemKey, newScoreId, scorableItems } from "@/lib/portalScoresCore";
import { useStudio } from "./store";

/**
 * SCORES AND COMPARISONS FOR THE RESPONDENT PORTAL (phase 2, 2026-11-20) — inside the Respondent portal section.
 *
 * The researcher names the scores of this survey: each one points at marks the survey already has (a test's total
 * or a topic, a calculated variable) or adds up answers. They choose what a respondent sees (scores, the name of
 * the range, a comparison), and which groups people are compared within. Everything here is saved with the survey
 * and applies once published; "Score existing responses" then brings earlier responses up to date.
 *
 * A comparison is only ever shown for a group of at least ten people; the minimum can be raised, not lowered.
 */
interface Status { available: boolean; ready: boolean; why: string | null; completed: number; upToDate: number; compared: { people: number; at: string } | null }
type Source = ScoreDimension["source"];
const KINDS: { kind: Source["kind"]; label: string }[] = [
  { kind: "items", label: "Answers added up" },
  { kind: "variable", label: "A calculated variable" },
  { kind: "test_total", label: "The test's total marks" },
  { kind: "test_topic", label: "One topic of the test" },
];
const numOrUndef = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));

export function PortalScorecardPanel() {
  const s = useStudio();
  const portal = s.def.portal;
  const set = (f: (p: PortalSettings) => void) => s.update((d) => { d.portal = d.portal ?? PortalSettings.parse({ enabled: true }); f(d.portal); });
  const dims = portal?.scorecard?.dimensions ?? [];
  const setDim = (i: number, f: (x: ScoreDimension) => void) => set((p) => { const x = p.scorecard?.dimensions[i]; if (x) f(x); });
  const items = React.useMemo(() => scorableItems(s.def), [s.def]);
  const variables = React.useMemo(() => calculatedVariables(s.def), [s.def]);
  const groupable = React.useMemo(() => groupingQuestions(s.def), [s.def]);
  const problems = React.useMemo(() => scorecardProblems(s.def), [s.def]);
  const test = isAssessment(s.def);
  const [open, setOpen] = React.useState<number | null>(null);

  const [status, setStatus] = React.useState<Status | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<{ text: string; ok: boolean } | null>(null);
  const load = React.useCallback(async () => {
    if (!s.surveyDbId) return;
    const r = await fetch(`/api/surveys/${s.surveyDbId}/portal/scores`, { cache: "no-store" });
    if (r.ok) setStatus(await r.json());
  }, [s.surveyDbId]);
  React.useEffect(() => { if (dims.length) void load(); }, [dims.length, load]);

  const rescore = async () => {
    setBusy(true); setNote(null);
    let after: string | null = null, scored = 0, skipped = 0;
    for (let page = 0; page < 2000; page++) {
      const r: Response = await fetch(`/api/surveys/${s.surveyDbId}/portal/scores`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ after }) });
      const j: { error?: string; scored?: number; skipped?: number; next?: string | null } = await r.json().catch(() => ({}));
      if (!r.ok) { setBusy(false); setNote({ text: j.error ?? `That did not work (${r.status}).`, ok: false }); return; }
      scored += j.scored ?? 0; skipped += j.skipped ?? 0; after = j.next ?? null;
      setNote({ text: `Scoring… ${scored} so far`, ok: true });
      if (!after) break;
    }
    setBusy(false);
    setNote({ text: `${scored} response${scored === 1 ? "" : "s"} scored${skipped ? `; ${skipped} could not be scored (their version could not be read)` : ""}.`, ok: true });
    await load();
  };

  const addDim = () => {
    const at = dims.length;
    set((p) => {
      p.scorecard = p.scorecard ?? { dimensions: [] };
      const label = `Score ${p.scorecard.dimensions.length + 1}`;
      p.scorecard.dimensions.push({ id: newScoreId(label, p.scorecard.dimensions.map((x) => x.id)), label, source: test ? { kind: "test_total" } : { kind: "items", method: "sum", items: [] }, higherIsBetter: true, bands: [] });
    });
    setOpen(at);
  };
  const setKind = (i: number, kind: Source["kind"]) => setDim(i, (x) => {
    x.source = kind === "items" ? { kind, method: "sum", items: [] } : kind === "variable" ? { kind, name: variables[0]?.code ?? "" } : kind === "test_topic" ? { kind, topic: "" } : { kind };
  });
  const toggleItem = (i: number, key: string) => setDim(i, (x) => {
    if (x.source.kind !== "items") return;
    const at = x.source.items.findIndex((it) => itemKey(it) === key);
    if (at >= 0) { x.source.items.splice(at, 1); return; }
    const it = items.find((o) => o.key === key);
    if (it) x.source.items.push({ question: it.question, ...(it.row !== undefined ? { row: it.row } : {}), reverse: false });
  });

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--c-border, #e5e7eb)" }} data-testid="portal-scorecard">
      <div className="row" style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13.5 }}>Scores and comparisons</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>What a respondent is told about their own results.</span>
      </div>

      <div className="row" style={{ gap: 16, marginTop: 8, flexWrap: "wrap", fontSize: 13 }}>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={!!portal?.show.scores} onChange={(e) => set((p) => { p.show.scores = e.target.checked; })} data-testid="portal-show-scores" /> Respondents can see their scores</label>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={portal?.show.bands !== false} disabled={!portal?.show.scores} onChange={(e) => set((p) => { p.show.bands = e.target.checked; })} data-testid="portal-show-bands" /> …with the name of the range (Low, High)</label>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={!!portal?.show.comparison && !!portal?.benchmark.enabled} disabled={!portal?.show.scores} onChange={(e) => set((p) => { p.show.comparison = e.target.checked; p.benchmark.enabled = e.target.checked; })} data-testid="portal-show-comparison" /> …and how they compare with others</label>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={!!portal?.show.trends} disabled={!portal?.show.scores} onChange={(e) => set((p) => { p.show.trends = e.target.checked; })} data-testid="portal-show-trends" /> …and how they have changed over time</label>
      </div>
      {portal?.show.scores && !dims.length && <div className="chip warn qd-note" style={{ marginTop: 8 }}>No scores are defined yet, so there is nothing to show. Add one below.</div>}

      <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
        {dims.map((d, i) => {
          const mine = problems.filter((p) => p.dimension === d.id);
          const chosen = d.source.kind === "items" ? new Map(d.source.items.map((it) => [itemKey(it), it])) : null;
          return (
            <div key={i} className="card" style={{ padding: 10 }} data-testid={`portal-score-${i}`}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <input className="input" style={{ maxWidth: 220 }} value={d.label} aria-label="Name of the score" onChange={(e) => setDim(i, (x) => { x.label = e.target.value; })} />
                <select className="select" style={{ maxWidth: 220 }} value={d.source.kind} aria-label="Where the score comes from" onChange={(e) => setKind(i, e.target.value as Source["kind"])}>
                  {KINDS.filter((k) => test || k.kind === d.source.kind || (k.kind !== "test_total" && k.kind !== "test_topic")).map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                </select>
                {mine.length > 0 && <span className="chip warn">{mine.length} to fix</span>}
                <span className="grow" />
                <button type="button" className="btn small" onClick={() => setOpen(open === i ? null : i)}>{open === i ? "Close" : "Edit"}</button>
                <button type="button" className="btn small" onClick={() => { set((p) => { p.scorecard?.dimensions.splice(i, 1); }); setOpen(null); }} aria-label={`Remove ${d.label}`}>Remove</button>
              </div>
              {mine.map((p, k) => <div key={k} className="chip warn qd-note" style={{ marginTop: 6 }}>{p.message}</div>)}

              {open === i && (
                <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                  {d.source.kind === "variable" && (
                    <label style={{ fontSize: 13 }}>Variable
                      <select className="select" value={d.source.name} onChange={(e) => setDim(i, (x) => { if (x.source.kind === "variable") x.source.name = e.target.value; })}>
                        {!variables.some((v) => d.source.kind === "variable" && v.code === d.source.name) && <option value={d.source.name}>{d.source.name || "Choose…"}</option>}
                        {variables.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
                      </select>
                    </label>
                  )}
                  {d.source.kind === "test_topic" && (
                    <label style={{ fontSize: 13 }}>Topic, exactly as it is tagged on the questions
                      <input className="input" value={d.source.topic} onChange={(e) => setDim(i, (x) => { if (x.source.kind === "test_topic") x.source.topic = e.target.value; })} />
                    </label>
                  )}
                  {d.source.kind === "items" && chosen && (
                    <div style={{ fontSize: 13 }}>
                      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                        <span>Answers to count</span>
                        <select className="select" style={{ maxWidth: 200 }} value={d.source.method} aria-label="How they are combined" onChange={(e) => setDim(i, (x) => { if (x.source.kind === "items") x.source.method = e.target.value as "sum" | "mean"; })}>
                          <option value="sum">Added up (every one must be answered)</option>
                          <option value="mean">Averaged (at least half answered)</option>
                        </select>
                      </div>
                      {items.length === 0 && <p className="muted" style={{ margin: "6px 0 0" }}>This survey has no single-choice or rating questions with numbered points to add up.</p>}
                      <div style={{ maxHeight: 220, overflowY: "auto", marginTop: 6, border: "1px solid var(--c-border, #e5e7eb)", borderRadius: 8, padding: 6 }}>
                        {items.map((it) => {
                          const on = chosen.get(it.key);
                          return (
                            <div key={it.key} className="row" style={{ gap: 8, padding: "2px 0" }}>
                              <label className="row grow" style={{ gap: 6 }}><input type="checkbox" checked={!!on} onChange={() => toggleItem(i, it.key)} /> {it.label}</label>
                              {on && <label className="row muted" style={{ gap: 4, fontSize: 12 }}><input type="checkbox" checked={!!on.reverse} onChange={(e) => setDim(i, (x) => { if (x.source.kind !== "items") return; const t = x.source.items.find((y) => itemKey(y) === it.key); if (t) t.reverse = e.target.checked; })} /> reversed</label>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
                    <label style={{ fontSize: 13 }}>Lowest possible
                      <input className="input" type="number" placeholder={d.source.kind === "variable" ? "Needed" : "Worked out"} value={d.min ?? ""} onChange={(e) => setDim(i, (x) => { x.min = numOrUndef(e.target.value); })} />
                    </label>
                    <label style={{ fontSize: 13 }}>Highest possible
                      <input className="input" type="number" placeholder={d.source.kind === "variable" ? "Needed" : "Worked out"} value={d.max ?? ""} onChange={(e) => setDim(i, (x) => { x.max = numOrUndef(e.target.value); })} />
                    </label>
                    <label style={{ fontSize: 13 }}>A better result is
                      <select className="select" value={d.higherIsBetter ? "high" : "low"} onChange={(e) => setDim(i, (x) => { x.higherIsBetter = e.target.value === "high"; })}>
                        <option value="high">A higher score</option>
                        <option value="low">A lower score</option>
                      </select>
                    </label>
                  </div>
                  <label style={{ fontSize: 13 }}>Over time, a change smaller than this is "about the same" (optional)
                    <input className="input" type="number" min={0} step="any" style={{ maxWidth: 140 }} placeholder="Any change counts" value={d.minChange ?? ""} onChange={(e) => setDim(i, (x) => { const n = numOrUndef(e.target.value); x.minChange = n !== undefined && n > 0 ? n : undefined; })} />
                  </label>
                  <label style={{ fontSize: 13 }}>What this score means, in the respondent's words (optional)
                    <input className="input" maxLength={600} value={d.description ?? ""} onChange={(e) => setDim(i, (x) => { x.description = e.target.value || undefined; })} />
                  </label>
                  <div style={{ fontSize: 13 }}>
                    <div className="row" style={{ gap: 8 }}><span>Named ranges</span><span className="muted" style={{ fontSize: 12 }}>Each range runs up to and including its value. Describe, do not diagnose.</span></div>
                    {d.bands.map((b, k) => (
                      <div key={k} className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                        <span className="muted">up to</span>
                        <input className="input" type="number" style={{ maxWidth: 90 }} value={b.upTo} aria-label="Up to" onChange={(e) => setDim(i, (x) => { const n = Number(e.target.value); if (Number.isFinite(n)) x.bands[k]!.upTo = n; })} />
                        <input className="input" style={{ maxWidth: 150 }} value={b.label} placeholder="Name" aria-label="Name of the range" onChange={(e) => setDim(i, (x) => { x.bands[k]!.label = e.target.value; })} />
                        <input className="input grow" style={{ minWidth: 160 }} value={b.note ?? ""} placeholder="What it means (optional)" aria-label="What the range means" onChange={(e) => setDim(i, (x) => { x.bands[k]!.note = e.target.value || undefined; })} />
                        <button type="button" className="btn small" onClick={() => setDim(i, (x) => { x.bands.splice(k, 1); })} aria-label="Remove range">×</button>
                      </div>
                    ))}
                    <button type="button" className="btn small" style={{ marginTop: 6 }} disabled={d.bands.length >= 12} onClick={() => setDim(i, (x) => { x.bands.push({ upTo: (x.bands.at(-1)?.upTo ?? 0) + 1, label: `Range ${x.bands.length + 1}` }); })}>Add a range</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="row" style={{ gap: 12, marginTop: 8, flexWrap: "wrap", fontSize: 13 }}>
        <button type="button" className="btn small" onClick={addDim} disabled={dims.length >= 40} data-testid="portal-add-score">Add a score</button>
        {dims.length > 1 && (
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={!!portal?.scorecard?.overall} onChange={(e) => set((p) => { if (!p.scorecard) return; p.scorecard.overall = e.target.checked ? { label: "Overall" } : undefined; })} /> One headline figure (0 to 100):
            <input className="input" style={{ maxWidth: 180 }} disabled={!portal?.scorecard?.overall} value={portal?.scorecard?.overall?.label ?? ""} placeholder="Overall" aria-label="Name of the headline figure" onChange={(e) => set((p) => { if (p.scorecard?.overall) p.scorecard.overall.label = e.target.value || "Overall"; })} />
          </label>
        )}
      </div>

      {portal?.show.comparison && portal.benchmark.enabled && (
        <div style={{ marginTop: 12, fontSize: 13 }} data-testid="portal-benchmark">
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <span>A comparison is shown for a group of at least</span>
            <input className="input" type="number" min={10} style={{ maxWidth: 90 }} value={portal.benchmark.minCohort} aria-label="Smallest group" onChange={(e) => set((p) => { p.benchmark.minCohort = Math.max(10, Math.floor(Number(e.target.value) || 10)); })} />
            <span>people. Ten is the lowest allowed.</span>
          </div>
          <p className="muted" style={{ margin: "6px 0", fontSize: 12.5 }}>Everyone is compared with everyone. Add a group to also compare a person with their own group — never with another.</p>
          {portal.benchmark.groups.map((g, k) => (
            <div key={k} className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
              <input className="input" style={{ maxWidth: 160 }} value={g.label} aria-label="Name of the grouping" onChange={(e) => set((p) => { p.benchmark.groups[k]!.label = e.target.value; })} />
              <select className="select" style={{ maxWidth: 180 }} value={g.source.kind} aria-label="Grouped by" onChange={(e) => set((p) => { p.benchmark.groups[k]!.source = e.target.value === "embedded" ? { kind: "embedded", ref: "" } : { kind: "question", ref: groupable[0]?.id ?? "" }; })}>
                <option value="question">By a question</option>
                <option value="embedded">By a field of the respondent list</option>
              </select>
              {g.source.kind === "question"
                ? <select className="select grow" style={{ minWidth: 180 }} value={g.source.ref} aria-label="Question" onChange={(e) => set((p) => { p.benchmark.groups[k]!.source.ref = e.target.value; })}>{!groupable.some((q) => q.id === g.source.ref) && <option value={g.source.ref}>Choose…</option>}{groupable.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}</select>
                : <input className="input grow" style={{ minWidth: 180 }} value={g.source.ref} placeholder="Field name, e.g. department" aria-label="Field name" onChange={(e) => set((p) => { p.benchmark.groups[k]!.source.ref = e.target.value; })} />}
              <button type="button" className="btn small" onClick={() => set((p) => { p.benchmark.groups.splice(k, 1); })} aria-label="Remove grouping">×</button>
            </div>
          ))}
          <button type="button" className="btn small" style={{ marginTop: 6 }} disabled={portal.benchmark.groups.length >= 6} onClick={() => set((p) => { const label = `Group ${p.benchmark.groups.length + 1}`; p.benchmark.groups.push({ id: newScoreId(label, p.benchmark.groups.map((x) => x.id)), label, source: { kind: "question", ref: groupable[0]?.id ?? "" } }); })}>Add a group</button>
          {problems.filter((p) => portal.benchmark.groups.some((g) => g.id === p.dimension) && !dims.some((d) => d.id === p.dimension)).map((p, k) => <div key={k} className="chip warn qd-note" style={{ marginTop: 6 }}>{p.message}</div>)}
        </div>
      )}

      {portal?.show.trends && (
        <div style={{ marginTop: 12, fontSize: 13 }} data-testid="portal-series">
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={!!portal.series} onChange={(e) => set((p) => { p.series = e.target.checked ? { id: newScoreId(s.def.meta.title || "series", []), label: s.def.meta.title || "Series" } : undefined; })} data-testid="portal-series-on" />
            This survey is one of a series, or is taken again at intervals
          </label>
          {portal.series && (
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", marginTop: 8 }}>
              <label>Name of the series, as respondents see it
                <input className="input" maxLength={120} value={portal.series.label} onChange={(e) => set((p) => { if (p.series) p.series.label = e.target.value || "Series"; })} />
              </label>
              <label>Series key (the same in every survey of the series)
                <input className="input mono" maxLength={60} value={portal.series.id} onChange={(e) => set((p) => { const v = e.target.value.replace(/[^A-Za-z0-9_-]/g, ""); if (p.series && v) p.series.id = v; })} />
              </label>
              <label>What this survey is called in the series (optional)
                <input className="input" maxLength={60} placeholder="2026, Spring term, Week 6" value={portal.series.period ?? ""} onChange={(e) => set((p) => { if (p.series) p.series.period = e.target.value || undefined; })} />
              </label>
              <label>Taken again every … days (optional)
                <input className="input" type="number" min={1} max={1830} placeholder="Not repeated" value={portal.series.repeatEveryDays ?? ""} onChange={(e) => set((p) => { if (!p.series) return; const n = Math.floor(Number(e.target.value)); p.series.repeatEveryDays = n >= 1 && n <= 1830 ? n : undefined; })} />
              </label>
            </div>
          )}
          <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>Results are compared over time only when a score is made the same way: the same questions by code, the same scale and the same range. Taking it again also needs retakes allowed, or more than one attempt, in the settings above.</p>
        </div>
      )}

      {dims.length > 0 && (
        <div className="row" style={{ gap: 10, marginTop: 12, flexWrap: "wrap", fontSize: 12.5 }} data-testid="portal-scores-status">
          <button type="button" className="btn small" disabled={busy || !status?.ready} onClick={rescore} data-testid="portal-rescore">{busy ? "Scoring…" : "Score existing responses"}</button>
          {status && !status.ready && <span className="muted">{status.why}</span>}
          {status?.ready && <span className="muted">{status.upToDate} of {status.completed} completed responses carry the current scores{status.compared ? `; the portal last compared ${status.compared.people} people` : ""}.</span>}
          {note && <span className={`chip ${note.ok ? "on" : "warn"}`}>{note.text}</span>}
        </div>
      )}
      <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>New responses are scored when they are submitted. After changing a score or a group, publish, then score the existing responses so everyone is compared the same way.</p>
    </div>
  );
}
