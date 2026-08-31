import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary } from "@rescript/engine";
import {
  exportVariableDictionaryXlsx,
  exportSurveyJson,
  importSurveyJson,
  responsesToCSV,
  variableDictionaryToCSV,
  type ResponseStateLike,
} from "./index.js";

function makeSurvey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: {
      id: "svy_test",
      code: "TEST_001",
      title: "Exporter Test Survey",
      version: "1.2",
      status: "testing",
    },
    questions: [
      {
        id: "q_gender",
        code: "Q1",
        variableName: "GENDER",
        type: "single_select",
        text: "<p>What is your <b>gender</b>?</p>",
        required: true,
        options: [
          { code: "1", label: "Male" },
          { code: "2", label: "Female" },
        ],
      },
      {
        id: "q_brands",
        code: "Q2",
        variableName: "BRANDS",
        type: "multi_select",
        text: "Which brands do you know?",
        options: [
          { code: "1", label: "Brand A" },
          { code: "2", label: "Brand B" },
          { code: "3", label: "Brand C" },
        ],
      },
      {
        id: "q_age",
        code: "Q3",
        variableName: "AGE",
        type: "numeric",
        text: "How old are you?",
      },
      {
        id: "q_rating",
        code: "Q4",
        variableName: "RATE",
        type: "composite",
        text: "Rate each brand",
        columns: [
          {
            id: "c1",
            label: "Rating",
            responseType: "numeric",
            variableStem: "RATING",
            options: [],
            validation: [],
          },
        ],
        rows: [{ code: "1", label: "Brand A", flags: [] }],
      },
    ],
    flow: [
      {
        type: "page",
        id: "p1",
        questionIds: ["q_gender", "q_brands", "q_age", "q_rating"],
      },
    ],
  });
}

function makeState(overrides?: Partial<ResponseStateLike>): ResponseStateLike {
  return {
    sessionId: "sess_001",
    respondentId: "resp_001",
    surveyVersion: "1.2",
    startedAt: "2026-01-15T10:00:00.000Z",
    status: "complete",
    answers: {
      q_gender: "1",
      q_brands: ["1", "3"],
      q_age: 42,
      q_rating: { "1": { c1: 9 } },
    },
    embedded: {},
    calculated: {},
    ...overrides,
  };
}

test("xlsx export produces a non-empty zip buffer", async () => {
  const def = makeSurvey();
  const buf = await exportVariableDictionaryXlsx(def);
  assert.ok(buf.length > 0, "buffer should be non-empty");
  // PK zip magic
  assert.equal(buf[0], 0x50);
  assert.equal(buf[1], 0x4b);
});

test("xlsx Variables sheet has one row per dictionary variable", async () => {
  const def = makeSurvey();
  const dict = buildVariableDictionary(def);
  const buf = await exportVariableDictionaryXlsx(def);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const sheet = wb.getWorksheet("Variables");
  assert.ok(sheet, "Variables sheet should exist");

  let dataRows = 0;
  sheet!.eachRow((_row, rowNumber) => {
    if (rowNumber > 1) dataRows++;
  });
  assert.equal(dataRows, dict.length);

  // other sheets exist too
  assert.ok(wb.getWorksheet("Survey"));
  assert.ok(wb.getWorksheet("Questions"));

  // Questions sheet text is HTML-stripped
  const qSheet = wb.getWorksheet("Questions")!;
  const q1Text = qSheet.getRow(2).getCell(5).value;
  assert.equal(q1Text, "What is your gender?");
});

test("JSON round-trip preserves meta and question count", () => {
  const def = makeSurvey();
  const text = exportSurveyJson(def);
  const back = importSurveyJson(text);
  assert.deepEqual(back.meta, def.meta);
  assert.equal(back.questions.length, def.questions.length);
  assert.deepEqual(back, def);
});

test("importSurveyJson throws readable errors on garbage", () => {
  assert.throws(() => importSurveyJson("not json at all {{{"), /not valid JSON/);
  assert.throws(
    () => importSurveyJson(JSON.stringify({ meta: { id: 123 } })),
    /does not match the survey schema/,
  );
});

test("responsesToCSV: header plus one line per state, values in the right columns", () => {
  const def = makeSurvey();
  const states = [
    makeState(),
    makeState({
      sessionId: "sess_002",
      respondentId: undefined,
      status: "in_progress",
      answers: { q_gender: "2", q_brands: ["2"], q_age: 30, q_rating: {} },
    }),
  ];
  const csv = responsesToCSV(def, states);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines.length, 3, "header + one line per state");

  const header = lines[0].split(",");
  assert.deepEqual(header.slice(0, 5), [
    "RESP_ID",
    "SESSION_ID",
    "SURVEY_VERSION",
    "START_TIME",
    "STATUS",
  ]);

  // dictionary order of non-system variables
  const expectedVars = buildVariableDictionary(def)
    .filter((v) => v.responseType !== "system")
    .map((v) => v.name);
  assert.deepEqual(header.slice(5), expectedVars);

  const col = (name: string) => header.indexOf(name);
  assert.ok(col("GENDER") >= 5);
  assert.ok(col("BRANDS_1") >= 5);
  assert.ok(col("AGE") >= 5);
  assert.ok(col("RATING_1") >= 5);

  const row1 = lines[1].split(",");
  assert.equal(row1[0], "resp_001");
  assert.equal(row1[1], "sess_001");
  assert.equal(row1[2], "1.2");
  assert.equal(row1[3], "2026-01-15T10:00:00.000Z");
  assert.equal(row1[4], "complete");
  assert.equal(row1[col("GENDER")], "1");
  assert.equal(row1[col("BRANDS_1")], "1");
  assert.equal(row1[col("BRANDS_2")], "0");
  assert.equal(row1[col("BRANDS_3")], "1");
  assert.equal(row1[col("AGE")], "42");
  assert.equal(row1[col("RATING_1")], "9");

  const row2 = lines[2].split(",");
  assert.equal(row2[0], "", "missing respondentId exports empty");
  assert.equal(row2[1], "sess_002");
  assert.equal(row2[4], "in_progress");
  assert.equal(row2[col("GENDER")], "2");
  assert.equal(row2[col("BRANDS_1")], "0");
  assert.equal(row2[col("BRANDS_2")], "1");
  assert.equal(row2[col("AGE")], "30");
  assert.equal(row2[col("RATING_1")], "", "unanswered composite cell is empty");
});

test("responsesToCSV quotes values containing commas and quotes", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "svy_q", title: "Quoting" },
    questions: [
      {
        id: "q_txt",
        code: "Q1",
        variableName: "COMMENT",
        type: "open_text",
        text: "Comments?",
      },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_txt"] }],
  });
  const state = makeState({
    answers: { q_txt: 'I said "hello, world"' },
  });
  const csv = responsesToCSV(def, [state]);
  assert.ok(csv.includes('"I said ""hello, world"""'));
});

test("variableDictionaryToCSV lists every variable", () => {
  const def = makeSurvey();
  const dict = buildVariableDictionary(def);
  const csv = variableDictionaryToCSV(def);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines.length, dict.length + 1);
  assert.ok(lines[0].startsWith("Variable,Label,Question"));
  // value labels rendered as "1=Male; 2=Female"
  assert.ok(csv.includes("1=Male; 2=Female"));
});
