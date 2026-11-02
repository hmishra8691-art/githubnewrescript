import type { CanonicalQuestion, CanonicalDynamic, CanonicalEmbeddedField, CLoop, Issue, PendingInstruction } from "../canonical.js";

/**
 * DYNAMIC LISTS, LOOPS AND PIPING, READ FROM A QUESTIONNAIRE'S OWN WORDS (2026-11-02).
 *
 * ## The gap this closes
 *
 * The document reader turned "ASK IF Q3 = 1" and "IF Q5 = 2 SKIP TO Q9" into logic, and nothing else a programmer
 * writes beside a question. "CARRY FORWARD BRANDS SELECTED AT Q1" was dropped without a word (it contains no IF or
 * ONLY, so not even the unread-instruction report saw it); "SHOW ONLY BRANDS NOT SELECTED AT Q2" was reported as
 * unread; "ASK FOR EACH BRAND SELECTED AT Q1" was read as a broken display condition; "[INSERT ANSWER FROM Q1]" and
 * "[BRAND]" stayed in the question text as brackets. A carried-forward question, having no options of its own, was
 * then typed as an open end.
 *
 * ## What is read now — as the native features, never as text
 *
 *   carry forward      "CARRY FORWARD BRANDS SELECTED AT Q1", "SHOW ONLY BRANDS SELECTED AT Q2", "only show the
 *                      supermarkets they picked in the previous question", "MASK TO Q1 SELECTED"
 *                      → question.carryForward { source, selected }
 *   masking            "SHOW ONLY BRANDS NOT SELECTED AT Q2", "MASK OUT WHATEVER THEY CHOSE IN Q1", "EXCLUDE …"
 *                      → carryForward { source, not selected }
 *   the same list      "SAME LIST AS Q1", "USE THE SAME ANSWER LIST AS Q1" → carryForward { source, all } (codes kept)
 *   a loop             "ASK FOR EACH BRAND SELECTED AT Q1", "REPEAT THIS QUESTION FOR EVERY SUPERMARKET SELECTED IN
 *                      Q1", "ASK THE SAME QUESTION FOR EVERY SELECTED BRAND" — consecutive questions with the same
 *                      source become one loop block over the source's selected answers
 *   the current item   "[BRAND]", "<BRAND>", "{BRAND}", "[INSERT BRAND]", "[THIS BRAND]", "[ITEM]" in a looped
 *                      question → {{loop.label}}
 *   an earlier answer  "[INSERT ANSWER FROM Q1]", "[INSERT Q4]", "[Q5 ANSWER]", "[PIPE Q2]", "{Q4}", "<Q4>" in a
 *                      question's text, its options or its instruction → {{@Q1}} (the mapper makes it {{CODE}})
 *   an embedded field  "[INSERT REGION]" when REGION is a field the document stores → {{ed.REGION}}
 *
 * "The previous question" / "the question above" resolve to the question before; a loop that names no question
 * ("for every selected brand") takes the nearest earlier multi-choice question. Those are marked `inferred` and
 * the reconstruction report asks the researcher to confirm them. An instruction that reads like a dynamic list but
 * names nothing this reader can resolve ("only show the supermarkets they like") becomes a question for the
 * researcher (clarify.ts), with the alternatives the survey allows — never a guess, never dropped.
 *
 * Every instruction used here is removed from the question's instruction list, so the unread-instruction report
 * does not repeat it.
 */

export interface DynDraft { q: CanonicalQuestion; instructions: string[]; block: number; page: number; loop?: DynLoop }
export interface DynLoop { key: string; loop: CLoop; noun: string; members: string[] }

const CODE = /\b(Q\w+|[A-Z]{1,4}\d[\w.]*)\b/gi;
const CHOICE_KINDS = new Set(["single", "multi", "dropdown", "multi_dropdown"]);
const PREVIOUS = /\b(?:the\s+)?(?:previous|prior|preceding|last|above|earlier)\s+(?:question|one|q\b)|\bquestion\s+(?:above|before)\b/i;
const VERB_PICKED = String.raw`(?:selected|chosen|chose|picked|ticked|mentioned|named|choose|selects?|picks?|ticks?|mentions?|use[sd]?|bought|purchased|aware\s+of)`;

