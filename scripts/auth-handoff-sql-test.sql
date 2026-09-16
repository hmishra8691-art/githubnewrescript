/* ============================================================================
 * 0032 — THE SESSION HANDOFF, AGAINST A REAL DATABASE
 *
 *   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/auth-handoff-sql-test.sql
 *
 * Everything that makes a credential-in-a-URL survivable is enforced in SQL,
 * so this is where it has to be proved. The three properties are single use,
 * expiry, and binding to one destination, and each is tested by DOING the
 * thing it must prevent and asserting it did not work — not by checking that
 * the happy path returns a row, which would pass with every guard removed.
 *
 * Runs in a transaction and rolls back. Nothing here survives the file.
 * ==========================================================================*/

begin;

do $$
declare
  cust uuid; usr uuid; usr2 uuid; sess uuid; sess2 uuid;
  h1 text := repeat('a', 64);
  h2 text := repeat('b', 64);
  h3 text := repeat('c', 64);
  h4 text := repeat('7', 64);
  h5 text := repeat('8', 64);
  got uuid; exp timestamptz; n integer;
  origin_a text := 'https://interviews.example';
  origin_b text := 'https://other.example';
begin
  /* ---------------------------------------------------------- fixtures */
  insert into public.customers (slug, name) values ('handoff-test', 'handoff test')
    returning id into cust;

  usr := gen_random_uuid();
  insert into auth.users (id, email) values (usr, 'handoff@test.invalid');
  /* a trigger on auth.users already creates the profile row; fill it in */
  insert into public.profiles (id, customer_id, email, full_name, role, user_code, status)
    values (usr, cust, 'handoff@test.invalid', 'Handoff Test', 'programmer', 'HANDOFF1', 'active')
    on conflict (id) do update
      set customer_id = excluded.customer_id, full_name = excluded.full_name,
          role = excluded.role, user_code = excluded.user_code, status = excluded.status;

  /*
   * Two sessions, and therefore two people: `user_sessions_one_active_key`
   * enforces §12's one-active-session-per-account rule, so a second session
   * for the same user is not a thing this database will hold. Section 7 needs
   * a second session that section 7's cleanup must NOT touch, and this is what
   * it costs to have one honestly.
   */
  usr2 := gen_random_uuid();
  insert into auth.users (id, email) values (usr2, 'handoff2@test.invalid');
  insert into public.profiles (id, customer_id, email, full_name, role, user_code, status)
    values (usr2, cust, 'handoff2@test.invalid', 'Handoff Two', 'programmer', 'HANDOFF2', 'active')
    on conflict (id) do update
      set customer_id = excluded.customer_id, full_name = excluded.full_name,
          role = excluded.role, user_code = excluded.user_code, status = excluded.status;

  insert into public.user_sessions (user_id, status, expires_at)
    values (usr, 'active', now() + interval '12 hours') returning id into sess;
  insert into public.user_sessions (user_id, status, expires_at)
    values (usr2, 'active', now() + interval '12 hours') returning id into sess2;

  /* ============================================ 1. the happy path works */

  exp := public.rescript_auth_issue_handoff(h1, sess, usr, origin_a, 60, null);
  assert exp > now(), 'issued code expires in the future';
  assert exp <= now() + interval '121 seconds', 'issued code expires within the clamp';

  got := public.rescript_auth_redeem_handoff(h1, origin_a);
  assert got = sess, format('redeeming a fresh code returns its session, got %s', got);

  /* ==================================== 2. SINGLE USE — the whole point */

  got := public.rescript_auth_redeem_handoff(h1, origin_a);
  assert got is null, 'a code redeemed twice must return null the second time';

  /*
   * And the guard must be the row, not the caller's memory of it. Re-reading
   * the row proves `used_at` was written rather than the second call merely
   * missing for some other reason.
   */
  select count(*) into n from public.auth_handoff_codes
   where code_hash = h1 and used_at is not null;
  assert n = 1, 'redemption marks the row used';

  /* ======================================= 3. BOUND TO ONE DESTINATION */

  perform public.rescript_auth_issue_handoff(h2, sess, usr, origin_a, 60, null);

  got := public.rescript_auth_redeem_handoff(h2, origin_b);
  assert got is null, 'a code minted for one origin must not redeem at another';

  /*
   * A near miss is still a miss. These are the shapes a mistake actually
   * takes: a trailing slash, a different scheme, a subdomain.
   */
  assert public.rescript_auth_redeem_handoff(h2, origin_a || '/') is null,
    'origin comparison is exact — a trailing slash is a different string';
  assert public.rescript_auth_redeem_handoff(h2, 'http://interviews.example') is null,
    'a different scheme is a different origin';
  assert public.rescript_auth_redeem_handoff(h2, 'https://sub.interviews.example') is null,
    'a subdomain is a different origin';

  /* the code is still unspent after all those failures, and still works */
  got := public.rescript_auth_redeem_handoff(h2, origin_a);
  assert got = sess, 'a failed redemption at the wrong origin must not consume the code';

  /* ================================================== 4. EXPIRY BITES */

  perform public.rescript_auth_issue_handoff(h3, sess2, usr2, origin_a, 10, null);
  /* reach in and age it, rather than sleeping for two minutes in a test */
  update public.auth_handoff_codes set expires_at = now() - interval '1 second'
   where code_hash = h3;

  got := public.rescript_auth_redeem_handoff(h3, origin_a);
  assert got is null, 'an expired code must not redeem';

  /* ============================== 5. THE TTL IS CLAMPED, NOT TRUSTED */

  delete from public.auth_handoff_codes where code_hash = h3;
  exp := public.rescript_auth_issue_handoff(h3, sess2, usr2, origin_a, 86400, null);
  assert exp <= now() + interval '121 seconds',
    format('a caller asking for a day must still get at most two minutes, got %s', exp);

  delete from public.auth_handoff_codes where code_hash = h3;
  exp := public.rescript_auth_issue_handoff(h3, sess2, usr2, origin_a, 0, null);
  assert exp >= now() + interval '9 seconds',
    'a caller asking for zero seconds must still get a usable window';

  /* ======================================= 6. GARBAGE IS REFUSED LOUDLY */

  begin
    perform public.rescript_auth_issue_handoff('short', sess, usr, origin_a, 60, null);
    assert false, 'a too-short code hash must be refused';
  exception when others then null;
  end;

  begin
    perform public.rescript_auth_issue_handoff(repeat('d', 64), sess, usr, 'not-an-origin', 60, null);
    assert false, 'a target that is not an origin must be refused';
  exception when others then null;
  end;

  begin
    perform public.rescript_auth_issue_handoff(repeat('e', 64), sess, usr,
      'https://a.example/path', 60, null);
    assert false, 'an origin with a path must be refused';
  exception when others then null;
  end;

  /* a null code or origin at redemption is "no", never an error */
  assert public.rescript_auth_redeem_handoff(null, origin_a) is null, 'null code redeems to null';
  assert public.rescript_auth_redeem_handoff(h1, null) is null, 'null origin redeems to null';

  /* ============================ 7. ISSUING TIDIES UP AFTER THIS SESSION */

  /*
   * `issue` deletes this session's own expired and spent codes, which is what
   * keeps the table to the number of sign-ins in flight without a scheduled
   * job to forget about.
   *
   * A fresh pair is used rather than h1, because h1 was already swept by the
   * issue in section 3 — which is the behaviour under test doing its job, and
   * exactly why this section cannot lean on state from an earlier one.
   */
  perform public.rescript_auth_issue_handoff(h4, sess, usr, origin_a, 60, null);
  assert public.rescript_auth_redeem_handoff(h4, origin_a) = sess, 'h4 redeems once';

  select count(*) into n from public.auth_handoff_codes
   where code_hash = h4 and used_at is not null;
  assert n = 1, 'the spent code is still there before the next issue';

  perform public.rescript_auth_issue_handoff(h5, sess, usr, origin_a, 60, null);
  select count(*) into n from public.auth_handoff_codes where code_hash = h4;
  assert n = 0, 'issuing for a session clears that session''s spent codes';

  /* and the code it just minted is NOT swept along with them */
  select count(*) into n from public.auth_handoff_codes where code_hash = h5;
  assert n = 1, 'issuing must not delete the code it is issuing';

  /* but it must NOT touch another session's live codes */
  select count(*) into n from public.auth_handoff_codes where session_id = sess2;
  assert n >= 1, 'issuing for one session must not clear another session''s codes';

  /* ========================= 8. A REVOKED SESSION TAKES ITS CODES WITH IT */

  /*
   * The FK is `on delete cascade`, so a deleted session cannot leave a code
   * that would hand somebody a session id that no longer exists.
   */
  delete from public.user_sessions where id = sess2;
  select count(*) into n from public.auth_handoff_codes where session_id = sess2;
  assert n = 0, 'deleting a session deletes its outstanding codes';

  /* ==================================================== 9. THE SWEEP */

  perform public.rescript_auth_issue_handoff(repeat('9', 64), sess, usr, origin_a, 60, null);
  update public.auth_handoff_codes set created_at = now() - interval '2 hours'
   where code_hash = repeat('9', 64);
  n := public.rescript_auth_sweep_handoff(60);
  assert n >= 1, 'the sweep removes codes older than the keep window';
  select count(*) into n from public.auth_handoff_codes where code_hash = repeat('9', 64);
  assert n = 0, 'the swept code is gone';

  raise notice 'auth handoff: all assertions passed';
end $$;

/* ------------------------------------------------------------ the grants */

/*
 * Asserted separately because it is the failure that would not show up in any
 * behavioural test above: the functions working perfectly AND being callable
 * by `anon` is the whole vulnerability, not half of it.
 */
do $$
declare bad text;
begin
  select string_agg(p.proname, ', ') into bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'rescript_auth_issue_handoff',
       'rescript_auth_redeem_handoff',
       'rescript_auth_sweep_handoff')
     and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute'));
  assert bad is null, format('these handoff functions are callable by an untrusted role: %s', bad);

  assert not has_table_privilege('anon', 'public.auth_handoff_codes', 'select'),
    'anon must not be able to read handoff codes';
  assert not has_table_privilege('authenticated', 'public.auth_handoff_codes', 'select'),
    'authenticated must not be able to read handoff codes';
  assert (select relrowsecurity from pg_class where oid = 'public.auth_handoff_codes'::regclass),
    'row level security must be enabled on auth_handoff_codes';

  raise notice 'auth handoff: permissions are locked down';
end $$;

rollback;
