# The projects page as a control centre — wallet meters, refill, clone

*On top of `70c5f79`. Engine 924 tests (+9), billing 25 (+8), access 77 (+2); new suite `scripts/project-meter-test.mjs`; guard audit 128/128.*

Three additions to the page that lists every project, all of them on the card itself: what the project's wallet holds, a way to put credits into it, and a way to copy the whole study. Nothing was taken off the card to make room — the question, response and completion counts, the status pill, the client and due chips, the collaborators and every existing action are where they were.

## 1. The meter, and why it is one function

Each card now carries four figures — **Wallet** (what has been put in), **Used**, **Remaining**, **Meter used** — a bar coloured by level, and a word: *Healthy · Low balance · Critical · Read-only*. The point is that a researcher should be able to see which project is about to stop **without opening any of them**.

**Every number is a customer charge.** Provider cost, infrastructure, fees, tax reserve and margin are not read, not summed and not sent: `ProjectMeter` has no field to put them in, and the payload still passes through `stripInternalCosts`. Administrators keep their view where they had it.

**`projectMeter(wallet, usage, config)`** lives in `packages/billing/src/wallet.ts`, beside `summarizeWallet`, because the dashboard must not do its own arithmetic. A balance that reads $56.75 on the list and something else inside the project is one system telling a person two different things, and they have no way to know which is true. A test computes both from one wallet and one set of recorded events and compares them field by field.

**Two queries for the whole page, whatever its length.** `apps/studio/lib/projectMeters.ts` reads every wallet in the workspace and every usage event once and groups them in memory; `GET /api/billing/projects` answers the page in a single request. The obvious implementation — ask each project for its own meter — is a round trip per card, eighty queries on a dashboard of forty projects for a number that is a sum. `projectMeterView` is still the answer for one project opened on its own, where the ledger, forecast and timeline it also loads are actually shown.

Billing is optional on an installation, so this is a separate request from the survey list: if it fails, or migration 0023 is absent, the cards render exactly as they did before — without meters, not with broken ones. A project that has no wallet yet shows no meter rather than a misleading `$0.00`.

**Filters and sorts** follow the same idea: *Healthy / Low balance / Critical / Exhausted* alongside the existing filters, and *Lowest balance · Highest balance · Most used · Least used* alongside the existing sorts. A project with no wallet sorts last in all four — putting "unknown" at the top of "lowest balance" would bury the project that is actually about to stop.

The level vocabulary is now shared by the card, the project's Usage tab and Billing Administration (`LEVEL_WORD`). One wallet, one set of words.

## 2. Refill — which never creates credits

**Refill wallet** on the card opens a dialog with quick amounts, a custom amount and a note. It has two modes, and they are different acts:

- **From my credits** — a transfer, through the existing atomic SQL function: one `credit_transfers` row and two ledger lines under one transfer id. The person's balance falls by exactly what the project's rises by, and only the *available* balance may move — what a reservation holds for an operation in flight is not theirs to give away. The screen shows the same number the server will check, so a refusal is never a surprise.
- **Assign credits** — a platform administrator issuing new credits, which is how credits enter the system at all while the platform is in simulation mode. It is labelled as what it is and offered to nobody else.

There is no third path. Nothing in this feature writes a balance directly; the balance is what the ledger says.

**A refilled project comes back on its own.** The credit lands, `rescript_billing_credit` recomputes the wallet's state from its new balance, and READ_ONLY clears in the same transaction. Nobody goes and flips a status.

## 3. Clone — ids change, codes do not

**`cloneSurveyDefinition`** (`packages/engine/src/cloneProject.ts`) copies a project's programming into a new project. The rule is one line:

> **Ids change. Codes and names do not.**

Everything in a definition is named twice. An **id** (`q_k3f8`, `page_2`, `quota_a1`) is private to the project and means nothing outside it — two projects sharing one is the copy quietly reading the original's questions. A **code** (`Q5`, option `3`, row `A`, `BRAND_AWARE`) is the platform's join key: answers, export columns, quota counters and the variable dictionary are keyed by it. So every id is minted fresh and every code is kept, which is also why a cloned `Q5` is still `Q5` in the export, and why the thousand references written as codes — every piping token, every calculation, every masking expression — keep working untouched.

