import type { VariableDef } from "@rescript/schema";

/**
 * SAS OUTPUT (§44) — a transport file, and the syntax to go with it.
 *
 * There is no honest way to write a native `.sas7bdat` here: the format is
 * undocumented, and a dataset SAS refuses to open — or worse, opens wrongly —
 * is more damaging than no dataset. What research suppliers actually ship is
 * either a SAS TRANSPORT file (`.xpt`, documented in SAS Technical Support
 * note TS-140 and readable by SAS, R, Stata and Python) or a CSV with a `.sas`
 * program beside it that applies the labels and formats. This writes both.
 *
 * XPT v5 carries its own hard limits, and they are the reason the `.sas`
 * script exists alongside it: names are 8 characters, labels 40, and there is
 * no place in the format for value labels at all. The script carries the full
 * names, the full labels and a PROC FORMAT for every code — so between the two
 * files nothing about the study is lost.
 */

export interface SasVariable {
  name: string;
  label: string;
  type: "numeric" | "string";
  stringWidth?: number;
  valueLabels?: Record<string, string>;
}

export interface XptInput {
  variables: SasVariable[];
  rows: Record<string, unknown>[];
  /** SAS member (dataset) name; 8 characters, uppercase */
  datasetName?: string;
  datasetLabel?: string;
}

const ascii = (s: string): string =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, " ");

const pad = (s: string, n: number): Buffer => {
  const b = Buffer.alloc(n, 0x20);
  const src = Buffer.from(ascii(s), "latin1");
  src.copy(b, 0, 0, Math.min(n, src.length));
  return b;
};

/**
 * SAS name rules: 8 characters for transport v5, letters/digits/underscore,
 * not starting with a digit. Uniqueness is enforced after truncation, because
 * `Q1_SATISFACTION` and `Q1_SATISFIED` both truncate to `Q1_SATIS` and two
 * columns with one name is a corrupt dataset.
 */
export function sasName(raw: string, taken: Set<string>): string {
  let s = ascii(raw).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!/^[A-Z_]/.test(s)) s = `V${s}`;
  s = s.slice(0, 8) || "VAR";
  let out = s, n = 1;
  while (taken.has(out)) {
    const suffix = String(n++);
    out = s.slice(0, 8 - suffix.length) + suffix;
  }
  taken.add(out);
  return out;
}

/**
 * IEEE double → IBM 370 hexadecimal float, which is what a transport file
 * stores. This is the one part of XPT that cannot be fudged: write IEEE bytes
 * and every number in the dataset is silently wrong rather than missing.
 *
 * The mantissa needs 56 bits, past what a JS number holds exactly, so it is
 * assembled as a BigInt.
 */
export function ibmDouble(v: number | null): Buffer {
  const out = Buffer.alloc(8);
  // a SAS missing numeric is a full stop in the first byte
  if (v == null || !Number.isFinite(v)) { out[0] = 0x2e; return out; }
  if (v === 0) return out;

  const neg = v < 0;
  let x = Math.abs(v);
  let e = 0;
  while (x >= 1) { x /= 16; e += 1; }
  while (x < 1 / 16) { x *= 16; e -= 1; }
  // 1/16 <= x < 1, so the mantissa is x × 2^56
  let mant = BigInt(Math.round(x * 2 ** 56));
  // rounding can carry past the top of the mantissa
  if (mant >= 1n << 56n) { mant >>= 4n; e += 1; }

  const exponent = e + 64;
  if (exponent < 0 || exponent > 127) { out[0] = 0x2e; return out; } // out of range reads as missing
  out[0] = (neg ? 0x80 : 0) | (exponent & 0x7f);
  for (let i = 7; i >= 1; i--) { out[i] = Number(mant & 0xffn); mant >>= 8n; }
  return out;
}

