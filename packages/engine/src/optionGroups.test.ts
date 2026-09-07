import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import type { OptionGroup } from "@rescript/schema";
import {
  createResponseState, effectiveQuestion, setAnswer,
  orderItems, orderWithGroups, hasOptionGroups, groupOf, lintOptionGroups,
} from "./index.js";
import { cond } from "@rescript/schema";

/**
 * HIERARCHICAL GROUPS AND INDEPENDENT RANDOMIZATION (§13–30).
 *
 * The invariant every test here exists to defend:
 *
 *     AN ITEM NEVER LEAVES ITS GROUP.
 *
 * That is a property of the algorithm, not of the input — groups move as whole
 * blocks and members are ordered inside a block, so there is no step at which
 * a member and a non-member are in the same array being shuffled. The tests
 * that matter most run all four switch combinations over many seeds and check
 * membership after every one.
 */

const GROUP_A: OptionGroup = {
  id: "grp_a", name: "Smartphones", scope: "options",
  members: ["a1", "a2", "a3"],
};
const GROUP_B: OptionGroup = {
  id: "grp_b", name: "Computers", scope: "options",
  members: ["b1", "b2", "b3"],
};

function survey(over: Record<string, unknown> = {}) {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Groups", version: "1.0" },
    questions: [
      {
        id: "q_gate", code: "Q0", variableName: "GATE", type: "single_select", text: "Continue?",
        options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }],
      },
      {
        id: "q_prod", code: "Q1", variableName: "PROD", type: "multi_select",
        text: "Which do you use?",
        options: [
          { code: "a1", label: "Apple" }, { code: "a2", label: "Samsung" }, { code: "a3", label: "Google" },
          { code: "b1", label: "Dell" }, { code: "b2", label: "HP" }, { code: "b3", label: "Lenovo" },
        ],
        optionGroups: [GROUP_A, GROUP_B],
        ...over,
      },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q_gate", "q_prod"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });
}

const shown = (def: ReturnType<typeof survey>, seed: number, answers: Record<string, unknown> = {}) => {
  const state = createResponseState(def, { seed });
  for (const [k, v] of Object.entries(answers)) setAnswer(def, state, k, v);
  const view = effectiveQuestion(def.questions[1], { def, state, loop: null } as never);
  return view.options.map((o) => String(o.code));
};

/** Which group each code belongs to, as a string, for membership assertions. */
const shape = (codes: string[]) => codes.map((c) => c[0]).join("");

/* ------------------------------------------------------------ the basics */

test("groups are detected per scope, and membership is resolvable", () => {
  const def = survey();
  const q = def.questions[1];
  assert.equal(hasOptionGroups(q, "options"), true);
  assert.equal(hasOptionGroups(q, "rows"), false, "no row groups on this question");
  assert.equal(groupOf(q, "options", "a2")?.id, "grp_a");
  assert.equal(groupOf(q, "options", "b3")?.id, "grp_b");
  assert.equal(groupOf(q, "options", "nope"), null);
});

test("with everything fixed, the list is the groups in declaration order", () => {
  /*
   * Grouping applies even with no randomization: "Group A then Group B" is the
   * presented structure a programmer asked for, not a randomization setting.
   */
  assert.deepEqual(shown(survey(), 1), ["a1", "a2", "a3", "b1", "b2", "b3"]);
});

test("A GROUP STRUCTURE REORDERS AN INTERLEAVED LIST INTO BLOCKS", () => {
  const def = survey();
  const raw = JSON.parse(JSON.stringify(def));
  /* declared interleaved — the group structure has to gather them */
  raw.questions[1].options = [
    { code: "a1", label: "Apple" }, { code: "b1", label: "Dell" },
    { code: "a2", label: "Samsung" }, { code: "b2", label: "HP" },
    { code: "a3", label: "Google" }, { code: "b3", label: "Lenovo" },
  ];
  assert.deepEqual(shown(SurveyDefinition.parse(raw), 1), ["a1", "a2", "a3", "b1", "b2", "b3"]);
});

/* ====================================== the four independent combinations */

const combos: [string, string, string][] = [
  ["fixed", "fixed", "groups fixed, items fixed"],
  ["random", "fixed", "groups random, items fixed"],
  ["fixed", "random", "groups fixed, items random"],
  ["random", "random", "groups random, items random"],
];

