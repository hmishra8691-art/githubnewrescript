import type { Intent } from "./proposal.ts";

/**
 * THE DETERMINISTIC GRAMMAR — a sentence into an intent, with no network.
 *
 * This is what the Intelligent mode runs when no language model is
 * configured, and what it runs FIRST even when one is: a sentence these
 * patterns recognise never leaves the machine, costs nothing, and means the
 * same thing every time. The model is for the sentences these do not catch.
 *
 * It recognises the shapes a survey programmer actually types —
 *
 *   show Q5 (only) when/if <expr>          hide Q5 when <expr>
 *   ask Q5 only if <expr>                  don't show page 3 if <expr>
 *   skip to Q9 when <expr>                 after Q3, go to the end if <expr>
 *   terminate / screen out when <expr>     end the survey if <expr>
 *   make Q4 required / optional            Q4 is mandatory
 *   add a numeric question "How old…"      add a question after Q3: Age?
 *     with options A, B, C
 *   rename AGE to RESP_AGE                 rename Q3's variable to AGE
 *   what depends on Q3 / uses Q3           what does Q3 depend on
 *   what does Q3 affect                    what can affect Q3
 *   explain Q3 / why is Q3 shown
 *
 * — and hands the CONDITION through as text, untouched: the expression
 * parser decides what `Q3 = Yes and Q4 > 2` means, not this file.
 */

/**
 * A thing a sentence names: `Q5`, `AGE`, `page 3`, `block Main`, `the income
 * question`, or anything in quotes. Two bare words at most, and never one
 * of the words that start the condition — `show Q5 only when …` names Q5,
 * not "Q5 only".
 */
const OBJ = String.raw`((?:the\s+)?(?:(?:question|page|screen|block|section|group)\s+[\w.]+|[A-Za-z_][\w.]*(?:\s+(?!only\b|when\b|if\b|where\b|unless\b|then\b|question\b)[A-Za-z_]\w*)?)(?:\s+question)?|"[^"]+"|“[^”]+”)`;
const WHEN = String.raw`\s+(?:only\s+)?(?:when|if|where|unless)\s+(.+)$`;

const strip = (s: string) => s.replace(/^[“"]|[”"]$/g, "").trim();

function unlessFlip(sentence: string, expression: string): string {
  return /\bunless\s/i.test(sentence) && !/\b(?:when|if|where)\s/i.test(sentence) ? `NOT (${expression})` : expression;
}

