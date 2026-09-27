import type {
  CanonicalSurvey, CanonicalQuestion, CanonicalOption, CanonicalRow, CanonicalValidation, CanonicalSkip, CanonicalCustom,
  CanonicalEmbeddedField, CanonicalQuota, CFlow, CExpr, CRef, COp, CLoop, CanonicalKind, Issue,
} from "../canonical.js";
import { plainText } from "../canonical.js";

/**
 * QUALTRICS QSF → CANONICAL (§4–§9).
 *
 * A QSF is JSON: `SurveyEntry` (name, language) and `SurveyElements`, a flat
 * list tagged by `Element`:
 *
 *   SQ   one question — type, selector, text, choices, recodes, export tag,
 *        validation, display logic, skip logic, JavaScript
 *   BL   the blocks — their questions in order, "Page Break" markers, and
 *        block options (question randomization, Loop & Merge)
 *   FL   the Survey Flow — blocks, embedded data, branches, randomizers,
 *        groups, end-of-survey elements, in the order the respondent meets them
 *   QO   quotas — a condition, a limit, an action
 *
 * Everything the source identifies keeps its identity: QID15 stays QID15,
 * the export tag stays the variable name, a choice keeps its id AND its
 * recode value (the recode is what the data carries, so it becomes the
 * Rescript option code; the id is what logic refers to, so the mapper
 * translates through it).
 *
 * Logic is read into the canonical expression tree. Qualtrics writes a
 * condition as numbered sets of numbered expressions with `Conjuction`
 * (sic — the misspelling is Qualtrics') on every expression after the
 * first; AND binds tighter than OR, which is how the Qualtrics editor
 * evaluates it. An expression of a kind this adapter does not read — a
 * GeoIP rule, a device-type rule, a scoring category — becomes `raw` with
 * Qualtrics' own description, and an issue.
 */

type Json = Record<string, any>;
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as object) : []) as T[];
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const truthy = (v: unknown) => v === true || v === "true" || v === "ON" || v === 1 || v === "1";

