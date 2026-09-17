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

- **Benchmarks** (`benchmarks.ts`): median total/page/question time of the survey's completes when ≥ `evidence.minPeers` (default 30); otherwise the definition's reading-time estimate (250 wpm + per-decision cost). Explanations say which ("vs. median of 40 completes" / "vs. estimated reading time"), and a flag against an estimate carries `evidence.estimateConfidence` (default 0.6) of its points with a caveat.
- **Rule catalogue** (`catalogue.ts`, 60+ rules): id, category, title, description, default severity, risk points, quality penalty, `enabledIn` per strictness, params with per-strictness defaults. Categories: timing (overall/page/question/matrix/open-end speeding, reading time, uniform timing, short dwell, idle-then-rush, timing entropy, acceleration, cross-respondent timing match), matrix (straight-lining incl. reverse-worded rows, diagonal, alternating/repeating, low variance, midpoint, extremes, identical signature), consistency (answer where hidden — "owns a car: No, brand: Toyota", repeat pairs, frequency vs quantity, piping), pattern (low/high entropy, non-substantive, middle/extreme bias, acquiescence, mechanical alternation, rare options), attention (failed, multiple, knowledge gap), open ends (short, gibberish, repeated, generic, irrelevant, contradicts closed answers, cross-respondent duplicate/near-duplicate, AI-like polish **as risk**, pasted), interaction (paste ratio, rapid paste+submit, out of focus), navigation (cycling, reloads, fingerprint match, screener edits), device (duplicate signature, webdriver, timezone), network (duplicate IP, IP density, provider risk — `SYSTEM_NETWORK_RISK` hook), bot (machine timing, no interaction, impossible sequence), duplicate (rarity-weighted answer agreement, multi-signal), cluster (coordinated, burst), screener (repeat attempts, inconsistent, fast), history (poor record).
- **Similarity** (`similarity.ts`): agreement weighted by how *rare* each agreed value is in this survey; links = high similarity + a shared signal (device/IP hash, navigation fingerprint, identical grids, timing profile, identical open ends) or extreme similarity alone; union-find closes links into clusters with `CLUSTER_ID`, `SIMILAR_RESPONDENT_IDS`, `CLUSTER_RISK_SCORE`.
- **Scoring** (`score.ts`): fraud risk = signals combined *within* a category first (`correlated`: the strongest counts in full, the rest add a little) and noisy-OR *across* categories; quality = 100 − Σ penalties. **Never combined.** The band comes from the risk score; the **verdict** (§3b) comes from the evidence, and the band is capped at what the verdict supports. Custom rules may raise the floor. Every flag: `ruleId, category, severity, title, explanation, observed, expected, riskPoints, qualityPenalty, role, strength, confidence, caveat?, questionIds, relatedSessionIds, at`.
- **SYSTEM_\*** (`types.ts SystemVars`): durations, ratios, focus/clipboard/navigation counts, device fields, hashes, matrix signatures, open-end hashes, per-category scores, quality/risk/status, similarity/cluster fields, flag counts — stored with the assessment and exposed to custom rules as `calc.SYSTEM_*`.
- `assessSurvey()` — all responses of a survey with final cluster ids (recompute).

Server glue `@rescript/quality/server`: `loadPeers`, `assessAndStore`, `recomputeSurvey`, `hashIdentifier`, `deviceHashFrom`, `clientIp`.

## 3b. Evidence & verdict — why nobody is "bad" for one failed check

