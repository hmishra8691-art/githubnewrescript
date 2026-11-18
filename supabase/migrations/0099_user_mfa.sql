-- 0099 — TWO-FACTOR SIGN-IN (audit 2026-11-17, P1-07).
--
-- One row per person who has set up an authenticator app. The TOTP secret is stored SEALED (envelope encryption with
-- INTEGRATIONS_SECRET_KEY, AAD "mfa|<user id>"), never in clear; recovery codes are stored as SHA-256 hashes only.
-- `last_step` is the 30-second step of the last accepted code, so a code is accepted once.
--
-- Read and written only by the Studio's server (service role). Row-level security is on with no policy, so the
-- browser's anon/authenticated keys can read nothing here.
--
-- Until this migration is applied the Studio treats two-factor sign-in as unavailable and signs people in with the
-- password alone, logging that it did so (it does not lock administrators out).

create table if not exists public.user_mfa (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  secret_sealed text not null,
  recovery_hashes text[] not null default '{}',
  last_step bigint,
  enabled_at timestamptz not null default now(),
  last_used_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.user_mfa enable row level security;

comment on table public.user_mfa is 'P1-07: TOTP second factor per person; secret sealed, recovery codes hashed; service role only.';

insert into public.schema_marks (migration, note) values ('0099', 'user_mfa: TOTP second factor (P1-07)')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
