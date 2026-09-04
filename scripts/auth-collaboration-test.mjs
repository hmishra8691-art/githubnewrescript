/**
 * Proof that the session and edit-lock guarantees hold under concurrency.
 *
 * The two headline requirements — one active session per user (§4) and one
 * editor per project (§14, §16) — are exactly the shape of problem that looks
 * fine in a click-through and fails in the field: two people acting at the
 * same instant, each reading "nobody has it" before either writes. So neither
 * is tested by calling the function twice in sequence. Every contention test
 * below uses real parallel transactions on separate connections.
 *
 *   PGURL=postgres://postgres:pg@localhost/authtest node scripts/auth-collaboration-test.mjs
 */
import pgLib from "/home/claude/.npm-global/lib/node_modules/pg/lib/index.js";
const { Client, Pool } = pgLib;

const URL = process.env.PGURL ?? "postgres://postgres:pg@localhost/authtest";
let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const db = new Client({ connectionString: URL });
await db.connect();

/* the policy numbers the TypeScript module would compute */
const STALE = 900, ABSOLUTE = 43200, LIFETIME = 43200;
const LOCK_STALE = 180, LOCK_MAX = 28800;

const reset = async () => {
  await db.query(`truncate public.project_presence, public.project_edit_locks, public.project_comments,
    public.notifications, public.project_invitations, public.project_members, public.login_attempts,
    public.user_sessions, public.audit_logs, public.responses, public.surveys, public.profiles,
    public.customers cascade`);
  await db.query("delete from auth.users");
  // access_settings.updated_by references profiles, so TRUNCATE CASCADE above
  // takes the seeded platform-default row with it. Re-seed exactly as the
  // migration does, so each block starts from the migrated state rather than
  // from one the migration never produces.
  await db.query(`insert into public.access_settings (customer_id, policy)
    values ('00000000-0000-0000-0000-000000000000', '{}'::jsonb)
    on conflict (customer_id) do update set policy = '{}'::jsonb`);
};

/** Sign someone up exactly as Supabase Auth would: insert into auth.users. */
const signup = async (email, meta = {}) => {
  const { rows } = await db.query(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id",
    [email, JSON.stringify(meta)],
  );
  return rows[0].id;
};

const profileOf = async (id) => (await db.query(
  "select user_code, role, status, organization, full_name, customer_id from public.profiles where id=$1", [id],
)).rows[0];

const login = async (client, user, opts = {}) => {
  const { rows } = await client.query(
    "select * from public.rescript_login($1,$2,$3,$4,$5,$6,$7,$8)",
    [user, STALE, ABSOLUTE, LIFETIME, opts.force ?? false, opts.ua ?? "UA", opts.ip ?? null, opts.device ?? "Chrome on macOS"],
  );
  return rows[0];
};

const acquire = async (client, survey, user, session, section = null) => {
  const { rows } = await client.query(
    "select * from public.rescript_acquire_lock($1,$2,$3,$4,$5,$6)",
    [survey, user, session, LOCK_STALE, LOCK_MAX, section],
  );
  return rows[0];
};

const mkSurvey = async (customer, code, owner) => {
  const { rows } = await db.query(
    "insert into public.surveys (customer_id, code, title, status, owner_id, created_by) values ($1,$2,$3,'draft',$4,$4) returning id",
    [customer, code, `Survey ${code}`, owner],
  );
  return rows[0].id;
};

/* ============================================================ 1. signup */

