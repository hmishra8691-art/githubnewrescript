import type { Condition, ConditionGroup, ConditionRule } from "@rescript/schema";

/**
 * Editing operations on a condition tree.
 *
 * The canonical schema is unchanged: a `Condition` is still a rule or a group,
 * a group still owns its own `op`, and the evaluator is still the recursive one
 * in `evaluate.ts`. What lives here is the set of moves a *builder* needs —
 * address a node, group a selection, ungroup, change one group's operator —
 * expressed as pure functions over that same tree.
 *
 * They are here rather than in the Studio for the reason the brief gives in
 * §14: question logic (display, skip, option, validation) and Survey Flow
 * logic (branches, redirects, page visibility) must not grow two
 * implementations of nesting. One tree, one set of operations, one evaluator.
 *
 * ## Addressing
 *
 * A node is addressed by its index path from the root: `[]` is the root,
 * `[2]` its third child, `[2, 0]` that child's first child. Paths are stable
 * for the duration of one edit and are recomputed after each — which is why
 * every operation returns a whole new root rather than mutating in place.
 */

export type LogicPath = number[];

const isGroup = (c: Condition): c is ConditionGroup => c.type === "group";

export const emptyGroup = (op: ConditionGroup["op"] = "and"): ConditionGroup =>
  ({ type: "group", op, children: [] });

/* ------------------------------------------------------- editable form */

/**
 * The form the builder edits: always a group, so "the list of conditions" is
 * always `root.children` and an empty builder is a real, valid value.
 *
 * A stored single rule (legacy, and what `canonicalCondition` produces again)
 * becomes a one-child AND group. That is the same thing to the evaluator —
 * `every([rule])` is `rule` — so nothing about the survey's meaning moves.
 */
export function editableCondition(c: Condition | undefined | null): ConditionGroup {
  if (!c) return emptyGroup();
  if (isGroup(c)) return c;
  return { type: "group", op: "and", children: [c] };
}

/**
 * The form worth storing: the smallest tree with identical meaning.
 *
 * A one-child AND/OR group collapses to its child, because the wrapper says
 * nothing. A one-child NOT group does NOT collapse — it negates. An empty tree
 * becomes `undefined` where the caller allows it (no logic at all), and
 * otherwise an empty AND group, which every evaluator reads as "no constraint".
 * An empty OR group would read as "never", so the operator is dropped with the
 * last child rather than left behind to invert the meaning of a question's
 * visibility.
 */
export function canonicalCondition(
  g: ConditionGroup,
  opts: { allowEmpty?: boolean } = {},
): Condition | undefined {
  const pruned = pruneEmptyGroups(g);
  if (!pruned || (isGroup(pruned) && pruned.children.length === 0)) {
    return opts.allowEmpty === false ? emptyGroup() : undefined;
  }
  return pruned;
}

/**
 * Drop groups that ended up with no children; they can only mislead.
 *
 * A wrapper holding a single CONDITION is dropped too — `and([rule])` is
 * `rule`, so the wrapper is noise. A wrapper holding a single GROUP is kept:
 * it is a bracket the programmer deliberately created, and dropping it would
 * make a group they had just built stop being drawn as one. A single-child
 * `not` is never dropped, because it negates.
 */
function pruneEmptyGroups(c: Condition): Condition | null {
  if (!isGroup(c)) return c;
  const children = c.children
    .map((ch) => pruneEmptyGroups(ch))
    .filter((ch): ch is Condition => ch !== null);
  if (children.length === 0) return null;
  if (children.length === 1 && c.op !== "not" && !isGroup(children[0])) return children[0];
  return { ...c, children };
}

/* ---------------------------------------------------------- addressing */

export function getAt(root: Condition, path: LogicPath): Condition | null {
  let cur: Condition = root;
  for (const i of path) {
    if (!isGroup(cur)) return null;
    const next = cur.children[i];
    if (!next) return null;
    cur = next;
  }
  return cur;
}

