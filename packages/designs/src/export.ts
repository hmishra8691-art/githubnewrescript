/** Export helpers for generated design files. */

export interface DesignFile {
  columns: string[];
  rows: Record<string, unknown>[];
}

/** Quote a CSV cell per RFC 4180 (quote when it contains , " \n or \r). */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialize a design file to CSV (header row + one line per row). */
export function designToCSV(file: DesignFile): string {
  const lines: string[] = [];
  lines.push(file.columns.map(csvCell).join(","));
  for (const row of file.rows) {
    lines.push(file.columns.map((col) => csvCell(row[col])).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Slug helper: lowercase, alphanumerics and dashes only. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Standard file name for a generated design,
 * e.g. designFileName("conjoint", "Pricing Study", 2, "csv")
 *   -> "conjoint_pricing-study_v2.csv"
 */
export function designFileName(
  kind: string,
  name: string,
  version: number,
  format: string,
): string {
  const ext = format.replace(/^\./, "");
  return `${slug(kind)}_${slug(name)}_v${version}.${ext}`;
}
