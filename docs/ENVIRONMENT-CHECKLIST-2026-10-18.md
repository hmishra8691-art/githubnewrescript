# Environment checklist (2026-10-18)

Every environment variable the apps read, found by searching `process.env.*` (and `env.X` in the functions that take an environment) across `apps/` and `packages/`, excluding tests and build output. Use it with `.env.example` (the commented template) and `/platform` (what a running Studio has set).

**Values never appear here, on `/platform`, or in any API response.** Only names and "set / not set".

## How to read the table

**Where.** Each variable is set in one or more of these places:

- **Vercel: Studio / Runtime / Interviews.** The Vercel project's Environment Variables, per app. Set them for each environment (Production, Preview) you deploy.
- **Local.** `apps/<app>/.env.local`, copied from `.env.example`.
- **Supabase secrets.** No variable is read from Supabase secrets today: there are no Edge Functions (`supabase/` holds migrations only). Supabase provides the values of `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`, which are set in Vercel.

**Change.** What a change needs before it takes effect:

- **Redeploy.** Vercel reads server variables when a deployment starts. A change applies to the next deployment, so redeploy.
- **Rebuild.** `NEXT_PUBLIC_*` values are inlined into the browser bundle at build time. A change needs a new build (a redeploy on Vercel); a restart is not enough.
- **Restart.** Locally, restart `next dev` after editing `.env.local`.

**Required.**

- **Critical:** the app or a core feature does not work without it.
- **Required for X:** feature X is off without it, and `/platform` says so.
- **Optional:** a default applies.

## 1. Platform and URLs

| Variable | Apps | Purpose | Required | Placeholder | Where | Change |
|---|---|---|---|---|---|---|
| `RESCRIPT_ENV` | Studio | Deployment tier: `development`, `staging` or `production`. Drives the banner and the diagnostics gate | Strongly recommended (inferred from `NODE_ENV` otherwise) | `production` | Vercel Studio | Redeploy |
| `RESCRIPT_RELEASE` | Studio | Release shown on `/platform` (falls back to `VERCEL_GIT_COMMIT_SHA`) | Optional | `2026.10.18` | Vercel Studio | Redeploy |
| `VERCEL_GIT_COMMIT_SHA` | Studio | Set by Vercel automatically | Automatic | — | Vercel (system) | — |
| `NODE_ENV` | all | Set by Next.js | Automatic | — | — | — |
| `NEXT_PUBLIC_RUNTIME_URL` | Studio | Base URL of every respondent link, test link and QR code | Critical in deployment | `https://survey.example.com` | Vercel Studio | **Rebuild** |
| `STUDIO_PUBLIC_URL` | Studio | Absolute base for emailed links (resets, invitations) | Required for email links | `https://studio.example.com` | Vercel Studio | Redeploy |
| `NEXT_PUBLIC_SITE_URL` | Studio | Base URL for `robots.txt` and `sitemap.xml` | Optional | `https://studio.example.com` | Vercel Studio | **Rebuild** |
| `NEXT_PUBLIC_INTERVIEWS_URL` | Studio | Link to the Interviews app | Optional (needs `AUTH_HANDOFF_ORIGINS`) | `https://interviews.example.com` | Vercel Studio | **Rebuild** |
| `AUTH_HANDOFF_ORIGINS` | Studio | Exact origins allowed to receive a sign-in handoff | Required with Interviews | `https://interviews.example.com` | Vercel Studio | Redeploy |
| `INTERVIEWS_PUBLIC_URL` | Interviews | Interviews' own origin; must match the Studio's handoff entry | Required for Interviews | `https://interviews.example.com` | Vercel Interviews | Redeploy |
| `NEXT_PUBLIC_STUDIO_URL` | Interviews | Where Interviews sends people to sign in | Required for Interviews | `https://studio.example.com` | Vercel Interviews | **Rebuild** |
| `RESCRIPT_DIAGNOSTICS` | Studio | `1` lets every project member read per-project diagnostics (a warning in production) | Optional, off | `1` | Vercel Studio | Redeploy |
| `NEXT_DIST_DIR` | Studio, Interviews | Alternative build directory (test harness only) | Optional | `.next-test` | Local | Restart |

## 2. Database

| Variable | Apps | Purpose | Required | Placeholder | Where | Change |
|---|---|---|---|---|---|---|
| `SUPABASE_URL` | Studio, Runtime, Interviews | Supabase project URL | **Critical** | `https://<ref>.supabase.co` | Vercel (all three) | Redeploy |
| `SUPABASE_SERVICE_ROLE_KEY` | Studio, Runtime, Interviews | Server-only service role key | **Critical** | `<service_role key>` | Vercel (all three) | Redeploy |
| `SUPABASE_ANON_KEY` | Studio | Password exchange at sign-in | Required (falls back to the service key, with a warning) | `<anon key>` | Vercel Studio | Redeploy |

