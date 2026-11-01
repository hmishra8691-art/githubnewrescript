"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { ctxOf, uiOf } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { anchor } from "../authoring";
import { effectiveQuestion, cascadeParents, cascadeChildren, cascadeParentOf, CASCADE_PARENT_SUFFIX } from "@rescript/engine";

/**
 * AQ-08 — CASCADING DROPDOWN (`single_select.cascading_dropdown`, engine cascade.ts).
 *
 * Two native selects, each with its own visible label: the parent (settings.cascadeParents), then the child list
 * filtered to that parent (the question's options whose meta.parent is the parent's code — after the ordinary
 * option pipeline: masks, display logic, carry-forward and sorting all still apply to the children). The answer is
 * the child code; the parent is written beside it (`<id>__parent`, onExtraChange) and re-derived from the
 * definition on export. Changing the parent clears a child that no longer belongs. Until a parent is chosen the
 * second list is disabled.
 */
export function CascadingDropdown(p: QRProps) {
  const { options } = effectiveQuestion(p.q, ctxOf(p));
  const parents = cascadeParents(p.q);
  const derived = cascadeParentOf(p.q, p.value);
  const [parent, setParent] = React.useState<string>(derived != null ? String(derived) : "");
  // a value set from outside (resume, a punch, Back) moves the parent with it
  React.useEffect(() => { if (derived != null && String(derived) !== parent) setParent(String(derived)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [derived]);
  const children = cascadeChildren(options, parent);
  const st = p.q.settings as { cascadeParentLabel?: string; cascadeChildLabel?: string };
  const pid = `${p.q.id}__cascade_parent`, cid = `${p.q.id}__cascade_child`;
  const select = uiOf(p, "select_placeholder", undefined, "— Select —");
  const chooseParent = (v: string) => {
    setParent(v);
    p.onExtraChange?.(CASCADE_PARENT_SUFFIX.slice(2), v === "" ? null : parents.find((x) => String(x.code) === v)?.code ?? v);
    const stillOk = p.value != null && cascadeParentOf(p.q, p.value) != null && String(cascadeParentOf(p.q, p.value)) === v;
    if (!stillOk && p.value != null && p.value !== "") p.onChange(null);
  };
  return (
    <div className="rs-cascade" data-testid="rs-cascade">
      <label htmlFor={pid}>
        <span className="rs-cascade-label">{st.cascadeParentLabel ?? select}</span>
        <select id={pid} className="rs-select" data-testid="rs-cascade-parent" value={parent} disabled={p.q.settings.readOnly}
          onChange={(e) => chooseParent(e.target.value)}>
          <option value="">{select}</option>
          {parents.map((x) => <option key={String(x.code)} value={String(x.code)}>{x.label.replace(/<[^>]*>/g, "")}</option>)}
        </select>
      </label>
      <label htmlFor={cid}>
        <span className="rs-cascade-label">{st.cascadeChildLabel ?? select}</span>
        <select id={cid} className="rs-select" data-testid="rs-cascade-child" value={p.value == null ? "" : String(p.value)}
          disabled={p.q.settings.readOnly || !parent}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") { p.onChange(null); return; }
            const o = children.find((x) => String(x.code) === v);
            p.onExtraChange?.(CASCADE_PARENT_SUFFIX.slice(2), parents.find((x) => String(x.code) === parent)?.code ?? parent);
            p.onChange(o ? o.code : v);
          }}>
          <option value="">{select}</option>
          {children.map((o) => <option key={String(o.code)} value={String(o.code)} {...anchor("option", o.code)}>{o.label.replace(/<[^>]*>/g, "")}</option>)}
        </select>
      </label>
    </div>
  );
}

registerVariantRenderer("cascading_dropdown", CascadingDropdown);
