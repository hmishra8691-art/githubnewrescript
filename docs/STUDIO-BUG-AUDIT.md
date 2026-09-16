# Rescript Studio — bug audit

Five parallel read-only audits (auth and route guards, builder state, billing,
response data and analytics, collaboration and admin), then every reported
finding re-read against the source and, where it could be, executed. Anything
that did not survive that second pass is not here.

Each finding carries the file and line, the failure in one sentence, and how it
was verified. Ranked by severity: what breaks, how likely it is to be hit, and
whether the user can tell it happened.

---

## Tier 1 — broken in normal use

### 1. Every email invitation fails, and the owner is told the opposite

`apps/studio/app/api/surveys/[id]/share/route.ts:199`, error mapped at `:203`

```ts
{ onConflict: "survey_id,email" }
...
if (/duplicate|unique/i.test(error.message)) return … "That address has already been invited…" (409)
```

The only matching index is `project_invitations_pending_key` on
`(survey_id, lower(email))` **where** `accepted_at is null and revoked_at is
null and email is not null` (`supabase/migrations/0008_auth_collaboration.sql:481`).
It is partial *and* on an expression, so Postgres cannot infer it for
`ON CONFLICT (survey_id, email)`.

**Verified by execution** against PostgreSQL 16:

```
ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification
```

That message contains "unique", so the regex on `:203` converts a hard schema
error into a 409. Inviting a colleague who has never been invited returns
"That address has already been invited to this project." No row is written, no
token is minted, no mail is sent. The invite-an-outsider path does not work at
all, and the message actively misdirects whoever is debugging it.

*Fix shape:* `on_conflict` cannot name a partial expression index — either add a
plain unique constraint, or do the select-then-insert-or-update explicitly. And
the 409 should be raised from a checked precondition, never inferred from the
text of a database error.

### 2. Removing a collaborator can *promote* them

`apps/studio/app/api/surveys/[id]/members/route.ts:181`

```ts
await db.from("project_members").delete().eq("survey_id", params.id).eq("user_id", targetId);
```

`rescript_project_access` (`0009_session_persistence_fixes.sql:127-139`) falls
through a missing member row to the workspace baseline, and
`rescript_workspace_default_role` returns `'editor'` when nothing is configured
(`0009:77-79`, matching `DEFAULT_WORKSPACE_ACCESS`). Deleting the row therefore
returns a same-workspace colleague to the workspace default instead of removing
them.

The owner removes a **viewer**; the API answers `ok`, the panel drops them, they
are emailed "your access was removed" — and on their next request they resolve
to **editor**, can take the edit lock and rewrite the questionnaire. Removing an
unwanted editor is a no-op. Only installations that have explicitly set the
workspace default to `none` are safe, and that is not the default.

### 3. A reversal can be replayed for unlimited credit

`packages/billing/src/meter.ts:368`

```ts
const input: UsageEventInput = { ...original, quantity: neg(original.quantity), … };
```

`...original` carries `idempotencyKey`, and `rescript_billing_insert_usage`
(`0031_billing_subject.sql:546-549`) returns the existing row when the key
matches. So for any event with a key — `interview-stt:${mediaId}`,
`interview-analysis:…` — no reversal row is written: `store.record` gets the
*original* back. `record`'s replay guard (`0031:486`) correctly skips the
counter-debit, but `meter.reverse` then credits `original.customerCharge`
unconditionally (`meter.ts:377`), and `original.adjustsEventId` is still null,
so the route's "already reversed" check never trips. Pressing **Reverse** in
admin billing five times credits five times for one charge.

### 4. A retried settle debits the wallet twice

`supabase/migrations/0031_billing_subject.sql:417-423`

```sql
e := public.rescript_billing_insert_usage(p_event, r.id);   -- may return the EXISTING event
update public.project_wallets set … balance = balance - charge, total_used = total_used + charge
```

`rescript_billing_record` was given an explicit "a replayed event already has a
ledger line" guard (`0031:486-487`). `settle` was not — and settle is the path
every charge above zero actually takes. A job that transcribes, settles
`interview-stt:m1`, then fails and retries produces **one** `usage_events` row
and **two** `wallet_ledger` debits. The comment claiming a retried settle is a
no-op is true of the event and false of the money.

### 5. Reservations are never expired, so wallets slowly lock up

`packages/billing/src/store-supabase.ts:240` (`expireReservations`) has **no
caller anywhere** in `apps/` or `supabase/`. It exists at every layer — store,
`Meter` interface (`meter.ts:128`), SQL function
(`0023_billing.sql:359`) — and nothing calls it. The only scheduled job is
`/api/cron/media-delivery` (`apps/studio/vercel.json`).

`reservationTtlMinutes` is stored on each row and documented as "released back
to the wallet"; nothing releases it. Any handler killed between `reserve` and
`settle` — a function timeout on a long TTS or transcription, an instance
recycle, a deploy mid-request — leaves the hold `held` for ever. Fifty
abandoned $0.50 holds on a $25 wallet make `available` zero: spending and
transfers are refused while the balance still visibly reads $25.

### 6. AI endpoints bill a phantom meter when `surveyId` is omitted