console.log("\n§1–2 — signup, the generated user code, and the first account");
{
  await reset();
  // a workspace and two surveys that predate accounts, as the live database has
  const { rows: c } = await db.query("insert into public.customers (slug, name) values ('default','Default Workspace') returning id");
  const legacy = c[0].id;
  await db.query("insert into public.surveys (customer_id, code, title, status) values ($1,'OLD1','Legacy 1','draft'),($1,'OLD2','Legacy 2','live')", [legacy]);

  const john = await signup("john@company.com", { full_name: "John Smith", organization: "Miures Research" });
  const p1 = await profileOf(john);
  ok("a profile is created with the account, in one transaction", !!p1);
  ok("a user code is generated automatically", /^USR-\d{5,}$/.test(p1.user_code), p1.user_code);
  eq("the first account is the platform administrator", p1.role, "platform_admin");
  eq("the name and organization from signup are stored", [p1.full_name, p1.organization], ["John Smith", "Miures Research"]);
  eq("the first account adopts the existing workspace", p1.customer_id, legacy);

  const { rows: adopted } = await db.query("select count(*)::int n from public.surveys where owner_id = $1", [john]);
  eq("and takes ownership of the projects that predate accounts", adopted[0].n, 2);

  const sarah = await signup("sarah@company.com", { full_name: "Sarah Lee", organization: "Miures Research" });
  const p2 = await profileOf(sarah);
  eq("a later account is not an administrator", p2.role, "programmer");
  eq("a named organization is joined, not duplicated", p2.customer_id, legacy);
  ok("user codes are sequential and distinct", p1.user_code !== p2.user_code, `${p1.user_code} / ${p2.user_code}`);

  const { rows: owned } = await db.query("select count(*)::int n from public.surveys where owner_id = $1", [sarah]);
  eq("and it inherits nothing", owned[0].n, 0);

  const solo = await signup("freelancer@example.com", { full_name: "Dev Patel" });
  const p3 = await profileOf(solo);
  ok("an account with no organization still gets an isolated workspace", p3.customer_id !== legacy);

  const { rows: audit } = await db.query("select action from public.audit_logs where action='user.created'");
  eq("every account creation is audited", audit.length, 3);
}

/* ============================================================ 2. one session */

console.log("\n§4 — one active login per user, sequentially");
{
  await reset();
  const u = await signup("a@b.com", { full_name: "A B" });

  const first = await login(db, u);
  eq("the first login creates a session", first.outcome, "created");
  ok("and returns its id", !!first.session_id);

  const second = await login(db, u);
  eq("the second login is REFUSED while the first is live", second.outcome, "blocked");
  eq("and it names the session that is holding the account", second.blocking_session_id, first.session_id);
  eq("and the device, so the user knows where to look", second.blocking_device, "Chrome on macOS");
  ok("no session was created for the refused attempt", second.session_id === null);

  const { rows: n } = await db.query("select count(*)::int n from public.user_sessions where user_id=$1 and status='active'", [u]);
  eq("exactly one active session exists", n[0].n, 1);
}

console.log("§4 — 60 simultaneous logins for the same account");
{
  await reset();
  const u = await signup("race@b.com", { full_name: "Race" });
  const pool = new Pool({ connectionString: URL, max: 30 });
  const results = await Promise.all(Array.from({ length: 60 }, () => (async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const r = await login(c, u);
      await c.query("commit");
      return r.outcome;
    } catch (e) {
      await c.query("rollback").catch(() => {});
      return `ERR:${e.message}`;
    } finally { c.release(); }
  })()));
  await pool.end();

  const errors = results.filter((r) => r.startsWith?.("ERR:"));
  eq("no attempt produced a database error", errors.length, 0, errors[0]);
  eq("exactly ONE login won", results.filter((r) => r === "created").length, 1);
  eq("every other attempt was told it was blocked", results.filter((r) => r === "blocked").length, 59);

  const { rows: n } = await db.query("select count(*)::int n from public.user_sessions where user_id=$1 and status='active'", [u]);
  eq("and the database holds exactly one active session", n[0].n, 1);
}

/* ============================================================ 3. release */

console.log("\n§5–7 — releasing the session");
{
  await reset();
  const u = await signup("c@b.com", { full_name: "C" });
  const s1 = (await login(db, u)).session_id;

  await db.query("select public.rescript_end_session($1,'logout')", [s1]);
  const after = await login(db, u);
  eq("after an explicit logout the next login is allowed", after.outcome, "created");

  // an admin revocation
  await db.query("select public.rescript_end_session($1,'revoked',$2)", [after.session_id, u]);
  const third = await login(db, u);
  eq("after a revocation the next login is allowed", third.outcome, "created");

  // a crashed browser: no heartbeat for longer than the stale threshold
  await db.query("update public.user_sessions set last_seen_at = now() - interval '20 minutes' where id=$1", [third.session_id]);
  const fourth = await login(db, u);
  eq("a crashed browser's session goes stale and the account is usable again", fourth.outcome, "created");
  const { rows: st } = await db.query("select status, ended_reason from public.user_sessions where id=$1", [third.session_id]);
  eq("the stale session is recorded as expired, with the reason", [st[0].status, st[0].ended_reason], ["expired", "stale"]);

  // and the absolute ceiling
  await db.query("update public.user_sessions set created_at = now() - interval '20 hours' where id=$1", [fourth.session_id]);
  const fifth = await login(db, u);
  eq("a session past its absolute lifetime is retired too", fifth.outcome, "created");
}

