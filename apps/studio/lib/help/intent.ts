/**
 * WHAT KIND OF HELP IS BEING ASKED FOR (2026-11-09).
 *
 *   guide         "how do I …" — instructions, the person configures it
 *   do            "can you set up … for me" — the change is proposed through Intelligent Mode, where the researcher
 *                 approves it; Help itself never edits a survey and never says it did
 *   troubleshoot  "my piping is blank", "why isn't Q12 showing" — causes, checks, fixes
 *   billing       wallet, credits, charges — answered from the live billing configuration, never invented prices
 *
 * And when the words fit several features that solve different problems (piping vs carry-forward vs masking), a
 * clarifying question with the options, instead of a guess.
 */
export type HelpMode = "guide" | "do" | "troubleshoot" | "billing";

const DO = /\b(?:can|could|would|will) you\b.{0,60}\b(?:set ?up|configure|add|create|apply|make|build|do|program|write|fix|change|insert|turn on|switch)\b|\b(?:do|set|configure|fix|build) (?:it|this|that) for me\b|\bfor me\b.{0,5}$|^(?:please )?(?:set up|configure|add|create|apply|make|build|insert|fix|program)\b(?!.{0,40}\bhow\b)/i;
const HOW = /\bhow (?:do|can|should|would) (?:i|we|you)\b|\bhow to\b|\bwhat (?:is|are|does)\b|\bexplain\b|\bwhere (?:is|do|can)\b|\bguide me\b|\bshow me how\b|\bsteps?\b/i;
const TROUBLE = /\b(?:not|isn'?t|aren'?t|doesn'?t|don'?t|won'?t|can'?t|never)\b.{0,25}\b(?:work|working|show|showing|appear|appearing|display|displaying|fill|filling|run|running|execut|load|save|deploy|redirect|count|match)|\b(?:blank|empty|missing|broken|wrong|incorrect|unexpected(?:ly)?|failed|fails|failing|error|bug|stuck)\b|\bwhy (?:is|are|does|do|did|isn'?t|aren'?t|doesn'?t|can'?t)\b/i;
const BILLING = /\bwallet\b|\bcredits?\b|\bcharg(?:e|ed|es|ing)\b|\bbill(?:ed|ing)?\b|\bdeduct|\bbalance\b|\binvoice|\bspend(?:ing)?\b|\bcost(?:s)?\b|\bprice|\bpay(?:ment)?\b|\bsubscription\b|\bbillable\b/i;

export function helpMode(text: string): HelpMode {
  const t = text.trim();
  if (BILLING.test(t) && !/\b(?:conjoint|maxdiff|price (?:point|ladder|sensitivity)|willingness|method(?:ology)?|(?:find|set|choose|right|optimal|best) (?:the )?price|pricing (?:research|study)|cost per complete)\b|\bhow much (?:would|will|do|are) (?:customers|people|users|they)\b/i.test(t)) return "billing";
  if (TROUBLE.test(t)) return "troubleshoot";
  if (DO.test(t) && !HOW.test(t)) return "do";
  return "guide";
}

/** the sentence Intelligent Mode should receive for a "do it for me" request: the request without the politeness */
export function intelligentInstruction(text: string): string {
  return text.trim()
    .replace(/^(?:hi|hey|hello)[,!. ]+/i, "")
    .replace(/^(?:(?:can|could|would|will) you(?: please)?|please)\s+/i, "")
    .replace(/\s+for me\b/gi, "")
    .replace(/\s*please[?.!]*\s*$/i, "")
    .replace(/\?+\s*$/, "")
    .replace(/^./, (c) => c.toUpperCase());
}

export interface Clarification { question: string; options: { label: string; ask: string }[] }

/**
 * Requests that genuinely mean different features. Asked only when the words do not already decide it.
 */
const CLARIFY: { when: RegExp; decided: RegExp; c: Clarification }[] = [
  {
    when: /\b(?:only|just)\b.{0,30}\b(?:brands?|options?|items?|products?|answers?|choices?)\b.{0,40}\b(?:selected|chose|chosen|picked|ticked|aware|used)\b|\b(?:brands?|options?|items?) (?:from|selected in|chosen in) (?:an? )?(?:earlier|previous|another) question/i,
    decided: /\bpip(?:e|ing)\b|\bcarry[- ]?forward\b|\bmask(?:ing)?\b|\bin the (?:question )?text\b|\bas (?:the )?options\b|\bgrid\b|\brows\b/i,
    c: {
      question: "How should the earlier answers appear in the new question?",
      options: [
        { label: "As its answer options", ask: "How do I carry forward the options a respondent selected in an earlier question as the options of a later question?" },
        { label: "Hide the ones they didn't pick from a fixed list", ask: "How do I mask a question's options so only those selected in an earlier question are shown?" },
        { label: "Inside the question wording", ask: "How do I pipe the answers from an earlier question into the text of a later question?" },
        { label: "As the rows of a grid", ask: "How do I show only the brands selected earlier as the rows of a grid question (row masking)?" },
      ],
    },
  },
  {
    when: /\b(?:not (?:ask|show)|skip|hide|don'?t (?:ask|show))\b.{0,40}\b(?:if|when|for (?:people|respondents|those) who)\b/i,
    decided: /\bdisplay logic\b|\bskip logic\b|\bbranch|\bnext \d+ questions|\bthe rest of\b|\bend of the survey\b|\bonly (?:this|one|q\w+)\b/i,
    c: {
      question: "Is it one question you want to hide, or a run of questions to jump over?",
      options: [
        { label: "Hide one question", ask: "How do I hide a single question with display logic based on an earlier answer?" },
        { label: "Jump over several questions", ask: "How do I use skip logic to jump over several questions based on an earlier answer?" },
        { label: "A different path for some respondents", ask: "How do I branch the survey flow so some respondents get a different block of questions?" },
      ],
    },
  },
];

export function clarificationFor(text: string): Clarification | null {
  for (const x of CLARIFY) if (x.when.test(text) && !x.decided.test(text)) return x.c;
  return null;
}
