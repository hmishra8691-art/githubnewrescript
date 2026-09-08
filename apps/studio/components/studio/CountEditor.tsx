"use client";
import React from "react";
import type {
  ComparisonOperator, ConditionRule, CountOf, CountScope, CountSpec, Question,
} from "@rescript/schema";
import { lintCount, authoringQuestionView } from "@rescript/engine";
import { useStudio } from "./store";

/**
 * THE COUNT HALF OF A CONDITION ROW.
 *
 * A count rule is an ordinary rule whose left-hand side is a number, so this
 * component edits `source.count` and leaves the operator and value controls to
 * the row that owns them. Everything here is about making the number
 * unambiguous:
 *
 *   WHAT is counted   selected / not selected / valid / invalid /
 *                     eligible / visible / hidden / matching
 *   OVER WHAT         this question's options, rows or columns — and only the
 *                     ones it actually has, because offering "rows" for a
 *                     multi-select would be inventing a capability
 *   NARROWED TO       an explicit subset, and/or one option group
 *
 * The three shortcuts — at least / at most / exactly — are not a second
 * mechanism. They set the operator on the same rule, which is why a rule built
 * with the shortcut and one built by hand are indistinguishable afterwards.
 * "Minimum selections [2]" is `>= 2`, and the row goes on saying so.
 */

const OF_LABEL: Record<CountOf, string> = {
  selected: "selected",
  notSelected: "not selected",
  valid: "valid",
  invalid: "invalid",
  eligible: "eligible",
  visible: "shown",
  hidden: "hidden",
  matching: "matching",
};

const OF_HINT: Record<CountOf, string> = {
  selected: "Options the respondent ticked; rows and columns that hold an answer.",
  notSelected: "The rest of the list — including everything when nothing is answered.",
  valid: "Items holding an answer that passes that item's own validation. An option has no validation of its own, so for options this is the same as selected.",
  invalid: "Items holding an answer that FAILS that item's own validation. An unanswered item is not invalid — it is missing, which “not selected” counts.",
  eligible: "Items the option pipeline leaves in — after masking, carry-forward, list operations and display rules.",
  visible: "The list the respondent is actually shown.",
  hidden: "Items the pipeline took away.",
  matching: "Items answering with one of the responses you pick, or satisfying a condition.",
};

/** Only the operators that mean something against a number. */
export const COUNT_OPERATORS: ComparisonOperator[] = ["eq", "ne", "gt", "lt", "gte", "lte", "between"];

const stripHtml = (h: string) => h.replace(/<[^>]*>/g, "").trim();

/** Which scopes this question actually has. Never offer one it does not. */
export function scopesFor(q: Question | undefined): CountScope[] {
  if (!q) return ["options"];
  const out: CountScope[] = [];
  if ((q.options ?? []).length) out.push("options");
  if ((q.rows ?? []).length) out.push("rows");
  if ((q.columns ?? []).length) out.push("columns");
  return out.length ? out : ["options"];
}

/** A plain-English reading of the count, so the rule can be checked by eye. */
export function describeCount(spec: CountSpec, q: Question | undefined): string {
  const noun = spec.scope === "rows" ? "rows" : spec.scope === "columns" ? "columns" : "options";
  const where = spec.only?.length
    ? ` of ${spec.only.length} chosen ${noun}`
    : spec.group
      ? ` in one group`
      : ` in ${q?.code ?? "the question"}`;
  const resp = spec.responseIn?.length
    ? ` answering ${spec.responseIn.map((r) => labelForResponse(q, r)).join(" or ")}`
    : "";
  if (spec.of === "matching") return `how many${where}${resp || " match the condition"}`;
  return `how many ${OF_LABEL[spec.of]}${where}`;
}

function labelForResponse(q: Question | undefined, code: string | number): string {
  const o = (q?.options ?? []).find((x) => String(x.code) === String(code));
  return o ? stripHtml(o.label) : String(code);
}

