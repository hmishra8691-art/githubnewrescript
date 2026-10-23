-- 0073 — Exact even presentation (engine item #15, 2026-10-22)
--
-- A randomizer's "evenly present" and a design question's VERSION used to be
-- derived from the respondent's random seed: balanced on average only (1,000
-- respondents, show 1 of 4 → spread 14–62). With `balance: { exact: true }` /
-- `settings.versionBalance: { exact: true }` the runtime CLAIMS the arm here:
--
--   balance_keys     one row per survey / environment / slot — the lock every
--                    claim on that slot takes, so claims are serialised
--   balance_claims   what each session holds: its arms, and whether the claim
--                    is active (in progress), completed, released (screened
--                    out, terminated, deleted) or expired (abandoned)
--
-- WHY IT IS EXACT AND DOES NOT HERD. `rescript_claim_balance` locks the slot's
-- key row, expires stale in-progress claims, COUNTS the claims per arm, picks
-- the least-filled arm(s) with the caller's deterministic tie-break order and
-- inserts the claim — all under that lock. The next claim cannot count until
-- this one is recorded, so two respondents arriving together can never both
-- see the same counts (least fill decided on a snapshot could: bursts of 25 →
-- spread 17). Under any concurrency the counted claims per arm differ by at
-- most one.
--
-- WHAT IS COUNTED (`p_basis`): 'completed' (default) = active + completed,
-- an abandoned claim expires after the hold, a screened-out one is released;
-- 'started' = every claim ever made.
--
-- Re-runnable: `if not exists`, `create or replace` (same signatures), revoke.
-- Only the runtime's service role calls the functions; members read the
-- tables through RLS like the other respondent data (0065 / 0069).

create table if not exists public.balance_keys (
  survey_id uuid not null references public.surveys(id) on delete cascade,
  is_test boolean not null default false,
  balance_key text not null check (char_length(balance_key) between 1 and 300),
  created_at timestamptz not null default now(),
  primary key (survey_id, is_test, balance_key)
);

create table if not exists public.balance_claims (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  is_test boolean not null default false,
  balance_key text not null check (char_length(balance_key) between 1 and 300),
  session_id text not null check (char_length(session_id) between 8 and 200),
  arms text[] not null check (cardinality(arms) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'completed', 'released', 'expired')),
  basis text not null default 'completed' check (basis in ('completed', 'started')),
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 hours',
  updated_at timestamptz not null default now(),
  release_reason text
);
create unique index if not exists balance_claims_session_key on public.balance_claims (survey_id, is_test, balance_key, session_id);
create index if not exists balance_claims_counting on public.balance_claims (survey_id, is_test, balance_key, status);
create index if not exists balance_claims_by_session on public.balance_claims (survey_id, session_id);

-- ------------------------------------------------------------ the claim
create or replace function public.rescript_claim_balance(
  p_survey uuid,
  p_test boolean,
  p_session text,
  p_key text,
  p_arms text[],
  p_count integer default 1,
  p_basis text default 'completed',
  p_hold_seconds integer default 7200
) returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mine public.balance_claims%rowtype;
  v_pick text[];
  v_count integer := greatest(1, coalesce(p_count, 1));
  v_hold interval := make_interval(secs => greatest(300, least(604800, coalesce(p_hold_seconds, 7200))));
  v_basis text := case when p_basis = 'started' then 'started' else 'completed' end;
begin
  if p_arms is null or cardinality(p_arms) = 0 then
    raise exception 'rescript_claim_balance: no arms to claim from';
  end if;
  if p_session is null or char_length(p_session) < 8 then
    raise exception 'rescript_claim_balance: invalid session';
  end if;

  -- serialise every claim on this slot (survey × environment × key)
  insert into public.balance_keys (survey_id, is_test, balance_key)
    values (p_survey, coalesce(p_test, false), p_key)
    on conflict do nothing;
  perform 1 from public.balance_keys
    where survey_id = p_survey and is_test = coalesce(p_test, false) and balance_key = p_key
    for update;

  -- the session already holds this slot: the same arms (Back, reload, a retried request)
  select * into v_mine from public.balance_claims
    where survey_id = p_survey and is_test = coalesce(p_test, false) and balance_key = p_key and session_id = p_session;
  if found then
    if v_mine.status <> 'completed' then
      update public.balance_claims
        set status = 'active', expires_at = now() + v_hold, updated_at = now(), release_reason = null
        where id = v_mine.id;
    end if;
    return v_mine.arms;
  end if;

  -- abandoned sessions stop counting
  update public.balance_claims
    set status = 'expired', updated_at = now(), release_reason = 'expired'
    where survey_id = p_survey and is_test = coalesce(p_test, false) and balance_key = p_key
      and status = 'active' and expires_at < now();

  -- the least-filled arms, ties in the caller's order (deterministic)
  select coalesce(array_agg(arm order by n, pos), '{}') into v_pick
  from (
    select a.arm, a.pos,
      (select count(*) from public.balance_claims c
        where c.survey_id = p_survey and c.is_test = coalesce(p_test, false) and c.balance_key = p_key
          and a.arm = any (c.arms)
          and (v_basis = 'started' or c.status in ('active', 'completed'))) as n
    from (select distinct on (arm) arm, pos from unnest(p_arms) with ordinality as u(arm, pos) order by arm, pos) a
    order by n, a.pos
    limit v_count
  ) s;

  insert into public.balance_claims (survey_id, is_test, balance_key, session_id, arms, status, basis, expires_at)
    values (p_survey, coalesce(p_test, false), p_key, p_session, v_pick, 'active', v_basis, now() + v_hold);
  return v_pick;