export function readQsf(text: string, fileName: string, fp: string): CanonicalSurvey {
  const issues: Issue[] = [];
  let qsf: Json;
  try { qsf = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (e) {
    return empty(fileName, fp, [{ location: fileName, type: "parse", severity: "high", message: `The QSF is not valid JSON: ${(e as Error).message}`, autoAttempted: false }]);
  }
  const entry: Json = qsf.SurveyEntry ?? {};
  const elements: Json[] = arr(qsf.SurveyElements);
  const byType = (t: string) => elements.filter((e) => e.Element === t);

  /* ------------------------------------------------------------ questions */
  const questions = new Map<string, CanonicalQuestion>();
  const qsfQ = new Map<string, Json>();
  for (const el of byType("SQ")) {
    const p: Json = el.Payload ?? {};
    const qid = str(p.QuestionID ?? el.PrimaryAttribute);
    if (!qid) continue;
    qsfQ.set(qid, p);
  }
  for (const [qid, p] of qsfQ) questions.set(qid, readQuestion(qid, p, issues));

  // choice id → recode, per question: logic refers to ids, data to recodes
  const choiceCode = (qid: string, choiceId: string): string | number | undefined => questions.get(qid)?.options.find((o) => o.sourceId === choiceId)?.code;

  // logic, now that every question exists
  for (const [qid, p] of qsfQ) {
    const q = questions.get(qid)!;
    if (p.DisplayLogic) q.displayLogic = readLogic(p.DisplayLogic, `${qid} · display logic`, issues);
    for (const [cid, c] of Object.entries<Json>(p.Choices ?? {})) {
      if (c?.DisplayLogic) { const o = q.options.find((x) => x.sourceId === cid); if (o) o.displayLogic = readLogic(c.DisplayLogic, `${qid} · choice ${cid} display logic`, issues); }
    }
    for (const s of arr<Json>(p.SkipLogic)) {
      const sk = readSkip(qid, s, issues);
      if (sk) q.skips.push(sk);
    }
    // Qualtrics' "In-page display logic" and carry-forward are read, but only carried as notes where there is no equivalent
    if (p.DynamicChoices?.Locator) {
      const m = /q:\/\/(QID\d+)\/(\w+)/.exec(str(p.DynamicChoices.Locator));
      if (m) {
        q.settings = { ...(q.settings ?? {}), carryForward: { from: m[1], filter: /Selected/.test(m[2]) && !/Unselected|Not/.test(m[2]) ? "selected" : /Displayed/.test(m[2]) ? "displayed" : /Unselected|NotSelected/.test(m[2]) ? "notSelected" : "all" } };
        q.notes.push(`choices carried forward from ${m[1]} (${m[2]})`);
      }
    }
  }
  void choiceCode;

  /* ------------------------------------------------------------ blocks */
  interface QBlock { id: string; description: string; type: string; pages: string[][]; options: Json }
  const blocks = new Map<string, QBlock>();
  let trashed = 0;
  const trashIds: string[] = [];
  for (const el of byType("BL")) {
    for (const b of arr<Json>(el.Payload)) {
      const id = str(b.ID);
      if (!id) continue;
      if (b.Type === "Trash") { for (const x of arr<Json>(b.BlockElements)) if (x.Type === "Question" && x.QuestionID) { trashed++; trashIds.push(str(x.QuestionID)); } continue; }
      const pages: string[][] = [[]];
      for (const be of arr<Json>(b.BlockElements)) {
        if (be.Type === "Page Break") { if (pages[pages.length - 1].length) pages.push([]); }
        else if (be.Type === "Question" && be.QuestionID && questions.has(str(be.QuestionID))) pages[pages.length - 1].push(str(be.QuestionID));
      }
      if (pages.length > 1 && pages[pages.length - 1].length === 0) pages.pop();
      blocks.set(id, { id, description: str(b.Description), type: str(b.Type), pages, options: b.Options ?? {} });
    }
  }
  // a trashed question is not part of the survey (unless a live block also holds it)
  for (const id of trashIds) if (![...blocks.values()].some((b) => b.pages.some((pg) => pg.includes(id)))) questions.delete(id);
  if (trashed) issues.push({ location: "Trash block", type: "dropped", severity: "info", message: `${trashed} question${trashed === 1 ? " was" : "s were"} in the Qualtrics trash and ${trashed === 1 ? "was" : "were"} not imported.`, autoAttempted: false });

  /* ------------------------------------------------------------ flow */
  const flowEl = byType("FL")[0]?.Payload ?? {};
  const usedBlocks = new Set<string>();
  const readFlow = (items: Json[], path: string): CFlow[] => {
    const out: CFlow[] = [];
    for (const f of items) {
      const fid = str(f.FlowID || f.ID || `${path}.${out.length}`);
      switch (f.Type) {
        case "Block": case "Standard": case "Default": {
          const b = blocks.get(str(f.ID));
          if (!b) { issues.push({ location: `Flow · ${fid}`, type: "reference", severity: "medium", message: `The Survey Flow names block ${f.ID}, which is not in the file.`, autoAttempted: false }); break; }
          usedBlocks.add(b.id);
          out.push(blockNode(b, questions, issues));
          break;
        }
        case "EmbeddedData": {
          const fields: CanonicalEmbeddedField[] = arr<Json>(f.EmbeddedData).map((e) => embeddedField(e, fid, issues)).filter((x): x is CanonicalEmbeddedField => !!x);
          out.push({ t: "embedded", sourceId: fid, fields });
          break;
        }
        case "Branch": {
          const when = f.BranchLogic ? readLogic(f.BranchLogic, `Flow · Branch ${fid}`, issues) : { t: "const", value: true } as CExpr;
          out.push({ t: "branch", sourceId: fid, when, children: readFlow(arr(f.Flow), fid), description: plainText(f.Description) || undefined });
          break;
        }
        case "Randomizer": {
          const show = Number(f.SubSet);
          out.push({ t: "randomizer", sourceId: fid, show: Number.isFinite(show) && show > 0 ? show : undefined, even: truthy(f.EvenPresentation), children: readFlow(arr(f.Flow), fid) });
          break;
        }
        case "Group": out.push({ t: "group", sourceId: fid, title: str(f.Description) || undefined, children: readFlow(arr(f.Flow), fid) }); break;
        case "EndSurvey": {
          const o: Json = f.Options ?? {};
          const status = truthy(o.ScreenOutResponse) ? "screened" : "complete";
          out.push({ t: "end", sourceId: fid, status, message: o.EOSMessage ? `Qualtrics end-of-survey message ${o.EOSMessage}` : undefined, redirectUrl: o.EOSRedirectURL || undefined });
          break;
        }
        case "Root": out.push(...readFlow(arr(f.Flow), fid)); break;
        default:
          out.push({ t: "unsupported", sourceId: fid, sourceType: str(f.Type), detail: plainText(f.Description) || JSON.stringify(f).slice(0, 200) });
          issues.push({ location: `Flow · ${f.Type} ${fid}`, type: "unsupported", severity: f.Type === "WebService" || f.Type === "Authenticator" ? "high" : "medium", message: `A Qualtrics ${f.Type} element has no Rescript equivalent and was not reproduced.`, suggestion: f.Type === "WebService" ? "Recreate the call as an embedded-data expression or a custom script." : f.Type === "Authenticator" ? "Use the project's access settings (panel links, invitations) instead." : undefined, autoAttempted: false });
      }
    }
    return out;
  };
  let flow = readFlow(arr(flowEl.Flow), "FL");
  // blocks not in the flow: Qualtrics does not show them; keep them visible to the programmer, at the end, flagged
  for (const b of blocks.values()) {
    if (usedBlocks.has(b.id) || !b.pages.some((p) => p.length)) continue;
    issues.push({ location: `Block ${b.description || b.id}`, type: "structure", severity: "low", message: `Block “${b.description || b.id}” is not in the Survey Flow, so respondents never see it. It was imported at the end, hidden behind a branch that never applies.`, suggestion: "Place it in the flow in Architect, or delete it.", autoAttempted: true });
    flow.push({ t: "branch", sourceId: `unused_${b.id}`, when: { t: "const", value: false }, children: [blockNode(b, questions, issues)], description: "Not in the Qualtrics Survey Flow" });
  }
  if (!flow.length && blocks.size) flow = [...blocks.values()].map((b) => blockNode(b, questions, issues));

  /* ------------------------------------------------------------ quotas */
  const quotas: CanonicalQuota[] = [];
  for (const el of byType("QO")) {
    const p: Json = el.Payload ?? {};
    const id = str(p.ID ?? el.PrimaryAttribute);
    const limit = Number(p.Occurrences ?? p.Count ?? 0);
    const action = str(p.QuotaAction);
    quotas.push({
      sourceId: id, name: str(p.Name) || id, limit: Number.isFinite(limit) ? limit : 0,
      when: p.Logic ? readLogic(p.Logic, `Quota ${p.Name ?? id}`, issues) : { t: "const", value: true },
      onFull: /End/i.test(action) ? "terminate" : /Redirect/i.test(action) ? "redirect" : "continue",
    });
    if (p.LogicType && p.LogicType !== "Simple") issues.push({ location: `Quota ${p.Name ?? id}`, type: "converted", severity: "medium", message: `Quota “${p.Name ?? id}” is a ${p.LogicType} quota; it was imported as one cell with its condition.`, suggestion: "Check its cells in the Quotas tab.", autoAttempted: true });
  }
  if (byType("QG").length) issues.push({ location: "Quota groups", type: "unsupported", severity: "medium", message: `${byType("QG").length} Qualtrics quota group${byType("QG").length === 1 ? "" : "s"} (cross-quota rules) were not reproduced; the quotas inside them were.`, autoAttempted: false });

  /* ------------------------------------------------------------ survey-level JS / header */
  const custom: CanonicalCustom[] = [];
  const so: Json = byType("SO")[0]?.Payload ?? {};
  if (typeof so.Header === "string" && /<script/i.test(so.Header)) custom.push({ language: "javascript", code: so.Header, location: "survey header", role: "survey-wide JavaScript in the header", refs: refsIn(so.Header) });
  for (const c of custom) issues.push({ location: c.location, type: "custom_logic", severity: "high", message: "Survey-wide JavaScript in the look & feel header has no Rescript equivalent.", suggestion: "Analyze it in Intelligent mode, or rewrite it as a custom script.", autoAttempted: false, refs: c.refs });

  return {
    source: { platform: "qualtrics", format: "qsf", fileName, title: str(entry.SurveyName) || undefined, language: str(entry.SurveyLanguage) || undefined, fingerprint: fp },
    questions: [...questions.values()], flow, embedded: [], quotas, custom, issues,
  };
}

function empty(fileName: string, fp: string, issues: Issue[]): CanonicalSurvey {
  return { source: { platform: "qualtrics", format: "qsf", fileName, fingerprint: fp }, questions: [], flow: [], embedded: [], quotas: [], custom: [], issues };
}

/* ------------------------------------------------------------ question */

function readQuestion(qid: string, p: Json, issues: Issue[]): CanonicalQuestion {
  const type = str(p.QuestionType), sel = str(p.Selector), sub = str(p.SubSelector);
  const val: Json = p.Validation?.Settings ?? {};
  const notes: string[] = [];
  const custom: CanonicalCustom[] = [];
  let confidence: CanonicalQuestion["confidence"] = "confirmed";
  const q: CanonicalQuestion = {
    sourceId: qid, variable: str(p.DataExportTag) || qid, text: qsfPiping(str(p.QuestionText)), kind: "unknown", sourceType: [type, sel, sub].filter(Boolean).join("/"),
    options: [], rows: [], required: val.ForceResponse === "ON", validation: [], skips: [], custom, confidence, notes,
  };
  if (val.ForceResponse === "RequestResponse") notes.push("Qualtrics “request response” (soft required) — imported as optional");
  const order = (ids: unknown, obj: Json | undefined): string[] => { const o = arr<unknown>(ids).map(str).filter((x) => obj && x in obj); return o.length ? o : Object.keys(obj ?? {}); };
  const recode: Json = p.RecodeValues ?? {};
  const choices = (): CanonicalOption[] => order(p.ChoiceOrder, p.Choices).map((cid) => {
    const c: Json = p.Choices[cid] ?? {};
    const code = recode[cid] !== undefined && recode[cid] !== "" ? recode[cid] : cid;
    return {
      sourceId: cid, code: /^-?\d+$/.test(str(code)) ? Number(code) : str(code), label: qsfPiping(str(c.Display)),
      ...(truthy(c.ExclusiveAnswer) ? { exclusive: true } : {}), ...(truthy(c.TextEntry) ? { otherSpecify: true } : {}),
    };
  });
  const answers = (): CanonicalOption[] => order(p.AnswerOrder, p.Answers).map((aid) => {
    const a: Json = p.Answers[aid] ?? {};
    const rv: Json = p.RecodeValues ?? {};
    const code = rv[aid] ?? aid;
    return { sourceId: aid, code: /^-?\d+$/.test(str(code)) ? Number(code) : str(code), label: qsfPiping(str(a.Display)), ...(truthy(a.ExclusiveAnswer) ? { exclusive: true } : {}) };
  });
  const rowsFromChoices = (): CanonicalRow[] => order(p.ChoiceOrder, p.Choices).map((cid) => ({ sourceId: cid, code: str(p.ChoiceDataExportTags?.[cid] || cid), label: qsfPiping(str(p.Choices[cid]?.Display)) }));
  const set = (kind: CanonicalKind) => { q.kind = kind; };

  switch (type) {
    case "MC": {
      q.options = choices();
      if (/^(SAVR|SAHR|SACOL|SB|NPS|TB)$/.test(sel) || sel === "") set(sel === "NPS" ? "nps" : "single");
      else if (/^(MAVR|MAHR|MACOL|MSB)$/.test(sel)) set("multi");
      else if (sel === "DL") set("dropdown");
      else { set("single"); notes.push(`selector ${sel} imported as a single choice`); confidence = "review"; }
      if (sel === "NPS") q.options = [];
      break;
    }
    case "TE": {
      const ct = str(val.ContentType);
      if (sel === "FORM") { set("text"); q.rows = rowsFromChoices(); notes.push("a form of several text fields"); }
      else if (ct === "ValidNumber" || ct === "ValidNumericRange") set("numeric");
      else if (ct === "ValidEmail") set("email");
      else if (ct === "ValidDate") set("date");
      else set(sel === "SL" || sel === "PW" ? "text" : "textarea");
      if (sel === "PW") notes.push("a password field — imported as a plain text field");
      break;
    }
    case "Matrix": {
      q.rows = rowsFromChoices();
      q.options = answers();
      if (sel === "Likert" && sub === "MultipleAnswer") set("matrix_multi");
      else if (sel === "Likert" && sub === "DL") set("matrix_dropdown");
      else if (sel === "TE") set("matrix_text");
      else if (sel === "CS") { set("matrix_numeric"); notes.push("a constant-sum matrix"); confidence = "review"; }
      else if (sel === "MaxDiff") { set("maxdiff"); confidence = "review"; notes.push("a Qualtrics MaxDiff matrix — Rescript MaxDiff runs from a design; the items were kept as rows"); }
      else if (sel === "RO") { set("ranking"); confidence = "review"; notes.push("a rank-order matrix imported as a ranking of the rows"); q.options = q.rows.map((r) => ({ sourceId: r.sourceId, code: /^\d+$/.test(r.code) ? Number(r.code) : r.code, label: r.label })); q.rows = []; }
      else { set("matrix_single"); if (sel !== "Likert") { notes.push(`matrix selector ${sel} imported as a single-answer grid`); confidence = "review"; } }
      break;
    }
    case "Slider": {
      const cfg: Json = p.Configuration ?? {};
      const opts = choices();
      if (sel === "STAR") { set("stars"); q.settings = { minValue: 1, maxValue: Number(cfg.StarCount ?? 5) }; }
      else if (opts.length <= 1) { set("slider"); q.settings = { minValue: Number(cfg.CSSliderMin ?? 0), maxValue: Number(cfg.CSSliderMax ?? 100) }; }
      else { set("matrix_numeric"); q.rows = rowsFromChoices(); q.settings = { minValue: Number(cfg.CSSliderMin ?? 0), maxValue: Number(cfg.CSSliderMax ?? 100) }; notes.push(`${opts.length} sliders imported as a numeric grid`); confidence = "review"; }
      break;
    }
    case "RO": set("ranking"); q.options = choices(); break;
    case "CS": { set("constant_sum"); q.options = choices(); const total = Number(p.Validation?.Settings?.ChoiceTotal ?? p.Configuration?.CSTotal); if (Number.isFinite(total) && total > 0) q.validation.push({ kind: "sum_equals", value: total }); break; }
    case "DB": set("descriptive"); q.required = false; break;
    case "FileUpload": set("file_upload"); break;
    case "HeatMap": case "HotSpot": set("hotspot"); confidence = "review"; notes.push(`a Qualtrics ${type} — the image regions must be redrawn`); break;
    case "Timing": case "Meta":
      set("hidden"); q.required = false; confidence = "review";
      notes.push(type === "Timing" ? "a page timer — Rescript records page timings itself; kept as a hidden variable for the data map" : "browser metadata — Rescript records user agent and device itself; kept as a hidden variable");
      break;
    case "SBS":
      set("matrix_single"); q.rows = rowsFromChoices(); confidence = "review";
      q.options = arr<Json>(p.AdditionalQuestions).length ? [] : answers();
      notes.push("a side-by-side question — only the first column could be carried as a grid");
      issues.push({ location: qid, type: "converted", severity: "high", message: `${q.variable} is a side-by-side question; Rescript has no side-by-side type. It was imported as a single grid and its other columns were not.`, suggestion: "Split it into one grid per column in Studio.", autoAttempted: true, refs: [qid] });
      break;
    default:
      set("unknown"); confidence = "unsupported";
      issues.push({ location: qid, type: "unsupported", severity: "high", message: `${q.variable} is a Qualtrics ${q.sourceType} question, which has no Rescript equivalent.`, suggestion: "Rebuild it in Studio; a placeholder keeps its position.", autoAttempted: false, refs: [qid] });
  }

  /* validation */
  const vt = str(val.Type);
  if (vt === "ContentType") {
    const ct = str(val.ContentType);
    if (ct === "ValidNumber" || ct === "ValidNumericRange") {
      const n: Json = val.ValidNumber ?? {};
      if (n.Min !== undefined && n.Min !== "") q.validation.push({ kind: "min_value", value: Number(n.Min) });
      if (n.Max !== undefined && n.Max !== "") q.validation.push({ kind: "max_value", value: Number(n.Max) });
      if (str(n.NumDecimals) === "0") q.validation.push({ kind: "integer" });
    } else if (ct === "ValidEmail") q.validation.push({ kind: "email" });
    else if (/Phone/.test(ct)) q.validation.push({ kind: "phone" });
    else if (/Zip/.test(ct)) q.validation.push({ kind: "zip" });
    else if (ct === "ValidDate") { /* the type carries it */ }
    else if (ct === "ValidTextOnly") q.validation.push({ kind: "pattern", value: "^[^0-9]*$" });
    else if (ct) { notes.push(`content validation ${ct} was not carried`); issues.push({ location: `${qid} · validation`, type: "validation", severity: "medium", message: `${q.variable} uses Qualtrics content validation “${ct}”, which has no direct equivalent.`, suggestion: "Add a pattern rule in Studio.", autoAttempted: false, refs: [qid] }); }
  } else if (vt === "MinChoices" || vt === "MaxChoices" || vt === "ChoiceRange" || vt === "ExactChoices") {
    const mn = Number(val.MinChoices), mx = Number(val.MaxChoices);
    if (Number.isFinite(mn) && mn > 0) q.validation.push({ kind: "min_selections", value: mn });
    if (Number.isFinite(mx) && mx > 0) q.validation.push({ kind: "max_selections", value: mx });
  } else if (vt === "CharRange" || vt === "TextLength") {
    const mn = Number(val.MinChars), mx = Number(val.MaxChars);
    if (Number.isFinite(mn) && mn > 0) q.validation.push({ kind: "min_length", value: mn });
    if (Number.isFinite(mx) && mx > 0) q.validation.push({ kind: "max_length", value: mx });
  } else if (vt === "CustomValidation") {
    const logic = val.CustomValidation?.Logic;
    const expr = logic ? readLogic(logic, `${qid} · custom validation`, []) : undefined;
    custom.push({ language: "qualtrics", code: JSON.stringify(logic ?? val.CustomValidation ?? {}), location: qid, role: "custom validation", refs: [...new Set(JSON.stringify(logic ?? {}).match(/QID\d+/g) ?? [])] });
    issues.push({ location: `${qid} · validation`, type: "custom_logic", severity: "medium", message: `${q.variable} has Qualtrics custom validation${expr && expr.t !== "raw" ? " — its condition was read" : ""}; it was not converted automatically.`, suggestion: "Recreate it as a Condition validation rule in Studio.", autoAttempted: !!expr, refs: [qid] });
  } else if (vt && vt !== "None") {
    notes.push(`validation type ${vt} was not carried`);
  }

  /* option randomization */
  const rt = str(p.Randomization?.Type);
  if (rt === "All") q.randomizeOptions = true;
  else if (rt && rt !== "None") { q.randomizeOptions = true; notes.push(`option randomization “${rt}” imported as a plain shuffle`); }

  /* JavaScript: kept, flagged — unless it is only Qualtrics' empty template */
  const js = typeof p.QuestionJS === "string" ? p.QuestionJS : "";
  if (js && !isEmptyJsTemplate(js)) {
    custom.push({ language: "javascript", code: js, location: qid, role: "question JavaScript", refs: refsIn(js) });
    issues.push({ location: `${qid} · JavaScript`, type: "custom_logic", severity: "high", message: `${q.variable} runs custom JavaScript, which has no direct Rescript equivalent. The code is kept, disabled, in Scripts.`, suggestion: "Ask “what could not be migrated?” in Intelligent mode and press Analyze to see what it does and get a proposed rebuild.", autoAttempted: false, refs: [qid, ...refsIn(js)] });
    confidence = confidence === "confirmed" ? "review" : confidence;
  }
  q.confidence = confidence;
  if (q.instruction === undefined && p.QuestionDescription && plainText(p.QuestionDescription) !== plainText(p.QuestionText)) { /* the description is Qualtrics' own summary, not an instruction */ }
  return q;
}

/** Qualtrics' default JS body: addOnload / addOnReady / addOnUnload with only comments inside */
export function isEmptyJsTemplate(js: string): boolean {
  const stripped = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    .replace(/Qualtrics\.SurveyEngine\.addOn(?:load|Ready|Unload|PageSubmit)\s*\(\s*function\s*\([^)]*\)\s*\{\s*\}\s*\)\s*;?/g, "");
  return !stripped.trim();
}

