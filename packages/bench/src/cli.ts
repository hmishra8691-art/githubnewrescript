#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, renderScorecard, runSuites, type Scorecard } from "./core.js";
import { allSuites } from "./run.js";

/**
 * pnpm bench                    run every benchmark, compare with the committed baseline, exit 1 on a regression
 *                               or a benchmark that disappeared
 * pnpm bench --update-baseline  the same, then keep this run as the baseline and rewrite the scorecard document
 * pnpm bench --only fraud       only the suites whose id contains the word (no comparison of the others)
 *
 * A metric below its Level 5 target is a gap, printed and not failing: the targets are the roadmap's destination.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const BASELINE = join(root, "packages/bench/baseline.json");
const SCORECARD = join(root, "docs/LEVEL5-SCORECARD.md");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const update = args.includes("--update-baseline");

let commit: string | null = null;
try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null; } catch { commit = null; }

const suites = allSuites(root).filter((s) => !only || s.id.includes(only));
if (!suites.length) { console.error(`no benchmark matches "${only}"`); process.exit(2); }
const card = await runSuites(suites, { commit });
const stored: Scorecard | null = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
const baseline = stored && only ? { ...stored, suites: stored.suites.filter((s) => s.id.includes(only)) } : stored;
const cmp = compare(card, baseline);
const text = renderScorecard(card, baseline ? cmp : undefined);
console.log(text);

const out = join(root, "packages/bench/dist/last-run.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(card, null, 2) + "\n");

if (update) {
  if (only) { console.error("--update-baseline keeps a whole run; drop --only"); process.exit(2); }
  const failed = card.suites.filter((s) => s.status === "blocked" && s.reason?.startsWith("the suite failed to run"));
  if (failed.length) { console.error(`not keeping a baseline with a suite that failed to run: ${failed.map((s) => s.id).join(", ")}`); process.exit(1); }
  writeFileSync(BASELINE, JSON.stringify(card, null, 2) + "\n");
  writeFileSync(SCORECARD, renderScorecard(card) + "\n");
  console.log(`baseline kept: packages/bench/baseline.json; scorecard: docs/LEVEL5-SCORECARD.md`);
  process.exit(0);
}
if (!baseline) { console.error("there is no baseline to compare with: run with --update-baseline once"); process.exit(1); }
const crashed = card.suites.filter((s) => s.status === "blocked" && s.reason?.startsWith("the suite failed to run"));
if (crashed.length) { console.error(`a benchmark failed to run: ${crashed.map((s) => `${s.id} (${s.reason})`).join("; ")}`); process.exit(1); }
if (!cmp.ok) { console.error(`FAILED: ${cmp.regressions.length} regression(s), ${cmp.missing.length} missing`); process.exit(1); }
console.log(`OK: no regression against the baseline. ${cmp.gaps.length} metric(s) below their Level 5 target, ${cmp.blocked.length} benchmark(s) not measurable.`);
