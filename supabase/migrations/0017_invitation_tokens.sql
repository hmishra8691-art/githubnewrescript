-- =====================================================================
-- 0017 — THE INVITATION TOKEN, MADE REAL AND STORED AS A HASH
--
-- `project_invitations.token` has been in the schema since 0008, in
-- plaintext, described in `share/route.ts` as: "The token is what links
-- account creation to this grant (§22). It is unguessable and single-use, so
-- knowing an email address is not enough to inherit access."
--
-- None of that was happening.
--
-- The token is generated, put in the `?invite=` link, stored — and read by
-- NOTHING. `signup/page.tsx` calls `Boolean(searchParams.get("invite"))` to
-- change a sentence of copy and throws the value away. The grant is made by
-- `rescript_claim_invitations(p_user)`, which matches on the account's EMAIL
-- ADDRESS or user code, never on the token.
--
-- So the actual model is "whoever creates an account with that address gets
-- the grant", and nothing in this platform verifies an email address at
-- signup. An invitation to a client's finance director is claimable by
-- anyone who signs up as them. The audit recorded this as "the token is
-- plaintext", which undersells it: a plaintext token that nothing reads is
-- not a weak credential, it is a missing one.
--
-- WHAT THIS MIGRATION DOES
--
--   * stores the token as a SHA-256 hash and stops storing the token, so the
--     table is no longer a list of working credentials. Hashed in the
--     application, exactly as `password_resets` is (0016) — pgcrypto lives in
--     the `extensions` schema here, and one hashing convention beats two.
--
--   * adds `rescript_accept_invitation(p_user, p_token_hash)`: presenting the
--     token grants THAT invitation. A second door rather than a widening of
--     `rescript_claim_invitations`, whose return type live code depends on.
--
--   * leaves the email path alone. Sign-in still claims invitations waiting
--     for an address, so an invitation sent before signup still takes effect
--     the moment the person arrives (§22) and nobody who has already been
--     invited is stranded by this migration.
--
-- WHAT IT DOES NOT DO, SAID PLAINLY
--
-- The email path remains as strong as the address is, and the address is not
-- verified. This migration makes the token a real credential and takes the
-- plaintext out of the database; it does not make email verification exist.
-- That is its own feature — a confirmation mail, a pending state, a resend —
-- and pretending otherwise in a commit message would be worse than leaving
-- the note. Until it exists, the strong path is the link.
--
-- Safe on an empty table and on a populated one: existing rows keep their
-- plaintext token and their email path, and are simply never matched by the
-- new function until they are re-sent.
-- =====================================================================

-- ------------------------------------------------------------ the column
alter table public.project_invitations
  add column if not exists token_hash text;

comment on column public.project_invitations.token_hash is
  'SHA-256 of the invitation token, hashed in the application. The token itself is never stored: the row must not be a working credential.';

/*
 * The token was NOT NULL from 0008. It has to stop being required before the
 * application can stop writing it, and the column stays rather than being
 * dropped: rows written before this migration still hold theirs, and dropping
 * a column is the one schema change that cannot be undone by writing more SQL.
 */
alter table public.project_invitations
  alter column token drop not null;

comment on column public.project_invitations.token is
  'DEPRECATED (0017): plaintext token, written only by builds before 0017. New invitations store token_hash and leave this null.';

-- ------------------------------------------------------------- the indexes
/*
 * The old unique index on the plaintext token is kept: it still holds for the
 * rows that have one, and NULLs do not conflict in a unique index, so new
 * rows pass it freely. Adding the same guarantee for the hash is what matters.
 */
create unique index if not exists project_invitations_token_hash_key
  on public.project_invitations (token_hash)
  where token_hash is not null;

/*
 * Finding a live invitation by its hash is the hot path for the accept
 * function, and it is the only query that runs before anybody is
 * authenticated — so it gets its own partial index rather than relying on the
 * unique one above.
 */
create index if not exists project_invitations_live_hash_idx
  on public.project_invitations (token_hash)
  where token_hash is not null and accepted_at is null and revoked_at is null;

