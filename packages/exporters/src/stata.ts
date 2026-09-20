import type { VariableDef } from "@rescript/schema";

/**
 * STATA (.dta), format 118 — Stata 14 and later.
 *
 * The third statistical format, and the easiest of the three to justify: it
 * is fully documented, it is UTF-8 throughout (unlike SAS transport, which is
 * ASCII and mangles `Café`), its names allow 32 characters rather than 8, and
 * the dictionary this platform already builds maps onto it almost exactly.
 *
 * Format 118 rather than 117 because 117 is Stata 13 and Latin-1; rather than
 * 119 because that only raises the variable ceiling to 32,767 and is not read
 * by anything older. 118 is what a research supplier ships.
 *
 * ## Shape of the file
 *
 * A .dta is XML-ISH: literal `<tag>` markers around fixed-width binary
 * blocks, with a `<map>` of byte offsets near the front that Stata uses to
 * jump straight to a section. The map is written LAST, once every offset is
 * known, and a map that disagrees with the real offsets gives a file Stata
 * opens and misreads — the same class of failure as the SPSS value-label
 * indexes, so it is asserted in the tests rather than trusted.
 */

export interface StataVariable {
  name: string;
  label: string;
  type: "numeric" | "string";
  stringWidth?: number;
  valueLabels?: Record<string, string>;
  /**
   * Declared missing codes, carried for the reader's benefit only.
   *
   * Stata's missing model is not SPSS's. SPSS keeps 99 in the cell AND marks
   * it missing, so nothing is lost. Stata's extended missings (`.a` … `.z`)
   * REPLACE the value — write 99 as `.a` and the 99 is gone from the
   * dataset. Converting silently would destroy data the researcher can see
   * in every other format, so the codes stay as ordinary values with their
   * labels, and the dictionary says which ones mean "no answer".
   */
  missingValues?: (string | number)[];
}

export interface DtaInput {
  variables: StataVariable[];
  rows: Record<string, unknown>[];
  fileLabel?: string;
}

/* Stata's numeric type codes. Everything numeric is written as a double:
 * a survey's values are not worth the byte-width analysis, and a double
 * holds every integer a study produces exactly. */
const T_DOUBLE = 65526;
const T_STRL = 32768;

/** Stata's system missing for a double: 0x7FE0000000000000. */
const SYSMIS = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xe0, 0x7f]);

const MAX_NAME = 32;
const MAX_LABEL = 80;
const MAX_VALUE_LABEL = 32000;

class Writer {
  private parts: Buffer[] = [];
  private len = 0;
  push(b: Buffer) { this.parts.push(b); this.len += b.length; }
  ascii(s: string) { this.push(Buffer.from(s, "utf8")); }
  u8(n: number) { const b = Buffer.alloc(1); b.writeUInt8(n); this.push(b); }
  u16(n: number) { const b = Buffer.alloc(2); b.writeUInt16LE(n); this.push(b); }
  i32(n: number) { const b = Buffer.alloc(4); b.writeInt32LE(n); this.push(b); }
  u64(n: number) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); this.push(b); }
  f64(n: number) { const b = Buffer.alloc(8); b.writeDoubleLE(n); this.push(b); }
  /** a fixed-width UTF-8 field, null padded */
  fixed(s: string, n: number) {
    const b = Buffer.alloc(n);
    const src = Buffer.from(s, "utf8");
    src.copy(b, 0, 0, Math.min(n - 1, src.length));   // always null terminated
    this.push(b);
  }
  get offset() { return this.len; }
  done() { return Buffer.concat(this.parts); }
}

/**
 * Stata names: 32 characters, letters/digits/underscore, not starting with a
 * digit, and not one of Stata's reserved words — `_n`, `if`, `in`, `by` and
 * friends are commands, and a variable called `if` makes every do-file that
 * touches the dataset a syntax error.
 */
const RESERVED = new Set([
  "_all", "_b", "byte", "_coef", "_cons", "double", "float", "if", "in", "int",
  "long", "_n", "_N", "_pi", "_pred", "_rc", "_skip", "str", "strL", "using", "with", "by",
]);