**References are rewritten by id, not by enumeration.** A definition refers to ids from some sixty places, and that list grows with every feature; a clone that knows fifty-nine of them produces a survey that works until somebody opens the sixtieth. So the direction is inverted: this file knows only where ids are *declared* — one per question, option, row, column, validation rule, flow node, branch, quota, cell, list fill, named expression, design, script, option group, audio asset — which the schema itself dictates. Then every string in the document that equals an old id becomes the new one, wherever it lives and whatever the field is called. A reference nobody remembered is rewritten anyway.

Two things are not plain ids and are handled explicitly: **translation keys** (`q:<qid>:opt:<code>`, `flow:<id>:title`, `quota:<id>:message`) and audio `elementKey`s, which embed an id inside a colon-joined string and are object *keys*; a key left behind detaches every translated word from its question, silently, because a missing translation falls back to the source language and simply looks untranslated. And `meta`, which is restamped, along with `deployment.studySlug` — a slug is a public address, and two projects answering on one is the original's respondents landing in the copy.

**The proof is part of the function.** After the rewrite the clone is serialised and searched for every original id. `stowaways` must be empty; if it is not, the API deletes the half-made project and refuses, because a survey whose logic silently reads another project's questions is worse than no survey.

### What a clone does not take

Responses (live or test), respondents, deployments, test runs, comments, the activity log, collaborators, and the wallet — **the copy starts with no wallet at all**, which is a zero balance until somebody refills it. Duplicating a balance would be creating credits, and credits are only ever created by an administrator assigning them. The dialog says both of these in the words above rather than leaving them to be discovered.

The dialog lists what *is* copied and offers no checkboxes over it. A definition is one interlocking document: the logic refers to the questions, the quotas read the answers, the translations are keyed to elements that must exist. "Copy the questions but not the logic" does not describe a smaller survey — it describes a broken one, and a dialog that offers the choice is promising something it cannot deliver.

### Permission and record

New capability **`project.clone`**, granted to owner, editor and programmer. It is read-shaped in what it discloses — whoever can clone could already open every question — but a creation act in what it does, and a reviewer being able to read a study is not a reason for them to be able to put another project in the workspace's list.

Two audit records, deliberately: `project.cloned` against the original (who copied it, when, into what) and `project.created` against the copy, so the new project's own history starts the way every project's does. Reading either one alone still leaves a true statement.

`POST /api/surveys/:id/clone` follows the same three writes as creating any project — survey row, version row, `current_version_id` — and gives the copy a free code (`ORIG_COPY`, then `ORIG_COPY2`) rather than refusing over a name collision.

## Tests

| where | what |
|---|---|
| `packages/engine/src/cloneProject.test.ts` | a deliberately awkward survey — matrix addressed by row and scale point, display/skip logic, a named expression, a quota reading an answer, carry-forward, piping, Other-specify, randomization, translations, audio — cloned: no id shared with the original; codes, variable names and expressions unchanged; every id reference following its entity; translation keys rewritten while the option codes inside them are not; the clone compiles and runs; a slug is never shared; cloning the clone accumulates nothing |
| `packages/billing/src/billing.test.ts` | the brief's meter cases: $100/$35 reads $65 and 35%; the bands follow the administrator's thresholds and move when they do; an exhausted project reads 100% and read-only; an unfunded wallet reads 0% and not NaN; reserved money is neither spent nor available; the card agrees with the Usage panel field by field; a refill reactivates a stopped project without anyone touching its status; a transfer takes exactly what it gives and a refused one moves nothing |
| `packages/access/src/access.test.ts` | who may clone, and that a clone is recorded against both projects |
| `scripts/project-meter-test.mjs` | four projects in four states on the real page: the meter's figures, bar and word; the balance filter and the wallet sorts; a refill moving credits from the person's own wallet and bringing a read-only project back; a clone from the card with the dialog stating what travels and what does not; and a 390px pass with no sideways scroll and every action reachable from the overflow menu |

`scripts/billing-test.mjs` asserted the old level word "Normal"; it now pins "Healthy", the word every screen uses.
