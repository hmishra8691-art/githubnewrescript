-- 0085 — The recruitment exchange, Phase 5: the fraud network graph, vendor quality, forecasts (2026-11-03).
--
-- 0084 scores one arrival on what can be seen about it. This adds the questions that can only be asked across
-- MANY arrivals: is this a ring rather than a person, is this vendor actually any good, and is this project
-- going to finish on time and on budget.
--
--   fraud_network_clusters  a group of identities linked by shared signals. The brief's §19: the unit of
--                           organised fraud is the network, not the respondent, and a reviewer who is shown
--                           forty separate cases has to reconstruct the ring themselves. One cluster is ONE
--                           case, naming its members, with the graph evidence attached.
--   vendor_quality_metrics  what a vendor's traffic has actually been worth, from real outcomes, WITH THE
--                           SAMPLE SIZE AND AN INTERVAL. A rejection rate of 20% over five completes and over
--                           five thousand are different claims, and a column holding only the point estimate
--                           cannot tell them apart.
--   recruitment_forecasts   projected completion and final cost, with the basis they were computed from and a
--                           reason when there is not enough history to project anything at all.
--   model_evaluations       precision, recall and the false-positive rate of the fraud rules over CONFIRMED
--                           outcomes — resolved cases, not suspicions. With no resolved cases this reports
--                           `insufficient` and no numbers, which is the honest state today.
--
-- ## What a cluster is not allowed to do
--
-- Nothing here refuses or blocks anybody. A detected cluster opens one case, holds its members' completes from
-- billing, and waits for a human. The brief's §19 asks the system to "identify suspicious networks"; it does
-- not ask it to act on them unsupervised, and the false-positive rate of this graph on real traffic is
-- unmeasured like everything else in this subsystem.
--
-- Re-runnable: `if not exists`, `drop … if exists` first, `create or replace`. Undo:
--   drop table if exists public.model_evaluations, public.recruitment_forecasts, public.vendor_quality_metrics,
--     public.fraud_network_clusters cascade;
--   alter table public.fraud_cases drop column if exists cluster_id;

/* ------------------------------------------------------------ the graph's output */

create table if not exists public.fraud_network_clusters (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  survey_id uuid references public.surveys(id) on delete cascade,
  /* a stable fingerprint of the member set, so re-running the pass updates a cluster rather than duplicating it */
  signature text not null check (char_length(signature) between 16 and 128),
  members uuid[] not null default '{}',
  member_count integer not null default 0 check (member_count >= 0),
  /*
   * The ratio that distinguishes a household from a click farm. Four people sharing two tablets is 2.0 and
   * ordinary; forty identities sharing six devices is 6.7 and is not. Size alone says nothing — a popular
   * mobile carrier puts thousands of unrelated people behind one address.
   */
  devices integer not null default 0 check (devices >= 0),
  networks integer not null default 0 check (networks >= 0),
  identities_per_device numeric(8,2),
  /* 0–100, from packages/quality/src/cluster.ts. Never a verdict on its own. */
  score numeric(5,2) not null default 0 check (score >= 0 and score <= 100),
  /* which signals linked the members, and the arithmetic, for the reviewer who has to justify holding them */
  signals text[] not null default '{}',
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'cleared', 'upheld', 'stale')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  detected_by text not null default 'graph'
);
create unique index if not exists fraud_network_clusters_uniq on public.fraud_network_clusters (customer_id, signature);
create index if not exists fraud_network_clusters_queue_idx on public.fraud_network_clusters (customer_id, status, score desc);
create index if not exists fraud_network_clusters_members_idx on public.fraud_network_clusters using gin (members);

alter table public.fraud_cases
  add column if not exists cluster_id uuid references public.fraud_network_clusters(id) on delete set null;
create index if not exists fraud_cases_cluster_idx on public.fraud_cases (cluster_id) where cluster_id is not null;

/* ------------------------------------------------------------ what a vendor is actually worth */

