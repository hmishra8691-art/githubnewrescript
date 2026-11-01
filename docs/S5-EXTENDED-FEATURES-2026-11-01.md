# S5a — Extended features, part A: multimedia and gamification (2026-11-01)

Branch `feat/persistent-execution-engine`, from `939109e` (S4c). Audit: `SCRIPT-STUDIO-AUDIT-2026-10-30.md` rows MM2-04, MM2-06, MM2-09, MM2-15, GA-06, GA-07, AQ-12.

- No new npm dependencies. The 360° viewer (MM2-15) is therefore **out of scope** (see §6).
- Schema changes are optional fields only (backward compatible). An existing survey renders exactly as before.
- No migrations. Respondent video is stored as the existing `answer_upload` kind, so there is no new `media_objects.kind`.
- Every feature can be reached three ways: the Studio, Intelligent Mode (an action in the capability registry), and the public docs (regenerated from source).

## 1. MM2-04 — Image zoom / lightbox

**Setting.** `settings.zoom` on a question, and `mediaItems[].zoom` on one stimulus item. The values are:
- `off`;
- `click`: the image opens in a lightbox;
- `hover-magnifier`: a lens follows the pointer, and a click or Enter still opens the lightbox, so keyboard and touch users get the same zoom.

An item's own `zoom` wins over the question's. When neither is set, zoom is `off`.

**Default (decision).**
- An absent setting is `off`, so existing surveys are unchanged.
- The image variants default to `click` in their variant defaults, so a **new** image question zooms. These variants are `single_select.image`, `multi_select.image`, `image.choice`, `image.grid`, `image.comparison`, `comparison.side_by_side` and `ranking.image`.
- `set_question_media` never turns zoom on by itself.

**What zooms.**
- Stimulus images (`QuestionMedia`). The image becomes a button named "Enlarge image: <alt>".
- Images inserted in the question text. They get a button role, `tabindex` and Enter/Space handling.
- Option images in ImageSelect and on the compare cards. Each gets a separate "⤢" Enlarge button, so clicking the image itself still selects the option.

Videos and embeds are never zoomed.

**The lightbox** (`packages/renderer/src/Lightbox.tsx`):
- It is `role="dialog"` with `aria-modal="true"`, labelled by the alt-text caption.
- Focus starts on Close and stays inside the dialog: Tab and Shift+Tab cycle its buttons.
- Escape, the close button or a click on the backdrop closes it, and focus returns to the opener.
- Zoom runs from 1× to 5×, by the buttons, `+` `−` `0`, the wheel, a pinch or a double click.
- Pan by dragging or with the arrow keys. Pan is bounded so the image never leaves its frame (engine `mediaZoom.ts`: `clampScale`, `clampPan`, `wheelScale`, `pinchScale`).
- There is no transition under `prefers-reduced-motion`.
- It has no portal: it is `position: fixed`, because the renderer does not depend on `react-dom`.

**Paradata.** Each opening adds 1 to `ZOOMED_<CODE>`. This is embedded data, through the new `QRProps.onParadata`, which the Runner writes into `state.embedded` (names must match `[A-Z][A-Z0-9_]*`). It is declared in the variable dictionary, so it is an export column.

**Studio.** Properties → Image zoom. The media list editor has a per-item zoom setting.

**IM.** `set_question_media {zoom: off | click | hover-magnifier}`. An item can carry its own `zoom`. A bad value is refused.

## 2. MM2-06 — Before / after comparison slider

**Variant.** `comparison.before_after` "Before / After Slider": numeric base type, renderer `beforeafter`. It sits in the comparison family, beside side-by-side and attributes.

**Images.** The two images are the question's stimulus: `mediaItems[0]` is before (left of the divider) and `mediaItems[1]` is after. IM sets them with `create_question` and then `set_question_media` with two items.

**Settings** (`settings.beforeAfter`):
- `beforeLabel` and `afterLabel`;
- `startPosition` (0–100, default 50);
- `askRating` (default true), `ratingPrompt`, `minLabel` and `maxLabel`.

**The answer.**
- With `askRating` on, the answer is the rating after (`minValue..maxValue`, default 1–5).
- With `askRating: false`, the answer is the final divider position (0–100). The Studio switches the bounds to 0–100, and `lintBeforeAfter` flags bounds that cannot hold it.

**Divider.**
- It is a real `role="slider"` with `aria-valuenow` and `aria-valuetext`.
- Keyboard: arrows move ±5 %, PageUp and PageDown move ±25 %, Home and End go to 0 and 100.
- A pointer drag works anywhere on the frame.
- The rating is a radio group with 44 px targets.

**Recording** (`settings.recordPosition`). This writes, as embedded data that is exported:
- `BA_<CODE>_POSITION`: the last position;
- `BA_<CODE>_DWELL_BEFORE` and `BA_<CODE>_DWELL_AFTER`: seconds with the divider at ≥ 50 % (the before image fills most of the frame) and below 50 %.

These are written on every move and once more when the question unmounts. Dwell is measured in the browser, so it is client-asserted paradata.

**Studio.** `variantConfig/beforeAfter.tsx` has two image pickers with alt text, the labels, the start position, rating on/off, the scale and end labels, and record position, plus lint.

## 3. MM2-09 — Respondent video recording

**Variant.** `media.video_recording` "Video Recording / Video Response": base type `upload`, renderer `videorecording`. Its defaults are:
- 60 s limit;
- 3 re-records;
- 50 MB;
- file upload allowed;
- a consent sentence.

