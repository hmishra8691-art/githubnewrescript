/**
 * THE SUPABASE TRANSPORT — caching off, and a dropped read asked again.
 *
 *   node scripts/supabase-fetch-test.mjs
 *
 * No server and no browser: `supabaseFetch` takes its `fetch` and its `sleep`
 * by injection, so the whole retry budget can be exercised in milliseconds
 * against a fetch that fails to order. Node 22 imports the TypeScript source
 * directly, so this tests the file the apps actually ship rather than a copy
 * of its logic.
 *
 * What matters here, in one line each:
 *
 *   · a read that comes back 502 is asked again, and the good answer wins;
 *   · a WRITE is never asked again — a 504 means "no reply", not "did not
 *     happen", and repeating a save could double it;
 *   · the budget is finite, so a real outage still surfaces as an error;
 *   · caching is off on every request, including the ones passed through.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const STUDIO_COPY = path.join(repo, "apps/studio/lib/supabaseFetch.ts");
const RUNTIME_COPY = path.join(repo, "apps/runtime/lib/supabaseFetch.ts");

const { supabaseFetch, repeatable, TRANSIENT_STATUS } = await import(STUDIO_COPY);

let passed = 0;
const checks = [];
function check(name, fn) { checks.push([name, fn]); }

/** A fetch that answers from a script, and records how it was called. */
function scripted(answers) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (next instanceof Error) throw next;
    return new Response(next.body ?? "{}", { status: next.status });
  };
  return { fetchImpl, calls };
}

const noSleep = { sleep: async () => {}, onRetry: () => {} };

/* ------------------------------------------------------------- the reads */

check("a read answered 502 is asked again, and the second answer is used", async () => {
  const { fetchImpl, calls } = scripted([{ status: 502 }, { status: 200, body: '{"ok":true}' }]);
  const f = supabaseFetch({ fetchImpl, ...noSleep });
  const res = await f("https://x.supabase.co/rest/v1/user_sessions?id=eq.1");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":true}');
  assert.equal(calls.length, 2, "asked exactly twice");
});

check("every status the gateway uses for 'not attempted' is retried", async () => {
  for (const status of TRANSIENT_STATUS) {
    const { fetchImpl, calls } = scripted([{ status }, { status: 200 }]);
    const res = await supabaseFetch({ fetchImpl, ...noSleep })("https://x/rest/v1/profiles");
    assert.equal(res.status, 200, `recovered from ${status}`);
    assert.equal(calls.length, 2, `asked twice after ${status}`);
  }
});

