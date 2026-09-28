# Intelligent mode — advanced UX, CSS and JavaScript

*Built 2026-09-28.* The brief: "Intelligent Mode — Advanced UX, CSS &
JavaScript Customization" (21 sections). It extends the copilot
([INTELLIGENT-COPILOT.md](INTELLIGENT-COPILOT.md)) from research and survey
programming to UX engineering, using the same controlled action layer.

## What it does

A researcher can now ask Intelligent mode for changes to how the survey looks
and behaves, for example:

- "make Q12's options modern cards, animate the one they pick, expand Other smoothly, don't change the logic"
- "fade Block 3's questions in one at a time"
- "animate the Next button when Q5 is answered"
- "stack Q7's options on mobile"
- "make the existing animation slower"
- "clean up the custom CSS"
- "add JavaScript that…"

The copilot proposes structured **UX actions**, and the engine validates them.
The Changes panel then previews them on the **real question components**.
Apply records them as one undoable AI change.

## Architecture

```
request ─ classifyRequest → ux / uxOnly ("don't change the logic", "make Q10 look better")
        ─ the UX GUIDE, the theme, and the named questions' layout + existing UX go to the model
model  ─ create_style / update_style / remove_style
         create_animation / update_animation / remove_animation
         create_behavior / update_behavior / remove_behavior
         attach_behavior_to_question|option|block|page, create_responsive_rule
engine ─ targets resolved to stable ids (question id, option code, block id, page id)
         every CSS value through ONE gate (checkDeclarations); CSS text scoped (scopeCss)
         scripts validated (validateUxScript); items validated (validateUxItem)
         uxOnly: structural actions refused; structureUnchanged proven (withoutUx before === after)
Studio ─ Changes → "Look and behaviour": each item in words, the proof, the preview
         (real renderer + theme + compiled CSS + the runtime's UxLayer), the code
       ─ UX tab: what the survey has, the UX review, Remove… (a confirmed proposal)
runtime─ the shell carries data-rs-ux / data-rs-block / data-rs-page and the nav buttons data-rs-button;
         <UxLayer> injects the compiled CSS, marks answered cards, staggers, replays page
         transitions, runs behaviours (fire / hold / release) and sandboxed scripts
```

## The data (schema `ux`)

`SurveyDefinition.ux = { styles, animations, behaviors }` is stored in the
definition. That is why preview, test, publish, export and duplicate all carry
it. If a survey has no `ux`, the runtime renders exactly as before: there is no
attribute, no stylesheet and no layer.

| Item | Shape |
|---|---|
| style | `target` + `rules[]` (`state`: hover, focus, selected, answered or disabled; `media`: mobile, tablet, desktop or reduced_motion; `whenClass`; `selector`; `declarations`), or scoped `css` text (`&` is the target) |
| animation | `target`, `preset` (fade-in, fade-up, fade-down, slide-left, slide-right, scale-in, pop, pulse, shake, bounce, wiggle, highlight, glow, expand), `trigger` (appear, page_enter, hover, focus, select, answer), duration, delay, easing, `staggerMs` (one at a time), iterations, media |
| behaviour | `target` + `on` (answer, change, select_option, deselect_option, page_complete, block_complete, appear, page_enter, click, hover) + `effects[]` (animate, show_message, hide_message, add/remove/toggle_class, set_style, show, hide, scroll_into_view, focus). Alternatively a sandboxed `script` |

A **target** names survey objects by stable id, never by a generated CSS path:
survey, block, page, question, option, row, column, button (next, back, submit
or any), progress (and its fill), navigation, and component (a simple selector
inside a custom component). It can also address a question part: card, title,
instruction, options, input, other_text, media or error.

The model and the script API share a single string grammar for targets:

- `Q5`, `Q5.options`, `Q5.option:Other`, `Q5.title`, `Q5.other`
- `block:Brand.questions`, `page:3`
- `next`, `progress.fill`, `nav`, `survey`

## Safety

- **Scoping.** Every compiled selector starts with `[data-rs-ux="<survey id>"]`. A style can only match this survey's own elements, never the Studio or another survey. `html`, `body` and `:root` are refused, as are `& + x` and `& ~ x`, `@import`, `@font-face` and every other at-rule except `@media`, `@supports` and `@keyframes`. Keyframes are renamed into the style's own namespace.
- **The CSS gate** (`checkDeclarations`) applies to structured rules, CSS text and the runtime's `set_style` alike:
  - it refuses `{ } ; < >` and escapes;
  - it refuses `expression()`, `javascript:` and bindings;
  - `url()` may load only https, or an inline png, jpeg, gif or webp image.