-- ------------------------------------------------------- accept by token
/**
 * ACCEPT ONE INVITATION, PROVEN BY ITS TOKEN.
 *
 * The strong path, and the one the emailed link now takes. Three properties
 * are worth stating because each is a way this goes wrong:
 *
 * 1. IT DOES NOT CARE WHICH ADDRESS THE ACCOUNT USES. The token is the
 *    credential; requiring the account's email to match the invited address
 *    as well would break the ordinary case of a person who signs up with
 *    their real address after being invited at an alias — and it would add no
 *    security, because the address is not verified and the token already is
 *    proof of receipt.
 *
 * 2. IT IS SINGLE-USE, in the same statement that reads it. The UPDATE's
 *    WHERE clause carries the whole condition — unaccepted, unrevoked,
 *    unexpired — so two simultaneous accepts cannot both win: the second
 *    updates zero rows and returns nothing. A read-then-write would race.
 *
 * 3. IT IS SECURITY DEFINER AND TAKES A HASH, NEVER A TOKEN. The caller has
 *    already hashed it, so the token does not travel into the database, does
 *    not appear in `pg_stat_statements`, and does not sit in a log.
 *
 * Returns the row it granted so the caller can say which project was joined,
 * and nothing at all when the token is unknown, spent, revoked or expired —
 * one indistinguishable answer, because telling a stranger which of those it
 * was tells them whether the invitation exists.
 */
create or replace function public.rescript_accept_invitation(
  p_user uuid,
  p_token_hash text
)
returns table (invitation_id uuid, survey_id uuid, role text)
language plpgsql
security definer
set search_path = public
as $$
/*
 * `use_column` is not decoration — without it this function does not work.
 *
 * `returns table (invitation_id, survey_id, role)` declares OUT parameters
 * called `survey_id` and `role`, and `project_members` has columns of exactly
 * those names. The `on conflict (survey_id, user_id)` clause below is then
 * ambiguous, and plpgsql's default is to raise rather than guess — which it
 * does at RUN TIME, on the first real invitation, not when the migration is
 * applied. (It did: the scratch proof caught it on assertion 3.)
 *
 * The alternative was renaming the returned columns to avoid the collision,
 * which would have meant `project_id` for something this schema calls
 * `survey_id` everywhere else. One pragma is cheaper than one inconsistency.
 */
#variable_conflict use_column
declare
  inv record;
begin
  if p_user is null or p_token_hash is null or length(p_token_hash) < 32 then
    return;
  end if;

  /* claim and read in one statement — see property 2 above */
  update public.project_invitations i
     set accepted_at = now(), accepted_by = p_user
   where i.token_hash = p_token_hash
     and i.accepted_at is null
     and i.revoked_at is null
     and i.expires_at > now()
  returning i.id, i.survey_id, i.role, i.invited_by into inv;

  /*
   * `FOUND` rather than `inv is null`: a record whose every field is null
   * also satisfies `is null`, so testing the record would conflate "no such
   * token" with a row that somehow held nulls. FOUND is set by the UPDATE
   * itself and means exactly what is being asked.
   */
  if not found then
    return;
  end if;

  insert into public.project_members (survey_id, user_id, role, added_by)
  values (inv.survey_id, p_user, inv.role, inv.invited_by)
  on conflict (survey_id, user_id) do nothing;

  insert into public.audit_logs (user_id, action, entity, entity_id, survey_id, detail)
  values (
    p_user, 'project.invitation_accepted', 'survey', inv.survey_id::text, inv.survey_id,
    jsonb_build_object('role', inv.role, 'invitationId', inv.id, 'via', 'token')
  );

  return query select inv.id, inv.survey_id, inv.role;
end $$;

comment on function public.rescript_accept_invitation(uuid, text) is
  'Accept one project invitation by its token hash (§22). Single-use in one statement; returns nothing for an unknown, spent, revoked or expired token.';

revoke all on function public.rescript_accept_invitation(uuid, text) from public;
grant execute on function public.rescript_accept_invitation(uuid, text) to authenticated, service_role;
