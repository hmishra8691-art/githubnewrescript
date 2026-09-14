/**
 * THE FOUR LAUNCH BLOCKERS, PROVED ON THE WIRE.
 *
 *   node scripts/blocker-fixes-test.mjs
 *
 * Each of these passed review by looking correct, and each was producing
 * wrong results in production. So none of them is tested by reading the
 * source: this stands up a stub PostgREST and a real production build of the
 * Studio against it, and looks at what actually goes over the two wires —
 * what the app ASKS the database for, and what it hands back to the caller.
 *
 *   R1  an export must not contain a response the researcher deleted.
 *       The query had no `deleted_at` filter while every other reader had
 *       one, so the Data tab said seven and the CSV contained twelve.
 *
 *   R3  `/studio/[id]` is the only server component in the app that reads
 *       data. It read with the SERVICE ROLE and no gate, so any signed-in
 *       user could open any project's questionnaire. The middleware cannot
 *       help: at the edge there is no database, so it can only see that a
 *       cookie exists.
 *
 *   R12 Studio metering defaulted `environment` to LIVE and no caller could
 *       pass anything else, so exports of TEST data were recorded as
 *       production usage — rows saying exactly that are in the live ledger.
 *
 *   R4  the editor's "has this survey collected live data?" probe read
 *       `d.total`, and the endpoint answers `{ live: { total }, test: {…} }`.
 *       So it read 0 forever, the code freeze never engaged once, and options
 *       were renumbered on live surveys mid-field. That one is a CONTRACT
 *       between two of our files, so it is checked by running the editor's
 *       real reader over the real server's real answer.
 *
 * Built into `.next-blockers` so a dev server on the same tree keeps its own
 * chunks. Set BLOCKER_REUSE_BUILD=1 while iterating on the assertions.
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";

const STUB_PORT = 4455;
const STUDIO_PORT = 3003;

const SESSION = "blocker0-0000-0000-0000-000000000000-pad";
const USER = "11111111-1111-1111-1111-111111111111";
const CUSTOMER = "22222222-2222-2222-2222-222222222222";
const SURVEY = "33333333-3333-3333-3333-333333333333";
const VERSION = "44444444-4444-4444-4444-444444444444";
const SECRET_QUESTION = "How much do you earn before tax?";

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

/* ------------------------------------------------------------- the stub */

/** Every request the Studio made, so a MISSING filter is provable. */
const hits = [];
/** Every row the Studio tried to WRITE, so a wrong value is provable too. */
const writes = [];
/** Flipped per check: is this caller a member of the project? */
let role = "owner";

const DEFINITION = {
  meta: { id: SURVEY, code: "ZZBLOCK", title: "Blocker fixture", version: "1.0" },
  questions: [{
    id: "q1", code: "Q1", variableName: "Q1", type: "single_select",
    text: SECRET_QUESTION, options: [{ code: 1, label: "Under 20k" }, { code: 2, label: "Over 20k" }],
    rows: [], columns: [], settings: {}, validation: [],
  }],
  flow: [{ id: "p1", type: "page", questionIds: ["q1"] }, { id: "e1", type: "end", status: "complete" }],
};

