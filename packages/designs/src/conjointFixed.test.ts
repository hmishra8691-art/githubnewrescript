import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Question } from "@rescript/schema";
import {
  applySurveyActions, coerceSurveyActions, createResponseState, flattenVariables, buildVariableDictionary, designVersionFor,
  shuffleAlternatives, validateQuestion, blockingErrors, stackedChoiceData, parseFixedAlternatives, fixedAlternativeOfRow,
} from "@rescript/engine";
import { registerBuiltinDesignGenerators, conjointPlugin, type ConjointConfig } from "./index.js";

/*
 * FIXED (CUSTOM) ALTERNATIVES IN A CBC (2026-11-10).
 *
 * Pinned, because each is a way this could quietly damage a study:
 *   - the DESIGN is untouched: the designed concepts, their balance and efficiency are exactly those of the same
 *     configuration without fixed alternatives; a configuration without them regenerates byte-identically
 *   - a fixed alternative is in every task, after the designed concepts and before None, and is never shuffled among them
 *   - it can only carry levels the design estimates; a typo is refused, not turned into a new level
 *   - "specify" text is text: its own variable, never a level, required once that alternative is chosen
 */
registerBuiltinDesignGenerators();
const ATTRS = [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Storage", levels: ["64 GB", "128 GB", "256 GB"] }, { name: "Price", levels: ["$199", "$299", "$399"] }];
const BASE: ConjointConfig = { attributes: ATTRS, tasks: 6, alternativesPerTask: 3, versions: 2, noneOption: true, method: "efficient" };
const FIXED = ["My current phone", "Beta today | Brand: Beta; Price: $299", "Another phone [specify]"];
const errs = (c: Partial<ConjointConfig>) => conjointPlugin.validateConfig!({ ...BASE, ...c });
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Phones", version: "1" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
const run = (def: SurveyDefinition, raw: unknown[]) => { const c = coerceSurveyActions(raw); assert.deepEqual(c.rejected, []); return applySurveyActions(def, c.actions, { ids, now: "2026-11-10T00:00:00.000Z" }); };
const cbc = (def: SurveyDefinition) => def.questions.find((q) => q.type === "conjoint_task")!;
const designOf = (def: SurveyDefinition, q: Question) => def.designs.find((d) => d.id === (q.settings as { designRef?: string }).designRef)!;

test("the syntax: a label, a label with levels, a label with [specify], or an object", () => {
  assert.deepEqual(parseFixedAlternatives([...FIXED, { label: "Status quo", levels: { Price: "$199" } }, "  ", { label: "" }]), [
    { label: "My current phone", levels: {}, specify: false },
    { label: "Beta today", levels: { Brand: "Beta", Price: "$299" }, specify: false },
    { label: "Another phone", levels: {}, specify: true },
    { label: "Status quo", levels: { Price: "$199" }, specify: false },
  ]);
});

test("the design is untouched: the designed concepts and every measurement are those of the plain configuration", () => {
  const plain = conjointPlugin.generate(BASE, 77);
  const withFixed = conjointPlugin.generate({ ...BASE, fixedAlternatives: FIXED }, 77);
  const designed = withFixed.rows.filter((r) => Number(r.none_option) !== 1 && !(Number(r.fixed_option) >= 1)).map(({ fixed_option: _f, ...r }) => r);
  assert.deepEqual(designed, plain.rows.filter((r) => Number(r.none_option) !== 1));
  assert.deepEqual(withFixed.summary!.efficiency, plain.summary!.efficiency);
  assert.deepEqual(withFixed.summary!.levelFrequencies, plain.summary!.levelFrequencies);
  assert.equal(plain.columns.includes("fixed_option"), false, "a design without fixed alternatives has no such column");
  assert.deepEqual(conjointPlugin.generate({ ...BASE, fixedAlternatives: [] }, 77).rows, plain.rows);
  /* every task: 3 designed, then the 3 fixed in their order, then None — numbered 1…7 */
  for (const v of [1, 2]) for (let t = 1; t <= 6; t++) {
    const task = withFixed.rows.filter((r) => r.version === v && r.task === t);
    assert.deepEqual(task.map((r) => r.alt), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(task.map((r) => [Number(r.fixed_option), Number(r.none_option)]), [[0, 0], [0, 0], [0, 0], [1, 0], [2, 0], [3, 0], [0, 1]]);
    assert.deepEqual([task[3].Brand, task[3].Storage, task[3].Price], ["", "", ""], "an alternative with no levels carries none");
    assert.deepEqual([task[4].Brand, task[4].Storage, task[4].Price], ["Beta", "", "$299"]);
  }
  assert.deepEqual((withFixed.summary!.fixedAlternatives as { label: string }[]).map((f) => f.label), ["My current phone", "Beta today", "Another phone"]);
  assert.match(String(withFixed.summary!.fixedNote), /not part of the experimental design/);
});

test("refused: a level the design does not estimate, a duplicate label, too many, two text boxes, dual-response", () => {
  assert.deepEqual(errs({ fixedAlternatives: FIXED }), []);
  assert.match(errs({ fixedAlternatives: ["Mine | Price: $249"] }).join(" "), /“\$249” is not a level of Price.*can only carry levels the design estimates/);
  assert.match(errs({ fixedAlternatives: ["Mine | Colour: Red"] }).join(" "), /“Colour” is not an attribute/);
  assert.match(errs({ fixedAlternatives: ["Mine", "mine"] }).join(" "), /each needs its own label/);
  assert.match(errs({ fixedAlternatives: ["A", "B", "C", "D", "E"] }).join(" "), /At most 4 fixed alternatives/);
  assert.match(errs({ fixedAlternatives: ["A [specify]", "B [specify]"] }).join(" "), /Only one fixed alternative can ask the respondent to specify/);
  assert.match(errs({ fixedAlternatives: ["Mine"], noneOption: false, dualResponseNone: true }).join(" "), /cannot be combined with dual-response None/);
});

test("on screen and in the data: fixed alternatives follow the shuffled concepts; the typed text is required, stored as text and exported", () => {
  const r = run(empty(), [{ op: "create_conjoint", method: "cbc", attributes: ATTRS, alternatives: 3, tasks: 4, versions: 1, none: true, seed: 5, fixedAlternatives: FIXED }]);
  assert.deepEqual(r.errors, []);
  assert.match(r.results.map((x) => x.description).join(" "), /the fixed alternative “My current phone”.*“Another phone” \(with a text box\).*not part of the design/);
  const def = r.def, q = cbc(def), d = designOf(def, q);
  const all = d.file!.rows as Record<string, unknown>[];
  const state = createResponseState(def, { seed: 31, sessionId: "s31" });
  const mine = all.filter((x) => String(x.version) === designVersionFor(q, all, 31));
  for (const t of ["1", "2", "3", "4"]) {
    const shown = shuffleAlternatives(mine.filter((x) => String(x.task) === t), 31, `${q.id}:${t}`);
    assert.deepEqual(shown.slice(3).map((x) => [Number(x.fixed_option), Number(x.none_option)]), [[1, 0], [2, 0], [3, 0], [0, 1]], "designed concepts first, then the fixed ones in order, None last");
    assert.deepEqual(shown.slice(0, 3).map((x) => Number(x.alt)).sort(), [1, 2, 3]);
  }
  assert.equal(fixedAlternativeOfRow(d.config, mine.find((x) => Number(x.fixed_option) === 3)!)!.specify, true);
  /* choosing the "specify" alternative without saying what it is is not an answer */
  const ans: Record<string, unknown> = { "1": "1", "2": "4", "3": "6", "4": "7" };
  assert.match(blockingErrors(validateQuestion(def, q, ans, { def, state })).map((e) => e.message).join(" "), /Task 3: please say what “Another phone” is/);
  ans["3_other"] = "  A refurbished Delta  ";
  assert.deepEqual(blockingErrors(validateQuestion(def, q, ans, { def, state })), []);
  state.answers[q.id] = ans;
  const flat = flattenVariables(def, state);
  assert.equal(flat[`${q.variableName}_T2`], 4);
  assert.equal(flat[`${q.variableName}_T3`], 6);
  assert.equal(flat[`${q.variableName}_T3_OTHER`], "A refurbished Delta");
  assert.equal(flat[`${q.variableName}_T3_other`], undefined, "the text is never written as a choice");
  const dict = buildVariableDictionary(def);
  assert.match(String(dict.find((x) => x.name === `${q.variableName}_T3_OTHER`)!.notes), /not an attribute level and is not in the choice model/);
  /* the stacked choice file: which rows are fixed, and the text on the chosen row only */
  const sc = stackedChoiceData(def, [{ sessionId: "s31", respondentId: "R31", seed: 31, answers: state.answers, calculated: {} }]);
  assert.deepEqual(sc.columns.slice(-3), ["fixed", "fixed_label", "other_text"]);
  const t3 = sc.rows.filter((x) => x.task === 3);
  assert.equal(t3.length, 7);
  assert.deepEqual(t3.filter((x) => x.fixed).map((x) => [x.fixed, x.fixed_label, x.chosen, x.other_text]), [[1, "My current phone", 0, ""], [2, "Beta today", 0, ""], [3, "Another phone", 1, "  A refurbished Delta  "]]);
  assert.deepEqual([t3[4].Brand, t3[4].Brand_code, t3[4].Storage_code], ["Beta", 2, 0]);
  /* update: remove them — the designed concepts stay exactly as they were */
  const off = run(def, [{ op: "update_conjoint", target: q.code, fixedAlternatives: [] }]);
  assert.deepEqual(off.errors, []);
  const d2 = designOf(off.def, cbc(off.def));
  assert.equal(d2.file!.columns.includes("fixed_option"), false);
  assert.deepEqual(d2.file!.rows, all.filter((x) => !(Number(x.fixed_option) >= 1)).map(({ fixed_option: _f, ...x }) => (Number(x.none_option) === 1 ? { ...x, alt: 4 } : x)));
  /* a plain design's dictionary has no _OTHER variable and its export no fixed columns */
  assert.ok(!buildVariableDictionary(off.def).some((x) => /_OTHER$/.test(x.name)));
});
