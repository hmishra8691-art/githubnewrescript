import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { usedNames, copyNames, renameImpact, applyRename, buildVariableDictionary } from "./index.js";

/**
 * DUPLICATING A QUESTION MUST NOT PRODUCE A DUPLICATE VARIABLE NAME.
 *
 * Both duplicate paths in the Studio appended `_COPY` unconditionally, so
 * duplicating the SAME question twice produced two questions sharing a code
 * and a variable name. That is a blocking problem at the publish gate, which
 * means the survey could no longer be versioned or tested at all — and because
 * the Studio rendered the gate's refusal as a vanishing toast, it surfaced to
 * the programmer as "your latest changes could not be saved, please retry".
 * The duplication was the cause; the save message was the symptom.
 */

const survey = () =>
  SurveyDefinition.parse({
    meta: { id: "svy", code: "S", title: "T" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "How old?" },
      { id: "q2", code: "Q2", variableName: "Q2", type: "numeric", text: "How many?" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e1", status: "complete" }],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

test("duplicating the same question twice gives two different names", () => {
  const def = survey();
  const taken = usedNames(def);
  const first = copyNames(taken, { code: "Q1", variableName: "Q1" });
  const second = copyNames(taken, { code: "Q1", variableName: "Q1" });

  assert.equal(first.variableName, "Q1_COPY");
  assert.equal(second.variableName, "Q1_COPY_2", "the second copy collided with the first — the reported bug");
  assert.notEqual(first.code, second.code);
});

test("the code and the variable name take the same suffix", () => {
  const taken = usedNames(survey());
  const a = copyNames(taken, { code: "Q1", variableName: "Q1" });
  assert.equal(a.code, a.variableName, "they start equal and a programmer expects them to stay in step");
  const b = copyNames(taken, { code: "Q1", variableName: "Q1" });
  assert.equal(b.code, b.variableName);

  /*
   * The case that separates "one suffix for both" from "number them
   * independently": here the CODE `Q1_COPY` is taken and the variable name
   * `Q1_COPY` is not. Advancing only the one that collided would give a copy
   * coded Q1_COPY_2 with the variable name Q1_COPY — two fields that no longer
   * agree, on a question where they started identical.
   */
  const def = survey();
  def.questions.push({ ...def.questions[0], id: "q9", code: "Q1_COPY", variableName: "UNRELATED" } as never);
  const c = copyNames(usedNames(def), { code: "Q1", variableName: "Q1" });
  assert.equal(c.code, c.variableName, `code ${c.code} and variable ${c.variableName} drifted apart`);
});

test("a copy whose code and variable name differ still avoids both collisions", () => {
  /*
   * Code and variable name are separate fields and need not match. When they
   * differ, checking only one of them for a collision is not enough: here
   * `QA_COPY` is already taken as a code while `VB_COPY` is free, so a check
   * that looked only at the variable name would accept the pair and mint a
   * second question coded QA_COPY.
   */
  const def = survey();
  def.questions.push({ ...def.questions[0], id: "qa", code: "QA", variableName: "VB" } as never);
  def.questions.push({ ...def.questions[0], id: "qx", code: "QA_COPY", variableName: "UNRELATED_2" } as never);
  const name = copyNames(usedNames(def), { code: "QA", variableName: "VB" });
  assert.notEqual(name.code, "QA_COPY", "the copy's code collided with an existing code");
  assert.equal(name.code, "QA_COPY_2");
  assert.equal(name.variableName, "VB_COPY_2", "both fields advance together");
});

test("duplicating a copy keeps the convention and stays unique", () => {
  const taken = usedNames(survey());
  const copy = copyNames(taken, { code: "Q1", variableName: "Q1" });        // Q1_COPY
  const copyOfCopy = copyNames(taken, copy);                                 // Q1_COPY_COPY
  assert.equal(copyOfCopy.variableName, "Q1_COPY_COPY");
  assert.notEqual(copyOfCopy.variableName, copy.variableName);
});

test("a copy never lands on a name another question already uses", () => {
  /*
   * The collision does not have to come from a copy. A programmer who has
   * already hand-named something `Q1_COPY` must not have it silently shadowed.
   */
  const def = survey();
  def.questions.push({ ...def.questions[0], id: "q3", code: "Q1_COPY", variableName: "Q1_COPY" } as never);
  const name = copyNames(usedNames(def), { code: "Q1", variableName: "Q1" });
  assert.equal(name.variableName, "Q1_COPY_2");
});

test("codes and variable names are one namespace", () => {
  /*
   * `getQuestionByCodeOrVar` resolves both, so a copy's code may not land on a
   * name already in use even when that name is only a CODE. The question added
   * here deliberately has a free variable name and a taken code: a uniqueness
   * check that tracked only variable names would hand the copy `Q1_COPY` and
   * produce two questions with the same code.
   */
  const def = survey();
  def.questions.push({ ...def.questions[0], id: "q3", code: "Q1_COPY", variableName: "UNRELATED" } as never);
  const name = copyNames(usedNames(def), { code: "Q1", variableName: "Q1" });
  assert.notEqual(name.code, "Q1_COPY", "the copy's code collided with an existing question's code");
  assert.equal(name.code, "Q1_COPY_2");
});

test("reserved system columns are never handed out", () => {
  const taken = usedNames(survey());
  for (const reserved of ["RESP_ID", "SESSION_ID", "STATUS"]) {
    assert.ok(taken.has(reserved), `${reserved} must be treated as taken`);
  }
});

test("a whole block of copies gets distinct names from one shared set", () => {
  // the block path mints every copy before any is in the definition, so the
  // set has to be shared or every question in the block gets the same suffix
  const taken = usedNames(survey());
  const a = copyNames(taken, { code: "Q1", variableName: "Q1" });
  const b = copyNames(taken, { code: "Q2", variableName: "Q2" });
  const c = copyNames(taken, { code: "Q1", variableName: "Q1" });
  const names = [a, b, c].map((x) => x.variableName);
  assert.equal(new Set(names).size, 3, `names collided: ${names.join(", ")}`);
});

test("the duplicated survey has no duplicate variables — the gate's own check", () => {
  /*
   * The end-to-end assertion: build the variable dictionary the publish gate
   * builds, over a survey with two copies of the same question, and confirm
   * nothing is exported twice.
   */
  const def = survey();
  const taken = usedNames(def);
  for (let i = 0; i < 3; i++) {
    const n = copyNames(taken, { code: "Q1", variableName: "Q1" });
    def.questions.push({ ...def.questions[0], id: `c${i}`, code: n.code, variableName: n.variableName } as never);
  }
  const names = buildVariableDictionary(def).map((v) => v.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes, [], `the dictionary exports these twice: ${dupes.join(", ")}`);
});

test("a manual rename still refuses a name that is already taken", () => {
  // requirement 4: the manual path must reject a collision rather than accept it
  const def = survey();
  const verdict = renameImpact(def, "Q1", "Q2");
  assert.equal(verdict.ok, false, "renaming Q1 onto Q2 must be refused");
  assert.ok(verdict.blockers.length > 0);
});

test("a manual rename propagates, so nothing is left naming the old variable", () => {
  // requirement 3: the new name must be reflected everywhere
  const def = survey();
  const renamed = applyRename(def, "Q1", "AGE_YEARS", {});
  const names = buildVariableDictionary(renamed).map((v) => v.name);
  assert.ok(names.includes("AGE_YEARS"), "the new name should be in the dictionary");
  assert.ok(!names.includes("Q1"), "the old name should be gone from the dictionary");
});
