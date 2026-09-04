-- 0008 — Accounts, sessions, project sharing, and collaborative editing
--
-- The four layers the requirement insists stay distinct, as four groups of
-- tables. Nothing here changes how a survey is programmed; it decides who may
-- do it and when.
--
--   AUTHENTICATION   profiles (extended)          who is this user
--   SESSIONS         user_sessions                are they logged in, once
--   AUTHORIZATION    project_members, invitations what may they touch
--   EDIT CONTROL     project_edit_locks, presence may they change it now
--
-- TWO GUARANTEES ARE STRUCTURAL, NOT CHECKED.
--
-- "One active session per user" and "one editor per project" are both the same
-- shape of problem as List Fill's last slot: a read followed by a write cannot
-- promise them, because two logins can both read "no active session" before
-- either writes one. So neither is enforced by a query:
--
--   * user_sessions has a UNIQUE INDEX on (user_id) WHERE status = 'active'.
--     A second concurrent login does not fail a check — it fails an index,
--     inside the transaction, and gets told who holds the session.
--
--   * project_edit_locks has survey_id as its PRIMARY KEY. There is nowhere
--     to put a second lock on a project. Acquiring is one upsert whose WHERE
--     clause runs inside the row lock.
--
-- Two sessions or two editors are therefore not "prevented"; they are
-- unrepresentable. That is the only version of this that survives concurrency.
--
-- POLICY LIVES IN TYPESCRIPT, NOT HERE.
-- Every timeout — idle, stale, absolute lifetime, lock expiry — is decided by
-- `@rescript/access` and passed in as a parameter. SQL performs the atomic
-- claim and nothing else, so there is no second copy of the state machine to
-- drift out of step with the one the UI and the tests use.
--
-- Idempotent: safe to re-run.

-- ============================================================ 1. ACCOUNTS

/**
 * The user code (USR-10482). A sequence, not a random string: it is meant to
 * be read aloud and typed by a colleague sharing a project. Starting at 10000
 * keeps every code the same width.
 */
create sequence if not exists public.rescript_user_code_seq start with 10000 increment by 1;

alter table public.profiles
  add column if not exists user_code text,
  add column if not exists organization text,
  add column if not exists job_title text,
  add column if not exists status text not null default 'active',
  add column if not exists last_login_at timestamptz,
  add column if not exists locked_until timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles add constraint profiles_status_check
  check (status in ('active', 'disabled'));

-- the code is the shareable identity, so it must be unique platform-wide
create unique index if not exists profiles_user_code_key on public.profiles (user_code);
-- one account per email address, case-insensitively
create unique index if not exists profiles_email_lower_key on public.profiles (lower(email));
create index if not exists profiles_customer_idx on public.profiles (customer_id);

/** Issue the next user code. */
create or replace function public.rescript_next_user_code() returns text
language sql volatile security definer set search_path = public as $$
  select 'USR-' || nextval('public.rescript_user_code_seq')::text;
$$;

/**
 * Create the profile the moment an account exists.
 *
 * A trigger rather than application code, because a signup that created an
 * auth user and then failed to write the profile would leave an account that
 * can authenticate but has no identity, no code and no organization — and the
 * next request would have to invent one. Here the two are the same
 * transaction.
 *
 * THE FIRST ACCOUNT IS THE PLATFORM ADMIN and adopts the existing workspace,
 * so the projects that predate accounts have an owner instead of being
 * orphaned. Every later signup gets its own organization.
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
    -- adopt the workspace the platform has been using without accounts
    select id into cust from public.customers order by created_at limit 1;
    if cust is null then
      insert into public.customers (slug, name)
      values ('default', coalesce(org_name, 'Default Workspace'))
      returning id into cust;
    elsif org_name is not null then
      update public.customers set name = org_name where id = cust;
    end if;
  elsif org_name is not null then
    -- a named organization joins an existing one of that name, or starts it
    select id into cust from public.customers where lower(name) = lower(org_name) limit 1;
    if cust is null then
      insert into public.customers (slug, name)
      values (
        -- a readable, unique slug; the suffix only appears on a collision
        regexp_replace(lower(org_name), '[^a-z0-9]+', '-', 'g') || '-' || substr(md5(gen_random_uuid()::text), 1, 6),
        org_name
      )
      returning id into cust;
    end if;
  else
    -- no organization given: a workspace of one, still isolated
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

  -- the first account takes ownership of everything that predates accounts
  if is_first then
    update public.surveys set owner_id = new.id where owner_id is null;
  end if;

  insert into public.audit_logs (customer_id, user_id, action, entity, entity_id, detail)
  values (cust, new.id, 'user.created', 'user', new.id::text,
          jsonb_build_object('email', lower(new.email), 'first', is_first));

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.rescript_on_auth_user_created();

-- ============================================================ 2. PROJECT OWNER

/**
 * Every project has exactly one owner (§12).
 *
 * Separate from `created_by`, which is history: ownership transfers, and the
 * record of who first made the project should not silently change when it
 * does.
 */
