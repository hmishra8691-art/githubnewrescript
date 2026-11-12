"use client";
/**
 * THE INHERITED LIST OF A CARRY-FORWARD QUESTION, IN THE BUILDER (2026-11-13).
 *
 * A question that carries its options (or rows) from an earlier one used to show an empty list in the builder: the
 * options exist only at runtime. This panel lists what CAN arrive — every option of the source — in grey and locked
 * (their text and code belong to the source question), and gives the programmer the controls that belong to THIS
 * question (engine carryforward.ts, schema CarryForward):
 *
 *   display text   the wording shown here (the source's label and the stored answer never change)
 *   always show    shown whatever the respondent chose ("Other", "None of these")
 *   never carry    never shown here, even when chosen
 *   template       wording for every inherited option without its own text — "{{label}} products"
 *   own options    the options added below are shown after the inherited ones ("keep own")
 *
 * Nothing here is copied: the list is read from the source every time, so a renamed, added or deleted source option
 * is renamed, added or gone here too.
 */
import React from "react";
import type { Question, SurveyDefinition } from "@rescript/schema";
import { authoringQuestionView } from "@rescript/engine";

const plain = (s: string) => String(s ?? "").replace(/<[^>]*>/g, "");

export function CarriedOptionsPanel({ def, q, patch }: { def: SurveyDefinition; q: Question; patch(p: Partial<Question>): void }) {
  const cf = q.carryForward;
  if (!cf || cf.into === "columns") return null;
  const src = def.questions.find((x) => x.id === cf.sourceQuestionId);
  if (!src) return <p className="chip warn" data-testid="cf-source-missing">The source question of this carry-forward no longer exists — choose another in Properties → Carry-forward.</p>;
  const view = authoringQuestionView(src, def);
  const items = (view.options.length ? view.options : view.rows) as { code: string | number; label: string; flags?: string[] }[];
  const set = (p: Partial<NonNullable<Question["carryForward"]>>) => patch({ carryForward: { ...cf, ...p } });
  const excluded = new Set((cf.exclude ?? []).map(String));
  const always = new Set((cf.always ?? []).map(String));
  const toggle = (key: "exclude" | "always", code: string, on: boolean) => {
    const cur = new Set(((cf[key] ?? []) as (string | number)[]).map(String));
    if (on) cur.add(code); else cur.delete(code);
    /* the stored codes keep the source's own type (number or text) */
    const next = items.filter((i) => cur.has(String(i.code))).map((i) => i.code);
    const other = key === "exclude" ? "always" : "exclude";
    const patchBoth: Record<string, unknown> = { [key]: next.length ? next : undefined };
    /* one option cannot be both: the box just ticked wins */
    if (on) { const o = ((cf[other] ?? []) as (string | number)[]).filter((c) => String(c) !== code); patchBoth[other] = o.length ? o : undefined; }
    set(patchBoth as never);
  };
  const setLabel = (code: string, text: string) => {
    const next = { ...(cf.labels ?? {}) };
    if (text.trim()) next[code] = text; else delete next[code];
    set({ labels: Object.keys(next).length ? next : undefined });
  };
  const what = cf.into === "rows" ? "rows" : "options";
  const filterWords: Record<string, string> = { selected: "the ones the respondent selected", not_selected: "the ones the respondent did not select", displayed: "the ones shown to the respondent", answered_rows: "the rows the respondent answered", all: "all of them" };
  const own = cf.into === "rows" ? q.rows.length : q.options.length;

  return (
    <div className="card" style={{ padding: 10, marginBottom: 10 }} data-testid="carried-options">
      <div className="flabel" style={{ marginBottom: 2 }}>Inherited from {src.code} — {filterWords[cf.filter ?? "selected"] ?? cf.filter}</div>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>
        These {what} come from {src.code} and stay linked to it: their text and codes are edited there. Here you decide how each one reads and whether it appears.
      </p>
      {items.length === 0 ? (
        <p className="muted" style={{ fontSize: 12.5 }} data-testid="carried-empty">{src.code} has no {what} to carry yet.</p>
      ) : (
        <table className="tbl" style={{ width: "100%", fontSize: 13 }}>
          <thead>
            <tr><th style={{ textAlign: "left" }}>Code</th><th style={{ textAlign: "left" }}>From {src.code}</th><th style={{ textAlign: "left" }}>Shown here as</th><th title="Shown here whatever the respondent chose">Always show</th><th title="Never shown here, even when chosen">Never carry</th></tr>
          </thead>
          <tbody>
            {items.map((i) => {
              const code = String(i.code);
              const off = excluded.has(code);
              const special = (i.flags ?? []).filter((f) => ["other_specify", "exclusive", "none_of_above", "dont_know"].includes(f));
              return (
                <tr key={code} data-testid="carried-row" data-code={code} style={off ? { opacity: 0.45 } : undefined}>
                  <td className="mono" style={{ color: "var(--muted, #8a8f98)" }}>{code}</td>
                  <td style={{ color: "var(--muted, #8a8f98)" }} title={`Edited in ${src.code}`}>
                    {plain(i.label)}{special.length ? <span className="chip" style={{ marginLeft: 6 }}>{special.map((f) => f.replace(/_/g, " ")).join(", ")}</span> : null}
                  </td>
                  <td>
                    <input className="input" style={{ width: "100%" }} disabled={off} data-testid={`carried-label-${code}`}
                      placeholder={cf.labelTemplate ? plain(cf.labelTemplate.split("{{label}}").join(plain(i.label))) : plain(i.label)}
                      value={cf.labels?.[code] ?? ""} onChange={(e) => setLabel(code, e.target.value)} />
                  </td>
                  <td style={{ textAlign: "center" }}><input type="checkbox" data-testid={`carried-always-${code}`} checked={always.has(code)} onChange={(e) => toggle("always", code, e.target.checked)} /></td>
                  <td style={{ textAlign: "center" }}><input type="checkbox" data-testid={`carried-exclude-${code}`} checked={off} onChange={(e) => toggle("exclude", code, e.target.checked)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="row" style={{ gap: 12, flexWrap: "wrap", marginTop: 8 }}>
        <label className="row" style={{ gap: 6, fontSize: 13 }} title='Wording for every inherited option without its own text. {{label}} is the source wording — e.g. "{{label}} products"'>
          Wording for all
          <input className="input" style={{ width: 200 }} placeholder="{{label}} products" maxLength={300} data-testid="carried-template"
            value={cf.labelTemplate ?? ""} onChange={(e) => set({ labelTemplate: e.target.value || undefined })} />
        </label>
        <label className="row" style={{ gap: 6, fontSize: 13 }} title={`Show this question's own ${what} (added below) after the inherited ones`}>
          <input type="checkbox" checked={!!cf.keepOwn} data-testid="carried-keep-own" onChange={(e) => set({ keepOwn: e.target.checked })} />
          Also show the {what} added below ({own})
        </label>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
        Order: {filterWords[cf.filter ?? "selected"] ?? cf.filter} → plus “always show” → minus “never carry” → then the {what} added below. The answer stored is always {src.code}'s own code, so data and logic are unchanged by the wording.
      </p>
      {own > 0 && !cf.keepOwn && (
        <p className="chip warn" style={{ marginTop: 6 }} data-testid="carried-own-ignored">
          {own} {what.slice(0, -1)}{own === 1 ? "" : "s"} added below {own === 1 ? "is" : "are"} not shown — tick “Also show the {what} added below”.
        </p>
      )}
    </div>
  );
}
