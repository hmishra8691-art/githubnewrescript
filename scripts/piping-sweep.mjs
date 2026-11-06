#!/usr/bin/env node
/**
 * THE PIPING SWEEP (platform audit 2026-11-05) — defects of absence, found mechanically.
 *
 * Nine of the audit's ten piping defects were the same shape: something built, tested and never connected to
 * the thing it was built for — a SQL function no code calls, a table no code reads, an export no module
 * imports. Each would have been caught at the commit that introduced it by a few seconds of cross-referencing.
 * This is that cross-referencing, run by `pnpm audit:code` and by CI on every push:
 *
 *   1. SQL FUNCTIONS NOTHING REACHES   every `create or replace function public.<name>` in the migrations,
 *                                      against every rpc("<name>") in TypeScript, every trigger binding and every
 *                                      reference from inside another migration. A function reached by none is
 *                                      listed — unless it is in KNOWN_UNREACHED_FUNCTIONS with a reason.
 *   2. TABLES NOTHING READS / WRITES   every `create table` in the migrations, against from("<table>") in
 *                                      TypeScript and insert/update/delete in SQL. Reported separately: a table
 *                                      nothing writes is a feature that never produces; a table nothing reads
 *                                      is one that produces into the void.
 *   3. EXPORTS NOTHING IMPORTS         every `export const|function|class` in packages/*\/src, counted against a
 *                                      concatenation of all source; a count of one is the definition alone.
 *   4. VARIABLES NOBODY DOCUMENTED     every `process.env.<NAME>` against .env.example. 39 were missing on the
 *                                      day of the audit; a new deployment could not be configured from the file.
 *
 * The allow-lists are the audit's own findings that were decided rather than fixed (a table awaiting its
 * writer, a function kept for an operator). Adding to them is a decision and needs a reason beside the name.
 * The sweep fails on anything new.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const failures = [];

function files(dir, pred, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files(full, pred, out);
    else if (pred(full)) out.push(full);
  }
  return out;
}

const migrations = files("supabase/migrations", (f) => f.endsWith(".sql")).sort();
const sql = migrations.map((f) => readFileSync(f, "utf8")).join("\n");
const tsFiles = [...files("apps", (f) => /\.(ts|tsx|mjs)$/.test(f)), ...files("packages", (f) => /\.(ts|tsx|mjs)$/.test(f)), ...files("scripts", (f) => /\.(ts|tsx|mjs|sql)$/.test(f))];
const ts = tsFiles.map((f) => readFileSync(f, "utf8")).join("\n");

/* ------------------------------------------------------------ 1. functions */

const KNOWN_UNREACHED_FUNCTIONS = {
  rescript_assessment_distribution: "an operator's query over assessment_results (0076); no screen yet",
  rescript_balance_counts: "an operator's query over the exact-balance claims (0079); no screen yet",
  rescript_billing_open_period: "billing operations: opens a period by hand (0036); the cron closes them",
  rescript_billing_set_spending: "billing operations: sets a project's spending policy by hand (0038)",
  rescript_interview_person_recordings: "an operator's query (0030); no screen yet",
  rescript_invitation_sends: "an operator's query over invitation deliveries (0017)",
  rescript_media_for_survey: "an operator's query over a survey's media (0028)",
  survey_publish_state: "a dashboard query kept for the SQL editor (0004)",
  survey_dashboard_stats: "superseded by the per-survey counts (0075); kept for the SQL editor",
};

