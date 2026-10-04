# Media consolidation — 1-10-26 review

The review file `1_10_26.xlsx` (sheets "Oweas" and "Prince") asked for one place to manage a question's media, an image pop-up for answer-option pictures, a preview that keeps up with edits, removal through the dialog, matching alignment in the preview, and piped image URLs that work. Every row is covered below.

## What changed, row by row

| Row | Ask | Done |
|---|---|---|
| Oweas 1, Prince 1 | Choosing an option image opens a customization pop-up first; the image is added only after Apply | Choose / Upload on an option's Image URL open **Customize image**. It has width/height (px), scale, fit, alignment, keep proportions, shrink on small screens, padding, spacing, alt text and a live preview in an option-sized frame. Nothing is written to the option until Apply. Cancel leaves the option as it was. **Customize** reopens it for a picture that is already set. Typing or pasting a URL still sets it directly. |
| Oweas 2, Prince 2 | The same pop-up across every question type with option images | It is part of the option image field itself, so it appears on every type whose renderer draws option pictures: image, icon, list, card, product, carousel, multi-carousel, compare, flip and swipe cards, drag-rank, image ranking. The Live View element panel uses the same field. The settings are stored as `option.imageDisplay` and applied at every option-picture site in the renderer. The type, sub-type and every other setting are untouched. |
| Oweas 3, Prince 3 | Remove "Media shown under the question text" and consolidate into Insert media | The separate field is gone from new questions. Insert media (🖼 in the question text) now has: **sources** (asset library, upload new, URL, Google Drive URL, plus **Save to asset library** for a Drive file); **types** (image, video, audio, and a player for YouTube, Vimeo or Drive); alt text; size and layout per item; **Show media: Above question / Below question / At the cursor**; **several items**, which can be added, reordered and removed, each with its own settings; and a live preview of what the respondent sees. The HTML view still works. |
| Prince 4 | Position and several items only for the question text, not an option's image | Position and the several-items list appear only in the question-text editor. An option label's Insert media and an option's Image URL pop-up show only image settings. |
| Oweas 4, Prince 5 | The media preview does not update after editing an inserted item | **Root cause:** an edited picture was read back with the kind `img` (the tag name) instead of `image`. The dialog then had no preview branch, no alt field, showed player controls, and dropped the alt text on Apply. It now reads back as `image`, and the preview redraws on every change to size, alignment, fit, proportions, padding or spacing. |
| Prince 6 | Clearing the Source URL in Edit Media and pressing Apply should remove the media | When editing, an empty Source keeps Apply enabled and shows "Apply removes this media from the question". Apply then removes the element, along with the line it stood on if that line is now empty. Backspace/Delete and the HTML view still work. |
| Prince 7 | Alignment set in the builder is not the same in Preview | The current build places left / center / right the same in the editor, Live View and the respondent preview, including several items with different alignments. A browser test now measures all three. The edit bug above was what lost alignment and alt text on edited items. |
| Prince 8 | A URL parameter piped into an image URL shows as text | Insert media now accepts a piped source (`{{ImageURL}}`). It is stored as `<img src="{{ImageURL}}">`, shown in the editor and preview as a placeholder, and drawn as the picture for the respondent. If the respondent has no value, nothing is drawn instead of a broken image. **Second bug fixed:** piped option-image and question-media URLs came back HTML-escaped, so `?a=1&b=2` became `?a=1&amp;b=2`, breaking signed and CDN URLs. They are now unescaped. `{{ImageURL\|image}}` in text still works. |

## Existing questions

A question that already has `settings.mediaUrl` / `mediaItems` keeps it, and the renderer draws it exactly as before. The question pane shows a dashed card with the old editor and a **Move into the question text** button. The button turns every item into question-text markup, keeping the question's size and alignment and the side-by-side layout, and clears the old settings. It is one edit, so one undo puts it back. Media-owning types (video rating, timeline, watch time, audio recording) keep their own media field, unchanged.

## Players in text

Rich text never stores an `<iframe>`, because the sanitiser removes every one. A YouTube / Vimeo / Drive player is stored as a placeholder:

```html
<div data-rs-media="embed" data-rs-src="…">▶ title</div>
```

At display time the renderer runs `expandMediaEmbeds` after `sanitizeHtml`. This turns the placeholder into the same sandboxed, allow-listed player the question media used, at the size and alignment set. A placeholder for any other host is removed, not framed.

## Google Drive → asset library

The new route is `POST /api/surveys/[id]/media/import` (`survey.edit`, first statement `requireEditRight`). It works as follows:

- It downloads only a Drive file link, using `fetchDriveFile`.
- It refuses a page in place of the file (the file is not shared "Anyone with the link").
- It refuses a declared size over the limit before reading the body.
- It stores the file through the same ticket → PUT → confirm path as a browser upload (`storeAssetBytes`), and deduplicates by SHA-256.
- The helper is node-only. It is exported from `@rescript/media/server`, not from the browser barrel.

## Tests

- `packages/engine/src/mediaConsolidation.test.ts` (7 tests) covers:
  - padding/spacing round trip
  - `Option.imageDisplay`
  - embed placeholder → player, and only for allow-listed hosts
  - empty piped source dropped
  - `&` preserved in piped option and question media
  - piped `src` escaping and the `javascript:` refusal
  - legacy media → text
- `packages/media/src/importRemote.test.ts` (4 tests) covers:
  - Drive link shapes
  - download, HTML page refusal, size refusal before read, UTF-8 filename
  - stored and confirmed as a survey asset, then deduplicated
  - type and size limits
- `scripts/media-consolidation-test.mjs` (14 browser checks) covers every row above. The saved survey is mocked through `/sandbox?dbid=` so that Choose, Upload and the Drive save run.
- Mutation-checked:
  - engine 15/15
  - media 9/9
  - Studio/renderer 15/16, plus the option-image render site. The one survivor sets the dialog's initial position in `useState`, which the open effect sets again; it is an equivalent mutant.

## Not done

- **Hotspot / heatmap / annotation stimulus images:** a plain `settings.imageUrl` box without Choose or Upload. They keep their own fixed sizing, because their click regions are measured on the drawn image.
- **Drive videos:** saving one only works for files Drive serves without its virus-scan page, so in practice up to about 100 MB. Larger files should be downloaded and uploaded.
