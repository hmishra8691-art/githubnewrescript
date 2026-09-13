/*
 * NOTHING IN `public` IS REACHABLE WITH THE ANON KEY.
 *
 * ## What was wrong
 *
 * Every function Postgres creates carries a default `EXECUTE` grant to
 * PUBLIC. Sixty-three of ours are `SECURITY DEFINER`, which means they run as
 * their owner and RLS does not apply to what they touch. PUBLIC includes
 * `anon`, and the anon key is published to every browser by design. So the
 * whole RPC surface — not the parts anyone chose to expose, all of it — was
 * callable by anybody who opened the network tab:
 *
 *     POST /rest/v1/rpc/<name>   apikey: <the anon key everyone has>
 *
 * Three of those are worth naming, because they are not hygiene:
 *
 *   · `rescript_login(p_user, …)` inserts an ACTIVE row in `user_sessions`
 *     for whatever user id it is handed and RETURNS the new session id. The
 *     session cookie IS that id (`setSessionCookie` in `lib/authServer.ts`
 *     stores it verbatim, `sessionIdFrom` reads it back). A caller with the
 *     anon key and a user's uuid could mint themselves a session as that
 *     user, with no password — and `p_force => true` revokes the victim's
 *     real session on the way past. That is a complete authentication
 *     bypass.
 *   · `rescript_delete_project(p_survey_id)` deletes a survey, and the
 *     cascade takes its versions, responses and respondents with it.
 *   · `rescript_purge_responses` / `rescript_soft_delete_responses` /
 *     `rescript_import_responses` / `rescript_update_response` rewrite
 *     collected data.
 *
 * The 0025 migration closed the same hole for the five billing functions it
 * added, after Supabase's linter caught it. This closes it for the other
 * sixty-eight, and for the reason 0025 gives: revoking `anon` and
 * `authenticated` alone is not enough, because the grant is to PUBLIC.
 *
 * ## Why revoking breaks nothing
 *
 * Every database call in this product is made server-side with
 * `SUPABASE_SERVICE_ROLE_KEY` — `supabaseAdmin()` in both apps,
 * `supabaseService()` in the Studio, and the billing store. There is no
 * browser-side Supabase client anywhere in the repo; the one use of the anon
 * key is `supabaseAuthClient()`, which calls `signInWithPassword` against
 * GoTrue and never touches PostgREST. `service_role` keeps its grant, so
 * every existing call site is untouched.
 *
 * Trigger functions are revoked too. Postgres checks `EXECUTE` when the
 * trigger is CREATED, not when it fires, so the eleven triggers below keep
 * working. `rescript_on_auth_user_created` fires as `supabase_auth_admin` on
 * `auth.users` during signup, and is granted to that role explicitly rather
 * than left to depend on that rule.
 *
 * ## The four that keep `authenticated`
 *
 * `current_customer_id`, `current_role`, `rescript_is_platform_admin` and
 * `rescript_project_role` are called from inside RLS policies — thirty-odd of
 * them. A policy expression runs as the QUERYING role, so revoking these
 * would turn every policy into a permission error rather than a decision.
 * Nothing queries as `authenticated` today, but the policies are the safety
 * net for the day something does, and a safety net that throws is not one.
 * They keep `authenticated` and lose `anon`: they read nothing an
 * authenticated caller cannot already establish about itself.
 *
 * ## search_path
 *
 * Eleven functions had none. For a `SECURITY DEFINER` function that is the
 * classic escalation — the caller creates `pg_temp.surveys`, calls the
 * function, and the function's unqualified references resolve to the
 * caller's table while running as the owner. `pg_temp` is named LAST rather
 * than left out, because leaving it out still lets a temporary table shadow a
 * real one for table lookups.
 *
 * ## The eight tables with RLS on and no policy
 *
 * RLS with no policy already denies everything to `anon` and `authenticated`
 * (`service_role` bypasses RLS, which is how the apps reach them). That is
 * the correct posture here and the policies below say so out loud, so that
 * "this table has no policy" is never again read as an oversight to be fixed
 * by adding a permissive one. `login_attempts` and `password_resets` are the
 * two where that would matter most.
 */

/* ------------------------------------------------------------ functions */