export const parentPath = (path: LogicPath): LogicPath => path.slice(0, -1);
export const indexIn = (path: LogicPath): number => path[path.length - 1] ?? -1;

export const samePath = (a: LogicPath, b: LogicPath): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export const pathKey = (path: LogicPath): string => path.join(".");

/** True when `inner` is `outer` or sits underneath it. */
export const isUnder = (inner: LogicPath, outer: LogicPath): boolean =>
  outer.every((x, i) => inner[i] === x) && inner.length >= outer.length;

/** Replace the node at `path`, returning a new root. */
export function replaceAt(root: ConditionGroup, path: LogicPath, next: Condition): ConditionGroup {
  if (path.length === 0) {
    return isGroup(next) ? next : { type: "group", op: "and", children: [next] };
  }
  const [i, ...rest] = path;
  const child = root.children[i];
  if (!child) return root;
  const updated: Condition = rest.length === 0
    ? next
    : isGroup(child) ? replaceAt(child, rest, next) : child;
  return { ...root, children: root.children.map((c, j) => (j === i ? updated : c)) };
}

/**
 * Remove the node at `path`.
 *
 * A group left with no children goes too, recursively: deleting the last
 * condition inside a bracket is how a programmer says "I don't want that
 * bracket", and leaving `( )` behind would either always pass or never pass
 * depending on its operator (req §19).
 */
export function removeAt(root: ConditionGroup, path: LogicPath): ConditionGroup {
  if (path.length === 0) return emptyGroup(root.op);
  if (path.length === 1) {
    return { ...root, children: root.children.filter((_, j) => j !== path[0]) };
  }
  const [i, ...rest] = path;
  const child = root.children[i];
  if (!child || !isGroup(child)) return root;
  const trimmed = removeAt(child, rest);
  const children = trimmed.children.length === 0
    ? root.children.filter((_, j) => j !== i)
    : root.children.map((c, j) => (j === i ? trimmed : c));
  return { ...root, children };
}

/** Add a node at the end of the group addressed by `path`. */
export function appendTo(root: ConditionGroup, path: LogicPath, node: Condition): ConditionGroup {
  const target = getAt(root, path);
  if (!target || !isGroup(target)) return root;
  return replaceAt(root, path, { ...target, children: [...target.children, node] });
}

/** Insert a copy of the node at `path` directly after it. */
export function duplicateAt(root: ConditionGroup, path: LogicPath): ConditionGroup {
  const node = getAt(root, path);
  if (!node || path.length === 0) return root;
  const pPath = parentPath(path);
  const parent = getAt(root, pPath);
  if (!parent || !isGroup(parent)) return root;
  const at = indexIn(path);
  const children = [...parent.children];
  children.splice(at + 1, 0, structuredClone(node));
  return replaceAt(root, pPath, { ...parent, children });
}

/** Set one group's operator. Nothing else in the tree is touched (req §10). */
export function setOperatorAt(
  root: ConditionGroup,
  path: LogicPath,
  op: ConditionGroup["op"],
): ConditionGroup {
  const target = getAt(root, path);
  if (!target || !isGroup(target)) return root;
  return replaceAt(root, path, { ...target, op });
}

/* ---------------------------------------------------------- connectors */

/**
 * The operator shown in each gap between a group's children.
 *
 * A group owns ONE operator, so every gap in it reads the same — which is
 * fine as a display, and was the whole bug as a set of *controls*: four
 * conditions in one list drew three dropdowns onto one stored value, so
 * setting one appeared to set the others. It also made
 * `C1 AND C2 OR C3 AND C4` impossible to express, because a single level can
 * only hold a single operator.
 *
 * `setGroupConnector` is the fix: each gap can be set independently, and the
 * result is materialised as real nested groups.
 */
export function connectorsOf(group: ConditionGroup): ConditionGroup["op"][] {
  return Array(Math.max(0, group.children.length - 1)).fill(group.op);
}

