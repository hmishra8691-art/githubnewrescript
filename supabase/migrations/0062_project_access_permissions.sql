-- 0062 — Project collaborators & advanced access (2026-10-17,
-- docs/COLLABORATORS-ACCESS-2026-10-17.md)
--
-- WHAT THIS ADDS — all of it additive; no row is rewritten, no column narrowed:
--
--   1. project_members.permissions  jsonb   per-module access for role 'custom'
--                                           (read ONLY when role = 'custom'; a
--                                           fixed role means its row in
--                                           packages/access/src/roles.ts, as before)
--      project_members.expires_at   timestamptz  when the membership ends (null = never)
--   2. the role check widens to the five new roles: project_admin, viewer_data,
--      vendor, interviewer, custom. Every existing value stays valid and keeps
--      its meaning.
--   3. project_invitations carries what the accepted membership will be:
--      permissions, access_expires_at (distinct from expires_at, which is the
--      INVITATION link's own 14-day life), and resent_at / resend_count for
--      "Resend".
--   4. rescript_project_access: an EXPIRED membership answers no role, with
--      role_source 'expired' — exactly like a revoked one, it outranks the
--      workspace baseline, so a contractor whose access ended does not fall
--      through to the workspace's default `editor` (the 0034 lesson, again).
--      Everything that asks this function — the Studio guard, the project
--      list, rescript_project_role and every RLS policy built on it — stops
--      granting at the expiry instant, with no job to run.
--   5. Both acceptance paths (token: rescript_accept_invitation; email at
--      sign-in: rescript_claim_invitations) copy the invitation's permissions
--      and access expiry onto the membership, and re-grant a REVOKED or
--      EXPIRED row (the token path used to `do nothing` on a revoked row, so a
--      removed person who was invited back by link stayed removed).
--
-- WHAT THIS DELIBERATELY DOES NOT DO: interpret `permissions` in SQL. The
-- capability rules live in one place (packages/access, `can()`); the database
-- stores the grant and enforces the one predicate that is not a rule but a
-- clock — expiry. The RLS policies that name roles (0008: surveys update for
-- owner/editor/programmer; comments insert) are unchanged, so the new roles
-- get LESS through a direct authenticated connection, never more; nothing
-- connects that way today (0026), every Studio read and write goes through the
-- guarded service-role routes, where custom permissions are enforced.
--
-- DEPLOY ORDER: this file first, then the code. Old code keeps working on the
-- new schema (it never writes the new columns, never meets a new role because
-- only the new code grants them, and reads expiry through the access function).
-- New code before this file: reading the new columns fails soft (treated as no
-- permissions / no expiry), but GRANTING a custom role, an expiry or a new role
-- is refused by the database until this file is applied.
--
-- Re-runnable: `if not exists`, constraints dropped and re-added, functions
-- `create or replace` with unchanged signatures (grants are kept).
-- Undo (only once no row uses a new role):
--   update public.project_members set role = 'viewer' where role in ('project_admin','viewer_data','vendor','interviewer','custom');
--   then restore 0008's check and 0034's function bodies; the columns can stay.

begin;

-- ======================================================== 1. THE MEMBERSHIP

alter table public.project_members
  add column if not exists permissions jsonb,
  add column if not exists expires_at timestamptz;

comment on column public.project_members.permissions is
  'Per-module access for role custom: {"v":1,"modules":{"data":"view",...},"add":[cap],"remove":[cap]}. Interpreted only by packages/access (normalizePermissions / can); ignored for every other role.';
comment on column public.project_members.expires_at is
  'When this membership ends. rescript_project_access answers no role (source ''expired'') from this instant. Null = no expiry.';

alter table public.project_members drop constraint if exists project_members_role_check;
alter table public.project_members add constraint project_members_role_check
  check (role in ('editor', 'programmer', 'reviewer', 'viewer', 'test_user', 'deployment_manager',
                  'project_admin', 'viewer_data', 'vendor', 'interviewer', 'custom'));

alter table public.project_members drop constraint if exists project_members_permissions_check;
alter table public.project_members add constraint project_members_permissions_check
  check (permissions is null or jsonb_typeof(permissions) = 'object');

create index if not exists project_members_expiring_idx
  on public.project_members (survey_id, expires_at) where expires_at is not null and revoked_at is null;

-- ======================================================== 2. THE INVITATION

alter table public.project_invitations
  add column if not exists permissions jsonb,
  add column if not exists access_expires_at timestamptz,
  add column if not exists resent_at timestamptz,
  add column if not exists resend_count integer not null default 0;

comment on column public.project_invitations.access_expires_at is
  'When the MEMBERSHIP this invitation grants will end (copied to project_members.expires_at on acceptance). Not the invitation link''s own expiry, which is expires_at.';

/* NOT VALID: invitation rows were never checked before, and a historical row
   must not be able to stop this migration; every new write is checked */
alter table public.project_invitations drop constraint if exists project_invitations_role_check;
alter table public.project_invitations add constraint project_invitations_role_check
  check (role in ('editor', 'programmer', 'reviewer', 'viewer', 'test_user', 'deployment_manager',
                  'project_admin', 'viewer_data', 'vendor', 'interviewer', 'custom')) not valid;

alter table public.project_invitations drop constraint if exists project_invitations_permissions_check;
alter table public.project_invitations add constraint project_invitations_permissions_check
  check (permissions is null or jsonb_typeof(permissions) = 'object') not valid;

-- ======================================================== 3. ACCESS, WITH EXPIRY

/* 0034's function, with the one clause expiry needs. Precedence is unchanged:
     owner  >  explicit project_members row (live, revoked or EXPIRED)  >  workspace baseline */
create or replace function public.rescript_project_access(p_user uuid, p_survey uuid)
returns table (project_role text, role_source text)
language plpgsql stable security definer set search_path = public as $$
declare
  s_owner uuid;
  s_customer uuid;
  u_customer uuid;
  m public.project_members;
  ws_role text;
begin
  project_role := null; role_source := 'none';
  if p_user is null or p_survey is null then return next; return; end if;

  select sv.owner_id, sv.customer_id into s_owner, s_customer
    from public.surveys sv where sv.id = p_survey;
  if not found then return next; return; end if;

  if s_owner = p_user then
    project_role := 'owner'; role_source := 'owner'; return next; return;
  end if;

  select pm.* into m
    from public.project_members pm
   where pm.survey_id = p_survey and pm.user_id = p_user;
  if m.user_id is not null then
    if m.revoked_at is not null then
      /* removed on purpose: the workspace baseline does not get to undo it */
      role_source := 'revoked'; return next; return;
    end if;
    if m.expires_at is not null and m.expires_at <= now() then
      /* ended on schedule: the same rule — an explicit decision outranks the baseline */
      role_source := 'expired'; return next; return;
    end if;
    project_role := m.role; role_source := 'member'; return next; return;
  end if;

  select pr.customer_id into u_customer from public.profiles pr where pr.id = p_user;
  if s_customer is not null and u_customer is not null and s_customer = u_customer then
    ws_role := public.rescript_workspace_default_role(s_customer);
    if ws_role is not null then
      project_role := ws_role; role_source := 'workspace'; return next; return;
    end if;
  end if;

  return next;
end $$;

-- ======================================================== 4. ACCEPTING, WITH PERMISSIONS AND EXPIRY

/* 0017's token path. Same signature, same single-statement claim; the grant now
   carries the invitation's permissions and access expiry, and a revoked or
   expired row is granted again (it used to be left as it was). */
create or replace function public.rescript_accept_invitation(
  p_user uuid,
  p_token_hash text
)
returns table (invitation_id uuid, survey_id uuid, role text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  inv record;
begin
  if p_user is null or p_token_hash is null or length(p_token_hash) < 32 then
    return;
  end if;

  update public.project_invitations i
     set accepted_at = now(), accepted_by = p_user
   where i.token_hash = p_token_hash
     and i.accepted_at is null
     and i.revoked_at is null
     and i.expires_at > now()
  returning i.id, i.survey_id, i.role, i.invited_by, i.permissions, i.access_expires_at into inv;

  if not found then
    return;
  end if;

  insert into public.project_members (survey_id, user_id, role, added_by, permissions, expires_at)
  values (inv.survey_id, p_user, inv.role, inv.invited_by, inv.permissions, inv.access_expires_at)
  on conflict (survey_id, user_id) do update
    set role = excluded.role, permissions = excluded.permissions, expires_at = excluded.expires_at,
        revoked_at = null, revoked_by = null, added_by = excluded.added_by, updated_at = now()
    where project_members.revoked_at is not null
       or (project_members.expires_at is not null and project_members.expires_at <= now());

  insert into public.audit_logs (user_id, action, entity, entity_id, survey_id, detail)
  values (
    p_user, 'project.invitation_accepted', 'survey', inv.survey_id::text, inv.survey_id,
    jsonb_build_object('role', inv.role, 'invitationId', inv.id, 'via', 'token', 'expiresAt', inv.access_expires_at)
  );

  return query select inv.id, inv.survey_id, inv.role;
end $$;

/* 0034's email path, the same way. */
create or replace function public.rescript_claim_invitations(p_user uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0; em text; uc text;
begin
  select lower(email), user_code into em, uc from public.profiles where id = p_user;
  if em is null then return 0; end if;

  for r in
    select i.* from public.project_invitations i
    where i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
      and (lower(i.email) = em or (i.user_code is not null and i.user_code = uc))
  loop
    insert into public.project_members (survey_id, user_id, role, added_by, permissions, expires_at)
    values (r.survey_id, p_user, r.role, r.invited_by, r.permissions, r.access_expires_at)
    on conflict (survey_id, user_id) do update
      set role = excluded.role, permissions = excluded.permissions, expires_at = excluded.expires_at,
          revoked_at = null, revoked_by = null, updated_at = now()
      where project_members.revoked_at is not null
         or (project_members.expires_at is not null and project_members.expires_at <= now());

    update public.project_invitations
       set accepted_at = now(), accepted_by = p_user
     where id = r.id;

    insert into public.audit_logs (user_id, action, entity, entity_id, survey_id, detail)
    values (p_user, 'project.invitation_accepted', 'survey', r.survey_id::text, r.survey_id,
            jsonb_build_object('role', r.role, 'invitationId', r.id, 'expiresAt', r.access_expires_at));
    n := n + 1;
  end loop;
  return n;
end $$;

commit;
