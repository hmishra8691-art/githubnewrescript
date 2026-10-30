# Native section navigation (page / section jump) — 2026-10-30

The owner's case: an exam-style paper (UPSC General Studies — History, Geography, Polity …) wants a bar that jumps
between sections. Intelligent Mode tried to build one with a survey script and correctly found there was no page-jump
API: scripts run in a sandboxed iframe and cannot press Next or Back (by design — that stays). The owner chose a
NATIVE, safe section jump. This is it: one engine rule, used by the built-in navigator, by scripts and by the save
route's replay.

## What changed

**Engine** (`packages/engine/src/sectionNav.ts`, beside `flow.ts`)
- `goToPage(def, state, target, counts, view, opts)` → a `NavigationResult` (like `goBack`) plus `ok`, `via`
  (`back` | `visited` | `free`), and on refusal `refusal` (a code) and `reason` (respondent-readable). `target` is a
  page id (`p3`, one loop iteration `p3@apple`), a question id / code on a page, or a section — a flow block / section
  id or title (`opts.as`: `page` | `section` | `auto`). A refusal leaves the state untouched.
- The rules:
  - **Backward** (an earlier page in the compiled flow that still has something to show): Back's semantics — logic
    re-evaluated, nothing re-validated; the Back trail is trimmed to the entries before the target, so Back afterwards
    returns to the page before it on the respondent's own path. Allowed in every mode, except `off` with
    `branding.buttons.showBack: false`.
  - **Visited forward** (a page already seen — in the trail, in the seen list, before the current page, or holding an
    answer): done exactly as if Next were pressed until the target is reached (simulated on a copy, committed only
    when it arrives): every page in between must validate, skip logic, quota checks and embedded data run. Modes
    `visited` and `free`.
  - **Free forward** (mode `free` only): any page reachable in the compiled flow from the current answers. The pages
    jumped over are NOT validated. Refused when an end, a redirect or a quota check lies between, when a page in
    between (the current one included) has a skip rule that fires, when the target is hidden by logic (`hidden`) or
    does not exist (`not_found`) — a loop iteration that does not exist is not in the compiled flow, so it is
    `hidden`. Embedded data on the way is captured; the target gets the normal arrival work (prune, prefill,
    defaults); the page jumped from is pushed on the Back trail.
