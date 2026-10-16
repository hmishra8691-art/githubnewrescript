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
 * an independent implementation, in `scripts/verify-statistical-exports.mjs`
 * and in the `SPSS: UTF-8` tests of `statisticalExport.test.ts`.
 *
 * TEXT IS UTF-8. The file declares it twice, the way SPSS itself does: the
 * integer-info record (7/3) carries character code 65001 and the encoding
 * record (7/20) carries the name "UTF-8". Every label, value label, file
 * label and string cell is then written as UTF-8 bytes. A .sav is byte-
 * oriented — a string variable's WIDTH is a count of bytes, not characters —
 * so widths come from `Buffer.byteLength` and any truncation happens at a
 * code-point boundary, never inside a multi-byte sequence. Only the 8-byte
 * short names in the base variable records are transliterated to ASCII,
 * because SPSS's name rules are ASCII rules; the real name rides in 7/13.
 *
 * Record types written here:
 *   1    file header
 *   2    one per variable (plus a continuation per extra 8 bytes of a string)
 *   3/4  value labels, and the variables they apply to
 *   7/3  integer info: version, IEEE floats, little-endian, code page 65001
 *   7/4  floating-point info: the sysmis / highest / lowest doubles
 *   7/13 the long-name map, since a base record's name is 8 bytes
 *   7/11 measurement level, column width and alignment
 *   7/20 character encoding: "UTF-8"
 *   999  dictionary termination, then the case data
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
  /**
   * UTF-8, padded with spaces to exactly `len` bytes. Text that does not fit
   * is cut at a code-point boundary: a field is read back as a whole, and a
   * half sequence at its end would turn the last character into mojibake.
   */
  fixed(s: string, len: number) {
    const b = Buffer.alloc(len, 0x20);
    utf8(s, len).copy(b, 0);
    this.push(b);
  }
  /** raw ASCII, for the magic number and structural padding */
  bytes(s: string) { this.push(Buffer.from(s, "latin1")); }
  done(): Buffer { return Buffer.concat(this.chunks); }
}

/**
 * `s` as UTF-8, no longer than `maxBytes`, cut only between code points.
 *
 * Control characters are replaced by spaces, as the old ASCII sanitiser did:
 * a stray newline inside a label or a cell is not something SPSS displays,
 * and a NUL would end the field early in some readers.
 */
function utf8(s: string, maxBytes: number): Buffer {
  const clean = (s ?? "").replace(/[\x00-\x1f\x7f]/g, " ");
  const b = Buffer.from(clean, "utf8");
  if (b.length <= maxBytes) return b;
  // walk back from the cut to the start of the sequence that straddles it:
  // continuation bytes are 10xxxxxx, so the first byte that is not one is
  // where the straddling character began
  let end = maxBytes;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.subarray(0, end);
}

/** The decoded text of `utf8(s, maxBytes)`, for places that need a string back. */
function clip(s: string, maxBytes: number): string {
  return utf8(s, maxBytes).toString("utf8");
}

/**
 * Transliteration to ASCII, used ONLY for variable names. SPSS's name rules
 * are ASCII rules, so a name has to be mangled whatever the file's encoding;
 * the label next to it keeps the original text. Letters that `NFD` cannot
 * decompose are mapped by hand so "Größe" becomes GROSSE rather than GRO_E.
 */
function ascii(s: string): string {
  return (s ?? "")
    .replace(/ß/g, "ss").replace(/ẞ/g, "SS")
    .replace(/æ/g, "ae").replace(/Æ/g, "AE")
    .replace(/œ/g, "oe").replace(/Œ/g, "OE")
    .replace(/ø/g, "o").replace(/Ø/g, "O")
    .replace(/ł/g, "l").replace(/Ł/g, "L")
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .replace(/þ/g, "th").replace(/Þ/g, "Th")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/…/g, "...")
    .replace(/[^\x20-\x7e]/g, " ");
}

/**
 * Field limits, in BYTES. SPSS reads a variable label of up to 255 bytes and
 * a value label of up to 120; longer ones are refused or cut by the reader,
 * which is worse than cutting them here at a character boundary.
 */
