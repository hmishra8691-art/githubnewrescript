import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SurveyDefinition } from "@rescript/schema";
import { variableMetadata } from "./dataset.js";

/*
 * Y8 — THE CODE FRAME MUST BE THE DATABASE'S.
 *
 * `_status` declared a category `screened_out`. The column's check
 * constraint says `screened`. Nothing anywhere mapped one to the other, so
 * every status banner carried a "Screened out" row at n = 0 while the real
 * screen-outs sat in an unlabelled `screened` row — or, where the crosstab
 * used the declared frame as a filter, vanished from the base entirely.
 *
 * A test that just asserted the string `screened` would have gone stale the
 * moment someone added a status. This one reads the constraint out of the
 * migration, so the two cannot drift apart again: add a status to the
 * database and this fails until the frame knows about it.
 */

function repoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "supabase", "migrations"))) return d;
    d = dirname(d);
  }
  throw new Error("could not find the repository root from " + import.meta.url);
}

/**
 * The statuses the `responses.status` check constraint actually permits.
 *
 * Scoped to the `responses` table on purpose: `surveys` has a `status` check
 * of its own, with an entirely different vocabulary (draft/testing/live/
 * closed), and a regex loose enough to hit whichever came first in the file
 * would compare the response frame against the survey lifecycle.
 */
function dbStatuses(): string[] {
  const sql = readFileSync(join(repoRoot(), "supabase", "migrations", "0001_core_schema.sql"), "utf8");
  const table = /create table public\.responses\s*\(([\s\S]*?)\n\);/i.exec(sql);
  assert.ok(table, "could not find the responses table in 0001_core_schema.sql");
  const m = /check\s*\(\s*status\s+in\s*\(([^)]*)\)/i.exec(table![1]);
  assert.ok(m, "could not find the status check constraint on public.responses");
  const codes = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(codes.length >= 3, `parsed too few statuses: ${JSON.stringify(codes)}`);
  return codes;
}

/** The categories `_status` declares, read back through the public surface. */
function declaredStatuses(): string[] {
  const vars = variableMetadata(SurveyDefinition.parse({ meta: { id: "s", title: "t" }, questions: [], flow: [] }));
  const v = vars.find((x) => x.name === "_status");
  assert.ok(v, "_status is missing from the variable metadata");
  return (v!.categories ?? []).map((c) => c.code);
}

test("every status the database can store is in the _status code frame", () => {
  const db = dbStatuses();
  const declared = declaredStatuses();
  const missing = db.filter((c) => !declared.includes(c));
  assert.deepEqual(
    missing,
    [],
    `these statuses exist in the database and would show up unlabelled: ${missing.join(", ")}`,
  );
});

test("the frame invents no status the database cannot store", () => {
  /*
   * The other direction, and the one that was actually broken: a declared
   * code with no data behind it is a permanent n = 0 row that a client reads
   * as "nobody screened out".
   */
  const db = dbStatuses();
  const invented = declaredStatuses().filter((c) => !db.includes(c));
  assert.deepEqual(
    invented,
    [],
    `these codes are declared but no response can ever carry them: ${invented.join(", ")}`,
  );
});