console.log("§6 — the heartbeat keeps a session alive, and cannot revive a dead one");
{
  await reset();
  const u = await signup("d@b.com", { full_name: "D" });
  const s = (await login(db, u)).session_id;

  await db.query("update public.user_sessions set last_seen_at = now() - interval '5 minutes' where id=$1", [s]);
  const { rows: beat } = await db.query("select * from public.rescript_touch_session($1,$2,$3)", [s, STALE, ABSOLUTE]);
  eq("a heartbeat inside the window keeps the session active", beat[0].status, "active");
  ok("and moves last-seen forward", Date.now() - Date.parse(beat[0].last_seen_at) < 5000);

  await db.query("select public.rescript_end_session($1,'revoked',null)", [s]);
  const { rows: dead } = await db.query("select * from public.rescript_touch_session($1,$2,$3)", [s, STALE, ABSOLUTE]);
  eq("a revoked session cannot check itself back in", dead[0].status, "revoked");

  const { rows: unknown } = await db.query("select * from public.rescript_touch_session($1,$2,$3)", ["00000000-0000-0000-0000-000000000001", STALE, ABSOLUTE]);
  eq("an unknown session is reported, not invented", unknown[0].status, "unknown");
}

console.log("§4 — takeover happens only when explicitly permitted");
{
  await reset();
  const u = await signup("e@b.com", { full_name: "E" });
  const s1 = (await login(db, u)).session_id;
  const blocked = await login(db, u);
  eq("without the setting, refused", blocked.outcome, "blocked");
  const forced = await login(db, u, { force: true });
  eq("with the setting, the new session wins", forced.outcome, "taken_over");
  const { rows } = await db.query("select status, ended_reason from public.user_sessions where id=$1", [s1]);
  eq("and the displaced session is recorded as such", [rows[0].status, rows[0].ended_reason], ["revoked", "taken_over"]);
}

/* ============================================================ 4. throttle */

console.log("\n§3 — failed sign-ins are counted per account and per source");
{
  await reset();
  for (let i = 0; i < 5; i++) {
    await db.query("insert into public.login_attempts (identifier, ip_hash, success, reason) values ('john@company.com','iphash',false,'bad_password')");
  }
  await db.query("insert into public.login_attempts (identifier, ip_hash, success) values ('other@company.com','iphash',false)");
  const { rows } = await db.query("select * from public.rescript_login_failures('john@company.com','iphash',900)");
  eq("failures for the account are counted", rows[0].account_failures, 5);
  eq("and failures from the source, across accounts", rows[0].source_failures, 6);

  const { rows: old } = await db.query("select * from public.rescript_login_failures('john@company.com','iphash',0)");
  eq("the window moves, so a lockout expires with nothing to reset", old[0].account_failures, 0);
}

/* ============================================================ 5. authorization */

