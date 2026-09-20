import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  responsesToCSV,
  responsesToSav,
  responsesToXpt,
  responsesToSasSyntax,
  buildResponseMatrix,
  renderValue,
  ibmDouble,
  spssName,
  sasName,
  responsesToSavBundle,
  responsesToDta,
  stataName,
  responsesToSasBundle,
  variableDictionaryToCSV,
  BUILT_IN_EXPORT_PRESETS,
  type ResponseStateLike,
} from "./index.js";
import { DataExportPreset } from "@rescript/schema";

/** Entry names in a stored zip, read straight from the central directory. */
function zipEntryNames(buf: Buffer): string[] {
  const out: string[] = [];
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;   // central directory header
    const nameLen = buf.readUInt16LE(i + 28);
    out.push(buf.toString("utf8", i + 46, i + 46 + nameLen));
  }
  return out;
}

/**
 * These tests READ THE FILES BACK.
 *
 * Asserting that a .sav is a non-empty buffer starting with "$FL2" proves
 * only that the first four bytes were written; every real defect found while
 * building this writer — a tab eaten by the ASCII sanitiser, value labels
 * pointing at the wrong variable because continuation records were not
 * counted, an 80-byte transport record that was 72 — produced a perfectly
 * plausible buffer of roughly the right size. So the readers below are small,
 * independent decoders, and the assertions are about what comes out of them.
 *
 * `scripts/verify-statistical-exports.mjs` does the same job against
 * pyreadstat, which is a genuinely independent implementation. It is not run
 * here because it needs Python.
 */

/* ------------------------------------------------------------ a tiny .sav reader */

interface SavRead {
  /** the 8-character short names, as record 2 stores them */
  shortNames: string[];
  /** the real names, resolved through the 7/13 long-name map */
  names: string[];
  labels: Record<string, string>;
  /** value-label sets, keyed by the variable they were attached to */
  valueLabels: Record<string, Record<string, string>>;
  missing: Record<string, number[]>;
  cases: Record<string, unknown>[];
}