**The respondent's flow** (`packages/renderer/src/variants/videoRecording.tsx`):
- **Consent.** The consent text is shown with a checkbox, and the camera button stays disabled until it is ticked. Unticking it releases the camera.
- **Recording.** `getUserMedia({video, audio})` shows a live, muted, mirrored preview. Start / Stop shows the elapsed time and the limit. At `maxAnswerSeconds` (5–600) the recorder stops itself.
- **Recorder settings.** WebM vp8/opus is tried first, then MP4. The bitrate is 900 kbit/s video plus 96 kbit/s audio.
- **Playback.** Re-record is offered while takes remain (`maxRetakes`).
- **Screen readers.** A polite live region says "Recording", "Saving your video" and "Video saved".
- **Fallback.** With no MediaRecorder, no camera or a refused permission, the respondent gets a note and a video file input (`capture="user"`). The same rules apply to the file. "Upload a video file" can also be offered beside the camera (`allowFileUpload`, default true).

**Storage — the existing resumable pipeline.**
- The take goes through `uploadFile`, then `/api/session/media/{ticket, parts, confirm}`, as an `answer_upload`.
- That means the same bucket, the per-session path, the year-long signed URL, deletion and the media delivery e-mail as every other respondent file.
- The answer is the upload's `[{url, name, size, type}]`.
- A preview or a sandbox test link (`/n/`) has no session storage. There, the take stays in the browser (a data URL up to 2 MB, otherwise an object URL) and is saved with the answers, as for every upload.

**The rules** (`packages/media/src/answerVideo.ts`). They are checked three times:
1. In the browser before the upload: `answerVideoRule`.
2. On the **ticket** route before a URL is issued: 415 for the type, 413 for the size. This applies when the question is a video recording.
3. On the **confirm** route against the stored object: `verifyAnswerVideo` in `store.ts`. It applies the type and size rule to the stored size and type, then **sniffs** the first bytes: EBML `1A45DFA3` for WebM, an ISO-BMFF `ftyp` box for MP4 or MOV. A mismatch is removed from the store, the row is marked `failed` and 415 is returned.

What the rules allow:
- Types: `video/webm`, `video/mp4` and `video/quicktime` only (codecs parameter ignored).
- Size: at most the question's `maxSizeMb`, never above 50 MB (`ANSWER_VIDEO_MAX_BYTES` — the store's default global limit).

The existing auth (`sessionForMedia`, the session ownership check on confirm) and the generic size checks are unchanged.

**Storage cost.**
- About **7.5 MB per recorded minute** at the recorder's bitrate. For example, 1,000 respondents × one 60-second answer ≈ 7.5 GB in `rescript-uploads`.
- Files are kept a year, like every respondent file.
- `answerVideoStorageEstimate(seconds, respondents)` gives the figure.
- There is no server-side transcoding and no transcript of a video answer.

**Studio.** `variantConfig/videoRecording.tsx`: length, re-records, size, consent text, the upload fallback and the cost note, with lint (`lintVideoRecording`).

**Capabilities.** `platform:respondent_video` is now supported. The `video_interview` note no longer says "no respondent video".

## 4. GA-06 / GA-07 — Points, badges and levels

**Setting.** A survey-level `gamification`:

| Part | What it holds |
|---|---|
| `points` | `perAnswer` (default 10), `perCorrect` (from the answer key, default 0), `customVariable` (a calculation added to the points) |
| `badges[]` | `id`, `title`, `description`, `icon` from the built-in set, `when` (a Condition) |
| `levels[]` | `name` and `minPoints` |
| `hud` | `show` and `position`: top-right, top-left, bottom-right or bottom-left |

The built-in icons are star, trophy, medal, rocket, fire, heart, lightbulb, target, crown and check.

**Engine** (`gamification.ts`). The variables are computed at the end of `runCalculations`, so the Runner and every other caller of the flow compute them identically. All of them are **calculated variables** declared in the dictionary, so they are export columns:

| Variable | Meaning |
|---|---|
| `POINTS_ANSWERED` | top-level answers of respondent-facing questions |
| `POINTS_CORRECT` | answers that match `question.assessment.correct` |
| `POINTS` | perAnswer × answered + perCorrect × correct + the custom variable |
| `LEVEL` | 1-based index of the level reached; value labels are the level names |
| `LEVEL_NAME` | the name of that level |
| `BADGES` | earned badge ids, comma-separated |

**Badges are one-time.** An earned badge is kept even when its rule later stops being true.

**Badge rules.**
- Shortcuts: `POINTS >= 30`, `POINTS_CORRECT >= 3`, `POINTS_ANSWERED >= 10`, `LEVEL >= 2`.
- Any condition the logic grammar reads, for example `Q3 = 1`.
- Or `minPoints`.

**The answer key in the browser (decision).** `stripAssessmentSecrets` now keeps the key in the respondent's copy when `perCorrect > 0` and the survey is **not** a scored paper. The HUD reveals which answers scored anyway, which is the D14 quiz rule.
- In a scored paper the key is still withheld. There, POINTS counts answer points only.
- Note: `set_answer_key` turns a paper on.

**Runtime.**
- `GamificationHud` (renderer) is a `role="status"`, polite region in the chosen corner. It shows the points, the level and the badge icons, each with a name ("Badge: Sharp mind"). A "pop" plays only with `prefers-reduced-motion: no-preference`.
- A newly earned badge opens the **native popup** (`uxPopup`: placement top, closes by itself after 5 s) with the icon, title and description.

**Studio.** Survey Settings → Gamification:
- points and the custom variable;
- the HUD;
- badges added with a title, an icon and the rule as text;
- levels;
- lint (`lintGamification`: duplicate ids, a custom variable that is not a calculation, no points ever).

**IM.** `set_gamification`:
- `perAnswer`, `perCorrect`, `customVariable`;
- `badges`, `addBadges` and `removeBadges`, where a badge's `when` is text, a condition or `minPoints`;
- `levels`, `hud`, `enabled`, `clear`.

The result is schema-checked and linted. There is a UX guide line, a registry native feature (`gamification`) and the capability `platform:gamification`.

## 5. AQ-12 — Review your answers

