# Respondent rate limits — 2026-11-17 (audit P0-08, SEC-02)

## What changed

The respondent endpoints had no rate limit. One connection could call `/api/session/start` or
`/api/session/save` as fast as it liked. That fills quotas with junk sessions and uses up the database's 60
connections, which shuts real respondents out.

`apps/runtime/lib/rateLimit.ts` now limits each connection (client address) per route, over a sliding one-minute
window:

| Route | Limit per connection per minute | Why this number |
| --- | --- | --- |
| `POST /api/session/start` | 60 | A respondent starts once; 60 still allows a busy office or carrier NAT |
| `POST /api/session/save` | 600 | About one save per page; 600 covers many respondents behind one address |
| `GET /r/<client>/<study>` (entry link) | 120 | Panel redirects arrive in bursts |

Over the limit, the route answers `429` with `Retry-After` and `{ code: "rate_limited" }`, before any database
call. Configure it with `RUNTIME_RATE_LIMIT` (for example `start=30,save=300`), or set it to `off`.

## What it does not do

Each serverless instance keeps its own counts, so the effective ceiling is the limit × the number of warm
instances. That stops a single script. It does not stop a distributed flood.

**Owner decision needed:** add an edge limit in front of the runtime:
- a Vercel Firewall rate-limit rule, or
- a Cloudflare WAF rule on `/api/session/*` and `/r/*`, keyed on IP, at the same numbers.

Then lower or keep the in-app limits as a second layer.

## Tests

`apps/runtime/lib/rateLimit.test.ts` covers:
- reading the environment (defaults, overrides, off);
- refusing a flood with a retry time, while other addresses and routes are unaffected;
- the window sliding;
- memory staying bounded (20,000 keys) under address rotation.
