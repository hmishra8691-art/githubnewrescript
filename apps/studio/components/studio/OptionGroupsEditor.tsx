"use client";
import React from "react";
import type { OptionGroup, OptionOrder, Question } from "@rescript/schema";
import { lintOptionGroups, groupOf } from "@rescript/engine";
import { useStudio, uid } from "./store";
import { OptionalCondition } from "./ConditionBuilder";

/**
 * OPTION GROUPS, AND THE TWO ORDER SWITCHES (§29–30).
 *
 * The panel is deliberately built around MEMBERSHIP rather than around
 * dragging, because membership is what the engine reads and what a programmer
 * gets wrong. Every option, row or column in the question is listed once with
 * the group it belongs to; moving one between groups is changing that value.
 * A drag-and-drop tree looks better in a screenshot and makes "which group is
 * this in?" a question you answer by looking at indentation.
 *
 * The two order controls are separate and both always visible, because all
 * four combinations are real (§18) and the useful one is easy to miss: FIXED
 * groups with RANDOM items — sections that stay put while their contents
 * rotate.
 *
 * Nothing here can move an item out of its group by accident; the engine
 * orders groups as whole blocks. What this panel can do wrong is put an item
 * in two groups or in none, and both are linted on screen.
 */

const ORDER_LABEL: Record<OptionOrder, string> = {
  fixed: "Fixed — as listed",
  random: "Random",
  rotate: "Rotate — start position advances",
  flip: "Flip — always reversed",
  flip_random: "Flip — reversed for half of respondents",
  alpha_asc: "Alphabetical A → Z",
  alpha_desc: "Alphabetical Z → A",
  numeric_asc: "Numeric, ascending",
  numeric_desc: "Numeric, descending",
  custom: "Custom order",
  priority: "Priority order",
};

/** Not every strategy makes sense for every level. */
const GROUP_ORDERS: OptionOrder[] = [
  "fixed", "random", "rotate", "flip", "flip_random", "alpha_asc", "alpha_desc", "custom", "priority",
];
const ITEM_ORDERS: OptionOrder[] = [
  "fixed", "random", "rotate", "flip", "flip_random",
  "alpha_asc", "alpha_desc", "numeric_asc", "numeric_desc", "custom", "priority",
];

const stripHtml = (h: string) => h.replace(/<[^>]*>/g, "").trim();
type Scope = "options" | "rows" | "columns";

