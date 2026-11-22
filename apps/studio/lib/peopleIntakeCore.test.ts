import { test } from "node:test";
import assert from "node:assert/strict";
import { listNameFromFile, manualProblems, manualToUpload, mergeRows, parseQuickPaste, previewHeadline } from "./peopleIntakeCore.ts";

test("pasted people are understood however they were copied, and nothing typed is thrown away", () => {
  assert.deepEqual(parseQuickPaste("ada@example.com\nBob Stone <BOB@example.com>\n\nCy Young, cy@example.com\ndee@example.com Dee Dee"), [
    { name: "", email: "ada@example.com", id: "" }, { name: "Bob Stone", email: "bob@example.com", id: "" },
    { name: "Cy Young", email: "cy@example.com", id: "" }, { name: "Dee Dee", email: "dee@example.com", id: "" },
  ]);
  assert.deepEqual(parseQuickPaste("a@x.org, b@x.org; \"Cee\" <c@x.org>").map((r) => [r.name, r.email]), [["", "a@x.org"], ["", "b@x.org"], ["Cee", "c@x.org"]]);
  assert.deepEqual(parseQuickPaste("Someone With No Address"), [{ name: "Someone With No Address", email: "", id: "" }]);
  assert.deepEqual(parseQuickPaste("  \n \n"), []);
  assert.equal(parseQuickPaste("end of a sentence ada@example.com.")[0]!.email, "ada@example.com");
});

test("typed rows are checked as they are typed: a bad address, the same person twice, nobody to invite", () => {
  const p = manualProblems([
    { name: "Ada", email: "ada@example.com", id: "" }, { name: "Bob", email: "bob-at-example", id: "" }, { name: "Ada 2", email: "ADA@example.com", id: "" },
    { name: "", email: "", id: "" }, { name: "Cy", email: "", id: "" }, { name: "Dee", email: "", id: "E1" }, { name: "Dee 2", email: "d2@example.com", id: "e1" },
  ]);
  assert.deepEqual(p, { 1: "This does not look like an email address.", 2: "The same email is on line 1.", 4: "Add an email or an ID, so this person can be invited and told apart.", 6: "The same ID is on line 6." });
  assert.deepEqual(manualProblems([{ name: "", email: "", id: "" }]), {}, "an empty line is not a mistake");
});

test("typed rows become the same upload a file would: three headings, blank lines dropped; pasted people are merged without repeats", () => {
  assert.deepEqual(manualToUpload([{ name: " Ada ", email: " ada@example.com ", id: "" }, { name: "", email: "", id: " " }]), { headers: ["name", "email", "id"], rows: [{ name: "Ada", email: "ada@example.com", id: "" }] });
  const merged = mergeRows([{ name: "", email: "", id: "" }, { name: "Ada", email: "ada@example.com", id: "" }], parseQuickPaste("ada@example.com\nbob@example.com"));
  assert.deepEqual(merged.map((r) => r.email), ["ada@example.com", "bob@example.com"]);
});

test("the preview says in one sentence what will happen", () => {
  const s = { read: 12, people: 10, dropped: 0, duplicatesInFile: 2, invalidEmails: 1, withEmail: 9, withExternalId: 3, embeddedFields: [] };
  assert.equal(previewHeadline(s, 3, true, "live"), "7 people will be added to the live list (2 repeated in the file, 3 already on the list left out).");
  assert.equal(previewHeadline(s, 3, false, "test"), "10 people will be added to the test list (2 repeated in the file left out).");
  assert.equal(previewHeadline({ ...s, people: 1, duplicatesInFile: 0 }, 0, true, "live"), "1 person will be added to the live list.");
  assert.equal(previewHeadline({ ...s, people: 0 }, 0, true, "live"), "There is nobody to add in this list.");
  assert.equal(listNameFromFile("spring_wave-2 staff.xlsx"), "spring wave 2 staff");
});
