"use client";
import React from "react";
import type { Question, QuestionVariantDef } from "@rescript/schema";
import {
  questionTypeRegistry,
  variantRegistry,
  variantFamilies,
  variantsOf,
  variantForLegacyType,
  resolveVariant,
  responseModelOf,
  isSafeConversion,
  isSelectableVariant,
} from "@rescript/schema";
import { useStudio, uid } from "./store";

/**
 * Question Family → Variant selection (hierarchical picker) and the
 * variant switcher for existing questions, with safe-conversion rules:
 * same response model = silent, different = explicit warning; text,
 * options, ids, variables and compatible settings are always preserved.
 */

/** Apply a variant's defaults without clobbering anything the programmer
 *  already configured. */
export function applyVariantDefaults(q: Question, v: QuestionVariantDef): void {
  const d = v.defaults;
  if (!d) return;
  if (d.settings) q.settings = { ...d.settings, ...q.settings, ...pickDefined(d.settings, q.settings) } as any;
  if (d.options && q.options.length === 0) q.options = d.options.map((o) => ({ flags: [], ...o })) as any;
  if (d.rows && q.rows.length === 0) q.rows = d.rows.map((r) => ({ flags: [], validation: [], required: false, ...r })) as any;
  if (d.validation && q.validation.length === 0) q.validation = d.validation as any;
  if (d.instruction && !q.instruction) q.instruction = d.instruction;
}

/** settings precedence: variant defaults fill gaps, explicit values win —
 *  except on fresh creation where defaults should land. */
function pickDefined(defaults: Record<string, unknown>, current: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(defaults)) {
    if (current[k] === undefined) out[k] = val;
  }
  return out;
}

export function createFromVariant(v: QuestionVariantDef, n: number): Question {
  const plugin = questionTypeRegistry.get(v.baseType);
  const q: Question = plugin
    ? plugin.create({ id: uid("q"), code: `Q${n}`, variableName: `Q${n}` })
    : ({
        id: uid("q"), code: `Q${n}`, variableName: `Q${n}`, type: v.baseType, text: "",
        options: [], rows: [], columns: [], validation: [], required: false,
        settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [],
      } as unknown as Question);
  q.type = v.baseType;
  q.variant = v.id;
  // creation: defaults land directly
  if (v.defaults?.settings) q.settings = { ...q.settings, ...v.defaults.settings } as any;
  if (v.defaults?.options) q.options = v.defaults.options.map((o) => ({ flags: [], ...o })) as any;
  if (v.defaults?.rows) q.rows = v.defaults.rows.map((r) => ({ flags: [], validation: [], required: false, ...r })) as any;
  if (v.defaults?.validation) q.validation = v.defaults.validation as any;
  if (v.defaults?.instruction) q.instruction = v.defaults.instruction;
  return q;
}

/* -------------------------------------------------------------- the picker */