`apps/studio/lib/metering.ts:146`

```ts
const id = typeof surveyId === "string" && surveyId.trim() ? surveyId.trim() : null;
if (isSandboxProject(id)) return { ctx: …, meter: getSandboxMeter() };   // isSandboxProject(null) === true
```

Callers pass the body field straight through:
`ai/rephrase/route.ts:35`, `ai/translate/route.ts:41`, `ai/tts/route.ts:26`.
Omit `surveyId` and the reservation goes to a process-local in-memory meter
seeded with 100 credits while the *real* provider is called with the
installation's key. No wallet is debited, no project permission is checked
(`requireProjectFor` is on the other branch), and a frozen or empty wallet never
returns 402/423. Any signed-in account — including a `viewer` who may edit
nothing — can translate and synthesise indefinitely on the operator's spend.

---

## Tier 2 — wrong data, or wrong access, in ordinary use

### 7. An editor can change other people's roles

`apps/studio/app/api/surveys/[id]/share/route.ts:125` is gated on
`project.share`, which `editor` holds (`packages/access/src/roles.ts:155`), and
upserts `project_members` with `onConflict: "survey_id,user_id"` — an **update**
of an existing member's role. Role changes are supposed to require
`project.manage_members`, which only `owner` holds
(`members/route.ts:91`, `roles.ts:241`). The owner demotes a contractor to
viewer; any editor re-POSTs them as editor and the demotion is undone, audited
only as `project.shared`. `GRANTABLE_ROLES` excludes `owner`, so the ceiling is
editor — it is privilege *restoration*, not full takeover.

### 8. Cross-tenant write and read of workspace analytics themes

`apps/studio/app/api/surveys/[id]/analytics/[[...path]]/route.ts:526`

```ts
if (!cur || (cur.survey_id && cur.survey_id !== surveyId)) return bad("Unknown item.", 404);
…
const { data } = await db.from(coll.table).update(patch).eq("id", itemId).select("*").single();
```

`analytics_themes.survey_id` is **nullable** (`0011_analytics.sql:91`; every
other collection table is `not null`) and a workspace theme is stored with
`survey_id: null`. So `cur.survey_id && …` short-circuits to false, the row is
accepted whatever its `customer_id`, and the update is by `id` alone through the
service-role client, which RLS does not backstop. The response returns the whole
row, so it is a read as well as a write. The sibling DELETE at `:631` *does*
carry `.or(survey_id.eq.…,customer_id.eq.…)`, which is what the PUT should have.
Exploitation needs the theme's uuid, which is the only thing limiting it.

### 9. The response export is unbounded and silently truncated

`apps/studio/app/api/surveys/[id]/responses/route.ts:110`

```ts
let { data: resp, error: qerr } = (await query.order("started_at")) as …;
```

No `.range()` loop. Every other bulk reader in the codebase chunks — 
`lib/analytics.ts:50-62` and `lib/responseData.ts:214-226` both page at 1000 and
stop on a short chunk — which is proof the pattern is known here. PostgREST caps
at `db-max-rows` and returns **200 OK**, so a 4,000-complete study exports 1,000
rows under the right filename with the right header and no warning anywhere.
Where the cap is not set, the same line instead loads every response with its
full answer payload into one function's memory.

### 10. `include=all` mixes TEST and LIVE, and nothing in the file says which is which

`apps/studio/app/api/surveys/[id]/responses/route.ts:108`

```ts
if (include === "live") query = query.eq("is_test", false);
else if (include === "test") query = query.eq("is_test", true);
```

With `all`, neither branch runs. Neither exporter emits an environment marker:
`packages/exporters/src/csv.ts:30` `SYSTEM_COLUMNS` is
`RESP_ID, SESSION_ID, SURVEY_VERSION, START_TIME, STATUS`, and the quality
exporter's header is built the same way; only the JSON branch carries `isTest`.
`components/studio/DataPanel.tsx` offers "All" as a plain button beside the CSV
and XLSX links. Sixty pilot interviews leave in the same file as real fieldwork
with no column that distinguishes them.

### 11. The Quality dashboard counts binned responses

`apps/studio/app/api/surveys/[id]/quality/route.ts:92-99` — no
`.is("deleted_at", null)`. Every other reader has one (`lib/responseData.ts:167`,
`lib/analytics.ts:51`) and so does the database's own `rescript_quality_summary`
(`0006_response_management.sql:318`). The researcher bins 40 CRITICAL
responses; the Data tab drops to 960 while the Quality tab still reports 1,000
assessed and 40 CRITICAL — the same screen that offered the bin action never
shows it took effect. The `.limit(20000)` on the same query truncates the same
way finding 9 does.

### 12. "Clean" means two different things in the export and in analytics

`apps/studio/lib/analytics.ts:26` omits `review_status` from `COLUMNS`
altogether, and `:56` filters `quality.is.null,quality->>classification.eq.CLEAN`.
The export's rule is different: `packages/exporters/src/responseQuality.ts:62-70`
excludes anything marked `REMOVE` and admits anything marked `KEEP`. The
researcher's own REMOVE/KEEP decisions are honoured by the file they deliver and
ignored by every crosstab, NPS and report deck in the Analytics module. Two
deliverables from one study that disagree, with nothing on screen explaining it.

