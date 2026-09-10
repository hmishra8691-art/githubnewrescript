/**
 * RUN THE BROWSER CORPUS.
 *
 * `pnpm test` runs the unit suites and `pnpm audit:code` runs the static
 * audits. Neither touches the ~48 Playwright suites in this directory,
 * because those need both dev servers up — so nothing ran them, and two of
 * them rotted in plain sight:
 *
 *   · `auth-guard-audit.mjs` drifted to 15 failures while
 *     `docs/COLLABORATION.md` still said "0 unguarded";
 *   · `canvas-test.mjs` had been red since Fieldwork, Project and
 *     Distribution were added, because its navigation filter was never
 *     updated and nobody re-ran it.
 *
 * Both were found by accident. This script exists so the next one is found on
 * purpose.
 *
 *   node scripts/verify-browser.mjs                  the whole corpus
 *   node scripts/verify-browser.mjs --only logic     just the matching ones
 *   node scripts/verify-browser.mjs --jobs 4         in parallel — see below
 *   node scripts/verify-browser.mjs --list           what it would run
 *
 * ## WHY IT RUNS ONE AT A TIME BY DEFAULT
 *
 * The first full run of the corpus reported six failures. Four of them —
 * `autopunch-media-test.mjs` and three `variants-g*` suites — were `--jobs 3`
 * artefacts: every one of them was waiting for `[data-qid]` in the runtime
 * preview, and every one of them passed on its own. Three Chromiums driving
 * three cold `next dev` compiles of the same routes starve each other past a
 * 30-second selector wait, and the suite blames the app.
 *
 * A parallel runner that invents failures is worse than no runner, because a
 * red run nobody believes is a red run nobody reads. So `--jobs` stays
 * available for a narrowed `--only` on a big machine, and the default is 1.
 * The whole corpus is ~35 minutes sequentially; that is a price worth paying
 * for a result that means something.
 *
 * ## The three properties that make it worth trusting
 *
 * 1. THE LIST IS DISCOVERED, NOT WRITTEN. Every `scripts/*-test.mjs` is in
 *    the corpus unless it is on the exclusion list below WITH A REASON. A
 *    hardcoded list of suites is a list that a new suite gets left off, which
 *    is the failure this script is here to prevent.
 *
 * 2. A SKIP IS A FAILURE UNLESS IT WAS DECLARED. If a suite cannot run — a
 *    timeout, a crash, a missing dependency — the run is red. "48 of 51
 *    passed" with no explanation of the other three is exactly how a corpus
 *    quietly shrinks.
 *
 * 3. IT LEAVES THE MACHINE AS IT FOUND IT. Servers this script started are
 *    stopped; servers that were already running are left alone, because
 *    killing a developer's dev server mid-session to run a check is a good
 *    way to make somebody stop running the check.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";

/**
 * Suites that need something this script cannot provide, with the reason.
 *
 * All three want a REAL Postgres with the migrations applied — they assert
 * concurrency guarantees (one active session under 60-way contention, the
 * atomic List Fill claim, the edit lock under real simultaneity) that only a
 * database can settle. They are not browser suites at all and belong in a
 * separate step against a scratch database, beside the `*-sql-test.sql`
 * files.
 */
const NEEDS_DATABASE = {
  "auth-collaboration-test.mjs": "asserts session and lock behaviour under real 60-way contention; needs Postgres",
  "listfill-allocation-test.mjs": "asserts the atomic allocation claim; needs Postgres",
  "lock-concurrency-test.mjs": "8 connections, 8 transactions, one winner; needs Postgres",
};

/**
 * How long any one suite may take.
 *
 * Measured, not guessed: `variants-g3-test.mjs` takes 8 MINUTES on its own —
 * 22 checks that each drive real pointer drags and swipes through the runtime.
 * The first version of this script capped a suite at 5 minutes and reported
 * that suite as a failure, which is the worst kind of red: a green suite
 * called broken teaches everybody to ignore the runner.
 *
 * 15 minutes is therefore roughly twice the slowest thing in the corpus. A
 * suite that hits it is hung, not slow.
 */
const SUITE_TIMEOUT_MS = Number(process.env.SUITE_TIMEOUT_MS ?? 900_000);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const only = value("only", null);
const jobs = Math.max(1, Number(value("jobs", 1)));

