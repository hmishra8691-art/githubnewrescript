import test from "node:test";
import assert from "node:assert/strict";
import { buildVariableDictionary, flattenVariables } from "@rescript/engine";
import { buildMasterDemoSurvey } from "./masterDemo.js";
import { simulateRespondent } from "./simulate.js";

/**
 * THE DICTIONARY AND THE RUNTIME MUST AGREE ON EVERY COLUMN NAME.
 *
 * `buildVariableDictionary` (variables.ts) DECLARES what columns a survey
 * produces. `flattenVariables` (flatten.ts) WRITES them at interview time.
 * They are separate implementations of the same naming scheme — the suffixes
 * `_R1`, `_LAT`, `_1`, `_other` and about sixty more are spelled out inline
 * in each file — and nothing has ever checked that they match.
 *
 * The dangerous direction is a key the RUNTIME writes that the DICTIONARY
 * does not declare: every exporter builds its columns from the dictionary, so
 * that answer is collected, stored, and then silently absent from the
 * delivered file. Nobody finds out from the platform; they find out from the
 * client.
 *
 * This test exists because the next change to either file — including making
 * these suffixes configurable — needs something that fails when they drift.
 * It runs against the master demo, which carries one question of nearly every
 * type, and a simulated respondent who answers all of them.
 */

/** Columns the dictionary adds that no answer can fill — these are expected. */
const SYSTEM_COLUMNS = new Set([
  "RESP_ID", "SESSION_ID", "SURVEY_VERSION", "START_TIME", "END_TIME", "STATUS",
]);

function parity(naming?: Record<string, string>) {
  const def = buildMasterDemoSurvey();
  if (naming) (def as any).variableNaming = naming;
  const sim = simulateRespondent(def, { seed: 20260920, answers: {} });
  const declared = new Set(buildVariableDictionary(def).map((v) => v.name));
  const written = new Set(Object.keys(flattenVariables(def, sim.state as any, {})));
  return { def, sim, declared, written };
}

test("the master demo actually exercises the naming scheme", () => {
  /*
   * A guard on the guard. If the fixture ever stopped covering the question
   * types, or the simulation stopped answering them, the parity assertions
   * below would pass by having almost nothing to compare.
   */
  const { def, declared, written } = parity();
  const types = new Set(def.questions.map((q) => q.type));
  assert.ok(types.size >= 25, `the fixture must cover a wide range of types, got ${types.size}`);
  assert.ok(declared.size >= 150, `the dictionary should be substantial, got ${declared.size}`);
  assert.ok(written.size >= 50, `the simulation must actually answer things, got ${written.size}`);
});

test("every column the runtime writes is declared in the dictionary", () => {
  /*
   * THE ONE THAT MATTERS. Every exporter takes its columns from the
   * dictionary, so a name the runtime writes and the dictionary does not
   * declare is an answer that is collected and then never delivered.
   */
  const { def, declared, written } = parity();

  /*
   * Three categories are written and deliberately not declared. Each is
   * listed with its reason rather than tolerated by a percentage, so that a
   * NEW undeclared column fails this test instead of hiding inside a margin.
   */
  const byDesign = (name: string): string | null => {
    // 1. The bare column of a multiple response holds the list of codes the
    //    respondent picked. The analysable form is the per-option 0/1 flags,
    //    which ARE declared, so nothing is lost by leaving the list out of
    //    the dictionary — it would be a delimited string no package can
    //    tabulate.
    const owner = def.questions.find((q) => q.variableName === name);
    if (owner && ["multi_select", "multi_dropdown", "image_select", "ranking", "image_ranking"].includes(owner.type)) {
      return "the list form of a multiple response; the per-option flags carry it";
    }
    // 2. Values a CUSTOM SCRIPT invents with setCalc(). The dictionary is
    //    derived statically from the questionnaire and cannot know what a
    //    script will create at runtime — the name can be built from a string.
    //    Declaring these would mean executing scripts to build a dictionary.
    if ((def.scripts ?? []).some((sc) => sc.code.includes(`'${name}'`) || sc.code.includes(`"${name}"`))) {
      return "created at runtime by a custom script, so no static dictionary can declare it";
    }
    // 3. Masking diagnostics — how a list was built, for debugging a survey,
    //    not an answer anybody analyses.
    if (/^MASK_[A-Z0-9_]+_(COUNT|LIST|SOURCE|OPERATION)$/.test(name)) {
      return "a masking diagnostic, not a response";
    }
    return null;
  };

  const unexpected = [...written].filter((n) => !declared.has(n) && !SYSTEM_COLUMNS.has(n) && !byDesign(n));
  assert.deepEqual(
    unexpected, [],
    `these columns are written at interview time but not declared, so they would reach no export:\n  ${unexpected.join("\n  ")}`,
  );
});

