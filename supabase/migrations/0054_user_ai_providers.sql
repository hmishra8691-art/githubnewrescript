-- 0054 — user-owned AI providers (BYOK): encrypted credentials and per-feature settings.
--
-- WHAT THIS HOLDS. A researcher may connect their own AI provider (chat for
-- Intelligent Mode and the other AI features, speech-to-text, translation).
-- Two tables, kept apart on purpose:
--
--   user_ai_credentials   the SECRET. `sealed` is an envelope-encrypted blob
--                         (AES-256-GCM; a per-credential data key wrapped by a
--                         master key that lives in the server's environment,
--                         never in this database). Without the master key a
--                         dump of this table is noise. `mask` is the only
--                         part of a key ever shown ("sk-…a1b2").
--   user_ai_settings      the CHOICES: per feature, the provider, address,
--                         model and identifiers — no secret in it — plus the
--                         fallback list and whether the platform may be used
--                         as a last resort.
--
-- WHO CAN READ IT. Nobody over the API. Row-level security is ENABLED with NO
-- policy for `anon` or `authenticated`, and every privilege is revoked from
-- both: a row cannot be selected, inserted, updated or deleted through
-- PostgREST by any signed-in user, their own rows included. Only the Studio's
-- server (the service role) touches these tables, and it enforces "your own
-- rows" in code on every read and write. RLS is the second lock, not the only
-- one: even a policy mistake elsewhere cannot expose a ciphertext, because the
-- grants are gone and the master key is not here.
--
-- Additive. Nothing existing changes except one new column on customers.

create table if not exists public.user_ai_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  label text,
  sealed text not null,
  mask text not null,
  key_id text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  last_used_at timestamptz,
  last_test jsonb
);
create index if not exists user_ai_credentials_user_idx on public.user_ai_credentials (user_id);

create table if not exists public.user_ai_settings (
  user_id uuid not null references public.profiles(id) on delete cascade,
  feature text not null check (feature in ('intelligent', 'stt', 'translation', 'additional')),
  mode text not null default 'platform' check (mode in ('platform', 'user')),
  config jsonb not null default '{}'::jsonb,
  credential_id uuid references public.user_ai_credentials(id) on delete set null,
  fallbacks jsonb not null default '[]'::jsonb,
  allow_platform_fallback boolean not null default false,
  last_test jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, feature)
);

alter table public.user_ai_credentials enable row level security;
alter table public.user_ai_settings enable row level security;
alter table public.user_ai_credentials force row level security;
alter table public.user_ai_settings force row level security;
revoke all on public.user_ai_credentials from anon, authenticated;
revoke all on public.user_ai_settings from anon, authenticated;
-- (no policies: deny by default; the service role bypasses RLS)

-- A workspace administrator can switch user-managed AI off for the whole
-- workspace: its members' projects hold the organisation's survey content, and
-- sending it to a personal provider is the organisation's decision.
alter table public.customers add column if not exists ai_byok_allowed boolean not null default true;
