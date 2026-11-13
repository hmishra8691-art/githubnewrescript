# Scalability, performance and load-testing audit — 2026-11-13

**Question asked:** can ResLens.ai reliably support 10,000 concurrent respondents (about 100 studies × 100 respondents,
each answering a 50–60-question survey) plus the researchers using the Studio at the same time?

**Short answer: not today.** The application code scales. The **database does not**: production runs on Supabase's
smallest compute size (shared, burstable CPU; `max_connections` 60), and at the target load the database has to execute
roughly 2,000–4,000 statements per second. Seven changes are needed before launch (section 9). Two code fixes are in
this patch. One database migration is written but **not applied**.

This report separates **measured** facts from **estimates**. Nothing was load-tested against the live database or
the live site. As agreed, the tests ran against a production build inside the audit sandbox, plus read-only queries
on the live database. No end-to-end test at 10,000 has been run, so **no capacity figure here is verified end to
end**. Section 8 is the test that would verify one, on a staging copy.

---

## 1. Scope and the load we sized for

"10,000 users" was taken as **10,000 respondents answering at the same moment**, plus a few hundred to a few thousand
researchers in the Studio. Read literally, 10,000 researchers each with 100 live respondents would be one million
concurrent respondents, which is a different system; it was not sized here.

Assumptions behind every per-second number (all can be changed and the arithmetic redone):

| Assumption | Value | Why |
|---|---|---|
| Interview length, 60 questions | 12 minutes | ≈ 5 questions a minute |
| Pages per interview | 13 / 30 / 60 | 13 is what the 60-question test fixture produces; 60 is one question per page |
| Saves | one per page, plus a final save | `Runner.tsx`: one `POST /api/session/save` per page; the final save is retried up to 3 times |
| Starts and completions | 10,000 ÷ 720 s ≈ **14 per second each**, steady state | |

At 10,000 concurrent respondents that is **180 / 420 / 830 saves per second** for 13 / 30 / 60 pages.

---

## 2. Architecture as it stands (what each request touches)

- **Respondent app** (`apps/runtime`, Next.js 14 on Vercel serverless). It uses `supabase-js` over HTTPS (PostgREST).
  Functions never open Postgres connections themselves, so Vercel scaling out cannot exhaust database connections
  directly. That is the right design for serverless.
- **Survey page load:** 3–4 queries (deployment, cached survey version, survey, quota counts). The definition (live
  average 27 KB, largest 223 KB) is cached in memory per function instance; a cold instance fetches it again.
- **Intermediate save:** before this patch, 4–5 queries: read the session row, the quota counts and the balance claims
  for the server-side replay, then the update. After this patch, 2 queries (read and update), except for the sampled
  replays.
- **Final save:** 10–15 statements (update, quota counting, List Fill / balance release, respondent status, assessment
  score, fieldwork events), then the **quality engine**. That engine reads up to `maxPeers` (default 3,000) earlier
  responses of the study, with their answers, and writes the assessment back.
- **Studio** (`apps/studio`): every authenticated API call first runs 3 queries (session row, profile, access policy).
  An open project polls `/collab` every 15 s (presence, lock heartbeat, lock expiry sweep, presence list, comments:
  about 10 statements per poll). The session heartbeat runs every 30 s and the alert bell every 20 s.
- **Media:** a survey image or video goes through `/api/media/<id>`, which does 2 queries and redirects (302) to a
  15-minute signed Cloudflare R2 URL; no bytes pass through the function. R2 has no egress fees.
- **Background:** Vercel cron jobs (notifications and intelligent tasks every minute, others hourly) and a job queue
  for AI interviews (`rescript_interview_claim_job`). None of these are in the respondent hot path.

---

## 3. Live database: what it is and what it does today (read-only, measured)

