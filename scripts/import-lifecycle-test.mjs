#!/usr/bin/env node
/**
 * I8 — THE IMPORT LIFECYCLE, end to end at package level, for every file in the corpora:
 *
 *   read the file → map it → the survey passes the schema → the pre-field deliverable check runs
 *   → three simulated respondents take it on the runtime engine (first / last / deepest answers)
 *   → their responses export to CSV and SPSS (.sav) with a column for every question they answered
 *
 *   node scripts/import-lifecycle-test.mjs          (after `pnpm -r build`)
 *
 * What it does NOT do, and says so: publish. Publishing is a database write (deployments table) that needs the
 * Studio and Supabase; the sandbox has neither. Everything a published survey RUNS is exercised here — the same
 * engine functions the runtime Runner calls, and the same exporters the Studio's export routes call.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeImport } from "../packages/import/dist/index.js";
import { walkSurvey } from "../packages/import/dist/verify.js";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { validateSurveyDeliverable } from "../packages/engine/dist/index.js";
import { responsesToCSV, responsesToSav } from "../packages/exporters/dist/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "import", "corpus");
const files = [
  ...readdirSync(join(ROOT, "qsf")).filter((f) => f.endsWith(".qsf")).map((f) => join(ROOT, "qsf", f)),
  ...readdirSync(join(ROOT, "word")).filter((f) => f.endsWith(".docx")).map((f) => join(ROOT, "word", f)),
  join(ROOT, "brand-instructions.txt"),
];
let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => { if (cond) pass++; else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); } return cond; };

for (const f of files) {
  const name = f.split("/").pop();
  let n = 0;
  const a = await analyzeImport(new Uint8Array(readFileSync(f)), name, { surveyId: "lifecycle", uid: (p) => `${p}_${++n}` });
  const def = a.result?.def;
  if (!ok(!!def, `${name}: imported`, a.issues?.map((i) => i.message).join("; "))) continue;
  const parsed = SurveyDefinition.safeParse(def);
  ok(parsed.success, `${name}: passes the schema`, parsed.success ? "" : parsed.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  let pre;
  try { pre = validateSurveyDeliverable(def); ok(true, `${name}: deliverable check runs`); } catch (e) { ok(false, `${name}: deliverable check runs`, e.message); }
  const states = [];
  for (const [i, strategy] of ["first", "last", "deepest"].entries()) {
    const w = walkSurvey(def, strategy, 11 + i, { keepState: true });
    ok(!w.error && /^(complete|screened|terminated|quota_full)/.test(String(w.end)), `${name}: respondent ${i + 1} (${strategy}) reaches an end`, `${w.end} ${w.error ?? ""}`);
    if (w.state) states.push({ ...w.state, sessionId: `life-${i}`, respondentId: `r${i}` });
  }
  const answered = new Set(states.flatMap((s) => Object.keys(s.answers).map((k) => k.split("@")[0])));
  const csv = responsesToCSV(def, states);
  const lines = csv.trim().split(/\r?\n/);
  ok(lines.length === states.length + 1, `${name}: CSV has a header and one row per respondent`, `${lines.length} lines`);
  const header = lines[0].split(",");
  const missing = def.questions.filter((q) => answered.has(q.id) && q.type !== "html" && !header.some((h) => h === q.variableName || h.startsWith(`${q.variableName}_`)));
  ok(missing.length === 0, `${name}: every answered question has a CSV column`, missing.map((q) => q.variableName).slice(0, 5).join(", "));
  let sav;
  try { sav = responsesToSav(def, states); } catch (e) { ok(false, `${name}: SPSS export`, e.message); }
  if (sav) ok(sav.subarray(0, 4).toString("latin1") === "$FL2" && sav.length > 200, `${name}: SPSS (.sav) file written`, `${sav.length} bytes`);
  console.log(`${name}: ${def.questions.length} questions · schema ${parsed.success ? "ok" : "FAIL"} · deliverable ${pre ? (pre.ok ? "ok" : `${pre.errors.length} error(s) — ${pre.errors.slice(0, 2).map((e) => e.message).join(" / ").slice(0, 160)}`) : "?"} · ends ${states.map((s) => s.status).join("/")} · CSV ${lines.length - 1} rows × ${header.length} cols · SAV ${sav?.length ?? 0} B`);
}
console.log(`\nlifecycle: ${pass} passed, ${fail} failed (publish is not exercised here — it needs the Studio and a database)`);
process.exit(fail ? 1 : 0);
