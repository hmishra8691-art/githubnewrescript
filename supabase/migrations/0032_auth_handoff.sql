/* ============================================================================
 * 0032 — ONE SESSION, TWO ORIGINS
 *
 * `rescript_session` is host-only by design: `setSessionCookie` sets no
 * `domain`, so the browser sends it to the Studio's host and nowhere else.
 * That was correct while there was one app. With Interviews on its own origin
 * it means the cookie never arrives, and the sign-in page's promise —
 * "signing in there signs you in here" — is false for every visitor.
 *
 * The obvious repair is a shared cookie domain, and it is not available:
 * `vercel.app` is on the Public Suffix List, which is exactly the mechanism
 * that stops one Vercel deployment setting cookies for another. No browser
 * will accept `domain=.vercel.app`, so no amount of configuration gets there.
 *
 * So the session is carried across by hand, once, in a form that is useless to
 * anybody who intercepts it a second later.
 *
 *   1. Interviews sends the visitor to the Studio's /api/auth/handoff.
 *   2. The Studio — where the cookie IS valid — checks the session, mints a
 *      random code, stores only its SHA-256 here, and redirects back with the
 *      code in the query string.
 *   3. Interviews redeems it SERVER-SIDE through `rescript_auth_redeem_handoff`
 *      and sets `rescript_session` on its own host.
 *
 * ## What makes the code in a URL acceptable
 *
 * A URL is the worst place to put a secret: it lands in history, in a Referer
 * header, in any proxy log on the path. Three properties together make this
 * one survivable, and all three are enforced HERE rather than in application
 * code, because a check that lives in one of two apps is a check the other app
 * can forget:
 *
 *   **Single use.** Redemption is one UPDATE with `used_at is null` in its
 *   WHERE clause. The row is locked for the duration, so of two racing
 *   redemptions exactly one matches a row and the other gets nothing. This is
 *   why redemption is a function and not a SELECT followed by an UPDATE — that
 *   pair has a window between it, and the window is the whole attack.
 *
 *   **Sixty seconds.** Long enough for a redirect, far too short to be found
 *   in a log and used. The TTL is a parameter with a small default rather than
 *   a constant, and it is CLAMPED below, so a caller cannot widen it by
 *   passing a large number.
 *
 *   **Bound to one destination.** The origin the code was minted for is stored
 *   and must match at redemption. A code intercepted from a URL cannot be
 *   replayed against a different app, and an open redirect in one app cannot
 *   be turned into a session anywhere else.
 *
 * ## What this deliberately does NOT do
 *
 * It does not create a second session. The code hands over the id of the
 * session the person already has, so `user_sessions` stays the single record
 * of who is signed in and revoking a session still ends it everywhere on the
 * next request. A per-app session row would have meant a revoke that worked in
 * one app and not the other, which is worse than the problem being solved.
 * ==========================================================================*/

create table if not exists public.auth_handoff_codes (
  /*
   * The PRIMARY KEY is the hash, never the code. A database backup, a log line
   * or a curious admin gets a value that cannot be redeemed — the same reason
   * `interviews.token_hash` exists rather than a token column.
   */
  code_hash text primary key,
  session_id uuid not null references public.user_sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,

  /* the exact origin this code may be redeemed at: "https://host[:port]" */
  target_origin text not null,

  /* who asked, for reading an abuse pattern later. Salted, as everywhere else. */
  issued_ip_hash text,

  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists auth_handoff_codes_session_idx
  on public.auth_handoff_codes (session_id);
/* the sweep's working set, and nothing else reads by time */
create index if not exists auth_handoff_codes_expiry_idx
  on public.auth_handoff_codes (expires_at);

/**
 * Mint one.
 *
 * The TTL is clamped to [10, 120] seconds. A caller that wants an hour does not
 * get an hour: the point of the clamp is that the lifetime of a credential in a
 * URL is a property of this table, not a decision an API route makes.
 *
 * Each call also removes this session's own expired codes. That keeps the table
 * to roughly the number of sign-ins in flight without a scheduled job to
 * forget, and it means an abandoned handoff — somebody who closed the tab at
 * the redirect — leaves nothing behind.
 */
create or replace function public.rescript_auth_issue_handoff(
  p_code_hash text,
  p_session uuid,
  p_user uuid,
  p_origin text,
  p_ttl_seconds integer default 60,
  p_ip_hash text default null
)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare exp timestamptz;
begin
  if p_code_hash is null or length(p_code_hash) < 32 then
    raise exception 'handoff code hash is missing or too short';
  end if;
  if p_origin is null or p_origin !~ '^https?://[A-Za-z0-9.:-]+$' then
    raise exception 'handoff target origin is not an origin: %', p_origin;
  end if;

  delete from public.auth_handoff_codes
   where session_id = p_session and (expires_at < now() or used_at is not null);

  exp := now() + make_interval(secs => least(120, greatest(10, coalesce(p_ttl_seconds, 60))));

  insert into public.auth_handoff_codes
    (code_hash, session_id, user_id, target_origin, issued_ip_hash, expires_at)
  values (p_code_hash, p_session, p_user, p_origin, p_ip_hash, exp);

  return exp;
end $$;

/**
 * Spend one, and return the session it stands for.
 *
 * NULL means "no", for every reason there is — unknown code, already used,
 * expired, minted for somewhere else. The caller cannot tell which, and should
 * not: distinguishing them is how a redemption endpoint becomes an oracle for
 * guessing codes.
 *
 * The single UPDATE is the concurrency control. `used_at is null` in the WHERE
 * clause means the row is claimed and marked in one statement under one lock,
 * so two simultaneous redemptions of the same code cannot both succeed.
 */
create or replace function public.rescript_auth_redeem_handoff(
  p_code_hash text,
  p_origin text
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare sid uuid;
begin
  if p_code_hash is null or p_origin is null then return null; end if;

  update public.auth_handoff_codes
     set used_at = now()
   where code_hash = p_code_hash
     and target_origin = p_origin
     and used_at is null
     and expires_at > now()
  returning session_id into sid;

  return sid;
end $$;

/**
 * Housekeeping, for a scheduled call if one ever wants it.
 *
 * `issue` already clears a session's own leavings, so this exists for the rows
 * of sessions that never came back at all. Keeping used codes for an hour is
 * deliberate: a support question about a failed sign-in is unanswerable if the
 * evidence is deleted the moment it stops working.
 */
create or replace function public.rescript_auth_sweep_handoff(p_keep_minutes integer default 60)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.auth_handoff_codes
   where created_at < now() - make_interval(mins => greatest(1, p_keep_minutes));
  get diagnostics n = row_count;
  return n;
end $$;

/* ------------------------------------------------------------ permissions */

/*
 * Deny-all RLS and no grants, exactly as the billing and interview tables.
 * This one matters more than most: a table that can be read is a table whose
 * codes can be redeemed, so `anon` and `authenticated` are given nothing at
 * all, and the functions are service-role only.
 */
alter table public.auth_handoff_codes enable row level security;
revoke all on table public.auth_handoff_codes from public, anon, authenticated;
drop policy if exists auth_handoff_codes_service_role_only on public.auth_handoff_codes;
create policy auth_handoff_codes_service_role_only on public.auth_handoff_codes
  for all using (false) with check (false);

revoke all on function public.rescript_auth_issue_handoff(text, uuid, uuid, text, integer, text)
  from public, anon, authenticated;
revoke all on function public.rescript_auth_redeem_handoff(text, text)
  from public, anon, authenticated;
revoke all on function public.rescript_auth_sweep_handoff(integer)
  from public, anon, authenticated;
