"use client";
import React from "react";
import type {
  Question, SetExpr, SetOperator, SetSelection, MaskAction, PunchRule,
} from "@rescript/schema";
import { SET_OPERATOR_LABEL, SET_SELECTION_LABEL } from "@rescript/schema";
import {
  parseSetExpression, formatSetExpression, setExpressionSummary,
  setExprToChain, appendSet, replaceSetAt, removeSetAt, setChainOperator,
  bracketSetPair, validateSetExpr, pipelineToSetExpr, isOptionLevelPunch,
  type SetExprError,
  stripHtmlText,
} from "@rescript/engine";
import { useStudio, uid } from "./store";
import { OptionalCondition } from "./ConditionBuilder";
import { AutoPunchRows } from "./AutoPunchEditor";

/**
 * Option-level rules (a literal code set, no cell target, no priority) are
 * edited by AutoPunchRows instead — see `isOptionLevelPunch` for why those
 * two extra fields force a rule to stay here instead.
 */
const isOptionLevel = isOptionLevelPunch;

/**
 * Visual masking: which options a question shows, computed from other
 * questions' answers.
 *
 * Two views over one tree, exactly as the logic builder and the logic
 * expression editor are two views over one condition:
 *
 *   Visual      one row per set, an operator in each gap, brackets for nesting
 *   Expression  `(Q5.Selected UNION Q6.Selected) DIFFERENCE Q7.Selected`
 *
 * Nothing stores an expression — the text is printed from the tree and parsed
 * back into it, so the two panes cannot disagree, and the runtime evaluates
 * the same tree either way.
 */

const OPERATORS: SetOperator[] = ["union", "intersection", "difference"];
const SELECTIONS: SetSelection[] = ["selected", "unselected", "all", "displayed"];

const OPERATOR_HINT: Record<SetOperator, string> = {
  union: "in either",
  intersection: "in both",
  difference: "in the first but not the second",
};

/* ------------------------------------------------------- one set, one row */

