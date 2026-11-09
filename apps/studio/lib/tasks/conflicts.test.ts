import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictMessage, findConflicts, stepsToRedo } from "./conflicts.ts";

const done = (stepId: string, actions: unknown[], title = stepId) => ({ stepId, status: "completed", title, output: { actions } });

test("agents in their own lanes do not conflict: different codes, different questions", () => {
  assert.deepEqual(findConflicts([
    done("b1", [{ op: "create_question", code: "Q1", text: "a" }, { op: "create_question", code: "Q2", text: "b" }]),
    done("b2", [{ op: "create_question", code: "Q3", text: "c" }]),
    done("logic", [{ op: "set_display_logic", target: "Q3" }]),
  ]), []);
});

test("two agents creating the same code, or one deleting what another edits, or both setting the same thing — each is raised with a question", () => {
  const cs = findConflicts([
    done("b1", [{ op: "create_question", code: "Q21", text: "Satisfaction" }, { op: "update_question", target: "Q5", text: "New wording A" }], "Questions Q11–Q20"),
    done("b2", [{ op: "create_question", code: "Q21", text: "Age" }, { op: "update_question", target: "Q5", text: "New wording B" }], "Questions Q21–Q30"),
    done("tidy", [{ op: "delete_question", target: "Q9" }]),
    done("logic", [{ op: "set_display_logic", target: "Q9" }]),
    { stepId: "x", status: "running", output: { actions: [{ op: "create_question", code: "Q21" }] } },
  ]);
  const by = Object.fromEntries(cs.map((c) => [c.key, c]));
  assert.equal(by["q:q21"].kind, "same_code");
  assert.deepEqual(by["q:q21"].steps.map((s) => s.stepId), ["b1", "b2"]);
  assert.match(by["q:q21"].question, /Two parts of this task both created Q21/);
  assert.equal(by["set:q5:text"].kind, "same_setting");
  assert.equal(by["q:q9"].kind, "edit_deleted");
  assert.ok(!cs.some((c) => c.steps.some((s) => s.stepId === "x")), "a step still running is not judged");
  assert.deepEqual(stepsToRedo(by["q:q21"], "b1"), ["b2"]);
  assert.match(conflictMessage([by["q:q21"]]), /^Your decision is needed: /);
});

test("a step that edits the same question twice, alone, is not a conflict with itself", () => {
  assert.deepEqual(findConflicts([done("b1", [{ op: "create_question", code: "Q1", text: "a" }, { op: "update_question", target: "Q1", text: "b" }])]), []);
});
