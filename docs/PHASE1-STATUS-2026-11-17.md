# Phase 1 (critical fixes) — status, 2026-11-17

From the audit's backlog (Claude Doc "ResLens.ai — End-to-End Platform Audit & 2027–2029 Roadmap", Part 7). Six of
the nine P0 items are done in code. Three need a decision or credentials from the owner; for those, everything that
does not need approval is in place.

## Done

| ID | Patch | What |
| --- | --- | --- |
| P0-01 | 0160 | Pasted options number from 1 (inline paste, paste-box append, placeholder rows) |
| P0-02 | 0161 | No false "Save failed — Saved, but…" for fields the schema migrates; the same fix for analysis-plan edits |
| P0-04 | 0162 | `&nbsp;` and typographic entities decoded in plain text and on paste |
| P0-03 | 0163 | Import reads field behaviour: auto-populate, read-only, hidden, cross-question checks, totals |
| P0-05 | 0164 | Contract tests: RLS in the migration chain (in `audit:code`); importer output vs the schema |
| P0-08 | 0165 | Rate limits on respondent start, save and entry links (in-app layer) |

## Needs the owner

| ID | What is ready | What is needed |
| --- | --- | --- |
| P0-06 AI accuracy baseline | The harness exists (`pnpm eval:ai`, the 18 Oct work); the import behaviour corpus is in CI (0163) | An API key and a budget cap. Then run `EVAL_AI_API_URL=… EVAL_AI_API_KEY=… EVAL_AI_MODEL=… pnpm eval:ai --record --update-baseline --max-cost 5`, and commit the baseline and cassette |
| P0-07 Migrations 0097, 0098 | Both written and reviewed (13 Nov); the status script is `scripts/tenancy-migrations-status.mjs` | Approval to apply them to the live database (the SQL was given on 13 Nov) |
| P0-08 edge layer | In-app limits live after deploy | A Vercel Firewall or Cloudflare WAF rate-limit rule on `/api/session/*` and `/r/*` |
| P0-09 Database capacity | Peer reads already projected (`quality->system`); `maxPeers` is a per-survey quality setting | Upgrade Supabase compute from Micro to a dedicated-CPU size, run functions in the database's region (`sfo1`), then run `scripts/perf/respondent-load.mjs` against staging at 1,000 concurrent respondents |

## Gate for phase 2

The audit's gate is "no confirmed defect open; staging passes 1,000 concurrent respondents". The first half is met
in code (ERR-01 to ERR-07 fixed, with tests). The second half needs P0-09's staging run, which needs a staging
environment.
