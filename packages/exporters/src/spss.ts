import type { VariableDef } from "@rescript/schema";

/**
 * SPSS SYSTEM FILE (.sav) WRITER (§44).
 *
 * The point of a .sav is not that it holds the numbers — a CSV holds the
 * numbers. It is that it holds the numbers TOGETHER WITH what they mean:
 * every variable keeps its label, every code keeps its value label, and
 * missing values are declared as missing rather than blank. Exporting a
 * survey as "SPSS" by writing labels into text cells would throw away exactly
 * the thing the format exists for, so this writes real metadata records.
 *
 * Written by hand, little-endian and UNCOMPRESSED, because the format is
 * documented and a dependency that writes it is not one this repo carries.
 * Uncompressed costs file size and buys a writer that is simple enough to be
 * obviously correct. The output is checked against ReadStat (via pyreadstat),
 * an independent implementation, in `spss.verify.test.ts`.
 *
 * Record types written here:
 *   1   file header
 *   2   one per variable (plus a continuation per extra 8 bytes of a string)
 *   3/4 value labels, and the variables they apply to
 *   7/13 the long-name map, since a base record's name is 8 bytes
 *   7/11 measurement level, column width and alignment
 *   999 dictionary termination, then the case data
 */

export interface SavVariable {
  /** the name as the rest of the platform knows it */
  name: string;
  label: string;
  /** numeric, or the byte width of a string */
  type: "numeric" | "string";
  stringWidth?: number;
  valueLabels?: Record<string, string>;
  /** discrete values that mean "no answer" rather than a quantity */
  missingValues?: (number | string)[];
  /** SPSS measurement level; drives what SPSS offers in its dialogs */
  measure?: "nominal" | "ordinal" | "scale";
}

export interface SavInput {
  variables: SavVariable[];
  /** one record per case, keyed by variable name */
  rows: Record<string, unknown>[];
  fileLabel?: string;
}

/* ------------------------------------------------------------ byte writing */

class ByteSink {
  private chunks: Buffer[] = [];
  push(b: Buffer) { this.chunks.push(b); }
  int32(n: number) { const b = Buffer.alloc(4); b.writeInt32LE(n | 0, 0); this.push(b); }
  double(n: number) { const b = Buffer.alloc(8); b.writeDoubleLE(n, 0); this.push(b); }
  /** ASCII, padded with spaces or truncated to exactly `len` */
  fixed(s: string, len: number) {
    const b = Buffer.alloc(len, 0x20);
    Buffer.from(ascii(s), "latin1").copy(b, 0, 0, Math.min(len, Buffer.byteLength(ascii(s), "latin1")));
    this.push(b);
  }
  bytes(s: string) { this.push(Buffer.from(s, "latin1")); }
  done(): Buffer { return Buffer.concat(this.chunks); }
}

/**
 * SPSS system files are byte-oriented and this writer declares no code page,
 * so anything outside ASCII is transliterated rather than written as bytes a
 * reader would mis-decode. A label that came back as mojibake would be worse
 * than one that lost its accents.
 */
function ascii(s: string): string {
  return (s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/…/g, "...")
    .replace(/[^\x20-\x7e]/g, " ");
}

/* ------------------------------------------------------------ names */

/**
 * SPSS's own variable name rules: 1–64 bytes, starting with a letter, and
 * containing no spaces or punctuation beyond `_$#@.`. The platform's names
 * are already close, but a derived one can carry a character SPSS rejects,
 * and a file SPSS refuses to open is not an export.
 *
 * Uniqueness is enforced after mangling, because two different names can
 * mangle to the same thing and a duplicate makes the dictionary unreadable.
 */
