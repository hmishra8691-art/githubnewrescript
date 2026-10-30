-- 0077 — Section navigation: the respondent's Back trail and visited sections, kept in the response row (2026-10-30)
--
-- docs/SECTION-NAVIGATION-2026-10-30.md. The navigator (engine sectionNav.ts) decides which sections a respondent may
-- jump to from the pages they have SEEN, and Back follows the trail of pages they actually came through (LOGIC-04).
-- Both lived only in the respondent's browser, so a respondent who resumed on another device lost them. The owner
-- decided (2026-10-30) that they live in the response row:
--
--   responses.nav   jsonb, nullable — { "v": 1,
--                                       "stack":   ["p1", "p2", "pr@apple", …],   -- the Back trail, oldest first
--                                       "visited": ["p1", "p2", "p4", …],         -- every page shown and left
--                                       "at":      "p4" }                          -- the page the respondent is on (optional)
--
-- Written by the runtime's save route only (service role), after it has validated the shape and dropped every id
-- that is not a page of the definition the session runs. It is NEVER trusted to move a respondent: the save route's
-- replay (engine checkSubmission) still decides what is valid, and resume positions by step_index as before.
-- It is paradata, not an answer: no export reads it.
--
-- Size guard. A 1,000-page survey (every page a loop iteration of a 20-item loop, ids like "p_0042@item_17") has a
-- trail and a visited list of at most 1,000 ids each. The runtime caps each list at 2,000 ids of at most 128
-- characters; the check enforces the same list bounds and a 1 MB byte backstop (2 × 2,000 × (128 + jsonb overhead)
-- stays under it uncompressed; a realistic 1,000-page trail is ~40 KB). An absent key is an empty list.
--
-- Access: unchanged, and nothing else is needed. RLS on public.responses is row-level (0001
-- `responses_tenant_read`: SELECT for the survey's own customer and platform admins; there are NO insert / update /
-- delete policies, so only the service role writes). A new column is read and written under exactly those rules —
-- whoever may read the row may read its navigation trail, which holds page ids only (no answers, no personal data).
-- No index: nothing queries by it; it is read with the row on resume.
--
-- Re-runnable: `add column if not exists`, `drop constraint if exists` before the add.
-- Undo (forgets trails; respondents fall back to the browser copy, then to compiled order):
--   alter table public.responses drop constraint if exists responses_nav_shape;
--   alter table public.responses drop column if exists nav;

alter table public.responses add column if not exists nav jsonb;

comment on column public.responses.nav is
  'Section navigation paradata (0077): { v:1, stack: Back trail page ids, visited: pages seen, at?: current page id }. Written by the runtime save route only, validated against the session''s definition; never exported as respondent data.';

alter table public.responses drop constraint if exists responses_nav_shape;
-- CASE, not AND: SQL does not promise to evaluate AND left to right, and jsonb_array_length raises on a non-array
alter table public.responses add constraint responses_nav_shape check (
  case
    when nav is null then true
    when jsonb_typeof(nav) <> 'object' then false
    else coalesce(nav ->> 'v', '') = '1'
      and (case when not nav ? 'stack' then true when jsonb_typeof(nav -> 'stack') = 'array' then jsonb_array_length(nav -> 'stack') <= 2000 else false end)
      and (case when not nav ? 'visited' then true when jsonb_typeof(nav -> 'visited') = 'array' then jsonb_array_length(nav -> 'visited') <= 2000 else false end)
      and (case when not nav ? 'at' then true when jsonb_typeof(nav -> 'at') = 'string' then length(nav ->> 'at') <= 128 else false end)
      and pg_column_size(nav) <= 1048576
  end
);