/** Three responses: two live, one of them binned. */
const RESPONSES = [
  { survey_id: SURVEY, session_id: "s-keep", respondent_id: null, status: "complete", seed: 1, answers: { q1: "1" }, calculated: {}, embedded: {}, flags: {}, started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:05:00Z", is_test: false, deleted_at: null },
  { survey_id: SURVEY, session_id: "s-binned", respondent_id: null, status: "complete", seed: 2, answers: { q1: "2" }, calculated: {}, embedded: {}, flags: {}, started_at: "2026-01-01T01:00:00Z", completed_at: "2026-01-01T01:05:00Z", is_test: false, deleted_at: "2026-01-02T00:00:00Z" },
  { survey_id: SURVEY, session_id: "s-test", respondent_id: null, status: "complete", seed: 3, answers: { q1: "1" }, calculated: {}, embedded: {}, flags: {}, started_at: "2026-01-01T02:00:00Z", completed_at: "2026-01-01T02:05:00Z", is_test: true, deleted_at: null },
];

/**
 * A PostgREST that honours the filters it is SENT, rather than one that
 * returns the right answer whatever it is asked. That distinction is the
 * whole test: a stub that filtered for the app would pass against the bug.
 */
function applyFilters(rows, url) {
  let out = rows;
  for (const [key, raw] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    const [op, ...rest] = String(raw).split(".");
    const val = rest.join(".");
    if (op === "is" && val === "null") out = out.filter((r) => r[key] == null);
    else if (op === "eq") out = out.filter((r) => String(r[key]) === val);
    else if (op === "not" ) { /* not.is.null */ out = out.filter((r) => r[key] != null); }
  }
  return out;
}

const stub = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${STUB_PORT}`);
  hits.push(`${req.method} ${req.url}`);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const wantsObject = (req.headers.accept ?? "").includes("pgrst.object");
    const send = (rows) => {
      if (wantsObject) {
        if (!rows.length) {
          res.writeHead(406, { "content-type": "application/json" });
          return res.end(JSON.stringify({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(rows[0]));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rows));
    };

    if (url.pathname === "/rest/v1/user_sessions") {
      const now = new Date().toISOString();
      return send([{ id: SESSION, user_id: USER, status: "active", created_at: now, last_seen_at: now, expires_at: new Date(Date.now() + 36e5).toISOString(), device_label: "test", ended_reason: null }]);
    }
    if (url.pathname === "/rest/v1/profiles") {
      return send([{ id: USER, email: "t@example.com", full_name: "Tester", user_code: "USR-10000", customer_id: CUSTOMER, role: "programmer", status: "active" }]);
    }
    if (url.pathname === "/rest/v1/rpc/rescript_access_policy") return send([{}]);

    /*
     * Just enough of the wallet to let the meter get as far as RESERVING,
     * which is the call that carries `p_environment` — the field this suite
     * exists to check. Nothing here does arithmetic; the money logic is
     * proven against real Postgres in `billing-sql-test.sql`.
     */
    if (url.pathname === "/rest/v1/rpc/rescript_billing_wallet_for") {
      return send([{ id: "w-1", customer_id: CUSTOMER, survey_id: SURVEY, user_id: USER, shared_wallet_id: null, currency: "USD", balance: 100, reserved: 0, total_added: 100, total_used: 0, state: "active", overdraft_enabled: false, overdraft_limit: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]);
    }
    if (url.pathname === "/rest/v1/rpc/rescript_billing_record" || url.pathname === "/rest/v1/rpc/rescript_billing_reserve") {
      const p = (() => { try { return JSON.parse(body || "{}"); } catch { return {}; } })();
      /* a known-cost event goes straight to `_record` with the whole event on
         `p_event`; an estimated one holds first with the fields spread out */
      const ev = p.p_event ?? { event_type: p.p_event_type, environment: p.p_environment };
      writes.push({ path: "meter", row: { event_type: ev.eventType ?? ev.event_type, environment: ev.environment } });
      if (url.pathname.endsWith("_record")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ event: { id: "e-1", customer_id: CUSTOMER, survey_id: SURVEY, event_type: ev.eventType ?? ev.event_type, environment: ev.environment, quantity: 1, customer_charge: 0, created_at: "2026-01-01T00:00:00Z" }, wallet: null }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, reservation: { id: "r-1", wallet_id: "w-1", customer_id: CUSTOMER, survey_id: SURVEY, user_id: USER, event_type: p.p_event_type, environment: p.p_environment, estimated_cost: 0, reserved_amount: 0, status: "held", created_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T01:00:00Z", settled_at: null }, wallet: { id: "w-1", customer_id: CUSTOMER, survey_id: SURVEY, currency: "USD", balance: 100, reserved: 0, total_added: 100, total_used: 0, state: "active", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" } }));
    }
    if (url.pathname === "/rest/v1/rpc/rescript_project_access") {
      /* the only knob this suite turns: a member, or a stranger */
      return send([{ project_role: role, role_source: role ? "owner" : "none" }]);
    }
    if (url.pathname === "/rest/v1/surveys") {
      return send([{ id: SURVEY, code: "ZZBLOCK", title: "Blocker fixture", status: "live", owner_id: USER, customer_id: CUSTOMER, locked: false, current_version_id: VERSION, draft_definition: null, draft_updated_at: null, revision: 3 }]);
    }
    if (url.pathname === "/rest/v1/survey_versions") return send([{ id: VERSION, version: "1.0", definition: DEFINITION }]);
    if (url.pathname === "/rest/v1/responses") return send(applyFilters(RESPONSES, url));

    /* billing, audit, notifications: present but empty, so nothing throws.
       The BODY is kept: what the meter claims about an event is the point. */
    if (req.method === "POST") {
      try { writes.push({ path: url.pathname, row: JSON.parse(body || "{}") }); } catch { /* not json */ }
      res.writeHead(201, { "content-type": "application/json" });
      return res.end("[]");
    }
    send([]);
  });
});
stub.listen(STUB_PORT);
await once(stub, "listening");
console.log(`  ·    stub PostgREST on :${STUB_PORT}`);

/* ------------------------------------------------------------- the build */

const DIST = ".next-blockers";
const buildEnv = {
  ...process.env,
  NEXT_DIST_DIR: DIST,
  SUPABASE_URL: `http://localhost:${STUB_PORT}`,
  SUPABASE_SERVICE_ROLE_KEY: "stub-service-key-for-tests",
};