- `submitGate(def, state, counts, view)`: when Next on the current page would end the survey (complete), the interview
  is replayed from the start on a copy (the save route's walk) and every page on the path validated: `missing`
  (required, unanswered), `invalid` (answered but failing a rule), `bySection` (for the "go to" list). Normal survey:
  refuses while anything is missing. Assessment (`def.assessment` enabled): unanswered = unattempted → `needsConfirm`
  with "N questions unanswered — submit anyway?". Invalid answers always refuse.
- `sectionOutline(...)`: the sections the navigator shows (the OUTERMOST block / section of each page with something to
  show, in flow order) with `current`, `visited`, `answered` / `total` (display-only types excluded) and `locked`.
- `flow.ts`: `visitedPages` / `setVisitedPages` (the LOGIC-04 Back trail, now exported), `seenPages` / `markSeen`
  (every page shown and left — a backward jump trims the trail but a section stays visited), `arriveAt` (land on a
  step as Next does). `start()` clears both.
- `serverValidation.ts` (`checkSubmission`, the save route's replay under `RUNTIME_SERVER_VALIDATION`): with
  `navigation.sectionNav: "free"`, an UNANSWERED question on a page before the claimed step is a soft
  `skipped_required` (the engine allowed the skip) instead of a hard `invalid_answer`; answered-but-invalid stays
  hard. At completion it is hard again unless the survey is an assessment — the same rule as the Submit gate. In
  `off` / `visited` nothing changed: a payload that skipped a required page is refused as before.
- `ux.ts`: `UX_SCRIPT_API` gains `goToPage`, `goToSection` (the script gate accepts them).
- `uxActions.ts`: `set_navigation` (a look-and-behaviour op; aliases `set_section_navigation`,
  `add_section_navigator`; `mode: "on"` reads as `visited`): writes `def.navigation`, warns when the survey has fewer
  than two blocks and when `free` is chosen, refuses a no-op, destructive when it switches the navigator off.
- `capabilities.ts`: `platform:section_navigation` (supported; aliases "section navigator", "jump between sections",
  "nav bar … sections", …; `implementedAs: set_navigation`).

**Schema** (`packages/schema/src/survey.ts`) — `navigation?: { sectionNav: "off" | "visited" | "free" (default off),
position: "top" | "side" (default top) }`. Optional and additive: absent = off, every existing survey unchanged.

**Runtime** (`apps/runtime/components/SectionNav.tsx`, `Runner.tsx`, `lib/resume.ts`; styles in
`packages/renderer/styles/questions.css`)
- The navigator: a `nav` landmark (`aria-label="Sections"`) of BUTTONS, `aria-current="step"` on the current section,
  `aria-disabled` (still focusable) on a locked one, the state in words for screen readers ("visited", "locked",
  "2 of 5 answered"), a live status line for refusals. Top bar or side rail (fixed, below the preview toolbar, on
  screens ≥ 900 px; a bar below that). Themed with the branding tokens (`--rs-primary`, `--rs-border`, `--rs-surface`,
  `--rs-radius`, `--rs-focus` …), logical properties only (RTL-safe). Hidden when the survey has fewer than two
  sections.
- A click runs `goToPage`; success records telemetry `via: "jump"` (`navigation.jumps`), checkpoints like Back (cache +
  save), clears errors; a refusal shows the reason. A click that lands inside Next's minimum latch (`MIN_ADVANCE_MS`)
  is replayed when it opens, never dropped.
- Free mode: Next on the last page runs `submitGate`: the panel (`role="alertdialog"`, focused) lists the missing
  questions per section, each a button that goes there; an assessment gets "Review answers" / "Submit anyway".
- Save / resume: the Back trail and the seen pages live in `state.meta` (never an answer, never exported). Since the
  follow-up of 2026-10-30 (below) they are stored in the response row, `responses.nav` (migration 0077), with every
  save of a survey that has a navigator; a copy is also kept in this browser (`writeNavTrail` / `readNavTrail`:
  localStorage per session id for live / test, sessionStorage per preview). Both are restored after `resumeAt`;
  the browser copy is cleared on completion.
- Preview, test and live run the same Runner.

**Scripts** (`packages/renderer/src/uxSandbox.ts`, `UxLayer.tsx`) — `rs.goToPage(pageIdOrCode)` and
`rs.goToSection(blockIdOrTitle)` post a command; the HOST (UxLayer → the Runner's `onNavigate`) applies `goToPage`
with the survey's rule. Success: `rs.goToSection("Geography") — navigated` in the script log; refusal:
`rs.goToSection("Polity") refused: <reason>` as a `console.warn` (and in the preview inspector). Where no host handles
navigation (the Studio canvas), the call is reported as unavailable.

**Studio** — Branding & Theme → **Navigation** (right under Buttons / "show back button"): Off / Visited sections /
Free with one-line explanations, Position (bar above the page / side rail), and in Free a note that skipped required
questions are checked at Submit (assessments only confirm).

**Intelligent Mode** — the UX guide (`apps/studio/lib/copilot/prompt.ts`, `COPILOT_UX_GUIDE`) says the survey has a
built-in navigator, never to build one from a script, and documents `set_navigation` and `rs.goToPage` /
`rs.goToSection`; `UX_ACTION_OP` maps `set_navigation` to the UX guide; `uxIntent` reads "section navigator", "nav
bar", "jump between sections", "move freely between subjects" as look-and-behaviour, so that guide is sent. The system
prompt (at its cap) is untouched.

**Docs** — `content/docs/logic.md` (§ Section navigation), `custom-code.md` (navigation from a script, with an
example), `survey-definition.md` (`navigation`), regenerated `actions-reference.md` / `capabilities.md`.

### Follow-up (2026-10-30): the trail in the response row — migration 0077

The owner's decision: the Back trail and the visited list live in the database, so a respondent who resumes on
another device keeps them.

- **Migration** `supabase/migrations/0077_response_navigation.sql`: nullable `responses.nav jsonb` —
  `{ v: 1, stack: [page ids, the Back trail, oldest first], visited: [pages seen], at?: current page id }`. A shape
  check (`responses_nav_shape`, CASE-guarded): an object, `v = 1`, each list ≤ 2,000 ids, `at` ≤ 128 characters,
  and a 1 MB byte backstop (a realistic 1,000-page trail with loop-iteration ids is ~7 KB stored). No index (nothing
  queries by it). RLS unchanged: `responses` policies are row-level (0001 `responses_tenant_read`; no write policies,
  only the service role writes), so the column is read by exactly whoever reads the row. Re-runnable; undo in the file.
- **Engine** (`sectionNav.ts`): `navTrailOf` (what the save posts), `sanitizeNavTrail` (shape, bounds, every id a page
  of THIS definition — a loop iteration `p@x` by its page `p` — unknown ids dropped and counted, never refused),
  `restoreNavTrail`, `chooseNavTrail` (the merge rule below).
- **Write** (`/api/session/save`): the posted `nav` is sanitized against the definition the session runs and stored in
  `update.nav`. It is never used to move the respondent — the replay (`checkSubmission`) still decides what is valid,
  and resume positions by `step_index` as before. Before 0077 is applied, the update that names the missing column is
  retried without `nav` (logged once): the answers are always saved.
- **Read** (`/api/session/start` resume): returns `saved.nav` and `saved.savedAt` (`last_saved_at`). Before 0077 the
  select is retried without `nav` (logged once). `mergeResumeSnapshot` carries both past a pending local snapshot.
- **The merge rule** (Runner, `chooseNavTrail`): both copies are sanitized against the current definition (pages a
  new version deleted are dropped). The row's trail wins when this browser has none (another device) or when the row
  was saved at or after the browser copy; a browser copy written later (a save that never reached the server) wins;
  a row without a save time loses to a browser copy. The chosen trail is restored, so Back, visited jumps and the
  navigator behave on a second device as on the first. Test / preview log which copy was used.
- **Sandbox** (a runtime with no database): `lib/sessionSandbox.ts` keeps test surveys and response rows (with `nav`)
  in memory; `/api/session/sandbox` (`launch` → `/n/<token>`, `row` → the stored position and trail) and the
  `/n/<token>` test link run the real start / save / resume path, so the browser suite can resume on another device.
  403 / 404 wherever a database is configured.
- **Exports**: unchanged. There is no paradata section in the response export, and every read of `responses` names
  its columns, so `nav` reaches no export.
- **Deploy order**: `0074_intelligent_tasks.sql` → `0076_assessments.sql` → `0077_response_navigation.sql` (0075 is
  already applied in production). The code works before 0077 (the browser copy is the fallback); apply it before
  relying on cross-device resume.

## Where to find it

- Studio: open a survey → **Branding & Theme** → **Navigation**. Give each section its own block (the navigator lists
  blocks).
- Respondent: the bar above the page (or the rail at the left / right in RTL), on preview (`/preview`), test links and
  live links alike.
- Intelligent Mode: "add a section navigator", "let respondents jump between sections" → `set_navigation`.
- Scripts: `rs.goToSection("Geography")` / `rs.goToPage("Q12")`.
- Server: `/api/session/save` with `RUNTIME_SERVER_VALIDATION` = `log` (default) / `enforce` / `off` — unchanged
  semantics; free-mode skips are logged as soft `skipped_required`. The trail: `responses.nav` (0077); a malformed or
  stale trail is logged as `[rescript:save] navigation trail` with the number of ids dropped.
- Sandbox test link (no database): `POST /api/session/sandbox {action:"launch", definition}` → `/n/<token>`; a resume
  link is `/n/<token>?r=<session id>`.

## Verification

Units
- engine: `cd packages/engine && pnpm -s build && node --test dist/*.test.js` → 2414 / 2414 after the 0077 follow-up
  (5 new in `navTrail.test.ts`: the posted trail, sanitize — foreign / stale / oversized ids, restore on another
  device with the same navigator and Back, the merge rule server vs browser, a version change); before it 2409 (14 new in
  `sectionNav.test.ts`: off / back-disabled, visited backward + Back, visited forward refused / walked, visited forward
  over an incomplete page, free jump + Submit gate per section, outline states, hidden / not found / question-code
  target, never past end / quota / firing skip, loop iterations, assessment confirm, server replay accept / refuse,
  the script gate, `set_navigation`; 1 new in `capabilities.test.ts`; the script-corpus fixture follows the longer
  rs api list)
- schema: `cd packages/schema && pnpm -s build && node --test dist/*.test.js` → 18 / 18 (4 new, `navigation.test.ts`)
- runtime lib: `cd apps/runtime && node --experimental-strip-types --no-warnings --test 'lib/*.test.ts'` → 38 / 38
  (the browser trail; `mergeResumeSnapshot` keeps the row's `nav`)
- studio lib: `cd apps/studio && node --experimental-strip-types --no-warnings --test 'lib/**/*.test.ts'` →
  1046 / 1046 (1 new: `sectionNavGuide.test.ts`; `copilot.test.ts` confirms `set_navigation` is documented)

SQL (0077): `scripts/response-navigation-sql-test.sql` on a scratch Postgres 16 (a fresh copy of the 0070 cluster,
own port, `-k /tmp`): 0071 → 0077 applied, then 0077 again, then the test twice → 4 / 4 ok both times (the column and
the check exist once; old rows stay null; a trail round-trips, a 1,000-page trail fits; 2,001-id lists, non-objects,
wrong / missing version, non-array lists and a numeric `at` are refused). The server was stopped afterwards.

Checks: `tsc --noEmit` studio / runtime / renderer → 0 errors; `node scripts/gen-public-docs.mjs --check` → current;
`node scripts/dependency-boundaries.mjs` → 0 violations; `node scripts/auth-guard-audit.mjs` → 0 problems.

Browser (`flock -o /tmp/p0/heavy.lock /tmp/p0/fresh.sh <suite>`, fake provider)
- `scripts/section-nav-test.mjs` → 16 / 16 ok (20 s): A visited mode (landmark, aria-current, locked + reason, Next×2,
  backward jump, visited forward jump, Back after it), B reload keeps the position and the visited trail, C free mode
  (keyboard jump over 3 unanswered pages, Back to the page jumped from, Submit gate "History: 2 / Geography: 1", gate
  link, completion, telemetry jumps), D assessment "3 questions unanswered — submit anyway?" → completes, E
  `rs.goToSection` refused with the reason in the console then accepted, F Arabic RTL.
  The suite found two bugs, fixed in the same commit: a section click or "Submit anyway" inside Next's minimum latch
  was dropped silently; the side rail sat under the preview toolbar.
- After the 0077 follow-up: `section-nav-test.mjs` → 19 / 19 ok (102 s), §G new: on a sandbox test link, Next then a
  free jump to section 3; the row holds `{v:1, stack:[ph1,ph2], visited:[ph1,ph2], at:pp1}`; the resume link in a
  fresh browser context (empty storage) lands on p1, the navigator states equal device A's, Back goes to h2 (the
  respondent's path), not g1 (the flow). Regressions: `engine-15-19-test.mjs` run 1 died when the Studio dev server
  was OOM-killed (26 ok, #18 document request — an OOM death), run 2 ok (35 checks, 426 s); `qa-fixes-test.mjs` runs 1
  and 2 died to Studio OOM kills (after 12 and 15 ok), run 3 ok (18 checks, 77 s).
- Regressions (same harness, after the navigator was in): `master-demo-test.mjs` ok (15 checks, 60 s);
  `qa-fixes-test.mjs` run 1 died when the Studio dev server was OOM-killed by the memory cgroup after 12 ok
  (`ERR_CONNECTION_RESET` on /sandbox — an OOM death, not a pass), run 2 ok (18 checks, 56 s); `assessment-test.mjs` ok
  (7 checks, 121 s); `engine-15-19-test.mjs` ok (35 checks, 534 s).

## Honest limits

- The trail is stored only for surveys with a navigator (`sectionNav` ≠ off); other surveys keep Back's old resume
  behaviour (compiled order after a resume on another device).
- Until 0077 is applied, the row has no trail: another device derives "visited" from the answers and the position, and
  Back falls back to compiled order. `at` (the current page) is stored but not used to position a resume.
- "Visited" also counts every page before the current one in the flow (the engine's rule), so a section the respondent
  jumped over and that lies BEHIND them shows as visited on both devices.
- The cross-device path was tested in the browser against the runtime's in-memory sandbox store and in SQL against
  Postgres 16 — not end to end against a Supabase deployment.
- A free jump does not run the skipped pages' arrival work (prefill, default values) until they are shown; the Submit
  gate validates them with whatever they hold then.
- Free mode refuses to pass a quota check at all (even one that would not fire) — use Next through a quota.
- The save route's replay walks the flow with `advance`, which applies skip logic with the answers as posted: a skip
  rule that fires on an EMPTY answer of a skipped page could route the replay differently from the respondent (logged,
  soft, not refused unless enforce sees an invalid answer).
- `visited` forward jumps simulate Next through every page between — on a very long jump this is O(pages²) compiles,
  fine for 100–200 pages, not measured beyond.
- The server-side replay was exercised by unit tests (`checkSubmission`), not by a browser run against a database: the
  sandbox runtime has none.
- The navigator lists outermost blocks / sections; pages outside any block are not listed, and a survey with fewer than
  two sections shows no navigator.
