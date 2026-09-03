"use client";
import React from "react";
import type { Condition, ConditionGroup, ConditionRule, ComparisonOperator, Question } from "@rescript/schema";
import {
  VALUELESS_OPERATORS,
  TWO_VALUE_OPERATORS,
  LIST_VALUE_OPERATORS,
  isOptionValueRef,
} from "@rescript/schema";
import {
  operatorsForQuestion, conditionSummary, embeddedCatalog,
  type LogicPath,
  editableCondition, canonicalCondition, pathKey, appendTo, replaceAt, removeAt,
  duplicateAt, setOperatorAt, groupSelection, ungroupAt, validateLogicTree,
  OPERATOR_LABEL, OPERATOR_HINT, setGroupConnector,
} from "@rescript/engine";
import { useStudio } from "./store";
import { ExpressionEditor } from "./ExpressionEditor";

/**
 * Recursive visual condition builder — arbitrary AND/OR/NOT nesting with
 * every operator the engine implements (reqs §6–7, §13).
 *
 * Two things make it work for option-level logic:
 *   • operators are filtered to the ones that make sense for the source
 *     question, so a ranking operator never appears under a text question;
 *   • in per-option mode the builder can read "this option" and compare
 *     against it, which is how one rule covers a whole option list without
 *     any per-question hard-coding (reqs §8–9, §28).
 */

const OPERATOR_LABELS: Record<ComparisonOperator, string> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  lt: "<",
  gte: "≥",
  lte: "≤",
  between: "between",
  notBetween: "not between",
  in: "in list",
  notIn: "not in list",
  contains: "contains",
  notContains: "doesn't contain",
  containsAny: "contains any of",
  containsAll: "contains all of",
  containsNone: "contains none of",
  selected: "has selected",
  notSelected: "hasn't selected",
  answered: "is answered",
  unanswered: "is unanswered",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
  matches: "matches regex",
  startsWith: "starts with",
  endsWith: "ends with",
  rankedFirst: "ranked first",
  rankedLast: "ranked last",
  rankedTopN: "ranked in top N",
  rankEquals: "rank equals",
  rankGreaterThan: "rank greater than",
  rankLessThan: "rank less than",
  notRanked: "not ranked",
  dateBefore: "before",
  dateAfter: "after",
  dateEquals: "on",
  dateBetween: "between dates",
};

const VALUE2_PLACEHOLDER: Partial<Record<ComparisonOperator, string>> = {
  between: "and",
  notBetween: "and",
  dateBetween: "and",
  rankedTopN: "N",
  rankEquals: "rank",
  rankGreaterThan: "rank",
  rankLessThan: "rank",
};

function newRule(defaultRef: string): ConditionRule {
  return { type: "rule", source: { kind: "question", ref: defaultRef }, operator: "eq", value: "" };
}

/**
 * A ready-to-edit condition list.
 *
 * Deliberately EMPTY. It used to arrive with one rule already in it and an
 * AND group around it, which is the thing the builder now avoids: the
 * programmer adds conditions first and decides about grouping afterwards.
 */
export function newConditionGroup(_defaultRef?: string): Condition {
  return { type: "group", op: "and", children: [] };
}

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "");