create table if not exists public.vendor_quality_metrics (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  integration_id uuid not null references public.vendor_integrations(id) on delete cascade,
  /* NULL = across every market; a code = that market only */
  market text check (market is null or market ~ '^[A-Z]{2}$'),
  /* the window these figures cover, because "this vendor's rejection rate" with no window is meaningless */
  window_days integer not null default 90 check (window_days > 0),

  completes integer not null default 0 check (completes >= 0),
  accepted integer not null default 0 check (accepted >= 0),
  rejected integer not null default 0 check (rejected >= 0),
  duplicates integer not null default 0 check (duplicates >= 0),
  screenouts integer not null default 0 check (screenouts >= 0),
  fraud_cases integer not null default 0 check (fraud_cases >= 0),

  /*
   * The point estimate AND the bounds. A 20% rejection rate over five completes and over five thousand are
   * different claims; ranking on the point estimate treats them as the same, which is how a vendor wins 40% of
   * a project on one lucky week. The optimiser ranks on the pessimistic bound (Phase 2's rule).
   */
  rejection_rate numeric(5,2) check (rejection_rate is null or (rejection_rate >= 0 and rejection_rate <= 100)),
  rejection_low numeric(5,2),
  rejection_high numeric(5,2),
  duplicate_rate numeric(5,2) check (duplicate_rate is null or (duplicate_rate >= 0 and duplicate_rate <= 100)),
  incidence numeric(5,2) check (incidence is null or (incidence >= 0 and incidence <= 100)),
  median_delivery_days numeric(8,2),
  /* actual against quoted, the brief's §24 */
  actual_cpi numeric(10,4),
  quoted_cpi numeric(10,4),
  /* 0–100. NULL when there is not enough history to say anything, which is not the same as zero. */
  quality_score numeric(5,2) check (quality_score is null or (quality_score >= 0 and quality_score <= 100)),
  confidence text not null default 'none' check (confidence in ('none', 'low', 'medium', 'high')),
  computed_at timestamptz not null default now()
);
create unique index if not exists vendor_quality_metrics_uniq
  on public.vendor_quality_metrics (integration_id, coalesce(market, '--'), window_days);
create index if not exists vendor_quality_metrics_customer_idx on public.vendor_quality_metrics (customer_id, computed_at desc);

/* ------------------------------------------------------------ forecasts */

create table if not exists public.recruitment_forecasts (
  id uuid primary key default gen_random_uuid(),
  recruitment_project_id uuid not null references public.recruitment_projects(id) on delete cascade,
  market text check (market is null or market ~ '^([A-Z]{2}|--)$'),
  /* what the projection says, when it can say anything */
  projected_completion timestamptz,
  projected_final_cost numeric(14,2),
  projected_valid_completes integer,
  completes_per_day numeric(10,2),
  /*
   * A projection the data does not support is not made. `basis` says what it rested on, and `insufficient_reason`
   * says why there is nothing — "4 completes over 2 hours" is a real answer and a forecast from it is not.
   */
  basis jsonb not null default '{}'::jsonb,
  insufficient_reason text,
  computed_at timestamptz not null default now()
);
create index if not exists recruitment_forecasts_project_idx on public.recruitment_forecasts (recruitment_project_id, computed_at desc);

/* ------------------------------------------------------------ do the rules actually work */

create table if not exists public.model_evaluations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  /* which rule, or NULL for the admission scorer as a whole */
  rule_id text,
  window_days integer not null default 90 check (window_days > 0),
  /*
   * Over CONFIRMED outcomes only: an upheld case is a true positive, a cleared one is a false positive. A
   * suspicion is neither, and counting suspicions as fraud is how a detector grades its own homework.
   */
  true_positives integer not null default 0 check (true_positives >= 0),
  false_positives integer not null default 0 check (false_positives >= 0),
  /* a respondent admitted and later rejected on their answers is a miss this layer could have caught */
  false_negatives integer not null default 0 check (false_negatives >= 0),
  precision numeric(5,4),
  recall numeric(5,4),
  false_positive_rate numeric(5,4),
  /* `insufficient` until enough cases have actually been resolved. It is the honest state today. */
  status text not null default 'insufficient' check (status in ('insufficient', 'computed')),
  resolved_cases integer not null default 0 check (resolved_cases >= 0),
  note text,
  computed_at timestamptz not null default now()
);
create unique index if not exists model_evaluations_uniq
  on public.model_evaluations (customer_id, coalesce(rule_id, '*'), window_days);

