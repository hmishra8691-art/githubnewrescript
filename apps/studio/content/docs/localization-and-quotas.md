# Localization and quotas

## Languages

```json
"localization": {
  "sourceLanguage": "en",
  "languages": [{ "code": "de", "name": "German", "status": "ready", "enabled": true }, { "code": "fr", "locale": "fr-CA", "status": "draft" }],
  "translations": { "de": { "q:q_age:text": { "text": "Wie alt sind Sie?", "status": "approved" }, "q:q_gender:opt:1": { "text": "Männlich", "status": "ai" } } },
  "glossary": [{ "id": "g1", "source": "Brand A", "doNotTranslate": true }],
  "routing": { "order": ["url", "embedded", "invitation", "rules", "browser", "respondent"], "urlParam": "lang", "embeddedField": "language", "allowSwitch": true, "fallback": "en" },
  "mode": "hybrid"
}
```

A language has a `code`, an optional `locale` (`fr-CA`), a `direction` (`rtl` for Arabic, Hebrew, Persian, Urdu…), a `status` (`draft`, `in_review`, `ready`, `live`) and number, date and time formats. Translations are keyed by element: `meta:title`, `q:<questionId>:text` / `:instruction` / `:description` / `:placeholder`, `q:<id>:opt:<code>`, `q:<id>:row:<code>`, `q:<id>:col:<colId>`, `q:<id>:col:<colId>:opt:<code>`, `q:<id>:scale:<which>`, `q:<id>:validation:<index>`, `q:<id>:probe`, `flow:<nodeId>:title` / `:message`, `quota:<id>:message`, `branding:buttons:<which>`, `ui:<id>` for interface strings. Each entry has a `status` (`not_translated, ai, edited, reviewed, approved, outdated`), an origin, a hash of the source it was made from (a changed source marks it `outdated`) and a history.

**Routing** decides a respondent's language in order: the link (`?lang=de`), an embedded field, the invitation, rules (conditions → language), the browser, the respondent's own switch, then the fallback. A language can be routed to only when `ready` or `live` and complete — the review blocks a live language with missing translations, lost piping tokens or unbalanced HTML.

Intelligent mode: "add French as a language", "add Canadian French", "translate this survey into German" (the model writes; every string goes through the gate and keeps its status `ai` until reviewed), "which questions are untranslated?", "what is missing in German?", "re-translate the outdated German text", "approve the German translations", "remove German". The glossary (`set_glossary`) fixes terms and marks brand names *do not translate*. Spreadsheet round-trips: `localization/export` writes the strings to Excel, `localization/import` reads them back.

## Quotas

```json
"quotas": [{ "id": "q_gender", "name": "Gender", "mode": "hard", "targetTotal": 400,
  "cells": [{ "id": "c_m", "label": "Men", "when": { "type": "rule", "source": { "kind": "question", "ref": "q_gender" }, "operator": "eq", "value": 1 }, "limit": 200 },
            { "id": "c_f", "label": "Women", "when": { "type": "rule", "source": { "kind": "question", "ref": "q_gender" }, "operator": "eq", "value": 2 }, "limit": 200 }],
  "onFull": { "kind": "terminate", "message": "Thank you — we have enough responses in your group." },
  "countStatus": ["complete"] }]
```

A quota has cells, each a condition with a `limit` (a count, or a percent of `targetTotal` with `limitType: "percent"`) and an optional `target`; `mode` is `hard` (stops respondents) or `soft` (flags them); `onFull` is `terminate`, `redirect`, `flag` or `warn`; `countStatus` says whether in-progress responses count. The quota is checked where a `quota_check` flow node stands (`{ "type": "quota_check", "quotaIds": ["q_gender"], "onFull": { "kind": "terminate" } }`) — usually right after the questions it reads — and `quota.q_gender` in any condition is the quota's current count. Test responses are counted apart.

The Quotas tab shows fills against limits and the history; Intelligent mode creates and edits them ("create a quota on gender: 200 men, 200 women", "add a quota cell for the North region, limit 100", "check the gender quota after Q3", "make the age quota soft"), and a quota sheet can be imported (`import/quotas`).

## Embedded data and panels

Embedded fields (`embeddedData[]`, or an `embedded_data` flow node) carry values into the response from the link (`?PANEL_ID=abc&lang=de`), a panel, a static value or an expression, typed as `string, integer, decimal, boolean, date, datetime, url`. They are read as `ed.NAME` in logic and `{{ed.NAME}}` in text, exported as columns, and used by routing (`embeddedField`) and redirects (`{{ed.PANEL_ID}}` in a `redirect` node's URL). Respondent lists (`respondents`) mint individual links, send invitations and record completions per respondent.