/** A single operand: a question and which slice of it. */
function SetRow({ node, sources, listFills, onChange, onRemove, onBracket, canBracket }: {
  node: SetExpr;
  sources: { id: string; code: string; label: string }[];
  listFills: { id: string; name: string }[];
  onChange(next: SetExpr): void;
  onRemove(): void;
  onBracket?(): void;
  canBracket?: boolean;
}) {
  if (node.kind === "op") {
    // a bracket: render its own chain, indented
    return (
      <div className="mb-bracket" data-testid="mask-bracket">
        <div className="mb-bracket-head">
          <span className="mb-badge">GROUP</span>
          <span className="muted" style={{ fontSize: 12.5 }}>evaluated first</span>
          <span className="grow" />
          <button className="btn small danger" title="Remove this bracket and everything in it"
            onClick={onRemove}>×</button>
        </div>
        <SetChainEditor expr={node} sources={sources} listFills={listFills} onChange={onChange} nested />
      </div>
    );
  }

  if (node.kind === "complement") {
    return (
      <div className="mb-row" data-testid="mask-row">
        <span className="mb-not">NOT</span>
        <div className="grow">
          <SetRow node={node.of} sources={sources} listFills={listFills}
            onChange={(of) => onChange({ kind: "complement", of })}
            onRemove={onRemove} />
        </div>
      </div>
    );
  }

  if (node.kind === "codes") {
    return (
      <div className="mb-row" data-testid="mask-row">
        <span className="mb-kind">Codes</span>
        <input className="input mono grow" data-testid="mask-codes"
          value={node.codes.join(", ")}
          placeholder="a, b, c"
          onChange={(e) => onChange({
            kind: "codes",
            codes: e.target.value.split(",").map((x) => x.trim()).filter(Boolean),
          })} />
        <button className="btn small danger" onClick={onRemove}>×</button>
      </div>
    );
  }

  if (node.kind === "listFill") {
    /*
     * A List Fill's resolved output as a masking source (§23). Authored
     * today via the expression pane (`LISTFILL(name)`, parsed by
     * `parseSetExpression`) — this Visual-mode row exists so a tree
     * containing one can still be read, re-pointed at a different List
     * Fill, and removed here, the same as any other leaf.
     */
    return (
      <div className="mb-row" data-testid="mask-row">
        <span className="mb-kind">List Fill</span>
        <select className="select mb-q grow" data-testid="mask-listfill"
          value={listFills.some((lf) => lf.id === node.listFillId) ? node.listFillId : ""}
          onChange={(e) => onChange({ kind: "listFill", listFillId: e.target.value })}>
          {!listFills.some((lf) => lf.id === node.listFillId) && (
            <option value="">— unknown List Fill —</option>
          )}
          {listFills.map((lf) => (
            <option key={lf.id} value={lf.id}>{lf.name}</option>
          ))}
        </select>
        <button className="btn small danger" onClick={onRemove}>×</button>
      </div>
    );
  }

  if (node.kind === "loopItem") {
    /*
     * The current loop item as a PAYLOAD (§24) — "punch Q20 with the loop's
     * current product", not a trigger. Leave the reference blank for the
     * item's own code (`CURRENT_ITEM_CODE`); name one of the loop's own
     * reference columns (e.g. `Product_ID`) to punch that column's value
     * instead (`CURRENT_ITEM.Product_ID`). Meaningless outside a loop — the
     * validator (`validateSetExpr`) flags that case rather than resolving to
     * nothing silently.
     */
    return (
      <div className="mb-row" data-testid="mask-row">
        <span className="mb-kind">Loop Item</span>
        <input className="input mono grow" data-testid="mask-loopitem-ref"
          placeholder="leave blank for the item's own code, or name a reference column"
          value={node.ref ?? ""}
          onChange={(e) => onChange({ kind: "loopItem", ref: e.target.value.trim() || null })} />
        <button className="btn small danger" onClick={onRemove}>×</button>
      </div>
    );
  }

  if (node.kind === "expr") {
    /*
     * A calculated value as a payload (§8, §17) — the same expression
     * language a Calculation or a condition's Expression source already
     * accepts (`SUM(...)`, `Q1 + Q2`, …), evaluated through the identical
     * resolver so a function calc already has works as a punch value with no
     * separate syntax to learn.
     */
    return (
      <div className="mb-row" data-testid="mask-row">
        <span className="mb-kind">Calculated Value</span>
        <input className="input mono grow" data-testid="mask-expr"
          placeholder="e.g. SUM(Q1, Q2)"
          value={node.expression}
          onChange={(e) => onChange({ kind: "expr", expression: e.target.value })} />
        <button className="btn small danger" onClick={onRemove}>×</button>
      </div>
    );
  }

  return (
    <div className="mb-row" data-testid="mask-row">
      <select className="select mb-q" data-testid="mask-source"
        value={node.questionId}
        onChange={(e) => onChange({ ...node, questionId: e.target.value })}>
        {sources.length === 0 && <option value="">— no other question —</option>}
        {sources.map((s) => (
          <option key={s.id} value={s.id}>{s.code} — {s.label}</option>
        ))}
      </select>
      <select className="select mb-sel" data-testid="mask-selection"
        value={node.selection}
        onChange={(e) => onChange({ ...node, selection: e.target.value as SetSelection })}>
        {SELECTIONS.map((s) => (
          <option key={s} value={s}>{SET_SELECTION_LABEL[s]}</option>
        ))}
      </select>
      {canBracket && (
        <button className="btn small" data-testid="mask-bracket-pair"
          title="Bracket this set with the next one, so they are evaluated together"
          onClick={onBracket}>( … )</button>
      )}
      <button className="btn small danger" title="Remove this set" onClick={onRemove}>×</button>
    </div>
  );
}

/* -------------------------------------------------- a chain of sets + gaps */

/**
 * The visual builder proper: rows with an operator between each pair.
 *
 * Each gap edits its OWN node in the tree, so changing one operator cannot
 * move another — the same property the logic builder's connectors have.
 */
