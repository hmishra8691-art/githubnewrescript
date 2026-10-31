/**
 * S3b item 3 (audit MM-09 overview, MM-11 logs) — EVERY PIECE OF CODE IN THE SURVEY, one row each, for Research tools →
 * All code. Pure: the panel adds the live health (S1c route) per row.
 *
 * The items are the script audit log's (`scriptItems`, engine scriptAudit.ts), so the list, the audit log and the
 * per-script history name the same things with the same ids:
 *   ux_script        a behaviour's script (Styles, animations & scripts), with its target
 *   logic_script     Scripts panel (event, scope)
 *   component_js / component_html   a Custom Component's code
 *   question_css     a question's custom CSS
 *   branding_header / branding_footer / branding_css   Branding
 *   question_js / branding_js       old Custom code fields (moved into behaviours when the survey loads)
 * Each row: where it runs, its events, on/off, the gate's verdict (`scriptVerdict` — the same check the audit log
 * records), what it reads and writes (`scriptLiteralRefs`), and the id its health is reported under.
 */
import type { SurveyDefinition } from "@rescript/schema";
import { describeUxTarget, scriptItems, scriptVerdict, scriptLiteralRefs, scriptDeclarations, uxBehaviorTrigger, type ScriptItemKind, type ScriptVerdict } from "@rescript/engine";

export type CodeEditTarget =
  | { type: "behavior"; id: string }
  | { type: "logic"; id: string }
  | { type: "question"; questionId: string; field: "customJs" | "customHtml" | "customCss" }
  | { type: "branding"; field: "headerHtml" | "footerHtml" | "customCss" | "customJs" };

export interface CodeRow {
  /** `${kind}:${id}` — the audit log's item */
  key: string;
  kind: ScriptItemKind;
  kindLabel: string;
  id: string;
  name: string;
  /** where it runs, in words */
  where: string;
  events: string[];
  /** null: this kind has no switch */
  enabled: boolean | null;
  verdict: ScriptVerdict;
  reads: string[];
  writes: string[];
  /** the id the runtime reports its failures under (script health); null: never reported (CSS / HTML) */
  healthId: string | null;
  language: "js" | "css" | "html";
  code: string;
  edit: CodeEditTarget;
  /** the question it belongs to, if any (code) */
  question?: string;
}

export const KIND_LABEL: Record<ScriptItemKind, string> = {
  ux_script: "Behaviour script", logic_script: "Logic script", component_js: "Component JS", component_html: "Component HTML",
  question_css: "Question CSS", question_js: "Old custom JS", branding_header: "Header HTML", branding_footer: "Footer HTML",
  branding_css: "Survey CSS", branding_js: "Old survey JS",
};

const uniq = (xs: string[]) => [...new Set(xs)];

export function codeInventory(def: SurveyDefinition): CodeRow[] {
  const rows: CodeRow[] = [];
  const qCode = (id?: string | null) => (id ? String(def.questions.find((q) => q.id === id)?.code ?? id) : "");
  for (const it of scriptItems(def)) {
    const base = { key: `${it.kind}:${it.id}`, kind: it.kind, kindLabel: KIND_LABEL[it.kind], id: it.id, name: it.name, code: it.code, verdict: scriptVerdict(it.kind, it.code, def) };
    const js = (code: string) => { const r = scriptLiteralRefs(code); return { reads: uniq(r.filter((x) => !x.write).map((x) => x.name)), writes: uniq(r.filter((x) => x.write).map((x) => x.name)) }; };
    switch (it.kind) {
      case "ux_script": {
        const b = def.ux!.behaviors.find((x) => x.id === it.id)!;
        const d = scriptDeclarations(it.code);
        const trig = uxBehaviorTrigger(b);
        const events = uniq([...(trig ? [trig.on] : []), ...d.listens.map((l) => `${l.event}${l.target && l.target !== "self" ? ` ${l.target}` : ""}`), ...d.domEvents.map((e) => `dom ${e}`)]);
        rows.push({ ...base, where: describeUxTarget(def, b.target), events: events.length ? events : ["page open"], enabled: it.enabled, ...js(it.code), healthId: b.id, language: "js", edit: { type: "behavior", id: b.id }, ...(b.target.questionId ? { question: qCode(b.target.questionId) } : {}) });
        break;
      }
      case "logic_script": {
        const sc = def.scripts.find((x) => x.id === it.id)!;
        const q = sc.scope === "question" ? def.questions.find((x) => x.id === sc.ref || String(x.code) === sc.ref) : undefined;
        const where = sc.scope === "survey" ? "the whole survey" : sc.scope === "question" ? `question ${q ? q.code : sc.ref ?? "?"}` : `page ${sc.ref ?? "?"}`;
        rows.push({ ...base, where, events: [sc.event], enabled: it.enabled, ...js(it.code), healthId: sc.id, language: "js", edit: { type: "logic", id: sc.id }, ...(q ? { question: String(q.code) } : {}) });
        break;
      }
      case "component_js": case "component_html": case "question_css": case "question_js": {
        const qid = it.id.replace(/:(js|html|css)$/, "");
        const field = it.kind === "component_html" ? "customHtml" : it.kind === "question_css" ? "customCss" : "customJs";
        const isJs = it.kind === "component_js" || it.kind === "question_js";
        rows.push({ ...base, where: `question ${qCode(qid)}`, events: it.kind === "component_js" ? uniq(["render", ...(/api\s*\.\s*onChange\s*\(/.test(it.code) ? ["answer change"] : [])]) : it.kind === "question_js" ? ["moved on load"] : ["always"],
          enabled: null, ...(isJs ? js(it.code) : { reads: [], writes: [] }), healthId: it.kind === "component_js" ? `uxb_component_${qid.replace(/[^\w-]/g, "_")}` : null,
          language: isJs ? "js" : it.kind === "component_html" ? "html" : "css", edit: { type: "question", questionId: qid, field }, question: qCode(qid) });
        break;
      }
      default: {
        const field = it.kind === "branding_header" ? "headerHtml" : it.kind === "branding_footer" ? "footerHtml" : it.kind === "branding_css" ? "customCss" : "customJs";
        rows.push({ ...base, where: "every page", events: it.kind === "branding_js" ? ["moved on load"] : ["always"], enabled: null, reads: [], writes: [], healthId: null,
          language: it.kind === "branding_css" ? "css" : it.kind === "branding_js" ? "js" : "html", edit: { type: "branding", field } });
      }
    }
  }
  return rows;
}

export interface InventoryFilter { kind?: string; text?: string; problems?: boolean; off?: boolean }
/** the panel's filters: a kind group, text (name, where, code, reads / writes), only problems (refused / sanitised / legacy, or failing live), only switched off */
export function filterInventory(rows: CodeRow[], f: InventoryFilter, failing: (healthId: string | null) => boolean = () => false): CodeRow[] {
  const t = f.text?.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.kind && f.kind !== "all") {
      const group = r.kind === "ux_script" ? "behaviour" : r.kind === "logic_script" ? "logic" : r.kind.startsWith("component") ? "component" : r.kind.startsWith("branding") ? "branding" : "question";
      if (group !== f.kind) return false;
    }
    if (f.problems && r.verdict.status === "passed" && !failing(r.healthId)) return false;
    if (f.off && r.enabled !== false) return false;
    if (t && ![r.name, r.where, r.kindLabel, r.question ?? "", ...r.reads, ...r.writes, ...r.events].some((x) => x.toLowerCase().includes(t)) && !r.code.toLowerCase().includes(t)) return false;
    return true;
  });
}