| Fact | Value | Source |
|---|---|---|
| Postgres | 17.6, Supabase project `rescript-survey-platform`, us-west-1 | project list |
| `max_connections` / `shared_buffers` / `effective_cache_size` | 60 / 224 MB / 384 MB | `pg_settings` — consistent with the **Micro** compute size (shared, burstable CPU) |
| Database size / `responses` rows | 58 MB / 266 | `pg_database_size`, `pg_class` |
| Average `answers` size / largest | 2.1 KB / 402 KB | `pg_column_size` |
| Statements since 2026-08-31 (74 days) | 5.82 million; 6,050 s executing; **1.04 ms mean** | `pg_stat_statements` |
| Response `UPDATE` (the save) | 4.5–5.8 ms mean, 162–207 ms max, at almost no concurrency | `pg_stat_statements` |
| Response `INSERT` (session start) | 20 ms mean | same |
| Survey-version definition read | 9–11 ms mean (large jsonb) | same |
| `survey_dashboard_stats()` (Studio dashboard) | **185 ms mean, 3.9 s max**, on 266 responses | same |
| `responses` updates that were HOT | 250 of 2,279 (11%) | `pg_stat_user_tables` |
| `responses_answers_gin` | **0 scans ever**, rewritten on every save | `pg_stat_user_indexes` |

**The researcher side already dominates database traffic.** With about 10 users, the five most-called statements
are Studio presence and session heartbeats, at 114,518 calls each. One researcher with a project open costs the
database about **1 statement per second** while doing nothing. 1,000 researchers idling cost about as much as 10,000
respondents answering.

---

## 4. Load-test results (measured)

### 4.1 Server-side CPU per save (engine benchmark, `scripts/perf/engine-bench.mjs`)

The save route replays the whole interview to validate a payload, so a save costs O(pages) and an interview O(pages²).

| Survey | Pages | Replay per save P50 / P95 / P99 | CPU per interview |
|---|---:|---|---:|
| 60 questions with display logic, skips, matrices, calculations (`buildScaleSurvey(60)`) | 13 | **3.6 / 7.0 / 7.7 ms** | 47 ms |
| Master Demo, 160 questions, nested loops, List Fills, conjoint, MaxDiff | 66 | **143 / 376 / 471 ms** | **10.5 s** |

Quality engine on the final save, 60-question survey:

| Peers read | CPU | Answers transferred from the database |
|---:|---:|---:|
| 100 | 8 ms | 80 KB |
| 1,000 | 46 ms | 0.8 MB |
| 3,000 (default cap) | 134 ms | **2.4 MB per completed interview** |

Parsing a definition costs 10 ms (37 KB) and 49 ms (199 KB). A **test** session re-reads and re-parses the draft on
every save; a live session uses the cache.

### 4.2 Respondent app under load (`scripts/perf/respondent-load.mjs`)

These runs used a production build (`next build` + `next start`) on **one 2-vCPU machine shared with the load
generator**. They exercise the real save route against the in-memory session store, so they measure Next.js, JSON
handling and the server-side replay, **not Postgres**. Each virtual respondent starts a session, saves after every
page with the real engine-built payload, then completes.

**Saturation (no think time):**

| Survey | Before (replay every save) | After this patch | Change |
|---|---|---|---|
| 60 questions | 207 req/s · 190 saves/s · save P50 462 ms | **573 req/s · 530 saves/s · save P50 145 ms** | 2.8× |
| 160-question Master Demo | 50 req/s · 46 saves/s · final save P50 1,567 ms | **238 req/s · 222 saves/s · final save P50 352 ms** | 4.8× |

**Stepped concurrency, 5 s average think time between pages, 60-question survey (before the patch):**

| Virtual respondents | Offered load | Achieved | Save P50 | Save P95 | Save P99 | Errors |
|---:|---:|---:|---:|---:|---:|---:|
| 250 | ~50 req/s | 50 req/s | 6 ms | 278 ms | 721 ms | 0 |
| 500 | ~100 req/s | 97 req/s | 5 ms | 699 ms | 1,237 ms | 0 |
| 1,000 | ~200 req/s | 192 req/s | 8 ms | 1,336 ms | 2,351 ms | 0 |
| 1,500 | ~300 req/s | 255 req/s (saturated) | **231 ms** | 1,903 ms | **11,578 ms** | 0 |
| 1,500, **after the patch** | ~300 req/s | 287 req/s | **1.6 ms** | 927 ms | 1,836 ms | 0 |

In these runs every virtual respondent arrived at once, a deliberate spike, so the P95/P99 tails come mostly from the
first page. The endurance and spike results are in 4.4.

### 4.3 Database write throughput (local Postgres, `pgbench`)

These runs used Postgres 16 on the same 2-vCPU machine, configured with the live instance's memory settings, and the
live `responses` table: every column, all 15 indexes and the update trigger. It held 110,000 rows (100 studies ×
1,000 completes + 10,000 sessions in progress). Each transaction is the save route's two statements with a 2.1 KB
answers payload.

