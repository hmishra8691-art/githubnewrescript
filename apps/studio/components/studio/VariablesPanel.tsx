"use client";
import React from "react";
import type { VariableDef } from "@rescript/schema";
import { buildVariableDictionary, buildDerivedVariables, lintVariables } from "@rescript/engine";
import { useStudio } from "./store";

/**
 * Variable / Data Dictionary (requirement §9) with Excel export (§10).
 *
 * The dictionary is derived from the programmed survey and always in sync —
 * that is the point of it. But "always derived" also meant "never editable",
 * and a derived label is occasionally the wrong one: a grid row that reads
 * well as a question ("I would recommend it to a friend") is a poor column
 * header, and a 1–5 scale exports as "1".."5" unless somebody gives the
 * numbers their words back.
 *
 * So a row can be OVERRIDDEN. The override is stored in `def.variables` —
 * which has been in the schema since the first release and was read by
 * nothing — and applied by `buildVariableDictionary`, so it reaches the
 * exports, the analysis dataset and the version snapshot without any of them
 * knowing this panel exists. Everything structural stays derived: an override
 * can restate a label, its value labels, whether it is hidden and its notes,
 * and can never claim a variable comes from somewhere it does not.
 */
export function VariablesPanel() {
  const s = useStudio();
  const [filter, setFilter] = React.useState("");
  const [editing, setEditing] = React.useState<string | null>(null);

  const vars: VariableDef[] = React.useMemo(() => buildVariableDictionary(s.def), [s.def]);
  const derived: VariableDef[] = React.useMemo(() => buildDerivedVariables(s.def), [s.def]);
  const problems = React.useMemo(() => lintVariables(s.def), [s.def]);
  const overrides = React.useMemo(
    () => new Map((s.def.variables ?? []).map((v) => [v.name, v])),
    [s.def.variables],
  );

  const shown = vars.filter(
    (v) =>
      !filter ||
      v.name.toLowerCase().includes(filter.toLowerCase()) ||
      (v.questionCode ?? "").toLowerCase().includes(filter.toLowerCase()),
  );

  /** Write one field of an override, creating or removing the entry as needed. */
  const setOverride = (v: VariableDef, patch: Partial<VariableDef>) => {
    s.labelNextEdit(`variable ${v.name}`);
    s.update((d) => {
      const list = (d.variables ??= []);
      const base = derived.find((x) => x.name === v.name);
      const i = list.findIndex((x) => x.name === v.name);
      const next: any = { ...(i >= 0 ? list[i] : { name: v.name, label: "", dataType: base?.dataType ?? "text", responseType: base?.responseType ?? "text", valueCodes: [], valueLabels: {} }), ...patch };
      // an override that says nothing is not an override — drop it, so the
      // definition never accumulates rows that do nothing
      const says =
        (next.label ?? "").trim() ||
        Object.keys(next.valueLabels ?? {}).length ||
        next.hidden === true ||
        (next.notes ?? "").trim();
      if (!says) {
        if (i >= 0) list.splice(i, 1);
        return;
      }
      if (i >= 0) list[i] = next;
      else list.push(next);
    });
  };

  const reset = (name: string) => {
    s.labelNextEdit(`variable ${name}`);
    s.update((d) => {
      d.variables = (d.variables ?? []).filter((x) => x.name !== name);
    });
  };

  /** "1=Strongly agree; 5=Strongly disagree" ⇄ { "1": "…", "5": "…" } */
  const labelsToText = (m: Record<string, string>) =>
    Object.entries(m).map(([c, l]) => `${c}=${l}`).join("; ");
  const textToLabels = (t: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const part of t.split(/[;\n]/)) {
      const [code, ...rest] = part.split("=");
      const label = rest.join("=").trim();
      if (code?.trim() && label) out[code.trim()] = label;
    }
    return out;
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Variables</h2>
        <span className="chip">{vars.length}</span>
        {overrides.size > 0 && (
          <span className="chip" data-testid="override-count">{overrides.size} edited</span>
        )}
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
      <p className="muted" style={{ fontSize: 13 }}>
        Generated automatically from the programmed survey — always in sync. Edit a row to give a
        variable a different label or value labels for export and analysis; the survey itself is
        unchanged, and Reset puts the derived values back.
      </p>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Variable</th><th>Question</th><th>Type</th><th>Response</th>
              <th>Codes</th><th>Value labels</th><th>Label</th><th>Flags</th><th />
            </tr>
          </thead>
          <tbody>
            {shown.map((v) => {
              const edited = overrides.has(v.name);
              const open = editing === v.name;
              return (
                <React.Fragment key={v.name + (v.questionId ?? "")}>
                  <tr data-testid="variable-row" data-variable={v.name} className={edited ? "var-edited" : ""}>
                    <td><strong>{v.name}</strong></td>
                    <td>{v.questionCode ?? ""}</td>
                    <td>{v.dataType}</td>
                    <td>{v.responseType}</td>
                    <td>{v.valueCodes.join(",")}</td>
                    <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {labelsToText(v.valueLabels)}
                    </td>
                    <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>{v.label}</td>
                    <td>
                      {v.derived && <span className="chip">derived</span>}{" "}
                      {v.hidden && <span className="chip">hidden</span>}{" "}
                      {edited && <span className="chip" data-testid="var-edited">edited</span>}
                    </td>
                    <td>
                      <button className="btn small" data-testid="edit-variable"
                        onClick={() => setEditing(open ? null : v.name)}>
                        {open ? "done" : "edit"}
                      </button>
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={9}>
                        <div className="var-edit" data-testid="variable-editor">
                          <label className="f">
                            <span>Label — what this column is called in exports and analysis</span>
                            <input className="input" data-testid="var-label"
                              placeholder={derived.find((x) => x.name === v.name)?.label ?? ""}
                              value={overrides.get(v.name)?.label ?? ""}
                              onChange={(e) => setOverride(v, { label: e.target.value })} />
                          </label>
                          <label className="f">
                            <span>Value labels — <span className="mono">1=Strongly agree; 5=Strongly disagree</span></span>
                            <input className="input mono" data-testid="var-value-labels"
                              placeholder={labelsToText(derived.find((x) => x.name === v.name)?.valueLabels ?? {})}
                              value={labelsToText(overrides.get(v.name)?.valueLabels ?? {})}
                              onChange={(e) => setOverride(v, { valueLabels: textToLabels(e.target.value) })} />
                          </label>
                          <label className="f">
                            <span>Notes — for whoever reads the dictionary</span>
                            <input className="input" data-testid="var-notes"
                              value={overrides.get(v.name)?.notes ?? ""}
                              onChange={(e) => setOverride(v, { notes: e.target.value || undefined })} />
                          </label>
                          <div className="row" style={{ gap: 10, marginTop: 8 }}>
                            <label className="row" style={{ gap: 6, fontSize: 13 }}>
                              <input type="checkbox" data-testid="var-hidden"
                                checked={overrides.get(v.name)?.hidden ?? v.hidden}
                                onChange={(e) => setOverride(v, { hidden: e.target.checked })} />
                              Hide from exports and analysis
                            </label>
                            <span className="grow" />
                            {edited && (
                              <button className="btn small" data-testid="reset-variable"
                                onClick={() => { reset(v.name); setEditing(null); }}>
                                Reset to derived
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
