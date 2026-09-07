-- =====================================================================
-- 0016 — SENDING MAIL
--
-- The platform has never sent an email. Three flows worked around it, each
-- differently:
--
--   * PASSWORD RESET called `auth.resetPasswordForEmail` and swallowed the
--     failure, logging "is SMTP configured for this Supabase project?" — so
--     "a reset link is on its way" was, in fact, a lie. And `/reset` was an
--     honest placeholder that pointed back to sign-in, because the Studio
--     never holds a Supabase access token and so could not complete a reset
--     even if the mail had arrived.
--   * A PROJECT INVITATION returned `inviteUrl` for the inviter to pass on
--     by hand.
--   * A RESPONDENT INVITATION came out as a spreadsheet of links.
--
-- The last two are honest and stay as fallbacks. This migration adds the two
-- tables that let the platform send instead.
--
-- Why password reset moves OFF Supabase Auth's own email: accounts do live in
-- `auth.users` (`auth.admin.createUser`), so Supabase could send it — but
-- only with SMTP configured inside the Supabase project, on its own rate
-- limits, with its own templates, and landing on a page the Studio cannot
-- complete. One provider, one place to look when mail fails, and a reset
-- page that actually sets a password is worth a table.
-- =====================================================================

-- ---------------------------------------------------------------------
-- §1  Password reset tokens
--
-- The token is stored as a SHA-256 HASH and never in the clear. A reset
-- token is password-equivalent for its lifetime: whoever holds one can take
-- the account. A database dump must therefore not contain a set of live
-- account takeovers, which is exactly what a plaintext column would be.
-- (`project_invitations.token` is plaintext, from 0008. That is a smaller
-- exposure — an invitation grants a role on one project, not an account —
-- but it is worth revisiting; it is deliberately left alone here rather than
-- migrated under a mail change, because rewriting it would invalidate every
-- invitation currently in flight.)
--
-- One hour. Long enough to find the email, short enough that a link left in
-- an inbox is not a standing key. Single-use via `used_at`, and using one
-- invalidates every other outstanding reset for that account — a reset is a
-- statement that the old credential is not trusted, so a second link sitting
-- in an older email must not still work.
-- ---------------------------------------------------------------------
create table if not exists public.password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  /* denormalised so an expired row still says who it was for after the
     profile's address changes — a reset sent to an old address is exactly
     what somebody investigating an incident needs to see */
  email text not null,
  token_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 hour',
  used_at timestamptz,
  /* who asked, and who used it — the same hash the login throttle uses */
  requested_ip_hash text,
  used_ip_hash text
);

create unique index if not exists password_resets_token_key
  on public.password_resets (token_hash);

-- "is there a live reset for this account", and the throttle's window
create index if not exists password_resets_user_idx
  on public.password_resets (user_id, created_at desc);

alter table public.password_resets enable row level security;

/*
 * No policies at all, deliberately: only the service role touches this, the
 * way `respondents` and `responses` are handled (0001). There is no query a
 * signed-in user could run against it that they should be allowed to run —
 * including their own rows, since the hash is the only thing in here worth
 * having.
 */

comment on table public.password_resets is
  'Single-use password reset tokens, stored as SHA-256 hashes and valid for one hour. Service role only: no RLS policies, because the hash is the only interesting column and nobody should be able to read it.';