| Clients | Saves/s with the GIN index | Without it | Latency (avg) with / without |
|---:|---:|---:|---:|
| 8 | 2,892 | 3,257 | 2.8 / 2.5 ms |
| 16 | 3,065 | 3,793 | 5.2 / 4.2 ms |
| 32 | 2,907 | 3,907 | 11.0 / 8.2 ms |
| 50 | 3,073 | **4,144 (+35%)** | 16.3 / 12.1 ms |

**These figures are an upper bound, not the Supabase number.** The local machine has a local disk, no network hop,
no PostgREST in front, dedicated cores and 8 GB of memory. The live instance takes **10× longer per update**
(5 ms against 0.4 ms) at almost no load. The peer query for a 3,000-complete study ran in 13 ms locally, but spilled
its sort to disk (`work_mem` 2 MB).

### 4.4 Endurance and spike (after the patch, same machine)

| Run | Achieved | Save P50 / P95 / P99 | Start P95 | Errors |
|---|---|---|---|---:|
| **Endurance:** 500 respondents, 2 s think time, 3 minutes (3,040 completed interviews) | 252 req/s | 2.1 / 12.8 / 25.2 ms | 12.8 ms | 0 |
| **Spike:** 1,500 respondents arriving at the same instant | 286 req/s | 1.7 / 961 / 1,966 ms | 3,401 ms | 0 |
| **Same 1,500, arrival spread over 30 s** | 235 req/s | **1.6 / 7.1 / 15.7 ms** | **4.7 ms** | 0 |

The server's memory grew from 308 to 354 MB over the 3-minute run. Most of that is the in-memory test session store
(capped at 2,000 sessions), so it says little about production. A 3-minute run is not an endurance test in the full
sense; the 2-hour run belongs to the staging test (section 8). The two spike runs show the same box absorbing the
same 1,500 respondents with a P99 of 16 ms when they arrive over 30 s, against 2 s when they arrive at once. On
Vercel, a simultaneous arrival also means cold starts, so a panel invitation sent in waves is gentler than one
blast.

---

## 5. What can already handle the target, and what cannot

| Component | Verdict at 10,000 respondents | Basis |
|---|---|---|
| Respondent app code (save, start, replay) | **Scales**, after this patch | 530 saves/s per 2 vCPUs measured; the target needs 180–830/s, spread over as many Vercel instances as the plan allows |
| Avoiding connection exhaustion from serverless | **Fine by design** | Functions talk HTTPS to PostgREST, never directly to Postgres |
| Duplicate-submission and ordering protection | **Sound** | Final save guarded by `status = in_progress`; save sequence numbers (0078) refuse stale saves; quota counting is idempotent per session (`rescript_count_quota_cells`); the final save retries with the same sequence number. Covered by existing tests, re-run here (`section-nav-test` 20/20) |
| Network interruption and resume | **Sound** | Intermediate saves tolerate failure (the next one carries everything); the final save retries 3 times; a resume link restores the session |
| Static assets and media bytes | **Fine** | CDN and Cloudflare R2 (no egress fees) |
| **Database compute (Micro, shared CPU)** | **Will fail** | 2 shared, burstable vCPUs and 60 connections must serve ~1,100–2,000 respondent statements/s plus ~1 statement/s per researcher; at 1.04 ms mean CPU per statement that alone is 2–4 CPU-seconds per second |
| **Quality engine on completion** | **Will degrade** as studies grow | Up to 2.4 MB read and 134 ms of CPU per completion at 3,000 peers; at 14 completions/s that is ~34 MB/s out of the database |
| **Studio idle polling** | **Will degrade** | ~1 statement/s per open project, plus 3 auth queries on every Studio API call |
| **Studio dashboard (`survey_dashboard_stats`)** | **Will degrade** | 185 ms mean on 266 responses; its cost grows with response count |
| Respondent page JavaScript | **Slow on mobile** | 971 kB first-load JS (as reported by `next build`) for `/s/…`; it does not affect capacity, but it affects load time |
| AI interview modes | **Not in this scenario** | Bound by the AI provider's rate limits; queued work already exists |

---

## 6. Bottlenecks, severity and fixes

