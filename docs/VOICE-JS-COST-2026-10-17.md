# Voice input, respondent speech-to-text, JavaScript intelligence and AI cost (2026-10-17)

Brief: "Priority Development Prompt: AI Branding Voice Input, Respondent Speech-to-Text, JavaScript Intelligence,
and Cost Optimization". Targeted changes on the existing modules; nothing was rebuilt. Cost detail:
`docs/AI-COST-AUDIT-2026-10-17.md`.

## Root causes

| Area | What was there / what was wrong |
|---|---|
| Design with AI | The theme assistant took **one** image and had no microphone. The microphone existed only in Intelligent Mode (MediaRecorder → `/api/ai/transcribe`). The model call is text-only: an image reaches it as a colour description plus a placeholder for its address. |
| Respondent STT | `SpeechInputButton` (browser Web Speech) existed but was **opt-in per question** (`settings.speechInput`) and wired to only two text inputs; Other boxes, form/list fields had none. |
| JS: "When Q3 has option 1 selected, display a popup" | No platform popup existed, so the model hand-built `position:fixed` overlays with their own timers — never closed when the answer changed, sometimes at the far left. |
| JS: the request never reached the model | The engine's no-model parser read "show a small hint popup when …" as **display logic for a question called "a small hint popup"** and refused it ("There is no question …"); the Studio classifier also missed popup/tooltip/modal/hint words, so such requests went without the UX guide. Found by the browser suite. |
| Custom Code × scripts | The Studio migrates `question.customJs` into a script when a survey opens; `set_custom_code` only replaced its own scripts, so on a question with old custom code **both the old and the new code ran**. |
| Cost | No fixed fee: every AI call is priced from reported tokens. But every JS call re-sent ~7,200 tokens of fixed instructions (system prompt 3,699 + UX guide 3,463) at full price with **no provider prompt caching**, and every change regenerated the whole script (2–9k output tokens). |

## What changed

**P1 — Branding → Design with AI** (`BrandingAdvanced.tsx`, new `lib/useVoiceInput.ts` shared with Intelligent Mode,
`lib/copilot/themeReferences.ts`, `themeImageText.ts`, theme-image lines of the copilot route)
- Microphone next to the prompt (aria-pressed/label, keyboard). The transcript is **appended** to what is typed and stays editable; pause/resume where the browser recorder supports it (45 s limit pauses too), otherwise stop and record again.
- Up to 4 references: PNG/JPG/JPEG/WebP, 10 MB each, thumbnail + name + size + colours + remove. Wrong type, oversize, empty, too many and unreadable files each get a readable error; a failed asset upload keeps the image inline.
- **PDF is refused with a clear message**: no PDF renderer in the repo and the model call is text-only. Smallest plan: render page 1 to PNG client-side with pdf.js, then it is an ordinary reference.
- The route accepts `themeImages` (several, each with its own placeholder) besides the old `themeImage`. Review → Apply is unchanged; typed-only prompting is unchanged.

**P2 — respondent speech-to-text** (engine `speechInput.ts`, renderer `SpeechInput.tsx`, `QuestionRenderer.tsx`, `variants/form.tsx`, `variants/list.tsx`, schema `deployment.speechInput`, Properties panel)
- **On by default** on every editable free-text field. Opt-out per question (`settings.speechInput: false`) and per survey (`deployment.speechInput: false`), both in the Studio.
- Covered: single-line text, multi-line text, "Other (specify)" boxes of single/multi select (every layout), grid "Other" rows, text/long-text fields in forms (name, address, contact), numbered text lists, repeating/nested form fields, dynamic list lines.
- Never: numeric, date, time, email, phone, URL, ZIP or masked fields, numeric Other boxes, read-only/hidden questions.
- Not covered: matrix text cells, composite/table and spreadsheet cells (raw inputs in table cells — a button per cell would break column widths and keyboard navigation); rich text (HTML answer).
- Browser-native only: no audio leaves the device. Chrome, Edge, Safari 14.1+ show it; Firefox has no recogniser, so no button and typing as usual. No server fallback (would need consent UI and a runtime transcribe route — plan in limits).
- The transcript goes through the field's normal onChange under the question id, `__other__<code>` or the form row key — no extra keys, validation/required/length unchanged.

