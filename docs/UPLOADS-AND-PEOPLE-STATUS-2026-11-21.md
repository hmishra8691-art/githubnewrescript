# Adding people, uploads and the portal's accounts — status (21 November 2026)

The request: wherever a file of people can be uploaded, also allow typing them in; offer a template; validate,
preview and confirm; make the respondent portal's account creation use the same lists; simplify both screens
without removing anything; audit every upload on the platform.

## How it works now

There is one list of people per survey (a live one and a test one). It is reached from two places, and both now
use the same "Add people" box.

| Where | What you do there |
| --- | --- |
| Distribution, top of the page | Add people, see your lists, download or email links |
| Distribution, Respondent portal, People and accounts | Choose a list, add people, create their portal accounts |

### Adding people (the same box in both places)

1. **How.** Type them in (name, email, their ID; "Add another person"; or paste several addresses at once),
   upload a file, or paste cells from a spreadsheet.
2. **Which list.** An earlier list, or a new one with a name. A new list is offered the file's name.
3. **Check.** Nothing is written. The check says how many people will be added and lists what needs a look,
   by row.
4. **Confirm.** The people are added. People already on the survey's list are left out unless you untick that.

### The template

"Upload a file" shows two buttons: Download template (Excel) and (CSV). Columns: `name`, `email`, `id`,
`department`. Each person needs an email or an id. Extra columns are kept with the person. The template has one
example row; if it is uploaded unfilled, the row is recognised and never added.

### What the check reports

| Finding | What happens to the row |
| --- | --- |
| An email address that looks wrong | Named with its row. The person is still added, as before, with the address as written; the check says an invitation cannot be emailed to it |
| The same person twice in the file | The repeat is left out |
| A row with nobody in it | Left out |
| The template's example row | Left out |
| A person already on this survey's list | Left out by default (a tick box) |
| No column recognised as email or id | A warning, and the column list opens so it can be set |
| A file of the wrong kind, or over 15 MB or 20,000 rows | Refused, with the formats that work |

### Lists

"Your lists" shows each list with its people, links sent, started and completed. Each can be downloaded,
emailed, sent again, marked as sent, renamed (new) or have its unopened people removed. A list cannot be renamed
onto another list's name.

### Portal accounts

1. **List to work with**: everyone, or one list, with its size and how many already have an account.
2. **Add people** opens the same box, for the live list. Afterwards the section moves to that list.
3. **One button** creates accounts for everyone in the chosen list who has none. It works on the whole list,
   not only the 200 rows on screen, 2,000 people per press; the page says when more remain.
4. Ticked people can still be handled one by one.
5. Everything else (pause, restore, dates, attempts, lock, unlock, reopen, first password, sign out, remove) is
   under "More actions for the ticked people". Nothing was removed.

How sign-in details reach people is stated on the page, from the same rule the server uses:

| Person | What happens |
| --- | --- |
| Has an email address, email is set up | They are emailed a link to set their own password. You never see it |
| Has an email address, email is not set up | The account is created; the page says no invitation was sent |
| Has no email address | Their sign-in link is shown once, with a Copy all button, to hand over |

One behaviour changed on purpose: creating accounts now always asks for the invitations as well. Before, on an
installation without email, a person with no address got an account but no link until "Send invitation" was
pressed separately.

## Every upload on the platform

Only the respondent list is a file of people. Team members are invited one at a time in Collaborators, not from
a file, and that was left alone.

