/**
 * THE ROOT FIX FOR P0-3 AND P0-4, PROVED ON THE WIRE.
 *
 * The redirect loop had two halves. One was a middleware redirect, and
 * `p0-session-test.mjs` proves that is gone by driving a browser. The other is
 * this one, and it is the half that matters more:
 *
 *     whichever endpoint DISCOVERS that a session is dead must delete the
 *     cookie, so the cookie's presence means something again — for every
 *     entry point at once, rather than for the one screen somebody
 *     remembered to patch.
 *
 * That cannot be shown by intercepting the request in the browser (a
 * Playwright-fulfilled response does not go through the cookie jar the way a
 * real one does), and it cannot be shown against a Studio with no database.
 * So this script stands up BOTH: a stub that answers the handful of PostgREST
 * calls the gate makes, and its own Studio pointed at it. Then it simply looks
 * at the HTTP response.
 *
 * The distinction it also pins is the one that keeps the fix from becoming its
 * own outage: "the session is gone" clears the cookie, "I could not check"
 * must NOT — otherwise a momentary database blip signs out every open tab in
 * the company at once.
 *
 *   node scripts/p0-cookie-test.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

const STUB_PORT = 4444;
const STUDIO_PORT = 3002;
const DEAD = "dead0000-0000-0000-0000-000000000000-padding";

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

/* ---------------------------------------------------------------- the stub */

/**
 * Just enough PostgREST to let `requireUser` reach a decision.
 *
 * `mode` is switched between checks: "empty" is a session id that is not in
 * the table (the gate must conclude the session is gone), "down" is the
 * database being unreachable (the gate must conclude nothing at all).
 */
let mode = "empty";
/**
 * Every request the Studio actually made, which is how the caching bug below
 * was found: the count of these was far lower than the count of requests the
 * test had sent.
 */
const hits = [];
const stub = createServer((req, res) => {
  hits.push(`${mode} ${req.method} ${req.url}`);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (mode === "down") {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "connection refused (simulated)" }));
    }
    /*
     * PostgREST's own answer for "you asked for a single object and there are
     * no rows". supabase-js turns this into `{ data: null, error: null }` for
     * `.maybeSingle()`, which is exactly the state the gate must handle as
     * "this session does not exist".
     */
    const wantsObject = (req.headers.accept ?? "").includes("pgrst.object");
    if (wantsObject) {
      res.writeHead(406, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        code: "PGRST116",
        details: "The result contains 0 rows",
        message: "JSON object requested, multiple (or no) rows returned",
      }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
  });
});
stub.listen(STUB_PORT);
await once(stub, "listening");
console.log(`  ·    stub PostgREST on :${STUB_PORT}`);

/* -------------------------------------------------------------- the studio */

