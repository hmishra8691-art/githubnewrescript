# Nothing in `public` is reachable with the anon key

Migration `0026_least_privilege.sql`. Applied to `gouxrdjpiejuliucqwoy`.

## The finding

Supabase's security linter reported 146 things. One of them was an
authentication bypass.

Every function Postgres creates carries a default `EXECUTE` grant to `PUBLIC`.
Sixty-three of ours are `SECURITY DEFINER`, so they run as their owner and RLS
does not apply to what they touch. `PUBLIC` includes `anon`, and the anon key
is published to every browser by design. The entire RPC surface was therefore
callable by anyone:

```
POST /rest/v1/rpc/<name>    apikey: <the anon key everybody has>
```

Three of those are not hygiene items.

**`rescript_login(p_user, …)`.** It inserts an `active` row into
`user_sessions` for whatever user id it is handed, and returns the new session
id. The session cookie *is* that id — `setSessionCookie` in
`apps/studio/lib/authServer.ts` stores it verbatim and `sessionIdFrom` reads it
straight back, on the reasoning that the value "identifies a row and grants
nothing on its own". That reasoning was sound and the grant broke it: a caller
with the anon key and a user's uuid could mint a session as that user with no
password, and `p_force => true` revoked the victim's real session on the way
past. Complete authentication bypass, gated only on knowing a uuid.

**`rescript_delete_project(p_survey_id)`.** Deletes a survey; the cascade takes
its versions, responses and respondents.

**`rescript_purge_responses` / `rescript_soft_delete_responses` /
`rescript_import_responses` / `rescript_update_response`.** Rewrite collected
data.

The 0025 migration closed exactly this hole for the five billing functions it
added, after the linter caught it, and wrote down why revoking `anon` and
`authenticated` alone is not enough. The other sixty-eight functions predated
that lesson.

## Why revoking breaks nothing

Every database call in the product is made server-side with
`SUPABASE_SERVICE_ROLE_KEY`:

| factory | file | key |
|---|---|---|
| `supabaseAdmin()` | `apps/runtime/lib/admin.ts`, `apps/studio/lib/admin.ts` | service role |
| `supabaseService()` | `apps/studio/lib/authServer.ts` | service role |
| billing store | `packages/billing/src/store-supabase.ts` | service role |
| `supabaseAuthClient()` | `apps/studio/lib/authServer.ts` | anon — **GoTrue only** |

Every `.rpc(` call site in the repo is inside `app/api/**/route.ts` or
`lib/*.ts`. There is no browser-side Supabase client anywhere. The one use of
the anon key calls `signInWithPassword` and never touches PostgREST. The
browser holds an httpOnly opaque cookie, never a GoTrue JWT — so nothing, ever,
queries this database as `authenticated` either.

`service_role` keeps its grant. No call site changed.

## The four exceptions

`current_customer_id`, `current_role`, `rescript_is_platform_admin` and
`rescript_project_role` keep `EXECUTE` for `authenticated` (not `anon`).

Thirty-odd RLS policies call them. A policy expression runs as the *querying*
role, so revoking them would turn every policy into a permission error rather
than a decision. They cannot become `SECURITY INVOKER` either: they read
`profiles` and `project_members`, which are themselves under RLS, and a policy
helper that re-enters RLS recurses.

They are the four findings the linter still reports, and the report is correct
as far as it goes: a signed-in caller could use them as an oracle — "is user U
a platform admin", "what role does user U hold on survey S" — given both
uuids. Nobody can hold an `authenticated` JWT today. The clean fix, if
client-side auth is ever added, is to move these four into a `private` schema
that PostgREST does not expose and repoint the policies; that means recreating
every policy that names them, which is a larger change than this pass and
buys nothing while no such caller exists.

## Trigger functions

Revoked too. Postgres checks `EXECUTE` when a trigger is *created*, not when it
fires, so the eleven triggers keep working. `rescript_on_auth_user_created`
fires as `supabase_auth_admin` on `auth.users` during signup and is granted to
that role explicitly rather than left resting on that rule.

## search_path

Eleven functions had none. For a `SECURITY DEFINER` function that is the
classic escalation: the caller creates `pg_temp.surveys`, calls the function,
and its unqualified references resolve to the caller's table while running as
the owner. All eleven are now `public, pg_temp` — `pg_temp` named **last**,
because leaving it out entirely still lets a temporary table shadow a real one
for table lookups (it is only function and operator lookups that skip an
unnamed `pg_temp`).

The sixty-odd functions that already had `search_path=public` are left alone;
they are not flagged and churning them would obscure this diff. New functions
should use `public, pg_temp`.

## The eight tables with RLS on and no policy

`listfill_allocations`, `listfill_counts`, `login_attempts`,
`password_resets`, `quality_profiles`, `response_counters`, `response_edits`,
`response_reviews`.

RLS with no policy already denies everything to `anon` and `authenticated`;
`service_role` bypasses RLS, which is how the apps reach them. That is the
correct posture, so each now carries an explicit `using (false)` policy that
says so out loud. The point is not to change behaviour — it is that "this
table has no policy" should never again read as an oversight somebody fixes by
adding a permissive one. `login_attempts` and `password_resets` are the two
where that would have mattered most, and they carry a comment saying why.

## Verified

Run as each role against the live database after applying:

| check | result |
|---|---|
| `anon` → any function in `public` | 0 executable |
| `anon` → `rescript_login`, `rescript_delete_project` | denied |
| `authenticated` → functions | the 4 RLS helpers only |
| `authenticated` → `rescript_save_draft` | denied |
| `service_role` → functions | all 88, unchanged |
| `service_role` → `login_attempts` | reads, RLS bypassed |
| signup trigger grant | present |
| functions with no `search_path` | 0 |
| public tables with no policy | 0 |

Linter: 146 findings → 5. Four are the RLS helpers above. The fifth is leaked
password protection.

## The rule for new functions

This bug has now been found twice — 0025 closed it for five functions, 0026
for sixty-eight more — because `CREATE FUNCTION` grants to `PUBLIC` silently
and nothing in the repo notices. So, for every migration that adds a function
to `public`:

```sql
revoke all on function public.<name>(<identity args>) from public, anon, authenticated;
```

`from public` is the part that matters; revoking `anon, authenticated` alone
leaves the default `PUBLIC` grant standing, which is precisely how sixty-eight
functions stayed open. Then run the security advisors — that linter is what
caught this both times, and it is the control that actually works. Prefer
`SECURITY INVOKER` where the function does not need to cross RLS, and set
`search_path = public, pg_temp` on everything.

## Still open: leaked password protection

Not fixable by migration — it is an Auth setting, not SQL. Supabase Auth can
check new passwords against HaveIBeenPwned; it is off. Turn it on in the
dashboard under Authentication → Policies (password settings). See
<https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection>.

## Scope of the exposure

The hole was live, not theoretical. The installation currently holds 9
profiles, 12 surveys and 53 responses, all created since 1 September — the
team's own data, pre-launch. That is a reason this is being closed before
launch rather than after a breach; it is not evidence that nobody called those
endpoints. Nothing here audited the access logs, and if that matters,
Supabase's API logs for `/rest/v1/rpc/rescript_login` are where to look.