export function OptionGroupsEditor({ q, patch }: {
  q: Question;
  patch: (p: Partial<Question>) => void;
}) {
  const s = useStudio();
  const [scope, setScope] = React.useState<Scope>("options");

  /* only the scopes this question actually has — never invent a capability */
  const available: Scope[] = [
    ...((q.options ?? []).length ? ["options" as Scope] : []),
    ...((q.rows ?? []).length ? ["rows" as Scope] : []),
    ...((q.columns ?? []).length ? ["columns" as Scope] : []),
  ];
  const useScope = available.includes(scope) ? scope : available[0];
  if (!useScope) {
    return (
      <p className="muted" style={{ fontSize: 13 }}>
        This question has no options, rows or columns to group.
      </p>
    );
  }

  const groups = (q.optionGroups ?? []).filter((g) => (g.scope ?? "options") === useScope);
  const others = (q.optionGroups ?? []).filter((g) => (g.scope ?? "options") !== useScope);
  const ordering = q.groupOrdering ?? { groupOrder: "fixed", itemOrder: "fixed", ungrouped: "last" };

  const items: { key: string; label: string }[] =
    useScope === "rows"
      ? (q.rows ?? []).map((r) => ({ key: String(r.code), label: stripHtml(r.label) }))
      : useScope === "columns"
        ? (q.columns ?? []).map((c) => ({ key: c.id, label: c.label }))
        : (q.options ?? []).map((o) => ({ key: String(o.code), label: stripHtml(o.label) || String(o.code) }));

  const setGroups = (next: OptionGroup[]) => patch({ optionGroups: [...others, ...next] });
  const setOrdering = (p: Partial<typeof ordering>) =>
    patch({ groupOrdering: { ...ordering, ...p } });

  const addGroup = () => {
    setGroups([...groups, {
      id: uid("grp"),
      name: `Group ${String.fromCharCode(65 + groups.length)}`,
      scope: useScope,
      members: [],
    }]);
  };

  const updateGroup = (id: string, p: Partial<OptionGroup>) =>
    setGroups(groups.map((g) => (g.id === id ? { ...g, ...p } : g)));

  const removeGroup = (id: string) => setGroups(groups.filter((g) => g.id !== id));

  const duplicateGroup = (g: OptionGroup) =>
    /*
     * A duplicate gets a NEW id and NO members. Copying the membership would
     * put every option in two groups at once — the one thing the lint below
     * exists to catch — so the useful copy is the settings, not the contents.
     */
    setGroups([...groups, { ...g, id: uid("grp"), name: `${g.name} copy`, members: [] }]);

  const moveGroup = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= groups.length) return;
    const next = [...groups];
    [next[i], next[j]] = [next[j], next[i]];
    setGroups(next);
  };

  /** Put one item in a group, taking it out of whichever group had it. */
  const assign = (key: string, groupId: string | "") => {
    setGroups(groups.map((g) => {
      const without = g.members.filter((m) => String(m) !== key);
      return g.id === groupId ? { ...g, members: [...without, key] } : { ...g, members: without };
    }));
  };

  /** Reorder a member inside its own group. */
  const moveMember = (g: OptionGroup, key: string, dir: -1 | 1) => {
    const codes = g.members.map(String);
    const i = codes.indexOf(key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= codes.length) return;
    [codes[i], codes[j]] = [codes[j], codes[i]];
    updateGroup(g.id, { members: codes });
  };

  const problems = lintOptionGroups(q);
  const ungrouped = items.filter((i) => !groupOf(q, useScope, i.key));

  return (
    <div className="opt-groups" data-testid="option-groups">
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Groups</strong>
        {available.length > 1 && (
          <select className="select" data-testid="group-scope" value={useScope}
            onChange={(e) => setScope(e.target.value as Scope)} aria-label="What to group">
            {available.map((sc) => <option key={sc} value={sc}>{sc}</option>)}
          </select>
        )}
        <span className="grow" />
        <button className="btn small" data-testid="add-group" data-command="add-option-group"
          onClick={addGroup}>+ Add group</button>
      </div>

      {groups.length === 0 ? (
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>
          No groups yet. A group keeps its {useScope} together: randomizing groups moves the whole
          block, and randomizing within a group never moves an item out of it.
        </p>
      ) : (
        <>
          {/* ------------------------------------- the two order switches */}
          <div className="card group-order" style={{ padding: "8px 12px", marginBottom: 10 }}
            data-testid="group-ordering">
            <label className="f"><span>Group order</span>
              <select className="select" data-testid="group-order" value={ordering.groupOrder}
                onChange={(e) => setOrdering({ groupOrder: e.target.value as OptionOrder })}>
                {GROUP_ORDERS.map((o) => <option key={o} value={o}>{ORDER_LABEL[o]}</option>)}
              </select></label>
            <label className="f"><span>Order within each group</span>
              <select className="select" data-testid="item-order" value={ordering.itemOrder}
                onChange={(e) => setOrdering({ itemOrder: e.target.value as OptionOrder })}>
                {ITEM_ORDERS.map((o) => <option key={o} value={o}>{ORDER_LABEL[o]}</option>)}
              </select></label>
            <label className="f"><span>{useScope} in no group</span>
              <select className="select" data-testid="ungrouped-position" value={ordering.ungrouped}
                onChange={(e) => setOrdering({ ungrouped: e.target.value as "first" | "last" })}>
                <option value="last">shown last</option>
                <option value="first">shown first</option>
              </select></label>
            <p className="muted" style={{ fontSize: 12, margin: "6px 0 0", lineHeight: 1.5 }}>
              The two are independent — fixed groups with random items is a real and common
              setting. Whatever they are set to, an item never leaves its group.
            </p>
          </div>

          {groups.map((g, gi) => {
            const members = g.members.map(String)
              .map((k) => items.find((i) => i.key === k))
              .filter(Boolean) as { key: string; label: string }[];
            return (
              <div className="card group-card" key={g.id} style={{ padding: "8px 12px", marginBottom: 8 }}
                data-testid="group-card" data-group-id={g.id}>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <input className="input" style={{ maxWidth: 220 }} value={g.name}
                    data-testid={`group-name-${g.id}`}
                    onChange={(e) => updateGroup(g.id, { name: e.target.value })}
                    placeholder="Group name" />
                  <span className="chip mono" title="Stable group id — logic and scripts use this">{g.id}</span>
                  <span className="muted" style={{ fontSize: 12.5 }}>{members.length} of {items.length}</span>
                  <span className="grow" />
                  <button className="btn small" title="Move group up" data-testid={`group-up-${g.id}`}
                    onClick={() => moveGroup(gi, -1)} disabled={gi === 0}>↑</button>
                  <button className="btn small" title="Move group down" data-testid={`group-down-${g.id}`}
                    onClick={() => moveGroup(gi, 1)} disabled={gi === groups.length - 1}>↓</button>
                  <button className="btn small" title="Duplicate this group's settings"
                    data-testid={`group-dup-${g.id}`} onClick={() => duplicateGroup(g)}>⧉</button>
                  <button className="btn small danger" title="Remove the group (its members stay)"
                    data-testid={`group-remove-${g.id}`} onClick={() => removeGroup(g.id)}>×</button>
                </div>

                <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                  <label className="f" style={{ minWidth: 220 }}>
                    <span>Order within this group</span>
                    <select className="select" data-testid={`group-itemorder-${g.id}`}
                      value={g.itemOrder ?? ""}
                      onChange={(e) => updateGroup(g.id, { itemOrder: (e.target.value || undefined) as OptionOrder })}>
                      <option value="">use the question setting ({ORDER_LABEL[ordering.itemOrder]})</option>
                      {ITEM_ORDERS.map((o) => <option key={o} value={o}>{ORDER_LABEL[o]}</option>)}
                    </select>
                  </label>
                  {ordering.groupOrder === "custom" && (
                    <label className="f" style={{ maxWidth: 110 }}><span>Position</span>
                      <input className="input" type="number" value={g.order ?? ""}
                        data-testid={`group-order-${g.id}`}
                        onChange={(e) => updateGroup(g.id, { order: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
                  )}
                  {ordering.groupOrder === "priority" && (
                    <label className="f" style={{ maxWidth: 110 }}><span>Priority</span>
                      <input className="input" type="number" value={g.priority ?? ""}
                        data-testid={`group-priority-${g.id}`}
                        onChange={(e) => updateGroup(g.id, { priority: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
                  )}
                </div>

                {/* members, in the group's own order */}
                {members.length > 0 && (
                  <div style={{ marginTop: 6 }} data-testid={`group-members-${g.id}`}>
                    {members.map((m, mi) => (
                      <div className="row group-member" key={m.key} style={{ gap: 4, fontSize: 13 }}>
                        <span className="muted mono" style={{ minWidth: 34 }}>{m.key}</span>
                        <span className="grow">{m.label}</span>
                        <button className="btn small" onClick={() => moveMember(g, m.key, -1)}
                          disabled={mi === 0} title="Move up">↑</button>
                        <button className="btn small" onClick={() => moveMember(g, m.key, 1)}
                          disabled={mi === members.length - 1} title="Move down">↓</button>
                        <button className="btn small" data-testid={`member-remove-${m.key}`}
                          onClick={() => assign(m.key, "")} title="Take out of this group">×</button>
                      </div>
                    ))}
                  </div>
                )}

                {/*
                  * GROUP-LEVEL LOGIC (§27). Hiding a group hides every member —
                  * except one marked Always Show, which survives, exactly as it
                  * survives a mask. That precedence is stated in the engine and
                  * repeated here because it is the thing a programmer needs to
                  * know before they rely on this switch.
                  */}
                <details style={{ marginTop: 6 }} data-testid={`group-logic-${g.id}`}>
                  <summary style={{ cursor: "pointer", fontSize: 12.5 }}>
                    {g.visibleIf ? "Shown conditionally" : "Show this group only when…"}
                  </summary>
                  <div style={{ marginTop: 6 }}>
                    <OptionalCondition
                      value={g.visibleIf}
                      onChange={(c) => updateGroup(g.id, { visibleIf: c })}
                      label="Show the whole group when"
                    />
                    <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
                      Hides every member. An option marked <strong>Always Show</strong> stays —
                      the same precedence it has against a mask.
                    </p>
                  </div>
                </details>
              </div>
            );
          })}
        </>
      )}

      {/* --------------------------------------------- assign every item */}
      <details className="card" style={{ padding: "8px 12px" }} data-testid="group-assign" open={groups.length > 0}>
        <summary style={{ cursor: "pointer", fontSize: 13 }}>
          Which group is each {useScope.slice(0, -1)} in?
          {ungrouped.length > 0 && <span className="muted"> — {ungrouped.length} in none</span>}
        </summary>
        <div style={{ marginTop: 8 }}>
          {items.map((i) => {
            const g = groupOf(q, useScope, i.key);
            return (
              <div className="row" key={i.key} style={{ gap: 6, fontSize: 13, marginBottom: 3 }}>
                <span className="muted mono" style={{ minWidth: 34 }}>{i.key}</span>
                <span className="grow">{i.label}</span>
                <select className="select" data-testid={`assign-${i.key}`}
                  value={g?.id ?? ""} onChange={(e) => assign(i.key, e.target.value)}
                  disabled={groups.length === 0}>
                  <option value="">— no group —</option>
                  {groups.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      </details>

      {problems.map((p) => (
        <div key={p} className="chip warn qd-note" data-testid="group-problem">{p}</div>
      ))}
    </div>
  );
}