function SetChainEditor({ expr, sources, listFills, onChange, nested }: {
  expr: SetExpr | null;
  sources: { id: string; code: string; label: string }[];
  listFills: { id: string; name: string }[];
  onChange(next: SetExpr | null): void;
  nested?: boolean;
}) {
  const chain = expr ? setExprToChain(expr) : { items: [], ops: [] as SetOperator[] };

  const addSet = () => {
    const first = sources[0];
    if (!first) return;
    const item: SetExpr = { kind: "ref", questionId: first.id, selection: "selected" };
    onChange(appendSet(expr, item, "union"));
  };

  if (chain.items.length === 0) {
    return (
      <div className="mb-empty" data-testid="mask-empty">
        <span className="muted">No sets yet — the question shows its own options.</span>
        <button className="btn small primary" data-testid="mask-add-set"
          disabled={sources.length === 0} onClick={addSet}>+ Add set</button>
      </div>
    );
  }

  return (
    <div className={`mb-chain${nested ? " nested" : ""}`}>
      {chain.items.map((item, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <div className="mb-join">
              <select className="select mb-op" data-testid="mask-operator"
                value={chain.ops[i - 1]}
                onChange={(e) => onChange(
                  setChainOperator(expr!, i - 1, e.target.value as SetOperator),
                )}>
                {OPERATORS.map((op) => (
                  <option key={op} value={op}>{SET_OPERATOR_LABEL[op]}</option>
                ))}
              </select>
              <span className="muted mb-op-hint">{OPERATOR_HINT[chain.ops[i - 1]]}</span>
            </div>
          )}
          <SetRow
            node={item}
            sources={sources}
            listFills={listFills}
            canBracket={i + 1 < chain.items.length}
            onBracket={() => onChange(bracketSetPair(expr!, i))}
            onChange={(next) => onChange(replaceSetAt(expr!, i, next))}
            onRemove={() => onChange(removeSetAt(expr!, i))}
          />
        </React.Fragment>
      ))}
      <div className="row" style={{ marginTop: 4 }}>
        <button className="btn small" data-testid="mask-add-set" onClick={addSet}>+ Add set</button>
        <button className="btn small" title="Everything this question has that is NOT in the set above"
          data-testid="mask-add-not"
          onClick={() => onChange(appendSet(expr, { kind: "complement", of: chain.items[0] }, "difference"))}>
          + NOT …
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------- expression pane */

function SetExpressionPane({ expr, onChange }: {
  expr: SetExpr | null; onChange(next: SetExpr | null): void;
}) {
  const s = useStudio();
  const printed = React.useMemo(() => formatSetExpression(s.def, expr), [s.def, expr]);
  const [text, setText] = React.useState(printed);
  const [dirty, setDirty] = React.useState(false);
  const area = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => { if (!dirty) setText(printed); }, [printed, dirty]);

  const result = React.useMemo(() => parseSetExpression(s.def, text), [s.def, text]);

  /** Only a clean parse reaches the survey. */
  const commit = (next: string) => {
    const r = parseSetExpression(s.def, next);
    if (r.errors.length > 0) return;
    s.labelNextEdit?.("edit mask expression");
    onChange(r.expr ?? null);
    setDirty(false);
  };

  const insert = (token: string) => {
    const el = area.current;
    const at = el?.selectionStart ?? text.length;
    const before = text.slice(0, at);
    const after = text.slice(el?.selectionEnd ?? at);
    const pad = before.length > 0 && !/[\s(]$/.test(before) ? " " : "";
    const next = `${before}${pad}${token}${after.length && !/^[\s)]/.test(after) ? " " : ""}${after}`;
    setText(next);
    setDirty(true);
    commit(next);
    requestAnimationFrame(() => el?.focus());
  };

  return (
    <div className="mb-expr">
      <div className="xe-chips">
        {OPERATORS.map((op) => (
          <button key={op} className="xe-chip" data-testid={`mask-chip-${op}`}
            onClick={() => insert(SET_OPERATOR_LABEL[op])}>{SET_OPERATOR_LABEL[op]}</button>
        ))}
        <button className="xe-chip" onClick={() => insert("NOT")}>NOT</button>
        <button className="xe-chip" onClick={() => insert("(")}>(</button>
        <button className="xe-chip" onClick={() => insert(")")}>)</button>
      </div>
      <textarea ref={area} className="ta code xe-input" data-testid="mask-expression"
        rows={3} spellCheck={false} value={text}
        placeholder="(Q5.Selected UNION Q6.Selected) DIFFERENCE Q7.Selected"
        onChange={(e) => { setText(e.target.value); setDirty(true); commit(e.target.value); }}
        onBlur={() => commit(text)}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
        onDrop={(e) => {
          const token = e.dataTransfer.getData("text/plain");
          if (!token) return;
          e.preventDefault();
          insert(token);
        }} />
      {result.errors.map((err: SetExprError, i) => (
        <div key={i} className="xe-error" data-testid="mask-error">
          ⚠ {err.message}{err.position != null ? ` (at character ${err.position + 1})` : ""}
        </div>
      ))}
      {result.errors.length === 0 && result.warnings.map((w, i) => (
        <div key={i} className="xe-warn" data-testid="mask-warning">⚠ {w.message}</div>
      ))}
      {result.errors.length > 0 && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          The saved mask is unchanged until this reads correctly.
        </div>
      )}
    </div>
  );
}

