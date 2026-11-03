-- 0083 — The recruitment exchange, Phase 3: Respondent Trust ID and the participation ledger (2026-11-03).
--
-- 0072 made sure one panel id cannot enter one study twice. This makes sure one PERSON cannot — as far as the
-- available evidence allows, which is the whole difficulty and the reason this migration is written the way it is.
--
-- ## What can and cannot be known
--
-- The brief's §13 lists the deduplication signals as "same email, same verified phone, same authorized Trust ID,
-- same vendor participant ID". For Dynata, Cint, Toluna and PureSpectrum, three of those four are not obtainable:
-- the integration is a redirect carrying an opaque participant id, and the contracts prohibit re-identifying the
-- respondent. So this schema is built around a graded answer rather than a yes/no one:
--
--   deterministic   the same identifier was presented twice — the same vendor's participant id, or an identity
--                   this platform itself holds (an invitation list, our own panel, a verified phone)
--   probabilistic   different identifiers, but the device, network and behavioural evidence says one person
--   vendor_scoped   nothing links this arrival to anything outside the vendor it came from
--
-- Every match carries which of those it is, and nothing in this system is permitted to render a probabilistic
-- match as a certainty. A project's final report states what fraction of the sample was deduplicated at each
-- level rather than claiming "zero duplicates", because the second claim cannot be supported.
--
-- ## Keys and scope
--
--   respondent_trust_ids        the pseudonymous platform identity. ORGANISATION-SCOPED: a trust id never spans
--                               customers, so one client's respondents are never matched against another's.
--   identity_match_tokens       HMAC tokens derived under RTID_MATCH_KEY — never a raw e-mail, phone or id. RLS
--                               on with NO policy and no grant, the `panel_secrets` pattern: the service role
--                               behind the routes is the only reader.
--   vendor_participant_mappings one vendor's id for a person → that person's trust id.
--   participation_ledger        the authoritative record of who is in which project and in what state. The
--                               unique partial index is what makes a reservation ATOMIC: two vendors sending
--                               the same person at the same instant cannot both get in.
--   identity_match_events       every resolution and every duplicate, with its evidence and confidence, and
--                               whether it was ENFORCED or merely observed.
--
-- RTID_MATCH_KEY is deliberately a different key from QUALITY_HASH_SALT. The quality salt is per SURVEY, which
-- makes a device hash in one study incomparable with one in another — a real privacy property that exists on
-- purpose. Matching across projects needs that property relaxed, so it is relaxed narrowly, under its own key,
-- for organisations that have opted in, and the per-survey hashes in `responses` are left exactly as they are.
-- A match token is never written to `responses`, and a `responses` hash is never a match token.
--
-- SHADOW MODE. `recruitment_projects.dedupe_mode` starts at 'shadow': identities are resolved and the ledger is
-- written, duplicates are recorded with `would_block`, and NOBODY IS REFUSED. A deduplication system that starts
-- by turning away real respondents, with no measured false-positive rate, is a system that gets switched off in
-- week two. Enforcement is Phase 4 and is a per-project decision.
--
-- Re-runnable: `if not exists`, `drop … if exists` first, `create or replace`. Undo:
--   drop table if exists public.identity_match_events, public.participation_ledger,
--     public.vendor_participant_mappings, public.identity_match_tokens, public.respondent_trust_ids cascade;
--   alter table public.recruitment_projects drop column if exists dedupe_mode;

/* ------------------------------------------------------------ the identity */