| # | Problem | Component | At 10,000 respondents | Fix | Severity | Status |
|---|---|---|---|---|---|---|
| 1 | Shared, burstable 2-vCPU database with 60 connections | Supabase compute | CPU saturates; latency climbs; saves time out (20 s client timeout), then the respondent sees errors | Move to a dedicated-CPU size (estimate in section 7), then **verify** with the staging test | **P0** | Needs your decision |
| 2 | Functions possibly far from the database | Vercel region | `vercel.json` sets no region. Vercel's default function region is Washington, D.C. (`iad1`) unless the project settings change it; the database is in N. California. If so, every query adds a cross-country round trip of ~60–70 ms, and a save does 2–5 of them | Set the respondent and Studio functions to `sfo1` (or move the database) | **P0 if misplaced** | Check the project's Functions region setting |
| 3 | Every intermediate save replayed the whole interview, only to write a log line (default `log` posture) | `/api/session/save` | 3.6–471 ms of CPU and 2 extra database reads per save | Replay every final save in full, and only 5% of intermediate saves (`RUNTIME_SERVER_VALIDATION_SAMPLE`). `enforce` and `RECOMPUTE=store` still replay every save | High | **Fixed in this patch**: 2.8–4.8× throughput |
| 4 | Quality engine reads up to 3,000 peers on every completion | `@rescript/quality` `loadPeers` | Database egress and CPU grow with study size | Lower the default `maxPeers` (e.g. 500), or compute the peer benchmarks per study on a schedule and read them on completion. Changes quality results, so it is a product decision | High | Recommended |
| 5 | Studio polling and per-request auth queries | `/collab`, `/auth/heartbeat`, `guard.ts` | ~1 statement/s per open project; 3 auth queries per API call | Presence every 30–60 s instead of 15; cache the access policy per instance for 30–60 s; run the lock-expiry sweep from cron instead of every poll; slow the polling in hidden tabs, with a lock stale window to match. Security- and collaboration-sensitive, so not changed here | High | Recommended |
| 6 | Dashboard statistics recomputed per view | `survey_dashboard_stats()` | Slows linearly with responses | Maintain per-survey counters (trigger or job) and read those | High | Recommended |
| 7 | Unused GIN index rewritten on every save | `responses_answers_gin` | 13–35% fewer saves per second | `supabase/migrations/0097_drop_unused_answers_gin.sql` | Medium | **Written, not applied** |
| 8 | Survey images and videos: one function call and 2 queries per image per respondent | `/api/media/<id>` | An image-heavy survey adds hundreds of calls per second | The CDN may keep a stimulus redirect for 5 minutes (`s-maxage=300`). A respondent's own recording stays private | Medium | **Fixed in this patch.** Whether Vercel's CDN keeps a 302 response was not verified |
| 9 | Test sessions re-read and re-parse the draft on every save | `resolveRunDefinition` | Only matters if many test sessions run at once | Cache the draft by revision | Low | Recommended |
| 10 | 971 kB first-load JS on the survey page | `apps/runtime` bundle | Slower first page on mobile; more CDN transfer | Load heavy question types (conjoint, video, maps, rich media) only when a survey uses them | Medium | Recommended |
| 11 | Peer query sorts on disk (`work_mem` 2 MB) | `loadPeers` | Extra I/O per completion | Comes free with a larger compute size, or with an index matching the filter | Low | With #1 |

---

## 7. Capacity and cost estimates

**These are estimates.** They use the live mean of 1.04 ms of database CPU per statement, the per-respondent
statement count above (~81 statements per 12-minute, 30-page interview ≈ 0.11 per second), ~1 statement per second
per researcher with a project open, and 50% headroom. Prices are Supabase's and Vercel's list prices as last known
to me (2025); **check them on the current pricing pages before budgeting**.

| Concurrent respondents (+ researchers) | DB statements/s (est.) | Database size to start the staging test at | Supabase compute, list price per month |
|---|---:|---|---:|
| 1,000 (+100) | ~210 | Large (2 dedicated vCPU, 8 GB) | ~$110 |
| 5,000 (+500) | ~1,050 | XL (4 vCPU, 16 GB) | ~$210 |
| 10,000 (+1,000 to 2,500) | ~2,100–3,600 | **2XL (8 vCPU, 32 GB)**; XL may do if fix #5 lands | ~$410 |
| 20,000 (+2,000 to 5,000) | ~4,200–7,300 | 4XL (16 vCPU, 64 GB), plus a read replica for dashboards and exports | ~$960 + replica |

