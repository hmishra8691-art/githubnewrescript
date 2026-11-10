---
summary: The AI interviewer — run the same survey as a text or voice conversation (standard, conversational or adaptive), with guardrails, adaptive follow-up probes, voice, reading and pause settings, and per-question overrides
related: branding-overview, respondent-experience, open-ended, translation
status: available
---
# The AI interviewer

The **AI interviewer** presents the programmed survey as a conversation. It is **not a question type** and never changes what the survey asks: display and skip logic, masking, validation, quotas, loops and piping stay in charge, and the interviewer cannot show a hidden question, accept an invalid answer or store anything a question could not take. It is set under **Branding → AI interviewer** and stored in `branding.aiConversation`, so a client's interviewer travels with their brand.

Three choices define it:

| Setting | Values | What it means |
|---|---|---|
| **Interaction** | text, voice, text + voice | How respondents answer — typing, speaking, or either |
| **Conversation** | standard, **conversational**, adaptive | Standard: pages as usual. Conversational: one question at a time, with the answers so far above it as a transcript. Adaptive: conversational, plus follow-up probes |
| **On / off** | — | Off is the survey exactly as it is without an interviewer |

**Adaptive follow-up** asks probes after an answer — by default on open ends — between a minimum and a maximum number per question, within a maximum depth, in a probe style (neutral, warm or professional). Probes are written by a language model on a live link and are held to guardrails: stay within the research objective, allowed and restricted topics, and the interviewer rules (avoid leading, suggestive, approving or persuasive wording). Rules can limit probing to answers that meet a condition.

**Voice** settings (with interaction voice or text + voice): the voice profile (gender, age style, personality — a style, never an imitation of a real person), language and accent (or detected from the respondent), speaking rate, pitch and volume, pauses, what is read aloud (question, options, instructions, errors; how many options; how grids are read), and how spoken answers are taken (navigation commands, repeat, clarification below a confidence threshold, captions, whether the transcript is stored). Each question can override the survey's settings, and can have its own spoken version.

## When to use it

- Mobile and younger audiences, for whom a chat feels more natural than a form.
- Richer open ends: adaptive probes ask "why?" the way an interviewer would.
- Accessibility and low-literacy audiences: questions read aloud, answers spoken.

## Set it up in the builder

::: steps A conversational survey
1. **Open Branding → AI interviewer**.
2. **Switch it on** — "AI conversational survey on".
3. **Interaction mode → Text** (or Voice, or both).
4. **Conversation behavior → Conversational** — or Adaptive for follow-up probes.
5. **Advanced** — voice, reading, guardrails; then preview on a phone.
:::

::: example ai-conversational

## How it is stored

```json
{ "branding": { "aiConversation": { "enabled": true, "interaction": "text", "conversation": "conversational",
  "adaptive": { "enabled": false, "maxFollowUps": 2, "probeStyle": "neutral", "applyTo": "open_ends" },
  "interviewer": { "avoidLeading": true, "avoidSuggestive": true, "avoidApproval": true, "avoidPersuasive": true } } } }
```

::: note
The live example shows the **conversational** presentation, which needs no language model. Follow-up probes (adaptive) and the voice are not run in these docs: they call a language model and speech services on a live link.
:::

## Common mistakes

- **Expecting the interviewer to change the questionnaire** — it presents the survey; logic, validation and data stay as programmed.
- **Adaptive probing on closed questions** — probes are for open ends by default; probing every answer lengthens the interview.

## Troubleshooting

- *The survey still shows whole pages* — the interviewer is off, or the conversation behavior is standard.
- *No microphone* — voice needs interaction voice or text + voice, and a browser that allows the microphone.
