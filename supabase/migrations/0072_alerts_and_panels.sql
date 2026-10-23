-- 0072 — Alerts and panel recruitment (2026-10-22, engineer G3).
--
-- ALERTS. Events (an AI interview's distress flag, abuse, an injection attempt, completions, quotas, targets, the
-- cost cap, provider fallback, group-session flags, live-session no-shows, survey milestones) are routed by rules
-- to channels: e-mail, the in-app bell (0008's `notifications`), Slack, Microsoft Teams, a signed webhook.
--
--   notify_channels    an organisation's Slack / Teams / webhook / e-mail channels. The webhook URL (and a
--                      webhook's signing secret) is SEALED with envelope encryption (the BYOK vault's scheme,
--                      AES-256-GCM, key INTEGRATIONS_SECRET_KEY, AAD = channel row): `secret_sealed` is never
--                      readable through the API, members see the masked `hint` only
--   notify_rules       the organisation's rules (AlertSettings JSON); a study's own rules are on its definition
--                      (`definition.alerts`). survey_id is reserved for a study-level copy (not used yet)
--   notify_events      the OUTBOX: every event, from the Studio or the runtime (respondent app), written before it
--                      is delivered, so a crash between "flagged" and "sent" loses nothing; `idempotency_key` is
--                      unique (a replayed event is one event); the excerpt is stored REDACTED
--   notify_deliveries  one row per event × destination: queued / sent / failed / retrying / skipped (duplicate)
--                      / digest_pending / digested / not_configured, attempts, the next attempt (backoff), the
--                      provider's status, the error; `idempotency_key` unique (one delivery per event and
--                      destination, ever) — the delivery log the Studio shows
--   notifications      (0008) gains `notify_event_id`: an in-app alert is a notification row like any other
--
-- PANELS. A study's panel configuration (presets, end links, signing scheme) is on its definition
-- (`definition.panels`); what is secret or produced is here:
--
--   panel_secrets      the signing secret per (survey, panel key), sealed like the channels (AAD = survey|panel)
--   panel_entries      one arrival from a panel: the panel's id for the person, the link kind (ai_interview /
--                      group_session / live_session / survey) and what it points at, the kept parameters, the
--                      outcome (complete / screenout / quota_full / terminate / over_quota) and when the person was
--                      sent back (signed or not). One live entry per (survey, panel, panel id, test) when the panel
--                      dedupes — a unique partial index, so two tabs racing cannot both get in
--
-- Access: members of the project read entries and deliveries of their projects (the roles that read responses,
-- as 0065 / 0069); members of an organisation read its channels WITHOUT the secret column; nobody but the
-- service role writes (the Studio's routes and the runtime check access first). panel_secrets has NO member policy.
--
-- Re-runnable: `if not exists`, `drop … if exists` first, `create or replace`. Undo (destroys alert logs and
-- panel entries):
--   drop table if exists public.panel_entries, public.panel_secrets, public.notify_deliveries, public.notify_events,
--     public.notify_rules, public.notify_channels cascade;
--   alter table public.notifications drop column if exists notify_event_id;

/* ------------------------------------------------------------ alerts */

create table if not exists public.notify_channels (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  kind text not null check (kind in ('slack', 'teams', 'webhook', 'email')),
  name text not null check (char_length(name) between 1 and 80),
  -- e-mail channels carry their addresses here (not secret); Slack / Teams / webhook carry none of the URL
  config jsonb not null default '{}'::jsonb,
  secret_sealed text,
  secret_key_id text,
  -- what a screen may show of the secret: "hooks.slack.com/…/••••9xQ"
  hint text,
  enabled boolean not null default true,
  last_test_at timestamptz,
  last_status text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notify_channels_secret_needed check (kind = 'email' or secret_sealed is not null)
);
create unique index if not exists notify_channels_name_uniq on public.notify_channels (customer_id, kind, lower(name));

create table if not exists public.notify_rules (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  survey_id uuid references public.surveys(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
create unique index if not exists notify_rules_scope_uniq on public.notify_rules (customer_id, coalesce(survey_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists public.notify_events (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  customer_id uuid references public.customers(id) on delete cascade,
  survey_id uuid references public.surveys(id) on delete cascade,
  type text not null check (type ~ '^[a-z_]+\.[a-z_]+$'),
  ref text,
  -- the event as rendered input: study title, pseudonymous participant, the REDACTED excerpt, the link, details
  payload jsonb not null default '{}'::jsonb,
  source text not null default 'studio' check (source in ('studio', 'runtime', 'cron')),
  is_test boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'processing', 'processed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create unique index if not exists notify_events_idem_uniq on public.notify_events (idempotency_key);
create index if not exists notify_events_pending_idx on public.notify_events (created_at) where status in ('pending', 'processing');
create index if not exists notify_events_survey_idx on public.notify_events (survey_id, created_at desc);

create table if not exists public.notify_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.notify_events(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete cascade,
  survey_id uuid references public.surveys(id) on delete cascade,
  event_type text not null,
  channel_kind text not null check (channel_kind in ('email', 'in_app', 'slack', 'teams', 'webhook')),
  channel_id uuid references public.notify_channels(id) on delete set null,
  -- who / where, as a screen may show it: an address, a user id, "#research-ops" — never a webhook URL
  destination text not null,
  dedupe_key text,
  idempotency_key text not null,
  status text not null check (status in ('queued', 'sent', 'failed', 'retrying', 'skipped', 'digest_pending', 'digested', 'not_configured')),
  reason text,
  digest text check (digest is null or digest in ('hourly', 'daily')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  response_status integer,
  last_error text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create unique index if not exists notify_deliveries_idem_uniq on public.notify_deliveries (idempotency_key);
create index if not exists notify_deliveries_dest_idx on public.notify_deliveries (destination, created_at desc);
create index if not exists notify_deliveries_dedupe_idx on public.notify_deliveries (dedupe_key, destination, created_at desc);
create index if not exists notify_deliveries_retry_idx on public.notify_deliveries (next_attempt_at) where status in ('retrying', 'digest_pending');
create index if not exists notify_deliveries_survey_idx on public.notify_deliveries (survey_id, created_at desc);
create index if not exists notify_deliveries_customer_idx on public.notify_deliveries (customer_id, created_at desc);

-- in-app alerts are notifications (0008); the event they came from
alter table public.notifications add column if not exists notify_event_id uuid references public.notify_events(id) on delete set null;

-- e-mail alerts and live-session invitations are logged in mail_deliveries (0016) like every other mail: the kind
-- check is WIDENED by union with whatever it already allows, so this composes with any other migration's widening
do $$
declare kinds text[];
begin
  if to_regclass('public.mail_deliveries') is null then return; end if;
  select array_agg(distinct k order by k) into kinds from (
    select (regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g'))[1] as k
      from pg_constraint c where c.conrelid = 'public.mail_deliveries'::regclass and c.conname = 'mail_deliveries_kind_check'
    union select unnest(array['password_reset', 'project_invitation', 'respondent_invitation', 'test', 'media_delivery', 'alert', 'live_session_invite', 'live_session_reminder'])
  ) x;
  execute 'alter table public.mail_deliveries drop constraint if exists mail_deliveries_kind_check';
  execute format('alter table public.mail_deliveries add constraint mail_deliveries_kind_check check (kind = any (%L::text[]))', kinds);
end $$;

/* ------------------------------------------------------------ panels */

create table if not exists public.panel_secrets (
  survey_id uuid not null references public.surveys(id) on delete cascade,
  panel_key text not null check (panel_key ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  secret_sealed text not null,
  secret_key_id text not null,
  hint text,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (survey_id, panel_key)
);

create table if not exists public.panel_entries (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  panel_key text not null check (panel_key ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  pid text not null check (char_length(pid) <= 128),
  target text not null check (target in ('ai_interview', 'group_session', 'live_session', 'survey')),
  -- the study / group session / room / deployment the link belongs to, and the session it became
  target_ref text,
  session_ref text,
  is_test boolean not null default false,
  dedupe boolean not null default true,
  captured jsonb not null default '{}'::jsonb,
  outcome text check (outcome is null or outcome in ('complete', 'screenout', 'quota_full', 'terminate', 'over_quota')),
  status text,
  signed boolean,
  redirected_at timestamptz,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
-- one live entry per panel id: a second arrival is refused (the partial index is what ON CONFLICT targets)
create unique index if not exists panel_entries_dedupe_uniq on public.panel_entries (survey_id, panel_key, pid, is_test) where dedupe and pid <> '';
create index if not exists panel_entries_survey_idx on public.panel_entries (survey_id, panel_key, outcome);
create index if not exists panel_entries_session_idx on public.panel_entries (session_ref);

/* ------------------------------------------------------------ RLS: the backstop */

alter table public.notify_channels   enable row level security;
alter table public.notify_rules      enable row level security;
alter table public.notify_events     enable row level security;
alter table public.notify_deliveries enable row level security;
alter table public.panel_secrets     enable row level security;
alter table public.panel_entries     enable row level security;

-- an organisation's channels and rules: its own members (any role but client / viewer), and platform admins
-- (through 0001's security-definer helpers: a subquery on profiles here would recurse into profiles' own policy)
drop policy if exists notify_channels_org_read on public.notify_channels;
create policy notify_channels_org_read on public.notify_channels for select to authenticated
  using (
    (customer_id = public.current_customer_id() and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );
drop policy if exists notify_rules_org_read on public.notify_rules;
create policy notify_rules_org_read on public.notify_rules for select to authenticated
  using (
    (customer_id = public.current_customer_id() and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );
-- events, deliveries and panel entries: the roles that read the project's responses (as 0065 / 0069)
drop policy if exists notify_events_data_read on public.notify_events;
create policy notify_events_data_read on public.notify_events for select to authenticated
  using (
    survey_id is not null and (
      public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
      or public.rescript_is_platform_admin(auth.uid()))
  );
drop policy if exists notify_deliveries_data_read on public.notify_deliveries;
create policy notify_deliveries_data_read on public.notify_deliveries for select to authenticated
  using (
    (survey_id is not null and public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager'))
    or public.rescript_is_platform_admin(auth.uid())
  );
drop policy if exists panel_entries_data_read on public.panel_entries;
create policy panel_entries_data_read on public.panel_entries for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
    or public.rescript_is_platform_admin(auth.uid())
  );
-- panel_secrets: RLS on, no policy — only the service role (behind the routes) ever reads it

-- secrets are never readable through the API, even by members (a column list replaces the table grant)
revoke all on public.notify_channels, public.notify_rules, public.notify_events, public.notify_deliveries,
  public.panel_secrets, public.panel_entries from anon;
revoke all on public.panel_secrets from authenticated;
revoke select on public.notify_channels from authenticated;
grant select (id, customer_id, kind, name, config, hint, enabled, last_test_at, last_status, created_by, created_at, updated_at)
  on public.notify_channels to authenticated;
revoke insert, update, delete on public.notify_channels, public.notify_rules, public.notify_events, public.notify_deliveries,
  public.panel_entries from authenticated;

/* ------------------------------------------------------------ functions (service role only) */

/*
 * Claim pending outbox events for processing: at most p_limit, oldest first, leased for p_lease_seconds so two
 * dispatchers (an immediate ping and the cron) never deliver the same event at once; an expired lease is
 * claimable again (a dispatcher that died mid-way).
 */
create or replace function public.rescript_notify_claim(p_limit integer default 20, p_lease_seconds integer default 60, p_event uuid default null)
returns setof public.notify_events
language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.notify_events e
     set status = 'processing', attempts = e.attempts + 1, lease_until = now() + make_interval(secs => greatest(5, p_lease_seconds))
   where e.id in (
     select x.id from public.notify_events x
      where (p_event is null or x.id = p_event)
        and (x.status = 'pending' or (x.status = 'processing' and x.lease_until < now()))
        and x.attempts < 10
      order by x.created_at
      limit greatest(1, least(p_limit, 200))
      for update skip locked)
  returning e.*;
end $$;

/*
 * Admit one arrival from a panel: insert the entry, or — when the panel dedupes and this panel id already has an
 * entry in this study (same test flag) — return the existing one with `duplicate = true`. Atomic through the
 * unique partial index, so two tabs racing cannot both get in.
 */
create or replace function public.rescript_panel_enter(
  p_survey uuid, p_panel text, p_pid text, p_target text, p_target_ref text, p_is_test boolean, p_dedupe boolean, p_captured jsonb)
returns table (entry_id uuid, duplicate boolean, outcome text, session_ref text)
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.panel_entries (survey_id, panel_key, pid, target, target_ref, is_test, dedupe, captured)
  values (p_survey, p_panel, coalesce(p_pid, ''), p_target, p_target_ref, coalesce(p_is_test, false), coalesce(p_dedupe, true) and coalesce(p_pid, '') <> '', coalesce(p_captured, '{}'::jsonb))
  on conflict (survey_id, panel_key, pid, is_test) where dedupe and pid <> '' do nothing
  returning id into v_id;
  if v_id is not null then
    return query select v_id, false, null::text, null::text;
  else
    return query select p.id, true, p.outcome, p.session_ref from public.panel_entries p
      where p.survey_id = p_survey and p.panel_key = p_panel and p.pid = p_pid and p.is_test = coalesce(p_is_test, false) and p.dedupe
      limit 1;
  end if;
end $$;

revoke all on function public.rescript_notify_claim(integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.rescript_panel_enter(uuid, text, text, text, text, boolean, boolean, jsonb) from public, anon, authenticated;

comment on table public.notify_channels is 'Alert channels of an organisation (0072). Webhook URLs are sealed (INTEGRATIONS_SECRET_KEY); members read the masked hint only.';
comment on table public.notify_deliveries is 'The alert delivery log (0072): one row per event and destination, with status, attempts and the next retry.';
comment on table public.panel_entries is 'Arrivals from sample panels (0072): the panel id, the link, the outcome and the redirect — the reconciliation file.';
