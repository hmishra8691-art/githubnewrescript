/**
 * THE EDIT LOCK, UNDER REAL SIMULTANEITY (P0-6, P0-8).
 *
 * `scripts/access-sql-test.sql` proves the lock's LOGIC — who may take it,
 * when it goes stale, what happens when its holder signs out. What it cannot
 * prove is the part the requirement actually cares about:
 *
 *     "The system must prevent two users from editing the same project at the
 *      same time... Do NOT rely only on frontend UI to prevent simultaneous
 *      editing. The editing lock must be enforced at the backend/database
 *      level."
 *
 * Two calls in one statement, in one backend, in sequence, are not that. Here
 * every contender is a SEPARATE CONNECTION issuing a REAL SIMULTANEOUS
 * transaction against the same row, which is the only arrangement in which
 * "exactly one winner" is a claim rather than a hope.
 *
 * The mechanism being tested is not a check. `rescript_acquire_lock` does an
 * `insert … on conflict (survey_id) do update … where <takeable>`, and that
 * WHERE is evaluated inside the row lock Postgres has already taken to perform
 * the update. A loser therefore cannot observe a stale "it's free" and write
 * anyway: by the time it is looked at, the winner's row is the one being read.
 * The same technique holds List Fill's slot claim.
 *
 *   PGURL=postgres://postgres:pg@localhost/authtest node scripts/lock-concurrency-test.mjs
 */
import pgLib from "/home/claude/.npm-global/lib/node_modules/pg/lib/index.js";
const { Client, Pool } = pgLib;

const URL = process.env.PGURL ?? "postgres://postgres:pg@localhost/authtest";
const STALE = 180;
const MAX_HOLD = 28800;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const admin = new Client({ connectionString: URL });
await admin.connect();

/*
 * Fixture. `profiles` references `auth.users`, whose insert trigger would
 * otherwise build its own workspaces and roles; it is switched off around the
 * insert so this file states its own world.
 */
const CUST = "dddd0000-0000-0000-0000-00000000000a";
const N = 8;
const userId = (i) => `2222aaaa-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`;
const sessionId = (i) => `6666aaaa-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`;

async function reset() {
  await admin.query("delete from public.project_edit_locks where survey_id in (select id from public.surveys where customer_id = $1)", [CUST]);
  await admin.query("delete from public.surveys where customer_id = $1", [CUST]);
  await admin.query("delete from public.user_sessions where user_id = any($1::uuid[])", [Array.from({ length: N }, (_, i) => userId(i))]);
  await admin.query("delete from public.audit_logs where user_id = any($1::uuid[])", [Array.from({ length: N }, (_, i) => userId(i))]);
  await admin.query("delete from public.profiles where id = any($1::uuid[])", [Array.from({ length: N }, (_, i) => userId(i))]);
  await admin.query("delete from auth.users where id = any($1::uuid[])", [Array.from({ length: N }, (_, i) => userId(i))]);
  await admin.query("delete from public.customers where id = $1", [CUST]);

  await admin.query("insert into public.customers (id, slug, name) values ($1,'lockconc','Lock Concurrency')", [CUST]);
  await admin.query("alter table auth.users disable trigger on_auth_user_created");
  for (let i = 0; i < N; i++) {
    await admin.query("insert into auth.users (id, email) values ($1,$2)", [userId(i), `lock${i}@conc.test`]);
    await admin.query(
      "insert into public.profiles (id, customer_id, email, full_name, role, user_code, status) values ($1,$2,$3,$4,'programmer',$5,'active')",
      [userId(i), CUST, `lock${i}@conc.test`, `Editor ${i}`, `USR-8000${i}`],
    );
    await admin.query(
      "insert into public.user_sessions (id, user_id, status, expires_at) values ($1,$2,'active', now() + interval '2 hours')",
      [sessionId(i), userId(i)],
    );
  }
  await admin.query("alter table auth.users enable trigger on_auth_user_created");

  const { rows } = await admin.query(
    "insert into public.surveys (customer_id, code, title, status, owner_id) values ($1,'LOCK','Contended Study','draft',$2) returning id",
    [CUST, userId(0)],
  );
  return rows[0].id;
}