const suites = readdirSync(`${ROOT}scripts`)
  .filter((f) => f.endsWith("-test.mjs"))
  .filter((f) => !NEEDS_DATABASE[f])
  .filter((f) => !only || f.includes(only))
  .sort();

if (flag("list")) {
  console.log(`${suites.length} suite(s) would run:\n`);
  for (const s of suites) console.log(`  ${s}`);
  console.log(`\nExcluded, with a reason (${Object.keys(NEEDS_DATABASE).length}):`);
  for (const [k, why] of Object.entries(NEEDS_DATABASE)) console.log(`  · ${k} — ${why}`);
  process.exit(0);
}

/* ------------------------------------------------------------- the servers */

/**
 * IS ANYTHING LISTENING ON THIS PORT? A TCP connect, not an HTTP request.
 *
 * "Is a server already running" and "can it serve a page yet" are two
 * different questions, and answering the first with the second is what broke
 * a whole run: the check was a single 2.5-second GET of `/sandbox`, which on a
 * COLD `next dev` has to compile the largest route in the app (823 kB of first
 * load JS across 75 components). It cannot answer that fast. So a perfectly
 * healthy server was declared absent, the runner started its own, and the run
 * died on EADDRINUSE having tested nothing.
 *
 * A TCP connect answers the first question in milliseconds and cannot be
 * confused by a slow compile.
 */
const portInUse = (url) => new Promise((resolve) => {
  const { hostname, port } = new URL(url);
  const socket = net.connect({
    host: hostname === "localhost" ? "127.0.0.1" : hostname,
    port: Number(port || 80),
  });
  const done = (v) => { socket.destroy(); resolve(v); };
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
  setTimeout(() => done(false), 2000).unref?.();
});

/** Can it actually serve this page? One attempt, generously timed. */
const alive = async (url) => {
  try {
    /*
     * Ten seconds, not 2.5: this is deliberately pointed at a page the app has
     * to compile, because "the port answers" is not the property the suites
     * need — the first suite would race the first compile and fail for a
     * reason nobody could reproduce.
     */
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return res.status < 500;
  } catch {
    return false;
  }
};

/** Poll `alive` until it holds or the budget runs out. */
const ready = async (url, budgetMs) => {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await alive(url)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(1500);
  }
};

/**
 * Start a dev server and wait until it actually serves a page.
 *
 * `next dev` prints "ready" long before it can serve a compiled route, so
 * readiness is a real request for a real page — polling the port would let
 * the first suite race the first compile and fail for no reason anybody could
 * reproduce.
 */
async function startServer(name, filter, readyUrl) {
  const child = spawn("pnpm", ["--filter", filter, "dev"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    /*
     * A runtime this script starts gets the FAKE AI provider unless the
     * environment already chose one. `ai-variables-test` proves the whole
     * AI-derived-variable path against it, deterministically and keylessly;
     * without it that suite fails on its first check with a message saying
     * so. A runtime that was already up is left exactly as it was — this
     * env goes only to a process we own.
     */
    env: { ...process.env, ...(name === "runtime" && !process.env.AI_API_URL ? { AI_API_URL: "fake:" } : {}) },
  });
  const log = [];
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const text = log.join("");
      /*
       * EADDRINUSE is not a failure — it means somebody else owns the port,
       * so the right move is to use THEIR server and make sure we never stop
       * it. Treating it as fatal is how a healthy machine reported "the
       * corpus could not be run".
       */
      if (/EADDRINUSE/.test(text)) return null;
      throw new Error(`${name} exited before it was ready:\n${text.slice(-1500)}`);
    }
    if (await alive(readyUrl)) return child;
    await sleep(1500);
  }
  throw new Error(`${name} did not become ready within 180s:\n${log.join("").slice(-1500)}`);
}

/* ------------------------------------------------------------ one suite */

function runSuite(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("node", [`scripts/${file}`], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, STUDIO_URL: STUDIO, RUNTIME_URL: RUNTIME },
    });
    const out = [];
    child.stdout.on("data", (d) => out.push(String(d)));
    child.stderr.on("data", (d) => out.push(String(d)));

    const timer = setTimeout(() => {
      /*
       * A timeout is a FAILURE, not a skip. A hung suite is usually a suite
       * waiting for a selector that no longer exists, which is exactly the
       * regression worth catching.
       */
      child.kill("SIGKILL");
      resolve({ file, ok: false, ms: Date.now() - started, reason: `timed out after ${SUITE_TIMEOUT_MS / 1000}s`, output: out.join("") });
    }, SUITE_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      const output = out.join("");
      /* the corpus's own convention: a final line naming what passed */
      const tail = output.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
      resolve({
        file, ok: code === 0, ms: Date.now() - started,
        reason: code === 0 ? tail.trim() : `exit ${code}`,
        output,
      });
    });
  });
}