alter table public.surveys
  add column if not exists owner_id uuid references public.profiles(id) on delete set null,
  add column if not exists locked boolean not null default false,
  add column if not exists collaboration jsonb not null default '{}'::jsonb;

update public.surveys set owner_id = created_by where owner_id is null and created_by is not null;
create index if not exists surveys_owner_idx on public.surveys (owner_id);

-- ============================================================ 3. SESSIONS

create table if not exists public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz,
  ended_at timestamptz,
  ended_reason text,
  revoked_by uuid references public.profiles(id) on delete set null,
  user_agent text,
  ip_hash text,
  device_label text
);
alter table public.user_sessions enable row level security;

alter table public.user_sessions drop constraint if exists user_sessions_status_check;
alter table public.user_sessions add constraint user_sessions_status_check
  check (status in ('active', 'logged_out', 'revoked', 'expired'));

/**
 * THE single-active-session guarantee (§4, §34).
 *
 * Not a check, not a query — an index. Two simultaneous logins both insert;
 * one commits and the other gets a unique violation it can report honestly.
 */
create unique index if not exists user_sessions_one_active_key
  on public.user_sessions (user_id) where status = 'active';
create index if not exists user_sessions_user_idx on public.user_sessions (user_id, created_at desc);
create index if not exists user_sessions_active_idx on public.user_sessions (last_seen_at) where status = 'active';

/**
 * Retire sessions the clock has ended.
 *
 * Called before every login and on every heartbeat, with the thresholds the
 * TypeScript policy computed. This is what stops a crashed browser locking an
 * account out (§6, §7) — and it runs on demand rather than in a background
 * job, so the truth is correct at the moment it is asked for and the platform
 * needs no scheduler.
 */
create or replace function public.rescript_expire_sessions(
  p_user uuid,
  p_stale_seconds integer,
  p_absolute_seconds integer
) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.user_sessions s
     set status = 'expired', ended_at = now(),
         ended_reason = case
           when s.last_seen_at < now() - make_interval(secs => p_stale_seconds) then 'stale'
           else 'lifetime' end
   where s.status = 'active'
     and (p_user is null or s.user_id = p_user)
     and (
       s.last_seen_at < now() - make_interval(secs => p_stale_seconds)
       or s.created_at < now() - make_interval(secs => p_absolute_seconds)
       or (s.expires_at is not null and s.expires_at <= now())
     );
  get diagnostics n = row_count;

  -- a session that is gone cannot keep holding an edit lock (§35)
  update public.project_edit_locks l
     set status = 'released', released_at = now(), released_reason = 'session_ended'
   where l.status = 'held'
     and not exists (
       select 1 from public.user_sessions s
       where s.id = l.locked_by_session_id and s.status = 'active'
     );
  return n;
end $$;

/**
 * Log in, or explain why not.
 *
 * Returns exactly one row. `outcome` is 'created', 'blocked' or 'taken_over',
 * and on 'blocked' the blocking session is described so the message can name
 * the device and say when it will be released.
 */
create or replace function public.rescript_login(
  p_user uuid,
  p_stale_seconds integer,
  p_absolute_seconds integer,
  p_lifetime_seconds integer,
  p_force boolean default false,
  p_user_agent text default null,
  p_ip_hash text default null,
  p_device_label text default null
) returns table (
  outcome text,
  session_id uuid,
  blocking_session_id uuid,
  blocking_last_seen timestamptz,
  blocking_created_at timestamptz,
  blocking_device text
)
language plpgsql security definer set search_path = public as $$
declare
  existing record;
  new_id uuid;
