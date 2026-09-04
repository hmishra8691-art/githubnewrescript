-- ============================================================================
-- 0009  P0 FIXES: PROJECT VISIBILITY, CROSS-DEVICE SESSIONS, LOCK LIVENESS
-- ============================================================================
--
-- Everything here repairs behaviour that 0008 introduced. It changes no
-- table's shape and destroys no data: it changes which QUESTIONS the platform
-- asks, because three of the reported "data loss" bugs were the same access
-- question being answered a new way rather than any row going missing.
--
-- What went wrong, in the order the users met it:
--
--   1. VISIBILITY (P0-1, P0-5). `rescript_project_role` recognised exactly two
--      ways to have access: own the project, or hold a `project_members` row.
--      In production `project_members` is EMPTY. Before accounts existed the
--      Studio listed projects by workspace, so an organization's programmers
--      all saw the organization's work. Overnight they each saw only what they
--      personally owned, and the guard answers 404 for everything else —
--      which is a very convincing impression of deleted data. Section 1 adds
--      workspace membership as a third, configurable source of a role.
--
--   2. OWNERSHIP (P0-1). The signup trigger handed EVERY owner-less survey to
--      the first account that ever signed up. Projects built by other people
--      before accounts existed became one administrator's property and
--      vanished from their authors' dashboards. Section 4 stops that
--      happening again. It does NOT guess at reassigning what already
--      happened — see the note there.
--
--   3. STALE LOCKS (P0-8). A lock was judged live by the age of its heartbeat
--      alone, so a lock held by a session that had LOGGED OUT still blocked
--      the team until a three-minute timer ran out. Production had two of
--      them. Section 3 makes a lock exactly as alive as the session holding
--      it, everywhere the question is asked.
--
-- Every predicate here is the SQL half of a rule stated once in
-- @rescript/access. SQL performs the atomic claim; it never invents policy.

begin;

-- ============================================================ 1. WORKSPACE ROLE

/**
 * The baseline role a workspace grants its own members on its own projects.
 *
 * Stored in the same `access_settings.policy` document as every other
 * threshold, so §7's "configurable, not hardcoded" holds here too. An absent
 * key means the default; an explicit null (or "none") switches the whole
 * mechanism off and restores strict explicit-share-only access. The two are
 * deliberately distinguishable — `?` tests for the key's presence, `->>`
 * cannot tell "unset" from "set to null", and getting that wrong would mean an
 * administrator could never turn this off.
 *
 * `owner` is rejected: ownership is a column on the project and is transferred,
 * never granted wholesale to a workspace.
 */