function readSav(buf: Buffer): SavRead {
  let p = 0;
  const i32 = () => { const v = buf.readInt32LE(p); p += 4; return v; };
  const f64 = () => { const v = buf.readDoubleLE(p); p += 8; return v; };
  const str = (n: number) => { const s = buf.toString("latin1", p, p + n); p += n; return s; };

  assert.equal(str(4), "$FL2", "SPSS magic");
  p += 60;                       // product name
  const layout = i32();
  assert.equal(layout, 2, "layout code must be 2 or the file is big-endian");
  const nominalCaseSize = i32();
  i32();                         // compression
  i32();                         // weight index
  const ncases = i32();
  f64();                         // bias
  p += 9 + 8 + 64 + 3;           // date, time, file label, padding

  /*
   * A variable wider than 8 bytes is stored as a head record plus one
   * continuation record per extra 8 bytes, and the value-label records index
   * variables by POSITION INCLUDING THE CONTINUATIONS. `slots` therefore
   * counts every record and `slotOwner` maps a slot back to the real variable
   * — which is exactly the arithmetic the writer has to get right.
   */
  const names: string[] = [];
  const labels: Record<string, string> = {};
  const missing: Record<string, number[]> = {};
  const widths: number[] = [];
  const slotOwner: (string | null)[] = [];

  let rec = i32();
  while (rec === 2) {
    const type = i32();
    const hasLabel = i32();
    const nMissing = i32();
    i32();                       // print format
    i32();                       // write format
    const name = str(8).trimEnd();
    if (type === -1) {
      slotOwner.push(null);      // continuation record: no variable of its own
    } else {
      slotOwner.push(name);
      names.push(name);
      widths.push(type);
      if (hasLabel) {
        const len = i32();
        labels[name] = str(len).trimEnd();
        p += (4 - (len % 4)) % 4;   // padded to a 4-byte boundary
      }
      if (nMissing) {
        const vals: number[] = [];
        for (let k = 0; k < Math.abs(nMissing); k++) vals.push(f64());
        missing[name] = vals;
      }
    }
    rec = i32();
  }

  const valueLabels: Record<string, Record<string, string>> = {};
  const longNames: Record<string, string> = {};
  while (rec !== 999) {
    if (rec === 3) {
      const n = i32();
      const set: Record<string, number | string> = {};
      const raw: { value: number; label: string }[] = [];
      for (let k = 0; k < n; k++) {
        const value = f64();
        const len = buf.readUInt8(p); p += 1;
        const label = str(len);
        p += (8 - ((len + 1) % 8)) % 8;
        raw.push({ value, label });
      }
      void set;
      const next = i32();
      assert.equal(next, 4, "a value-label record must be followed by its variable list");
      const count = i32();
      for (let k = 0; k < count; k++) {
        const slot = i32();                       // 1-based, counting continuations
        const owner = slotOwner[slot - 1];
        assert.ok(owner, `value labels attached to continuation slot ${slot}`);
        const m: Record<string, string> = {};
        for (const { value, label } of raw) m[String(value)] = label;
        valueLabels[owner!] = m;
      }
    } else if (rec === 7) {
      const subtype = i32();
      const size = i32();
      const count = i32();
      if (subtype === 13) {
        /*
         * The long-name map: `SHORT=LongName`, entries separated by a TAB.
         * Parsing it here rather than trusting it is the point — the writer
         * once ran this string through the ASCII sanitiser, which replaced
         * the tab with a space and merged every entry into one, giving the
         * first variable a name built out of the second one's mapping.
         */
        const text = str(size * count);
        for (const entry of text.split("\t")) {
          const eq = entry.indexOf("=");
          if (eq > 0) longNames[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
      } else {
        p += size * count;
      }
    } else if (rec === 6) {
      const lines = i32();
      p += lines * 80;
    } else {
      throw new Error(`unexpected record type ${rec}`);
    }
    rec = i32();
  }
  i32();                         // the filler after 999

  const cases: Record<string, unknown>[] = [];
  for (let c = 0; c < ncases; c++) {
    const row: Record<string, unknown> = {};
    names.forEach((name, vi) => {
      const w = widths[vi];
      if (w === 0) {
        const v = f64();
        row[name] = v === -Number.MAX_VALUE ? null : v;
      } else {
        const octets = Math.ceil(w / 8) * 8;
        row[name] = str(octets).slice(0, w).trimEnd();
      }
    });
    cases.push(row);
  }
  assert.equal(nominalCaseSize, slotOwner.length, "nominal case size must count continuation records");
  const resolve = (n: string) => longNames[n] ?? n;
  const remap = <T,>(o: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [resolve(k), v]));
  return {
    shortNames: names,
    names: names.map(resolve),
    labels: remap(labels),
    valueLabels: remap(valueLabels),
    missing: remap(missing),
    cases: cases.map(remap),
  };
}

/* ------------------------------------------------------------ a tiny .xpt reader */

function ibmToIeee(b: Buffer): number | null {
  if (b[0] === 0x2e && b.subarray(1).every((x) => x === 0)) return null;   // missing
  if (b.every((x) => x === 0)) return 0;
  const neg = (b[0] & 0x80) !== 0;
  const exp = (b[0] & 0x7f) - 64;
  let mant = 0n;
  for (let i = 1; i < 8; i++) mant = (mant << 8n) | BigInt(b[i]);
  const value = Number(mant) / 2 ** 56 * 16 ** exp;
  return neg ? -value : value;
}

function readXpt(buf: Buffer): { names: string[]; labels: string[]; rows: Record<string, unknown>[] } {
  assert.equal(buf.length % 80, 0, "every transport record is 80 bytes");
  const at = (n: number) => buf.toString("latin1", n * 80, (n + 1) * 80);
  assert.ok(at(0).startsWith("HEADER RECORD*******LIBRARY"), "library header");
  assert.ok(at(3).startsWith("HEADER RECORD*******MEMBER"), "member header");
  assert.ok(at(4).startsWith("HEADER RECORD*******DSCRPTR"), "descriptor header");
  const nsHeader = at(7);
  assert.ok(nsHeader.startsWith("HEADER RECORD*******NAMESTR"), "namestr header");
  const nvars = parseInt(nsHeader.slice(54, 58), 10);

  const base = 8 * 80;
  const names: string[] = [];
  const labels: string[] = [];
  const types: number[] = [];
  const lens: number[] = [];
  for (let i = 0; i < nvars; i++) {
    const o = base + i * 140;
    types.push(buf.readInt16BE(o));
    lens.push(buf.readInt16BE(o + 4));
    names.push(buf.toString("latin1", o + 8, o + 16).trimEnd());
    labels.push(buf.toString("latin1", o + 16, o + 56).trimEnd());
  }

  // the OBS header sits on the next 80-byte boundary after the namestrs
  let obs = base + Math.ceil((nvars * 140) / 80) * 80;
  assert.ok(buf.toString("latin1", obs, obs + 27).startsWith("HEADER RECORD*******OBS"), "observation header");
  obs += 80;

  const rowLen = lens.reduce((a, b) => a + b, 0);
  const rows: Record<string, unknown>[] = [];
  for (let o = obs; o + rowLen <= buf.length; o += rowLen) {
    // a trailing record padded with blanks is not an observation
    if (buf.subarray(o, o + rowLen).every((x) => x === 0x20)) break;
    const row: Record<string, unknown> = {};
    let c = o;
    for (let i = 0; i < nvars; i++) {
      if (types[i] === 1) { row[names[i]] = ibmToIeee(buf.subarray(c, c + 8)); }
      else { row[names[i]] = buf.toString("latin1", c, c + lens[i]).trimEnd(); }
      c += lens[i];
    }
    rows.push(row);
  }
  return { names, labels, rows };
}

/* ------------------------------------------------------------ fixture */

function makeSurvey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "svy_stat", code: "STAT01", title: "Statistical Export Test", version: "1.0", status: "testing" },
    questions: [
      {
        id: "q_gender", code: "Q1", variableName: "GENDER", type: "single_select",
        text: "What is your gender?", required: true,
        options: [{ code: "1", label: "Male" }, { code: "2", label: "Female" }, { code: "99", label: "Prefer not to say" }],
      },
      {
        id: "q_brands", code: "Q2", variableName: "BRANDS", type: "multi_select",
        text: "Which brands do you know?",
        options: [{ code: "1", label: "Brand A" }, { code: "2", label: "Brand B" }],
      },
      { id: "q_age", code: "Q3", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q_open", code: "Q4", variableName: "COMMENT", type: "text", text: "Any other comments?" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_gender", "q_brands", "q_age", "q_open"] }],
  });
}

