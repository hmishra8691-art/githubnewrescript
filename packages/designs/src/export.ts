/** Export helpers for generated design files. */

export interface DesignFile {
  columns: string[];
  rows: Record<string, unknown>[];
}

/*
 * RFC-4180 quoting plus the anti-formula-injection guard.
 *
 * This is a deliberate copy of `packages/exporters/src/csvCell.ts`, which is
 * the canonical version — @rescript/designs does not depend on
 * @rescript/exporters, and adding that edge (and with it docx, exceljs and
 * qrcode) for three lines is a worse trade than the duplication. Change both,
 * and keep `export.test.ts` in step with `csvCell.test.ts`.
 *
 * The numeric exemption matters most here: a design file is nearly all
 * integers, and blanket-prefixing every negative one would turn the matrix
 * into text for whoever loads it.
 */
const PLAIN_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const s = /^[=+\-@\t\r]/.test(raw) && !PLAIN_NUMBER.test(raw) ? `\t${raw}` : raw;
  if (/[",\n\r\t]/.test(s)) {
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
