#!/usr/bin/env node
/**
 * BACKWARD-COMPATIBILITY SNAPSHOTS for the conjoint suite (F4, 2026-10-22).
 *
 * Run ONCE against the build that predates the suite; the JSON it writes is
 * committed (scripts/conjoint-suite/snapshots/) and the tests in
 * packages/analytics/src/conjoint/compat.test.ts compare the CURRENT build
 * against it: existing CBC / MaxDiff / menu / ACBC designs regenerate
 * byte-identically, existing CBC / MaxDiff analyses and the menu counts table
 * give the same numbers, the wide and stacked exports and the variable
 * dictionary are unchanged.
 *
 *   node scripts/conjoint-suite/make-snapshots.mjs     (after `pnpm -r --filter ./packages/* build`)
 *
 * Re-running it after the suite landed would bless whatever the code does
 * now — only do that deliberately, for an intended change, and say so.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotInputs } from "./snapshot-inputs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "snapshots");
mkdirSync(out, { recursive: true });
const snaps = await snapshotInputs();
for (const [name, value] of Object.entries(snaps)) writeFileSync(join(out, `${name}.json`), JSON.stringify(value, null, 1) + "\n");
console.log(`wrote ${Object.keys(snaps).length} snapshots to ${out}`);
