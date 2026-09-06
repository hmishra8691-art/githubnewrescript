import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { parseSpreadsheet } from "./spreadsheetImport.js";

/**
 * The importer's job is to read the file a client actually sends, which is
 * rarely a tidy CSV: it is a workbook with a title above the table, a second
 * sheet of notes, dates as dates, and a formula or two.
 */

async function workbook(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("a workbook with a title and a blank line still finds its header row", async () => {
  const buf = await workbook((wb) => {
    const ws = wb.addWorksheet("Responses");
    ws.addRow(["Fieldwork export — Q3"]);
    ws.addRow([]);
    ws.addRow(["respondent_code", "Q1", "Q2"]);
    ws.addRow(["RESP_000001", 9, "Great service"]);
    ws.addRow(["RESP_000002", 3, ""]);
    ws.addRow([]);
  });
  const out = await parseSpreadsheet(buf);
  assert.equal(out.sheetName, "Responses");
  assert.deepEqual(out.headers, ["respondent_code", "Q1", "Q2"]);
  assert.equal(out.rows.length, 2, "the trailing blank row is not a response");
  assert.equal(out.rows[0].Q1, 9);
  assert.equal(out.rows[1].Q2, "");
});

test("a date stays the date that was typed", async () => {
  const buf = await workbook((wb) => {
    const ws = wb.addWorksheet("S");
    ws.addRow(["code", "started"]);
    ws.addRow(["R1", new Date(Date.UTC(2026, 5, 14))]);
  });
  const out = await parseSpreadsheet(buf);
  assert.equal(out.rows[0].started, "2026-06-14",
    "a timezone shift here silently moves someone's date by a day");
});

test("a formula cell imports its result, not its formula", async () => {
  const buf = await workbook((wb) => {
    const ws = wb.addWorksheet("S");
    ws.addRow(["code", "total"]);
    const row = ws.addRow(["R1", null]);
    row.getCell(2).value = { formula: "1+2", result: 3 } as never;
  });
  const out = await parseSpreadsheet(buf);
  assert.equal(out.rows[0].total, 3);
});

test("the sheet can be chosen, and every sheet is named for the picker", async () => {
  const buf = await workbook((wb) => {
    wb.addWorksheet("Data").addRow(["a"]);
    const notes = wb.addWorksheet("Notes");
    notes.addRow(["heading"]);
    notes.addRow(["something"]);
  });
  const first = await parseSpreadsheet(buf);
  assert.equal(first.sheetName, "Data");
  assert.deepEqual(first.sheetNames, ["Data", "Notes"]);

  const chosen = await parseSpreadsheet(buf, { sheet: "Notes" });
  assert.equal(chosen.sheetName, "Notes");
  assert.deepEqual(chosen.headers, ["heading"]);
  assert.equal(chosen.rows.length, 1);
});

test("two columns with the same heading are refused, by name", async () => {
  const buf = await workbook((wb) => {
    const ws = wb.addWorksheet("S");
    ws.addRow(["code", "Q1", "Q1"]);
    ws.addRow(["R1", 1, 2]);
  });
  await assert.rejects(() => parseSpreadsheet(buf), /more than one column called “Q1”/);
});

test("an empty sheet and a missing sheet each say which", async () => {
  const empty = await workbook((wb) => { wb.addWorksheet("Blank"); });
  await assert.rejects(() => parseSpreadsheet(empty, { sheet: "Blank" }), /“Blank” is empty/);
  await assert.rejects(() => parseSpreadsheet(empty, { sheet: "Nope" }), /no sheet called “Nope”/);
});

test("the path the API takes — base64 in, rows out", async () => {
  /*
   * The Studio posts a workbook as base64 and the route rebuilds a Buffer
   * from it, so that exact hop is what is worth pinning: a parser that only
   * accepts an ArrayBuffer would typecheck and fail in production.
   */
  const buf = await workbook((wb) => {
    const ws = wb.addWorksheet("S");
    ws.addRow(["respondent_code", "Q1"]);
    ws.addRow(["RESP_000001", 7]);
  });
  const base64 = buf.toString("base64");
  const out = await parseSpreadsheet(Buffer.from(base64, "base64"));
  assert.deepEqual(out.headers, ["respondent_code", "Q1"]);
  assert.equal(out.rows[0].Q1, 7);
});

test("something that is not a workbook fails with a message, not a stack", async () => {
  await assert.rejects(
    () => parseSpreadsheet(Buffer.from("not a workbook", "utf8")),
    (e: Error) => typeof e.message === "string" && e.message.length > 0,
  );
});
