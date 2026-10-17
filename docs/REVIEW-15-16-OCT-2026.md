# Review documents 15/10/2026 and 16/10/2026 — consolidated issue list and resolution (2026-10-17)

Detail per area:

- Flow and Embedded Data: `docs/FLOW-EMBEDDED-DATA-2026-10-17.md`
- Smart operators and Contains on lists: `docs/SMART-OPERATORS-2026-10-17.md`
- Collaborators and access management: `docs/COLLABORATORS-ACCESS-2026-10-17.md`

Shared helper: `packages/engine/src/listValue.ts`. It splits lists, detects value types (`02108` stays text) and does whole-item `listContainsItem`.

Status words:

- **Implemented + tested**: unit and browser suites pass.
- **Implemented, unit-tested**: no browser suite.
- **Not done**: the reason is given.

## Document 15/10/2026 — Survey Flow

| # | Item | Root cause | Status |
|---|---|---|---|
| 1 | `{{ed.X}}` in a Fixed value stored as literal text | `applyEmbeddedField` only coerced a Fixed value to its type; it never resolved tokens | **Implemented + tested.** Resolved by the existing piping resolver where the element runs (live, test, preview). Chained fields work. Missing references follow `emptyEmbedded` (zero / error / skip), with the Default value first. Builder warnings appear in Survey Flow and now also in the survey's logic check. Also fixed: `{{ed.RESPONSE_ID}}` / `{{ed.SURVEY_CODE}}` were offered but never set, and quota-full redirect URLs were not resolved |
| 2 | Value box too wide | A full-width single-line input | **Implemented + tested.** Starts compact, grows to the card width, then wraps and grows down. The "stored as" preview is shortened, with "show all" |
| 3–4 | Insert Piped Text, 10 categories | Missing | **Implemented + tested.** A searchable menu, two or three levels deep, inserting at the cursor. See the category list below |
| 5 | Piped text in other flow fields | — | **Implemented + tested** for Embedded Data values, calculation fields (Calc DSL syntax, numeric only), Block/Group titles, quota and end redirect URLs, end message, and branch/condition values (in the condition builder). **Not added** to Loop & Merge item/field values (used verbatim by loop logic and exports, so piping would make text and logic disagree) or to Randomizer/Branch names (never shown to respondents) |
| 6 | Test / Preview Value | Missing | **Implemented + tested.** A panel labelled "sample test data" shows the expression, the resolved value and the stored type, and warns `Embedded Data field "FirstName" was not found.` It runs the runtime's own code |
| 7 | Add Element as a button grid | A vertical scrolling list with search | **Implemented + tested.** All 9 elements as icon buttons, 3 per row (2 on narrow screens), equal sizes (`grid-auto-rows: 1fr`), tooltips, keyboard support. Inserts at the position and closes. The search was removed because every element is visible |
| 8 | Automatic data type; ZIP list under Integer said "is not a number" | The type was mandatory; a list cannot be one integer | **Implemented + tested.** New `auto` and `list` types, added without changing existing ones. New fields default to Auto ("Auto (detected: List of 4 items)"), and every explicit type remains as an override. `02108` stays text. A list under Integer explains itself and suggests Auto/List. Existing fields keep their type and behaviour. Intelligent Mode may also create `auto`/`list` fields |
| 9 | Contains on a comma-separated Embedded Data list, in Branch logic | Substring `contains` on text, so 10001 matched 110001, and a list needle or different spacing failed. An Integer-typed list was stored as null, so every condition on it was false | **Implemented + tested.** New operators: Contains item, Does not contain item, Contains all items, Contains exactly. They match whole items, trim spaces, ignore case, keep leading zeros, and a list needle matches if any item does. On `list`/auto-list fields, `contains` matches items. On String and untyped fields it stays substring, so existing surveys are unchanged (snapshots: 63,936 operator evaluations and 942 template conditions, identical). The comparison value may be a piped `{{Q1.ZIP}}` |

**Insert Piped Text categories**

