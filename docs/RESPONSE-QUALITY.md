# Response Quality & Fraud Detection Engine

`packages/quality` (`@rescript/quality`) · runtime event collector · Studio settings, dashboard, review · exports · migration `0005_response_quality.sql`

The engine watches *how* a respondent answered — not just what — scores every finished response the moment it is submitted, explains every flag, and leaves the decision to the researcher. Nothing is ever deleted automatically.

```
Respondent → Runtime (event collector) → /api/session/save (telemetry + answers)
          → @rescript/quality assess() against the survey's peers
          → responses.quality  (scores, classification, flags, SYSTEM_*)
          → Data → Quality dashboard → KEEP / REMOVE / REVIEW LATER (audit trail)
          → dataset filter (all / clean / custom) → CSV / JSON / XLSX → analysis
```

## 1. Configuration — `def.quality` (Survey settings → Quality checks)

| field | meaning |
|---|---|
| `enabled` | master toggle (default off) |
| `strictness` | `relaxed` · `standard` (default) · `strict` · `very_strict` · `custom` — each built-in rule has an on/off and thresholds per level (see catalogue) |
| `bands` | fraud-risk → classification: `review` 20, `suspicious` 40, `highlySuspicious` 60, `critical` 80 (upper-exclusive, editable) |
| `rules[ruleId]` | per-rule overrides: `enabled`, `severity`, `weight` (risk ×), `qualityWeight`, `params{}` (thresholds), `questionIds[]` |
| `customRules[]` | researcher rules: an ordinary `Condition` (`when`) over answers **and** metrics (`calc.SYSTEM_*`), `riskPoints`, `qualityPenalty`, `severity`, optional `minClass` floor, `explanation` |
| `telemetry` | what the runtime may record: `timing`, `focus`, `clipboard`, `navigation`, `interaction`, `device`, `network` (hashed IP) + `disclosure` text |
| `privacy` | `telemetryRetentionDays` (purge raw telemetry, keep scores) · `longitudinal` (link history by external respondent id) |
| `maxPeers` | newest completes compared for duplicates/clusters (default 3000) |
| `profile` | name of the profile applied (informational) |

Profiles: built-in (`Consumer Research — Standard`, `B2B — Relaxed`, `Healthcare — Strict`, `Finance — Very Strict`, `Panel Research — Very Strict`, `Custom Research — Custom`) plus saved ones in `quality_profiles` (per customer). Applying copies the config into the survey — a profile never changes a survey after the fact.

**Attention checks** are a question property: `q.attentionCheck = { kind: explicit|instruction|trap|reverse|repeat|knowledge, expected[], pairedQuestionId?, severity, riskPoints, qualityPenalty }`. Set in the question editor ("Attention check"); the engine grades the answer and explains a miss.

## 2. Event collector — `apps/runtime/lib/telemetry.ts`

Recorded per session, derived metadata only (`ResponseTelemetry`): page visits (`pageId`, `enteredAt/leftAt`, `via` start/next/back/reload, out-of-focus ms, blurs, pointer/key/scroll counts), per-question timing (first/last change, latency after page entry, change count, paste count + **lengths**, typed chars), focus totals, clipboard counts, navigation sequence, interaction totals, device class (type, browser, OS, screen, viewport, dpr, locale, language, timezone, touch, `navigator.webdriver`). Explicitly **not** recorded: clipboard contents, typed text, keystrokes, mouse coordinates, raw IP, canvas/font fingerprints. Disabled categories are listed in `disabled` so a zero reads as "not measured".

Posted with every save; the server re-sanitises it (`sanitizeTelemetry`), drops switched-off categories, computes `device_hash` (sha256 of coarse fields, salted per survey), and stores it. `ip_hash` is set at session creation from `x-forwarded-for` (salted per survey via `QUALITY_HASH_SALT`), only when `telemetry.network` is on. The disclosure text renders in the runtime footer.

## 3. The engine — `packages/quality`

`assess({ def, response, peers, history }) → QualityAssessment` — pure, no I/O.

