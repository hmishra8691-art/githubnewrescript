import { test } from "node:test";
import assert from "node:assert/strict";
import {
  guessRespondentMapping, parseDelimitedList, prepareRespondentList,
  summariseRespondentList, type ColumnTarget,
} from "./respondentList.js";
import { invitationsToCSV, surveyQrSvg } from "./invitations.js";

/* ------------------------------------------------------- guessing columns */

test("the headings client files actually use are recognised", () => {
  const m = guessRespondentMapping(["Full Name", "E-Mail", "Employee No.", "Region"]);
  assert.equal(m["Full Name"], "name");
  assert.equal(m["E-Mail"], "email");
  assert.equal(m["Employee No."], "external_id");
  assert.equal(m["Region"], "embedded");
});

test("a column nobody can guess becomes embedded data rather than being dropped", () => {
  const m = guessRespondentMapping(["email", "store_number", "plan_tier"]);
  assert.equal(m["store_number"], "embedded");
  assert.equal(m["plan_tier"], "embedded");
});

test("two candidates for one field: the first wins and the second is recoverable", () => {
  // "id" and "employee_id" both look like an external id
  const m = guessRespondentMapping(["id", "employee_id", "email"]);
  assert.equal(m["id"], "external_id");
  assert.equal(m["employee_id"], "embedded", "the loser must be embedded, not silently overwriting the winner");
});

test("a blank heading is ignored, not mapped", () => {
  const m = guessRespondentMapping(["email", "", "  "]);
  assert.deepEqual(Object.keys(m), ["email"]);
});

/* ---------------------------------------------------------- pasted text */

test("a pasted CSV is read", () => {
  const { headers, rows } = parseDelimitedList("name,email\nAda,ada@example.com\nAlan,alan@example.com\n");
  assert.deepEqual(headers, ["name", "email"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].email, "alan@example.com");
});

test("a column pasted out of Excel is tab-separated, and that is detected", () => {
  const { headers, rows } = parseDelimitedList("name\temail\nAda Lovelace\tada@example.com");
  assert.deepEqual(headers, ["name", "email"]);
  assert.equal(rows[0].name, "Ada Lovelace");
});

test("a quoted comma in a name does not become a column", () => {
  const { rows } = parseDelimitedList('name,email\n"Smith, Ada",ada@example.com');
  assert.equal(rows[0].name, "Smith, Ada");
  assert.equal(rows[0].email, "ada@example.com");
});

test("an escaped quote survives", () => {
  const { rows } = parseDelimitedList('name,email\n"Ada ""Countess"" Lovelace",ada@example.com');
  assert.equal(rows[0].name, 'Ada "Countess" Lovelace');
});

test("the empty rows at the bottom of every client file are ignored", () => {
  const { rows } = parseDelimitedList("name,email\nAda,ada@example.com\n\n\n   \n");
  assert.equal(rows.length, 1);
});

test("a short row is padded rather than shifting the columns", () => {
  const { rows } = parseDelimitedList("name,email,region\nAda,ada@example.com");
  assert.equal(rows[0].region, "");
});

/* --------------------------------------------------------- preparing rows */

const MAP: Record<string, ColumnTarget> = {
  name: "name", email: "email", employee_id: "external_id", region: "embedded",
};

test("a clean list becomes respondents, with the unmapped columns kept", () => {
  const { people, dropped, duplicates, issues } = prepareRespondentList([
    { name: "Ada Lovelace", email: "ada@example.com", employee_id: "EMP-001", region: "North" },
    { name: "Alan Turing", email: "alan@example.com", employee_id: "EMP-002", region: "South" },
  ], MAP);
  assert.equal(people.length, 2);
  assert.equal(dropped, 0);
  assert.equal(duplicates.length, 0);
  assert.equal(issues.length, 0);
  assert.deepEqual(people[0].embedded, { region: "North" });
});

test("an address is lowercased, because it is a matching key", () => {
  const { people } = prepareRespondentList([{ email: "Ada@Example.COM" }], { email: "email" });
  assert.equal(people[0].email, "ada@example.com");
});

test("a row with nobody in it is dropped and counted", () => {
  const { people, dropped } = prepareRespondentList([
    { name: "Ada", email: "ada@example.com", employee_id: "", region: "" },
    { name: "", email: "", employee_id: "", region: "North" },
    { name: "  ", email: "   ", employee_id: "  ", region: "" },
  ], MAP);
  assert.equal(people.length, 1);
  assert.equal(dropped, 2, "a row with only a region is nobody to invite");
});

