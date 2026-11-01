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