- **Benchmarks** (`benchmarks.ts`): median total/page/question time of the survey's completes when ≥ 8; otherwise the definition's reading-time estimate (250 wpm + per-decision cost). Explanations say which ("vs. median of 40 completes" / "vs. estimated reading time").
- **Rule catalogue** (`catalogue.ts`, 60+ rules): id, category, title, description, default severity, risk points, quality penalty, `enabledIn` per strictness, params with per-strictness defaults. Categories: timing (overall/page/question/matrix/open-end speeding, reading time, uniform timing, short dwell, idle-then-rush, timing entropy, acceleration, cross-respondent timing match), matrix (straight-lining incl. reverse-worded rows, diagonal, alternating/repeating, low variance, midpoint, extremes, identical signature), consistency (answer where hidden — "owns a car: No, brand: Toyota", repeat pairs, frequency vs quantity, piping), pattern (low/high entropy, non-substantive, middle/extreme bias, acquiescence, mechanical alternation, rare options), attention (failed, multiple, knowledge gap), open ends (short, gibberish, repeated, generic, irrelevant, contradicts closed answers, cross-respondent duplicate/near-duplicate, AI-like polish **as risk**, pasted), interaction (paste ratio, rapid paste+submit, out of focus), navigation (cycling, reloads, fingerprint match, screener edits), device (duplicate signature, webdriver, timezone), network (duplicate IP, IP density, provider risk — `SYSTEM_NETWORK_RISK` hook), bot (machine timing, no interaction, impossible sequence), duplicate (rarity-weighted answer agreement, multi-signal), cluster (coordinated, burst), screener (repeat attempts, inconsistent, fast), history (poor record).
- **Similarity** (`similarity.ts`): agreement weighted by how *rare* each agreed value is in this survey; links = high similarity + a shared signal (device/IP hash, navigation fingerprint, identical grids, timing profile, identical open ends) or extreme similarity alone; union-find closes links into clusters with `CLUSTER_ID`, `SIMILAR_RESPONDENT_IDS`, `CLUSTER_RISK_SCORE`.
- **Scoring** (`score.ts`): fraud risk = noisy-OR of weighted risk points (evidence accumulates, never double-counts to certainty); quality = 100 − Σ penalties. **Never combined.** Classification from the bands; custom rules may raise the floor. Every flag: `ruleId, category, severity, title, explanation, observed, expected, riskPoints, qualityPenalty, questionIds, relatedSessionIds, at`.
- **SYSTEM_\*** (`types.ts SystemVars`): durations, ratios, focus/clipboard/navigation counts, device fields, hashes, matrix signatures, open-end hashes, per-category scores, quality/risk/status, similarity/cluster fields, flag counts — stored with the assessment and exposed to custom rules as `calc.SYSTEM_*`.
- `assessSurvey()` — all responses of a survey with final cluster ids (recompute).

Server glue `@rescript/quality/server`: `loadPeers`, `assessAndStore`, `recomputeSurvey`, `hashIdentifier`, `deviceHashFrom`, `clientIp`.

## 4. Real-time processing

`POST /api/session/save` (runtime): stores telemetry on every save; on the final save (complete / screened / terminated) runs `assessAndStore` when `quality.enabled` — peers = the newest finished responses of the same survey and mode (test and live never mix). Engine failures never fail the save (`[rescript:quality] assessment failed (answers saved)`); recompute later.

Studio routes: `GET /api/surveys/:id/quality?include=` (dashboard payload), `GET|PATCH|POST /quality/:sessionId` (full assessment + decision + re-assess), `POST /quality/recompute` (draft settings → all responses, final clusters), `GET|POST|DELETE /quality/profiles`, `POST /quality/purge` (retention).

## 4b. Which settings run where — and how to prove it

`def.quality` autosaves with the survey draft (`surveys.draft_definition`) and is cut into every version. Three readers, one rule:

