import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { SurveyDefinition } from "@rescript/schema";
import { buildVariableDictionary, createResponseState, runCalculations } from "@rescript/engine";
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

/* ============================================================ loops (§37, §38) */

function loopSurvey() {
  return SurveyDefinition.parse({
    meta: { id: "sl", code: "SL", title: "Loop export", version: "1.0" },
    questions: [
      { id: "q2", code: "Q2", variableName: "Q2", type: "multi_select", text: "Brands",
        options: [{ code: 1, label: "Apple" }, { code: 3, label: "Google" }, { code: 5, label: "Xiaomi" }] },
      { id: "q7", code: "Q7", variableName: "Q7", type: "numeric", text: "Rate {{loop.label}}" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q2"] },
      {
        type: "loop", id: "LOOP_001", loopVar: "brand",
        source: { kind: "question", questionId: "q2", filter: "selected" },
        references: {
          columns: [{ name: "Brand_Nickname" }, { name: "Product_ID" }, { name: "Category" }],
          values: {
            "1": { Brand_Nickname: "APPLE", Product_ID: "PROD_001", Category: "Smartphone" },
            "3": { Brand_Nickname: "GOOGLE", Product_ID: "PROD_003", Category: "Smartphone" },
            "5": { Brand_Nickname: "XIAOMI", Product_ID: "PROD_005", Category: "Smartphone" },
          },
        },
        children: [{ type: "page", id: "p7", questionIds: ["q7"] }],
      },
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

test("§37: the XLSX dictionary gains a Loops sheet relating Loop → Item → Reference → Question", async () => {
  const buf = await exportVariableDictionaryXlsx(loopSurvey());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const sheet = wb.getWorksheet("Loops");
  assert.ok(sheet, "a survey with a loop has a Loops sheet");
  const header = (sheet!.getRow(1).values as unknown[]).slice(1);
  assert.deepEqual(header, [
    "Loop ID", "Loop", "Source", "Iteration", "Item", "Item Code", "Reference Column", "Reference Value",
    "Reference Type", "Question Variable", "Data Type", "Loop Variable",
  ]);
  const rows: unknown[][] = [];
  sheet!.eachRow((r, i) => { if (i > 1) rows.push((r.values as unknown[]).slice(1)); });
  const apple = rows.find((r) => r[3] === 1 && r[6] === "Product_ID");
  assert.ok(apple, "iteration 1 has a Product_ID row");
  assert.equal(apple![0], "LOOP_001");
  assert.equal(apple![5], "1", "position 1 in source order is Apple");
  assert.equal(apple![7], "PROD_001");
  assert.equal(apple![9], "Q7_1", "and names the question variable for that iteration");
  assert.equal(apple![11], "LOOP_BRAND_ITEM_1_PRODUCT_ID");
  assert.ok(rows.some((r) => r[11] === "LOOP_BRAND_COUNT"));

  // the Variables sheet carries the scope columns too
  const vars = wb.getWorksheet("Variables")!;
  const vh = (vars.getRow(1).values as unknown[]).slice(1);
  assert.ok(vh.includes("Loop") && vh.includes("Iteration") && vh.includes("Reference"));

  // and a survey with no loop still exports exactly the three sheets it always did
  const plain = SurveyDefinition.parse({ meta: { id: "p", code: "P", title: "P", version: "1.0" }, questions: [], flow: [] });
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(await exportVariableDictionaryXlsx(plain) as any);
  assert.deepEqual(wb2.worksheets.map((w) => w.name), ["Variables", "Survey", "Questions"]);
});

test("loop iterations reach the CSV — which they never did before", () => {
  const def = loopSurvey();
  const state = createResponseState(def, { seed: 1 });
  state.answers.q2 = [3, 5];
  runCalculations(def, state, "on_change");
  state.answers["q7@3"] = 8;
  state.answers["q7@5"] = 2;
  const csv = responsesToCSV(def, [state]);
  const [header, row] = csv.trim().split("\n").map((l) => l.split(","));
  const col = (name: string) => row[header.indexOf(name)];
  assert.ok(header.includes("Q7_1") && header.includes("Q7_2") && header.includes("Q7_3"), "positional columns are declared");
  assert.equal(col("Q7_1"), "8", "Google ran first (source order of the selected)");
  assert.equal(col("Q7_2"), "2");
  assert.equal(col("Q7_3"), "", "an unfilled position is empty, not missing");
  assert.equal(col("LOOP_BRAND_ITEM_1_CODE"), "3");
  assert.equal(col("LOOP_BRAND_ITEM_1_BRAND_NICKNAME"), "GOOGLE");
  assert.equal(col("LOOP_BRAND_COUNT"), "2");
});

test("§38: the JSON export carries the loop with its references, self-contained, and nothing on Q2", () => {
  const def = loopSurvey();
  const json = JSON.parse(JSON.stringify(def));
  const loop = json.flow.find((n: any) => n.type === "loop");
  assert.deepEqual(loop.references.columns.map((c: any) => c.name), ["Brand_Nickname", "Product_ID", "Category"]);
  assert.equal(loop.references.values["1"].Product_ID, "PROD_001");
  const q2 = json.questions.find((q: any) => q.id === "q2");
  assert.equal(JSON.stringify(q2).includes("PROD_001"), false, "the source question carries none of it");
  // and it round-trips through the schema unchanged
  assert.deepEqual(SurveyDefinition.parse(json).flow, def.flow);
});