check("a thrown network error is asked again too", async () => {
  const { fetchImpl, calls } = scripted([new TypeError("fetch failed"), { status: 200 }]);
  const res = await supabaseFetch({ fetchImpl, ...noSleep })("https://x/rest/v1/profiles");
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

check("the budget is finite — a real outage still reaches the caller", async () => {
  const { fetchImpl, calls } = scripted([{ status: 503 }]);
  const res = await supabaseFetch({ fetchImpl, ...noSleep })("https://x/rest/v1/profiles");
  assert.equal(res.status, 503, "the last failure is returned, not swallowed");
  assert.equal(calls.length, 3, "three attempts, then it stops");
});

check("a network error that never clears is thrown, not turned into a Response", async () => {
  const { fetchImpl, calls } = scripted([new TypeError("fetch failed")]);
  await assert.rejects(
    () => supabaseFetch({ fetchImpl, ...noSleep })("https://x/rest/v1/profiles"),
    /fetch failed/,
  );
  assert.equal(calls.length, 3);
});

check("a 401 or a 409 is an answer, and is never repeated", async () => {
  for (const status of [400, 401, 403, 404, 409, 429]) {
    const { fetchImpl, calls } = scripted([{ status }]);
    const res = await supabaseFetch({ fetchImpl, ...noSleep })("https://x/rest/v1/profiles");
    assert.equal(res.status, status);
    assert.equal(calls.length, 1, `${status} asked once`);
  }
});

/* ------------------------------------------------------------ the writes */

check("a POST is never repeated, however it failed", async () => {
  for (const answer of [{ status: 502 }, { status: 504 }, new TypeError("fetch failed")]) {
    const { fetchImpl, calls } = scripted([answer]);
    const f = supabaseFetch({ fetchImpl, ...noSleep });
    await f("https://x/rest/v1/rpc/rescript_save_draft", { method: "POST", body: "{}" })
      .catch(() => {});
    assert.equal(calls.length, 1, "a write is attempted exactly once");
  }
});

check("PATCH, PUT and DELETE are writes too", async () => {
  for (const method of ["PATCH", "PUT", "DELETE", "post", "patch"]) {
    assert.equal(repeatable(method), false, `${method} is not repeatable`);
  }
  for (const method of ["GET", "get", "HEAD", "head"]) {
    assert.equal(repeatable(method), true, `${method} is repeatable`);
  }
});

check("the method carried on a Request object is honoured, not just init", async () => {
  const { fetchImpl, calls } = scripted([{ status: 502 }]);
  const f = supabaseFetch({ fetchImpl, ...noSleep });
  await f(new Request("https://x/rest/v1/audit_logs", { method: "POST", body: "{}" })).catch(() => {});
  assert.equal(calls.length, 1, "a POST expressed as a Request is still a write");
});

/* ------------------------------------------------------------ the caching */

check("caching is off on every request, retried or passed straight through", async () => {
  const { fetchImpl, calls } = scripted([{ status: 502 }, { status: 200 }]);
  await supabaseFetch({ fetchImpl, ...noSleep })("https://x/rest/v1/profiles");
  for (const c of calls) assert.equal(c.init.cache, "no-store");

  const w = scripted([{ status: 200 }]);
  await supabaseFetch({ fetchImpl: w.fetchImpl, ...noSleep })("https://x/rest/v1/rpc/q", { method: "POST" });
  assert.equal(w.calls[0].init.cache, "no-store", "a write is uncached as well");
});

check("the caller's own headers and signal survive the wrapper", async () => {
  const { fetchImpl, calls } = scripted([{ status: 200 }]);
  const signal = new AbortController().signal;
  await supabaseFetch({ fetchImpl, ...noSleep })("https://x/rest/v1/profiles", {
    headers: { apikey: "k", prefer: "count=exact" },
    signal,
  });
  assert.equal(calls[0].init.headers.apikey, "k");
  assert.equal(calls[0].init.headers.prefer, "count=exact");
  assert.equal(calls[0].init.signal, signal);
});

/* ------------------------------------------------------------ the backoff */

check("it waits between attempts, and the waits grow", async () => {
  const waits = [];
  const { fetchImpl } = scripted([{ status: 502 }, { status: 502 }, { status: 200 }]);
  await supabaseFetch({
    fetchImpl,
    sleep: async (ms) => { waits.push(ms); },
    onRetry: () => {},
  })("https://x/rest/v1/profiles");
  assert.equal(waits.length, 2, "slept once before each retry");
  assert.ok(waits[0] > 0 && waits[1] > waits[0], `backoff grows: ${waits.join(", ")}`);
});

check("the whole budget is short enough to sit inside a request", async () => {
  const waits = [];
  const { fetchImpl } = scripted([{ status: 502 }]);
  await supabaseFetch({ fetchImpl, sleep: async (ms) => { waits.push(ms); }, onRetry: () => {} })(
    "https://x/rest/v1/profiles",
  );
  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(total <= 1000, `retries add at most a second, not a timeout's worth (${total}ms)`);
});

/* ------------------------------------------------ the two copies agree */

check("the runtime app's copy is identical to the Studio's, below the header", async () => {
  const marker = "/**\n * Gateway statuses that mean";
  const code = (p) => {
    const s = readFileSync(p, "utf8");
    const at = s.indexOf(marker);
    assert.notEqual(at, -1, `${path.basename(p)} still starts its code at the expected marker`);
    return s.slice(at);
  };
  assert.equal(
    code(RUNTIME_COPY),
    code(STUDIO_COPY),
    "apps/runtime/lib/supabaseFetch.ts has drifted from apps/studio/lib/supabaseFetch.ts — copy it across",
  );
});

/* ------------------------------------------------------------------ run */

console.log("SUPABASE TRANSPORT\n");
for (const [name, fn] of checks) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${checks.length} checks passed`);