for (const [groupOrder, itemOrder, name] of combos) {
  test(`MEMBERSHIP SURVIVES: ${name}`, () => {
    const def = survey({ groupOrdering: { groupOrder, itemOrder, ungrouped: "last" } });
    for (let seed = 1; seed <= 40; seed++) {
      const codes = shown(def, seed);
      assert.equal(codes.length, 6, `all six options shown at seed ${seed}`);
      /*
       * The invariant, checked directly: the six codes must form two
       * contiguous runs of three, one all "a" and one all "b". Any leakage
       * between groups breaks this immediately.
       */
      const s = shape(codes);
      assert.ok(s === "aaabbb" || s === "bbbaaa",
        `seed ${seed} kept the groups intact, got ${codes.join(",")} (${s})`);
    }
  });
}

test("groups fixed + items fixed is deterministic and unshuffled", () => {
  const def = survey({ groupOrdering: { groupOrder: "fixed", itemOrder: "fixed", ungrouped: "last" } });
  for (let seed = 1; seed <= 10; seed++) {
    assert.deepEqual(shown(def, seed), ["a1", "a2", "a3", "b1", "b2", "b3"]);
  }
});

test("GROUPS RANDOM + ITEMS FIXED: the blocks move, the members do not", () => {
  const def = survey({ groupOrdering: { groupOrder: "random", itemOrder: "fixed", ungrouped: "last" } });
  const orders = new Set<string>();
  for (let seed = 1; seed <= 60; seed++) {
    const codes = shown(def, seed);
    orders.add(codes.join(","));
    /* whichever block came first, its members are still 1,2,3 in order */
    assert.ok(
      codes.join(",") === "a1,a2,a3,b1,b2,b3" || codes.join(",") === "b1,b2,b3,a1,a2,a3",
      `items stayed in declared order within their block: ${codes.join(",")}`,
    );
  }
  assert.equal(orders.size, 2, "both group orders occur across a sample");
});

test("GROUPS FIXED + ITEMS RANDOM: the members move, the blocks do not", () => {
  const def = survey({ groupOrdering: { groupOrder: "fixed", itemOrder: "random", ungrouped: "last" } });
  const withinA = new Set<string>();
  for (let seed = 1; seed <= 60; seed++) {
    const codes = shown(def, seed);
    assert.equal(shape(codes), "aaabbb", `A always precedes B: ${codes.join(",")}`);
    withinA.add(codes.slice(0, 3).join(","));
  }
  assert.ok(withinA.size > 1, `the members of A really are shuffled: ${[...withinA].join(" | ")}`);
});

test("the two switches are seeded independently — one group's order does not follow the other's", () => {
  const def = survey({ groupOrdering: { groupOrder: "fixed", itemOrder: "random", ungrouped: "last" } });
  let differed = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const codes = shown(def, seed);
    /* the digit, not the group letter — "a1" -> "1" */
    const a = codes.slice(0, 3).map((c) => c[1]).join("");
    const b = codes.slice(3).map((c) => c[1]).join("");
    if (a !== b) differed++;
  }
  assert.ok(differed > 20,
    `two groups with the same strategy get different permutations (${differed}/60 differed)`);
});

/* ------------------------------------------------- a group may override */

test("A GROUP CAN ORDER ITS OWN MEMBERS DIFFERENTLY FROM THE REST", () => {
  const def = survey({
    groupOrdering: { groupOrder: "fixed", itemOrder: "fixed", ungrouped: "last" },
    optionGroups: [
      { ...GROUP_A, itemOrder: "flip" },
      GROUP_B,
    ],
  });
  assert.deepEqual(shown(def, 1), ["a3", "a2", "a1", "b1", "b2", "b3"],
    "A is reversed; B keeps its declared order");
});

/* --------------------------------------------------------- the strategies */

const items = [
  { code: "3", label: "Cherry", order: 2, priority: 1 },
  { code: "1", label: "apple", order: 3, priority: 5 },
  { code: "10", label: "Banana", order: 1, priority: 3 },
];
const codesOf = (list: { code: string | number }[]) => list.map((i) => String(i.code));

test("fixed keeps declaration order", () => {
  assert.deepEqual(codesOf(orderItems(items, "fixed", 1)), ["3", "1", "10"]);
});

test("FLIP always reverses; FLIP_RANDOM reverses about half the time", () => {
  assert.deepEqual(codesOf(orderItems(items, "flip", 1)), ["10", "1", "3"]);
  assert.deepEqual(codesOf(orderItems(items, "flip", 999)), ["10", "1", "3"],
    "…and does not depend on the seed");

  let reversed = 0;
  for (let s = 1; s <= 200; s++) {
    if (codesOf(orderItems(items, "flip_random", s))[0] === "10") reversed++;
  }
  assert.ok(reversed > 60 && reversed < 140, `roughly half of 200 respondents: ${reversed}`);
});

