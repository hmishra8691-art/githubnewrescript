-- Intelligent engine reliability (2026-10-17): the operation log keeps enough of a long
-- prompt to reproduce it. A 25,000-character pasted brief was logged as its first 4,000
-- characters only; the record now keeps 20,000, and its intent carries the full length and
-- SHA-256 (promptLength, promptSha256) when the prompt is longer than 4,000.
--
-- Backward compatible: the Studio writes up to 20,000 and, on a database without this
-- migration, falls back to the old 4,000 (operationsStore.ts) instead of losing the record.

alter table public.intelligent_operations
  drop constraint if exists intelligent_operations_prompt_len;

alter table public.intelligent_operations
  add constraint intelligent_operations_prompt_len check (char_length(prompt) <= 20000);