/** The source list, draggable into the expression pane (reqs §11–§12). */
function SourcePicker({ sources, onInsert }: {
  sources: { id: string; code: string; label: string }[];
  onInsert(token: string): void;
}) {
  return (
    <div className="mb-picker">
      <span className="flabel" style={{ margin: "0 0 3px" }}>Insert a set</span>
      <div className="mb-picker-list">
        {sources.map((src) =>
          SELECTIONS.slice(0, 3).map((sel) => {
            const token = `${src.code}.${sel === "all" ? "Options" : SET_SELECTION_LABEL[sel]}`;
            return (
              <button key={`${src.id}.${sel}`} className="mb-chip" data-testid="mask-source-chip"
                data-token={token}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/plain", token)}
                onClick={() => onInsert(token)}
                title={`Insert ${token}`}>
                <span className="mono">{src.code}</span>
                <span className="muted">{SET_SELECTION_LABEL[sel]}</span>
              </button>
            );
          }))}
        {sources.length === 0 && (
          <span className="muted" style={{ fontSize: 12.5 }}>
            No other questions to draw options from yet.
          </span>
        )}
      </div>
    </div>
  );
}

/* ============================================================ the panel */

/** Which field on `Question` this instance of the builder edits. */
export type MaskField = "mask" | "rowMask" | "columnMask";

const FIELD_NOUN: Record<MaskField, string> = {
  mask: "option",
  rowMask: "row",
  columnMask: "column",
};

/**
 * The real, deterministic order this survey evaluates a question in (req
 * §32) — printed here rather than a separate, simplified precedence list,
 * so it can never disagree with `carryforward.ts`, the code that actually
 * runs it.
 */
const EVALUATION_ORDER: Record<MaskField, string> = {
  mask: "always-hidden → eligibility (always-show/hide, show/hide-when) → "
    + "named display rules → previous-answer list logic → mask (this) → "
    + "auto-punch show/hide → list operations (union/intersect/exclude/…) → "
    + "prioritize → sort → group/randomize → piping",
  rowMask: "eligibility (always-show/hide, show/hide-when) → named display "
    + "rules → mask (this) → prioritize → group/randomize → piping",
  columnMask: "visible-if → named display rules → eligibility (always-show/"
    + "hide, show/hide-when) → mask (this) → group/randomize",
};

