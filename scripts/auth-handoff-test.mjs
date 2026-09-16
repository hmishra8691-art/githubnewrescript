/**
 * THE SESSION HANDOFF, ON THE WIRE, WITH BOTH APPLICATIONS RUNNING.
 *
 *   node scripts/auth-handoff-test.mjs
 *
 * ## Why this suite exists
 *
 * `rescript_session` is host-only. The Studio sets it with no `domain`, so it
 * is sent to the Studio's host and nowhere else — and a shared cookie domain
 * is not available to fix that, because `vercel.app` is on the Public Suffix
 * List precisely to stop one deployment setting cookies for another.
 *
 * The consequence was a product that looked fine and could not be used: the
 * Interviews sign-in card said "signing in there signs you in here", the link
 * went to the Studio's login form, the person signed in on the Studio's origin
 * and came back still signed out. Forever. Nothing crashed, no request 500'd,
 * and no unit test could have noticed, because the bug was the RELATIONSHIP
 * between two applications' responses.
 *
 * So this suite stands up BOTH of them, production-built, against a stub
 * PostgREST, and drives the whole handshake with real HTTP and a real cookie
 * jar. The assertions are about what crosses the wire — status codes, Location
 * headers, Set-Cookie — because that is where the bug lived.
 *
 * `scripts/auth-handoff-sql-test.sql` proves the other half: that single use,
 * expiry and origin binding are enforced by the database rather than by either
 * application remembering to. The stub here deliberately implements those
 * rules too, so that a route which ignored them would still be caught.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";

const STUB_PORT = 4466;
const STUDIO_PORT = 3010;
const INTERVIEWS_PORT = 3011;
const STUDIO = `http://localhost:${STUDIO_PORT}`;
const INTERVIEWS = `http://localhost:${INTERVIEWS_PORT}`;

const SESSION = "11111111-2222-3333-4444-555555555555";
const USER = "99999999-8888-7777-6666-555555555555";
const CUSTOMER = "abcdabcd-0000-0000-0000-000000000001";

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/* ============================================================== the stub */

/**
 * Just enough PostgREST for both gates, plus the two handoff functions.
 *
 * The handoff rules are implemented here as well as in SQL on purpose. If this
 * stub happily redeemed a code twice, a route that never checked would pass —
 * so the stub enforces what the database enforces, and the suite is then
 * testing the ROUTES against a store that behaves like the real one.
 */
const codes = new Map(); // codeHash -> { session, origin, expiresAt, usedAt }
const stubHits = [];

const sessionRow = {
  id: SESSION,
  user_id: USER,
  status: "active",
  created_at: new Date(Date.now() - 60_000).toISOString(),
  last_seen_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 12 * 3600_000).toISOString(),
  device_label: "test",
  ended_reason: null,
};
const profileRow = {
  id: USER,
  email: "handoff@test.invalid",
  full_name: "Handoff Test",
  user_code: "HANDOFF1",
  customer_id: CUSTOMER,
  role: "programmer",
  status: "active",
};

const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url ?? "";
    stubHits.push(`${req.method} ${url.split("?")[0]}`);
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }

    /* ---- the handoff functions ---- */
    if (url.includes("/rpc/rescript_auth_issue_handoff")) {
      const expiresAt = Date.now() + Math.min(120, Math.max(10, payload.p_ttl_seconds ?? 60)) * 1000;
      codes.set(payload.p_code_hash, {
        session: payload.p_session, origin: payload.p_origin, expiresAt, usedAt: null,
      });
      return json(200, new Date(expiresAt).toISOString());
    }
    if (url.includes("/rpc/rescript_auth_redeem_handoff")) {
      const row = codes.get(payload.p_code_hash);
      /* the same four conditions the SQL applies, in the same order */
      if (!row || row.usedAt || row.expiresAt <= Date.now() || row.origin !== payload.p_origin) {
        return json(200, null);
      }
      row.usedAt = Date.now();
      return json(200, row.session);
    }

    /* ---- what the Interviews gate asks ---- */
    if (url.includes("/rpc/rescript_touch_session")) {
      const live = payload.p_session === SESSION;
      return json(200, [{ user_id: live ? USER : null, status: live ? "active" : "unknown" }]);
    }

    /* ---- the tables both gates read ---- */
    if (url.includes("/user_sessions")) {
      return json(200, url.includes(SESSION) ? [sessionRow] : []);
    }
    if (url.includes("/profiles")) {
      return json(200, url.includes(USER) ? [profileRow] : []);
    }

    /* everything else — settings, policies, counts — takes its default */
    return json(200, []);
  });
});
stub.listen(STUB_PORT);
await once(stub, "listening");
console.log(`  ·    stub PostgREST on :${STUB_PORT}`);

