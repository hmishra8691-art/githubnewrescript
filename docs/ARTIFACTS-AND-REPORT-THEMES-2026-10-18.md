# Persistent document links and natural-language report themes (2026-10-18)

Engineer E2. Closes the two "Not done" items of `ANALYSIS-APPLY-DOCX-REPORTING-2026-10-17.md`:

- the download link was lost after a reload;
- the requested report theme was suggested, not applied.

## 1. Audit — what was there

**Documents.**

- `POST /api/copilot/output` made a document on every request and streamed it back. Nothing was stored.
- The copilot card held only a `blob:` URL, which is page memory. A reload lost it, and asking again regenerated the document (and asked the model again for the findings narrative).
- The Research tab also regenerated on every click.
- Nothing recorded which design, data or theme a file was made from, so nothing could say "this is out of date".
- Story-report renders (`analytics_story_renders`, bucket `rescript-reports`) were the only stored, signed-URL downloads. They were the pattern to follow.

**Themes.** There were three theme models, none for the documents:

- `ReportTheme` (`analytics_themes`, 0011): in-app reports and the report/deck PowerPoint exporters. Four presets (Rescript, Midnight, Graphite, Warm paper).
- `DesignConfig` (`analytics_story_themes`, 0051): story reports, with its own NL parser (`interpretDesignRequest`).
- Survey `Branding` (`themes`): what respondents see.

The problems:

- The Word exporters hard-coded colours and Calibri.
- `reportBriefFromText` mapped "premium" to Midnight, but the builder only added a note, because a theme is a stored row.
- Logos exist: survey Branding `logoUrl`, and the Branding asset library as `media_objects` (`survey_asset`, `shared`).

## 2. Root causes

1. **No artifact identity.** A document had no fingerprint and no row. The only reference was a page-memory URL.
2. **Themes were stored records with no resolution step.** The brief carried a theme *name*, but creating the report never turned that name into a theme id.
3. **The Word files had no style layer.** Every helper in `export/docx.ts` read module constants.

## 3. Design — persistent documents

**Identity.** `apps/studio/lib/artifacts/core.ts` (pure, used by both browser and server). The fingerprint is a hash of:

- the definition's canonical hash;
- the type and edition (audience for findings outputs, `standard` for design documents);
- for findings outputs: the data stamp (`datasetStamp`: count and last change of the responses), the latest stored run id, and the narrative mode;
- the theme (ref, version, and a hash of its look);
- a structure request;
- the client on the cover;
- `GENERATOR_VERSION`.

The revision is recorded in `inputs` but not fingerprinted, so an autosave that changes nothing does not create a version.

**Service.** `lib/artifacts/service.ts`. The database and store are injected; `lib/artifacts/server.ts` binds them to the Supabase service client and `mediaDb().stores.primary` (Cloudflare R2 when configured, else Supabase Storage).