const states: ResponseStateLike[] = [
  {
    sessionId: "sess_001", respondentId: "r1", surveyVersion: "1.0",
    startedAt: "2026-01-15T10:00:00.000Z", status: "complete",
    answers: { q_gender: "1", q_brands: ["1", "2"], q_age: 42, q_open: "Everything was fine" },
    embedded: {}, calculated: {},
  },
  {
    sessionId: "sess_002", respondentId: "r2", surveyVersion: "1.0",
    startedAt: "2026-01-15T11:00:00.000Z", status: "complete",
    answers: { q_gender: "99", q_brands: ["2"], q_age: 7, q_open: "" },
    embedded: {}, calculated: {},
  },
];

/* ------------------------------------------------------------ tests */

test("SPSS: names, variable labels and value labels survive the write", () => {
  const def = makeSurvey();
  const sav = readSav(responsesToSav(def, states));

  assert.ok(sav.names.includes("GENDER"), `GENDER missing from ${sav.names.join(", ")}`);
  assert.equal(sav.labels.GENDER, "What is your gender?");

  // the thing the format exists for: the code is the value, the label is metadata
  assert.deepEqual(sav.valueLabels.GENDER, { "1": "Male", "2": "Female", "99": "Prefer not to say" });
  assert.equal(sav.cases[0].GENDER, 1, "the CELL holds the code, never the label");
  assert.equal(sav.cases[1].GENDER, 99);
});

test("SPSS: value labels land on the right variable when a long string precedes them", () => {
  /*
   * The regression this exists for. COMMENT is a wide string, so it occupies
   * several dictionary slots, and the value-label record indexes slots rather
   * than variables. Get that wrong and GENDER's labels attach to whatever
   * variable happens to sit at slot N — a file that opens cleanly in SPSS and
   * is wrong.
   */
  const def = makeSurvey();
  const sav = readSav(responsesToSav(def, states));
  for (const [variable, labels] of Object.entries(sav.valueLabels)) {
    assert.ok(sav.names.includes(variable), `labels attached to unknown variable ${variable}`);
    if (variable === "GENDER") assert.equal(labels["1"], "Male");
    if (variable.startsWith("BRANDS_")) assert.equal(labels["1"], "Selected");
  }
  assert.ok(sav.valueLabels.GENDER, "GENDER must still own its own labels");
});

