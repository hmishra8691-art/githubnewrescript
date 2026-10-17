-- 0060 — prompt-cache rates for AI chat models (AI cost audit, 2026-10-17; docs/AI-COST-AUDIT-2026-10-17.md)
--
-- The Studio now reports, per AI call, how many input tokens the provider READ from its prompt cache and how
-- many it WROTE into it (Anthropic: cache_read_input_tokens / cache_creation_input_tokens; OpenAI:
-- prompt_tokens_details.cached_tokens). The meter prices those tokens from rate rows with side
-- 'cache_read' / 'cache_write' of the SAME model as the input row (packages/billing registry.ts
-- `cacheRateFor`); a model without such rows is priced at its input rate, exactly as before.
--
--   1. billing_rates.side accepts 'cache_read' and 'cache_write' (the check allowed input/output only).
--   2. The cache rows the code ships as defaults — ONLY when the table is already materialised (an
--      administrator saved a rate, which writes every default row first). An EMPTY table means "use the
--      code's defaults" (Meter.rates), and those already include the cache rows; inserting 13 rows into an
--      empty table would make them the WHOLE rate table and price every other operation at zero.
--      Inserted only where no row of that id exists — an administrator's edited row is never overwritten.
--      Anthropic list prices: a read is 10 % of input, a 5-minute write 125 %; OpenAI: a cached read is
--      50 % and there is no write charge (no write row).
--
-- DEPLOY ORDER: the code first, then this file. Code that predates this change cannot parse a
-- 'cache_read' row (its Rate schema allows input/output only), fails to load the rate table and falls
-- back to the built-in default rates until it is replaced.
--
-- Re-runnable: the constraint is dropped if present and added again; the inserts do nothing for ids that exist.
-- Undo: delete from public.billing_rates where side in ('cache_read','cache_write'); then restore the old check
--   (alter table public.billing_rates drop constraint if exists billing_rates_side_check;
--    alter table public.billing_rates add constraint billing_rates_side_check check (side in ('input','output'));)

alter table public.billing_rates drop constraint if exists billing_rates_side_check;
alter table public.billing_rates add constraint billing_rates_side_check
  check (side is null or side in ('input', 'output', 'cache_read', 'cache_write'));

insert into public.billing_rates (id, provider, service, model, side, unit, provider_cost, unit_size, markup_pct, customer_rate, currency, active, estimated, note)
select v.id, v.provider, v.service, v.model, v.side, v.unit, v.provider_cost, v.unit_size, v.markup_pct, v.customer_rate, v.currency, v.active, v.estimated, v.note
from (values
  ('ai.chat.claude-sonnet-4-6.cache_read',  'openai-compatible', 'chat', 'claude-sonnet-4-6', 'cache_read',  'token', 0.30,  1000000, 0, null, 'USD', true, false, ''),
  ('ai.chat.claude-sonnet-4-6.cache_write', 'openai-compatible', 'chat', 'claude-sonnet-4-6', 'cache_write', 'token', 3.75,  1000000, 0, null, 'USD', true, false, ''),
  ('ai.chat.claude-fable-5-1.cache_read',   'openai-compatible', 'chat', 'claude-fable-5-1',  'cache_read',  'token', 1.00,  1000000, 0, null, 'USD', true, false, '10 % / 125 % of the input list price'),
  ('ai.chat.claude-fable-5-1.cache_write',  'openai-compatible', 'chat', 'claude-fable-5-1',  'cache_write', 'token', 12.50, 1000000, 0, null, 'USD', true, false, '10 % / 125 % of the input list price'),
  ('ai.chat.claude-opus-5-5.cache_read',    'openai-compatible', 'chat', 'claude-opus-5-5',   'cache_read',  'token', 0.40,  1000000, 0, null, 'USD', true, false, '10 % / 125 % of the input list price'),
  ('ai.chat.claude-opus-5-5.cache_write',   'openai-compatible', 'chat', 'claude-opus-5-5',   'cache_write', 'token', 5.00,  1000000, 0, null, 'USD', true, false, '10 % / 125 % of the input list price'),
  ('ai.chat.claude-sonnet-5-5.cache_read',  'openai-compatible', 'chat', 'claude-sonnet-5-5', 'cache_read',  'token', 0.20,  1000000, 0, null, 'USD', true, false, '10 % / 125 % of the input list price'),
  ('ai.chat.claude-sonnet-5-5.cache_write', 'openai-compatible', 'chat', 'claude-sonnet-5-5', 'cache_write', 'token', 2.50,  1000000, 0, null, 'USD', true, false, '10 % / 125 % of the input list price'),
  ('ai.chat.claude-haiku-4-5.cache_read',   'openai-compatible', 'chat', 'claude-haiku-4-5',  'cache_read',  'token', 0.10,  1000000, 0, null, 'USD', true, false, ''),
  ('ai.chat.claude-haiku-4-5.cache_write',  'openai-compatible', 'chat', 'claude-haiku-4-5',  'cache_write', 'token', 1.25,  1000000, 0, null, 'USD', true, false, ''),
  ('ai.chat.gpt-4o-mini.cache_read',        'openai-compatible', 'chat', 'gpt-4o-mini',       'cache_read',  'token', 0.075, 1000000, 0, null, 'USD', true, false, 'OpenAI cached input; no write charge'),
  ('ai.chat.*.cache_read',                  'openai-compatible', 'chat', '*',                 'cache_read',  'token', 0.30,  1000000, 0, null, 'USD', true, false, 'for a model priced by the * input row'),
  ('ai.chat.*.cache_write',                 'openai-compatible', 'chat', '*',                 'cache_write', 'token', 3.75,  1000000, 0, null::numeric, 'USD', true, false, 'for a model priced by the * input row')
) as v(id, provider, service, model, side, unit, provider_cost, unit_size, markup_pct, customer_rate, currency, active, estimated, note)
where exists (select 1 from public.billing_rates r where r.side in ('input', 'output'))
on conflict (id) do nothing;