create or replace function public.rescript_workspace_default_role(p_customer uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  pol jsonb;
  ns jsonb;
  val text;
  present boolean := false;
begin
  if p_customer is null then return null; end if;
  pol := public.rescript_access_policy(p_customer);
  ns := pol -> 'workspace';

  if ns is not null and jsonb_typeof(ns) = 'object' and ns ? 'defaultRole' then
    present := true;
    val := ns ->> 'defaultRole';
  elsif pol ? 'workspaceDefaultRole' then
    -- flat form, for settings written before the namespaced shape existed
    present := true;
    val := pol ->> 'workspaceDefaultRole';
  end if;

  if not present then
    return 'editor';  -- see DEFAULT_WORKSPACE_ACCESS in packages/access
  end if;
  if val is null or val = 'none' or val = '' then
    return null;
  end if;
  if val not in ('editor', 'programmer', 'reviewer', 'viewer', 'test_user', 'deployment_manager') then
    -- an unrecognised setting closes the door rather than opening it
    return null;
  end if;
  return val;
end $$;

/**
 * A user's role on a project, AND where it came from.
 *
 * Precedence, stated once here and once in `resolveProjectRole`:
 *
 *     owner  >  explicit project_members row  >  workspace baseline
 *
 * The middle term wins over the last one in BOTH directions. An owner who
 * deliberately shares a project as `viewer` with a colleague in their own
 * workspace has made a decision, and a baseline that quietly promoted that
 * colleague back to `editor` would make the sharing dialog a lie.
 *
 * The workspace term never crosses an organization: both sides must have a
 * customer_id and they must match. Cross-organization isolation was never the
 * bug and is not relaxed here.
 */
create or replace function public.rescript_project_access(p_user uuid, p_survey uuid)
returns table (project_role text, role_source text)
language plpgsql stable security definer set search_path = public as $$
declare
  s_owner uuid;
  s_customer uuid;
  u_customer uuid;
  m_role text;
  ws_role text;
begin
  project_role := null; role_source := 'none';
  if p_user is null or p_survey is null then return next; return; end if;

  select sv.owner_id, sv.customer_id into s_owner, s_customer
    from public.surveys sv where sv.id = p_survey;
  if not found then return next; return; end if;

  if s_owner = p_user then
    project_role := 'owner'; role_source := 'owner'; return next; return;
  end if;

  select pm.role into m_role
    from public.project_members pm
   where pm.survey_id = p_survey and pm.user_id = p_user;
  if m_role is not null then
    project_role := m_role; role_source := 'member'; return next; return;
  end if;

  select pr.customer_id into u_customer from public.profiles pr where pr.id = p_user;
  if s_customer is not null and u_customer is not null and s_customer = u_customer then
    ws_role := public.rescript_workspace_default_role(s_customer);
    if ws_role is not null then
      project_role := ws_role; role_source := 'workspace'; return next; return;
    end if;
  end if;

  return next;
end $$;

/**
 * The role alone, for the many callers that do not need the provenance.
 * Delegates rather than restating the precedence — two copies of this rule
 * would eventually disagree, and the disagreement would be a security bug.
 */
create or replace function public.rescript_project_role(p_user uuid, p_survey uuid)
returns text
language sql stable security definer set search_path = public as $$
  select a.project_role from public.rescript_project_access(p_user, p_survey) a;
$$;

-- ============================================================ 2. THE DASHBOARD

/*
 * `my_role` gains a companion. The dashboard has to separate "mine", "shared
 * with me" and "my team's" — three different relationships that a flat list
 * hides — and it cannot do that from the role alone, because a workspace
 * baseline of `editor` is indistinguishable from an explicit share as
 * `editor` once the source is thrown away.
 *
 * Dropped rather than replaced: `create or replace` cannot change the OUT
 * columns of a set-returning function.
 */
drop function if exists public.rescript_my_projects(uuid, integer);
create function public.rescript_my_projects(p_user uuid, p_lock_stale_seconds integer default 180)
returns table (
  survey_id uuid, code text, title text, status text, updated_at timestamptz,
  owner_id uuid, owner_name text, owner_code text,
  my_role text, role_source text,
  collaborators integer,
  editing_user_id uuid, editing_name text, editing_since timestamptz,
  current_version text, response_count integer
)
language sql stable security definer set search_path = public as $$
  select
    s.id, s.code, s.title, s.status, s.updated_at,
    s.owner_id, op.full_name, op.user_code,
    a.project_role, a.role_source,
    (select count(*)::int from public.project_members m where m.survey_id = s.id) as collaborators,
    l.locked_by_user_id, lp.full_name, l.created_at,
    v.version,
    (select count(*)::int from public.responses r where r.survey_id = s.id and r.deleted_at is null)
  from public.surveys s
  cross join lateral public.rescript_project_access(p_user, s.id) a
  left join public.profiles op on op.id = s.owner_id
  left join public.survey_versions v on v.id = s.current_version_id
  /*
   * "Who is editing this right now" must agree with the lock's own liveness
   * rule, or a card shows Sarah editing a project she signed out of an hour
   * ago. The heartbeat window AND the holding session both have to hold.
   */
  left join public.project_edit_locks l
    on l.survey_id = s.id and l.status = 'held'
   and l.last_heartbeat_at > now() - make_interval(secs => p_lock_stale_seconds)
   and exists (
     select 1 from public.user_sessions us
      where us.id = l.locked_by_session_id and us.status = 'active'
   )
  left join public.profiles lp on lp.id = l.locked_by_user_id
  where a.project_role is not null
  order by s.updated_at desc;
$$;

-- ============================================================ 3. LOCK LIVENESS

/**
 * The whole truth about one project's lock, in one round trip.
 *
 * `holder_session_live` is the field P0-8 was missing. The Studio read the
 * lock row and judged it by its heartbeat, which cannot see that the person
 * holding it signed out ninety seconds ago. Only a join to `user_sessions`
 * can answer that, so the answer is produced here, once, and every caller
 * gets the same one. It also folds in the holder's name, which the routes
 * were fetching with a second query on every poll.
 */
create or replace function public.rescript_lock_for(p_survey uuid)
returns table (
  survey_id uuid,
  locked_by_user_id uuid,
  locked_by_session_id uuid,
  status text,
  section text,
  created_at timestamptz,
  last_heartbeat_at timestamptz,
  expires_at timestamptz,
  locked_by_name text,
  locked_by_code text,
  holder_session_live boolean
)
language sql stable security definer set search_path = public as $$
  select
    l.survey_id, l.locked_by_user_id, l.locked_by_session_id, l.status, l.section,
    l.created_at, l.last_heartbeat_at, l.expires_at,
    p.full_name, p.user_code,
    exists (
      select 1 from public.user_sessions s
       where s.id = l.locked_by_session_id and s.status = 'active'
    )
  from public.project_edit_locks l
  left join public.profiles p on p.id = l.locked_by_user_id
  where l.survey_id = p_survey;
$$;

/**
 * Enter edit mode — the atomic claim, with one more way to be takeable.
 *
 * The `where` on the conflict path runs INSIDE the row lock Postgres already
 * took to do the update, which is what makes "exactly one winner" a structural
 * property rather than a checked one. Four conditions made a lock takeable
 * before: not held, heartbeat too old, held past the ceiling, or past its
 * expiry. A fifth is added, and it is the one that matters most in practice
 * because it needs no clock at all:
 *
 *     the session holding it is no longer active.
 *
 * A logged-out, revoked or expired session is not coming back to save
 * anything. Making the team wait out a stale timer for it was the bug.
 */
drop function if exists public.rescript_acquire_lock(uuid, uuid, uuid, integer, integer, text);
create function public.rescript_acquire_lock(
  p_survey uuid, p_user uuid, p_session uuid,
  p_stale_seconds integer, p_max_hold_seconds integer, p_section text default null
)
returns table (
  acquired boolean, locked_by_user_id uuid, locked_by_session_id uuid,
  locked_by_name text, locked_by_code text,
  created_at timestamptz, last_heartbeat_at timestamptz,
  was_stale boolean, was_orphaned boolean
)
language plpgsql security definer set search_path = public as $$
declare
  got record;
  holder record;
  stale_before timestamptz := now() - make_interval(secs => p_stale_seconds);
  oldest_start timestamptz := now() - make_interval(secs => p_max_hold_seconds);
  prior record;
begin
  select l.locked_by_session_id as sid, l.status as st, l.last_heartbeat_at as hb,
         exists (select 1 from public.user_sessions s
                  where s.id = l.locked_by_session_id and s.status = 'active') as live
    into prior
  from public.project_edit_locks l where l.survey_id = p_survey;

  insert into public.project_edit_locks
    (survey_id, locked_by_user_id, locked_by_session_id, status, section, created_at, last_heartbeat_at, expires_at)
  values
    (p_survey, p_user, p_session, 'held', p_section, now(), now(), now() + make_interval(secs => p_max_hold_seconds))
  on conflict (survey_id) do update
    set locked_by_user_id = p_user,
        locked_by_session_id = p_session,
        status = 'held',
        section = p_section,
        created_at = case when public.project_edit_locks.locked_by_session_id = p_session
                            and public.project_edit_locks.status = 'held'
                          then public.project_edit_locks.created_at else now() end,
        last_heartbeat_at = now(),
        expires_at = now() + make_interval(secs => p_max_hold_seconds),
        released_at = null, released_reason = null, released_by = null
    where
      public.project_edit_locks.status <> 'held'
      or public.project_edit_locks.last_heartbeat_at < stale_before
      or public.project_edit_locks.created_at < oldest_start
      or (public.project_edit_locks.expires_at is not null and public.project_edit_locks.expires_at <= now())
      -- P0-8: the holder is not signed in any more
      or not exists (
        select 1 from public.user_sessions s
         where s.id = public.project_edit_locks.locked_by_session_id and s.status = 'active'
      )
      -- re-acquiring my own lock is how a page reload gets edit mode back
      or public.project_edit_locks.locked_by_session_id = p_session
  returning * into got;

  if got.survey_id is not null then
    return query select true, got.locked_by_user_id, got.locked_by_session_id,
      (select p.full_name from public.profiles p where p.id = got.locked_by_user_id),
      (select p.user_code from public.profiles p where p.id = got.locked_by_user_id),
      got.created_at, got.last_heartbeat_at,
      coalesce(prior.sid is not null and prior.sid <> p_session and prior.st = 'held'
               and prior.hb < stale_before and prior.live, false),
      coalesce(prior.sid is not null and prior.sid <> p_session and prior.st = 'held'
               and not prior.live, false);
    return;
  end if;

  select l.*, p.full_name, p.user_code into holder
  from public.project_edit_locks l
  left join public.profiles p on p.id = l.locked_by_user_id
  where l.survey_id = p_survey;

  return query select false, holder.locked_by_user_id, holder.locked_by_session_id,
    holder.full_name, holder.user_code, holder.created_at, holder.last_heartbeat_at, false, false;
end $$;

/**
 * The opportunistic sweep: whoever looks at a project tidies up the locks the
 * clock — or a sign-out — has ended. No scheduler, so nothing to fail
 * silently at 3am.
 *
 * The session-liveness arm is what makes this the primary cure for P0-8: it
 * runs on every collaboration poll, so a lock left behind by a sign-out is
 * gone within one polling interval instead of one stale timeout.
 */
create or replace function public.rescript_expire_locks(p_stale_seconds integer)
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.project_edit_locks l
     set status = 'released',
         released_at = now(),
         released_reason = case
           when not exists (select 1 from public.user_sessions s
                             where s.id = l.locked_by_session_id and s.status = 'active')
             then 'session_ended'
           else 'stale' end
   where l.status = 'held'
     and (
       l.last_heartbeat_at < now() - make_interval(secs => p_stale_seconds)
       or (l.expires_at is not null and l.expires_at <= now())
       or not exists (
         select 1 from public.user_sessions s
          where s.id = l.locked_by_session_id and s.status = 'active'
       )
     );
  get diagnostics n = row_count;
  return n;
end $$;

/**
 * Release every lock a session holds, by session.
 *
 * "A session that has ended holds nothing" is asserted in four places — this
 * function, `rescript_end_session`, `rescript_expire_locks` and
 * `rescript_login`'s takeover — and each was its own copy of the same UPDATE.
 * This is now the single definition of it, and `rescript_end_session` below
 * delegates rather than restating it. Four copies of a rule is four chances
 * for one of them to be updated and the others forgotten, which is precisely
 * how the liveness rule this migration adds would come apart later.
 */
create or replace function public.rescript_release_session_locks(p_session uuid, p_reason text default 'session_ended')
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.project_edit_locks
     set status = 'released', released_at = now(), released_reason = p_reason
   where locked_by_session_id = p_session and status = 'held';
  get diagnostics n = row_count;
  return n;
end $$;

/**
 * Ending a session — sign-out or an administrator's revoke.
 *
 * Unchanged in behaviour; the inlined lock UPDATE it used to carry is now the
 * call above, so there is one statement of "a session that has ended holds
 * nothing" instead of a copy per caller.
 */
create or replace function public.rescript_end_session(p_session uuid, p_reason text default 'logout', p_by uuid default null)
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.user_sessions
     set status = case when p_reason = 'logout' then 'logged_out' else 'revoked' end,
         ended_at = now(), ended_reason = p_reason,
         revoked_by = case when p_reason = 'logout' then null else p_by end
   where id = p_session and status = 'active';
  get diagnostics n = row_count;

  perform public.rescript_release_session_locks(p_session, p_reason);
  delete from public.project_presence where session_id = p_session;
  return n;
end $$;

-- ============================================================ 4. THE TRIGGER

/**
 * THE SIGNUP TRIGGER NO LONGER CLAIMS OTHER PEOPLE'S WORK.
 *
 * The removed line was:
 *
 *     if is_first then
 *       update public.surveys set owner_id = new.id where owner_id is null;
 *     end if;
 *
 * The intent was reasonable — projects that predate accounts should not be
 * orphaned — but the effect was that the first person to sign up silently
 * became the owner of everything anyone had ever built, and every real author
 * lost sight of their own projects. That is P0-1 in its most literal form.
 *
 * 0008 already does the safe half of this at migration time, one statement
 * later: `owner_id = created_by where created_by is not null`. Attributing a
 * project to the person who actually made it is evidence; attributing it to
 * whoever registered first is a guess, and a guess about ownership is not a
 * thing to make on a customer's production data.
 *
 * Surveys that still have no owner now stay owner-less, which is safe: they
 * remain visible to their whole workspace through the baseline role added in
 * section 1, and a platform administrator can assign them deliberately.
 *
 * This does NOT undo the claim that already happened on this installation.
 * Ownership there is now indistinguishable from a legitimate one, and quietly
 * moving projects between accounts on the strength of a title is exactly the
 * kind of guess this comment is about. The administrator screen offers the
 * transfer; a person decides.
 */
create or replace function public.rescript_on_auth_user_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  is_first boolean;
  org_name text;
  cust uuid;
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  select count(*) = 0 into is_first from public.profiles;
  org_name := nullif(trim(coalesce(meta->>'organization', '')), '');

  if is_first then
    select id into cust from public.customers order by created_at limit 1;
    if cust is null then
      insert into public.customers (slug, name)
      values ('default', coalesce(org_name, 'Default Workspace'))
      returning id into cust;
    elsif org_name is not null then
      update public.customers set name = org_name where id = cust;
    end if;
  elsif org_name is not null then
    select id into cust from public.customers where lower(name) = lower(org_name) limit 1;
    if cust is null then
      insert into public.customers (slug, name)
      values (
        regexp_replace(lower(org_name), '[^a-z0-9]+', '-', 'g') || '-' || substr(md5(gen_random_uuid()::text), 1, 6),
        org_name
      )
      returning id into cust;
    end if;
  else
    insert into public.customers (slug, name)
    values (
      'user-' || substr(md5(new.id::text), 1, 10),
      coalesce(nullif(trim(coalesce(meta->>'full_name', '')), ''), split_part(new.email, '@', 1))
    )
    returning id into cust;
  end if;

  insert into public.profiles (id, customer_id, email, full_name, role, user_code, organization, job_title, status)
  values (
    new.id, cust, lower(new.email),
    coalesce(nullif(trim(coalesce(meta->>'full_name', '')), ''), split_part(new.email, '@', 1)),
    case when is_first then 'platform_admin' else 'programmer' end,
    public.rescript_next_user_code(),
    org_name,
    nullif(trim(coalesce(meta->>'job_title', '')), ''),
    'active'
  )
  on conflict (id) do nothing;

  /*
   * DELIBERATELY NO SURVEY CLAIMING HERE.
   *
   * This used to run, for the first account only:
   *     update public.surveys set owner_id = new.id where owner_id is null;
   * The effect was that the first person to register silently became the
   * owner of everything anyone had built before accounts existed, and every
   * real author lost sight of their own projects — P0-1 in its most literal
   * form. Attributing a project to its `created_by` is evidence; attributing
   * it to whoever signed up first is a guess. Owner-less surveys now stay
   * owner-less, remain visible to their whole workspace through the baseline
   * role in rescript_project_access, and are assigned deliberately by an
   * administrator.
   */

  insert into public.audit_logs (customer_id, user_id, action, entity, entity_id, detail)
  values (cust, new.id, 'user.created', 'user', new.id::text,
          jsonb_build_object('email', lower(new.email), 'first', is_first));

  return new;
end $$;

-- ============================================================ 5. HOUSEKEEPING

/*
 * Apply the new liveness rule to the locks already in the table. Two of the
 * five in production are held by sessions that logged out or expired; without
 * this they would keep blocking their projects until somebody happened to
 * poll them. Nothing is deleted — a released lock is a status change, and the
 * `released_reason` says why.
 */
update public.project_edit_locks l
   set status = 'released', released_at = now(), released_reason = 'session_ended'
 where l.status = 'held'
   and not exists (
     select 1 from public.user_sessions s
      where s.id = l.locked_by_session_id and s.status = 'active'
   );

commit;