export function CountEditor({
  rule, onChange,
}: {
  rule: ConditionRule;
  onChange(r: ConditionRule): void;
}) {
  const s = useStudio();
  const spec = rule.source.count;
  if (!spec) return null;

  const q = s.def.questions.find((x) => x.id === rule.source.ref);
  /*
   * Same resolver as ConditionBuilder's row/column pickers: a carry-forward
   * question has no rows/options/columns of its own in the static schema, so
   * without this a COUNT rule against exactly the matrix this feature exists
   * for offers nothing to count and nothing to narrow to.
   */
  const view = q ? authoringQuestionView(q, s.def) : undefined;
  const scopes = scopesFor(view);

  const setSpec = (patch: Partial<CountSpec>) =>
    onChange({ ...rule, source: { ...rule.source, count: { ...spec, ...patch } as CountSpec } });

  /** The items of the current scope, as pickable codes. */
  const items: { key: string; label: string }[] =
    spec.scope === "rows"
      ? (view?.rows ?? []).map((r) => ({ key: String(r.code), label: stripHtml(r.label) }))
      : spec.scope === "columns"
        ? (view?.columns ?? []).map((c) => ({ key: c.id, label: c.label }))
        : (view?.options ?? []).map((o) => ({ key: String(o.code), label: stripHtml(o.label) }));

  /* the responses a grid row can hold — the question's own option list */
  const responses = (view?.options ?? []).map((o) => ({ key: String(o.code), label: stripHtml(o.label) }));

  const toggle = (list: (string | number)[] | undefined, key: string): (string | number)[] | undefined => {
    const cur = (list ?? []).map(String);
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    return next.length ? next : undefined;
  };

  const groups = (q as unknown as { optionGroups?: { id: string; name: string; scope?: string }[] })?.optionGroups ?? [];
  const problems = q ? lintCount(s.def, rule.source as never, rule.operator, rule.value) : [];

  return (
    <div className="count-editor" data-testid="count-editor">
      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12.5 }}>count</span>

        <select
          className="select" data-testid="count-of" aria-label="What to count"
          value={spec.of} onChange={(e) => setSpec({ of: e.target.value as CountOf })}
          title={OF_HINT[spec.of]}
        >
          {(Object.keys(OF_LABEL) as CountOf[]).map((o) => (
            <option key={o} value={o} title={OF_HINT[o]}>{OF_LABEL[o]}</option>
          ))}
        </select>

        {/*
          * Only the scopes this question has. A multi-select is offered
          * "options" and nothing else — the alternative is a dropdown that
          * lets a programmer count rows on a question with no rows and then
          * wonder why the rule never fires.
          */}
        {scopes.length > 1 ? (
          <select
            className="select" data-testid="count-scope" aria-label="What to count over"
            value={spec.scope} onChange={(e) => setSpec({ scope: e.target.value as CountScope, only: undefined })}
          >
            {scopes.map((sc) => (
              <option key={sc} value={sc}>{sc === "options" ? "options" : sc}</option>
            ))}
          </select>
        ) : (
          <span className="chip" data-testid="count-scope-fixed">{scopes[0]}</span>
        )}

        {groups.length > 0 && (
          <select
            className="select" data-testid="count-group" aria-label="Count within one group"
            value={spec.group ?? ""} onChange={(e) => setSpec({ group: e.target.value || undefined })}
          >
            <option value="">all groups</option>
            {groups.map((g) => <option key={g.id} value={g.id}>in {g.name}</option>)}
          </select>
        )}

        {/* the shortcuts — the same rule, with the operator filled in */}
        <span className="grow" />
        <span className="muted" style={{ fontSize: 12 }}>quick:</span>
        {([["gte", "at least"], ["lte", "at most"], ["eq", "exactly"]] as [ComparisonOperator, string][]).map(
          ([op, label]) => (
            <button
              key={op} type="button"
              className={`btn small ${rule.operator === op ? "primary" : ""}`}
              data-testid={`count-quick-${op}`}
              onClick={() => onChange({ ...rule, operator: op, value: Number(rule.value ?? 1) || 1 })}
            >{label}</button>
          ),
        )}
      </div>

      {/* ------------------------------------------------ the subset picker */}
      <details className="count-subset" data-testid="count-subset">
        <summary style={{ cursor: "pointer", fontSize: 12.5 }}>
          {spec.only?.length
            ? `counting ${spec.only.length} of ${items.length} ${spec.scope}`
            : `counting all ${items.length} ${spec.scope}`}
        </summary>
        <div className="row" style={{ gap: 4, flexWrap: "wrap", marginTop: 6 }}>
          {items.map((i) => {
            const on = (spec.only ?? []).map(String).includes(i.key);
            return (
              <button
                key={i.key} type="button"
                className={`btn small ${on ? "primary" : ""}`}
                data-testid={`count-only-${i.key}`}
                onClick={() => setSpec({ only: toggle(spec.only, i.key) })}
              >{i.label || i.key}</button>
            );
          })}
          {spec.only?.length ? (
            <button type="button" className="btn small ghost" data-testid="count-only-clear"
              onClick={() => setSpec({ only: undefined })}>count all</button>
          ) : null}
        </div>
        <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
          Pick nothing to count the whole list. Picking a subset is the “at least 2 of A, C and E” case —
          {" "}{spec.scope} outside the subset are not counted at all, so they cannot inflate the number.
        </p>
      </details>

      {/* ------------------------- which responses count, for a grid row */}
      {spec.of === "matching" && spec.scope !== "options" && responses.length > 0 && (
        <div className="count-responses" data-testid="count-responses">
          <span className="muted" style={{ fontSize: 12.5 }}>answering:</span>
          <div className="row" style={{ gap: 4, flexWrap: "wrap", marginTop: 4 }}>
            {responses.map((r) => {
              const on = (spec.responseIn ?? []).map(String).includes(r.key);
              return (
                <button
                  key={r.key} type="button"
                  className={`btn small ${on ? "primary" : ""}`}
                  data-testid={`count-response-${r.key}`}
                  onClick={() => setSpec({ responseIn: toggle(spec.responseIn, r.key) })}
                >{r.label}</button>
              );
            })}
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
            A row counts when it holds any of these — which is what “rated Good or Very Good” means.
          </p>
        </div>
      )}

      <div className="count-reading muted" data-testid="count-reading">
        {describeCount(spec, view)}
      </div>

      {problems.map((p) => (
        <div key={p} className="chip warn qd-note" data-testid="count-problem">{p}</div>
      ))}
    </div>
  );
}