The engine used to be a single number: every rule that fired added its points
to a noisy-OR, the number fell into a band, the band was the answer. On a real
project the first twelve completes — the research team testing the live link
from one office — came out HIGHLY SUSPICIOUS almost to a person: seven of
seven from one IP, two or three per device signature, every page "too fast"
against a reading-time estimate that assumes each word is read, one paste.
Each signal was small. Together, treated as independent facts, they passed 60.
`packages/quality/src/dataset.test.ts` reproduces this exactly ("THE OFFICE
THAT TESTED ITS OWN SURVEY") and shows the old model flagging most of them
and the new one flagging none.

What changed, and where the researcher controls it (Survey settings → Quality
checks → **Evidence & verdict**, stored in `def.quality.evidence`):

| Problem | Fix | Setting |
|---|---|---|
| Five "fast" rules on one quick respondent were five facts | Signals in one category combine as **correlated**: top signal in full + 35 % of the noisy-OR of the rest, scaled by what's left | `combination` (`correlated` / `independent`) |
| Speed judged against an estimate from 8 completes | Medians trusted from **30** completes; below, flags carry 60 % confidence and a caveat, and cannot be "strong" | `minPeers`, `estimateConfidence` |
| "7 of 7 from one IP" on a 7-person study | Share-of-completes rules (`device.duplicate`, `network.ip_density`) are **informational** below 30 completes | `minPopulation` |
| Observations counted as fraud | 21 rules are informational by default (midpoint, extremes, acquiescence, pasted, out of focus, duplicate IP, …): checked, shown, never move the verdict. Any rule can be switched either way | per-rule **counts / informational** toggle (`rules[id].role`) |
| A high band from weak, correlated evidence | **FLAGGED** needs a strong (≥ 25 design points), confident (≥ 0.75) classifying flag, or moderate (≥ 12) classifying flags in `flaggedMinCategories` independent categories, on top of the risk band. Otherwise a risk above `bands.review` is **REVIEW** | `flagged` (`strong_or_two_categories` / `bands_only`), `flaggedMinCategories` |
| Opinion agreement read as duplication | `duplicate.answers` is informational unless the answer signature is identical; grid matches no longer count as a shared cluster signal; `matrix.signature_match` tests expected twins; `matrix.alternating` folds reverse-worded rows | rule fixes, not settings |

Every assessment now says **why**: `verdict` (`PASS` / `REVIEW` / `FLAGGED`)
and `evidence { strong, moderate, weak, informational, categories, because,
carriedBy }`. `because` is the one-line answer to "why was this respondent
flagged?" and is shown in the Quality table's *Why* column, at the top of the
review drawer, in the XLSX *Response Quality* sheet (columns *Verdict*, *Why*,
appended last so client scripts keep their column numbers), and in
`reasons[]`. Informational flags are listed with "noted, does not affect the
classification".

Assessments written before the verdict existed show a band-derived verdict in
the dashboard (CLEAN → PASS, REVIEW → REVIEW, above → FLAGGED) until
re-assessed — "Re-assess all" applies the current settings.

**Test dataset.** `buildQualityDataset()` (`dataset.ts`) is 224 synthetic
respondents to a 14-question car survey: 158 valid (ordinary, fast-but-legit,
slow, satisfied customers who agree, one tab switch, skipped optionals, an
office sharing IP and devices, back + reload), 20 borderline (quick and thin,
one straight-lined grid, pasted answers, away several times) and 46 invalid
(bots, speeders failing attention, all-grid straightliners, gibberish,
duplicate pairs on one device, webdriver). The tests hold: no valid respondent
FLAGGED and ≥ 90 % PASS; no borderline FLAGGED; no invalid PASS and ≥ 85 %
FLAGGED; every verdict has a `because`. With defaults: valid 155 / 3 / 0,
borderline 16 / 4 / 0, invalid 0 / 4 / 42 (PASS / REVIEW / FLAGGED).
`summarizeDataset()` gives the same table for any config.

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

Header cards count by **verdict** (PASS / REVIEW / FLAGGED) and, beside them,
by risk **band**; both filter the table. Each row shows verdict, band, scores,
classifying signal categories (informational ones as "+n noted") and the
*Why* line. The review drawer opens on "Why was this respondent flagged?" with
the evidence tally, then every flag with its strength, confidence, caveat and
role.

Totals by classification (clickable filters), fraud-risk histogram, signal chips per category, decisions, coordinated clusters, search, sort. Row → review drawer: Quality score, Fraud risk, classification, recommendation (`INCLUDE` / `REVIEW BEFORE INCLUSION` / `LIKELY EXCLUDE`), signal groups, every flag as *what happened / expected / why it matters / points / related questions & respondents*, answers, telemetry summary (contents never stored), decision history. **KEEP / REMOVE / REVIEW LATER** with a reason → `responses.review_*` + a `response_reviews` audit row; *undo* clears. REMOVE never deletes.

## 6. Export & analysis hand-off

Data tab dataset selector = `dataset=all|clean|custom:CLS,...` on `/responses` (JSON, CSV, XLSX). *Clean* = KEEP decisions + unreviewed CLEAN (UNSCORED counts as clean); REMOVED never in clean/custom. CSV adds `QUALITY_STATUS, QUALITY_SCORE, FRAUD_RISK_SCORE, RESPONSE_STATUS` with `quality=1`. `format=xlsx` (exceljs) → **Main Data** (+ summary columns) · **Response Quality** (scores, classification, recommendation, one flag column per category, counts, cluster id, similar respondents, primary/secondary reasons, detailed explanation, researcher decision + timestamp) · **About**.

## 7. Privacy

Hashed IP and device only (salted per survey; `QUALITY_HASH_SALT`); clipboard lengths, never text; per-category telemetry switches; disclosure text; retention purge keeps scores, drops raw telemetry; longitudinal linking opt-in; every decision audited and reversible. All automated results are risk indicators requiring judgement — the UI and exports say so.

## 8. Tests

`packages/quality/src/engine.test.ts` (31 — incl. config fingerprint stability/change detection) — every rule family, benchmarks vs estimate, strictness presets, rule overrides, bands, custom rules over `calc.SYSTEM_*`, similarity weighting, coordinated cluster across a survey, explainability shape. `server.test.ts` (4) — hashes, peers, store, recompute with cluster ids. `dataset.test.ts` (9) — the 224-respondent dataset (§3b): population counts, no valid or borderline respondent FLAGGED, no invalid one PASS, every verdict explained, band consistent with verdict, and the office-that-tested-its-own-survey reproduction under the new and the old model. `scripts/quality-test.mjs` — settings UI → `def.quality` (+ save state, SYSTEM_* rule display, no-overlap layout, values survive leaving the tab), attention check, live event collector (visits, back, latency, paste lengths only, device, switches), dashboard (+ settings-in-effect card, older-settings markers, live gap), review drawer, decisions + audit, dataset selector + export links.
