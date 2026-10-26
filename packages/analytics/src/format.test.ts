import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_LOCALE } from "./format.js";
import { fmtNum } from "./analyses/common.js";

/**
 * SERVER-SIDE NUMBERS DO NOT FOLLOW THE SERVER.
 *
 * `(250000).toLocaleString()` with no locale takes the one the Node process
 * was started under, so the same analysis rendered "250,000" in CI and
 * "2,50,000" on a developer's machine with Indian settings. Report text,
 * table labels and PowerPoint exports are all built server-side, so what a
 * client received depended on the deployment region. Twenty-one call sites
 * were affected; `fmtNum` had pinned "en-US" from the start and the rest
 * never did.
 *
 * Reproduce the original failure with:
 *   LC_ALL=en_IN.UTF-8 pnpm --filter @rescript/analytics test
 */

test("the report locale is fixed, whatever the process locale", () => {
  assert.equal((250_000).toLocaleString(REPORT_LOCALE), "250,000");
  assert.equal((1_234_567).toLocaleString(REPORT_LOCALE), "1,234,567");
  assert.equal(fmtNum(250_000, 0), "250,000");
  // the ambient locale is whatever this process was started under; the pinned
  // one must not equal it by accident for the assertions above to mean anything
  assert.equal(REPORT_LOCALE, "en-US");
});

test("no source file formats a number without naming the locale", () => {
  /*
   * A guard rather than a unit test: the defect is invisible on any machine
   * whose locale happens to be en-US, which is every CI runner, so nothing
   * else would catch a new one being added.
   */
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!name.endsWith(".ts")) continue;
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        // the doc comments in this file and in format.ts quote the broken form on purpose
        if (/\*/.test(line.trim().slice(0, 1))) return;
        if (/\.toLocaleString\(\s*\)/.test(line)) offenders.push(`${name}:${i + 1}`);
      });
    }
  };
  walk(src);
  assert.deepEqual(offenders, [], `pass REPORT_LOCALE — a bare toLocaleString() follows the server's own locale:\n  ${offenders.join("\n  ")}`);
});