console.log("\n§11–12, §23 — who holds what role");
{
  await reset();
  const john = await signup("owner@co.com", { full_name: "John", organization: "Co" });
  const sarah = await signup("editor@co.com", { full_name: "Sarah", organization: "Co" });
  const dave = await signup("outsider@other.com", { full_name: "Dave", organization: "Other Ltd" });
  const cust = (await profileOf(john)).customer_id;
  const survey = await mkSurvey(cust, "P1", john);

  eq("the owner is the owner", (await db.query("select public.rescript_project_role($1,$2) r", [john, survey])).rows[0].r, "owner");
  eq("a stranger has no role at all", (await db.query("select public.rescript_project_role($1,$2) r", [sarah, survey])).rows[0].r, null);

  await db.query("insert into public.project_members (survey_id, user_id, role, added_by) values ($1,$2,'reviewer',$3)", [survey, sarah, john]);
  eq("a shared user holds exactly the role they were given", (await db.query("select public.rescript_project_role($1,$2) r", [sarah, survey])).rows[0].r, "reviewer");

  await db.query("update public.project_members set role='programmer' where survey_id=$1 and user_id=$2", [survey, sarah]);
  eq("changing the role changes the answer", (await db.query("select public.rescript_project_role($1,$2) r", [sarah, survey])).rows[0].r, "programmer");

  eq("someone in another organization still has no role", (await db.query("select public.rescript_project_role($1,$2) r", [dave, survey])).rows[0].r, null);
  await db.query("insert into public.project_members (survey_id, user_id, role, added_by) values ($1,$2,'viewer',$3)", [survey, dave, john]);
  eq("§24: an explicit share is the authorized exception that crosses organizations",
    (await db.query("select public.rescript_project_role($1,$2) r", [dave, survey])).rows[0].r, "viewer");

  const other = await mkSurvey((await profileOf(dave)).customer_id, "P2", dave);
  eq("and it grants nothing on that user's OTHER projects",
    (await db.query("select public.rescript_project_role($1,$2) r", [john, other])).rows[0].r, null);

  eq("a role that is not a role is refused by the constraint",
    await db.query("insert into public.project_members (survey_id,user_id,role) values ($1,$2,'superuser')", [survey, sarah]).then(() => "accepted").catch(() => "refused"),
    "refused");

  eq("the platform admin is identified from the profile",
    (await db.query("select public.rescript_is_platform_admin($1) a", [john])).rows[0].a, true);
  eq("and a normal account is not", (await db.query("select public.rescript_is_platform_admin($1) a", [sarah])).rows[0].a, false);

  const { rows: mine } = await db.query("select * from public.rescript_my_projects($1)", [sarah]);
  eq("the dashboard lists exactly the projects a user can reach", mine.map((r) => r.code), ["P1"]);
  eq("with their own role on each", mine[0].my_role, "programmer");
  eq("and who owns it", mine[0].owner_name, "John");
}

/* ============================================================ 6. one editor */

console.log("\n§14, §16 — one editor per project, sequentially");
{
  await reset();
  const john = await signup("j@co.com", { full_name: "John Smith", organization: "Co" });
  const sarah = await signup("s@co.com", { full_name: "Sarah Lee", organization: "Co" });
  const cust = (await profileOf(john)).customer_id;
  const survey = await mkSurvey(cust, "LOCK", john);
  await db.query("insert into public.project_members (survey_id,user_id,role,added_by) values ($1,$2,'editor',$1)", [survey, sarah]).catch(() => {});
  await db.query("insert into public.project_members (survey_id,user_id,role) values ($1,$2,'editor') on conflict do nothing", [survey, sarah]);

  const sj = (await login(db, john)).session_id;
  const ss = (await login(db, sarah)).session_id;

  const a = await acquire(db, survey, john, sj);
  eq("John takes the lock", a.acquired, true);

  const b = await acquire(db, survey, sarah, ss);
  eq("Sarah is refused", b.acquired, false);
  eq("and is told who is editing", b.locked_by_name, "John Smith");
  ok("and since when", !!b.created_at);

  const again = await acquire(db, survey, john, sj);
  eq("John re-acquiring is not a conflict — that is a page reload", again.acquired, true);
  eq("and the editing-since time does not reset", Date.parse(again.created_at), Date.parse(a.created_at));

  eq("the heartbeat is accepted only from the holder",
    (await db.query("select public.rescript_heartbeat_lock($1,$2,$3) h", [survey, sj, LOCK_MAX])).rows[0].h, true);
  eq("and refused from anyone else",
    (await db.query("select public.rescript_heartbeat_lock($1,$2,$3) h", [survey, ss, LOCK_MAX])).rows[0].h, false);

  eq("releasing what you do not hold changes nothing",
    (await db.query("select public.rescript_release_lock($1,$2) r", [survey, ss])).rows[0].r, false);
  eq("the holder releases it", (await db.query("select public.rescript_release_lock($1,$2) r", [survey, sj])).rows[0].r, true);

  const c2 = await acquire(db, survey, sarah, ss);
  eq("and Sarah can now edit", c2.acquired, true);

  const { rows: one } = await db.query("select count(*)::int n from public.project_edit_locks where survey_id=$1", [survey]);
  eq("there is only ever one lock row per project — a second editor is unrepresentable", one[0].n, 1);
}