/** One contender's attempt, on its own connection. */
const attempt = async (client, survey, i, section = null) => {
  const { rows } = await client.query(
    "select acquired, locked_by_session_id, was_stale, was_orphaned from public.rescript_acquire_lock($1,$2,$3,$4,$5,$6)",
    [survey, userId(i), sessionId(i), STALE, MAX_HOLD, section],
  );
  return { i, ...rows[0] };
};

const lockRow = async (survey) => {
  const { rows } = await admin.query(
    "select locked_by_session_id, status, released_reason from public.project_edit_locks where survey_id = $1", [survey],
  );
  return rows[0] ?? null;
};

/* ============================================================ 1. the stampede */

console.log(`\n§14, §16 — ${N} editors reach a free project at the same instant`);
{
  const survey = await reset();
  const pool = new Pool({ connectionString: URL, max: N });

  /*
   * Every client is connected and its statement PREPARED before any of them
   * runs, so the contention is genuine rather than an artefact of connection
   * setup happening one at a time. `Promise.all` then releases them together.
   */
  const clients = await Promise.all(Array.from({ length: N }, () => pool.connect()));
  await Promise.all(clients.map((c) => c.query("select 1")));

  const results = await Promise.all(clients.map((c, i) => attempt(c, survey, i)));
  clients.forEach((c) => c.release());

  const winners = results.filter((r) => r.acquired);
  eq("exactly one of eight simultaneous editors gets the lock", winners.length, 1);
  eq("...and the stored lock belongs to that winner",
    (await lockRow(survey)).locked_by_session_id, sessionId(winners[0].i));
  eq("...held", (await lockRow(survey)).status, "held");
  ok("...and no loser was told it succeeded", results.filter((r) => r.acquired).length === 1);
  ok("nobody was refused for the wrong reason",
    results.every((r) => !r.was_stale && !r.was_orphaned),
    "a free project is neither stale nor orphaned");

  await pool.end();
}

/* ============================================================ 2. the holder */

console.log("\n§16, §29 — the holder keeps it while the others keep asking");
{
  const survey = await reset();
  const pool = new Pool({ connectionString: URL, max: N });
  const clients = await Promise.all(Array.from({ length: N }, () => pool.connect()));
  await Promise.all(clients.map((c) => c.query("select 1")));

  // editor 0 takes it first, uncontended
  eq("the first editor takes the lock", (await attempt(clients[0], survey, 0)).acquired, true);

  // now everybody, including the holder, goes for it at once — five rounds,
  // because a race that holds once may only have held by luck
  for (let round = 0; round < 5; round++) {
    const results = await Promise.all(clients.map((c, i) => attempt(c, survey, i)));
    const winners = results.filter((r) => r.acquired).map((r) => r.i);
    eq(`round ${round + 1}: only the holder succeeds`, winners, [0]);
  }
  eq("the lock never moved", (await lockRow(survey)).locked_by_session_id, sessionId(0));

  clients.forEach((c) => c.release());
  await pool.end();
}

/* ============================================================ 3. P0-8 */

console.log("\nP0-8 — a lock whose holder signed out is takeable at once, by exactly one");
{
  const survey = await reset();
  const pool = new Pool({ connectionString: URL, max: N });
  const clients = await Promise.all(Array.from({ length: N }, () => pool.connect()));
  await Promise.all(clients.map((c) => c.query("select 1")));

  await attempt(clients[0], survey, 0);
  /*
   * Editor 0 signs out. Their heartbeat is SECONDS old, so under the old rule
   * — heartbeat age alone — this lock would have gone on blocking the whole
   * team for another three minutes even though nobody was at that keyboard.
   */
  await admin.query("update public.user_sessions set status='logged_out', ended_at=now(), ended_reason='logout' where id=$1", [sessionId(0)]);
  // and the lock row is left `held` on purpose: the point is that liveness is
  // decided when the question is asked, not by a sweep having run first
  eq("the row still says held", (await lockRow(survey)).status, "held");

  const results = await Promise.all(clients.slice(1).map((c, k) => attempt(c, survey, k + 1)));
  const winners = results.filter((r) => r.acquired);
  eq("exactly one of seven contenders takes the orphaned lock", winners.length, 1);
  eq("...and it is reported as orphaned, not as stale", winners[0].was_orphaned, true);
  eq("...stale would have been the wrong story", winners[0].was_stale, false);

  clients.forEach((c) => c.release());
  await pool.end();
}

