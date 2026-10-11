import type {
  CanonicalSurvey, CanonicalQuestion, CanonicalOption, CanonicalRow, CanonicalValidation, CanonicalSkip, CanonicalCustom,
  CanonicalEmbeddedField, CanonicalQuota, CFlow, CExpr, CRef, COp, CLoop, CanonicalKind, Issue, InventoryItem, CanonicalAsset,
  CanonicalSurveyOptions,
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
 *   QG   quota groups; SO survey options (back button, progress bar, header)
 *
 * Every other element kind (PROJ, STAT, RS, SC scoring, PL …) is counted in
 * `elements` and reported as ignored — the file's table of contents, so a
 * reader can see what was there and not read. Loss is never silent: what
 * is read incompletely goes into the inventory as "partial", what cannot be
 * reproduced as "unsupported", each with the reason.
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

/** the element kinds a QSF carries and what this reader does with each — the ones it does not read are still listed */
const ELEMENT_KINDS: Record<string, { handled: "read" | "ignored" | "unsupported"; note: string }> = {
  SQ: { handled: "read", note: "questions" }, BL: { handled: "read", note: "blocks" }, FL: { handled: "read", note: "survey flow" },
  QO: { handled: "read", note: "quotas" }, QG: { handled: "read", note: "quota groups" }, SO: { handled: "read", note: "survey options" },
  QC: { handled: "ignored", note: "question counts — derived, not needed" }, RS: { handled: "ignored", note: "response sets — not part of the questionnaire" },
  PROJ: { handled: "ignored", note: "project category — not part of the questionnaire" }, STAT: { handled: "ignored", note: "survey statistics — not part of the questionnaire" },
  PL: { handled: "ignored", note: "preview link — not part of the questionnaire" }, SCO: { handled: "unsupported", note: "scoring — Rescript has no scoring categories; rebuild as calculated variables" },
  SC: { handled: "unsupported", note: "scoring — Rescript has no scoring categories; rebuild as calculated variables" }, TR: { handled: "ignored", note: "translation statistics" },
  CS: { handled: "ignored", note: "survey-level counts" }, NT: { handled: "ignored", note: "notes" }, TB: { handled: "unsupported", note: "table of contents" },
};

export function readQsf(text: string, fileName: string, fp: string): CanonicalSurvey {
  const issues: Issue[] = [];
  const inventory: InventoryItem[] = [];
  const assets: CanonicalAsset[] = [];
  let qsf: Json;
  try { qsf = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (e) {
    return empty(fileName, fp, [{ location: fileName, type: "parse", severity: "high", message: `The QSF is not valid JSON: ${(e as Error).message}`, autoAttempted: false }]);
  }
  const entry: Json = qsf.SurveyEntry ?? {};
  const elements: Json[] = arr(qsf.SurveyElements);
  const byType = (t: string) => elements.filter((e) => e.Element === t);
  /* the table of contents: every element kind, counted, with what became of it */
  const kindCounts = new Map<string, number>();
  for (const e of elements) kindCounts.set(str(e.Element) || "?", (kindCounts.get(str(e.Element) || "?") ?? 0) + 1);
  const elementTable = [...kindCounts].map(([type, count]) => ({ type, count, ...(ELEMENT_KINDS[type] ?? { handled: "ignored" as const, note: "an element kind this reader does not know" }) }));
  for (const e of elementTable) if (e.handled === "unsupported") issues.push({ location: `${e.type} element`, type: "unsupported", severity: "medium", message: `The file carries ${e.count} ${e.type} element${e.count === 1 ? "" : "s"} (${e.note.split(" — ")[0]}); Rescript has no equivalent, so ${e.count === 1 ? "it was" : "they were"} not reproduced.`, suggestion: e.note.split(" — ")[1], autoAttempted: false });

  /* ------------------------------------------------------------ questions */
  const questions = new Map<string, CanonicalQuestion>();
  const qsfQ = new Map<string, Json>();
  for (const el of byType("SQ")) {
    const p: Json = el.Payload ?? {};
    const qid = str(p.QuestionID ?? el.PrimaryAttribute);
    if (!qid) continue;
    qsfQ.set(qid, p);
  }
  const languages = new Set<string>();
  for (const [qid, p] of qsfQ) questions.set(qid, readQuestion(qid, p, issues, inventory, assets, languages));

  // logic, now that every question exists
  for (const [qid, p] of qsfQ) {
    const q = questions.get(qid)!;
    const grid = /^matrix|^bucket$/.test(q.kind) || (q.kind === "text" && q.rows.length > 0) || (q.kind === "numeric" && q.rows.length > 0);
    if (p.DisplayLogic) q.displayLogic = readLogic(p.DisplayLogic, `${qid} · display logic`, issues);
    /*
     * A choice's own display logic. In a grid the Qualtrics "Choices" are the
     * ROWS (the statements) and the "Answers" are the columns, so a choice
     * condition belongs to the row — attaching it to the option with the same
     * number, as this used to, hid the wrong thing.
     */
    for (const [cid, c] of Object.entries<Json>(p.Choices ?? {})) {
      if (!c?.DisplayLogic) continue;
      const e = readLogic(c.DisplayLogic, `${qid} · choice ${cid} display logic`, issues);
      if (grid) { const r = q.rows.find((x) => x.sourceId === cid); if (r) r.displayLogic = e; }
      else { const o = q.options.find((x) => x.sourceId === cid); if (o) o.displayLogic = e; }
    }
    for (const [aid, a] of Object.entries<Json>(p.Answers ?? {})) {
      if (!a?.DisplayLogic || !grid) continue;
      const o = q.options.find((x) => x.sourceId === aid); if (o) o.displayLogic = readLogic(a.DisplayLogic, `${qid} · answer ${aid} display logic`, issues);
    }
    for (const s of arr<Json>(p.SkipLogic)) {
      const sk = readSkip(qid, s, issues);
      if (sk) q.skips.push(sk);
    }
    /* carry-forward: choices taken from another question's answer — a first-class Rescript feature, so it is carried as one */
    if (p.DynamicChoices?.Locator) {
      const loc = str(p.DynamicChoices.Locator);
      const m = /q:\/\/(QID\d+)\/(\w+)/.exec(loc);
      if (m) {
        const filter = /Unselected|NotSelected/.test(m[2]) ? "notSelected" : /Selected/.test(m[2]) ? "selected" : /Displayed/.test(m[2]) ? "displayed" : "all";
        q.carryForward = { questionId: m[1], filter, into: grid ? "rows" : "options" };
        q.notes.push(`choices carried forward from ${m[1]} (${m[2]})`);
        if (!questions.has(m[1])) { issues.push({ location: `${qid} · carry-forward`, type: "reference", severity: "high", message: `${q.variable} carries choices forward from ${m[1]}, which is not in the file.`, autoAttempted: false, refs: [qid, m[1]] }); inventory.push({ feature: "carry_forward", sourceId: qid, status: "unsupported", note: `source ${m[1]} missing` }); }
      } else { issues.push({ location: `${qid} · carry-forward`, type: "unsupported", severity: "medium", message: `${q.variable} carries choices forward from “${loc}”, a locator this import does not read.`, suggestion: "Set the carry-forward source in Studio.", autoAttempted: false, refs: [qid] }); inventory.push({ feature: "carry_forward", sourceId: qid, status: "unsupported", note: loc }); }
    }
  }

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
  for (const id of trashIds) if (![...blocks.values()].some((b) => b.pages.some((pg) => pg.includes(id)))) {
    questions.delete(id);
    /* nothing the trash held is an element of the survey — not a question, not its assets, not its options in the inventory */
    for (let i = inventory.length - 1; i >= 0; i--) if (inventory[i].sourceId === id || inventory[i].sourceId.startsWith(`${id} `)) inventory.splice(i, 1);
    for (let i = assets.length - 1; i >= 0; i--) if (assets[i].location === id || assets[i].location.startsWith(`${id} `)) assets.splice(i, 1);
  }
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
        case "Randomizer": case "BlockRandomizer": {
          /* a BlockRandomizer is a randomizer whose children are blocks — the same thing to Rescript */
          const show = Number(f.SubSet);
          out.push({ t: "randomizer", sourceId: fid, show: Number.isFinite(show) && show > 0 ? show : undefined, even: truthy(f.EvenPresentation), children: readFlow(arr(f.Flow), fid) });
          if (f.Type === "BlockRandomizer") inventory.push({ feature: "block_randomizer", sourceId: fid, status: "imported" });
          break;
        }
        case "Group": out.push({ t: "group", sourceId: fid, title: str(f.Description) || undefined, children: readFlow(arr(f.Flow), fid) }); break;
        case "EndSurvey": {
          const o: Json = f.Options ?? {};
          const status = truthy(o.ScreenOutResponse) ? "screened" : "complete";
          /* a library message (EOSM_…) is not in the file — say so instead of writing its id where a sentence should be */
          out.push({ t: "end", sourceId: fid, status, redirectUrl: o.EOSRedirectURL || undefined });
          if (o.EOSMessage) issues.push({ location: `Flow · EndSurvey ${fid}`, type: "dropped", severity: "low", message: `The end-of-survey message ${o.EOSMessage} lives in the Qualtrics message library, which the file does not include; the end uses Rescript's default message.`, suggestion: "Paste the message into the end element in Architect.", autoAttempted: false });
          break;
        }
        case "Root": out.push(...readFlow(arr(f.Flow), fid)); break;
        default:
          out.push({ t: "unsupported", sourceId: fid, sourceType: str(f.Type), detail: plainText(f.Description) || JSON.stringify(f).slice(0, 200) });
          inventory.push({ feature: "flow_element", sourceId: fid, status: "unsupported", note: str(f.Type) });
          /* an element that WRAPS other elements (an Authenticator, a Table of Contents) still has children the respondent meets — read them, flat, so nothing behind it is lost */
          if (Array.isArray(f.Flow) && f.Flow.length) { out.push(...readFlow(arr(f.Flow), fid)); issues.push({ location: `Flow · ${f.Type} ${fid}`, type: "converted", severity: "medium", message: `The ${arr(f.Flow).length} element${arr(f.Flow).length === 1 ? "" : "s"} inside the ${f.Type} were imported in its place, without it.`, autoAttempted: true }); }
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
  /*
   * QUOTA GROUPS. A Qualtrics group bundles quotas that are read together
   * ("Gender": Male, Female). Rescript's own shape for that is one quota with
   * a cell per member, so a group becomes exactly that. Membership is read
   * from the group (its quota list) or from the quota (its group id),
   * whichever the export carries.
   */
  for (const el of byType("QG")) {
    const g: Json = el.Payload ?? {};
    const gid = str(g.ID ?? el.PrimaryAttribute);
    const gname = str(g.Name ?? el.SecondaryAttribute) || gid;
    const listed = [...arr<Json>(g.Quotas), ...arr<Json>(g.QuotaIDs), ...arr<Json>(g.Members)].map((x) => str(typeof x === "object" && x ? (x.ID ?? x.QuotaID) : x));
    const members = quotas.filter((q) => listed.includes(q.sourceId)
      || byType("QO").some((qo) => str(qo.Payload?.ID ?? qo.PrimaryAttribute) === q.sourceId && [qo.Payload?.QuotaGroupID, qo.Payload?.QuotaGroup, qo.Payload?.GroupID].map(str).includes(gid)));
    for (const m of members) m.group = { id: gid, name: gname };
    issues.push(members.length
      ? { location: `Quota group ${gname}`, type: "converted", severity: "low", message: `Quota group “${gname}” was imported as one quota with ${members.length} cell${members.length === 1 ? "" : "s"}.`, suggestion: "Check its cells and its full action in the Quotas tab — Qualtrics' cross-quota options (place in one / all) are not carried.", autoAttempted: true }
      : { location: `Quota group ${gname}`, type: "unsupported", severity: "medium", message: `Quota group “${gname}” lists no quota this import recognised; its quotas were imported one by one.`, autoAttempted: false });
  }

  /* ------------------------------------------------------------ survey options, survey-level JS / header */
  const custom: CanonicalCustom[] = [];
  const so: Json = byType("SO")[0]?.Payload ?? {};
  if (typeof so.Header === "string" && /<script/i.test(so.Header)) custom.push({ language: "javascript", code: so.Header, location: "survey header", role: "survey-wide JavaScript in the header", refs: refsIn(so.Header) });
  for (const c of custom) { issues.push({ location: c.location, type: "custom_logic", severity: "high", message: "Survey-wide JavaScript in the look & feel header has no Rescript equivalent.", suggestion: "Analyze it in Intelligent mode, or rewrite it as a custom script.", autoAttempted: false, refs: c.refs }); inventory.push({ feature: "custom_js", sourceId: c.location, status: "unsupported", note: "kept, disabled" }); }
  for (const u of imageUrls(str(so.Header)).concat(imageUrls(str(so.Footer)))) assets.push(asset(u, "survey header", "header"));
  const options: CanonicalSurveyOptions = {};
  if (so.BackButton !== undefined) { options.backButton = truthy(so.BackButton); inventory.push({ feature: "survey_option", sourceId: "BackButton", status: "imported" }); }
  if (so.ProgressBarDisplay !== undefined) { const pb = str(so.ProgressBarDisplay); options.progressBar = pb === "None" || pb === "" ? "none" : /Verbose/.test(pb) ? "verbose" : "text"; inventory.push({ feature: "survey_option", sourceId: "ProgressBarDisplay", status: "imported" }); }
  if (typeof so.NextButton === "string" && so.NextButton.trim()) { options.nextLabel = plainText(so.NextButton).slice(0, 40); inventory.push({ feature: "survey_option", sourceId: "NextButton", status: "imported" }); }
  if (typeof so.PreviousButton === "string" && so.PreviousButton.trim()) { options.backLabel = plainText(so.PreviousButton).slice(0, 40); inventory.push({ feature: "survey_option", sourceId: "PreviousButton", status: "imported" }); }
  for (const k of ["SaveAndContinue", "PartialData", "BallotBoxStuffingPrevention", "SurveyExpiration", "SurveyProtection", "AnonymizeResponse", "ResponseSummary"] as const) {
    if (so[k] !== undefined && str(so[k]) !== "" && str(so[k]) !== "false") inventory.push({ feature: "survey_option", sourceId: k, status: "unsupported", note: "a Qualtrics survey option with no Rescript equivalent — set the matching project setting by hand" });
  }

  return {
    source: { platform: "qualtrics", format: "qsf", fileName, title: str(entry.SurveyName) || undefined, language: str(entry.SurveyLanguage) || undefined, fingerprint: fp },
    questions: [...questions.values()], flow, embedded: [], quotas, custom, issues,
    assets, languages: [...languages].sort(), options, inventory, elements: elementTable,
  };
}

function empty(fileName: string, fp: string, issues: Issue[]): CanonicalSurvey {
  return { source: { platform: "qualtrics", format: "qsf", fileName, fingerprint: fp }, questions: [], flow: [], embedded: [], quotas: [], custom: [], issues, inventory: [], assets: [], elements: [] };
}

/* ------------------------------------------------------------ assets */

/** every image URL in a piece of HTML */
export function imageUrls(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) out.push(m[1]);
  return out;
}
const asset = (url: string, location: string, role: CanonicalAsset["role"]): CanonicalAsset => ({
  url, location, role,
  hosting: /^IM_[A-Za-z0-9]+$/.test(url) ? "library_id" : /qualtrics\.com|\/ControlPanel\/Graphic\.php|\/CP\/Graphic\.php/i.test(url) ? "platform" : "external",
});

/* ------------------------------------------------------------ question */

function readQuestion(qid: string, p: Json, issues: Issue[], inventory: InventoryItem[] = [], assets: CanonicalAsset[] = [], languages: Set<string> = new Set()): CanonicalQuestion {
  const type = str(p.QuestionType), sel = str(p.Selector), sub = str(p.SubSelector);
  const val: Json = p.Validation?.Settings ?? {};
  const notes: string[] = [];
  const custom: CanonicalCustom[] = [];
  let confidence: CanonicalQuestion["confidence"] = "confirmed";
  const q: CanonicalQuestion = {
    sourceId: qid, variable: str(p.DataExportTag) || qid, text: qsfPiping(str(p.QuestionText)), kind: "unknown", sourceType: [type, sel, sub].filter(Boolean).join("/"),
    options: [], rows: [], required: val.ForceResponse === "ON", validation: [], skips: [], custom, confidence, notes,
  };
  /* images in the question text: kept in the HTML, listed as assets so the report can say where they are hosted */
  for (const u of imageUrls(str(p.QuestionText))) assets.push(asset(u, qid, "question_text"));
  /*
   * A choice label that is an image (a Qualtrics "graphic" choice) becomes an
   * option with `imageUrl` — the picture Rescript options already carry — and
   * the alt text or the remaining words as its label.
   */
  const optionImage = (cid: string, html: string): { label: string; imageUrl?: string } => {
    const urls = imageUrls(html);
    if (!urls.length) return { label: qsfPiping(html) };
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(html)?.[1];
    const rest = plainText(html.replace(/<img\b[^>]*>/gi, ""));
    assets.push(asset(urls[0], `${qid} · option ${cid}`, "option_image"));
    return { label: qsfPiping(rest || alt || `Image ${cid}`), imageUrl: urls[0] };
  };
  if (val.ForceResponse === "RequestResponse") notes.push("Qualtrics “request response” (soft required) — imported as optional");
  const order = (ids: unknown, obj: Json | undefined): string[] => { const o = arr<unknown>(ids).map(str).filter((x) => obj && x in obj); return o.length ? o : Object.keys(obj ?? {}); };
  const recode: Json = p.RecodeValues ?? {};
  const choices = (): CanonicalOption[] => order(p.ChoiceOrder, p.Choices).map((cid) => {
    const c: Json = p.Choices[cid] ?? {};
    const code = recode[cid] !== undefined && recode[cid] !== "" ? recode[cid] : cid;
    const img = optionImage(cid, str(c.Display));
    return {
      sourceId: cid, code: /^-?\d+$/.test(str(code)) ? Number(code) : str(code), label: img.label, ...(img.imageUrl ? { imageUrl: img.imageUrl } : {}),
      ...(truthy(c.ExclusiveAnswer) ? { exclusive: true } : {}), ...(truthy(c.TextEntry) ? { otherSpecify: true } : {}),
    } as CanonicalOption;
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
      else if (sel === "Bipolar") { set("matrix_single"); q.variantHint = "matrix.semantic"; notes.push("a bipolar matrix imported as a semantic-differential grid"); }
      else if (sel === "Profile") { set("matrix_single"); confidence = "review"; notes.push("a profile matrix — Qualtrics lets each row carry its own answer set; the shared columns were imported"); issues.push({ location: qid, type: "converted", severity: "medium", message: `${q.variable} is a profile matrix; it was imported as a single-answer grid with one shared set of columns.`, autoAttempted: true, refs: [qid] }); }
      else { set("matrix_single"); if (sel !== "Likert") { notes.push(`matrix selector ${sel} imported as a single-answer grid`); confidence = "review"; } }
      if (sel === "Likert" && sub === "SingleAnswer") q.variantHint = "matrix.likert";
      /* a required grid requires every row — that is what Qualtrics "force response" means on a matrix */
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
    case "DB": {
      set("descriptive"); q.required = false;
      /* a graphic block: the picture is a library id or a URL — carried as an image in the text, and listed as an asset */
      if (sel === "GRB" || p.Graphic) {
        const ref = str(p.GraphicUrl || p.Graphic);
        if (ref) {
          const a = asset(ref, qid, "graphic"); assets.push(a);
          const src = a.hosting === "library_id" ? "" : ref;
          q.text = `${q.text}${q.text ? "\n" : ""}${src ? `<p><img src="${src}" alt="${plainText(str(p.GraphicDescription)) || "Image"}" /></p>` : `<p><em>[Image ${ref}${p.GraphicDescription ? ` — ${plainText(str(p.GraphicDescription))}` : ""} from the Qualtrics library — upload it here]</em></p>`}`;
          if (a.hosting === "library_id") { confidence = "review"; notes.push(`graphic ${ref} is a Qualtrics library id with no URL in the file`); }
        }
      }
      break;
    }
    case "FileUpload": set("file_upload"); break;
    case "Draw": set("signature"); if (sel !== "Signature") { notes.push(`a Qualtrics ${type}/${sel} imported as a signature field`); confidence = "review"; } break;
    case "PGR": {
      /* pick, group and rank: items dragged into named groups — Rescript's bucket grid (rows = items, options = groups) */
      set("bucket"); confidence = "review";
      q.rows = rowsFromChoices();
      q.options = arr<unknown>(p.Groups).map((g, i) => ({ sourceId: String(i + 1), code: i + 1, label: plainText(str(g)) || `Group ${i + 1}` }));
      notes.push("a pick-group-rank question imported as a bucket sort: the rank within each group is not carried");
      issues.push({ location: qid, type: "converted", severity: "medium", message: `${q.variable} is a pick, group and rank question; it was imported as a drag-into-groups grid. The order within each group is not recorded.`, suggestion: "Add a ranking question per group if the order matters.", autoAttempted: true, refs: [qid] });
      break;
    }
    case "HeatMap": case "HotSpot": set("hotspot"); confidence = "review"; notes.push(`a Qualtrics ${type} — the image regions must be redrawn`); break;
    case "Timing": case "Meta":
      set("hidden"); q.required = false; confidence = "review";
      notes.push(type === "Timing" ? "a page timer — Rescript records page timings itself; kept as a hidden variable for the data map" : "browser metadata — Rescript records user agent and device itself; kept as a hidden variable");
      break;
    case "SBS": {
      /*
       * Side by side: the shared Choices are the rows; each AdditionalQuestion
       * is a column with its own answer type and its own answers. Rescript's
       * mixed grid (composite, matrix.mixed) is exactly that shape, so every
       * column comes across — the data columns are named <variable>_<column>_<row>
       * where Qualtrics wrote <variable>#<column>_<row>.
       */
      q.rows = rowsFromChoices();
      const aq = Object.entries<Json>(p.AdditionalQuestions ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]));
      if (!aq.length) { set("matrix_single"); q.options = answers(); confidence = "review"; notes.push("a side-by-side question with no columns in the file — imported as a single grid"); break; }
      set("matrix_mixed");
      q.columns = aq.map(([cid, c]) => {
        const ct = str(c.QuestionType), cs = str(c.Selector);
        const responseType = ct === "TE" ? (str(c.Validation?.Settings?.ContentType) === "ValidNumber" ? "numeric" : "text") : /^(MAVR|MAHR|MACOL|MSB)$/.test(cs) ? "multi" : cs === "DL" ? "dropdown" : "single";
        const ansOrder = arr<unknown>(c.AnswerOrder).map(str).filter((x) => c.Answers && x in c.Answers);
        const ids = ansOrder.length ? ansOrder : Object.keys(c.Answers ?? {});
        const options: CanonicalOption[] = responseType === "text" || responseType === "numeric" ? [] : ids.map((aid) => { const rv = c.RecodeValues?.[aid]; const code = rv !== undefined && rv !== "" ? rv : aid; return { sourceId: aid, code: /^-?\d+$/.test(str(code)) ? Number(code) : str(code), label: qsfPiping(str(c.Answers?.[aid]?.Display)) }; });
        if (!options.length && responseType !== "text" && responseType !== "numeric") notes.push(`column ${cid} has no answers in the file`);
        return { sourceId: cid, label: qsfPiping(str(c.QuestionText)) || `Column ${cid}`, responseType, options };
      });
      notes.push(`a side-by-side question with ${aq.length} column${aq.length === 1 ? "" : "s"} — imported as a mixed grid; data columns are <variable>_<column>_<row>`);
      break;
    }
    default:
      set("unknown"); confidence = "unsupported";
      issues.push({ location: qid, type: "unsupported", severity: "high", message: `${q.variable} is a Qualtrics ${q.sourceType} question, which has no Rescript equivalent.`, suggestion: "Rebuild it in Studio; a placeholder keeps its position.", autoAttempted: false, refs: [qid] });
  }
  inventory.push({ feature: "question", sourceId: qid, status: q.kind === "unknown" ? "unsupported" : (confidence as string) === "review" || (confidence as string) === "ambiguous" ? "partial" : "imported", note: q.kind === "unknown" ? q.sourceType : notes[notes.length - 1] });

  /* hidden from respondents, kept in the data (DataVisibility) */
  if (truthy(p.DataVisibility?.Hidden)) { q.settings = { ...(q.settings ?? {}), hidden: true }; notes.push("hidden from respondents in Qualtrics (DataVisibility) — hidden here too"); }

  /* a default answer: a pre-selected choice, or prefilled text */
  const dc: Json = p.DefaultChoices ?? {};
  if (Object.keys(dc).length) {
    const picked = Object.entries<Json>(dc).filter(([, v]) => v && (truthy(v.Selected) || typeof v.Text === "string" && v.Text !== "" || typeof v.Value === "string" && v.Value !== ""));
    if (picked.length) {
      let value: unknown;
      if (type === "TE") value = str(picked[0][1].Text ?? picked[0][1].Value);
      else if (q.kind === "multi") value = picked.map(([cid]) => q.options.find((o) => o.sourceId === cid)?.code ?? cid);
      else if (q.kind === "single" || q.kind === "dropdown" || q.kind === "nps") value = q.options.find((o) => o.sourceId === picked[0][0])?.code ?? picked[0][0];
      if (value !== undefined) { q.settings = { ...(q.settings ?? {}), defaultValue: value }; inventory.push({ feature: "default_value", sourceId: qid, status: "imported" }); }
      else { inventory.push({ feature: "default_value", sourceId: qid, status: "unsupported", note: `a default on a ${q.sourceType}` }); notes.push("the Qualtrics default answer was not carried for this type"); }
    }
  }

  /* layout and formatting the schema has a home for */
  const cfg: Json = p.Configuration ?? {};
  if (truthy(cfg.RepeatHeaders) || (typeof cfg.RepeatHeaders === "string" && /^(middle|top|both)$/i.test(cfg.RepeatHeaders))) q.settings = { ...(q.settings ?? {}), headerRepeat: "auto" };
  if (cfg.LabelPosition && /^(SIDE|LEFT)$/i.test(str(cfg.LabelPosition))) q.settings = { ...(q.settings ?? {}), fieldLabelPosition: "left" };
  else if (cfg.LabelPosition && /^(TOP|ABOVE)$/i.test(str(cfg.LabelPosition))) q.settings = { ...(q.settings ?? {}), fieldLabelPosition: "above" };
  if (type === "Slider") {
    const nd = Number(cfg.NumDecimals); if (Number.isFinite(nd) && nd > 0) q.settings = { ...(q.settings ?? {}), decimalPlaces: Math.min(10, nd) };
    if (cfg.GridLines !== undefined || cfg.SnapToGrid !== undefined) notes.push("slider grid lines / snapping are not carried");
    if (truthy(cfg.NotApplicable)) notes.push("the slider's “not applicable” option was not carried");
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
      else if (Number.isFinite(Number(n.NumDecimals)) && str(n.NumDecimals) !== "") q.settings = { ...(q.settings ?? {}), decimalPlaces: Math.min(10, Number(n.NumDecimals)) };
    } else if (ct === "ValidEmail") q.validation.push({ kind: "email" });
    else if (/URL/i.test(ct)) q.validation.push({ kind: "url" });
    else if (/Phone/.test(ct)) q.validation.push({ kind: "phone" });
    else if (/Zip/.test(ct)) q.validation.push({ kind: "zip" });
    else if (ct === "ValidDate") { /* the type carries it */ }
    else if (ct === "ValidTextOnly") q.validation.push({ kind: "pattern", value: "^[^0-9]*$" });
    else if (ct) { notes.push(`content validation ${ct} was not carried`); issues.push({ location: `${qid} · validation`, type: "validation", severity: "medium", message: `${q.variable} uses Qualtrics content validation “${ct}”, which has no direct equivalent.`, suggestion: "Add a pattern rule in Studio.", autoAttempted: false, refs: [qid] }); inventory.push({ feature: "validation", sourceId: `${qid} ${ct}`, status: "unsupported", note: `content validation ${ct}` }); }
    if (ct === "ValidDate" && val.ValidDate?.DateFormat) { notes.push(`date format ${str(val.ValidDate.DateFormat)} — Rescript formats dates by the respondent's locale`); inventory.push({ feature: "validation", sourceId: `${qid} ValidDate`, status: "partial", note: "the date format is the locale's, not the fixed Qualtrics format" }); }
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
    inventory.push({ feature: "validation", sourceId: `${qid} CustomValidation`, status: "unsupported", note: "custom validation kept in the question's notes" });
  } else if (vt === "AllRanks" || vt === "ChoicesTotal" || vt === "ForceResponse") {
    /* carried by the type itself: a required ranking ranks everything, a constant sum reads ChoiceTotal above */
    if (vt === "AllRanks" && !q.required) { notes.push("“all ranks” without force response — imported as optional"); inventory.push({ feature: "validation", sourceId: `${qid} AllRanks`, status: "partial", note: "rank-all is enforced only when the question is required" }); }
  } else if (vt && vt !== "None") {
    notes.push(`validation type ${vt} was not carried`);
    inventory.push({ feature: "validation", sourceId: `${qid} ${vt}`, status: "unsupported", note: `validation type ${vt}` });
  }

  /* option randomization: a plain shuffle, or the advanced scheme — fixed positions, a random subset, undisplayed choices */
  const rt = str(p.Randomization?.Type);
  if (rt === "All") { q.randomizeOptions = true; inventory.push({ feature: "randomization", sourceId: qid, status: "imported" }); }
  else if (rt === "Advanced" && p.Randomization?.Advanced) {
    const adv: Json = p.Randomization.Advanced;
    const fixed = arr<unknown>(adv.FixedOrder).map(str);
    const randAt = fixed.indexOf("RAND"), randLast = fixed.lastIndexOf("RAND");
    const anchorsTop = randAt >= 0 ? fixed.slice(0, randAt).filter((x) => x !== "RAND") : [];
    const anchorsBottom = randLast >= 0 ? fixed.slice(randLast + 1).filter((x) => x !== "RAND") : [];
    const between = randAt >= 0 ? fixed.slice(randAt, randLast + 1).filter((x) => x !== "RAND") : [];
    const subset = Number(adv.TotalRandSubset ?? adv.RandomSubSetCount);
    const undisplayed = arr<unknown>(adv.Undisplayed).map(str);
    q.randomizeOptions = true;
    q.randomization = { anchorsTop, anchorsBottom, pick: Number.isFinite(subset) && subset > 0 ? subset : undefined, undisplayed, sourceType: "Advanced" };
    const partial = between.length > 0 || (Number.isFinite(subset) && subset > 0 && arr<unknown>(adv.RandomSubSet).length > 0 && arr<unknown>(adv.RandomSubSet).length !== (q.options.length - anchorsTop.length - anchorsBottom.length - undisplayed.length));
    if (between.length) notes.push(`${between.length} choice${between.length === 1 ? "" : "s"} fixed between randomized groups — imported as randomized`);
    inventory.push({ feature: "randomization", sourceId: qid, status: partial ? "partial" : "imported", note: partial ? "fixed positions between randomized groups, or a subset drawn from part of the list" : undefined });
    if (partial) issues.push({ location: `${qid} · randomization`, type: "converted", severity: "low", message: `${q.variable}'s advanced randomization has fixed choices between randomized ones, or draws its subset from part of the list; the anchors at the top and bottom, the subset size and the undisplayed choices were carried, the rest as a shuffle.`, autoAttempted: true, refs: [qid] });
  }
  else if (rt && rt !== "None") { q.randomizeOptions = true; notes.push(`option randomization “${rt}” imported as a plain shuffle`); inventory.push({ feature: "randomization", sourceId: qid, status: "partial", note: rt }); }

  /* JavaScript: kept, flagged — unless it is only Qualtrics' empty template */
  const js = typeof p.QuestionJS === "string" ? p.QuestionJS : "";
  if (js && !isEmptyJsTemplate(js)) {
    custom.push({ language: "javascript", code: js, location: qid, role: "question JavaScript", refs: refsIn(js) });
    issues.push({ location: `${qid} · JavaScript`, type: "custom_logic", severity: "high", message: `${q.variable} runs custom JavaScript, which has no direct Rescript equivalent. The code is kept, disabled, in Scripts.`, suggestion: "Ask “what could not be migrated?” in Intelligent mode and press Analyze to see what it does and get a proposed rebuild.", autoAttempted: false, refs: [qid, ...refsIn(js)] });
    confidence = confidence === "confirmed" ? "review" : confidence;
    inventory.push({ feature: "custom_js", sourceId: qid, status: "unsupported", note: "kept, disabled" });
  }
  q.confidence = confidence;

  /*
   * TRANSLATIONS. A multilingual QSF carries, on every question, a `Language`
   * map: language code → the question's text, choices and answers in that
   * language. They are kept by SOURCE id here and keyed by Rescript code in
   * the mapper, so a translated choice stays attached to its recode.
   */
  const lang: Json = p.Language && typeof p.Language === "object" && !Array.isArray(p.Language) ? p.Language : {};
  for (const [code, t] of Object.entries<Json>(lang)) {
    if (!t || typeof t !== "object") continue;
    const lc = code.toLowerCase();
    const table: Record<string, string> = {};
    if (typeof t.QuestionText === "string" && t.QuestionText.trim()) table.text = qsfPiping(t.QuestionText);
    for (const [cid, c] of Object.entries<Json>(t.Choices ?? {})) if (c && typeof c.Display === "string" && c.Display.trim()) table[`choice:${cid}`] = qsfPiping(c.Display);
    for (const [aid, a] of Object.entries<Json>(t.Answers ?? {})) if (a && typeof a.Display === "string" && a.Display.trim()) table[`answer:${aid}`] = qsfPiping(a.Display);
    if (!Object.keys(table).length) continue;
    languages.add(lc);
    q.translations = { ...(q.translations ?? {}), [lc]: table };
  }

  /* piping the reader could not turn into a Rescript token is left verbatim — and reported, so nothing is silently wrong on the page */
  for (const tok of unconvertedPiping([q.text, ...q.options.map((o) => o.label), ...q.rows.map((r) => r.label)].join(" "))) {
    inventory.push({ feature: "piping", sourceId: `${qid} ${tok}`, status: "unsupported", note: tok });
    issues.push({ location: `${qid} · piping`, type: "unsupported", severity: "medium", message: `${q.variable} pipes “${tok}”, which has no Rescript equivalent; the text shows it as written.`, suggestion: "Replace it with a Rescript piping token or plain text in Studio.", autoAttempted: false, refs: [qid] });
  }
  if (q.instruction === undefined && p.QuestionDescription && plainText(p.QuestionDescription) !== plainText(p.QuestionText)) { /* the description is Qualtrics' own summary, not an instruction */ }
  return q;
}

