#!/usr/bin/env node
/**
 * Verify the SPSS and SAS writers against pyreadstat — a separate
 * implementation (the ReadStat C library) that knows nothing about our code.
 *
 *   node scripts/verify-statistical-exports.mjs
 *
 * The unit tests in packages/exporters read these files back with decoders of
 * our own, which catches structural mistakes but shares our assumptions: if
 * we misread the specification, the writer and the reader are wrong in the
 * same direction and agree with each other. This script is the check against
 * that, so it is worth running whenever either writer changes.
 *
 * It is NOT part of `pnpm test`, because it needs Python and pyreadstat:
 *
 *   pip install pyreadstat --break-system-packages
 *
 * Without them it prints how to get them and exits 0, so a contributor who
 * has neither is not blocked.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = spawnSync("python3", ["-c", "import pyreadstat"], { encoding: "utf8" });
if (probe.status !== 0) {
  console.log("SKIP: python3 with pyreadstat is not available.");
  console.log("      pip install pyreadstat --break-system-packages");
  process.exit(0);
}

const { buildSav } = await import("../packages/exporters/dist/spss.js");
const { buildXpt } = await import("../packages/exporters/dist/sas.js");
const { buildDta } = await import("../packages/exporters/dist/stata.js");

const dir = mkdtempSync(join(tmpdir(), "rescript-stat-"));

/* A dictionary that exercises every feature the writers claim to support. */
const variables = [
  { name: "RESPID", label: "Respondent identifier", type: "numeric", measure: "nominal" },
  {
    name: "Q1_GENDER", label: "What is your gender?", type: "numeric", measure: "nominal",
    valueLabels: { 1: "Male", 2: "Female", 99: "Prefer not to say" },
    missingValues: [99],
  },
  { name: "Q2_AGE", label: "Age in years", type: "numeric", measure: "scale" },
  {
    name: "A_VARIABLE_NAME_THAT_IS_WELL_PAST_EIGHT_CHARACTERS",
    label: "A variable label that is considerably longer than the forty characters a transport file allows",
    type: "numeric", measure: "ordinal",
    valueLabels: { 0: "No", 1: "Yes" },
  },
  { name: "Q4_OPEN", label: "Any other comments?", type: "string", stringWidth: 60 },
  { name: "WEIGHT", label: "Design weight", type: "numeric", measure: "scale" },
];

const rows = [
  { RESPID: 1001, Q1_GENDER: 1, Q2_AGE: 34, A_VARIABLE_NAME_THAT_IS_WELL_PAST_EIGHT_CHARACTERS: 1, Q4_OPEN: "Good service", WEIGHT: 1.25 },
  { RESPID: 1002, Q1_GENDER: 2, Q2_AGE: 51, A_VARIABLE_NAME_THAT_IS_WELL_PAST_EIGHT_CHARACTERS: 0, Q4_OPEN: "", WEIGHT: 0.5 },
  { RESPID: 1003, Q1_GENDER: 99, Q2_AGE: null, A_VARIABLE_NAME_THAT_IS_WELL_PAST_EIGHT_CHARACTERS: 1, Q4_OPEN: "A much longer open end, with a comma", WEIGHT: 2 },
  { RESPID: 1004, Q1_GENDER: 1, Q2_AGE: 7, A_VARIABLE_NAME_THAT_IS_WELL_PAST_EIGHT_CHARACTERS: 0, Q4_OPEN: "x", WEIGHT: -3.75 },
  { RESPID: 1005, Q1_GENDER: 2, Q2_AGE: 100, A_VARIABLE_NAME_THAT_IS_WELL_PAST_EIGHT_CHARACTERS: 1, Q4_OPEN: "0.1 test", WEIGHT: 0.1 },
];

writeFileSync(join(dir, "out.sav"), buildSav({ variables, rows, fileLabel: "Rescript verification" }));
writeFileSync(join(dir, "out.xpt"), buildXpt({ variables, rows, datasetName: "SURVEY", datasetLabel: "Rescript verification" }));
writeFileSync(join(dir, "out.dta"), buildDta({ variables, rows, fileLabel: "Rescript verification" }));
writeFileSync(join(dir, "expected.json"), JSON.stringify({ variables, rows }));

