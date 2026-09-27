"use client";
import React from "react";
import type { ObjectKey } from "@rescript/engine";
import { Icon, type IconName } from "../ui/Icon";
import { TAG_LABEL, type StructureEntry, type StructureQuestion, type StructureBlock, type LogicChip, type ObjectTag } from "../../lib/architect/structure";

/**
 * THE STRUCTURE OUTLINE — the survey the way a programmer reads it.
 *
 *   ┌ BLOCK 2 · About you ──────────────────── IF Q1 = Yes ─ 4 questions ┐
 *   │  Page 1 of 2                                                       │
 *   │   Q3  AGE      Numeric      How old are you?          [VAL] [DL]   │
 *   │   Q4  COUNTRY  Dropdown     Which country…                         │
 *   │  ─────────────────── PAGE BREAK ───────────────── [remove]         │
 *   │  Page 2 of 2                                                       │
 *   │   Q5  REGION   Dropdown     Which region…              [DL]        │
 *   │   H1  AGE_GRP  H · Hidden variable                     [CALC]      │
 *   └────────────────────────────────────────────────────────────────────┘
 *   ◆ BRANCH  Consumer / Business  — 2 paths + otherwise
 *      IF Q13 = Consumer  ▸  BLOCK 3 …
 *
 * Blocks are frames, pages are bands inside them, the page break between
 * two pages is drawn as the boundary it is, with the control to remove it;
 * between two questions on one page a hover line offers "+ page break
 * here". Every question row carries its object badge (hidden variable,
 * conjoint, MaxDiff…) and its LOGIC CHIPS — click one and the inspector
 * opens on that section, or selects the rule / calculation / quota that
 * holds it (§8: inspect logic without leaving the architecture).
 *
 * Nothing here edits a question: rows select (the shared selection), chips
 * reveal, breaks split and join pages through the engine.
 */

export interface StructureActions {
  onSelect(key: ObjectKey): void;
  /** open the inspector on a panel section of the selected question */
  onReveal(key: ObjectKey, section: string): void;
  onAddBreak?(questionId: string): void;
  onRemoveBreak?(questionId: string): void;
  /** add a question after this one (the command registry's question.add reads the selection) */
  onAddQuestion?(afterKey: ObjectKey): void;
}

const ELEMENT_ICON: Partial<Record<string, IconName>> = {
  branch: "flow", loop: "flow", randomizer: "flow", embedded_data: "variables", quota_check: "quotas", redirect: "share", end: "check",
};
const ELEMENT_LABEL: Record<string, string> = {
  branch: "Branch", loop: "Loop", randomizer: "Randomizer", embedded_data: "Embedded data", quota_check: "Quota check", redirect: "Redirect", end: "End", section: "Group",
};

export function StructureOutline({ entries, unplaced, primary, readOnly, actions, dim }: {
  entries: StructureEntry[];
  unplaced?: StructureQuestion[];
  primary: ObjectKey | null;
  readOnly: boolean;
  actions: StructureActions;
  /** keys outside the focus neighbourhood, when focus is on */
  dim?: ReadonlySet<string> | null;
}) {
  return (
    <div className="st" data-testid="structure-outline">
      {entries.map((e) => <Entry key={e.key} e={e} primary={primary} readOnly={readOnly} actions={actions} dim={dim} />)}
      {unplaced && unplaced.length > 0 && (
        <section className="st-block st-unplaced" data-testid="structure-unplaced">
          <header className="st-block-head"><span className="st-kicker">Not on any page</span><span className="st-meta">{unplaced.length} question{unplaced.length === 1 ? "" : "s"} respondents never see</span></header>
          <div className="st-page-body">{unplaced.map((q) => <QuestionRow key={q.id} q={q} primary={primary} readOnly actions={actions} dim={dim} />)}</div>
        </section>
      )}
      {entries.length === 0 && !unplaced?.length && <p className="muted st-empty">The survey has no structure yet — add a block to start.</p>}
    </div>
  );
}

