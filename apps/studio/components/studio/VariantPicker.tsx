"use client";
import React from "react";
import type { Question, QuestionVariantDef } from "@rescript/schema";
import {
  questionTypeRegistry,
  variantRegistry,
  variantFamilies,
  pickerTypesOf,
  variantForLegacyType,
  resolveVariant,
  responseModelOf,
  isSafeConversion,
  allowedValidationKinds } from "@rescript/schema";
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
  if (v.defaults?.columns) {
    q.columns = v.defaults.columns.map((c, i) => ({
      options: [], validation: [], readOnly: false,
      variableStem: `${q.variableName}_C${i + 1}`,
      ...c,
    })) as any;
  }
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
  /*
   * TYPES, EACH WITH ITS PRESETS — not a flat list (taxonomy audit, 2026-09-10).
   *
   * A flat list showed "Single-Line Text", "Email", "Phone", "URL", "ZIP",
   * "Company" as six peers, when five of them are the first one with a
   * validator switched on. It also scattered a type's starting points across
   * families: "Percentage Slider" sat under Numeric while the slider it is a
   * preset of sat under Slider. Now a family shows its TYPES as cards, and
   * each card carries its own "start from" row — including presets whose
   * registry entry lives in another family. One home per question.
   */
  const { types, planned } = pickerTypesOf(family);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" style={{ width: 860, display: "grid", gridTemplateColumns: "230px 1fr", gap: 16, padding: 0, overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ borderRight: "1px solid var(--border)", padding: "14px 0", maxHeight: "76vh", overflowY: "auto" }}>
          <div className="flabel" style={{ padding: "0 16px 6px" }}>Question family</div>
          {families.map((f) => (
            <button key={f.family}
              className={`nav-item ${family === f.family ? "active" : ""}`}
              data-testid={`picker-family-${f.family}`}
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
          {types.map(({ type: v, presets }) => (
            /*
             * The card is the type's click target; the presets are a row
             * BESIDE it, not inside it. Putting buttons inside a clickable
             * card made "click the card" ambiguous — the first version did,
             * and a click in the middle of Single-Line Text picked URL.
             */
            <div key={v.id} className="picker-type" data-testid={`picker-type-${v.id}`} style={{ marginBottom: 8 }}>
              <div
                className="card selectable"
                data-testid={`picker-variant-${v.id}`} data-status={v.status}
                style={{ padding: "10px 14px", marginBottom: presets.length ? 4 : 0 }}
                onClick={() => onPick(v)}>
                <div className="card-title" style={{ fontSize: 14 }}>
                  {v.name}
                  <span className="chip" title="response data model">{v.responseModel.replace("_", " ")}</span>
                </div>
                <div style={{ color: "var(--subtle)", fontSize: 13, marginTop: 2 }}>{v.description}</div>
              </div>
              {presets.length > 0 && (
                <div className="row" style={{ gap: 6, flexWrap: "wrap", padding: "0 14px", alignItems: "baseline" }}
                  data-testid={`picker-presets-${v.id}`}>
                  <span className="muted" style={{ fontSize: 12 }}>Start from:</span>
                  {presets.map((p) => (
                    <button key={p.id} className="chip"
                      data-testid={`picker-variant-${p.id}`} data-status={p.status} data-preset-of={v.id}
                      title={p.description}
                      onClick={() => onPick(p)}>
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {planned.map((v) => (
            <div key={v.id}
              className="card"
              data-testid={`picker-variant-${v.id}`} data-status={v.status}
              style={{ padding: "10px 14px", opacity: 0.55 }}>
              <div className="card-title" style={{ fontSize: 14 }}>
                {v.name}<span className="chip">coming soon</span>
              </div>
              <div style={{ color: "var(--subtle)", fontSize: 13, marginTop: 2 }}>{v.description}</div>
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
  /*
   * A preset lives under its PARENT type, which may sit in another family
   * (ranking.top_n's parent is ranking.click; slider.multi_attribute's is
   * matrix.slider_matrix). The switcher shows the parent's family and lists
   * types with their presets nested, exactly as the picker does — one home
   * per question, in both places.
   */
  const parent = current?.presetOf ? variantRegistry.get(current.presetOf) : undefined;
  const family = parent?.family ?? current?.family ?? "single_select";
  const typesWithPresets = pickerTypesOf(family).types;

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
        /*
         * Reset only what the new variant genuinely cannot represent.
         * `allowedValidationKinds` keeps the four type-agnostic kinds
         * (required / condition / custom_expression / custom_script), so
         * switching variants no longer silently deletes a hand-built
         * Condition-tree rule that the engine would still evaluate correctly.
         */
        const keep = allowedValidationKinds(to.validations, to.validations);
        cur.validation = cur.validation.filter((r) => keep.includes(r.kind));
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
            const first = pickerTypesOf(e.target.value).types[0]?.type;
            if (first) switchTo(first);
          }}>
          {families.map((f) => <option key={f.family} value={f.family}>{f.familyLabel}</option>)}
        </select></label>
      <label className="f" style={{ width: 220, marginBottom: 0 }}><span>Question type</span>
        <select className="select" value={current?.id ?? ""} data-testid="variant-switcher"
          onChange={(e) => {
            const to = variantRegistry.get(e.target.value);
            if (to) switchTo(to);
          }}>
          {!current && <option value="">({q.type})</option>}
          {typesWithPresets.map(({ type, presets }) => (
            presets.length === 0
              ? <option key={type.id} value={type.id}>{type.name}</option>
              : (
                <optgroup key={type.id} label={type.name}>
                  <option value={type.id}>{type.name}</option>
                  {presets.map((pr) => <option key={pr.id} value={pr.id} data-preset-of={type.id}>↳ {pr.name}</option>)}
                </optgroup>
              )
          ))}
        </select></label>
    </>
  );
}