end;
$$;

-- ------------------------------------------------------------ the end of an interview
-- Completed: the claims stay counted for good. Anything else (screened out,
-- terminated, quota full, deleted): given back. Both lock the session's slots
-- in key order first, so a concurrent claim never counts a half-released row
-- and two of these never deadlock.
create or replace function public.rescript_complete_balance(p_survey uuid, p_session text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  perform 1 from public.balance_keys k
    where k.survey_id = p_survey
      and (k.is_test, k.balance_key) in (select c.is_test, c.balance_key from public.balance_claims c where c.survey_id = p_survey and c.session_id = p_session)
    order by k.is_test, k.balance_key
    for update;
  update public.balance_claims
    set status = 'completed', updated_at = now(), release_reason = null
    where survey_id = p_survey and session_id = p_session and status in ('active', 'expired');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.rescript_release_balance(p_survey uuid, p_session text, p_reason text default 'not_completed')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  perform 1 from public.balance_keys k
    where k.survey_id = p_survey
      and (k.is_test, k.balance_key) in (select c.is_test, c.balance_key from public.balance_claims c where c.survey_id = p_survey and c.session_id = p_session)
    order by k.is_test, k.balance_key
    for update;
  update public.balance_claims
    set status = 'released', updated_at = now(), release_reason = left(coalesce(p_reason, 'not_completed'), 60)
    where survey_id = p_survey and session_id = p_session and status in ('active', 'expired');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- a deleted response gives its claims back (soft delete sets deleted_at; a hard delete removes the row)
create or replace function public.rescript_release_balance_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'DELETE') or (new.deleted_at is not null and old.deleted_at is null) then
    update public.balance_claims
      set status = 'released', updated_at = now(), release_reason = 'response_deleted'
      where survey_id = old.survey_id and session_id = old.session_id and status <> 'released';
  end if;
  return coalesce(new, old);
end;
$$;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'responses' and column_name = 'deleted_at') then
    drop trigger if exists rescript_balance_release_on_delete on public.responses;
    create trigger rescript_balance_release_on_delete
      after update of deleted_at or delete on public.responses
      for each row execute function public.rescript_release_balance_on_delete();
  end if;
end $$;

-- ------------------------------------------------------------ what a dashboard reads
create or replace function public.rescript_balance_counts(p_survey uuid, p_test boolean)
returns table (balance_key text, arm text, active bigint, completed bigint, released bigint, expired bigint)
language sql
stable
security invoker
set search_path = public
as $$
  -- security INVOKER: the caller's RLS decides which surveys' claims it can count
  select c.balance_key, a.arm,
    count(*) filter (where c.status = 'active' and c.expires_at >= now()),
    count(*) filter (where c.status = 'completed'),
    count(*) filter (where c.status = 'released'),
    count(*) filter (where c.status = 'expired' or (c.status = 'active' and c.expires_at < now()))
  from public.balance_claims c, unnest(c.arms) as a(arm)
  where c.survey_id = p_survey and c.is_test = coalesce(p_test, false)
  group by c.balance_key, a.arm
  order by c.balance_key, a.arm;
$$;

revoke all on function public.rescript_claim_balance(uuid, boolean, text, text, text[], integer, text, integer) from public, anon, authenticated;
revoke all on function public.rescript_complete_balance(uuid, text) from public, anon, authenticated;
revoke all on function public.rescript_release_balance(uuid, text, text) from public, anon, authenticated;
revoke all on function public.rescript_release_balance_on_delete() from public, anon, authenticated;
revoke all on function public.rescript_balance_counts(uuid, boolean) from public, anon;
grant execute on function public.rescript_balance_counts(uuid, boolean) to authenticated;

-- ------------------------------------------------------------ RLS (members who read responses read the claims; nobody writes but the service role)
alter table public.balance_keys enable row level security;
alter table public.balance_claims enable row level security;
drop policy if exists balance_claims_data_read on public.balance_claims;
create policy balance_claims_data_read on public.balance_claims for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
    or public.rescript_is_platform_admin(auth.uid())
  );
revoke all on public.balance_keys, public.balance_claims from anon;
revoke insert, update, delete, truncate on public.balance_keys, public.balance_claims from authenticated;
grant select on public.balance_claims to authenticated;