export function VariantPickerModal({ onPick, onClose }: {
  onPick(v: QuestionVariantDef): void;
  onClose(): void;
}) {
  const families = variantFamilies();
  const [family, setFamily] = React.useState(families[0]?.family ?? "single_select");
  const variants = variantsOf(family).filter((v) => isSelectableVariant(v) || v.status === "planned");

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" style={{ width: 860, display: "grid", gridTemplateColumns: "230px 1fr", gap: 16, padding: 0, overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ borderRight: "1px solid var(--border)", padding: "14px 0", maxHeight: "76vh", overflowY: "auto" }}>
          <div className="flabel" style={{ padding: "0 16px 6px" }}>Question family</div>
          {families.map((f) => (
            <button key={f.family}
              className={`nav-item ${family === f.family ? "active" : ""}`}
              onClick={() => setFamily(f.family)}>
              {f.familyLabel}
              <span className="nav-count">{f.stable > 0 ? f.stable : "soon"}</span>
            </button>
          ))}
        </div>
        <div style={{ padding: "14px 18px 18px 2px", maxHeight: "76vh", overflowY: "auto" }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="flabel" style={{ margin: 0 }}>
              {families.find((f) => f.family === family)?.familyLabel} — pick a question type
            </div>
            <span className="grow" />
            <button className="btn small" onClick={onClose}>close</button>
          </div>
          {variants.map((v) => (
            <div key={v.id}
              className={`card ${v.status === "stable" ? "selectable" : ""}`}
              style={{ padding: "10px 14px", opacity: v.status === "stable" ? 1 : 0.55 }}
              onClick={() => v.status === "stable" && onPick(v)}>
              <div className="card-title" style={{ fontSize: 13 }}>
                {v.name}
                {v.status === "planned" && <span className="chip">coming soon</span>}
                {v.status === "stable" && (
                  <span className="chip" title="response data model">{v.responseModel.replace("_", " ")}</span>
                )}
              </div>
              <div style={{ color: "var(--subtle)", fontSize: 12, marginTop: 2 }}>{v.description}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------- switcher (existing q) */

export function VariantSwitcher({ q }: { q: Question }) {
  const s = useStudio();
  // a question saved against a retired duplicate resolves to its survivor, so
  // the switcher shows where that type lives now rather than a blank
  const current: QuestionVariantDef | undefined =
    resolveVariant(q.variant) ??
    (variantForLegacyType(q.type) ? variantRegistry.get(variantForLegacyType(q.type)!) : undefined);
  const families = variantFamilies().filter((f) => f.stable > 0);
  const family = current?.family ?? "single_select";
  const stableVariants = variantsOf(family).filter(isSelectableVariant);

  const switchTo = (to: QuestionVariantDef) => {
    const safe = isSafeConversion(current, to, q.type);
    if (!safe) {
      const fromModel = current?.responseModel ?? responseModelOf(q.type);
      const ok = window.confirm(
        `Changing this question to "${to.name}" changes its response structure ` +
        `(${fromModel.replace("_", " ")} → ${to.responseModel.replace("_", " ")}).\n\n` +
        `Question text, options and the variable name are preserved, but collected ` +
        `data, logic and exports that depend on the old structure may be affected, ` +
        `and incompatible validation/settings will be reset.\n\nContinue?`,
      );
      if (!ok) return;
    }
    s.update((d) => {
      const i = d.questions.findIndex((x) => x.id === q.id);
      if (i < 0) return;
      const cur = d.questions[i];
      cur.type = to.baseType;
      cur.variant = to.id;
      applyVariantDefaults(cur, to);
      if (!safe) {
        // reset only what the new variant cannot represent
        cur.validation = cur.validation.filter((r) => to.validations.includes(r.kind));
        if (!to.capabilities.includes("exclusive_options")) {
          cur.options = cur.options.map((o) => ({
            ...o,
            flags: (o.flags ?? []).filter((f) => !["exclusive", "none_of_above", "dont_know", "refused"].includes(f)),
          }));
        }
        if (!to.capabilities.includes("min_max_selections")) {
          delete (cur.settings as any).minSelections;
          delete (cur.settings as any).maxSelections;
        }
      }
    });
    s.toast(`Question type changed to ${to.name}${safe ? "" : " (incompatible settings reset)"}`);
  };

  return (
    <>
      <label className="f" style={{ width: 150, marginBottom: 0 }}><span>Family</span>
        <select className="select" value={family}
          onChange={(e) => {
            const first = variantsOf(e.target.value).find(isSelectableVariant);
            if (first) switchTo(first);
          }}>
          {families.map((f) => <option key={f.family} value={f.family}>{f.familyLabel}</option>)}
        </select></label>
      <label className="f" style={{ width: 200, marginBottom: 0 }}><span>Question type</span>
        <select className="select" value={current?.id ?? ""}
          onChange={(e) => {
            const to = variantRegistry.get(e.target.value);
            if (to) switchTo(to);
          }}>
          {!current && <option value="">({q.type})</option>}
          {stableVariants.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select></label>
    </>
  );
}
