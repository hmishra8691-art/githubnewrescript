# Intelligent Mode as a research-operations agent — status (22 November 2026)

The request: make Intelligent Mode able to understand, configure and carry out what the last six phases added
(the respondent portal and everything around it), from a sentence and an attached file, with a preview and a
confirmation before anything important, and precise guidance where it cannot act.

## What it does now

A researcher attaches a file (paperclip, **People list**) and says what they want. Example, word for word from
the brief: "Upload this file and use it for respondent account creation and email invitations."

The agent then:

1. Reads the file (CSV, TSV, TXT, XLSX, XLSM) and works out which column is the email, the name and the ID
   **from the cells as well as the headings**, with the reason for each column shown.
2. Lists what needs a look, by row: wrong-looking addresses, repeats, empty rows, people already on the list.
3. Shows a plan. Each step carries its reason. Nothing is written yet.
4. Asks only when it has to: two columns could be the email, or nothing tells people apart.
5. On **Confirm**, runs the steps through the same routes the screens use.
6. Reports each step: how many added, how many accounts, what was not done and why, and the next action.

### How columns are read

| Field | How it is recognised |
| --- | --- |
| Email | The cells are email addresses (60% or more), whatever the heading says. Otherwise a heading that says email |
| Their ID | The heading says ID, number, code or reference, the values are all different, and it is not a phone or postcode |
| Name | A heading that says name. Or a first-name and a last-name column, joined first-then-last whatever order the file has them in. Or, with no such heading, a column whose cells read like people's names |
| Everything else | Kept with the person as extra information |

Two candidates for one field produce a question with the default shown. The researcher's answer wins. This
reader also serves the manual Add people box, so both read a file the same way.

### What it carries out, after a preview and Confirm

| Sentence | What happens |
| --- | --- |
| "Upload this file to a new list called Wave 2" | People are added to that list |
| "…and create their accounts and send the invitations" | Accounts for everyone on the list without one; invitations as the platform's rule allows |
| "Create accounts for the Wave 2 list" | Uses the list already there. No file needed |
| "Pause access for the Night shift list", restore, lock, unlock | Applies to the whole list, at once |
| "Let respondents see their scores and change their answers for 48 hours" | Portal settings, shown as now and after |
| "Use the employee engagement template" | Applies the template; its fixed rules are flagged before applying |
| "How many people still have no account?" | Answered from the lists |

Settings covered: portal on or off; answers, earlier attempts, scores, range names, comparison, change over
time, sentences, projection, AI paragraph, achievements; messages; editing (never, until locked, for N hours or
days); attempts; template; identity.

### What it only guides to, and why

For these it gives the place, the steps and the reason for each step. It never runs them from a sentence.

| Function | Why it is guided |
| --- | --- |
| Privacy requests and consent | You carry the request out first; the answer is recorded against your name |
| First password, sign out, remove from portal | A password must not pass through a chat; these act on one named person |
| One respondent's results | Each opening is written to the audit log against you |
| Dates and attempts for some people | Dates are easy to misread in a sentence |
| Defining scores | Which questions make a score is a research decision |
| Reminders | A scheduled job an administrator switches on once |
| The respondent's PDF report | It is the respondent's own download |
| The list template | A download; the agent gives the place |
| Personal survey links (download or email) | A different invitation from the portal's; not connected to the agent yet |

"What can you do with the respondent portal?" lists both groups, each with a sentence that asks for it.

### Conflicts it catches before acting

| Situation | What the card says |
| --- | --- |
| Accounts asked for, portal off | Turning it on becomes the first step, and it says save and publish is still needed |
| Email not set up | Accounts will be created; nobody with an address can be invited yet |
| A setting that needs another | For example: change over time needs scores and earlier attempts |
| A template's fixed rule | For example: the patient-reported outcomes template always keeps projection off |
| Scores asked for, none defined | Nothing would show; where to define one |
| A list that does not exist | Names the lists that do |
| Everyone already has an account | Does nothing, and says so |
| Accounts on the test list | Refused; accounts are for the live list |
| No permission, or the portal's tables missing | Refused with the reason |