| Upload | Accepts | Formats and columns shown | Template | Preview before saving | Changed now |
| --- | --- | --- | --- | --- | --- |
| Respondent list (Distribution, Portal) | CSV, TSV, TXT, XLSX, XLSM | Yes | Excel and CSV | Yes | Rebuilt |
| Tracker wave | CSV, TSV, TXT, XLSX, XLS | Yes | An earlier export | Mapping step after upload | Hint added |
| Conjoint / MaxDiff design | CSV, TSV, TXT | Yes | A generated design's CSV | No; refused without a `task` column | Hint added |
| Translations | XLSX, CSV, JSON | Yes | The Export buttons | No; says how many applied and skipped | Hint added |
| Response import | CSV, TSV, TXT, JSON, XLSX, XLSM | Yes | An export of the survey | Yes | No |
| Questionnaire import (Intelligent view) | QSF, XML, DOCX, XLSX, CSV, PDF, TXT, JSON | Yes | Mentioned | Review screen | No |
| Brief and reference files (Intelligent view, Copilot) | PDF, DOCX, TXT, MD, CSV, XLSX | Partly | Not applicable | Not applicable | No |
| Survey JSON, script bundle | JSON | Yes | An export | Validated on load | No |
| Media and assets (library, picker, insert, media lists, video prompts) | Images, video, audio | Partly | Not applicable | Shown after upload | No |
| Brand guidelines | PDF | Yes | Not applicable | Colours shown before applying | No |
| Theme references, report logo, story assets | Images, PPTX, PDF, fonts | Partly | Not applicable | Shown after upload | No |
| Transcripts and recordings (Qual) | TXT, VTT, SRT, DOCX; audio, video | Partly | Not applicable | Listed after upload | No |

"Partly" means the button names the kind of file but the accepted extensions are only in the file chooser.

## What was tested

| What | How | Result |
| --- | --- | --- |
| Row-by-row findings, the template (CSV and Excel), the example row | exporters suite: 157 tests | pass |
| Typed rows, pasted addresses, merging, headline wording | `peopleIntakeCore.test.ts`, 4 tests | pass |
| "Everyone in a list" requests, list summaries, the sharing sentences against the rule | `portalAdminCore.test.ts`, 3 new tests (Studio suite: 1,326) | pass |
| The whole walk in a real browser | `scripts/people-intake-test.mjs`, 25 checks, on `/sandbox/people` | pass |
| The Distribution tab inside the full Studio | `scripts/distribution-test.mjs`, 8 checks, updated to the new box | pass |
| Guards, tenancy, row-level security, unused exports | `pnpm audit:code` | 0 problems |

The 25 browser checks cover: the empty state; both templates; typing people in, with a mistyped address flagged
as typed; pasting several addresses; a new list needing a name; the check writing nothing; confirming; a file of
the wrong kind; a file with two wrong addresses, a repeat, an empty row, the example row and a person already
listed; the unfilled Excel template; reusing a list; renaming; the portal's list picker and counts; adding a
person from the portal section; creating accounts for a whole list; the hand-over link for a person with no
address; the message when email is not set up; the no-account filter; the actions under More actions; phone
width. The phone check found the typed-people table pushing the page sideways; it now stacks.

## What was NOT tested

- **Nothing ran against a database.** The browser walk uses an in-memory list that exists only where no database
  is configured and never in production. The checks and decisions are the product's own code; the storage is not.
  Three database paths are new and type-checked only: renaming a list, listing by list and "no account", and
  finding "everyone in a list" on the server.
- **No email was sent.** The "emailed a link" path was not seen in a browser.
- **Volume.** A list of thousands was not uploaded, and the 2,000-per-press path was not exercised.
- **Email lists, send again, mark as sent, remove unopened** were relabelled, not re-tested in a browser.
- **The hints added to the tracker, design and translation uploads** were type-checked, not opened.
- **Drag and drop** of a file onto the box: the test uses the file chooser.

## Known gaps

1. A wrong-looking email address is reported, not refused: the person is added with it. Fix the file and check
   again to avoid that. Refusing such rows outright would change what existing uploads do, so it was not done.
2. Lists cannot be merged, and a person cannot be moved between lists.
3. A list cannot be deleted whole from the screen once links were opened; only unopened people are removed.
4. The check shows the first 200 findings.
5. The portal table shows 200 people at a time. The list button reaches everyone; ticking does not.
6. Tracker, design and translation uploads have no row-by-row preview like the respondent list.
7. Team members still cannot be invited in bulk.
8. The rename uses the browser's own prompt box.

## Nothing to apply

No migration. No setting.