**P3 — JavaScript intelligence** (schema `ux.ts`; engine `ux.ts`, `uxActions.ts`, `uxScriptGuard.ts`, `optionActions.ts`, `nlIntent.ts`; renderer `uxPopup.ts`, `UxLayer.tsx`, `uxSandbox.ts`, `uxDom.ts`; Studio `prompt.ts`, `outline.ts`)
- Platform popup: effect `{do:"show_popup", text, title?, placement: center|anchored|top|inline, dismiss?: button|auto|none, autoMs?}` and `hide_popup`. On `select_option` it holds **only while the option is selected** and closes when it is not; closes on page change; one per behaviour. Centred = modal dialog (focus trapped, Escape, close button); anchored sits next to its target; theme colours; 460 px desktop / 90vw phone; reduced motion respected. Scripts get `rs.popup(text, {title, placement, target, dismiss, autoMs})` / `rs.closePopup()`.
- Guide: "CHOOSING THE PATTERN" (declarative behaviour for conditions; centre vs anchored vs inline; scripts only when effects cannot express it; never two mechanisms for one behaviour) and the Q3-option-1 worked example. The outline now lists each behaviour's event, options, placement, `when`, `once`, and long scripts on the named questions as stored.
- Authoring checks (refused in Intelligent Mode, warnings in the editor, runtime gate unchanged): hand-built full-screen overlays ("use show_popup / rs.popup"); `rs.popup` opened from an answer event with no way to close it; a second behaviour for the same target+event+options ("Update <id>"); a centred popup that cannot be dismissed.
- Cheap edits: `update_behavior` takes `edits: [{find, replace}]` (each `find` exactly once), so a small change does not regenerate the script.
- Fixed: `set_custom_code` replaces the migrated legacy script (keeps its id) — the old code no longer runs alongside the new. Verified: `custom_component` code untouched; a declarative behaviour and a script on one event each run once.
- Fixed: popup/message/tooltip/alert requests reach the model with the UX guide (engine `uxLook` recogniser; Studio `uxIntent`); questions are still shown/hidden by the engine.

**P4 — cost and billing** (`packages/ai`, `packages/billing`, `lib/meterRun.ts`, `lib/aiPromptCache.ts`, route call options, admin rate editor, `billingView.ts`, `components/billing/shared.tsx`, migration 0060)
- Provider prompt caching: the fixed guides are sent as a cached prefix (Anthropic native `cache_control`; OpenAI automatic prefix caching read from usage). If the provider refuses the native format the call is resent the old way once. `AI_PROMPT_CACHE=off` disables it.
- Cached tokens priced at the provider's cached rate (Anthropic read 10 % / write 125 % of input; OpenAI 50 %) under the **unchanged margin** — the charge follows the real provider cost; nothing is discounted by fiat.
- Usage records: each charge stores input, cached, cache-written and output tokens and the operation; the usage table now shows "N tokens (in, cached · out)" and names Intelligent Mode operations ("look & behaviour · correction").
- Audited, no duplicates: one hold → one settle per logical call; provider retries report nothing until success; continuations sum into one charge; a failed call is released (not charged); skipped repairs, cached answers and joined in-flight calls are not charged; the $0.001 minimum floor never touches a copilot call and is recorded (`minimumLift`) when it applies. Runtime script execution is never metered.
- Expected (claude-sonnet-4-6): behaviour call $0.1632 → **$0.1185** warm (−27 %); its repair $0.1751 → $0.1304; first call in a 5-minute window +8 % (cache write). Small edits through `edits` cut the output share (≈65 % of a behaviour charge).

## Tests

- Unit: engine 2,000 (popup 13, speechInput 10, nlIntent +1), Studio lib 577 (themeReferences 7, popupGuide 5, aiPromptCache/meterRun cache 10, billingView 1), ai 123 (+12), billing 52 (+8), templates 109, exporters 128, runtime 14. Typechecks clean (schema, engine, renderer, studio, runtime); public docs current.
- Browser (real Studio + live runtime, stand-in model): `popup-p3-test` 14 checks (centred at 1280×800 and 390×844, deselect closes, Next → Back no duplicates, anchored hint, Escape/close, refused overlay, `edits`, completion, no console errors); `theme-voice-test` 8; `speech-input-test`; plus the regression set listed in the commit.

## Deploy

1. Deploy the code (Studio, runtime). No new environment variable; optional `AI_PROMPT_CACHE=off`, `AI_ANTHROPIC_VERSION`.
2. Then apply `supabase/migrations/0060_ai_prompt_cache_rates.sql` (re-runnable). Production's `billing_rates` is empty today (code defaults in use), so it only widens the `side` check; needed before an administrator saves rates.
3. Live check: two behaviour requests within 5 minutes — the second usage row shows ~7,000 cached tokens; no `native_refused` in the logs.

## Limits

- Prompt caching tested with mocks only; verify live (step 3).
- Respondent STT has no server fallback (Firefox: typing only). Plan: a runtime `/api/transcribe` behind an explicit consent prompt and a survey-level switch, reusing the Studio's metered STT.
- PDF references refused (plan above). Matrix/table text cells and rich text have no microphone.
- Duplicate-behaviour check is exact (overlapping option sets not caught); overlay detection is pattern-based; the popup's "Close" label is English only; anchored popups do not follow scrolling inside an inner container.
- Output budget: every request type may use up to 32k tokens with 8 continuations; capping UX/edit/repair calls is a product decision left open (`budget.ts`).
