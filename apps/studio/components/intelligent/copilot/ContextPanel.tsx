"use client";
import React from "react";
import type { Option, SurveyDefinition } from "@rescript/schema";
import { contextActions, dependencyReport, listBlocks, parseObjectKey, type ContextAction, type ContextTarget, type DependencyIndex, type ObjectKey } from "@rescript/engine";
import { groupContextActions, optionFacts, typeName } from "../../../lib/copilot/review";
import { plainText } from "../../../lib/copilot/client";
import { OptionPeek } from "./ChangeReview";

/**
 * THE SELECTION, MADE ACTIONABLE (Intelligent Mode upgrade, Phase 4 — the
 * audit's R15): the top of the Inspector tab, above the existing inspector.
 *
 *   ACTIONS FOR Q7                 only what is valid for THIS object: the
 *     Logic   [Add display logic…] [Add skip logic…]      options group only
 *     Options [Add “Other”] [Sort A → Z] …                for a question with
 *     …                                                   options, a range only for a number
 *   OPTIONS   1 Yes · 2 No          click one: the actions become the option's
 *   DEPENDENCIES
 *     Q7
 *     ↓ Display logic   Q8 · Q9
 *     ↓ Skip logic      Q7 skip 1
 *     Reads             —
 *
 * The actions are the engine's (`contextActions`): each is a SENTENCE its own
 * interpreter reads, so a click goes the way typing does. A ready one is
 * sent as it is — interpretation, validation, the Changes panel, Apply; a
 * template ("Show Q7 only if …") is put in the input box for the researcher
 * to finish. Working out which are valid runs the interpreter on each ready
 * sentence (up to half a second on a 60-question survey), so it is computed
 * AFTER the selection has painted, in a transition, with a placeholder
 * meanwhile — selecting is never held up by it.
 *
 * The dependency map is `dependencyReport` on the same object: what reads it,
 * by kind, as a downward flow, then what it reads; every item navigates.
 */
