"use client";
import React from "react";
import type {
  Question, SetExpr, SetOperator, SetSelection, MaskAction, PunchRule,
} from "@rescript/schema";
import { SET_OPERATOR_LABEL, SET_SELECTION_LABEL } from "@rescript/schema";
import {
  parseSetExpression, formatSetExpression, setExpressionSummary,
  setExprToChain, appendSet, replaceSetAt, removeSetAt, setChainOperator,
  bracketSetPair, validateSetExpr, pipelineToSetExpr,
  type SetExprError,
} from "@rescript/engine";
import { useStudio, uid } from "./store";
import { OptionalCondition } from "./ConditionBuilder";
import { AutoPunchRows } from "./AutoPunchEditor";

/** Option-level rules (a literal code set) are edited by AutoPunchRows, not the set chain. */
const isOptionLevel = (r: PunchRule) => r.source.kind === "codes";

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
function SetRow({ node, sources, onChange, onRemove, onBracket, canBracket }: {
  node: SetExpr;
  sources: { id: string; code: string; label: string }[];
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
          <span className="muted" style={{ fontSize: 11 }}>evaluated first</span>
          <span className="grow" />
          <button className="btn small danger" title="Remove this bracket and everything in it"
            onClick={onRemove}>×</button>
        </div>
        <SetChainEditor expr={node} sources={sources} onChange={onChange} nested />
      </div>
    );
  }

  if (node.kind === "complement") {
    return (
      <div className="mb-row" data-testid="mask-row">
        <span className="mb-not">NOT</span>
        <div className="grow">
          <SetRow node={node.of} sources={sources}
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
function SetChainEditor({ expr, sources, onChange, nested }: {
  expr: SetExpr | null;
  sources: { id: string; code: string; label: string }[];
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
        <div className="muted" style={{ fontSize: 11 }}>
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
          <span className="muted" style={{ fontSize: 11 }}>
            No other questions to draw options from yet.
          </span>
        )}
      </div>
    </div>
  );
}

/* ============================================================ the panel */

export function MaskingBuilder({ q, patch }: {
  q: Question; patch(p: Partial<Question>): void;
}) {
  const s = useStudio();
  const [mode, setMode] = React.useState<"visual" | "expression">("visual");

  /** Any other question with options to draw from. */
  const sources = s.def.questions
    .filter((x) => x.id !== q.id && (x.options.length > 0 || x.rows.length > 0))
    .map((x) => ({
      id: x.id,
      code: x.code,
      label: x.text.replace(/<[^>]*>/g, "").slice(0, 40) || x.variableName,
    }));

  const mask = q.mask;
  const expr = mask?.expr ?? null;

  const setExpr = (next: SetExpr | null) => {
    s.labelNextEdit?.("edit mask");
    if (!next) { patch({ mask: undefined }); return; }
    patch({
      mask: {
        expr: next,
        action: mask?.action ?? "display",
        keepAlwaysShow: mask?.keepAlwaysShow ?? true,
        when: mask?.when,
        label: mask?.label,
      },
    });
  };

  const issues = expr ? validateSetExpr(s.def, q.id, expr) : [];
  const summary = expr ? setExpressionSummary(s.def, expr) : "";
  const convertible = !mask ? pipelineToSetExpr(q) : null;

  /** Options the mask can never remove, for the reassurance line. */
  const protectedOptions = q.options.filter(
    (o) =>
      o.logic?.visibility === "always_show" ||
      o.flags?.some((f) => ["other_specify", "none_of_above", "dont_know", "refused"].includes(f)),
  );

  return (
    <div className="masking-builder" data-testid="masking-builder">
      <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
        Build this question&apos;s option list from other questions&apos; answers. Sets combine
        with UNION (either), INTERSECTION (both) and DIFFERENCE (the first but not the
        second); brackets decide what is evaluated first.
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
            onClick={() => patch({ mask: undefined })}>clear mask</button>
        )}
      </div>

      {mode === "visual"
        ? <SetChainEditor expr={expr} sources={sources} onChange={setExpr} />
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
                onChange={(e) => patch({ mask: { ...mask!, action: e.target.value as MaskAction } })}>
                <option value="display">Show only these options</option>
                <option value="remove">Remove these options</option>
                <option value="preselect">Pre-select these (show all)</option>
                <option value="display_and_preselect">Show only these, and pre-select them</option>
                <option value="disable">Show all, allow only these</option>
              </select>
            </label>
            <label className="row" style={{ gap: 5, fontSize: 12, alignSelf: "flex-end" }}>
              <input type="checkbox" data-testid="mask-keep-always"
                checked={mask?.keepAlwaysShow ?? true}
                onChange={(e) => patch({ mask: { ...mask!, keepAlwaysShow: e.target.checked } })} />
              Always keep Other / None / Don&apos;t know
            </label>
          </div>
          {protectedOptions.length > 0 && (mask?.keepAlwaysShow ?? true) && (
            <div className="muted" style={{ fontSize: 11 }} data-testid="mask-protected">
              Kept whatever the mask returns: {protectedOptions.map((o) =>
                o.label.replace(/<[^>]*>/g, "")).join(", ")}
            </div>
          )}
          <OptionalCondition label="Apply the mask only when" value={mask?.when}
            onChange={(when) => patch({ mask: { ...mask!, when } })} />
        </>
      )}

      <PunchRules q={q} patch={patch} sources={sources} />
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
 */