export function stataName(raw: string, taken: Set<string>): string {
  let s = (raw ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z_]/.test(s)) s = `v${s}`;
  s = s.slice(0, MAX_NAME) || "var";
  if (RESERVED.has(s.toLowerCase())) s = `${s}_`.slice(0, MAX_NAME);
  let out = s, n = 1;
  while (taken.has(out.toLowerCase())) {
    const suffix = String(n++);
    out = s.slice(0, MAX_NAME - suffix.length) + suffix;
  }
  taken.add(out.toLowerCase());
  return out;
}

/**
 * Stata value labels attach to a NAMED SET, and a variable points at a set by
 * name — unlike SPSS, where the labels are attached to the variable directly.
 * Two variables sharing a scale can therefore share one set, which is how a
 * real Stata dataset is built; here each variable gets its own set named
 * after it, because survey scales that look identical often are not (a
 * "don't know" on one question and not another) and silently merging them
 * would relabel data.
 */
function valueLabelSets(vars: { stata: string; v: StataVariable; numeric: boolean }[]) {
  return vars
    .filter((x) => x.numeric && Object.keys(x.v.valueLabels ?? {}).length > 0)
    .map((x) => {
      const entries = Object.entries(x.v.valueLabels ?? {})
        .map(([code, label]) => ({ value: Number(code), label: String(label ?? "") }))
        // a non-numeric code cannot be a Stata value label; it is dropped
        // rather than written as 0, which would relabel a real answer
        .filter((e) => Number.isFinite(e.value) && e.label.trim().length > 0)
        .sort((a, b) => a.value - b.value);
      return { name: x.stata, entries };
    })
    .filter((s) => s.entries.length > 0);
}