begin
  -- whatever the clock has already ended does not block anything
  perform public.rescript_expire_sessions(p_user, p_stale_seconds, p_absolute_seconds);

  select s.id, s.last_seen_at, s.created_at, s.device_label into existing
  from public.user_sessions s
  where s.user_id = p_user and s.status = 'active'
  for update;

  if existing.id is not null then
    if not p_force then
      return query select 'blocked'::text, null::uuid, existing.id, existing.last_seen_at, existing.created_at, existing.device_label;
      return;
    end if;
    -- an explicitly permitted takeover ends the other session, and the lock
    -- it was holding goes with it
    update public.user_sessions
       set status = 'revoked', ended_at = now(), ended_reason = 'taken_over'
     where id = existing.id;
    update public.project_edit_locks
       set status = 'released', released_at = now(), released_reason = 'session_taken_over'
     where locked_by_session_id = existing.id and status = 'held';
  end if;

  /*
   * Two logins that BOTH found no active session race here. The `for update`
   * above locked nothing, because there was no row to lock — so the unique
   * partial index is the arbiter, and the loser must be told it lost rather
   * than shown a database error. This handler is the difference between
   * "already logged in elsewhere" and a 500 on a cold account.
   */
  begin
    insert into public.user_sessions (user_id, status, expires_at, user_agent, ip_hash, device_label)
    values (p_user, 'active', now() + make_interval(secs => p_lifetime_seconds), p_user_agent, p_ip_hash, p_device_label)
    returning id into new_id;
  exception when unique_violation then
    select s.id, s.last_seen_at, s.created_at, s.device_label into existing
    from public.user_sessions s
    where s.user_id = p_user and s.status = 'active';
    return query select 'blocked'::text, null::uuid, existing.id, existing.last_seen_at, existing.created_at, existing.device_label;
    return;
  end;

  update public.profiles set last_login_at = now(), updated_at = now() where id = p_user;

  return query select
    case when existing.id is null then 'created' else 'taken_over' end,
    new_id, existing.id, existing.last_seen_at, existing.created_at, existing.device_label;
end $$;

/**
 * The heartbeat (§6). Refuses to touch a session that is not active, so a
 * revoked session cannot resurrect itself by checking in.
 */
create or replace function public.rescript_touch_session(
  p_session uuid,
  p_stale_seconds integer,
  p_absolute_seconds integer
) returns table (status text, last_seen_at timestamptz, user_id uuid)
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  select s.user_id into u from public.user_sessions s where s.id = p_session;
  if u is null then
    return query select 'unknown'::text, null::timestamptz, null::uuid;
    return;
  end if;
  perform public.rescript_expire_sessions(u, p_stale_seconds, p_absolute_seconds);

  update public.user_sessions s set last_seen_at = now()
   where s.id = p_session and s.status = 'active';

  return query select s.status, s.last_seen_at, s.user_id
  from public.user_sessions s where s.id = p_session;
end $$;

