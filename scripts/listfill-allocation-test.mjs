/**
 * Proof that List Fill allocation is safe for live fieldwork (requirement §27).
 *
 * Run against a scratch Postgres with `supabase/migrations/0007_list_fill.sql`
 * applied. This is not a simulation of concurrency: every respondent here is a
 * separate connection issuing a real, simultaneous transaction, which is the
 * only way to show that a cap holds when two people reach the last slot at the
 * same moment.
 *
 *   PGURL=postgres://postgres:pg@localhost/lftest node scripts/listfill-allocation-test.mjs
 */
import pgLib from "/home/claude/.npm-global/lib/node_modules/pg/lib/index.js";
const { Client, Pool } = pgLib;

const URL = process.env.PGURL ?? "postgres://postgres:pg@localhost/lftest";
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

const reset = async () => {
  await admin.query("truncate public.listfill_allocations, public.listfill_counts, public.responses, public.surveys cascade");
  const { rows } = await admin.query("insert into public.surveys default values returning id");
  return rows[0].id;
};

const pref = (...opts) => JSON.stringify(opts.map(([code, maximum]) => (maximum == null ? { code } : { code, maximum })));

const allocate = async (client, survey, session, preference, count = 1, useCompleted = false, test = false) => {
  const { rows } = await client.query(
    "select slot_no, option_code, reused from public.rescript_allocate_listfill($1,$2,$3,$4,$5::jsonb,$6,$7,$8)",
    [survey, test, "lf1", session, preference, count, useCompleted, "v1"],
  );
  return rows;
};

const countsOf = async (survey, test = false) => {
  const { rows } = await admin.query(
    "select option_code, allocated_count, completed_count from public.listfill_counts where survey_id=$1 and is_test=$2 order by option_code",
    [survey, test],
  );
  return Object.fromEntries(rows.map((r) => [r.option_code, [r.allocated_count, r.completed_count]]));
};

/* ------------------------------------------------------------ 1. the sequence */

console.log("\n§10 — priority, then cap, then the next option (sequentially)");
{
  const survey = await reset();
  const p = pref(["A", 3], ["B", 2], ["C", null]);
  const got = [];
  for (let i = 1; i <= 8; i++) {
    const rows = await allocate(admin, survey, `s${i}`, p);
    got.push(rows[0]?.option_code ?? null);
  }
  eq("A takes its 3, B its 2, then C absorbs the rest", got, ["A", "A", "A", "B", "B", "C", "C", "C"]);
  const c = await countsOf(survey);
  eq("counters agree", [c.A[0], c.B[0], c.C[0]], [3, 2, 3]);
}

/* ------------------------------------------------------------ 2. concurrency */

console.log("\n§27 — 300 simultaneous respondents cannot exceed a cap");
{
  const survey = await reset();
  const p = pref(["A", 150], ["B", 75], ["C", 50], ["D", null]);
  const pool = new Pool({ connectionString: URL, max: 40 });
  const results = await Promise.all(
    Array.from({ length: 300 }, (_, i) => (async () => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const rows = await allocate(client, survey, `race${i}`, p);
        await client.query("commit");
        return rows[0]?.option_code ?? null;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        return `ERR:${e.message}`;
      } finally { client.release(); }
    })()),
  );
  await pool.end();

  const errors = results.filter((r) => typeof r === "string" && r.startsWith("ERR:"));
  eq("no respondent hit an error", errors.length, 0);
  ok("every respondent got an option", results.every((r) => r && !r.startsWith("ERR:")), `nulls: ${results.filter((r) => !r).length}`);

  const c = await countsOf(survey);
  eq("A is exactly at its cap — not 151, not 149", c.A[0], 150);
  eq("B is exactly at its cap", c.B[0], 75);
  eq("C is exactly at its cap", c.C[0], 50);
  eq("D, uncapped, took the remaining 25", c.D[0], 300 - 150 - 75 - 50);

  const { rows: dup } = await admin.query(
    "select session_id from public.listfill_allocations where survey_id=$1 group by session_id having count(*) > 1", [survey],
  );
  eq("no session allocated twice", dup.length, 0);

  const { rows: total } = await admin.query(
    "select count(*)::int n from public.listfill_allocations where survey_id=$1 and released_at is null", [survey],
  );
  eq("allocations recorded match the counters", total[0].n, c.A[0] + c.B[0] + c.C[0] + c.D[0]);
}

