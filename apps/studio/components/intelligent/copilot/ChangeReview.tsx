"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { buildDependencyIndex, impactPhrase, impactReport, type ChangeItem, type ChangeTree, type DependencyIndex, type ImpactItem } from "@rescript/engine";
import {
  itemStatus, refusals, toggleItems, siblings, itemName, applyCount, questionHeader, optionTitle, optionFacts, impactKey,
  CARDS_OPEN_UP_TO, SEVERITY_WORDS, type ItemStatus, type OptionFacts,
} from "../../../lib/copilot/review";
import type { Copilot } from "./useCopilot";

/**
 * THE CHANGE REVIEW (Intelligent Mode upgrade, Phase 4 — the audit's R13
 * and R14): the open proposal as the engine's change tree, read the way a
 * researcher checks a questionnaire — not as a diff.
 *
 *   Impact: 5 dependent objects ▸        what else notices, worst first, each one navigable
 *   Survey · Blocks                      changes with no question of their own
 *   ☑ Q7 · Single choice · Do you own…   one card per question, its changes counted
 *       ☑ [Option label] Option 4 — United States · label
 *           old  United Sates            (struck through)
 *           new  United States
 *           Affected: 2 ▸   Proposed
 *
 * Every row has a tick. Unticking EXCLUDES the actions behind it — and with
 * them every other row those actions made, which the row says before you
 * untick ("Unticking also excludes …"); Apply then writes the included
 * actions only. The review is built from the whole proposal, so an excluded
 * row stays here to be ticked again; its status says what Apply will do.
 *
 * Nothing scrolls sideways: values wrap (overflow-wrap: anywhere) and clamp
 * to three lines with "more"; the technical details are a wrapping <pre>.
 * Option rows are focusable and preview the option — code, export value,
 * flags, its condition, the question's order and mask, what reads it —
 * on hover or keyboard focus, computed from the proposed survey.
 */
