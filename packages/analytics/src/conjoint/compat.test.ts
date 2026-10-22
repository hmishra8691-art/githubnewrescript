import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * BACKWARD COMPATIBILITY (F4, 2026-10-22). The JSON in scripts/conjoint-suite/snapshots/ was written
 * by make-snapshots.mjs against the build BEFORE the conjoint suite; this recomputes the same inputs
 * with the current build and requires them unchanged: every pre-existing CBC (balanced, efficient,
 * None, holdouts, pair + combination prohibitions, versions), MaxDiff, menu and ACBC design
 * regenerates byte-identically; the CBC and MaxDiff analyses, the menu counts table and an HB run
 * give the same numbers; the wide export, the variable dictionary and the stacked CBC file are equal.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SNAP = join(ROOT, "scripts", "conjoint-suite", "snapshots");

test("existing conjoint / MaxDiff designs, analyses and exports are unchanged by the conjoint suite", { timeout: 180_000 }, async () => {
  const { snapshotInputs } = await import(pathToFileURL(join(ROOT, "scripts", "conjoint-suite", "snapshot-inputs.mjs")).href);
  const now = JSON.parse(JSON.stringify(await snapshotInputs()));
  for (const part of ["designs", "analyses", "exports"]) {
    const before = JSON.parse(readFileSync(join(SNAP, `${part}.json`), "utf8"));
    for (const key of Object.keys(before)) assert.deepEqual(now[part][key], before[key], `${part}.${key} changed`);
  }
});
