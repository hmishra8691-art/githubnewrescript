"use client";
import React from "react";
import type { VariableDef } from "@rescript/schema";
import { buildVariableDictionary, buildDerivedVariables, lintVariables, renameImpact, applyRename, questionForVariable,
  planTemplateRename, applyTemplateRename, STARTER_TEMPLATES, TEMPLATE_TOKENS } from "@rescript/engine";
import { NamingTemplatesPanel } from "./NamingTemplatesPanel";
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
  /* the rename box, per open row */
  const [renameTo, setRenameTo] = React.useState("");
  const [alsoCode, setAlsoCode] = React.useState(true);
  const [view, setView] = React.useState<"dictionary" | "naming">("dictionary");

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
        (next.notes ?? "").trim() ||
        /*
         * §44 phase 2. Omitting these here would have been the quiet kind of
         * bug: the field accepts your typing, the row redraws, and the
         * override is discarded on the way out because nothing "says"
         * anything — so the missing values you declared are gone by the next
         * export.
         */
        (next.missingValues ?? []).length ||
        (next.exportName ?? "").trim() ||
        !!next.measure;
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

  /** "99; 999" ⇄ [99, 999] — numbers stay numbers so SPSS can declare them. */
  const missingToText = (m: (string | number)[] | undefined) => (m ?? []).join("; ");
  const textToMissing = (t: string): (string | number)[] =>
    t.split(/[;,\n]/).map((x) => x.trim()).filter(Boolean)
      .map((x) => (Number.isFinite(Number(x)) && x !== "" ? Number(x) : x));

  /*
   * Only a question's own variable and a calculation's target can be renamed.
   * Everything else in the dictionary is a column the engine derives — a
   * matrix row, a multi-select flag — and its name follows its parent's, so
   * the rename belongs on the parent.
   */
  const renameable = (v: VariableDef) =>
    !!questionForVariable(s.def, v.name) || (s.def.calculations ?? []).some((c) => c.targetVariable === v.name);

  const impact = React.useMemo(() => {
    if (!editing || !renameTo.trim() || renameTo === editing) return null;
    try {
      return renameImpact(s.def, editing, renameTo.trim());
    } catch {
      return null;
    }
  }, [s.def, editing, renameTo]);

  const doRename = (from: string) => {
    const to = renameTo.trim();
    if (!impact?.ok) return;
    s.labelNextEdit(`rename ${from} to ${to}`);
    s.update((d) => {
      const next = applyRename(d, from, to, { alsoCode });
      for (const k of Object.keys(d)) delete (d as any)[k];
      Object.assign(d, next);
    });
    setRenameTo("");
    setEditing(null);
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Variables</h2>
        <span className="chip">{vars.length}</span>
        {overrides.size > 0 && (
          <span className="chip" data-testid="override-count">{overrides.size} edited</span>
        )}
        <div className="row" style={{ gap: 4, marginLeft: 8 }} data-testid="variables-view">
          <button className={`btn small ${view === "dictionary" ? "primary" : ""}`}
            data-testid="view-dictionary" onClick={() => setView("dictionary")}>Dictionary</button>
          <button className={`btn small ${view === "naming" ? "primary" : ""}`}
            data-testid="view-naming" onClick={() => setView("naming")}>Naming standard</button>
        </div>
        {view === "dictionary" && (
          <input className="input" style={{ width: 220 }} placeholder="filter…"
            value={filter} onChange={(e) => setFilter(e.target.value)} />
        )}
        <span className="grow" />
        <a className="btn" href={`/api/surveys/${s.surveyDbId}/export/xlsx`} target="_blank">
          ⬇ Export Variable Dictionary (.xlsx)
        </a>
      </div>
      {problems.map((p, i) => (
        <div key={i} className="chip warn" style={{ marginBottom: 8 }}>{p}</div>
      ))}
      {view === "naming" ? <NamingTemplatesPanel /> : (
      <>
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
                      {edited && <span className="chip" data-testid="var-edited">edited</span>}{" "}
                      {v.exportName && <span className="chip" data-testid="var-has-export-name">→ {v.exportName}</span>}{" "}
                      {(v.missingValues ?? []).length > 0 && (
                        <span className="chip" data-testid="var-has-missing">missing: {(v.missingValues ?? []).join(", ")}</span>
                      )}
                    </td>
                    <td>
                      <button className="btn small" data-testid="edit-variable"
                        onClick={() => { setRenameTo(""); setEditing(open ? null : v.name); }}>
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
                          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                            <label className="f" style={{ flex: "1 1 200px" }}>
                              <span>Export name — the column name in delivered files</span>
                              <input className="input mono" data-testid="var-export-name"
                                placeholder={v.name}
                                value={overrides.get(v.name)?.exportName ?? ""}
                                onChange={(e) => setOverride(v, { exportName: e.target.value || undefined })} />
                            </label>
                            <label className="f" style={{ flex: "1 1 200px" }}>
                              <span>Missing values — <span className="mono">99; 999</span></span>
                              <input className="input mono" data-testid="var-missing"
                                value={missingToText(overrides.get(v.name)?.missingValues)}
                                onChange={(e) => setOverride(v, { missingValues: textToMissing(e.target.value) })} />
                            </label>
                            <label className="f" style={{ flex: "0 1 160px" }}>
                              <span>Measure</span>
                              <select className="select" data-testid="var-measure"
                                value={overrides.get(v.name)?.measure ?? ""}
                                onChange={(e) => setOverride(v, { measure: (e.target.value || undefined) as any })}>
                                <option value="">(derived: {v.measure ?? "—"})</option>
                                <option value="nominal">Nominal</option>
                                <option value="ordinal">Ordinal</option>
                                <option value="scale">Scale</option>
                              </select>
                            </label>
                          </div>
                          <p className="muted" style={{ fontSize: 12, margin: "2px 0 8px" }}>
                            Missing values are declared in SPSS and marked in the SAS syntax, so a
                            mean excludes them instead of averaging the 99s in. The value itself
                            still appears in the data.
                          </p>

                          {renameable(v) && (
                            <div data-testid="var-rename" style={{ borderTop: "1px solid var(--border, #e5e9f0)", paddingTop: 10, marginTop: 4 }}>
                              <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                                <label className="f" style={{ flex: "1 1 220px" }}>
                                  <span>Rename the variable — every rule, pipe and expression is updated</span>
                                  <input className="input mono" data-testid="var-rename-input"
                                    placeholder={v.name} value={renameTo}
                                    onChange={(e) => setRenameTo(e.target.value)} />
                                </label>
                                <button className="btn small primary" data-testid="var-rename-apply"
                                  disabled={!impact?.ok}
                                  onClick={() => doRename(v.name)}>Rename</button>
                              </div>

                              {impact?.aliasedByCode && (
                                <label className="row" style={{ gap: 6, fontSize: 13, marginTop: 6 }}>
                                  <input type="checkbox" data-testid="var-rename-also-code"
                                    checked={alsoCode} onChange={(e) => setAlsoCode(e.target.checked)} />
                                  Rename the question code to match
                                </label>
                              )}

                              {impact && (
                                <div data-testid="var-rename-impact" style={{ marginTop: 8, fontSize: 12.5 }}>
                                  {impact.blockers.map((b, i) => (
                                    <div key={`b${i}`} className="chip warn" data-testid="var-rename-blocker"
                                      style={{ display: "block", marginBottom: 4 }}>{b}</div>
                                  ))}
                                  {impact.warnings.map((w, i) => (
                                    <div key={`w${i}`} className="muted" data-testid="var-rename-warning"
                                      style={{ marginBottom: 4 }}>⚠ {w}</div>
                                  ))}
                                  {impact.ok && (
                                    <div data-testid="var-rename-summary">
                                      {impact.usages.length} reference{impact.usages.length === 1 ? "" : "s"} will be updated
                                      {impact.derivedRenames.length > 1
                                        ? `, across ${impact.derivedRenames.length} columns`
                                        : ""}.
                                      {impact.analysesUnchecked && " Saved analyses are not checked here — repoint them afterwards."}
                                    </div>
                                  )}
                                  {impact.usages.length > 0 && (
                                    <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
                                      {impact.usages.slice(0, 12).map((u, i) => (
                                        <li key={i} data-testid="var-usage">{u.where}</li>
                                      ))}
                                      {impact.usages.length > 12 && <li className="muted">…and {impact.usages.length - 12} more</li>}
                                    </ul>
                                  )}
                                </div>
                              )}
                            </div>
                          )}

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
      </>
      )}
    </div>
  );
}