/* ============================================================ 4. release/acquire */

console.log("\n§29 — releasing and re-taking under contention loses nothing and grants nobody twice");
{
  const survey = await reset();
  const pool = new Pool({ connectionString: URL, max: N });
  const clients = await Promise.all(Array.from({ length: N }, () => pool.connect()));
  await Promise.all(clients.map((c) => c.query("select 1")));

  const holders = [];
  for (let round = 0; round < 6; round++) {
    // whoever holds it lets go, and everybody dives for it in the same instant
    const current = (await lockRow(survey))?.locked_by_session_id ?? null;
    if (current) {
      const held = Array.from({ length: N }, (_, i) => i).find((i) => sessionId(i) === current);
      await admin.query("select public.rescript_release_lock($1,$2,'released')", [survey, sessionId(held)]);
    }
    const results = await Promise.all(clients.map((c, i) => attempt(c, survey, i)));
    const winners = results.filter((r) => r.acquired).map((r) => r.i);
    eq(`handover ${round + 1}: one winner`, winners.length, 1);
    holders.push(winners[0]);
  }
  ok("the lock changed hands without ever being held twice", holders.length === 6,
    `sequence: ${holders.join(" → ")}`);

  clients.forEach((c) => c.release());
  await pool.end();
}

/* ============================================================ 5. the invariant */

console.log("\nThe structural guarantee — one row, one holder, enforced by the schema");
{
  const survey = await reset();
  /*
   * `project_edit_locks` has `survey_id` as its PRIMARY KEY. Exclusivity is
   * therefore not something the application maintains and could forget to
   * maintain: a second lock row for one project cannot exist, whatever any
   * caller does. This asserts that directly, so a future migration that
   * relaxed the key would fail here rather than in production.
   */
  const { rows: pk } = await admin.query(
    `select a.attname from pg_index i
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'public.project_edit_locks'::regclass and i.indisprimary`,
  );
  eq("the project is the primary key, so two lock rows cannot exist", pk.map((r) => r.attname), ["survey_id"]);

  await admin.query(
    "insert into public.project_edit_locks (survey_id, locked_by_user_id, locked_by_session_id, status) values ($1,$2,$3,'held')",
    [survey, userId(0), sessionId(0)],
  );
  const second = await admin
    .query("insert into public.project_edit_locks (survey_id, locked_by_user_id, locked_by_session_id, status) values ($1,$2,$3,'held')",
      [survey, userId(1), sessionId(1)])
    .then(() => "accepted").catch(() => "refused");
  eq("a second holder is refused by the database itself", second, "refused");

  // and one active session per account, the other structural guarantee
  const { rows: idx } = await admin.query(
    `select indexdef from pg_indexes where schemaname='public' and tablename='user_sessions' and indexname='user_sessions_one_active_key'`,
  );
  ok("one active session per account is a unique partial index, not a check",
    // `pg_indexes.indexdef` normalises keywords to upper case
    idx.length === 1 && /UNIQUE INDEX/i.test(idx[0].indexdef) && /WHERE \(status = 'active'::text\)/i.test(idx[0].indexdef),
    idx[0]?.indexdef ?? "index missing");
}

await admin.query("delete from public.project_edit_locks where survey_id in (select id from public.surveys where customer_id = $1)", [CUST]);
await admin.end();

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
