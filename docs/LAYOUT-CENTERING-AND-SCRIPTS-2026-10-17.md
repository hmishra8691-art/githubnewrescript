# Layout centring after a theme, Intelligent Mode overflow, and script compatibility (2026-10-17)

Brief sections 12 (theme, border and centred layout) and 13 (JavaScript / CSS / animation verification).
Engineer C. Every number below was measured in Chromium (Playwright) against a Studio dev server (:3100,
`AI_API_URL=fake:`) and a runtime dev server (:3101), before and after the change.

## 12 — Reproduction (measured)

**Respondent survey (runtime), offset of the survey frame's centre from the window's centre:**

| Theme | 1600 | 1280 | 1024 | 768 | 390 |
|---|---|---|---|---|---|
| no theme | 0 → 0 | 0 → 0 | 0 → 0 | **−4** → 0 | 0 → 0 |
| Gen-Z preset (640px, full) | 0 → 0 | 0 → 0 | 0 → 0 | **−64** (x=0) → 0 | 0 → 0 |
| contained 640px, default align | **−480** (x=0) → 0 | **−320** → 0 | **−192** → 0 | **−64** → 0 | 0 → 0 |

A question with one 400-character word made the page **3,720px** wide at 390px (→ 390).

**Intelligent Mode (`/sandbox?mode=studio` → Intelligent), 25,000-character prompt + a 14-block research plan
with long variable names, a 400-character URL and an unbroken assumption:**

| | Before | After |
|---|---|---|
| conversation log `scrollWidth` / width, 1600 | 3,182 / 994 (scrolls sideways) | 994 / 994 |
| the turn card, 1600 / 1280 / 1024 | 3,115 in 860 / 626 / 370 | fits |
| toolbar in the pane, 1280 / 1024 (3 panes) | 787px of controls in 674 / 418 px — "Plan first" and the **Panel toggle under the panel, unreachable** | wraps, right-aligned, every control visible and hit-testable |
| page `scrollWidth` at 390 | 594 (the whole Studio scrolled sideways) | 390 |
| column widths | welcome 760, turns 860, ask bar the full pane | one 860px column for all three, centred |
| the echoed 25k prompt | ~400 lines pushing the answer pages down | a bubble capped at min(320px, 40vh) that scrolls |