test("SPSS: names longer than eight characters survive via the long-name map", () => {
  /*
   * Record 2 can only hold 8 characters, so SESSION_ID is stored as
   * `SESSION_` and the real name lives in the 7/13 map. Several variables
   * here are over-length, which is what makes this a test of the TAB
   * separator: with the entries merged, the first name read back as a
   * fragment of the second one's mapping.
   */
  const def = makeSurvey();
  const sav = readSav(responsesToSav(def, states));

  assert.ok(sav.shortNames.includes("SESSION_"), "the short name is truncated to eight");
  assert.ok(sav.names.includes("SESSION_ID"), `long name not recovered from ${sav.names.join(", ")}`);
  assert.ok(sav.names.includes("SURVEY_VERSION"));
  assert.ok(sav.names.includes("START_TIME"));
  for (const n of sav.names) assert.doesNotMatch(n, /[\s=]/, `"${n}" looks like a merged map entry`);
});

test("SAS transport: numbers round-trip through IBM hex float", () => {
  const def = makeSurvey();
  const xpt = readXpt(responsesToXpt(def, states));
  assert.ok(xpt.names.includes("AGE"));
  assert.equal(xpt.rows[0].AGE, 42);
  assert.equal(xpt.rows[1].AGE, 7);
  assert.equal(xpt.rows[0].GENDER, 1);
  assert.equal(xpt.rows[1].GENDER, 99);
});

test("SAS transport: IBM float conversion is exact for values a survey produces", () => {
  for (const v of [0, 1, -1, 0.1, 0.5, 2.5, 7, 42, 99, 100, 1234.5678, -0.25, 1e6]) {
    const back = ibmToIeee(ibmDouble(v));
    assert.equal(back, v, `${v} did not survive the round trip (got ${back})`);
  }
  assert.equal(ibmToIeee(ibmDouble(null)), null, "a missing numeric stays missing");
});

test("SAS syntax: every labelled variable gets a format and every variable a label", () => {
  const def = makeSurvey();
  const sas = responsesToSasSyntax(def, states);
  assert.match(sas, /proc format;/);
  assert.match(sas, /'Male'/);
  assert.match(sas, /'Prefer not to say'/);
  assert.match(sas, /GENDER = 'What is your gender\?'/);
  assert.match(sas, /proc import/);
  // the script must reference the CSV it will actually sit beside
  assert.match(sas, /STAT01_responses\.csv/);
});

test("SAS: truncated names are made unique rather than silently colliding", () => {
  const taken = new Set<string>();
  const a = sasName("Q1_SATISFACTION", taken);
  const b = sasName("Q1_SATISFIED", taken);
  assert.notEqual(a, b, "two columns must never share a name");
  assert.equal(a.length <= 8, true);
  assert.equal(b.length <= 8, true);
});

test("code / label / code+label change the cells and nothing else", () => {
  const def = makeSurvey();
  const codes = responsesToCSV(def, states);
  const labels = responsesToCSV(def, states, undefined, { valueMode: "label" });
  const both = responsesToCSV(def, states, undefined, { valueMode: "code_label" });

  const cols = (csv: string) => csv.split("\n")[0].split(",").length;
  assert.equal(cols(labels), cols(codes), "label mode must not change the column count");
  assert.equal(cols(both), cols(codes));
  assert.equal(labels.split("\n").length, codes.split("\n").length, "nor the row count");

  assert.match(codes, /,1,/);
  assert.match(labels, /Male/);
  assert.match(both, /1 - Male/);
  // an unlabelled value is untouched in every mode, so a number stays a number
  assert.match(labels, /,42,/);
  assert.match(both, /,42,/);
});

test("label mode leaves the open text alone", () => {
  const def = makeSurvey();
  const labels = responsesToCSV(def, states, undefined, { valueMode: "label" });
  assert.match(labels, /Everything was fine/);
});

test("a multiple response is labelled per option, not flattened into one cell", () => {
  /*
   * A multi-select reaches the file as one 0/1 column per option — the form
   * every statistical package can actually tabulate — so label mode has to
   * label the FLAG, giving Selected / Not selected rather than leaving bare
   * ones and zeros beside labelled columns.
   */
  const def = makeSurvey();
  const labels = responsesToCSV(def, states, undefined, { valueMode: "label" });
  const [header, r1, r2] = labels.trim().split("\n");
  assert.ok(header.includes("BRANDS_1") && header.includes("BRANDS_2"));
  assert.match(r1, /Selected,Selected/);
  assert.match(r2, /Not selected,Selected/);

  // and where a column DOES hold the list of codes, the array survives as an
  // array so each format can apply its own delimiter
  const brands = { name: "BRANDS", label: "Brands", valueLabels: { "1": "Brand A", "2": "Brand B" } } as any;
  assert.deepEqual(renderValue(["1", "2"], brands, "code"), ["1", "2"]);
  assert.deepEqual(renderValue(["1", "2"], brands, "label"), ["Brand A", "Brand B"]);
  assert.deepEqual(renderValue(["1", "2"], brands, "code_label"), ["1 - Brand A", "2 - Brand B"]);
});

