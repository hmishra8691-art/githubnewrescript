-- 0010 — quota counters remember when they last moved.
--
-- The Quota Dashboard shows "last updated" per quota. The counter table had no
-- timestamp, so the two functions that write it now stamp `updated_at`; every
-- other reader and writer is unchanged (the column has a default, and both
-- functions keep their signatures).

alter table public.quota_counts
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.increment_quota_counts(
  p_survey_id uuid,
  p_cells jsonb,
  p_test boolean default false
) returns void
language plpgsql security definer set search_path = public as $$
declare c jsonb;
begin
  for c in select * from jsonb_array_elements(p_cells) loop
    insert into public.quota_counts (survey_id, quota_id, cell_id, is_test, count, updated_at)
    values (p_survey_id, c->>'quotaId', c->>'cellId', p_test, 1, now())
    on conflict (survey_id, quota_id, cell_id, is_test)
    do update set count = public.quota_counts.count + 1, updated_at = now();
  end loop;
end $$;

create or replace function public.rescript_replace_quota_counts(p_survey uuid, p_test boolean, p_cells jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare c jsonb; n integer := 0;
begin
  delete from public.quota_counts where survey_id = p_survey and is_test = p_test;
  for c in select * from jsonb_array_elements(coalesce(p_cells, '[]'::jsonb)) loop
    insert into public.quota_counts (survey_id, quota_id, cell_id, is_test, count, updated_at)
    values (p_survey, c->>'quotaId', c->>'cellId', p_test, coalesce((c->>'count')::integer, 0), now());
    n := n + 1;
  end loop;
  return n;
end $$;
