/**
 * HIERARCHICAL GROUPS, AND ORDERING THAT CANNOT BREAK THEM (§13–30).
 *
 * A group holds member CODES; the flat `options` / `rows` / `columns` arrays
 * are untouched and every existing consumer keeps reading them (see the note
 * on `OptionGroup` in the schema for why that was the deciding constraint).
 * This file is the only place that reads groups, and all it does is decide
 * ORDER and VISIBILITY.
 *
 * ## THE INVARIANT
 *
 *   An item never leaves its group.
 *
 * That is not a property of the input — it is a property of the algorithm.
 * Groups are ordered as WHOLE BLOCKS and members are ordered WITHIN a block;
 * there is no step at which a member and a non-member sit in the same array
 * being shuffled. A flat `seededShuffle` over the list could not give that
 * guarantee no matter how the groups were declared, which is why grouping
 * takes precedence over flat randomization rather than running after it.
 *
 * ## PRECEDENCE, STATED (§28)
 *
 * Three layers can hide an item, and the order is fixed:
 *
 *   1. `always_hide` on the item      — hidden, and nothing overrides it
 *   2. `always_show` on the item      — survives a group being hidden, exactly
 *                                       as it survives a mask
 *   3. the group's `visibleIf`        — false hides every remaining member
 *
 * Item-level conditional logic runs in the pipeline as it always did. A group
 * is a coarser switch above it, not a replacement for it.
 *
 * ## THE SEED BUG THIS FIXES
 *
 * `Randomization.groups` — the anonymous predecessor — seeded each group's
 * shuffle with its ARRAY INDEX (`subSeed(seed, "g" + gi)`). Reordering the
 * groups in the editor therefore silently re-shuffled every respondent already
 * in field, because group 0's seed became group 1's. A real group has an id,
 * and the id is the seed key.
 */
import type { Condition, OptionGroup, OptionOrder, Question } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";
import { seededShuffle, subSeed, mulberry32 } from "./random.js";

export interface GroupableItem {
  code: string | number;
  label?: string;
  flags?: string[];
  order?: number;
  priority?: number;
}

const key = (i: GroupableItem) => String(i.code);
const stripHtml = (h: string) => h.replace(/<[^>]*>/g, "").trim();

/*
 * "Always show" and "always hide" live in the item's OPTION LOGIC, not in its
 * flags — `logic.visibility`, the same field `carryforward.ts` reads. Checking
 * `flags` instead looks plausible and is silently always false, which would
 * have made the Always Show precedence rule below a no-op.
 */
type WithLogic = { logic?: { visibility?: string } };
const isAlwaysShow = (i: unknown) => (i as WithLogic)?.logic?.visibility === "always_show";
const isAlwaysHide = (i: unknown) => (i as WithLogic)?.logic?.visibility === "always_hide";

/** Does this question group the given collection? */
export function hasOptionGroups(q: Question, scope: "options" | "rows" | "columns"): boolean {
  return (q.optionGroups ?? []).some((g) => (g.scope ?? "options") === scope && g.members.length > 0);
}

/** The groups for one scope, in declaration order. */
export function groupsFor(q: Question, scope: "options" | "rows" | "columns"): OptionGroup[] {
  return (q.optionGroups ?? []).filter((g) => (g.scope ?? "options") === scope);
}

/* --------------------------------------------------------------- ordering */

/**
 * Order a list of anything by one strategy.
 *
 * `seed` is already scoped by the caller — per question and, for a within-group
 * order, per group — so two groups with the same strategy do not receive the
 * same permutation.
 */