## 3. Security, salts and jobs

| Variable | Apps | Purpose | Required | Placeholder | Where | Change |
|---|---|---|---|---|---|---|
| `AUTH_HASH_SALT` | Studio | Salt for IP hashes (throttling, sessions) | Recommended | `<random 32+ chars>` | Vercel Studio | Redeploy |
| `QUALITY_HASH_SALT` | Studio, Runtime | Salt for respondent and device hashes. **Must be the same value in both apps** | Required for duplicate detection | `<random 32+ chars>` | Vercel Studio + Runtime | Redeploy both |
| `CRON_SECRET` | Studio, Interviews | Shared secret for Vercel Cron. Unset means every scheduled job refuses to run | Required for scheduled jobs | `<random 32+ chars>` | Vercel Studio + Interviews | Redeploy |
| `AI_CREDENTIAL_KEY` | Studio | Seals users' own AI keys (bring your own key, BYOK) in the vault | Required for BYOK (otherwise `vault_unavailable`) | `<32-byte key, base64>` | Vercel Studio | Redeploy |
| `AI_CREDENTIAL_KEY_PREVIOUS` | Studio | The previous vault key, during rotation | Optional | `<old key>` | Vercel Studio | Redeploy |
| `AI_BYOK_ALLOW_PRIVATE_ENDPOINTS` | Studio | `1` lets users' own endpoints be private or LAN hosts | Optional, off | `1` | Vercel Studio | Redeploy |
| `RUNTIME_SERVER_VALIDATION` | Runtime | Replays saved pages: `off`, `log` or `enforce` | Optional (`off`) | `log` | Vercel Runtime | Redeploy |

## 4. Language model (Intelligent Mode, copilot, probes, classification)

| Variable | Apps | Purpose | Required | Placeholder | Where | Change |
|---|---|---|---|---|---|---|
| `AI_API_URL` | Studio, Runtime, Interviews | OpenAI-compatible base URL. `fake:` selects the deterministic stand-in (development and tests only) | **Required for every AI feature** | `https://api.anthropic.com/v1` | Vercel (all three) | Redeploy |
| `AI_API_KEY` | Studio, Runtime, Interviews | Provider key | Required with a real provider | `<provider key>` | Vercel (all three) | Redeploy |
| `AI_MODEL` | Studio, Runtime, Interviews | Large model. Default `gpt-4o-mini`, which an Anthropic endpoint refuses | Required unless the provider is OpenAI | `claude-sonnet-4-6` | Vercel (all three) | Redeploy |
| `AI_MODEL_SMALL` | Studio | Small model for structuring calls | Optional (defaults to `AI_MODEL`) | `claude-haiku-4-5` | Vercel Studio | Redeploy |
| `AI_WORKSPACE_ID` | Studio, Runtime, Interviews | Anthropic workspace header | Optional | `wrkspc_…` | Vercel | Redeploy |
| `AI_API_HEADERS` | Studio, Runtime, Interviews | Extra headers, as JSON | Optional | `{"x-org":"…"}` | Vercel | Redeploy |
| `AI_ANTHROPIC_VERSION` | Studio | `anthropic-version` header on the native path | Optional (`2023-06-01`) | `2023-06-01` | Vercel Studio | Redeploy |
| `AI_PROMPT_CACHE` | Studio | `off` disables provider prompt caching | Optional (on) | `off` | Vercel Studio | Redeploy |
| `AI_MAX_OUTPUT_TOKENS` | Studio | Copilot output ceiling | Optional (32,000) | `16384` | Vercel Studio | Redeploy |
| `AI_MAX_CONCURRENCY` | Studio, Runtime, Interviews | Concurrent requests per provider lane | Optional | `6` | Vercel | Redeploy |
| `AI_FALLBACK_API_URL` · `AI_FALLBACK_API_KEY` · `AI_FALLBACK_MODEL` · `AI_FALLBACK_MODEL_SMALL` | Studio, Runtime, Interviews | Second provider, used after the first fails | Optional | `https://api.openai.com/v1` · `<key>` · `gpt-4o` · `gpt-4o-mini` | Vercel | Redeploy |
| `AI_VISION_MODEL` | Studio | Model that reads page images (imports) | Optional (defaults to `AI_MODEL`) | `gpt-4o` | Vercel Studio | Redeploy |
| `AI_EMBEDDINGS_MODEL` | Studio | Semantic retrieval over research documents; without it retrieval is BM25 keyword search | Optional | `text-embedding-3-small` | Vercel Studio | Redeploy |

## 5. Speech, translation, media, reports, geocoding