function PunchRules({ q, patch, sources }: {
  q: Question;
  patch(p: Partial<Question>): void;
  sources: { id: string; code: string; label: string }[];
}) {
  const s = useStudio();
  const rules = q.punches ?? [];

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
      <p className="muted" style={{ fontSize: 11, marginTop: -4 }}>
        “If an option is selected elsewhere, select / deselect / show / hide an option here.”
        Also listed survey-wide in the Logic tab.
      </p>
      <AutoPunchRows q={q} />

      <h3 className="sec" style={{ marginTop: 16 }}>Auto-select from a set (punching)</h3>
      <p className="muted" style={{ fontSize: 11, marginTop: -4 }}>
        Tick options in this question from another question&apos;s answers. Codes that match
        carry across; use a mapping when the two lists number things differently.
      </p>

      {rules.filter((r) => !isOptionLevel(r)).map((rule) => { const i = rules.indexOf(rule); return (
        <div key={rule.id} className="card mb-punch-card" data-testid="punch-rule" style={{ padding: 10 }}>
          <div className="row" style={{ flexWrap: "wrap", marginBottom: 6 }}>
            <span className="flabel" style={{ margin: 0 }}>FOR EACH option in</span>
            <span className="grow" />
            <select className="select" style={{ width: 120 }} data-testid="punch-action"
              value={rule.action}
              onChange={(e) => setRule(i, { action: e.target.value as PunchRule["action"] })}>
              <option value="select">select it here</option>
              <option value="deselect">unselect it here</option>
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

          <SetChainEditor expr={rule.source} sources={sources}
            onChange={(next) => next && setRule(i, { source: next })} />

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
                <select className="select grow" value={String(m.to)}
                  onChange={(e) => setRule(i, {
                    mapping: rule.mapping.map((x, j) => (j === mi ? { ...x, to: e.target.value } : x)),
                  })}>
                  {q.options.map((o) => (
                    <option key={String(o.code)} value={String(o.code)}>
                      {o.code}: {o.label.replace(/<[^>]*>/g, "").slice(0, 30)}
                    </option>
                  ))}
                </select>
                <button className="btn small danger"
                  onClick={() => setRule(i, { mapping: rule.mapping.filter((_, j) => j !== mi) })}>×</button>
              </div>
            ))}
          </div>

          <OptionalCondition label="Only when" value={rule.when}
            onChange={(when) => setRule(i, { when })} />
        </div>
      ); })}

      <button className="btn small" data-testid="punch-add" disabled={sources.length === 0}
        onClick={addRule}>+ auto-selection rule</button>
    </div>
  );
}
