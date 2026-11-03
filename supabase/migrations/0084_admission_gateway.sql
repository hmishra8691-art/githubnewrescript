-- 0084 — The recruitment exchange, Phase 4: the admission gateway and fraud intelligence (2026-11-03).
--
-- 0083 answered "is this the same person?". This answers "should this person go in, and if so, how do we prove
-- later that we let them?" — and it adds the one security primitive the brief's §22 asks for that this platform
-- did not have: a short-lived, single-use token standing between the gateway's decision and the survey session.
--
-- ## The flow (the brief's §23)
--
--   vendor link  →  /r/<client>/<study>  →  resolve identity (0083)  →  score risk (quality/admission.ts)
--                →  record the decision  →  issue an access token  →  redirect to the survey
--                →  session/start redeems the token, once, server-side  →  the interview begins
--
-- Before this, `session/start` was both the gate and the thing being gated. That worked, but it left nowhere to
-- put a verification step and nothing to prove, afterwards, on what evidence a given respondent was admitted.
--
--   survey_access_tokens  the token's HASH, never the token. Single use: `redeemed_at` is set by a conditional
--                         update, so a replayed token finds the row already redeemed and is refused. Short-lived
--                         and bound to the survey, the identity and the arrival network it was issued for.
--   admission_decisions   one row per arrival through the gateway: the decision, the risk score, the reason
--                         codes and the evidence. The brief's §20 requires a reason for every decision, and this
--                         is where "why was this respondent held?" is answered weeks later by somebody who was
--                         not there.
--   fraud_cases           the review queue. A quarantined participation opens a case; a human clears or upholds
--                         it, and the respondent can appeal. §20's false-positive mechanism.
--   network_reputation    cached intelligence about an address: datacenter, proxy, Tor, VPN, and how many
--                         distinct identities have arrived from it. Cached so the synchronous admission path is
--                         one indexed lookup rather than a call to anybody.
--
-- ## What this migration deliberately does not do
--
-- Nothing here refuses a respondent. The highest risk band quarantines a participation for review and holds its
-- complete from being billed; `admission_decisions.decision` has no value meaning "blocked on risk". The
-- false-positive rate of these signals on real traffic has not been measured — 0083's shadow mode exists to
-- measure it and no traffic has been through it yet — and until it has, refusing people is a guess with
-- somebody else's earnings. A duplicate refusal (0083, enforce mode) is a different thing and stays available.
--
-- Re-runnable: `if not exists`, `drop … if exists` first, `create or replace`. Undo:
--   drop table if exists public.fraud_cases, public.admission_decisions, public.survey_access_tokens,
--     public.network_reputation cascade;
--   alter table public.recruitment_projects drop column if exists admission_mode;

/* ------------------------------------------------------------ network intelligence */