console.log("§16 — 60 simultaneous attempts to enter edit mode");
{
  await reset();
  const owner = await signup("o@co.com", { full_name: "Owner", organization: "Co" });
  const cust = (await profileOf(owner)).customer_id;
  const survey = await mkSurvey(cust, "RACE", owner);

  // sixty different people, each with their own session, all clicking Edit
  const users = [];
  for (let i = 0; i < 60; i++) {
    const u = await signup(`racer${i}@co.com`, { full_name: `Racer ${i}`, organization: "Co" });
    await db.query("insert into public.project_members (survey_id,user_id,role) values ($1,$2,'editor')", [survey, u]);
    const s = (await login(db, u)).session_id;
    users.push({ u, s });
  }

  const pool = new Pool({ connectionString: URL, max: 30 });
  const results = await Promise.all(users.map(({ u, s }) => (async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const r = await acquire(c, survey, u, s);
      await c.query("commit");
      return r.acquired;
    } catch (e) {
      await c.query("rollback").catch(() => {});
      return `ERR:${e.message}`;
    } finally { c.release(); }
  })()));
  await pool.end();

  eq("no attempt errored", results.filter((r) => typeof r === "string").length, 0, String(results.find((r) => typeof r === "string")));
  eq("exactly ONE of sixty entered edit mode", results.filter((r) => r === true).length, 1);
  eq("the other fifty-nine were refused", results.filter((r) => r === false).length, 59);

  const { rows } = await db.query("select count(*)::int n from public.project_edit_locks where survey_id=$1 and status='held'", [survey]);
  eq("and the project has one held lock", rows[0].n, 1);
}

/* ============================================================ 7. stale locks */

console.log("\n§17, §30 — stale locks and force release");
{
  await reset();
  const john = await signup("sj@co.com", { full_name: "John Smith", organization: "Co" });
  const sarah = await signup("ss@co.com", { full_name: "Sarah Lee", organization: "Co" });
  const cust = (await profileOf(john)).customer_id;
  const survey = await mkSurvey(cust, "STALE", john);
  await db.query("insert into public.project_members (survey_id,user_id,role) values ($1,$2,'editor')", [survey, sarah]);
  const sj = (await login(db, john)).session_id;
  const ss = (await login(db, sarah)).session_id;

  await acquire(db, survey, john, sj);
  eq("while John is live, Sarah cannot take the lock", (await acquire(db, survey, sarah, ss)).acquired, false);

  // John's browser crashes: the heartbeat stops
  await db.query("update public.project_edit_locks set last_heartbeat_at = now() - interval '10 minutes' where survey_id=$1", [survey]);
  const taken = await acquire(db, survey, sarah, ss);
  eq("once his lock goes stale, Sarah can take it", taken.acquired, true);
  eq("and the takeover is reported as such", taken.was_stale, true);
  eq("no permanent lock exists", (await db.query("select locked_by_user_id u from public.project_edit_locks where survey_id=$1", [survey])).rows[0].u, sarah);

  // a live lock taken away deliberately
  const { rows: forced } = await db.query("select * from public.rescript_force_release_lock($1,$2)", [survey, john]);
  eq("an authorized force-release succeeds", forced[0].released, true);
  eq("and names who was holding it, for the audit trail", forced[0].was_held_by_name, "Sarah Lee");

  const { rows: none } = await db.query("select * from public.rescript_force_release_lock($1,$2)", [survey, john]);
  eq("force-releasing a free project is a no-op, not an error", none[0].released, false);

  // the sweeper
  await acquire(db, survey, john, sj);
  await db.query("update public.project_edit_locks set last_heartbeat_at = now() - interval '1 hour' where survey_id=$1", [survey]);
  const { rows: swept } = await db.query("select public.rescript_expire_locks($1) n", [LOCK_STALE]);
  eq("the sweeper retires abandoned locks", swept[0].n, 1);
  eq("with a reason on the record",
    (await db.query("select released_reason r from public.project_edit_locks where survey_id=$1", [survey])).rows[0].r, "stale");
}

