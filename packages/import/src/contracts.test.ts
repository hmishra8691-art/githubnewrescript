import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeImport } from "./index.js";
import { qsfFixture, DECIPHER_FIXTURE, DOC_LINES, docxFixture } from "./fixtures.js";
import { SurveyDefinition, normalizeAsParsed } from "@rescript/schema";
import { droppedFieldPaths } from "@rescript/engine";

/*
 * LAYER CONTRACT: IMPORT ↔ SCHEMA (audit 2026-11-17, P0-05).
 *
 * The importers write question objects by hand. A key the schema does not know is stripped on save, so the setting
 * silently never reaches the survey; a value the schema migrates shows the user a false "Save failed". This runs
 * every importer's fixture through the real pipeline and checks that what it produced survives the schema exactly
 * as the draft save checks it — the same comparison, so a mapper change that would trip the save fails here first.
 */
const enc = new TextEncoder();
const HEALTHCARE = "S1. Specialty?\n1. Cardiologist\n2. Oncologist\nQ1. How many patients?\nPROGRAMMER NOTE: NUMERIC, RANGE 1-999.\nQ2. Of these, how many have heart failure?\nPROGRAMMER NOTE: MUST BE LESS THAN OR EQUAL TO Q1.\nQ3. Your specialty\nPROGRAMMER NOTE: AUTO-POPULATE WITH THE ANSWER FROM S1 AND MAKE IT READ-ONLY.\nQ5. Date of interview\nPROGRAMMER NOTE: HIDDEN. PRE-FILL WITH TODAY'S DATE.\n";
const SOURCES: [string, Uint8Array][] = [
  ["survey.qsf", enc.encode(JSON.stringify(qsfFixture()))],
  ["survey.xml", enc.encode(DECIPHER_FIXTURE)],
  ["questionnaire.txt", enc.encode(DOC_LINES.join("\n"))],
  ["questionnaire.docx", docxFixture()],
  ["healthcare.txt", enc.encode(HEALTHCARE)],
];

for (const [name, bytes] of SOURCES) {
  test(`${name}: everything the importer writes survives the schema (the draft save's own check)`, async () => {
    const r = await analyzeImport(bytes, name, { surveyId: "contract" });
    const def = r.result?.def;
    assert.ok(def, `${name} produced a survey`);
    const sent = JSON.parse(JSON.stringify(def));
    const parsed = SurveyDefinition.safeParse(JSON.parse(JSON.stringify(def)));
    assert.ok(parsed.success, parsed.success ? "" : parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    assert.deepEqual(droppedFieldPaths(normalizeAsParsed(sent), parsed.data), [], `${name}: fields the schema would drop or report`);
  });
}