function RuleEditor({ rule, onChange, onRemove, perOption }: {
  rule: ConditionRule; onChange(r: ConditionRule): void; onRemove(): void; perOption?: boolean;
}) {
  const s = useStudio();
  const q: Question | undefined = s.def.questions.find((x) => x.id === rule.source.ref);
  const listOps = LIST_VALUE_OPERATORS.includes(rule.operator);
  const needsValue = !VALUELESS_OPERATORS.includes(rule.operator);
  const needsValue2 = TWO_VALUE_OPERATORS.includes(rule.operator);
  const usesOption = isOptionValueRef(rule.value);

  // only offer operators that make sense for the chosen source (req §7)
  const allowed: ComparisonOperator[] =
    rule.source.kind === "question" && q
      ? operatorsForQuestion(q)
      : (Object.keys(OPERATOR_LABELS) as ComparisonOperator[]);
  const operatorChoices = allowed.includes(rule.operator) ? allowed : [rule.operator, ...allowed];

  const setSource = (patch: Partial<ConditionRule["source"]>) =>
    onChange({ ...rule, source: { ...rule.source, ...patch } });

  /**
   * Source is ONE control, not two. A separate "Question / Variable /
   * Calculation / Embedded" picker sat in front of every rule, truncated to
   * "Questi⌄" in the panel, and was almost never changed — the overwhelming
   * majority of conditions read a question. Option groups put every source in
   * a single dropdown, which is both narrower and less to explain.
   */
  const sourceValue =
    rule.source.kind === "question" ? `q:${rule.source.ref}`
      : rule.source.kind === "option" ? `o:${rule.source.ref || "code"}`
        : `${rule.source.kind}:${rule.source.ref}`;

  const pickSource = (raw: string) => {
    const [kind, ...rest] = raw.split(":");
    const ref = rest.join(":");
    if (kind === "q") return setSource({ kind: "question", ref });
    if (kind === "o") return setSource({ kind: "option", ref: ref || "code" });
    setSource({ kind: kind as any, ref });
  };

  return (
    <div className="cond-rule">
      <div className="cond-rule-main">
      <select className="select ref-select" aria-label="What this condition reads"
        value={sourceValue} onChange={(e) => pickSource(e.target.value)}>
        <option value="q:">— pick a question —</option>
        {perOption && (
          <optgroup label="This option">
            <option value="o:code">this option’s code</option>
            <option value="o:label">this option’s label</option>
            <option value="o:value">this option’s value</option>
            <option value="o:index">this option’s position</option>
          </optgroup>
        )}
        <optgroup label="Questions">
          {s.def.questions.map((x) => (
            <option key={x.id} value={`q:${x.id}`}>{x.code} — {x.variableName}</option>
          ))}
        </optgroup>
        {s.def.calculations.length > 0 && (
          <optgroup label="Calculations">
            {s.def.calculations.map((c) => (
              <option key={c.id} value={`calculation:${c.targetVariable}`}>{c.targetVariable}</option>
            ))}
          </optgroup>
        )}
        {/* every embedded field declared anywhere in the flow, with its type —
            not only the ones registered on the survey (reqs §15–16) */}
        {embeddedCatalog(s.def).length > 0 && (
          <optgroup label="Embedded data">
            {embeddedCatalog(s.def).map((e2) => (
              <option key={e2.name} value={`embedded:${e2.name}`}>
                {e2.name}{e2.dataType !== "string" ? ` (${e2.dataType})` : ""}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Loop">
          <option value="loop:label">loop label</option>
          <option value="loop:code">loop code</option>
          <option value="loop:index">loop index</option>
        </optgroup>
      </select>
      {q && (q.rows.length > 0 || q.columns.length > 0) && (
        <>
          {q.rows.length > 0 && (
            <select className="select" value={rule.source.rowCode ?? ""}
              onChange={(e) => setSource({ rowCode: e.target.value || undefined })}>
              <option value="">any row</option>
              {q.rows.map((r) => <option key={String(r.code)} value={String(r.code)}>row: {stripHtml(r.label)}</option>)}
            </select>
          )}
          {q.columns.length > 0 && (
            <select className="select" value={rule.source.columnId ?? ""}
              onChange={(e) => setSource({ columnId: e.target.value || undefined })}>
              <option value="">any col</option>
              {q.columns.map((c) => <option key={c.id} value={c.id}>col: {c.label}</option>)}
            </select>
          )}
        </>
      )}
      <select className="select op-select" value={rule.operator}
        onChange={(e) => onChange({ ...rule, operator: e.target.value as ComparisonOperator })}>
        {operatorChoices.map((o) => <option key={o} value={o}>{OPERATOR_LABELS[o] ?? o}</option>)}
      </select>

      {needsValue && (
        usesOption ? (
          <span className="chip pipe-chip" title="Compares against the option this rule is attached to">
            this option’s {(rule.value as any).$option}
          </span>
        ) : q && q.options.length > 0 && !listOps && rule.operator !== "matches" ? (
          <select className="select" value={String(rule.value ?? "")}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}>
            <option value="">— value —</option>
            {q.options.map((o) => (
              <option key={String(o.code)} value={String(o.code)}>{o.code}: {stripHtml(o.label)}</option>
            ))}
          </select>
        ) : (
          <input className="input"
            placeholder={listOps ? "1,2,3" : "value"}
            value={listOps && Array.isArray(rule.value) ? rule.value.join(",") : String(rule.value ?? "")}
            onChange={(e) =>
              onChange({ ...rule, value: listOps ? e.target.value.split(",").map((x) => x.trim()) : e.target.value })
            } />
        )
      )}
      {perOption && needsValue && (
        <button className="btn small" style={{ flex: "0 0 auto" }}
          title="Compare against the option this rule is attached to"
          onClick={() => onChange({ ...rule, value: usesOption ? "" : { $option: "code" } })}>
          {usesOption ? "fixed value" : "↺ this option"}
        </button>
      )}
      {needsValue2 && (
        <input className="input" style={{ flex: "0 1 90px" }} placeholder={VALUE2_PLACEHOLDER[rule.operator] ?? "and"}
          value={String(rule.value2 ?? "")}
          onChange={(e) => onChange({ ...rule, value2: e.target.value })} />
      )}
      </div>
      <div className="cond-rule-actions">
        <button className="btn small danger" title="Remove this condition" onClick={onRemove}>×</button>
      </div>
    </div>
  );
}

/* ==========================================================================
 * The logic builder: conditions first, groups only when asked for.
 *
 * It used to open on a logical structure — a group, an "ALL (AND)" operator
 * and an empty slot — so the first thing a programmer met was set theory, and
 * mixing AND with OR meant knowing to press "+ condition group ( … )" before
 * writing anything down.
 *
 * Now the builder opens empty. Conditions are added to a flat list. When two
 * of them belong together the programmer ticks them and presses
 * "Move to new group", which is the only nesting gesture there is — and it
 * works on groups too, so depth accumulates the same way at every level.
 *
 * The stored shape does not change: still `Condition`, still a group that owns
 * its own `op`, still evaluated by the recursive evaluator. All of the tree
 * arithmetic lives in `@rescript/engine`'s `logicTree.ts`, shared with Survey
 * Flow, so question logic and branch logic cannot drift apart (req §14).
 * ======================================================================== */

/** Number the groups in document order, so the badges read "Group 1, 2, 3". */
function groupNumbers(root: ConditionGroup): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  const walk = (node: Condition, path: LogicPath) => {
    if (node.type !== "group") return;
    node.children.forEach((child, i) => {
      const p = [...path, i];
      if (child.type === "group") out.set(pathKey(p), ++n);
      walk(child, p);
    });
  };
  walk(root, []);
  return out;
}

interface BuilderCtx {
  root: ConditionGroup;
  commit(next: ConditionGroup, label: string): void;
  selected: string[];
  toggle(path: LogicPath, on: boolean): void;
  numbers: Map<string, number>;
  perOption?: boolean;
  justGrouped: string | null;
}

/**
 * One level of the list: the rows, the connector between them, and the
 * "+ Add condition" that grows it.
 *
 * The same component renders the top level and the inside of every group,
 * which is what makes nesting free — a group is a row that happens to contain
 * a list.
 */
function ConditionList({ ctx, path, group }: {
  ctx: BuilderCtx; path: LogicPath; group: ConditionGroup;
}) {
  const s = useStudio();
  const firstRef = s.def.questions[0]?.id ?? "";
  const isRoot = path.length === 0;

  const addCondition = () =>
    ctx.commit(appendTo(ctx.root, path, newRule(firstRef)), "add condition");

  if (group.children.length === 0) {
    return (
      <div className="lb-empty" data-testid={isRoot ? "lb-empty" : "lb-empty-group"}>
        <span className="muted">
          {isRoot ? "No conditions added yet." : "This group is empty."}
        </span>
        <button className="btn small primary" data-testid="lb-add-condition" onClick={addCondition}>
          + Add condition
        </button>
      </div>
    );
  }

  return (
    <div className={`lb-list${isRoot ? " root" : ""}`}>
      {group.children.map((child, i) => {
        const childPath = [...path, i];
        const key = pathKey(childPath);
        return (
          <React.Fragment key={key}>
            {i > 0 && (
              <Connector ctx={ctx} path={path} group={group} gapIndex={i - 1} />
            )}
            <div className={`lb-row${ctx.selected.includes(key) ? " selected" : ""}`}
              data-testid="lb-row">
              {/* a plain span, not a <label>: a label wrapping its own checkbox
                  re-dispatches the click to it, which toggles twice */}
              <span className="lb-pick">
                <input type="checkbox" data-testid="lb-check"
                  aria-label="Select this condition to group, duplicate or delete it"
                  title="Select this to group, duplicate or delete it"
                  checked={ctx.selected.includes(key)}
                  onChange={(e) => ctx.toggle(childPath, e.target.checked)} />
              </span>
              <div className="lb-row-body">
                {child.type === "rule" ? (
                  <RuleEditor rule={child} perOption={ctx.perOption}
                    onChange={(r) => ctx.commit(replaceAt(ctx.root, childPath, r), "edit condition")}
                    onRemove={() => ctx.commit(removeAt(ctx.root, childPath), "remove condition")} />
                ) : (
                  <GroupRow ctx={ctx} path={childPath} group={child} />
                )}
              </div>
            </div>
          </React.Fragment>
        );
      })}
      <div className="lb-add">
        <button className="btn small" data-testid="lb-add-condition" onClick={addCondition}>
          + Add condition
        </button>
      </div>
    </div>
  );
}

/**
 * The operator between two rows — one per gap, each independently settable.
 *
 * This is the fix for "changing one AND/OR changes the others". A group holds
 * ONE operator, and this control used to write it directly, so four conditions
 * in one list drew three dropdowns onto one stored value: setting any of them
 * moved all three. Worse, `C1 AND C2 OR C3 AND C4` could not be expressed at
 * all, because one level can only hold one operator.
 *
 * `setGroupConnector` writes the gap instead, and rebuilds the level so every
 * other gap keeps what it had — AND binding tighter than OR, so the brackets
 * that appear are exactly the ones the edit means. Each operator then lives on
 * a real group node of its own; nothing is shared.
 */
function Connector({ ctx, path, group, gapIndex }: {
  ctx: BuilderCtx; path: LogicPath; group: ConditionGroup; gapIndex: number;
}) {
  // NOT is not a relationship between two things — it belongs to the group as
  // a whole, and is set in that group's header
  if (group.op === "not") {
    return (
      <div className="lb-join">
        <span className="lb-join-label" data-testid="cond-join">{OPERATOR_LABEL.not}</span>
      </div>
    );
  }
  return (
    <div className="lb-join">
      <select className="select lb-join-select" data-testid="lb-join-op"
        aria-label="How these two combine"
        value={group.op === "or" ? "or" : "and"}
        onChange={(e) => ctx.commit(
          setGroupConnector(ctx.root, path, gapIndex, e.target.value as "and" | "or"),
          "change operator",
        )}>
        <option value="and">AND</option>
        <option value="or">OR</option>
      </select>
      <span className="muted lb-join-hint">{OPERATOR_HINT[group.op]}</span>
    </div>
  );
}

/** A group: a bordered container with its own operator, holding its own list. */
function GroupRow({ ctx, path, group }: {
  ctx: BuilderCtx; path: LogicPath; group: ConditionGroup;
}) {
  const key = pathKey(path);
  const n = ctx.numbers.get(key);
  return (
    <div className={`lb-group op-${group.op}${ctx.justGrouped === key ? " just-created" : ""}`}
      data-testid="lb-group">
      <div className="lb-group-head">
        <span className="lb-group-badge">GROUP {n ?? ""}</span>
        <select className="select lb-op-select" data-testid="group-op"
          aria-label="How the conditions in this group combine"
          value={group.op}
          onChange={(e) => ctx.commit(
            setOperatorAt(ctx.root, path, e.target.value as ConditionGroup["op"]),
            "change group operator",
          )}>
          <option value="and">AND</option>
          <option value="or">OR</option>
          <option value="not">NOT</option>
        </select>
        <span className="muted lb-group-hint">{OPERATOR_HINT[group.op]}</span>
        {/* the two buttons travel together: letting them wrap independently
            dropped a lone × onto a second line in the 380px panel */}
        <span className="lb-group-actions">
          <button className="btn small" data-testid="lb-ungroup"
            title="Remove this group, keep the conditions in it"
            onClick={() => ctx.commit(ungroupAt(ctx.root, path), "ungroup")}>
            ungroup
          </button>
          <button className="btn small danger" title="Delete this group and everything in it"
            onClick={() => ctx.commit(removeAt(ctx.root, path), "delete group")}>×</button>
        </span>
      </div>
      <div className="lb-group-body">
        <ConditionList ctx={ctx} path={path} group={group} />
      </div>
    </div>
  );
}

/**
 * The builder. `value` is the stored condition; what comes back out is the
 * smallest tree with the same meaning, so a one-condition rule is stored as a
 * rule and an emptied builder as an empty list rather than an inverted one.
 */
/**
 * Visual or written — the same logic either way.
 *
 * Both panes edit the one canonical tree: the visual builder assembles it,
 * the expression editor parses text into it and prints it back. Nothing
 * stores an expression, so switching modes cannot lose or change anything
 * (reqs §1, §13–15).
 */
export function ConditionEditor(props: {
  value: Condition; onChange(c: Condition): void; perOption?: boolean;
}) {
  const [mode, setMode] = React.useState<"visual" | "expression">("visual");
  return (
    <div className="cond-modes">
      <div className="cond-mode-bar" data-testid="logic-mode-bar">
        <button className={`cm-tab ${mode === "visual" ? "on" : ""}`} data-testid="mode-visual"
          onClick={() => setMode("visual")}>Visual</button>
        <button className={`cm-tab ${mode === "expression" ? "on" : ""}`} data-testid="mode-expression"
          onClick={() => setMode("expression")}>Expression</button>
        <span className="grow" />
        <span className="muted cm-hint">
          {mode === "visual" ? "click to build" : "type, drag or click references"}
        </span>
      </div>
      {mode === "visual"
        ? <VisualConditionEditor {...props} />
        : <ExpressionEditor {...props} />}
      {/* one plain-English reading, under whichever pane is open — it used to
          be rendered by OptionalCondition as well, which showed it twice */}
      <ConditionSummary value={props.value} />
    </div>
  );
}

function VisualConditionEditor({ value, onChange, perOption }: {
  value: Condition; onChange(c: Condition): void; perOption?: boolean;
}) {
  const s = useStudio();
  const root = editableCondition(value);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [justGrouped, setJustGrouped] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  /** Every write goes through here: canonicalise, label for undo, save. */
  const commit = (next: ConditionGroup, label: string) => {
    s.labelNextEdit?.(label);
    onChange(canonicalCondition(next, { allowEmpty: false })!);
  };

  const toggle = (path: LogicPath, on: boolean) => {
    const key = pathKey(path);
    setNotice(null);
    setSelected((cur) => (on ? [...cur, key] : cur.filter((k) => k !== key)));
  };

  const selectedPaths: LogicPath[] = selected.map((k) => k.split(".").map(Number));
  // grouping only makes sense among siblings; the engine refuses the rest
  const sameLevel = selectedPaths.length > 0 &&
    new Set(selectedPaths.map((p) => p.slice(0, -1).join("."))).size === 1;

  const moveToGroup = () => {
    const res = groupSelection(root, selectedPaths, "and");
    if (!res.ok) { setNotice(res.reason ?? "That selection cannot be grouped"); return; }
    commit(res.root, "move to new group");
    setSelected([]);
    const key = res.groupPath ? pathKey(res.groupPath) : null;
    setJustGrouped(key);
    setTimeout(() => setJustGrouped(null), 1800);
  };

  const duplicateSelected = () => {
    // deepest-last, so earlier duplications do not shift later paths
    const ordered = [...selectedPaths].sort((a, b) => b.join(".").localeCompare(a.join(".")));
    let next = root;
    for (const p of ordered) next = duplicateAt(next, p);
    commit(next, "duplicate conditions");
    setSelected([]);
  };

  const deleteSelected = () => {
    const ordered = [...selectedPaths].sort((a, b) => b.join(".").localeCompare(a.join(".")));
    let next = root;
    for (const p of ordered) next = removeAt(next, p);
    commit(next, "delete conditions");
    setSelected([]);
  };

  const numbers = groupNumbers(root);
  const ctx: BuilderCtx = { root, commit, selected, toggle, numbers, perOption, justGrouped };
  const issues = validateLogicTree(root);

  return (
    <div className="logic-builder" data-testid="logic-builder">
      {selected.length > 0 && (
        <div className="lb-actions" data-testid="lb-actions">
          <span className="lb-count" data-testid="lb-count">{selected.length} selected</span>
          <button className="btn small primary" data-testid="lb-move-to-group"
            disabled={!sameLevel}
            title={sameLevel
              ? "Wrap the selected conditions in a group you can give its own AND / OR / NOT"
              : "Select conditions that sit at the same level"}
            onClick={moveToGroup}>
            Move to new group
          </button>
          <button className="btn small" data-testid="lb-duplicate" onClick={duplicateSelected}>
            Duplicate
          </button>
          <button className="btn small danger" data-testid="lb-delete" onClick={deleteSelected}>
            Delete
          </button>
          <span className="grow" />
          <button className="btn small" onClick={() => { setSelected([]); setNotice(null); }}>
            Clear selection
          </button>
        </div>
      )}
      {notice && <div className="lb-notice" data-testid="lb-notice">{notice}</div>}

      <ConditionList ctx={ctx} path={[]} group={root} />

      {issues.filter((i) => i.level === "error").slice(0, 3).map((i, k) => (
        <div key={k} className="lb-issue" data-testid="lb-issue">⛔ {i.message}</div>
      ))}
    </div>
  );
}

/** Optional condition wrapper: none / edit. */
export function OptionalCondition({ label, value, onChange, perOption, hint }: {
  label: string; value: Condition | undefined; onChange(c: Condition | undefined): void;
  perOption?: boolean; hint?: string;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="row" style={{ marginBottom: 4 }}>
        <span className="flabel" style={{ marginBottom: 0 }}>{label}</span>
        <span className="grow" />
        {value ? (
          <button className="btn small danger" onClick={() => onChange(undefined)}>clear</button>
        ) : (
          /* opens an EMPTY builder — no group, no operator, nothing to undo */
          <button className="btn small" data-testid="optional-add"
            onClick={() => onChange(newConditionGroup())}>
            + add
          </button>
        )}
      </div>
      {hint && !value && <div className="muted" style={{ fontSize: 11, marginTop: -2 }}>{hint}</div>}
      {value && <ConditionEditor value={value} onChange={onChange} perOption={perOption} />}
    </div>
  );
}

/** Readable one-line summary of a configured condition (req §14). */
export function ConditionSummary({ value }: { value: Condition | undefined }) {
  const s = useStudio();
  const text = conditionSummary(s.def, value);
  if (!text) return null;
  return <div className="logic-summary">{text}</div>;
}

/** Legacy text renderer kept for the logic-flow export; now shares the
 *  engine's phrasing so the editor and the export never disagree. */
export function conditionToText(c: Condition | undefined, def: any): string {
  return conditionSummary(def, c);
}
