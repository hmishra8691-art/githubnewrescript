-- 0071 — live human-moderated sessions and multi-party video (focus groups / IDIs) (2026-10-22, engineer G2).
--
-- A live session is run in the browser: the moderator from the Studio, participants from their own join link in the
-- respondent app, silent observers in a "back room" participants never see. Media flows browser to browser (built-in
-- mesh WebRTC) or through an SFU when one is configured; NOTHING here stores media — recordings are ordinary
-- media_objects (kind qual_recording, private bucket) made by each person's own browser, with consent.
--
--   live_rooms          one scheduled session: the state (status, settings, the guide's consent / stimuli / sections
--                       snapshot, the stage, the moderation log), a version (compare-and-set) and a rev (bumped on
--                       any change, so long-polls wake), the qual session / transcript it became
--   live_room_invites   participant slots and observer links: label, e-mail, segment, status (pending / joined /
--                       no_show / revoked), the link version, and the SHA-256 of the link's token (the token is
--                       derived by the Studio from a server secret; it is never stored)
--   live_room_members   who is in the room: role, handle (P1 … / Moderator / Observer n), state (waiting / admitted /
--                       left / removed / denied), recording consent, media state, the SHA-256 of their member token
--   live_room_signals   WebRTC connection messages (offer / answer / candidate / meta / bye) between two members;
--                       they live two minutes (expires_at) and are swept by rescript_live_sweep()
--   live_room_notes     the back room: moderator ↔ observer chat and observers' timestamped notes
--   live_room_tracks    each recorded chunk (member, audio / video, sequence, start on the server clock, the media
--                       object, its per-chunk transcript) — merged by time into one qual transcript on Finalize
--
-- Access: the Studio's routes decide (lib/qual/qualAccess.ts: run = Data edit, observe = Data view); the respondent
-- app's routes check a member token. Both write with the service role. RLS is the backstop: roles that read responses
-- may SELECT rooms, notes, tracks and members (members WITHOUT the token hash); invites (e-mail addresses, token
-- hashes) and signals have no member policy at all. Nobody writes but the service role.
--
-- Re-runnable: `if not exists`, `create or replace`, `drop … if exists` first. Touches no earlier table's
-- constraints (a live transcript is qual_transcripts source 'stt', format 'stt', meta.origin 'live_session').
-- Undo (destroys this data):
--   drop function if exists public.rescript_live_touch(uuid), public.rescript_live_save(uuid, jsonb, integer),
--     public.rescript_live_poll(uuid, uuid, bigint), public.rescript_live_sweep(timestamptz),
--     public.rescript_live_claim_track(uuid, timestamptz, timestamptz);
--   drop table if exists public.live_room_tracks, public.live_room_notes, public.live_room_signals,
--     public.live_room_members, public.live_room_invites, public.live_rooms;

/* ------------------------------------------------------------ rooms */