| Variable | Apps | Purpose | Required | Placeholder | Where | Change |
|---|---|---|---|---|---|---|
| `AI_STT_API_URL` | Studio, Runtime, Interviews | Speech-to-text base URL (serves `/audio/transcriptions`). Falls back to `AI_API_URL`, **which does not work for Anthropic** | Required for transcription and spoken requests when `AI_API_URL` is Anthropic | `https://api.openai.com/v1` | Vercel (all three) | Redeploy |
| `AI_STT_API_KEY` | Studio, Runtime, Interviews | Its key (falls back to `AI_API_KEY`) | With `AI_STT_API_URL` | `<key>` | Vercel | Redeploy |
| `AI_STT_MODEL` | Studio, Runtime, Interviews | Speech-to-text model | Optional (`whisper-1`) | `whisper-1` | Vercel | Redeploy |
| `AI_TTS_MODEL` | Studio, Runtime | Text-to-speech model (voice interviewer, narration) | Optional (`tts-1`). TTS uses `AI_API_URL`; Anthropic has none | `tts-1` | Vercel | Redeploy |
| `TRANSLATION_PROVIDER` | Studio | Pins the provider: `google`, `ai` or `fake` | Optional (Google when keyed, else the model) | `google` | Vercel Studio | Redeploy |
| `GOOGLE_TRANSLATE_API_KEY` | Studio | Google Cloud Translation key | Optional (the model translates without it) | `<key>` | Vercel Studio | Redeploy |
| `GOOGLE_TRANSLATE_ENDPOINT` | Studio | Alternative v2 endpoint | Optional | `https://translation.googleapis.com/language/translate/v2` | Vercel Studio | Redeploy |
| `R2_ACCOUNT_ID` (or `R2_ENDPOINT`) · `R2_BUCKET` · `R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` | Studio, Runtime, Interviews | Cloudflare R2 media storage (all four, or Supabase Storage is used) | Recommended; required for Interviews recordings in production | `<account id>` · `rescript-media` · `<key id>` · `<secret>` | Vercel (all three) | Redeploy |
| `R2_REGION` · `R2_FORCE_PATH_STYLE` | Studio, Runtime, Interviews | R2 tuning | Optional (`auto` · `1`) | `auto` · `1` | Vercel | Redeploy |
| `MEDIA_STORAGE` · `MEDIA_STORAGE_URL` · `MEDIA_ALLOW_MEMORY_STORAGE` | Studio, Runtime | `memory` selects the test double (refused in production unless allowed) | Tests only | `memory` · `http://127.0.0.1:4598` · `1` | Local | Restart |
| `INTERVIEWS_STORAGE` · `INTERVIEWS_STORAGE_URL` · `INTERVIEWS_ALLOW_MEMORY_STORAGE` | Interviews | The same, for Interviews | Tests only | `memory` · `http://127.0.0.1:4599` · `1` | Local | Restart |
| `REPORT_NARRATION_ENABLED` | Studio | `1`, `true` or `yes` allows narrated video reports (an organisation decision) | Optional, off | `1` | Vercel Studio | Redeploy |
| `REPORT_ARTIFACT_RETENTION_DAYS` | Studio | How long a finished report artefact is kept | Optional (90) | `90` | Vercel Studio | Redeploy |
| `REPORT_FONTS_DIR` | Studio | Fonts for rendered reports | Optional (`public/report-fonts`) | `/var/task/fonts` | Vercel Studio | Redeploy |
| `FFMPEG_PATH` | Studio | ffmpeg binary for video reports | Optional (`ffmpeg-static`) | `/usr/bin/ffmpeg` | Vercel Studio | Redeploy |
| `GEOCODE_API_URL` · `GEOCODE_API_KEY` · `GEOCODE_EMAIL` | Runtime | Address search on location questions (Nominatim-compatible) | Optional (the typed address is kept without it) | `https://nominatim.example/search` · `<key>` · `ops@example.com` | Vercel Runtime | Redeploy |

## 6. Mail

| Variable | Apps | Purpose | Required | Placeholder | Where | Change |
|---|---|---|---|---|---|---|
| `RESEND_API_KEY` | Studio | Resend key | Required for password reset | `re_…` | Vercel Studio | Redeploy |
| `MAIL_FROM` | Studio | Transactional From address, on a verified domain | With the key | `Rescript <no-reply@example.com>` | Vercel Studio | Redeploy |
| `MAIL_FROM_INVITATIONS` | Studio | Separate From address for respondent invitations | Recommended | `Surveys <surveys@example.com>` | Vercel Studio | Redeploy |
| `MAIL_REPLY_TO` | Studio | Reply-To address | Optional | `support@example.com` | Vercel Studio | Redeploy |
| `MAIL_DEV_REDIRECT` | Studio | Outside production, all mail goes to this address | Optional | `you@example.com` | Vercel Studio (Preview) / Local | Redeploy |

## 7. Billing, tests and debugging

