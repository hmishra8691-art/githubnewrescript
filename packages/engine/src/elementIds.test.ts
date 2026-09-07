import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  ensureElementIds, derivedId, cellId, elementIndex, duplicateElementIds,
  lintElementIds, createScriptCtx, createResponseState,
} from "./index.js";

/**
 * STABLE IDS FOR EVERY ELEMENT (§31–49).
 *
 * The acceptance criteria are mostly about what must NOT happen: ids must
 * survive renaming, reordering, randomization and versioning. So most of these
 * tests do something destructive and then check that the ids did not move.
 */

const base = () => ({
  meta: { id: "s1", code: "S1", title: "Ids", version: "1.0" },
  questions: [
    {
      id: "q_brands", code: "Q1", variableName: "BRANDS", type: "multi_select", text: "Which?",
      options: [
        { code: "1", label: "Apple" },
        { code: "2", label: "Google" },
        { code: "3", label: "Bosch" },
      ],
      validation: [{ kind: "min_selections", value: 1 }, { kind: "max_selections", value: 2 }],
    },
    {
      id: "q_grid", code: "Q2", variableName: "GRID", type: "matrix_single", text: "Rate",
      rows: [{ code: "r1", label: "Row one" }, { code: "r2", label: "Row two" }],
      columns: [{ id: "c1", label: "Col", responseType: "text", variableStem: "COL" }],
      options: [{ code: "a", label: "A" }],
    },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q_brands", "q_grid"] },
    { type: "end", id: "e1", status: "complete" },
  ],
});

const parse = (raw: unknown) => SurveyDefinition.parse(raw);

/* ------------------------------------------------------ the schema itself */

test("A DEFINITION WITHOUT IDS STILL PARSES — a required field would take live surveys dark", () => {
  /*
   * Every definition already in the database was written without these. The
   * runtime returns null on a parse failure and the Studio refuses to open, so
   * a required id would not be a migration — it would be an outage.
   */
  const def = parse(base());
  assert.equal(def.questions[0].options[0].id, undefined, "and no id is invented at parse time");
  assert.equal(def.questions[1].rows[0].id, undefined);
});

test("PARSING DOES NOT MINT IDS — every read path parses, so a default would churn them", () => {
  /*
   * `z.string().default(() => uid())` would give a different id on every
   * parse: opening the editor, serving a respondent, running a quality check,
   * building an export. Stable is the entire point.
   */
  const a = parse(base());
  const b = parse(base());
  assert.deepEqual(
    a.questions[0].options.map((o) => o.id),
    b.questions[0].options.map((o) => o.id),
  );
});

/* ----------------------------------------------------------- the backfill */

test("the backfill fills every leaf that was missing an id", () => {
  const { def, added, clean } = ensureElementIds(parse(base()));
  assert.equal(clean, false);
  assert.equal(added.option, 4, "three brand options plus the grid's one");
  assert.equal(added.row, 2);
  assert.equal(added.validation, 2);
  for (const o of def.questions[0].options) assert.match(o.id!, /^opt_[0-9a-f]{8}$/);
  for (const r of def.questions[1].rows) assert.match(r.id!, /^row_[0-9a-f]{8}$/);
});

test("IT IS DETERMINISTIC — the same definition gives the same ids, every time and every server", () => {
  /*
   * This is not a nicety. `survey_versions.definition` is frozen by a database
   * trigger, so a published version can only be backfilled ON READ — and a
   * random id there would differ per request, breaking anything that stored
   * one. It would also change under a respondent mid-session.
   */
  const a = ensureElementIds(parse(base())).def;
  const b = ensureElementIds(parse(base())).def;
  assert.deepEqual(
    a.questions[0].options.map((o) => o.id),
    b.questions[0].options.map((o) => o.id),
  );
});

test("it is idempotent — running it twice adds nothing", () => {
  const once = ensureElementIds(parse(base()));
  const twice = ensureElementIds(once.def);
  assert.equal(twice.clean, true);
  assert.deepEqual(twice.added, {});
  assert.deepEqual(twice.def, once.def);
});

test("IT NEVER OVERWRITES AN ID THAT EXISTS", () => {
  const raw = base() as never as { questions: { options: { id?: string }[] }[] };
  raw.questions[0].options[0].id = "opt_written_by_hand";
  const { def, added } = ensureElementIds(parse(raw));
  assert.equal(def.questions[0].options[0].id, "opt_written_by_hand");
  assert.equal(added.option, 3, "only the three that had none");
});