**Setting.** A flow page setting: `page.review {enabled, title, textLimit 20–2000 (default 200), excludeQuestionIds}`.

**What is listed** (`reviewSummary`, engine `reviewPage.ts`):
- Only pages on the visited or seen trail **before** the review page.
- They are grouped by their outermost block or section.
- Only questions shown with the current answers. Hidden, calculated and content questions are never listed, and neither are excluded ones.

**How answers are shown.**
- Choices as option labels.
- Grids as row: value pairs.
- Files by name.
- Open-end text cut at `textLimit` with "…".

**Change / Return.**
- **Change** (named "Change your answer to: <question>") jumps back through section navigation's `goToPage`. It uses Back's semantics, so only visited pages can be reached.
- The page it lands on shows **Return to review**. This jumps forward through `goToPage` with mode `visited` (validated as Next would), even when the survey's navigator is off.

**Rendering.** `ReviewPanel` (renderer) shows the heading, one labelled region per section, and a definition list.

**Studio.** Survey Flow → the block card's page → Review page, and the page node editor.

**IM.** `set_review_page`:
- `{add: true}` adds a new page with a short text block at the end of the last block;
- `{page}` names an existing page, by its id or a question on it;
- `title`, `textLimit`, `exclude`, `clear`.

There is a UX guide line, the registry entry `review_page` and the capability `platform:review_answers`.

## 6. MM2-15 — 360° panorama: not available

Not built. A viewer (Pannellum or Photo Sphere Viewer) would be a new dependency, which this step excludes.

The capability registry has `platform:panorama_360` with status `not_supported`. Its reason names the alternatives:
- a flat equirectangular image with Image zoom (pan and zoom in the lightbox);
- a 360° video from a provider (YouTube) through `set_question_media`.

The registry's media summary says the same.

## 7. Verification

The final sweep ran at the item 6 commit.

**Unit tests**

| Package | Result |
|---|---|
| Engine | 2609/2609 (new: s5aZoom 5, s5aBeforeAfter 6, s5aVideo 4, s5aGamification 6, s5aReview 4) |
| Schema | 18/18 |
| Media | 179/179 (new answerVideo.test 5) |
| Designs | 124/124 |
| Analytics | 396/396 |
| Exporters | 141 pass, 2 skipped (as before) |
| Templates | 111/111 |
| Quality | 61/61 |
| Renderer | 11/11 |
| Runtime lib | 75/75 |
| Studio lib | 1132/1132 |

**Checks**

- Typecheck (`tsc --noEmit`) on renderer, studio and runtime: 0 errors each.
- `gen-public-docs --check`: current.
- Dependency boundaries: 0 violations.
- Auth guard: 0 problems across 259 handlers.

**Browser suites**

| Suite | Result |
|---|---|
| `s5a-media-gamification-test` (new) | 16 passed in one full run (68 s) |
| `variants-g5-test` | ok (194 s) |
| `variants-g6-test` | ok (416 s) |
| `im-media-test` | ok (36 s) |
| `section-nav-test` | ok (59 s) |
| `s4a-respondent-test` | ok (93 s) |

Earlier runs of the new suite failed and were fixed, or were lost to memory:
- Section D: the answer key was stripped from the respondent's copy, so correct-answer points were 0. Fixed in `stripAssessmentSecrets` (see §4).
- Section C: a race while attaching the preview stream. Fixed: the stream is now attached in an effect.
- Section E: a wrong expected string in the test.
- One whole-suite run hit an out-of-memory kill in section C ("Page crashed"). That run counts as not verified. The full rerun passed.

Next-server processes were killed for memory several times during the regression batch (cgroup out of memory). All six regression suites still reported ok.

**Browser: `scripts/s5a-media-gamification-test.mjs`.** Sections A–F; A–E run on the runtime, F in the Studio:
- **A — zoom.** Option image Enlarge → dialog, focus trap, bounded zoom, Esc, focus return, ZOOMED_Q1 counts; stimulus by keyboard; hover lens.
- **B — before/after.** Slider keys, drag, rating answer, BA_* paradata.
- **C — video.** Chromium's fake camera (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`) on a sandbox test link: consent → preview → record → stop → playback → a `video/webm` answer saved in the sandbox row. With no devices: the fallback refuses a PNG and takes a WebM.
- **D — gamification.** HUD 0 → 15 → 30, two badge popups, levels, one-time badges, POINTS / BADGES / LEVEL saved in the sandbox row.
- **E — review.** Grouping, truncation, hidden question absent, Change → Return.
- **F — Studio.** Image zoom, the before/after editor, the review page, the gamification card.

The sandbox row route (`/api/session/sandbox` action `row`, sandbox-only) gained `pick` so a suite can read named stored values. File answers are summarised as name, type and size, never their bytes.

## 8. Known limitations

- **Zoom.** `ZOOMED_<CODE>` is one count per question, not per loop iteration.
- **Before/after.** Horizontal wipe only.
- **Video.**
  - The resumable upload, ticket and confirm checks need a configured store. They were exercised by unit tests (`answerVideo.test.ts`, including `verifyAnswerVideo` on a stub store), not against Supabase or R2 in this session.
  - The sandbox and preview keep the take in the browser.
- **Gamification.**
  - POINTS counts top-level answers, not loop iterations.
  - There is no cross-respondent leaderboard.
  - In a scored paper, correct-answer points are not computed in the browser.
- **Review.** Loop iterations are listed as their pages were visited.

---

# S5b — Extended features, part B: telemetry and integrations (2026-11-01)

Branch `feat/persistent-execution-engine`, from `a8810ad` (S5a). Audit: `SCRIPT-STUDIO-AUDIT-2026-10-30.md` rows TE-02, TE-04, TE-06, TE-10, TE-12, TE-13, AP-09, AP-14.