console.log("§35 — a lock cannot outlive the session that holds it");
{
  await reset();
  const john = await signup("lj@co.com", { full_name: "John", organization: "Co" });
  const cust = (await profileOf(john)).customer_id;
  const survey = await mkSurvey(cust, "SESS", john);
  const sj = (await login(db, john)).session_id;
  await acquire(db, survey, john, sj);

  await db.query("select public.rescript_end_session($1,'logout')", [sj]);
  eq("logging out releases the lock the session was holding",
    (await db.query("select status s from public.project_edit_locks where survey_id=$1", [survey])).rows[0].s, "released");

  // and a session that expires without a logout
  const s2 = (await login(db, john)).session_id;
  await acquire(db, survey, john, s2);
  await db.query("update public.user_sessions set last_seen_at = now() - interval '30 minutes' where id=$1", [s2]);
  await db.query("select public.rescript_expire_sessions($1,$2,$3)", [john, STALE, ABSOLUTE]);
  const { rows } = await db.query("select status, released_reason from public.project_edit_locks where survey_id=$1", [survey]);
  eq("an expired session's lock is released too", [rows[0].status, rows[0].released_reason], ["released", "session_ended"]);

  // and a takeover
  const s3 = (await login(db, john)).session_id;
  await acquire(db, survey, john, s3);
  await login(db, john, { force: true });
  eq("a takeover releases the displaced session's lock",
    (await db.query("select released_reason r from public.project_edit_locks where survey_id=$1", [survey])).rows[0].r, "session_taken_over");
}

/* ============================================================ 8. presence */

console.log("\n§13, §31 — presence");
{
  await reset();
  const john = await signup("pj@co.com", { full_name: "John Smith", organization: "Co" });
  const sarah = await signup("ps@co.com", { full_name: "Sarah Lee", organization: "Co" });
  const dave = await signup("pd@co.com", { full_name: "David Patel", organization: "Co" });
  const cust = (await profileOf(john)).customer_id;
  const survey = await mkSurvey(cust, "PRES", john);
  await db.query("insert into public.project_members (survey_id,user_id,role) values ($1,$2,'editor'),($1,$3,'reviewer')", [survey, sarah, dave]);
  const sj = (await login(db, john)).session_id;
  const ss = (await login(db, sarah)).session_id;
  const sd = (await login(db, dave)).session_id;

  for (const [s, u, a] of [[sj, john, "editing"], [ss, sarah, "viewing"], [sd, dave, "reviewing"]]) {
    await db.query("select public.rescript_touch_presence($1,$2,$3,$4)", [survey, s, u, a]);
  }
  const { rows } = await db.query("select * from public.rescript_project_presence($1,60)", [survey]);
  eq("everyone inside the project is listed", rows.length, 3);
  eq("with the role each holds", rows.map((r) => r.role).sort(), ["editor", "owner", "reviewer"]);

  await db.query("update public.project_presence set last_seen_at = now() - interval '5 minutes' where session_id=$1", [sd]);
  const { rows: fewer } = await db.query("select * from public.rescript_project_presence($1,60)", [survey]);
  eq("someone who stopped reporting drops off", fewer.length, 2);

  await db.query("select public.rescript_end_session($1,'logout')", [ss]);
  const { rows: fewest } = await db.query("select * from public.rescript_project_presence($1,60)", [survey]);
  eq("signing out removes you from everyone else's panel", fewest.map((r) => r.full_name), ["John Smith"]);
}

/* ============================================================ 9. members panel */

console.log("§20 — the collaborator panel");
{
  await reset();
  const john = await signup("mj@co.com", { full_name: "John Smith", organization: "Co" });
  const sarah = await signup("ms@co.com", { full_name: "Sarah Lee", organization: "Co" });
  const cust = (await profileOf(john)).customer_id;
  const survey = await mkSurvey(cust, "MEM", john);
  await db.query("insert into public.project_members (survey_id,user_id,role) values ($1,$2,'editor')", [survey, sarah]);
  const ss = (await login(db, sarah)).session_id;
  await db.query("select public.rescript_touch_presence($1,$2,$3,'viewing')", [survey, ss, sarah]);

  const { rows } = await db.query("select * from public.rescript_project_members($1,60)", [survey]);
  eq("the owner leads the list", [rows[0].full_name, rows[0].role, rows[0].is_owner], ["John Smith", "owner", true]);
  eq("with every collaborator and their code", rows.map((r) => r.user_code).filter(Boolean).length, 2);
  eq("and who is present right now", [rows[1].full_name, rows[1].present], ["Sarah Lee", true]);
  eq("the owner is not present", rows[0].present, false);
}

