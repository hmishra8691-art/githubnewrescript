# Animated research reports, branded video and synchronized PowerPoint — implementation report

Date: 2026-10-12 · Entry point: Results → Reports → **Create report** (PowerPoint, Animated video, or Both)

## 1. Audit — what existed

- **Analytics reporting.** There was a block-based report builder (`ReportDefinition`, `ReportsPanel`) with PowerPoint and Excel export (`buildPptx`, `buildXlsx`). There was also a storytelling deck model (`deckFromRun` → `buildDeckPptx`), chart purpose ranking (`chooseChart`), a findings report drafted from a run (`reportFromRun`) and an AI narrative gate (`gateNarrative`).
- **Analysis plan → runs.** `runPlan` produces findings, hypothesis verdicts, corrections, KPIs and waves. Stored runs (`analytics_runs`) keep a compact form without per-analysis results.
- **Platform.** The platform already had:
  - a speech service (`synthesizeSpeech`) and a chat model (`completeJson`) behind `AI_API_URL`/`AI_API_KEY`
  - a media store: Cloudflare R2 when configured, otherwise Supabase Storage, with signed downloads but no server-side write
  - the meter (`REPORT_GENERATION`), Vercel crons, and project role → capability gates
- **Missing.** There was no video capability, no shared report definition across outputs, no brand-asset reading, no scene editor, and no versioned report export.

## 2. Root causes of the gap

- The two PowerPoint paths (block report and story deck) laid out content independently, in inches, with no text measurement. Nothing could guarantee that two outputs of the same content agree, or that text fits.
- Run results were not stored, so an output made later could not be traced to the numbers it showed.
- The object store could not write server-made files.

## 3. Files

**New**

- **`packages/analytics/src/story/`** — the shared report engine:
  - `types.ts`: the versioned `StoryReport`
  - `design.ts`: DesignConfig, the 6 themes, contrast enforcement, brand themes, and design-in-words
  - `charts.ts`: frozen chart data, chart validity rules, recommendation, formatting
  - `planner.ts`: proposes the report from plan + run
  - `measure.ts`: real font metrics via opentype.js
  - `layout.ts`: deterministic scene layout plus motion
  - `qa.ts`: geometry, contrast and value checks, the repair loop, timing, pacing, subtitles
  - `render.ts`: SVG frame at time *t*
  - `revise.ts`: revisions in words → operations, refusals, merging a regenerated report
  - `story.test.ts`
- **`packages/analytics/src/export/storyPptx.ts`** — the editable PowerPoint from the composed pages. It uses native charts and tables and adds speaker notes.
- **`packages/reportvideo/`** (new workspace package, Node only):
  - `fonts.ts`: font loading and resvg rasterisation
  - `ffmpeg.ts`
  - `video.ts`: plan, per-scene segments, assembly with subtitles
  - `verify.ts`: decoded-video QA
  - `pptxQa.ts`: PowerPoint read-back QA
  - `brand.ts`: logo, deck, PDF and font analysis
  - `providers.ts`: narration and visuals providers with fallback, and the cost/time estimate
  - `story.test.ts`
- **`apps/studio/lib/`**:
  - `storyCore.ts`: edit validation (numbers protected, invented figures refused, design sanitised), status, version diff
  - `storyEngine.ts`: the service — create, versions, revise, design, brand, regenerate, exports as resumable jobs, downloads
  - `storyService.ts`: binds the service to the real run, store, fonts, speech, model and meter
  - `storyEngine.test.ts`
- **`apps/studio/app/api/surveys/[id]/stories/[[...path]]/route.ts`** — the API.
- **`apps/studio/app/api/cron/story-renders/route.ts`** — background rendering.
- **`apps/studio/components/analytics/`**:
  - `StoryStudio.tsx`: the list, create dialog, storyboard, inspector, revise, design, export and versions panels
  - `storyApi.ts`
- **`apps/studio/public/report-fonts/`** — Inter, Source Serif 4 and Montserrat (regular and bold), with their OFL licences.
- **`supabase/migrations/0051_story_reports.sql`**.
- **`scripts/story-report-test.mjs`** — the browser test.

**Changed**

- `ReportsPanel.tsx`: Create report, and the story list.
- `globals.css`: `st-*` styles.
- `packages/media/src/objectStore.ts`: `put()` for server-made files, and the `rescript-reports` bucket.
- `next.config.mjs`: native modules kept external, plus tracing.
- `vercel.json`: a cron every minute.
- `auth-guard-audit.mjs`: the cron entry.
- `fakeSupabase.mjs`: story tables and unique indexes.
- Package manifests and `pnpm-workspace.yaml`: `ffmpeg-static` is allowed to run its install script.

## 4. Services and database

**Migration 0051** creates:

- `analytics_story_reports`: the current definition, version, status, outputs, planner options and run.
- `analytics_story_versions`: immutable; a unique `(story, version)` pair.
- `analytics_story_renders`: kind, version, plan hash, progress, QA, providers, artifact path, attempts, lease and expiry. A unique partial index allows **one active render per report and output**.
- `analytics_story_segments`: rendered scenes by content hash, reused across renders.
- `analytics_story_themes`: saved at project or workspace level.

RLS lets members read; writes go through the service role.

**API** (`/api/surveys/<id>/stories/...`):

- **Gating.** Reading needs `analytics.read`, editing needs `analytics.edit`, and export needs `analytics.export` plus a workspace that is not read-only.
- **Downloads.** A signed URL that lasts ten minutes. Artifacts are kept for `REPORT_ARTIFACT_RETENTION_DAYS` days (default 90).
- **Billing.** One `REPORT_GENERATION` event per finished export, against the data's environment. Narration and model design calls go through `meteredAi`.

## 5. Video approach

There is no video-generation API in this deployment, and analytical content must be exact. The video is therefore rendered **deterministically on the server**:

1. **Scene plan.** The report is composed for the video canvas (1920×1080, 1080×1920 or 1080×1080; the output's short side is 720–2160) and checked. Every scene is timed from:
   - its entrances
   - its reading time: words ÷ 3.2 per second, plus 0.3 s per number
   - its narration, when there is one

   Scenes are then paced to a requested length, never below reading time; if that is impossible, a note says so.
2. **Render.** Each scene's frames are drawn by `renderFrame` (the same function the browser preview uses) and rasterised by resvg with the bundled fonts. Only the entrances are drawn frame by frame. The still hold is extended inside ffmpeg (`tpad`) and the exit is a fade to the background colour. Encoding is H.264 High, yuv420p, at the design's frame rate, with AAC narration padded to the scene's length when narration is on.
3. **Assemble.** Segments are joined by stream copy, and the subtitles are muxed as a `mov_text` track. An `.srt` file is stored alongside.
4. **Validate.** See section 8.

**Jobs.** A job advances in steps: the panel advances it while it is open, and the cron does so otherwise. A lease keeps one worker per job. Scenes are stored as they finish, so a timeout or cancel resumes without re-rendering finished work. An edit re-renders only the scenes whose hash changed.

**Providers.** Generative visuals sit behind a provider interface. The deterministic decoration is the default and the fallback. The provider, model and status used are recorded on every render.

## 6. One report definition, two outputs

`StoryReport` is versioned and holds:

- the scenes: text, the frozen chart data with its base and significance, layout, emphasis, motion, duration, sources and caveats
- the design
- where the numbers came from (run id, n, dataset, plan hash)

`composeReport(report, measurer, "video" | "pptx")` lays out every scene with real font metrics.

- **Video.** The main story at the design's aspect ratio.
- **PowerPoint.** Main story plus appendix at 16:9, with appendix tables paginated.

The PowerPoint is built from the composed **blocks** at their final state:

- text boxes at the measured positions
- native PowerPoint charts carrying the frozen values, with the same axis range, number format and highlight
- native tables and shapes, and speaker notes with sources and bases

There are no slide screenshots. Every render records the version it was made from.

## 7. Branding, design in words, previews

- **Themes.** Corporate Executive, Modern Analytics, Premium Editorial, Minimal Research, Cinematic Data Story and Custom Brand.
- **Contrast.** Every design is passed through contrast enforcement:
  - text 7:1 on the background
  - 4.5:1 on surfaces and table headers
  - marks 3:1, with series kept distinguishable

  Brand colours used as text are adjusted only where they are used as text. Every adjustment is reported.
- **Design in words.** A request is read deterministically into a structured patch covering:
  - colours, roles and palettes; dark/light; serif; label and statistic size; density
  - motion, speed and transition; aspect ratio, resolution and duration
  - narration, subtitles, decimals, page numbers and logo

  A leftover phrase goes to the configured chat model only when one is configured. It is sent with the current design summary only — never report content.
- **Brand files.** They are read on the server and never sent to an AI provider:
  - **PNG/JPEG/GIF/WebP/SVG logos:** colours, size, transparency and white-box warning; scripted SVGs are refused.
  - **.pptx/.potx templates:** theme colours and fonts.
  - **PDF guidelines:** hex codes and font names from the text.
  - **Font files:** name and licence embedding flag. They are never used for drawing; the closest bundled OFL face is used, and the panel says so.

  Each file gets clear feedback if it cannot be read. Logos keep their proportions.
- **Previews.** Previews and theme cards are drawn with the report's own title scene and first chart. Themes can be saved per project or per workspace.

## 8. Quality checks

**Layout (both outputs, before export and live in the storyboard):**

- **Bounds and fit.** Bounds and the safe area; text overflow (text is never truncated — it shrinks to a minimum size, then fails); overlong words; missing glyphs; minimum sizes at the output resolution.
- **Overlaps.** Text collisions; text over decoration or the logo; value labels colliding with neighbouring bars; legend or axis over bars.
- **Contrast.** Measured against the actual fill behind each piece of text.
- **Values.** Every printed value is checked against its source number; bar lengths must be in value order; numeric table columns are right-aligned.

When a check fails, a repair loop tries, in order:

1. horizontal bars
2. three-line labels
3. moving the logo
4. removing the decoration
5. a wider visual

It then re-lays out and re-checks. Anything still critical blocks export, and the "Validation required" status names the issue.

**Video, read back from the file:**

- **Streams.** Codec, pixel format, resolution and fps; duration and frame count against the plan; the AAC track and the subtitle track when requested.
- **Decoding.** A full decode without errors.
- **Per scene.** The settled frame and the last held frame are compared with a reference drawn from the definition (mean difference ≤ 6/255). This catches blank, corrupt, wrong or swapped scenes; frames within the hold must match each other (no flicker). Reading time and narration must fit inside the scene.
- **Repair.** Failing scenes are re-rendered and re-checked once; otherwise the render fails with the reasons.

**PowerPoint, read back from the zip:**

- slide count; shapes within the slide; no overlapping text boxes
- each bullet in its own paragraph; every text block present
- native charts present, of the right type, with cached values and categories equal to the report's frozen data; bar axes from zero
- native tables present; no pictures except the report's own images
- fonts listed; speaker notes; page numbers

Exports are marked completed only after these checks pass.

**Statistics.**

- Significance letters appear only when a test produced them. Bases travel with every chart.
- Missing values are shown as "—", never as 0.
- Bars start at zero. Donuts are allowed only for shares that add up to 100% (or counts). Lines are allowed only for ordered categories.
- Corrections and descriptive-only status are shown on the scene.
- Requests that would distort the data are refused with an alternative. These include truncating the axis, hiding bases, claiming support the tests did not give, 3D charts, and dropping non-significant results.
- Edits cannot change a number, and figures typed into text must exist in the results.

## 9. Tests

| Suite | Result |
|---|---|
| `packages/analytics` (including 8 story tests: proposal, composing both outputs with real fonts in 3 aspect ratios, timing and pacing, design in words and contrast, revisions and refusals and regeneration, chart rules, text fitting) | 268/268 |
| `packages/reportvideo` (6 end-to-end tests: render, assemble and verify an MP4; corrupt and swapped files fail; one-scene re-render via hashes; 9:16 and 1:1; narration with AAC; a PowerPoint read back with a tampered value caught; brand assets) | 6/6 |
| `apps/studio` (8 service tests over the in-memory DB and store with real rendering: create, no-data refusal, protected numbers and invented figures, stale edits, revise preview/apply/compare/revert, design and brand themes saved per scope, regenerate keeps edits, PowerPoint plus a resumable video in steps with reuse, dedupe, cancel, signed download and billing, narration) | 311/311 in all |
| `scripts/story-report-test.mjs` — browser, real page, real service and renderer | 19/19 |
| Regression: engine 1773, media 162, storage 104, ai 36, billing 41, access 99, schema 11; `analysis-plan-test` 34/34; `analytics-test` 92/92; auth-guard audit 0 problems; `tsc` clean | pass |

## 10. Limitations and what is not done

- **No generative image or video provider is configured.** Decoration is deterministic. The provider interface and the recording of its use are in place, but no generative provider is wired yet.
- **Narration** needs the speech service (`AI_API_URL`) **and** `REPORT_NARRATION_ENABLED=true`, because the narration script is report content. Otherwise the video has a silent track and says so.
- **Rewording text in natural language is not automated.** Such requests are refused with a pointer to edit the text directly.
- **The PowerPoint names Inter, Source Serif 4 and Montserrat** (open licence). PowerPoint substitutes where they are not installed; the fonts are not embedded.
- **Significance letters in the PowerPoint** are small text boxes placed beside the native data labels. Their position is approximate if a person resizes the chart.
- **PDF guideline reading** is limited to hex codes and font names in the PDF's text. Scanned PDFs are reported as unreadable.
- **Storage.** Supabase Storage has a project-wide upload limit, 50 MB by default. Long 1440p/4K videos need R2, which is the primary store when configured.
- **Compute.** Rendering runs in 60-second function steps. 4K renders are slow on serverless CPU. A cron running every minute needs a Vercel plan that allows it; otherwise the panel advances jobs while open.
- **Brand upload size.** Brand uploads are limited to 3 MB at a time, because of the platform's request size limit.
- **Untested in the sandbox.** Migration 0051 is written but not yet applied. The production `next build` compiled successfully, but its type-check step was killed for memory in the sandbox (`tsc --noEmit` passes separately). The browser test runs against an in-memory database, so the SQL itself is exercised only when the migration is applied.
