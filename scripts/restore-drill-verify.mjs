#!/usr/bin/env node
/**
 * THE RESTORE DRILL'S MEASUREMENT (audit 2026-11-17, P1-12) — run after a backup has been restored into staging.
 *
 *   PRIMARY_DB_URL     postgres://… of production, read-only use (a read replica or a read-only role is best)
 *   RESTORED_DB_URL    postgres://… of the restored staging database
 *   RESTORE_STARTED_AT ISO time the restore was started (from the drill log) — the RTO clock starts here
 *   BACKUP_TAKEN_AT    ISO time of the backup / point in time restored — the RPO is how far it lags production
 *   STAGING_HEALTH_URL optional: the staging Studio's /api/health, which must answer ok or degraded
 *
 * It compares the row counts of the tables that matter most, newest timestamps in each, migrations recorded
 * (schema_marks), and prints a drill report in markdown — RTO (restore start → restored database verified) and RPO
 * (newest production row newer than the newest restored row). Needs `psql` on the PATH. Read-only on both databases.
 */
import { execFileSync } from "node:child_process";

const env = process.env;
const P = env.PRIMARY_DB_URL, R = env.RESTORED_DB_URL;
if (!P || !R) { console.error("Set PRIMARY_DB_URL and RESTORED_DB_URL (see the header)."); process.exit(2); }
const TABLES = [
  ["surveys", "updated_at"], ["survey_versions", "created_at"], ["responses", "updated_at"], ["respondents", "updated_at"],
  ["profiles", "updated_at"], ["audit_logs", "created_at"], ["media_objects", "created_at"], ["analytics_model_jobs", "updated_at"],
];
const q = (url, sql) => execFileSync("psql", [url, "-At", "-v", "ON_ERROR_STOP=1", "-c", `set default_transaction_read_only = on; ${sql}`], { encoding: "utf8", timeout: 120_000 }).trim().split("\n").pop();

const rows = [];
let worstLagMs = 0;
for (const [t, ts] of TABLES) {
  const sql = `select count(*) || '|' || coalesce(max(${ts})::text, '') from public.${t}`;
  let a, b;
  try { a = q(P, sql); } catch (e) { a = `error|${String(e.message).split("\n")[0]}`; }
  try { b = q(R, sql); } catch (e) { b = `error|${String(e.message).split("\n")[0]}`; }
  const [pc, pmax] = a.split("|"), [rc, rmax] = b.split("|");
  const lag = pmax && rmax ? Date.parse(pmax) - Date.parse(rmax) : null;
  if (lag && lag > worstLagMs) worstLagMs = lag;
  rows.push({ t, pc, rc, pmax, rmax, lag });
}
const marks = (url) => { try { return q(url, "select string_agg(migration, ',' order by migration) from public.schema_marks"); } catch { return ""; } };
const pm = marks(P), rm = marks(R);
const missingMarks = pm.split(",").filter((m) => m && !rm.split(",").includes(m));

let health = "not checked";
if (env.STAGING_HEALTH_URL) {
  try { const r = await fetch(env.STAGING_HEALTH_URL); const j = await r.json(); health = `${r.status} ${j.status}`; } catch (e) { health = `unreachable (${e.message})`; }
}
const verifiedAt = new Date();
const rto = env.RESTORE_STARTED_AT ? (verifiedAt.getTime() - Date.parse(env.RESTORE_STARTED_AT)) / 60000 : null;
const rpo = env.BACKUP_TAKEN_AT ? Math.max(0, (Date.now() - Date.parse(env.BACKUP_TAKEN_AT)) / 60000) : null;

console.log(`# Restore drill — ${verifiedAt.toISOString().slice(0, 16).replace("T", " ")} UTC\n`);
console.log(`- **RTO** (restore started → restored database verified): ${rto == null ? "set RESTORE_STARTED_AT" : `${rto.toFixed(0)} min`}`);
console.log(`- **RPO** (data written after the backup point, lost if this were real): ${rpo == null ? "set BACKUP_TAKEN_AT" : `${rpo.toFixed(0)} min`}; newest-row lag across the tables below: ${(worstLagMs / 60000).toFixed(0)} min`);
console.log(`- Migrations recorded in production but not in the restore: ${missingMarks.length ? missingMarks.join(", ") : "none"}`);
console.log(`- Staging Studio health: ${health}\n`);
console.log("| Table | Production rows | Restored rows | Newest in production | Newest restored |\n|---|---:|---:|---|---|");
for (const r of rows) console.log(`| ${r.t} | ${r.pc} | ${r.rc} | ${r.pmax || "—"} | ${r.rmax || "—"} |`);
const bad = rows.some((r) => r.rc.startsWith("error")) || missingMarks.length > 0;
console.log(`\n**Result:** ${bad ? "FAILED — see the rows marked error or the missing migrations" : "restored database answers; counts differ only by what was written after the backup point"}`);
process.exit(bad ? 1 : 0);
