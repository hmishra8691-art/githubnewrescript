# HTTP API

The Studio and the respondent runtime are two applications with their own endpoints. Both answer JSON; errors are `{ "error": "…" }` with the HTTP status (400 for a bad request, 401 for no session, 403 for a missing capability, 409 for a state that refuses the action, 423 for a project that is locked).

## Authentication and authorisation

Studio endpoints are authorised by the **session cookie** (`rescript_session`) a sign-in sets (`POST /api/auth/login`); there are no API keys or webhooks yet. Every request is checked in the handler against the database: who the session belongs to, what role they hold on the project, and — for a write to the questionnaire — whether they hold the project's edit lock. Roles (`owner, editor, programmer, reviewer, viewer, test_user, deployment_manager`) map to capabilities such as `project.read`, `survey.edit`, `survey.save_version`, `responses.read`, `responses.export`, `responses.manage`, `deploy.manage`, `analytics.read`, `analytics.edit`, `analytics.export`, `project.share`, `project.manage_members`, `project.lock_settings`, `billing.read`. The capability each route needs is listed below.

## Studio routes

All under `/api/`. `{id}` is the survey (project) id.

**Projects and the definition**

| Route | Verbs | Needs |
|---|---|---|
| `surveys` | GET, POST | a session |
| `surveys/{id}` | GET, PATCH, DELETE | project.read; the edit lock; project.delete |
| `surveys/{id}/draft` | GET, PUT, DELETE | project.read; the edit lock (the draft definition) |
| `surveys/{id}/versions`, `/versions/{versionId}` | GET, POST | project.read; the edit lock (snapshots, restore) |
| `surveys/{id}/config` | GET, PATCH | project.read; survey.edit (client, manager, fieldwork dates, settings); project.lock_settings (freeze, collaboration) |
| `surveys/{id}/lock` | GET, POST | project.read (acquire, release, request the edit lock) |
| `surveys/{id}/clone`, `/transfer` | POST | project.clone; project.transfer |
| `surveys/{id}/activity`, `/diagnostics` | GET | project.read_activity; project.read |
| `surveys/{id}/themes`, `/glossary`, `/brand-scrape` | GET, POST, PUT, DELETE | project.read; survey.edit |
| `surveys/{id}/tests` | GET, POST | responses.read; survey.edit (the QA regression suite) |
| `surveys/{id}/export/survey` | POST | project.read — `{ "format": "json" \| "docx" }` |

**Collaboration:** `surveys/{id}/collab`, `/comments`, `/members`, `/share` (project.read, comment.create, project.read_members, project.manage_members, project.share).

**Deployment and respondents:** `surveys/{id}/deploy` (deploy.manage), `/publish`, `/qr` (project.read), `/respondents` (responses.read, deploy.manage), `/respondents/send` (deploy.manage), `/respondents/links` (responses.export), `/sample-sources` (responses.read, survey.edit).

**Data**

| Route | Verbs | Needs |
|---|---|---|
| `surveys/{id}/responses` | GET | responses.read — `?format=summary\|csv\|xlsx\|sav\|sas\|dta\|json&include=live\|all&test=1&dataset=all\|clean\|custom:…&values=code\|label\|code_label&quality=1&dictionary=1` |
| `surveys/{id}/data`, `/data/{responseId}` | GET, POST, PATCH, DELETE | responses.read; responses.manage |
| `surveys/{id}/data/import`, `/data/delete` | POST | responses.manage |
| `surveys/{id}/export-presets` | GET, POST, DELETE | responses.read; responses.export |
| `surveys/{id}/export/xlsx` | GET | responses.export (the variable dictionary) |
| `surveys/{id}/fieldwork`, `/listfill` | GET, POST | responses.read; responses.manage |
| `surveys/{id}/quality`, `/quality/{sessionId}`, `/quality/recompute`, `/quality/purge`, `/quality/profiles` | GET, PATCH, POST, DELETE | responses.read; responses.manage; survey.edit |
| `surveys/{id}/quotas`, `/quotas/history`, `/quotas/recount`, `/quotas/audit` | GET, POST | responses.read; project.read; responses.manage; survey.edit |
| `surveys/{id}/analytics/…` | GET, POST, PUT, PATCH, DELETE | analytics.read / analytics.edit / analytics.publish / analytics.export |

