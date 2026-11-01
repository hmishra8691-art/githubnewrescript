-- 0079 — Weighted exact balance (S4c, 2026-11-01; audit RA-05)
--
-- A flow randomizer's children (and an experiment question's arms) may carry
-- relative WEIGHTS. With exact balance the claim must then aim at each arm's
-- target share (weight / total) instead of equal counts: the arm FURTHEST
-- BELOW its target goes first. The order is Sainte-Laguë's divisor,
-- (count + 0.5) / weight, ties in the caller's deterministic order — the very
-- rule the engine's `pickLeastFilled` applies (the sandbox / preview store), so
-- the server and the in-memory store pick the same arms. With every weight
-- equal (or `p_weights` null — every call written before this) the order is
-- by count alone: exactly 0073's least-filled claim.
--
-- WHY A NEW SIGNATURE. 0073's function had eight parameters; this one adds
-- `p_weights numeric[] default null`. Two overloads would make an 8-argument
-- named call ambiguous, so the old signature is dropped first and the new one
-- serves both old and new callers (a runtime that sends no `p_weights` gets
-- the unweighted claim). Everything else — the slot lock, the session's
-- existing claim, expiry, the basis — is 0073's, unchanged.
--
-- Re-runnable: `drop function if exists` of the OLD signature only, then
-- `create or replace` of the new one; revoke again.

drop function if exists public.rescript_claim_balance(uuid, boolean, text, text, text[], integer, text, integer);

create or replace function public.rescript_claim_balance(
  p_survey uuid,
  p_test boolean,
  p_session text,
  p_key text,
  p_arms text[],
  p_count integer default 1,
  p_basis text default 'completed',
  p_hold_seconds integer default 7200,
  p_weights numeric[] default null
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
  if p_weights is not null and cardinality(p_weights) <> cardinality(p_arms) then
    raise exception 'rescript_claim_balance: one weight per arm';
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

  -- the arms furthest below their target share ((n + 0.5) / weight; by n alone when unweighted), ties in the caller's order
  select coalesce(array_agg(arm order by score, pos), '{}') into v_pick
  from (
    select a.arm, a.pos, x.n,
      case when p_weights is null then x.n::numeric
           else (x.n + 0.5) / greatest(coalesce(p_weights[a.pos], 1), 0.000001) end as score
    from (select distinct on (arm) arm, pos from unnest(p_arms) with ordinality as u(arm, pos) order by arm, pos) a
    cross join lateral (
      select count(*) as n from public.balance_claims c
        where c.survey_id = p_survey and c.is_test = coalesce(p_test, false) and c.balance_key = p_key
          and a.arm = any (c.arms)
          and (v_basis = 'started' or c.status in ('active', 'completed'))
    ) x
    order by score, a.pos
    limit v_count
  ) s;

  insert into public.balance_claims (survey_id, is_test, balance_key, session_id, arms, status, basis, expires_at)
    values (p_survey, coalesce(p_test, false), p_key, p_session, v_pick, 'active', v_basis, now() + v_hold);
  return v_pick;
end;
$$;

revoke all on function public.rescript_claim_balance(uuid, boolean, text, text, text[], integer, text, integer, numeric[]) from public, anon, authenticated;
