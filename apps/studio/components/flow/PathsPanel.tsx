"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { explorePaths, comparePaths, type PathExploration, type PathComparison } from "@rescript/templates";
import { answersFromText } from "../../lib/flow/debug";

/**
 * PATHS — "who goes where" (audit plan #4, 2026-11-07).
 *
 *   Explore   N varied simulated respondents through the real engine: reach per flow element, endings, the routes
 *             most people take, pages and branch paths nobody reached, where walks were blocked.
 *   Compare   two answer sets side by side: where the routes part, the pages only one saw, and on shared pages
 *             the piped text and options that differ.
 *
 * Everything runs on the definition in the editor, in the browser — nothing is saved or sent.
 */
export function PathsPanel({ def, onSelect }: { def: SurveyDefinition; onSelect?: (pageId: string) => void }) {
  const [tab, setTab] = React.useState<"explore" | "compare">("explore");
  const [count, setCount] = React.useState(100);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [x, setX] = React.useState<PathExploration | null>(null);
  const [a, setA] = React.useState("");
  const [b, setB] = React.useState("");
  const pageLabel = React.useCallback((id: string) => {
    const base = id.split("@")[0]!;
    const find = (nodes: SurveyDefinition["flow"]): string | null => {
      for (const n of nodes) {
        if (n.id === base && n.type === "page") return (n as { title?: string }).title || base;
        const k = n as { children?: SurveyDefinition["flow"]; branches?: { children: SurveyDefinition["flow"] }[]; otherwise?: SurveyDefinition["flow"] };
        for (const c of [k.children, ...(k.branches ?? []).map((br) => br.children), k.otherwise]) { const r = c ? find(c) : null; if (r) return r; }
      }
      return null;
    };
    return find(def.flow) ?? base;
  }, [def]);

  const run = () => {
    setBusy(true); setErr(null);
    setTimeout(() => {
      try { setX(explorePaths(def, { count })); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
      setBusy(false);
    }, 20);
  };
  const cmp = React.useMemo<(PathComparison & { unknown: string[] }) | null>(() => {
    if (tab !== "compare" || (!a.trim() && !b.trim())) return null;
    try {
      const pa = answersFromText(def, a), pb = answersFromText(def, b);
      return { ...comparePaths(def, pa.answers, pb.answers), unknown: [...pa.unknown, ...pb.unknown] };
    } catch { return null; }
  }, [tab, def, a, b]);

  return (
    <div className="fc-paths" data-testid="flow-paths">
      <div className="fc-paths-head">
        <div className="fc-seg" role="tablist">
          <button role="tab" aria-selected={tab === "explore"} className={tab === "explore" ? "on" : ""} data-testid="paths-tab-explore" onClick={() => setTab("explore")}>Explore</button>
          <button role="tab" aria-selected={tab === "compare"} className={tab === "compare" ? "on" : ""} data-testid="paths-tab-compare" onClick={() => setTab("compare")}>Compare two</button>
        </div>
        {tab === "explore" && (
          <>
            <label className="fc-paths-n">Respondents
              <select value={count} onChange={(e) => setCount(Number(e.target.value))} data-testid="paths-count">
                {[50, 100, 300, 1000].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button className="btn btn-primary btn-sm" onClick={run} disabled={busy} data-testid="paths-run">{busy ? "Walking…" : x ? "Run again" : "Run"}</button>
          </>
        )}
      </div>
      {err && <div className="fc-paths-err" role="alert">{err}</div>}

      {tab === "explore" && x && (
        <div className="fc-paths-body" data-testid="paths-result">
          <div className="fc-paths-sum">
            <b>{x.respondents}</b> simulated respondents ·{" "}
            {Object.entries(x.endings).map(([k, v]) => <span key={k} className="fc-paths-pill">{k} {Math.round((v / x.respondents) * 100)}%</span>)}
          </div>
          {x.neverReached.length > 0 && (
            <div className="fc-paths-warn" data-testid="paths-never">
              <b>Nobody reached</b> {x.neverReached.map((n) => <button key={n.id} className="linklike" onClick={() => onSelect?.(n.id.split("/")[0]!)}>{n.kind === "page" ? pageLabel(n.id) : `${n.label}`}</button>)}
              <span className="muted"> — check the conditions in front of them, or run more respondents.</span>
            </div>
          )}
          {x.blocked.length > 0 && (
            <div className="fc-paths-warn" data-testid="paths-blocked">
              <b>Walks stopped by validation</b> {x.blocked.map((bk) => <span key={bk.pageId}>{pageLabel(bk.pageId)} ×{bk.count}: {bk.message}</span>)}
            </div>
          )}
          <table className="fc-paths-table" data-testid="paths-elements">
            <thead><tr><th>Flow element</th><th>Reached</th></tr></thead>
            <tbody>
              {x.elements.filter((e) => e.reached >= 0).map((e) => (
                <tr key={e.id} className={e.reached === 0 ? "zero" : ""} onClick={() => onSelect?.(e.id.split("/")[0]!)}>
                  <td style={{ paddingLeft: 8 + e.depth * 14 }}>{e.kind === "page" ? pageLabel(e.id) : e.label}</td>
                  <td><span className="fc-paths-bar"><i style={{ width: `${e.share}%` }} /></span> {e.share}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="fc-paths-sub">Most common routes</div>
          <ol className="fc-paths-routes" data-testid="paths-routes">
            {x.routes.map((r, i) => <li key={i}><b>{r.share}%</b> {r.pages.map(pageLabel).join(" → ")} <span className="muted">· {r.ending}</span></li>)}
          </ol>
        </div>
      )}
      {tab === "explore" && !x && !busy && <div className="fc-paths-body muted">Walks varied respondents (including edge cases) through the survey as it is in the editor and shows where they go.</div>}

      {tab === "compare" && (
        <div className="fc-paths-body">
          <label className="fc-paths-ans">A <input className="fc-debug-input" data-testid="paths-a" placeholder="Q1=1, Q2=Apple" value={a} onChange={(e) => setA(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></label>
          <label className="fc-paths-ans">B <input className="fc-debug-input" data-testid="paths-b" placeholder="Q1=2, Q2=Banana" value={b} onChange={(e) => setB(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></label>
          {cmp && (
            <div data-testid="paths-compare">
              <div className="fc-paths-sum">
                {cmp.partsAt ? <>Routes part at <b>{pageLabel(cmp.partsAt)}</b></> : <>Same route</>} · A ends <b>{cmp.a.ending}</b> after {cmp.a.pages.length} pages · B ends <b>{cmp.b.ending}</b> after {cmp.b.pages.length}
                {cmp.unknown.length > 0 && <span className="fc-paths-err"> · unknown: {cmp.unknown.join(", ")}</span>}
              </div>
              {(cmp.onlyA.length > 0 || cmp.onlyB.length > 0) && (
                <div className="fc-paths-cols">
                  <div><div className="fc-paths-sub">Only A sees</div>{cmp.onlyA.map((p) => <div key={p}>{pageLabel(p)}</div>)}</div>
                  <div><div className="fc-paths-sub">Only B sees</div>{cmp.onlyB.map((p) => <div key={p}>{pageLabel(p)}</div>)}</div>
                </div>
              )}
              {cmp.differences.length > 0 && (
                <table className="fc-paths-table" data-testid="paths-diffs">
                  <thead><tr><th>Question</th><th>A sees</th><th>B sees</th></tr></thead>
                  <tbody>{cmp.differences.map((d, i) => <tr key={i}><td>{d.code} <span className="muted">{d.what}</span></td><td>{d.a}</td><td>{d.b}</td></tr>)}</tbody>
                </table>
              )}
              {!cmp.partsAt && cmp.differences.length === 0 && <div className="muted">Both answer sets see the same pages, text and options.</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