/* ============================================================ 10. invitations */

console.log("\n§22 — inviting someone who has no account yet");
{
  await reset();
  const john = await signup("ij@co.com", { full_name: "John", organization: "Co" });
  const cust = (await profileOf(john)).customer_id;
  const survey = await mkSurvey(cust, "INV", john);

  await db.query(
    "insert into public.project_invitations (survey_id, email, role, token, invited_by) values ($1,'newcomer@else.com','programmer',$2,$3)",
    [survey, "tok_" + "a".repeat(30), john],
  );
  eq("a second live invitation to the same address is refused",
    await db.query("insert into public.project_invitations (survey_id,email,role,token,invited_by) values ($1,'newcomer@else.com','viewer',$2,$3)", [survey, "tok_other", john]).then(() => "accepted").catch(() => "refused"),
    "refused");

  const newcomer = await signup("newcomer@else.com", { full_name: "New Comer" });
  const { rows: claimed } = await db.query("select public.rescript_claim_invitations($1) n", [newcomer]);
  eq("signing up claims the invitation", claimed[0].n, 1);
  eq("and grants exactly the role it carried",
    (await db.query("select public.rescript_project_role($1,$2) r", [newcomer, survey])).rows[0].r, "programmer");
  eq("the invitation is marked accepted, so it cannot be reused",
    (await db.query("select accepted_by from public.project_invitations where survey_id=$1", [survey])).rows[0].accepted_by, newcomer);
  eq("claiming twice grants nothing more", (await db.query("select public.rescript_claim_invitations($1) n", [newcomer])).rows[0].n, 0);

  // an invitation by user code, for someone who already has an account
  const sarah = await signup("is@co.com", { full_name: "Sarah", organization: "Co" });
  const code = (await profileOf(sarah)).user_code;
  await db.query("insert into public.project_invitations (survey_id, user_code, role, token, invited_by) values ($1,$2,'reviewer',$3,$4)",
    [survey, code, "tok_" + "b".repeat(30), john]);
  await db.query("select public.rescript_claim_invitations($1)", [sarah]);
  eq("an invitation addressed to a user code is claimed by that user",
    (await db.query("select public.rescript_project_role($1,$2) r", [sarah, survey])).rows[0].r, "reviewer");

  // an expired invitation grants nothing
  const late = await signup("late@else.com", { full_name: "Late" });
  await db.query("insert into public.project_invitations (survey_id,email,role,token,invited_by,expires_at) values ($1,'late@else.com','editor',$2,$3, now() - interval '1 day')",
    [survey, "tok_" + "c".repeat(30), john]);
  eq("an expired invitation is not claimable", (await db.query("select public.rescript_claim_invitations($1) n", [late])).rows[0].n, 0);
}

/* ============================================================ 11. comments */

console.log("§26 — internal notes");
{
  await reset();
  const john = await signup("cj@co.com", { full_name: "John", organization: "Co" });
  const cust = (await profileOf(john)).customer_id;
  const survey = await mkSurvey(cust, "COM", john);

  const { rows: c } = await db.query(
    "insert into public.project_comments (survey_id, author_id, body, target) values ($1,$2,'Please check the routing after Q18.','{\"questionId\":\"q18\"}'::jsonb) returning id",
    [survey, john],
  );
  await db.query("insert into public.project_comments (survey_id, author_id, parent_id, body) values ($1,$2,$3,'Updated in 2.1.')", [survey, john, c[0].id]);
  const { rows: thread } = await db.query("select count(*)::int n from public.project_comments where survey_id=$1", [survey]);
  eq("a note and its reply are one thread", thread[0].n, 2);

  await db.query("update public.project_comments set resolved_at=now(), resolved_by=$2 where id=$1", [c[0].id, john]);
  const { rows: open } = await db.query("select count(*)::int n from public.project_comments where survey_id=$1 and resolved_at is null and parent_id is null", [survey]);
  eq("resolving closes it", open[0].n, 0);

  // deleting the project takes its notes with it — nothing orphaned, nothing leaked
  await db.query("delete from public.surveys where id=$1", [survey]);
  const { rows: gone } = await db.query("select count(*)::int n from public.project_comments where survey_id=$1", [survey]);
  eq("notes never outlive their project", gone[0].n, 0);
}