create table if not exists public.live_rooms (
  id               uuid primary key default gen_random_uuid(),
  survey_id        uuid not null references public.surveys(id) on delete cascade,
  customer_id      uuid references public.customers(id) on delete cascade,
  title            text not null check (length(title) between 1 and 200),
  kind             text not null default 'focus_group' check (kind in ('focus_group', 'interview')),
  status           text not null default 'scheduled' check (status in ('scheduled', 'open', 'live', 'ended', 'cancelled')),
  scheduled_at     timestamptz,
  time_zone        text check (time_zone is null or length(time_zone) <= 64),
  -- LiveRoomState (packages/analytics live/room.ts)
  state            jsonb not null check (jsonb_typeof(state) = 'object'),
  version          integer not null default 0 check (version >= 0),
  rev              bigint not null default 0 check (rev >= 0),
  qual_session_id  uuid references public.qual_sessions(id) on delete set null,
  transcript_id    uuid references public.qual_transcripts(id) on delete set null,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists live_rooms_survey_idx on public.live_rooms (survey_id, scheduled_at);
drop trigger if exists live_rooms_touch on public.live_rooms;
create trigger live_rooms_touch before update on public.live_rooms for each row execute function public.touch_updated_at();

/* ------------------------------------------------------------ invitations (participant slots, observer links) */

create table if not exists public.live_room_invites (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.live_rooms(id) on delete cascade,
  survey_id     uuid not null references public.surveys(id) on delete cascade,
  role          text not null default 'participant' check (role in ('participant', 'observer')),
  label         text check (label is null or length(label) <= 120),
  email         text check (email is null or (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+$')),
  segment       text check (segment is null or length(segment) <= 120),
  status        text not null default 'pending' check (status in ('pending', 'joined', 'no_show', 'revoked')),
  link_version  integer not null default 1 check (link_version >= 1),
  -- sha-256 of the link's token; the token is derived from a server secret and never stored
  token_hash    text not null unique check (length(token_hash) = 64),
  member_id     uuid,
  invited_at    timestamptz,
  reminded_at   timestamptz,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index if not exists live_room_invites_room_idx on public.live_room_invites (room_id, created_at);

/* ------------------------------------------------------------ members */

create table if not exists public.live_room_members (
  id                  uuid primary key default gen_random_uuid(),
  room_id             uuid not null references public.live_rooms(id) on delete cascade,
  survey_id           uuid not null references public.surveys(id) on delete cascade,
  role                text not null check (role in ('moderator', 'participant', 'observer')),
  handle              text not null check (handle ~ '^(P[0-9]{1,3}|Moderator|Observer [0-9]{1,3})$'),
  -- the invite's label or the staff member's name: shown to the moderator and observers only
  label               text check (label is null or length(label) <= 120),
  segment             text check (segment is null or length(segment) <= 120),
  state               text not null default 'waiting' check (state in ('waiting', 'admitted', 'left', 'removed', 'denied')),
  invite_id           uuid references public.live_room_invites(id) on delete set null,
  user_id             uuid,
  -- sha-256 of the member token held by one browser tab; rotated on every (re)join
  token_hash          text not null unique check (length(token_hash) = 64),
  recording_consent   boolean not null default false,
  consent_at          timestamptz,
  media               jsonb not null default '{}'::jsonb check (jsonb_typeof(media) = 'object'),
  muted_by_moderator  boolean not null default false,
  device              jsonb check (device is null or jsonb_typeof(device) = 'object'),
  joined_at           timestamptz not null default now(),
  last_seen_at        timestamptz,
  unique (room_id, handle)
);
create index if not exists live_room_members_room_idx on public.live_room_members (room_id);
alter table public.live_room_invites drop constraint if exists live_room_invites_member_fk;
alter table public.live_room_invites add constraint live_room_invites_member_fk foreign key (member_id) references public.live_room_members(id) on delete set null;

/* ------------------------------------------------------------ signalling (two-minute messages) */

create table if not exists public.live_room_signals (
  id           bigserial primary key,
  room_id      uuid not null references public.live_rooms(id) on delete cascade,
  from_member  uuid not null references public.live_room_members(id) on delete cascade,
  to_member    uuid not null references public.live_room_members(id) on delete cascade,
  type         text not null check (type in ('offer', 'answer', 'candidate', 'meta', 'bye')),
  payload      jsonb,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  check (from_member <> to_member)
);
create index if not exists live_room_signals_to_idx on public.live_room_signals (to_member, id);
create index if not exists live_room_signals_expiry_idx on public.live_room_signals (expires_at);

/* ------------------------------------------------------------ the back room */

create table if not exists public.live_room_notes (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid not null references public.live_rooms(id) on delete cascade,
  survey_id       uuid not null references public.surveys(id) on delete cascade,
  member_id       uuid references public.live_room_members(id) on delete set null,
  kind            text not null check (kind in ('chat', 'note')),
  author          text not null check (length(author) between 1 and 120),
  text            text not null check (length(text) between 1 and 2000),
  -- seconds from the session's start (null before it started)
  offset_seconds  integer check (offset_seconds is null or offset_seconds >= 0),
  created_at      timestamptz not null default now()
);
create index if not exists live_room_notes_room_idx on public.live_room_notes (room_id, created_at);

/* ------------------------------------------------------------ recorded chunks */

create table if not exists public.live_room_tracks (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.live_rooms(id) on delete cascade,
  survey_id    uuid not null references public.surveys(id) on delete cascade,
  member_id    uuid not null references public.live_room_members(id) on delete cascade,
  kind         text not null check (kind in ('audio', 'video')),
  seq          integer not null check (seq >= 0),
  -- the chunk's start on the server's clock (epoch ms) and its length
  start_ms     bigint not null check (start_ms > 0),
  duration_ms  integer not null default 0 check (duration_ms >= 0),
  media_id     uuid references public.media_objects(id) on delete set null,
  mime_type    text,
  bytes        bigint,
  status       text not null default 'uploading' check (status in ('uploading', 'stored', 'transcribing', 'transcribed', 'failed', 'empty')),
  -- { text, segments: [{ start, end, text }], model, language } of this chunk alone
  transcript   jsonb check (transcript is null or jsonb_typeof(transcript) = 'object'),
  error        text,
  lease_until  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (room_id, member_id, kind, seq)
);
create index if not exists live_room_tracks_room_idx on public.live_room_tracks (room_id, status);
drop trigger if exists live_room_tracks_touch on public.live_room_tracks;
create trigger live_room_tracks_touch before update on public.live_room_tracks for each row execute function public.touch_updated_at();

/* ------------------------------------------------------------ functions (service role only) */

-- something about the room changed: wake the long-polls
create or replace function public.rescript_live_touch(p_room uuid) returns bigint
language sql security definer set search_path = public as $$
  update public.live_rooms set rev = rev + 1 where id = p_room returning rev;
$$;

-- compare-and-set the room's state; false when someone else wrote first
create or replace function public.rescript_live_save(p_room uuid, p_state jsonb, p_expected integer) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.live_rooms
     set state = p_state, status = coalesce(p_state->>'status', status), version = version + 1, rev = rev + 1
   where id = p_room and version = p_expected;
  return found;
end $$;

-- one long-poll step: the room's rev and the signals to this member after a cursor (one round trip)
create or replace function public.rescript_live_poll(p_room uuid, p_member uuid, p_after bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'rev', coalesce((select rev from public.live_rooms where id = p_room), 0),
    'signals', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'from', s.from_member, 'to', s.to_member, 'type', s.type, 'payload', s.payload, 'at', s.created_at) order by s.id)
                           from (select * from public.live_room_signals
                                  where room_id = p_room and to_member = p_member and id > coalesce(p_after, 0) and expires_at > now()
                                  order by id limit 500) s), '[]'::jsonb));