---

## Tier 3 — real, narrower

### 13. Cutting a version discards whatever was typed during the request

`apps/studio/components/studio/Studio.tsx:437` → `store.tsx:601-607`.
`markSaved` unconditionally clears the pending autosave timer and sets
`{kind: "clean"}`. The version body was built from `defRef.current` *before* the
POST, and the versions route nulls `draft_definition` server-side. Keystrokes
landing during the round trip schedule an autosave that `markSaved` then
cancels. The header reads "All changes saved", the `beforeunload` guard stays
silent, and closing the tab loses the edits.

### 14. A failed quota save undoes the *previous* edit

`apps/studio/components/studio/QuotaDashboard.tsx:197`

```ts
const ok = await s.flushDraft();
if (!ok) { s.undo(); …
```

`undo()` reads `past` from the render-time context value (`store.tsx:571`),
unlike every other store method, which deliberately goes through a ref. The
`s.update()` two lines earlier pushed a new entry the awaited `s` cannot see. If
the draft PUT fails, `undo()` restores the state from before the *preceding*
edit and `touched()` schedules an autosave of it — so a failed quota save can
overwrite an already-saved question edit. If the quota change is the session's
first edit, `past` is empty and `undo()` is a no-op: the change stays on screen
under a message saying it was not applied.

### 15. "Lock project" does not stop sharing or publishing

`apps/studio/lib/guard.ts:288`

```ts
const WRITE_CAPABILITIES = new Set<Capability>([
  "survey.edit", "survey.save_version", "responses.manage", "deploy.manage",
]);
```

The comment two lines above says a frozen project "refuses every write, whatever
the role". The set omits `project.share`, `project.manage_members`,
`analytics.edit`, `analytics.publish`, `comment.create` and `project.clone`. An
owner freezes a study; an editor can still add an outside collaborator to it and
still publish a public analytics link from it. (`project.lock_settings` is
excluded deliberately and documented — an owner must be able to unlock.)

### 16. TURF counts "never asked" as "did not choose"

`packages/analytics/src/analyses/business.ts:193`

```ts
const cols = items.map((v) => numericColumn(ds, v).map((x) => (x != null && x > 0 ? 1 : 0)));
```

with `W = n`, the whole sample. A respondent routed past the question has `null`
for the item, is folded into the zero bucket, and still counts in the
denominator. `frequencies` (`stats/descriptive.ts:90-102`) correctly bases on
the valid count, so the same battery reports two different reaches. Awareness
asked only to 600 category users of 1,000 completes: the frequencies table says
75%, TURF says 45%.

### 17. Login lockout budget is doubled by the second identifier

`apps/studio/app/api/auth/login/route.ts:75` counts failures against
`rawIdentifier`, the literal string typed, while `findAccount`
(`lib/authServer.ts:311-313`) resolves either the email or the user code to the
same account. So `a@b.com` and `USR-10001` are two counters for one account: 16
guesses per window instead of 8. The per-source counter defaults to 25 and does
not bind first, and `profiles.locked_until` — the other arm of `decideThrottle` —
is read and cleared but never written anywhere in the repository.

---

## Checked and found sound

Worth recording, so the next audit does not re-tread it.

- Every `app/api/surveys/[id]/**` handler gates with a capability, and nested-id
  routes (`data/[responseId]`, `quality/[sessionId]`, `versions/[versionId]`,
  `media/*`, `comments`) re-scope the child row by `survey_id`. No IDOR found
  there, and no UI-only permission.
- Sessions: `requireUser` re-reads the session row uncached per request;
  sign-out, password change and account disable all revoke server-side; cookies
  are `httpOnly` + `sameSite=lax` + `secure` in production.
- `/api/platform` reports presence only and reduces `SUPABASE_URL` to its project
  reference — no value of any variable is emitted, and the production gate runs
  before any env read.
- Password reset: CSPRNG token, hash-only storage, single-use, revokes all
  sessions, never logged. `packages/mail` escapes every interpolation.
- `/api/share/[token]` and `/d/[id]`: hashed 32-byte tokens, expiry checked
  against the clock, revocation enforced in SQL, snapshot-only.
- Billing arithmetic: `money6` / `sumMoney` / `priceOperation` sum in micro-units
  with no float accumulation; `rescript_billing_transfer` locks in a fixed order
  and re-checks under the lock; `decideCreditRequest` is atomic.
- Every `usageToSpec` in `apps/studio`, `apps/runtime` and `apps/interviews`
  branches on `kind` before pricing — the known past failure has not recurred.
- The draft PUT's conditional RPC write, its 409/501/422 discrimination, and its
  refusal to open on an unparseable draft rather than falling back to blank.
- `packages/exporters/src/csv.ts` header/row alignment: both are built from the
  same de-duplicated `varNames`, so a deleted question cannot shift a column.
- `lib/responseData.ts` and `lib/quotaRecount.ts`: environment is a required
  parameter, soft-deletes excluded, scans chunked.
