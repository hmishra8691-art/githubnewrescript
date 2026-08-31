"use client";
import React from "react";
import type { VariableDef } from "@rescript/schema";
import { buildVariableDictionary, lintVariables } from "@rescript/engine";
import { useStudio } from "./store";

/** Variable / Data Dictionary (requirement §9) with Excel export (§10). */
export function VariablesPanel() {
  const s = useStudio();
  const [filter, setFilter] = React.useState("");
  const vars: VariableDef[] = React.useMemo(() => buildVariableDictionary(s.def), [s.def]);
  const problems = React.useMemo(() => lintVariables(s.def), [s.def]);
  const shown = vars.filter(
    (v) =>
      !filter ||
      v.name.toLowerCase().includes(filter.toLowerCase()) ||
      (v.questionCode ?? "").toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Variables</h2>
        <span className="chip">{vars.length}</span>
        <input className="input" style={{ width: 220 }} placeholder="filter…"
          value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="grow" />
        <a className="btn" href={`/api/surveys/${s.surveyDbId}/export/xlsx`} target="_blank">
          ⬇ Export Variable Dictionary (.xlsx)
        </a>
      </div>
      {problems.map((p, i) => (
        <div key={i} className="chip warn" style={{ marginBottom: 8 }}>{p}</div>
      ))}
      <p className="muted" style={{ fontSize: 12 }}>
        Generated automatically from the programmed survey — always in sync. Saved into every version
        snapshot; the Excel export reflects the exact programmed state.
      </p>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Variable</th><th>Question</th><th>Type</th><th>Response</th>
              <th>Codes</th><th>Value labels</th><th>Label</th><th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((v) => (
              <tr key={v.name + (v.questionId ?? "")}>
                <td><strong>{v.name}</strong></td>
                <td>{v.questionCode ?? ""}</td>
                <td>{v.dataType}</td>
                <td>{v.responseType}</td>
                <td>{v.valueCodes.join(",")}</td>
                <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {Object.entries(v.valueLabels).map(([c, l]) => `${c}=${l}`).join("; ")}
                </td>
                <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>{v.label}</td>
                <td>
                  {v.derived && <span className="chip">derived</span>}{" "}
                  {v.hidden && <span className="chip">hidden</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