revoke all on function public.current_customer_id() from public, anon, authenticated;
revoke all on function public."current_role"() from public, anon, authenticated;
revoke all on function public.increment_quota_counts(p_survey_id uuid, p_cells jsonb, p_test boolean) from public, anon, authenticated;
revoke all on function public.rescript_accept_invitation(p_user uuid, p_token_hash text) from public, anon, authenticated;
revoke all on function public.rescript_access_policy(p_customer uuid) from public, anon, authenticated;
revoke all on function public.rescript_acquire_lock(p_survey uuid, p_user uuid, p_session uuid, p_stale_seconds integer, p_max_hold_seconds integer, p_section text) from public, anon, authenticated;
revoke all on function public.rescript_active_sessions(p_stale_seconds integer) from public, anon, authenticated;
revoke all on function public.rescript_allocate_listfill(p_survey uuid, p_test boolean, p_list_fill text, p_session text, p_preference jsonb, p_count integer, p_use_completed boolean, p_version text) from public, anon, authenticated;
revoke all on function public.rescript_assign_respondent_code() from public, anon, authenticated;
revoke all on function public.rescript_billing_immutable() from public, anon, authenticated;
revoke all on function public.rescript_billing_state(p_balance numeric, p_current text, p_read_only_threshold numeric) from public, anon, authenticated;
revoke all on function public.rescript_billing_transfer_guard() from public, anon, authenticated;
revoke all on function public.rescript_bump_response_revision() from public, anon, authenticated;
revoke all on function public.rescript_claim_invitations(p_user uuid) from public, anon, authenticated;
revoke all on function public.rescript_claim_listfill_slot(p_survey uuid, p_test boolean, p_list_fill text, p_option text, p_max integer, p_use_completed boolean) from public, anon, authenticated;
revoke all on function public.rescript_complete_listfill(p_survey uuid, p_session text) from public, anon, authenticated;
revoke all on function public.rescript_delete_project(p_survey_id uuid) from public, anon, authenticated;
revoke all on function public.rescript_end_session(p_session uuid, p_reason text, p_by uuid) from public, anon, authenticated;
revoke all on function public.rescript_expire_locks(p_stale_seconds integer) from public, anon, authenticated;
revoke all on function public.rescript_expire_sessions(p_user uuid, p_stale_seconds integer, p_absolute_seconds integer) from public, anon, authenticated;
revoke all on function public.rescript_field_positions(p_survey uuid, p_is_test boolean, p_active_seconds integer) from public, anon, authenticated;
revoke all on function public.rescript_field_pulse(p_survey uuid, p_is_test boolean, p_active_seconds integer, p_window_minutes integer) from public, anon, authenticated;
revoke all on function public.rescript_field_timeline(p_survey uuid, p_is_test boolean, p_bucket text, p_from timestamp with time zone, p_to timestamp with time zone, p_tz text) from public, anon, authenticated;
revoke all on function public.rescript_finalize_version(p_survey_id uuid, p_version_id uuid, p_base_revision bigint) from public, anon, authenticated;
revoke all on function public.rescript_force_release_lock(p_survey uuid, p_by uuid, p_reason text) from public, anon, authenticated;
revoke all on function public.rescript_heartbeat_lock(p_survey uuid, p_session uuid, p_max_hold_seconds integer, p_section text) from public, anon, authenticated;
revoke all on function public.rescript_import_responses(p_survey uuid, p_version uuid, p_test boolean, p_mode text, p_rows jsonb, p_by text) from public, anon, authenticated;
revoke all on function public.rescript_invitation_sends(p_survey uuid, p_is_test boolean) from public, anon, authenticated;
revoke all on function public.rescript_is_platform_admin(p_user uuid) from public, anon, authenticated;
revoke all on function public.rescript_listfill_status(p_survey uuid, p_test boolean) from public, anon, authenticated;
revoke all on function public.rescript_lock_for(p_survey uuid) from public, anon, authenticated;
revoke all on function public.rescript_login(p_user uuid, p_stale_seconds integer, p_absolute_seconds integer, p_lifetime_seconds integer, p_force boolean, p_user_agent text, p_ip_hash text, p_device_label text) from public, anon, authenticated;
revoke all on function public.rescript_login_failures(p_identifier text, p_ip_hash text, p_window_seconds integer) from public, anon, authenticated;
revoke all on function public.rescript_my_projects(p_user uuid, p_lock_stale_seconds integer) from public, anon, authenticated;
revoke all on function public.rescript_next_respondent_code(p_survey uuid, p_test boolean) from public, anon, authenticated;
revoke all on function public.rescript_next_user_code() from public, anon, authenticated;
revoke all on function public.rescript_on_auth_user_created() from public, anon, authenticated;
revoke all on function public.rescript_project_access(p_user uuid, p_survey uuid) from public, anon, authenticated;
revoke all on function public.rescript_project_config(p_surveys uuid[]) from public, anon, authenticated;
revoke all on function public.rescript_project_members(p_survey uuid, p_present_within_seconds integer) from public, anon, authenticated;
revoke all on function public.rescript_project_presence(p_survey uuid, p_within_seconds integer) from public, anon, authenticated;
revoke all on function public.rescript_project_role(p_user uuid, p_survey uuid) from public, anon, authenticated;
revoke all on function public.rescript_purge_responses(p_survey uuid, p_ids uuid[], p_by text) from public, anon, authenticated;
revoke all on function public.rescript_purge_telemetry(p_survey_id uuid, p_days integer) from public, anon, authenticated;
revoke all on function public.rescript_quality_summary(p_survey_id uuid, p_is_test boolean) from public, anon, authenticated;
revoke all on function public.rescript_question_count(def jsonb) from public, anon, authenticated;
revoke all on function public.rescript_record_share_access(p_share uuid, p_event text, p_user uuid, p_email text, p_ip_hash text, p_agent text) from public, anon, authenticated;
revoke all on function public.rescript_recount_listfill(p_survey uuid, p_test boolean) from public, anon, authenticated;
revoke all on function public.rescript_release_listfill(p_survey uuid, p_session text) from public, anon, authenticated;
revoke all on function public.rescript_release_listfill_on_delete() from public, anon, authenticated;
revoke all on function public.rescript_release_lock(p_survey uuid, p_session uuid, p_reason text) from public, anon, authenticated;
revoke all on function public.rescript_release_session_locks(p_session uuid, p_reason text) from public, anon, authenticated;
revoke all on function public.rescript_replace_quota_counts(p_survey uuid, p_test boolean, p_cells jsonb) from public, anon, authenticated;
revoke all on function public.rescript_resolve_share(p_token text) from public, anon, authenticated;
revoke all on function public.rescript_resolve_share_variants(p_token text) from public, anon, authenticated;
revoke all on function public.rescript_respondent_stats(p_survey uuid, p_is_test boolean) from public, anon, authenticated;
revoke all on function public.rescript_restore_responses(p_survey uuid, p_ids uuid[], p_by text) from public, anon, authenticated;
revoke all on function public.rescript_save_draft(p_survey_id uuid, p_definition jsonb, p_base_revision bigint, p_base_version_id uuid, p_title text) from public, anon, authenticated;
revoke all on function public.rescript_soft_delete_responses(p_survey uuid, p_ids uuid[], p_by text, p_reason text) from public, anon, authenticated;
revoke all on function public.rescript_source_stats(p_survey uuid, p_is_test boolean) from public, anon, authenticated;
revoke all on function public.rescript_test_suite(p_survey uuid) from public, anon, authenticated;
revoke all on function public.rescript_touch_presence(p_survey uuid, p_session uuid, p_user uuid, p_activity text) from public, anon, authenticated;
revoke all on function public.rescript_touch_report_template() from public, anon, authenticated;
revoke all on function public.rescript_touch_respondent() from public, anon, authenticated;
revoke all on function public.rescript_touch_session(p_session uuid, p_stale_seconds integer, p_absolute_seconds integer) from public, anon, authenticated;
revoke all on function public.rescript_touch_test_case() from public, anon, authenticated;
revoke all on function public.rescript_update_response(p_id uuid, p_expected_revision integer, p_answers jsonb, p_calculated jsonb, p_changes jsonb, p_by text, p_reason text) from public, anon, authenticated;
revoke all on function public.rescript_versions_are_immutable() from public, anon, authenticated;
revoke all on function public.rescript_workspace_default_role(p_customer uuid) from public, anon, authenticated;
revoke all on function public.survey_dashboard_stats() from public, anon, authenticated;
revoke all on function public.survey_publish_state(p_survey_id uuid) from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