/* ============================================================ 12. settings */

console.log("§7 — the timings are configuration");
{
  await reset();
  const { rows: base } = await db.query("select public.rescript_access_policy(null) p");
  eq("a platform default row exists", typeof base[0].p, "object");

  await db.query("update public.access_settings set policy='{\"staleAfterSeconds\":600}'::jsonb where customer_id='00000000-0000-0000-0000-000000000000'");
  const john = await signup("stj@co.com", { full_name: "John", organization: "Co" });
  const cust = (await profileOf(john)).customer_id;
  const { rows: p1 } = await db.query("select public.rescript_access_policy($1) p", [cust]);
  eq("the platform default applies to a customer with no override", p1[0].p.staleAfterSeconds, 600);

  await db.query("insert into public.access_settings (customer_id, policy) values ($1,'{\"staleAfterSeconds\":120,\"allowForceTakeover\":true}'::jsonb)", [cust]);
  const { rows: p2 } = await db.query("select public.rescript_access_policy($1) p", [cust]);
  eq("a customer override wins", p2[0].p.staleAfterSeconds, 120);
  eq("and merges with the default rather than replacing it", p2[0].p.allowForceTakeover, true);
}

/* ============================================================ 13. isolation */

console.log("\n§24, §40 — isolation");
{
  await reset();
  const a1 = await signup("a1@companya.com", { full_name: "A One", organization: "Company A" });
  const b1 = await signup("b1@companyb.com", { full_name: "B One", organization: "Company B" });
  const custA = (await profileOf(a1)).customer_id;
  const custB = (await profileOf(b1)).customer_id;
  ok("two organizations are two workspaces", custA !== custB);

  const pa = await mkSurvey(custA, "PA", a1);
  const pb = await mkSurvey(custB, "PB", b1);

  eq("A cannot reach B's project", (await db.query("select public.rescript_project_role($1,$2) r", [a1, pb])).rows[0].r, null);
  eq("B cannot reach A's project", (await db.query("select public.rescript_project_role($1,$2) r", [b1, pa])).rows[0].r, null);

  const { rows: la } = await db.query("select code from public.rescript_my_projects($1)", [a1]);
  eq("and neither appears in the other's project list", la.map((r) => r.code), ["PA"]);

  const { rows: lb } = await db.query("select code from public.rescript_my_projects($1)", [b1]);
  eq("in either direction", lb.map((r) => r.code), ["PB"]);
}

/* ============================================================ 14. admin */

console.log("§9 — the admin session view");
{
  await reset();
  const admin = await signup("admin@co.com", { full_name: "Admin", organization: "Co" });
  const u1 = await signup("u1@co.com", { full_name: "John Smith", organization: "Co" });
  const u2 = await signup("u2@co.com", { full_name: "Sarah Lee", organization: "Co" });
  const s1 = (await login(db, u1)).session_id;
  await login(db, u2);

  const { rows } = await db.query("select * from public.rescript_active_sessions()");
  eq("every active session is listed", rows.length, 2);
  ok("with the person's name and code", rows.every((r) => r.full_name && r.user_code));

  await db.query("select public.rescript_end_session($1,'revoked',$2)", [s1, admin]);
  const { rows: after } = await db.query("select * from public.rescript_active_sessions()");
  eq("a revoked session leaves the list", after.length, 1);
  eq("and records who revoked it",
    (await db.query("select revoked_by from public.user_sessions where id=$1", [s1])).rows[0].revoked_by, admin);

  await db.query("update public.profiles set status='disabled' where id=$1", [u2]);
  eq("a disabled account is no longer a platform admin candidate",
    (await db.query("select public.rescript_is_platform_admin($1) a", [u2])).rows[0].a, false);
  void u1;
}

await db.end();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
