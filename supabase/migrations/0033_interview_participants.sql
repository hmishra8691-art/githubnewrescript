/* ============================================================================
 * 0033 — WHO IS IN THIS RECORDING
 *
 * 0030 modelled a self-service interview: one candidate, alone, answering one
 * question into one camera. Every recording had exactly one voice, so nothing
 * needed to say whose it was — `interview_media.response_id` said everything
 * there was to say.
 *
 * A moderated interview breaks that. Two interviewers and a respondent sit in
 * one recording; the next recording in the same study has one interviewer and
 * the same respondent; the one after that has a different interviewer. The
 * question "who is in this?" has a different answer for every recording, and
 * there is nowhere to put it.
 *
 * ## The two tables, and why it is two
 *
 *   interview_people              a PERSON, once per project
 *   interview_media_participants  that person's presence IN one recording
 *
 * Collapsing them — a name column on the media row, or a jsonb array of names
 * — is the version that looks smaller and is wrong by the second recording.
 * A person appears in many recordings; their name, their email and their
 * Rescript account are facts about them, not about any one video. Storing
 * those per recording means an interviewer who corrects the spelling of their
 * own name corrects it in one place and not the other forty, and it means
 * "every recording Priya is in" is a text search rather than a join.
 *
 * ## Why the respondent is a person too
 *
 * `interviews.candidate_name` already names the respondent, and it stays the
 * source of truth. But a participant selector has to offer the respondent
 * alongside the interviewers, and a list where one entry is a foreign key and
 * another is a string is a list every caller has to special-case.
 *
 * So a trigger mirrors the candidate into `interview_people` — scoped to that
 * interview, `kind = 'respondent'` — on insert and on update. It is derived
 * data maintained by the database, not a second place to edit: writing
 * `candidate_name` updates the mirror, and nothing else writes that row.
 *
 * ## Roles are open, deliberately
 *
 * `interviewer` and `respondent` are what the product needs today.
 * `observer`, `interpreter` and `note_taker` are named because qualitative
 * fieldwork has all three and discovering that later should not be a
 * migration. The check constraint is a list rather than an enum for the same
 * reason — adding a value is one `alter`, not a type rewrite that locks every
 * dependent view.
 * ==========================================================================*/

/* ===================================================== the people */

