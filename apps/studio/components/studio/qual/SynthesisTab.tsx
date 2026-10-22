"use client";
import React from "react";
import { compareGroups, formatTimestamp, themeCounts, OBJECTIVE_WORDS, VERDICT_WORDS, FREQUENCY_NOTE, COVERAGE_NOTE, type SynthClaim, type SynthesisSection } from "@rescript/analytics";
import { allSegments } from "@/lib/qual/qualWorkspace";
import type { WorkspaceView } from "./qualApi";
import type { SynthesisApi, SynthesisState, AskResult } from "./synthesisApi";

/**
 * SYNTHESIS (2026-10-22) — Research Tools → Qualitative → Synthesis: AI theme summaries (what people said, nuance,
 * tensions, who said it by group, what runs against it), the study's key findings per objective and hypothesis, a
 * comparison of two participant groups (by code), and a question asked of the data — every sentence citing the
 * excerpts it rests on, every count the Studio's, AI-written vs edited always visible, stale when the coding changed.
 */

type Run = <T>(label: string, fn: () => Promise<T>, done?: (v: T) => void) => Promise<T | undefined>;
const SECTION_WORDS: Record<SynthesisSection, string> = { summary: "What people said", nuance: "Nuance", tensions: "Tensions", bySegment: "By participant group", contradicting: "What runs against it" };

