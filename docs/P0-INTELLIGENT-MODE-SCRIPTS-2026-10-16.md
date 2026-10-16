# P0 — Intelligent Mode's JavaScript did not run in the survey (2026-10-16)

## What happened (from the operations log, not assumed)

The request (Hindi, by voice, 2026-10-16 20:04 UTC, survey "CGP Protest & 2029 Elections"):

> मुझे ख्योशन 3 पे **जावस्यूप** लगाना … एज एटिन के ऊपर … येस आप एलिजिबल वोटर हैं … नेक्स बटन डिसीबल रहा है जब तक मैं एटिन या उसके ऊपर टाइप ना करूं

The stored operation: `mode: "question"`, prompt 10,823 characters, one action `set_custom_code` on Q3 with the
59-line script that the bug report quotes. Status: saved. In the live runtime it did nothing: no message for any
value, and a 17-year-old could continue.

The earlier request that worked (2026-10-09, the screenshots) had **"JavaScript" in Latin letters**, was classified
`mode: "ux"`, and the model answered with three declarative behaviours (select option 5 → message, deselect →
hide, page complete → pulse Next).

## Root cause

1. **The request never reached the UX guide.** `classifyRequest` / `uxIntent` (apps/studio/lib/copilot/prompt.ts)
   recognise behaviour requests by English keywords. Speech-to-text wrote "JavaScript" as `जावस्यूप`, so the
   request was a plain "question", and the UX guide (the survey's real page hooks, the sandbox's `rs` api,
   the lifecycle) was not sent. The model knew only that `set_custom_code` takes "a script" and wrote generic
   browser code: SurveyJS / `data-variable` / `name=` selectors, a Next button disabled by the script, an
   `init()` that re-ran itself every 300 ms looking for the input.
2. **The gate let it through.** Guessed selectors were a *warning*; `input[data-variable=…]`, `name=`, `.sd-…`
   were not even recognised. Nothing looked at "disable Next" or the polling loop. The card showed the action as
   a normal change; nothing said the script had never run.
3. **Even with the right selectors the Next part could not work** — and the guide did not say so. Since
   RUNTIME-08 (P2 batch) the sandbox refuses `disabled` / `hidden` on Next / Back (a script that fails half-way
   would strand the respondent), so the button only *looked* disabled (opacity 0.4) and still advanced. The
   guide still listed `disabled` as settable, and had no hook for a question's answer box.

Reproduced in the real runtime (`/tmp/p0/age/repro.mjs`): the field script — no message for "", abc, 17, 18, 25,
1; 17 proceeds. The same script with only its selectors corrected — messages correct, Next greyed but 17
proceeds, console: "a script cannot disable the Next / Back buttons".

## The fix

| Where | Change |
|---|---|
| `packages/engine/src/uxScriptGuard.ts` | `scriptAuthoringProblems(code, def)`: refuses a selector whose every alternative belongs to another tool (SurveyJS `.sd-`/`.sv-`, Qualtrics `#NextButton`/`.QuestionBody`, `[data-role|variable|name|field=…]`, `[aria-label="Next"]`, `[name=…]` that is not a question id, and the existing `.next-button`/`#next`/`.question` guesses) — naming the question's real answer box when the selector names its code or variable (`[data-qid="q3"] input`); disabling / hiding Next or Back (with the fix: `set_validation`); a function that waits for an element by calling itself on a timer. `SCRIPT_CHECKED`: the card's "checked, not run yet — try it in Preview". |
| `packages/engine/src/ux.ts` | `validateUxItem(…, { authoring })`: the authoring checks are **errors** where a script is being written (Intelligent Mode / the theme assistant: `uxActions.gate`, `set_custom_code`) and **warnings** elsewhere. The runtime gate (`validateUxScript`) is unchanged, so no stored script stops running. |
| `packages/engine/src/uxActions.ts`, `optionActions.ts` | authoring mode on; a script action's description ends with `SCRIPT_CHECKED` — generated code is never presented as tested code. |
| `apps/studio/lib/copilot/prompt.ts` | `uxIntent`: Devanagari / Urdu / Arabic words for JavaScript, script, CSS, animation, button, Next, message, disable…; "show a message", "Next disabled until…". A request in another script, or one that stops the respondent, is never look-only (validation stays allowed). UX guide: the answer-box hook, the attributes the survey does NOT carry, never disable Next/Back, no self-polling, and **stopping the respondent is validation** with a worked pair (`set_validation` + a live-feedback script). `repairPrompt()`: when refused look-and-behaviour actions came from a prompt without the guide, the repair request carries it. |
| `apps/studio/app/api/copilot/turn/route.ts` | uses `repairPrompt`; logs `[rescript:copilot] actions refused, asking once more` with the reasons and whether the guide was added; `context.repair.uxGuide`. |

Compatibility: Style Animation Scripts and the retired Custom code are still one pipeline (`set_custom_code` →
a script behaviour); nothing about the sandbox, `rs.listen`, the DOM bridge or the runtime changed. Declarative
behaviours (the screenshots' path) are untouched.

## Verification

- Engine `scriptAuthoring.test.ts` (5): the field script verbatim is refused for each defect with the real hook;
  the same intent on the real hooks is accepted with the checked-not-run note; the runtime gate and the Studio
  editor still only warn (stored scripts keep running); what is *not* refused (a selector list with one real
  hook, enabling Next, own elements, one-off timers, radios by question id); each refusal on its own.
- Studio `copilot.test.ts` (+3): the field request (verbatim) → `ux: true, uxOnly: false`; Hindi/Hinglish/English
  variants; look-only and structural requests unchanged; the guide's worked example passes the engine; the repair
  prompt adds the guide only when it was missing and only for look-and-behaviour actions.
- Browser `scripts/age-script-p0-test.mjs` (10 checks, Studio with the stand-in model + live runtime): the field
  request with the field script as the model's first answer → refused with every reason → the correction
  (validation min 18 + live-message script) offered as "checked, not run yet" → applied → in the runtime:
  empty → no message, cannot continue; letters → refused at the keystroke; 1 → "must be 18", 18 typed digit by
  digit → "eligible"; 17 → message + the survey's validation stops Next; cleared → no message; 18 → continues;
  Back and forward → the script starts once (no duplicate messages), the limit still holds; Next never disabled
  by a script; no script refusals or page errors.

## Known limits

- A model can still write a script that is valid and wrong in its logic; the card says it has not run, and the
  preview inspector shows what the sandbox refused or could not find.
- The Devanagari word list is a hint for choosing the guide. The refusal + guided repair is the safety net when a
  request in any language is missed.
