# Rich text in answer options, and media with controls

Answer options, grid rows and columns are edited as rich text with the same
editor question text has; pictures, video and audio are inserted from the
asset library and sized with controls; and what the builder shows is what
the respondent sees, because size, fit and alignment are one computation.

## Rich option labels

`Option.label`, `QuestionRow.label` and `QuestionColumn.label` were always
`string`, always rendered as HTML (every variant hands them to
`dangerouslySetInnerHTML`), and edited in a plain `<input>`. Nothing in the
schema changed — a plain label is the same string it was, and a survey from
before this reads byte-for-byte the same. What changed is the editor and the
safety around it.

**Editor.** `InlineRichText` (`apps/studio/components/studio/RichTextEditor.tsx`)
is a single-line contentEditable that looks like the input it replaced and
keeps its keyboard contract — Enter adds the next option, Backspace on an
empty label removes it, arrows move between labels, a multi-line paste
splits into options. Its toolbar (`RteToolbar`, the same one question text
has) opens when text is selected or the **Aa** button is clicked: bold,
italic, underline, strike, super/subscript, alignment, font size (CSS
`font-size`, not `<font>`), colour, highlight, link, **🖼 media**, piping,
clear formatting, and an **HTML** source view. Used for options, columns and
form fields in the properties panel, and for options, rows and columns in
the Live View inspector.

**Safety, twice.** The editor sanitises on every commit (`sanitizeHtml`),
and — new — the engine sanitises every option, row and column label at the
one seam all variants read through (`effectiveQuestion`, `carryforward.ts`),
so a label written by an API client, an import or before the editor existed
is safe at render too. Question text, instruction and custom HTML are
sanitised at render in `QuestionRenderer`. The sanitiser now also:

- strips `<script>` blocks whole (their body is code, not text),
- keeps `style=` but removes executable CSS inside it — `behavior:`,
  `-moz-binding`, `expression()`, `@import`, `url(javascript:…)`,
  `url(data:text/html…)` (`sanitizeCss`),
- reads `<img alt>` in `stripHtmlText`, so a picture-only option has a name.

**Exports and identifiers.** Value labels in the CSV / XLSX dictionary and
SPSS syntax are plain text (`variables.ts`), the docx and the option-paste
matcher go through `stripHtmlText`, and a logo-only option reads as its alt
text everywhere a short label is wanted. Piping, logic references,
randomization, masking, carry-forward and stored answers are by **code**,
which no formatting touches.

**Translations** are still edited as plain strings in the localization
editor; a rich label shows its markup there. That is a decision for the
translation editor, not for this feature.

## Media with controls

`MediaDisplay` (`packages/schema/src/mediaDisplay.ts`) — width, height, max
width/height, fit, alignment, keep-ratio, responsive, autoplay, controls,
muted, loop, poster, custom CSS — is edited by `MediaDisplayControls` and
turned into CSS by one engine function, `mediaDisplayCss` /
`mediaDisplayStyle` (`packages/engine/src/mediaDisplay.ts`). Where it lives:

| where | field | rendered by |
|---|---|---|
| a question's media | `settings.mediaDisplay` | `<MediaEmbed display>` |
| the branding logo | `branding.logoDisplay` | `<SafeImage display>` |
| a picture / player in rich text | the element's `style` attribute | the browser, via the same CSS |

The insert dialog (`MediaInsertDialog`) builds the markup with `mediaHtml`
from the same object, marks it `data-rs-media="image|video|audio"`, and
reads it back (`mediaDisplayFromCss`, `mediaValueFromElement`) when the
element is clicked, so "make the logo smaller" is a number changed. Audio is
an `<audio>` element now — a player bar, not a black video box. Video
autoplay is written muted, because browsers only honour it muted.

Responsive by default: `max-width: 100%` unless the researcher turns
"shrink on small screens" off, so a 300px logo is 300px on a desktop and the
screen's width on a phone.

## Tests

- `packages/engine/src/richContent.test.ts` — CSS hardening, sizing markup
  through the sanitiser, labels safe at the seam, alt text in the dictionary,
  the MediaDisplay round trip.
- `packages/media/src/assets.test.ts` — the library as one survey sees it,
  duplicates, rename/share from the owner only, the MIME allowlist.
- `scripts/rich-media-test.mjs` — the flow end to end in the browser: an
  option made bold, Enter still adding options, a picture inserted at 120px
  centred, the HTML view sanitising a handler and a script, a question's
  media set to 200px contain, the Assets tab, and the runtime rendering all
  of it with the same sizes.
- The existing Studio suites (`studio-test`, `blocks-test`, `canvas-test`,
  `count-logic-test`, `option-logic-test`, `option-groups-test`,
  `qa-fixes-test`) address the label surface by `[data-oidx]` and
  `textContent` now.