/* ------------------------------------------------------------ 3. the last slot */

console.log("\n§27 — 50 respondents racing for ONE remaining slot");
{
  const survey = await reset();
  await admin.query(
    "insert into public.listfill_counts (survey_id,is_test,list_fill_id,option_code,allocated_count) values ($1,false,'lf1','A',149)", [survey],
  );
  const p = pref(["A", 150], ["B", null]);
  const pool = new Pool({ connectionString: URL, max: 25 });
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => (async () => {
      const client = await pool.connect();
      try { return (await allocate(client, survey, `last${i}`, p))[0]?.option_code ?? null; }
      finally { client.release(); }
    })()),
  );
  await pool.end();
  eq("exactly one respondent won the last slot of A", results.filter((r) => r === "A").length, 1);
  eq("the other 49 fell through to B", results.filter((r) => r === "B").length, 49);
  const c = await countsOf(survey);
  eq("A stopped at 150", c.A[0], 150);
}

/* ------------------------------------------------------------ 4. idempotency */

console.log("\nidempotency — back, reload and double-submit never re-allocate");
{
  const survey = await reset();
  const p = pref(["A", 1], ["B", 1], ["C", 1]);
  const first = await allocate(admin, survey, "sess-x", p);
  eq("first call allocates", [first[0].option_code, first[0].reused], ["A", false]);

  const again = await allocate(admin, survey, "sess-x", p);
  eq("second call returns the same item, marked reused", [again[0].option_code, again[0].reused], ["A", true]);
  const third = await allocate(admin, survey, "sess-x", p);
  eq("and again", [third[0].option_code, third[0].reused], ["A", true]);

  const c = await countsOf(survey);
  eq("A's counter moved exactly once, not three times", c.A[0], 1);

  // a genuine double-submit: the same session, two connections, at once
  const pool = new Pool({ connectionString: URL, max: 4 });
  const both = await Promise.all([1, 2].map(async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const rows = await allocate(client, survey, "sess-y", p);
      await client.query("commit");
      return rows[0]?.option_code;
    } finally { client.release(); }
  }));
  await pool.end();
  eq("both simultaneous submits of one session got the same option", both[0], both[1]);
  const { rows: n } = await admin.query(
    "select count(*)::int n from public.listfill_allocations where session_id='sess-y' and released_at is null", [],
  );
  eq("and only one allocation row exists for it", n[0].n, 1);
}

/* ------------------------------------------------------------ 5. multi-slot */

console.log("multiple items per respondent");
{
  const survey = await reset();
  const rows = await allocate(admin, survey, "multi", pref(["A", 10], ["B", 10], ["C", 10]), 3);
  eq("three distinct items, in preference order", rows.map((r) => r.option_code), ["A", "B", "C"]);
  eq("positions are 1..3", rows.map((r) => r.slot_no), [1, 2, 3]);

  const short = await allocate(admin, survey, "short", pref(["A", 10]), 3);
  eq("asking for 3 with one option available yields 1, not a fabricated 3", short.length, 1);
}

/* ------------------------------------------------------------ 6. complete / release */

console.log("complete, release, recount");
{
  const survey = await reset();
  const p = pref(["A", 5]);
  await admin.query("insert into public.responses (survey_id, session_id) values ($1,'r1'),($1,'r2'),($1,'r3')", [survey]);
  for (const s of ["r1", "r2", "r3"]) await allocate(admin, survey, s, p);
  eq("three claimed, none completed", (await countsOf(survey)).A, [3, 0]);

  await admin.query("select public.rescript_complete_listfill($1,'r1')", [survey]);
  eq("completing one moves completed_count only", (await countsOf(survey)).A, [3, 1]);
  await admin.query("select public.rescript_complete_listfill($1,'r1')", [survey]);
  eq("completing the same session twice is harmless", (await countsOf(survey)).A, [3, 1]);

  await admin.query("select public.rescript_release_listfill($1,'r2')", [survey]);
  eq("releasing an abandoned session gives the slot back", (await countsOf(survey)).A, [2, 1]);

  const reclaimed = await allocate(admin, survey, "r4", p);
  eq("the released slot is claimable again", reclaimed[0].option_code, "A");
}