export function MaskingBuilder({ q, patch, field = "mask" }: {
  q: Question; patch(p: Partial<Question>): void; field?: MaskField;
}) {
  const s = useStudio();
  const [mode, setMode] = React.useState<"visual" | "expression">("visual");
  const noun = FIELD_NOUN[field];

  /** Any other question with options to draw from. */
  const sources = s.def.questions
    .filter((x) => x.id !== q.id && (x.options.length > 0 || x.rows.length > 0))
    .map((x) => ({
      id: x.id,
      code: x.code,
      label: stripHtmlText(x.text).slice(0, 40) || x.variableName,
    }));
  /** List Fills whose already-decided output a mask can read (§23). */
  const listFills = (s.def.listFills ?? []).map((lf) => ({ id: lf.id, name: lf.name ?? lf.id }));

  const mask = q[field];
  const expr = mask?.expr ?? null;

  const setExpr = (next: SetExpr | null) => {
    s.labelNextEdit?.(`edit ${noun} mask`);
    if (!next) { patch({ [field]: undefined }); return; }
    patch({
      [field]: {
        expr: next,
        action: mask?.action ?? "display",
        keepAlwaysShow: mask?.keepAlwaysShow ?? true,
        onEmptySource: mask?.onEmptySource,
        when: mask?.when,
        label: mask?.label,
      },
    } as Partial<Question>);
  };

  const issues = expr ? validateSetExpr(s.def, q.id, expr) : [];
  const summary = expr ? setExpressionSummary(s.def, expr) : "";
  // the older sequential pipeline only ever drove options, never rows/columns
  const convertible = field === "mask" && !mask ? pipelineToSetExpr(q) : null;

  /** Items the mask can never remove, for the reassurance line. */
  const items = field === "mask" ? q.options : field === "rowMask" ? q.rows : q.columns;
  const protectedItems = items.filter(
    (o) =>
      o.logic?.visibility === "always_show" ||
      o.flags?.some((f) => ["other_specify", "none_of_above", "dont_know", "refused"].includes(f)),
  );
  const itemLabel = (o: (typeof items)[number]) => stripHtmlText(o.label);

  return (
    <div className="masking-builder"
      data-testid={field === "mask" ? "masking-builder" : `masking-builder-${field}`}>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        Build this question&apos;s {noun} list from other questions&apos; answers. Sets combine
        with UNION (either), INTERSECTION (both) and DIFFERENCE (the first but not the
        second); brackets decide what is evaluated first.
      </p>
      <p className="muted" style={{ fontSize: 11.5, marginTop: -6 }} data-testid="mask-evaluation-order">
        Evaluation order (fixed, so two rules can never disagree unpredictably):{" "}
        {EVALUATION_ORDER[field]}.
      </p>

      {convertible && (
        <div className="mb-convert" data-testid="mask-convert">
          This question uses the older list pipeline, which reads as{" "}
          <code>{formatSetExpression(s.def, convertible)}</code>.
          <button className="btn small" data-testid="mask-convert-btn"
            onClick={() => { setExpr(convertible); patch({ optionPipeline: [] }); }}>
            convert to a mask
          </button>
        </div>
      )}

      <div className="cond-mode-bar" data-testid="mask-mode-bar">
        <button className={`cm-tab ${mode === "visual" ? "on" : ""}`} data-testid="mask-mode-visual"
          onClick={() => setMode("visual")}>Visual</button>
        <button className={`cm-tab ${mode === "expression" ? "on" : ""}`} data-testid="mask-mode-expression"
          onClick={() => setMode("expression")}>Expression</button>
        <span className="grow" />
        {expr && (
          <button className="btn small danger" data-testid="mask-clear"
            onClick={() => patch({ [field]: undefined } as Partial<Question>)}>clear mask</button>
        )}
      </div>

      {mode === "visual"
        ? <SetChainEditor expr={expr} sources={sources} listFills={listFills} onChange={setExpr} />
        : (
          <>
            <SetExpressionPane expr={expr} onChange={setExpr} />
            <SourcePicker sources={sources} onInsert={(token) => {
              // insert through the expression pane's own parser by appending
              const merged = expr
                ? `${formatSetExpression(s.def, expr)} UNION ${token}`
                : token;
              const r = parseSetExpression(s.def, merged);
              if (r.errors.length === 0) setExpr(r.expr ?? null);
            }} />
          </>
        )}

      {issues.map((iss, i) => (
        <div key={i} className={iss.level === "error" ? "xe-error" : "xe-warn"}
          data-testid="mask-issue">⚠ {iss.message}</div>
      ))}
      {summary && !issues.some((i) => i.level === "error") && (
        <div className="logic-summary" data-testid="mask-summary">Shows {summary}</div>
      )}

      {expr && (
        <>
          <div className="row mb-action" style={{ flexWrap: "wrap", marginTop: 8 }}>
            <label className="f" style={{ marginBottom: 0, width: 190 }}>
              <span>What to do with the result</span>
              <select className="select" data-testid="mask-action"
                value={mask?.action ?? "display"}
                onChange={(e) => patch({ [field]: { ...mask!, action: e.target.value as MaskAction } } as Partial<Question>)}>
                <option value="display">Show only these {noun}s</option>
                <option value="remove">Remove these {noun}s</option>
                <option value="preselect">Pre-select these (show all)</option>
                <option value="display_and_preselect">Show only these, and pre-select them</option>
                <option value="disable">Show all, allow only these</option>
              </select>
            </label>
            <label className="row" style={{ gap: 5, fontSize: 13, alignSelf: "flex-end" }}>
              <input type="checkbox" data-testid="mask-keep-always"
                checked={mask?.keepAlwaysShow ?? true}
                onChange={(e) => patch({ [field]: { ...mask!, keepAlwaysShow: e.target.checked } } as Partial<Question>)} />
              Always keep Other / None / Don&apos;t know
            </label>
            <label className="f" style={{ marginBottom: 0, width: 210 }}>
              <span>If the source is unanswered</span>
              <select className="select" data-testid="mask-empty-source"
                value={mask?.onEmptySource ?? (mask?.keepAlwaysShow === false ? "show_none" : "always_show_only")}
                onChange={(e) => patch({
                  [field]: { ...mask!, onEmptySource: e.target.value as "show_all" | "show_none" | "always_show_only" },
                } as Partial<Question>)}>
                <option value="always_show_only">Show only Always-Show / special items</option>
                <option value="show_all">Show every {noun}</option>
                <option value="show_none">Show none</option>
              </select>
            </label>
          </div>
          {protectedItems.length > 0 && (mask?.keepAlwaysShow ?? true) && (
            <div className="muted" style={{ fontSize: 12.5 }} data-testid="mask-protected">
              Kept whatever the mask returns: {protectedItems.map(itemLabel).join(", ")}
            </div>
          )}
          <OptionalCondition label="Apply the mask only when" value={mask?.when}
            onChange={(when) => patch({ [field]: { ...mask!, when } } as Partial<Question>)} />
        </>
      )}
    </div>
  );
}

