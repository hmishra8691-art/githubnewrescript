# Moving jQuery / custom JavaScript surveys to Rescript (2026-11-07)

Qualtrics and Decipher programmers solve many layout and flow problems with jQuery on the respondent's page.
Rescript does not load jQuery, and logic scripts run in a sandbox without the page (so the server can replay every
answer). Almost every jQuery pattern has a **native setting** that does the same job on every device, in the
preview, in the simulator and in the server replay. The importer (`packages/import/src/jsMigrate.ts`) reads imported
code statically and gives a verdict per script: compatible / native / partial / incompatible — this guide is the
manual version of the same table.

| What the jQuery / JS did | Rescript equivalent | Where |
|---|---|---|
| `hideNextButton()` then show after N seconds | Page timer: minimum time before Next | Flow › page › Timer |
| `clickNextButton()` on a timeout | Page timer with limit + "advance" on timeout | Flow › page › Timer |
| Click an option → submit the page | **Auto-next** (survey default or per question; multi-selects and grids wait) | Branding › Layout; Question › Auto-next |
| `setEmbeddedData` / `getEmbeddedData` | `setEmbedded(name, v)` / `getEmbedded(name)` in a logic script (translated automatically) | Scripts |
| `setChoiceValue` (pre-select / punch) | Punch rule (applies on every device and in the replay) | Question › Punches |
| Hide an option based on an earlier answer | Option display logic, or carry-forward with a filter | Question › option ⚙ |
| Change option text by an earlier answer (`$('.LabelWrapper').text(...)`) | **Option text by answer (grid)**, or a ternary label expression | Question › Dynamic logic |
| Change question text by an answer | Dynamic text (ternary / piping) | Question › Dynamic logic |
| Number the questions / letter the options with CSS counters | Question numbers (code / sequence), option letters / numbers | Branding › Layout |
| Re-style one question (`$(...).css(...)`) | UX rule on the question, or theme / question styles | Question › Look |
| Input masks, prefixes / suffixes (`$`, `%`, phone formats) | Validation kinds (number only, length range, US state, date format), affixes, masked input | Question › Validation |
| Column / sum checks in a grid | Validation rules (sum, per-row), allocation question | Question › Validation |
| Randomise with `Math.random` and hide | Randomizer flow element, option / row randomisation with anchors | Flow; Question › Randomise |
| Redirect with `window.location` | End element with a redirect URL and piped parameters | Flow › End |
| `$.ajax` / `fetch` to an API | Signed webhook (Alerts) out; embedded data / URL parameters in | Alerts; Access |
| `setInterval` animations, custom widgets | Native question variant (slider, card sort, hotspot, heatmap, …) or a custom component | Question picker |

## What cannot be moved and why
- Moving the respondent back (`clickPreviousButton`) — navigation belongs to the runtime.
- Reading or writing arbitrary page DOM from a logic script — the script must give the same answer when the server
  replays the response; anything visual is a UX rule.

## How to check a migrated survey
1. Import the .qsf — every script is imported **switched off**, with its verdict and findings in its notes.
2. Flow › **Paths** › Explore: who reaches each page and branch path; Compare two: the text and options two answer
   sets see.
3. Test › production-like test (or ask Intelligent Mode "who goes where?") for routes, quota fill and endings.
4. The programming harnesses (`scripts/programming-audit.mjs`, `scripts/programming-audit-browser.mjs`) run in CI on
   every push.