**Media:** `surveys/{id}/media` and `/media/{mediaId}`, the upload flow `/media/ticket` → `/media/parts` → `/media/confirm`, `/media/import`, `/media/remove`, `/media/lookup`, `/media/transcript`, `/media/deliveries` (project.read; the edit lock; responses.manage), `media/{path}` (project.read).

**Intelligent mode**

| Route | Verbs | Needs | What |
|---|---|---|---|
| `copilot/turn` | POST | a session | a sentence read by the model: `{ surveyId, message, definition, selectedId?, memory?, mode?: "review" \| "generate", stage?: "plan" \| "execute", plan?, items?, planFirst? }` → the reply, actions, coverage, cost |
| `copilot/ask` | POST | analytics.read | a data question on the responses |
| `copilot/output` | POST | project.read (proposal); analytics.export (findings) | `{ surveyId, output: { type: "proposal_docx" \| "findings_docx" \| "findings_pptx", audience, client? } }` → the file |
| `copilot/workflow` | POST | project.read; survey.edit for `setMode` | `{ surveyId, objective?, produced?, mode?, setMode? }` → the workflow, the execution mode, the model, the cost per model step |
| `copilot/operations`, `copilot/record` | GET, POST, PATCH | project.read; survey.edit; the edit lock | the operation history |
| `copilot/documents` | GET, POST, DELETE | a session | research documents uploaded for retrieval |

**AI and translation:** `ai/logic`, `ai/rephrase`, `ai/transcribe`, `ai/tts`, `import/custom-logic` (metered AI calls), `ai/translate`, `translation/languages`, `translation/memory`, `translation/status`, `localization/export`, `localization/import`. **Import:** `import/analyze` (a questionnaire document → a definition), `import/quotas`, `import/record`. **Billing:** `billing/me`, `billing/projects`, `billing/transfer`, `surveys/{id}/billing`. **Auth and account:** `auth/login`, `auth/signup`, `auth/password`, `auth/logout`, `auth/me`, `auth/heartbeat`, `sessions`, `profile`, `notifications`.

## The respondent runtime

The runtime serves the survey at `/s/{client}/{study}` (live) and `/t/{client}/{study}` (test). Its API is authorised by the response's unguessable session id, minted at start:

| Route | Verbs | What |
|---|---|---|
| `api/session/start` | POST | mint or resume a response; returns the session id and the frozen definition version |
| `api/session/save` | POST | persist progress (answers, position, embedded data) |
| `api/session/listfill` | POST | the server-side List Fill allocation |
| `api/session/ai` | POST | resolve `ai_classify` / `ai_sentiment` for a calculated question |
| `api/session/probe` | POST | the wording of an AI follow-up probe |
| `api/session/build-stamp` | GET | has the definition changed since the session started |
| `api/session/media/ticket`, `/parts`, `/confirm`, `/transcript` | POST, GET | media capture: permission, parts, confirmation, transcript |
| `api/runtime-definition/{versionId}` | GET | the cacheable frozen definition |
| `api/geocode` | POST | `{ sessionId, questionId, q }` for a location question |

## Examples

```bash
# the live, clean responses as SPSS, with value labels
curl -b "rescript_session=…" "https://studio.example/api/surveys/$ID/responses?format=sav&dataset=clean&values=label" -o responses.sav

# the definition as JSON
curl -b "rescript_session=…" -X POST "https://studio.example/api/surveys/$ID/export/survey" -H "content-type: application/json" -d '{"format":"json"}'

# a sentence through the engine and, if needed, the model
curl -b "rescript_session=…" -X POST "https://studio.example/api/copilot/turn" -H "content-type: application/json" \
  -d '{"surveyId":"'$ID'","message":"make Q5 required","definition":{…}}'
```