test("ROTATION advances the start position, and every item takes a turn", () => {
  const five = ["A", "B", "C", "D", "E"].map((c) => ({ code: c, label: c }));
  const firsts = new Set<string>();
  for (let s = 1; s <= 200; s++) firsts.add(codesOf(orderItems(five, "rotate", s))[0]);
  assert.equal(firsts.size, 5, "every item starts first for some respondent");

  /* and it is a rotation, not a shuffle: the cyclic order never changes */
  for (let s = 1; s <= 50; s++) {
    const got = codesOf(orderItems(five, "rotate", s)).join("");
    assert.ok("ABCDEABCDE".includes(got), `${got} is a rotation of ABCDE`);
  }
});

test("ALPHABETICAL sorts by the label a respondent reads, case-insensitively", () => {
  assert.deepEqual(codesOf(orderItems(items, "alpha_asc", 1)), ["1", "10", "3"],
    "apple, Banana, Cherry");
  assert.deepEqual(codesOf(orderItems(items, "alpha_desc", 1)), ["3", "10", "1"]);
});

test("alphabetical ignores markup — <b>Apple</b> sorts under A, not under <", () => {
  const marked = [
    { code: "x", label: "<em>Zebra</em>" },
    { code: "y", label: "<b>Apple</b>" },
  ];
  assert.deepEqual(codesOf(orderItems(marked, "alpha_asc", 1)), ["y", "x"]);
});

test("NUMERIC sorts by the code as a number, and non-numeric codes sort last both ways", () => {
  assert.deepEqual(codesOf(orderItems(items, "numeric_asc", 1)), ["1", "3", "10"],
    "1, 3, 10 — not the string order 1, 10, 3");
  assert.deepEqual(codesOf(orderItems(items, "numeric_desc", 1)), ["10", "3", "1"]);

  const mixed = [{ code: "2" }, { code: "other" }, { code: "1" }];
  assert.deepEqual(codesOf(orderItems(mixed, "numeric_asc", 1)), ["1", "2", "other"]);
  assert.deepEqual(codesOf(orderItems(mixed, "numeric_desc", 1)), ["2", "1", "other"],
    "“other” stays last rather than jumping to the front");
});

test("CUSTOM uses each item's own order; PRIORITY is highest-first and stable", () => {
  assert.deepEqual(codesOf(orderItems(items, "custom", 1)), ["10", "3", "1"]);
  assert.deepEqual(codesOf(orderItems(items, "priority", 1)), ["1", "10", "3"]);

  const ties = [{ code: "a", priority: 1 }, { code: "b", priority: 1 }, { code: "c", priority: 9 }];
  assert.deepEqual(codesOf(orderItems(ties, "priority", 1)), ["c", "a", "b"],
    "equal priorities keep declaration order");
});

test("ALPHABETICAL WITHIN A GROUP DOES NOT FLATTEN ACROSS GROUPS (§23)", () => {
  const def = survey({
    groupOrdering: { groupOrder: "fixed", itemOrder: "alpha_asc", ungrouped: "last" },
    optionGroups: [
      { id: "grp_a", name: "A", scope: "options", members: ["a3", "a1", "a2"] },
      { id: "grp_b", name: "B", scope: "options", members: ["b3", "b1", "b2"] },
    ],
  });
  /* A: Apple(a1), Google(a3), Samsung(a2) — B: Dell(b1), HP(b2), Lenovo(b3) */
  assert.deepEqual(shown(def, 1), ["a1", "a3", "a2", "b1", "b2", "b3"]);
  /* if it had flattened, Apple/Dell/Google/HP/Lenovo/Samsung would interleave */
  assert.equal(shape(shown(def, 1)), "aaabbb");
});

/* ------------------------------------------------------- anchors and flags */