$$;

-- TTL cleanup of signalling messages
create or replace function public.rescript_live_sweep(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.live_room_signals where expires_at <= coalesce(p_now, now());
  get diagnostics n = row_count;
  return n;
end $$;

-- one transcriber per chunk at a time
create or replace function public.rescript_live_claim_track(p_track uuid, p_now timestamptz, p_until timestamptz) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.live_room_tracks set lease_until = p_until
   where id = p_track and (lease_until is null or lease_until <= p_now);
  return found;
end $$;

revoke all on function public.rescript_live_touch(uuid) from public, anon, authenticated;
revoke all on function public.rescript_live_save(uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.rescript_live_poll(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.rescript_live_sweep(timestamptz) from public, anon, authenticated;
revoke all on function public.rescript_live_claim_track(uuid, timestamptz, timestamptz) from public, anon, authenticated;

/* ------------------------------------------------------------ RLS: the backstop */

alter table public.live_rooms         enable row level security;
alter table public.live_room_invites  enable row level security;
alter table public.live_room_members  enable row level security;
alter table public.live_room_signals  enable row level security;
alter table public.live_room_notes    enable row level security;
alter table public.live_room_tracks   enable row level security;

-- the same roles as 0065 / 0070 (those whose capability table holds `responses.read`); `custom` fails closed
do $$
declare t text;
begin
  foreach t in array array['live_rooms', 'live_room_members', 'live_room_notes', 'live_room_tracks'] loop
    execute format('drop policy if exists %I on public.%I', t || '_data_read', t);
    execute format($p$create policy %I on public.%I for select to authenticated using (
      public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
      or public.rescript_is_platform_admin(auth.uid()))$p$, t || '_data_read', t);
  end loop;
end $$;
-- live_room_invites (e-mail addresses, link hashes) and live_room_signals: no member policy — service role only

-- token hashes are never readable through the API, even by members (a column revoke does not override a table
-- grant, so the table grant is replaced by a column list)
revoke all on public.live_rooms, public.live_room_invites, public.live_room_members, public.live_room_signals,
  public.live_room_notes, public.live_room_tracks from anon;
revoke select on public.live_room_members from authenticated;
grant select (id, room_id, survey_id, role, handle, label, segment, state, invite_id, user_id, recording_consent, consent_at,
  media, muted_by_moderator, device, joined_at, last_seen_at) on public.live_room_members to authenticated;

comment on table public.live_rooms is 'Live human-moderated sessions (0071): scheduled rooms run in the browser (built-in mesh WebRTC or an SFU). Media is never stored here.';
comment on table public.live_room_invites is 'Participant slots and observer links of live sessions: the SHA-256 of each link token (derived from a server secret, never stored). Service role only.';
comment on table public.live_room_members is 'People in a live session: a handle (P1 …), never a name shown to other participants; the SHA-256 of their member token (not selectable by members).';
comment on table public.live_room_signals is 'WebRTC signalling messages between two members of a live session; two-minute TTL (rescript_live_sweep). Service role only.';
comment on table public.live_room_tracks is 'Recorded chunks of a live session (each person''s own audio / video, with consent) and their per-chunk transcripts.';