export function SynthesisTab({ ws, api, run }: { ws: WorkspaceView; api: SynthesisApi; run: Run }) {
  const [st, setSt] = React.useState<SynthesisState | null>(null);
  const [dropped, setDropped] = React.useState<{ text: string; reason: string; section?: string }[] | null>(null);
  const [question, setQuestion] = React.useState("");
  const [answer, setAnswer] = React.useState<AskResult | null>(null);
  const segs = React.useMemo(() => allSegments(ws), [ws]);
  const groups = React.useMemo(() => [...new Set(segs.filter((s) => s.role !== "moderator").map((s) => s.group).filter((g): g is string => !!g))].sort(), [segs]);
  const [pair, setPair] = React.useState<{ a: string; b: string }>({ a: "", b: "" });
  React.useEffect(() => { void run("Loading the synthesis", () => api.load(), setSt); }, [api, run, ws.version]);
  const byId = React.useMemo(() => new Map(ws.state.excerpts.map((e) => [e.id, e])), [ws]);
  const title = (id: string) => ws.transcripts.find((t) => t.id === id)?.title ?? "source";
  const themes = ws.state.codebook.themes.filter((t) => t.status !== "rejected");
  const cmp = pair.a && pair.b && pair.a !== pair.b ? compareGroups(ws.state, segs, pair.a, pair.b) : null;

  const Claim = ({ c, themeId, section, index, version }: { c: SynthClaim; themeId?: string; section?: SynthesisSection; index?: number; version?: number }) => {
    const [editing, setEditing] = React.useState(false);
    const [text, setText] = React.useState(c.text);
    return (
      <li data-testid="syn-claim" data-origin={c.origin} data-cites={c.excerptIds.join(",")}>
        {editing ? <span className="ql-row"><input className="input small" style={{ minWidth: 380 }} value={text} data-testid="syn-claim-input" onChange={(e) => setText(e.target.value)} /><button type="button" className="btn small primary" data-testid="syn-claim-save" onClick={() => { setEditing(false); if (themeId && section && index !== undefined && version) void run("Saving the edit", () => api.editTheme(themeId, version, { section, index, text }), setSt); }}>Save</button></span>
          : <>{c.group ? <b>{c.group}: </b> : null}{c.text}{c.interpretation && <span className="badge neutral" title="the writer's reading, not participants' words"> interpretation</span>} <span className={`badge ${c.origin === "ai" ? "warning" : "success"}`} data-testid="syn-origin">{c.origin === "ai" ? "AI-written" : c.origin === "edited" ? "Edited" : "Researcher"}</span>{c.support ? <span className="ql-muted"> · {c.support.sources} source{c.support.sources === 1 ? "" : "s"}</span> : null}
            {themeId && section && index !== undefined && ws.can.code && ws.pii && <button type="button" className="btn ghost small" data-testid="syn-claim-edit" onClick={() => setEditing(true)}>Edit</button>}</>}
        <div className="ql-cites">{c.excerptIds.slice(0, 3).map((id) => { const e = byId.get(id); return e ? <blockquote key={id} className="ql-quote-small" data-testid="syn-quote" data-id={id}>“{e.quote}” <span className="ql-muted">— {title(e.sourceId)}{e.speaker ? ` · ${e.speaker}` : ""}{e.start != null ? ` · ${formatTimestamp(e.start)}` : ""} [{id}]</span></blockquote> : <span key={id} className="ql-muted">[{id} — no longer in the coding]</span>; })}</div>
      </li>
    );
  };

  return (
    <div data-testid="qual-synthesis">
      <div className="alert info" data-testid="syn-note">AI-written from the coded excerpts only: every sentence cites the excerpts it rests on (uncited sentences, sentences naming a group without its evidence and sentences stating numbers the excerpts do not give are dropped). Every count below is computed by the Studio. {FREQUENCY_NOTE}</div>
      {!ws.can.code && <div className="alert info">Reading only: writing or editing the synthesis needs Data: View and Data Analytics: Edit.</div>}

      <div className="card ql-section" data-testid="syn-themes">
        <div className="ql-row"><div className="eyebrow">Theme summaries</div><span className="grow" />
          {ws.can.code && <button type="button" className="btn primary small" data-testid="syn-write-themes" disabled={!themes.length} onClick={() => run("Writing theme summaries (AI)", () => api.writeThemes(), (r) => { setSt(r.state); setDropped(r.dropped); })}>{st && Object.keys(st.themes).length ? "Regenerate all" : "Summarise the themes (AI)"}</button>}
        </div>
        {!themes.length && <div className="empty">No themes yet — group codes under themes in Coding first.</div>}
        {dropped && <p className="ql-muted" data-testid="syn-dropped" data-count={dropped.length}>{dropped.length ? `${dropped.length} sentence(s) were dropped: ${dropped.slice(0, 4).map((d) => d.reason).join("; ")}` : "No sentence had to be dropped."}</p>}
        {themes.map((t) => {
          const v = st?.themes[t.id];
          const counts = themeCounts(ws.state, segs, t.id);
          return (
            <div key={t.id} className="ql-section" data-testid="syn-theme" data-name={t.name} data-state={v?.record.state ?? "missing"} data-status={v?.record.status ?? ""}>
              <div className="ql-row">
                <b>{t.name}</b>
                <span className="chip" data-testid="syn-counts">{counts.sources} of {counts.totalSources} sources · {counts.segments} segments · {counts.participants} participants</span>
                {v && <span className={`badge ${v.record.state === "stale" ? "warning" : "success"}`} data-testid="syn-state">{v.record.state === "stale" ? "Stale — the coding changed" : "Current"}</span>}
                {v && <span className="ql-muted">v{v.version} · {v.record.status === "edited" ? "edited" : "AI-written"} · {v.record.coverage.words}</span>}
                <span className="grow" />
                {ws.can.code && <button type="button" className="btn small" data-testid="syn-write-theme" onClick={() => run("Writing the summary (AI)", () => api.writeThemes([t.id]), (r) => { setSt(r.state); setDropped(r.dropped); })}>{v ? "Regenerate" : "Summarise"}</button>}
              </div>
              {Object.keys(counts.byGroup).length > 1 && <p className="ql-muted" data-testid="syn-by-group">{Object.entries(counts.byGroup).map(([g, c]) => `${g}: ${c.segments} of ${c.groupSegments} segments (${c.share}%)`).join(" · ")}</p>}
              {v && (["summary", "nuance", "tensions", "bySegment", "contradicting"] as SynthesisSection[]).filter((s) => v.record[s].length).map((s) => (
                <div key={s}><div className="ql-muted">{SECTION_WORDS[s]}</div><ul className="ql-list">{v.record[s].map((c, i) => <Claim key={i} c={c} themeId={t.id} section={s} index={i} version={v.version} />)}</ul></div>
              ))}
            </div>
          );
        })}
        <p className="ql-muted">{COVERAGE_NOTE}</p>
      </div>

      <div className="card ql-section" data-testid="syn-insights" data-state={st?.insights?.record.state ?? "missing"}>
        <div className="ql-row"><div className="eyebrow">Key findings by objective</div><span className="grow" />
          {ws.can.code && <button type="button" className="btn primary small" data-testid="syn-write-insights" onClick={() => run("Writing the key findings (AI)", () => api.writeInsights(cmp ? [cmp.a, cmp.b] : null), (r) => { setSt(r.state); setDropped(r.dropped); })}>{st?.insights ? "Regenerate findings" : "Write key findings (AI)"}</button>}
        </div>
        {st?.insights && (() => {
          const ins = st.insights.record;
          return (
            <div>
              <p className="ql-muted">v{st.insights.version} · {ins.status === "edited" ? "edited" : "AI-written"} · {ins.state === "stale" ? "stale — the coding changed" : "current"} · {ins.totals.sources} sources, {ins.totals.excerpts} excerpts</p>
              {ins.executiveSummary.length > 0 && <><div className="ql-muted">Executive summary</div><ul className="ql-list">{ins.executiveSummary.map((c, i) => <Claim key={i} c={c} />)}</ul></>}
              {ins.objectives.map((o) => (
                <div key={o.ref} className="ql-section" data-testid="syn-objective" data-ref={o.ref} data-status={o.status}>
                  <div className="ql-row"><b>{o.ref}</b> {o.objective} <span className={`badge ${o.status === "answered" ? "success" : o.status === "partial" ? "warning" : "neutral"}`}>{OBJECTIVE_WORDS[o.status]}</span></div>
                  {o.note && <p className="ql-muted">{o.note}</p>}
                  <ul className="ql-list">{o.findings.map((c, i) => <Claim key={i} c={c} />)}</ul>
                </div>
              ))}
              {ins.hypotheses.map((h) => <div key={h.ref} className="ql-row" data-testid="syn-hypothesis" data-verdict={h.verdict}><b>{h.ref}</b> {h.hypothesis} <span className="badge neutral">{VERDICT_WORDS[h.verdict]}</span><ul className="ql-list">{h.claims.map((c, i) => <Claim key={i} c={c} />)}</ul></div>)}
              {ins.surprises.length > 0 && <><div className="ql-muted">Surprises</div><ul className="ql-list">{ins.surprises.map((c, i) => <Claim key={i} c={c} />)}</ul></>}
              {ins.framing.kind !== "none" ? <><div className="ql-muted">{ins.framing.kind === "journey" ? "The journey" : "Decision drivers"}</div>{ins.framing.stages.map((s) => <div key={s.name}><b>{s.name}</b><ul className="ql-list">{s.claims.map((c, i) => <Claim key={i} c={c} />)}</ul></div>)}</> : <p className="ql-muted" data-testid="syn-framing">No journey or decision-driver framing: {ins.framing.reason}.</p>}
              {ins.recommendations.length > 0 && <div data-testid="syn-recommendations"><div className="ql-muted">Recommendations — interpretation, not findings</div><ul className="ql-list">{ins.recommendations.map((c, i) => <Claim key={i} c={c} />)}</ul></div>}
            </div>
          );
        })()}
      </div>

      <div className="card ql-section" data-testid="syn-compare">
        <div className="eyebrow">Compare two participant groups</div>
        {groups.length < 2 ? <p className="ql-muted">Assign speakers to participant groups (Transcripts → Open → speakers) to compare them.</p> : (
          <div className="ql-row">
            <select className="select small" value={pair.a} data-testid="syn-compare-a" onChange={(e) => setPair({ ...pair, a: e.target.value })}><option value="">group…</option>{groups.map((g) => <option key={g}>{g}</option>)}</select>
            <span>vs</span>
            <select className="select small" value={pair.b} data-testid="syn-compare-b" onChange={(e) => setPair({ ...pair, b: e.target.value })}><option value="">group…</option>{groups.map((g) => <option key={g}>{g}</option>)}</select>
          </div>
        )}
        {cmp && (
          <div className="table-wrap"><table className="grid" data-testid="syn-compare-table"><thead><tr><th>Theme</th><th>{cmp.a} ({cmp.base.a.segments} seg)</th><th>{cmp.b} ({cmp.base.b.segments} seg)</th><th>Difference (points)</th></tr></thead><tbody>
            {cmp.rows.map((r) => <tr key={r.themeId} data-testid="syn-compare-row" data-theme={r.theme}><td>{r.theme}</td><td>{r.a.segments} ({r.a.share}%){r.quoteA ? <div className="ql-muted">“{r.quoteA.quote}”</div> : null}</td><td>{r.b.segments} ({r.b.share}%){r.quoteB ? <div className="ql-muted">“{r.quoteB.quote}”</div> : null}</td><td>{r.difference > 0 ? "+" : ""}{r.difference}</td></tr>)}
          </tbody></table><p className="ql-muted">{cmp.note}</p></div>
        )}
      </div>

      <div className="card ql-section" data-testid="syn-ask">
        <div className="eyebrow">Ask the data</div>
        <div className="ql-row">
          <input className="input" style={{ minWidth: 420 }} placeholder="What did Mumbai participants say about price?" value={question} data-testid="syn-ask-input" onChange={(e) => setQuestion(e.target.value)} />
          <button type="button" className="btn small primary" data-testid="syn-ask-go" disabled={question.trim().length < 3 || !ws.can.code} onClick={() => run("Asking", () => api.ask(question), setAnswer)}>Ask</button>
        </div>
        {answer && (
          <div data-testid="syn-answer" data-enough={answer.notEnoughEvidence ? "0" : "1"}>
            {answer.notEnoughEvidence ? <p data-testid="syn-answer-none"><b>Not enough evidence.</b> {answer.note}</p> : <ul className="ql-list">{answer.claims.map((c, i) => <Claim key={i} c={c} />)}</ul>}
            {answer.groups.length > 0 && <p className="ql-muted">Searched only: {answer.groups.join(", ")} · {answer.retrieved} of {answer.considered} excerpts retrieved</p>}
            {!answer.notEnoughEvidence && <p className="ql-muted">{answer.note}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