- No new npm dependencies. **No migration**: the new paradata lives in the existing `responses.telemetry` jsonb, the per-response settings in the survey definition's `alerts`, and the response events use the existing 0072 outbox (`notify_events.payload` is jsonb).
- Schema changes are optional fields with defaults; an existing survey records what it did before plus the new categories (each with its own switch).
- **Privacy rule kept throughout:** never typed text in paradata. Visibility is times and percentages, answer history is codes / numbers (typed text: its length only), idle periods are durations. Each new collector has a switch in `quality.telemetry`; a switched-off category is listed in the telemetry's `disabled`, and the collector lists what it actually measured in the new `measured` field, so telemetry recorded before S5b (or in a browser without the API) reads as "not measured", never as zero. Privacy notes: `docs/RESPONSE-QUALITY.md` (Telemetry section) and the Studio's Quality → Telemetry & privacy switches.

## 1. TE-04 — Question visibility and scroll depth

**Collector** (`apps/runtime/lib/telemetry.ts`, arithmetic in `lib/paradata.ts`):
- One IntersectionObserver (thresholds 0 / .25 / .5 / .75 / 1) watches every question card (`[data-qid]`, review-page and assessment-report copies excluded). A card is **visible** when at least half of it is in the viewport, or — for a card taller than the viewport, which can never be half on screen — when it fills half the viewport.
- Per question: `visibleMs` (all visits) and `firstSeenAt` (epoch ms, like `firstChangeAt`). A hidden tab closes the open intervals; leaving the page closes them too.
- New cards (display logic on the same page) are picked up by a MutationObserver throttled to one rescan per 200 ms.
- Per page visit: `scrollDepth` — the deepest viewport bottom reached, % of the page height (a page that fits = 100), sampled at most once per animation frame.
- Switch: `quality.telemetry.visibility` (default on). No IntersectionObserver → "visibility" goes into `disabled`.

**Server.** The sanitiser moved from the save route to `apps/runtime/lib/telemetrySanitize.ts` (unit-tested); it keeps the new fields only when their category is on, clamps them, and keeps nothing it does not know. The sandbox save path now stores the sanitised telemetry in the sandbox row (the browser suite reads it back with `row` + `pick: {telemetry: true}`).

**Quality rule** `interaction.answered_unseen` (interaction, informational, medium, standard and up; `minQuestions` 3 / 2 / 1 / 1): questions the respondent changed by their own input whose card was never at least half visible — a person answers what they can see. Needs `visibility` and `timing`; skipped (not failed) when not measured.

## 2. TE-02 — Answer-value history

- Each change of a **closed** question appends `[ms since the survey started, value]` to the question's `history`, the latest 20 kept (`historyDropped` counts the rest). Closed = single / multi / dropdown / image select, NPS, slider, numeric, numeric list, ranking, allocation, single / multi / numeric / dropdown grids. Strings are cut to 40 characters, lists to 50 items, grids to 60 rows.
- **Typed text** (`open_text`, `long_text`, `text_list`, `matrix_text`) appends `{ len }` only. **Every other type** (upload, geo, date, …) appends nothing.
- The server **re-derives** the history from the definition's question types (`sanitizeTelemetry(t, cfg, types)`), so a tampered client cannot store text: text questions keep `{len}` only, unknown questions nothing.
- Switch: `answerHistory` (default on; needs `timing`, where the per-question entries live).
- **Quality rule** `interaction.flip_flop` (informational, low; `reversals` 4 / 3 / 3 / 2, `questions` 3 / 2 / 1 / 1): an answer went back to a value it had held before (not merely the one just left) — A→B→A is one reversal. Filling a grid row by row or ticking more boxes never counts; a ranking's order does. Open ends never count.

## 3. TE-06 — Inactivity

- An idle clock (`IdleClock`, `lib/paradata.ts`): any input, pointer down / move, key, wheel, touch or scroll is activity; a gap of `idleSeconds` (default 60, 10–3600) is an **idle period**, recorded when activity resumes or the page is left — so a throttled background timer never loses one. A 1-second timer only announces the start (for the prompt).
- Recorded: `idle.periods` (page, start in ms since the survey started, duration, `prompted`; the latest 100), `totalMs`, `longestMs`, `prompts`, and `idleMs` per page visit.
- **Prompt** (`idlePrompt`, **off by default**): when a period begins, the survey's **native popup** (`openUxPopup`, now exported by the renderer) opens centred with `idlePromptText` or the built-in UI string `idle_prompt` in the respondent's language ("Are you still there? Take your time — your answers so far are kept.", button label `idle_prompt_ok`). Any input closes it. Never shown in a hidden tab.
- Switch: `idle`. Studio: Quality → Telemetry & privacy (idle seconds, prompt, prompt text).

## 4. TE-10 — Timing in exports

`packages/exporters/src/paradataExport.ts`, both shapes computed from `responses.telemetry` with the quality engine's own `pageSeconds` / `questionSeconds`, so the export and the quality review agree:
- **Wide** (`timing=1` on the responses export; Data panel checkbox "Per-page / per-question timing columns"): `PAGE_<ID>_SEC` (every visit, out-of-focus time excluded) and `Q_<VAR>_SEC` (page entry → last change on the answering visit, else an equal share of the page), upper case, appended **last** (after `SYSTEM_*`) so no earlier column moves. CSV, SPSS / SAS / Stata (numeric, labelled "Seconds on page p1", "Seconds on AGE: How old are you?") and Excel (Main Data; the About sheet explains each column).
- **Long** (`format=timing`, Data panel "Timing, long format (.csv)"): one row per respondent × page (LEVEL=page) and × question (LEVEL=question): SESSION_ID, RESPONDENT_ID, STATUS, LEVEL, PAGE_ID, QUESTION_ID, VARIABLE, VISITS, SECONDS, VISIBLE_SECONDS, CHANGES, IDLE_SECONDS, SCROLL_DEPTH_PCT. Formula-guarded cells, optional BOM.
- A blank is "not measured" (no telemetry, timing off, never reached), never zero. The route selects `telemetry` only when one of these is asked for.