On top: Supabase Pro plan base (~$25/month) and usage (egress, ~$0.09/GB beyond the included amount; fix #4 matters
here). Vercel Pro (~$20 per seat per month) plus usage. Measured CPU puts the respondent app's own compute at a few
**cents per 1,000 completed interviews**: about 33 requests and roughly 0.2–0.4 CPU-seconds per interview. The
larger variable cost is likely to be transfer of the 971 kB page bundle (fix #10).

**Today's ceiling on the current Micro instance: not verified.** As a rough estimate, a few hundred to perhaps
1,000–2,000 concurrent respondents, with a handful of researchers. Above that, the burstable CPU runs out of credits
under sustained load. Only the staging test in section 8 can replace this estimate with a number.

**Do we need queues, workers or caching?** Not as new infrastructure for the respondent path. The save path is
already small (2 statements after this patch). The one piece of work worth taking off the request is the quality
assessment on completion (#4); it can run from the existing job/cron mechanism. A cache layer such as Redis is not
justified by anything measured here.

---

## 8. The test that would verify capacity (staging; nothing touches production)

1. **Staging database:** a Supabase branch or a separate project at the compute size under test (start at 2XL),
   with the production schema (`supabase/migrations`) and 100 studies' worth of completed responses.
2. **Staging respondent app:** a Vercel preview deployment pointed at it, in the **same region**, with production
   environment variables (`RUNTIME_SERVER_VALIDATION=log`, sample 0.05).
3. **Load generators** outside Vercel. One machine drives about 1,500 virtual respondents (measured); 10,000 needs
   about 7–10 machines, or k6 Cloud. The script is `scripts/perf/respondent-load.mjs` with
   `--client --study --def --mode test`. Use 20 s average think time and `--ramp` for arrival.
4. **Steps:** 100 → 500 → 1,000 → 2,500 → 5,000 → 10,000 → 15,000 → 20,000, 15 minutes each, ramped. Then a
   10,000 spike with `--ramp 0`, and a 2-hour run at 10,000. Run a researcher load beside it: N headless Studio tabs
   polling `/collab`.
5. **Watch:** save P50/P95/P99 and error rate from the script. On Supabase: CPU, `pg_stat_activity` connections,
   `pg_stat_statements` and disk IOPS. On Vercel: function duration and concurrency (Observability).
6. **Pass:** save P95 < 500 ms, P99 < 2 s, errors < 0.1%, database CPU < 70% sustained, and no 5xx.

Estimated cost of one full run: the compute size for a few hours (Supabase bills compute hourly) plus the generator
machines. Tens of dollars, not hundreds.

---

## 9. Final decision

**Can the current platform safely handle 10,000 concurrent respondents today? No.**

What must change before launch, in order:

1. **Upgrade the database** from Micro to a dedicated-CPU size (start the test at 2XL).
2. **Confirm the Vercel function region** matches the database (us-west-1 → `sfo1`).
3. **Deploy this patch** (replay sampling, CDN caching of survey media).
4. **Apply migration 0097** (drop the unused GIN index) after review.
5. **Reduce Studio polling and auth queries** (#5) and **fix the dashboard statistics** (#6).
6. **Cap or defer the quality engine's peer read** (#4).
7. **Run the staging test** (section 8) and launch only when 10,000 passes; publish the verified number.

Items 1–4 are configuration or already written. Items 5 and 6 are code changes of a few days each. Item 7 needs a
staging environment and roughly a day.

---

## 10. What was changed in this patch

- `apps/runtime/lib/replayScope.ts` (+3 unit tests) and `app/api/session/save/route.ts`: under `log`, intermediate
  saves are replayed for a 5% sample; final saves, `enforce` and `RECOMPUTE=store` are unchanged.
  `RUNTIME_SERVER_VALIDATION_SAMPLE` is documented in `.env.example` and the environment checklist.
- `apps/runtime/app/api/media/[...path]/route.ts`: stimulus redirects are cacheable by the CDN for 5 minutes;
  respondent recordings stay private.
- `supabase/migrations/0097_drop_unused_answers_gin.sql`: **not applied**.
- `scripts/perf/engine-bench.mjs`, `scripts/perf/respondent-load.mjs` (sandbox and staging modes).

Regression checks run: runtime unit tests 121/121, runtime type check, code audit. Browser: `section-nav-test` 20/20
(saves, resume, Back) and `s5b-telemetry-test` 16/16. `script-writes-test` fails at the same step **with and
without** this patch (a pre-existing failure, not investigated here).
