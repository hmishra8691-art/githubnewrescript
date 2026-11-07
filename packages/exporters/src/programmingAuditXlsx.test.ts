import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { programmingAuditXlsx } from "./index.js";

test("the audit log opens as a sheet: header, one row per finding, formula-looking text kept as text, an About sheet", async () => {
  const buf = await programmingAuditXlsx([
    { severity: "Critical", category: "Invalid reference", location: "Q1", object: "displayLogic", issue: "=References “ghost”", expected: "e", actual: "a", correction: "c", check: "logic" },
    { severity: "Medium", category: "Layout", location: "Q2", object: "settings", issue: "Column layout set", expected: "e", actual: "a", correction: "c", check: "logic" },
  ], { surveyTitle: "Car study", surveyCode: "CAR", version: "1.2" });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.getWorksheet("Programming audit")!;
  assert.deepEqual((ws.getRow(1).values as any[]).slice(1), ["#", "Severity", "Category", "Location", "Object", "Issue", "Expected behaviour", "Actual behaviour", "Recommended correction", "Status"]);
  assert.equal(ws.rowCount, 3);
  assert.equal(ws.getRow(2).getCell(6).value, "'=References “ghost”");
  assert.equal(ws.getRow(3).getCell(10).value, "Open");
  assert.match(String(wb.getWorksheet("About")!.getRow(5).getCell(2).value), /^2 — Critical 1 · High 0 · Medium 1 · Low 0$/);
});