test("the by-design exclusions are still the ones we think they are", () => {
  /*
   * A guard on the allowlist above. If a category empties out, the reason no
   * longer applies and the exclusion should go — an allowlist nobody revisits
   * is how the next real gap gets absorbed silently.
   */
  const { def, declared, written } = parity();
  const undeclared = [...written].filter((n) => !declared.has(n) && !SYSTEM_COLUMNS.has(n));
  const multiLists = undeclared.filter((n) => def.questions.some((q) => q.variableName === n));
  const scriptMade = undeclared.filter((n) => (def.scripts ?? []).some((sc) => sc.code.includes(`'${n}'`)));
  const maskDiag = undeclared.filter((n) => /^MASK_/.test(n));

  assert.ok(multiLists.length > 0, "the fixture should still contain a multiple response");
  assert.ok(scriptMade.length > 0, "and a script that invents a value");
  assert.ok(maskDiag.length > 0, "and a masked question");
  assert.equal(
    multiLists.length + scriptMade.length + maskDiag.length, undeclared.length,
    `every undeclared column must fall into a known category; unaccounted: ${undeclared.filter((n) => !multiLists.includes(n) && !scriptMade.includes(n) && !maskDiag.includes(n)).join(", ")}`,
  );
});

test("the dictionary does not declare columns the runtime cannot produce", () => {
  /*
   * The other direction is less dangerous — an empty column in a delivery
   * rather than a missing one — but it is still a disagreement between the
   * two files, and it is how the first direction starts.
   *
   * Loop iterations are the legitimate exception: the dictionary declares
   * `Q7_1 … Q7_N` for the most iterations the definition ALLOWS, so that the
   * export has the same columns before the first respondent and after the
   * last, while one respondent only fills the iterations they actually saw.
   * Those are identified by the dictionary itself, via `iteration`.
   */
  const { def, declared, written } = parity();
  const dict = buildVariableDictionary(def);
  const loopScoped = new Set(dict.filter((v) => v.iteration !== undefined || v.loopId).map((v) => v.name));

  const unfilled = [...declared].filter(
    (n) => !written.has(n) && !SYSTEM_COLUMNS.has(n) && !loopScoped.has(n),
  );

  /*
   * A question the respondent never reached also declares columns nothing
   * fills, which is correct behaviour rather than drift. So this asserts a
   * PROPORTION rather than zero: a sudden jump means the two files have
   * stopped agreeing, which is what this is watching for.
   */
  const ratio = unfilled.length / declared.size;
  assert.ok(
    ratio < 0.5,
    `${unfilled.length} of ${declared.size} declared columns were never written (${Math.round(ratio * 100)}%). ` +
      `A large share usually means the dictionary and the runtime have drifted apart:\n  ${unfilled.slice(0, 40).join("\n  ")}`,
  );
});

test("no column name is declared twice", () => {
  /*
   * Two entries with one name is a column that silently loses one of its
   * meanings in every export, and the exporters de-duplicate by name.
   */
  const def = buildMasterDemoSurvey();
  const names = buildVariableDictionary(def).map((v) => v.name);
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const n of names) {
    if (seen.has(n)) dupes.push(n);
    seen.add(n);
  }
  assert.deepEqual(dupes, [], `duplicated column names: ${dupes.join(", ")}`);
});


/* ------------------------------- the same guarantee under a custom scheme */

/*
 * A derived-suffix template renames hundreds of columns at once, across both
 * the file that declares them and the file that writes them. Running the
 * parity check again under a NON-DEFAULT scheme is what makes that safe to
 * offer: if either file were still composing a name its own way, the two
 * would disagree the moment the pattern stopped being `{base}_{code}`.
 */
const COMPACT = { option: "{base}r{code}", row: "{base}r{row}", cell: "{base}r{row}c{column}", index: "{base}_{n}" };

test("a custom suffix scheme reaches the runtime, not just the dictionary", () => {
  const plain = parity();
  const compact = parity(COMPACT);

  assert.notDeepEqual([...compact.declared].sort(), [...plain.declared].sort(),
    "the scheme must actually change the dictionary, or this test proves nothing");
  assert.notDeepEqual([...compact.written].sort(), [...plain.written].sort(),
    "and it must change what the runtime writes — if only the dictionary moved, every export would be empty");

  // the shapes must match: the same number of columns, just spelled differently
  assert.equal(compact.declared.size, plain.declared.size, "a rename must not gain or lose columns");
  assert.equal(compact.written.size, plain.written.size);
});

test("every column the runtime writes is declared, under a custom scheme too", () => {
  /*
   * The same assertion as the default case, and the one that would fail if a
   * suffix were still spelled out inline in one file.
   */
  const { def, declared, written } = parity(COMPACT);
  const owned = new Set(def.questions.map((q) => q.variableName));
  const undeclared = [...written].filter(
    (n) =>
      !declared.has(n) &&
      !SYSTEM_COLUMNS.has(n) &&
      !owned.has(n) &&                                   // the list form of a multiple response
      !/^MASK_/.test(n) &&                               // masking diagnostics
      !(def.scripts ?? []).some((sc) => sc.code.includes(`'${n}'`)),
  );
  assert.deepEqual(undeclared, [],
    `under a custom suffix scheme these are written but not declared:\n  ${undeclared.join("\n  ")}`);
});

test("the compact scheme produces the names it promises", () => {
  const { declared } = parity(COMPACT);
  assert.ok([...declared].some((n) => /r\d+$/.test(n)),
    `expected compact names like Q1r1, got e.g. ${[...declared].slice(0, 8).join(", ")}`);
  assert.ok(![...declared].some((n) => /^DEVICES_\d+$/.test(n)),
    "and none of the default underscore spellings should remain");
});