## 5. TE-12 / TE-13 — Script timing and IM quality settings

**`rs.getTiming()`** (behaviour scripts): `{ elapsedSeconds, pageSeconds, questionSeconds(code) }`, a frozen object.
- The Runner passes a snapshot of its telemetry to the UxLayer (`timing` prop: survey start, the current visit's entry and out-of-focus time, seconds per question **code**); it is copied into the sandboxed frame with the answers. The frame adds "now" itself, so elapsed / page time are current when read.
- **Read-only:** nothing goes back to the host — there is no write twin (a script cannot write paradata; `rs.setTiming` is refused by the gate as not part of the api).
- Null when the survey records no timing (`timing: false`) and outside the survey (the Studio canvas).
- Registered: `UX_SCRIPT_API`, `SANDBOX_API` (the capability registry), the public logic reference. The script corpus snapshot was updated for the longer api list in the gate's refusal text.

**`set_quality_settings`** (engine `qualityActions.ts`, an option-and-design op):
`{enabled, strictness, telemetry {timing, focus, clipboard, navigation, interaction, device, network, visibility, answerHistory, idle: bool; idleSeconds; idlePrompt; idlePromptText | null; disclosure | null}, rules {"<rule id>": {enabled, severity, params {<threshold>: value}}}}`.
- Rule ids and threshold keys are checked against `QUALITY_RULE_PARAMS` (schema), which a quality-package test asserts equals the rule catalogue — so the engine needs no dependency on the quality package. An unknown id or threshold is refused with the alternatives.
- Switching a category off is reported as destructive (its rules are skipped, its data not kept).
- Registry: native feature `quality_settings`, capability `platform:paradata`. Guide: `apps/studio/lib/copilot/qualityGuide.ts` (sent for quality / paradata requests, cached, its examples applied as written by a test; registered in `guideSelect`). Public docs regenerated.

## 6. AP-09 — Per-response webhook

**Events.** `response.completed`, `response.screened_out` (screened or terminated), `response.quota_full` — category `response`, severity low.

**Settings** (`alerts.responses`, **off by default**): `enabled`, `events` (completed / screened_out / quota_full), `includeAnswers` (default false), `allowFields` (variable names), `includeTest` (default false).

**Emission.** The runtime save route, on a final status, calls `responseEvents` (`apps/runtime/lib/notifyEmit.ts`) — through the same outbox, routing, signed generic webhook, retries (30 s → 2 min → 8 min → 32 min) and delivery log as every alert; one event per session (idempotency key `response.completed:<session>`).

**Payload** (`renderWebhook` → `response`): response id, status, `startedAt`, `completedAt`, `isTest`; with `includeAnswers`, `answers` by variable name (the engine's own flattening) and `withheld` — the names left out as likely PII: typed text of any kind, "other" / comment text, places, files and recordings, free-form tables, embedded / hidden fields, and anything validated or tagged as an e-mail, phone, postal code or URL. Listed `allowFields` are sent anyway.

**Guards.**
- Answers ride **only in the generic webhook** body. Slack, Teams, e-mail and the in-app bell get the one-line notice.
- Response events match only rules that **name** them (`response.completed`, `response.*`, `response`) — never a `*` rule written for operational alerts, and never the default bell.
- They are not batched by the hourly cap (one delivery per response by design); dedupe and quiet hours apply as before.

**Studio.** Research Tools → Qualitative → Alerts & panels → "Per-response events (webhook)" (on, statuses, include answers, allowed fields, test responses), plus the existing rule builder, which now lists the three events. **IM:** `configure_alerts {events: ["response completed", "screened out"], webhook: "<channel>", responses: {includeAnswers, allowFields}}`; naming a response event turns the per-response events on; `responses: null` turns them off. The integrations guide has the line.

**Not wired:** the sandbox save path (no database) does not emit response events; the browser suite does not cover delivery (the unit test uses a local stand-in HTTP server).

## 7. Out of scope

- **A public REST API with API keys** (AP-09's other half) needs an auth-model decision: key scopes, per-project versus per-organisation keys, rotation, rate limits. Webhooks push; nothing here pulls.
- **CRM and payments** need a vendor choice.
- **A script-callable network proxy (AP-14).** Scripts still reach nothing off the page; `rs.getTiming()` is read-only and the per-response webhook is configured by the researcher, never by a script.

## 8. Verification (S5b)

The final sweep ran at the item 6 commit plus the guide-selection fix in item 7.

**Unit tests**

| Package | Result |
|---|---|
| Engine | 2618/2618 (new: s5bQuality 4, s5bResponseEvents 5) |
| Schema | 18/18 |
| Media | 179/179 |
| Designs | 124/124 |
| Analytics | 396/396 |
| Exporters | 146 pass, 2 skipped (as before; new: 5 timing tests in statisticalExport.test) |
| Templates | 111/111 |
| Quality | 67/67 (new: answered_unseen ×2, telemetryOff, valueReversals, flip_flop, QUALITY_RULE_PARAMS = catalogue) |
| Renderer | 12/12 (new: rs.getTiming frame check) |
| Runtime lib | 88/88 (new: paradata.test 8, telemetrySanitize.test 6) |
| Studio lib | 1136/1136 (new: qualityGuide 3, notify service stand-in server 1) |

**Checks.** `tsc --noEmit` on renderer, studio and runtime: 0 errors each. `gen-public-docs --check`: current (actions-reference, capabilities and logic-reference regenerated in item 5). Dependency boundaries: 0 violations. Auth guard: 0 problems across 259 handlers.

**SQL.** No migration was needed (see the top of part B), so none was run.

**Browser suites**

| Suite | Result |
|---|---|
| `s5b-telemetry-test` (new) | 16 passed, one full run, 84 s — runtime only (the Studio stopped for memory) |
| `quality-test` | first run: out-of-memory crash after 6 checks (not verified); rerun: all 10 passed |
| `alerts-panels-test` | ok, 9 passed |
| `script-health-test` | section A (3 checks: the save route keeps the script-health entries in telemetry) passed twice; section B (Studio) timed out both times while next-server processes were OOM-killed — **not verified** |
| `analytics-test` | 50 checks passed, then a Studio timeout during an OOM kill — **not verified** |

An earlier run of `s5b-telemetry-test` through `fresh.sh` (Studio and runtime both up) lost the runtime to an out-of-memory kill in section A; that run counts as not verified, and the runtime-only rerun above passed.

**Browser: `scripts/s5b-telemetry-test.mjs`.** Sections A–D, all on the runtime (preview and sandbox test links):
- **A — visibility.** First card seen on arrival, the last only after a scroll; scroll depth 16 % → 100 %; a DOM-click answer on an off-screen card counts a change with no first-seen time; visible time closed on leaving; the sandbox row keeps the sanitised fields; visibility off → nothing collected, listed as disabled.
- **B — history.** 1→2→1→2→1 kept with rising relative times; a grid keeps its cells; typed text `{len}` only (the text appears nowhere, client or stored); off → counts only.
- **C — idle.** `idleSeconds` 10 + prompt: the native popup opens centred with the survey's words, a mouse move closes it, one prompted period; prompt off (default) → no popup, period still recorded; idle off → no record.
- **D — `rs.getTiming()`.** A behaviour script reads elapsed / page / question seconds (≥ the wait), unknown code null, frozen result; timing off → null.

## 9. Known limitations (S5b)

- **Visibility.** Needs IntersectionObserver (absent → not measured). A card counted as visible may still be covered by a popup. Loop iterations of one question share one entry.
- **Answer history.** Kept per question id, not per loop iteration. Writes by punches, scripts or defaults are not respondent changes and are not recorded.
- **Idle.** A respondent reading without touching anything for `idleSeconds` is idle by definition — the rule set does not yet read idle periods (the existing `timing.idle_then_rush` still uses dwell).
- **Exports.** Telemetry must be kept: with `privacy.telemetryRetentionDays` expired, or timing switched off, the cells are blank. Question seconds follow the quality engine's definition (first answering visit), not total time on screen — `VISIBLE_SECONDS` in the long file is that.
- **`rs.getTiming()`.** The page / question seconds are as of the host's last update plus wall-clock time in the frame; out-of-focus time after that update is not subtracted until the next one. The time is client-asserted, like every condition that reads `time_on_page`.
- **Per-response webhook.** PII detection is heuristic (types, variants, semantics, validation kinds) — a closed question whose codes are themselves identifying is not caught; `allowFields` is the explicit override in the other direction. The sandbox save path does not emit response events. Delivery was tested with a local stand-in server, not end-to-end from a browser.

---

# S5c — Extended features, part C: research methods polish (2026-11-01)

Branch `feat/persistent-execution-engine`, from `4f69108` (S5b). Audit: `SCRIPT-STUDIO-AUDIT-2026-10-30.md` rows SM-07, SM-08, SM-10, SM-13, SM-14, SM-16, SM-18.

- No new npm dependencies. **No migration.** Every new setting is an optional schema field; a survey without it behaves exactly as before.
- Every analysis added here is checked in unit tests against reference values computed by hand and re-checked with an independent script, not only "it runs".
- One copilot action, `add_method_template`, inserts each method as a complete programmed block plus the analysis-plan items that read it. The starter templates in `packages/templates` are built from the same engine fragments (`methodTemplateFragment`), so a survey opened from "New survey" and a block that Intelligent Mode adds are identical.

## 1. SM-08 — Van Westendorp: honest end-points and the Newton–Miller–Smith extension

**End-points** (`pricing` option `vwCurves`):
- `proxy` is the default and is unchanged. It sets PMC = "too cheap" ∩ "expensive" and PME = "cheap" ∩ "too expensive", which is common practice.
- `textbook` uses the "not" curves: PMC = "too cheap" ∩ "not cheap" (100 − cheap) and PME = "too expensive" ∩ "not expensive" (100 − expensive).
- The result's note names the definition it used and gives the other definition's values. The curves table now has "not cheap" and "not expensive" columns.
- OPP and IPP are the same under both definitions.

**NMS** (`nmsCheap` and `nmsExpensive`, plus optional `calibration`). This is purchase likelihood at the respondent's own "cheap" price and own "expensive" price:
- Each respondent's purchase probability is piecewise linear: (too cheap, 0) → (cheap, p_cheap) → (expensive, p_expensive) → (too expensive, 0), and 0 outside that range.
- Trial is the mean of those probabilities. Revenue is price × trial.
- The trial optimum is always a grid price. The revenue optimum is solved exactly on each segment, where revenue is a parabola.
- The default calibration for a 5-point scale (top box first) is 0.7 / 0.5 / 0.3 / 0.1 / 0. This is a commonly used calibration, not a value taken from the 1993 paper; set your own with `calibration`.

**Template `pricing_psm`.** The four price questions and the NMS pair, with the cheap / expensive answer piped into the NMS questions. Code: `packages/analytics/src/analyses/pricingModels.ts`.

## 2. SM-07 — Adaptive Gabor–Granger: `numeric.price_ladder`

**A variant, not a loop.** Engine loops iterate a list that is fixed when the loop starts, one page per iteration. An adaptive ladder needs a page per step, logic for every up / down path, and n variables that are mostly empty. The variant stores **one** numeric answer instead: the highest price accepted, with 0 meaning none. The engine checks that answer (`validate.ts` accepts 0 or a ladder price only), and the analysis reads it directly.

**Step rule** (`priceLadder.ts`):
- Start at the middle price (the lower middle for an even ladder), the lowest, the highest, or a random price seeded per respondent.
- Yes moves one price up; no moves one price down.
- The ladder stops at the first boundary (the next price in that direction was already asked) or at either end.

**Recording.** The path goes to paradata as `GG_<CODE>_START` and `GG_<CODE>_PATH` (for example `15:1,20:0`).

**Analysis.** `pricing` with `method: gabor_granger, ladder: true, prices`. Demand(p) is the % of respondents whose highest accepted price is ≥ p; revenue is p × demand. This rests on the method's monotonicity assumption.

**Studio.** The variant editor sets the prices, start, prompt, answer labels and currency; the maximum value follows the top price. The plan suitability check refuses a ladder item without a ladder question or without three or more prices.

## 3. SM-10 — Sequential monadic analysis

**Inputs.** Plan method / analytics kind `sequential_monadic`: one rating per concept. The options are `order` (S4c's stored `ORDER_<RANDOMIZER>`) and `blocks` (the randomizer child that holds each concept).

**Within-respondent comparison**, on respondents who rated every concept:
- means;
- the omnibus test: paired t for two concepts, Friedman (tie-corrected) for three or more;
- every pair by paired t, Holm-adjusted, with Wilcoxon as a check.

**Order effect:**
- each concept's mean when rated first vs later (Welch t);
- the pooled first-position effect: the first-shown rating minus the mean of the later ratings, one-sample t. Under a balanced rotation, concept quality averages out, so a non-zero mean is the position effect.

**Template.** One block per concept (the concept, then appeal and intent), under a Williams randomizer that shows every block.

**Registry.** Methodology `sequential_monadic` moves from partial to **supported**.

## 4. SM-18 — IAT D-score

**Algorithm.** Greenwald, Nosek & Banaji (2003), improved D, in the D600 form. The reaction-time variant records the first response with no forced correction, so errors get the built-in penalty.

**Tagging the blocks.** The four combined blocks are `experimental.reaction_time` questions tagged with `settings.iatBlock {role, key}`: B3 / B4 compatible and B6 / B7 incompatible, each as practice or test.

**Steps:**
1. Drop trials over 10,000 ms.
2. Exclude a respondent with more than 10 % of trials under 300 ms.
3. Compute the inclusive SD of B3+B6 and of B4+B7, on the original latencies.
4. Replace each error with the block's correct mean + 600 ms.
5. For each pair, compute (incompatible − compatible) / SD.
6. D is the equal-weight mean of the pairs present.

**Per-respondent variables.** The engine writes `IAT_D`, `IAT_TRIALS`, `IAT_FAST_SHARE` and `IAT_EXCLUDED` in the calculation pass, so the Runner and the server replay agree. They are declared in the variable dictionary and exported.

**Analysis** (plan method `iat_dscore`, kind `iat`):
- scored and excluded counts, mean D, SD, t against 0 and Cohen's d;
- strength bands (|D| < .15 / .35 / .65) by direction.

**Template and Studio.** Template `iat` builds the four keyed blocks from the targets, attributes and words. The Studio's reaction-time editor sets the role and the answer key per stimulus.

## 5. SM-16 — Shelf test: `hotspot.shelf`

**The question.** It uses the regions machinery: a shelf image with one region per product, and the task "pick the product you would buy". The answer is the product's code.

**Paradata** (browser-measured):
- `SHELF_<CODE>_TIME`: seconds to find.
- `SHELF_<CODE>_EXAMINED`: products hovered or focused before the pick, each once, in order.
- `SHELF_<CODE>_PICK2`: the optional second choice (`settings.shelf.secondPick`).

**Analysis** (plan method `shelf_share`, kind `shelf`): share of first choice, second-choice %, examined % and median / mean time to find per product.

**Studio and IM.** The Studio reuses the regions editor and adds the second-choice controls and lint. IM can use `create_question type hotspot.shelf` or the `shelf_test` template; the template needs `imageUrl`, and the guide says to ask for it.

## 6. SM-13 / SM-14 — Brand funnel and ad test templates

**`brand_funnel`:**
- Unaided first mention is an open end, coded by the existing AI classification: a calculated `ai_classify(UNAIDED, "brands|Other|None")` that the runtime resolves.
- Then aided awareness (with None) → consideration → purchase, carried forward stage to stage → preference.
- Plan: `brand_funnel` over the four stages, plus frequencies of the coded first mention.

**`ad_test`:**
- Forced exposure: `media.video_rating` with `requireComplete`, so the ad must play to the end before the likeability rating.
- Unaided recall (AI-coded) and aided recall.
- A diagnostics grid of five statements, then purchase intent.
- Plan: recall frequencies, likeability mean, top-2 box.

**Both** are starters in `packages/templates` and `add_method_template` templates. The guide asks for the brands and the video when they are not given.

## 7. Registries

**Methodologies:**
- `sequential_monadic` → supported.
- `van_westendorp` and `gabor_granger` notes rewritten (proxy / textbook, NMS, ladder).
- `brand_funnel` note now names the template.
- New: `iat` (partial: single-category blocks and pairing-order counterbalancing are not native), `shelf_test` (supported), `ad_test` (supported). Each says what is not native.

**Plan-method notes and records:**
- `ANALYSIS_NOTES`: pricing, sequential_monadic, iat_dscore, shelf_share.
- `analysis:paired` note: paired tests now run in the plan for a sequential monadic design.

**Capability registry.** `method_templates` → `add_method_template`.

**Methods guide.** Gains the template paragraph and seven worked example lines, all applied by the engine in `methodsGuide.test`. Its budget rose from 7,000 to 9,000 characters; the guide is sent only on methods requests. The methodology names were shortened so the capability brief stays under its 2,200 cap.

## 8. Verification (S5c)

**Unit tests** (final sweep after item 6 and the item 7 registry edits)

| Package | Result |
|---|---|
| Engine | 2634/2634 (new: s5cMethodTemplates 5, s5cPriceLadder 4, s5cIat 4, s5cShelf 3); after the item 7 note edits: capabilities, capabilityRegistry and s5c* 34/34 |
| Schema | 18/18 |
| Designs | 124/124 |
| Analytics | 786/786, every dist test directory (new: pricingModels 7, experimental 6) |
| Templates | 121/121 (new: methods 6; every starter passes the quality check and is walked to an end) |
| Renderer | 12/12 |
| Runtime lib | 88/88 |
| Studio lib | 1137/1137 (methodsGuide: example lines applied, intent words) |

**Reference values used in the tests:**
- VW proxy PMC 10.5 / PME 15; textbook 10 / 16; OPP 13; IPP 12.
- NMS trial optimum 15 (55 %); revenue optimum 20 (10.0); segment vertex 15 (11.25).
- Ladder demand 85.7 / 71.4 / 42.9 / 14.3 %, revenue maximum at 15.
- Sequential monadic: Friedman Q 8.6667 (tie-corrected, p = e^(−Q/2)); paired t 2.70 / 7.05 / 1.75; Holm; first-position t 1.0.
- IAT D practice 1.6667, test 2.5012, D 2.0839; analysis mean .36, SD .336, t 2.395.
- Shelf shares 50 / 25 / 25, examined 75 / 75 / 50, times 5 / 3 / 10 s.

**Checks.**
- `tsc --noEmit`: studio, runtime and renderer, 0 errors each.
- `gen-public-docs --check`: current. Regenerated: actions-reference (add_method_template block), capabilities and question-types (176 → 178 variants).
- Dependency boundaries: 0 violations.
- Auth guard: 259 handlers, 0 problems.

**SQL.** No migration, so none was run.

**Browser suites**

| Suite | Result |
|---|---|
| `s5c-methods-test` (new) | 5 passed (61 s): A shelf ×2, B ladder ×2, C IAT ×1 — the IAT run writes `IAT_D` ≈ 1.94 to the preview store |
| `methods-intelligent-test` | ok, 14 passed |
| `variants-g6-test` | ok, all G6 variant checks passed (26 ✔ lines, including the IAT renderer's `__rt` map) |
| `analysis-plan-test` | **not verified.** Run 1 got a ChunkLoadError while the Studio's next-server was OOM-killed. Run 2 passed §1–§4 (18 checks), then timed out in §5 as the Studio was OOM-killed again (dmesg) |

**Browser: `scripts/s5c-methods-test.mjs`** (runtime preview, built from the same `methodTemplateFragment` the action uses):
- **A — shelf.** Hovering records p2, p3 once each; the click picks p1 (answer `["p1"]`); `SHELF_SHELF_EXAMINED` is `p2,p3,p1`; the time is > 0; Enter on a focused product records `SHELF_SHELF_PICK2` and leaves the answer unchanged.
- **B — ladder.** Starts at 15; yes → 20, no → stops, so the answer is 15, the path `15:1,20:0` and the start 15. Start again, then no at 15 / 10 / 5 → answer 0 and path `15:0,10:0,5:0`.
- **C — IAT.** Four blocks, 32 trials, about 450 ms slower on the incompatible pairing → `IAT_D` > 0, `IAT_EXCLUDED` 0, `IAT_TRIALS` 32.

## 9. Known limitations (S5c)

- **NMS calibration** is a convention: the default 0.7 / 0.5 / 0.3 / 0.1 / 0 is common practice, not a published constant. The interpolation between a respondent's four prices is linear.
- **Price ladder.** One ladder per question, and monotonic acceptance is assumed. The ladder's prices are not stored per respondent: the path is, and the definition holds the ladder.
- **Sequential monadic.** The order check needs the stored `ORDER_<RANDOMIZER>`, so surveys fielded before S4c have none. Only first vs later is checked; there is no carry-over model by preceding concept.
- **IAT.** Only the four combined blocks are scored. Single-category practice blocks (B1, B2, B5) and counterbalancing of which pairing comes first are not built by the template (add a randomizer by hand). Latencies are measured in the browser (`Date.now()` at the stimulus); there is no inter-trial control beyond the variant's fixation and gap.
- **Shelf.** "Examined" means pointer hover or keyboard focus, which is a proxy for attention, not eye tracking. The shelf is a single image (no scrolling, 3D or price tags as data) with one purchase.
- **Brand funnel / ad test.** The coded open ends need the AI service (`ai_classify` is resolved by the runtime). The ad test has no test / control cells and no second-by-second trace (use `media.video_timeline`).

---

# S4–S5 complete — summary (2026-11-01)

| Step | What shipped |
|---|---|
| **S4a–S4c** (`docs/S4-NATIVE-FEATURES-2026-10-31.md`) | Native features: timers and behaviour conditions, the respondent experience, weighted and Latin-square / Williams randomizers, stored display order, exact experiment arms, custom List Fill |
| **S5a** | Media and gamification: image zoom, before/after slider, respondent video, points / badges / levels, the review page |
| **S5b** | Telemetry and integrations: visibility and scroll depth, answer history, inactivity, timing in exports, read-only script timing and IM quality settings, per-response webhooks |
| **S5c** | Research methods: Van Westendorp proxy / textbook with the NMS extension, an adaptive Gabor–Granger ladder, sequential monadic analysis with the order effect, IAT D-scores, a shelf test, brand-funnel and ad-test templates — all reachable from one Intelligent Mode action and the "New survey" picker, and checked against hand-computed reference values |

**Across S4–S5:**
- No new npm dependencies.
- One migration (0079, S4c).
- **Not verified because of Studio out-of-memory kills in this sandbox:** S5b `script-health-test` section B and `analytics-test`, and S5c `analysis-plan-test` §5.
