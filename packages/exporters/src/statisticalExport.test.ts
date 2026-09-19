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
  type ResponseStateLike,
} from "./index.js";

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