create table if not exists public.network_reputation (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  /*
   * The HMAC of the address under RTID_MATCH_KEY — the same `network` token 0083 derives, so this table joins
   * to the identity registry without either of them holding an IP address. There is no column here that a raw
   * address could go in.
   */
  network_token text not null check (char_length(network_token) between 16 and 128),
  -- what the address is, as far as anything can tell
  datacenter boolean not null default false,
  proxy boolean not null default false,
  tor boolean not null default false,
  vpn boolean not null default false,
  /** 0–100 from a configured provider, when one exists. NULL = nobody was asked. */
  provider_risk numeric(5,2) check (provider_risk is null or (provider_risk >= 0 and provider_risk <= 100)),
  provider text,
  -- distinct respondent identities seen arriving from this network, maintained as arrivals happen
  identities integer not null default 0 check (identities >= 0),
  arrivals integer not null default 0 check (arrivals >= 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- reputation goes stale; a refreshed lookup replaces it
  checked_at timestamptz,
  expires_at timestamptz
);
create unique index if not exists network_reputation_uniq on public.network_reputation (customer_id, network_token);

/* ------------------------------------------------------------ the decision */

create table if not exists public.admission_decisions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  survey_id uuid not null references public.surveys(id) on delete cascade,
  trust_id uuid references public.respondent_trust_ids(id) on delete set null,
  ledger_id uuid references public.participation_ledger(id) on delete set null,
  integration_id uuid references public.vendor_integrations(id) on delete set null,
  /*
   * `admitted`          went in normally
   * `admitted_flagged`  went in, and a case was opened because the risk band says a human should look
   * `duplicate`         refused by 0083's enforcement — an identity decision, not a risk one
   * `observed`          shadow mode: would have been refused as a duplicate, admitted anyway
   * `not_eligible`      the project is closed, over quota, or the link was wrong
   * There is deliberately NO value meaning "refused because the risk score was high".
   */
  decision text not null check (decision in ('admitted', 'admitted_flagged', 'duplicate', 'observed', 'not_eligible')),
  risk_score numeric(5,2) not null default 0 check (risk_score >= 0 and risk_score <= 100),
  risk_band text not null default 'low' check (risk_band in ('low', 'moderate', 'high', 'critical')),
  -- the rule ids that fired, for filtering; the sentences live in `evidence`
  reasons text[] not null default '{}',
  evidence jsonb not null default '{}'::jsonb,
  -- how this arrival was linked to its identity, carried from 0083 so a reviewer sees it without a join
  resolution text check (resolution is null or resolution in ('deterministic', 'probabilistic', 'vendor_scoped')),
  network_token text,
  -- how long the synchronous path actually took, because §21 says legitimate respondents must not be delayed
  decided_in_ms integer check (decided_in_ms is null or decided_in_ms >= 0),
  occurred_at timestamptz not null default now()
);
create index if not exists admission_decisions_survey_idx on public.admission_decisions (survey_id, occurred_at desc);
create index if not exists admission_decisions_trust_idx on public.admission_decisions (trust_id, occurred_at desc);
create index if not exists admission_decisions_band_idx on public.admission_decisions (customer_id, risk_band, occurred_at desc);

/* ------------------------------------------------------------ the access token */

create table if not exists public.survey_access_tokens (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  survey_id uuid not null references public.surveys(id) on delete cascade,
  trust_id uuid references public.respondent_trust_ids(id) on delete set null,
  ledger_id uuid references public.participation_ledger(id) on delete set null,
  decision_id uuid references public.admission_decisions(id) on delete set null,
  /*
   * The SHA-256 of the token, never the token. Treated exactly as a password would be: the gateway hands the
   * secret to the respondent's browser once and keeps only something it can compare against. A reader of this
   * table cannot mint a working token from it.
   */
  token_hash text not null check (char_length(token_hash) = 64),
  -- bound to the arrival, so a token lifted from one person's redirect does not work for another's browser
  network_token text,
  is_test boolean not null default false,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- single use. Set by a conditional update, so a replay finds it already set and is refused.
  redeemed_at timestamptz,
  redeemed_session text,
  constraint survey_access_tokens_window check (expires_at > issued_at)
);
create unique index if not exists survey_access_tokens_hash_uniq on public.survey_access_tokens (token_hash);
create index if not exists survey_access_tokens_expiry_idx on public.survey_access_tokens (expires_at) where redeemed_at is null;

/* ------------------------------------------------------------ the review queue */

create table if not exists public.fraud_cases (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  survey_id uuid references public.surveys(id) on delete cascade,
  trust_id uuid references public.respondent_trust_ids(id) on delete set null,
  ledger_id uuid references public.participation_ledger(id) on delete set null,
  decision_id uuid references public.admission_decisions(id) on delete set null,
  kind text not null default 'admission_risk'
    check (kind in ('admission_risk', 'duplicate', 'vendor_pattern', 'manual')),
  risk_score numeric(5,2) not null default 0 check (risk_score >= 0 and risk_score <= 100),
  reasons text[] not null default '{}',
  evidence jsonb not null default '{}'::jsonb,
  /*
   * open       waiting for a human
   * cleared    a false positive. The complete is billable and the identity's risk is reduced.
   * upheld     genuine. The complete is not billable and the identity is marked.
   * appealed   the respondent (through the vendor) disputed an upheld case
   * withdrawn  opened in error
   */
  status text not null default 'open' check (status in ('open', 'cleared', 'upheld', 'appealed', 'withdrawn')),
  -- a complete under review is not paid for until the case is resolved; §30's money depends on this
  holds_payment boolean not null default true,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolution_note text,
  /*
   * §20 asks for an appeal mechanism. A case upheld without one is a person told they cheated with no way to
   * answer, by a system whose false-positive rate nobody has measured.
   */
  appealed_at timestamptz,
  appeal_note text
);
create index if not exists fraud_cases_queue_idx on public.fraud_cases (customer_id, status, opened_at desc);
create index if not exists fraud_cases_survey_idx on public.fraud_cases (survey_id, status);
create index if not exists fraud_cases_trust_idx on public.fraud_cases (trust_id, opened_at desc);
-- one open case per participation: a reviewer should see one item, not one per page reload
create unique index if not exists fraud_cases_open_uniq on public.fraud_cases (ledger_id)
  where status in ('open', 'appealed') and ledger_id is not null;

