-- 0100 — PUBLIC API KEYS (audit 2026-11-17, P2-13).
--
-- A key belongs to a person in a workspace; it never does more than that person can (the Studio checks their project
-- role on every request). Only a SHA-256 of the key is stored, with a 10-character prefix to recognise it in a list.
-- Service role only: row-level security on, no policy.
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  customer_id uuid,
  name text not null check (char_length(name) between 1 and 80),
  prefix text not null,
  key_hash text not null unique,
  scopes text[] not null check (cardinality(scopes) > 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists api_keys_user_idx on public.api_keys (user_id) where revoked_at is null;

alter table public.api_keys enable row level security;

comment on table public.api_keys is 'P2-13: public API keys — hashed, scoped, owned by a person; service role only.';

insert into public.schema_marks (migration, note) values ('0100', 'api_keys: public REST API keys (P2-13)')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