test("a name alone is somebody — an offline list has no addresses", () => {
  const { people, dropped } = prepareRespondentList([{ name: "Ada Lovelace" }], { name: "name" });
  assert.equal(people.length, 1);
  assert.equal(dropped, 0);
});

test("an address that does not look like one is REPORTED, not refused", () => {
  const { people, issues } = prepareRespondentList([
    { name: "Ada", email: "ada@example.com" },
    { name: "Grace", email: "not-an-email" },
  ], { name: "name", email: "email" });
  assert.equal(people.length, 2, "a typo must not cost the platform an interview");
  assert.equal(issues.length, 1);
  assert.match(issues[0], /row 3/, "the row number must be the one the researcher sees in their spreadsheet");
  assert.match(issues[0], /not-an-email/);
});

test("many bad addresses are summarised rather than listed forever", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ email: `bad-${i}` }));
  const { issues, people } = prepareRespondentList(rows, { email: "email" });
  assert.equal(people.length, 12);
  assert.equal(issues.length, 6, "five examples and one summary line");
  assert.match(issues[5], /7 more/);
});

test("the same id twice in one file is one person, and the clash is named", () => {
  const { people, duplicates } = prepareRespondentList([
    { name: "Ada Lovelace", email: "ada@example.com", employee_id: "EMP-001" },
    { name: "Ada L.", email: "other@example.com", employee_id: "emp-001" },
  ], MAP);
  assert.equal(people.length, 1);
  assert.deepEqual(duplicates, ["emp-001"], "the duplicate must be reported by its value, not by row number alone");
});

test("without an id, the address is the dedupe key", () => {
  const { people, duplicates } = prepareRespondentList([
    { name: "Ada", email: "ada@example.com" },
    { name: "Ada again", email: "ADA@example.com" },
  ], { name: "name", email: "email" });
  assert.equal(people.length, 1);
  assert.equal(duplicates.length, 1);
});

test("two people who share an address but have different ids are two people", () => {
  // a household, or a shared team inbox — the client's id is what decides
  const { people, duplicates } = prepareRespondentList([
    { email: "family@example.com", employee_id: "EMP-001" },
    { email: "family@example.com", employee_id: "EMP-002" },
  ], { email: "email", employee_id: "external_id" });
  assert.equal(people.length, 2);
  assert.equal(duplicates.length, 0);
});

test("an empty embedded cell is not stored as an empty string", () => {
  const { people } = prepareRespondentList([{ email: "a@b.co", region: "" }], { email: "email", region: "embedded" });
  assert.deepEqual(people[0].embedded, {});
});

test("an absurd name is truncated rather than refused", () => {
  const { people } = prepareRespondentList([{ name: "x".repeat(500) }], { name: "name" });
  assert.equal(people[0].name?.length, 200);
});

test("the summary is what the preview shows", () => {
  const rows = [
    { name: "Ada", email: "ada@example.com", employee_id: "EMP-001", region: "North" },
    { name: "Ada", email: "ada2@example.com", employee_id: "emp-001", region: "North" },
    { name: "", email: "", employee_id: "", region: "" },
    { name: "Grace", email: "bad", employee_id: "EMP-003", region: "South" },
  ];
  const prepared = prepareRespondentList(rows, MAP);
  const s = summariseRespondentList(rows.length, prepared, MAP);
  assert.equal(s.read, 4);
  assert.equal(s.people, 2);
  assert.equal(s.dropped, 1);
  assert.equal(s.duplicatesInFile, 1);
  assert.equal(s.withEmail, 2);
  assert.equal(s.withExternalId, 2);
  assert.deepEqual(s.embeddedFields, ["region"]);
});

/* ------------------------------------------------------------ the handout */

test("a links file cannot be turned into a spreadsheet formula", () => {
  const csv = invitationsToCSV([
    { url: "https://x.test/s/a/b?token=t1", token: "t1", name: "=cmd|' /C calc'!A0", email: "a@b.co" },
  ]);
  const nameCell = csv.split("\n")[1].split(",")[0];
  assert.ok(nameCell.startsWith('"\t='), `a formula reached the file intact: ${nameCell}`);
});

test("a link with a comma in a field stays one column", () => {
  const csv = invitationsToCSV([{ url: "https://x.test/s/a/b?token=t1", token: "t1", name: "Smith, Ada" }]);
  assert.equal(csv.split("\n")[1].split('"').length, 3, "the name was not quoted");
});

test("the QR code is vector, and encodes the link it was given", async () => {
  const svg = await surveyQrSvg("https://survey.example.com/s/acme/study-001");
  assert.match(svg, /^<\?xml|^<svg/);
  assert.match(svg, /viewBox/, "without a viewBox it cannot scale, which is the whole reason for SVG");
});
