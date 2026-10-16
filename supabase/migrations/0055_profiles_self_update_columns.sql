-- 0055 — a user may edit only the descriptive columns of their own profile (audit SCHEMA-05, 2026-10-16)
--
-- profiles_update_self (0001) and profiles_self_write (0008) let an `authenticated` user update ANY column of
-- their own row, including role and customer_id: a self-promotion to platform_admin or a tenant hop the moment
-- any code path queries PostgREST with a user JWT. No such path exists today (every route uses the service
-- role), so this closes a latent hole without changing behaviour.
--
-- Two layers, either of which is enough:
--   1. column-level privileges: `authenticated` may update only the descriptive columns;
--   2. a trigger that refuses a change to role / customer_id / status / user_code / email / locked_until unless
--      the caller is the service role (auth.uid() is null) or a platform admin.
-- Re-runnable.

revoke update on public.profiles from authenticated;
grant update (full_name, job_title, organization, updated_at) on public.profiles to authenticated;

create or replace function public.rescript_profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- service role / direct database sessions have no auth.uid(): the application's own server code, trusted
  if auth.uid() is null then return new; end if;
  if public.rescript_is_platform_admin(auth.uid()) then return new; end if;
  if new.role is distinct from old.role
     or new.customer_id is distinct from old.customer_id
     or new.status is distinct from old.status
     or new.user_code is distinct from old.user_code
     or new.email is distinct from old.email
     or new.locked_until is distinct from old.locked_until then
    raise exception 'profiles: role, customer, status, code, email and lock state can only be changed by an administrator'
      using errcode = '42501';
  end if;
  return new;
end $$;

create or replace trigger profiles_guard before update on public.profiles
  for each row execute function public.rescript_profiles_guard();

-- trigger function only: not callable over RPC (applied separately as 0055b on rescript-survey-platform)
revoke all on function public.rescript_profiles_guard() from public, anon, authenticated;