create table if not exists public.respondent_trust_ids (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  -- the pseudonymous handle shown in a fraud review; carries no information about the person
  trust_id text not null check (trust_id ~ '^rtid_[a-z0-9]{16,40}$'),
  -- how this identity was arrived at. `vendor_scoped` is the honest default for panel traffic.
  resolution text not null default 'vendor_scoped'
    check (resolution in ('deterministic', 'probabilistic', 'vendor_scoped')),
  -- 0–100. Only a deterministic match may be 100, and the engine enforces that; the constraint says so too.
  confidence numeric(5,2) not null default 0 check (confidence >= 0 and confidence <= 100),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  participations integer not null default 0 check (participations >= 0),
  completions integer not null default 0 check (completions >= 0),
  rejections integer not null default 0 check (rejections >= 0),
  duplicates integer not null default 0 check (duplicates >= 0),
  -- maintained by the fraud engine in Phase 4; 0 until then, and never a reason to refuse on its own
  risk_score numeric(5,2) not null default 0 check (risk_score >= 0 and risk_score <= 100),
  status text not null default 'active' check (status in ('active', 'quarantined', 'blocked')),
  -- what this person consented to and when, for the lawful basis this registry depends on
  consent jsonb not null default '{}'::jsonb,
  -- retention: a trust id is deleted when this passes, with its tokens
  retention_until timestamptz,
  created_at timestamptz not null default now(),
  constraint respondent_trust_ids_confidence_matches_resolution
    check (resolution <> 'vendor_scoped' or confidence = 0)
);
create unique index if not exists respondent_trust_ids_uniq on public.respondent_trust_ids (customer_id, trust_id);
create index if not exists respondent_trust_ids_seen_idx on public.respondent_trust_ids (customer_id, last_seen_at desc);
create index if not exists respondent_trust_ids_retention_idx on public.respondent_trust_ids (retention_until) where retention_until is not null;

/* ------------------------------------------------------------ the match tokens */

