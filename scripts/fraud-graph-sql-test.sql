-- THE FRAUD GRAPH, VENDOR QUALITY AND MODEL EVALUATION (migration 0085).
--
--   psql "$DB" -v ON_ERROR_STOP=1 -f scripts/fraud-graph-sql-test.sql
--
-- One transaction, rolled back at the end: the assertions run against real tables and real functions but leave
-- nothing behind. Each check raises `PASS n …` or aborts.
--
-- What it is actually testing is a set of REFUSALS — the places where this subsystem declines to produce a
-- number it cannot support. A test suite that only checked the happy path would pass against a version that
-- scored every new vendor at zero and reported 100% precision over four decisions.

begin;

\set cust  '''d0000000-0000-0000-0000-0000000000d1'''
\set usr   '''d00000d1-0000-0000-0000-000000000001'''
\set srv   '''d0000000-0000-0000-0000-0000000001d1'''
\set vend  '''d0000000-0000-0000-0000-0000000002d1'''
\set integ '''d0000000-0000-0000-0000-0000000003d1'''
\set proj  '''d0000000-0000-0000-0000-0000000004d1'''

insert into auth.users (id, email) values (:usr, 'fraud-graph@example.test');
insert into public.customers (id, slug, name) values (:cust, 'fraud-graph', 'Fraud graph');
-- a trigger on auth.users already made the profile row; this gives it this organisation and role
insert into public.profiles (id, customer_id, email, full_name, role)
  values (:usr, :cust, 'fraud-graph@example.test', 'Reviewer', 'researcher')
  on conflict (id) do update set customer_id = excluded.customer_id, role = excluded.role;
insert into public.surveys (id, customer_id, code, title, owner_id)
  values (:srv, :cust, 'FGRAPH', 'Fraud graph', :usr);
insert into public.panel_vendors (id, name, slug, customer_id, status)
  values (:vend, 'Test vendor', 'test-vendor-fg', :cust, 'catalogue');
insert into public.vendor_integrations (id, customer_id, vendor_id, mode, enabled)
  values (:integ, :cust, :vend, 'manual', true);
insert into public.recruitment_projects (id, customer_id, survey_id, required_completes, budget_amount, budget_currency, status)
  values (:proj, :cust, :srv, 1000, 10000, 'GBP', 'fielding');

-- eight identities for the ring
do $$
declare i integer;
begin
  for i in 1..8 loop
    insert into public.respondent_trust_ids (id, customer_id, trust_id)
    values (('d00000d1-0000-0000-0000-00000000000' || i)::uuid, 'd0000000-0000-0000-0000-0000000000d1',
            'rtid_fgraph' || lpad(i::text, 10, '0'));
  end loop;
end $$;

/* ============================================================ 1. a ring is ONE case */

do $$
declare v record; v_members uuid[];
begin
  select array_agg(id order by trust_id) into v_members from public.respondent_trust_ids
   where customer_id = 'd0000000-0000-0000-0000-0000000000d1';

  select * into v from public.rescript_cluster_upsert(
    'd0000000-0000-0000-0000-0000000000d1', 'sig_eight_on_one_device_aaaa', v_members, 1, 1,
    67.0, array['device'], '{"ratio": 8}'::jsonb, null, true);

  if v.case_id is null then raise exception 'a detected ring opened no case'; end if;
  if not v.created then raise exception 'the first upsert did not create the cluster'; end if;
  raise notice 'PASS 1  eight identities on one device → one cluster, one case';
end $$;

/* ============================================================ 2. re-running updates, never duplicates */

do $$
declare v record; v_members uuid[]; v_clusters integer; v_cases integer;
begin
  select array_agg(id order by trust_id) into v_members from public.respondent_trust_ids
   where customer_id = 'd0000000-0000-0000-0000-0000000000d1';

  -- the hourly pass runs again over the same ring, with a refreshed score
  select * into v from public.rescript_cluster_upsert(
    'd0000000-0000-0000-0000-0000000000d1', 'sig_eight_on_one_device_aaaa', v_members, 1, 2,
    72.0, array['device','network'], '{"ratio": 8}'::jsonb, null, true);

  if v.created then raise exception 'the second pass created a second cluster for the same ring'; end if;

  select count(*) into v_clusters from public.fraud_network_clusters
   where customer_id = 'd0000000-0000-0000-0000-0000000000d1';
  select count(*) into v_cases from public.fraud_cases
   where customer_id = 'd0000000-0000-0000-0000-0000000000d1';

  if v_clusters <> 1 then raise exception 'expected 1 cluster, found %', v_clusters; end if;
  if v_cases <> 1 then raise exception 'expected 1 case after two passes, found % — a reviewer would see the same ring twice', v_cases; end if;

  if (select score from public.fraud_network_clusters where signature = 'sig_eight_on_one_device_aaaa') <> 72.0 then
    raise exception 'the second pass did not refresh the score';
  end if;
  raise notice 'PASS 2  running the pass twice updates the ring; it does not open a second case';
end $$;

/* ============================================================ 3. a human verdict survives the next pass */

