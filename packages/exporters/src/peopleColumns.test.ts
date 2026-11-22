import { test } from "node:test";
import assert from "node:assert/strict";
import { readPeopleColumns } from "./peopleColumns.js";
import { prepareRespondentList } from "./respondentList.js";

const rows = (headers: string[], lines: string[][]) => lines.map((l) => Object.fromEntries(headers.map((h, i) => [h, l[i] ?? ""])));

test("the email column is found by what is in it, whatever it is called", () => {
  const h = ["Kontakt", "Abteilung", "Wer"];
  const r = readPeopleColumns(h, rows(h, [["ada@example.com", "Ops", "Ada"], ["bob@example.com", "Ops", "Bob"], ["cy@example.com", "HR", "Cy"]]));
  assert.equal(r.mapping.Kontakt, "email");
  assert.match(r.columns.find((c) => c.header === "Kontakt")!.why, /values are email addresses \(100%/);
  assert.equal(r.mapping.Abteilung, "embedded");
  assert.deepEqual(r.questions, []);
});

test("first and last name are joined first-then-last, even when the file has them the other way round", () => {
  const h = ["Surname", "First name", "Work e-mail", "Staff no."];
  const data = rows(h, [["Lovelace", "Ada", "ada@example.com", "S-1"], ["Stone", "Bob", "bob@example.com", "S-2"]]);
  const r = readPeopleColumns(h, data);
  assert.deepEqual(Object.keys(r.mapping).slice(0, 2), ["First name", "Surname"]);
  assert.equal(r.mapping["Work e-mail"], "email");
  assert.equal(r.mapping["Staff no."], "external_id");
  const people = prepareRespondentList(data, r.mapping).people;
  assert.deepEqual(people.map((p) => [p.name, p.email, p.external_id]), [["Ada Lovelace", "ada@example.com", "S-1"], ["Bob Stone", "bob@example.com", "S-2"]]);
  /* the mapping survives the trip to the browser and back with its order intact */
  assert.equal(prepareRespondentList(data, JSON.parse(JSON.stringify(r.mapping))).people[0]!.name, "Ada Lovelace");
});

test("two email columns: the likelier is the default, and the question names both", () => {
  const h = ["name", "email", "manager email"];
  const r = readPeopleColumns(h, rows(h, [["Ada", "ada@example.com", "boss@example.com"], ["Bob", "bob@example.com", "boss@example.com"]]));
  assert.equal(r.mapping.email, "email");
  assert.equal(r.mapping["manager email"], "embedded");
  assert.equal(r.questions.length, 1);
  assert.deepEqual([r.questions[0]!.field, r.questions[0]!.chosen, r.questions[0]!.options], ["email", "email", ["email", "manager email"]]);
});

test("an ID needs a heading that says so and values that tell people apart", () => {
  const h = ["email", "Phone number", "Team code", "Employee ID"];
  const r = readPeopleColumns(h, rows(h, [["a@x.io", "555-1", "T1", "E1"], ["b@x.io", "555-2", "T1", "E2"], ["c@x.io", "555-3", "T2", "E3"]]));
  assert.equal(r.mapping["Employee ID"], "external_id");
  assert.equal(r.mapping["Phone number"], "embedded", "a phone number is not who the person is");
  assert.equal(r.mapping["Team code"], "embedded", "a code shared by several people cannot identify one");
  assert.deepEqual(r.questions, []);
});

test("nothing identifies anyone: it asks instead of guessing", () => {
  const h = ["Team", "Site"];
  const r = readPeopleColumns(h, rows(h, [["Ops", "North"], ["HR", "South"]]));
  assert.ok(!Object.values(r.mapping).includes("email") && !Object.values(r.mapping).includes("external_id"));
  assert.equal(r.questions.length, 1);
  assert.equal(r.questions[0]!.chosen, null);
  assert.deepEqual(r.questions[0]!.options, ["Team", "Site"]);
});

test("the template's own headings, and an empty file with headings only", () => {
  const r = readPeopleColumns(["name", "email", "id", "department"], []);
  assert.deepEqual(r.mapping, { name: "name", email: "email", id: "external_id", department: "embedded" });
  assert.deepEqual(r.questions, []);
});

test("a name column nobody labelled is found by what is in it, and never mistaken for a department", () => {
  const h = ["Kontakt", "Wer", "Abteilung"];
  const r = readPeopleColumns(h, rows(h, [["ada@example.com", "Ada Lovelace", "Ops"], ["bob@example.com", "Bob Stone", "Ops"], ["cy@example.com", "Cy Young", "Human Resources"], ["", "Dee Paper", "Human Resources"]]));
  assert.equal(r.mapping.Wer, "name");
  assert.match(r.columns.find((c) => c.header === "Wer")!.why, /read like people's names/);
  assert.equal(r.mapping.Abteilung, "embedded", "values that repeat are not names");
  assert.deepEqual(Object.keys(r.mapping)[0], "Wer");
  /* two such columns: the first is the default and the question names both */
  const h2 = ["mail", "Employee", "Line manager"];
  const r2 = readPeopleColumns(h2, rows(h2, [["a@x.io", "Ada Lovelace", "Grace Hopper"], ["b@x.io", "Bob Stone", "Alan Turing"], ["c@x.io", "Cy Young", "Edsger Dijkstra"]]));
  assert.equal(r2.mapping.Employee, "name");
  assert.equal(r2.mapping["Line manager"], "embedded");
  assert.deepEqual(r2.questions.map((q) => [q.field, q.options]), [["name", ["Employee", "Line manager"]]]);
});