- **`obtainArtifact`** is the one entry point:
  - If a row has the same fingerprint and the caller may see it, the stored file is read, re-checked and sent. `generate()` is never called and no model is asked.
  - Otherwise the document is generated once, stored under a unique key (`<survey>/artifacts/<type>/<edition>/v<n>-<id>.<ext>`), and gets a row.
  - Concurrent requests: the same inputs end in one row (unique index, loser's object removed); the same version number makes the loser take the next.
  - Explicit regeneration (`output.regenerate`: "update the Word document", the Regenerate button) re-marks the old row's fingerprint (`fp~vN`) and makes a new version.
  - A stored copy found missing or corrupt on reuse is retired and remade, and the response says so (`x-rescript-artifact-note`).
  - A database without 0064 still gets its file; persistence fails soft.
- **`artifactLink`** handles downloads:
  1. The row must belong to this project (otherwise 404, so ids cannot be probed across projects).
  2. The caller must be allowed to see it (another member's private artifact: 403).
  3. The caller needs the capability for the type (403 without it).
  4. The file is checked again: size, SHA-256, then `checkOfficeFile` (`checkDocx`, or the new `checkPptx`). Missing → 410, corrupt → 422, each with what to do.
  5. A 120-second signed URL is minted and returned. It is never stored. An expired link is fixed by asking again, which never regenerates.
- **History.** The line's last 5 versions stay downloadable. Older objects are removed and their rows marked deleted. Earlier versions are marked superseded.

**Access** (`packages/access` capabilities through `can(ctx.grant, …)`):

| Document | List | Download / generate |
|---|---|---|
| Research plan, proposal, SAP | `project.read` | `project.read` |
| Findings report, findings deck | `analytics.read` (Data Analytics & Reports: View) | `analytics.export` |

`visibility: "private"` makes an artifact the owner's only. The default is `"project"`.

**Routes.**

- `POST /api/copilot/output`: unchanged contract (the file is the body). It adds these headers:
  - `x-rescript-artifact-id`
  - `-version`
  - `-fingerprint`
  - `-reused`
  - `-created`
  - `-note`
  - `x-rescript-theme`
  - `-theme-version`
  - `x-rescript-structure`
- `GET /api/surveys/[id]/artifacts`: lines, each with its latest version, history, and `state: current | stale`. `stale` is computed with the same `fingerprintInputs` the output route uses; findings lines are compared with the dataset and narrative mode they were made with.
- `GET /api/surveys/[id]/artifacts/[artifactId]`: a fresh link (`?redirect=1` returns a 302).

**UI.**

- The copilot card (`DocumentCards.tsx`):
  - Download takes the page's bytes or a fresh link.
  - Shows "kept from earlier, not regenerated" and the version.
  - Shows "A new version is available" with "Make the new version".
  - Missing or forbidden files are explained on the card.
- On opening a survey, `useCopilot` restores one card per document line the copilot or workflow made.
- The Research tab:
  - Lists `· vN`.
  - Its button downloads the kept file.
  - Shows a "New version available" badge.
  - Has Regenerate / "Make new version" and an "Earlier…" version picker.

**Sandbox only.** `lib/artifacts/sandboxStore.ts` keeps documents and the report theme in the tab's sessionStorage, with 2 versions per line. The client computes the same fingerprint. This exists only so the reload behaviour can be tested without a server. It is never used for a saved project.

## 4. Design — report themes

**Model.** `packages/analytics/src/reportThemes.ts` defines `ThemeSpec` with these parts:

- colours by role: primary, secondary, accent, background, surface, text, muted, heading, border, table header background/text, stripe;
- chart palette;
- typography: heading/body font, base/H1/H2/H3 pt, weight, case;
- paragraph spacing;
- table style: grid, minimal or striped;
- density and title rule;
- annotation emphasis;
- branding: header, footer, page numbers, logo placement.

Structure is a separate `StructureRequest` (a section order). The analysis and the content are not in the theme.

`enforceTheme`:

- keeps body text at 7:1;
- keeps headings, muted text and table headers at 4.5:1;
- keeps accents and series at 3:1, and keeps series distinguishable;
- moves a colour's lightness (hue kept) to meet these, and reports each move;
- clamps sizes and fonts.

**Presets.** Executive Research, Healthcare Analytics, Brand Performance, Consumer Insights, Academic Research. They live in code and pass the rules unadjusted.

**Saved themes** (0064 `report_themes` + `report_theme_versions`):

- scope `org` (customer) or `user` (owner); never global;
- the same name, with case and punctuation folded, becomes the next version, and every version is kept.

**The project's theme** (`report_theme_selections`) is a frozen copy with its ref and version, plus the structure request.

**Reading words.** `interpretThemeRequest` is deterministic. The five sentences:

| Sentence | Reading |
|---|---|
| "Apply our premium corporate theme with navy headings, subtle cyan accents, and clean white backgrounds" | new theme "Premium Corporate" on Executive Research; navy headings and table header; cyan accent darkened to #05A1BB for 3:1, and the preview says so |
| "executive consulting-style layout…" | Arial, ruled titles, minimal tables, airy spacing |
| "healthcare research presentation, restrained colors, clear statistical annotations" | Healthcare Analytics base, palette eased toward grey, annotations upright and darker |
| "use our uploaded logo and brand colors" | the survey Branding colours plus the uploaded logo in the page header; with none on file, a clear answer and no model call |
| "keep the content but reorganize around the main hypotheses and recommendations" | structure only: summary → hypotheses → recommendations, then the rest |

Names are resolved as follows:

- `Apply the Healthcare Analytics theme` → apply by name. A saved theme of the same name shadows the built-in.
- An unknown name → `unknown_name` → the user is asked to describe it.
- A name is never read as a description ("Board Pack" is not a board look), unless it is pure description ("premium corporate").

**Model use.** The model is used only when nothing was placed and the person clicks "Let the AI read the look":

- it goes through `POST report-themes {op:"preview", useModel:true}`;
- it passes the project AI switch (`aiAllowed`), the person's connection (`aiReadyFor`) and the meter;
- only the words and the current look are sent;
- the answer goes through `sanitizeThemePatch`;
- it is shown as a preview.

**Preview before apply.** Nothing changes until Apply. Applying changes the fingerprint of every document, so each kept document offers "a new version is available".

**Engine.** `nlIntent.ts`:

- New interpretation `kind: "theme"` (`ThemeRequest`: describe, apply_named, save_as, restructure, list).
- `OutputRequest.theme` ("create the findings deck in the Healthcare Analytics theme").
- `OutputRequest.regenerate` ("update the Word document").

The survey has its own theme, so the engine sorts sentences this way:

- A sentence is a *report* theme only with a document word, a built-in name, or report-only words (consulting, statistical annotations, chart palette).
- A sentence about the survey is left to the model as before.
- An ambiguous one ("premium corporate theme with navy headings…", "use our logo and brand colors") gets a clarify card with two choices.

Capability registry: `export:findings_deck_pptx`, `export:report_themes` (partial). `capabilities.md` was regenerated.

**Report builder.** `reportBriefFromText` also recognises the five names. When a report is created, `resolveReportTheme` (`lib/reportThemeResolve.ts`):

- reuses a saved `analytics_themes` row of that name, or
- saves the preset to *this project* (not the workspace) and sets `themeId`.

The draft note now says the theme is applied.

**Rendering, one look in every format:**

- **Word:** `docStyleOf(theme)` is a set of style tokens. Every helper in `export/docx.ts` reads `S`, which `themed()` sets for the synchronous part of a build; every paragraph is constructed before the packer's first `await`. A themed document also declares Heading 1/2 (font, size, colour) and the Normal font in `styles.xml`. It applies:
  - grid, minimal or striped tables;
  - clear annotations;
  - header and footer words;
  - a PNG/JPEG logo in the header or on the cover, sized from its own header bytes. The logo comes from a data: URL or *our* `/api/media/<id>` for this project or a shared library asset; nothing is fetched from arbitrary URLs.
  - Without a theme the output is the standard look exactly as before.
- **PowerPoint and in-app:** `themeToReportTheme` feeds the existing `ReportTheme` path (`buildDeckPptx`, `buildPptx`, the report renderer).
- **Structure:** `reorderSections` moves whole Heading-1 sections of the findings report; the cover and closing line stay in place.

## 5. Migration and deploy order

`supabase/migrations/0064_artifacts_and_report_themes.sql` is re-runnable. It creates:

- `artifacts`;
- `report_themes`;
- `report_theme_versions`;
- `report_theme_selections`;
- RLS: members read, a private artifact only its owner; themes by organisation or owner, using `current_customer_id()` because a subquery on `profiles` recurses in its own policy;
- `grant select` to `authenticated`;
- the private bucket `rescript-reports` (`insert … on conflict do nothing`, only if `storage.buckets` exists). Existing buckets are created lazily by `supabaseObjectStore.ceiling`.

**Order:** apply 0064 first, then deploy the code. If the code ships first:

- documents are still made and downloaded, but not kept;
- saving or applying a theme answers "needs migration 0064";
- built-in themes named in a sentence still apply.

**Environment variables:** none new. The existing R2 / Supabase storage settings decide the store.

## 6. Tested

**Formats** (each rendered and inspected):

- **Word:** `styles.xml` declares Heading 1 with the theme colour and font; heading runs are coloured; table header fill, stripes and minimal borders are present; header/footer words and the logo `<w:drawing>` are present; `checkDocx` passes. Covered for the plan, proposal, SAP and findings report with 4 themes, and the body `<w:t>` is byte-identical to the unthemed file.
- **PowerPoint:** `srgbClr` primary and heading `typeface` appear on the slides; every slide's words are unchanged; `checkPptx` passes.
- **PDF:** LibreOffice converted the themed plan here. The navy fill colour (0.106 0.165 0.290 rg) is in the page streams and Calibri/Carlito is embedded. There is no PDF download in the Studio, so PDF is claimed only as a conversion of the Word file.
- **In-app:** the browser suites below (preview swatches, Research tab). The in-app report's look uses the existing `ReportTheme` renderer and was not re-tested beyond the builder applying the theme id.

**Unit tests:**

| Package | Suite | Result |
|---|---|---|
| analytics | `reportThemes.test.ts` (16, including the PDF test) | 601 total pass |
| engine | `reportThemeIntent.test.ts` (4) | 2137 pass |
| studio | `lib/artifacts/artifacts.test.ts` (8) | 670 total pass |
| studio | `sandboxStore.test.ts` (3) | (in the 670) |
| studio | `reportThemesStore.test.ts` (5) | (in the 670) |
| studio | `copilot/reportThemeTurn.test.ts` (2) | (in the 670) |
| studio | `reportThemeResolve.test.ts` (1) | (in the 670) |
| studio | `reportingGuide.test.ts` (extended) | (in the 670) |
| exporters | — | 135 pass |

`artifacts.test.ts` covers fingerprints, no generation on reuse or download, versions and history, signed-URL refresh after expiry with no generation, missing/corrupt files, 403 private / 404 cross-project / 403 without export, races, and a missing table.

**Checks:** `dependency-boundaries` 0 violations; `auth-guard-audit` 210 handlers, 0 problems; `apps/runtime` tsc clean. Studio `tsc` on every file E2 touched and everything they import: clean. The full-project Studio `tsc` was blocked at hand-off by a syntax error in `components/analytics/AnalysisBuilder.tsx` (line 215, another engineer's in-progress edit), so the orchestrator must re-run it.

**SQL:** `scripts/artifacts-sql-test.sql` passes on Postgres 16 (scratch cluster with 0064 applied twice). It covers shape, fingerprint uniqueness, versions, private copies, RLS for owner, member, outsider and anonymous, theme scope and versions, and the private bucket.

## 7. What the orchestrator must run

With the Studio on :3000, the fake AI provider, and `@rescript/analytics` built:

- `node scripts/artifact-persistence-test.mjs`
- `node scripts/report-theme-nl-test.mjs`
- `node scripts/research-plan-docx-test.mjs`
- `node scripts/story-report-test.mjs`
- `node scripts/phase5-reporting-test.mjs`
- `node scripts/analysis-apply-test.mjs`
- `node scripts/data-export-test.mjs`
- `node scripts/phase3-research-test.mjs` (its Documents panel section)

Against a database with every migration applied:

- `psql -v ON_ERROR_STOP=1 -f scripts/artifacts-sql-test.sql`

## 8. Limits

- **Structure** reorders the findings report (Word) only. The deck and the design documents keep their order.
- **Logos** are embedded in Word only from a data: URL or our media store, as PNG or JPEG up to 2 MB. In PowerPoint only a data: URL logo is used (the existing `ReportTheme.logoUrl` path).
- **Fonts:** the theme names a font. Word and PowerPoint use it if the reader has it installed; it is not embedded.
- **Stale detection for saved projects** is computed when the list is read (on opening the copilot, or the Research tab). A card already on screen learns of a theme change via the theme card, and of a design change only on the next open. The sandbox recomputes as the design changes.
- **Restored cards** cover documents the copilot or workflow made. The Research tab lists all kept documents.
- **The sandbox** keeps 2 versions per document in the tab; it is lost with the tab.
- **The model path** for themes was tested only through its gating and sanitising, in unit tests with a fake answer. No live model was used.
- **`python-docx`** still shows unstyled paragraphs' style as None (unchanged; see 2026-10-17).

## 9. Follow-up after the browser-suite pass (2026-10-18)

- **Restored cards never came back for a saved project.** The restore effect marked a survey as done before its request had answered. React's development double-mount then tore the effect down mid-request and skipped the re-run, so no card appeared. The mark is now cleared when the effect is torn down before its answer. `artifact-persistence-test` §6 caught it.
- **§3 reload timeout (orchestrator run).** It did not reproduce in four runs. The cause was the shared dev server recompiling or restarting under the reload. Both suites now retry a reload up to three times and ignore `ChunkLoadError` only. Any other page error still fails them.
- **`report-theme-nl-test` §0 was a wrong expectation, not a missing theme.** The `docx` library always declares Heading 1 with its own default blue (2E74B5). The unthemed baseline is now checked as "standard ink, nothing navy". The themed checks (§2, §4) were already passing.
- **§6 mock.** The signed URL is stood in by a `data:` URL, because a browser download from `<a download>` bypasses Playwright's interception. The §6 fixture is now parsed through the schema before the plan is built.
- **Results:** `artifact-persistence-test` 6/6, `report-theme-nl-test` 6/6, `research-plan-docx-test` 4/4, `phase5-reporting-test` 6/6, `story-report-test` 19/19 (one first-run timeout under shared load, passed on re-run). Studio `tsc` clean.
