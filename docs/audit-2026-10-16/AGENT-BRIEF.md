# Audit agent brief (shared)

Repo: /home/claude/rescript (pnpm monorepo, Node 22). Packages build to `dist`; engine tests: `cd packages/engine && pnpm build && node --test dist/*.test.js`. Studio lib tests: `cd apps/studio && node --experimental-strip-types --no-warnings --test "lib/**/*.test.ts"`. Analytics/other packages: `pnpm --filter @rescript/<pkg> test`.

No Postgres credentials in this sandbox (no .env.local). DB-backed tests are "not run by declaration". Supabase schema may be read through migrations in `supabase/migrations/*.sql`.

Dev servers are NOT running unless the orchestrator says so. Do not start `next dev` yourself (8 GB RAM, OOM risk). Reproduce with unit-level code (import from `packages/*/dist`) wherever possible. If a finding needs a browser, write the repro as a note "BROWSER-REPRO NEEDED: <steps>" and the orchestrator will run it.

Prior audit docs exist in `docs/*.md` (77 files). Use them for orientation only: a prior doc claiming something works is NOT evidence. Re-verify against current code and tests.

## Rules
1. Classify every feature: IMPLEMENTED (verified by test or executed repro), PARTIAL, UI-ONLY, BROKEN (repro'd), MISSING, UNVERIFIED (say why).
2. Every BROKEN/PARTIAL finding needs: file:line evidence, repro steps or test command + output, expected vs actual, root cause if found, suggested fix, severity (P0 data loss/security/runtime failure; P1 core broken; P2 missing/incomplete; P3 minor).
3. Never fabricate test results. If you couldn't run something, say UNVERIFIED and what would verify it.
4. Do not modify source files. You may add scratch scripts under docs/audit-2026-10-16/repro/<your-area>/ only.
5. Output: write your report to `docs/audit-2026-10-16/raw/<area>.md`. Use a findings table with IDs `<AREA>-NN`. Keep prose tight; evidence over opinion.