console.log("soft-deleting a response releases its claim automatically");
{
  const survey = await reset();
  await admin.query("insert into public.responses (survey_id, session_id) values ($1,'d1'),($1,'d2')", [survey]);
  await allocate(admin, survey, "d1", pref(["A", 1]));
  const second = await allocate(admin, survey, "d2", pref(["A", 1], ["B", null]));
  eq("A is full, so the second respondent gets B", second[0].option_code, "B");

  await admin.query("update public.responses set deleted_at = now() where session_id='d1'");
  eq("the deleted response's claim is released", (await countsOf(survey)).A, [0, 0]);

  await admin.query("update public.responses set deleted_at = null where session_id='d1'");
  eq("restoring it takes the claim back", (await countsOf(survey)).A, [1, 0]);
}

console.log("recount rebuilds the counters from the allocations that stand");
{
  const survey = await reset();
  for (let i = 1; i <= 4; i++) await allocate(admin, survey, `x${i}`, pref(["A", 10]));
  await admin.query("update public.listfill_counts set allocated_count = 999 where survey_id=$1", [survey]);
  await admin.query("select public.rescript_recount_listfill($1,false)", [survey]);
  eq("a corrupted counter is repaired to the true number", (await countsOf(survey)).A, [4, 0]);
}

/* ------------------------------------------------------------ 7. environments */

console.log("test and live never share a counter");
{
  const survey = await reset();
  const p = pref(["A", 1]);
  const live = await allocate(admin, survey, "live1", p, 1, false, false);
  const test = await allocate(admin, survey, "test1", p, 1, false, true);
  eq("live took A", live[0].option_code, "A");
  eq("test also took A, from its own counter", test[0].option_code, "A");
  eq("live counter", (await countsOf(survey, false)).A, [1, 0]);
  eq("test counter", (await countsOf(survey, true)).A, [1, 0]);

  const liveBlocked = await allocate(admin, survey, "live2", pref(["A", 1], ["B", null]), 1, false, false);
  eq("live is full for A and falls to B", liveBlocked[0].option_code, "B");
  const testStill = await allocate(admin, survey, "test2", pref(["A", 1], ["B", null]), 1, false, true);
  eq("test is independently full for A", testStill[0].option_code, "B");
}

/* ------------------------------------------------------------ 8. complete-only counting */

console.log("counting completes only");
{
  const survey = await reset();
  const p = pref(["A", 2]);
  // capped on completes: claims keep being issued while nothing has completed
  const a = await allocate(admin, survey, "c1", p, 1, true);
  const b = await allocate(admin, survey, "c2", p, 1, true);
  const c = await allocate(admin, survey, "c3", p, 1, true);
  eq("three in-progress claims are allowed against a target of 2 completes",
    [a[0].option_code, b[0].option_code, c[0].option_code], ["A", "A", "A"]);
  await admin.query("insert into public.responses (survey_id, session_id) values ($1,'c1'),($1,'c2')", [survey]);
  await admin.query("select public.rescript_complete_listfill($1,'c1')", [survey]);
  await admin.query("select public.rescript_complete_listfill($1,'c2')", [survey]);
  eq("two completes recorded", (await countsOf(survey)).A, [3, 2]);
  const after = await allocate(admin, survey, "c4", pref(["A", 2], ["B", null]), 1, true);
  eq("with the completes target met, A is closed and B is used", after[0].option_code, "B");
}

/* ------------------------------------------------------------ 9. edge cases */

console.log("edge cases");
{
  const survey = await reset();
  const zero = await allocate(admin, survey, "z1", pref(["A", 0], ["B", null]));
  eq("a maximum of zero is never claimable", zero[0].option_code, "B");

  const none = await allocate(admin, survey, "z2", pref(["A", 0]));
  eq("nothing available yields no rows rather than an error", none.length, 0);

  const empty = await allocate(admin, survey, "z3", "[]");
  eq("an empty preference list yields nothing", empty.length, 0);

  const zeroCount = await allocate(admin, survey, "z4", pref(["A", null]), 0);
  eq("a count of zero allocates nothing", zeroCount.length, 0);

  const { rows: status } = await admin.query("select * from public.rescript_listfill_status($1,false)", [survey]);
  ok("the status reader returns rows for the dashboard", Array.isArray(status));
}

await admin.end();

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