/* ------------------------------------------------------------ row level security */

alter table public.fraud_network_clusters enable row level security;
alter table public.vendor_quality_metrics enable row level security;
alter table public.recruitment_forecasts  enable row level security;
alter table public.model_evaluations      enable row level security;

drop policy if exists fraud_network_clusters_read on public.fraud_network_clusters;
create policy fraud_network_clusters_read on public.fraud_network_clusters for select to authenticated
  using (
    (customer_id = public.current_customer_id() and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists vendor_quality_metrics_read on public.vendor_quality_metrics;
create policy vendor_quality_metrics_read on public.vendor_quality_metrics for select to authenticated
  using (
    (customer_id = public.current_customer_id() and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists model_evaluations_read on public.model_evaluations;
create policy model_evaluations_read on public.model_evaluations for select to authenticated
  using (
    (customer_id = public.current_customer_id() and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists recruitment_forecasts_read on public.recruitment_forecasts;
create policy recruitment_forecasts_read on public.recruitment_forecasts for select to authenticated
  using (
    (public.rescript_recruitment_project_customer(recruitment_project_id) = public.current_customer_id()
      and public."current_role"() in ('platform_admin', 'programmer', 'researcher'))
    or public.rescript_is_platform_admin(auth.uid())
  );

revoke all on public.fraud_network_clusters, public.vendor_quality_metrics,
  public.recruitment_forecasts, public.model_evaluations from anon;
grant select on public.fraud_network_clusters, public.vendor_quality_metrics,
  public.recruitment_forecasts, public.model_evaluations to authenticated;

/* ------------------------------------------------------------ a cluster is ONE case

   The brief's §19: the unit of organised fraud is the network. A reviewer shown forty separate cases has to
   reconstruct the ring themselves, which is exactly the work the graph was built to do for them. So a cluster
   opens ONE case naming all its members, and re-running the pass updates it rather than opening another.    */

create or replace function public.rescript_cluster_upsert(
  p_customer uuid, p_signature text, p_members uuid[], p_devices integer, p_networks integer,
  p_score numeric, p_signals text[], p_evidence jsonb,
  p_survey uuid default null, p_open_case boolean default false)
returns table (cluster_id uuid, case_id uuid, created boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_cluster uuid;
  v_case    uuid;
  v_created boolean := false;
  v_count   integer := coalesce(array_length(p_members, 1), 0);
  v_ratio   numeric := case when coalesce(p_devices, 0) > 0 then round(v_count::numeric / p_devices, 2) else null end;
begin
  insert into public.fraud_network_clusters (customer_id, survey_id, signature, members, member_count,
    devices, networks, identities_per_device, score, signals, evidence)
  values (p_customer, p_survey, p_signature, coalesce(p_members, '{}'), v_count,
    coalesce(p_devices, 0), coalesce(p_networks, 0), v_ratio, coalesce(p_score, 0),
    coalesce(p_signals, '{}'), coalesce(p_evidence, '{}'::jsonb))
  on conflict (customer_id, signature) do update
    set members = excluded.members, member_count = excluded.member_count,
        devices = excluded.devices, networks = excluded.networks,
        identities_per_device = excluded.identities_per_device,
        score = excluded.score, signals = excluded.signals, evidence = excluded.evidence,
        last_seen_at = now(),
        -- a cluster a human already judged stays judged; the pass refreshes its facts, not its verdict
        status = public.fraud_network_clusters.status
  returning id, (xmax = 0) into v_cluster, v_created;

  if coalesce(p_open_case, false) then
    /*
     * ALIASED. `cluster_id` is also this function's first OUT parameter, so an unqualified reference here is
     * ambiguous and PostgreSQL refuses the whole call — which means the graph would open a case for a ring and
     * then fail before returning, every time.
     */
    select fc.id into v_case from public.fraud_cases fc
      where fc.cluster_id = v_cluster and fc.status in ('open', 'appealed') limit 1;
    if v_case is null then
      insert into public.fraud_cases (customer_id, survey_id, cluster_id, kind, risk_score, reasons, evidence)
      values (p_customer, p_survey, v_cluster, 'vendor_pattern', coalesce(p_score, 0),
              coalesce(p_signals, '{}'),
              coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object('members', v_count, 'devices', p_devices))
      returning id into v_case;
    else
      update public.fraud_cases
         set risk_score = coalesce(p_score, risk_score),
             evidence = coalesce(p_evidence, evidence) || jsonb_build_object('members', v_count, 'devices', p_devices)
       where id = v_case;
    end if;

    /*
     * Every member's completes are held from billing until the ring is judged. The identities are NOT
     * quarantined: that would block them from other studies on a detector whose false-positive rate nobody
     * has measured, and the first mistake would take out forty people at once.
     */
    update public.respondent_trust_ids rt
       set risk_score = greatest(rt.risk_score, coalesce(p_score, 0)), last_seen_at = now()
     where rt.id = any (p_members);
  end if;

  return query select v_cluster, v_case, v_created;
end;
$$;

/* ------------------------------------------------------------ what a vendor is worth

   From REAL outcomes — the orders placed and what came back — over a window, with the sample size and a Wilson
   interval beside every rate. The optimiser already ranks on the pessimistic bound (Phase 2); this is what
   gives it a bound to rank on instead of a point estimate pretending to be one.                             */

create or replace function public.rescript_vendor_quality_recompute(
  p_customer uuid, p_window_days integer default 90)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_rows integer := 0;
  z      numeric := 1.96;   -- 95%
  r      record;
  n      numeric;
  p      numeric;
  denom  numeric;
  centre numeric;
  margin numeric;
begin
  for r in
    select o.integration_id,
           sum(o.delivered_completes)  as delivered,
           sum(o.accepted_completes)   as accepted,
           sum(o.rejected_completes)   as rejected,
           sum(o.duplicate_attempts)   as duplicates,
           sum(o.spend_amount)         as spend,
           avg(o.agreed_cpi)           as quoted
      from public.recruitment_orders o
      join public.recruitment_projects pr on pr.id = o.recruitment_project_id
     where pr.customer_id = p_customer
       and o.placed_at is not null
       and o.placed_at > now() - make_interval(days => greatest(coalesce(p_window_days, 90), 1))
     group by o.integration_id
  loop
    n := nullif(r.delivered, 0);
    p := case when n is null then null else r.rejected::numeric / n end;

    if n is null or p is null then
      centre := null; margin := null;
    else
      denom  := 1 + (z * z) / n;
      centre := (p + (z * z) / (2 * n)) / denom;
      margin := (z / denom) * sqrt(p * (1 - p) / n + (z * z) / (4 * n * n));
    end if;

    insert into public.vendor_quality_metrics (customer_id, integration_id, market, window_days,
      completes, accepted, rejected, duplicates,
      rejection_rate, rejection_low, rejection_high, duplicate_rate,
      actual_cpi, quoted_cpi, quality_score, confidence, computed_at)
    values (p_customer, r.integration_id, null, greatest(coalesce(p_window_days, 90), 1),
      coalesce(r.delivered, 0), coalesce(r.accepted, 0), coalesce(r.rejected, 0), coalesce(r.duplicates, 0),
      case when p is null then null else round(p * 100, 2) end,
      case when margin is null then null else round(greatest(0, centre - margin) * 100, 2) end,
      case when margin is null then null else round(least(1, centre + margin) * 100, 2) end,
      case when coalesce(r.delivered, 0) + coalesce(r.duplicates, 0) = 0 then null
           else round(r.duplicates::numeric / (r.delivered + r.duplicates) * 100, 2) end,
      case when coalesce(r.accepted, 0) = 0 then null else round(r.spend / r.accepted, 4) end,
      round(coalesce(r.quoted, 0), 4),
      /*
       * A quality score is withheld entirely below 50 accepted completes. NULL is not zero: a vendor nobody
       * has used yet is unknown, and rendering that as a bad score would bury every new relationship.
       */
      case when coalesce(r.accepted, 0) < 50 then null
           else round(greatest(0, 100 - coalesce(p, 0) * 100 * 2), 2) end,
      case when coalesce(r.accepted, 0) >= 1000 then 'high'
           when coalesce(r.accepted, 0) >= 300  then 'medium'
           when coalesce(r.accepted, 0) >= 50   then 'low'
           else 'none' end,
      now())
    on conflict (integration_id, coalesce(market, '--'), window_days) do update
      set completes = excluded.completes, accepted = excluded.accepted, rejected = excluded.rejected,
          duplicates = excluded.duplicates, rejection_rate = excluded.rejection_rate,
          rejection_low = excluded.rejection_low, rejection_high = excluded.rejection_high,
          duplicate_rate = excluded.duplicate_rate, actual_cpi = excluded.actual_cpi,
          quoted_cpi = excluded.quoted_cpi, quality_score = excluded.quality_score,
          confidence = excluded.confidence, computed_at = now();
    v_rows := v_rows + 1;
  end loop;

  return v_rows;
end;
$$;

/* ------------------------------------------------------------ do the rules actually work

   Over CONFIRMED outcomes only. An upheld case is a true positive; a cleared one is a false positive. A
   suspicion is neither — counting suspicions as fraud is a detector grading its own homework, and it is how
   every fraud system reports 99% accuracy right up until somebody checks.                                   */

create or replace function public.rescript_model_evaluate(
  p_customer uuid, p_window_days integer default 90)
returns table (status text, resolved integer, "precision" numeric, false_positive_rate numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_tp integer; v_fp integer; v_total integer; v_prec numeric; v_fpr numeric; v_status text;
begin
  select count(*) filter (where fc.status = 'upheld'),
         count(*) filter (where fc.status = 'cleared'),
         count(*) filter (where fc.status in ('upheld', 'cleared'))
    into v_tp, v_fp, v_total
    from public.fraud_cases fc
   where fc.customer_id = p_customer
     and fc.resolved_at is not null
     and fc.resolved_at > now() - make_interval(days => greatest(coalesce(p_window_days, 90), 1));

  /*
   * Thirty resolved cases is the floor. Below it precision is a number computed from noise, and publishing it
   * would let somebody tune thresholds against four decisions.
   */
  if coalesce(v_total, 0) < 30 then
    v_status := 'insufficient'; v_prec := null; v_fpr := null;
  else
    v_status := 'computed';
    v_prec := round(v_tp::numeric / v_total, 4);
    v_fpr  := round(v_fp::numeric / v_total, 4);
  end if;

  insert into public.model_evaluations (customer_id, rule_id, window_days, true_positives, false_positives,
    "precision", false_positive_rate, status, resolved_cases, note, computed_at)
  values (p_customer, null, greatest(coalesce(p_window_days, 90), 1), coalesce(v_tp, 0), coalesce(v_fp, 0),
    v_prec, v_fpr, v_status, coalesce(v_total, 0),
    case when v_status = 'insufficient'
         then format('%s resolved cases in the window; at least 30 are needed before precision means anything', coalesce(v_total, 0))
         else null end,
    now())
  on conflict (customer_id, coalesce(rule_id, '*'), window_days) do update
    set true_positives = excluded.true_positives, false_positives = excluded.false_positives,
        "precision" = excluded."precision", false_positive_rate = excluded.false_positive_rate,
        status = excluded.status, resolved_cases = excluded.resolved_cases,
        note = excluded.note, computed_at = now();

  return query select v_status, coalesce(v_total, 0), v_prec, v_fpr;
end;
$$;

revoke all on function public.rescript_cluster_upsert(uuid, text, uuid[], integer, integer, numeric, text[], jsonb, uuid, boolean) from public, anon, authenticated;
revoke all on function public.rescript_vendor_quality_recompute(uuid, integer) from public, anon, authenticated;
revoke all on function public.rescript_model_evaluate(uuid, integer) from public, anon, authenticated;

comment on table public.fraud_network_clusters is 'Groups of identities linked by shared signals (0085). One cluster is one case: the unit of organised fraud is the network, not the respondent.';
comment on table public.vendor_quality_metrics is 'What a vendor''s traffic has actually been worth (0085), with the sample size and a Wilson interval. A NULL quality_score means unknown, not bad.';
comment on table public.model_evaluations is 'Precision and false-positive rate of the fraud rules over RESOLVED cases only (0085). `insufficient` until at least 30 have been judged.';