/** QIDs and embedded field names a piece of code mentions */
function refsIn(code: string): string[] {
  const out = new Set<string>(code.match(/QID\d+/g) ?? []);
  for (const m of code.matchAll(/e:\/\/Field\/([\w.-]+)/g)) out.add(m[1]);
  for (const m of code.matchAll(/(?:get|set)EmbeddedData\s*\(\s*["']([\w.-]+)["']/g)) out.add(m[1]);
  return [...out];
}

/**
 * Qualtrics piping → canonical piping. `{{@QID}}` is resolved to the
 * Rescript code by the mapper; embedded and loop fields map directly.
 */
export function qsfPiping(html: string): string {
  return html
    .replace(/\$\{q:\/\/(QID\d+)\/ChoiceGroup\/SelectedChoices(?:TextEntry)?\}/g, "{{@$1}}")
    .replace(/\$\{q:\/\/(QID\d+)\/ChoiceTextEntryValue\}/g, "{{@$1}}")
    .replace(/\$\{q:\/\/(QID\d+)\/ChoiceNumericEntryValue\/(\w+)\}/g, "{{@$1[$2]}}")
    .replace(/\$\{q:\/\/(QID\d+)\/ChoiceGroup\/SelectedAnswers\/(\w+)\}/g, "{{@$1[$2].label}}")
    .replace(/\$\{e:\/\/Field\/([\w.-]+)\}/g, (_, f: string) => `{{ed.${f.replace(/[^\w]/g, "_")}}}`)
    .replace(/\$\{lm:\/\/Field\/1\}/g, "{{loop.label}}")
    .replace(/\$\{lm:\/\/Field\/(\d+)\}/g, "{{loop.field$1}}")
    .replace(/\$\{lm:\/\/CurrentLoopNumber\}/g, "{{loop.index}}");
}

/* ------------------------------------------------------------ logic */

const OPS: Record<string, COp> = {
  Selected: "selected", NotSelected: "notSelected", Displayed: "displayed", NotDisplayed: "notDisplayed",
  EqualTo: "eq", NotEqualTo: "ne", GreaterThan: "gt", GreaterThanOrEqual: "gte", LessThan: "lt", LessThanOrEqual: "lte",
  Empty: "unanswered", NotEmpty: "answered", Contains: "contains", DoesNotContain: "notContains", MatchesRegex: "matches",
  Is: "eq", IsNot: "ne",
};

/**
 * A Qualtrics BooleanExpression → CExpr. Sets are numbered objects; inside
 * a set, expressions are numbered and carry `Conjuction` (sic) from the
 * second on. AND binds tighter than OR.
 */
export function readLogic(logic: Json, location: string, issues: Issue[]): CExpr {
  const sets = Object.keys(logic).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b)).map((k) => logic[k]);
  const setExprs: { conj: string; e: CExpr }[] = [];
  for (const set of sets) {
    const items = Object.keys(set ?? {}).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b)).map((k) => set[k]);
    const parts: { conj: string; e: CExpr }[] = items.map((x, i) => ({ conj: i === 0 ? "And" : str(x.Conjuction || x.Conjunction || "And"), e: readExpression(x, location, issues) }));
    const e = joinAndOr(parts);
    setExprs.push({ conj: str(items[0]?.Conjuction || items[0]?.Conjunction || set?.Conjuction || "And"), e });
  }
  if (!setExprs.length) return { t: "const", value: true };
  if (setExprs.length) setExprs[0].conj = "And";
  return joinAndOr(setExprs);
}

