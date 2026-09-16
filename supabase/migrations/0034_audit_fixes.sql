-- ============================================================================
-- 0034  THE SCHEMA HALF OF THE STUDIO BUG AUDIT
-- ============================================================================
--
-- Three of the audit's findings could not be closed in TypeScript, because
-- what was wrong was the question the database answers:
--
--   2. Removing a collaborator PROMOTED them. `rescript_project_access` falls
--      through a missing `project_members` row to the workspace baseline, and
--      that baseline is `editor` unless an administrator has configured
--      otherwise. Deleting the row therefore returned a removed viewer to
--      editor on their next request, and removing an unwanted editor was a
--      no-op. Section 1 gives a removal somewhere to be written down, so the
--      access function can see it.
--
--   4. A retried settle debited the wallet TWICE. `rescript_billing_record`
--      was given an explicit "a replayed event already has a ledger line"
--      guard in 0031; `rescript_billing_settle` — the path every charge above
--      zero actually takes — was not. Section 2 gives it one, and makes both
--      functions SAY whether they wrote anything, which is what lets
--      `Meter.reverse` stop crediting a wallet for a reversal it did not
--      write (finding 3).
--
--   5. Reservations were never expired, so wallets locked up. The function
--      existed and nothing called it; a scheduled job now does
--      (`/api/cron/billing-reservations`). Section 3 bounds it, because the
--      first run against an installation that has been up for months has a
--      backlog, and one statement over all of it is how a cron job becomes an
--      outage.
--
-- Nothing here destroys a row or narrows a column. Section 1 adds two nullable
-- columns; sections 2 and 3 replace function bodies.

begin;

-- ====================================================== 1. REVOKED MEMBERSHIP

/**
 * A removal is a DECISION, and a decision has to be stored to be obeyed.
 *
 * `project_members` had exactly two states — a row, or no row — and "no row"
 * already meant something: fall through to whatever the workspace grants. So
 * there was no way to say "this person, specifically, may not see this
 * project", which is precisely what the owner meant when they pressed Remove.
 *
 * `revoked_at` is that third state. The precedence in `rescript_project_access`
 * is unchanged in shape —
 *
 *     owner  >  explicit project_members row  >  workspace baseline
 *
 * — it is only that a REVOKED row is still an explicit row. It outranks the
 * baseline exactly as an explicit share does, and for the same reason: an
 * owner who has made a decision about one person should not have it quietly
 * overturned by a default.
 *
 * Re-sharing that person clears the mark (`share`, `members` PATCH), so this
 * is not a tombstone: it is the current answer, and it can change.
 */
alter table public.project_members
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references public.profiles(id) on delete set null;

create index if not exists project_members_live_idx
  on public.project_members (survey_id) where revoked_at is null;

/* 0009's function, with the one clause the third state needs. */
create or replace function public.rescript_project_access(p_user uuid, p_survey uuid)
returns table (project_role text, role_source text)
language plpgsql stable security definer set search_path = public as $$
declare
  s_owner uuid;
  s_customer uuid;
  u_customer uuid;
  m public.project_members;
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

  select pm.* into m
    from public.project_members pm
   where pm.survey_id = p_survey and pm.user_id = p_user;
  if m.user_id is not null then
    if m.revoked_at is not null then
      /* removed on purpose: the workspace baseline does not get to undo it */
      role_source := 'revoked'; return next; return;
    end if;
    project_role := m.role; role_source := 'member'; return next; return;
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

/* The collaborator panel lists collaborators, not history. */
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
    from public.project_members m
    where m.survey_id = p_survey and m.revoked_at is null
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

/* …and the dashboard's collaborator count counts the same people. */
create or replace function public.rescript_my_projects(p_user uuid, p_lock_stale_seconds integer default 180)
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
    (select count(*)::int from public.project_members m
      where m.survey_id = s.id and m.revoked_at is null) as collaborators,
    l.locked_by_user_id, lp.full_name, l.created_at,
    v.version,
    (select count(*)::int from public.responses r where r.survey_id = s.id and r.deleted_at is null)
  from public.surveys s
  cross join lateral public.rescript_project_access(p_user, s.id) a
  left join public.profiles op on op.id = s.owner_id
  left join public.survey_versions v on v.id = s.current_version_id
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

