-- 0078 — Save ordering: a monotonic per-session sequence number on the response row (2026-10-30)
--
-- docs/S0-SECURITY-INTEGRITY-2026-10-30.md, audit 2026-10-30 D6. Every page the respondent leaves (Next AND Back)
-- fires an intermediate save carrying the WHOLE state. Two saves in flight could arrive out of order, and the older
-- snapshot overwrote the newer one — reproduced on the navigation trail of 0077 (section-nav-test §G).
--
--   responses.save_seq   bigint not null default 0
--
-- The Runner numbers every save of a session 1, 2, 3, … (continuing from the row's save_seq on resume, and from its
-- own pending cache after a reload). The save route writes an intermediate save only when its seq is GREATER than
-- the stored one — a conditional update (`… where save_seq < $seq`) — and otherwise answers 200 { stale: true }
-- without writing. The final save (completion / screen-out / termination) is not refused for its seq: it is guarded
-- by `status = 'in_progress'` and finalises exactly once (Y11). A client that sends no seq (an old page still open
-- across a deploy) is written as before, without touching save_seq.
--
-- Access: unchanged. RLS on public.responses is row-level (0001); only the service role writes. No index: the
-- condition is evaluated on the row the update already finds by session_id.
--
-- Re-runnable: `add column if not exists`. Before 0078 is applied the save route retries without the column and logs
-- once (the 0077 pattern), so deploy order is free; recommended 0074 → 0076 → 0077 → 0078.
-- Undo (saves become unordered again):
--   alter table public.responses drop constraint if exists responses_save_seq_nonneg;
--   alter table public.responses drop column if exists save_seq;

alter table public.responses add column if not exists save_seq bigint not null default 0;

comment on column public.responses.save_seq is
  'Save ordering (0078): the highest client save sequence number applied to this row. An intermediate save with seq <= save_seq is stale and not written. Written by the runtime save route only.';

alter table public.responses drop constraint if exists responses_save_seq_nonneg;
alter table public.responses add constraint responses_save_seq_nonneg check (save_seq >= 0);