const HEADER = (text: string) => pad(text, 80);
const xptDate = (d = new Date()): string => {
  const M = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}${M[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

/** Pad the buffer out to a whole number of 80-byte records, as the format requires. */
function padTo80(chunks: Buffer[]): Buffer {
  const b = Buffer.concat(chunks);
  const rem = b.length % 80;
  return rem === 0 ? b : Buffer.concat([b, Buffer.alloc(80 - rem, 0x20)]);
}

export function buildXpt(input: XptInput): Buffer {
  const taken = new Set<string>();
  const vars = input.variables.map((v, i) => ({
    ...v,
    sas: sasName(v.name, taken),
    len: v.type === "string" ? Math.min(200, Math.max(1, v.stringWidth ?? 200)) : 8,
    index: i + 1,
  }));

  const stamp = xptDate();
  const out: Buffer[] = [];

  out.push(HEADER("HEADER RECORD*******LIBRARY HEADER RECORD!!!!!!!000000000000000000000000000000"));
  // 'SAS' ×2, 'SASLIB', version, OS, 24 blanks, timestamp — exactly 80 bytes.
  // Every record in a transport file is 80 bytes and they are read positionally,
  // so an omitted field does not shorten one record, it shifts the whole file.
  out.push(Buffer.concat([pad("SAS", 8), pad("SAS", 8), pad("SASLIB", 8), pad("9.4", 8), pad("LINUX", 8), pad("", 24), pad(stamp, 16)]));
  out.push(Buffer.concat([pad(stamp, 16), pad("", 64)]));

  out.push(HEADER("HEADER RECORD*******MEMBER  HEADER RECORD!!!!!!!000000000000000001600000000140"));
  out.push(HEADER("HEADER RECORD*******DSCRPTR HEADER RECORD!!!!!!!000000000000000000000000000000"));
  const ds = (input.datasetName ?? "SURVEY").toUpperCase().slice(0, 8);
  out.push(Buffer.concat([pad("SAS", 8), pad(ds, 8), pad("SASDATA", 8), pad("9.4", 8), pad("LINUX", 8), pad("", 24), pad(stamp, 16)]));
  out.push(Buffer.concat([pad(stamp, 16), pad("", 16), pad(input.datasetLabel ?? "", 40), pad("", 8)]));

  out.push(HEADER(`HEADER RECORD*******NAMESTR HEADER RECORD!!!!!!!000000${String(vars.length).padStart(4, "0")}00000000000000000000`));

  const namestrs: Buffer[] = [];
  let pos = 0;
  for (const v of vars) {
    const ns = Buffer.alloc(140, 0x20);
    ns.writeInt16BE(v.type === "string" ? 2 : 1, 0);   // ntype
    ns.writeInt16BE(0, 2);                              // nhfun
    ns.writeInt16BE(v.len, 4);                          // nlng
    ns.writeInt16BE(v.index, 6);                        // nvar0
    pad(v.sas, 8).copy(ns, 8);                          // nname
    pad(v.label, 40).copy(ns, 16);                      // nlabel — 40 chars, hence the .sas script
    pad("", 8).copy(ns, 56);                            // nform
    ns.writeInt16BE(0, 64); ns.writeInt16BE(0, 66); ns.writeInt16BE(0, 68);
    pad("", 2).copy(ns, 70);
    pad("", 8).copy(ns, 72);                            // niform
    ns.writeInt16BE(0, 80); ns.writeInt16BE(0, 82);
    ns.writeInt32BE(pos, 84);                           // npos
    namestrs.push(ns);
    pos += v.len;
  }
  out.push(padTo80(namestrs));

  out.push(HEADER("HEADER RECORD*******OBS     HEADER RECORD!!!!!!!000000000000000000000000000000"));

  const data: Buffer[] = [];
  for (const row of input.rows) {
    for (const v of vars) {
      const raw = row[v.name];
      if (v.type === "numeric") {
        const n = raw == null || raw === "" ? null : Number(raw);
        data.push(ibmDouble(n == null || !Number.isFinite(n) ? null : n));
      } else {
        data.push(pad(raw == null ? "" : String(raw), v.len));
      }
    }
  }
  out.push(padTo80(data));
  return Buffer.concat(out);
}

/* ------------------------------------------------------------ the .sas script */

/**
 * A SAS program that reads the CSV beside it and restores everything the
 * transport format cannot hold: full-length variable names, labels past 40
 * characters, and value labels as real SAS formats.
 *
 * Generated rather than hand-written because it has to agree with the data
 * file exactly — a script whose LABEL statement names a column the CSV does
 * not have fails at the first line, and one whose formats drift from the
 * dictionary quietly mislabels every table built from it.
 */
export function buildSasSyntax(vars: SasVariable[], opts: { csvName?: string; datasetName?: string } = {}): string {
  const csv = opts.csvName ?? "responses.csv";
  const ds = (opts.datasetName ?? "SURVEY").toUpperCase().slice(0, 32);
  const L = (s: string) => ascii(s).replace(/'/g, "''");
  const lines: string[] = [];

  lines.push("/*");
  lines.push(" * Generated by Rescript. Reads the exported CSV and applies the study's");
  lines.push(" * variable labels and value labels.");
  lines.push(" *");
  lines.push(` * 1. Put this file beside ${csv}`);
  lines.push(" * 2. Set the path below");
  lines.push(" * 3. Run");
  lines.push(" */");
  lines.push("");
  lines.push("%let path = /change/me;   /* the folder holding the CSV */");
  lines.push("");

  const withLabels = vars.filter((v) => Object.keys(v.valueLabels ?? {}).length > 0);
  if (withLabels.length) {
    lines.push("proc format;");
    for (const v of withLabels) {
      const fmt = `${sasName(v.name, new Set())}F`.slice(0, 8);
      const numeric = v.type === "numeric";
      lines.push(`  value ${numeric ? "" : "$"}${fmt}`);
      for (const [code, label] of Object.entries(v.valueLabels ?? {})) {
        if (!(label ?? "").trim()) continue;
        lines.push(`    ${numeric ? code : `'${L(code)}'`} = '${L(label)}'`);
      }
      lines.push("  ;");
    }
    lines.push("run;");
    lines.push("");
  }

  lines.push(`proc import datafile="&path/${csv}" out=${ds} dbms=csv replace;`);
  lines.push("  getnames=yes;");
  lines.push("  guessingrows=max;");
  lines.push("run;");
  lines.push("");

  lines.push(`data ${ds};`);
  lines.push(`  set ${ds};`);
  lines.push("  label");
  for (const v of vars) {
    const label = (v.label ?? "").trim();
    if (label) lines.push(`    ${v.name} = '${L(label).slice(0, 256)}'`);
  }
  lines.push("  ;");
  if (withLabels.length) {
    lines.push("  format");
    for (const v of withLabels) {
      const fmt = `${sasName(v.name, new Set())}F`.slice(0, 8);
      lines.push(`    ${v.name} ${v.type === "numeric" ? "" : "$"}${fmt}.`);
    }
    lines.push("  ;");
  }
  lines.push("run;");
  lines.push("");
  return lines.join("\n");
}

/** Decide how a dictionary variable is represented for SAS. Same rule as SPSS. */
export function sasVariableFor(v: VariableDef, widthHint = 200): SasVariable {
  const numericCodes = (v.valueCodes ?? []).length > 0 && (v.valueCodes ?? []).every((c) => Number.isFinite(Number(c)));
  const numeric = v.dataType === "numeric" || v.dataType === "boolean" || numericCodes;
  return {
    name: v.name,
    label: (v.label ?? "").trim() || v.name,
    type: numeric ? "numeric" : "string",
    stringWidth: numeric ? undefined : widthHint,
    valueLabels: v.valueLabels ?? {},
  };
}