test("AN ANCHOR IS A STATEMENT ABOUT THE SCREEN, NOT ABOUT A GROUP", () => {
  /*
   * An anchored "None of the above" belongs at the bottom of the QUESTION.
   * Anchoring it within whichever group happens to hold it would put it in the
   * middle of the list, which is not what anchoring has ever meant here.
   */
  const def = survey({
    groupOrdering: { groupOrder: "random", itemOrder: "random", ungrouped: "last" },
    options: [
      { code: "a1", label: "Apple" }, { code: "a2", label: "Samsung" }, { code: "a3", label: "Google" },
      { code: "b1", label: "Dell" }, { code: "b2", label: "HP" }, { code: "b3", label: "Lenovo" },
      { code: "none", label: "None of these", flags: ["anchor_bottom"] },
    ],
    optionGroups: [GROUP_A, { ...GROUP_B, members: ["b1", "b2", "b3", "none"] }],
  });
  for (let seed = 1; seed <= 30; seed++) {
    const codes = shown(def, seed);
    assert.equal(codes[codes.length - 1], "none", `anchored last at seed ${seed}: ${codes.join(",")}`);
  }
});

test("an always_hide member is dropped, wherever its group ends up", () => {
  const def = survey({
    options: [
      { code: "a1", label: "Apple" }, { code: "a2", label: "Samsung", logic: { visibility: "always_hide" } },
      { code: "a3", label: "Google" },
      { code: "b1", label: "Dell" }, { code: "b2", label: "HP" }, { code: "b3", label: "Lenovo" },
    ],
  });
  const codes = shown(def, 1);
  assert.ok(!codes.includes("a2"));
  assert.equal(codes.length, 5);
});

/* -------------------------------------------------------- group-level logic */

test("GROUP-LEVEL LOGIC HIDES EVERY MEMBER (§27)", () => {
  const def = survey({
    optionGroups: [
      GROUP_A,
      { ...GROUP_B, visibleIf: cond.rule("q_gate", "eq", 1) },
    ],
  });
  assert.deepEqual(shown(def, 1, { q_gate: 1 }), ["a1", "a2", "a3", "b1", "b2", "b3"]);
  assert.deepEqual(shown(def, 1, { q_gate: 2 }), ["a1", "a2", "a3"],
    "the whole of Group B is gone");
});

test("ALWAYS SHOW SURVIVES A HIDDEN GROUP — the precedence rule, in force", () => {
  /*
   * The same precedence Always Show already has against a mask. A programmer
   * who marks "Other" as Always Show has said it must never be filtered away,
   * and a group switch is a filter.
   */
  const def = survey({
    options: [
      { code: "a1", label: "Apple" }, { code: "a2", label: "Samsung" }, { code: "a3", label: "Google" },
      { code: "b1", label: "Dell" }, { code: "b2", label: "HP" },
      { code: "b3", label: "Other", logic: { visibility: "always_show" } },
    ],
    optionGroups: [GROUP_A, { ...GROUP_B, visibleIf: cond.rule("q_gate", "eq", 1) }],
  });
  assert.deepEqual(shown(def, 1, { q_gate: 2 }), ["a1", "a2", "a3", "b3"],
    "B is hidden, but its Always Show member stays");
});

/* ---------------------------------------------------------- odd shapes */

test("MEMBERSHIP IS EXCLUSIVE — a code in two groups appears once, in the first", () => {
  const def = survey({
    optionGroups: [
      { id: "grp_a", name: "A", scope: "options", members: ["a1", "a2", "b1"] },
      { id: "grp_b", name: "B", scope: "options", members: ["b1", "b2", "b3"] },
    ],
  });
  const codes = shown(def, 1);
  assert.equal(codes.filter((c) => c === "b1").length, 1, "shown once, not twice");
  assert.equal(codes.indexOf("b1"), 2, "in group A, which claimed it first");
});

test("an item in no group is kept with the others, last by default", () => {
  const def = survey({
    optionGroups: [{ id: "grp_a", name: "A", scope: "options", members: ["a1", "a2"] }],
  });
  const codes = shown(def, 1);
  assert.deepEqual(codes.slice(0, 2), ["a1", "a2"]);
  assert.deepEqual(codes.slice(2), ["a3", "b1", "b2", "b3"], "the ungrouped four, in order, last");
});

test("ungrouped items can be put first instead", () => {
  const def = survey({
    groupOrdering: { groupOrder: "fixed", itemOrder: "fixed", ungrouped: "first" },
    optionGroups: [{ id: "grp_a", name: "A", scope: "options", members: ["a1", "a2"] }],
  });
  assert.deepEqual(shown(def, 1), ["a3", "b1", "b2", "b3", "a1", "a2"]);
});

test("a group listing a deleted member simply has fewer members", () => {
  const def = survey({
    optionGroups: [
      { id: "grp_a", name: "A", scope: "options", members: ["a1", "gone", "a2"] },
      GROUP_B,
    ],
  });
  assert.deepEqual(shown(def, 1), ["a1", "a2", "b1", "b2", "b3", "a3"],
    "a3 was in no group, so it goes last");
});