const script = `
import json, math, sys
import pyreadstat

d = ${JSON.stringify(dir)}
exp = json.load(open(d + "/expected.json"))
fail = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: fail.append(msg)

print("SPSS (.sav)")
df, meta = pyreadstat.read_sav(d + "/out.sav")
names = [v["name"] for v in exp["variables"]]
check(meta.column_names == names, f"variable names: {meta.column_names}")
check(meta.column_labels == [v["label"] for v in exp["variables"]], "variable labels")
check(meta.variable_value_labels.get("Q1_GENDER") == {1.0: "Male", 2.0: "Female", 99.0: "Prefer not to say"},
      f"value labels on Q1_GENDER: {meta.variable_value_labels.get('Q1_GENDER')}")
check(meta.variable_value_labels.get(names[3]) == {0.0: "No", 1.0: "Yes"},
      "value labels survive on a long-named variable")
check(list(df["Q1_GENDER"])[0] == 1.0, "the CELL holds the code, not the label")
check(math.isnan(list(df["Q2_AGE"])[2]), "a missing numeric reads as missing")
check(list(df["Q4_OPEN"])[2] == "A much longer open end, with a comma", "string values are intact")
check([round(x, 10) for x in df["WEIGHT"]] == [1.25, 0.5, 2.0, -3.75, 0.1], f"numeric precision: {list(df['WEIGHT'])}")

# user-defined missing is declared, so it can be honoured or ignored on read
dfm, metam = pyreadstat.read_sav(d + "/out.sav", user_missing=True)
check(99.0 in set(dfm["Q1_GENDER"]), "the 99 is still readable when user_missing is on")
check(math.isnan(list(df["Q1_GENDER"])[2]), "and treated as missing by default — i.e. it was DECLARED, not just stored")

print("SAS transport (.xpt)")
xdf, xmeta = pyreadstat.read_xport(d + "/out.xpt")
check(len(xmeta.column_names) == len(names), f"one column per variable: {xmeta.column_names}")
check(all(len(n) <= 8 for n in xmeta.column_names), "names fit the 8-character transport limit")
check(len(set(xmeta.column_names)) == len(xmeta.column_names), "truncated names are still unique")
check(xmeta.column_labels[0] == "Respondent identifier", f"labels: {xmeta.column_labels[0]}")
check([round(x, 10) for x in xdf.iloc[:, 5]] == [1.25, 0.5, 2.0, -3.75, 0.1],
      f"IBM hex float round-trip: {list(xdf.iloc[:, 5])}")
check(math.isnan(list(xdf.iloc[:, 2])[2]), "a missing numeric reads as missing")

print("Stata (.dta)")
sdf, smeta = pyreadstat.read_dta(d + "/out.dta")
check(smeta.column_names[0] == "RESPID", f"variable names: {smeta.column_names}")
check(all(len(n) <= 32 for n in smeta.column_names), "names fit Stata's 32-character limit")
check(len(set(smeta.column_names)) == len(smeta.column_names), "truncated names are still unique")
check(smeta.column_labels[1] == "What is your gender?", f"variable labels: {smeta.column_labels[1]}")
check(smeta.variable_value_labels.get("Q1_GENDER") == {1.0: "Male", 2.0: "Female", 99.0: "Prefer not to say"},
      f"value labels: {smeta.variable_value_labels.get('Q1_GENDER')}")
check(len(smeta.variable_value_labels) == 2, f"BOTH label sets are read: {list(smeta.variable_value_labels)}")
check([round(x, 10) for x in sdf["WEIGHT"]] == [1.25, 0.5, 2.0, -3.75, 0.1], f"numeric precision: {list(sdf['WEIGHT'])}")
check(math.isnan(list(sdf["Q2_AGE"])[2]), "a missing numeric reads as missing")
check(list(sdf["Q4_OPEN"])[2] == "A much longer open end, with a comma", "UTF-8 strings are intact")

print()
if fail:
    print(f"{len(fail)} check(s) FAILED")
    sys.exit(1)
print("All checks passed against pyreadstat.")
`;

writeFileSync(join(dir, "verify.py"), script);
try {
  execFileSync("python3", [join(dir, "verify.py")], { stdio: "inherit" });
} catch {
  process.exit(1);
}