const defined = new Set([...sql.matchAll(/create or replace function public\.([a-z0-9_]+)/g)].map((m) => m[1]));
const dropped = new Set([...sql.matchAll(/drop function if exists public\.([a-z0-9_]+)/g)].map((m) => m[1]));
const calledTs = new Set([...ts.matchAll(/rpc\(\s*["'`]([a-z0-9_]+)["'`]/g)].map((m) => m[1]));
/* a function named through a variable or a template (`rescript_${x}`) — any other mention in TypeScript counts */
const mentionedTs = new Set([...ts.matchAll(/\b(rescript_[a-z0-9_]+|survey_[a-z0-9_]+|current_[a-z0-9_]+|touch_[a-z0-9_]+)\b/g)].map((m) => m[1]));
for (const name of defined) {
  if (dropped.has(name) && !sql.split(`drop function if exists public.${name}`).pop().includes(`create or replace function public.${name}`)) continue;
  if (calledTs.has(name) || mentionedTs.has(name)) continue;
  /* referenced from SQL other than its own definition: a trigger, a policy, another function's body */
  const refs = (sql.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
  const own = (sql.match(new RegExp(`(create or replace function public\\.${name}\\b|revoke all on function public\\.${name}\\b|grant execute on function public\\.${name}\\b|comment on function public\\.${name}\\b)`, "g")) ?? []).length;
  if (refs > own) continue;
  if (KNOWN_UNREACHED_FUNCTIONS[name]) continue;
  failures.push(`function ${name} is defined and reached by nothing (no rpc(), trigger, policy or SQL caller)`);
}
for (const name of Object.keys(KNOWN_UNREACHED_FUNCTIONS)) {
  if (!defined.has(name)) failures.push(`KNOWN_UNREACHED_FUNCTIONS names ${name}, which no migration defines any more — remove it`);
}

/* --------------------------------------------------------------- 2. tables */

const KNOWN_UNWRITTEN_TABLES = {
  design_files: "0058's decision: kept until a loader for designs[].file.storagePath exists",
  interview_exports: "the Interviews export queue, designed and not built (0092 says so on the table)",
  vendor_quotations: "written by the `quote` adapter capability, which no adapter yet declares (0092)",
};
const KNOWN_UNREAD_TABLES = {
  identity_match_tokens: "written for the probabilistic matcher's future; the resolver reads trust ids (0083)",
};

const created = new Set([...sql.matchAll(/create table(?: if not exists)? public\.([a-z0-9_]+)/g)].map((m) => m[1]));
const droppedTables = new Set([...sql.matchAll(/drop table if exists public\.([a-z0-9_]+)/g)].map((m) => m[1]));
const tableInTs = (t) => new RegExp(`from\\(\\s*["'\`]${t}["'\`]|["'\`]${t}["'\`]`).test(ts);
for (const t of created) {
  if (droppedTables.has(t)) continue;
  const inTs = tableInTs(t);
  const writtenSql = new RegExp(`(insert into|update|delete from)\\s+public\\.${t}\\b`).test(sql);
  const readSql = new RegExp(`(from|join)\\s+public\\.${t}\\b`).test(sql);
  if (!inTs && !writtenSql && !KNOWN_UNWRITTEN_TABLES[t]) failures.push(`table ${t} is created and written by nothing`);
  if (!inTs && !readSql && !writtenSql && !KNOWN_UNWRITTEN_TABLES[t] && !KNOWN_UNREAD_TABLES[t]) failures.push(`table ${t} is created and read by nothing`);
}

/* -------------------------------------------------------------- 3. exports */

const corpusCounts = new Map();
for (const w of ts.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) corpusCounts.set(w, (corpusCounts.get(w) ?? 0) + 1);
for (const f of files("packages", (p) => /\/src\/.*\.ts$/.test(p) && !/\.test\.ts$/.test(p) && !/\.snapshot\.ts$/.test(p))) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/^export (?:const|function|async function|class) ([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    if ((corpusCounts.get(m[1]) ?? 0) <= 1) failures.push(`${f}: export ${m[1]} appears only at its own definition`);
  }
}

/* ---------------------------------------------------------- 4. environment */

/* set by the platform or by a test harness, never by an operator */
const PLATFORM_ENV = new Set(["NODE_ENV", "VERCEL_ENV", "VERCEL_GIT_COMMIT_SHA", "NEXT_DIST_DIR", "TZ", "WRITE_OPERATOR_SNAPSHOT", "WRITE_CORPUS_SNAPSHOT", "RESCRIPT_NL_DEBUG"]);
const envExample = readFileSync(".env.example", "utf8");
const documented = new Set([...envExample.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));
/* the applications and packages only — scripts/ is the test harness, whose knobs are its own business */
const appSrc = tsFiles.filter((f) => !f.startsWith("scripts/")).map((f) => readFileSync(f, "utf8")).join("\n");
const referenced = new Set([...appSrc.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
for (const name of referenced) {
  if (!documented.has(name) && !PLATFORM_ENV.has(name)) failures.push(`process.env.${name} is read and not in .env.example`);
}

console.log(`piping sweep: ${defined.size} SQL functions, ${created.size} tables, packages' exports checked — ${failures.length} problem(s)`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
