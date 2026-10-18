/**
 * THE MODERATED-STUDY GUIDE (2026-10-18) — how Intelligent Mode writes and edits the guide of a
 * moderated interview (IDI) or focus-group study: `def.qualStudy`, through `create_qual_guide` and
 * the patch-only `update_qual_guide` (engine `qualActions.ts`). It rides at the end of the
 * qualitative guide (`COPILOT_QUAL_GUIDE`), so it is sent with the same requests and cached the
 * same way; prompt wiring is unchanged. Every `{"op":…}` line is applied by the engine as written
 * (`researchGuide.test.ts`, `qualStudyGuide.test.ts`).
 *
 * What it must never let the model claim: that Rescript runs the session. It plans it and records
 * what happened (sessions, recordings, transcripts, AI-assisted coding in Research Tools →
 * Qualitative); there is no conferencing and no real-time moderation.
 */
export const COPILOT_QUAL_STUDY_GUIDE = `MODERATED INTERVIEWS AND FOCUS GROUPS — Rescript PLANS them (a guide for a human moderator) and RECORDS them afterwards (session records, uploaded recordings, transcripts, AI-assisted coding in Research Tools → Qualitative). It does NOT run live sessions: no video conferencing, no real-time moderation — say so if asked. The guide is written by:
• create_qual_guide — kind "interview" (IDIs) or "focus_group"; title, objectives, protocol, durationMinutes, screening (include / "Exclude: …"), consent {statement, recordingDisclosure, dataUse}, segments [{name, target}], sessionPlan {sessions, participantsPerSession, mode}, groundRules (focus groups), and sections IN ORDER: opening (script: welcome, purpose, consent and recording reminder) → warm-up → one topic per objective (questions broad → specific, neutral, one idea each; probes; conditionalProbes [{ifMentions, ask}]; moderator instructions) → exercise / concept (stimuli) → closing. Time every section; the minutes add up to the duration.
• update_qual_guide — a PATCH: name only what changes. sections [{target: id or title, addQuestions, updateQuestions [{target, addProbes, conditionalProbes}], removeQuestions, minutes, script, addInstructions}], addSections [{title, kind, after}], removeSections, addObjectives, addGroundRules, consent {…}. Never re-send the whole guide to change one thing; "replace": true on create only when asked to start again.
{"op":"create_qual_guide","kind":"interview","title":"Why customers switch broadband","durationMinutes":45,"objectives":["Understand what triggers switching"],"consent":{"recordingDisclosure":"The interview is recorded (audio) for the research team only."},"sections":[{"title":"Introduction","kind":"opening","minutes":5,"script":"Thank you for joining. There are no right or wrong answers. May I record?"},{"title":"Switching triggers","minutes":30,"questions":[{"text":"Tell me about the last time you thought about changing provider.","probes":["What happened next?"],"conditionalProbes":[{"ifMentions":"price","ask":"What would a fair price be?"}]}]},{"title":"Close","kind":"closing","minutes":5,"questions":["Is there anything else you would like to add?"]}]}
{"op":"update_qual_guide","sections":[{"target":"Switching triggers","addQuestions":["Who else had a say in the decision?"]}]}
After fieldwork: transcripts are imported or transcribed and coded in the Qualitative workspace — the AI proposes codes, every quote must be verbatim, a person reviews. Themes are evidence, never population percentages.`;
