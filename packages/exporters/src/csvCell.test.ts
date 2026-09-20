import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell, csvRow, needsFormulaGuard } from "./csvCell.js";
import { responsesToCSV } from "./csv.js";
import { invitationsToCSV } from "./invitations.js";
import { SurveyDefinition } from "@rescript/schema";

/*
 * Y1 — FORMULA INJECTION.
 *
 * The guard existed only in invitations.ts. The response export — the file
 * that actually reaches the client — quoted its cells per RFC 4180 and
 * nothing more, which does not help at all: the spreadsheet's parser eats
 * the quotes and then evaluates the cell.
 */

const ATTACKS = [
  '=1+1',
  '=cmd|\' /C calc\'!A0',
  '+1+1',
  '@SUM(1:2)',
  '-1+1+cmd|\' /C calc\'!A0',   // the classic guard bypass: starts numeric, is not a number
  '-Ann',
  '=HYPERLINK("http://evil","click")',
  '\tleading tab',
  '\rleading cr',
];

test("every formula trigger is neutralised", () => {
  for (const a of ATTACKS) {
    assert.equal(needsFormulaGuard(a), true, `unguarded: ${JSON.stringify(a)}`);
    const out = csvCell(a);
    /* the payload is still legible, it just cannot be the first character */
    const body = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
    assert.equal(body, `\t${a}`, `expected a tab prefix, got ${JSON.stringify(out)}`);
  }
});

test("a plain number is left alone, sign and all", () => {
  /*
   * This is the half that the naive `/^[=+\-@\t\r]/` guard gets wrong, and
   * getting it wrong is not cosmetic: a -5..+5 scale exported as text does
   * not tabulate, does not mean-average, and does not import into SPSS as a
   * scale. The corruption the guard exists to prevent, self-inflicted.
   */
  for (const n of ["-5", "+3", "-0.5", "-447700900000", "+1.2e-7", "-.25", "0", "12"]) {
    assert.equal(needsFormulaGuard(n), false, `a number was treated as a formula: ${n}`);
    assert.equal(csvCell(n), n, `a number was rewritten: ${n}`);
  }
});

test("ordinary text is untouched, and RFC-4180 quoting still applies", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell(""), "");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell(["a", "b"]), "a|b");
  assert.equal(csvRow(["a", "b,c"]), 'a,"b,c"');
});

test("a tab-guarded cell is quoted, so the tab survives the round trip", () => {
  /*
   * Without the \t in the quoting test the prefix would be written bare into
   * a tab-delimited-ish cell and a reader could split on it. Quoting keeps
   * the value one field.
   */
  const out = csvCell("=1+1");
  assert.equal(out, '"\t=1+1"');
});

/* ------------------------------------------- the two exports that ship it */

const DEF = SurveyDefinition.parse({
  meta: { id: "svy_inj", title: "Injection" },
  questions: [
    { id: "q_txt", code: "Q1", variableName: "OPEN", type: "open_text", text: "Anything else?" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_txt"] }],
});

test("the RESPONSE export guards respondent-typed text", () => {
  const csv = responsesToCSV(DEF, [{
    sessionId: "sess1", respondentId: "r1", surveyVersion: 1,
    startedAt: "2026-01-01T00:00:00Z", status: "complete",
    answers: { q_txt: "=cmd|' /C calc'!A0" }, embedded: {}, calculated: {},
  } as any]);
  assert.match(csv, /"\t=cmd/, `the open end went out unguarded:\n${csv}`);
  assert.doesNotMatch(csv, /,=cmd/, "a formula reached the file");
});

test("the RESPONDENT LIST export still guards, after moving to the shared cell", () => {
  const csv = invitationsToCSV([{
    name: "-Ann", email: "=1+1", externalId: "@x", url: "https://e/x", token: "t",
  } as any]);
  assert.match(csv, /"\t-Ann"/, csv);
  assert.match(csv, /"\t=1\+1"/, csv);
  assert.match(csv, /"\t@x"/, csv);
});