test("ids do not collide across questions, or between two rules of one kind", () => {
  const { def } = ensureElementIds(parse(base()));
  const all = [
    ...def.questions[0].options.map((o) => o.id),
    ...def.questions[1].options.map((o) => o.id),
    ...def.questions[1].rows.map((r) => r.id),
    ...def.questions[0].validation.map((v) => v.id),
  ];
  assert.equal(new Set(all).size, all.length, `no duplicates: ${JSON.stringify(all)}`);

  /* the grid's option code "a" and the brands' "1" both exist; the question id
     is part of the derivation, so they cannot land on the same value */
  assert.notEqual(def.questions[0].options[0].id, def.questions[1].options[0].id);
});

/* ================================================== what must NOT change */

test("AN ID SURVIVES A RENAME (§44)", () => {
  const before = ensureElementIds(parse(base())).def;
  const id = before.questions[0].options[0].id;

  const renamed = JSON.parse(JSON.stringify(before));
  renamed.questions[0].options[0].label = "iPhone";
  const after = ensureElementIds(parse(renamed));

  assert.equal(after.def.questions[0].options[0].id, id);
  assert.equal(after.clean, true, "a rename does not even reach the backfill");
});

test("AN ID SURVIVES A REORDER (§45)", () => {
  const before = ensureElementIds(parse(base())).def;
  const ids = new Map(before.questions[0].options.map((o) => [o.code, o.id]));

  const reordered = JSON.parse(JSON.stringify(before));
  const opts = reordered.questions[0].options;
  reordered.questions[0].options = [opts[2], opts[0], opts[1]];
  const after = ensureElementIds(parse(reordered)).def;

  assert.deepEqual(after.questions[0].options.map((o) => o.code), ["3", "1", "2"]);
  for (const o of after.questions[0].options) {
    assert.equal(o.id, ids.get(o.code), `option ${o.code} kept its id`);
  }
});

test("AN ID SURVIVES A CODE CHANGE, once it has been written", () => {
  /*
   * The important half of the deterministic-backfill story. The id is derived
   * only while it is MISSING; once written it is data, and renumbering the
   * code afterwards does not move it. That is what makes the backfill safe
   * despite being a function of the code.
   */
  const before = ensureElementIds(parse(base())).def;
  const id = before.questions[0].options[0].id;

  const renumbered = JSON.parse(JSON.stringify(before));
  renumbered.questions[0].options[0].code = "99";
  const after = ensureElementIds(parse(renumbered)).def;

  assert.equal(after.questions[0].options[0].id, id,
    "the id is data now, not a function of the code");
});

test("an id survives a whole round trip through the schema", () => {
  const withIds = ensureElementIds(parse(base())).def;
  const reparsed = parse(JSON.parse(JSON.stringify(withIds)));
  assert.deepEqual(
    reparsed.questions[0].options.map((o) => o.id),
    withIds.questions[0].options.map((o) => o.id),
  );
});

/* --------------------------------------------------------------- cell ids */

test("a cell id is derived from its row and column, not stored (§36)", () => {
  const a = cellId("row_1", "col_1");
  assert.equal(a, cellId("row_1", "col_1"), "same inputs, same id");
  assert.notEqual(a, cellId("row_1", "col_2"));
  assert.notEqual(a, cellId("row_2", "col_1"));
  assert.match(a, /^cell_[0-9a-f]{8}$/);
});

test("derivedId is a pure function of its parts", () => {
  assert.equal(derivedId("opt", "q1", "A"), derivedId("opt", "q1", "A"));
  assert.notEqual(derivedId("opt", "q1", "A"), derivedId("opt", "q1", "B"));
  assert.notEqual(derivedId("opt", "q1", "A"), derivedId("row", "q1", "A"),
    "the prefix is part of the identity");
});

/* ----------------------------------------------------------- the index */

test("every identified element is reachable by its id", () => {
  const def = ensureElementIds(parse(base())).def;
  const index = elementIndex(def);

  const optId = def.questions[0].options[1].id!;
  assert.equal(index.get(optId)?.kind, "option");
  assert.equal(index.get(optId)?.label, "Google");
  assert.equal(index.get(optId)?.parentId, "q_brands");

  assert.equal(index.get("q_brands")?.kind, "question");
  assert.equal(index.get("p1")?.kind, "page");
  assert.equal(index.get("c1")?.kind, "column");
  assert.equal(index.get(def.questions[1].rows[0].id!)?.kind, "row");
  assert.equal(index.get("nope"), undefined);
});

