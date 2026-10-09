"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { changeItems, compileAnimation, compileStyle, describeUxTarget, diffSurveys, reviewUx, type DependencyIndex, type ObjectKey, type SurveyAction } from "@rescript/engine";
import { Icon } from "../../ui/Icon";
import { structureRows, changeLabel, uxPreviewScope, type OutlineRow, type ProposalState } from "../../../lib/copilot/client";
import { UxPreview } from "./UxPreview";
import { AnalysisTab } from "./AnalysisTab";
import { LanguagesTab } from "./LanguagesTab";
import { QuotasTab, type QuotaImportNote } from "./QuotasTab";
import { FindingsTab } from "./FindingsTab";
import { Linked } from "./CopilotCard";
import { ChangeReview } from "./ChangeReview";
import { ContextPanel } from "./ContextPanel";
import { applyCount, presentIds, reviewTree, optionTitle } from "../../../lib/copilot/review";
import { apiCallWords, canReapply, canRestore, isChange, sourceWord, statusWord, type ClientOp } from "../../../lib/copilot/history";
import { formatCharge } from "../../../lib/import/chat";
import type { Copilot, PanelTab } from "./useCopilot";
import { describeDocMerge, mergeDocActions } from "../../../lib/copilot/mergeDoc";

/**
 * THE RIGHT-HAND PANEL of the copilot workspace (the copilot brief §10, §12,
 * §17, §18):
 *
 *   Changes    exactly what the open proposal will do — the change list, the
 *              destructive part behind a confirmation, what was refused and
 *              why, what the result newly breaks, the review of every change
 *              question by question (ChangeReview: tick or untick each one;
 *              Apply writes the ticked ones), and the structure before and after
 *   Review     findings grouped Critical / Warning / Suggestion — the
 *              engine's checks and the model's reading — each linked to its
 *              questions, mechanical fixes offered as a preview
 *   Research   the uploaded documents and their research cards
 *   History    every Intelligent operation of this survey, newest first,
 *              read back from the server (it survives a reload): the prompt,
 *              its status and source, the AI change number; expanded, how it
 *              was read and what it did; Compare, Restore, Reapply
 *   Analysis   the analysis framework (AnalysisTab)
 *   Languages  each language version's state and next step (LanguagesTab)
 *   Quotas     the feasibility review, the live counts' advice, the sheet import (QuotasTab)
 *   Findings   what the data said: the latest analysis run's verdicts and findings (FindingsTab)
 *   Inspector  the object in focus: what can be done to it and what depends
 *              on it (ContextPanel), then the existing inspector
 *
 * The strip WRAPS onto a second line rather than scrolling sideways — ten
 * tabs do not fit a 360 px panel, and a tab you cannot see is a tab you do
 * not know exists.
 */