/** Run with a bounded number in flight. */
async function runAll(files, concurrency) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (next < files.length) {
      const i = next++;
      const file = files[i];
      /*
       * the suite's own position in the list, not the count of finished ones:
       * under --jobs the second number to PRINT is often not the second to
       * start, and a line that says "2/48" about the fifth suite makes a
       * failure impossible to find again.
       */
      const label = `${String(i + 1).padStart(2)}/${files.length}`;
      const r = await runSuite(file);
      results.push(r);
      console.log(`  ${r.ok ? "ok  " : "FAIL"} ${label} ${r.file} (${(r.ms / 1000).toFixed(0)}s)${r.ok ? "" : ` — ${r.reason}`}`);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ main */

const started = [];
let failed = false;

try {
  const studioWasUp = await portInUse(STUDIO);
  const runtimeWasUp = await portInUse(RUNTIME);

  console.log(`\nRESCRIPT BROWSER CORPUS — ${suites.length} suite(s), ${jobs} at a time`);
  console.log(`  studio  ${STUDIO} ${studioWasUp ? "(already running — left alone)" : "(starting)"}`);
  console.log(`  runtime ${RUNTIME} ${runtimeWasUp ? "(already running — left alone)" : "(starting)"}\n`);

  /*
   * `startServer` returns null when the port turned out to be taken after all
   * (a server that finished booting between the probe and the spawn). Null
   * must not reach the cleanup list — this script stops only what it started,
   * and a null there would throw while tidying up after a green run.
   */
  const adopt = (child) => { if (child) started.push(child); };
  if (!studioWasUp) adopt(await startServer("studio", "studio", `${STUDIO}/sandbox`));
  if (!runtimeWasUp) adopt(await startServer("runtime", "runtime", RUNTIME));

  /*
   * Whether we started them or found them, both must SERVE before suite 1.
   * A server we found may still be cold, and a cold `/sandbox` compile is
   * minutes on a loaded machine — waiting here costs one wait, while not
   * waiting costs a false failure in whichever suite draws the short straw.
   */
  for (const [name, url] of [[`studio`, `${STUDIO}/sandbox`], [`runtime`, `${RUNTIME}/preview`]]) {
    process.stdout.write(`  waiting for ${name} to serve a page… `);
    if (!(await ready(url, 240_000))) {
      throw new Error(`${name} is listening on its port but never served ${url} within 240s`);
    }
    console.log("ready");
  }
  console.log();

  const results = await runAll(suites, jobs);

  const bad = results.filter((r) => !r.ok);
  const total = (results.reduce((t, r) => t + r.ms, 0) / 1000 / 60).toFixed(1);

  console.log(`\n${results.length - bad.length} of ${results.length} suite(s) passed · ${total} minutes of suite time`);

  if (Object.keys(NEEDS_DATABASE).length) {
    console.log(`\nNot run, by declaration (${Object.keys(NEEDS_DATABASE).length}):`);
    for (const [k, why] of Object.entries(NEEDS_DATABASE)) console.log(`  · ${k} — ${why}`);
  }

  if (bad.length) {
    failed = true;
    console.log(`\n${bad.length} FAILED:`);
    for (const r of bad) {
      console.log(`\n─────────── ${r.file} — ${r.reason}`);
      /* the last 40 lines: enough to see the assertion, not the whole log */
      console.log(r.output.trim().split("\n").slice(-40).join("\n"));
    }
  }
} catch (e) {
  failed = true;
  console.error(`\nThe corpus could not be run: ${e.message}`);
} finally {
  /*
   * Only what this script started, and the whole process GROUP: `next dev`
   * spawns children, and killing the parent alone leaves a server holding
   * port 3000 — which makes the next run fail for a reason that looks like a
   * test failure.
   */
  for (const child of started) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  if (started.length) {
    await sleep(1200);
    for (const child of started) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    console.log(`\nStopped ${started.length} server(s) this run started.`);
  }
}

process.exit(failed ? 1 : 0);