test("DUPLICATE IDS ARE REPORTED, NOT SILENTLY MERGED", () => {
  /*
   * Studio's minter is `Date.now()` plus a counter that resets per page load,
   * and collaboration is on — two editors in the same millisecond can produce
   * the same id. Flow nodes were already linted for this; nothing else was.
   */
  const def = ensureElementIds(parse(base())).def;
  const clash = JSON.parse(JSON.stringify(def));
  clash.questions[0].options[1].id = clash.questions[0].options[0].id;

  const dupes = duplicateElementIds(clash);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].count, 2);
  assert.deepEqual(dupes[0].kinds, ["option"]);

  const msgs = lintElementIds(clash);
  assert.match(msgs[0], /2 elements share the id/);
  assert.match(msgs[0], /reach the wrong one/);

  assert.deepEqual(duplicateElementIds(def), [], "a clean definition is silent");
});

/* ------------------------------------------------- addressable in scripts */

test("A SCRIPT CAN ADDRESS AN ELEMENT BY ITS ID (§46)", () => {
  const def = ensureElementIds(parse(base())).def;
  const state = createResponseState(def, { seed: 1 });
  const ctx = createScriptCtx(def, state, null, { logs: [], errors: [] });

  const optId = def.questions[0].options[1].id!;
  assert.deepEqual(ctx.getOption(optId), {
    kind: "option", id: optId, code: "2", label: "Google", parentId: "q_brands",
  });
  assert.equal(ctx.getRow(def.questions[1].rows[0].id!)?.label, "Row one");
  assert.equal(ctx.getColumn("c1")?.kind, "column");
  assert.equal(ctx.getElement("p1")?.kind, "page");

  /* a question stays addressable the three ways it always was */
  assert.equal(ctx.getQuestion("q_brands")?.id, "q_brands");
  assert.equal(ctx.getQuestion("Q1")?.id, "q_brands");
  assert.equal(ctx.getQuestion("BRANDS")?.id, "q_brands");
});

test("the accessors are typed — asking for a row by an option's id returns null", () => {
  const def = ensureElementIds(parse(base())).def;
  const state = createResponseState(def, { seed: 1 });
  const ctx = createScriptCtx(def, state, null, { logs: [], errors: [] });
  const optId = def.questions[0].options[0].id!;
  assert.equal(ctx.getRow(optId), null, "an option is not a row");
  assert.ok(ctx.getOption(optId), "…but it is an option");
});

test("A SCRIPT GETS A COPY, NOT THE DEFINITION", () => {
  /*
   * A script that mutated the definition would change what every other
   * respondent on the same server sees. Handing out the live object would make
   * that a one-liner.
   */
  const def = ensureElementIds(parse(base())).def;
  const state = createResponseState(def, { seed: 1 });
  const ctx = createScriptCtx(def, state, null, { logs: [], errors: [] });
  const optId = def.questions[0].options[0].id!;

  const view = ctx.getOption(optId) as { label?: string };
  view.label = "hacked";
  assert.equal(def.questions[0].options[0].label, "Apple", "the definition is untouched");
  assert.equal(ctx.getOption(optId)?.label, "Apple");
});

/* --------------------------------------------------- nothing else moved */

test("THE BACKFILL TOUCHES NOTHING BUT IDS", () => {
  /*
   * The guarantee that matters for the rest of the platform: codes are the
   * join key for stored answers, export column names, quota cells and List
   * Fill counters, several of which live in tables nothing can rewrite. If the
   * backfill moved one, live data would stop matching its own definition.
   */
  const before = parse(base());
  const after = ensureElementIds(before).def;

  const strip = (d: unknown): unknown =>
    JSON.parse(JSON.stringify(d), (k, v) => (k === "id" && typeof v === "string" && /^(opt|row|vr|lfo|lfd|grp)_[0-9a-f]{8}$/.test(v) ? undefined : v));

  assert.deepEqual(strip(after), strip(before),
    "with the derived ids removed, the definition is byte-identical");
});

test("the input definition is not mutated", () => {
  const before = parse(base());
  ensureElementIds(before);
  assert.equal(before.questions[0].options[0].id, undefined,
    "ensureElementIds returns a new definition and leaves its argument alone");
});
