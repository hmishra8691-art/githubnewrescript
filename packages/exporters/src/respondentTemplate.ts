import ExcelJS from "exceljs";
import { RESPONDENT_TEMPLATE_EXAMPLE, RESPONDENT_TEMPLATE_HELP, respondentTemplateHeaders } from "./respondentList.js";

/**
 * THE IMPORT TEMPLATE AS A WORKBOOK (2026-11-21). The first sheet is the one that is read back on upload: the
 * headings and one example row. The second sheet explains each column — it is never read, so a researcher can
 * leave it in.
 */
export async function respondentTemplateXlsx(extraColumns: string[] = []): Promise<Uint8Array> {
  const headers = respondentTemplateHeaders(extraColumns);
  const wb = new ExcelJS.Workbook();
  const people = wb.addWorksheet("People");
  people.columns = headers.map((h) => ({ header: h, key: h, width: h === "email" ? 34 : h === "name" ? 30 : 18 }));
  people.getRow(1).font = { bold: true };
  people.addRow(Object.fromEntries(headers.map((h) => [h, (RESPONDENT_TEMPLATE_EXAMPLE as Record<string, string>)[h] ?? ""])));
  people.views = [{ state: "frozen", ySplit: 1 }];
  const help = wb.addWorksheet("How to fill this in");
  help.columns = [{ width: 110 }];
  for (const line of RESPONDENT_TEMPLATE_HELP) help.addRow([line]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