test("an empty group contributes nothing and breaks nothing", () => {
  const def = survey({
    optionGroups: [{ id: "grp_e", name: "Empty", scope: "options", members: [] }, GROUP_A, GROUP_B],
  });
  assert.deepEqual(shown(def, 1), ["a1", "a2", "a3", "b1", "b2", "b3"]);
});

test("orderWithGroups reports the blocks it built, for the debugger", () => {
  const res = orderWithGroups(
    [{ code: "a1" }, { code: "a2" }, { code: "b1" }, { code: "z" }],
    [GROUP_A, GROUP_B],
    { groupOrder: "fixed", itemOrder: "fixed", ungrouped: "last" },
    1,
  );
  assert.deepEqual(res.items.map((i) => i.code), ["a1", "a2", "b1", "z"]);
  assert.deepEqual(res.blocks.map((b) => b.name), ["Smartphones", "Computers", "(ungrouped)"]);
  assert.deepEqual(res.blocks[2].items.map((i) => i.code), ["z"]);
});

/* ------------------------------------------------------------------ lint */

test("the lint catches a member in two groups, and says which one wins", () => {
  const def = survey({
    optionGroups: [
      { id: "grp_a", name: "Phones", scope: "options", members: ["a1", "b1"] },
      { id: "grp_b", name: "Computers", scope: "options", members: ["b1", "b2"] },
    ],
  });
  const problems = lintOptionGroups(def.questions[1]);
  assert.ok(problems.some((p) => /both “Phones” and “Computers”/.test(p)), problems.join(" | "));
  assert.ok(problems.some((p) => /only in “Phones”/.test(p)));
});

test("the lint catches a member that no longer exists", () => {
  const def = survey({
    optionGroups: [{ id: "grp_a", name: "A", scope: "options", members: ["a1", "ghost"] }],
  });
  const problems = lintOptionGroups(def.questions[1]);
  assert.ok(problems.some((p) => /"ghost", which no longer exists/.test(p)), problems.join(" | "));
});

test("THE LINT EXPLAINS WHY A FLAT RANDOMIZATION SETTING APPEARS TO DO NOTHING", () => {
  /*
   * Groups win over a flat shuffle — they have to, because a flat shuffle
   * would move a member out of its group. Without this message a programmer
   * sets "randomize options", sees a fixed order, and concludes the feature is
   * broken.
   */
  const def = survey({
    randomization: { enabled: true, scope: "options", method: "shuffle" },
  });
  const problems = lintOptionGroups(def.questions[1]);
  assert.ok(problems.some((p) => /The groups win/.test(p)), problems.join(" | "));
  assert.ok(problems.some((p) => /would move an item out of its group/.test(p)));

  /* and it really does win */
  for (let seed = 1; seed <= 20; seed++) {
    assert.equal(shape(shown(def, seed)), "aaabbb");
  }
});

test("the lint reports partly-grouped lists, and says where the rest will go", () => {
  const def = survey({
    optionGroups: [{ id: "grp_a", name: "A", scope: "options", members: ["a1"] }],
  });
  const problems = lintOptionGroups(def.questions[1]);
  assert.ok(problems.some((p) => /5 options are in no group/.test(p)), problems.join(" | "));
  assert.ok(problems.some((p) => /shown together, last/.test(p)));
});

test("a fully grouped question with no problems lints silently", () => {
  assert.deepEqual(lintOptionGroups(survey().questions[1]), []);
});

/* ---------------------------------------------- the seed key, not the index */

test("REORDERING GROUPS DOES NOT RE-SHUFFLE THE MEMBERS", () => {
  /*
   * The bug in the anonymous predecessor: `Randomization.groups` seeded each
   * group's shuffle with its ARRAY INDEX, so moving a group in the editor
   * silently re-randomized every respondent already in field. A real group has
   * an id, and the id is the seed key.
   */
  const a = survey({
    groupOrdering: { groupOrder: "fixed", itemOrder: "random", ungrouped: "last" },
    optionGroups: [GROUP_A, GROUP_B],
  });
  const b = survey({
    groupOrdering: { groupOrder: "fixed", itemOrder: "random", ungrouped: "last" },
    optionGroups: [GROUP_B, GROUP_A],
  });

  for (let seed = 1; seed <= 30; seed++) {
    const fromA = shown(a, seed);
    const fromB = shown(b, seed);
    /* the blocks swapped places, but each block's internal order is identical */
    assert.deepEqual(fromA.slice(0, 3), fromB.slice(3), `group A's members at seed ${seed}`);
    assert.deepEqual(fromA.slice(3), fromB.slice(0, 3), `group B's members at seed ${seed}`);
  }
});