## How it is built

- Nothing was rebuilt. The agent calls the existing respondent and portal routes; duplicates, account joining
  and how a credential leaves the system are decided there, exactly as for the screens.
- The sentence is read by fixed rules in the engine (`packages/engine/src/opsIntent.ts`), not by a language
  model. No model is called for any of this, so it costs nothing and sends no respondent data anywhere.
- The same file holds the catalogue of the six phases' functions: what each does, where it is, what it needs,
  and whether the agent does it or guides to it. A test checks every entry's example sentence is understood.
- Sentences about the questionnaire ("add a question about email") are left to the existing reader.
- Sign-in links for people with no email address are shown once on the card and are not kept in the
  conversation.
- Portal settings changed by the agent are ordinary edits to the survey: undoable, saved and published as usual.
- The manual screens are unchanged and remain the alternative. "Open Distribution" on a card goes there.

## What was tested

| What | How | Result |
| --- | --- | --- |
| Reading sentences: the brief's own two sentences, lists, settings, access, questions, guides, and questionnaire sentences left alone | `opsIntent.test.ts`, 10 tests (engine suite: 2,976) | pass |
| Reading columns from contents | `peopleColumns.test.ts`, 7 tests (exporters suite: 164) | pass |
| Settings changes, dependencies, template rules, column answers | `opsCore.test.ts`, 5 tests (Studio suite: 1,331) | pass |
| The agent in a real browser, in the full Studio | `scripts/intelligent-ops-test.mjs`, 21 checks | pass |
| The manual Add people walk, after the reader changed | `scripts/people-intake-test.mjs`, 25 checks | pass |
| Guards, tenancy, row-level security, unused exports | `pnpm audit:code` | 0 problems |

The 21 browser checks use four file shapes: a CSV with headings in nobody's convention, the Excel template, a
tab-separated file with the name split in two and in the wrong order, and a file with two email columns. They
cover the request with no file, preview, confirm, the hand-over link, reusing a list, a missing list, status,
pause and restore, settings, a template's fixed rule, the guides, Open Distribution, and that no model is called.

## What was NOT tested

- **Nothing ran against a database.** The browser run uses the in-memory list that exists only where no
  database is configured, never in production. Checks and decisions are the product's code; storage is not.
- **No email was sent.** The "invitation emailed" outcome was never seen; only "email is not set up".
- **A filled-in Excel workbook with real people.** The Excel path was exercised with the template only.
- **Large files**, and the 2,000-people-per-request path.
- **Voice**, and any language other than English.
- **Permissions in a browser.** A member without the deployment permission gets the server's refusal; that
  message path is written, not exercised.
- In the browser run, routes unrelated to people and the portal were answered with 401 by the test, because
  the development server cannot hold the whole Studio's routes in memory on the build machine. The respondent
  and portal routes were real.
- One earlier run of the browser suite ended with five "Failed to fetch" page errors after every check had
  passed. Two later runs were clean. The cause was not found.

## Known limits

1. **Rules, not a model.** A phrasing the rules do not cover falls through to the general copilot, which does
   not know these operations. The catalogue's example sentences all work; free phrasing will sometimes miss.
2. **"Invitations" means portal invitations.** Emailing personal survey links is guided, not done.
3. **A wrong-looking email address is reported, not refused.** Such a person gets an account with no address
   and a link to hand over.
4. **An ID with an unfamiliar heading is not guessed.** "Personalnummer" stays extra information unless the
   researcher maps it on the Add people screen. There is no question for it on the card.
5. **A person in a new file with an ID is not matched to the same person added earlier by email only.** That is
   the list's existing rule (the ID wins).
6. **Dates, access windows and reopening are not run from a sentence.**
7. **The uploaded file itself is not stored**, as before. What is reused is the list it made.
8. **Privacy requests, messages, individual results and reminders are explained, not operated.**
9. **Pause, lock and the rest cover up to 2,000 people per request.**

## Nothing to apply

No migration. No setting.