const clean = (t: string) => t.replace(/^[[(<]\s*|\s*[\])>]$/g, "").trim().replace(/^(?:programmer(?:'s)?\s*(?:note|instruction)?|prog|pn|instruction|note)\s*[:\-–]\s*/i, "").trim();
const singular = (w: string) => w.toLowerCase().replace(/ies$/, "y").replace(/(?<=[^s])s$/, "");

/** the source a dynamic instruction names: a code the document defines before this question, or "the previous question" */
function sourceOf(text: string, i: number, drafts: DynDraft[], byCode: Map<string, CanonicalQuestion>): { q: CanonicalQuestion; inferred: boolean } | null {
  const own = drafts[i].q.sourceId.toUpperCase();
  for (const m of text.matchAll(CODE)) {
    const q = byCode.get(m[1].toUpperCase());
    if (q && q.sourceId.toUpperCase() !== own) return { q, inferred: false };
  }
  if (PREVIOUS.test(text) && i > 0) return { q: drafts[i - 1].q, inferred: true };
  return null;
}

/** the nearest earlier question with options a respondent picks several of — what "every selected brand" refers to */
function nearestMulti(i: number, drafts: DynDraft[]): CanonicalQuestion | null {
  for (let j = i - 1; j >= 0; j--) { const q = drafts[j].q; if ((q.kind === "multi" || q.kind === "multi_dropdown") && q.options.length) return q; }
  return null;
}

type Kind = "loop" | "mask" | "same_list" | "carry_forward";
/** what an instruction asks for, by its words — or null when it is not about a dynamic list at all */
function kindOf(t: string): Kind | null {
  if (/\b(?:ask|repeat|loop|cycle|show)\b[^.]*\b(?:for|per)\s+(?:each|every|all)\b|\bfor\s+(?:each|every)\s+(?:\w+\s+){0,2}(?:selected|chosen|picked|ticked|mentioned)\b|^\s*(?:start\s+)?loop\b|\bsame\s+question\s+for\s+(?:each|every)\b/i.test(t)) return "loop";
  if (new RegExp(String.raw`\bnot\s+${VERB_PICKED}|\bunselected\b|\bmask\s+out\b|\bexclud\w*\b|\bremov\w*\b[^.]*\b${VERB_PICKED}|\bhide\b[^.]*\b${VERB_PICKED}|\bwhatever\s+(?:they|was)\s+${VERB_PICKED}\b[^.]*\b(?:mask|hid|remov|exclud)`, "i").test(t) || /\bmask\s+out\b/i.test(t)) return "mask";
  if (/\bsame\s+(?:answer\s+|option\s+|code\s+)?(?:list|options|codes|answers|brands|items|categories)\b|\buse\s+(?:the\s+)?(?:\w+\s+){0,2}(?:list|options|codes)\s+(?:from|of|in|at|as)\b|\b(?:repeat|copy|reuse)\s+(?:the\s+)?(?:answer\s+|option\s+)?(?:list|options|codes)\b/i.test(t)) return "same_list";
  if (new RegExp(String.raw`\bcarry\s*(?:forward|over|fwd)\b|\bcarried\s+forward\b|\bmask(?:ed)?\s+(?:to|by|on|based)\b|\b(?:show|display|list|include|offer)\s+(?:only\s+)?(?:the\s+)?(?:\w+\s+){0,3}(?:${VERB_PICKED}|they\s+${VERB_PICKED}|that\s+(?:were|was)\s+${VERB_PICKED})\b|\bonly\s+(?:show|display|list)\b[^.]*\b${VERB_PICKED}\b|\bpipe\s+(?:in\s+)?(?:the\s+)?(?:list|options|brands|items|answers)\b`, "i").test(t)) return "carry_forward";
  return null;
}
/** an instruction that reads like a dynamic list but that no rule above understood ("only show the brands they like") */
const LOOKS_DYNAMIC = /\b(?:only\s+show|show\s+only|carry|mask|pipe|for\s+(?:each|every)|same\s+list|previous(?:ly)?\s+(?:selected|chosen)|they\s+(?:like|prefer|use|know))\b/i;

/** the noun of a loop: "for each BRAND selected" → brand; "for every supermarket" → supermarket */
const nounOf = (t: string) => /\bfor\s+(?:each|every)\s+(?:selected\s+|chosen\s+)?([a-z][\w'-]*)/i.exec(t)?.[1] ?? "item";

/** the instructions: carry forward, masks, the same list, loops — run BEFORE the logic reader, which then never sees them */
export function readDynamicInstructions(drafts: DynDraft[], byCode: Map<string, CanonicalQuestion>, issues: Issue[]): { dynamics: CanonicalDynamic[]; loops: DynLoop[] } {
  const dynamics: CanonicalDynamic[] = [];
  const loops: DynLoop[] = [];
  const say = (d: CanonicalDynamic) => dynamics.push(d);

  for (const [i, d] of drafts.entries()) {
    const q = d.q;
    const keep: string[] = [];
    for (const ins of d.instructions) {
      const t = clean(ins);
      const kind = kindOf(t);
      if (!kind) {
        /* the dynamic words without anything to resolve: a decision for the researcher, with the survey's own alternatives */
        if (LOOKS_DYNAMIC.test(t) && !/\b(?:if|when|unless)\b/i.test(t) && !sourceOf(t, i, drafts, byCode)) {
          const instruction: PendingInstruction = { kind: "dynamic", text: t, questionId: q.sourceId };
          issues.push({ location: `${q.sourceId} · “${t}”`, type: "ambiguous", severity: "medium", message: `${q.sourceId} says “${t}”, which reads like a list taken from an earlier answer, but names no question it could be taken from.`, suggestion: "Say which question's answers to show (carry forward), to exclude (mask), or to repeat the question for.", autoAttempted: false, refs: [q.sourceId], instruction });
          q.confidence = q.confidence === "high" || q.confidence === "confirmed" ? "review" : q.confidence;
          continue;
        }
        keep.push(ins);
        continue;
      }
      if (kind === "loop") {
        const named = sourceOf(t, i, drafts, byCode);
        const src = named?.q ?? nearestMulti(i, drafts);
        if (!src) { keep.push(ins); issues.push({ location: `${q.sourceId} · “${t}”`, type: "ambiguous", severity: "medium", message: `${q.sourceId} is to be repeated (“${t}”), but no earlier question with several choices was found to repeat it over.`, autoAttempted: false, refs: [q.sourceId], instruction: { kind: "dynamic", text: t, questionId: q.sourceId } }); continue; }
        const noun = singular(nounOf(t));
        const key = `${src.sourceId}|selected`;
        /* consecutive questions over the same source share one loop; a question range ("Q3-Q5", "Q3 AND Q4") joins them */
        const prev = i > 0 ? drafts[i - 1].loop : undefined;
        const lp: DynLoop = prev && prev.key === key ? prev : { key, noun, members: [], loop: { kind: "question", questionId: src.sourceId, filter: "selected", loopVar: noun.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^(\d)/, "_$1") || "ITEM" } };
        if (lp !== prev) loops.push(lp);
        lp.members.push(q.sourceId);
        d.loop = lp;
        say({ feature: "loop", questionId: q.sourceId, sourceId: src.sourceId, original: t, interpretation: `${q.sourceId} is asked once for each ${noun} selected at ${src.sourceId}, its answer stored per ${noun}.`, confidence: named && !named.inferred ? "high" : "inferred" });
        continue;
      }
      const src = sourceOf(t, i, drafts, byCode);
      if (!src) {
        keep.push(ins);
        issues.push({ location: `${q.sourceId} · “${t}”`, type: "ambiguous", severity: "medium", message: `${q.sourceId} says “${t}” but names no question its list comes from.`, suggestion: "Name the question (for example “SHOW ONLY BRANDS SELECTED AT Q1”).", autoAttempted: false, refs: [q.sourceId], instruction: { kind: "dynamic", text: t, questionId: q.sourceId } });
        continue;
      }
      if (!CHOICE_KINDS.has(src.q.kind) && !src.q.carryForward) {
        keep.push(ins);
        issues.push({ location: `${q.sourceId} · “${t}”`, type: "ambiguous", severity: "medium", message: `${q.sourceId} takes its list from ${src.q.sourceId} (“${t}”), but ${src.q.sourceId} has no answers to choose from.`, autoAttempted: false, refs: [q.sourceId, src.q.sourceId] });
        continue;
      }
      const filter = kind === "mask" ? "notSelected" : kind === "same_list" ? "all" : "selected";
      const into = /^matrix/.test(q.kind) ? "rows" : "options";
      q.carryForward = { questionId: src.q.sourceId, filter, into };
      const words = filter === "selected" ? `the answers selected at ${src.q.sourceId}` : filter === "notSelected" ? `the answers of ${src.q.sourceId} that were NOT selected` : `every answer of ${src.q.sourceId}, with its codes`;
      say({ feature: kind === "mask" ? "mask" : kind === "same_list" ? "same_list" : "carry_forward", questionId: q.sourceId, sourceId: src.q.sourceId, original: t, interpretation: `${q.sourceId}'s ${into === "rows" ? "rows are" : "list is"} ${words}${filter === "all" ? "" : ", updated from the respondent's own answer"}.`, confidence: src.inferred ? "inferred" : "high" });
      q.notes.push(`${into === "rows" ? "rows" : "options"} carried from ${src.q.sourceId} (${filter === "notSelected" ? "not selected" : filter}) — read from “${t}”`);
      /* a question whose only list comes from elsewhere was typed as an open end for having none of its own */
      if (!q.options.length && !/^matrix/.test(q.kind)) {
        const said = /select\s+all|all\s+that\s+apply|multi|tick\s+all|choose\s+all|select\s+(?:any|as\s+many)/i.test(`${q.text} ${d.instructions.join(" ")}`);
        q.kind = said ? "multi" : "single";
        q.notes = q.notes.filter((n) => !/^open end/.test(n));
        for (let k = issues.length - 1; k >= 0; k--) if (issues[k].refs?.includes(q.sourceId) && /lists no options/.test(issues[k].message)) issues.splice(k, 1);
      }
    }
    d.instructions = keep;
  }
  return { dynamics, loops };
}

/** the placeholders in the words — run AFTER the logic reader, so the fields it stores can be piped */
export function rewritePlaceholders(drafts: DynDraft[], byCode: Map<string, CanonicalQuestion>, issues: Issue[], embedded: CanonicalEmbeddedField[]): CanonicalDynamic[] {
  const dynamics: CanonicalDynamic[] = [];
  const say = (d: CanonicalDynamic) => dynamics.push(d);
  /* ------------------------------------------------------------ placeholders in the words */
  const fields = new Map(embedded.map((f) => [f.name.toUpperCase(), f.name]));
  const order = new Map(drafts.map((d, i) => [d.q.sourceId.toUpperCase(), i]));
  for (const [i, d] of drafts.entries()) {
    const q = d.q;
    const nouns = d.loop ? new Set([d.loop.noun.toUpperCase(), `${d.loop.noun.toUpperCase()}S`, "ITEM", "OPTION", "ANSWER"]) : null;
    const rewrite = (s: string | undefined, where: string): string | undefined => {
      if (!s) return s;
      return s.replace(/\[([^\]\n]{1,80})\]|\{([A-Za-z][\w ]{0,40})\}|<([A-Za-z][\w ]{0,40})>/g, (whole, a?: string, b?: string, c?: string) => {
        const inner = (a ?? b ?? c ?? "").trim();
        const up = inner.toUpperCase().replace(/\s+/g, " ");
        /* the current loop item: [BRAND], [THIS BRAND], [INSERT BRAND], {BRAND} */
        const item = /^(?:INSERT\s+|PIPE\s+(?:IN\s+)?)?(?:THE\s+)?(?:THIS\s+|CURRENT\s+|SELECTED\s+|EACH\s+)?([A-Z][A-Z'-]*)$/.exec(up)?.[1];
        if (nouns && item && nouns.has(item)) {
          say({ feature: "loop_pipe", questionId: q.sourceId, sourceId: d.loop!.loop.questionId, original: whole, interpretation: `the ${d.loop!.noun} the loop is on is written in here.`, confidence: "high" });
          return "{{loop.label}}";
        }
        /* an earlier answer: [INSERT ANSWER FROM Q1], [Q5 ANSWER], [PIPE Q2], {Q4}, <Q4> */
        const ref = /^(?:INSERT|PIPE(?:\s+IN)?|SHOW|DISPLAY)?\s*(?:THE\s+)?(?:(?:ANSWER|RESPONSE|BRAND|OPTION|SELECTION|CHOICE|ITEM|TEXT|VALUE)S?\s+)?(?:(?:FROM|AT|IN|TO|GIVEN\s+AT|SELECTED\s+AT|CHOSEN\s+AT)\s+)?([A-Z]{1,4}\d[\w.]*)(?:\s+(?:ANSWER|RESPONSE|SELECTION|CHOICE|VALUE)S?)?$/.exec(up)?.[1];
        if (ref && (/^INSERT|^PIPE|ANSWER|RESPONSE|SELECTION|CHOICE|VALUE|FROM|^SHOW|^DISPLAY/.test(up) || b || c)) {
          const src = byCode_(ref);
          if (src) {
            const before = (order.get(src.sourceId.toUpperCase()) ?? 0) < i;
            say({ feature: "pipe", questionId: q.sourceId, sourceId: src.sourceId, original: whole, interpretation: `the answer given at ${src.sourceId} is written in ${where}${before ? "" : " — but it is asked later, so it is empty here"}.`, confidence: "high" });
            return `{{@${src.sourceId}}}`;
          }
        }
        /* an embedded field the document stores: [INSERT REGION] */
        const fname = /^(?:INSERT|PIPE(?:\s+IN)?)\s+(?:THE\s+)?([A-Z][\w-]*)$/.exec(up)?.[1];
        if (fname && fields.has(fname)) {
          say({ feature: "embedded_pipe", questionId: q.sourceId, original: whole, interpretation: `the stored value ${fields.get(fname)} is written in ${where}.`, confidence: "high" });
          return `{{ed.${fields.get(fname)}}}`;
        }
        /* an insertion this reader cannot resolve: kept as written, and said */
        if (/^(?:INSERT|PIPE)\b/.test(up)) {
          issues.push({ location: `${q.sourceId} · ${where}`, type: "ambiguous", severity: "medium", message: `${q.sourceId} asks to insert “${inner}” into ${where}, which names no earlier question, loop item or stored value — it is kept as written.`, suggestion: "Name the question it comes from (for example [INSERT ANSWER FROM Q2]).", autoAttempted: false, refs: [q.sourceId] });
        }
        return whole;
      });
    };
    q.text = rewrite(q.text, "the question") ?? q.text;
    if (q.instruction) q.instruction = rewrite(q.instruction, "the instruction");
    for (const o of q.options) o.label = rewrite(o.label, `option ${o.code}`) ?? o.label;
    for (const r of q.rows) r.label = rewrite(r.label, `row ${r.code}`) ?? r.label;
  }
  return dynamics;

  function byCode_(code: string): CanonicalQuestion | undefined { return byCode.get(code.toUpperCase()); }
}
