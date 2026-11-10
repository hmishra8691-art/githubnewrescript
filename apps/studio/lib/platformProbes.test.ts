import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE /platform MIGRATION PROBES NAME COLUMNS THAT EXIST (2026-11-10). Each probe selects one column of a table its
 * migration created (`id` when none is named); a probe naming a column the table does not have fails on a database
 * where the migration IS applied, and the page then says "not applied". 0007, 0025, 0032 and 0089 did exactly that —
 * their tables have no `id`. This reads every probe from the route and finds its table's column in the migrations up
 * to and including the probe's own: in a `create table` of that table, or an `alter table … add column` of it.
 */
const ROOT = join(process.cwd(), "..", "..");
const route = readFileSync(join(process.cwd(), "app", "api", "platform", "route.ts"), "utf8");
const probes = [...route.matchAll(/\{ migration: "(\d{4})", what: "[^"]*", table: "([a-z_]+)"(?:, column: "([a-z_]+)")? \}/g)].map((m) => ({ migration: m[1], table: m[2], column: m[3] ?? "id" }));
const dir = join(ROOT, "supabase", "migrations");
const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

function created(table: string, column: string, upTo: string): boolean {
  const t = table.replace(/_/g, "_");
  for (const f of files.filter((x) => x.slice(0, 4) <= upTo)) {
    const sql = readFileSync(join(dir, f), "utf8").toLowerCase();
    /* create table [if not exists] [public.]<table> ( … ); — the body up to the closing ");" at the start of a line */
    const create = new RegExp(`create table (?:if not exists )?(?:public\\.)?"?${t}"?\\s*\\(([\\s\\S]*?)\\n\\);`, "g");
    for (const m of sql.matchAll(create)) if (new RegExp(`(^|\\n)\\s*"?${column}"?\\s`).test(m[1])) return true;
    const alter = new RegExp(`alter table (?:if exists )?(?:only )?(?:public\\.)?"?${t}"?[\\s\\S]*?add column (?:if not exists )?"?${column}"?\\s`, "g");
    if (alter.test(sql)) return true;
  }
  return false;
}

test("every /platform probe selects a column its migration created", () => {
  assert.ok(probes.length >= 40, `${probes.length} probes read from the route`);
  const wrong = probes.filter((p) => !created(p.table, p.column, p.migration));
  assert.deepEqual(wrong, [], `probes naming a column their table does not have: ${wrong.map((p) => `${p.migration} ${p.table}.${p.column}`).join(", ")}`);
});