export function ContextPanel({ def, current, index, primary, option, onOption, onAsk, onTemplate, onSelect, onSelectKey, busy }: {
  /** the survey the sentences will be read against — the open proposal's result, else the survey */
  def: SurveyDefinition;
  /** the survey as it is now, with `index` built from it — what the dependency map describes */
  current: SurveyDefinition;
  index: DependencyIndex;
  primary: ObjectKey | null;
  /** the option selected in this panel, for the selected question */
  option: { questionId: string; code: string | number } | null;
  onOption(o: { questionId: string; code: string | number } | null): void;
  onAsk(sentence: string): void;
  onTemplate(sentence: string): void;
  onSelect(questionId: string): void;
  onSelectKey(key: string): void;
  busy: boolean;
}) {
  const parsed = primary ? parseObjectKey(primary) : null;
  const question = parsed?.kind === "question" ? def.questions.find((q) => q.id === parsed.id) ?? current.questions.find((q) => q.id === parsed.id) ?? null : null;
  const block = parsed?.kind === "flowNode" ? listBlocks(def.flow as unknown[]).find((b) => b.id === parsed.id) ?? null : null;
  const opt = question && option?.questionId === question.id ? ((question.options ?? []) as Option[]).find((o) => String(o.code) === String(option.code)) ?? null : null;
  const target: ContextTarget | null = question ? (opt ? { questionId: question.id, option: opt.code } : { questionId: question.id }) : block ? { blockId: block.id } : null;
  const key = target ? JSON.stringify(target) : "";

  /* the valid operations, computed after the selection paints — see the header */
  const [computed, setComputed] = React.useState<{ key: string; def: SurveyDefinition; actions: ContextAction[] } | null>(null);
  const [, startTransition] = React.useTransition();
  React.useEffect(() => {
    if (!target) return;
    const t = window.setTimeout(() => {
      let actions: ContextAction[] = [];
      try { actions = contextActions(def, target); } catch { /* a half-formed survey offers nothing rather than taking the panel down */ }
      startTransition(() => setComputed({ key, def, actions }));
    }, 0);
    return () => window.clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, def]);
  const ready = !!computed && computed.key === key && computed.def === def;
  const groups = React.useMemo(() => (ready ? groupContextActions(computed!.actions) : []), [ready, computed]);

  /* the dependency map — index lookups, cheap enough to follow the selection directly */
  const report = React.useMemo(() => {
    if (!primary || !index.nodes.has(primary)) return null;
    try { return dependencyReport(current, primary, { index }); } catch { return null; }
  }, [current, index, primary]);

  if (!target && !report) return null;
  const name = question ? String(question.code) : block ? `block “${block.title ?? block.id}”` : report?.label ?? "";
  const nav = (k: string | undefined) => { if (!k) return; if (k.startsWith("question:")) onSelect(k.slice(9)); else onSelectKey(k); };

  return (
    <div className="cp-context" data-testid="cp-context" data-target={question?.code ?? block?.id ?? ""}>
      {question && (
        <p className="cp-ctx-what" data-testid="cp-ctx-what"><b className="mono">{question.code}</b> · {typeName(question)} · <span className="cp-ctx-text">{plainText(question.text ?? "") || "(no text)"}</span></p>
      )}
      {target && (
        <section className="cp-ctx-actions" data-testid="cp-ctx-actions" aria-busy={!ready}>
          <div className="cp-ctx-head">
            <span className="iq-label" data-testid="cp-ctx-title">Actions for {name}{opt ? ` · option ${opt.code} “${plainText(opt.label)}”` : ""}</span>
            {opt && <button type="button" className="cp-ref" onClick={() => onOption(null)} data-testid="cp-ctx-option-clear" title="Back to the question's actions">× option</button>}
          </div>
          {!ready
            ? <p className="iqi-dim cp-ctx-wait" data-testid="cp-ctx-pending">Finding what can be done…</p>
            : groups.length === 0
              ? <p className="iqi-dim" data-testid="cp-ctx-none">Nothing the engine can do to this object from here.</p>
              : groups.map((g) => (
                <div key={g.group} className="cp-ctx-group" data-testid="cp-ctx-group" data-group={g.group}>
                  <span className="cp-ctx-gname">{g.group}</span>
                  <div className="cp-ctx-btns">
                    {g.actions.map((a) => (
                      <button
                        key={a.label + a.sentence} type="button" className={`cp-ctx-btn${a.ready ? " ready" : " template"}${a.destructive ? " danger" : ""}`}
                        data-testid="cp-ctx-action" data-ready={a.ready ? "true" : "false"} data-destructive={a.destructive ? "true" : "false"} data-sentence={a.sentence}
                        disabled={a.ready && busy}
                        title={a.ready ? `${a.destructive ? "Removes or rewrites content — " : ""}Propose: “${a.sentence.trim()}” (reviewed before anything is applied)` : `Write it: “${a.sentence.trim()} …” goes in the input box to finish`}
                        onClick={() => (a.ready ? onAsk(a.sentence) : onTemplate(a.sentence))}
                      >
                        {a.label}{a.ready || a.label.endsWith("…") ? "" : " …"}{a.destructive ? <span className="cp-ctx-warn" aria-label="destructive"> ⚠</span> : null}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
        </section>
      )}
      {question && (question.options?.length ?? 0) > 0 && (
        <section className="cp-ctx-options" data-testid="cp-ctx-options">
          <div className="iq-label">Options · {question.options!.length}</div>
          <div className="cp-optlist">
            {(question.options as Option[]).map((o) => <OptionChip key={String(o.code)} def={current.questions.some((q) => q.id === question.id) ? current : def} questionId={question.id} o={o} on={!!opt && String(opt.code) === String(o.code)} onPick={() => onOption(opt && String(opt.code) === String(o.code) ? null : { questionId: question.id, code: o.code })} nav={nav} index={current.questions.some((q) => q.id === question.id) ? index : undefined} />)}
          </div>
        </section>
      )}
      {report && (
        <section className="cp-depmap" data-testid="cp-depmap" data-used-by={report.usedByCount} data-reads={report.readsCount}>
          <div className="iq-label">Dependencies</div>
          <div className="cp-dep-root mono" data-testid="cp-dep-root">{report.label}</div>
          <p className="cp-dep-summary iqi-dim" data-testid="cp-dep-summary">{report.usedBySummary}</p>
          {report.usedBy.map((sec) => (
            <div key={sec.title} className="cp-dep-sec" data-testid="cp-dep-section" data-title={sec.title}>
              <div className="cp-dep-arrow"><span aria-hidden="true">↓</span> {sec.title}</div>
              <div className="cp-dep-items">{sec.items.map((it, k) => <button key={k} type="button" className="iq-chip cp-dep-chip" onClick={() => nav(it.key)} disabled={!it.key} data-testid="cp-dep-chip" data-key={it.key ?? ""} title={it.detail ?? it.label}>{it.label}{it.detail ? <span className="cp-dep-detail"> · {it.detail}</span> : null}</button>)}</div>
            </div>
          ))}
          <div className="cp-dep-reads-head iq-label">Reads</div>
          <p className="cp-dep-summary iqi-dim" data-testid="cp-dep-reads-summary">{report.readsSummary}</p>
          {report.reads.map((sec) => (
            <div key={sec.title} className="cp-dep-sec reads" data-testid="cp-dep-read-section" data-title={sec.title}>
              <div className="cp-dep-arrow"><span aria-hidden="true">↑</span> {sec.title}</div>
              <div className="cp-dep-items">{sec.items.map((it, k) => <button key={k} type="button" className="iq-chip cp-dep-chip" onClick={() => nav(it.key)} disabled={!it.key} data-testid="cp-dep-chip" data-key={it.key ?? ""} title={it.detail ?? it.label}>{it.label}{it.detail ? <span className="cp-dep-detail"> · {it.detail}</span> : null}</button>)}</div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/** one option of the selected question: a chip that selects it, previewing it on hover or focus */
function OptionChip({ def, questionId, o, on, onPick, nav, index }: { def: SurveyDefinition; questionId: string; o: Option; on: boolean; onPick(): void; nav(key: string): void; index?: DependencyIndex }) {
  const [peek, setPeek] = React.useState(false);
  const facts = React.useMemo(() => (peek ? optionFacts(def, questionId, o.code, index) : null), [peek, def, questionId, o.code, index]);
  return (
    <span className={`cp-optchip-wrap has-pop${on ? " on" : ""}`} onMouseEnter={() => setPeek(true)} onFocus={() => setPeek(true)}>
      <button type="button" className={`cp-optchip${on ? " on" : ""}`} aria-pressed={on} onClick={onPick} data-testid="cp-ctx-option" data-code={String(o.code)}>
        <span className="mono">{String(o.code)}</span> {plainText(o.label)}
      </button>
      <div className="cp-pop" role="tooltip">{facts ? <OptionPeek facts={facts} nav={nav} /> : <span className="iqi-dim">…</span>}</div>
    </span>
  );
}
