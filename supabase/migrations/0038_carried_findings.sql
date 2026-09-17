-- 0038_carried_findings.sql
--
-- THE FINDINGS EVERY PHASE CARRIED FORWARD, CLOSED.
--
-- Three of the seven items on the plan's "carried findings" list need schema.
--
-- ## A session recording gets an audio companion
--
-- A moderated recording was transcribed against the VIDEO object, which a
-- speech provider that accepts 25 MB refuses after about eighty seconds at
-- the browser's default bitrate. Candidate answers never had this problem
-- because they record a second, audio-only track and transcribe that. The
-- session recorder now does the same, and `companion_of` is how the audio
-- row names the video it belongs to — the candidate path joins the pair by
-- `response_id`, which a session recording does not have.
--
-- ## Evidence can point at a recording
--
-- Session transcripts never reached the analysis: sources were keyed by
-- response id and a session has none. They are sources now, and the evidence
-- they produce names the recording (`media_id`) instead of a response. The
-- existing unique key treats NULL response ids as distinct, so several
-- session findings for one requirement coexist; `media_id` is what tells them
-- apart to a reader.
--
-- ## A job can be handed back without spending an attempt
--
-- A wallet refusal is not a broken recording and not a provider having a bad
-- moment: it is "not until somebody tops up". The runner used to mark it a
-- permanent failure — the comment beside it promised the opposite. A job now
-- finishes as `queued` with a `run_after` an hour out, and the claim's
-- increment of `attempts` is refunded, so a wallet that is empty for a week
-- does not exhaust three attempts on the first day.
--
-- Additive; nothing existing changes meaning.

begin;

alter table public.interview_media
  add column if not exists companion_of uuid references public.interview_media(id) on delete cascade;
create index if not exists interview_media_companion_idx
  on public.interview_media (companion_of) where companion_of is not null;
comment on column public.interview_media.companion_of is
  'For a session_audio companion: the session_video it was recorded alongside. The companion is what gets transcribed.';

alter table public.interview_evidence
  add column if not exists media_id uuid references public.interview_media(id) on delete set null;
comment on column public.interview_evidence.media_id is
  'Set when the quoted passage comes from a moderated session transcript, which has no response row.';

create or replace function public.rescript_interview_finish_job(
  p_job uuid,
  p_status text,
  p_error text default null,
  p_run_after timestamptz default null
)
returns public.interview_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.interview_jobs;
begin
  update public.interview_jobs
     set status = p_status,
         error = p_error,
         run_after = coalesce(p_run_after, run_after),
         completed_at = case when p_status in ('complete', 'cancelled') then now() else completed_at end,
         claimed_at = case when p_status = 'running' then claimed_at else null end,
         /* handed back, not failed: the attempt the claim counted is refunded */
         attempts = case when p_status = 'queued' then greatest(0, attempts - 1) else attempts end
   where id = p_job
   returning * into j;
  return j;
end $$;
revoke all on function public.rescript_interview_finish_job(uuid, text, text, timestamptz) from public, anon, authenticated;

commit;