test("every format exports the same columns in the same order", () => {
  /*
   * A client who opens the .sav beside the .csv and finds different columns
   * has two datasets and no way to know which one is the study.
   */
  const def = makeSurvey();
  const matrix = buildResponseMatrix(def, states);
  const csvHeader = responsesToCSV(def, states).split("\n")[0].split(",");
  const sav = readSav(responsesToSav(def, states));
  const xpt = readXpt(responsesToXpt(def, states));

  assert.deepEqual(csvHeader, matrix.names, "CSV must follow the shared matrix");
  assert.equal(sav.names.length, matrix.names.length, "SPSS must have one variable per column");
  assert.equal(xpt.names.length, matrix.names.length, "SAS must have one variable per column");
  // SPSS keeps the full name in the long-name map, so these match outright
  assert.deepEqual(sav.names, matrix.names, "SPSS columns must match the matrix exactly");
  // SAS transport truncates to eight, so compare against that rule
  const taken = new Set<string>();
  assert.deepEqual(xpt.names, matrix.names.map((n) => sasName(n, taken)));
});

test("the existing default output is byte-for-byte unchanged", () => {
  /*
   * The brief's hard constraint: this update must not disturb what already
   * works. Any caller that does not ask for a value mode must get the file it
   * got before the option existed.
   */
  const def = makeSurvey();
  assert.equal(
    responsesToCSV(def, states),
    responsesToCSV(def, states, undefined, { valueMode: "code", headerMode: "name" }),
  );
});

/* ------------------------------------- §44 phase 2: the delivery properties */

function withOverrides(def: SurveyDefinition, overrides: any[]): SurveyDefinition {
  const next = JSON.parse(JSON.stringify(def));
  next.variables = overrides;
  return next;
}

test("declared missing values reach the .sav as missing-value declarations", () => {
  /*
   * The point of declaring them: a mean over GENDER must not average the
   * 99s in. Writing them as ordinary values would leave the file looking
   * right and every statistic computed from it wrong.
   */
  const def = withOverrides(makeSurvey(), [
    { name: "GENDER", label: "What is your gender?", dataType: "numeric", responseType: "single_select",
      valueCodes: [], valueLabels: {}, derived: false, hidden: false, missingValues: [99] },
  ]);
  const sav = readSav(responsesToSav(def, states));
  assert.deepEqual(sav.missing.GENDER, [99], `expected 99 declared missing, got ${JSON.stringify(sav.missing)}`);
});

test("an export name renames the column in every format at once", () => {
  const def = withOverrides(makeSurvey(), [
    { name: "GENDER", label: "What is your gender?", dataType: "numeric", responseType: "single_select",
      valueCodes: [], valueLabels: {}, derived: false, hidden: false, exportName: "S1_GENDER" },
  ]);

  const csvHeader = responsesToCSV(def, states).split("\n")[0].split(",");
  assert.ok(csvHeader.includes("S1_GENDER"), `CSV: ${csvHeader.join(",")}`);
  assert.ok(!csvHeader.includes("GENDER"), "the platform name must not also appear");

  const sav = readSav(responsesToSav(def, states));
  assert.ok(sav.names.includes("S1_GENDER"), `SPSS: ${sav.names.join(", ")}`);

  const xpt = readXpt(responsesToXpt(def, states));
  assert.ok(xpt.names.includes("S1_GENDE"), `SAS (8 chars): ${xpt.names.join(", ")}`);
});

test("an export name does not cost the column its data", () => {
  /*
   * The trap: the writers look up each row's value by the variable's name.
   * Rename the variable for output without re-keying the rows and every
   * value silently becomes missing — a file with the right columns, the
   * right labels and no data in it.
   */
  const def = withOverrides(makeSurvey(), [
    { name: "GENDER", label: "What is your gender?", dataType: "numeric", responseType: "single_select",
      valueCodes: [], valueLabels: {}, derived: false, hidden: false, exportName: "S1_GENDER" },
  ]);
  const sav = readSav(responsesToSav(def, states));
  assert.equal(sav.cases[0].S1_GENDER, 1, "the first respondent's answer must still be there");
  assert.equal(sav.cases[1].S1_GENDER, 99);

  const xpt = readXpt(responsesToXpt(def, states));
  assert.equal(xpt.rows[0].S1_GENDE, 1);
});