export function orderItems<T extends GroupableItem>(
  items: T[],
  how: OptionOrder,
  seed: number,
): T[] {
  const list = [...items];
  switch (how) {
    case "fixed":
      return list;
    case "random":
      return seededShuffle(list, seed);
    case "rotate": {
      /*
       * The start position advances with the respondent's seed, so across a
       * sample every item spends an equal share of the time first — which is
       * the point of rotation, and what a plain shuffle does not guarantee for
       * small n.
       */
      if (!list.length) return list;
      const k = subSeed(seed, "rot") % list.length;
      return [...list.slice(k), ...list.slice(0, k)];
    }
    case "flip":
      return list.reverse();
    case "flip_random":
      return mulberry32(subSeed(seed, "flip"))() < 0.5 ? list.reverse() : list;
    case "alpha_asc":
    case "alpha_desc": {
      const dir = how === "alpha_asc" ? 1 : -1;
      /*
       * Sorted by the LABEL a respondent reads, with the markup taken off —
       * an option whose label is "<b>Apple</b>" sorts under A, not under "<".
       */
      return list.sort((a, b) =>
        dir * stripHtml(String(a.label ?? a.code)).localeCompare(
          stripHtml(String(b.label ?? b.code)), undefined, { numeric: true, sensitivity: "base" },
        ));
    }
    case "numeric_asc":
    case "numeric_desc": {
      const dir = how === "numeric_asc" ? 1 : -1;
      const n = (i: T) => {
        const v = Number(i.code);
        return Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
      };
      /* non-numeric codes sort last in both directions, rather than
         alternating between first and last depending on the direction */
      return list.sort((a, b) => {
        const na = n(a), nb = n(b);
        if (!Number.isFinite(na) && !Number.isFinite(nb)) return 0;
        if (!Number.isFinite(na)) return 1;
        if (!Number.isFinite(nb)) return -1;
        return dir * (na - nb);
      });
    }
    case "custom":
      /* an explicit `order`, with anything unset keeping its declared place */
      return list
        .map((i, idx) => ({ i, idx }))
        .sort((a, b) => (a.i.order ?? a.idx) - (b.i.order ?? b.idx))
        .map((x) => x.i);
    case "priority":
      /* highest first; ties keep declaration order, so it is stable */
      return list
        .map((i, idx) => ({ i, idx }))
        .sort((a, b) => (b.i.priority ?? 0) - (a.i.priority ?? 0) || a.idx - b.idx)
        .map((x) => x.i);
  }
  return list;
}

export interface GroupedResult<T> {
  items: T[];
  /** the blocks, in the order they were placed — for the debugger */
  blocks: { groupId: string | null; name: string; items: T[] }[];
  /** members removed because their group was hidden */
  hiddenByGroup: string[];
}

/**
 * Order a collection by its groups.
 *
 * Anchored items are handled by the caller (they are lifted out before this
 * runs and put back after), because an anchor means "first or last on the
 * screen" and that is a statement about the whole list, not about a group.
 */
export function orderWithGroups<T extends GroupableItem>(
  items: T[],
  groups: OptionGroup[],
  ordering: { groupOrder: OptionOrder; itemOrder: OptionOrder; ungrouped: "first" | "last" },
  seed: number,
  ctx?: EvalContext,
): GroupedResult<T> {
  const byCode = new Map(items.map((i) => [key(i), i]));
  const claimed = new Set<string>();
  const hiddenByGroup: string[] = [];

  /*
   * MEMBERSHIP IS EXCLUSIVE, first group wins. An option in two groups would
   * be shown twice, and a respondent who ticks it in one place and not the
   * other produces an answer nothing can interpret.
   */
  const blocks: { group: OptionGroup | null; members: T[] }[] = [];
  for (const g of groups) {
    const visible = !g.visibleIf || !ctx || evaluateCondition(g.visibleIf, ctx);
    const members: T[] = [];
    for (const code of g.members) {
      const k = String(code);
      if (claimed.has(k)) continue;
      const item = byCode.get(k);
      if (!item) continue;              // a member that has since been deleted
      claimed.add(k);
      if (isAlwaysHide(item)) continue;
      if (!visible && !isAlwaysShow(item)) {
        hiddenByGroup.push(k);
        continue;
      }
      members.push(item);
    }
    blocks.push({ group: g, members });
  }

  const ungrouped = items.filter((i) => !claimed.has(key(i)));

  /* the groups are ordered as blocks — members travel with their block */
  const orderedBlocks = orderItems(
    blocks.map((b, idx) => ({
      code: b.group?.id ?? `__ungrouped_${idx}`,
      label: b.group?.name ?? "",
      order: b.group?.order,
      priority: b.group?.priority,
      block: b,
    })),
    ordering.groupOrder,
    subSeed(seed, "groups"),
  ).map((x) => x.block);

  const out: T[] = [];
  const shape: GroupedResult<T>["blocks"] = [];

  const pushUngrouped = () => {
    if (!ungrouped.length) return;
    const kept = ungrouped.filter((i) => !isAlwaysHide(i));
    /* ungrouped items get the question-level within-group order, so a
       question that is only partly grouped still behaves consistently */
    const placed = orderItems(kept, ordering.itemOrder, subSeed(seed, "ungrouped"));
    out.push(...placed);
    shape.push({ groupId: null, name: "(ungrouped)", items: placed });
  };

  if (ordering.ungrouped === "first") pushUngrouped();

  for (const b of orderedBlocks) {
    /*
     * WITHIN-GROUP ORDER, seeded BY GROUP ID.
     *
     * Two independent things happen here and neither can affect the other:
     * the block's position was decided above, and its members' order is
     * decided here. That is the §18 requirement — four working combinations
     * of two switches — and it is why membership survives.
     */
    const how = b.group?.itemOrder ?? ordering.itemOrder;
    const placed = orderItems(
      b.members,
      how,
      subSeed(seed, `grp:${b.group?.id ?? "none"}`),
    );
    out.push(...placed);
    shape.push({ groupId: b.group?.id ?? null, name: b.group?.name ?? "(ungrouped)", items: placed });
  }

  if (ordering.ungrouped !== "first") pushUngrouped();

  return { items: out, blocks: shape, hiddenByGroup };
}