function Entry({ e, primary, readOnly, actions, dim }: { e: StructureEntry; primary: ObjectKey | null; readOnly: boolean; actions: StructureActions; dim?: ReadonlySet<string> | null }) {
  if (e.kind === "block") return <Block b={e} primary={primary} readOnly={readOnly} actions={actions} dim={dim} />;
  const dimmed = dim ? !dim.has(e.key) : false;
  if (e.kind === "group") {
    return (
      <section className={`st-group${primary === e.key ? " primary" : ""}${dimmed ? " dim" : ""}`} data-testid="structure-group" data-key={e.key}>
        <header className="st-group-head" onClick={() => actions.onSelect(e.key)}>
          <Icon name="layers" size={13} /><span className="st-kicker">Group</span><span className="st-title">{e.label}</span>
          {e.condition && <span className="st-cond" title={`Shown when ${e.condition}`}><span className="st-if">IF</span> {e.condition}</span>}
        </header>
        <div className="st-group-body">{e.entries.map((c) => <Entry key={c.key} e={c} primary={primary} readOnly={readOnly} actions={actions} dim={dim} />)}</div>
      </section>
    );
  }
  return (
    <section className={`st-el st-el-${e.type}${primary === e.key ? " primary" : ""}${dimmed ? " dim" : ""}`} data-testid="structure-element" data-key={e.key} data-type={e.type}>
      <header className="st-el-head" onClick={() => actions.onSelect(e.key)} role="button" tabIndex={0} onKeyDown={(k) => { if (k.key === "Enter") actions.onSelect(e.key); }}>
        <Icon name={ELEMENT_ICON[e.type] ?? "flow"} size={13} />
        <span className="st-kicker">{ELEMENT_LABEL[e.type] ?? e.type}</span>
        <span className="st-title">{e.label}</span>
        {e.detail && <span className="st-meta">{e.detail}</span>}
      </header>
      {e.children.map((arm, i) => (
        <div className="st-arm" key={i} data-testid="structure-arm">
          <div className="st-arm-head">
            {arm.condition ? <><span className="st-if">IF</span> <span className="st-arm-cond">{arm.condition}</span> <span className="st-arm-then">→ {arm.label}</span></> : <span className="st-arm-then">{arm.label}</span>}
          </div>
          <div className="st-arm-body">
            {arm.entries.length ? arm.entries.map((c) => <Entry key={c.key} e={c} primary={primary} readOnly={readOnly} actions={actions} dim={dim} />) : <p className="muted st-empty">Nothing here — the respondent continues past the {ELEMENT_LABEL[e.type]?.toLowerCase() ?? e.type}.</p>}
          </div>
        </div>
      ))}
    </section>
  );
}