/* ------------------------------------------------------------ grid groups */

test("THE SAME MODEL GROUPS GRID ROWS (§26)", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s2", code: "S2", title: "Grid groups", version: "1.0" },
    questions: [{
      id: "q_grid", code: "Q1", variableName: "GRID", type: "matrix_single", text: "Rate each",
      rows: [
        { code: "pa", label: "Product A" }, { code: "pb", label: "Product B" },
        { code: "pc", label: "Product C" }, { code: "pd", label: "Product D" },
      ],
      options: [{ code: "1", label: "Poor" }, { code: "2", label: "Good" }],
      optionGroups: [
        { id: "g_own", name: "Ours", scope: "rows", members: ["pc", "pd"] },
        { id: "g_riv", name: "Theirs", scope: "rows", members: ["pa", "pb"] },
      ],
      groupOrdering: { groupOrder: "fixed", itemOrder: "flip", ungrouped: "last" },
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q_grid"] }, { type: "end", id: "e", status: "complete" }],
  });
  const state = createResponseState(def, { seed: 7 });
  const view = effectiveQuestion(def.questions[0], { def, state, loop: null } as never);
  assert.deepEqual(view.rows.map((r) => String(r.code)), ["pd", "pc", "pb", "pa"],
    "Ours first, then Theirs, each reversed within itself");
  /* and the options are untouched — a row group is not an option group */
  assert.deepEqual(view.options.map((o) => String(o.code)), ["1", "2"]);
});

test("a row group does not affect columns, and vice versa", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s3", code: "S3", title: "Scoped", version: "1.0" },
    questions: [{
      id: "q_tab", code: "Q1", variableName: "TAB", type: "composite", text: "Fill in",
      rows: [{ code: "r1", label: "R1" }, { code: "r2", label: "R2" }],
      columns: [
        { id: "cA", label: "A", responseType: "text", variableStem: "A" },
        { id: "cB", label: "B", responseType: "text", variableStem: "B" },
      ],
      optionGroups: [{ id: "g_cols", name: "Cols", scope: "columns", members: ["cB", "cA"] }],
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q_tab"] }, { type: "end", id: "e", status: "complete" }],
  });
  const state = createResponseState(def, { seed: 3 });
  const view = effectiveQuestion(def.questions[0], { def, state, loop: null } as never);
  assert.deepEqual(view.columns.map((c) => c.id), ["cB", "cA"], "the column group ordered them");
  assert.deepEqual(view.rows.map((r) => String(r.code)), ["r1", "r2"], "rows untouched");
});

/* ----------------------------------------------- nothing else changed */

test("A QUESTION WITH NO GROUPS BEHAVES EXACTLY AS BEFORE", () => {
  /*
   * The regression guard for the whole feature. `optionGroups` defaults to an
   * empty array on every question in the platform, and an empty array must be
   * indistinguishable from the feature not existing.
   */
  const def = survey({ optionGroups: [] });
  assert.equal(hasOptionGroups(def.questions[1], "options"), false);
  assert.deepEqual(shown(def, 1), ["a1", "a2", "a3", "b1", "b2", "b3"]);

  const shuffled = survey({
    optionGroups: [],
    randomization: { enabled: true, scope: "options", method: "shuffle" },
  });
  const orders = new Set<string>();
  for (let seed = 1; seed <= 30; seed++) orders.add(shown(shuffled, seed).join(","));
  assert.ok(orders.size > 5, "flat randomization still randomizes when there are no groups");
});

test("the legacy Randomization.groups field still works when there are no real groups", () => {
  /*
   * The anonymous predecessor is still honoured — surveys in field use it, and
   * breaking them to make room for the better version would be exactly the
   * regression this work was not allowed to cause.
   */
  const def = survey({
    optionGroups: [],
    randomization: {
      enabled: true, scope: "options", method: "shuffle",
      groups: [["a1", "a2", "a3"], ["b1", "b2", "b3"]],
    },
  });
  for (let seed = 1; seed <= 20; seed++) {
    assert.equal(shape(shown(def, seed)), "aaabbb",
      "the old code-groups keep their members together too");
  }
});