/** Explicit logout (§5) — the session is released and the account is free. */
create or replace function public.rescript_end_session(
  p_session uuid,
  p_reason text default 'logout',
  p_by uuid default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.user_sessions
     set status = case when p_reason = 'logout' then 'logged_out' else 'revoked' end,
         ended_at = now(), ended_reason = p_reason,
         revoked_by = case when p_reason = 'logout' then null else p_by end
   where id = p_session and status = 'active';
  get diagnostics n = row_count;

  -- logging out releases whatever this session was editing (§29)
  update public.project_edit_locks
     set status = 'released', released_at = now(), released_reason = p_reason
   where locked_by_session_id = p_session and status = 'held';

  delete from public.project_presence where session_id = p_session;
  return n;
end $$;

-- ============================================================ 4. LOGIN ATTEMPTS

/**
 * What the throttle counts (§3). Kept as raw attempts rather than a counter so
 * a lockout can expire simply by the window moving, with nothing to reset.
 */
create table if not exists public.login_attempts (
  id bigserial primary key,
  identifier text,
  user_id uuid,
  ip_hash text,
  success boolean not null default false,
  reason text,
  created_at timestamptz not null default now()
);
alter table public.login_attempts enable row level security;
create index if not exists login_attempts_identifier_idx on public.login_attempts (lower(identifier), created_at desc);
create index if not exists login_attempts_ip_idx on public.login_attempts (ip_hash, created_at desc);

/** Failures inside the window, per account and per source. */
create or replace function public.rescript_login_failures(
  p_identifier text,
  p_ip_hash text,
  p_window_seconds integer
) returns table (account_failures integer, source_failures integer)
language sql stable security definer set search_path = public as $$
  select
    (select count(*)::int from public.login_attempts a
      where not a.success and a.created_at > now() - make_interval(secs => p_window_seconds)
        and p_identifier is not null and lower(a.identifier) = lower(p_identifier)),
    (select count(*)::int from public.login_attempts a
      where not a.success and a.created_at > now() - make_interval(secs => p_window_seconds)
        and p_ip_hash is not null and a.ip_hash = p_ip_hash);
$$;

-- ============================================================ 5. MEMBERSHIP

create table if not exists public.project_members (
  survey_id uuid not null references public.surveys(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null,
  added_by uuid references public.profiles(id) on delete set null,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (survey_id, user_id)
);
alter table public.project_members enable row level security;

alter table public.project_members drop constraint if exists project_members_role_check;
alter table public.project_members add constraint project_members_role_check
  check (role in ('editor', 'programmer', 'reviewer', 'viewer', 'test_user', 'deployment_manager'));

create index if not exists project_members_user_idx on public.project_members (user_id);

/**
 * THE authorization primitive: what role does this user hold on this project?
 *
 * One function, used by the API routes and by every RLS policy below, so a
 * policy and a route can never disagree about who is a member. Ownership is
 * a column on the survey and outranks any membership row.
 */
create or replace function public.rescript_project_role(p_user uuid, p_survey uuid)
returns text
language sql stable security definer set search_path = public as $$
  select case
    when p_user is null or p_survey is null then null
    when exists (select 1 from public.surveys s where s.id = p_survey and s.owner_id = p_user) then 'owner'
    else (select m.role from public.project_members m where m.survey_id = p_survey and m.user_id = p_user)
  end;
$$;

/** Is this account a platform administrator? */
create or replace function public.rescript_is_platform_admin(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.role = 'platform_admin' and p.status = 'active'
                   from public.profiles p where p.id = p_user), false);
$$;

-- ============================================================ 6. INVITATIONS

/**
 * Sharing with someone who has no account yet (§22).
 *
 * The token is the link between account creation and the project grant, so
 * accepting an invitation cannot be forged by knowing an email address.
 */
create table if not exists public.project_invitations (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  email text,
  user_code text,
  role text not null,
  token text not null,
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references public.profiles(id) on delete set null,
  revoked_at timestamptz
);
alter table public.project_invitations enable row level security;
create unique index if not exists project_invitations_token_key on public.project_invitations (token);
-- one live invitation per project per email
create unique index if not exists project_invitations_pending_key
  on public.project_invitations (survey_id, lower(email))
  where accepted_at is null and revoked_at is null and email is not null;
create index if not exists project_invitations_email_idx on public.project_invitations (lower(email)) where accepted_at is null;

/**
 * Turn every pending invitation for this address into a membership.
 *
 * Called when an account is created and when it signs in, so an invitation
 * sent before signup takes effect the moment the person arrives — the
 * "securely link the account creation process to the project invitation" that
 * §22 asks for, without the new user having to find the email again.
 */
create or replace function public.rescript_claim_invitations(p_user uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0; em text; uc text;
begin
  select lower(email), user_code into em, uc from public.profiles where id = p_user;
  if em is null then return 0; end if;

  for r in
    select i.* from public.project_invitations i
    where i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
      and (lower(i.email) = em or (i.user_code is not null and i.user_code = uc))
  loop
    insert into public.project_members (survey_id, user_id, role, added_by)
    values (r.survey_id, p_user, r.role, r.invited_by)
    on conflict (survey_id, user_id) do nothing;

    update public.project_invitations
       set accepted_at = now(), accepted_by = p_user
     where id = r.id;

    insert into public.audit_logs (user_id, action, entity, entity_id, survey_id, detail)
    values (p_user, 'project.invitation_accepted', 'survey', r.survey_id::text, r.survey_id,
            jsonb_build_object('role', r.role, 'invitationId', r.id));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ============================================================ 7. EDIT LOCKS

/**
 * The edit lock (§16, §35).
 *
 * `survey_id` is the PRIMARY KEY: there is physically nowhere to record a
 * second editor of a project. `section` is stored from the start so
 * section-level locking (§18) becomes a change to the conflict test rather
 * than a change to the schema and every caller.
 */
create table if not exists public.project_edit_locks (
  survey_id uuid primary key references public.surveys(id) on delete cascade,
  locked_by_user_id uuid not null references public.profiles(id) on delete cascade,
  locked_by_session_id uuid not null references public.user_sessions(id) on delete cascade,
  status text not null default 'held',
  section text,
  created_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  expires_at timestamptz,
  released_at timestamptz,
  released_reason text,
  released_by uuid references public.profiles(id) on delete set null
);
alter table public.project_edit_locks enable row level security;

alter table public.project_edit_locks drop constraint if exists project_edit_locks_status_check;
alter table public.project_edit_locks add constraint project_edit_locks_status_check
  check (status in ('held', 'released', 'revoked'));

create index if not exists project_edit_locks_session_idx on public.project_edit_locks (locked_by_session_id);
create index if not exists project_edit_locks_held_idx on public.project_edit_locks (last_heartbeat_at) where status = 'held';

/**
 * Take the lock, or be told who has it.
 *
 * ONE statement does the claiming. The `where` on the conflict path is
 * evaluated after the row lock is taken, so it sees the current holder as of
 * that instant and not as of the caller's earlier read — the same argument as
 * List Fill's slot claim, and the reason two people cannot both enter edit
 * mode however precisely they click together.
 *
 * A stale lock is takeable; a live one is not; and the current holder can
 * always re-acquire, because a page reload must return the editor to edit
 * mode rather than telling them they are conflicting with themselves.
 */
create or replace function public.rescript_acquire_lock(
  p_survey uuid,
  p_user uuid,
  p_session uuid,
  p_stale_seconds integer,
  p_max_hold_seconds integer,
  p_section text default null
) returns table (
  acquired boolean,
  locked_by_user_id uuid,
  locked_by_session_id uuid,
  locked_by_name text,
  locked_by_code text,
  created_at timestamptz,
  last_heartbeat_at timestamptz,
  was_stale boolean
)
language plpgsql security definer set search_path = public as $$
declare
  got record;
  holder record;
  stale_before timestamptz := now() - make_interval(secs => p_stale_seconds);
  oldest_start timestamptz := now() - make_interval(secs => p_max_hold_seconds);
  prior record;
begin
  -- who held it before this attempt, so the caller can report a takeover
  select l.locked_by_session_id as sid, l.status as st, l.last_heartbeat_at as hb
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
        -- keep the original start time when the same session re-acquires, so
        -- "editing since 10:32" does not reset on every page reload
        created_at = case when public.project_edit_locks.locked_by_session_id = p_session
                            and public.project_edit_locks.status = 'held'
                          then public.project_edit_locks.created_at else now() end,
        last_heartbeat_at = now(),
        expires_at = now() + make_interval(secs => p_max_hold_seconds),
        released_at = null, released_reason = null, released_by = null
    where
      -- free: released, revoked, or never really held
      public.project_edit_locks.status <> 'held'
      -- stale: the holder stopped checking in
      or public.project_edit_locks.last_heartbeat_at < stale_before
      -- past its ceiling
      or public.project_edit_locks.created_at < oldest_start
      or (public.project_edit_locks.expires_at is not null and public.project_edit_locks.expires_at <= now())
      -- or it is already ours
      or public.project_edit_locks.locked_by_session_id = p_session
  returning * into got;

  if got.survey_id is not null then
    return query select true, got.locked_by_user_id, got.locked_by_session_id,
      (select p.full_name from public.profiles p where p.id = got.locked_by_user_id),
      (select p.user_code from public.profiles p where p.id = got.locked_by_user_id),
      got.created_at, got.last_heartbeat_at,
      coalesce(prior.sid is not null and prior.sid <> p_session and prior.st = 'held' and prior.hb < stale_before, false);
    return;
  end if;

  -- refused: someone else is genuinely editing
  select l.*, p.full_name, p.user_code into holder
  from public.project_edit_locks l
  left join public.profiles p on p.id = l.locked_by_user_id
  where l.survey_id = p_survey;

  return query select false, holder.locked_by_user_id, holder.locked_by_session_id,
    holder.full_name, holder.user_code, holder.created_at, holder.last_heartbeat_at, false;
end $$;

/**
 * Keep the lock alive (§17). Only the holding session can, and only while the
 * lock is still held — a stale lock is not refreshed back to life behind the
 * back of whoever has since taken it.
 */
create or replace function public.rescript_heartbeat_lock(
  p_survey uuid,
  p_session uuid,
  p_max_hold_seconds integer,
  p_section text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.project_edit_locks
     set last_heartbeat_at = now(),
         expires_at = now() + make_interval(secs => p_max_hold_seconds),
         section = coalesce(p_section, section)
   where survey_id = p_survey and locked_by_session_id = p_session and status = 'held';
  get diagnostics n = row_count;
  return n > 0;
end $$;

/** Give the lock up (§29). Only the holder; releasing what you do not hold is a no-op, not an error. */
create or replace function public.rescript_release_lock(
  p_survey uuid,
  p_session uuid,
  p_reason text default 'released'
) returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.project_edit_locks
     set status = 'released', released_at = now(), released_reason = p_reason
   where survey_id = p_survey and locked_by_session_id = p_session and status = 'held';
  get diagnostics n = row_count;
  return n > 0;
end $$;

/**
 * Force-release (§30). Authorization is the caller's job — this only does it
 * and records who to. Deliberately separate from `rescript_release_lock` so
 * the audit trail can never confuse "John finished" with "Sarah took it from
 * John".
 */
create or replace function public.rescript_force_release_lock(
  p_survey uuid,
  p_by uuid,
  p_reason text default 'force_released'
) returns table (released boolean, was_held_by uuid, was_held_by_name text, was_held_by_session uuid)
language plpgsql security definer set search_path = public as $$
declare held record;
begin
  select l.locked_by_user_id as uid, l.locked_by_session_id as sid, p.full_name as nm
    into held
  from public.project_edit_locks l
  left join public.profiles p on p.id = l.locked_by_user_id
  where l.survey_id = p_survey and l.status = 'held';

  if held.uid is null then
    return query select false, null::uuid, null::text, null::uuid;
    return;
  end if;

  update public.project_edit_locks
     set status = 'revoked', released_at = now(), released_reason = p_reason, released_by = p_by
   where survey_id = p_survey;

  return query select true, held.uid, held.nm, held.sid;
end $$;

/**
 * Retire locks whose heartbeat stopped, wherever they are (§17).
 *
 * Called opportunistically on presence reads, so a stale lock is cleaned up
 * by the next person who looks at the project rather than needing a job to
 * run. `rescript_acquire_lock` does not depend on this having happened — it
 * makes its own decision inside the row lock — so nothing is racing it.
 */
create or replace function public.rescript_expire_locks(p_stale_seconds integer) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.project_edit_locks
     set status = 'released', released_at = now(), released_reason = 'stale'
   where status = 'held'
     and (last_heartbeat_at < now() - make_interval(secs => p_stale_seconds)
          or (expires_at is not null and expires_at <= now()));
  get diagnostics n = row_count;
  return n;
end $$;

-- ============================================================ 8. PRESENCE

/**
 * Who is inside a project right now (§13, §31).
 *
 * Keyed by session, not by user: the same person in two browsers is two
 * presences, and collapsing them would make "you are editing in another
 * session" impossible to explain. Rows are transient — deleted on logout and
 * ignored once they go quiet — so this table is a live view, not a history.
 */
create table if not exists public.project_presence (
  survey_id uuid not null references public.surveys(id) on delete cascade,
  session_id uuid not null references public.user_sessions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  /** what the client says it is doing; "editing" is still decided by the lock */
  activity text,
  primary key (survey_id, session_id)
);
alter table public.project_presence enable row level security;
create index if not exists project_presence_survey_idx on public.project_presence (survey_id, last_seen_at desc);
create index if not exists project_presence_user_idx on public.project_presence (user_id);

/** Report in, and read back everyone who is here. */
create or replace function public.rescript_touch_presence(
  p_survey uuid,
  p_session uuid,
  p_user uuid,
  p_activity text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.project_presence (survey_id, session_id, user_id, activity)
  values (p_survey, p_session, p_user, p_activity)
  on conflict (survey_id, session_id) do update
    set last_seen_at = now(), activity = coalesce(p_activity, public.project_presence.activity);
end $$;

/**
 * Everyone present in a project, with their role and what they are doing.
 *
 * A presence row whose session is no longer active is not returned: signing
 * out on one machine must remove you from the panel on everyone else's.
 */
create or replace function public.rescript_project_presence(
  p_survey uuid,
  p_within_seconds integer
) returns table (
  user_id uuid, session_id uuid, user_code text, full_name text, email text,
  role text, activity text, last_seen_at timestamptz, first_seen_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select pr.user_id, pr.session_id, p.user_code, p.full_name, p.email,
         coalesce(public.rescript_project_role(pr.user_id, p_survey), 'none') as role,
         pr.activity, pr.last_seen_at, pr.first_seen_at
  from public.project_presence pr
  join public.profiles p on p.id = pr.user_id
  join public.user_sessions s on s.id = pr.session_id and s.status = 'active'
  where pr.survey_id = p_survey
    and pr.last_seen_at > now() - make_interval(secs => p_within_seconds)
  order by pr.last_seen_at desc;
$$;

-- ============================================================ 9. COMMENTS

/**
 * Internal notes (§26).
 *
 * A separate table from anything respondent-facing, so there is no code path
 * by which a note could reach a survey — the runtime never reads this table
 * and has no reason to. Threads are one level deep: a note and its replies,
 * which is what a routing discussion actually looks like.
 */
create table if not exists public.project_comments (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  parent_id uuid references public.project_comments(id) on delete cascade,
  body text not null,
  /** where the note is anchored: a question, a panel, a version — or nothing */
  target jsonb not null default '{}'::jsonb,
  mentions uuid[] not null default array[]::uuid[],
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table public.project_comments enable row level security;
create index if not exists project_comments_survey_idx on public.project_comments (survey_id, created_at desc);
create index if not exists project_comments_thread_idx on public.project_comments (parent_id);
create index if not exists project_comments_open_idx on public.project_comments (survey_id) where resolved_at is null and deleted_at is null;

-- ============================================================ 10. NOTIFICATIONS

create table if not exists public.notifications (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  survey_id uuid references public.surveys(id) on delete cascade,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
alter table public.notifications enable row level security;
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;

-- ============================================================ 11. AUDIT

/**
 * The existing audit table, widened for project activity (§25).
 *
 * Extending rather than adding a second table: the platform already recorded
 * `survey.create` here, and two audit trails would mean every report has to
 * read both and reconcile their vocabularies.
 */
alter table public.audit_logs
  add column if not exists survey_id uuid references public.surveys(id) on delete cascade,
  add column if not exists session_id uuid,
  add column if not exists ip_hash text;

create index if not exists audit_logs_survey_idx on public.audit_logs (survey_id, created_at desc);
create index if not exists audit_logs_user_idx on public.audit_logs (user_id, created_at desc);
create index if not exists audit_logs_action_idx on public.audit_logs (action, created_at desc);

-- ============================================================ 12. SETTINGS

/**
 * Configurable timings (§7). The nil UUID row is the platform default; a row
 * per customer overrides it. The VALUES are read by `@rescript/access`, which
 * owns their meaning — this table only stores them.
 */
create table if not exists public.access_settings (
  customer_id uuid primary key,
  policy jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
alter table public.access_settings enable row level security;

insert into public.access_settings (customer_id, policy)
values ('00000000-0000-0000-0000-000000000000', '{}'::jsonb)
on conflict (customer_id) do nothing;

/** The effective policy for a customer: their row over the platform default. */
create or replace function public.rescript_access_policy(p_customer uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select policy from public.access_settings where customer_id = '00000000-0000-0000-0000-000000000000'),
    '{}'::jsonb
  ) || coalesce(
    (select policy from public.access_settings where customer_id = p_customer),
    '{}'::jsonb
  );
$$;

-- ============================================================ 13. RLS

/**
 * Row-level security (§33, §40).
 *
 * The Studio's API routes authorize every request server-side and hold the
 * service role, which bypasses these policies — so nothing here is load-
 * bearing for the current app, and nothing here can break it. They exist as
 * the SECOND line: the day any query runs as the signed-in user (a browser
 * client, a realtime subscription, a reporting tool), cross-project and
 * cross-customer reads are already impossible rather than newly possible.
 *
 * Every policy asks `rescript_project_role`, the same function the routes
 * ask, so the two cannot disagree about who is a member.
 */

-- profiles: yourself, and colleagues you actually share something with
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or public.rescript_is_platform_admin(auth.uid())
    or customer_id = (select p.customer_id from public.profiles p where p.id = auth.uid())
    or exists (
      select 1 from public.project_members m
      where m.user_id = profiles.id
        and public.rescript_project_role(auth.uid(), m.survey_id) is not null
    )
  );

drop policy if exists profiles_self_write on public.profiles;
create policy profiles_self_write on public.profiles for update to authenticated
  using (id = auth.uid() or public.rescript_is_platform_admin(auth.uid()))
  with check (id = auth.uid() or public.rescript_is_platform_admin(auth.uid()));

-- sessions: your own, or an admin's operational view
drop policy if exists user_sessions_own on public.user_sessions;
create policy user_sessions_own on public.user_sessions for select to authenticated
  using (user_id = auth.uid() or public.rescript_is_platform_admin(auth.uid()));

-- surveys: owned, shared with you, or an admin's read
drop policy if exists surveys_member_read on public.surveys;
create policy surveys_member_read on public.surveys for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), id) is not null
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists surveys_editor_write on public.surveys;
create policy surveys_editor_write on public.surveys for update to authenticated
  using (public.rescript_project_role(auth.uid(), id) in ('owner', 'editor', 'programmer'))
  with check (public.rescript_project_role(auth.uid(), id) in ('owner', 'editor', 'programmer'));

-- everything hanging off a survey inherits the survey's membership test
do $$
declare t text;
begin
  foreach t in array array[
    'survey_versions', 'deployments', 'design_files', 'responses', 'respondents',
    'project_members', 'project_invitations', 'project_edit_locks', 'project_presence',
    'project_comments'
  ] loop
    execute format('drop policy if exists %I_member_read on public.%I', t, t);
    execute format($f$
      create policy %I_member_read on public.%I for select to authenticated
        using (
          public.rescript_project_role(auth.uid(), survey_id) is not null
          or public.rescript_is_platform_admin(auth.uid())
        )
    $f$, t, t);
  end loop;
end $$;

-- comments: any member may write one; only the author or the owner may change it
drop policy if exists project_comments_write on public.project_comments;
create policy project_comments_write on public.project_comments for insert to authenticated
  with check (
    author_id = auth.uid()
    and public.rescript_project_role(auth.uid(), survey_id) in
        ('owner', 'editor', 'programmer', 'reviewer', 'test_user', 'deployment_manager')
  );

drop policy if exists project_comments_update on public.project_comments;
create policy project_comments_update on public.project_comments for update to authenticated
  using (author_id = auth.uid() or public.rescript_project_role(auth.uid(), survey_id) = 'owner')
  with check (author_id = auth.uid() or public.rescript_project_role(auth.uid(), survey_id) = 'owner');

-- notifications: strictly your own
drop policy if exists notifications_own on public.notifications;
create policy notifications_own on public.notifications for select to authenticated
  using (user_id = auth.uid());
drop policy if exists notifications_own_update on public.notifications;
create policy notifications_own_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- settings: everyone may read the timings that govern them; only an admin writes
drop policy if exists access_settings_read on public.access_settings;
create policy access_settings_read on public.access_settings for select to authenticated
  using (
    customer_id = '00000000-0000-0000-0000-000000000000'
    or customer_id = (select p.customer_id from public.profiles p where p.id = auth.uid())
    or public.rescript_is_platform_admin(auth.uid())
  );
drop policy if exists access_settings_write on public.access_settings;
create policy access_settings_write on public.access_settings for all to authenticated
  using (public.rescript_is_platform_admin(auth.uid()))
  with check (public.rescript_is_platform_admin(auth.uid()));

-- login_attempts carries no policy on purpose: it is throttle bookkeeping that
-- reveals which accounts are being guessed at, and only the server (service
-- role, which bypasses RLS) has any business reading it.

-- audit: readable by project members for their project, by an admin otherwise
drop policy if exists audit_logs_member_read on public.audit_logs;
create policy audit_logs_member_read on public.audit_logs for select to authenticated
  using (
    (survey_id is not null and public.rescript_project_role(auth.uid(), survey_id) is not null)
    or public.rescript_is_platform_admin(auth.uid())
  );

-- ============================================================ 14. READS FOR THE UI

/**
 * A user's project list (§36's dashboard), in one query: what they own, what
 * was shared with them, who is in it and whether it is being edited.
 *
 * A function rather than three round trips per card, because the dashboard
 * shows this for every project and the alternative is the N+1 that makes a
 * project list feel slow at exactly the moment a team gets big enough to need
 * one.
 */
create or replace function public.rescript_my_projects(p_user uuid, p_lock_stale_seconds integer default 180)
returns table (
  survey_id uuid, code text, title text, status text, updated_at timestamptz,
  owner_id uuid, owner_name text, owner_code text,
  my_role text, collaborators integer,
  editing_user_id uuid, editing_name text, editing_since timestamptz,
  current_version text, response_count integer
)
language sql stable security definer set search_path = public as $$
  select
    s.id, s.code, s.title, s.status, s.updated_at,
    s.owner_id, op.full_name, op.user_code,
    public.rescript_project_role(p_user, s.id) as my_role,
    (select count(*)::int from public.project_members m where m.survey_id = s.id) as collaborators,
    l.locked_by_user_id, lp.full_name, l.created_at,
    v.version,
    (select count(*)::int from public.responses r where r.survey_id = s.id and r.deleted_at is null) as response_count
  from public.surveys s
  left join public.profiles op on op.id = s.owner_id
  left join public.survey_versions v on v.id = s.current_version_id
  left join public.project_edit_locks l
    on l.survey_id = s.id and l.status = 'held'
   and l.last_heartbeat_at > now() - make_interval(secs => p_lock_stale_seconds)
  left join public.profiles lp on lp.id = l.locked_by_user_id
  where public.rescript_project_role(p_user, s.id) is not null
  order by s.updated_at desc;
$$;

/** The collaborator panel (§20), including who is present right now. */
create or replace function public.rescript_project_members(p_survey uuid, p_present_within_seconds integer default 60)
returns table (
  user_id uuid, user_code text, full_name text, email text, organization text,
  role text, is_owner boolean, added_at timestamptz, status text,
  last_login_at timestamptz, present boolean, activity text, last_seen_at timestamptz
)
language sql stable security definer set search_path = public as $$
  with people as (
    select s.owner_id as uid, 'owner'::text as role, true as is_owner, s.created_at as added_at
    from public.surveys s where s.id = p_survey and s.owner_id is not null
    union all
    select m.user_id, m.role, false, m.added_at
    from public.project_members m where m.survey_id = p_survey
  )
  select
    p.id, p.user_code, p.full_name, p.email, p.organization,
    people.role, people.is_owner, people.added_at, p.status, p.last_login_at,
    pr.session_id is not null as present, pr.activity, pr.last_seen_at
  from people
  join public.profiles p on p.id = people.uid
  left join lateral (
    select x.session_id, x.activity, x.last_seen_at
    from public.project_presence x
    join public.user_sessions us on us.id = x.session_id and us.status = 'active'
    where x.survey_id = p_survey and x.user_id = p.id
      and x.last_seen_at > now() - make_interval(secs => p_present_within_seconds)
    order by x.last_seen_at desc limit 1
  ) pr on true
  order by people.is_owner desc, people.role, p.full_name;
$$;

/** Active sessions across the platform, for the admin screen (§9). */
create or replace function public.rescript_active_sessions(p_stale_seconds integer default 900)
returns table (
  session_id uuid, user_id uuid, user_code text, full_name text, email text,
  organization text, account_status text, platform_role text,
  created_at timestamptz, last_seen_at timestamptz, device_label text, status text
)
language sql stable security definer set search_path = public as $$
  select s.id, s.user_id, p.user_code, p.full_name, p.email, p.organization,
         p.status, p.role, s.created_at, s.last_seen_at, s.device_label, s.status
  from public.user_sessions s
  join public.profiles p on p.id = s.user_id
  where s.status = 'active'
  order by s.last_seen_at desc;
$$;
