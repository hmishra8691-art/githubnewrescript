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
        {snap.loop && (
          <tr><td className="k">loop</td><td>{snap.loop.loopVar} = {snap.loop.code} “{snap.loop.label}” (#{snap.loop.index})</td></tr>
        )}
        <tr><td className="k">seed</td><td>{snap.seed}</td></tr>
      </tbody></table>

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
