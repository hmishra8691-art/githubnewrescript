#!/usr/bin/env node
/**
 * REPLAY A LANGUAGE CORPUS (Phase 8).
 *
 *   node scripts/corpus-replay.mjs <corpus.json> [...more]   — read every sentence again, print same / better / worse / changed and the backlog
 *   node scripts/corpus-replay.mjs --record <corpus.json>    — rewrite the file with the readings as they are now (after a deliberate change)
 *   node scripts/corpus-replay.mjs                           — every file in packages/engine/corpus
 *
 * A corpus is what the Studio exports from a project's History ("Export the
 * language corpus") or POST /api/copilot/corpus: the survey and its sentences
 * with the reading each one got. Exit code 1 when any sentence is worse.
 * Build the engine first (pnpm --filter @rescript/engine build).
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describeReplay, recordCorpus, replayCorpus } from "../packages/engine/dist/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const record = args.includes("--record");
const files = args.filter((a) => !a.startsWith("--"));
const targets = files.length ? files : readdirSync(join(ROOT, "packages", "engine", "corpus")).filter((f) => f.endsWith(".json")).map((f) => join(ROOT, "packages", "engine", "corpus", f));
let worse = 0;
for (const file of targets) {
  const corpus = JSON.parse(readFileSync(file, "utf8"));
  if (record) { writeFileSync(file, `${JSON.stringify(recordCorpus(corpus), null, 1)}\n`); console.log(`recorded ${file}`); continue; }
  const report = replayCorpus(corpus);
  console.log(describeReplay(report, corpus));
  worse += report.counts.worse;
}
process.exit(worse ? 1 : 0);
