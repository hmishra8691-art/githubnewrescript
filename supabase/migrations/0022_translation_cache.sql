-- =====================================================================
-- 0022 — TRANSLATION CACHE
--
-- The multilingual layer stores each survey's translations INSIDE its
-- definition (`localization.translations`, versioned with the survey, by
-- stable element key) — programming in the definition, as everywhere else.
-- This table is the other half of the localization architecture: a cache in
-- front of the translation provider, so the same sentence asked twice — in
-- the same survey, in the next survey, after a reload — is not paid for and
-- waited for twice.
--
-- WHY A TABLE AND NOT ONLY MEMORY. Vercel functions do not share memory and
-- do not live long; a cache that forgets between invocations saves nothing
-- on a 300-element survey translated into eight languages. And an APPROVED
-- human wording — "Customer Satisfaction" the way this client says it in
-- Hindi — should be what every later survey gets first, which needs a place
-- that outlives the request.
--
-- SCOPE. Rows are per customer, always. Machine translations of generic
-- strings would be safe to share, but a source text is a client's
-- questionnaire content and an approved wording is their editorial
-- decision; neither crosses tenants.
--
-- KEY. `cache_key` = hash(source text, whitespace-normalised) | source
-- language | target language | provider — the same string the application
-- computes (`cacheKey` in @rescript/ai). `source_hash` and `source_text` are
-- kept beside it so a row can be inspected and re-keyed if the hash ever
-- changes.
-- =====================================================================

create table if not exists public.translation_cache (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  cache_key text not null,
  provider text not null,
  source_language text not null,
  target_language text not null,
  source_hash text not null,
  source_text text not null,
  translated_text text not null,
  /* an approved human wording — never displaced by a machine result */
  approved boolean not null default false,
  hits integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists translation_cache_key_idx
  on public.translation_cache (customer_id, cache_key);
create index if not exists translation_cache_lookup_idx
  on public.translation_cache (customer_id, target_language, source_hash);

alter table public.translation_cache enable row level security;

drop policy if exists translation_cache_tenant_read on public.translation_cache;
create policy translation_cache_tenant_read on public.translation_cache
  for select to authenticated
  using (
    customer_id = public.current_customer_id()
    or public.current_role() = 'platform_admin'
  );

-- writes go through the service role behind `requireUser` / `requireProject`, as everywhere else
