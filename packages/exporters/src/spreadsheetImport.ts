import ExcelJS from "exceljs";

/**
 * READING A SPREADSHEET BACK IN.
 *
 * The platform could write .xlsx from the first release and never read one:
 * the response importer accepted CSV, TSV and JSON, and its own documentation
 * said plainly that it "never parses CSV or XLSX itself". So the commonest
 * file a client actually sends — a workbook, often with the header row not on
 * row one — had to be re-saved as CSV by hand before it could be imported,
 * and every re-save is a chance to mangle a date or drop a leading zero.
 *
 * This lives in `@rescript/exporters` beside the writer, and returns exactly
 * the shape the importer already consumes (`{ headers, rows }`), so nothing
 * downstream changes: the same mapping, the same validation, the same
 * transactional commit.
 */

export interface SheetRows {
  headers: string[];
  rows: Record<string, unknown>[];
  /** the sheet the rows came from, for the preview to name */
  sheetName: string;
  /** every sheet in the workbook, so the UI can offer a different one */
  sheetNames: string[];
}

/** A cell's value as a person would read it — never a formula object. */
function plain(v: unknown): unknown {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    // dates come back as UTC midnight; the date is what was typed, and a
    // timezone shift here silently moves someone's birthday
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // a formula cell carries { formula, result }; the result is the answer
    if ("result" in o) return plain(o.result);
    // rich text carries runs; join what a reader would see
    if (Array.isArray(o.richText)) return o.richText.map((r: { text?: string }) => r.text ?? "").join("");
    if ("text" in o) return plain(o.text);
    if ("hyperlink" in o) return plain(o.text ?? o.hyperlink);
    if ("error" in o) return "";
  }
  return v;
}

const isBlankRow = (values: unknown[]) =>
  values.every((v) => v === "" || v === null || v === undefined);

/**
 * Read a workbook into rows.
 *
 * `sheet` picks one by name; without it the first sheet that has any content
 * is used. The header row is found rather than assumed (see below) — a
 * workbook with a title and a blank line above the table is the normal case,
 * not an error, and refusing it would send the user back to Excel to tidy up
 * by hand.
 */
export async function parseSpreadsheet(
  data: ArrayBuffer | Uint8Array | Buffer,
  opts: { sheet?: string } = {},
): Promise<SheetRows> {
  const wb = new ExcelJS.Workbook();
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
  await wb.xlsx.load(buf as never);

  const sheetNames = wb.worksheets.map((w) => w.name);
  if (sheetNames.length === 0) throw new Error("that workbook has no sheets.");

  const sheet = opts.sheet
    ? wb.worksheets.find((w) => w.name === opts.sheet)
    : wb.worksheets.find((w) => w.actualRowCount > 0) ?? wb.worksheets[0];
  if (!sheet) throw new Error(`that workbook has no sheet called “${opts.sheet}”.`);

  /* every row as a plain array, trailing blanks trimmed */
  const grid: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = (row.values as unknown[]).slice(1).map(plain); // exceljs pads index 0
    grid.push(values);
  });

  /*
   * WHICH ROW IS THE HEADER.
   *
   * Not simply "the first row with something in it": client files routinely
   * open with a one-cell title ("Fieldwork export — Q3"), sometimes a blank
   * line, and only then the table. Taking the title as the header produces a
   * single column called "Fieldwork export — Q3" and an import that maps
   * nothing, which reads as a broken file rather than a misread one.
   *
   * A title row is narrow and the header is as wide as the data under it, so:
   * the header is the first non-blank row that is at least as wide as the
   * next non-blank row. A one-column sheet still works — 1 >= 1.
   */
  const filled = (r: unknown[]) => r.filter((v) => v !== "" && v !== null && v !== undefined).length;
  const contentRows = grid.map((r, i) => ({ i, r })).filter(({ r }) => !isBlankRow(r));
  if (contentRows.length === 0) throw new Error(`the sheet “${sheet.name}” is empty.`);
  let firstContent = contentRows[0].i;
  for (let k = 0; k < contentRows.length - 1; k++) {
    if (filled(contentRows[k].r) >= filled(contentRows[k + 1].r)) { firstContent = contentRows[k].i; break; }
    firstContent = contentRows[k + 1].i;
  }

  const headerRow = grid[firstContent].map((h) => String(h ?? "").trim());
  const width = headerRow.reduce((n, h, i) => (h ? i + 1 : n), 0);
  const headers = headerRow.slice(0, width);
  if (headers.length === 0) throw new Error(`no column headings were found in “${sheet.name}”.`);

  const dupes = headers.filter((h, i) => h && headers.indexOf(h) !== i);
  if (dupes.length) {
    throw new Error(
      `“${sheet.name}” has more than one column called ${[...new Set(dupes)].map((d) => `“${d}”`).join(", ")} — rename them so each answer has one column.`,
    );
  }

  const rows: Record<string, unknown>[] = [];
  for (const values of grid.slice(firstContent + 1)) {
    if (isBlankRow(values.slice(0, width))) continue;
    const row: Record<string, unknown> = {};
    headers.forEach((h, i) => { if (h) row[h] = values[i] ?? ""; });
    rows.push(row);
  }

  return { headers, rows, sheetName: sheet.name, sheetNames };
}