if (process.env.BLOCKER_REUSE_BUILD === "1" && existsSync(`apps/studio/${DIST}/BUILD_ID`)) {
  console.log(`  ·    reusing the existing ${DIST} build`);
} else {
  console.log(`  ·    building the studio into ${DIST} (~80s — these are production-only behaviours)`);
  const build = spawn("pnpm", ["exec", "next", "build"], { cwd: "apps/studio", env: buildEnv, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  build.stdout.on("data", (d) => log.push(String(d)));
  build.stderr.on("data", (d) => log.push(String(d)));
  const [code] = await once(build, "close");
  if (code !== 0) {
    console.error(`the studio could not be built (exit ${code}):\n${log.join("").slice(-2000)}`);
    stub.close();
    process.exit(1);
  }
}

const studio = spawn("pnpm", ["exec", "next", "start", "-p", String(STUDIO_PORT)], {
  cwd: "apps/studio",
  env: { ...buildEnv, NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});
studio.stderr.on("data", (d) => {
  const s = String(d);
  if (/Error/.test(s) && !/experimental/i.test(s)) process.stderr.write(`    studio: ${s}`);
});

const BASE = `http://localhost:${STUDIO_PORT}`;
const up = async () => {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${BASE}/login`, { redirect: "manual" }); if (r.status < 500) return true; }
    catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
if (!(await up())) {
  console.error("the studio under test never came up");
  studio.kill("SIGTERM"); stub.close(); process.exit(1);
}
console.log(`  ·    studio on :${STUDIO_PORT}\n`);

const cookie = { cookie: `rescript_session=${SESSION}` };

try {
  /* ================================================ R1 — the deleted rows */

  console.log("R1 — a response the researcher binned never reaches the file");
  {
    hits.length = 0;
    const res = await fetch(`${BASE}/api/surveys/${SURVEY}/responses?format=csv&include=live`, { headers: cookie });
    const csv = await res.text();
    eq("the export answers 200", res.status, 200);

    const asked = hits.filter((h) => h.includes("/rest/v1/responses"));
    ok("it asked the database to exclude them", asked.some((h) => h.includes("deleted_at=is.null")),
      asked.join(" | ") || "it never queried responses at all");

    const lines = csv.trim().split("\n").filter(Boolean);
    eq("one live response, not two", lines.length - 1, 1);
    ok("the kept response is in the file", csv.includes("s-keep"), csv.slice(0, 200));
    ok("THE BINNED ONE IS NOT", !csv.includes("s-binned"),
      "a response deleted in the Data tab was handed to the client");
  }

  console.log("\n...and the header count agrees with the file");
  {
    const res = await fetch(`${BASE}/api/surveys/${SURVEY}/responses?format=summary`, { headers: cookie });
    const body = await res.json();
    eq("the summary counts one live response", body?.live?.total, 1);
    eq("...and one test response", body?.test?.total, 1);
    ok("so the screen and the export cannot disagree", body?.live?.total === 1, JSON.stringify(body));
  }

  /* ================================== R4 — the reader and the writer agree */

  console.log("\nR4 — the editor's code-freeze probe can read what the server sends");
  {
    const { liveResponseCount, codesFrozenBy } = await import(
      pathToFileURL("apps/studio/lib/responseSummary.ts").href
    );
    const summary = await (await fetch(`${BASE}/api/surveys/${SURVEY}/responses?format=summary`, { headers: cookie })).json();

    eq("it reads the live count off the real payload", liveResponseCount(summary), 1);
    ok("...so a survey with live data freezes its codes", codesFrozenBy(summary) === true,
      JSON.stringify(summary));

    /* the exact expression that shipped, against the exact payload it met */
    const asItWas = summary.total ?? summary.rows?.length ?? 0;
    eq("the reader this replaced saw nothing, which is the whole bug", asItWas, 0);

    /* and it must not freeze on TEST data, or a pilot locks the programmer out */
    ok("test-only data leaves codes editable",
      codesFrozenBy({ live: { total: 0 }, test: { total: 40 } }) === false);
    ok("a missing or malformed payload does not freeze anything",
      codesFrozenBy(null) === false && codesFrozenBy({}) === false && codesFrozenBy({ live: { total: "x" } }) === false);
  }

  /* ============================================ R12 — the environment */

  console.log("\nR12 — test work is not recorded as production usage");
  {
    /* what the meter told the database this event's environment was */
    const envOf = () => writes
      .filter((w) => w.path === "meter" && w.row?.event_type === "EXPORT_GENERATION")
      .map((w) => w.row.environment);

    writes.length = 0;
    await fetch(`${BASE}/api/surveys/${SURVEY}/responses?format=csv&include=test`, { headers: cookie });
    await new Promise((r) => setTimeout(r, 400));   // recordUsage is fire-and-forget
    const testEnvs = envOf();
    ok("exporting TEST data is recorded as TEST",
      testEnvs.length > 0 && testEnvs.every((e) => e === "TEST"),
      testEnvs.length ? testEnvs.join(",") : "(no usage row reached the database — the meter is not wired here)");

    writes.length = 0;
    const live = await fetch(`${BASE}/api/surveys/${SURVEY}/responses?format=csv&include=live`, { headers: cookie });
    await new Promise((r) => setTimeout(r, 400));
    eq("and the live export still works", live.status, 200);
    const liveEnvs = envOf();
    ok("...and IS recorded as LIVE",
      liveEnvs.length > 0 && liveEnvs.every((e) => e === "LIVE"),
      liveEnvs.length ? liveEnvs.join(",") : "(no usage row reached the database)");
  }

  /* ================================================== R3 — the page guard */

  console.log("\nR3 — the studio page authorizes before it reads");
  {
    role = "owner";
    const mine = await fetch(`${BASE}/studio/${SURVEY}`, { headers: cookie });
    const minePage = await mine.text();
    eq("a member gets the editor", mine.status, 200);
    ok("...and is not turned away", !/not found|cannot open this project/i.test(minePage),
      minePage.replace(/\s+/g, " ").slice(0, 200));
    ok("...and the questionnaire reaches the page", minePage.includes(SECRET_QUESTION),
      "the editor opened but carried no definition — the fixture is wrong, not the gate");
  }
  {
    role = null;   // not a member of this project at all
    const theirs = await fetch(`${BASE}/studio/${SURVEY}`, { headers: cookie });
    const page = await theirs.text();
    ok("a stranger does NOT get the questionnaire", !page.includes(SECRET_QUESTION),
      "the survey's question text was served to a user with no role on it");
    ok("...nor the option labels", !page.includes("Under 20k"), "option labels leaked");
    ok("...and is told 'not found', the same as a project that does not exist",
      /not found/i.test(page), page.replace(/\s+/g, " ").slice(0, 300));
    role = "owner";
  }
  {
    const anon = await fetch(`${BASE}/studio/${SURVEY}`, { redirect: "manual" });
    ok("no cookie at all is sent to sign in, not to the editor",
      anon.status === 307 || anon.status === 302 || anon.status === 308,
      `status ${anon.status}`);
    const loc = anon.headers.get("location") ?? "";
    ok("...and comes back here afterwards", loc.includes("/login"), loc);
  }
} finally {
  studio.kill("SIGTERM");
  stub.close();
}

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