Centring of the conversation column inside its pane was already correct (±0px) and stays so; applying a
Branding preset and a Design-with-AI theme moves it by 0px at all five viewports (the Studio chrome never read
the survey's theme). The theme live preview (Branding, 399px panel) never narrowed enough for the bug to show
there; the copilot card preview (`cp-ux-shell`, 360px panel) does with a narrow theme — verified centred after
the fix with a contained 300px / right-aligned theme at desktop, tablet and phone (not measured before).

## Root cause

1. **The theme moved the frame.** `brandingVars()` turned `layout.contentAlign` into the shell's margins
   (`--rs-align-ml: 0` for "left"), and **"left" is the schema default, stored on every survey**. Whenever a theme
   made the frame narrower than the window — `widthMode: "contained"`, or any preset's `maxWidth` below 1024px —
   the survey was pinned to the left edge. Full-width desktop escaped only because that rule forced `margin: auto`.
2. **Intelligent Mode:** no `overflow-wrap` on turns (an unbroken token set the card's min-content); a `nowrap`
   toolbar with no wrapping in a pane that can be 418px; the menubar's invisible measuring probe
   (`.menubar-measure`, absolutely positioned, 594px) was scrollable overflow once `.ide` stops clipping (≤900px).

## Fix (files)

| File | Change |
|---|---|
| `packages/renderer/styles/questions.css` | `.rs-shell` margins are always `auto` — the frame is centred in every mode and viewport. `contentAlign` now aligns the question text and instructions (`text-align: var(--rs-content-align, start)`) and places the 68ch measured text block inside a full-width card. `overflow-wrap: break-word` on question text and instructions (break-word, not anywhere: a question's own HTML table still scrolls in `.rs-qhtml`). |
| `packages/renderer/src/branding.ts` | `contentAlignVars()`: "left" (default) emits nothing, so the writing direction decides (an RTL survey stays right-aligned); "center"/"right" set the text variables. No variable reaches the frame. |
| `apps/studio/app/design-system.css` | `--iq-column: 860px` shared by welcome, turns and the ask bar (padding `max(14px, (100% − column)/2)`); turns `overflow-wrap: anywhere; min-width: 0`; echoed prompt bubble capped and scrollable; `.iq-toolbar` wraps (`justify-content: flex-end`, hint `flex: 1 1 0`); `.menubar-measure { width: 0; overflow: hidden }` (children `flex: none`, MenuBar reads their `offsetWidth`, unchanged); at ≤900px the menubar scrolls inside itself like the top bar; `.project-spend` vertically centred. |
| `apps/studio/components/studio/BrandingPanel.tsx` | "Content align" tooltip says what it now does. |
| `scripts/desktop-layout-theming-test.mjs` | the three content-align checks now assert a centred frame + the text alignment (they asserted the old pinning). |

Tests: `scripts/layout-centering-test.mjs` (new, 14 checks, `STUDIO_URL`/`RUNTIME_URL`, `SECTIONS=runtime|studio`,
`SHOTS=<dir>`), `apps/studio/lib/layoutCentering.test.ts` (new, 3). The suite fails on the old code for each defect
above (frame offset, log/turn/page overflow, covered toolbar controls).

## 13 — Scripting stack: verified, no defect reproduced

Suites green against :3100/:3101: `style-script-p0-test` 11, `age-script-p0-test` 10, `popup-p3-test` 14,
`ux-script-dom-test` 15, `ux-copilot-test` 13, `theme-voice-test` 8, plus `menubar-test` 28,
`intelligent-mode-test` 55, `desktop-layout-theming-test` 24. New in `layout-centering-test`: a survey's scoped
style keeps applying under a pills and a cards theme (and the theme still restyles everything else); a **theme
changed live** (the Studio pushing a new definition to the open preview) keeps the frame centred, the scoped
style, exactly one compiled stylesheet and one script sandbox frame, and the script still answers once.

### Compatibility rules (Style Animation Scripts, Custom Code, themes)

1. **One pipeline.** Styles, animations and behaviours live in `survey.ux`; "Custom Code" (`set_custom_code`,
   legacy `question.customJs`) becomes a script behaviour and **replaces** the migrated one (same id) — old and
   new code never both run. `custom_component` code is separate and untouched.
2. **Pattern before code.** Declarative behaviour (effects on an event) first; `show_popup`/`rs.popup` for
   popups; a script only when effects cannot say it. One mechanism per behaviour: a second behaviour for the
   same target + event + options is refused ("Update <id>"). Stopping a respondent is validation
   (`set_validation`), never a script disabling or hiding Next/Back.
3. **Scope.** Compiled CSS sits under `[data-rs-ux="<survey id>"]` and the `data-rs-el`/`data-rs-id` hooks
   (≈0,5,0), never `html`/`body`/`:root`. Theme rules are ≤0,2,0 and act through `--rs-*` variables, so a theme
   change restyles everything the UX does not name and leaves what it names. A UX style that should follow the
   theme should use `var(--rs-primary)` etc. rather than literal colours (guidance, not enforced).
4. **Sandbox.** Scripts run in an `allow-scripts`-only iframe and reach the survey only through `rs`; creating
   `<style>`/`<link>`/`<script>`, `document.head`, network, cookies/storage, self-polling timers and hand-built
   full-screen overlays are refused at authoring time (errors in Intelligent Mode and the theme assistant,
   warnings in the editor; the runtime gate is unchanged so stored scripts keep running).
5. **Lifecycle.** A script runs only on the page that shows its question, starts once per page visit (Back and
   forward does not duplicate it), its frame is removed on page change, and a re-render — including a theme
   change — keeps one stylesheet and one frame. A popup on `select_option` holds only while the option is selected.
6. **Motion and devices.** Animations compile inside `@media (prefers-reduced-motion: no-preference)`; phone
   rules use `media: "mobile"`; popups are 460px on desktop and 90vw on a phone, centred.
7. **Studio previews** contain a script's additions to `body` and its fixed elements inside the preview shell.
8. **Generated code is labelled** "checked, not run yet — try it in Preview"; requests in Devanagari/Urdu/Arabic
   or with popup/tooltip words reach the model with the UX guide and the questions' real hooks.

## Not done, and why

- **Studio canvas (Questions)** is a full-width IDE workspace: measured centred (equal 28px/16px gutters) at every
  viewport, not capped to a reading measure — that is a product decision, and many suites depend on its layout.
- **Three panes at 1024px** leave the conversation 418px wide; panes collapse only below a 960px workspace
  (`@container`). Collapsing earlier is IntelligentView behaviour (engineer A's); the toolbar now wraps instead
  of hiding controls. The ask textarea stays narrow there.
- The top bar still scrolls inside itself below 1100px (existing design); the project-spend amount is hidden
  below 1400px by the existing rule, so only its label shows.
- RTL was not browser-tested; the unit test asserts "left" emits no alignment, and the CSS falls back to `start`.
- `cp-ux-shell` centring was verified after the fix only.
- Environment: the Studio dev server (2 GB heap on a shared 8 GB machine) restarted itself and was once
  OOM-killed during runs; the suite retries a copilot/theme request only when it failed at the network level.