export function CopilotPanel({ copilot, def, onSelect, inspector, onApply, applyNote, readOnly, onImportQuotaSheet, quotaImport, primary, index, onSelectKey, onAsk, onTemplate }: {
  copilot: Copilot;
  def: SurveyDefinition;
  onSelect(questionId: string): void;
  inspector: React.ReactNode;
  /** the selection (a dependency-index key) and the index of the survey as it is — for the Inspector tab's actions and dependency map */
  primary: ObjectKey | null;
  index: DependencyIndex;
  /** navigate to any object: a calculation, a skip rule, a quota, a block */
  onSelectKey(key: string): void;
  /** send a sentence as if typed — a ready context action */
  onAsk(sentence: string): void;
  /** put a sentence in the input box to finish — a context-action template */
  onTemplate(sentence: string): void;
  onApply(): void;
  applyNote: string | null;
  readOnly: boolean;
  onImportQuotaSheet?: () => void;
  quotaImport?: QuotaImportNote | null;
}) {
  /*
   * THE OPTION SELECTED IN THIS PANEL — an option row of the review, or a
   * chip in the Inspector's option list. The survey's selection is a
   * question; the option narrows the Inspector's actions to it. It belongs
   * to its question: selecting another question drops it.
   */
  const [option, setOption] = React.useState<{ questionId: string; code: string | number } | null>(null);
  React.useEffect(() => { if (option && primary !== `question:${option.questionId}`) setOption(null); }, [primary, option]);
  const tabs: { id: PanelTab; label: string; badge?: number }[] = [
    { id: "changes", label: "Changes", badge: copilot.state ? copilot.state.diff.summary.length : undefined },
    { id: "review", label: "Review", badge: copilot.review ? copilot.review.rules.counts.critical + copilot.review.ai.filter((f) => f.severity === "critical").length || undefined : undefined },
    { id: "research", label: "Research", badge: copilot.docs.length || undefined },
    { id: "history", label: "History", badge: copilot.ops.filter((o) => o.status === "applied" || o.status === "saved" || o.status === "save_failed").length || undefined },
    { id: "analysis", label: "Analysis", badge: def.research?.analysisPlan ? (def.research.analysisPlan.crosstabs.length + def.research.analysisPlan.tests.length) || undefined : undefined },
    { id: "findings", label: "Findings", badge: copilot.analysisRun ? copilot.analysisRun.findings.filter((f) => f.significant).length || undefined : undefined },
    { id: "languages", label: "Languages", badge: def.localization?.languages?.length || undefined },
    { id: "quotas", label: "Quotas", badge: def.quotas.length || undefined },
    { id: "ux", label: "UX", badge: def.ux ? (def.ux.styles.length + def.ux.animations.length + def.ux.behaviors.length) || undefined : undefined },
    { id: "inspector", label: "Inspector" },
  ];
  return (
    <aside className="iq-inspector cp-panel" data-testid="cp-panel" data-tab={copilot.tab}>
      <div className="cp-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={copilot.tab === t.id} className={`cp-tab${copilot.tab === t.id ? " on" : ""}`} onClick={() => copilot.setTab(t.id)} data-testid={`cp-tab-${t.id}`}>
            {t.label}{t.badge ? <span className="cp-badge">{t.badge}</span> : null}
          </button>
        ))}
      </div>
      <div className="cp-panel-body">
        {copilot.tab === "changes" && <ChangesTab copilot={copilot} def={def} onSelect={onSelect} onSelectKey={onSelectKey} onSelectOption={(questionId, code) => setOption({ questionId, code })} onApply={onApply} applyNote={applyNote} readOnly={readOnly} />}
        {copilot.tab === "review" && <ReviewTab copilot={copilot} def={def} onSelect={onSelect} />}
        {copilot.tab === "research" && <ResearchTab copilot={copilot} def={def} />}
        {copilot.tab === "history" && <HistoryTab copilot={copilot} def={def} readOnly={readOnly} onSelect={onSelect} />}
        {copilot.tab === "analysis" && <AnalysisTab copilot={copilot} def={def} onSelect={onSelect} />}
        {copilot.tab === "findings" && <FindingsTab copilot={copilot} def={def} onAsk={onAsk} />}
        {copilot.tab === "languages" && <LanguagesTab copilot={copilot} def={def} onSelect={onSelect} />}
        {copilot.tab === "quotas" && <QuotasTab copilot={copilot} def={def} onSelect={onSelect} onImportSheet={() => onImportQuotaSheet?.()} lastImport={quotaImport ?? null} readOnly={readOnly} />}
        {copilot.tab === "ux" && <UxTab copilot={copilot} def={def} onSelect={onSelect} />}
        {copilot.tab === "inspector" && (
          <>
            <ContextPanel def={copilot.working} current={def} index={index} primary={primary} option={option} onOption={setOption} onAsk={onAsk} onTemplate={onTemplate} onSelect={onSelect} onSelectKey={onSelectKey} busy={copilot.busy} />
            {inspector}
          </>
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------ changes */

/** the languages named by the engine's "N translations are now outdated (de, es)" warning — or null */
function outdatedLanguages(warnings: string[]): string | null {
  for (const w of warnings) { const m = /now outdated \(([^)]+)\)/.exec(w); if (m) return m[1]; }
  return null;
}

function ChangesTab({ copilot, onSelect, onSelectKey, onSelectOption, onApply, applyNote, readOnly }: { copilot: Copilot; def: SurveyDefinition; onSelect(id: string): void; onSelectKey(key: string): void; onSelectOption(questionId: string, code: string | number): void; onApply(): void; applyNote: string | null; readOnly: boolean }) {
  const st = copilot.state;
  const p = copilot.proposal;
  const [view, setView] = React.useState<"after" | "both">("after");
  /* "Apply 7 of 9 changes": counted over the review's rows, the whole proposal's — what is ticked of what was proposed */
  const tree = React.useMemo(() => (p && copilot.full ? reviewTree(p, copilot.full) : null), [p, copilot.full]);
  const present = React.useMemo(() => (p && st ? presentIds(p, st) : null), [p, st]);
  const count = React.useMemo(() => (tree ? applyCount(tree, copilot.excluded, present) : null), [tree, copilot.excluded, present]);
  if (!p || !st) return <p className="cp-empty" data-testid="cp-no-proposal">No change is proposed. Ask the copilot for one — “create a survey to test my hypothesis”, “add a question measuring brand trust”, “randomize the brands” — and it appears here, exactly, before anything is written.</p>;
  const beforeRows = structureRows(p.base, st.diff, "before");
  const afterRows = structureRows(st.after, st.diff, "after");
  const blocked = (st.destructive.length > 0 && !copilot.confirmed) || st.diff.empty || readOnly;
  const allOut = !!count && count.total > 0 && count.included === 0;
  const partial = !!count && copilot.excluded.length > 0 && count.included < count.total;
  return (
    <div className="cp-changes" data-testid="cp-changes">
      <div className="iq-label">The copilot wants to make these changes</div>
      {p.steps.length > 1 && <p className="iqi-dim" data-testid="cp-steps">{p.steps.length} requests: {p.steps.map((x) => `“${x.request.slice(0, 50)}”`).join(" → ")}</p>}
      <ul className="cp-summary" data-testid="cp-summary">{st.diff.summary.map((l, i) => <li key={i}><Linked text={l} def={st.after} onSelect={onSelect} /></li>)}</ul>
      {copilot.stale && <p className="iq-warning" data-testid="cp-stale"><Icon name="warning" size={12} /> The survey changed since this was proposed; Apply replays it onto the current survey first.</p>}
      {st.errors.length > 0 && (
        <div className="cp-block err" data-testid="cp-refused">
          <div className="iq-label">Not possible — {st.errors.length} action{st.errors.length === 1 ? "" : "s"} refused</div>
          <ul>{st.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
      {p.base.meta.status === "live" && (st.diff.questionsModified.length > 0 || st.diff.questionsRemoved.length > 0) && (
        <p className="iq-error" data-testid="cp-live-warning"><Icon name="warning" size={12} /> This survey is live. Changing or removing questions that already have answers affects the data you have collected — nothing here touches the responses themselves, and nothing is published until you deploy again.</p>
      )}
      {st.destructive.length > 0 && (
        <div className="cp-block danger" data-testid="cp-destructive">
          <div className="iq-label">Removes or rewrites existing content</div>
          <ul>{st.destructive.map((e, i) => <li key={i}><Linked text={e} def={p.base} onSelect={onSelect} /></li>)}</ul>
          <label className="cp-confirm"><input type="checkbox" checked={copilot.confirmed} onChange={(e) => copilot.setConfirmed(e.target.checked)} data-testid="cp-confirm" /> I understand — apply these {st.destructive.length} change{st.destructive.length === 1 ? "" : "s"} too (undoable)</label>
        </div>
      )}
      {(!st.diff.ux.empty || st.diff.theme.length > 0) && <UxChanges st={st} base={p.base} />}
      {st.warnings.length > 0 && (
        <div className="cp-block warn" data-testid="cp-new-problems">
          <div className="iq-label">The result would have {st.warnings.length} new problem{st.warnings.length === 1 ? "" : "s"}</div>
          <ul>{st.warnings.map((e, i) => <li key={i}><Linked text={e} def={st.after} onSelect={onSelect} /></li>)}</ul>
          {outdatedLanguages(st.warnings) && (
            <p className="iqi-dim" data-testid="cp-outdated-note">
              The translations stay until re-translated or confirmed; in the meantime those respondents see the outdated text.{" "}
              <button type="button" className="iq-btn" data-testid="cp-retranslate" disabled={copilot.busy || readOnly} onClick={() => void copilot.ask(`Re-translate the outdated translations in ${outdatedLanguages(st.warnings)} — the source text changed in this proposal.`)}>Re-translate them in this proposal</button>
            </p>
          )}
        </div>
      )}
      <ChangeReview copilot={copilot} tree={tree} present={present} onSelect={onSelect} onSelectKey={onSelectKey} onSelectOption={onSelectOption} />
      <div className="cp-structure-head">
        <span className="iq-label">Structure</span>
        <span className="iq-spacer" />
        <button type="button" className={`iq-btn${view === "after" ? " on" : ""}`} onClick={() => setView("after")}>After</button>
        <button type="button" className={`iq-btn${view === "both" ? " on" : ""}`} onClick={() => setView("both")} data-testid="cp-before-after">Before / after</button>
      </div>
      <div className={`cp-structure${view === "both" ? " two" : ""}`} data-testid="cp-structure">
        {view === "both" && <Outline rows={beforeRows} title="Before" onSelect={onSelect} def={p.base} />}
        <Outline rows={afterRows} title={view === "both" ? "After" : undefined} onSelect={onSelect} def={st.after} />
      </div>
      {applyNote && <p className="iq-warning" data-testid="cp-apply-note"><Icon name="info" size={12} /> {applyNote}</p>}
      {allOut && <p className="iq-warning" data-testid="cp-all-excluded"><Icon name="info" size={12} /> Every change is excluded — tick at least one to apply, or cancel the proposal.</p>}
      <div className="iq-actions">
        <button type="button" className="iq-btn" onClick={copilot.cancel} data-testid="cp-panel-cancel">Cancel</button>
        <span className="iq-spacer" />
        <button type="button" className="iq-btn primary" onClick={onApply} disabled={blocked} data-testid="cp-panel-apply" title={readOnly ? "Read-only" : allOut ? "Every change is excluded — tick at least one to apply" : st.diff.empty ? (st.errors.length ? "Nothing to apply — the Studio refused every change (see why above)" : "Nothing to apply") : st.destructive.length && !copilot.confirmed ? "Confirm the destructive changes first" : partial ? "Apply the ticked changes as one undoable change; the unticked ones are left out" : "Apply as one undoable change"} data-included={count?.included ?? ""} data-total={count?.total ?? ""}>{partial ? `Apply ${count!.included} of ${count!.total} changes` : "Apply changes"}</button>
      </div>
    </div>
  );
}

function Outline({ rows, title, onSelect, def }: { rows: OutlineRow[]; title?: string; onSelect(id: string): void; def: SurveyDefinition }) {
  return (
    <div className="cp-outline" data-testid={title ? `cp-outline-${title.toLowerCase()}` : "cp-outline"}>
      {title && <div className="iq-label">{title}</div>}
      {rows.length === 0 && <p className="iqi-dim">(empty)</p>}
      {/* keyed by place as well as id: a question placed in two branches (the master demo's Q43 / Q44) is two rows */}
      {rows.map((r, i) => r.kind === "block"
        ? <div key={`b${i}:${r.id}`} className={`cp-o-block${r.mark ? ` m-${r.mark}` : ""}`} data-mark={r.mark ?? ""}>{r.label}</div>
        : <button key={`q${i}:${r.id}`} type="button" className={`cp-o-q${r.mark ? ` m-${r.mark}` : ""}`} data-mark={r.mark ?? ""} onClick={() => def.questions.some((q) => q.id === r.id) && onSelect(r.id)} data-testid="cp-o-q">{r.label}{r.mark ? <span className="cp-mark">{r.mark}</span> : null}</button>)}
    </div>
  );
}

/* ------------------------------------------------------------ the look and behaviour */

/**
 * WHAT A PROPOSAL DOES TO THE LOOK AND BEHAVIOUR: each item in words, a
 * proof that the structure is untouched (for a look-only request the engine
 * refused anything else), the preview on the real components, and the
 * generated code — scoped CSS and sandboxed scripts — for whoever wants it.
 */
function UxChanges({ st, base }: { st: ProposalState; base: SurveyDefinition }) {
  const scope = React.useMemo(() => uxPreviewScope(st.after, st.diff), [st.after, st.diff]);
  const ids = new Set([...st.diff.ux.added, ...st.diff.ux.changed].map((x) => x.id));
  const ux = st.after.ux ?? { styles: [], animations: [], behaviors: [] };
  const code = [
    ...ux.styles.filter((x) => ids.has(x.id)).map((x) => ({ id: x.id, label: x.label, lang: "css", text: prettyCss(compileStyle(st.after, x).css) })),
    ...ux.animations.filter((x) => ids.has(x.id)).map((x) => ({ id: x.id, label: x.label, lang: "css", text: prettyCss(compileAnimation(st.after, x)) })),
    ...ux.behaviors.filter((x) => ids.has(x.id) && x.script).map((x) => ({ id: x.id, label: x.label, lang: "js · sandboxed", text: x.script! })),
  ];
  return (
    <div className="cp-block cp-ux" data-testid="cp-ux">
      <div className="iq-label">Look and behaviour</div>
      {st.structureUnchanged
        ? <p className="cp-ux-safe" data-testid="cp-ux-structure-ok"><Icon name="check" size={12} /> {st.uxOnly ? "UX only — " : ""}the survey's questions, options, codes, logic and validation are unchanged.</p>
        : <p className="iqi-dim" data-testid="cp-ux-with-structure">This proposal also changes the survey's structure (listed above).</p>}
      <ul className="cp-ux-list" data-testid="cp-ux-items">
        {st.uxNotes.map((n, i) => <li key={i}>{n}</li>)}
        {st.diff.ux.removed.map((x) => <li key={x.id} className="cp-from">Remove {x.kind} “{x.label}” ({x.target})</li>)}
      </ul>
      {st.diff.theme.length > 0 && (
        <div data-testid="cp-theme-changes">
          <div className="iq-label">Theme — saved in Branding, adjustable there by hand</div>
          <ul className="cp-ux-list">{st.diff.theme.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </div>
      )}
      <UxPreview after={st.after} before={base} scope={scope} />
      {code.length > 0 && (
        <details className="cp-ux-code" data-testid="cp-ux-code">
          <summary className="iq-label">Generated code ({code.length})</summary>
          {code.map((c) => (
            <div key={c.id}>
              <div className="iqi-dim">{c.label} <span className="mono">· {c.lang}</span></div>
              <pre className="mono">{c.text}</pre>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
function prettyCss(css: string): string {
  return css.replace(/\{/g, " {\n  ").replace(/;/g, ";\n  ").replace(/\}/g, "\n}\n").replace(/\n\s*\n/g, "\n").trim();
}

/**
 * THE SURVEY'S UX as it is: every style, animation and behaviour with what it
 * targets, the UX review (dead targets, conflicts, overrides of the theme,
 * phone traps), and removal — previewed and applied like any change.
 */
function UxTab({ copilot, def, onSelect }: { copilot: Copilot; def: SurveyDefinition; onSelect(id: string): void }) {
  const ux = def.ux ?? { styles: [], animations: [], behaviors: [] };
  const findings = React.useMemo(() => reviewUx(def), [def]);
  const rows = [
    ...ux.styles.map((x) => ({ id: x.id, kind: "style", op: "remove_style", label: x.label, target: describeUxTarget(def, x.target), detail: `${x.rules.length} rule${x.rules.length === 1 ? "" : "s"}${x.css ? " + CSS" : ""}` })),
    ...ux.animations.map((x) => ({ id: x.id, kind: "animation", op: "remove_animation", label: x.label, target: describeUxTarget(def, x.target), detail: `${x.preset} on ${x.trigger.replace("_", " ")}, ${x.durationMs}ms` })),
    ...ux.behaviors.map((x) => ({ id: x.id, kind: "behaviour", op: "remove_behavior", label: x.label, target: describeUxTarget(def, x.target), detail: x.script ? "sandboxed script" : `on ${String(x.on).replace("_", " ")} → ${x.effects.map((e) => e.do.replace("_", " ")).join(", ")}` })),
  ];
  if (!rows.length && !findings.length) return <p className="cp-empty" data-testid="cp-no-ux">This survey has no custom styles, animations or behaviours. Ask for them in plain words — “make the Q4 options look like cards”, “fade in each question in Block 2 one at a time”, “when someone picks Other, expand the text box smoothly”, “on mobile stack Q7's options” — and the copilot previews them on the real questions before anything changes.</p>;
  return (
    <div className="cp-ux-tab" data-testid="cp-ux-tab">
      {findings.length > 0 && (
        <section data-testid="cp-ux-findings">
          <div className="iq-label">UX review · {findings.length}</div>
          <ul className="cp-review-list">
            {findings.map((f, i) => (
              <li key={i} data-severity={f.level} data-testid="cp-ux-finding">
                <span className={`cp-sev v-${f.level}`}>{f.level}</span> <Linked text={f.message} def={def} onSelect={onSelect} />
                {f.fix && <div className="cp-finding-foot"><button type="button" className="iq-btn" onClick={() => copilot.previewFix([f.fix as SurveyAction], `UX fix: ${f.message.slice(0, 60)}`)} data-testid="cp-ux-preview-fix">Preview fix</button></div>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="iq-label">In this survey · {rows.length}</div>
      <table className="iqi-table cp-ux-items">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid="cp-ux-row" data-kind={r.kind}>
              <td><b>{r.label}</b><div className="iqi-dim">{r.kind} · <span className="mono">{r.id}</span></div></td>
              <td><Linked text={r.target} def={def} onSelect={onSelect} /><div className="iqi-dim">{r.detail}</div></td>
              <td><button type="button" className="iq-btn" onClick={() => copilot.previewFix([{ op: r.op, id: r.id } as SurveyAction], `Remove ${r.kind} “${r.label}”`)} data-testid="cp-ux-remove">Remove…</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------ review */

function ReviewTab({ copilot, def, onSelect }: { copilot: Copilot; def: SurveyDefinition; onSelect(id: string): void }) {
  const rv = copilot.review;
  if (!rv) return (
    <div className="cp-empty">
      <p>Ask for a review — “review my survey” — or press Review. The engine checks the logic, reachability, options, scales, duplicates and length at once; the copilot reads for research alignment, hypothesis coverage, wording and bias.</p>
      <button type="button" className="iq-btn primary" onClick={() => void copilot.runReview()} data-testid="cp-run-review">Review the survey</button>
    </div>
  );
  const byCode = new Map(def.questions.map((q) => [String(q.code).toUpperCase(), q.id]));
  const all = [
    ...rv.rules.findings.map((f) => ({ severity: f.severity, message: f.message, suggestion: f.suggestion, questionIds: f.questionIds, fix: f.fix, source: "engine" as const })),
    ...rv.ai.map((f) => ({ severity: f.severity, message: f.message, suggestion: f.suggestion, questionIds: f.questions.map((c) => byCode.get(c.toUpperCase())).filter((x): x is string => !!x), fix: undefined as SurveyAction[] | undefined, source: "copilot" as const })),
  ];
  const groups = (["critical", "warning", "suggestion"] as const).map((sv) => ({ sv, items: all.filter((f) => f.severity === sv) }));
  return (
    <div className="cp-review" data-testid="cp-review">
      <div className="cp-review-head">
        <span className="iqi-dim">{rv.rules.questions} questions · about {rv.rules.minutes} min{rv.running ? " · the copilot is reading…" : ""}</span>
        <span className="iq-spacer" />
        <button type="button" className="iq-btn" onClick={() => void copilot.runReview()} data-testid="cp-rerun-review">Review again</button>
      </div>
      {groups.map(({ sv, items }) => (
        <section key={sv} data-testid={`cp-review-${sv}`}>
          <div className={`iq-label cp-sev-head v-${sv}`}>{sv === "critical" ? "Critical" : sv === "warning" ? "Warning" : "Suggestion"} · {items.length}</div>
          {items.length === 0 && <p className="iqi-dim">None.</p>}
          <ul className="cp-review-list">
            {items.map((f, i) => (
              <li key={i} data-severity={f.severity} data-source={f.source} data-testid="cp-finding">
                <Linked text={f.message} def={def} onSelect={onSelect} />
                {f.suggestion && <div className="iqi-dim">→ {f.suggestion}</div>}
                <div className="cp-finding-foot">
                  <span className="cp-src">{f.source}</span>
                  {f.questionIds.slice(0, 6).map((id) => { const q = def.questions.find((x) => x.id === id); return q ? <button key={id} type="button" className="iq-chip" onClick={() => onSelect(id)}>{q.code}</button> : null; })}
                  {f.fix && <button type="button" className="iq-btn" onClick={() => copilot.previewFix(f.fix!, `Fix: ${f.message.slice(0, 60)}`)} data-testid="cp-preview-fix">Preview fix</button>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ research */

function ResearchTab({ copilot, def }: { copilot: Copilot; def: SurveyDefinition }) {
  const input = React.useRef<HTMLInputElement>(null);
  return (
    <div className="cp-research" data-testid="cp-research">
      <div className="cp-review-head">
        <span className="iqi-dim">{copilot.docs.length} document{copilot.docs.length === 1 ? "" : "s"} · the copilot reads only the passages a request needs</span>
        <span className="iq-spacer" />
        <input ref={input} type="file" hidden multiple accept=".pdf,.docx,.txt,.md,.csv,.xlsx" onChange={(e) => { void copilot.uploadDocs([...(e.target.files ?? [])]); e.target.value = ""; }} data-testid="cp-doc-file" />
        <button type="button" className="iq-btn" onClick={() => input.current?.click()} disabled={copilot.uploading} data-testid="cp-add-docs"><Icon name="paperclip" size={12} /> {copilot.uploading ? "Reading…" : "Add documents"}</button>
      </div>
      {!copilot.durable && copilot.docs.length > 0 && <p className="iq-warning" data-testid="cp-not-durable"><Icon name="info" size={12} /> Documents are kept for this session only (the research store is not set up on this installation).</p>}
      {copilot.docError && <p className="iq-error" data-testid="cp-doc-error"><Icon name="warning" size={12} /> {copilot.docError}</p>}
      {copilot.uploading && <div className="iq-thinking"><span className="iq-dot" /><span className="iq-dot" /><span className="iq-dot" /></div>}
      {copilot.docs.length === 0 && !copilot.uploading && <p className="cp-empty">Attach papers, literature reviews, reports, client briefs or methodology notes (PDF — scanned pages are read by OCR — Word, text, CSV, Excel). Each is summarised once; then ask “based on the literature, …”.</p>}
      {copilot.docs.map((d) => (
        <details key={d.id} className="cp-doc" data-testid="cp-doc" open={copilot.docs.length <= 2}>
          <summary>
            <span className="mono cp-doc-ref">{d.ref}</span> <b>{d.name}</b> <span className="iqi-dim">{d.summary?.type ?? d.format} · {d.pages} page{d.pages === 1 ? "" : "s"}{d.ocrPages ? ` · ${d.ocrPages} by OCR` : ""}</span>
            <button type="button" className="cp-x" onClick={(e) => { e.preventDefault(); void copilot.deleteDoc(d.id); }} title="Remove this document" data-testid="cp-doc-delete">×</button>
          </summary>
          {d.summary?.summary && <p>{d.summary.summary}</p>}
          {d.summary && (
            <dl className="cp-card-dl">
              {([["Objectives", d.summary.objectives], ["Hypotheses", d.summary.hypotheses], ["Findings", d.summary.findings], ["Gaps", d.summary.gaps], ["Question areas", d.summary.questionAreas]] as const).filter(([, xs]) => xs.length).map(([k, xs]) => (
                <React.Fragment key={k}><dt>{k}</dt><dd>{xs.map((x) => x.text).join(" · ")}</dd></React.Fragment>
              ))}
              {d.summary.constructs.length > 0 && <><dt>Constructs</dt><dd>{d.summary.constructs.map((c) => c.name).join(" · ")}</dd></>}
              {d.summary.scales.length > 0 && <><dt>Scales</dt><dd>{d.summary.scales.map((c) => `${c.name}${c.items ? ` (${c.items} items${c.points ? `, ${c.points}-pt` : ""})` : ""}`).join(" · ")}</dd></>}
            </dl>
          )}
          {d.warnings.map((w, i) => <p key={i} className="iqi-dim"><Icon name="info" size={11} /> {w}</p>)}
          {d.summary && (() => {
            /* into the research model (Phase 3): what the card has that the design does not, as one proposal */
            const merge = mergeDocActions(def, { name: d.name, summary: d.summary });
            return <div className="row" style={{ gap: 6, marginTop: 6 }}><button type="button" className="iq-btn" data-testid="cp-doc-merge" disabled={merge.empty || copilot.busy} title={merge.empty ? "The research design already has everything this card found" : `Record ${describeDocMerge(merge)} in the research design — as a proposal to review`} onClick={() => copilot.previewFix(merge.actions, `Use “${d.name}” in the research design`)}>Use in the research design</button><span className="iqi-dim" data-testid="cp-doc-merge-adds">{merge.empty ? "already in the design" : `adds ${describeDocMerge(merge)}`}</span></div>;
          })()}
        </details>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ history */

/**
 * THE OPERATION HISTORY (Phase 5): every Intelligent operation on this
 * survey — read back from the server on opening (and after each change),
 * merged with what this page is still sending — newest first. An entry is a
 * line: the AI change number when it was applied, its status, where it was
 * read (the engine, the model, the grammar, a fix), the time and the
 * prompt; an applied one says what it created, modified, removed and left
 * out. Details opens how it was read and what it did; Compare shows the
 * survey before against after (read-only — the review's rows without the
 * ticks); Restore takes it back (said first when later edits go with it);
 * Reapply proposes its actions again against the survey as it is now —
 * through the review, never written blind.
 */
function HistoryTab({ copilot, def, readOnly, onSelect }: { copilot: Copilot; def: SurveyDefinition; readOnly: boolean; onSelect(id: string): void }) {
  const [warn, setWarn] = React.useState<{ key: string; reason: string } | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => { void copilot.refreshOps(); }, []);
  const ops = copilot.ops;
  const records = React.useMemo(() => new Map(copilot.history.filter((h) => h.key).map((h) => [h.key!, h])), [copilot.history]);
  const restore = async (o: ClientOp, force = false) => {
    const r = await copilot.restore(o.key, force);
    setWarn(!r.ok && r.reason && !force ? { key: o.key, reason: r.reason } : null);
  };
  /* said whenever the records are in this server's memory rather than the table */
  const durability = copilot.opsDurable === false && (
    <p className="iq-warning" data-testid="cp-history-not-durable"><Icon name="info" size={12} /> {copilot.sandbox
      ? "The sandbox has no database: this history is kept in this server's memory, for this browser tab — a reload keeps it, a server restart does not."
      : "This history is kept on this server only until the table is set up (migration 0047) — a server restart loses it."}</p>
  );
  if (!ops.length) return (
    <div className="cp-history" data-testid="cp-history-empty">
      {durability}
      {copilot.opsError && <p className="iq-error" data-testid="cp-history-error"><Icon name="warning" size={12} /> The history could not be read: {copilot.opsError}</p>}
      <p className="cp-empty" data-testid="cp-no-history">Every Intelligent operation is listed here — what you asked, how it was read, what was proposed and applied — and every applied change can be compared, restored or reapplied.</p>
    </div>
  );
  return (
    <div className="cp-history" data-testid="cp-history" data-durable={copilot.opsDurable === false ? "false" : "true"}>
      {durability}
      {copilot.opsError && <p className="iq-error" data-testid="cp-history-error"><Icon name="warning" size={12} /> The history could not be read: {copilot.opsError}</p>}
      {ops.map((o) => (
        <OpEntry key={o.key} o={o} all={ops} rec={records.get(o.key)} copilot={copilot} def={def} readOnly={readOnly} onSelect={onSelect}
          onRestore={(force) => void restore(o, force)} warn={warn?.key === o.key ? warn.reason : null} />
      ))}
    </div>
  );
}
function OpEntry({ o, all, rec, copilot, def, readOnly, onSelect, onRestore, warn }: {
  o: ClientOp; all: ClientOp[]; rec?: import("../../../lib/copilot/client").ChangeRecord; copilot: Copilot; def: SurveyDefinition; readOnly: boolean;
  onSelect(id: string): void; onRestore(force?: boolean): void; warn: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [cmp, setCmp] = React.useState<null | "loading" | { before: SurveyDefinition; after: SurveyDefinition } | { error: string }>(null);
  const change = isChange(o);
  const restore = canRestore(o, all);
  const reapply = canReapply(o, copilot.actionsOf(o.key));
  const excluded = rec?.excluded ?? (o.excluded.length ? o.excluded : undefined);
  const compare = async () => {
    if (cmp) { setCmp(null); return; }
    setCmp("loading");
    setCmp(await copilot.compare(o.key));
  };
  const qOf = (id: string) => def.questions.find((q) => q.id === id || String(q.code) === id);
  const time = o.createdAt ? new Date(o.createdAt) : null;
  return (
    <div className={`cp-change cp-op${o.status === "reverted" ? " reverted" : ""}`} data-testid={change ? "cp-change" : "cp-op"} data-op="true" data-status={o.status} data-source={o.source} data-n={o.changeN ?? ""} data-key={o.key}>
      <div className="cp-change-head">
        {change && <b data-testid="cp-op-n">{changeLabel(o.changeN)}</b>}
        <span className={`cp-op-status s-${o.status}`} data-testid="cp-op-status">{statusWord(o.status)}</span>
        <span className="cp-op-source" data-testid="cp-op-source">{sourceWord(o.source)}</span>
        {time && <span className="iqi-dim" title={time.toLocaleString()}>{time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
        <span className="iq-spacer" />
        {o.status === "reverted" && <span className="iqi-dim">undone</span>}
        {restore.offered && <button type="button" className="iq-btn" disabled={readOnly} onClick={() => onRestore()} data-testid="cp-undo-change" title={restore.latest ? "Take this change back, as one operation" : "Restore the survey to before this change — later changes go with it (you are asked first)"}>Restore{restore.latest ? "" : "…"}</button>}
      </div>
      <p className="iqi-dim cp-change-req" data-testid="cp-op-prompt">“{o.prompt.slice(0, 160)}{o.prompt.length > 160 ? "…" : ""}”</p>
      {rec && rec.created.length > 0 && <div><span className="iq-label">Created</span> {rec.created.join(", ")}</div>}
      {rec && rec.modified.length > 0 && <div><span className="iq-label">Modified</span> {rec.modified.join(", ")}</div>}
      {rec && rec.removed.length > 0 && <div><span className="iq-label">Removed</span> {rec.removed.join(", ")}</div>}
      {!rec && change && o.applied.length > 0 && <div><span className="iq-label">Applied</span> {o.applied.slice(0, 4).join("; ")}{o.applied.length > 4 ? ` and ${o.applied.length - 4} more` : ""}</div>}
      {excluded && excluded.length > 0 && <div data-testid="cp-change-excluded"><span className="iq-label">Excluded</span> {excluded.length === 1 ? "1 proposed change was" : `${excluded.length} proposed changes were`} left out: {excluded.join("; ")}</div>}
      {o.status === "save_failed" && <p className="iq-error" data-testid="cp-op-not-saved"><Icon name="warning" size={12} /> {o.statusDetail ?? "Not saved."}</p>}
      {o.recordError && <p className="iqi-dim" data-testid="cp-op-record-error"><Icon name="info" size={11} /> {o.recordError}</p>}
      {o.auditError && <p className="iqi-dim" data-testid="cp-op-audit-error"><Icon name="info" size={11} /> {o.auditError}</p>}
      <div className="cp-op-actions">
        <button type="button" className={`iq-btn${open ? " on" : ""}`} aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="cp-op-expand">{open ? "▾" : "▸"} Details</button>
        {change && o.hasBefore && <button type="button" className={`iq-btn${cmp ? " on" : ""}`} onClick={() => void compare()} data-testid="cp-op-compare">Compare</button>}
        {reapply && <button type="button" className="iq-btn" disabled={readOnly || copilot.busy} onClick={() => copilot.reapply(o.key)} data-testid="cp-op-reapply" title="Propose these actions again, against the survey as it is now — they go through the review before anything is written">Reapply</button>}
      </div>
      {open && (
        <dl className="cp-op-detail" data-testid="cp-op-detail">
          {Object.keys(o.intent).length > 0 && <><dt>Read as</dt><dd data-testid="cp-op-intent">{Object.entries(o.intent).filter(([, v]) => v !== null && v !== "").map(([k, v]) => `${k}: ${v}`).join(" · ")}</dd></>}
          {o.detected.length > 0 && <><dt>Detected</dt><dd data-testid="cp-op-detected"><ul>{o.detected.map((d, i) => <li key={i}>{d.what}: <Linked text={d.value} def={def} onSelect={onSelect} /></li>)}</ul></dd></>}
          {o.targets.length > 0 && <><dt>Targets</dt><dd data-testid="cp-op-targets">{o.targets.map((t) => { const q = qOf(t); return q ? <button key={t} type="button" className="iq-chip" onClick={() => onSelect(q.id)} data-testid="cp-op-target" data-question={q.id}>{q.code}</button> : <span key={t} className="mono cp-op-target-gone">{t} </span>; })}</dd></>}
          <OpList title="Proposed" items={o.proposed.map((p) => p.description)} testid="cp-op-proposed" def={def} onSelect={onSelect} />
          <OpList title="Applied" items={o.applied} testid="cp-op-applied" def={def} onSelect={onSelect} />
          <OpList title="Left out" items={o.excluded} testid="cp-op-excluded" def={def} onSelect={onSelect} />
          <OpList title="Refused" items={o.failed.map((f) => (f.reason ? `${f.description} — ${f.reason}` : f.description))} testid="cp-op-failed" def={def} onSelect={onSelect} />
          <OpList title="Warnings" items={o.warnings} testid="cp-op-warnings" def={def} onSelect={onSelect} />
          {o.engineOps.length > 0 && <><dt>Engine operations</dt><dd className="mono" data-testid="cp-op-engine-ops">{o.engineOps.join(", ")}</dd></>}
          <dt>Model calls</dt>
          <dd data-testid="cp-op-api-calls">{o.apiCalls.length ? <ul>{o.apiCalls.map((c, i) => <li key={i} data-testid="cp-op-api-call">{apiCallWords(c, formatCharge)}</li>)}</ul> : "none — read by the Studio's own engine, nothing charged"}</dd>
          {o.statusDetail && <><dt>Status</dt><dd data-testid="cp-op-status-detail">{o.statusDetail}</dd></>}
        </dl>
      )}
      {cmp && <OpCompare cmp={cmp} def={def} onSelect={onSelect} />}
      {warn && (
        <div className="cp-block warn" data-testid="cp-revert-warning">
          <p>{warn}</p>
          <button type="button" className="iq-btn" onClick={() => onRestore(true)} data-testid="cp-revert-anyway">Restore to before {changeLabel(o.changeN)}</button>
        </div>
      )}
    </div>
  );
}

function OpList({ title, items, testid, def, onSelect }: { title: string; items: string[]; testid: string; def: SurveyDefinition; onSelect(id: string): void }) {
  if (!items.length) return null;
  return <><dt>{title}</dt><dd data-testid={testid}><ul>{items.map((x, i) => <li key={i}><Linked text={x} def={def} onSelect={onSelect} /></li>)}</ul></dd></>;
}

/**
 * COMPARE: the survey before the change against after it, as the review
 * reads a proposal — the summary, then one row per change (category, the
 * object, the field, old → new) — read-only: there is nothing to tick in
 * what already happened.
 */
function OpCompare({ cmp, def, onSelect }: { cmp: "loading" | { before: SurveyDefinition; after: SurveyDefinition } | { error: string }; def: SurveyDefinition; onSelect(id: string): void }) {
  const result = cmp !== "loading" && "before" in cmp ? cmp : null;
  const view = React.useMemo(() => {
    if (!result) return null;
    try { return { summary: diffSurveys(result.before, result.after).summary, items: changeItems(result.before, result.after).items }; } catch (e) { return { error: (e as Error).message }; }
  }, [result]);
  if (cmp === "loading") return <div className="cp-compare" data-testid="cp-compare" data-state="loading"><span className="iqi-dim">Reading the surveys before and after…</span></div>;
  if ("error" in cmp) return <div className="cp-compare" data-testid="cp-compare" data-state="error"><p className="iq-warning"><Icon name="info" size={12} /> {cmp.error}</p></div>;
  if (!view || "error" in view) return <div className="cp-compare" data-testid="cp-compare" data-state="error"><p className="iq-warning">The two surveys could not be compared{view && "error" in view ? `: ${view.error}` : ""}.</p></div>;
  return (
    <div className="cp-compare" data-testid="cp-compare" data-state="ready" data-items={view.items.length}>
      <div className="iq-label">Before → after</div>
      {view.summary.length === 0 && <p className="iqi-dim">The two surveys are the same.</p>}
      <ul className="cp-summary" data-testid="cp-compare-summary">{view.summary.map((l, i) => <li key={i}><Linked text={l} def={def} onSelect={onSelect} /></li>)}</ul>
      <ul className="cp-rows">
        {view.items.slice(0, 80).map((it) => (
          <li key={it.id} className="cp-row" data-testid="cp-compare-row" data-category={it.category} data-code={it.question?.code ?? ""}>
            <div className="cp-row-body">
              <div className="cp-row-head">
                <span className={`cp-cat k-${it.kind}`}>{it.category}</span>
                {it.question && <b className="mono">{it.question.code}</b>}
                {it.option && <span className="cp-row-opt">{optionTitle(it.option, "Option")}</span>}
                <span className="cp-row-field">{it.field}</span>
              </div>
              {it.from ? <div className="cp-val from"><span className="cp-val-k">old</span><span className="cp-val-t all">{it.from}</span></div> : null}
              {it.to ? <div className="cp-val to"><span className="cp-val-k">new</span><span className="cp-val-t all">{it.to}</span></div> : null}
            </div>
          </li>
        ))}
        {view.items.length > 80 && <li className="iqi-dim">and {view.items.length - 80} more</li>}
      </ul>
    </div>
  );
}
