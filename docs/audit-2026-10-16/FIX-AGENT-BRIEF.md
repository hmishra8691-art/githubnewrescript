# Fix-agent brief (P2 batch, 2026-10-16)

Repo: /home/claude/rescript at the commit after the P0 + P1 batches (`git log --oneline -12`). Read your register cards in `docs/audit-2026-10-16/11-bug-register.md` and the matching `raw/<area>.md` rows before touching code; the repro scripts under `docs/audit-2026-10-16/repro/` are yours to re-run.

Rules (same as the P1 batch):
1. **Own only the files named in your task.** Five other engineers are editing the repo at the same time. Use surgical Edit-tool changes; never rewrite a whole file; never `git add`/`git commit`/`git stash`/`git checkout` anything — the orchestrator commits. If a build shows a transient error in a file you did not touch, wait 20 s and retry once; if it persists, report it and carry on with what you can.
2. Do NOT start `next dev` (8 GB RAM). Reproduce and verify at unit level (`packages/*/dist`, `node --test`). Where a browser is the only proof, write the Playwright check as an addition to the relevant `scripts/*-test.mjs` suite (same style as the existing ones) and say so; the orchestrator runs it.
3. Every fix ships with a test in the package's existing test style; keep the package suite green (`pnpm build && node --test dist/*.test.js`; analytics also `dist/*/*.test.js`). Studio lib tests: `cd apps/studio && node --experimental-strip-types --no-warnings --test "lib/**/*.test.ts"`. Typecheck the app you touched (`npx tsc --noEmit -p .`).
4. No migrations unless your task says so; schema changes are additive optional JSON fields only. Preserve existing behaviour for surveys that do not use the new field.
5. Do not change the copilot system prompt's length past its 14,800-char test cap (`apps/studio/lib/copilot/copilot.test.ts`); if you add text, trim elsewhere in the same prompt and keep the tests green.
6. Report: files changed, each register ID → what changed + the new/changed messages, test counts before/after, anything you could not do and why.