export function spssName(raw: string, taken: Set<string>): string {
  let s = ascii(raw).toUpperCase().replace(/[^A-Z0-9_$#@.]/g, "_");
  if (!/^[A-Z@$]/.test(s)) s = `V${s}`;
  s = s.slice(0, 64) || "VAR";
  let out = s, n = 1;
  while (taken.has(out)) {
    const suffix = `_${n++}`;
    out = s.slice(0, 64 - suffix.length) + suffix;
  }
  taken.add(out);
  return out;
}

/** The 8-byte name the base record carries; the real one goes in the 7/13 map. */
function shortName(long: string, taken: Set<string>): string {
  let s = long.slice(0, 8);
  let n = 1;
  while (taken.has(s)) {
    const suffix = String(n++);
    s = long.slice(0, Math.max(1, 8 - suffix.length)) + suffix;
  }
  taken.add(s);
  return s;
}

/* ------------------------------------------------------------ the writer */

const SYSMIS = -Number.MAX_VALUE; // SPSS's system-missing double

export function buildSav(input: SavInput): Buffer {
  const taken = new Set<string>();
  const shortTaken = new Set<string>();
  const vars = input.variables.map((v) => {
    const long = spssName(v.name, taken);
    const width = v.type === "string" ? Math.min(255, Math.max(1, v.stringWidth ?? 255)) : 0;
    return { ...v, long, short: shortName(long, shortTaken), width };
  });

  const w = new ByteSink();

  /* ---- record 1: file header ---- */
  w.bytes("$FL2");
  w.fixed("@(#) rescript survey platform", 60);
  w.int32(2);                       // layout code — how a reader detects endianness
  w.int32(nominalCaseSize(vars));   // 8-byte units per case
  w.int32(0);                       // uncompressed
  w.int32(0);                       // no weight variable
  w.int32(input.rows.length);
  w.double(100);                    // compression bias, conventionally 100
  w.fixed(creationDate(), 9);
  w.fixed(creationTime(), 8);
  w.fixed(input.fileLabel ?? "", 64);
  w.bytes("\0\0\0");                // padding

  /* ---- record 2 per variable ---- */
  for (const v of vars) {
    writeVariableRecord(w, v);
    // a string wider than 8 bytes continues in further records, one per
    // 8-byte block after the first; they carry no metadata of their own
    if (v.type === "string") {
      const extra = Math.ceil(v.width / 8) - 1;
      for (let i = 0; i < extra; i++) writeContinuationRecord(w);
    }
  }

  /* ---- records 3/4: value labels ---- */
  for (const v of vars) {
    const labels = Object.entries(v.valueLabels ?? {}).filter(([, l]) => (l ?? "").trim().length > 0);
    if (!labels.length) continue;
    // a label set applies to variables of one type, so string and numeric
    // never share a record
    w.int32(3);
    w.int32(labels.length);
    for (const [code, label] of labels) {
      if (v.type === "numeric") {
        const n = Number(code);
        w.double(Number.isFinite(n) ? n : 0);
      } else {
        w.fixed(code, 8);
      }
      const text = ascii(label).slice(0, 120);
      const len = Buffer.byteLength(text, "latin1");
      w.push(Buffer.from([len]));
      // the label is padded so that the length byte plus the text fills a
      // multiple of 8 bytes
      const pad = (8 - ((len + 1) % 8)) % 8;
      w.fixed(text, len + pad);
    }
    w.int32(4);
    w.int32(1);
    w.int32(vars.indexOf(v) + 1 + precedingContinuations(vars, v)); // 1-based dictionary index
  }

  /* ---- record 7/13: the real names ---- */
  const longMap = vars.filter((v) => v.short !== v.long).map((v) => `${v.short}=${v.long}`).join("\t");
  if (longMap) {
    w.int32(7); w.int32(13); w.int32(1);
    /*
     * NOT through `ascii()`. The entries are separated by a TAB, and the
     * sanitiser replaces every control character with a space — which turned
     * the whole map into one entry and gave the first variable a name made of
     * the second one's mapping. The names are already ASCII by construction
     * (`spssName`), so there is nothing here left to sanitise.
     */
    const b = Buffer.from(longMap, "latin1");
    w.int32(b.length); w.push(b);
  }

  /* ---- record 7/11: measurement level, width, alignment ---- */
  w.int32(7); w.int32(11); w.int32(4); w.int32(vars.length * 3);
  for (const v of vars) {
    w.int32(v.measure === "scale" ? 3 : v.measure === "ordinal" ? 2 : 1);
    w.int32(v.type === "string" ? Math.min(40, v.width) : 8);
    w.int32(v.type === "string" ? 1 : 3); // left for text, right for numbers
  }

  /* ---- record 999: end of dictionary ---- */
  w.int32(999); w.int32(0);

  /* ---- the cases ---- */
  for (const row of input.rows) {
    for (const v of vars) {
      const raw = row[v.name];
      if (v.type === "numeric") {
        const n = toNumber(raw);
        w.double(n == null ? SYSMIS : n);
      } else {
        const s = ascii(raw == null ? "" : String(raw));
        const blocks = Math.ceil(v.width / 8);
        w.fixed(s, blocks * 8);
      }
    }
  }
  return w.done();
}

function writeVariableRecord(w: ByteSink, v: { long: string; short: string; label: string; type: string; width: number; missingValues?: (number | string)[] }): void {
  const label = ascii(v.label ?? "").slice(0, 120);
  const hasLabel = label.length > 0 ? 1 : 0;
  /*
   * Only DISCRETE missing values are written (up to the three SPSS allows for
   * a numeric variable). A range would be a fourth code in the header and a
   * different reading of the same field, and nothing in this platform
   * produces one.
   */
  const missing = (v.missingValues ?? []).slice(0, 3);
  w.int32(2);
  w.int32(v.type === "string" ? Math.min(255, v.width) : 0);
  w.int32(hasLabel);
  w.int32(missing.length);
  // print and write formats: 5 = F (numeric), 1 = A (string), packed as
  // (type << 16) | (width << 8) | decimals
  const fmt = v.type === "string"
    ? (1 << 16) | (Math.min(255, v.width) << 8)
    : (5 << 16) | (8 << 8);
  w.int32(fmt);
  w.int32(fmt);
  w.fixed(v.short, 8);
  if (hasLabel) {
    const b = Buffer.from(label, "latin1");
    w.int32(b.length);
    const pad = (4 - (b.length % 4)) % 4;
    w.fixed(label, b.length + pad);
  }
  for (const m of missing) {
    if (v.type === "string") w.fixed(String(m), 8);
    else w.double(Number(m));
  }
}

function writeContinuationRecord(w: ByteSink): void {
  w.int32(2);
  w.int32(-1);   // -1 marks this as the continuation of the variable before it
  w.int32(0); w.int32(0); w.int32(0); w.int32(0);
  w.fixed("", 8);
}

/** Dictionary indexes count continuation records, so a value label must too. */
function precedingContinuations(vars: { type: string; width: number }[], upTo: { type: string; width: number }): number {
  let n = 0;
  for (const v of vars) {
    if (v === upTo) break;
    if (v.type === "string") n += Math.ceil(v.width / 8) - 1;
  }
  return n;
}

function nominalCaseSize(vars: { type: string; width: number }[]): number {
  return vars.reduce((n, v) => n + (v.type === "string" ? Math.ceil(v.width / 8) : 1), 0);
}

function toNumber(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : null;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function creationDate(d = new Date()): string {
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function creationTime(d = new Date()): string {
  return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/* ------------------------------------------------------------ from a survey */

/**
 * Decide how one dictionary variable is represented in a .sav.
 *
 * A variable is numeric when the survey says so AND every value it can take
 * is a number. Codes are kept as codes — the labels travel as metadata, which
 * is the whole reason to hand somebody a .sav instead of a spreadsheet.
 */
export function savVariableFor(v: VariableDef, widthHint = 255): SavVariable {
  const numericCodes = (v.valueCodes ?? []).length > 0 && (v.valueCodes ?? []).every((c) => Number.isFinite(Number(c)));
  const numeric = v.dataType === "numeric" || v.dataType === "boolean" || numericCodes;
  /*
   * §44 phase 2 — the researcher's delivery settings win over the derived
   * ones, because they are the only source for these: nothing in a
   * questionnaire says which codes mean "no answer".
   *
   * `missingValues` is filtered to those the variable's own type can hold. A
   * declared missing value of "99" on a STRING variable is meaningless to
   * SPSS and writing it produces a file that reads back wrong, so it is
   * dropped here rather than corrupting the dictionary record.
   */
  const declaredMissing = (v.missingValues ?? []).filter((m) =>
    numeric ? Number.isFinite(Number(m)) : typeof m === "string",
  );
  return {
    name: v.exportName?.trim() || v.name,
    label: (v.label ?? "").trim() || v.name,
    type: numeric ? "numeric" : "string",
    stringWidth: numeric ? undefined : widthHint,
    valueLabels: v.valueLabels ?? {},
    missingValues: declaredMissing.length ? declaredMissing : undefined,
    measure: v.measure ?? (numericCodes || v.responseType?.includes("scale") ? "ordinal" : numeric ? "scale" : "nominal"),
  };
}
