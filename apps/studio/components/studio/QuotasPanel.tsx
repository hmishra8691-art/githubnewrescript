"use client";
import React from "react";
import { useStudio, uid } from "./store";
import { ConditionEditor, conditionToText } from "./ConditionBuilder";

/** Quota manager + live dashboard (requirement §15). */
export function QuotasPanel() {
  const s = useStudio();
  const [counts, setCounts] = React.useState<Record<string, Record<string, number>>>({});

  const refresh = React.useCallback(() => {
    fetch(`/api/surveys/${s.surveyDbId}/quotas`).then((r) => r.json())
      .then((d) => setCounts(d.counts ?? {})).catch(() => {});
  }, [s.surveyDbId]);
  React.useEffect(refresh, [refresh]);

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Quotas</h2>
        <span className="grow" />
        <button className="btn small" onClick={refresh}>↻ refresh counts</button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Hard quotas terminate when full (add a <em>quota check</em> node in the Survey Flow to enforce
        mid-survey); soft quotas only flag. Percent limits use the quota&apos;s target total.
        Multi-dimensional quotas = one cell per crossing (e.g. Male × 18–24).
      </p>
      {s.def.quotas.map((qt, qi) => (
        <div key={qt.id} className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <input className="input" style={{ width: 220 }} value={qt.name}
              onChange={(e) => s.update((d) => { d.quotas[qi].name = e.target.value; })} />
            <select className="select" value={qt.mode}
              onChange={(e) => s.update((d) => { d.quotas[qi].mode = e.target.value as any; })}>
              <option value="hard">hard</option><option value="soft">soft</option>
            </select>
            <label className="row" style={{ gap: 4 }}>target total
              <input className="input" style={{ width: 90 }} type="number" value={qt.targetTotal ?? ""}
                onChange={(e) => s.update((d) => { d.quotas[qi].targetTotal = e.target.value === "" ? undefined : Number(e.target.value); })} />
            </label>
            <select className="select" value={qt.onFull.kind}
              onChange={(e) => s.update((d) => { d.quotas[qi].onFull.kind = e.target.value as any; })}>
              <option value="terminate">terminate</option>
              <option value="redirect">redirect</option>
              <option value="flag">flag</option>
              <option value="warn">warn</option>
            </select>
            <span className="grow" />
            <button className="btn small danger" onClick={() => s.update((d) => { d.quotas.splice(qi, 1); })}>× quota</button>
          </div>

          {qt.cells.map((cell, ci) => {
            const count = counts[qt.id]?.[cell.id] ?? 0;
            const limit = cell.limitType === "percent"
              ? Math.floor((cell.limit / 100) * (qt.targetTotal ?? 0))
              : cell.limit;
            const pct = limit ? Math.min(100, (count / limit) * 100) : 0;
            return (
              <div key={cell.id} className="card" style={{ padding: 10 }}>
                <div className="row">
                  <input className="input" style={{ width: 180 }} value={cell.label}
                    onChange={(e) => s.update((d) => { d.quotas[qi].cells[ci].label = e.target.value; })} />
                  <input className="input" style={{ width: 84 }} type="number" value={cell.limit}
                    onChange={(e) => s.update((d) => { d.quotas[qi].cells[ci].limit = Number(e.target.value); })} />
                  <select className="select" style={{ width: 100 }} value={cell.limitType}
                    onChange={(e) => s.update((d) => { d.quotas[qi].cells[ci].limitType = e.target.value as any; })}>
                    <option value="count">count</option><option value="percent">%</option>
                  </select>
                  <span className="mono muted">{count}/{limit || "∞"}</span>
                  <span className="grow" />
                  <button className="btn small danger"
                    onClick={() => s.update((d) => { d.quotas[qi].cells.splice(ci, 1); })}>×</button>
                </div>
                <div className="qbar"><div className={pct >= 100 ? "full" : ""} style={{ width: `${pct}%` }} /></div>
                <div className="flabel" style={{ marginTop: 8 }}>cell condition — {conditionToText(cell.when, s.def)}</div>
                <ConditionEditor value={cell.when}
                  onChange={(when) => s.update((d) => { d.quotas[qi].cells[ci].when = when; })} />
              </div>
            );
          })}
          <button className="btn small" onClick={() =>
            s.update((d) => {
              d.quotas[qi].cells.push({
                id: uid("cell"), label: `Cell ${qt.cells.length + 1}`,
                when: { type: "group", op: "and", children: [] }, limit: 50, limitType: "count",
              });
            })}>
            + cell
          </button>
        </div>
      ))}
      <button className="btn" onClick={() =>
        s.update((d) => {
          d.quotas.push({
            id: uid("quota"), name: `Quota ${d.quotas.length + 1}`, mode: "hard",
            cells: [], onFull: { kind: "terminate" }, countStatus: ["complete"],
          });
        })}>
        + quota
      </button>
    </div>
  );
}