/* ------------------------------------------------------------------- lint */

/**
 * Problems a grouped question can have that the runtime cannot refuse.
 *
 * All of these evaluate perfectly well and produce a questionnaire that is
 * quietly wrong, which is exactly the class of thing that has to be caught by
 * reading the definition.
 */
export function lintOptionGroups(q: Question): string[] {
  const out: string[] = [];
  const groups = q.optionGroups ?? [];
  if (!groups.length) return out;

  const ids = new Set<string>();
  for (const g of groups) {
    if (ids.has(g.id)) out.push(`${q.code}: two groups share the id "${g.id}".`);
    ids.add(g.id);
    if (!g.name.trim()) out.push(`${q.code}: a group has no name, so nothing can refer to it.`);
  }

  for (const scope of ["options", "rows", "columns"] as const) {
    const scoped = groups.filter((g) => (g.scope ?? "options") === scope);
    if (!scoped.length) continue;

    const codes = new Set(
      scope === "columns"
        ? (q.columns ?? []).map((c) => c.id)
        : ((scope === "rows" ? q.rows : q.options) ?? []).map((x) => String(x.code)),
    );

    const seen = new Map<string, string>();
    for (const g of scoped) {
      for (const m of g.members) {
        const k = String(m);
        if (!codes.has(k)) {
          out.push(`${q.code}: group “${g.name}” lists ${scope.slice(0, -1)} "${k}", which no longer exists.`);
          continue;
        }
        const first = seen.get(k);
        if (first) {
          /*
           * Not a warning to be tidied away later: a duplicated member would
           * be shown twice, and only the first group's copy is kept — so the
           * question silently loses an option from the second group.
           */
          out.push(
            `${q.code}: "${k}" is in both “${first}” and “${g.name}”. `
            + `Membership is exclusive, so it will appear only in “${first}”.`,
          );
        } else {
          seen.set(k, g.name);
        }
      }
    }

    const orphans = [...codes].filter((c) => !seen.has(c));
    if (orphans.length && orphans.length < codes.size) {
      out.push(
        `${q.code}: ${orphans.length} ${scope} are in no group `
        + `(${orphans.slice(0, 5).join(", ")}${orphans.length > 5 ? ", …" : ""}) — `
        + `they will be shown together, ${q.groupOrdering?.ungrouped ?? "last"}.`,
      );
    }
  }

  /*
   * The one combination that is genuinely contradictory. A flat shuffle of the
   * whole list and a group structure cannot both hold: the shuffle would move
   * a member out of its group, which is the thing groups exist to prevent. The
   * engine resolves it by letting groups win; saying so here means a
   * programmer is not left wondering why their randomization setting appears
   * to do nothing.
   */
  if (q.randomization?.enabled && hasOptionGroups(q, q.randomization.scope)) {
    out.push(
      `${q.code}: this question has both ${q.randomization.scope} groups and flat `
      + `${q.randomization.scope} randomization. The groups win — a flat shuffle would move an item `
      + `out of its group. Set the order under Group randomization instead.`,
    );
  }

  return out;
}

/** A group's members, resolved against the current lists. For the editor. */
export function groupMembership(
  q: Question,
  scope: "options" | "rows" | "columns",
): { groupId: string; name: string; codes: string[] }[] {
  return groupsFor(q, scope).map((g) => ({
    groupId: g.id,
    name: g.name,
    codes: g.members.map(String),
  }));
}

/** Which group a code belongs to, or null. First group wins. */
export function groupOf(
  q: Question,
  scope: "options" | "rows" | "columns",
  code: string | number,
): OptionGroup | null {
  const k = String(code);
  for (const g of groupsFor(q, scope)) {
    if (g.members.some((m) => String(m) === k)) return g;
  }
  return null;
}

/** Group-level conditions, for the display-rule resolver and the linter. */
export function groupConditions(q: Question): { groupId: string; when: Condition }[] {
  return (q.optionGroups ?? [])
    .filter((g) => !!g.visibleIf)
    .map((g) => ({ groupId: g.id, when: g.visibleIf! }));
}