export function buildDta(input: DtaInput): Buffer {
  const taken = new Set<string>();
  const vars = input.variables.map((v) => {
    const numeric = v.type === "numeric";
    return {
      v,
      numeric,
      stata: stataName(v.name, taken),
      /* a string column is str# up to 2045, and strL beyond — strL needs a
       * separate section, so widths are clamped instead: a survey open end
       * past 2045 bytes is vanishingly rare and truncating is visible, where
       * a malformed strL section is not */
      width: numeric ? 0 : Math.min(2045, Math.max(1, v.stringWidth ?? 200)),
    };
  });

  const labelSets = valueLabelSets(vars);
  const hasSet = new Set(labelSets.map((s) => s.name));

  const w = new Writer();
  const offsets: Record<string, number> = {};
  const open = (tag: string) => { offsets[tag] = w.offset; w.ascii(`<${tag}>`); };
  const close = (tag: string) => w.ascii(`</${tag}>`);

  w.ascii("<stata_dta>");

  /* ------------------------------------------------------------- header */
  offsets.header = 0;
  w.ascii("<header>");
  w.ascii("<release>118</release>");
  w.ascii("<byteorder>LSF</byteorder>");
  w.ascii("<K>"); w.u16(vars.length); w.ascii("</K>");
  w.ascii("<N>"); w.u64(input.rows.length); w.ascii("</N>");
  const label = (input.fileLabel ?? "").slice(0, MAX_LABEL);
  w.ascii("<label>"); w.u16(Buffer.byteLength(label, "utf8")); w.ascii(label); w.ascii("</label>");
  const stamp = stataTimestamp();
  w.ascii("<timestamp>"); w.u8(stamp.length); w.ascii(stamp); w.ascii("</timestamp>");
  w.ascii("</header>");

  /*
   * The map is 14 × uint64 and has to hold the real offsets — but they are
   * not known until everything is written. So a placeholder of the exact
   * size goes in now and is overwritten at the end. Writing it any other way
   * means computing every section's length by hand, which is the sort of
   * arithmetic that is wrong once and wrong silently.
   */
  const mapOffset = w.offset;
  w.ascii("<map>");
  const mapDataOffset = w.offset;
  for (let i = 0; i < 14; i++) w.u64(0);
  w.ascii("</map>");

  open("variable_types");
  for (const v of vars) w.u16(v.numeric ? T_DOUBLE : v.width);
  close("variable_types");

  open("varnames");
  for (const v of vars) w.fixed(v.stata, 129);
  close("varnames");

  open("sortlist");
  for (let i = 0; i <= vars.length; i++) w.u16(0);   // not sorted
  close("sortlist");

  open("formats");
  for (const v of vars) w.fixed(v.numeric ? "%10.0g" : `%${v.width}s`, 57);
  close("formats");

  open("value_label_names");
  for (const v of vars) w.fixed(hasSet.has(v.stata) ? v.stata : "", 129);
  close("value_label_names");

  open("variable_labels");
  for (const v of vars) w.fixed((v.v.label ?? "").slice(0, MAX_LABEL), 321);
  close("variable_labels");

  open("characteristics");
  close("characteristics");

  /* --------------------------------------------------------------- data */
  open("data");
  for (const row of input.rows) {
    for (const v of vars) {
      const raw = row[v.v.name];
      if (v.numeric) {
        const n = raw == null || raw === "" ? null : Number(raw);
        if (n == null || !Number.isFinite(n)) w.push(Buffer.from(SYSMIS));
        else w.f64(n);
      } else {
        const b = Buffer.alloc(v.width);
        Buffer.from(raw == null ? "" : String(raw), "utf8").copy(b, 0, 0, v.width);
        w.push(b);
      }
    }
  }
  close("data");

  open("strls");
  close("strls");

  /* ------------------------------------------------------- value labels */
  open("value_labels");
  for (const set of labelSets) {
    w.ascii("<lbl>");
    /*
     * A label set is: its own byte length, the name, 3 bytes of padding, the
     * entry count, the text length, then parallel arrays of text offsets and
     * values, then the text itself as null-separated strings. The offsets are
     * into the text blob, so they have to be computed before any of it is
     * written.
     */
    const texts = set.entries.map((e) => Buffer.from(e.label.slice(0, MAX_VALUE_LABEL), "utf8"));
    const offs: number[] = [];
    let running = 0;
    for (const t of texts) { offs.push(running); running += t.length + 1; }
    const txtlen = running;
    const n = set.entries.length;
    const bodyLen = 4 + 4 + n * 4 + n * 4 + txtlen;   // n, txtlen, off[], val[], txt

    /*
     * The length field counts the BODY ONLY — not the 129-byte name or the
     * three padding bytes that follow it. Including them (which reads as the
     * natural thing to do, since they are inside the <lbl> block) overshoots
     * by 132, and the reader uses this number to find the NEXT label set. One
     * set survived it; two produced "invalid file, or file has unsupported
     * features", and a single set silently carried no labels at all.
     */
    w.i32(bodyLen);
    w.fixed(set.name, 129);
    w.push(Buffer.alloc(3));
    w.i32(n);
    w.i32(txtlen);
    for (const o of offs) w.i32(o);
    for (const e of set.entries) w.i32(e.value);
    for (const t of texts) { w.push(t); w.push(Buffer.alloc(1)); }
    w.ascii("</lbl>");
  }
  close("value_labels");

  offsets.end = w.offset;
  w.ascii("</stata_dta>");
  const eof = w.offset;

  const buf = w.done();

  /*
   * Now the real map. The order is fixed by the format: start, map,
   * variable_types, varnames, sortlist, formats, value_label_names,
   * variable_labels, characteristics, data, strls, value_labels,
   * end-of-file marker, and the file length.
   */
  const order = [
    0,
    mapOffset,
    offsets.variable_types,
    offsets.varnames,
    offsets.sortlist,
    offsets.formats,
    offsets.value_label_names,
    offsets.variable_labels,
    offsets.characteristics,
    offsets.data,
    offsets.strls,
    offsets.value_labels,
    offsets.end,
    eof,
  ];
  order.forEach((o, i) => buf.writeBigUInt64LE(BigInt(o), mapDataOffset + i * 8));
  return buf;
}

function stataTimestamp(d = new Date()): string {
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** How one dictionary variable is represented in Stata. Same rule as SPSS. */
export function stataVariableFor(v: VariableDef, widthHint = 200): StataVariable {
  const numericCodes = (v.valueCodes ?? []).length > 0 && (v.valueCodes ?? []).every((c) => Number.isFinite(Number(c)));
  const numeric = v.dataType === "numeric" || v.dataType === "boolean" || numericCodes;
  return {
    // the DELIVERED name, matching the other writers; statisticalExport
    // re-keys the rows to match, see `rekey`
    name: v.exportName?.trim() || v.name,
    label: (v.label ?? "").trim() || v.name,
    type: numeric ? "numeric" : "string",
    stringWidth: numeric ? undefined : widthHint,
    valueLabels: v.valueLabels ?? {},
    missingValues: (v.missingValues ?? []).filter((m) => (numeric ? Number.isFinite(Number(m)) : typeof m === "string")),
  };
}