export function ChangeReview({ copilot, tree, present, onSelect, onSelectKey, onSelectOption }: {
  copilot: Copilot;
  /** `reviewTree` of the whole proposal — built once by the Changes tab, which also counts it for the Apply button */
  tree: ChangeTree | null;
  /** `presentIds` of the effective run — which unattributed rows still happen (null: nothing excluded) */
  present: ReadonlySet<string> | null;
  onSelect(questionId: string): void;
  onSelectKey(key: string): void;
  /** an option row's title was clicked: it becomes the panel's option selection (the Inspector's "Actions for …") */
  onSelectOption(questionId: string, code: string | number): void;
}) {
  const p = copilot.proposal, full = copilot.full, st = copilot.state;
  const excluded = React.useMemo(() => new Set(copilot.excluded), [copilot.excluded]);
  const refused = React.useMemo(() => (st ? refusals(st) : new Map<number, string>()), [st]);
  /* the dependency index of each side, built only when a preview first asks for it */
  const ix = React.useRef(new WeakMap<SurveyDefinition, DependencyIndex>());
  const indexOf = React.useCallback((d: SurveyDefinition) => { let x = ix.current.get(d); if (!x) { x = buildDependencyIndex(d); ix.current.set(d, x); } return x; }, []);
  /* which cards are open, kept per proposal — looking at the Inspector and coming back must not fold the review up again */
  const [openCards, setOpenState] = React.useState<Record<string, boolean>>(() => (p ? cardsOpen.get(p) ?? {} : {}));
  const setOpenCards = (fn: (m: Record<string, boolean>) => Record<string, boolean>) => setOpenState((m) => { const next = fn(m); if (p) cardsOpen.set(p, next); return next; });
  React.useEffect(() => { setOpenState(p ? cardsOpen.get(p) ?? {} : {}); }, [p]);
  const [impactOpen, setImpactOpen] = React.useState(false);
  if (!p || !full || !st || !tree) return null;

  const statusOf = (it: ChangeItem) => itemStatus(it, excluded, refused, present);
  const included = (it: ChangeItem) => statusOf(it).status !== "excluded";
  /* the impact of what will actually be applied — an unticked removal no longer breaks anything */
  const impact = excluded.size ? impactReport(tree.items.filter(included).flatMap((i) => i.affected)) : tree.impact;
  const nav = (key: string) => (key.startsWith("question:") ? onSelect(key.slice(9)) : onSelectKey(key));
  const setIncluded = (items: ChangeItem[], on: boolean) => copilot.setExcluded(toggleItems(copilot.excluded, items, on));
  const defs = [full.after, p.base];
  const rowProps = { tree, statusOf, setIncluded, nav, onSelect, onSelectOption, defs, indexOf };
  const defaultOpen = tree.byQuestion.length <= CARDS_OPEN_UP_TO;
  const count = applyCount(tree, copilot.excluded, present);

  return (
    <div className="cp-block cp-review-tree" data-testid="cp-modified" data-items={tree.items.length} data-included={count.included}>
      <div className="cp-review-tree-head">
        <span className="iq-label">The changes, one by one</span>
        <span className="iqi-dim" data-testid="cp-review-count">{count.included === count.total ? `${count.total} change${count.total === 1 ? "" : "s"}` : `${count.included} of ${count.total} changes ticked`}</span>
      </div>
      <ImpactHeader items={impact.items} count={impact.count} open={impactOpen} onToggle={() => setImpactOpen((v) => !v)} nav={nav} />
      {tree.survey.length > 0 && (
        <section className="cp-level" data-testid="cp-level-survey">
          <div className="iq-label">Survey · {tree.survey.length}</div>
          <ul className="cp-rows">{tree.survey.map((it) => <Row key={it.id} item={it} {...rowProps} />)}</ul>
        </section>
      )}
      {tree.blocks.length > 0 && (
        <section className="cp-level" data-testid="cp-level-blocks">
          <div className="iq-label">Blocks · {tree.blocks.length}</div>
          <ul className="cp-rows">{tree.blocks.map((it) => <Row key={it.id} item={it} {...rowProps} />)}</ul>
        </section>
      )}
      {tree.byQuestion.map((g) => {
        const h = questionHeader(g.question, defs);
        const open = openCards[g.question.id] ?? defaultOpen;
        const states = g.items.map(statusOf);
        const out = states.filter((x) => x.status === "excluded").length;
        const togglable = g.items.filter((it) => it.actionIndexes.length);
        const all = out === g.items.length, none = out === 0 && states.every((x) => x.status !== "partial");
        return (
          <section key={g.question.id} className={`cp-qcard${all ? " excluded" : ""}`} data-testid="cp-qcard" data-code={h.code} data-qid={g.question.id} data-open={open ? "true" : "false"}>
            <div className="cp-qcard-head">
              <TriCheck checked={none} mixed={!all && !none} disabled={!togglable.length || copilot.busy} onChange={(on) => setIncluded(togglable, on)} testid="cp-qcard-check" label={`Include the changes to ${h.code}`} />
              <button type="button" className="cp-qcard-toggle" aria-expanded={open} onClick={() => setOpenCards((m) => ({ ...m, [g.question.id]: !open }))} data-testid="cp-qcard-toggle" title={`${h.code} · ${h.type} · ${h.text}`}>
                <span className="cp-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
                <span className="cp-qcard-title" data-testid="cp-qcard-title"><b className="mono">{h.code}</b> · <span data-testid="cp-qcard-type">{h.type}</span> · <span data-testid="cp-qcard-text">{h.text}</span></span>
                <span className="cp-qcard-count" data-testid="cp-qcard-count">{g.items.length}{out ? ` · ${out} out` : ""}</span>
              </button>
              <button type="button" className="cp-ref cp-qcard-go" onClick={() => onSelect(g.question.id)} title={`Select ${h.code}`} data-testid="cp-qcard-select">↗</button>
            </div>
            {open && <ul className="cp-rows">{g.items.map((it) => <Row key={it.id} item={it} {...rowProps} />)}</ul>}
          </section>
        );
      })}
    </div>
  );
}

/** the open cards of each proposal, for as long as the proposal object lives */
const cardsOpen = new WeakMap<object, Record<string, boolean>>();

/* ------------------------------------------------------------ the impact header */

