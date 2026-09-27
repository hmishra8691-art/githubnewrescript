import type {
  CanonicalSurvey, CanonicalQuestion, CanonicalOption, CanonicalRow, CanonicalValidation, CFlow, CExpr, CRef, COp, CanonicalKind, Issue, SourceFormat,
} from "../canonical.js";
import type { DocBlock } from "./docx.js";

/**
 * A QUESTIONNAIRE WRITTEN FOR PEOPLE → CANONICAL (§18–§23).
 *
 * Word, PDF and plain-text questionnaires all arrive here as a list of
 * paragraphs (and, from Word, tables). The reader is a small state machine
 * over those lines, and it knows the conventions researchers use:
 *
 *   Q5. / S2) / Question 7: / A3a –   a question, and its code
 *   1. Yes  a) Yes  • Yes  ☐ Yes  Yes ....... 1  Yes (1)   an answer option
 *   [SELECT ALL THAT APPLY]  (Single answer)  PROGRAMMER NOTE: …   an instruction
 *   ASK IF Q3 = 1 · ASK Q15 ONLY IF Q10 = Product A · SKIP TO Q10   logic
 *   (TERMINATE) · [EXCLUSIVE] · Other (please specify)   option annotations
 *   SECTION B: … · a heading style · an all-caps line   a block
 *   PAGE BREAK · ---   a page boundary
 *
 * The question's type is INFERRED — from its instruction ("select all that
 * apply" → multi), its words ("how many" → numeric, "rate each" → grid), its
 * options (none → open end) — and every inference says what it was based
 * on, with a confidence. Logic is read in a second pass, once every question
 * exists, and it is read CONSERVATIVELY: "ask Q15 only for respondents who
 * selected Product A in Q10" becomes a rule because Q10 has an option called
 * Product A; "ask only existing customers" does not, because nothing in the
 * document says which answer makes someone an existing customer (§36). That
 * one is reported as ambiguous, with the words that need a decision.
 */

interface Draft {
  q: CanonicalQuestion;
  instructions: string[];
  /** option index → the annotations written next to it */
  optionNotes: Map<number, string[]>;
  block: number;
  page: number;
  /** a type word appeared explicitly */
  typeSaid: boolean;
  table?: string[][];
}