create table if not exists public.identity_match_tokens (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  trust_id uuid not null references public.respondent_trust_ids(id) on delete cascade,
  -- what KIND of signal this is, which decides how much it is allowed to prove
  kind text not null check (kind in ('email', 'phone', 'external_id', 'vendor_pid', 'device', 'network', 'behaviour')),
  /*
   * The HMAC of the normalised value under RTID_MATCH_KEY. NEVER the value. There is no column on this table
   * that a raw e-mail address or telephone number could be put in, which is the point: the schema makes the
   * mistake impossible rather than forbidding it in a comment.
   */
  token text not null check (char_length(token) between 16 and 128),
  -- which key sealed it, so rotation can keep opening what the previous key wrote
  key_id text not null,
  -- a deterministic token may settle an identity on its own; a probabilistic one may only contribute evidence
  strength text not null check (strength in ('deterministic', 'probabilistic')),
  -- what this token may be used for. A token derived for deduplication is not a token for anything else.
  purpose text not null default 'dedupe' check (purpose in ('dedupe', 'fraud', 'reinstatement')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- a device or network token goes stale; an e-mail token does not. NULL = no expiry.
  expires_at timestamptz
);
-- one token per kind per organisation: presenting the same e-mail twice finds the same identity
create unique index if not exists identity_match_tokens_uniq on public.identity_match_tokens (customer_id, kind, token);
create index if not exists identity_match_tokens_trust_idx on public.identity_match_tokens (trust_id);

/* ------------------------------------------------------------ the vendor's own id */

create table if not exists public.vendor_participant_mappings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  integration_id uuid not null references public.vendor_integrations(id) on delete cascade,
  -- the vendor's identifier for this person, as it arrived on the link. Opaque to us and stored as given.
  participant_id text not null check (char_length(participant_id) between 1 and 200),
  trust_id uuid not null references public.respondent_trust_ids(id) on delete cascade,
  entries integer not null default 1 check (entries >= 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create unique index if not exists vendor_participant_mappings_uniq
  on public.vendor_participant_mappings (integration_id, participant_id);
create index if not exists vendor_participant_mappings_trust_idx on public.vendor_participant_mappings (trust_id);

/* ------------------------------------------------------------ the participation ledger */

create table if not exists public.participation_ledger (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  survey_id uuid not null references public.surveys(id) on delete cascade,
  trust_id uuid not null references public.respondent_trust_ids(id) on delete cascade,
  integration_id uuid references public.vendor_integrations(id) on delete set null,
  -- the brief's §14 states, exactly
  state text not null default 'reserved' check (state in
    ('invited', 'verification_pending', 'eligible', 'reserved', 'in_survey',
     'completed', 'rejected', 'duplicate', 'quarantined', 'expired')),
  /*
   * A reservation that never expires is a reservation that locks a person out of a study forever because their
   * browser crashed on the consent page. Everything non-terminal carries a deadline, and `rescript_rtid_sweep`
   * returns the expired ones to the pool.
   */
  reserved_at timestamptz not null default now(),
  expires_at timestamptz,
  session_ref text,
  response_id uuid,
  outcome text,
  -- true when this row exists only because shadow mode was on: it would have been refused, and was not
  shadow boolean not null default false,
  notes text,
  updated_at timestamptz not null default now()
);

/*
 * THE ATOMIC BIT. One LIVE participation per (survey, trust id) — where "live" is anything that is not a
 * terminal outcome and not a shadow observation. Two vendors sending the same person at the same instant
 * contend on this index, and exactly one wins; the other is told who holds it.
 *
 * `duplicate`, `rejected` and `expired` are deliberately outside the index: a person refused as a duplicate must
 * be recordable again if they come back, or the ledger would stop counting attempts after the first.
 */
create unique index if not exists participation_ledger_live_uniq
  on public.participation_ledger (survey_id, trust_id)
  where state in ('invited', 'verification_pending', 'eligible', 'reserved', 'in_survey', 'completed') and not shadow;

create index if not exists participation_ledger_survey_idx on public.participation_ledger (survey_id, state);
create index if not exists participation_ledger_trust_idx on public.participation_ledger (trust_id, reserved_at desc);
create index if not exists participation_ledger_expiry_idx on public.participation_ledger (expires_at)
  where expires_at is not null and state in ('reserved', 'verification_pending', 'in_survey');

/* ------------------------------------------------------------ the evidence trail */

create table if not exists public.identity_match_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  trust_id uuid references public.respondent_trust_ids(id) on delete set null,
  survey_id uuid references public.surveys(id) on delete cascade,
  integration_id uuid references public.vendor_integrations(id) on delete set null,
  kind text not null check (kind in ('resolved', 'minted', 'duplicate', 'merge_candidate', 'released', 'settled')),
  resolution text check (resolution is null or resolution in ('deterministic', 'probabilistic', 'vendor_scoped')),
  confidence numeric(5,2) check (confidence is null or (confidence >= 0 and confidence <= 100)),
  -- which kinds of signal contributed, for a reviewer who has to justify a refusal
  signals text[] not null default '{}',
  -- the reason codes and the arithmetic. Never a raw identifier.
  evidence jsonb not null default '{}'::jsonb,
  /*
   * Whether this was ENFORCED or only observed. The difference is the entire value of shadow mode: a count of
   * `would_block` events with `shadow = true` IS the false-positive exposure, measurable before anyone is
   * turned away.
   */
  shadow boolean not null default true,
  would_block boolean not null default false,
  occurred_at timestamptz not null default now()
);
create index if not exists identity_match_events_survey_idx on public.identity_match_events (survey_id, occurred_at desc);
create index if not exists identity_match_events_trust_idx on public.identity_match_events (trust_id, occurred_at desc);
create index if not exists identity_match_events_shadow_idx on public.identity_match_events (customer_id, shadow, would_block, occurred_at desc);

/* ------------------------------------------------------------ the project's setting */

alter table public.recruitment_projects
  -- shadow: resolve, record, refuse nobody. enforce: refuse duplicates. off: do not resolve at all.
  add column if not exists dedupe_mode text not null default 'shadow';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'recruitment_projects_dedupe_mode') then
    alter table public.recruitment_projects
      add constraint recruitment_projects_dedupe_mode check (dedupe_mode in ('off', 'shadow', 'enforce'));
  end if;
end $$;

/* ------------------------------------------------------------ row level security

   The tokens are the sensitive table and get the `panel_secrets` treatment: RLS on, NO policy, no grant. Nothing
   but the service role behind the routes reads them, and there is no column in them that a raw identifier could
   be in anyway. The rest is readable by the organisation's own members in the roles that handle fraud review. */

