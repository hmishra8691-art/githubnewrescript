"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { reviewQuotas, quotaAdvice, quotaDashboard, formatCondition, type SurveyAction } from "@rescript/engine";
import { Icon } from "../../ui/Icon";
import { Linked } from "./CopilotCard";
import type { Copilot } from "./useCopilot";

/**
 * THE QUOTAS — Intelligent → Quotas.
 *
 * The copilot's view of the quotas: the feasibility review (who is left out,
 * who is counted twice, limits that do not add up, a quota nothing checks,
 * a check before its question) with each mechanical fix as a proposal; the
 * quotas themselves with their cells and, when the live counts are in, the
 * fieldwork advice — a full cell while the rest is open, a cell that will
 * not fill at this pace — each adjustment offered as a proposal through
 * Changes; and the quota sheet import.
 *
 * Nothing here calls the model and nothing writes the survey: the
 * dashboard (Studio → Quotas) stays the place to edit by hand, and the same
 * `def.quotas` and `quota_counts` are read here.
 */
export interface QuotaImportNote { fileName: string; issues: string[]; matched: Record<string, string>; quotas: { name: string; layout: string; cells: number; total: number | null }[]; actions: number; at: string }

export function QuotasTab({ copilot, def, onSelect, onImportSheet, lastImport, readOnly }: { copilot: Copilot; def: SurveyDefinition; onSelect(id: string): void; onImportSheet(): void; lastImport: QuotaImportNote | null; readOnly: boolean }) {
  const findings = React.useMemo(() => reviewQuotas(def), [def]);
  const counts = copilot.quotaCounts ?? {};
  const dash = React.useMemo(() => quotaDashboard(def, counts), [def, counts]);
  const advice = React.useMemo(() => (copilot.quotaCounts ? quotaAdvice(def, copilot.quotaCounts) : []), [def, copilot.quotaCounts]);
  const sev = (s: string) => (s === "info" ? "suggestion" : s);
  const propose = (a: SurveyAction, label: string) => copilot.previewFix([a], label);
  const ask = (t: string) => void copilot.ask(t);

  return (
    <div className="cp-analysis cp-quotas" data-testid="cp-quotas">
      <section>
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <div className="iq-label">Quotas · {def.quotas.length}</div>
          <span className="grow" />
          <button type="button" className="iq-btn" onClick={onImportSheet} disabled={readOnly} data-testid="qt-import-sheet" title="An Excel or CSV with the sample targets — read against this survey into quotas you approve in Changes">Import a quota sheet</button>
        </div>
        {!def.quotas.length && <p className="cp-empty" data-testid="qt-none">No quotas yet. Say what the fieldwork needs — “500 completes, 50/50 gender, interlocked with three age bands”, “cap London at 200” — or import the client's quota sheet; the quota arrives as a proposal with its cells, limits and the check in the flow, and the review says who it would leave out.</p>}
        {lastImport && (
          <div className="cp-block" data-testid="qt-import-note">
            <div><Icon name="info" size={12} /> <b>{lastImport.fileName}</b>: {lastImport.quotas.length ? lastImport.quotas.map((q) => `${q.name} (${q.layout}, ${q.cells} cells${q.total ? `, total ${q.total}` : ""})`).join("; ") : "no quota layout recognised"}{lastImport.actions ? ` → ${lastImport.actions} quota${lastImport.actions === 1 ? "" : "s"} proposed in Changes` : ""}.</div>
            {Object.keys(lastImport.matched).length > 0 && <div className="iqi-dim">Columns matched: {Object.entries(lastImport.matched).map(([h, c]) => `${h} → ${c}`).join(", ")}</div>}
            {lastImport.issues.length > 0 && <ul className="cp-review-list" data-testid="qt-import-issues">{lastImport.issues.slice(0, 12).map((i, k) => <li key={k} data-severity="warning"><span className="cp-sev v-warning">left out</span> {i}</li>)}{lastImport.issues.length > 12 && <li className="iqi-dim">… and {lastImport.issues.length - 12} more</li>}</ul>}
          </div>
        )}
      </section>

      {findings.length > 0 && (
        <section data-testid="qt-review">
          <div className="iq-label">Can they fill? · {findings.length}</div>
          <ul className="cp-review-list">
            {findings.map((f, k) => (
              <li key={k} data-severity={f.severity} data-testid="qt-finding" data-kind={f.kind}>
                <span className={`cp-sev v-${f.severity}`}>{f.severity}</span> <Linked text={f.message} def={def} onSelect={onSelect} />
                {f.suggestion && <div className="iqi-dim">{f.suggestion}</div>}
                {f.action && !readOnly && <div><button type="button" className="iq-btn" data-testid="qt-fix" onClick={() => propose(f.action as SurveyAction, f.kind === "check_before_question" || f.kind === "unchecked" ? `Place the check for quota “${f.quotaName}”` : `Rescale quota “${f.quotaName}” to its total`)}>{f.kind === "unchecked" ? "Add the check" : f.kind === "check_before_question" ? "Move the check" : "Rescale to the total"}</button></div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {dash.quotas.map((row) => {
        const q = def.quotas.find((x) => x.id === row.id)!;
        const a = advice.find((x) => x.quotaId === row.id);
        return (
          <section key={row.id} className="cp-block" data-testid="qt-quota" data-quota-id={row.id} data-state={row.state}>
            <div className="row" style={{ alignItems: "center", gap: 8 }}>
              <div><b>{row.name}</b> <span className="iqi-dim">{row.mode} · when full: {row.onFull}{row.targetTotal ? ` · total ${row.targetTotal}` : ""}</span> <span className={`cp-sev v-${row.state === "FULL" ? "critical" : row.state === "NEAR_FULL" ? "warning" : "suggestion"}`}>{row.state.toLowerCase().replace("_", " ")}</span>{!row.enforced && <span className="cp-sev v-warning">not checked</span>}</div>
              <span className="grow" />
              <span className="iqi-dim" data-testid="qt-current">{copilot.quotaCounts ? `${row.current}${row.maximum !== null ? ` / ${row.maximum}` : ""}` : "no counts"}</span>
            </div>
            <table className="iqi-table" data-testid="qt-cells"><tbody>
              {row.cells.slice(0, 40).map((c) => (
                <tr key={c.cellId} data-testid="qt-cell" data-state={c.state}>
                  <td>{c.label}</td>
                  <td className="iqi-dim mono" style={{ fontSize: 11.5 }}>{formatCondition(def, q.cells.find((x) => x.id === c.cellId)!.when)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{copilot.quotaCounts ? `${c.current} / ` : ""}{c.limit}{c.limitType === "percent" ? "%" : ""}{c.limitType === "percent" && c.maximum ? <span className="iqi-dim"> ({c.maximum})</span> : null}</td>
                </tr>
              ))}
              {row.cells.length > 40 && <tr><td colSpan={3} className="iqi-dim">… and {row.cells.length - 40} more cells</td></tr>}
            </tbody></table>
            {a && a.lines.length > 0 && (
              <ul className="cp-review-list" data-testid="qt-advice">
                {a.lines.map((l, k) => (
                  <li key={k} data-severity={sev(l.severity)} data-kind={l.kind}>
                    <span className={`cp-sev v-${sev(l.severity)}`}>{l.kind.replace(/_/g, " ")}</span> {l.message}
                    {l.suggestion && <div className="iqi-dim">{l.suggestion}</div>}
                    {l.action && !readOnly && <div><button type="button" className="iq-btn" data-testid="qt-adjust" onClick={() => propose(l.action as SurveyAction, l.kind === "full_while_open" ? `Raise the full cells of “${row.name}”` : `Lower the slow cell of “${row.name}”`)}>{l.kind === "full_while_open" ? "Raise the full cells" : "Lower to the projected"}</button></div>}
                  </li>
                ))}
              </ul>
            )}
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {!readOnly && <button type="button" className="iq-btn" data-testid="qt-ask-rebalance" disabled={copilot.busy} onClick={() => ask(`Look at the “${row.name}” quota${copilot.quotaCounts ? " and its counts" : ""}: are the cells and limits right for the fieldwork, and what would you change?`)}>Ask the copilot</button>}
              {!readOnly && row.mode === "hard" && <button type="button" className="iq-btn" data-testid="qt-soft" onClick={() => propose({ op: "update_quota", quota: row.id, mode: "soft" } as SurveyAction, `Make quota “${row.name}” soft`)} title="Count, flag, stop nobody">Make soft</button>}
            </div>
          </section>
        );
      })}

      {def.quotas.length > 0 && (
        <p className="iqi-dim"><Icon name="info" size={12} /> {copilot.quotaCounts ? `Live counts as of ${new Date(copilot.quotaCountsAt ?? Date.now()).toLocaleTimeString()}` : "No live counts here (the sandbox has none; a saved survey's counts load from fieldwork)"}. Limits are edited by hand in Studio → Quotas; here every change is a proposal through Changes.{copilot.quotaCounts && <> <button type="button" className="iq-btn" onClick={() => void copilot.refreshQuotaCounts()} data-testid="qt-refresh">Refresh</button></>}</p>
      )}
    </div>
  );
}
