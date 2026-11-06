# Audit closure — 2026-11-05 / 06

Closing every finding of the 2026-11-05 platform audit (`claude/platform-audit-2026-11-05.md` in the
project; full report at https://claude.ai/artifact/4cikW2bY451jta6XH5UMnQ), plus the runtime Back fix
reported from live testing. Base `origin/main = df425be7`. Nine phases, nine commits, each verified
before the next was started and applied on the Mac clone (`~/Downloads/rescript-push`) with `git am`;
each commit's patch went to the chat as `claude/patches/006x-….mbox` (the project was out of room after
0061, so 0062–0068 live in the conversation and in the Mac's history).

## The phases

| # | Commit (container → Mac) | What |
|---|---|---|
| 1 | `b22ebc5b` → `0ccf7e40` | **0091**: the two 0081 functions revoked from public/anon (authenticated kept — a policy helper must stay executable by the role evaluating it, proved on a scratch database), RLS + the live policies for 27 analytics_*/interview_* tables in the chain, `set search_path` on the one trigger without it, `schema_marks`. `/api/platform` probes 0076–0091 and reads the marks, warning when the database is ahead of the list. renderer and runtime `test` scripts. "Studio sign-in is not enabled yet" gone. planned()/"coming soon" deleted. |
| 2 | `a57a5211` → `f060f4eb` | **What Back takes back** (`packages/engine/src/backClear.ts`): on Back — and on a backward section jump — every hidden/calculated question punched from the pages ahead, and every script-written answer/embedded/calculated/flag made from those pages, is cleared; `state.scriptWrites` records the page a write came from; on the way forward punches re-derive and on_load runs fresh. Respondent-typed answers are kept. 5 tests. |
| 3 | `0270423f` → `845cde5a` | `vendorFetch` finally gets its recorder and durable breaker (`apps/studio/lib/recruitment/vendorCalls.ts`): `vendor_api_calls` and `vendor_circuit_state` are written, health recompute has rows to read. Reallocation reads the planned rejection rate from `rationale.rejectionRate` instead of inverting the yield (a 15%-vs-8% vendor is flagged now). 3 tests. |
| 4 | `ddebea3c` → `e4fbf2a3` | `/notifications` (badge → there, mark read); Administration → **Recruitment margins** and **Vendor settlement** (settlements GET lists orders when none is named); Fraud page → **At the door** (admission_decisions + identity_match_events, shadow "would have blocked" count). |
| 5 | `d731bc15` → `5893a25d` | `/api/cron/qual-jobs` every 5 min (auto-coding continues without the tab; author's standing via `backgroundContextFor`; `modelRunnerFor` split out); story-renders hourly; `crossCheckQuotas` warns on the recruitment panel when a target is set in both quota systems. 5 tests. |
| 6 | `975c0059` → `6d79b966` | 51 dead exports deleted, 4 wired (GAMIFICATION/IAT lists drive the dictionary; longestRun/transitionRate → `matrix.long_run`, `matrix.flip_flop`, informational). **0092** drops `templates`; design_files kept per 0058; interview_exports / vendor_quotations commented as awaiting writers. |
| 7 | `8632aecb` → `87d63afb` | **The gate**: `.github/workflows/verify.yml` (typecheck, all tests with pyreadstat, audits, docs; migrations job: chain twice on clean Postgres + anon/RLS posture checks). `scripts/app-guard-audit.mjs` (Interviews + runtime; found two handlers reading before the gate — fixed). `scripts/piping-sweep.mjs` (functions/tables/exports/env). `.env.example` +39 variables. Crosstab: no letters below effective base 30 (`sigMinBase`), Welch t for means. operatorCompat test pinned to UTC. |
| 8 | `aac34ce1` → `37d953be` | **Mixed-methods hand-off** (`qualHandoff` + `applyHandoff`, card on the Synthesis tab); **quotes in the deck/report** (`deckQuotesFor`, "In their own words"). Both capabilities `supported`. analytics `qual/*.test.ts` joined `pnpm test` (+52 tests). |
| 9 | this commit | 0091 applied to production; mail test pinned to UTC; this document; full clean verification. |

## The audit's ten findings

| # | Finding | State |
|---|---|---|
| 1 | rescript_rtid_sweep uncalled | fixed before this work (df425be7) |
| 2 | vendorFetch record/state never passed | **done** (phase 3) |
| 3 | 160 notifications no screen shows | **done** (phase 4) |
| 4 | probe list stops at 0074 | **done** (phase 1) — and schema_marks makes the drift visible |
| 5 | 0089 not applied | was already applied by the time this work started |
| 6 | two SECURITY DEFINER functions executable by anon | **done, applied** (0091 in production: `anon_exec = 0`) |
| 7 | 28 tables' RLS outside the chain | **done, applied** (0091) — CI now checks every table has RLS on a chain-built database |
| 8 | reallocation compares two quantities | **done** (phase 3) |
| 9 | renderer / runtime outside pnpm test | **done** (phase 1) — and analytics qual/ (phase 8) |
| 10 | "Studio sign-in is not enabled yet" | **done** (phase 1) |

Piping defects 4–8 (admission record, identity events, margins, settlements, qual jobs): done in phases 4–5.
Calculation defects 1–3: phases 3 and 7. Dead code and duplication: phase 6 (the sweep returns 0).
Partial capabilities with product consequence: phase 8. CI: phase 7. Guards over all three apps: phase 7.

## Final verification (clean dists, 2026-11-06)

6,439 tests, 0 failures, 0 skipped — engine 2673, studio lib 1162, analytics 792, recruitment 216,
media 179, interviews 178, ai 150, exporters 148 (the two pyreadstat round-trips ran), access 123,
designs 124, templates 121, runtime 112, storage 104, import 100, quality 97, billing 57, identity 34,
mail 33, schema 18, renderer 12, reportvideo 6. `pnpm -r typecheck` clean. `pnpm audit:code`: 279 + 77
handlers 0 problems, piping sweep 0, 0 boundary violations. Public docs current. Studio `next build` clean.
Migration chain 92/92 on a clean Postgres 16, each applied twice.

## Found on the way

- Two timezone-dependent tests (engine operatorCompat, mail) failed west of Greenwich and passed in CI; both pinned.
- `localization.ts` holds a literal NUL sentinel, so grep calls it binary — the audit's shell sweep missed three dead exports there; the mechanised sweep reads files, not grep.
- Two Interviews handlers looked an interview up before any gate (an id-existence oracle); fixed.
- 57 completes (not 62) still carry no quality assessment; see below.

## Still operational — nothing to build

- **Apply 0092** (`drop table templates`): the Supabase MCP asked for confirmation of the destructive statement and got none. Run `supabase/migrations/0092_tables_nothing_writes.sql` in the SQL editor; it is idempotent.
- **Quality recompute** over the unassessed completes: `POST /api/surveys/<id>/quality/recompute` from a signed-in Studio session, for `a4dde534-…` (Test10, 35), `72f651f3-…` (6), `7eeb831c-…` (5), `9d742a09-…` (4), `57ce3b1b-…` (3), and one each for `c5aef8af-…`, `0285d990-…`, `04e067ac-…`, `3757aa9a-…`.
- The 39 flagged responses still await a human decision (`review_status` null on every row).
- `RTID_MATCH_KEY`, `VENDOR_WEBHOOK_SECRET` unset; no `quota_mapping` declared on any project.
- Leaked-password protection: a Supabase Auth setting.
- Push: the Mac clone is nine commits ahead of `origin/main` (`git push origin main` from the Mac's Terminal). The first push will also start CI, which needs no secrets.
- `.github/workflows/ai-eval.yml` is deleted in the Mac's working tree (pre-existing, untouched); `apps/studio/tsconfig.json` likewise.
