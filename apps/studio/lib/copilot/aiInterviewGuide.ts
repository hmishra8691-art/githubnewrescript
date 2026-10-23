/**
 * THE AI-INTERVIEW GUIDE (2026-10-22) — how Intelligent Mode turns an interview guide into an
 * AI-moderated study (`configure_ai_interviews`, engine `aiInterviewActions.ts`). Sent only when a
 * request is about AI interviews (`aiInterviewIntent`), lifted into the cached system prefix like every
 * guide (`aiPromptCache.ts`); the system prompt is at its cap and is not touched. Every `{"op":…}` line
 * is applied by the engine as written (`aiInterviewGuide.test.ts`).
 *
 * What it must never let the model claim: that a study was launched (that is the researcher's button,
 * after the consent check), or that Rescript runs live human-moderated sessions or video calls.
 */
export const COPILOT_AI_INTERVIEW_GUIDE = `AI-MODERATED INTERVIEWS — an interview guide (kind "interview") can be RUN BY AN AI MODERATOR with each participant, one to one, asynchronously, from a link: text chat, voice, or voice + camera, in the participant's language, with follow-up probes, the guide's conditional probes, stimuli and objective coverage. Configure it with configure_ai_interviews — a PATCH on the guide's AI settings (the guide must exist: create_qual_guide kind "interview" first, in the same reply if needed). Fields: modes ["text","voice","video"]; targetMinutes; maxTurns; defaultProbing none | light | deep; probing [{question: guide question id or the start of its text, depth, maxFollowUps}]; objectives (default: the guide's); languages ["hi","en"] (empty = the participant's own); targetCompletes; screener [{text, options:[{label, qualifies:false screens out, segment}]}] or [{fromQuestion:"Q3", qualifying:["I do"], segments:{"I do":"Payers"}}]; quotas [{segment, target}]; persona {name, tone}; stimuli [{name = the section's stimulus name, kind image | video | text, url (https) or text}]; incentive; thankYouMessage; redirectUrl (https; may pipe only {{pid}}); costCapUsd per interview; studyBudgetUsd; voiceStyles ["conversation","turn_based"] (hands-free with barge-in / tap to talk; "realtime" only when the installation has a realtime provider). Each study language gets its wording (fallback questions, consent, page labels) translated at launch — never claim it is done.
Consent is the GUIDE's consent.statement (plus recordingDisclosure for voice / video): launch is refused without it — add it with update_qual_guide consent when missing.
LAUNCHING (the participant link, real people, real AI spend) is the researcher's button in Research Tools → Qualitative → AI interviews: never say it is launched or live. Say what it costs: roughly one model call per answer.
Supported: AI-moderated 1:1 interviews. NOT supported by the AI moderator — say so: multi-party video calls, a real-time VIDEO conversation; live human-moderated sessions and video focus groups are Research Tools → Qualitative → Live sessions. Voice can be a hands-free conversation the participant can interrupt; the participant page speaks 20 languages built in (others machine-translated at launch).
{"op":"configure_ai_interviews","modes":["voice","text"],"targetCompletes":50,"languages":["Hindi","English"],"targetMinutes":20,"defaultProbing":"deep"}
{"op":"configure_ai_interviews","screener":[{"text":"Who pays the household broadband bill?","options":[{"label":"I do","segment":"Payers"},{"label":"Someone else","qualifies":false}]}],"quotas":[{"segment":"Payers","target":50}]}`;

/** a request about running a guide as AI-moderated interviews */
export function aiInterviewIntent(text: string): boolean {
  return /\bai[\s-]?(?:moderat\w*|led|run|powered)\b|\bai (?:voice |video |text |chat )?interview(?:s|er|ers|ing)?\b|\bas ai (?:voice |video |text )?interviews?\b|\basync(?:hronous)? (?:ai )?interviews?\b|\binterviews? at scale\b|\b(?:voice|video|chat) interviews? with \d+|\brun (?:this|the|my) (?:interview )?guide\b|\bai moderator\b|\bconfigure_ai_interviews\b/i.test(text)
    || /एआई\s*(?:इंटरव्यू|साक्षात्कार)|AI\s*(?:इंटरव्यू|साक्षात्कार)/.test(text);
}