/**
 * Set ONE gap's operator, restructuring the group so the other gaps keep
 * theirs.
 *
 * AND binds tighter than OR, as in every language and every survey tool, so
 * `C1 AND C2 OR C3 AND C4` becomes `(C1 AND C2) OR (C3 AND C4)`. The brackets
 * that appear are real groups with their own operators — nothing is implied,
 * hidden or shared, and the programmer sees the structure their edit means.
 *
 * Setting the gap back merges the runs again, so the operation is reversible.
 */
export function setGroupConnector(
  root: ConditionGroup,
  path: LogicPath,
  gapIndex: number,
  op: "and" | "or",
): ConditionGroup {
  const group = getAt(root, path);
  if (!group || !isGroup(group)) return root;
  // NOT is not a binary connector — it belongs to a group as a whole
  if (group.op === "not") return root;
  const items = group.children;
  if (items.length < 2 || gapIndex < 0 || gapIndex > items.length - 2) return root;

  const gaps = connectorsOf(group).map((g) => (g === "or" ? "or" : "and")) as ("and" | "or")[];
  gaps[gapIndex] = op;
  return replaceAt(root, path, regroupByPrecedence(items, gaps));
}

/** Rebuild one level from its items and the operator in each gap. */
function regroupByPrecedence(items: Condition[], gaps: ("and" | "or")[]): ConditionGroup {
  if (gaps.every((g) => g === gaps[0])) {
    return { type: "group", op: gaps[0], children: items };
  }
  // split into AND-runs wherever a gap says OR
  const runs: Condition[][] = [[items[0]]];
  gaps.forEach((g, i) => {
    if (g === "or") runs.push([items[i + 1]]);
    else runs[runs.length - 1].push(items[i + 1]);
  });
  return {
    type: "group",
    op: "or",
    children: runs.map((run) =>
      run.length === 1 ? run[0] : ({ type: "group", op: "and", children: run } as Condition),
    ),
  };
}

/* ------------------------------------------------------------ grouping */

export interface GroupResult {
  root: ConditionGroup;
  /** Where the new group ended up, so the UI can focus it. */
  groupPath: LogicPath | null;
  ok: boolean;
  reason?: string;
}

/**
 * Wrap a selection in a new group — the one nesting gesture the brief asks for
 * (§6). The selected nodes leave their current positions and become the new
 * group's children, in their existing order, and the group takes the position
 * of the first one.
 *
 * Selections must be siblings. Grouping across levels has no single meaning —
 * pulling a condition out of a bracket changes what that bracket evaluates —
 * so it is refused with a reason rather than guessed at.
 */
export function groupSelection(
  root: ConditionGroup,
  paths: LogicPath[],
  op: ConditionGroup["op"] = "and",
): GroupResult {
  if (paths.length === 0) {
    return { root, groupPath: null, ok: false, reason: "select at least one condition" };
  }
  if (paths.some((p) => p.length === 0)) {
    return { root, groupPath: null, ok: false, reason: "the whole list cannot be grouped inside itself" };
  }
  const parents = new Set(paths.map((p) => pathKey(parentPath(p))));
  if (parents.size > 1) {
    return {
      root, groupPath: null, ok: false,
      reason: "select conditions that sit at the same level — grouping across brackets would change what they mean",
    };
  }

  const pPath = parentPath(paths[0]);
  const parent = getAt(root, pPath);
  if (!parent || !isGroup(parent)) {
    return { root, groupPath: null, ok: false, reason: "that selection is no longer in the tree" };
  }

  const picked = [...paths].map(indexIn).sort((a, b) => a - b);
  const members = picked
    .map((i) => parent.children[i])
    .filter((c): c is Condition => !!c);
  if (members.length === 0) {
    return { root, groupPath: null, ok: false, reason: "that selection is no longer in the tree" };
  }

  const insertAt = picked[0];
  const remaining = parent.children.filter((_, i) => !picked.includes(i));
  const group: ConditionGroup = { type: "group", op, children: members };
  const children = [
    ...remaining.slice(0, insertAt),
    group,
    ...remaining.slice(insertAt),
  ];

  return {
    root: replaceAt(root, pPath, { ...parent, children }),
    groupPath: [...pPath, Math.min(insertAt, children.length - 1)],
    ok: true,
  };
}

