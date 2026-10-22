import { test } from "node:test";
import assert from "node:assert/strict";
import { cvaStudy, menuStudy, spec } from "./fixture.js";
import { runAnalysis } from "../analyses/index.js";
import { buildSimulatorPptx, buildSimulatorXlsx, simulatorReport } from "../export/conjointSimulator.js";
import { checkOfficeFile } from "../export/officeCheck.js";
import { unzipEntries } from "../export/docxCheck.js";

/** the simulator's tables to Excel (one sheet each) and PowerPoint (one slide each), through the platform's writers */
test("simulator exports: a valid workbook and deck carrying the simulator tables", async () => {
  const s = cvaStudy({ n: 60 });
  const r = runAnalysis({ name: "CVA simulator", kind: "conjoint", dataset: spec, variables: ["CVA"], options: { simulator: { products: [{ name: "Ours", levels: { Brand: "Alpha", Screen: "7in", Battery: "2 days", Storage: "128 GB" } }, { name: "Rival", levels: { Brand: "Beta", Screen: "6in", Battery: "3 days", Storage: "64 GB" } }], rule: "btl", sensitivity: true } } }, s.ds);
  const rep = simulatorReport(r);
  assert.ok(rep.blocks.some((b) => (b as { tableId?: string }).tableId === "sim_shares") && rep.blocks.some((b) => (b as { tableId?: string }).tableId === "sim_sensitivity"));
  const xlsx = await buildSimulatorXlsx(r);
  const sheets = [...unzipEntries(xlsx).keys()].filter((k) => k.startsWith("xl/worksheets/sheet"));
  assert.ok(sheets.length >= 3, `sheets: ${sheets.length}`);
  const shared = unzipEntries(xlsx).get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  assert.ok(/Market simulator/.test(shared) && /Rival/.test(shared));
  const pptx = await buildSimulatorPptx(r);
  assert.equal(checkOfficeFile(pptx, "pptx").ok, true);
  const m = menuStudy({ n: 300 });
  const mr = runAnalysis({ name: "Menu", kind: "conjoint", dataset: spec, variables: ["MENU"] }, m.ds);
  const mx = await buildSimulatorXlsx(mr, "Menu simulator");
  assert.ok(/Menu simulator/.test(unzipEntries(mx).get("xl/sharedStrings.xml")?.toString("utf8") ?? ""));
});