function joinAndOr(parts: { conj: string; e: CExpr }[]): CExpr {
  const ors: CExpr[][] = [[]];
  for (const p of parts) {
    if (/^or$/i.test(p.conj) && ors[ors.length - 1].length) ors.push([]);
    ors[ors.length - 1].push(p.e);
  }
  const ands = ors.map((a) => (a.length === 1 ? a[0] : { t: "group" as const, op: "and" as const, children: a }));
  return ands.length === 1 ? ands[0] : { t: "group", op: "or", children: ands };
}

function readExpression(x: Json, location: string, issues: Issue[]): CExpr {
  const lt = str(x.LogicType);
  const op = OPS[str(x.Operator)];
  const desc = plainText(x.Description) || `${lt} ${x.Operator ?? ""}`;
  const raw = (reason: string): CExpr => {
    const refs = [...new Set(`${x.ChoiceLocator ?? ""} ${x.LeftOperand ?? ""} ${x.QuestionID ?? ""}`.match(/QID\d+/g) ?? [])];
    issues.push({ location, type: "custom_logic", severity: "high", message: `A condition could not be converted: “${desc}” (${reason}).`, suggestion: "Rebuild this condition in the Logic builder.", autoAttempted: true, refs });
    return { t: "raw", text: desc, language: "qualtrics", refs, reason };
  };
  if (!op) return raw(`operator ${x.Operator ?? "?"} is not supported`);
  const right = x.RightOperand === undefined || x.RightOperand === "" ? undefined : /^-?\d+(\.\d+)?$/.test(str(x.RightOperand)) ? Number(x.RightOperand) : str(x.RightOperand);
  if (lt === "Question") {
    const loc = str(x.ChoiceLocator || x.LeftOperand);
    const m = /^q:\/\/(QID\d+)\/([A-Za-z]+)(?:\/([\w-]+))?(?:\/([\w-]+))?/.exec(loc);
    if (!m) return raw("the question locator is not recognised");
    const [, qid, part, a, b] = m;
    const ref: CRef = { kind: "question", id: qid };
    switch (part) {
      case "SelectableChoice": if (a) ref.choice = a; return { t: "cmp", ref, op: op === "eq" ? "selected" : op === "ne" ? "notSelected" : op };
      case "DisplayableQuestion": return op === "displayed" || op === "notDisplayed" ? { t: "cmp", ref, op } : raw("a question-displayed condition with an unexpected operator");
      case "ChoiceDisplayed": if (a) ref.choice = a; return { t: "cmp", ref, op: op === "selected" || op === "eq" ? "displayed" : op === "notSelected" || op === "ne" ? "notDisplayed" : op };
      case "ChoiceTextEntryValue": if (a) { ref.choice = a; issues.push({ location, type: "converted", severity: "low", message: `A condition reads the text typed into choice ${a} of ${qid}; it was converted to a condition on the question's answer.`, autoAttempted: true, refs: [qid] }); } return { t: "cmp", ref, op, ...(right !== undefined ? { value: right } : {}) };
      case "ChoiceNumericEntryValue": if (a) ref.row = a; return { t: "cmp", ref, op, ...(right !== undefined ? { value: right } : {}) };
      case "SelectableAnswer": if (a) ref.row = a; if (b) ref.choice = b; return { t: "cmp", ref, op: op === "eq" ? "selected" : op };
      case "QuestionText": case "QuestionScore": return raw(`a ${part} condition`);
      default: return raw(`the locator part ${part} is not supported`);
    }
  }
  if (lt === "EmbeddedField") {
    const field = str(x.LeftOperand).replace(/^e:\/\/Field\//, "");
    if (!field) return raw("no embedded field named");
    return { t: "cmp", ref: { kind: "embedded", id: field }, op, ...(right !== undefined ? { value: right } : {}) };
  }
  if (lt === "Quota") return { t: "cmp", ref: { kind: "quota", id: str(x.QuotaID || x.LeftOperand) }, op: /Full|Met/.test(str(x.Operator)) ? "eq" : op, value: 1 };
  if (lt === "LoopAndMerge" || lt === "LoopAndMergeField") return { t: "cmp", ref: { kind: "loop", id: str(x.LeftOperand).replace(/^lm:\/\/Field\//, "field") }, op, ...(right !== undefined ? { value: right } : {}) };
  return raw(`a ${lt || "?"} condition has no Rescript equivalent`);
}

function readSkip(qid: string, s: Json, issues: Issue[]): CanonicalSkip | null {
  const loc = str(s.ChoiceLocator || s.Locator);
  const m = /^q:\/\/(QID\d+)\/([A-Za-z]+)(?:\/([\w-]+))?/.exec(loc);
  const cond = str(s.Condition);
  const op = OPS[cond];
  const dest = str(s.SkipToDestination);
  const to = dest === "ENDOFSURVEY" ? { kind: "end" as const, status: "complete" as const }
    : dest === "ENDOFBLOCK" ? { kind: "end_of_block" as const }
    : /^QID\d+$/.test(dest) ? { kind: "question" as const, id: dest }
    : null;
  if (!to) { issues.push({ location: `${qid} · skip logic`, type: "reference", severity: "medium", message: `A skip to “${dest}” could not be read.`, autoAttempted: false, refs: [qid] }); return null; }
  let when: CExpr;
  if (m && op) {
    const ref: CRef = { kind: "question", id: m[1] };
    if (m[2] === "SelectableChoice" && m[3]) ref.choice = m[3];
    when = { t: "cmp", ref, op: m[2] === "ChoiceTextEntryValue" ? (op === "selected" ? "answered" : op) : op, ...(s.RightOperand !== undefined ? { value: s.RightOperand } : {}) };
  } else {
    when = { t: "raw", text: `${cond} ${loc}`, language: "qualtrics", refs: [qid], reason: "the skip condition is not recognised" };
    issues.push({ location: `${qid} · skip logic`, type: "custom_logic", severity: "high", message: `A skip condition could not be converted (“${cond}” on ${loc}).`, suggestion: "Rebuild it in the Skip logic section.", autoAttempted: true, refs: [qid] });
  }
  return { when, to };
}

/* ------------------------------------------------------------ blocks & flow */

function blockNode(b: { id: string; description: string; pages: string[][]; options: Json }, questions: Map<string, CanonicalQuestion>, issues: Issue[]): CFlow {
  const o = b.options ?? {};
  const node: Extract<CFlow, { t: "block" }> = { t: "block", sourceId: b.id, title: b.description || undefined, pages: b.pages.filter((p) => p.length) };
  if (!node.pages.length) node.pages = [[]];
  const rq = str(o.RandomizeQuestions);
  if (rq && rq !== "false" && rq !== "None") {
    node.randomizeQuestions = true;
    if (rq !== "true" && rq !== "RandomWithXPerPage") issues.push({ location: `Block ${b.description || b.id}`, type: "converted", severity: "medium", message: `Block “${b.description || b.id}” randomizes its questions (“${rq}”); imported as a plain shuffle of its pages.`, autoAttempted: true });
  }
  const looping = str(o.Looping);
  if (looping && looping !== "None") {
    const lo: Json = o.LoopingOptions ?? {};
    let loop: CLoop | undefined;
    if (looping === "Question" && lo.QID) {
      const locator = str(lo.ChoiceLocator);
      loop = { kind: "question", questionId: str(lo.QID), filter: /Unselected|NotSelected/.test(locator) ? "notSelected" : /Selected/.test(locator) ? "selected" : /Displayed/.test(locator) ? "displayed" : "all", loopVar: "item", randomize: str(lo.Randomization) === "All" };
    } else if (looping === "Static" || lo.Static) {
      const rows = Object.entries<Json>(lo.Static ?? {}).sort((a, c) => Number(a[0]) - Number(c[0]));
      const width = Math.max(1, ...rows.map(([, r]) => Object.keys(r ?? {}).length));
      loop = {
        kind: "static", loopVar: "item", randomize: str(lo.Randomization) === "All",
        fieldNames: Array.from({ length: width }, (_, k) => (k === 0 ? "label" : `field${k + 1}`)),
        items: rows.map(([code, r]) => ({ code, label: str(r?.["1"]), fields: Object.fromEntries(Object.entries<unknown>(r ?? {}).map(([k, v]) => [k === "1" ? "label" : `field${k}`, str(v)])) })),
      };
    }
    if (loop) node.loop = loop;
    else issues.push({ location: `Block ${b.description || b.id}`, type: "unsupported", severity: "high", message: `Block “${b.description || b.id}” uses Loop & Merge (“${looping}”) in a form that could not be read.`, suggestion: "Wrap the block in a loop in Architect.", autoAttempted: false });
  }
  void questions;
  return node;
}

function embeddedField(e: Json, fid: string, issues: Issue[]): CanonicalEmbeddedField | null {
  const name = str(e.Field || e.Description);
  if (!name) return null;
  const value = str(e.Value);
  const vt = str(e.VariableType);
  const dataType: CanonicalEmbeddedField["dataType"] = /Date/i.test(vt) ? "date" : /Scale|Number/i.test(vt) ? "decimal" : "string";
  if (!value) return { name, source: "url", dataType, sourceType: str(e.Type) || "Custom" };
  if (/\$\{/.test(value)) {
    // a piped value: an expression over other answers or fields
    const converted = qsfPiping(value);
    if (/\$\{/.test(converted)) issues.push({ location: `Flow · ${fid} · ${name}`, type: "converted", severity: "medium", message: `Embedded field ${name} is set from “${value}”, which contains piping that could not be converted.`, suggestion: "Rewrite the value as a Rescript expression.", autoAttempted: true });
    return { name, source: "expression", value: converted, dataType, sourceType: str(e.Type) };
  }
  return { name, source: "static", value, dataType, sourceType: str(e.Type) };
}