test("a missing value that the variable's type cannot hold is dropped, not written", () => {
  // "n/a" on a numeric variable would corrupt the dictionary record
  const def = withOverrides(makeSurvey(), [
    { name: "AGE", label: "How old are you?", dataType: "numeric", responseType: "numeric",
      valueCodes: [], valueLabels: {}, derived: false, hidden: false, missingValues: ["n/a"] },
  ]);
  const sav = readSav(responsesToSav(def, states));
  assert.equal(sav.missing.AGE, undefined, "a non-numeric missing code must not be declared on a numeric variable");
  assert.equal(sav.cases[0].AGE, 42, "and the data is unaffected");
});

test("the SAS syntax marks the codes that mean no answer", () => {
  const def = withOverrides(makeSurvey(), [
    { name: "GENDER", label: "What is your gender?", dataType: "numeric", responseType: "single_select",
      valueCodes: [], valueLabels: {}, derived: false, hidden: false, missingValues: [99] },
  ]);
  const sas = responsesToSasSyntax(def, states);
  const line = sas.split("\n").find((l) => l.includes("Prefer not to say"));
  assert.ok(line, "the value label must be in the syntax");
  assert.match(line!, /declared missing/, "and be marked as a missing code");
  const male = sas.split("\n").find((l) => l.includes("'Male'"));
  assert.doesNotMatch(male!, /declared missing/, "a real answer must not be marked");
});

/* ------------------------------------- §44 phase 4: dictionary and presets */

test("the data dictionary carries the delivery properties", () => {
  const def = withOverrides(makeSurvey(), [
    { name: "GENDER", label: "What is your gender?", dataType: "numeric", responseType: "single_select",
      valueCodes: [], valueLabels: {}, derived: false, hidden: false,
      missingValues: [99], exportName: "S1_GENDER", measure: "nominal" },
  ]);
  const csv = variableDictionaryToCSV(def);
  const [header, ...rows] = csv.trim().split("\n");
  assert.ok(header.includes("Export Name"), header);
  assert.ok(header.includes("Missing Values"), header);
  assert.ok(header.includes("Measure"), header);

  const line = rows.find((r) => r.startsWith("GENDER,"));
  assert.ok(line, "the variable must be in the dictionary");
  assert.ok(line!.includes("S1_GENDER"), `the export name must be there: ${line}`);
  assert.ok(line!.includes("99"), `the missing code must be there: ${line}`);
  assert.ok(line!.includes("nominal"), `the measure must be there: ${line}`);
});

test("asking for the dictionary with SPSS gives a zip containing both", () => {
  /*
   * A .sav is one file, so the dictionary cannot ride inside it. Asking for
   * it changes the shape of the download, which is why it is opt-in — a bare
   * format=sav must keep returning the single file it returned in phase 1.
   */
  const def = makeSurvey();
  const bundle = responsesToSavBundle(def, states);
  const names = zipEntryNames(bundle);
  assert.ok(names.some((n) => n.endsWith(".sav")), names.join(", "));
  assert.ok(names.some((n) => n.endsWith("_dictionary.csv")), names.join(", "));
  assert.ok(names.includes("README.txt"));

  // and the plain call is untouched
  const plain = responsesToSav(def, states);
  assert.equal(plain.toString("latin1", 0, 4), "$FL2", "format=sav on its own is still a bare .sav");
});

test("the SAS bundle includes the dictionary only when asked", () => {
  const def = makeSurvey();
  const without = zipEntryNames(responsesToSasBundle(def, states, { csv: "a,b\n1,2\n" }));
  assert.equal(without.some((n) => n.includes("dictionary")), false, without.join(", "));

  const with_ = zipEntryNames(responsesToSasBundle(def, states, { csv: "a,b\n1,2\n", includeDictionary: true }));
  assert.ok(with_.some((n) => n.endsWith("_dictionary.csv")), with_.join(", "));
  // the rest of the bundle is unchanged
  assert.ok(with_.some((n) => n.endsWith(".xpt")) && with_.some((n) => n.endsWith(".sas")));
});