create table if not exists public.interview_people (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  project_id uuid not null references public.interview_projects(id) on delete cascade,

  /*
   * Set for somebody who exists only inside one sitting — the respondent.
   * NULL for project staff, who appear across many interviews.
   *
   * This is what makes one table serve both without a `kind` that means two
   * unrelated things: the scope IS the distinction.
   */
  interview_id uuid references public.interviews(id) on delete cascade,

  /*
   * THE RESCRIPT ACCOUNT, WHEN THERE IS ONE.
   *
   * §4 of the brief: do not rely on free text when a known identity is
   * available. A staff interviewer who is a Rescript user gets their profile
   * here, and `display_name` becomes a label rather than the identity. The
   * unique index below then makes it impossible to add the same colleague
   * twice under two spellings of their name.
   */
  user_id uuid references public.profiles(id) on delete set null,

  display_name text not null check (length(btrim(display_name)) > 0),
  email text,

  /* what this person usually is here; a recording may still say otherwise */
  kind text not null default 'interviewer' check (kind in (
    'interviewer', 'respondent', 'observer', 'interpreter', 'note_taker'
  )),

  /*
   * A respondent row is written by the trigger below and must not be edited
   * by hand — `candidate_name` on the interview is where that name lives.
   */
  derived boolean not null default false,

  created_by uuid references public.profiles(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/*
 * ONE PERSON, ONE ROW — enforced two ways, because there are two ways to be
 * the same person.
 *
 * By account: a colleague added twice is the same colleague.
 * By email, case-folded: the usual way the same person arrives twice before
 * anybody has an account.
 *
 * Both are partial, so a person with neither — a freelance moderator known
 * only by name — is still addable, as many times as somebody insists.
 */
create unique index if not exists interview_people_user_idx
  on public.interview_people (project_id, user_id)
  where user_id is not null and archived_at is null;
create unique index if not exists interview_people_email_idx
  on public.interview_people (project_id, lower(btrim(email)))
  where email is not null and btrim(email) <> '' and archived_at is null;
/* one derived row per interview, so the trigger's upsert has a target */
create unique index if not exists interview_people_respondent_idx
  on public.interview_people (interview_id)
  where derived;

create index if not exists interview_people_project_idx
  on public.interview_people (project_id, kind) where archived_at is null;

drop trigger if exists interview_people_touch on public.interview_people;
create trigger interview_people_touch before update on public.interview_people
  for each row execute function public.rescript_interviews_touch();

/* ------------------------------------- the respondent, mirrored */

/**
 * Keep a person row in step with `interviews.candidate_name`.
 *
 * Derived, never authored. The mirror exists so a participant selector can
 * offer the respondent and the interviewers as one list of the same shape;
 * the interview row stays the only place a candidate's name is edited.
 */
create or replace function public.rescript_interview_mirror_respondent()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare pid uuid; cid uuid;
begin
  select project_id, customer_id into pid, cid from public.interviews where id = new.id;

  insert into public.interview_people
    (customer_id, project_id, interview_id, display_name, email, kind, derived)
  values (
    cid, pid, new.id,
    coalesce(nullif(btrim(new.candidate_name), ''), 'Respondent ' || left(new.token_prefix, 8)),
    nullif(btrim(new.candidate_email), ''),
    'respondent', true
  )
  on conflict (interview_id) where derived do update
    set display_name = excluded.display_name,
        email = excluded.email,
        updated_at = now();

  return new;
end $$;

revoke all on function public.rescript_interview_mirror_respondent() from public, anon, authenticated;

drop trigger if exists interviews_mirror_respondent on public.interviews;
create trigger interviews_mirror_respondent
  after insert or update of candidate_name, candidate_email on public.interviews
  for each row execute function public.rescript_interview_mirror_respondent();

/* ========================================= who is in one recording */

/**
 * THE PER-RECORDING LIST.
 *
 * §7 of the brief, and the whole reason this migration exists: the people on
 * a project are NOT automatically the people in a recording. A researcher
 * ticks who was present, per recording, and changes it freely as an
 * interviewer team rotates through a study.
 *
 * `role` is stored here rather than read from `interview_people.kind` because
 * the same person can be in two roles across a study — a researcher who
 * moderates one session and observes another — and because the role is a fact
 * about the recording, which is exactly what this table is.
 */
create table if not exists public.interview_media_participants (
  media_id uuid not null references public.interview_media(id) on delete cascade,
  person_id uuid not null references public.interview_people(id) on delete cascade,

  role text not null default 'interviewer' check (role in (
    'interviewer', 'respondent', 'observer', 'interpreter', 'note_taker'
  )),

  /*
   * THE DIARIZATION SEAT, LEFT EMPTY ON PURPOSE.
   *
   * A provider that separates speakers returns anonymous labels — "Speaker 1",
   * "Speaker 2" — and mapping those to people is a judgement, not a fact. This
   * column holds the mapping once somebody has made it, and `confirmed_by`
   * records who. Null means "we do not know which voice this is", which is a
   * different claim from "this is speaker 1" and must stay expressible: §12 is
   * explicit that uncertainty is preserved rather than guessed away.
   */
  speaker_label text,
  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_at timestamptz,

  created_at timestamptz not null default now(),
  primary key (media_id, person_id)
);

create index if not exists interview_media_participants_person_idx
  on public.interview_media_participants (person_id);
/* "which recordings has this speaker label been mapped in" */
create index if not exists interview_media_participants_speaker_idx
  on public.interview_media_participants (media_id, speaker_label)
  where speaker_label is not null;

/* ==================================== the recording itself */

/*
 * TWO NEW KINDS, AND WHY NOT `interviewer_video`.
 *
 * A moderated recording is not "the interviewer's video" — it contains the
 * interviewer asking and the respondent answering, and often two interviewers.
 * Naming it after one participant would be the same mistake as naming it after
 * one response. `session_video` says what it is: a segment of a session, whose
 * occupants are in `interview_media_participants` where they belong.
 */
alter table public.interview_media drop constraint if exists interview_media_kind_check;
alter table public.interview_media
  add constraint interview_media_kind_check check (kind in (
    'answer_video', 'answer_audio', 'question_prompt', 'combined', 'export',
    'session_video', 'session_audio'
  ));

/* who pressed record — null for a candidate's own unattended answer */
alter table public.interview_media
  add column if not exists recorded_by uuid references public.profiles(id) on delete set null;

/*
 * A moderated recording belongs to a QUESTION but not necessarily to a
 * response row: there is no candidate-side response when the interviewer is
 * driving. `response_id` was already nullable; this records that the looseness
 * is now load-bearing rather than incidental.
 */
comment on column public.interview_media.response_id is
  'null for a moderated session recording, which is bound to a question rather than to a candidate response row';

/* ========================================== transcripts learn about speakers */

/*
 * `segments` already holds [{start,end,text}]. Diarization adds a speaker key
 * inside each segment, which jsonb accommodates without a migration — but two
 * facts about the transcript AS A WHOLE do need columns, because a query that
 * has to open the jsonb to learn whether diarization ran is a query nobody
 * writes.
 */
alter table public.interview_transcripts
  add column if not exists diarized boolean not null default false;
alter table public.interview_transcripts
  add column if not exists speaker_count integer check (speaker_count is null or speaker_count >= 0);

comment on column public.interview_transcripts.segments is
  'timings, and a speaker key when the provider diarized: [{start,end,text,speaker?}]. A speaker label is anonymous until interview_media_participants maps it to a person.';

/* ====================================================== reading it back */

/**
 * Everybody in one recording, ready to render.
 *
 * One function rather than a join every caller rewrites — and it returns the
 * person's ACCOUNT as well as their label, so a UI can show a real user
 * differently from a typed-in name without a second query.
 */
create or replace function public.rescript_interview_recording_participants(p_media uuid)
returns table (
  person_id uuid, display_name text, email text, role text,
  user_id uuid, derived boolean, speaker_label text
)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.display_name, p.email, mp.role, p.user_id, p.derived, mp.speaker_label
    from public.interview_media_participants mp
    join public.interview_people p on p.id = mp.person_id
   where mp.media_id = p_media
   order by
     case mp.role when 'interviewer' then 0 when 'respondent' then 1 else 2 end,
     p.display_name
$$;

/**
 * REPLACE A RECORDING'S PARTICIPANT LIST, IN ONE STATEMENT.
 *
 * The researcher's edit is "these are the people", not "add this one, remove
 * that one" — so the write is a replacement, and doing it as delete-then-
 * insert inside one function means a half-applied list cannot be observed.
 *
 * Rows are refused for people belonging to a different project. That check
 * lives here rather than in the API because it is the one that stops a
 * participant list leaking a name across projects (§18), and a check in one of
 * several routes is a check the next route forgets.
 *
 * `speaker_label` survives the replacement for anybody still on the list: a
 * researcher correcting who was present should not silently discard the
 * diarization mapping somebody else confirmed.
 */
create or replace function public.rescript_interview_set_participants(
  p_media uuid,
  p_people uuid[],
  p_roles text[],
  p_actor uuid default null
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  proj uuid; n integer; bad uuid;
begin
  select project_id into proj from public.interview_media where id = p_media;
  if proj is null then raise exception 'unknown recording %', p_media; end if;

  if p_people is null or array_length(p_people, 1) is null then
    delete from public.interview_media_participants where media_id = p_media;
    return 0;
  end if;

  if array_length(p_roles, 1) is distinct from array_length(p_people, 1) then
    raise exception 'each participant needs a role: % people, % roles',
      array_length(p_people, 1), array_length(p_roles, 1);
  end if;

  /* a person from another project is a leak, not a typo */
  select pe.id into bad
    from unnest(p_people) as want(id)
    join public.interview_people pe on pe.id = want.id
   where pe.project_id <> proj
   limit 1;
  if bad is not null then
    raise exception 'person % does not belong to this recording''s project', bad;
  end if;

  select count(*) into n from unnest(p_people) as want(id)
    where not exists (select 1 from public.interview_people pe where pe.id = want.id);
  if n > 0 then raise exception '% participant(s) do not exist', n; end if;

  /*
   * Upsert, then remove what is no longer listed — rather than delete-then-
   * insert. A row that survives the edit is UPDATED, so its `speaker_label`
   * and who confirmed it are kept without being copied anywhere: a researcher
   * correcting who was present must not silently discard a diarization
   * mapping somebody else made.
   */
  insert into public.interview_media_participants (media_id, person_id, role)
  select p_media, u.person, u.role
    from unnest(p_people, p_roles) as u(person, role)
  on conflict (media_id, person_id) do update set role = excluded.role;

  delete from public.interview_media_participants
   where media_id = p_media and person_id <> all (p_people);

  select count(*) into n from public.interview_media_participants where media_id = p_media;
  return n;
end $$;

/**
 * Map an anonymous speaker label to a person on this recording.
 *
 * Separate from `set_participants` because it is a different act by a
 * different person at a different time: the researcher says who was there
 * before anything is transcribed, and says which voice is which afterwards.
 * Passing null clears the mapping, which is how somebody withdraws a guess.
 */
create or replace function public.rescript_interview_map_speaker(
  p_media uuid, p_person uuid, p_label text, p_actor uuid default null
)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare hit integer;
begin
  update public.interview_media_participants
     set speaker_label = nullif(btrim(p_label), ''),
         confirmed_by = case when nullif(btrim(p_label), '') is null then null else p_actor end,
         confirmed_at = case when nullif(btrim(p_label), '') is null then null else now() end
   where media_id = p_media and person_id = p_person;
  get diagnostics hit = row_count;
  return hit > 0;
end $$;

/** Every recording one person appears in — the query a researcher asks constantly. */
create or replace function public.rescript_interview_person_recordings(p_person uuid)
returns table (
  media_id uuid, interview_id uuid, question_id uuid, kind text,
  role text, duration_seconds numeric, created_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.id, m.interview_id, m.question_id, m.kind,
         mp.role, m.duration_seconds, m.created_at
    from public.interview_media_participants mp
    join public.interview_media m on m.id = mp.media_id
   where mp.person_id = p_person
     and m.deleted_at is null
   order by m.created_at desc
$$;

/* ============================================================ permissions */

alter table public.interview_people enable row level security;
revoke all on table public.interview_people from public, anon, authenticated;
drop policy if exists interview_people_service_role_only on public.interview_people;
create policy interview_people_service_role_only on public.interview_people
  for all using (false) with check (false);

alter table public.interview_media_participants enable row level security;
revoke all on table public.interview_media_participants from public, anon, authenticated;
drop policy if exists interview_media_participants_service_role_only on public.interview_media_participants;
create policy interview_media_participants_service_role_only on public.interview_media_participants
  for all using (false) with check (false);

revoke all on function public.rescript_interview_recording_participants(uuid) from public, anon, authenticated;
revoke all on function public.rescript_interview_set_participants(uuid, uuid[], text[], uuid) from public, anon, authenticated;
revoke all on function public.rescript_interview_map_speaker(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.rescript_interview_person_recordings(uuid) from public, anon, authenticated;
