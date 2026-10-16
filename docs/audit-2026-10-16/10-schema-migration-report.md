# 10 · Schema and migration report

Evidence: `raw/schema-and-runtime.md` Part A — A1 full table inventory (92 tables, columns, FKs, indexes, RLS per table), A2 119 RPCs, A3 34 triggers, A4 RLS summary, A5 migration hygiene, A6 jobs, A7 buckets, A8 who-writes-what, A9 routes writing responses, A10 gap→storage decision table, A11 "must not" list.

## State of the schema (verified from the 54 migrations)
- All 92 public tables have RLS enabled; all application access is **service-role**; member policies (0008 `authenticated`) and tenant policies (0001 `public`) coexist with deny-all tables — three dialects (SCHEMA-11), defence in depth only.
- Invariants enforced in SQL: `survey_versions` immutable (trigger), draft revision CAS (`rescript_save_draft`), version finalise RPC, `increment_quota_counts` atomic (but **uncapped**, SCHEMA-01), List Fill claim `insert … on conflict … where count < p_max`, single running plan apply (0053), billing ledgers immutable, `responses_touch` trigger for cache stamps.
- Hygiene: forward-only (no down scripts, SCHEMA-03); 0027 not re-runnable (SCHEMA-02); no destructive statements on live data found; `design_files` is dead (SCHEMA-08); no retention sweeps for `analytics_result_cache.expires_at`, `login_attempts`, `analytics_share_access` (SCHEMA-09); `respondents.token` plaintext (SCHEMA-04); `profiles` self-update unrestricted by column (SCHEMA-05, latent).
- Background jobs: Studio cron routes (`CRON_SECRET`) for quality/analytics/billing; **no** List Fill reconcile, **no** partial-response expiry (METHOD-10, RUNTIME-07).

## Gap → minimum change (from A10; decision per the brief's "do not add columns merely because a feature needs a value")
| Gap | Can the existing JSON hold it? | Decision | BC / backfill | Risk |
|---|---|---|---|---|
| Semantic validation metadata (age/email/phone/postal/percent/currency…) | **Yes** — `Question.settings` / `Question.analysis` are open objects; add optional `semantic` | JSON only, no migration | additive optional key; old versions parse unchanged; optional "infer" pass writes drafts only | none |
| Geographic reference data (country→admin1→city) | No (platform-scoped, large) | NEW platform table(s) `geo_regions(kind, code, name, parent_id, …)` + loader; the question references a region set in JSON (`settings.geoRegionSet`); derived region codes go to `responses.calculated` | new tables, RLS global-read/service-write; nothing to backfill | low |
| Conjoint/MaxDiff configs | **Yes** — `designs[].config` | keep; optionally move generated rows out of the respondent payload into the existing `design_files` (+ `survey_version_id`, `definition_hash`) | keep inline rows readable; one-off move | low |
| Analysis-plan execution status | mostly covered by `analytics_plan_applies` / `analytics_runs` | add per-item status: widen `analytics_plan_applies.summary` jsonb or new `analytics_plan_items` | additive | none |
| Cleaning rule config | **Yes** — `def.quality` (exists) | none; set default `enabled:true` in schema for new surveys | definitions without the key keep `false` only if that default is preserved for *existing* versions — implement as "default true when `quality` key absent **and** survey created after date X" or a Studio-side prompt | low |
| Rule-driven exclusion audit trail | partially (`response_reviews` covers manual decisions) | NEW `exclusion_log(run_id, response_id, rule_set_hash, reason)` or store in `analytics_runs.dataset` + verdict snapshot | additive | low |
| Generated-document records | partially (`analytics_exports`, `analytics_report_versions`, story renders) | NEW `generated_documents(kind, format, source_version_id, source_hash, storage pointer, generator version)` | additive | low |
| Server-side validation (RUNTIME-01) | n/a | code only | — | medium (must not reject legitimate resumes) |
| Quota cap (SCHEMA-01) | n/a | change `increment_quota_counts` to refuse over-limit and return the cells still open | RPC change: drop + recreate + **re-apply 0026 grants** (A11 §6) | medium |
| Hashed respondent tokens (SCHEMA-04) | — | add `token_hash`, dual-read during migration, backfill, then stop writing plaintext | backfill job; invitation links unaffected (hash on lookup) | medium |
| Column-level profile protection (SCHEMA-05) | — | `revoke update on profiles from authenticated; grant update (full_name, job_title, organization)` | none | none |

## Rules for any change (A11, abridged)
Never update `survey_versions.definition`; never rewrite `responses.answers` in a migration; never drop columns; never add UPDATE/DELETE to ledgers; never add permissive policies to deny-all tables; drop-and-recreate set-returning RPCs and re-apply 0026 grants; never widen `rescript_resolve_share`; keep atomicity in statements; no NOT NULL without default on `responses`/`respondents`; never grant `anon` EXECUTE on `rescript_*`.

## Migration plan shape
All batch-1 and batch-2 fixes are code-only. Batch 3 needs at most: one additive table for geo regions, one for generated documents (optional), one RPC replacement for quota capping, one additive column pair for token hashing. Each as its own numbered migration with an "undo notes" header (SCHEMA-03), run against a branch first (Supabase branching is available on the project), and verified by the four declared Postgres suites plus a new quota-concurrency test.