test("the built-in presets are usable settings, not decoration", () => {
  assert.ok(BUILT_IN_EXPORT_PRESETS.length >= 3);
  for (const p of BUILT_IN_EXPORT_PRESETS) {
    assert.ok(p.id.startsWith("builtin_"), `${p.name} must be identifiable as built in`);
    assert.ok(p.name.trim().length > 0);
    // every one must survive the schema it is stored and read through
    const parsed = DataExportPreset.safeParse(p);
    assert.equal(parsed.success, true, `${p.name}: ${parsed.success ? "" : parsed.error.message}`);
  }
  const spss = BUILT_IN_EXPORT_PRESETS.find((p) => p.format === "sav");
  assert.ok(spss, "a research export in SPSS is the point of the feature");
  assert.equal(spss!.values, "code", "a statistical export carries codes, not labels");

  const client = BUILT_IN_EXPORT_PRESETS.find((p) => p.name === "Client Data Export");
  assert.equal(client!.values, "label", "the client file reads without the questionnaire beside it");
});

/* ------------------------------------------------------ Stata (.dta) */

/** A small independent .dta reader — same discipline as the .sav and .xpt ones. */
function readDta(buf: Buffer): {
  names: string[];
  labels: string[];
  valueLabels: Record<string, Record<string, string>>;
  rows: Record<string, unknown>[];
} {
  const text = buf.toString("latin1");
  assert.ok(text.startsWith("<stata_dta>"), "the magic marker");
  assert.match(text, /<release>118<\/release>/, "format 118");

  /*
   * THE MAP IS CHECKED, NOT TRUSTED. It is 14 byte offsets Stata uses to jump
   * straight to each section; one that disagrees with the real layout gives a
   * file that opens and is misread, which is the same class of failure as the
   * SPSS value-label indexes.
   */
  const mapAt = text.indexOf("<map>") + 5;
  const offs: number[] = [];
  for (let i = 0; i < 14; i++) offs.push(Number(buf.readBigUInt64LE(mapAt + i * 8)));
  const tagAt = (o: number) => text.slice(o, o + 24);
  assert.equal(offs[0], 0, "the map's first entry is the start of the file");
  assert.ok(tagAt(offs[2]).startsWith("<variable_types>"), `map[2] should be variable_types, found ${tagAt(offs[2])}`);
  assert.ok(tagAt(offs[3]).startsWith("<varnames>"), `map[3] should be varnames, found ${tagAt(offs[3])}`);
  assert.ok(tagAt(offs[9]).startsWith("<data>"), `map[9] should be data, found ${tagAt(offs[9])}`);
  assert.ok(tagAt(offs[11]).startsWith("<value_labels>"), `map[11] should be value_labels, found ${tagAt(offs[11])}`);
  assert.equal(offs[13], buf.length, "the last entry is the file length");

  const kAt = text.indexOf("<K>") + 3;
  const nvar = buf.readUInt16LE(kAt);
  const nAt = text.indexOf("<N>") + 3;
  const nobs = Number(buf.readBigUInt64LE(nAt));

  let p = offs[2] + "<variable_types>".length;
  const types: number[] = [];
  for (let i = 0; i < nvar; i++) { types.push(buf.readUInt16LE(p)); p += 2; }

  p = offs[3] + "<varnames>".length;
  const names: string[] = [];
  for (let i = 0; i < nvar; i++) {
    names.push(buf.toString("utf8", p, p + 129).split("\u0000")[0]);
    p += 129;
  }

  p = offs[7] + "<variable_labels>".length;
  const labels: string[] = [];
  for (let i = 0; i < nvar; i++) {
    labels.push(buf.toString("utf8", p, p + 321).split("\u0000")[0]);
    p += 321;
  }

  p = offs[9] + "<data>".length;
  const rows: Record<string, unknown>[] = [];
  for (let r = 0; r < nobs; r++) {
    const row: Record<string, unknown> = {};
    names.forEach((name, i) => {
      if (types[i] === 65526) {
        const raw = buf.readDoubleLE(p); p += 8;
        // Stata's system missing for a double
        row[name] = Number.isNaN(raw) || raw >= 8.988465674311579e307 ? null : raw;
      } else {
        row[name] = buf.toString("utf8", p, p + types[i]).split("\u0000")[0];
        p += types[i];
      }
    });
    rows.push(row);
  }

  /* value labels: each <lbl> declares its own body length, and the reader
   * uses it to find the next one — getting that number wrong is why two
   * label sets once made the whole file unreadable */
  const valueLabels: Record<string, Record<string, string>> = {};
  p = offs[11] + "<value_labels>".length;
  while (text.startsWith("<lbl>", p)) {
    p += 5;
    const bodyLen = buf.readInt32LE(p); p += 4;
    const setName = buf.toString("utf8", p, p + 129).split("\u0000")[0]; p += 129 + 3;
    const start = p;
    const n = buf.readInt32LE(p); p += 4;
    const txtlen = buf.readInt32LE(p); p += 4;
    const offsets2: number[] = [];
    for (let i = 0; i < n; i++) { offsets2.push(buf.readInt32LE(p)); p += 4; }
    const values: number[] = [];
    for (let i = 0; i < n; i++) { values.push(buf.readInt32LE(p)); p += 4; }
    const txt = buf.toString("utf8", p, p + txtlen); p += txtlen;
    assert.equal(p - start, bodyLen, `the declared body length must match what was written for ${setName}`);
    const m: Record<string, string> = {};
    for (let i = 0; i < n; i++) m[String(values[i])] = txt.slice(offsets2[i]).split("\u0000")[0];
    valueLabels[setName] = m;
    assert.ok(text.startsWith("</lbl>", p), "each label set must be closed");
    p += 6;
  }
  return { names, labels, valueLabels, rows };
}