function Block({ b, primary, readOnly, actions, dim }: { b: StructureBlock; primary: ObjectKey | null; readOnly: boolean; actions: StructureActions; dim?: ReadonlySet<string> | null }) {
  const dimmed = dim ? !dim.has(b.key) : false;
  return (
    <section className={`st-block${primary === b.key ? " primary" : ""}${dimmed ? " dim" : ""}`} data-testid="structure-block" data-key={b.key}>
      <header className="st-block-head" onClick={() => actions.onSelect(b.key)} role="button" tabIndex={0} onKeyDown={(k) => { if (k.key === "Enter") actions.onSelect(b.key); }}>
        <Icon name="layers" size={13} />
        <span className="st-kicker">{b.label}</span>
        {b.title && <span className="st-title">{b.title}</span>}
        {b.condition && <span className="st-cond" title={`Shown when ${b.condition}`}><span className="st-if">IF</span> {b.condition}</span>}
        <span className="grow" />
        <span className="st-meta">{b.pages.length > 1 ? `${b.pages.length} pages · ` : ""}{b.questionCount} question{b.questionCount === 1 ? "" : "s"}</span>
      </header>
      {b.pages.map((p, pi) => (
        <React.Fragment key={p.id}>
          {pi > 0 && (
            <div className="st-break" data-testid="structure-page-break" data-after={b.pages[pi - 1].questions.slice(-1)[0]?.id ?? ""}>
              <span className="st-break-line" /><span className="st-break-label">Page break</span><span className="st-break-line" />
              {!readOnly && actions.onRemoveBreak && b.pages[pi - 1].questions.length > 0 && (
                <button type="button" className="st-break-btn" data-testid="structure-break-remove" title="Remove this page break — the two pages become one" onClick={(ev) => { ev.stopPropagation(); actions.onRemoveBreak!(b.pages[pi - 1].questions.slice(-1)[0].id); }}>remove</button>
              )}
            </div>
          )}
          <div className={`st-page${primary === p.key ? " primary" : ""}`} data-testid="structure-page" data-key={p.key} data-page={p.n}>
            {b.pages.length > 1 && (
              <div className="st-page-head" onClick={() => actions.onSelect(p.key)}>
                <span className="st-page-n">Page {p.n} of {b.pages.length}</span>{p.title && <span className="st-page-title">{p.title}</span>}
              </div>
            )}
            <div className="st-page-body">
              {p.questions.map((q, qi) => (
                <React.Fragment key={q.id}>
                  <QuestionRow q={q} primary={primary} readOnly={readOnly} actions={actions} dim={dim} />
                  {qi < p.questions.length - 1 && !readOnly && actions.onAddBreak && (
                    <div className="st-gap" data-testid="structure-gap" data-after={q.id}>
                      <button type="button" className="st-gap-btn" data-testid="structure-break-add" title={`Start a new page after ${q.code}`} onClick={() => actions.onAddBreak!(q.id)}>+ page break here</button>
                    </div>
                  )}
                </React.Fragment>
              ))}
              {p.questions.length === 0 && <p className="muted st-empty">Empty page.</p>}
            </div>
          </div>
        </React.Fragment>
      ))}
    </section>
  );
}

function QuestionRow({ q, primary, actions, dim }: { q: StructureQuestion; primary: ObjectKey | null; readOnly?: boolean; actions: StructureActions; dim?: ReadonlySet<string> | null }) {
  const dimmed = dim ? !dim.has(q.key) : false;
  return (
    <div
      className={`st-q${primary === q.key ? " primary" : ""}${dimmed ? " dim" : ""}`} data-testid="structure-question" data-key={q.key} data-qid={q.id}
      role="button" tabIndex={0}
      onClick={() => actions.onSelect(q.key)}
      onKeyDown={(e) => { if (e.key === "Enter") actions.onSelect(q.key); }}
    >
      <span className="mono st-code">{q.code}</span>
      <span className="st-type">{q.tags.length ? q.tags.map((t) => <Tag key={t} t={t} />) : q.typeLabel}</span>
      <span className="st-text" title={q.text}>{q.text}</span>
      <span className="st-chips">
        {q.required && <span className="st-chip req" title="Required">REQ</span>}
        {q.chips.map((c, i) => <Chip key={i} c={c} q={q} actions={actions} />)}
      </span>
      <span className="mono st-var" title="Variable">{q.variableName}</span>
    </div>
  );
}

function Tag({ t }: { t: ObjectTag }) {
  return <span className={`st-tag st-tag-${t}`} data-testid="structure-tag" data-tag={t} title={TAG_LABEL[t]}>{t === "hidden" ? "H" : t === "conjoint" ? "Conjoint" : t === "maxdiff" ? "MaxDiff" : t === "calculated" ? "Calc" : t === "screening" ? "Screen" : TAG_LABEL[t]}</span>;
}

function Chip({ c, q, actions }: { c: LogicChip; q: StructureQuestion; actions: StructureActions }) {
  return (
    <button
      type="button" className={`st-chip st-chip-${c.kind}`} data-testid="structure-chip" data-chip={c.kind} title={c.detail}
      onClick={(e) => { e.stopPropagation(); if (c.key) actions.onSelect(c.key); else if (c.section) actions.onReveal(q.key, c.section); else actions.onSelect(q.key); }}
    >{c.label}</button>
  );
}
