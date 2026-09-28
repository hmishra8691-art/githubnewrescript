# Intelligent mode — the AI Research + Survey Programming Copilot

*Built 2026-09-28.* The brief: "Upgrade Intelligent Mode into an AI Survey
Research & Programming Copilot" (18 sections).

## What it is

With a language model configured (`AI_API_URL`, the existing integration),
what a researcher types or says in Intelligent mode goes to the copilot. It
reasons about the research — objective, hypotheses, population, independent /
dependent / mediating / control variables, method, analysis — and programs the
survey through a **controlled action layer** in the engine. It never writes the
survey itself. Every proposal is previewed in full and applied, if the
researcher approves, as **one undoable edit** recorded in the AI change history.

```
researcher (typed / spoken, any language)
   │
   ▼  /api/copilot/turn ─────────────────────────────────────────────────────┐
   │  classifyRequest            generate / edit / review / question;       │
   │                             does it need the research at all?          │
   │  copilotOutline             the survey, compactly; the questions the   │
   │                             request names in full (logic, skips, rows) │
   │  research store             cards + the few BM25 (+ embeddings)        │
   │                             passages it needs — only when it needs them│
   │  memory                     the model's own running memory + 3 turns   │
   │  reviewSurvey (review)      the engine's facts, so the model adds      │
   │                             meaning, not a second copy                 │
   │  model (metered, cached)    ONE JSON reply                             │
   │  coerceCopilotReply         the gate                                   │
   │  applySurveyActions         every action on a CLONE: refs resolved,    │
   │                             conditions parsed, refused with reasons,   │
   │                             destructive flagged, schema + quality check│
   └─────────────────────────────────────────────────────────────────────────┘
   ▼
browser: proposal = base survey + action batches (revisable before applying)
   │  evaluateProposal → the Changes panel: summary, destructive (confirm),
   │  refused, new problems, before/after structure, field-by-field changes
   ▼
Apply → store.replace (one labelled undoable edit) → AI Change #00N
      → the ordinary save path (validates again) → /api/copilot/record (audit)
```

## The pieces

| Where | What |
|---|---|
| `packages/engine/src/surveyActions.ts` | The action vocabulary (`create_block`, `create_question`, `update_question`, `delete_question`, `move_question`, `set_display_logic`, `add_skip`, `clear_skips`, `set_validation`, `page_break`, `create_embedded`, `create_calculation`, `create_randomizer`, `create_branch`, `create_loop`, `create_quota`, `rename_block`, `delete_block`, `set_research`), the gate (`coerceSurveyActions`), `applySurveyActions`, `diffSurveys`, `renumberNewQuestions`. |
| `packages/engine/src/questionCreate.ts` | `createQuestionFromVariant` — the picker's maker, moved to the engine; the picker now delegates to it. A copilot question is the same object a programmer adds by hand. |
| `packages/engine/src/surveyReview.ts` | `reviewSurvey`: critical / warning / suggestion from the definition alone (quality errors, never-shown questions via `diagnoseQuestion`, unmeasured hypothesis constructs, leading wording, overlapping / gapped ranges, mixed scales, near-duplicates, length, double-barreled, missing None/Other, required open ends, no screening, demographics first). Mechanical fixes are offered as actions. |
| `packages/schema` | `SurveyDefinition.research` (objective, hypotheses, population, method, constructs with roles and the questions measuring them, analysis, assumptions, sources). |
| `packages/import/src/research.ts` | Research documents: extraction (PDF text by page with visual lines joined, Word with headings and tables, Excel/CSV tables, text with form-feed pages), scanned-page images for OCR, chunking (~1,200 chars, page + heading), `ResearchIndex` (BM25, blended with cosine when embeddings exist). |
| `packages/ai` | `ocrImage` (OpenAI-compatible vision message; `AI_VISION_MODEL`, else the chat model), `embedTexts` (only with `AI_EMBEDDINGS_MODEL`). |
| `supabase/migrations/0045_copilot_research.sql` | `copilot_documents` (with the per-document summary card) and `copilot_chunks`. Until applied, documents are kept in server memory and the Research panel says so. |
| `apps/studio/lib/copilot/` | `prompt.ts` (system prompt with the schema and action language, reply gate, request classification), `outline.ts`, `research.ts` (summary prompt/gate, cards, passages), `client.ts` (proposal chains, change records, memory, links, before/after rows), `store.ts` (server). |
| `apps/studio/app/api/copilot/` | `turn`, `documents` (POST / GET / DELETE), `record` (audit `survey.ai_changed`). |
| `apps/studio/components/intelligent/copilot/` | `useCopilot`, `CopilotCard`, `CopilotPanel` (Changes · Review · Research · History · Inspector), `StructurePane`. |

