/**
 * ONE EXCLUSIVE FLAG, ENFORCED WHERE IT CANNOT BE BYPASSED.
 *
 * The September 2026 review found two things about exclusivity. "None of the
 * Above", "Don't Know" and "Refused" behaved exactly like "Exclusive" — four
 * names, one behaviour, and the editor promising a difference that did not
 * exist. And on Image Multi-Select the behaviour was absent altogether,
 * because that renderer was the one selection path that never called
 * `toggleMultiValue`.
 *
 * Both are closed here: the three names fold into `exclusive` as a definition
 * is parsed, and the rule itself is checked in the engine, so it holds for a
 * renderer that forgets, a resumed session and a posted save alike.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SurveyDefinition, Option as OptionSchema, normalizeOptionFlags, RETIRED_OPTION_FLAGS,
} from "@rescript/schema";
import { createResponseState } from "./state.js";
import { validateQuestion } from "./validate.js";
import { isExclusiveOption, toggleMultiValue } from "./answers.js";

test("the three retired flags fold into `exclusive` when a definition is parsed", () => {
  for (const flag of RETIRED_OPTION_FLAGS) {
    const parsed = OptionSchema.parse({ code: 98, label: "None of these", flags: [flag] });
    assert.deepEqual(parsed.flags, ["exclusive"], `${flag} should parse as exclusive`);
  }
  /* a survey that used two of them at once does not end up with a duplicate */
  assert.deepEqual(
    normalizeOptionFlags(["anchor_bottom", "none_of_above", "dont_know", "exclusive"]),
    ["anchor_bottom", "exclusive"],
  );
  /* and nothing else is touched */
  assert.deepEqual(normalizeOptionFlags(["other_specify", "anchor_top"]), ["other_specify", "anchor_top"]);
});

test("a stored survey that used the old flags keeps working, with the same behaviour", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Old flags", version: "1.0" },
    questions: [{
      id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Which?",
      options: [
        { code: 1, label: "Tea" },
        { code: 2, label: "Coffee" },
        { code: 98, label: "None of these", flags: ["none_of_above"] },
      ],
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }],
  });
  const opts = def.questions[0].options;
  assert.deepEqual(opts[2].flags, ["exclusive"], "parsed from the stored definition, not rewritten in the database");
  assert.equal(isExclusiveOption(opts[2]), true);
  assert.deepEqual(toggleMultiValue([1, 2], 98, opts), [98], "still clears the rest, exactly as before");
});

test("an exclusive answer combined with others is refused by the engine", () => {
  /*
   * THE IMAGE-GRID BUG, ONE LAYER DOWN. `ImageSelect` now calls
   * `toggleMultiValue` like every other path, but a rule that only exists in
   * a renderer is a rule that the next renderer can forget. This is the check
   * that cannot be walked around.
   */
  const def = SurveyDefinition.parse({
    meta: { id: "s2", code: "S2", title: "Exclusive", version: "1.0" },
    questions: [{
      id: "q1", code: "Q1", variableName: "Q1", type: "image_select", text: "Which?",
      settings: { maxSelections: 3 },
      options: [
        { code: 1, label: "Tea" },
        { code: 2, label: "Coffee" },
        { code: 98, label: "None of these", flags: ["exclusive"] },
      ],
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }],
  });
  const q = def.questions[0];
  const state = createResponseState(def, { sessionId: "t", seed: 1 });
  const ctx = { def, state, loop: null };

  assert.deepEqual(validateQuestion(def, q, [1, 2], ctx as never), [], "two ordinary answers are fine");
  assert.deepEqual(validateQuestion(def, q, [98], ctx as never), [], "the exclusive one on its own is fine");

  const both = validateQuestion(def, q, [1, 98], ctx as never);
  assert.equal(both.length, 1, "holding both used to be accepted");
  assert.match(both[0].message, /None of these/, "and the message names the option, not the flag");
});