test("Stata: names, labels, value labels and data survive the write", () => {
  const def = makeSurvey();
  const dta = readDta(responsesToDta(def, states));

  assert.ok(dta.names.includes("GENDER"), dta.names.join(", "));
  assert.equal(dta.labels[dta.names.indexOf("GENDER")], "What is your gender?");
  assert.deepEqual(dta.valueLabels.GENDER, { "1": "Male", "2": "Female", "99": "Prefer not to say" });
  assert.equal(dta.rows[0].GENDER, 1, "the cell holds the code, as in every statistical format");
  assert.equal(dta.rows[1].GENDER, 99);
  assert.equal(dta.rows[0].AGE, 42);
});

test("Stata: several value-label sets are all readable", () => {
  /*
   * The regression. Each <lbl> declares its own BODY length and the reader
   * uses it to find the next one; counting the 129-byte name and its padding
   * into that number overshoots by 132, which made one set carry no labels
   * and two sets make the whole file unreadable.
   */
  const def = makeSurvey();
  const dta = readDta(responsesToDta(def, states));
  assert.ok(Object.keys(dta.valueLabels).length >= 2,
    `more than one set must be readable, got ${JSON.stringify(Object.keys(dta.valueLabels))}`);
  for (const [name, labels] of Object.entries(dta.valueLabels)) {
    assert.ok(dta.names.includes(name), `labels attached to unknown variable ${name}`);
    assert.ok(Object.keys(labels).length > 0, `${name} has an empty label set`);
  }
});

test("Stata keeps text that SAS transport cannot", () => {
  /*
   * The reason to offer Stata as well as SAS: .dta is UTF-8 throughout, so a
   * study with accented text delivers intact, where the transport file is
   * ASCII and turns Café into Cafe.
   */
  const def = makeSurvey();
  const accented: ResponseStateLike[] = [{
    ...states[0],
    answers: { ...(states[0].answers as object), q_open: "Café — naïve" } as any,
  }];
  const dta = readDta(responsesToDta(def, accented));
  assert.equal(dta.rows[0].COMMENT, "Café — naïve");
});

test("Stata: a reserved word cannot become a variable name", () => {
  // `if` and `in` are Stata commands; a variable called `if` makes every
  // do-file touching the dataset a syntax error
  const taken = new Set<string>();
  for (const word of ["if", "in", "_n", "byte"]) {
    const out = stataName(word, taken);
    assert.notEqual(out.toLowerCase(), word.toLowerCase(), `${word} must be escaped, got ${out}`);
  }
});

test("Stata: truncated names stay unique", () => {
  const taken = new Set<string>();
  const a = stataName("A_VARIABLE_NAME_THAT_IS_WELL_PAST_THIRTY_TWO_ONE", taken);
  const b = stataName("A_VARIABLE_NAME_THAT_IS_WELL_PAST_THIRTY_TWO_TWO", taken);
  assert.notEqual(a, b);
  assert.ok(a.length <= 32 && b.length <= 32);
});

test("every format still exports the same columns, now including Stata", () => {
  const def = makeSurvey();
  const matrix = buildResponseMatrix(def, states);
  const dta = readDta(responsesToDta(def, states));
  assert.equal(dta.names.length, matrix.names.length, "one Stata variable per column");
  const taken = new Set<string>();
  assert.deepEqual(dta.names, matrix.names.map((n) => stataName(n, taken)));
});