export function parseIntent(input: string): Intent {
  const text = input.trim().replace(/\s+/g, " ").replace(/[.!]+$/, "");
  if (!text) return { kind: "unknown", reason: "Say what you want to change — for example “show Q5 only when Q3 = Yes”." };
  let m: RegExpExecArray | null;

  /* ------------------------------------------------------ find / explain */
  if ((m = /^(?:what|which(?: questions| objects)?|who|find(?: everything| all)?|list(?: everything| all)?|show me(?: everything| all)?)\s+(?:questions?\s+|rules?\s+|things?\s+|objects?\s+)?(?:that\s+)?(?:depends?\s+on|uses?|references?|reads?|needs?|relies\s+on|is\s+using)\s+(.+?)(?:\s*\?)?$/i.exec(text))) {
    return { kind: "find", target: strip(m[1]), relation: "usedBy" };
  }
  if ((m = /^(?:what|which(?: questions| objects)?|find(?: everything| all)?|list(?: everything| all)?|show me(?: everything| all)?)\s+(?:questions?\s+|things?\s+|objects?\s+)?(?:that\s+)?(?:is|are|can\s+be|could\s+be|gets?|would\s+be)\s+affected\s+by\s+(.+?)(?:\s*\?)?$/i.exec(text))) {
    return { kind: "find", target: strip(m[1]), relation: "affects" };
  }
  if ((m = /^(?:what|which)\s+(?:does|do|can|could|will|would)\s+(.+?)\s+(?:depend\s+on|use|read|reference|rely\s+on|need)(?:\s*\?)?$/i.exec(text))) {
    return { kind: "find", target: strip(m[1]), relation: "dependsOn" };
  }
  if ((m = /^(?:what|which)\s+(?:does|do|can|could|will|would)\s+(.+?)\s+(?:affect|change|influence|impact|reach)(?:\s*\?)?$/i.exec(text))) {
    return { kind: "find", target: strip(m[1]), relation: "affects" };
  }
  if ((m = /^(?:what|which)\s+(?:can|could)\s+(?:affect|change|influence|impact|reach)\s+(.+?)(?:\s*\?)?$/i.exec(text))) {
    return { kind: "find", target: strip(m[1]), relation: "reach" };
  }
  if ((m = /^(?:explain|describe|tell me about|what is|what's|why is|why does|how does|how is)\s+(.+?)(?:\s+(?:shown|hidden|displayed|asked|skipped|work|do|behave|visible))?(?:\s*\?)?$/i.exec(text))) {
    return { kind: "explain", target: strip(m[1]) };
  }

  /* ------------------------------------------------------------ required */
  if ((m = /^(?:make|set|mark)\s+(.+?)\s+(?:as\s+)?(required|mandatory|compulsory|optional|not\s+required|non-?mandatory)$/i.exec(text))
    || (m = /^(.+?)\s+(?:is|should\s+be|must\s+be|becomes?)\s+(?:now\s+)?(required|mandatory|compulsory|optional|not\s+required|non-?mandatory)$/i.exec(text))
    || (m = /^(require|mandate)\s+(?:an?\s+answer\s+(?:to|for|on)\s+)?(.+)$/i.exec(text))) {
    const isVerb = /^(require|mandate)$/i.test(m[1]);
    const target = isVerb ? m[2] : m[1];
    const word = isVerb ? "required" : m[2].toLowerCase();
    return { kind: "required", target: strip(target), required: !/optional|not|non/.test(word) };
  }

  /* -------------------------------------------------------------- rename */
  if ((m = /^rename\s+(?:the\s+)?(?:variable\s+)?(.+?)(?:'s\s+variable)?\s+(?:to|as|→|->)\s+([A-Za-z_][\w]*)$/i.exec(text))
    || (m = /^(?:change|set)\s+(?:the\s+)?(?:variable\s+(?:name\s+)?(?:of|for)\s+)?(.+?)(?:'s)?\s+variable(?:\s+name)?\s+to\s+([A-Za-z_][\w]*)$/i.exec(text))
    || (m = /^(?:call|name)\s+(.+?)\s+([A-Za-z_][\w]*)$/i.exec(text))) {
    return { kind: "rename", target: strip(m[1]), newName: m[2] };
  }

  /* ---------------------------------------------------------- skip logic */
  if ((m = /^(?:after\s+(.+?),?\s+)?(?:skip|jump|go|move|branch|send(?:\s+(?:them|respondents?|people))?)\s+(?:(?:straight|directly|forward)\s+)?(?:to|ahead\s+to)\s+(.+?)(?:\s+(?:when|if|where|unless)\s+(.+))?$/i.exec(text))) {
    if (!m[3]) return { kind: "unknown", reason: "A skip needs a condition — “skip to Q9 when Q3 = No”." };
    return { kind: "skip", from: m[1] ? strip(m[1]) : undefined, to: strip(m[2]), expression: unlessFlip(text, m[3]) };
  }
  if ((m = /^(?:(?:after|from)\s+(.+?),?\s+)?(?:terminate|screen\s*(?:them\s+)?out|disqualify|end\s+the\s+survey|end\s+the\s+interview|finish|close\s+the\s+survey|exit)(?:\s+(?:the\s+)?(?:survey|interview|respondent|them|as\s+(\w+(?:\s+\w+)?)))?\s*,?\s+(?:when|if|where|unless)\s+(.+)$/i.exec(text))) {
    const verb = /terminate|screen|disqualify|exit/i.test(text.split(/\s+(?:when|if|where|unless)\s+/i)[0]) ? "terminate" : "end";
    const status = m[2] ? m[2] : verb === "end" ? "the end" : (/screen|disqualif/i.test(text) ? "screened" : "terminated");
    return { kind: "skip", from: m[1] ? strip(m[1]) : undefined, to: status, expression: unlessFlip(text, m[3]) };
  }
  if ((m = /^(?:when|if)\s+(.+?),?\s+(?:skip|jump|go|move|send(?:\s+(?:them|respondents?))?)\s+(?:to\s+)?(.+)$/i.exec(text))) {
    return { kind: "skip", to: strip(m[2]), expression: m[1] };
  }
  if ((m = /^(?:when|if)\s+(.+?),?\s+(?:terminate|screen\s*(?:them\s+)?out|disqualify|end\s+the\s+survey)(?:\s+(?:them|as\s+(\w+)))?$/i.exec(text))) {
    return { kind: "skip", to: m[2] ?? (/screen|disqualif/i.test(text) ? "screened" : /end the survey/i.test(text) ? "the end" : "terminated"), expression: m[1] };
  }

  /* ------------------------------------------------------- display logic */
  if ((m = new RegExp(String.raw`^(?:only\s+)?(?:show|display|ask|present|include|enable)\s+${OBJ}${WHEN}`, "i").exec(text))) {
    return { kind: "display", target: strip(m[1]), action: "show", expression: unlessFlip(text, m[2]) };
  }
  if ((m = new RegExp(String.raw`^(?:hide|suppress|don't\s+(?:show|ask|display)|do\s+not\s+(?:show|ask|display)|never\s+(?:show|ask)|remove|exclude|disable)\s+${OBJ}${WHEN}`, "i").exec(text))) {
    return { kind: "display", target: strip(m[1]), action: "hide", expression: unlessFlip(text, m[2]) };
  }
  if ((m = new RegExp(String.raw`^${OBJ}\s+(?:should\s+(?:only\s+)?(?:be\s+)?|is\s+(?:only\s+)?|must\s+(?:only\s+)?(?:be\s+)?|(?:will|can)\s+(?:only\s+)?(?:be\s+)?)?(?:shown|displayed|asked|visible|appears?)(?:\s+only)?\s+(?:when|if|where)\s+(.+)$`, "i").exec(text))) {
    return { kind: "display", target: strip(m[1]), action: "show", expression: m[2] };
  }
  if ((m = new RegExp(String.raw`^${OBJ}\s+(?:should\s+(?:be\s+)?|is\s+|must\s+(?:be\s+)?|(?:will|can)\s+(?:be\s+)?)?(?:hidden|skipped|suppressed|not\s+(?:shown|asked|displayed))\s+(?:when|if|where)\s+(.+)$`, "i").exec(text))) {
    return { kind: "display", target: strip(m[1]), action: "hide", expression: m[2] };
  }
  if ((m = new RegExp(String.raw`^(?:when|if)\s+(.+?),?\s+(?:then\s+)?(show|display|ask|hide|skip|suppress|don't\s+show|do\s+not\s+show)\s+${OBJ}$`, "i").exec(text))) {
    return { kind: "display", target: strip(m[3]), action: /^(?:show|display|ask)$/i.test(m[2]) ? "show" : "hide", expression: m[1] };
  }

  /* ------------------------------------------------------- add question */
  if ((m = /^(?:add|create|insert|new|append|put)\s+(?:an?\s+|another\s+|one\s+more\s+)?(?:new\s+)?(.*?)\s*question\b(.*)$/i.exec(text))) {
    const type = m[1].trim() || undefined;
    let rest = m[2].trim();
    let after: string | undefined;
    let options: string[] | undefined;
    let required: boolean | undefined;
    const opt = /\s*(?:,\s*)?(?:with|having|offering)\s+(?:the\s+)?(?:options?|answers?|choices?|answer\s+options?)\s*[:=]?\s*(.+)$/i.exec(rest);
    if (opt) {
      options = opt[1].split(/\s*(?:,|;|\/|\bor\b|\band\b)\s*/i).map(strip).filter(Boolean);
      rest = rest.slice(0, opt.index).trim();
    }
    const req = /\s*,?\s*(?:\(|,\s*)?(required|mandatory|optional)\)?\s*$/i.exec(rest);
    if (req) { required = !/optional/i.test(req[1]); rest = rest.slice(0, req.index).trim(); }
    const pos = /\s*(?:,\s*)?(?:after|below|following|under|behind)\s+(.+?)\s*$/i.exec(rest);
    const posFront = /^(?:after|below|following)\s+(.+?)(?:\s*[:,-]\s*|\s+(?:asking|saying|that\s+says|with\s+(?:the\s+)?text|titled|reading)\s+)(.+)$/i.exec(rest);
    let body = rest;
    if (posFront) { after = strip(posFront[1]); body = posFront[2]; }
    else if (pos && !/["“]/.test(pos[1])) { after = strip(pos[1]); body = rest.slice(0, pos.index); }
    body = body.replace(/^(?:[:,-]\s*|(?:asking|saying|that\s+says|with\s+(?:the\s+)?text|titled|reading)\s+)/i, "").trim();
    const quoted = /^[“"](.+)[”"]$/.exec(body);
    const qtext = quoted ? quoted[1] : body;
    return { kind: "add_question", type, text: qtext.trim(), options, after, required };
  }

  return { kind: "unknown", reason: "I did not understand that. Try “show Q5 only when Q3 = Yes”, “skip to Q9 if Q2 = No”, “make Q4 required”, “add a numeric question ‘How old are you?’ after Q2”, or “what depends on Q3”." };
}

/** the shapes the grammar knows, for the mode's help and for the model's prompt */
export const EXAMPLES: { text: string; about: string }[] = [
  { text: "Show Q5 only when Q3 = Yes and Q4 > 2", about: "display logic" },
  { text: "Hide page 3 if Q2 is Business", about: "a display rule on a page" },
  { text: "After Q2, skip to Q9 when Q2 = No", about: "a skip rule" },
  { text: "Screen out when Q1 < 18", about: "a termination" },
  { text: "Make Q4 required", about: "required" },
  { text: "Add a numeric question “How old are you?” after Q1", about: "a new question" },
  { text: "Add a single choice question “Do you own a car?” with options Yes, No", about: "a new question with options" },
  { text: "Rename AGE to RESP_AGE", about: "a variable rename" },
  { text: "What depends on Q3?", about: "dependencies" },
  { text: "Explain Q5", about: "how a question behaves" },
];