- **Gate warnings.** The gate warns on `!important`, `position: fixed`, very high `z-index`, and fixed widths wider than a phone. It also warns on hiding a question, or setting `pointer-events: none` on answers or buttons, because either stops a respondent answering or moving on.
- **Structure is untouched.** UX actions write `def.ux` and nothing else. A look-only request (`uxOnly`) refuses every structural action with its reason, and the proposal shows *"UX only — the survey's questions, options, codes, logic and validation are unchanged"*. This is checked, not assumed: the survey without `ux` before must equal the survey without `ux` after. The applied note says the same.
- **Scripts** are used only when the researcher asks for code, or when no declarative effect can do the job.
  - *Static checks* (`validateUxScript`). The script must parse. It may call only the `rs` API, and every target and question it names must exist. It must not use loops (`while`, `for`, `do`), because a sandboxed frame can share the page's thread. It must not use `document`, `window`, `parent`, `fetch`, storage, `eval`, `Function` or `constructor`. A duplicate `rs.listen` gets a warning.
  - *Validated twice.* The checks run again in the runtime before a script is started, because a definition can also be edited by hand.
  - *The sandbox.* Each script runs in its own sandboxed frame: an opaque origin (`sandbox="allow-scripts"`), with a Content Security Policy that forbids every network request.
  - *What a script can do.* It can only post `rs` commands. Each command is checked (target resolved against the survey, styles through the CSS gate, class tokens namespaced, text inserted as text) and rate-limited to 200 a second. A script that floods is stopped. Scripts run on the pages that show what they are attached to.
- **The `rs` API:**
  - `listen(event, target, fn)`
  - `getAnswer`, `getQuestion`, `getBlock`, `getPage`
  - `addClass`, `removeClass`, `toggleClass`
  - `animate(t, preset, {duration})`
  - `setStyle`, `clearStyle`
  - `show`, `hide`
  - `showMessage`, `hideMessage`
  - `scrollTo`, `focus`
  - `after(ms, fn)`, `log`

  There is no way to set an answer, read other surveys or reach the Studio.
- **React-safe.** Classes are tokens in `data-rs-ux-on`, not in `className`, which React rewrites whenever an option is selected. The answered mark is `data-rs-ux-answered`. Messages are appended text nodes. A re-render never erases a UX effect, and a UX effect never erases a re-render.
- **Accessibility.** Animations run only under `prefers-reduced-motion: no-preference`, and the Web Animations effects check it too. The guide tells the model never to hide a radio button with `display: none`.
- **Undo.** Every application is an AI Change with its before and after. Removing a UX item is marked destructive and needs confirmation.

## Existing UX, refactoring, diagnosis

- The outline gives the model every existing item by id. For a UX request it also gives the theme and, for each question the request names, `Qn ux:`: its layout (orientation, columns, option count, Other) and every style, animation and behaviour that touches it, plus its own hand-written CSS and JS if any.
- The model is told to change existing items instead of adding competing ones. "Slower" becomes `update_animation`, and `update_style` changes the rule for the same state or breakpoint rather than adding a second one.
- `reviewUx` feeds both the Review tab (category `ux`) and the UX tab. It finds:
  - items whose target is gone (with a Remove fix);
  - two styles setting the same property on the same element;
  - two animations on one element and trigger;
  - styles overriding the theme's buttons or font;
  - side-by-side options with no phone rule;
  - Branding or question custom CSS that styles `html`, `body` or `:root`.

## Tests

- engine `ux.test.ts` (8): the target grammar, the CSS gate, scoped CSS text, the UX actions end to end, the look-only guard and the refusals, scripts, the UX review, and the runtime triggers. Mutation checked: of 27 mutations, 5 survived and 3 did not compile. All 8 were closed with tests or rewritten, then re-checked, and all 10 re-checks were caught.
- studio `copilot.test.ts` (+2): UX intent (look-only versus mixed versus generation), the guide sent only on UX turns, the outline's UX, the proposal's proof and uxNotes, the change record, the preview scope. Mutation checked.
- browser `scripts/ux-copilot-test.mjs` (13):
  - Runtime: scoping; hover, selected, pop; stagger; Next pulse; hold and release, surviving re-renders; the sandboxed script through `rs` (the gate refuses `javascript:`); the sandbox against page, storage, network, flood and loop; the page transition between pages; the mobile rule; no UX means no change.
  - Studio: the look-only request with a refused rewording; the preview (after, before, phone); the code; Apply with byte-identical questions and flow; "slower" modifies; JavaScript previewed working and a network or page script refused; the UX tab (conflict, removal); undo.

## Not done

- The Studio's Live Question Canvas (authoring) does not render the UX layer. The copilot's preview and the runtime (Preview, Test, live) do.
- `block_complete` means the block's questions *on the current page* are all answered.
- The existing hand-written Branding and question `customJs` still run unsandboxed, as before. The copilot never writes to them: it uses sandboxed behaviours instead.
- A question's **Default value** setting (Properties) is still not applied by the runtime, so the copilot does not offer pre-filled answers. UX scripts cannot set answers, by design.