alter table public.respondent_trust_ids        enable row level security;
alter table public.identity_match_tokens       enable row level security;
alter table public.vendor_participant_mappings enable row level security;
alter table public.participation_ledger        enable row level security;
alter table public.identity_match_events       enable row level security;

drop policy if exists respondent_trust_ids_read on public.respondent_trust_ids;
create policy respondent_trust_ids_read on public.respondent_trust_ids for select to authenticated
  using (
    (customer_id = public.current_customer_id() and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists vendor_participant_mappings_read on public.vendor_participant_mappings;
create policy vendor_participant_mappings_read on public.vendor_participant_mappings for select to authenticated
  using (
    (customer_id = public.current_customer_id() and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists participation_ledger_read on public.participation_ledger;
create policy participation_ledger_read on public.participation_ledger for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) in
      ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists identity_match_events_read on public.identity_match_events;
create policy identity_match_events_read on public.identity_match_events for select to authenticated
  using (
    (customer_id = public.current_customer_id() and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

-- identity_match_tokens: RLS on, no policy — only the service role ever reads it

revoke all on public.respondent_trust_ids, public.identity_match_tokens, public.vendor_participant_mappings,
  public.participation_ledger, public.identity_match_events from anon;
revoke all on public.identity_match_tokens from authenticated;
grant select on public.respondent_trust_ids, public.vendor_participant_mappings,
  public.participation_ledger, public.identity_match_events to authenticated;

/* ------------------------------------------------------------ resolution

   How much a match is allowed to prove, in one place. These numbers are the subsystem's entire opinion about
   evidence and they are deliberately visible rather than buried in application code:

     a vendor's own participant id, or an identity this platform holds   DETERMINISTIC, 100
     one probabilistic signal agreeing (a device, say)                    PROBABILISTIC,  55
     two agreeing                                                         PROBABILISTIC,  75
     three agreeing                                                       PROBABILISTIC,  88
     nothing                                                              VENDOR_SCOPED,   0

   Probabilistic never reaches 100, at any number of signals. Two people in one household on one router sharing a
   family tablet produce three agreeing signals and are two people; no quantity of circumstantial evidence turns
   into proof, and a system that rounded 88 up to "certain" would be refusing them a day's work on a guess.     */

-- the RETURNS TABLE changed shape in development, and create-or-replace cannot change a function's result type
drop function if exists public.rescript_rtid_resolve(uuid, jsonb, uuid, text, uuid);
create or replace function public.rescript_rtid_resolve(
  p_customer uuid,
  -- [{kind, token, strength, expires_at}] — tokens only, never values
  p_tokens jsonb,
  p_integration uuid default null,
  p_participant text default null,
  p_survey uuid default null)
/*
 * Two different questions, so two different answers:
 *
 *   resolution / confidence                   how THIS ARRIVAL was linked to an identity
 *   identity_resolution / identity_confidence  how well that identity is known OVERALL
 *
 * They come apart constantly and the difference decides whether somebody may be refused. A person known
 * deterministically from Cint, arriving from Dynata and linked only by a shared device, is a PROBABILISTIC
 * match to a DETERMINISTIC identity. Reporting the identity's standing as the match's would turn circumstantial
 * evidence into proof at exactly the moment it matters — the brief's §13, "mark the participant as not fully
 * resolved rather than pretending to guarantee deduplication".
 */
returns table (
  trust_uuid uuid, trust_id text,
  resolution text, confidence numeric,
  identity_resolution text, identity_confidence numeric,
  minted boolean, merge_candidates integer)
language plpgsql security definer set search_path = public as $$
declare
  v_trust      uuid;
  v_handle     text;
  -- how this arrival matched
  v_resolution text := 'vendor_scoped';
  v_confidence numeric := 0;
  -- what the identity's standing is afterwards
  v_std_res    text;
  v_std_conf   numeric;
  v_minted     boolean := false;
  v_merge      integer := 0;
  v_kinds      integer;
  r            record;
begin
  -- 1. the vendor's own id for this person is deterministic within that vendor, and is the common case
  if p_integration is not null and coalesce(p_participant, '') <> '' then
    select m.trust_id into v_trust from public.vendor_participant_mappings m
      where m.integration_id = p_integration and m.participant_id = p_participant;
    if v_trust is not null then
      v_resolution := 'deterministic'; v_confidence := 100;
    end if;
  end if;

  -- 2. an identity this platform itself holds — an invitation list, our own panel, a verified phone
  if v_trust is null then
    -- uuid has no min() aggregate, so the oldest identity is chosen by its own first_seen_at
    select count(distinct t.trust_id) into v_merge
      from public.identity_match_tokens t
      join jsonb_array_elements(p_tokens) x on x->>'token' = t.token and x->>'kind' = t.kind
     where t.customer_id = p_customer
       and t.strength = 'deterministic'
       and (t.expires_at is null or t.expires_at > now());
    if coalesce(v_merge, 0) > 0 then
      select t.trust_id into v_trust
        from public.identity_match_tokens t
        join jsonb_array_elements(p_tokens) x on x->>'token' = t.token and x->>'kind' = t.kind
        join public.respondent_trust_ids rt on rt.id = t.trust_id
       where t.customer_id = p_customer
         and t.strength = 'deterministic'
         and (t.expires_at is null or t.expires_at > now())
       order by rt.first_seen_at, t.trust_id limit 1;
    end if;
    if v_trust is not null then
      v_resolution := 'deterministic'; v_confidence := 100;
      /*
       * Two trust ids answering to the same deterministic token are the same person seen twice. They are NOT
       * merged here: merging is destructive, it rewrites participation history, and doing it inside an admission
       * call that must answer in milliseconds is how a race corrupts a ledger. The candidate is recorded and a
       * human decides.
       */
      if v_merge > 1 then
        insert into public.identity_match_events (customer_id, trust_id, survey_id, integration_id, kind, resolution, confidence, signals, evidence, shadow)
        values (p_customer, v_trust, p_survey, p_integration, 'merge_candidate', 'deterministic', 100, '{}',
                jsonb_build_object('candidates', v_merge, 'note', 'several trust ids answer to one deterministic token'), true);
      end if;
    else
      v_merge := 0;
    end if;
  end if;

  -- 3. circumstantial agreement: device, network, behaviour
  if v_trust is null then
    select t.trust_id as hit, count(distinct t.kind) as kinds into r
      from public.identity_match_tokens t
      join jsonb_array_elements(p_tokens) x on x->>'token' = t.token and x->>'kind' = t.kind
     where t.customer_id = p_customer
       and t.strength = 'probabilistic'
       and (t.expires_at is null or t.expires_at > now())
     group by t.trust_id
     order by count(distinct t.kind) desc, t.trust_id
     limit 1;
    if r.hit is not null then
      v_kinds := r.kinds;
      v_trust := r.hit;
      v_resolution := 'probabilistic';
      v_confidence := case when v_kinds >= 3 then 88 when v_kinds = 2 then 75 else 55 end;
    end if;
  end if;

  -- 4. nobody we have seen: a new identity, scoped to the vendor it arrived from and claiming nothing more
  if v_trust is null then
    v_handle := 'rtid_' || encode(gen_random_bytes(12), 'hex');
    insert into public.respondent_trust_ids (customer_id, trust_id, resolution, confidence)
      values (p_customer, v_handle, 'vendor_scoped', 0)
      returning id into v_trust;
    v_minted := true;
    insert into public.identity_match_events (customer_id, trust_id, survey_id, integration_id, kind, resolution, confidence, shadow)
      values (p_customer, v_trust, p_survey, p_integration, 'minted', 'vendor_scoped', 0, true);
  else
    /*
     * `resolution` and `confidence` are both columns here AND names in this function's RETURNS TABLE, so every
     * read of them is qualified: an unqualified one is ambiguous and Postgres refuses the whole function.
     */
    update public.respondent_trust_ids rt
       set last_seen_at = now(),
           -- an identity only ever gets MORE certain; a weaker later match never downgrades a settled one
           resolution = case
             when rt.resolution = 'deterministic' then 'deterministic'
             when v_resolution = 'deterministic' then 'deterministic'
             when rt.resolution = 'probabilistic' or v_resolution = 'probabilistic' then 'probabilistic'
             else 'vendor_scoped' end,
           confidence = greatest(rt.confidence, v_confidence)
     where rt.id = v_trust;
  end if;

  -- the identity's standing, read back AFTER any strengthening above. It never overwrites this arrival's match.
  select rt.trust_id, rt.resolution, rt.confidence into v_handle, v_std_res, v_std_conf
    from public.respondent_trust_ids rt where rt.id = v_trust;

  -- 5. remember every token presented, so the next arrival resolves rather than minting again
  insert into public.identity_match_tokens (customer_id, trust_id, kind, token, key_id, strength, expires_at)
  select p_customer, v_trust, x->>'kind', x->>'token', coalesce(x->>'key_id', 'k1'), x->>'strength',
         nullif(x->>'expires_at', '')::timestamptz
    from jsonb_array_elements(p_tokens) x
  on conflict (customer_id, kind, token) do update set last_seen_at = now();

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
  -- note: the event stores THIS ARRIVAL's match, not the identity's standing — a reviewer justifying a refusal
  -- needs to know what linked this person on this occasion.

  return query select v_trust, v_handle, v_resolution, v_confidence, v_std_res, v_std_conf, v_minted, coalesce(v_merge, 0);
end;
$$;

/**
 * Reserve this person's place in this project, atomically.
 *
 * The unique partial index does the work: two vendors sending the same person at the same instant contend on it
 * and exactly one wins. The loser is told the state of the row that holds it, which is what lets the caller
 * answer "already completed" rather than a bare "no".
 *
 * `p_mode` decides what happens to the loser:
 *   enforce  reserved = false, would_block = true — the caller refuses the arrival
 *   shadow   a SHADOW row is written (outside the index), reserved = true, would_block = true — the arrival is
 *            admitted and the fact that it would have been refused is recorded. Counting these IS the
 *            false-positive exposure, measured before anybody is turned away.
 *   off      no ledger row at all
 */
create or replace function public.rescript_rtid_reserve(
  p_customer uuid, p_survey uuid, p_trust uuid,
  p_integration uuid default null, p_mode text default 'shadow', p_ttl_seconds integer default 3600)
returns table (reserved boolean, ledger_id uuid, state text, would_block boolean, held_state text, held_since timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid;
  v_held  record;
  v_ttl   interval := make_interval(secs => greatest(coalesce(p_ttl_seconds, 3600), 60));
begin
  if p_mode = 'off' then
    return query select true, null::uuid, 'eligible'::text, false, null::text, null::timestamptz;
    return;
  end if;

  insert into public.participation_ledger (customer_id, survey_id, trust_id, integration_id, state, expires_at, shadow)
    values (p_customer, p_survey, p_trust, p_integration, 'reserved', now() + v_ttl, false)
  on conflict do nothing
  returning id into v_id;

  if v_id is not null then
    update public.respondent_trust_ids set participations = participations + 1, last_seen_at = now() where id = p_trust;
    return query select true, v_id, 'reserved'::text, false, null::text, null::timestamptz;
    return;
  end if;

  -- somebody already holds this person's place in this project
  select l.state, l.reserved_at into v_held
    from public.participation_ledger l
   where l.survey_id = p_survey and l.trust_id = p_trust and not l.shadow
     and l.state in ('invited', 'verification_pending', 'eligible', 'reserved', 'in_survey', 'completed')
   order by l.reserved_at limit 1;

  update public.respondent_trust_ids set duplicates = duplicates + 1, last_seen_at = now() where id = p_trust;

  insert into public.identity_match_events (customer_id, trust_id, survey_id, integration_id, kind, shadow, would_block, evidence)
    values (p_customer, p_trust, p_survey, p_integration, 'duplicate', p_mode = 'shadow', true,
            jsonb_build_object('held_state', v_held.state, 'held_since', v_held.reserved_at));

  if p_mode = 'shadow' then
    insert into public.participation_ledger (customer_id, survey_id, trust_id, integration_id, state, expires_at, shadow, notes)
      values (p_customer, p_survey, p_trust, p_integration, 'reserved', now() + v_ttl, true,
              'shadow: would have been refused as a duplicate of a ' || coalesce(v_held.state, 'live') || ' participation')
      returning id into v_id;
    return query select true, v_id, 'reserved'::text, true, v_held.state, v_held.reserved_at;
    return;
  end if;

  return query select false, null::uuid, 'duplicate'::text, true, v_held.state, v_held.reserved_at;
end;
$$;

/** Move a participation to its outcome. Idempotent: settling an already-terminal row changes nothing. */
create or replace function public.rescript_rtid_settle(
  p_ledger uuid, p_state text, p_response uuid default null, p_outcome text default null, p_session text default null)
returns table (settled boolean, state text)
language plpgsql security definer set search_path = public as $$
declare v_row record;
begin
  select * into v_row from public.participation_ledger where id = p_ledger for update;
  if not found then
    raise exception 'participation % does not exist', p_ledger using errcode = 'no_data_found';
  end if;
  if v_row.state in ('completed', 'rejected', 'duplicate', 'expired') then
    return query select false, v_row.state;
    return;
  end if;

  update public.participation_ledger
     set state = p_state, response_id = coalesce(p_response, response_id),
         outcome = coalesce(p_outcome, outcome), session_ref = coalesce(p_session, session_ref),
         expires_at = case when p_state in ('completed', 'rejected', 'duplicate', 'expired') then null else expires_at end,
         updated_at = now()
   where id = p_ledger;

  -- a shadow row is an observation and must never move the counters a real participation moves
  if not v_row.shadow then
    if p_state = 'completed' then
      update public.respondent_trust_ids set completions = completions + 1, last_seen_at = now() where id = v_row.trust_id;
    elsif p_state = 'rejected' then
      update public.respondent_trust_ids set rejections = rejections + 1, last_seen_at = now() where id = v_row.trust_id;
    end if;
  end if;

  insert into public.identity_match_events (customer_id, trust_id, survey_id, integration_id, kind, shadow, evidence)
    values (v_row.customer_id, v_row.trust_id, v_row.survey_id, v_row.integration_id, 'settled', v_row.shadow,
            jsonb_build_object('from', v_row.state, 'to', p_state, 'outcome', p_outcome));

  return query select true, p_state;
end;
$$;

/**
 * Return expired reservations to the pool.
 *
 * Without this, a respondent whose browser died on the consent page holds their own place in the study forever
 * and is refused as a duplicate of themselves — the most infuriating possible failure, and invisible unless
 * somebody is looking for it.
 */
create or replace function public.rescript_rtid_sweep(p_limit integer default 1000)
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  with stale as (
    select id from public.participation_ledger
     where expires_at is not null and expires_at < now()
       and state in ('reserved', 'verification_pending', 'in_survey')
     order by expires_at limit greatest(coalesce(p_limit, 1000), 1)
     for update skip locked
  )
  update public.participation_ledger l set state = 'expired', expires_at = null, updated_at = now()
    from stale where l.id = stale.id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.rescript_rtid_resolve(uuid, jsonb, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.rescript_rtid_reserve(uuid, uuid, uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.rescript_rtid_settle(uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.rescript_rtid_sweep(integer) from public, anon, authenticated;

comment on table public.respondent_trust_ids is 'The pseudonymous platform identity (0083), organisation-scoped. `resolution` says how much the match is allowed to prove; probabilistic never reaches 100.';
comment on table public.identity_match_tokens is 'HMAC match tokens under RTID_MATCH_KEY (0083). Never a raw identifier — there is no column for one. RLS on, no policy: the service role only.';
comment on table public.participation_ledger is 'Who is in which project and in what state (0083). The unique partial index makes reservation atomic; shadow rows sit outside it and refuse nobody.';