/**
 * An invitation accepted after a removal is a NEW grant, and it must clear the
 * revocation — otherwise inviting somebody back would write `do nothing` onto
 * the revoked row and silently fail to let them in.
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
    on conflict (survey_id, user_id) do update
      set role = excluded.role, revoked_at = null, revoked_by = null, updated_at = now()
      where project_members.revoked_at is not null;

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

/* The profiles policy asked "do they share a project with me" through a
   membership row; a revoked row is not sharing anything. */
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or public.rescript_is_platform_admin(auth.uid())
    or customer_id = (select p.customer_id from public.profiles p where p.id = auth.uid())
    or exists (
      select 1 from public.project_members m
      where m.user_id = profiles.id
        and m.revoked_at is null
        and public.rescript_project_role(auth.uid(), m.survey_id) is not null
    )
  );

-- ================================================== 2. SETTLE ONCE, SAY SO

/**
 * A REPLAYED SETTLE MOVES NO MONEY.
 *
 * `rescript_billing_insert_usage` returns the EXISTING row when the event's
 * `idempotency_key` matches — that is the whole point of the key, and 0031's
 * own comment says "which makes a retried settle a no-op instead of an error".
 * It was a no-op for the EVENT and not for the MONEY: `settle` went straight
 * on to `balance = balance - charge` and inserted a second `wallet_ledger`
 * debit. A job that transcribes, settles `interview-stt:m1`, fails and retries
 * produced one usage event and two debits.
 *
 * `record` was given this guard in 0031 and `settle` was not, which is the
 * wrong way round: settle is the path every charge above zero takes.
 *
 * The test is exact rather than heuristic. A freshly inserted event carries
 * THIS reservation's id (`insert_usage` is handed `r.id`); a replayed one
 * carries whichever reservation first paid for it. The ledger check is kept
 * beside it for events written before the column meant anything.
 *
 * The hold still comes off either way: it belongs to this attempt, and leaving
 * it held is finding 5 all over again.
 *
 * Both functions now return `replayed`, so a caller that does something with
 * money AFTER the write — `Meter.reverse` credits a wallet — can tell whether
 * it is the one that wrote the event. That is what stops the Reverse button in
 * admin billing crediting five times for one charge when pressed five times.
 */