const Q_START = /^\s*((?:Q(?:uestion)?\s*\.?\s*)?[A-Z]{0,4}\d{1,4}[a-z]{0,2}(?:\.\d+)?)\s*[.):\-–—]\s*(.+)$/i;
/** the document's own label, normalised: "Question 5" / "Q. 5" → Q5; a bare "5." → Q5 */
const qCode = (raw: string) => { const c = raw.toUpperCase().replace(/^QUESTION\s*/, "Q").replace(/^Q[\s.]+/, "Q"); return /^\d/.test(c) ? `Q${c}` : c; };
const Q_START_NOPUNCT = /^\s*((?:Q|S|A|B|C|D|QS|SC)\d{1,4}[a-z]?)\s+(?![.)=:])(.+)$/i;
const OPT_NUM = /^\s*(\d{1,3})\s*[.)=:\-–]\s*(.+)$/;
const OPT_LETTER = /^\s*([a-hA-H])[.)]\s+(.+)$/;
const OPT_BULLET = /^\s*(?:[•\-\*○●□■☐◻▢◯◦▪]|\(\s*\)|\[\s*\])\s*(.+)$/;
const OPT_TRAILING = /^(.+?)(?:\s*\.{3,}\s*|\s+\(|\s+\[|\t+\s*)(\d{1,3})\s*[)\]]?\s*$/;
const INSTRUCTION = /^\s*(?:\[[^\]]+\]|\([^)]+\)|<[^>]+>)\s*$|^\s*(?:PROGRAMMER(?:'S)?\s+NOTE|PROG(?:RAMMER)?\s*[:.]|PN\s*:|INTERVIEWER|INSTRUCTION|NOTE\s*:|ASK\s+(?:ALL|IF|ONLY|THOSE|Q\w+)|SHOW\s+(?:IF|ONLY)|DISPLAY\s+(?:IF|ONLY)|BASE\s*:|FILTER\s*:|IF\s+.+(?:SKIP|GO|CONTINUE|TERMINATE|ASK)|SKIP\s+TO|GO\s+TO|TERMINATE|RANDOMI[SZ]E|ROTATE|SINGLE\s+(?:CODE|ANSWER|RESPONSE|SELECT)|MULTI(?:PLE)?\s+(?:CODE|ANSWER|RESPONSE|SELECT)|SELECT\s+(?:ONE|ALL)|HIDDEN)\b/i;
const HEADING = /^\s*(?:section|part|block|module|chapter)\s+[\w.-]+\s*(?:[:.–—-]\s*(.*))?$/i;
const PAGE_BREAK = /^\s*(?:[-=_*~]{3,}|\[?\s*(?:page\s*break|new\s*page|next\s*(?:page|screen)|screen\s*break)\s*\]?)\s*$/i;

export function readDocument(blocks: DocBlock[], meta: { fileName: string; format: SourceFormat; fingerprint: string; title?: string }): CanonicalSurvey {
  const issues: Issue[] = [];
  const drafts: Draft[] = [];
  const blockTitles: (string | undefined)[] = [undefined];
  let block = 0, page = 0;
  // a document that marks its own page breaks is paginated by them; one that does not gets one question per page
  let explicitPages = blocks.some((b) => b.kind === "para" && (!!b.pageBreakBefore || PAGE_BREAK.test(b.text)));
  let cur = null as Draft | null;
  let pending: string[] = [];
  let pendingBreak = false;
  let free: string[] = []; // unmarked lines after a question, before we know what they are
  let title = meta.title;
  let auto = 0;

  const flushFree = () => {
    if (!cur || !free.length) { free = []; return; }
    const d = cur;
    // two or more short unmarked lines are options; otherwise they continue the question text
    if (free.length >= 2 && free.every((l) => l.length <= 70 && !/\?\s*$/.test(l))) {
      for (const l of free) addOption(d, l, String(d.q.options.length + 1), true);
    } else d.q.text = `${d.q.text} ${free.join(" ")}`.trim();
    free = [];
  };
  const startQuestion = (code: string | null, text: string) => {
    flushFree();
    if (cur) finishDraft(cur);
    if (pendingBreak) { page++; pendingBreak = false; }
    const id = code ?? `Q${++auto}`;
    const q: CanonicalQuestion = { sourceId: id, variable: id, code: id, text: text.trim(), kind: "unknown", sourceType: "document", options: [], rows: [], required: true, validation: [], skips: [], custom: [], confidence: "high", notes: code ? [] : ["numbered by the import — the document gave no code"] };
    cur = { q, instructions: [...pending], optionNotes: new Map(), block, page, typeSaid: false };
    pending = [];
    drafts.push(cur);
    if (!explicitPages) page++; // one question per page unless the document says otherwise
  };
  const addOption = (d: Draft, raw: string, code: string, unmarked = false) => {
    let label = raw.trim();
    const notes: string[] = [];
    // annotations in brackets at the end: (SKIP TO Q10) [EXCLUSIVE] → TERMINATE
    for (;;) {
      const m = /\s*(?:\[([^\]]+)\]|\(([^)]*(?:skip|go\s*to|terminat|end|exclusive|anchor|specify|close|thank|screen|continue|ask|fix)[^)]*)\)|(?:→|->|=>)\s*(.+))\s*$/i.exec(label);
      if (!m || m.index === 0) break;
      notes.push((m[1] ?? m[2] ?? m[3]).trim());
      label = label.slice(0, m.index).trim();
    }
    const t = /^(.+?)\s*(?:\.{3,}|\t+)\s*(\d{1,3})$/.exec(label) ?? /^(.+?)\s+\((\d{1,3})\)$/.exec(label);
    if (t) { label = t[1].trim(); code = t[2]; }
    const o: CanonicalOption = { sourceId: code, code: /^\d+$/.test(code) ? Number(code) : code, label };
    if (/\b(?:please\s+specify|specify|other\s*[:(]|other\s*$|write\s+in)\b/i.test(label) || notes.some((n) => /specify|open/i.test(n))) o.otherSpecify = true;
    if (/^(?:none(?: of (?:these|the above))?|don'?t know|not sure|prefer not to (?:say|answer)|refused|no answer)\b/i.test(label) || notes.some((n) => /exclusive|single|only/i.test(n))) o.exclusive = true;
    if (notes.some((n) => /anchor|fix(?:ed)?\b/i.test(n))) o.anchor = true;
    d.optionNotes.set(d.q.options.length, notes);
    d.q.options.push(o);
    if (unmarked) d.q.confidence = worst(d.q.confidence, "review");
  };

  let inferredTable = false;
  for (const b of blocks) {
    if (b.kind === "table") {
      flushFree();
      if (cur && !cur.table && b.rows.length >= 2) { cur.table = b.rows; continue; }
      inferredTable = true;
      issues.push({ location: `table (${b.rows.length} rows)`, type: "ambiguous", severity: "low", message: "A table not attached to a question was skipped.", autoAttempted: false });
      continue;
    }
    const line = b.text.trim();
    if (!line) continue;
    if (b.pageBreakBefore && drafts.length) { pendingBreak = true; explicitPages = true; }
    if (PAGE_BREAK.test(line)) { flushFree(); pendingBreak = true; explicitPages = true; continue; }
    if (!title && !drafts.length && (b.style?.startsWith("title") || b.style === "heading 1") && !Q_START.test(line)) { title = line; continue; }

    const heading = (b.style?.startsWith("heading") || HEADING.test(line) || (/^[A-Z0-9 &/,'’:–—-]{6,60}$/.test(line) && /[A-Z]{4}/.test(line) && !INSTRUCTION.test(line))) && !/\?\s*$/.test(line) && !Q_START_NOPUNCT.test(line);
    const qm = Q_START.exec(line) ?? Q_START_NOPUNCT.exec(line);
    const isPureNumber = !!qm && /^\d+$/.test(qm[1]);
    const inOptions = !!cur && (cur as Draft).q.options.length > 0;
    const optionSeq = !!cur && isPureNumber && Number(qm![1]) === (cur as Draft).q.options.length + 1;
    const listItem = b.list;

    // a question: a code with a letter (Q5), or a numbered line that reads like a question
    const looksQuestion = !!qm && /[A-Za-z]/.test(qm[2]) && (!isPureNumber || (!optionSeq && (/\?\s*$/.test(qm[2]) || qm[2].length > 60 || !cur)) || (isPureNumber && !cur));
    if (heading && !looksQuestion) {
      flushFree();
      if (cur) { finishDraft(cur); cur = null; }
      block++; blockTitles[block] = (HEADING.exec(line)?.[1] || line).replace(/\s+/g, " ").trim();
      if (!explicitPages) page++;
      continue;
    }
    if (looksQuestion && !(listItem && listItem.level > 0)) { startQuestion(qCode(qm![1]), qm![2]); continue; }
    if (INSTRUCTION.test(line) && !(inOptions && OPT_NUM.test(line))) {
      flushFree();
      if (cur && !/^\s*ASK\s+(?:IF|ONLY)|^\s*(?:SHOW|DISPLAY)\s+(?:IF|ONLY)|^\s*BASE\s*:/i.test(line)) (cur as Draft).instructions.push(line);
      else pending.push(line);
      continue;
    }
    if (cur) {
      const d = cur as Draft;
      let m: RegExpExecArray | null;
      if (listItem && (listItem.level > 0 || d.q.text)) { flushFree(); addOption(d, line, String(listItem.index)); continue; }
      if ((m = OPT_NUM.exec(line))) { flushFree(); addOption(d, m[2], m[1]); continue; }
      if ((m = OPT_LETTER.exec(line)) && (d.q.options.length || /^[aA]$/.test(m[1]))) { flushFree(); addOption(d, m[2], m[1].toLowerCase()); continue; }
      if ((m = OPT_BULLET.exec(line))) { flushFree(); addOption(d, m[1], String(d.q.options.length + 1)); continue; }
      if ((m = OPT_TRAILING.exec(line)) && m[1].length < 80) { flushFree(); addOption(d, m[1], m[2]); continue; }
      if (inOptions && line.length <= 70 && !/\?\s*$/.test(line)) { addOption(d, line, String(d.q.options.length + 1), true); continue; }
      free.push(line);
      continue;
    }
    // before the first question: an introduction
    if (!drafts.length && !title && line.length < 100) { title = line; continue; }
    pending.push(line);
  }
  flushFree();
  if (cur) finishDraft(cur);
  void inferredTable;

  /* ------------------------------------------------------------ type inference */
  for (const d of drafts) inferType(d, issues);

  /* ------------------------------------------------------------ logic, now every question exists */
  const byCode = new Map(drafts.map((d) => [d.q.sourceId.toUpperCase(), d.q]));
  for (const [i, d] of drafts.entries()) readInstructions(d, drafts[i + 1]?.q, byCode, issues);

  /* ------------------------------------------------------------ flow */
  const flow: CFlow[] = [];
  const byBlock = new Map<number, Draft[]>();
  for (const d of drafts) (byBlock.get(d.block) ?? byBlock.set(d.block, []).get(d.block)!).push(d);
  for (const [bi, ds] of [...byBlock.entries()].sort((a, c) => a[0] - c[0])) {
    const pages: string[][] = [];
    let lastPage = -1;
    for (const d of ds) { if (d.page !== lastPage) { pages.push([]); lastPage = d.page; } pages[pages.length - 1].push(d.q.sourceId); }
    flow.push({ t: "block", sourceId: `block_${bi}`, title: blockTitles[bi], pages });
  }
  if (!explicitPages && drafts.length > 1) issues.push({ location: "pages", type: "inferred", severity: "info", message: "The document marks no page breaks, so each question was given its own page.", suggestion: "Join pages in Architect where questions belong together.", autoAttempted: true });
  if (!drafts.length) issues.push({ location: meta.fileName, type: "parse", severity: "high", message: "No questions were recognised in the document.", suggestion: "Questions are recognised by a code at the start of the line (Q1., S2), Question 3:) followed by the options on their own lines.", autoAttempted: true });

  return {
    source: { platform: "document", format: meta.format, fileName: meta.fileName, title, fingerprint: meta.fingerprint },
    questions: drafts.map((d) => d.q), flow, embedded: [], quotas: [], custom: [], issues,
  };
}

function worst(a: CanonicalQuestion["confidence"], b: CanonicalQuestion["confidence"]): CanonicalQuestion["confidence"] {
  const order = ["confirmed", "high", "review", "ambiguous", "unsupported"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

function finishDraft(d: Draft) { d.q.text = d.q.text.replace(/\s+/g, " ").trim(); }

/* ------------------------------------------------------------ type */

const TYPE_WORDS: [RegExp, CanonicalKind][] = [
  [/\b(?:select|choose|tick|check|mark|circle|code)\s+(?:all|any|as many)\b|\bmulti(?:ple)?[\s-]*(?:code|choice|select|response|answer|punch)\b|\[\s*multi\s*\]|\bmultiple answers?\s+(?:allowed|possible)\b/i, "multi"],
  [/\b(?:select|choose|tick|check|mark|circle|code)\s+(?:one|only one|a single)\b|\bsingle[\s-]*(?:code|choice|select|response|answer|punch)\b|\bone answer only\b/i, "single"],
  [/\bdrop[\s-]*down\b/i, "dropdown"],
  [/\brank\b|\branking\b|\bin order of (?:preference|importance)\b/i, "ranking"],
  [/\b(?:0|zero)\s*(?:-|to|–)\s*10\b.*\b(?:recommend|likely)\b|\bnet promoter\b|\bNPS\b/i, "nps"],
  [/\b(?:grid|matrix)\b|\brate each\b|\bfor each of the following\b|\beach of the following\b.*\b(?:rate|agree|scale)\b/i, "matrix_single"],
  [/\bslider\b/i, "slider"],
  [/\b(?:allocate|distribute)\b.*\b(?:points|percent|100)\b|\bconstant sum\b|\badd(?:s)? up to 100\b/i, "constant_sum"],
  [/\be-?mail\b.*\baddress\b|\byour e-?mail\b/i, "email"],
  [/\b(?:date of birth|what date|which date|\[date\])\b/i, "date"],
  [/\bhow many\b|\bhow much\b|\bhow old\b|\bnumber of\b|\b(?:your )?age\b.*\?|\[\s*(?:numeric|number)\s*\]|\bnumeric\b|\benter (?:a )?number\b|\bin years\b/i, "numeric"],
  [/\b(?:open[\s-]*(?:end(?:ed)?|text)|verbatim|in your own words|please (?:describe|explain|tell us)|why do you say)\b|\[\s*(?:open|text)\s*\]/i, "textarea"],
  [/\bhidden\s+(?:variable|question)\b|\[\s*hidden\s*\]|\bdummy\s+variable\b|\bdo not show\b.*\brespondent/i, "hidden"],
];

function inferType(d: Draft, issues: Issue[]) {
  const q = d.q;
  const said = [q.text, ...d.instructions].join(" \n ");
  let kind: CanonicalKind | null = null;
  let basis = "";
  for (const [re, k] of TYPE_WORDS) if (re.test(said)) { kind = k; basis = said.match(re)?.[0] ?? ""; d.typeSaid = true; break; }
  const hasOpts = q.options.length > 0;
  if (d.table && d.table.length >= 2) {
    // a grid: the header row is the scale, the first column the statements
    const header = d.table[0].slice(1).map((c) => c.trim()).filter(Boolean);
    const rows = d.table.slice(1).map((r) => r[0]?.trim()).filter(Boolean);
    if (header.length >= 2 && rows.length >= 1) {
      q.rows = rows.map((label, i): CanonicalRow => ({ sourceId: `r${i + 1}`, code: `r${i + 1}`, label }));
      if (!hasOpts) q.options = header.map((label, i): CanonicalOption => ({ sourceId: String(i + 1), code: i + 1, label }));
      q.kind = kind === "multi" ? "matrix_multi" : "matrix_single";
      q.notes.push("a grid read from a table: the header row is the scale, the first column the statements");
      return;
    }
  }
  if (kind === "hidden") { q.kind = "hidden"; q.required = false; q.notes.push(`marked hidden (“${basis}”)`); return; }
  if (kind === "matrix_single" && !hasOpts) { kind = null; }
  if (kind && ["numeric", "email", "date", "textarea", "nps", "slider"].includes(kind) && hasOpts && kind !== "nps") {
    // "How many…" with listed ranges is a single choice over the ranges
    q.notes.push(`reads like ${kind} (“${basis}”) but lists options — kept as a choice`);
    kind = q.options.length && /select|tick|choose/.test(said) ? kind : "single";
    q.confidence = worst(q.confidence, "review");
  }
  if (!kind) {
    if (hasOpts) { kind = "single"; q.notes.push("single choice: options are listed and no instruction says otherwise"); q.confidence = worst(q.confidence, q.options.length > 1 ? "high" : "review"); }
    else if (/\?\s*$/.test(q.text) || q.text.length > 20) { kind = "textarea"; q.notes.push("open end: no options and no type instruction"); q.confidence = worst(q.confidence, "review"); }
    else { kind = "descriptive"; q.notes.push("read as text shown to the respondent (no options, not a question)"); q.required = false; q.confidence = worst(q.confidence, "review"); }
  } else q.notes.push(`${kind.replace("_", " ")}: “${basis.trim()}”`);
  if (kind === "matrix_single" && hasOpts && !q.rows.length) { kind = "single"; }
  if (kind === "multi" && !hasOpts) { q.confidence = worst(q.confidence, "ambiguous"); issues.push({ location: q.sourceId, type: "ambiguous", severity: "medium", message: `${q.sourceId} says “${basis.trim()}” but lists no options.`, suggestion: "Add its options in Studio.", autoAttempted: true, refs: [q.sourceId] }); }
  if (kind === "nps") q.options = [];
  q.kind = kind;
  if (/\brandomi[sz]e|\brotate\b/i.test(said)) q.randomizeOptions = true;
  if (/\bnot required\b|\boptional\b/i.test(said)) q.required = false;
  const range = /\b(?:between|from)\s+(\d+)\s+(?:and|to|-)\s+(\d+)\b|\brange\s*[:=]?\s*(\d+)\s*[-–]\s*(\d+)|\b(?:numeric|number|integer|whole number)\b\W{0,3}(\d+)\s*[-–]\s*(\d+)\b/i.exec(said);
  if (range && (q.kind === "numeric" || q.kind === "slider")) { const lo = Number(range[1] ?? range[3] ?? range[5]), hi = Number(range[2] ?? range[4] ?? range[6]); const v: CanonicalValidation[] = [{ kind: "min_value", value: lo }, { kind: "max_value", value: hi }]; q.validation.push(...v); }
  const maxSel = /\b(?:up to|maximum of|max(?:imum)?|no more than)\s+(\d+)\b/i.exec(said);
  if (maxSel && q.kind === "multi") q.validation.push({ kind: "max_selections", value: Number(maxSel[1]) });
  if (q.kind === "descriptive") q.required = false;
}

/* ------------------------------------------------------------ logic */

/** "ASK IF …", "SKIP TO …", per-option "(SKIP TO Q10)" / "TERMINATE" — resolved against the real questions */
function readInstructions(d: Draft, next: CanonicalQuestion | undefined, byCode: Map<string, CanonicalQuestion>, issues: Issue[]) {
  const q = d.q;
  const conds: CExpr[] = [];
  for (const ins of d.instructions) {
    const text = ins.replace(/^[[(<]\s*|\s*[\])>]$/g, "").trim();
    let m: RegExpExecArray | null;
    // display: ASK IF / SHOW IF / BASE: / ASK Qx ONLY IF / ask only for respondents who …
    if ((m = /^(?:ASK|SHOW|DISPLAY)\s+(?:(?:Q\w+)\s+)?(?:ONLY\s+)?(?:IF|WHEN|TO|FOR)\s+(.+)$/i.exec(text)) || (m = /^(?:BASE|FILTER)\s*:\s*(.+)$/i.exec(text)) || (m = /^IF\s+(.+?)\s*,?\s*(?:THEN\s+)?(?:ASK|SHOW)\b.*$/i.exec(text))) {
      const body = m[1].replace(/^(?:all\s+)?(?:respondents?|those|people|participants|anyone)\s+(?:who|that|with)\s+/i, "");
      if (/^all\b/i.test(body.trim())) continue;
      const e = resolveCondition(body, q, byCode, `${q.sourceId} · “${text}”`, issues);
      if (e) conds.push(e);
      continue;
    }
    // skip: IF Q5 = NO, SKIP TO Q10 / If No, skip to Q10 / otherwise go to Q8
    if ((m = /^(?:IF\s+(.+?)\s*[,:]?\s*)?(?:SKIP|GO|JUMP|CONTINUE|PROCEED)\s+(?:TO|ON\s+TO)\s+(Q?\w+|END|THE END)\b.*$/i.exec(text))) {
      const to = skipTarget(m[2], byCode);
      if (!to) { issues.push({ location: `${q.sourceId} · “${text}”`, type: "reference", severity: "medium", message: `${q.sourceId} says to skip to “${m[2]}”, which is not a question in the document.`, autoAttempted: true, refs: [q.sourceId] }); continue; }
      if (!m[1]) {
        if (to.kind === "question" && next && to.id === next.sourceId) continue; // "continue to the next question"
        issues.push({ location: `${q.sourceId} · “${text}”`, type: "ambiguous", severity: "medium", message: `${q.sourceId} says “${text}” without saying when.`, suggestion: "Add the condition in Skip logic.", autoAttempted: false, refs: [q.sourceId] });
        continue;
      }
      if (to.kind === "question" && next && to.id === next.sourceId) continue; // "If Yes, continue to Q6" is the default path
      const e = resolveCondition(m[1], q, byCode, `${q.sourceId} · “${text}”`, issues);
      if (e) q.skips.push({ when: e, to, label: text });
      continue;
    }
    if ((m = /^IF\s+(.+?)\s*[,:]?\s*(?:THANK\s+AND\s+)?(?:TERMINATE|END|CLOSE|SCREEN\s*OUT|DISQUALIFY)\b/i.exec(text))) {
      const e = resolveCondition(m[1], q, byCode, `${q.sourceId} · “${text}”`, issues);
      if (e) q.skips.push({ when: e, to: { kind: "end", status: "screened" }, label: text });
      continue;
    }
  }
  if (conds.length) q.displayLogic = conds.length === 1 ? conds[0] : { t: "group", op: "and", children: conds };
  // option annotations: (SKIP TO Q10), (TERMINATE), → Q8
  for (const [i, notes] of d.optionNotes) {
    const o = q.options[i];
    for (const n of notes) {
      let m: RegExpExecArray | null;
      const when: CExpr = { t: "cmp", ref: { kind: "question", id: q.sourceId, choice: o.sourceId }, op: "selected" };
      if (/terminat|screen\s*out|disqualif|thank\s+and\s+(?:end|close)|^close\b/i.test(n)) q.skips.push({ when, to: { kind: "end", status: "screened" }, label: `${o.label}: ${n}` });
      else if ((m = /(?:skip|go|jump|continue)\s*(?:to)?\s+(Q?\w+)|^(Q\w+)$/i.exec(n))) {
        const to = skipTarget(m[1] ?? m[2], byCode);
        if (to && !(to.kind === "question" && next && to.id === next.sourceId)) q.skips.push({ when, to, label: `${o.label}: ${n}` });
        else if (!to) issues.push({ location: `${q.sourceId} · option ${o.code}`, type: "reference", severity: "medium", message: `Option “${o.label}” says “${n}”, which names no question in the document.`, autoAttempted: true, refs: [q.sourceId] });
      }
    }
  }
  if (q.skips.length || q.displayLogic) q.notes.push("logic read from the document's instructions");
}

function skipTarget(word: string, byCode: Map<string, CanonicalQuestion>): { kind: "question"; id: string } | { kind: "end"; status: "complete" } | null {
  if (/^(?:the\s+)?end$/i.test(word)) return { kind: "end", status: "complete" };
  const code = word.toUpperCase().startsWith("Q") || byCode.has(word.toUpperCase()) ? word.toUpperCase() : `Q${word}`;
  const q = byCode.get(code) ?? byCode.get(word.toUpperCase());
  return q ? { kind: "question", id: q.sourceId } : null;
}

const OPS: [RegExp, COp][] = [
  [/^(?:=|==|is|equals|is equal to|was|chose|selected|said|answered)$/i, "eq"],
  [/^(?:!=|<>|is not|isn't|not|does not equal|did not (?:choose|select))$/i, "ne"],
  [/^>=$|^at least$/i, "gte"], [/^<=$|^at most$/i, "lte"], [/^>$|^(?:greater|more|older) than$/i, "gt"], [/^<$|^(?:less|fewer|younger) than$/i, "lt"],
];

/**
 * A condition in words → CExpr, or null with an issue when it names
 * something the document does not define. Understands:
 *   Q5 = 1 · Q5 = Yes · Q5 = 1 OR 2 · Q5 = 1-3 · Q5 IS NOT 2 · Q3 > 17 · Q3 answered
 *   selected Product A in Q10 · answered Yes to Q3 · chose code 2 at Q7
 *   Yes / No / code 3 (about the question itself)
 */
export function resolveCondition(textIn: string, self: CanonicalQuestion, byCode: Map<string, CanonicalQuestion>, location: string, issues: Issue[]): CExpr | null {
  const text = textIn.trim().replace(/[.;]+$/, "");
  const ambiguous = (reason: string): null => {
    issues.push({ location, type: "ambiguous", severity: "high", message: `Logic cannot be determined with certainty: ${reason}`, suggestion: "Say which question and answer define it, then add the rule in Studio — or ask Intelligent mode.", autoAttempted: true, refs: [self.sourceId] });
    self.confidence = "ambiguous";
    return null;
  };
  // top-level AND / OR between whole conditions (each side must name a question)
  const split = /\s+(AND|OR)\s+(?=(?:Q\w+|NOT\b|\(|(?:selected|answered|chose)\b))/i.exec(text);
  if (split) {
    const left = resolveCondition(text.slice(0, split.index), self, byCode, location, issues);
    const right = resolveCondition(text.slice(split.index + split[0].length), self, byCode, location, issues);
    if (!left || !right) return null;
    return { t: "group", op: split[1].toLowerCase() as "and" | "or", children: [left, right] };
  }
  const optionOf = (q: CanonicalQuestion, v: string): CanonicalOption | null => {
    const w = v.replace(/^["“'‘(]+|["”'’)]+$/g, "").replace(/^(?:code|option|answer|choice)\s+/i, "").trim();
    return q.options.find((o) => String(o.code).toLowerCase() === w.toLowerCase())
      ?? q.options.find((o) => o.label.toLowerCase() === w.toLowerCase())
      ?? q.options.find((o) => o.label.toLowerCase().startsWith(w.toLowerCase()) && w.length >= 3)
      ?? null;
  };
  const cmpOn = (q: CanonicalQuestion, opWord: string, rhs: string): CExpr | null => {
    const op = OPS.find(([re]) => re.test(opWord.trim()))?.[1] ?? "eq";
    const values = rhs.split(/\s*(?:,|\bor\b|\/)\s*/i).map((s) => s.trim()).filter(Boolean);
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(rhs.trim());
    if (q.options.length) {
      const codes: (string | number)[] = [];
      if (range) for (let c = Number(range[1]); c <= Number(range[2]); c++) { const o = optionOf(q, String(c)); if (o) codes.push(o.sourceId); }
      else for (const v of values) { const o = optionOf(q, v); if (!o) return ambiguous(`${q.sourceId} has no option “${v}” (in “${text}”).`); codes.push(o.sourceId); }
      if (!codes.length) return ambiguous(`no option of ${q.sourceId} matches “${rhs}”.`);
      const one = (c: string | number): CExpr => ({ t: "cmp", ref: { kind: "question", id: q.sourceId, choice: String(c) }, op: op === "ne" ? "notSelected" : "selected" });
      return codes.length === 1 ? one(codes[0]) : { t: "group", op: op === "ne" ? "and" : "or", children: codes.map(one) };
    }
    const num = Number(rhs);
    if (Number.isFinite(num) && rhs.trim() !== "") return { t: "cmp", ref: { kind: "question", id: q.sourceId }, op, value: num };
    if (range && (op === "eq")) return { t: "group", op: "and", children: [{ t: "cmp", ref: { kind: "question", id: q.sourceId }, op: "gte", value: Number(range[1]) }, { t: "cmp", ref: { kind: "question", id: q.sourceId }, op: "lte", value: Number(range[2]) }] };
    return { t: "cmp", ref: { kind: "question", id: q.sourceId }, op, value: rhs.replace(/^["“']|["”']$/g, "") };
  };
  const q = (code: string) => byCode.get(code.toUpperCase());
  let m: RegExpExecArray | null;
  if ((m = /^(Q\w+)\s*(?:IS\s+|WAS\s+|HAS\s+BEEN\s+)?(ANSWERED|NOT ANSWERED|UNANSWERED|BLANK)$/i.exec(text))) {
    const t = q(m[1]); if (!t) return ambiguous(`${m[1]} is not a question in the document.`);
    return { t: "cmp", ref: { kind: "question", id: t.sourceId }, op: /not|un|blank/i.test(m[2]) ? "unanswered" : "answered" };
  }
  if ((m = /^(Q\w+)\s*(=|==|!=|<>|>=|<=|>|<|\bis not\b|\bisn't\b|\bis\b|\bequals\b|\bwas\b)\s*(.+)$/i.exec(text))) {
    const t = q(m[1]); if (!t) return ambiguous(`${m[1]} is not a question in the document.`);
    return cmpOn(t, m[2], m[3]);
  }
  if ((m = /^(?:NOT\s+)?(?:selected|chose|picked|ticked|coded|answered|said|mentioned)\s+(.+?)\s+(?:in|at|to|for|on)\s+(Q\w+)$/i.exec(text))) {
    const t = q(m[2]); if (!t) return ambiguous(`${m[2]} is not a question in the document.`);
    return cmpOn(t, /^NOT\s/i.test(text) ? "not" : "=", m[1]);
  }
  if ((m = /^(Q\w+)\s+(?:is\s+)?(?:code[sd]?|option|answer)\s+(.+)$/i.exec(text))) {
    const t = q(m[1]); if (!t) return ambiguous(`${m[1]} is not a question in the document.`);
    return cmpOn(t, "=", m[2]);
  }
  // about the question itself: "If No, …", "if code 3 …"
  if (self.options.length && (m = /^(?:NOT\s+)?(?:code\s+|answer\s+|option\s+)?(.+)$/i.exec(text)) && optionOf(self, m[1])) return cmpOn(self, /^NOT\s/i.test(text) ? "not" : "=", m[1]);
  const mentions = text.match(/\bQ\d+\w*\b/gi);
  if (!mentions) return ambiguous(`the document says “${text}”, but no question or answer in it defines that.`);
  return ambiguous(`“${text}” could not be read as a condition on ${mentions.join(", ")}.`);
}

export type { CRef };