/*
 * The RLS policy helpers. Revoked from PUBLIC and `anon` above, handed back
 * to `authenticated` here, because thirty-odd policies call them as the
 * querying role.
 */
grant execute on function public.current_customer_id() to authenticated;
grant execute on function public."current_role"() to authenticated;
grant execute on function public.rescript_is_platform_admin(p_user uuid) to authenticated;
grant execute on function public.rescript_project_role(p_user uuid, p_survey uuid) to authenticated;

/*
 * Signup. The trigger on `auth.users` fires as `supabase_auth_admin`; the
 * grant is explicit so this does not rest on Postgres checking EXECUTE at
 * CREATE TRIGGER time rather than at fire time.
 */
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function public.rescript_on_auth_user_created() to supabase_auth_admin';
  end if;
end $$;

/* ------------------------------------------------------------ search_path */

alter function public.rescript_billing_immutable() set search_path = public, pg_temp;
alter function public.rescript_billing_state(p_balance numeric, p_current text, p_read_only_threshold numeric) set search_path = public, pg_temp;
alter function public.rescript_billing_transfer_guard() set search_path = public, pg_temp;
alter function public.rescript_bump_response_revision() set search_path = public, pg_temp;
alter function public.rescript_purge_telemetry(p_survey_id uuid, p_days integer) set search_path = public, pg_temp;
alter function public.rescript_quality_summary(p_survey_id uuid, p_is_test boolean) set search_path = public, pg_temp;
alter function public.rescript_question_count(def jsonb) set search_path = public, pg_temp;
alter function public.rescript_touch_report_template() set search_path = public, pg_temp;
alter function public.rescript_touch_respondent() set search_path = public, pg_temp;
alter function public.rescript_touch_test_case() set search_path = public, pg_temp;
alter function public.touch_updated_at() set search_path = public, pg_temp;