function ImpactHeader({ items, count, open, onToggle, nav }: { items: ImpactItem[]; count: number; open: boolean; onToggle(): void; nav(key: string): void }) {
  const by = { breaks: items.filter((i) => i.severity === "breaks").length, changes: items.filter((i) => i.severity === "changes").length, informs: items.filter((i) => i.severity === "informs").length };
  return (
    <div className="cp-impact" data-testid="cp-impact" data-count={count}>
      <button type="button" className="cp-impact-head" aria-expanded={open} onClick={onToggle} disabled={!count} data-testid="cp-impact-toggle">
        {count ? <span className="cp-caret" aria-hidden="true">{open ? "▾" : "▸"}</span> : null}
        <b>Impact:</b> <span data-testid="cp-impact-count">{count ? `${count} dependent object${count === 1 ? "" : "s"}` : "nothing else depends on what changes"}</span>
        {(["breaks", "changes", "informs"] as const).filter((k) => by[k]).map((k) => <span key={k} className={`cp-sevchip v-${k}`}>{by[k]} {SEVERITY_WORDS[k]}</span>)}
      </button>
      {open && count > 0 && (
        <ul className="cp-impact-list" data-testid="cp-impact-list">
          {items.map((i, k) => (
            <li key={k} data-severity={i.severity}>
              <span className={`cp-sevchip v-${i.severity}`}>{SEVERITY_WORDS[i.severity]}</span>{" "}
              <button type="button" className="cp-ref" onClick={() => nav(impactKey(i.object))} data-testid="cp-impact-ref" data-key={impactKey(i.object)}>{impactPhrase(i)}</button>
              <span className="iqi-dim"> — {i.text}{i.indirect ? " (indirect)" : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ one change */

const STATUS_WORDS: Record<ItemStatus, string> = { proposed: "Proposed", excluded: "Excluded", partial: "Partly excluded", refused: "Refused" };

function Row({ item, tree, statusOf, setIncluded, nav, onSelect, onSelectOption, defs, indexOf }: {
  item: ChangeItem;
  tree: { items: ChangeItem[] };
  statusOf(it: ChangeItem): { status: ItemStatus; reason?: string };
  setIncluded(items: ChangeItem[], on: boolean): void;
  nav(key: string): void;
  onSelect(questionId: string): void;
  onSelectOption(questionId: string, code: string | number): void;
  defs: SurveyDefinition[];
  indexOf(d: SurveyDefinition): DependencyIndex;
}) {
  const { status, reason } = statusOf(item);
  const sibs = siblings(tree, item);
  const on = status !== "excluded";
  // an option of a choice question previews itself; rows and columns of a grid have no option to preview
  const isOption = !!item.option && !!item.question && /^Option/.test(item.category);
  const axis = item.category === "Rows" ? "Row" : item.category === "Columns" ? "Column" : "Option";
  /* the preview is computed on first hover or focus, from the side the option exists on */
  const [peek, setPeek] = React.useState(false);
  const facts = React.useMemo<OptionFacts | null>(() => {
    if (!peek || !isOption || !item.question || !item.option) return null;
    const def = item.kind === "removed" ? defs[1] : defs[0];
    return optionFacts(def, item.question.id, item.option.code, indexOf(def)) ?? optionFacts(defs[1], item.question.id, item.option.code, indexOf(defs[1]));
  }, [peek, isOption, item, defs, indexOf]);
  return (
    <li
      className={`cp-row s-${status}${isOption ? " has-pop" : ""}`} data-testid="cp-row" data-item={item.id} data-category={item.category} data-kind={item.kind} data-status={status}
      data-code={item.question?.code ?? ""} data-option={item.option ? String(item.option.code) : ""}
      tabIndex={isOption ? 0 : undefined} onMouseEnter={isOption ? () => setPeek(true) : undefined} onFocus={isOption ? () => setPeek(true) : undefined}
      aria-label={isOption ? `${item.category}: ${optionTitle(item.option!, axis)}` : undefined}
    >
      <TriCheck checked={on && status !== "partial"} mixed={status === "partial"} disabled={!item.actionIndexes.length} onChange={(v) => setIncluded([item], v)} testid="cp-row-check"
        label={item.actionIndexes.length ? `Include: ${itemName(item)}` : "Made together with the rest of the proposal — it cannot be left out on its own"} />
      <div className="cp-row-body">
        <div className="cp-row-head">
          <span className={`cp-cat k-${item.kind}`} data-testid="cp-row-cat">{item.category}</span>
          {item.option && item.question
            ? <button type="button" className="cp-row-opt" data-testid="cp-row-option" onClick={() => { onSelect(item.question!.id); if (isOption) onSelectOption(item.question!.id, item.option!.code); }}>{optionTitle(item.option, axis)}</button>
            : null}
          <span className="cp-row-field" data-testid="cp-row-field">{item.field}</span>
          <span className={`cp-status s-${status}`} data-testid="cp-row-status">{STATUS_WORDS[status]}</span>
        </div>
        {item.from ? <Val kind="from" text={item.from} /> : null}
        {item.to ? <Val kind="to" text={item.to} /> : null}
        {item.detail ? <p className="cp-row-detail iqi-dim">{item.detail}</p> : null}
        {status === "refused" && reason && <p className="cp-row-refused" data-testid="cp-row-reason">{reason}</p>}
        {status === "excluded" && reason && <p className="cp-row-detail iqi-dim" data-testid="cp-row-reason">{reason}</p>}
        {item.destructive && <p className="cp-row-danger" data-testid="cp-row-destructive">{item.destructive}</p>}
        {sibs.length > 0 && (
          <p className="cp-row-also iqi-dim" data-testid="cp-row-also">
            {on ? "Unticking also excludes" : "Excluded with it"}: {sibs.slice(0, 3).map(itemName).join(", ")}{sibs.length > 3 ? ` and ${sibs.length - 3} more` : ""}
          </p>
        )}
        {item.affected.length > 0 && (
          <details className="cp-affected" data-testid="cp-row-affected">
            <summary>Affected: {item.affected.length}</summary>
            <ul>{item.affected.map((a, k) => (
              <li key={k}><span className={`cp-sevchip v-${a.severity}`}>{SEVERITY_WORDS[a.severity]}</span> <button type="button" className="cp-ref" onClick={() => nav(impactKey(a.object))} data-testid="cp-affected-ref" data-key={impactKey(a.object)}>{impactPhrase(a)}</button><span className="iqi-dim"> — {a.text}</span></li>
            ))}</ul>
          </details>
        )}
        {item.technical && (
          <details className="cp-tech" data-testid="cp-row-tech">
            <summary>Technical details</summary>
            <pre className="mono">{JSON.stringify(item.technical, null, 2)}</pre>
          </details>
        )}
      </div>
      {isOption && <div className="cp-pop" role="tooltip">{facts ? <OptionPeek facts={facts} nav={nav} /> : <span className="iqi-dim">…</span>}</div>}
    </li>
  );
}

/** an old or new value: stacked, wrapping anywhere, clamped to three lines with "more" when it is longer */
function Val({ kind, text }: { kind: "from" | "to"; text: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [all, setAll] = React.useState(false);
  const [long, setLong] = React.useState(false);
  React.useLayoutEffect(() => { const el = ref.current; if (el && !all) setLong(el.scrollHeight > el.clientHeight + 1); }, [text, all]);
  return (
    <div className={`cp-val ${kind}`} data-testid={`cp-row-${kind}`}>
      <span className="cp-val-k">{kind === "from" ? "old" : "new"}</span>
      <span ref={ref} className={`cp-val-t${all ? " all" : ""}`} data-testid="cp-val">{text}</span>
      {(long || all) && <button type="button" className="cp-more" onClick={() => setAll((v) => !v)} data-testid="cp-val-more">{all ? "less" : "more"}</button>}
    </div>
  );
}

/** a checkbox that can also say "some" — the card of a question half of whose changes are ticked */
export function TriCheck({ checked, mixed, disabled, onChange, testid, label }: { checked: boolean; mixed?: boolean; disabled?: boolean; onChange(on: boolean): void; testid: string; label: string }) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = !!mixed; }, [mixed]);
  return <input ref={ref} type="checkbox" className="cp-check" checked={checked} disabled={disabled} aria-label={label} title={label} data-testid={testid} onChange={(e) => onChange(mixed ? true : e.target.checked)} onClick={(e) => e.stopPropagation()} />;
}

/**
 * WHAT ONE OPTION IS, in a popover: its code and export value, its flags,
 * when it is shown, how the question orders and masks its options, and what
 * in the survey reads it — the dependents a removal would reach.
 */
export function OptionPeek({ facts, nav }: { facts: OptionFacts; nav(key: string): void }) {
  return (
    <div className="cp-peek" data-testid="cp-pop" data-code={facts.code}>
      <div className="cp-peek-head"><span className="mono">{facts.code}</span> {facts.label}</div>
      <dl className="cp-peek-dl">
        <dt>Code</dt><dd data-testid="cp-pop-code">{facts.code}</dd>
        <dt>Export value</dt><dd>{facts.value ?? facts.code}</dd>
        <dt>Flags</dt><dd data-testid="cp-pop-flags">{facts.flags.length ? facts.flags.join(", ") : "none"}</dd>
        <dt>Shown</dt><dd>{facts.condition ? `only when ${facts.condition}` : "always"}</dd>
        <dt>Order</dt><dd>{facts.randomization ?? "fixed order"}</dd>
        {facts.mask && <><dt>Mask</dt><dd>{facts.mask}</dd></>}
        <dt>Read by</dt>
        <dd data-testid="cp-pop-deps">{facts.dependents.length
          ? <ul>{facts.dependents.map((d, k) => <li key={k}><button type="button" className="cp-ref" onMouseDown={(e) => e.preventDefault()} onClick={() => nav(d.key)} title={d.text}>{d.phrase}</button></li>)}</ul>
          : "nothing in the survey reads this option"}</dd>
      </dl>
    </div>
  );
}