create or replace function public.rescript_billing_settle(
  p_reservation uuid, p_event jsonb, p_read_only_threshold numeric
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.usage_reservations; w public.project_wallets; e public.usage_events;
  charge numeric; ps public.project_spending; kind text; replayed boolean;
begin
  select * into r from public.usage_reservations where id = p_reservation for update;
  if r.id is null then raise exception 'unknown reservation %', p_reservation; end if;
  if r.status <> 'held' then raise exception 'reservation already %', r.status; end if;
  kind := coalesce(r.subject_kind, 'survey');
  select * into w from public.project_wallets where id = r.wallet_id for update;
  charge := coalesce((p_event->>'customerCharge')::numeric, 0);
  e := public.rescript_billing_insert_usage(p_event, r.id);

  replayed := (e.reservation_id is distinct from r.id)
    or exists (select 1 from public.wallet_ledger l where l.usage_event_id = e.id);
  if replayed then charge := 0; end if;

  update public.usage_reservations
     set status = 'settled', actual_charge = charge, settled_at = now() where id = r.id;
  update public.project_wallets
     set reserved = greatest(0, reserved - r.reserved_amount),
         balance = balance - charge,
         total_used = total_used + charge,
         updated_at = now()
   where id = w.id returning * into w;
  if charge <> 0 then
    insert into public.wallet_ledger
      (wallet_id, customer_id, survey_id, kind, amount, balance_after, reason, usage_event_id, created_by)
      values (w.id, w.customer_id, coalesce(e.survey_id, w.survey_id), 'debit', -charge,
              w.balance, e.event_type, e.id, e.user_id);
  end if;
  update public.project_wallets
     set state = public.rescript_billing_state(balance, state, p_read_only_threshold)
   where id = w.id returning * into w;

  if r.survey_id is not null then
    update public.project_spending
       set reserved = greatest(0, reserved - r.reserved_amount),
           spent = spent + charge,
           updated_at = now()
     where subject_kind = kind and subject_id = r.survey_id returning * into ps;
    if ps.subject_id is not null then
      update public.project_spending
         set state = public.rescript_billing_project_state(ps),
             frozen_at = case
               when public.rescript_billing_project_state(ps) = 'frozen' and ps.frozen_at is null then now()
               when public.rescript_billing_project_state(ps) = 'active' then null
               else ps.frozen_at end
       where subject_kind = ps.subject_kind and subject_id = ps.subject_id returning * into ps;
    end if;
  end if;
  return jsonb_build_object('event', to_jsonb(e), 'wallet', to_jsonb(w),
    'replayed', replayed,
    'spending', case when ps.subject_id is null then null else to_jsonb(ps) end);
end $$;

/* 0031's `record`, with the replay it already detected now REPORTED. */
create or replace function public.rescript_billing_record(
  p_event jsonb, p_read_only_threshold numeric
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  w public.project_wallets; e public.usage_events; charge numeric; wid uuid;
  ps public.project_spending; kind text; replayed boolean := false; k text;
begin
  wid := nullif(p_event->>'walletId','')::uuid;
  kind := coalesce(nullif(p_event->>'subjectKind', ''), 'survey');
  if wid is not null then select * into w from public.project_wallets where id = wid for update; end if;

  /*
   * ASK BEFORE, NOT AFTER. `insert_usage` returns the EXISTING row when the
   * key matches and says nothing about which happened, and no test on the row
   * that comes back can tell the two apart here — there is no reservation id
   * to compare with (that is `settle`'s exact test) and a free event has no
   * ledger line either way. The key is unique, so the read a moment before the
   * write answers it: a row already carrying this key is a replay.
   */
  k := nullif(p_event->>'idempotencyKey', '');
  if k is not null then
    perform 1 from public.usage_events where idempotency_key = k;
    replayed := found;
  end if;

  e := public.rescript_billing_insert_usage(p_event, null);
  charge := coalesce((p_event->>'customerCharge')::numeric, 0);

  /* 0031's guard, kept: a replayed event already has its ledger line */
  replayed := replayed
    or exists (select 1 from public.wallet_ledger l where l.usage_event_id = e.id);

  if w.id is not null and charge <> 0 and e.adjusts_event_id is null and not replayed then
    update public.project_wallets
       set balance = balance - charge, total_used = total_used + charge, updated_at = now()
     where id = w.id returning * into w;
    insert into public.wallet_ledger
      (wallet_id, customer_id, survey_id, kind, amount, balance_after, reason, usage_event_id, created_by)
      values (w.id, w.customer_id, coalesce(e.survey_id, w.survey_id), 'debit', -charge,
              w.balance, e.event_type, e.id, e.user_id);
    update public.project_wallets
       set state = public.rescript_billing_state(balance, state, p_read_only_threshold)
     where id = w.id returning * into w;
    if e.survey_id is not null then
      ps := public.rescript_billing_subject_spending_for(kind, e.survey_id, w.customer_id, true);
      update public.project_spending set spent = spent + charge, updated_at = now()
       where subject_kind = kind and subject_id = e.survey_id returning * into ps;
      update public.project_spending
         set state = public.rescript_billing_project_state(ps),
             frozen_at = case
               when public.rescript_billing_project_state(ps) = 'frozen' and ps.frozen_at is null then now()
               when public.rescript_billing_project_state(ps) = 'active' then null
               else ps.frozen_at end
       where subject_kind = ps.subject_kind and subject_id = ps.subject_id returning * into ps;
    end if;
  end if;
  return jsonb_build_object('event', to_jsonb(e),
    'replayed', replayed,
    'wallet', case when w.id is null then null else to_jsonb(w) end,
    'spending', case when ps.subject_id is null then null else to_jsonb(ps) end);
end $$;

-- ================================================ 3. EXPIRY, IN SLICES

/**
 * Bounded, because it finally has a caller.
 *
 * The oldest holds go first, so a backlog drains in order, and the caller
 * (`/api/cron/billing-reservations`) loops until a slice comes back short.
 * `rescript_billing_release` is the same function a normal release uses, so
 * the project's `reserved` comes back too.
 */
create or replace function public.rescript_billing_expire_reservations(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n integer := 0;
begin
  for r in
    select id from public.usage_reservations
     where status = 'held' and expires_at <= p_now
     order by expires_at
     limit 1000
  loop
    perform public.rescript_billing_release(r.id, 'expired'); n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.rescript_billing_expire_reservations(timestamptz) from public, anon, authenticated;
revoke all on function public.rescript_billing_settle(uuid, jsonb, numeric) from public, anon, authenticated;
revoke all on function public.rescript_billing_record(jsonb, numeric) from public, anon, authenticated;
revoke all on function public.rescript_project_members(uuid, integer) from public, anon, authenticated;

commit;