/* ==================================================== auto-selection rules */

/**
 * Auto-selection ("punching"): tick options in THIS question from another
 * question's answers (reqs §14–§19).
 *
 * The rule lives on the question being filled, which is what makes it
 * deterministic — it reads state that already exists rather than reaching
 * across and writing into a question the respondent may not have seen.
 * "FOR EACH option IN Q5.Selected → punch the matching option" is this rule
 * with no mapping, which is why there is no separate loop to configure.
 *
 * Its own top-level Properties panel section (Part B) rather than nested
 * inside masking — Auto Punch targets ANY question type (numeric, hidden,
 * matrix/composite cells, not just choice-like ones masking applies to), so
 * it is no longer gated behind masking's own capability check. It computes
 * its own source list rather than taking one as a prop, so it has no
 * dependency on `MaskingBuilder` beyond the shared `SetChainEditor` pieces.
 */
export function PunchRules({ q, patch }: {
  q: Question;
  patch(p: Partial<Question>): void;
}) {
  const s = useStudio();
  const rules = q.punches ?? [];
  const listFills = (s.def.listFills ?? []).map((lf) => ({ id: lf.id, name: lf.name ?? lf.id }));
  /** Any other question with options to draw from. */
  const sources = s.def.questions
    .filter((x) => x.id !== q.id && (x.options.length > 0 || x.rows.length > 0))
    .map((x) => ({
      id: x.id,
      code: x.code,
      label: stripHtmlText(x.text).slice(0, 40) || x.variableName,
    }));

  const setRule = (i: number, next: Partial<PunchRule>) =>
    patch({ punches: rules.map((r, j) => (j === i ? { ...r, ...next } as PunchRule : r)) });

  const addRule = () => {
    const first = sources[0];
    if (!first) return;
    s.labelNextEdit?.("add auto-selection rule");
    patch({
      punches: [...rules, {
        id: uid("punch"),
        source: { kind: "ref", questionId: first.id, selection: "selected" },
        action: "select",
        mapping: [],
        ignoreUnmatched: true,
        recompute: "once",
      } as PunchRule],
    });
  };

  return (
    <div className="mb-punch">
      <h3 className="sec" style={{ marginTop: 16 }}>Auto punch (option → option)</h3>
      <p className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>
        “If an option is selected elsewhere, select / deselect / show / hide an option here.”
        Also listed survey-wide in the Logic tab.
      </p>
      <AutoPunchRows q={q} />

      <h3 className="sec" style={{ marginTop: 16 }}>Auto-select from a set (punching)</h3>
      <p className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>
        Tick options in this question from another question&apos;s answers. Codes that match
        carry across; use a mapping when the two lists number things differently. A matrix or
        composite target can also be addressed cell by cell, and independent rules that disagree
        are settled by priority — see the Logic tab&apos;s trace for which rule actually won.
      </p>

      {rules.filter((r) => !isOptionLevel(r)).map((rule) => { const i = rules.indexOf(rule);
        // A row/column address that no longer resolves — the target's rows
        // or columns changed since this rule was written — surfaced inline
        // rather than left to fail silently when the rule runs.
        const rowOk = rule.targetRow === undefined || q.rows.some((r) => String(r.code) === String(rule.targetRow));
        const columnOk = rule.targetColumn === undefined || q.columns.some((c) => c.id === rule.targetColumn);
        return (
        <div key={rule.id} className="card mb-punch-card" data-testid="punch-rule" style={{ padding: 10 }}>
          <div className="row" style={{ flexWrap: "wrap", marginBottom: 6 }}>
            <span className="flabel" style={{ margin: 0 }}>FOR EACH option in</span>
            <span className="grow" />
            <select className="select" style={{ width: 120 }} data-testid="punch-action"
              value={rule.action}
              onChange={(e) => setRule(i, { action: e.target.value as PunchRule["action"] })}>
              <option value="select">select it here</option>
              <option value="deselect">unselect it here</option>
              <option value="set_value">set value</option>
              <option value="clear">clear</option>
              <option value="show">show it here</option>
              <option value="hide">hide it here</option>
              <option value="enable">enable it here</option>
              <option value="disable">disable it here</option>
            </select>
            <select className="select" style={{ width: 120 }} data-testid="punch-recompute"
              title="Whether a respondent's own edit may be overwritten later"
              value={rule.recompute}
              onChange={(e) => setRule(i, { recompute: e.target.value as PunchRule["recompute"] })}>
              <option value="once">fill once</option>
              <option value="always">always refresh</option>
            </select>
            <button className="btn small danger" data-testid="punch-remove"
              onClick={() => patch({ punches: rules.filter((_, j) => j !== i) })}>×</button>
          </div>

          {/*
            * MATRIX / COMPOSITE CELL TARGETING (§16, §43). Absent (the
            * default) writes the target's whole answer, exactly as every
            * rule did before this existed. A row picker appears only for a
            * target that actually has rows (matrix/composite); a column
            * picker appears once a row is picked, only for a target that
            * has columns (a composite/custom-table cell) — a plain matrix
            * row has no column of its own, it writes the row's shared scale.
            */}
          {q.rows.length > 0 && (
            <div className="row" style={{ flexWrap: "wrap", marginBottom: 6 }}>
              <label className="row" style={{ gap: 4, fontSize: 13 }}>
                row
                <select className="select" data-testid="punch-target-row"
                  value={rule.targetRow === undefined ? "" : String(rule.targetRow)}
                  onChange={(e) => setRule(i, {
                    targetRow: e.target.value === "" ? undefined : e.target.value,
                    targetColumn: e.target.value === "" ? undefined : rule.targetColumn,
                  })}>
                  <option value="">(whole answer)</option>
                  {q.rows.map((r) => (
                    <option key={String(r.code)} value={String(r.code)}>{stripHtmlText(r.label)}</option>
                  ))}
                </select>
              </label>
              {rule.targetRow !== undefined && q.columns.length > 0 && (
                <label className="row" style={{ gap: 4, fontSize: 13 }}>
                  column
                  <select className="select" data-testid="punch-target-column"
                    value={rule.targetColumn ?? ""}
                    onChange={(e) => setRule(i, { targetColumn: e.target.value || undefined })}>
                    <option value="">(row&apos;s own scale)</option>
                    {q.columns.map((c) => (
                      <option key={c.id} value={c.id}>{c.label || c.id}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="row" style={{ gap: 4, fontSize: 13 }}
                title="Higher priority wins when this rule and another independent rule disagree on the same target — see the Logic tab's trace for which rule actually won">
                priority
                <input type="number" className="input mono" style={{ width: 56 }} data-testid="punch-priority"
                  value={rule.priority ?? 0}
                  onChange={(e) => setRule(i, { priority: Number(e.target.value) || undefined })} />
              </label>
            </div>
          )}
          {(!rowOk || !columnOk) && (
            <div className="xe-error" data-testid="punch-target-issue">
              {!rowOk && `✗ ${q.code} no longer has a row “${rule.targetRow}”. `}
              {!columnOk && `✗ ${q.code} no longer has a column “${rule.targetColumn}”.`}
            </div>
          )}

          <SetChainEditor expr={rule.source} sources={sources} listFills={listFills}
            onChange={(next) => next && setRule(i, { source: next })} />

          {rule.action !== "clear" && (
          <div className="mb-map">
            <div className="row" style={{ marginTop: 6 }}>
              <span className="flabel" style={{ margin: 0 }}>
                Mapping {rule.mapping.length === 0 ? "— same codes" : ""}
              </span>
              <span className="grow" />
              <button className="btn small" data-testid="punch-add-mapping"
                onClick={() => setRule(i, {
                  mapping: [...rule.mapping, { from: "", to: String(q.options[0]?.code ?? "") }],
                })}>+ map a code</button>
            </div>
            {rule.mapping.map((m, mi) => (
              <div key={mi} className="opt-row" data-testid="punch-mapping">
                <input className="input mono" style={{ width: 90 }} placeholder="source code"
                  value={String(m.from)}
                  onChange={(e) => setRule(i, {
                    mapping: rule.mapping.map((x, j) => (j === mi ? { ...x, from: e.target.value } : x)),
                  })} />
                <span className="muted">→</span>
                {/*
                  * The mapping target's own codes: a composite cell's column
                  * options, a matrix row's shared scale, or — no options at
                  * all (numeric/text) — a free-typed value.
                  */}
                {(rule.targetColumn
                  ? q.columns.find((c) => c.id === rule.targetColumn)?.options ?? []
                  : rule.targetRow !== undefined
                    ? q.options
                    : q.options
                ).length > 0 ? (
                  <select className="select grow" value={String(m.to)}
                    onChange={(e) => setRule(i, {
                      mapping: rule.mapping.map((x, j) => (j === mi ? { ...x, to: e.target.value } : x)),
                    })}>
                    {(rule.targetColumn
                      ? q.columns.find((c) => c.id === rule.targetColumn)?.options ?? []
                      : q.options
                    ).map((o) => (
                      <option key={String(o.code)} value={String(o.code)}>
                        {o.code}: {stripHtmlText(o.label).slice(0, 30)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input className="input grow mono" placeholder="value"
                    value={String(m.to)}
                    onChange={(e) => setRule(i, {
                      mapping: rule.mapping.map((x, j) => (j === mi ? { ...x, to: e.target.value } : x)),
                    })} />
                )}
                <button className="btn small danger"
                  onClick={() => setRule(i, { mapping: rule.mapping.filter((_, j) => j !== mi) })}>×</button>
              </div>
            ))}
          </div>
          )}

          <OptionalCondition label="Only when" value={rule.when}
            onChange={(when) => setRule(i, { when })} />
        </div>
      ); })}

      <button className="btn small" data-testid="punch-add" disabled={sources.length === 0}
        onClick={addRule}>+ auto-selection rule</button>
    </div>
  );
}