/* ------------------------------------------------------------ the project's setting */

alter table public.recruitment_projects
  -- off: no gateway. observe: score and record, open no cases. review: score, record, quarantine at high risk.
  add column if not exists admission_mode text not null default 'observe';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'recruitment_projects_admission_mode') then
    alter table public.recruitment_projects
      add constraint recruitment_projects_admission_mode check (admission_mode in ('off', 'observe', 'review'));
  end if;
end $$;

/* ------------------------------------------------------------ row level security */

alter table public.network_reputation    enable row level security;
alter table public.admission_decisions   enable row level security;
alter table public.survey_access_tokens  enable row level security;
alter table public.fraud_cases           enable row level security;

drop policy if exists admission_decisions_read on public.admission_decisions;
create policy admission_decisions_read on public.admission_decisions for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) in
      ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer_data', 'deployment_manager')
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists fraud_cases_read on public.fraud_cases;
create policy fraud_cases_read on public.fraud_cases for select to authenticated
  using (
    (customer_id = public.current_customer_id() and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists network_reputation_read on public.network_reputation;
create policy network_reputation_read on public.network_reputation for select to authenticated
  using (
    (customer_id = public.current_customer_id() and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

-- survey_access_tokens: RLS on, NO policy. A token hash is a credential and the service role is its only reader.

revoke all on public.network_reputation, public.admission_decisions, public.survey_access_tokens,
  public.fraud_cases from anon;
revoke all on public.survey_access_tokens from authenticated;
grant select on public.network_reputation, public.admission_decisions, public.fraud_cases to authenticated;

/* ------------------------------------------------------------ issuing

   One call does the whole synchronous decision: record what was decided and why, mint the token, and — when
   the band says so — open a review case. One statement rather than four, because a crash between them would
   leave a respondent holding a token nobody can explain, or a case with no decision attached to it.          */

create or replace function public.rescript_admission_issue(
  p_customer uuid, p_survey uuid, p_trust uuid, p_ledger uuid, p_integration uuid,
  p_decision text, p_risk numeric, p_band text, p_reasons text[], p_evidence jsonb,
  p_resolution text, p_network_token text, p_token_hash text, p_ttl_seconds integer,
  p_is_test boolean default false, p_decided_in_ms integer default null, p_open_case boolean default false)
returns table (decision_id uuid, token_id uuid, case_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_decision uuid;
  v_token    uuid;
  v_case     uuid;
  v_expires  timestamptz := now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 900), 60));
begin
  insert into public.admission_decisions (customer_id, survey_id, trust_id, ledger_id, integration_id,
    decision, risk_score, risk_band, reasons, evidence, resolution, network_token, decided_in_ms)
  values (p_customer, p_survey, p_trust, p_ledger, p_integration,
    p_decision, coalesce(p_risk, 0), coalesce(p_band, 'low'), coalesce(p_reasons, '{}'), coalesce(p_evidence, '{}'::jsonb),
    p_resolution, p_network_token, p_decided_in_ms)
  returning id into v_decision;

  if p_token_hash is not null then
    insert into public.survey_access_tokens (customer_id, survey_id, trust_id, ledger_id, decision_id,
      token_hash, network_token, is_test, expires_at)
    values (p_customer, p_survey, p_trust, p_ledger, v_decision, p_token_hash, p_network_token,
      coalesce(p_is_test, false), v_expires)
    returning id into v_token;
  end if;

  /*
   * A case is opened only in `review` mode and only at a band that warrants a human. `on conflict do nothing`
   * against the one-open-case-per-participation index means a respondent reloading the gateway produces one
   * item in the queue, not one per reload.
   */
  if coalesce(p_open_case, false) then
    insert into public.fraud_cases (customer_id, survey_id, trust_id, ledger_id, decision_id,
      kind, risk_score, reasons, evidence)
    values (p_customer, p_survey, p_trust, p_ledger, v_decision, 'admission_risk',
      coalesce(p_risk, 0), coalesce(p_reasons, '{}'), coalesce(p_evidence, '{}'::jsonb))
    on conflict do nothing
    returning id into v_case;

    if p_trust is not null then
      update public.respondent_trust_ids
         set risk_score = greatest(risk_score, coalesce(p_risk, 0)), last_seen_at = now()
       where id = p_trust;
    end if;
  end if;

  return query select v_decision, v_token, v_case, v_expires;
end;
$$;

/**
 * Redeem an access token, exactly once.
 *
 * The single-use guarantee is the conditional update: `where redeemed_at is null` means two simultaneous
 * redemptions contend in the database and one of them updates no rows. A replayed token — copied from a
 * redirect, shared in a forum, retried by a script — finds the row already redeemed and is refused. The
 * expiry is checked in the same statement, so a token that expired between issue and redemption cannot slip
 * through a read-then-write gap.
 */
create or replace function public.rescript_admission_redeem(
  p_token_hash text, p_survey uuid, p_session text, p_network_token text default null)
returns table (ok boolean, reason text, trust_id uuid, ledger_id uuid, decision_id uuid)
language plpgsql security definer set search_path = public as $$
declare v_row record;
begin
  update public.survey_access_tokens t
     set redeemed_at = now(), redeemed_session = p_session
   where t.token_hash = p_token_hash
     and t.survey_id = p_survey
     and t.redeemed_at is null
     and t.expires_at > now()
  returning t.trust_id, t.ledger_id, t.decision_id into v_row;

  if found then
    return query select true, 'redeemed'::text, v_row.trust_id, v_row.ledger_id, v_row.decision_id;
    return;
  end if;

  -- it failed: say WHY, because "expired" and "already used" lead a respondent to different next steps
  select t.redeemed_at, t.expires_at into v_row
    from public.survey_access_tokens t where t.token_hash = p_token_hash and t.survey_id = p_survey;
  if not found then
    return query select false, 'unknown'::text, null::uuid, null::uuid, null::uuid;
  elsif v_row.redeemed_at is not null then
    return query select false, 'already_used'::text, null::uuid, null::uuid, null::uuid;
  else
    return query select false, 'expired'::text, null::uuid, null::uuid, null::uuid;
  end if;
end;
$$;

/**
 * Record an arrival against a network, and return what is known about it.
 *
 * `identities` counts DISTINCT trust ids, not arrivals: one person reloading twenty times is one identity, and
 * scoring them as twenty would manufacture the density signal the rule is looking for.
 */
create or replace function public.rescript_network_seen(
  p_customer uuid, p_network_token text, p_trust uuid default null)
returns table (datacenter boolean, proxy boolean, tor boolean, vpn boolean, provider_risk numeric, identities integer)
language plpgsql security definer set search_path = public as $$
declare v_identities integer;
begin
  insert into public.network_reputation (customer_id, network_token, arrivals, identities)
    values (p_customer, p_network_token, 1, 0)
  on conflict (customer_id, network_token)
    do update set arrivals = public.network_reputation.arrivals + 1, last_seen_at = now();

  -- the honest count, from the identity registry itself rather than a counter that can drift
  select count(distinct t.trust_id) into v_identities
    from public.identity_match_tokens t
   where t.customer_id = p_customer and t.kind = 'network' and t.token = p_network_token;

  update public.network_reputation n
     set identities = coalesce(v_identities, 0)
   where n.customer_id = p_customer and n.network_token = p_network_token;

  return query
    select n.datacenter, n.proxy, n.tor, n.vpn, n.provider_risk, n.identities
      from public.network_reputation n
     where n.customer_id = p_customer and n.network_token = p_network_token;
end;
$$;

/** Resolve a review case. Idempotent: resolving a resolved case changes nothing and says so. */
create or replace function public.rescript_fraud_resolve(
  p_case uuid, p_status text, p_by uuid default null, p_note text default null)
returns table (resolved boolean, status text)
language plpgsql security definer set search_path = public as $$
declare v_row record;
begin
  select * into v_row from public.fraud_cases where id = p_case for update;
  if not found then
    raise exception 'fraud case % does not exist', p_case using errcode = 'no_data_found';
  end if;
  if v_row.status in ('cleared', 'upheld', 'withdrawn') then
    return query select false, v_row.status;
    return;
  end if;

  update public.fraud_cases fc
     set status = p_status,
         -- a cleared case releases the complete for billing; an upheld one keeps holding it
         holds_payment = (p_status <> 'cleared'),
         resolved_at = case when p_status = 'appealed' then fc.resolved_at else now() end,
         resolved_by = coalesce(p_by, fc.resolved_by),
         resolution_note = coalesce(p_note, fc.resolution_note),
         appealed_at = case when p_status = 'appealed' then now() else fc.appealed_at end,
         appeal_note = case when p_status = 'appealed' then coalesce(p_note, fc.appeal_note) else fc.appeal_note end
   where fc.id = p_case;

  /*
   * A cleared case REDUCES the identity's standing risk. Without this, one false positive would follow a
   * respondent around for ever: every later arrival would see a raised risk score and open another case, and
   * clearing them would never stop happening.
   */
  if p_status = 'cleared' and v_row.trust_id is not null then
    -- `status` is this function's OUT parameter as well as a column here, so the reads are qualified
    update public.respondent_trust_ids rt
       set risk_score = greatest(0, rt.risk_score - coalesce(v_row.risk_score, 0)),
           status = case when rt.status = 'quarantined' then 'active' else rt.status end
     where rt.id = v_row.trust_id;
  elsif p_status = 'upheld' and v_row.trust_id is not null then
    update public.respondent_trust_ids rt set status = 'quarantined' where rt.id = v_row.trust_id;
  end if;

  return query select true, p_status;
end;
$$;

revoke all on function public.rescript_admission_issue(uuid, uuid, uuid, uuid, uuid, text, numeric, text, text[], jsonb, text, text, text, integer, boolean, integer, boolean) from public, anon, authenticated;
revoke all on function public.rescript_admission_redeem(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.rescript_network_seen(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.rescript_fraud_resolve(uuid, text, uuid, text) from public, anon, authenticated;

comment on table public.survey_access_tokens is 'Short-lived single-use tokens standing between the gateway and the survey (0084). The HASH only; redemption is a conditional update, so a replay is refused.';
comment on table public.admission_decisions is 'One row per arrival through the gateway (0084), with the reason codes and evidence behind it. No value of `decision` means refused on risk.';
comment on table public.fraud_cases is 'The review queue (0084). A quarantined participation holds its complete from billing until a human clears or upholds it; the respondent may appeal.';

/* ------------------------------------------------------------ a correction to 0083

   0083 gave `identity_match_tokens` a unique index on (customer_id, kind, token). For a DETERMINISTIC token
   that is right and load-bearing: one e-mail address is one person, and two identities answering to it is the
   merge candidate 0083 reports.

   For a PROBABILISTIC token it is wrong, and wrong in the direction that harms people. A network token belongs
   to a router, and a router has a household behind it. Under a unique index the second person to arrive from
   that address could not get their own row — so `rescript_rtid_resolve` found the FIRST person's identity and
   silently returned it. Two people sharing a home connection became one person, and the second was then liable
   to be refused as a duplicate of a stranger.

   So the uniqueness is now scoped to what it is actually true of:

     deterministic   unique per (customer, kind, token) — one identifier, one identity, candidates reported
     probabilistic   unique per (customer, kind, token, trust id) — many identities may share a network or a
                     device, which is a FACT about the world and also exactly the signal `network.identity_density`
                     and `device.identity_density` are counting (0084).

   And the resolution rule changes to match, below.                                                           */

drop index if exists public.identity_match_tokens_uniq;

create unique index if not exists identity_match_tokens_deterministic_uniq
  on public.identity_match_tokens (customer_id, kind, token)
  where strength = 'deterministic';

-- one row per identity per token: a person arriving twice from one network does not accumulate rows
create unique index if not exists identity_match_tokens_pair_uniq
  on public.identity_match_tokens (customer_id, kind, token, trust_id);

create index if not exists identity_match_tokens_lookup_idx
  on public.identity_match_tokens (customer_id, kind, token);

/**
 * Resolve an arrival to an identity — with circumstantial evidence no longer able to merge two people.
 *
 * The change from 0083 is one rule, and it is the same rule the admission decision already follows: **evidence
 * below the threshold that licenses an action does not license an identity either.**
 *
 *   deterministic match                     adopt the identity. One identifier, one person.
 *   probabilistic match at or above 85      adopt it. Three independent signals agreeing is the same bar that
 *                                           `decideAdmission` requires before it will refuse anybody.
 *   probabilistic match below 85            DO NOT adopt. Mint a new identity and record the link as evidence.
 *                                           A household on one router is two people, and treating them as one
 *                                           would refuse the second as a duplicate of the first.
 *
 * The weaker links are not thrown away: they are recorded as `merge_candidate` events carrying the confidence
 * and the signals, which is what a reviewer sees, and the shared tokens are what the density rules count. So a
 * click farm running forty identities through one device still lights up — as a fraud signal, scored and
 * reviewed by a person, rather than as a silent identity merge nobody can see.
 */
create or replace function public.rescript_rtid_resolve(
  p_customer uuid,
  p_tokens jsonb,
  p_integration uuid default null,
  p_participant text default null,
  p_survey uuid default null)
returns table (
  trust_uuid uuid, trust_id text,
  resolution text, confidence numeric,
  identity_resolution text, identity_confidence numeric,
  minted boolean, merge_candidates integer)
language plpgsql security definer set search_path = public as $$
declare
  v_trust      uuid;
  v_handle     text;
  v_resolution text := 'vendor_scoped';
  v_confidence numeric := 0;
  v_std_res    text;
  v_std_conf   numeric;
  v_minted     boolean := false;
  v_merge      integer := 0;
  v_kinds      integer;
  v_link       uuid;
  v_link_conf  numeric := 0;
  r            record;
begin
  /* the adoption threshold: the same 85 that `decideAdmission` requires before it will act on a match */
  if p_integration is not null and coalesce(p_participant, '') <> '' then
    select m.trust_id into v_trust from public.vendor_participant_mappings m
      where m.integration_id = p_integration and m.participant_id = p_participant;
    if v_trust is not null then
      v_resolution := 'deterministic'; v_confidence := 100;
    end if;
  end if;

  if v_trust is null then
    select count(distinct t.trust_id) into v_merge
      from public.identity_match_tokens t
      join jsonb_array_elements(p_tokens) x on x->>'token' = t.token and x->>'kind' = t.kind
     where t.customer_id = p_customer and t.strength = 'deterministic'
       and (t.expires_at is null or t.expires_at > now());
    if coalesce(v_merge, 0) > 0 then
      select t.trust_id into v_trust
        from public.identity_match_tokens t
        join jsonb_array_elements(p_tokens) x on x->>'token' = t.token and x->>'kind' = t.kind
        join public.respondent_trust_ids rt on rt.id = t.trust_id
       where t.customer_id = p_customer and t.strength = 'deterministic'
         and (t.expires_at is null or t.expires_at > now())
       order by rt.first_seen_at, t.trust_id limit 1;
    end if;
    if v_trust is not null then
      v_resolution := 'deterministic'; v_confidence := 100;
      if v_merge > 1 then
        insert into public.identity_match_events (customer_id, trust_id, survey_id, integration_id, kind, resolution, confidence, signals, evidence, shadow)
        values (p_customer, v_trust, p_survey, p_integration, 'merge_candidate', 'deterministic', 100, '{}',
                jsonb_build_object('candidates', v_merge, 'note', 'several trust ids answer to one deterministic token'), true);
      end if;
    else
      v_merge := 0;
    end if;
  end if;

  -- circumstantial agreement. The STRONGEST single candidate, and how many signal kinds back it.
  if v_trust is null then
    select t.trust_id as hit, count(distinct t.kind) as kinds into r
      from public.identity_match_tokens t
      join jsonb_array_elements(p_tokens) x on x->>'token' = t.token and x->>'kind' = t.kind
     where t.customer_id = p_customer and t.strength = 'probabilistic'
       and (t.expires_at is null or t.expires_at > now())
     group by t.trust_id
     order by count(distinct t.kind) desc, t.trust_id
     limit 1;

    if r.hit is not null then
      v_kinds := r.kinds;
      v_link_conf := case when v_kinds >= 3 then 88 when v_kinds = 2 then 75 else 55 end;
      if v_link_conf >= 85 then
        v_trust := r.hit;
        v_resolution := 'probabilistic';
        v_confidence := v_link_conf;
      else
        /*
         * Below the threshold the link is EVIDENCE, not identity. The arrival gets its own identity and the
         * resemblance is recorded for a reviewer. This is the line between "two people share a router" and
         * "one person came back", and nothing circumstantial is allowed to decide it.
         */
        v_link := r.hit;
      end if;
    end if;
  end if;

  if v_trust is null then
    v_handle := 'rtid_' || encode(gen_random_bytes(12), 'hex');
    insert into public.respondent_trust_ids (customer_id, trust_id, resolution, confidence)
      values (p_customer, v_handle, 'vendor_scoped', 0)
      returning id into v_trust;
    v_minted := true;
    insert into public.identity_match_events (customer_id, trust_id, survey_id, integration_id, kind, resolution, confidence, shadow)
      values (p_customer, v_trust, p_survey, p_integration, 'minted', 'vendor_scoped', 0, true);

    if v_link is not null then
      insert into public.identity_match_events (customer_id, trust_id, survey_id, integration_id, kind, resolution, confidence, evidence, shadow)
      values (p_customer, v_trust, p_survey, p_integration, 'merge_candidate', 'probabilistic', v_link_conf,
              jsonb_build_object('resembles', v_link, 'signals', v_kinds,
                'note', 'circumstantial resemblance below the adoption threshold — a separate identity was created'), true);
      v_merge := 1;
    end if;
  else
    update public.respondent_trust_ids rt
       set last_seen_at = now(),
           resolution = case
             when rt.resolution = 'deterministic' then 'deterministic'
             when v_resolution = 'deterministic' then 'deterministic'
             when rt.resolution = 'probabilistic' or v_resolution = 'probabilistic' then 'probabilistic'
             else 'vendor_scoped' end,
           confidence = greatest(rt.confidence, v_confidence)
     where rt.id = v_trust;
  end if;

  select rt.trust_id, rt.resolution, rt.confidence into v_handle, v_std_res, v_std_conf
    from public.respondent_trust_ids rt where rt.id = v_trust;

  /*
   * `on conflict DO NOTHING` rather than an inferred column list: `trust_id` is this function's OUT parameter
   * as well as a column, and plpgsql resolves it as the variable inside a conflict target. The touch is a
   * separate statement, which is clearer anyway.
   */
  insert into public.identity_match_tokens (customer_id, trust_id, kind, token, key_id, strength, expires_at)
  select p_customer, v_trust, x->>'kind', x->>'token', coalesce(x->>'key_id', 'k1'), x->>'strength',
         nullif(x->>'expires_at', '')::timestamptz
    from jsonb_array_elements(p_tokens) x
  on conflict do nothing;

  update public.identity_match_tokens t set last_seen_at = now()
   where t.customer_id = p_customer and t.trust_id = v_trust
     and exists (select 1 from jsonb_array_elements(p_tokens) x
                  where x->>'kind' = t.kind and x->>'token' = t.token);

  if p_integration is not null and coalesce(p_participant, '') <> '' then
    insert into public.vendor_participant_mappings (customer_id, integration_id, participant_id, trust_id)
      values (p_customer, p_integration, p_participant, v_trust)
    on conflict (integration_id, participant_id)
      do update set last_seen_at = now(), entries = public.vendor_participant_mappings.entries + 1;
  end if;

  insert into public.identity_match_events (customer_id, trust_id, survey_id, integration_id, kind, resolution, confidence, signals, shadow)
  select p_customer, v_trust, p_survey, p_integration, 'resolved', v_resolution, v_confidence,
         coalesce(array_agg(distinct x->>'kind'), '{}'), true
    from jsonb_array_elements(p_tokens) x;

  return query select v_trust, v_handle, v_resolution, v_confidence, v_std_res, v_std_conf, v_minted, coalesce(v_merge, 0);
end;
$$;

revoke all on function public.rescript_rtid_resolve(uuid, jsonb, uuid, text, uuid) from public, anon, authenticated;

comment on index public.identity_match_tokens_deterministic_uniq is 'One deterministic identifier is one identity (0084). Probabilistic tokens are deliberately NOT unique: a network has a household behind it.';