do $$
declare v_members uuid[]; v_status text;
begin
  update public.fraud_network_clusters set status = 'cleared'
   where signature = 'sig_eight_on_one_device_aaaa';

  select array_agg(id order by trust_id) into v_members from public.respondent_trust_ids
   where customer_id = 'd0000000-0000-0000-0000-0000000000d1';
  perform public.rescript_cluster_upsert(
    'd0000000-0000-0000-0000-0000000000d1', 'sig_eight_on_one_device_aaaa', v_members, 1, 2,
    91.0, array['device'], '{"ratio": 8}'::jsonb, null, true);

  select status into v_status from public.fraud_network_clusters where signature = 'sig_eight_on_one_device_aaaa';
  if v_status <> 'cleared' then
    raise exception 'the pass re-opened a ring a human had cleared (status %) — the reviewer would have to clear it every hour', v_status;
  end if;
  raise notice 'PASS 3  the pass refreshes a judged ring''s facts and leaves its verdict alone';
end $$;

/* ============================================================ 4. members are held, not banned */

do $$
declare v_quarantined integer;
begin
  select count(*) into v_quarantined from public.respondent_trust_ids
   where customer_id = 'd0000000-0000-0000-0000-0000000000d1' and status <> 'active';
  if v_quarantined > 0 then
    raise exception '% identities were quarantined by the graph — on an unmeasured false-positive rate that bans % people at once', v_quarantined, v_quarantined;
  end if;
  if (select min(risk_score) from public.respondent_trust_ids
        where customer_id = 'd0000000-0000-0000-0000-0000000000d1') < 67 then
    raise exception 'the ring members carry no raised risk at all';
  end if;
  raise notice 'PASS 4  the ring raises every member''s risk and bans nobody';
end $$;

/* ============================================================ 5. no score below 50 accepted completes */

do $$
declare v_rows integer; v_score numeric; v_conf text;
begin
  insert into public.recruitment_orders
    (recruitment_project_id, integration_id, ordered_completes, agreed_cpi, currency, status,
     delivered_completes, accepted_completes, rejected_completes, duplicate_attempts, spend_amount, placed_at)
  values ('d0000000-0000-0000-0000-0000000004d1', 'd0000000-0000-0000-0000-0000000003d1',
          100, 5.0, 'GBP', 'live', 44, 40, 4, 0, 200, now() - interval '2 days');

  select public.rescript_vendor_quality_recompute('d0000000-0000-0000-0000-0000000000d1', 90) into v_rows;
  if v_rows <> 1 then raise exception 'expected 1 vendor scored, got %', v_rows; end if;

  select quality_score, confidence into v_score, v_conf from public.vendor_quality_metrics
   where integration_id = 'd0000000-0000-0000-0000-0000000003d1';

  if v_score is not null then
    raise exception 'a vendor with 40 accepted completes was given a score of % — unknown is not a measurement', v_score;
  end if;
  if v_conf <> 'none' then raise exception 'expected confidence none, got %', v_conf; end if;
  raise notice 'PASS 5  40 accepted completes earns no score and no confidence — NULL, never zero';
end $$;

/* ============================================================ 6. the interval is reported, and it is wide */

do $$
declare v record;
begin
  update public.recruitment_orders
     set delivered_completes = 1100, accepted_completes = 1000, rejected_completes = 100, spend_amount = 5000
   where recruitment_project_id = 'd0000000-0000-0000-0000-0000000004d1';

  perform public.rescript_vendor_quality_recompute('d0000000-0000-0000-0000-0000000000d1', 90);
  select * into v from public.vendor_quality_metrics
   where integration_id = 'd0000000-0000-0000-0000-0000000003d1';

  if v.rejection_rate is null or v.rejection_low is null or v.rejection_high is null then
    raise exception 'a rate was stored with no interval beside it';
  end if;
  if not (v.rejection_low < v.rejection_rate and v.rejection_rate < v.rejection_high) then
    raise exception 'the point estimate % is not inside its own interval [%, %]', v.rejection_rate, v.rejection_low, v.rejection_high;
  end if;
  if v.rejection_low < 0 or v.rejection_high > 100 then
    raise exception 'the interval left [0,100]: [%, %]', v.rejection_low, v.rejection_high;
  end if;
  if v.quality_score is null then raise exception '1,000 accepted completes still earns no score'; end if;
  if v.confidence <> 'high' then raise exception 'expected high confidence at 1,000 accepted, got %', v.confidence; end if;
  raise notice 'PASS 6  1,000 completes: rejection %, interval [%, %], score %, confidence %',
    v.rejection_rate, v.rejection_low, v.rejection_high, v.quality_score, v.confidence;
end $$;

/* ============================================================ 7. a thin sample gets a WIDER interval */

