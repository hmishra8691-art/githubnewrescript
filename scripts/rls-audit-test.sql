-- =====================================================================
-- WHAT ROW-LEVEL SECURITY IS ACTUALLY DOING (A13)
--
-- The capability-gap audit put it sharply: RLS is enabled on every table
-- with around fifty policies, and 52 API route files use the SERVICE ROLE,
-- which bypasses all of it. The app-layer guards in `lib/guard.ts` are the
-- only thing enforcing access on the platform's own routes.
--
-- That is true, and the conclusion people jump to — "the RLS is decorative"
-- — is wrong in a way worth writing down, because both halves matter:
--
--   * The APP LAYER is the enforcement point. It knows what the database
--     cannot: which capability an action needs, who holds the edit lock,
--     whether the project is frozen. `scripts/auth-guard-audit.mjs` proves
--     every handler passes through it, first statement, no exceptions that
--     are not written down with a reason.
--
--   * RLS is the BACKSTOP for everything that is not those routes. The anon
--     key reaches the browser by design; a leaked one, a mistaken direct
--     query, a future edge function or a third-party tool with the anon key
--     all land on the policies. Deleting them would cost nothing today and
--     everything the first time somebody queries the database from outside
--     `lib/guard.ts`.
--
-- So this file asserts the properties that must hold for the backstop to be
-- worth having, and reports the rest rather than asserting a number that
-- will be wrong next week.
--
--   psql -d <database> -f scripts/rls-audit-test.sql
--
-- Read-only: it creates nothing and changes nothing, so unlike the other
-- SQL suites here it is safe to run against the live project.
-- =====================================================================
\set ON_ERROR_STOP on
\timing off
\pset pager off

\echo '--- 1. EVERY table in public has RLS enabled'
-- The real hole is not a weak policy. It is a table added in six months with
-- RLS left off, which is open to anyone holding the anon key and looks
-- perfectly normal in every code path.
do $$
declare
  bad text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if bad is not null then
    raise exception 'FAIL: RLS is OFF on %', bad;
  end if;
  raise notice 'PASS every table is behind RLS';
end $$;

\echo '--- 2. a table with NO policies is service-role only, and that is declared'
-- Zero policies plus RLS enabled is the STRONGEST state, not a gap: it denies
-- everything to every client except the service role. `password_resets` was
-- given it deliberately in 0016 — a token table is a password-equivalent and
-- nothing but the server has any business reading it. The assertion is that
-- the set has not grown by accident.
do $$
declare
  declared text[] := array[
    'password_resets',      -- hashed reset tokens: password-equivalents
    'login_attempts',       -- throttling record, keyed on an IP hash
    'response_counters',    -- atomic counters behind quota and List Fill claims
    'listfill_counts',      -- ditto
    'listfill_allocations', -- ditto
    'response_edits',       -- post-field edit trail, written by the server only
    'response_reviews',     -- reviewer decisions, written by the server only
    'quality_profiles'      -- workspace quality library, server-mediated
  ];
  unexpected text;
  missing text;
begin
  select string_agg(t.relname, ', ' order by t.relname) into unexpected
  from (
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_policy p on p.polrelid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
    group by c.relname
    having count(p.polname) = 0
  ) t
  where t.relname <> all(declared);

  if unexpected is not null then
    raise exception
      'FAIL: % has RLS on and no policies. That is deny-all, which may be right — add it to the declared list with the reason, or give it a policy.',
      unexpected;
  end if;

  -- and the reverse: a declared table that HAS grown a policy
  select string_agg(d, ', ') into missing
  from unnest(declared) d
  where exists (
    select 1 from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = d
  );
  if missing is not null then
    raise notice 'NOTE % now has policies and is no longer service-role only — update the list', missing;
  end if;
  raise notice 'PASS the deny-all tables are the eight that are meant to be';
end $$;

\echo '--- 3. NO write policy is unconditional'
-- The failure this catches is `using (true)` — added to make something work
-- during development and never narrowed. A read policy that is too open
-- leaks; a WRITE policy that is too open lets one client's browser edit
-- another client's survey.
do $$
declare
  bad text;