const MAX_VARIABLE_LABEL = 255;
const MAX_VALUE_LABEL = 120;
const MAX_FILE_LABEL = 64;
/** the widest a plain string variable can be; the base record's type field holds the width */
const MAX_STRING_WIDTH = 255;
const UTF8_CODE_PAGE = 65001;

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
    // `stringWidth` is in bytes, as the format counts; a caller that measured
    // characters under-allocates for anything outside ASCII
    const width = v.type === "string" ? Math.min(MAX_STRING_WIDTH, Math.max(1, v.stringWidth ?? MAX_STRING_WIDTH)) : 0;
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
  w.fixed(input.fileLabel ?? "", MAX_FILE_LABEL);
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
      const text = utf8(label, MAX_VALUE_LABEL);
      const len = text.length;      // one length BYTE, so the cap above is what keeps it in range
      w.push(Buffer.from([len]));
      // the label is padded so that the length byte plus the text fills a
      // multiple of 8 bytes
      const pad = (8 - ((len + 1) % 8)) % 8;
      w.push(text);
      w.fixed("", pad);
    }
    w.int32(4);
    w.int32(1);
    w.int32(vars.indexOf(v) + 1 + precedingContinuations(vars, v)); // 1-based dictionary index
  }

  /* ---- record 7/3: integer info — this is where the code page is declared ---- */
  w.int32(7); w.int32(3); w.int32(4); w.int32(8);
  w.int32(1); w.int32(0); w.int32(0);   // version major / minor / revision
  w.int32(-1);                          // machine code: no particular one
  w.int32(1);                           // floating-point representation: IEEE 754
  w.int32(1);                           // compression code: 1 is the only documented value
  w.int32(2);                           // endianness: 2 = little
  w.int32(UTF8_CODE_PAGE);              // character code: 65001 = UTF-8

  /* ---- record 7/4: floating-point info ---- */
  w.int32(7); w.int32(4); w.int32(8); w.int32(3);
  w.double(SYSMIS);                     // system-missing
  w.double(Number.MAX_VALUE);           // highest
  w.double(SYSMIS);                     // lowest — SPSS writes -MAX here, the same bits as sysmis

  /* ---- record 7/13: the real names ---- */
  const longMap = vars.filter((v) => v.short !== v.long).map((v) => `${v.short}=${v.long}`).join("\t");
  if (longMap) {
    w.int32(7); w.int32(13); w.int32(1);
    /*
     * NOT through `fixed()`, which replaces every control character with a
     * space. The entries are separated by a TAB, and an earlier version of
     * this writer sanitised the map, which turned it into one entry and gave
     * the first variable a name made of the second one's mapping. The names
     * are ASCII by construction (`spssName`), so there is nothing to clean.
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

  /*
   * ---- record 7/20: character encoding ----
   * The name, as SPSS 16+ writes it. Readers that pre-date this record fall
   * back on the 7/3 code page above; both say the same thing.
   */
  w.int32(7); w.int32(20); w.int32(1); w.int32(5);
  w.bytes("UTF-8");

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
        // the cell occupies the variable's whole 8-byte blocks, but only
        // `width` bytes of it are the value — a reader stops there, so the
        // text is cut to the width, not to the padded size
        const s = clip(raw == null ? "" : String(raw), v.width);
        const blocks = Math.ceil(v.width / 8);
        w.fixed(s, blocks * 8);
      }
    }
  }
  return w.done();
}

function writeVariableRecord(w: ByteSink, v: { long: string; short: string; label: string; type: string; width: number; missingValues?: (number | string)[] }): void {
  const label = utf8(v.label ?? "", MAX_VARIABLE_LABEL);
  const hasLabel = label.length > 0 ? 1 : 0;
  /*
   * Only DISCRETE missing values are written (up to the three SPSS allows for
   * a numeric variable). A range would be a fourth code in the header and a
   * different reading of the same field, and nothing in this platform
   * produces one.
   */
  const missing = (v.missingValues ?? []).slice(0, 3);
  w.int32(2);
  w.int32(v.type === "string" ? Math.min(MAX_STRING_WIDTH, v.width) : 0);
  w.int32(hasLabel);
  w.int32(missing.length);
  // print and write formats: 5 = F (numeric), 1 = A (string), packed as
  // (type << 16) | (width << 8) | decimals
  const fmt = v.type === "string"
    ? (1 << 16) | (Math.min(MAX_STRING_WIDTH, v.width) << 8)
    : (5 << 16) | (8 << 8);
  w.int32(fmt);
  w.int32(fmt);
  w.fixed(v.short, 8);
  if (hasLabel) {
    w.int32(label.length);        // in bytes, which is what a reader allocates
    const pad = (4 - (label.length % 4)) % 4;
    w.push(label);
    w.fixed("", pad);
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