| reader | definition used |
|---|---|
| Data → Quality dashboard, `POST …/quality/recompute`, per-response re-assess | the autosaved **draft** when one exists, else the current version (`lib/qualityDef.ts`) |
| TEST session (`/t/…`) | the build the link resolved (`decideTestBuild`): `?v=` version → **draft** → current version. The save route resolves the same way (`resolveRunDefinition`) from the runner's `build` hint — a draft-run session used to be graded with the draft's *base version* settings, which is how a switched-on check never fired |
| LIVE session (`/s/…`) | the **published** version pinned by the live deployment — settings reach live respondents only after Save version + Publish; the dashboard says so when the live version's settings differ |

Every assessment carries `configHash` — `configFingerprint(config)`, an fnv1a of the canonical JSON of the resolved settings (profile name excluded). The dashboard payload carries the fingerprint of the settings saved now, so it can list "N scored with older settings" and offer a re-assess; each row shows *older settings* when its hash differs. `summarizeConfig(def)` (enabled, strictness, profile, bands, rules on / customised, custom rules, telemetry off, maxPeers, hash) is what the routes log:

```
[rescript:quality] config            runtime save route, on the final save — surveyId, session, isTest, definition {source, versionId, revision, hint}, config {hash, …}, enabledChecks[], at
[rescript:quality] assessed          … configHash, strictness, classification, risk, quality, flags, peers, computedAt
[rescript:quality] skipped           the definition this session ran has quality off
[rescript:quality] recompute config  Studio recompute — same shape, plus version/revision/savedAt of the settings source
[rescript:quality] recompute done    configHash, ms, results by mode
[rescript:draft] saved               the autosave that wrote the settings (surveyId, baseRevision → newRevision)
```

UI ⇄ saved ⇄ executed: the settings panel footer prints the on-screen fingerprint, the dashboard prints the persisted one, the runtime log prints the executed one. They must match; if they do not, the `definition.source` in the runtime log says which definition was loaded.

## 5. Dashboard & review — Data → Quality

Totals by classification (clickable filters), fraud-risk histogram, signal chips per category, decisions, coordinated clusters, search, sort. Row → review drawer: Quality score, Fraud risk, classification, recommendation (`INCLUDE` / `REVIEW BEFORE INCLUSION` / `LIKELY EXCLUDE`), signal groups, every flag as *what happened / expected / why it matters / points / related questions & respondents*, answers, telemetry summary (contents never stored), decision history. **KEEP / REMOVE / REVIEW LATER** with a reason → `responses.review_*` + a `response_reviews` audit row; *undo* clears. REMOVE never deletes.

## 6. Export & analysis hand-off

Data tab dataset selector = `dataset=all|clean|custom:CLS,...` on `/responses` (JSON, CSV, XLSX). *Clean* = KEEP decisions + unreviewed CLEAN (UNSCORED counts as clean); REMOVED never in clean/custom. CSV adds `QUALITY_STATUS, QUALITY_SCORE, FRAUD_RISK_SCORE, RESPONSE_STATUS` with `quality=1`. `format=xlsx` (exceljs) → **Main Data** (+ summary columns) · **Response Quality** (scores, classification, recommendation, one flag column per category, counts, cluster id, similar respondents, primary/secondary reasons, detailed explanation, researcher decision + timestamp) · **About**.

## 7. Privacy

Hashed IP and device only (salted per survey; `QUALITY_HASH_SALT`); clipboard lengths, never text; per-category telemetry switches; disclosure text; retention purge keeps scores, drops raw telemetry; longitudinal linking opt-in; every decision audited and reversible. All automated results are risk indicators requiring judgement — the UI and exports say so.

## 8. Tests

`packages/quality/src/engine.test.ts` (31 — incl. config fingerprint stability/change detection) — every rule family, benchmarks vs estimate, strictness presets, rule overrides, bands, custom rules over `calc.SYSTEM_*`, similarity weighting, coordinated cluster across a survey, explainability shape. `server.test.ts` (4) — hashes, peers, store, recompute with cluster ids. `scripts/quality-test.mjs` — settings UI → `def.quality` (+ save state, SYSTEM_* rule display, no-overlap layout, values survive leaving the tab), attention check, live event collector (visits, back, latency, paste lengths only, device, switches), dashboard (+ settings-in-effect card, older-settings markers, live gap), review drawer, decisions + audit, dataset selector + export links.