| Variable | Apps | Purpose | Required | Placeholder | Where | Change |
|---|---|---|---|---|---|---|
| `BILLING_SANDBOX_CREDITS` | Studio, Runtime, Interviews | Starting balance of the in-memory sandbox meter | Optional (100) | `100` | Local | Restart |
| `BILLING_SIMULATE_FAKE_COSTS` | Studio, Runtime, Interviews | `1` prices the fake provider as a real one | Tests only | `1` | Local | Restart |
| `RESCRIPT_NL_DEBUG` | engine host | Trace of the natural-language engine | Debug only | `1` | Local | Restart |
| `WRITE_CORPUS_SNAPSHOT` · `WRITE_OPERATOR_SNAPSHOT` | engine tests | Rewrite test snapshots | Tests only | `1` | Local | — |

## 8. Added 2026-10-18 by the concurrent work (E2, E3, E4)

E1 (context and registry) adds **no** environment variable. The research context is stored in migration 0067's table, with a memory fallback until it is applied.

**Checked at E1's final run.** Every `process.env` read in the files E2, E3 and E4 had changed so far (artifacts, report themes, `qual/*` routes and stores, schema `qualStudy`, analytics) is already in sections 1–7. No new variable was found then. The TODO rows below stay until each engineer confirms.

<!-- E2/E3/E4: add one row per variable your code reads, in the table format above. -->

| Variable | Added by | Apps | Purpose | Required | Placeholder | Where | Change |
|---|---|---|---|---|---|---|---|
| *TODO (E2: artefact persistence, report themes)* | E2 | | | | | | |
| *TODO (E3: interviews, focus groups, coding: transcription / diarisation vendor?)* | E3 | | | | | | |
| *TODO (E4: HB / LCA / SEM: a statistics service?)* | E4 | | | | | | |

**A new external dependency** gets the following:

- an entry in `SERVICES` in `packages/engine/src/capabilities.ts`, with its variables and a `readiness(env)`;
- a row here.

`/platform` then shows whether it is ready. Intelligent Mode refuses a request that depends on it while it is not, and names the variable.

## 9. Missing critical configuration: what the researcher sees and what the administrator sees

The rule: a missing service is an **administrator diagnostic** (`/platform` warnings, plus the "Capabilities and services" card from the capability registry). The researcher sees an honest message that names what is missing. The researcher never sees a broken screen or a raw provider error.

| Missing | Researcher sees | Administrator sees | Verified by |
|---|---|---|---|
| Language model (`AI_API_URL`) | Intelligent Mode works engine-only. A model request gets "No language model is configured on this Studio (AI_API_URL)…" (501, `not_configured` card). AI probes and classification are skipped silently at run time and the survey runs | `/platform` warning (`aiConfigWarning`). Service "Language model": not configured | `aiConfig` tests; `phase1-reliability-test`; `capabilityStatus` test |
| Speech-to-text (`AI_STT_API_URL`, or Anthropic as `AI_API_URL`) | Transcription returns "No transcription provider is configured" / "Anthropic's API has no speech-to-text endpoint…" (`sttUnavailableReason`). A copilot request to transcribe gets a refusal naming `AI_STT_API_URL`, with no charge | `/platform` warning "Speech-to-text provider is not configured (AI_STT_API_URL…)". Capability rows: not ready | `capabilitiesReadiness.test.ts`; `researchContext.test.ts` (readiness report); `context-summary-test` [5] |
| Translation (`GOOGLE_TRANSLATE_API_KEY` and no model, or a pinned provider without its key) | The translation status route reports no provider and the panel says so. Intelligent Mode can still write translations itself (`set_translations`), so copilot requests are never refused for this | `/platform` warning "Translation provider is not configured…" | `capabilitiesReadiness.test.ts`; existing `translation.test.ts` |
| Storage (no R2 and no Supabase) | Media routes answer 501 "media storage is not configured", naming the missing settings (`r2MissingSettings`). Surveys without media are unaffected | `/platform` warning "Media storage is not configured (R2_BUCKET or SUPABASE_URL)"; database warnings | `capabilityStatus` test; existing storage tests |
| Narration (`REPORT_NARRATION_ENABLED`) | Narrated video is refused with the reason (`reportvideo` providers). A copilot request for one is refused, naming the variable | Capability "Narrated video reports": not ready | `capabilitiesReadiness.test.ts` |
| Migration 0067 not applied | Nothing visible. The research context is kept in the server's memory, and after a restart the brief is sent whole again, as before | `/platform` migrations: "0067 (the research context of a long brief)" not applied | route fallback (`storeWithFallback`) |

Checking a running instance:

1. Open `/platform` as a platform admin. In production it is admin-only.
2. Read the warnings and the "Capabilities and services" card.
3. Fix the missing variables, then redeploy.
