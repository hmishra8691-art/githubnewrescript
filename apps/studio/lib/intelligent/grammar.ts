import type { Intent, ValidationSpec } from "./proposal.ts";

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
const WHEN = String.raw`\s+(?:only\s+)?(?:when|if|where|unless|(?:to|for)\s+(?:respondents?|people|those|anyone|users|participants)\s+who)\s+(.+)$`;

const strip = (s: string) => s.replace(/^[“"]|[”"]$/g, "").trim();

function unlessFlip(sentence: string, expression: string): string {
  return /\bunless\s/i.test(sentence) && !/\b(?:when|if|where)\s/i.test(sentence) ? `NOT (${expression})` : expression;
}

export function parseIntent(input: string): Intent {
  const text = input.trim().replace(/\s+/g, " ").replace(/[.!]+$/, "");
  if (!text) return { kind: "unknown", reason: "Say what you want to change — for example “show Q5 only when Q3 = Yes”." };
  let m: RegExpExecArray | null;

  /* ------------------------------------------------------------ screening (read-only) */
  if (/^(?:explain|show|tell me|list|describe)\s+(?:me\s+)?(?:why|how|when|where|which|what)?\s*(?:a\s+|the\s+)?(?:respondents?|people|someone|participants?|anyone)?\s*(?:is|are|get|gets|would be|can be|being)?\s*(?:screened|terminated|disqualified|screen[- ]?outs?|terminations?|screening)(?:\s+out)?(?:\s+(?:of\s+)?(?:the\s+)?survey)?(?:\s*\?)?$/i.test(text)
    || /^(?:what|which)\s+(?:screens|terminates|disqualifies)\s+(?:respondents?|people|someone)(?:\s+out)?(?:\s*\?)?$/i.test(text)
    || /^(?:why|when)\s+(?:is|are|would|does|do)\s+(?:this\s+|a\s+|the\s+)?(?:respondent|person|participant|someone|people|respondents)\s+(?:being\s+)?(?:screened|terminated|disqualified)(?:\s+out)?(?:\s*\?)?$/i.test(text)) {
    return { kind: "screening" };
  }

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

  /* ---------------------------------------------------------- page breaks */
  if ((m = /^(?:add|insert|put|create|place|start)\s+(?:a\s+|another\s+)?(?:new\s+)?(?:page\s*break|page)\s+(?:after|below|following|under)\s+(.+)$/i.exec(text))
    || (m = /^(?:put|move|show|place)\s+(?:the\s+)?(?:questions?\s+)?(?:after|below|following)\s+(.+?)\s+on\s+(?:a\s+)?(?:new|separate|its own|their own)\s+page$/i.exec(text))
    || (m = /^(?:break|split)\s+(?:the\s+)?page\s+(?:after|below)\s+(.+)$/i.exec(text))) {
    return { kind: "page_break", target: strip(m[1]), action: "add" };
  }
  if ((m = /^(?:remove|delete|drop|take\s+out|clear)\s+(?:the\s+)?(?:page\s*break|break)\s+(?:after|below|following|under)\s+(.+)$/i.exec(text))
    || (m = /^(?:merge|join)\s+(.+?)(?:'s)?\s+page\s+with\s+(?:the\s+)?(?:next|following)(?:\s+page)?$/i.exec(text))) {
    return { kind: "page_break", target: strip(m[1]), action: "remove" };
  }
  if ((m = /^(?:put|move|show|place|start)\s+(.+?)\s+on\s+(?:a\s+)?(?:new|separate|its own|fresh)\s+page$/i.exec(text))
    || (m = /^(?:add|insert|put|create|place)\s+(?:a\s+)?(?:new\s+)?(?:page\s*break|page)\s+(?:before|above|in front of)\s+(.+)$/i.exec(text))) {
    // "put Q11 on a new page" / "page break before Q11" — the break goes after the question BEFORE it
    return { kind: "page_break", target: strip(m[1]), action: "add", before: true };
  }

  /* ------------------------------------------------------ embedded data */
  if ((m = /^(?:add|create|make|define|insert|new)\s+(?:an?\s+|the\s+)?(?:new\s+)?embedded\s+(?:data\s+)?(?:variable|field|value|data)?\s*(?:called|named|for)?\s*[:]?\s*["“]?([A-Za-z_][\w ]*?)["”]?(?:\s*(?:,|and|which is|that is|with(?:\s+(?:the\s+)?value)?|=|:)\s*(?:set\s+(?:it\s+)?to|equal\s+to|value|to)?\s*["“]?([^"”]+?)["”]?)?(?:\s+(?:from|read\s+from|taken\s+from)\s+(?:the\s+)?(url|link|panel|query\s*string))?$/i.exec(text))) {
    const name = m[1].trim();
    const value = m[2]?.trim();
    const src = m[3] ? (/panel/i.test(m[3]) ? "panel" : "url") : undefined;
    const kind = value && /^(?:from|read from)\s+(?:the\s+)?(url|link|panel)$/i.exec(value);
    if (kind) return { kind: "embedded", name, source: /panel/i.test(kind[1]) ? "panel" : "url" };
    return { kind: "embedded", name, ...(src ? { source: src } : value !== undefined ? { source: "static", value } : {}) };
  }

  /* ---------------------------------------------------------------- loops */
  if ((m = /^(?:create|add|make|build|put|wrap)\s+(?:a\s+)?loop\s+(?:around|over|for|on|of)\s+(?:the\s+)?(?:questions?\s+)?(.+?)\s+(?:to|through|thru|–|-|until|till)\s+(.+?)(?:\s*,?\s+(?:once\s+)?(?:per|for\s+each|for\s+every)\s+([A-Za-z_][\w]*))?$/i.exec(text))
    || (m = /^(?:loop|repeat)\s+(?:the\s+)?(?:questions?\s+)?(.+?)\s+(?:to|through|thru|–|-|until|till)\s+(.+?)(?:\s*,?\s+(?:once\s+)?(?:per|for\s+each|for\s+every)\s+([A-Za-z_][\w]*))?$/i.exec(text))) {
    return { kind: "loop", from: strip(m[1]), to: strip(m[2]), ...(m[3] ? { loopVar: m[3] } : {}) };
  }
  if ((m = /^(?:create|add|make|put|wrap)\s+(?:a\s+)?loop\s+(?:around|over)\s+(?:these|the\s+selected|the\s+current)\s+questions?(?:\s*,?\s+(?:once\s+)?(?:per|for\s+each|for\s+every)\s+([A-Za-z_][\w]*))?$/i.exec(text))) {
    return { kind: "loop", from: "this", to: "this", ...(m[1] ? { loopVar: m[1] } : {}) };
  }

  /* ------------------------------------------------------------ required */
  if ((m = /^(?:make|set|mark)\s+(.+?)\s+(?:as\s+)?(required|mandatory|compulsory|optional|not\s+required|non-?mandatory)$/i.exec(text))
    || (m = /^(.+?)\s+(?:is|should\s+be|must\s+be|becomes?)\s+(?:now\s+)?(required|mandatory|compulsory|optional|not\s+required|non-?mandatory)$/i.exec(text))
    || (m = /^(require|mandate)\s+(?!(?:at\s+least|at\s+most|a\s+minimum|a\s+maximum|min|max|no\s+more|up\s+to|\d))(?:an?\s+answer\s+(?:to|for|on)\s+)?(.+)$/i.exec(text))) {
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

  /* ---------------------------------------------------------- validation */
  {
    const v = parseValidation(text);
    if (v) return v;
  }

  /* ------------------------------------------------------------- masking */
  if ((m = /^(?:remove|clear|drop|delete)\s+(?:the\s+)?(?:option\s+)?mask(?:ing)?\s+(?:from|on|of)\s+(.+)$/i.exec(text))
    || (m = /^(?:unmask|stop\s+masking)\s+(.+)$/i.exec(text))) {
    return { kind: "clear_mask", target: strip(m[1]) };
  }
  if ((m = /^(?:mask|filter|restrict|limit)\s+(?:the\s+)?(?:options?\s+(?:of|in|at)\s+)?(.+?)\s+(?:by|to|with|using)\s+(?:the\s+)?(.+)$/i.exec(text)) && !/\b(?:characters?|chars|digits|values?|selections?|answers?)\b/i.test(m[2]) && !/^(?:\d|at least|at most|between)/i.test(m[2])) {
    return { kind: "mask", target: strip(m[1]), expression: m[2], action: "display" };
  }
  if ((m = /^(?:show|display|offer)\s+(?:only\s+|just\s+)?(?:the\s+)?(?:options?|answers?|items?|choices?)\s+(.+)\s+(?:at|in|on|for)\s+((?:the\s+)?[A-Za-z_][\w]*(?:\s+question)?)$/i.exec(text))
    || (m = /^(?:at|in|on)\s+(.+?),?\s+(?:show|display|offer)\s+(?:only\s+|just\s+)?(?:the\s+)?(?:options?|answers?|items?|choices?)\s+(.+)$/i.exec(text))) {
    const swapped = /^(?:at|in|on)\s/i.test(text);
    const target = swapped ? m[1] : m[2], expr = swapped ? m[2] : m[1];
    return { kind: "mask", target: strip(target), expression: expr, action: "display" };
  }
  if ((m = /^(?:hide|remove|drop|exclude)\s+(?:the\s+)?(?:options?|answers?|items?|choices?)\s+(.+)\s+(?:from|at|in)\s+((?:the\s+)?[A-Za-z_][\w]*(?:\s+question)?)$/i.exec(text))
    || (m = /^(?:at|in|from)\s+(.+?),?\s+(?:hide|remove|drop|exclude)\s+(?:the\s+)?(?:options?|answers?|items?|choices?)\s+(.+)$/i.exec(text))) {
    const swapped = /^(?:at|in|from)\s/i.test(text);
    const target = swapped ? m[1] : m[2], expr = swapped ? m[2] : m[1];
    return { kind: "mask", target: strip(target), expression: expr, action: "remove" };
  }
  if ((m = /^carry\s+(?:forward\s+)?(?:the\s+)?(?:(selected|unselected|not\s+selected|displayed|all)\s+)?(?:options?|answers?|items?)?\s*(?:from\s+)?(.+?)\s+(?:to|into|forward\s+to)\s+(.+)$/i.exec(text))) {
    const sel = (m[1] ?? "selected").toLowerCase();
    const word = /not|un/.test(sel) ? "Unselected" : sel === "displayed" ? "Displayed" : sel === "all" ? "Options" : "Selected";
    return { kind: "mask", target: strip(m[3]), expression: `${strip(m[2])}.${word}`, action: "display" };
  }

  /* ------------------------------------------- hidden / calculated variables */
  if ((m = /^(?:add|create|make|insert|new|define)\s+(?:an?\s+|the\s+)?(?:new\s+)?(hidden|calculated|computed|derived)\s+(?:variable|value|field|question)\s*(?:called|named|for|:)?\s*(.*)$/i.exec(text))) {
    const type = /hidden/i.test(m[1]) ? "hidden" : "calculated";
    let rest = m[2].trim();
    let after: string | undefined;
    const pos = /\s*(?:,\s*)?(?:after|below|following)\s+(.+?)\s*$/i.exec(rest);
    if (pos) { after = strip(pos[1]); rest = rest.slice(0, pos.index).trim(); }
    return { kind: "add_question", type, text: strip(rest), after };
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
/* ---------------------------------------------------------------- validation */

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;

/**
 * Validation sentences. The subject is whatever comes before the rule words;
 * `resolveTarget` decides what it names. Every shape maps onto the engine's
 * own rule kinds — nothing here invents a check the Validation panel does
 * not already offer.
 */
function parseValidation(text: string): Intent | null {
  let m: RegExpExecArray | null;
  const T = String.raw`(.+?)`;
  const rule = (target: string, rules: ValidationSpec[]): Intent =>
    ({ kind: "validation", target: strip(target).replace(/^(?:the\s+)?(?:answer|value|response)\s+(?:to|of|for)\s+/i, ""), rules });

  if ((m = /^(?:clear|remove|drop|delete)\s+(?:all\s+|the\s+|every\s+)?validation(?:\s+rules?)?\s+(?:from|on|of)\s+(.+)$/i.exec(text))) return { kind: "clear_validation", target: strip(m[1]) };
  if ((m = /^(?:remove|drop|delete)\s+(?:the\s+)?(min(?:imum)?|max(?:imum)?|length|character|email|phone|url|zip|integer|pattern|range)\s*(?:value|length|selections?|limit|rule|check)?\s+(?:rule\s+)?(?:from|on|of)\s+(.+)$/i.exec(text))) {
    const w = m[1].toLowerCase();
    const kinds = /^min/.test(w) ? ["min_value", "min_length", "min_selections"] : /^max/.test(w) ? ["max_value", "max_length", "max_selections"] : /length|character/.test(w) ? ["min_length", "max_length"] : /range/.test(w) ? ["min_value", "max_value"] : [w];
    return { kind: "clear_validation", target: strip(m[2]), kinds: kinds as never };
  }
  // between
  if ((m = new RegExp(String.raw`^(?:make\s+|limit\s+|restrict\s+)?${T}\s+(?:must\s+be\s+|should\s+be\s+|is\s+|to\s+(?:values?\s+)?|values?\s+)?(?:a\s+number\s+)?(?:between|from)\s+${NUM}\s+(?:and|to|-)\s+${NUM}(?:\s+(characters?|chars|letters|selections?|options?|answers?|items?))?$`, "i").exec(text))) {
    const unit = (m[4] ?? "").toLowerCase();
    const k = /char|letter/.test(unit) ? ["min_length", "max_length"] : /select|option|answer|item/.test(unit) ? ["min_selections", "max_selections"] : ["min_value", "max_value"];
    return rule(m[1], [{ kind: k[0] as ValidationSpec["kind"], value: Number(m[2]) }, { kind: k[1] as ValidationSpec["kind"], value: Number(m[3]) }]);
  }
  // selections
  if ((m = new RegExp(String.raw`^(?:require\s+|allow\s+)?(?:at\s+least|a\s+minimum\s+of|min(?:imum)?)\s+${NUM}\s+(?:selections?|options?|answers?|items?|choices?)\s+(?:on|for|at|in)\s+${T}$`, "i").exec(text))) return rule(m[2], [{ kind: "min_selections", value: Number(m[1]) }]);
  if ((m = new RegExp(String.raw`^(?:allow\s+|permit\s+)?(?:at\s+most|a\s+maximum\s+of|max(?:imum)?|no\s+more\s+than|up\s+to)\s+${NUM}\s+(?:selections?|options?|answers?|items?|choices?)\s+(?:on|for|at|in)\s+${T}$`, "i").exec(text))) return rule(m[2], [{ kind: "max_selections", value: Number(m[1]) }]);
  if ((m = new RegExp(String.raw`^${T}\s+(?:must\s+have\s+|should\s+have\s+|needs?\s+|allows?\s+|has\s+)?(?:at\s+least|min(?:imum)?(?:\s+of)?)\s+${NUM}\s+(?:selections?|options?|answers?|items?|choices?)(?:\s+selected)?$`, "i").exec(text))) return rule(m[1], [{ kind: "min_selections", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^${T}\s+(?:must\s+have\s+|should\s+have\s+|allows?\s+|has\s+)?(?:at\s+most|max(?:imum)?(?:\s+of)?|no\s+more\s+than|up\s+to)\s+${NUM}\s+(?:selections?|options?|answers?|items?|choices?)(?:\s+selected)?$`, "i").exec(text))) return rule(m[1], [{ kind: "max_selections", value: Number(m[2]) }]);
  // characters
  if ((m = new RegExp(String.raw`^(?:limit|restrict|cap)\s+${T}\s+(?:to|at)\s+${NUM}\s+(?:characters?|chars|letters)$`, "i").exec(text))) return rule(m[1], [{ kind: "max_length", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^${T}\s+(?:must\s+be\s+|should\s+be\s+|is\s+|has\s+|allows?\s+)?(?:at\s+most|max(?:imum)?(?:\s+of)?|no\s+(?:more|longer)\s+than|up\s+to)\s+${NUM}\s+(?:characters?|chars|letters)(?:\s+long)?$`, "i").exec(text))) return rule(m[1], [{ kind: "max_length", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^${T}\s+(?:must\s+be\s+|should\s+be\s+|is\s+|has\s+|needs?\s+)?(?:at\s+least|min(?:imum)?(?:\s+of)?|no\s+(?:fewer|less|shorter)\s+than)\s+${NUM}\s+(?:characters?|chars|letters)(?:\s+long)?$`, "i").exec(text))) return rule(m[1], [{ kind: "min_length", value: Number(m[2]) }]);
  // numeric bounds
  if ((m = new RegExp(String.raw`^${T}\s+(?:must\s+be\s+|should\s+be\s+|is\s+|has\s+(?:a\s+)?)?(?:at\s+least|min(?:imum)?(?:\s+(?:value\s+)?(?:of|is))?|no\s+(?:less|lower|smaller)\s+than|>=|greater\s+than\s+or\s+equal\s+to)\s+${NUM}$`, "i").exec(text))) return rule(m[1], [{ kind: "min_value", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^${T}\s+(?:must\s+be\s+|should\s+be\s+|is\s+|has\s+(?:a\s+)?)?(?:at\s+most|max(?:imum)?(?:\s+(?:value\s+)?(?:of|is))?|no\s+(?:more|higher|greater)\s+than|<=|less\s+than\s+or\s+equal\s+to|up\s+to)\s+${NUM}$`, "i").exec(text))) return rule(m[1], [{ kind: "max_value", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^(?:set\s+(?:the\s+)?)?(?:min(?:imum)?|lowest)\s+(?:value\s+)?(?:of|for|on)\s+${T}\s+(?:to|=|is)\s+${NUM}$`, "i").exec(text))) return rule(m[1], [{ kind: "min_value", value: Number(m[2]) }]);
  if ((m = new RegExp(String.raw`^(?:set\s+(?:the\s+)?)?(?:max(?:imum)?|highest)\s+(?:value\s+)?(?:of|for|on)\s+${T}\s+(?:to|=|is)\s+${NUM}$`, "i").exec(text))) return rule(m[1], [{ kind: "max_value", value: Number(m[2]) }]);
  // formats
  if ((m = new RegExp(String.raw`^(?:validate\s+|check\s+|make\s+|treat\s+)?${T}\s+(?:must\s+be\s+|should\s+be\s+|is\s+|as\s+|to\s+be\s+)?(?:a\s+valid\s+|a\s+|an\s+|as\s+an?\s+)?(e-?mail(?:\s+address)?|phone(?:\s+number)?|telephone(?:\s+number)?|url|web\s+address|website|link|zip(?:\s+code)?|post(?:al)?\s*code|whole\s+number|integer|number\s+without\s+decimals)$`, "i").exec(text))) {
    const w = m[2].toLowerCase();
    const kind = /mail/.test(w) ? "email" : /phone|tele/.test(w) ? "phone" : /url|web|link/.test(w) ? "url" : /zip|post/.test(w) ? "zip" : "integer";
    return rule(m[1], [{ kind: kind as ValidationSpec["kind"] }]);
  }
  if ((m = new RegExp(String.raw`^${T}\s+(?:must|should)\s+match\s+(?:the\s+)?(?:pattern|regex|regular\s+expression)\s+(.+)$`, "i").exec(text))) return rule(m[1], [{ kind: "pattern", value: strip(m[2]) }]);
  return null;
}

export const EXAMPLES: { text: string; about: string }[] = [
  { text: "Show Q5 only when Q3 = Yes and Q4 > 2", about: "display logic" },
  { text: "Hide page 3 if Q2 is Business", about: "a display rule on a page" },
  { text: "After Q2, skip to Q9 when Q2 = No", about: "a skip rule" },
  { text: "Screen out when Q1 < 18", about: "a termination" },
  { text: "Make Q4 required", about: "required" },
  { text: "Add a numeric question “How old are you?” after Q1", about: "a new question" },
  { text: "Add a single choice question “Do you own a car?” with options Yes, No", about: "a new question with options" },
  { text: "Q1 must be between 18 and 99", about: "validation" },
  { text: "Limit Q6 to 120 characters", about: "a character limit" },
  { text: "Q7 must be an email address", about: "a format check" },
  { text: "At Q13 show only the options selected in Q11", about: "masking" },
  { text: "Add a page break after Q10", about: "a page break" },
  { text: "Create an embedded variable called country and set it to India", about: "embedded data" },
  { text: "Add a hidden variable for respondent type", about: "a hidden variable" },
  { text: "Create a loop around Q5 to Q8 for each brand", about: "a loop" },
  { text: "Rename AGE to RESP_AGE", about: "a variable rename" },
  { text: "What depends on Q3?", about: "dependencies" },
  { text: "Explain Q5", about: "how a question behaves" },
  { text: "Explain why respondents are screened out", about: "screening and termination" },
];