/**
 * Dissolve a group: its children take its place in its parent, in order.
 *
 * The children keep their own operators, so ungrouping an `(A OR B)` inside an
 * AND changes the meaning — deliberately, and visibly, because that is what
 * removing a bracket does.
 */
export function ungroupAt(root: ConditionGroup, path: LogicPath): ConditionGroup {
  if (path.length === 0) return root; // the root list is not a bracket
  const node = getAt(root, path);
  if (!node || !isGroup(node)) return root;
  const pPath = parentPath(path);
  const parent = getAt(root, pPath);
  if (!parent || !isGroup(parent)) return root;
  const at = indexIn(path);
  const children = [
    ...parent.children.slice(0, at),
    ...node.children,
    ...parent.children.slice(at + 1),
  ];
  return replaceAt(root, pPath, { ...parent, children });
}

/* ---------------------------------------------------------- describing */

export const OPERATOR_LABEL: Record<ConditionGroup["op"], string> = {
  and: "AND",
  or: "OR",
  not: "NOT",
};

export const OPERATOR_HINT: Record<ConditionGroup["op"], string> = {
  and: "all of these must be true",
  or: "any one of these",
  not: "none of these may be true",
};

/** How many conditions (not groups) the tree holds. */
export function countConditions(c: Condition | undefined | null): number {
  if (!c) return 0;
  if (!isGroup(c)) return 1;
  return c.children.reduce((t, ch) => t + countConditions(ch), 0);
}

/** How many groups the tree holds, excluding the root list. */
export function countGroups(root: ConditionGroup): number {
  let n = 0;
  const walk = (c: Condition) => {
    if (!isGroup(c)) return;
    for (const ch of c.children) {
      if (isGroup(ch)) n += 1;
      walk(ch);
    }
  };
  walk(root);
  return n;
}

/* ---------------------------------------------------------- validation */

export interface LogicTreeIssue {
  path: LogicPath;
  level: "error" | "warning";
  message: string;
}

/**
 * Structural problems a builder must not be able to save (req §19).
 *
 * Reference and operator checks are `lintLogic.ts`'s job and run survey-wide;
 * this is only about the shape of one tree, so the builder can show it inline
 * while the programmer is still looking at it.
 */
export function validateLogicTree(root: ConditionGroup): LogicTreeIssue[] {
  const issues: LogicTreeIssue[] = [];

  const walk = (c: Condition, path: LogicPath, depth: number) => {
    if (depth > 50) {
      issues.push({ path, level: "error", message: "Logic is nested too deeply to evaluate" });
      return;
    }
    if (!isGroup(c)) {
      const noValue = c.value === undefined || c.value === "" || c.value === null;
      const needsValue = !["answered", "unanswered", "isEmpty", "isNotEmpty", "notRanked"]
        .includes(c.operator);
      if (!c.source?.ref) {
        issues.push({ path, level: "error", message: "This condition has no question selected" });
      } else if (needsValue && noValue) {
        issues.push({ path, level: "warning", message: "This condition has no value to compare against" });
      }
      return;
    }
    if (c.children.length === 0 && path.length > 0) {
      issues.push({ path, level: "error", message: "This group is empty — remove it or add a condition" });
    }
    c.children.forEach((ch, i) => walk(ch, [...path, i], depth + 1));
  };

  walk(root, [], 0);
  return issues;
}

/** A fresh, blank condition row. */
export function newConditionRule(ref: string): ConditionRule {
  return { type: "rule", source: { kind: "question", ref }, operator: "eq", value: "" };
}
