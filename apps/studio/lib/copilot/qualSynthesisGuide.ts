/**
 * THE QUALITATIVE SYNTHESIS GUIDE (2026-10-22) — sent only when a request is about writing up or working with
 * qualitative DATA (`qualSynthesisIntent`), lifted into the cached system prefix like every guide; the system
 * prompt stays under its cap. The usual sentences never reach the model: the Studio reads them first
 * (`interpretQualRequest`, engine) into a preview card that runs on approval. This guide is for the rest — a
 * request phrased another way, or a question about what is possible — so the model points to the right sentence
 * and never writes a synthesis, a count or a quote itself in chat.
 */
export const COPILOT_QUAL_SYNTHESIS_GUIDE = `QUALITATIVE SYNTHESIS — the coded data (Research Tools → Qualitative) are written up by the Studio, never in this chat: you do not see the transcripts, so never write a theme summary, a finding, a quote, a count or a percentage yourself. Tell the researcher the sentence that does it (each opens a preview card; nothing runs until they approve):
• "summarise the themes" / "summarise the price theme" — AI theme summaries: what people said, nuance, tensions, by participant group, contradicting evidence; every sentence cites excerpts; counts are computed by code.
• "what are the key insights for objective 2" — key findings per objective and hypothesis; "not enough evidence" is a valid answer; recommendations are labelled interpretation.
• "compare Mumbai vs Delhi participants" — two participant groups theme by theme (by code, with a quote from each).
• "make a highlight reel of pricing complaints" — a reel of excerpts; clips play from recordings; Word / PowerPoint export.
• "set up double coding with 20% overlap" — blind double-coding (κ and Krippendorff's α, disagreement resolution).
• "what did Gen Z say about price?" — answered from cited excerpts only.
• "code new interviews automatically" — the auto-coding pipeline (AI-suggested, for review).
• "run a group session from the guide" — a TEXT group session (participants join by link, answer, rate each other's answers; AI clusters and follow-ups). Video conferencing is NOT supported — say so.
Frequency is not importance; AI-written text is reviewed before it is relied on.`;

/** a request about writing up qualitative data, double-coding, reels, group sessions */
export function qualSynthesisIntent(text: string): boolean {
  return /\b(?:theme summar\w*|summari[sz]e (?:the |each |all )?(?:themes?|interviews?|transcripts?)|key (?:insights?|findings) (?:for|of|from) (?:objective|the (?:interviews?|transcripts?|qual\w*))|highlight reels?|quote reels?|double[\s-]?cod\w*|krippendorff|inter[\s-]?coder|auto(?:matic(?:ally)?)?[\s-]?cod\w*|group sessions?|remesh|synthesi[sz]\w* (?:the )?(?:qual\w*|interviews?|transcripts?))\b/i.test(text);
}