/* ------------------------------------------------------------ RLS intent */

/*
 * Deny-all, said out loud. `service_role` bypasses RLS and is how the apps
 * read these; nothing else has any business in them. Written as one policy
 * per table rather than a loop so that granting access to one later is a
 * one-line diff against a named thing.
 */
drop policy if exists listfill_allocations_service_role_only on public.listfill_allocations;
create policy listfill_allocations_service_role_only on public.listfill_allocations
  as permissive for all to public using (false) with check (false);

drop policy if exists listfill_counts_service_role_only on public.listfill_counts;
create policy listfill_counts_service_role_only on public.listfill_counts
  as permissive for all to public using (false) with check (false);

drop policy if exists login_attempts_service_role_only on public.login_attempts;
create policy login_attempts_service_role_only on public.login_attempts
  as permissive for all to public using (false) with check (false);

drop policy if exists password_resets_service_role_only on public.password_resets;
create policy password_resets_service_role_only on public.password_resets
  as permissive for all to public using (false) with check (false);

drop policy if exists quality_profiles_service_role_only on public.quality_profiles;
create policy quality_profiles_service_role_only on public.quality_profiles
  as permissive for all to public using (false) with check (false);

drop policy if exists response_counters_service_role_only on public.response_counters;
create policy response_counters_service_role_only on public.response_counters
  as permissive for all to public using (false) with check (false);

drop policy if exists response_edits_service_role_only on public.response_edits;
create policy response_edits_service_role_only on public.response_edits
  as permissive for all to public using (false) with check (false);

drop policy if exists response_reviews_service_role_only on public.response_reviews;
create policy response_reviews_service_role_only on public.response_reviews
  as permissive for all to public using (false) with check (false);

comment on policy login_attempts_service_role_only on public.login_attempts is
  'Deliberate deny-all. Throttling evidence; readable only through the service role.';
comment on policy password_resets_service_role_only on public.password_resets is
  'Deliberate deny-all. Reset tokens; readable only through the service role.';
