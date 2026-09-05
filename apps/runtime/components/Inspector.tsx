"use client";
import React from "react";
import type { InspectorSnapshot } from "@rescript/engine";

function Val({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span style={{ opacity: 0.5 }}>∅</span>;
  if (typeof v === "object") return <>{JSON.stringify(v)}</>;
  return <>{String(v)}</>;
}

export function Inspector({ snap, logs }: { snap: InspectorSnapshot; logs: string[] }) {
  return (
    <aside className="rs-inspector">
      <h3>Session</h3>
      <table><tbody>
        <tr><td className="k">status</td><td>{snap.status}</td></tr>
        <tr><td className="k">step</td><td>{snap.stepIndex + 1} / {snap.totalSteps}</td></tr>
        <tr><td className="k">page</td><td>{snap.page?.pageId ?? "—"} {snap.page?.title ? `(${snap.page.title})` : ""}</td></tr>
        <tr><td className="k">section</td><td>{snap.page?.sectionPath.join(" › ") || "—"}</td></tr>
        <tr><td className="k">seed</td><td>{snap.seed}</td></tr>
      </tbody></table>

      {snap.loops?.length > 0 && (
        <>
          {/*
            * LOOP DEBUG (§35). One block per enclosing loop, innermost first,
            * showing exactly the context the block is being run with — the
            * reference values here are what {{loop.X}} resolves to on this page.
            */}
          <h3>Loop debug</h3>
          {snap.loops.map((l, depth) => (
            <table key={`${l.loopId}-${l.code}`} data-testid="loop-debug" data-loop={l.loopVar} style={depth ? { opacity: 0.85 } : undefined}><tbody>
              <tr><td className="k">loop</td><td>{l.loopVar}{l.loopId ? <span style={{ opacity: 0.6 }}> · {l.loopId}</span> : null}{depth > 0 ? <span style={{ opacity: 0.6 }}> (outer)</span> : null}</td></tr>
              <tr><td className="k">iteration</td><td data-testid="loop-iteration">{l.index} / {l.count}</td></tr>
              <tr><td className="k">current item</td><td data-testid="loop-item">{l.label}</td></tr>
              <tr><td className="k">item code</td><td>{l.code}</td></tr>
              {Object.keys(l.references).length > 0 ? (
                <tr><td className="k">references</td><td>
                  {Object.entries(l.references).map(([k, v]) => (
                    <div key={k} data-testid="loop-ref" data-ref={k}><span style={{ opacity: 0.7 }}>{k}</span> = <Val v={v} /></div>
                  ))}
                </td></tr>
              ) : (
                <tr><td className="k">references</td><td style={{ opacity: 0.5 }}>none declared on this loop</td></tr>
              )}
            </tbody></table>
          ))}
        </>
      )}

      <h3>Display logic</h3>
      <table><tbody>
        {snap.displayLogicResults.map((r) => (
          <tr key={r.questionId}>
            <td className="k">{r.questionId}</td>
            <td>
              <span className={r.visible ? "true" : "false"}>{r.visible ? "SHOW" : "HIDE"}</span>
              {r.trace.map((t, i) => (
                <div key={i} style={{ opacity: 0.8 }}>
                  {t.rule} {t.operator} {JSON.stringify(t.right)} → <Val v={t.left} /> ⇒{" "}
                  <span className={t.result ? "true" : "false"}>{String(t.result)}</span>
                </div>
              ))}
            </td>
          </tr>
        ))}
      </tbody></table>

      {snap.optionPipelines.length > 0 && (
        <>
          <h3>Option pipeline</h3>
          {snap.optionPipelines.map((p) => (
            <div key={p.questionId} style={{ marginBottom: 10 }}>
              <div className="k" style={{ marginBottom: 2 }}>{p.code}</div>
              <table><tbody>
                {p.trace.stages.filter((st) => st.changed).map((st, i) => (
                  <tr key={i}>
                    <td className="k">{st.label}</td>
                    <td>
                      {st.after.join(", ") || "—"}
                      {st.removed.length > 0 && (
                        <div style={{ opacity: 0.75 }}>
                          − {st.removed.map((r) => `${r.code} (${r.reason})`).join("; ")}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {Object.values(p.trace.byCode).map((st) => (
                  <tr key={`o_${st.code}`}>
                    <td className="k">{st.code}</td>
                    <td>
                      <span className={st.status === "visible" ? "true" : "false"}>
                        {st.status === "visible" ? `VISIBLE #${st.position}` : "HIDDEN"}
                      </span>
                      {st.alwaysShow ? " · always show" : ""}
                      {st.pinned ? " · pinned" : ""}
                      {st.moved ? ` · moved ${st.moved}` : ""}
                      {st.status === "hidden" && (
                        <div style={{ opacity: 0.75 }}>{st.stage}: {st.reason}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          ))}
        </>
      )}

      <h3>Answers</h3>
      <table><tbody>
        {Object.entries(snap.answers).map(([k, v]) => (
          <tr key={k}><td className="k">{k}</td><td><Val v={v} /></td></tr>
        ))}
      </tbody></table>

      <h3>Calculated</h3>
      <table><tbody>
        {Object.entries(snap.calculated).length === 0 && <tr><td style={{ opacity: 0.5 }}>none</td></tr>}
        {Object.entries(snap.calculated).map(([k, v]) => (
          <tr key={k}><td className="k">{k}</td><td><Val v={v} /></td></tr>
        ))}
      </tbody></table>

      <h3>Embedded data</h3>
      <table><tbody>
        {Object.entries(snap.embedded).length === 0 && <tr><td style={{ opacity: 0.5 }}>none</td></tr>}
        {Object.entries(snap.embedded).map(([k, v]) => (
          <tr key={k}><td className="k">{k}</td><td><Val v={v} /></td></tr>
        ))}
      </tbody></table>

      <h3>Quotas</h3>
      {snap.quotas.length === 0 && <div style={{ opacity: 0.5 }}>none defined</div>}
      {snap.quotas.map((q) => (
        <div key={`${q.quotaId}:${q.cellId}`} style={{ marginBottom: 6 }}>
          <div>
            {q.quotaName} / {q.cellLabel} — {q.count}/{q.effectiveLimit || "∞"}{" "}
            {q.matchesRespondent && <span className="true">← matches</span>}{" "}
            {q.full && <span className="false">FULL</span>}
          </div>
          <div className="rs-quota-bar">
            <div className={`rs-quota-fill ${q.full ? "full" : ""}`}
              style={{ width: `${q.effectiveLimit ? Math.min(100, (q.count / q.effectiveLimit) * 100) : 0}%` }} />
          </div>
        </div>
      ))}

      {snap.listFills.length > 0 && (
        <>
          <h3>List Fill</h3>
          {snap.listFills.map((lf) => (
            <div key={lf.listFillId} style={{ marginBottom: 6 }} data-testid={`insp-listfill-${lf.listFillId}`}>
              <div>
                <span className="k">{lf.name}</span>{" "}
                {lf.items.length ? (
                  lf.items.map((it) => (
                    <span key={it.position} className="true" style={{ marginRight: 6 }}>
                      {it.position}. {it.code}{it.label !== it.code ? ` (${it.label})` : ""}
                    </span>
                  ))
                ) : lf.pending ? (
                  <span style={{ opacity: 0.6 }}>due to run — its source is ready but it has not allocated yet</span>
                ) : (
                  <span style={{ opacity: 0.5 }}>nothing allocated</span>
                )}
              </div>
              {lf.unusedDestinations.length > 0 && (
                <div style={{ opacity: 0.7 }}>
                  unused destinations: {lf.unusedDestinations.map((d) => `${d.questionId} → ${d.rule}`).join(", ")}
                </div>
              )}
            </div>
          ))}
        </>
      )}

      <h3>Flat variables</h3>
      <table><tbody>
        {Object.entries(snap.flatVariables).map(([k, v]) => (
          <tr key={k}><td className="k">{k}</td><td><Val v={v} /></td></tr>
        ))}
      </tbody></table>

      {snap.flags.length > 0 && (
        <>
          <h3>Flags</h3>
          <pre>{snap.flags.join("\n")}</pre>
        </>
      )}

      {logs.length > 0 && (
        <>
          <h3>Script log</h3>
          <pre>{logs.join("\n")}</pre>
        </>
      )}
    </aside>
  );
}
