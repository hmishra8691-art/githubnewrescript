"use client";
import React from "react";
import { cascadeParents, lintCascade } from "@rescript/engine";
import { registerOptionMetaFields, registerVariantSettings } from "./registry";

/**
 * AQ-08 — Studio authoring for the CASCADING DROPDOWN (`single_select.cascading_dropdown`).
 *
 *   the first list    settings.cascadeParents [{code, label}] — edited here, one row each
 *   the second list   the question's own options; each option's "parent" column (option meta.parent) names the
 *                     parent code it belongs to
 *   the two prompts   settings.cascadeParentLabel / cascadeChildLabel
 * The engine's lintCascade problems (orphan options, empty parents, duplicate codes) are shown below.
 */

registerOptionMetaFields("cascading_dropdown", [
  { key: "parent", label: "parent", placeholder: "parent code", width: 110 },
]);

registerVariantSettings("cascading_dropdown", ({ q, patchSettings }) => {
  const parents = cascadeParents(q);
  const st = q.settings as { cascadeParentLabel?: string; cascadeChildLabel?: string };
  const set = (next: { code: string | number; label: string }[]) => patchSettings({ cascadeParents: next } as never);
  const problems = lintCascade(q);
  return (
    <>
      <h3 className="sec">Cascading dropdown</h3>
      <div className="row" style={{ gap: 8 }}>
        <label className="f grow"><span>First prompt</span>
          <input className="input" data-testid="cascade-parent-label" value={st.cascadeParentLabel ?? ""} placeholder="e.g. Country"
            onChange={(e) => patchSettings({ cascadeParentLabel: e.target.value || undefined } as never)} /></label>
        <label className="f grow"><span>Second prompt</span>
          <input className="input" data-testid="cascade-child-label" value={st.cascadeChildLabel ?? ""} placeholder="e.g. State"
            onChange={(e) => patchSettings({ cascadeChildLabel: e.target.value || undefined } as never)} /></label>
      </div>
      <div className="muted" style={{ fontSize: 12.5, margin: "4px 0" }}>
        The first list (code, label). Each option below names its parent code in its “parent” column.
      </div>
      <div data-testid="cascade-parents">
        {parents.map((p, i) => (
          <div key={i} className="row" style={{ gap: 6, marginBottom: 4 }} data-testid="cascade-parent-row">
            <input className="input mono" style={{ width: 90 }} value={String(p.code)} data-testid={`cascade-parent-code-${i}`}
              onChange={(e) => set(parents.map((x, j) => (j === i ? { ...x, code: /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value } : x)))} />
            <input className="input grow" value={p.label} data-testid={`cascade-parent-text-${i}`}
              onChange={(e) => set(parents.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <button className="btn small danger" title="Remove" data-testid={`cascade-parent-remove-${i}`}
              onClick={() => set(parents.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <button className="btn small" data-testid="cascade-parent-add"
          onClick={() => set([...parents, { code: `P${parents.length + 1}`, label: `Choice ${parents.length + 1}` }])}>+ first-list choice</button>
      </div>
      {problems.map((m) => <div key={m} className="chip warn" style={{ marginTop: 6 }} data-testid="cascade-problem">{m}</div>)}
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
        Stores the second list's code; exports <span className="mono">{q.variableName}</span> and <span className="mono">{q.variableName}_PARENT</span>.
      </div>
    </>
  );
});