## Provider configuration

| Variable | What |
|---|---|
| `AI_API_URL` | the OpenAI-compatible base, e.g. `https://api.anthropic.com/v1/` or `https://api.openai.com/v1` |
| `AI_API_KEY` | the key (server only) |
| `AI_MODEL` | the chat model the copilot reasons with (use one your provider serves — the default `gpt-4o-mini` is OpenAI's) |
| `AI_WORKSPACE_ID` | sent as `anthropic-workspace-id` on every request. Needed when an Anthropic key is **not scoped to a workspace** — the provider refuses with “must include the anthropic-workspace-id header”. Alternatively, create the key inside a workspace and leave this unset. |
| `AI_API_HEADERS` | any other headers the provider needs, as JSON (`{"OpenAI-Organization":"org_…"}`); it cannot override the key or the body type |
| `AI_VISION_MODEL` | OCR of scanned PDF pages (defaults to `AI_MODEL`) |
| `AI_EMBEDDINGS_MODEL` | optional semantic retrieval (BM25 alone without it) |

## Decisions

- **Reasoning is separated from execution.** The model's output is data in a
  closed vocabulary; the engine executes it on a clone, and only the
  researcher's Apply writes. There is no action to publish, deploy, change
  live settings or touch responses.
- **Proposals are chains.** "Reduce this to 20 questions" while a proposal is
  open revises it: the next batch is written against the *proposed* survey,
  the earlier card is marked superseded, and Apply is one edit. If the survey
  changed underneath, the chain is replayed onto it (actions name objects by
  code and ref) and the researcher is asked to review again.
- **Refs become variables.** A new question's `ref` (AGE, BUY_6M, TRUST_1) is
  its variable name, so the model's conditions, calculations and piping in
  the same batch work natively; if the name is taken, refs in expressions and
  piping are rewritten to the new question's code.
- **Codes read in order.** Questions a proposal creates are renumbered in flow
  order after each step (existing questions never are), so a revised proposal
  does not leave gaps and replays reach the same codes the model was shown.
- **Destructive is named, then confirmed.** Deleting, replacing logic,
  changing a type, replacing options or rows, renaming a variable — each is
  listed in red with what it touches (a deletion also says which questions it
  would strand), and Apply waits for a checkbox. On a live survey, a stronger
  warning.
- **Context is the minimum.** The outline is bounded (first 60 questions in
  full on a large survey, the named ones always), research goes only to
  research requests, whole documents are never re-sent (each is summarised
  once at upload, from its most informative ~20,000 characters), memory is
  the model's own ≤600-character summary plus three exchanges, and an
  identical request within 15 minutes is answered from a cache.
- **Honest citations.** The model marks claims *document*, *recommendation* or
  *assumption*; a citation to a passage that does not exist is dropped and
  the claim is downgraded to a recommendation.
- **The grammar stays.** Exact read-only questions ("what depends on Q3?",
  "why is Q20 not showing?") are answered by the engine; with no model
  configured, or when the model's answer is unusable, the deterministic
  grammar planner runs as before.
- **Metering.** Every model call — turns, document summaries, OCR pages,
  embeddings — is an `AI_REQUEST` through `meteredAi`; a refusing wallet
  stops the work and says why. The cost of each turn is shown on its card.

## Tests

- engine `surveyActions.test.ts` (9), `surveyReview.test.ts` (5) — mutation
  checked (the survivors were closed with tests; one guard is equivalent).
- import `research.test.ts` (3, mutation checked).
- studio `lib/copilot/copilot.test.ts` (9).
- browser `scripts/copilot-test.mjs` (11): workspace; hypothesis → understanding,
  plan, counts, Changes panel, nothing written; revise before applying;
  apply → real objects, one undo; conversational edit with a destructive
  scale change, before/after, clickable references, Undo AI change; refused
  actions; review (engine + model, fixes as proposals); research upload,
  scanned-page OCR, retrieval and citations, no documents for a plain edit;
  grammar fallback and exact read-only answers; Hinglish voice; route guards.
  The fake provider cannot reason, so the suite supplies the model's reply
  through `window.__rescriptCopilotFake` (honoured only with the fake).

## Not done

- A model is required for the copilot's reasoning; without one the mode is
  the grammar and the engine's review.
- OCR reads JPEG/JPEG 2000 page scans (the common case); CCITT or raw bitmap
  scans are reported, not read.
- The AI change history lives in the page session (the changes themselves are
  in the survey's versions and the audit log); it is not yet reloaded from
  the audit log in a later session.
- Deleting a question keeps the engine's existing reference pruning — which
  removes a branch arm that read the question, with its contents; the copilot
  says so before applying, but does not yet offer to keep those questions.
