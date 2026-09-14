/*
 * A TRANSCRIPT THAT ARRIVES LATE IS STILL THE ANSWER.
 *
 * The respondent's clip is transcribed by a durable job that finishes twenty
 * to sixty seconds after they stopped speaking — by design, because holding
 * an interview open on a provider call is what made five-minute answers
 * impossible. But the answer itself is only written to `responses` on a page
 * turn or at submit, and a finalised session refuses further writes
 * (`api/session/save` returns `ok: true` and stores nothing, deliberately, so
 * a late browser cannot rewrite a finished interview).
 *
 * Those two facts together meant the last question's transcript — and any
 * transcript for a respondent who pressed Next promptly — existed in
 * `media_transcripts` and never in the response. The export column read it
 * from `responses.answers`, so it was blank. The transcript was generated,
 * stored, retryable, and absent from the data.
 *
 * The browser cannot fix this: it may be closed. So the server writes it,
 * from the runner that produced it.
 *
 * ## Why a function rather than an UPDATE from the application
 *
 * `responses.answers` is one jsonb document holding every answer. Reading it,
 * patching one key and writing it back would race with the respondent's own
 * save and could lose answers to questions this transcript knows nothing
 * about. `jsonb_set` inside the database touches one path under one row lock,
 * so a transcript landing mid-interview cannot cost an answer.
 *
 * ## Why `answer_key` and not `question_id`
 *
 * Inside a loop an answer is keyed `<questionId>__<iteration>`, not by
 * question id — so a question asked about three brands has three answers and
 * three recordings. `question_id` stays what it is (it is what the media
 * cleanup groups by); the exact key the answer lives under is recorded
 * alongside it.
 */

alter table public.media_objects
  add column if not exists answer_key text;

comment on column public.media_objects.answer_key is
  'The key this recording''s answer lives under in responses.answers — the question id, or <questionId>__<iteration> inside a loop.';

/*
 * Merge a finished transcript into the answer it belongs to.
 *
 * Deliberately works on a FINALISED response as well as an in-progress one.
 * The rule the session-save guard enforces is that a browser may not rewrite
 * a submitted interview; this is not a browser, it is the transcript of the
 * recording that interview already contains, and refusing it would mean
 * discarding the thing the respondent actually said.
 *
 * Returns true when a row was touched, so the caller can tell "written" from
 * "that session no longer exists".
 */
create or replace function public.rescript_set_answer_transcript(
  p_session text,
  p_answer_key text,
  p_transcript jsonb
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_answers jsonb;
  v_id uuid;
begin
  select r.id, coalesce(r.answers, '{}'::jsonb) into v_id, v_answers
    from public.responses r
   where r.session_id = p_session
   for update;

  if v_id is null then
    return false;
  end if;

  /*
   * The answer object may not exist yet — a respondent whose page never
   * turned — so the transcript creates it rather than being dropped. It is
   * still a true statement about what they said.
   */
  if v_answers -> p_answer_key is null or jsonb_typeof(v_answers -> p_answer_key) <> 'object' then
    v_answers := jsonb_set(v_answers, array[p_answer_key], jsonb_build_object('transcript', p_transcript), true);
  else
    v_answers := jsonb_set(v_answers, array[p_answer_key, 'transcript'], p_transcript, true);
  end if;

  update public.responses
     set answers = v_answers,
         updated_at = now()
   where id = v_id;

  return true;
end $$;

revoke all on function public.rescript_set_answer_transcript(text, text, jsonb) from public, anon, authenticated;

/*
 * Every recording whose transcript finished but never reached its answer.
 *
 * The backfill for clips already collected, and the safety net for a runner
 * killed between marking the job complete and patching the response. Reading
 * it is how an operator knows whether the two ever disagree.
 */
create or replace function public.rescript_unmerged_transcripts(p_survey uuid default null)
returns table (media_id uuid, session_id text, answer_key text, survey_id uuid, text text, completed_at timestamptz)
language sql
security definer
set search_path = public, pg_temp
as $$
  select m.id, m.session_id, coalesce(m.answer_key, m.question_id), m.survey_id, t.text, t.completed_at
    from public.media_transcripts t
    join public.media_objects m on m.id = t.media_id
    left join public.responses r on r.session_id = m.session_id
   where t.status = 'completed'
     and m.session_id is not null
     and (p_survey is null or m.survey_id = p_survey)
     and coalesce(
           r.answers #>> array[coalesce(m.answer_key, m.question_id), 'transcript', 'text'],
           ''
         ) is distinct from t.text;
$$;

revoke all on function public.rescript_unmerged_transcripts(uuid) from public, anon, authenticated;