- **Available:**
  - Survey Question, with data choices by question type.
  - Embedded Data, with types and search.
  - Quota: counts, limit, remaining, % filled, status.
  - Survey Metadata.
  - Device.
  - Loop & Merge, inside a loop.
  - Date/Time, with date and time formats.
  - Distribution: channel and link type.
  - Random values: integer, decimal, from list, ID, boolean, UUID. They persist once per respondent by default, or per session, per loop, or every time.
- **Shown disabled, with the reason:**
  - Loop & Merge outside a loop.
  - Distribution contact fields: there is no contact model.
  - IP-based approximate location: none exists.
  - Precise location without a geo question. Nothing is fabricated.

## Document 16/10/2026

| # | Item | Status |
|---|---|---|
| 1 | Collaborators entry points: project ⋯ menu and Overview button | **Implemented + tested (UI).** The card's ⋯ menu has "Collaborators…", and the Overview has avatars, "+N" and "+ Invite" next to Open programming. Both open the existing panel; there is no second copy |
| 2 | Panel: invite, role, existing collaborators, pending invites (resend/cancel) | **Implemented + tested (UI)** on top of the existing lookup-first invite flow |
| 3 | Roles | **Implemented, unit- and SQL-tested.** Project Admin, View Only with Data, Vendor, Interview Only and Custom are new roles. Full Access = editor, Edit Access = programmer (because `editor` already deploys and manages data), View Only = viewer, No Access = remove. The owner stays non-grantable. Every existing role's capabilities are unchanged (snapshot) |
| 4–6 | Custom permissions: None/View/Edit/Manage per module; advanced permissions; Manage ≠ admin; reports ≠ raw data/PII | **Implemented, unit- and SQL-tested, enforced server-side.** Data: None → 403 on data and export routes; programming View → 403 on save and edit lock; expired access → 403 `access_expired`. Uses the platform's real modules. **Not offered:** Campaign Manager and Offline Surveys (the product has neither). Programming is not split into questions / logic / flow / quotas, because the survey saves as one document through one route, so separate rights could not be enforced |
| 7–9 | Expandable permission cards, search, presets, expiry, permission preview, activity history, copy permissions | **Implemented + tested (UI); expiry and history enforced and recorded server-side** |
| 10 | Smart, type-aware operators across all logic features | **Implemented + tested.** `smartOperators.ts` builds a grouped menu with a default per type, filtered by the linter's own validity rules. Every condition surface uses `ConditionBuilder`, and a guard test fails if any other component builds its own operator list. The comparison field adapts to the operator. Row, field and MaxDiff-task pickers appear where needed. The dropdown has search, each rule gets a plain-language summary, and a "Test condition" panel runs the real evaluator. When a source changes type, the rule is marked "needs update" and blocks deploy; it is never silently replaced |
| 10 (partial) | Operators not offered | "All rows equal" as one click (it can be built with the count toggle). Constant-sum Total (`SUM()` reads an allocation answer as 0 — a calc defect to fix separately). File count, type and size (the metadata is stored but no condition can read it). Image buckets and pairwise operators follow the question types that exist. SPSS-syntax export of the four new list operators |

## Verification

- **Unit tests:** engine 2,094, access 123, Studio lib 600, runtime lib 20, templates 110, designs 99, analytics 499, exporters 135, ai 123, billing 52, quality 61. All pass.
- **Checks:** typechecks (Studio, runtime, renderer) clean; public docs current; dependency boundaries 0 violations.
- **Backward-compatibility snapshots:** operators (63,936 evaluations), template conditions (942), existing role capabilities.
- **Browser** (new and regression): see the commit message for the final list.
- **SQL:** all migrations through 0062 apply twice on a scratch Postgres 16; `scripts/collaborators-access-sql-test.sql` passes.

## Deploy

1. Apply migration **0062** (`0062_project_access_permissions.sql`) BEFORE the code. Old code runs on the new schema; new code without 0062 cannot store custom access, expiry or the new roles.
2. Apply **0061** if not yet done.
3. Deploy the code.