begin
  select string_agg(format('%s.%s (%s)', tablename, policyname, cmd), ', ' order by tablename)
    into bad
  from pg_policies
  where schemaname = 'public'
    and cmd <> 'SELECT'
    -- every tenancy decision in this schema goes through one of these three
    and coalesce(qual, '') || coalesce(with_check, '') not like '%current_customer_id%'
    and coalesce(qual, '') || coalesce(with_check, '') not like '%current_role%'
    and coalesce(qual, '') || coalesce(with_check, '') not like '%auth.uid%';
  if bad is not null then
    raise exception 'FAIL: write policies with no tenancy predicate: %', bad;
  end if;
  raise notice 'PASS every write policy is scoped to a customer, a role or a user';
end $$;

\echo '--- 4. the same for read policies'
do $$
declare
  bad text;
begin
  select string_agg(format('%s.%s', tablename, policyname), ', ' order by tablename) into bad
  from pg_policies
  where schemaname = 'public'
    and cmd = 'SELECT'
    and coalesce(qual, '') || coalesce(with_check, '') not like '%current_customer_id%'
    and coalesce(qual, '') || coalesce(with_check, '') not like '%current_role%'
    and coalesce(qual, '') || coalesce(with_check, '') not like '%auth.uid%'
    and coalesce(qual, '') || coalesce(with_check, '') not like '%rescript_%';
  if bad is not null then
    raise exception 'FAIL: read policies with no tenancy predicate: %', bad;
  end if;
  raise notice 'PASS every read policy is scoped too';
end $$;

\echo '--- 4b. the two assertions above are not passing vacuously'
-- A test that looks for a pattern and finds nothing passes whether or not the
-- property holds. If the tenancy helpers are ever renamed, checks 3 and 4
-- would go quiet rather than fail — so this asserts that every policy matched
-- one of the patterns, which is the same fact stated positively.
do $$
declare
  total int;
  matched int;
begin
  select count(*) into total from pg_policies where schemaname = 'public';
  select count(*) into matched
  from pg_policies
  where schemaname = 'public'
    and (coalesce(qual, '') || coalesce(with_check, '') like '%current_customer_id%'
      or coalesce(qual, '') || coalesce(with_check, '') like '%current_role%'
      or coalesce(qual, '') || coalesce(with_check, '') like '%auth.uid%'
      or coalesce(qual, '') || coalesce(with_check, '') like '%rescript_%');
  if total = 0 then
    raise exception 'FAIL: no policies at all — the schema is not what this file was written against';
  end if;
  if matched <> total then
    raise exception 'FAIL: % of % policies matched no tenancy predicate, so checks 3 and 4 are looking for the wrong thing',
      total - matched, total;
  end if;
  raise notice 'PASS all % policies carry a tenancy predicate the checks above recognise', total;
end $$;

\echo '--- 5. REPORT: write-capable policies granted to PUBLIC rather than authenticated'
-- Not a failure, and worth seeing. `public` includes `anon`, so these are
-- reachable by a caller with only the anon key — but every one of them gates
-- on `current_customer_id()`, `current_role()` or `auth.uid()`, all of which
-- are NULL for an anonymous caller, so the predicate is false and the write
-- is refused. Narrowing the role list to `authenticated` would be
-- defence-in-depth rather than a fix, which is why this reports instead of
-- raising: the change is worth making deliberately, not under a failing test.
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public' and cmd <> 'SELECT' and roles::text like '%public%'
order by tablename;

\echo '--- 6. REPORT: the shape of the whole policy surface'
select cmd, roles::text as granted_to, count(*) as policies
from pg_policies
where schemaname = 'public'
group by cmd, roles::text
order by count(*) desc;

\echo '--- 7. REPORT: security-definer functions, which are the doors THROUGH the policies'
-- Each of these runs as its owner and therefore bypasses RLS on purpose. They
-- are the deliberate exceptions — a respondent submitting an answer, a share
-- token being resolved — and the list is short enough to read.
select p.proname, pg_get_function_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
order by p.proname;