const studio = spawn("pnpm", ["exec", "next", "start", "-p", String(STUDIO_PORT)], {
  cwd: "apps/studio",
  env: {
    ...process.env,
    SUPABASE_URL: `http://localhost:${STUB_PORT}`,
    // not a real key and never used as one: the stub does not check it, and
    // the gate only needs the client to be constructible
    SUPABASE_SERVICE_ROLE_KEY: "stub-service-key-for-tests",
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
studio.stderr.on("data", (d) => {
  const s = String(d);
  if (/Error|error/.test(s) && !/experimental/i.test(s)) process.stderr.write(`    studio: ${s}`);
});

const up = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${STUDIO_PORT}/login`, { redirect: "manual" });
      if (r.status < 500) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
const ready = await up();
if (!ready) {
  console.error("the studio under test never came up");
  studio.kill("SIGTERM");
  stub.close();
  process.exit(1);
}
console.log(`  ·    studio on :${STUDIO_PORT}\n`);

const BASE = `http://localhost:${STUDIO_PORT}`;
const withDeadCookie = { cookie: `rescript_session=${DEAD}` };
/** every `set-cookie` on a response, as one searchable string */
const setCookies = (res) => (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""]).join(" | ");
const clearsSession = (res) => /rescript_session=(;|\s*;)/.test(setCookies(res)) && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(setCookies(res));

try {
  /* ================================================ 1. the session is gone */

  console.log("P0-3 — a 401 for a dead session DELETES the cookie");
  {
    mode = "empty";
    const res = await fetch(`${BASE}/api/auth/me`, { headers: withDeadCookie });
    const body = await res.json().catch(() => ({}));

    eq("the gate refuses the request", res.status, 401);
    eq("...and says which kind of refusal it is", body.code, "unknown_session");
    ok("...and marks it as a sign-out the client can act on", body.signedOut === true, JSON.stringify(body));
    ok("THE FIX: the response clears the session cookie", clearsSession(res), setCookies(res) || "no set-cookie at all");
    ok("...as httpOnly, so the replacement is not scriptable either",
      /HttpOnly/i.test(setCookies(res)), setCookies(res));
  }

  console.log("\n...on every entry point, not just the one that was patched");
  {
    mode = "empty";
    /*
     * This is why the fix lives in the gate rather than in a screen. The loop
     * was originally noticed on the dashboard, and a fix applied there would
     * have left the same trap behind every other endpoint.
     */
    for (const path of ["/api/auth/me", "/api/projects", "/api/sessions", "/api/notifications"]) {
      const res = await fetch(`${BASE}${path}`, { headers: withDeadCookie });
      ok(`${path} refuses and clears`, res.status === 401 && clearsSession(res),
        `status ${res.status}, set-cookie: ${setCookies(res) || "none"}`);
    }
  }

  console.log("\nP0-4 — and with the cookie gone, the login page is reachable");
  {
    mode = "empty";
    const res = await fetch(`${BASE}/login`, { headers: withDeadCookie, redirect: "manual" });
    eq("holding a dead cookie does not bounce off /login", res.status, 200);
    const html = await res.text();
    ok("the form is rendered", /data-testid="login-identifier"/.test(html));

    // and a genuinely signed-out visitor is still routed to it
    const anon = await fetch(`${BASE}/`, { redirect: "manual" });
    ok("no cookie still redirects to /login",
      [301, 302, 307, 308].includes(anon.status) && (anon.headers.get("location") ?? "").includes("/login"),
      `status ${anon.status} → ${anon.headers.get("location")}`);
  }

  /* ============================================ 2. the database is unreachable */

  console.log("\nThe other half — 'I cannot check' must NOT sign anybody out");
  {
    mode = "down";
    const res = await fetch(`${BASE}/api/auth/me`, { headers: withDeadCookie });
    const body = await res.json().catch(() => ({}));

    /*
     * If this answered 401, the fix above would become a much worse bug than
     * the one it replaced: one database hiccup and every open tab in the
     * company empties itself at the same moment. "Checked, and it is dead" and
     * "could not check" have to be different answers.
     */
    eq("an unreachable database is a 503, not a 401", res.status, 503);
    eq("...with a code that says so", body.code, "session_unavailable");
    ok("...and the cookie is LEFT ALONE", !clearsSession(res), setCookies(res) || "no set-cookie (correct)");
    ok("...and it is not reported as a sign-out", body.signedOut !== true, JSON.stringify(body));
  }

  console.log("\nAnd a request with no cookie at all is not a sign-out event either");
  {
    mode = "empty";
    const res = await fetch(`${BASE}/api/auth/me`);
    const body = await res.json().catch(() => ({}));
    eq("it is still a 401", res.status, 401);
    eq("...as 'no session' rather than 'your session ended'", body.code, "no_session");
    ok("...and nothing needs clearing", !clearsSession(res), setCookies(res) || "no set-cookie (correct)");
  }
  /* ======================================= 3. the read is not cached */

  console.log("\nNo request is answered from a cache — a revoke has to take effect NOW");
  {
    /*
     * HOW THIS WAS FOUND, and why it is here.
     *
     * The four-endpoint check above was written to prove the cookie is
     * cleared everywhere. It passed, but the stub had been asked only twice
     * for five requests, and the "database is down" check that followed never
     * reached the stub at all — it was answered from the first result.
     *
     * Next's App Router patches the global `fetch` and, in this version,
     * caches GET requests in its Data Cache by default with no expiry.
     * supabase-js uses that same global `fetch`, so `requireUser`'s session
     * lookup was cached. That is not slowness, it is the whole session layer
     * losing its meaning: an administrator's revoke (§9) would not take
     * effect, an expired session would keep authorizing requests, and a role
     * change would not apply.
     *
     * `export const dynamic = "force-dynamic"` on the routes did not prevent
     * it. The fix is `cache: "no-store"` on the client's own fetch, in
     * lib/authServer.ts and lib/admin.ts.
     *
     * The assertion is a COUNT, because that is the only thing that shows a
     * cache. Every check above would pass just as happily against a cached
     * read.
     */
    const sessionReads = hits.filter((h) => h.includes("/user_sessions")).length;
    ok("every authorization check reached the database, none was served from a cache",
      sessionReads >= 6,
      `${sessionReads} database reads for 7 authorizing requests — a shortfall means the Data Cache is answering them:\n    ${hits.join("\n    ")}`);
    ok("...including the one made while the database was failing",
      hits.some((h) => h.startsWith("down ")),
      "the 'database down' request never reached the stub, so it was cached");
  }
} finally {
  studio.kill("SIGTERM");
  stub.close();
}

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