/** the `${…}` tokens still in a text after `qsfPiping` */
export function unconvertedPiping(text: string): string[] {
  return [...new Set((text.match(/\$\{[^}]*\}/g) ?? []))];
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
    .replace(/\$\{q:\/\/(QID\d+)\/ChoiceGroup\/SelectedChoicesCount\}/g, "{{@$1.count}}")
    .replace(/\$\{q:\/\/(QID\d+)\/ChoiceGroup\/DisplayedChoices\}/g, "{{@$1.displayed}}")
    .replace(/\$\{q:\/\/(QID\d+)\/ChoiceGroup\/UnselectedChoices\}/g, "{{@$1.unselected}}")
    .replace(/\$\{q:\/\/(QID\d+)\/ChoiceDescription\/(\w+)\}/g, "{{@$1.option.$2}}")
    .replace(/\$\{q:\/\/(QID\d+)\/QuestionText\}/g, "{{@$1.text}}")
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
  if (lt === "Quota") {
    /* "quota X has been met" / "has not been met": `eq 1` is full, `ne 1` is not full; the mapper turns it into a count against the quota's limit */
    const o = str(x.Operator);
    const full = /Not/i.test(o) ? false : /Full|Met|Reached/i.test(o) || op === "eq" || op === "selected" ? true : op === "ne" || op === "notSelected" ? false : null;
    if (full === null) return raw(`a quota condition with operator ${o}`);
    return { t: "cmp", ref: { kind: "quota", id: str(x.QuotaID || x.LeftOperand).replace(/^qo:\/\//, "") }, op: full ? "eq" : "ne", value: 1 };
  }
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
      case "SelectedChoicesCount": case "ChoiceCount": {
        /* "the respondent selected N / more than N / fewer than N choices" — a count condition Rescript evaluates itself */
        const n = typeof right === "number" ? right : Number(right);
        if (!Number.isFinite(n)) return raw("a choice-count condition without a number");
        if (op === "eq") return { t: "cmp", ref, op: "countEq", value: n };
        if (op === "gte") return { t: "cmp", ref, op: "countGte", value: n };
        if (op === "lte") return { t: "cmp", ref, op: "countLte", value: n };
        if (op === "gt") return { t: "cmp", ref, op: "countGte", value: n + 1 };
        if (op === "lt") return { t: "cmp", ref, op: "countLte", value: n - 1 };
        return raw(`a choice-count condition with operator ${x.Operator}`);
      }
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
  /* a skip that carries a whole BooleanExpression (newer exports) is read in full, AND / OR and all */
  if (s.Logic && typeof s.Logic === "object") {
    when = readLogic(s.Logic, `${qid} · skip logic`, issues);
  } else if (m && op) {
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
