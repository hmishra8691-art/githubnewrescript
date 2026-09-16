-- ============================================================================
-- ROLLBACK OF MIGRATION 0034
-- ============================================================================
--
--   psql "<connection string>" -f scripts/0034-rollback.sql
--
-- Puts every function 0034 replaced back to the body it had under migrations
-- 0001–0033, and the `profiles_self_read` policy back to 0008's. Run
-- `scripts/0034-check.sql` afterwards: every row should read
-- "NOT applied (still 0033)".
--
-- THE TWO COLUMNS ARE DELIBERATELY LEFT IN PLACE. `project_members.revoked_at`
-- and `revoked_by` are nullable and nothing but the 0034 functions reads them,
-- so the old behaviour is fully restored the moment the old function bodies
-- are back. Dropping them would destroy the record of who was removed and
-- when — which is the one thing in this migration that cannot be recreated —
-- and it would have to be dropped again on the next attempt. If you truly want
-- them gone, the statement is at the bottom, commented out.
--
-- NOT A HAND-COPY. Each body below was read back out of a scratch PostgreSQL
-- 16 with 0001–0033 applied, using `pg_get_functiondef`, so it is exactly what
-- the database itself would have run.
--
-- Everything is in one transaction: it all goes back, or none of it does.

begin;

CREATE OR REPLACE FUNCTION public.rescript_billing_expire_reservations(p_now timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; n integer := 0;
begin
  for r in select id from public.usage_reservations where status = 'held' and expires_at <= p_now loop
    perform public.rescript_billing_release(r.id, 'expired'); n := n + 1;
  end loop;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.rescript_billing_record(p_event jsonb, p_read_only_threshold numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  w public.project_wallets; e public.usage_events; charge numeric; wid uuid;
  ps public.project_spending; kind text;
begin
  wid := nullif(p_event->>'walletId','')::uuid;
  kind := coalesce(nullif(p_event->>'subjectKind', ''), 'survey');
  if wid is not null then select * into w from public.project_wallets where id = wid for update; end if;
  e := public.rescript_billing_insert_usage(p_event, null);
  charge := coalesce((p_event->>'customerCharge')::numeric, 0);
  /*
   * An idempotent replay returns the event that already exists, and its
   * reservation/adjustment columns are whatever they were — so the debit
   * below must not run again. `e.created_at < now()` is not a test we can
   * make; instead `insert_usage` is the only thing that knows, and it tells
   * us by returning a row whose id we did not just create. The cheap, exact
   * version of that check: a replayed event already has a ledger line.
   */
  if w.id is not null and charge <> 0 and e.adjusts_event_id is null
     and not exists (select 1 from public.wallet_ledger l where l.usage_event_id = e.id) then
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
    'wallet', case when w.id is null then null else to_jsonb(w) end,
    'spending', case when ps.subject_id is null then null else to_jsonb(ps) end);
end $function$
;

CREATE OR REPLACE FUNCTION public.rescript_billing_settle(p_reservation uuid, p_event jsonb, p_read_only_threshold numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r public.usage_reservations; w public.project_wallets; e public.usage_events;
  charge numeric; ps public.project_spending; kind text;
begin
  select * into r from public.usage_reservations where id = p_reservation for update;
  if r.id is null then raise exception 'unknown reservation %', p_reservation; end if;
  if r.status <> 'held' then raise exception 'reservation already %', r.status; end if;
  kind := coalesce(r.subject_kind, 'survey');
  select * into w from public.project_wallets where id = r.wallet_id for update;
  charge := coalesce((p_event->>'customerCharge')::numeric, 0);
  e := public.rescript_billing_insert_usage(p_event, r.id);
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
    'spending', case when ps.subject_id is null then null else to_jsonb(ps) end);
end $function$
;

CREATE OR REPLACE FUNCTION public.rescript_claim_invitations(p_user uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.rescript_my_projects(p_user uuid, p_lock_stale_seconds integer DEFAULT 180)
 RETURNS TABLE(survey_id uuid, code text, title text, status text, updated_at timestamp with time zone, owner_id uuid, owner_name text, owner_code text, my_role text, role_source text, collaborators integer, editing_user_id uuid, editing_name text, editing_since timestamp with time zone, current_version text, response_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.rescript_project_access(p_user uuid, p_survey uuid)
 RETURNS TABLE(project_role text, role_source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.rescript_project_members(p_survey uuid, p_present_within_seconds integer DEFAULT 60)
 RETURNS TABLE(user_id uuid, user_code text, full_name text, email text, organization text, role text, is_owner boolean, added_at timestamp with time zone, status text, last_login_at timestamp with time zone, present boolean, activity text, last_seen_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

/* 0008's policy: it asks whether the two people share a project through a
   membership row, without the `revoked_at is null` qualification 0034 added. */
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

/* The index is 0034's and is harmless either way; dropping it keeps the
   rollback complete, and nothing depends on it. */
drop index if exists public.project_members_live_idx;

commit;

-- Only if you are certain no removal has been recorded since 0034 went in —
-- this destroys that record, and `scripts/0034-check.sql` will report the
-- columns MISSING afterwards, which is the state before 0034 ever ran.
--
-- alter table public.project_members
--   drop column if exists revoked_at,
--   drop column if exists revoked_by;