do $$
declare v_thin numeric; v_thick numeric;
begin
  select rejection_high - rejection_low into v_thick from public.vendor_quality_metrics
   where integration_id = 'd0000000-0000-0000-0000-0000000003d1';

  -- same 9.09% rejection rate, a fortieth of the evidence
  update public.recruitment_orders
     set delivered_completes = 110, accepted_completes = 100, rejected_completes = 10, spend_amount = 500
   where recruitment_project_id = 'd0000000-0000-0000-0000-0000000004d1';
  perform public.rescript_vendor_quality_recompute('d0000000-0000-0000-0000-0000000000d1', 90);
  select rejection_high - rejection_low into v_thin from public.vendor_quality_metrics
   where integration_id = 'd0000000-0000-0000-0000-0000000003d1';

  if v_thin <= v_thick then
    raise exception 'the thin sample (width %) is not wider than the thick one (width %) — the interval is not measuring anything', v_thin, v_thick;
  end if;
  raise notice 'PASS 7  the same rejection rate over 110 completes is % points wide, over 1,100 it is % — the optimiser can tell them apart', round(v_thin, 1), round(v_thick, 1);
end $$;

/* ============================================================ 8. no precision until cases are RESOLVED */

do $$
declare v record;
begin
  select * into v from public.rescript_model_evaluate('d0000000-0000-0000-0000-0000000000d1', 90);
  if v.status <> 'insufficient' then raise exception 'expected insufficient with no resolved cases, got %', v.status; end if;
  if v."precision" is not null then raise exception 'precision % was published with nothing resolved', v."precision"; end if;

  if (select status from public.model_evaluations
        where customer_id = 'd0000000-0000-0000-0000-0000000000d1' and rule_id is null) <> 'insufficient' then
    raise exception 'the stored evaluation disagrees with what the function returned';
  end if;
  raise notice 'PASS 8  no resolved cases → insufficient, and no numbers at all';
end $$;

/* ============================================================ 9. twenty-nine resolutions is still insufficient */

do $$
declare i integer; v record;
begin
  for i in 1..29 loop
    insert into public.fraud_cases (customer_id, survey_id, kind, risk_score, status, resolved_at, resolution_note)
    values ('d0000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-0000000001d1',
            'admission_risk', 80, case when i <= 20 then 'upheld' else 'cleared' end, now(), 'test');
  end loop;

  select * into v from public.rescript_model_evaluate('d0000000-0000-0000-0000-0000000000d1', 90);
  if v.status <> 'insufficient' then
    raise exception 'precision was published from 29 decisions — somebody could tune thresholds against that';
  end if;
  if v.resolved <> 29 then raise exception 'expected 29 resolved, counted %', v.resolved; end if;

  -- the thirtieth crosses the floor
  insert into public.fraud_cases (customer_id, survey_id, kind, risk_score, status, resolved_at, resolution_note)
  values ('d0000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-0000000001d1',
          'admission_risk', 80, 'upheld', now(), 'test');

  select * into v from public.rescript_model_evaluate('d0000000-0000-0000-0000-0000000000d1', 90);
  if v.status <> 'computed' then raise exception 'thirty resolved cases still reports %', v.status; end if;
  if round(v."precision", 2) <> 0.70 then raise exception 'expected precision 0.70 (21 upheld of 30), got %', v."precision"; end if;
  if round(v.false_positive_rate, 2) <> 0.30 then raise exception 'expected a false-positive rate of 0.30, got %', v.false_positive_rate; end if;
  raise notice 'PASS 9  29 resolved → insufficient; 30 → precision 0.70, false positives 0.30';
end $$;

/* ============================================================ 10. an open case is not evidence of anything */

do $$
declare v_before record; v_after record;
begin
  select * into v_before from public.rescript_model_evaluate('d0000000-0000-0000-0000-0000000000d1', 90);

  -- a hundred suspicions, none of them resolved
  insert into public.fraud_cases (customer_id, survey_id, kind, risk_score, status)
  select 'd0000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-0000000001d1', 'admission_risk', 95, 'open'
    from generate_series(1, 100);

  select * into v_after from public.rescript_model_evaluate('d0000000-0000-0000-0000-0000000000d1', 90);
  if v_after."precision" <> v_before."precision" then
    raise exception 'a hundred unresolved suspicions moved precision from % to % — the detector is grading its own homework',
      v_before."precision", v_after."precision";
  end if;
  raise notice 'PASS 10 a hundred open cases change precision not at all';
end $$;

/* ============================================================ 11. a forecast with nothing to forecast from */

do $$
declare v_id uuid;
begin
  insert into public.recruitment_forecasts (recruitment_project_id, projected_completion, projected_final_cost,
    basis, insufficient_reason)
  values ('d0000000-0000-0000-0000-0000000004d1', null, null,
          '{"accepted": 4, "hoursElapsed": 2}'::jsonb, '4 accepted completes is too few to project from')
  returning id into v_id;

  if (select projected_completion from public.recruitment_forecasts where id = v_id) is not null then
    raise exception 'a forecast row with an insufficient reason also carries a date';
  end if;
  if (select insufficient_reason from public.recruitment_forecasts where id = v_id) is null then
    raise exception 'a forecast with no projection must say why';
  end if;
  raise notice 'PASS 11 an unforecastable project stores the reason, not a guess';
end $$;

rollback;
