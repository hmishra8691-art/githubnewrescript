# BYOK 7 — Project-level selection

A project chooses **whose AI it uses**, stored in the existing `surveys.settings.ai.source` (no new column).

| Value | Meaning |
|---|---|
| `"platform"` | Everyone on the project uses the platform's AI (billed to the project's wallet), whatever they set up personally. |
| `"user"` | Everyone uses **their own** provider. Each person's calls go to the provider and key in *their* Settings — never the owner's, never another member's. A member with none set up is told so and no call is made. |
| absent | Each person's own setting decides; with none, the platform. |

## Precedence

project choice → acting user's setting for the feature → platform. A user-managed outcome that cannot be honoured is a refusal, never the platform.

## API

- Create: `POST /api/surveys { …, aiSource }`.
- Read: `GET /api/surveys/{id}/ai-source` (any reader) → `{ source, canChange, youWouldUse }`.
- Change: `PUT /api/surveys/{id}/ai-source` — the **owner** (capability `billing.set_budget`; it decides who pays). Merged server-side into the settings bag. Audit `project.ai_source_changed`.

## Interactions to know

- The **project AI switch** (Internal / feature list) is asked first and applies to everyone regardless of source.
- The **workspace policy** (administrator) can forbid user-managed AI; then `"user"` projects refuse for that workspace's members with that sentence.
- Speech and translation follow the same project choice but use their own feature settings (a chat setting does not make speech user-managed).
- Respondent/interview AI ignores the project's `user` choice and stays platform-managed.

## Not on the settings screen

The per-project choice is set at creation and via the API (and the project's settings where present); the account Settings screen explains it but does not edit it.