/* ============================================================ the builds */

const env = {
  ...process.env,
  SUPABASE_URL: `http://localhost:${STUB_PORT}`,
  SUPABASE_SERVICE_ROLE_KEY: "stub-service-key-for-tests",
  SUPABASE_ANON_KEY: "stub-anon-key-for-tests",
  /* the Studio will hand a session to exactly one other application */
  AUTH_HANDOFF_ORIGINS: INTERVIEWS,
  /* and Interviews knows what it is called, which is what a code is bound to */
  INTERVIEWS_PUBLIC_URL: INTERVIEWS,
  NEXT_PUBLIC_STUDIO_URL: STUDIO,
};

const DIST = ".next-handoff";
const reuse = process.env.HANDOFF_REUSE_BUILD === "1";

async function build(app) {
  if (reuse && existsSync(`apps/${app}/${DIST}/BUILD_ID`)) {
    console.log(`  ·    reusing ${app}/${DIST} (HANDOFF_REUSE_BUILD=1)`);
    return;
  }
  console.log(`  ·    building ${app} into ${DIST}`);
  const p = spawn("pnpm", ["exec", "next", "build"], {
    cwd: `apps/${app}`,
    env: { ...env, NEXT_DIST_DIR: DIST },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  p.stdout.on("data", (d) => log.push(String(d)));
  p.stderr.on("data", (d) => log.push(String(d)));
  const [code] = await once(p, "close");
  if (code !== 0) {
    /* a build failure is this suite's answer, not a reason to skip it */
    console.error(`${app} could not be built (exit ${code}):`);
    console.error(log.join("").slice(-2500));
    stub.close();
    process.exit(1);
  }
}

await build("studio");
await build("interviews");

/* =========================================================== the servers */

const servers = [];
function start(app, port) {
  const p = spawn("pnpm", ["exec", "next", "start", "-p", String(port)], {
    cwd: `apps/${app}`,
    env: { ...env, NEXT_DIST_DIR: DIST, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stderr.on("data", (d) => {
    const s = String(d);
    if (/Error/.test(s) && !/experimental/i.test(s)) process.stderr.write(`    ${app}: ${s}`);
  });
  servers.push(p);
  return p;
}

start("studio", STUDIO_PORT);
start("interviews", INTERVIEWS_PORT);

async function waitFor(base) {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(base, { redirect: "manual" });
      if (r.status < 500) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const finish = (code) => {
  for (const s of servers) s.kill("SIGTERM");
  stub.close();
  process.exit(code);
};

if (!(await waitFor(`${STUDIO}/login`))) { console.error("the studio never came up"); finish(1); }
if (!(await waitFor(INTERVIEWS))) { console.error("interviews never came up"); finish(1); }
console.log(`  ·    studio on :${STUDIO_PORT}, interviews on :${INTERVIEWS_PORT}\n`);

/* ================================================================ checks */

const NAV = { "sec-fetch-dest": "document" };
const raw = (r) => r.headers.getSetCookie?.() ?? [];
const sessionCookieFrom = (r) =>
  raw(r).find((c) => c.startsWith("rescript_session=")) ?? null;

console.log("1. the signed-out Interviews page points at the handoff, not the login form");
{
  const r = await fetch(INTERVIEWS, { redirect: "manual" });
  const html = await r.text();
  const m = html.match(/href="([^"]*api\/auth\/handoff[^"]*)"/);
  ok("the sign-in link goes to the Studio's handoff", !!m,
    "no handoff link in the page — this is the original bug");
  if (m) {
    const href = new URL(m[1].replace(/&amp;/g, "&"));
    ok("it targets the Studio", href.origin === STUDIO, `got ${href.origin}`);
    ok("it names this app's own origin", href.searchParams.get("origin") === INTERVIEWS,
      `got ${href.searchParams.get("origin")}`);
  }
  ok("the page does not link straight to /login",
    !/href="[^"]*\/login"/.test(html),
    "a /login link signs somebody in on the wrong origin and returns them signed out");
}

console.log("\n2. a signed-in visitor is handed a code");
let firstCode = null;
{
  const r = await fetch(
    `${STUDIO}/api/auth/handoff?origin=${encodeURIComponent(INTERVIEWS)}&next=%2F`,
    { redirect: "manual", headers: { ...NAV, cookie: `rescript_session=${SESSION}` } },
  );
  ok("the handoff redirects", r.status === 303, `got ${r.status}`);
  const loc = r.headers.get("location") ?? "";
  const u = loc ? new URL(loc) : null;
  ok("to the Interviews callback", u?.origin === INTERVIEWS && u?.pathname === "/api/auth/callback",
    `got ${loc}`);
  firstCode = u?.searchParams.get("code") ?? null;
  ok("carrying a code", !!firstCode && firstCode.length >= 32, `got ${firstCode}`);
  ok("the response is not cacheable", (r.headers.get("cache-control") ?? "").includes("no-store"));
  ok("and does not leak the code in a Referer", r.headers.get("referrer-policy") === "no-referrer");
}

console.log("\n3. the code becomes a session cookie on the OTHER origin");
{
  const r = await fetch(`${INTERVIEWS}/api/auth/callback?code=${encodeURIComponent(firstCode)}&next=%2F`,
    { redirect: "manual", headers: NAV });
  ok("the callback redirects", r.status === 303, `got ${r.status}`);
  ok("to a clean URL with no code in it",
    !(r.headers.get("location") ?? "").includes("code="), r.headers.get("location") ?? "");

  const c = sessionCookieFrom(r);
  ok("a session cookie is set", !!c, "no rescript_session — the handoff achieved nothing");
  if (c) {
    ok("holding the session the Studio vouched for", c.includes(SESSION), c.split(";")[0]);
    ok("httpOnly", /httponly/i.test(c), c);
    ok("SameSite=Lax, matching the Studio", /samesite=lax/i.test(c), c);
    ok("path=/", /path=\//i.test(c), c);
    /*
     * The cookie must stay host-only. A `Domain` would be an attempt to do
     * the thing the Public Suffix List forbids — silently ignored by the
     * browser in production and confusing everywhere else.
     */
    ok("no Domain attribute — this cookie is host-only too", !/domain=/i.test(c), c);
  }
}

console.log("\n4. a code cannot be spent twice");
{
  const r = await fetch(`${INTERVIEWS}/api/auth/callback?code=${encodeURIComponent(firstCode)}&next=%2F`,
    { redirect: "manual", headers: NAV });
  ok("the replay sets no cookie", !sessionCookieFrom(r),
    "a replayed code minted a second session — the code is not single-use");
  ok("and says so rather than looping",
    (r.headers.get("location") ?? "").includes("signin=expired"),
    r.headers.get("location") ?? "");
}

console.log("\n5. a code cannot be invented");
{
  const r = await fetch(`${INTERVIEWS}/api/auth/callback?code=${"z".repeat(43)}&next=%2F`,
    { redirect: "manual", headers: NAV });
  ok("a made-up code sets no cookie", !sessionCookieFrom(r));
  const r2 = await fetch(`${INTERVIEWS}/api/auth/callback?next=%2F`, { redirect: "manual", headers: NAV });
  ok("no code at all sets no cookie", !sessionCookieFrom(r2));
}

console.log("\n6. only allowlisted applications may be handed a session");
{
  const before = codes.size;
  const r = await fetch(
    `${STUDIO}/api/auth/handoff?origin=${encodeURIComponent("https://evil.example")}&next=%2F`,
    { redirect: "manual", headers: { ...NAV, cookie: `rescript_session=${SESSION}` } },
  );
  ok("an unlisted origin is refused", r.status === 403, `got ${r.status}`);
  ok("and no code was minted for it", codes.size === before,
    "a code was created before the origin was checked");

  /*
   * The shapes a real attempt takes. Each must be refused, and the status is
   * deliberately not asserted: an origin that cannot be parsed is a 400 and
   * one that parses but is not listed is a 403, and which is which is not the
   * property that matters. What matters is that none of them mints anything.
   */
  for (const bad of [
    "http://localhost:3011.evil.example",   // ours, with a suffix — not parseable as a port
    "https://localhost.evil.example",       // ours as a subdomain of theirs
    `${INTERVIEWS}@evil.example`,           // userinfo, so the real host is evil.example
    `https://evil.example/?x=${INTERVIEWS}`, // ours in the query string
    "http://localhost:3010",                // the STUDIO itself, which is not a handoff target
  ]) {
    const n = codes.size;
    const rb = await fetch(
      `${STUDIO}/api/auth/handoff?origin=${encodeURIComponent(bad)}&next=%2F`,
      { redirect: "manual", headers: { ...NAV, cookie: `rescript_session=${SESSION}` } },
    );
    ok(`refused, and minted nothing: ${bad}`,
      rb.status >= 400 && rb.status < 500 && codes.size === n,
      `status ${rb.status}, codes ${n} → ${codes.size}`);
  }
}

console.log("\n7. the handoff cannot be turned into an open redirect");
{
  const r = await fetch(
    `${STUDIO}/api/auth/handoff?origin=${encodeURIComponent(INTERVIEWS)}&next=${encodeURIComponent("//evil.example")}`,
    { redirect: "manual", headers: { ...NAV, cookie: `rescript_session=${SESSION}` } },
  );
  const u = new URL(r.headers.get("location") ?? "http://x.invalid");
  ok("a protocol-relative next is flattened to /", u.searchParams.get("next") === "/",
    `got ${u.searchParams.get("next")}`);

  /* and the callback refuses it too, in case a code is ever hand-assembled */
  const code = u.searchParams.get("code");
  const r2 = await fetch(
    `${INTERVIEWS}/api/auth/callback?code=${encodeURIComponent(code)}&next=${encodeURIComponent("//evil.example")}`,
    { redirect: "manual", headers: NAV },
  );
  const dest = new URL(r2.headers.get("location") ?? "http://x.invalid");
  ok("the callback lands on its own origin, never off-site", dest.origin === INTERVIEWS,
    `got ${dest.origin}`);
}

console.log("\n8. somebody who is not signed in is sent to sign in, and comes back");
{
  const r = await fetch(
    `${STUDIO}/api/auth/handoff?origin=${encodeURIComponent(INTERVIEWS)}&next=%2Fprojects`,
    { redirect: "manual", headers: NAV },
  );
  ok("no session means a redirect to the form", r.status === 303, `got ${r.status}`);
  const loc = new URL(r.headers.get("location") ?? "http://x.invalid");
  ok("to the Studio's own login", loc.origin === STUDIO && loc.pathname === "/login", String(loc));
  const back = loc.searchParams.get("next") ?? "";
  ok("which will return to the handoff afterwards", back.startsWith("/api/auth/handoff"), back);
  ok("remembering where the person was going", back.includes(encodeURIComponent("/projects")), back);
}

console.log("\n9. a code is minted only for a page the person navigated to");
{
  const before = codes.size;
  const r = await fetch(
    `${STUDIO}/api/auth/handoff?origin=${encodeURIComponent(INTERVIEWS)}&next=%2F`,
    { redirect: "manual", headers: { "sec-fetch-dest": "empty", cookie: `rescript_session=${SESSION}` } },
  );
  ok("a subresource request is refused", r.status === 400, `got ${r.status}`);
  ok("and mints nothing", codes.size === before);
}

console.log("\n10. the whole round trip signs the person in");
{
  /* start to finish, following redirects by hand and carrying the cookie */
  const h = await fetch(
    `${STUDIO}/api/auth/handoff?origin=${encodeURIComponent(INTERVIEWS)}&next=%2F`,
    { redirect: "manual", headers: { ...NAV, cookie: `rescript_session=${SESSION}` } },
  );
  const cb = await fetch(h.headers.get("location"), { redirect: "manual", headers: NAV });
  const cookie = (sessionCookieFrom(cb) ?? "").split(";")[0];
  ok("the journey produced a cookie", !!cookie);

  const home = await fetch(INTERVIEWS, { redirect: "manual", headers: { cookie } });
  const html = await home.text();
  ok("and the Interviews home page now knows who they are",
    html.includes("handoff@test.invalid"),
    "the page still renders the signed-out card");
  ok("so the sign-in prompt is gone",
    !html.includes("Please sign in to your Rescript account"));
}

console.log(`\n${failures.length ? "FAILURES" : "all checks passed"} — ${pass} ok, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
finish(failures.length ? 1 : 0);