-- ---------------------------------------------------------------------
-- §2  What was actually sent
--
-- Three things this answers that nothing could answer before:
--
--   "did the invitation go?"      — the question asked when somebody says
--                                   they never got one, and the difference
--                                   between blaming the platform and
--                                   blaming a spam filter;
--   "don't send that twice"       — `dedupe_key` makes the respondent send
--                                   idempotent, so a double-click or a
--                                   retried request cannot mail 4 000 people
--                                   a second time. That is the failure this
--                                   table most exists to prevent;
--   "what did we send this list?" — a fieldwork record, per wave.
--
-- It stores no message BODY. The subject and the recipient are enough to
-- answer all three, and a table of rendered emails is a table of personal
-- links (a respondent invitation contains a working credential) sitting in
-- the database for ever.
-- ---------------------------------------------------------------------
create table if not exists public.mail_deliveries (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade,
  survey_id uuid references public.surveys(id) on delete cascade,
  kind text not null check (kind in (
    'password_reset', 'project_invitation', 'respondent_invitation', 'test'
  )),
  to_email text not null,
  subject text not null,
  provider text,
  /* the provider's own id, so a bounce in their dashboard can be traced back */
  provider_id text,
  status text not null default 'sent' check (status in ('sent', 'failed', 'suppressed')),
  /* why it did not go: a provider error, or the environment guard below */
  error text,
  /*
   * Idempotency. Set for anything that must not be sent twice — for a
   * respondent invitation it is the respondent id plus the send batch, so
   * re-running a wave skips whoever already has their link.
   */
  dedupe_key text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

/*
 * Unique only where a key was given, and only for mail that actually went:
 * a FAILED send must be retryable, or one provider hiccup would permanently
 * lock a respondent out of ever receiving their invitation.
 */
create unique index if not exists mail_deliveries_dedupe_key
  on public.mail_deliveries (dedupe_key)
  where dedupe_key is not null and status = 'sent';

create index if not exists mail_deliveries_survey_idx
  on public.mail_deliveries (survey_id, kind, created_at desc)
  where survey_id is not null;

create index if not exists mail_deliveries_recipient_idx
  on public.mail_deliveries (lower(to_email), created_at desc);

alter table public.mail_deliveries enable row level security;

/*
 * Members may read the delivery log for their own project — "did their
 * invitation go out" is a fieldwork question, not an administrative one.
 * Rows with no survey (a password reset, a platform test) are readable by
 * nobody through RLS; they are reached only by the service role.
 */
drop policy if exists mail_deliveries_member_read on public.mail_deliveries;
create policy mail_deliveries_member_read on public.mail_deliveries
  for select to authenticated
  using (
    survey_id is not null
    and (
      public.rescript_project_role(auth.uid(), survey_id) is not null
      or public.rescript_is_platform_admin(auth.uid())
    )
  );

grant select on public.mail_deliveries to authenticated;

comment on table public.mail_deliveries is
  'What the platform actually sent: recipient, subject, provider id and outcome. No message bodies — a respondent invitation contains a working credential. dedupe_key makes a bulk send idempotent, and is unique only for successful sends so a failure stays retryable.';

-- ---------------------------------------------------------------------
-- §3  Fieldwork's view of a send, per wave
--
-- The Distribution panel needs to know, before it offers to send, how many
-- of a wave have a live invitation already — otherwise "send this wave"
-- reads as "send it again" and nobody dares press it.
-- ---------------------------------------------------------------------
create or replace function public.rescript_invitation_sends(
  p_survey uuid,
  p_is_test boolean
)
returns table (
  list_name text,
  people bigint,
  emailed bigint,
  failed bigint,
  last_sent timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  /*
   * EXISTS rather than a left join, and that is not a style choice: joining
   * `mail_deliveries` fans out when one address has been mailed more than
   * once, and `people` would then count a respondent twice for having been
   * emailed twice. A wave of 400 would report 430 people, and the number
   * nobody can explain is the number nobody trusts.
   *
   * Matched on the ADDRESS, because that is what was mailed — a respondent
   * with no email cannot have been emailed and correctly counts as neither.
   */
  select
    coalesce(nullif(trim(r.list_name), ''), '(no list)') as list_name,
    count(*) as people,
    count(*) filter (where exists (
      select 1 from public.mail_deliveries d
      where d.survey_id = p_survey and d.kind = 'respondent_invitation'
        and d.status = 'sent' and r.email is not null
        and lower(d.to_email) = lower(r.email)
    )) as emailed,
    count(*) filter (where exists (
      select 1 from public.mail_deliveries f
      where f.survey_id = p_survey and f.kind = 'respondent_invitation'
        and f.status = 'failed' and r.email is not null
        and lower(f.to_email) = lower(r.email)
    ) and not exists (
      select 1 from public.mail_deliveries d2
      where d2.survey_id = p_survey and d2.kind = 'respondent_invitation'
        and d2.status = 'sent' and r.email is not null
        and lower(d2.to_email) = lower(r.email)
    )) as failed,
    (select max(d3.created_at) from public.mail_deliveries d3
      where d3.survey_id = p_survey and d3.kind = 'respondent_invitation'
        and d3.status = 'sent') as last_sent
  from public.respondents r
  where r.survey_id = p_survey
    and r.is_test = p_is_test
  group by 1
  order by 1;
$$;

comment on function public.rescript_invitation_sends(uuid, boolean) is
  'Per wave: how many people, how many have been emailed their link successfully, how many failed, and when the last one went. Lets the Distribution panel say "send the 11 who have not had one" instead of offering to re-send a whole list.';

grant execute on function public.rescript_invitation_sends(uuid, boolean) to authenticated, service_role;
