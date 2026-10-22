# Closing the gaps against competitors — group 2 (2026-10-22)

Group 2 of the Intelligent Mode weakness list: AI-moderated interviews, AI qualitative synthesis, advanced models from Intelligent Mode, and the conjoint suite. Multilingual support was left out on request.

Competitor descriptions come from public product material up to mid-2026. Web search was not available while building, so nothing here was checked against the competitors' current products.

| # | Gap | What was built | Compared with | Detail doc |
|---|---|---|---|---|
| 6 | No AI live interview | AI-moderated 1:1 interviews from a public link: text, turn-based voice, or voice with camera. Consent, then a screener, then the guide with dynamic probes. The moderator tracks time and objective coverage, and handles distress, abuse and injection attempts. If the AI provider fails, it continues with scripted questions. A live observer view lets the researcher end or exclude an interview. Transcripts flow into the qualitative tables. Intelligent Mode action: `configure_ai_interviews` | Outset, Listen Labs, Glaut, Conveo | `AI-INTERVIEWS-2026-10-22.md` |
| 7 | No AI theme summaries | Theme summaries with exact-quote evidence. Study-level insights per objective, labelled "not enough evidence" when it is lacking. Auto-coding of new transcripts. Blind double-coding with Cohen's κ and Krippendorff's α. Highlight reels exported to Word and PowerPoint. Transcript editing that re-anchors quotes. Long WAV and MP3 audio is split for transcription. Ask-the-data answers cite excerpts. Remesh-style text group sessions with live clustering and peer voting | Dovetail, Marvin, Yabble, Remesh | `QUAL-SYNTHESIS-AND-GROUPS-2026-10-22.md` |
| 8 | HB/LCA/SEM only in Data Analytics | These can now be plan items and be proposed by Intelligent Mode: HB, latent class, SEM/CFA, bootstrapped mediation, McDonald's ω and Gabor–Granger. One readiness rule; applying a plan item runs it. A plain-language reading plus a gated AI interpretation, included in reports. Results go stale on new completes and can be re-run | quantilope (quinn) | `ADVANCED-MODELS-INTELLIGENT-2026-10-22.md` |
| 9 | No ACBC estimator; menu-based conjoint counts only; no rating-based conjoint | ACBC estimator (BYO, screening, tournament; aggregate and HB; summed price). Menu-based estimation (per-item models, cross-effects, HB, menu simulator). Rating-based conjoint (CVA). Dual-response None. Brand-specific and labelled CBC. One simulator for every method: shares, revenue, willingness to pay, demand curves, sensitivity, optimisation, segments, and Excel/PowerPoint export | Sawtooth, Conjointly | `CONJOINT-SUITE-2026-10-22.md` |

## Validation highlights

**Conjoint recovery on synthetic data with known parameters**

| Method | Result |
|---|---|
| CVA | max error 0.106, individual r 0.943 |
| ACBC HB | max error 0.134, individual r 0.796, price slope within 1 % |
| Menu HB | all R̂ < 1.1, individual r 0.775 |
| Dual-response None | estimated −0.394 against a true −0.4 |

**Statistics**

- The bootstrap matches a Python reference bit for bit.
- McDonald's ω matches published semTools values.
- κ and α match hand-computed values.

**Qualitative evidence.** Every quote is an exact substring of its source. Counts come from the code, not the model. Excerpts that read as instructions cannot support a claim on their own (this was found and fixed during the eval).

## Verification

- **Unit tests:** see the commit message for the final counts. All pass.
- **Checks:**
  - typechecks (Studio, runtime, renderer) clean;
  - public docs current;
  - dependency boundaries 0 violations;
  - auth-guard audit 230 handlers, 0 problems.
- **SQL:** 0068, 0069 and 0070 applied twice together on Postgres 16. The qual-research, AI-interviews and qual-synthesis SQL tests pass.
- **Evaluation:** fake provider 55/55; the moderator evaluation passes 14/14 against a scripted stand-in model.
- **New browser suites, passing:**
  - `ai-interview` (9)
  - `qual-synthesis` (10)
  - `group-session` (7)
  - `advanced-models-intelligent` (18)
  - `conjoint-suite`
- **Regression suites:** passing. See the commit message for the list.
- **Dev-server memory:** the Studio dev server now grows past 3 GB while compiling large routes. Under shared memory it was killed several times during the browser runs. Every suite passed on a freshly started server. This affects development only, not the production build, but it should be watched.

## Not done (honest list)

- **Interviews:**
  - **Voice:** turn-based, not full-duplex with interruption, because that needs a realtime provider SDK.
  - **Multi-party and live sessions:** no multi-party video and no live human-moderated sessions.
  - **Participant page:** labels are English only; the scripted fallback speaks only English and Hindi.
  - **Alerts and recruiting:** no e-mail or Slack alert for distress, and no panel recruitment integration.
- **Synthesis:**
  - **Background processing:** auto-coding and group sessions advance only while a page is open, because there is no background worker.
  - **Video:** no video stitching for highlight reels.
  - **Long audio:** only WAV and MP3 are split.
  - **Ask-the-data:** retrieval is keyword-based, not semantic.
  - **Claim checks:** they are mechanical, not semantic.
- **Advanced models:**
  - **Latent class:** no covariates and no latent-class choice model.
  - **SEM diagram:** not in Word or PowerPoint; those get the paths as a table.
  - **Interpretation:** one model at a time, not free conversation over all results the way quinn does.
- **Conjoint:**
  - **Not supported:** latent-class choice, ranking-based conjoint, ACA, and HB for CVA.
  - **ACBC:** price is linear only.
  - **Menu:** no volumetric menus.
  - **Simulator:** no calibration to market shares, no source-of-volume table, and no interactive simulator screen; scenarios are set through options or Intelligent Mode.
- **Real model:** none of the AI behaviour has run against a real model yet. Run the eval (`/platform` panel or `EVAL_AI_API_KEY`) and the moderator eval (`scripts/eval-moderator.mjs` with the `EVAL_AI_*` variables).

## Deploy

1. **Migrations, before the code:**
   - **0069** `ai_interviews` — required for AI interviews against the database. It widens the 0065 transcript checks to accept `ai_interview`.
   - **0070** `qual_synthesis_and_groups` — syntheses, jobs, double-coding, highlights, transcript revisions and group sessions.
   - **0068** `ai_eval_runs` — still optional.

   All are re-runnable.
2. **Run `pnpm install`.** The runtime now declares `@rescript/analytics` and `@rescript/storage`.
3. **Deploy.** No new required environment variables. Voice interviews use the existing STT and TTS configuration (`AI_STT_*` or BYOK).
