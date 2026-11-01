/**
 * THE RESPONSE-QUALITY & PARADATA GUIDE (S5b, 2026-11-01; audit TE-12, TE-13) — how Intelligent Mode sets the
 * quality checks and the telemetry switches (`set_quality_settings`, engine `qualityActions.ts`) and what a script
 * may read (`rs.getTiming()`, read-only). Sent only when a request is about quality checks, paradata or timing
 * (`qualityIntent`), lifted into the cached system prefix like every guide; the system prompt is at its cap and is
 * not touched. Every `{"op":…}` line is applied by the engine as written (`qualityGuide.test.ts`).
 */
export const COPILOT_QUALITY_GUIDE = `RESPONSE QUALITY AND PARADATA — the quality checks and what the survey records about HOW people answer are settings, never a script.
set_quality_settings {enabled, strictness relaxed|standard|strict|very_strict|custom, telemetry {timing, focus, clipboard, navigation, interaction, device, network, visibility (time each question was on screen, scroll depth), answerHistory (successive codes of closed answers; typed text: length only), idle (inactivity periods): true|false; idleSeconds 10–3600; idlePrompt (a gentle native "Are you still there?", off by default); idlePromptText; disclosure (footer text)}, rules {"<rule id>": {enabled, severity low|medium|high|critical, params {<threshold>: value}}}}.
Rule ids are the built-in ones only, e.g. timing.overall_speeding {ratio}, timing.page_speeding {ratio, share}, matrix.straightline {minRows, sameShare, gridShare}, attention.multiple_failed {count}, openend.too_short {minChars, share}, interaction.answered_unseen {minQuestions}, interaction.flip_flop {reversals, questions}, interaction.out_of_focus {share}, navigation.reloads {count}; an unknown id or threshold is refused with the right names.
Switching a category off is destructive (its rules are skipped, its data not kept): say so. Paradata never holds typed text, keystrokes or mouse positions — never promise them.
Timing in a script is READ-ONLY: rs.getTiming() → {elapsedSeconds, pageSeconds, questionSeconds(code)} (null when timing is off); a script never writes paradata. Exports: the Data panel's timing columns (PAGE_<ID>_SEC, Q_<VAR>_SEC) and the long timing file.
{"op":"set_quality_settings","enabled":true,"strictness":"strict","rules":{"timing.overall_speeding":{"params":{"ratio":0.35}}}}
{"op":"set_quality_settings","telemetry":{"idle":true,"idleSeconds":90,"idlePrompt":true}}
{"op":"set_quality_settings","telemetry":{"clipboard":false,"answerHistory":false}}`;

/** a request about quality checks, speeders, telemetry / paradata or response timing */
export function qualityIntent(text: string): boolean {
  return /\bquality (?:checks?|settings?|rules?|control|strictness)\b|\bspeeders?\b|\bspeeding\b|\bstraight-?lin\w*|\btelemetry\b|\bparadata\b|\bflip-?flop\w*|\binactiv\w*|\bidle (?:time|prompt|detection|respondents?)\b|\bstill there\b|\bscroll depth\b|\bquestion visibility\b|\bfraud (?:checks?|detection)\b|\bbot detection\b|\bset_quality_settings\b|\brs\.getTiming\b/i.test(text);
}
