import type { CanonicalSurvey, CanonicalQuestion, CExpr, CFlow, InventoryItem } from "./canonical.js";
import { plainText } from "./canonical.js";
import type { MigrationReport } from "./report.js";

/**
 * THE IMPORT REVIEW (import brief §14, I7): what the review screen shows before anything is created.
 *
 *   compatibility(report)   every element in ONE of six categories — fully supported, supported with conversion,
 *                           requires additional configuration, partially supported, unsupported, requires
 *                           clarification — each with its source id and the reason
 *   outline(canonical)      the survey flow as the source wrote it, in order: blocks, questions, branches with
 *                           their conditions in words, randomizers, embedded-data assignments, ends and redirects
 *   selectBlocks(c, ids)    the canonical survey reduced to chosen blocks (Import selected blocks); what the kept
 *                           part refers to outside the selection is then reported, never silently dropped
 *   exprText(e, c)          a condition in words ("S1 = Yes AND NOT Q3 = No")
 */
export type CompatCategory = "full" | "converted" | "configure" | "partial" | "unsupported" | "clarify";
export const COMPAT_LABELS: Record<CompatCategory, string> = {
  full: "Fully supported", converted: "Supported with conversion", configure: "Requires additional configuration",
  partial: "Partially supported", unsupported: "Unsupported", clarify: "Requires your clarification",
};
export interface CompatItem { category: CompatCategory; feature: string; sourceId: string; label: string; note?: string }
export interface Compatibility { counts: Record<CompatCategory, number>; items: CompatItem[] }

export function compatibility(r: MigrationReport, inventory: InventoryItem[] = []): Compatibility {
  const items: CompatItem[] = [];
  const add = (category: CompatCategory, feature: string, sourceId: string, label: string, note?: string) => items.push({ category, feature, sourceId, label, ...(note ? { note } : {}) });
  /* questions: by mapping class */
  for (const d of r.mapping?.decisions ?? []) {
    const cat: CompatCategory = d.decision === "exact" ? "full" : d.decision === "components" ? "converted" : d.decision === "needs_js" ? "configure" : d.decision === "needs_runtime" ? "partial" : "unsupported";
    add(cat, "question", d.sourceId, `${d.variable} (${d.sourceType})`, d.decision === "exact" ? undefined : d.note);
  }
  /* everything else the inventory measured, one line per element */
  for (const i of inventory) {
    if (i.feature === "question") continue;
    const cat: CompatCategory = i.status === "imported" ? (i.note && /convert|imported as|became|native/i.test(i.note) ? "converted" : "full") : i.status === "partial" ? "partial" : "unsupported";
    add(cat, i.feature, i.sourceId, `${i.feature.replace(/_/g, " ")} · ${i.sourceId}`, i.note);
  }
  /* what needs a person before fielding: scripts to review, pictures to upload, custom logic */
  for (const s of r.scripts ?? []) add("configure", "custom_js", s.location, `script on ${s.location}`, s.summary);
  for (const a of r.fidelity?.assets ?? []) if (a.risk !== "ok") add("configure", "asset", a.location, `picture at ${a.location}`, a.risk === "no_url" ? "upload it in Studio" : "hosted by the source platform — copy it into the media library");
  for (const c of r.clarifications ?? []) add("clarify", c.kind, c.questionId ?? c.location, c.question, c.recommended ? `recommended: ${c.recommended.label}` : "no recommendation — your choice");
  const counts = { full: 0, converted: 0, configure: 0, partial: 0, unsupported: 0, clarify: 0 } as Record<CompatCategory, number>;
  for (const i of items) counts[i.category]++;
  return { counts, items };
}

export interface OutlineNode {
  depth: number;
  kind: "block" | "question" | "branch" | "randomizer" | "group" | "embedded" | "end" | "quota_check" | "unsupported";
  sourceId: string;
  label: string;
  /** a branch's or a question's display condition, in words */
  condition?: string;
  /** a question's skips, in words */
  skips?: string[];
  redirect?: string;
}

export function exprText(e: CExpr | undefined, c: CanonicalSurvey): string {
  if (!e) return "";
  const byId = new Map(c.questions.map((q) => [q.sourceId, q]));
  const name = (id: string) => byId.get(id)?.code ?? byId.get(id)?.variable ?? id;
  const go = (x: CExpr): string => {
    if (x.t === "const") return x.value ? "always" : "never";
    if (x.t === "raw") return `[unread: ${x.text.slice(0, 60)}]`;
    if (x.t === "group") return x.op === "not" ? `NOT (${x.children.map(go).join(" AND ")})` : x.children.map((ch) => ch.t === "group" && ch.op !== "not" ? `(${go(ch)})` : go(ch)).join(x.op === "and" ? " AND " : " OR ");
    const ref = x.ref.kind === "question" ? name(x.ref.id) : x.ref.kind === "embedded" ? `ED.${x.ref.id}` : `${x.ref.kind}:${x.ref.id}`;
    const q = x.ref.kind === "question" ? byId.get(x.ref.id) : undefined;
    const opt = x.ref.choice ? (q?.options.find((o) => o.sourceId === x.ref.choice)?.label ?? x.ref.choice) : undefined;
    const ops: Record<string, string> = { selected: "=", notSelected: "≠", eq: "=", ne: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "contains", notContains: "does not contain", answered: "answered", unanswered: "not answered", displayed: "displayed", notDisplayed: "not displayed" };
    const v = opt ?? (Array.isArray(x.value) ? x.value.join(", ") : x.value);
    return `${ref}${x.ref.row ? `[${x.ref.row}]` : ""} ${ops[x.op] ?? x.op}${v !== undefined && x.op !== "answered" && x.op !== "unanswered" ? ` ${v}` : ""}`;
  };
  return go(e);
}

export function outline(c: CanonicalSurvey): OutlineNode[] {
  const out: OutlineNode[] = [];
  const byId = new Map(c.questions.map((q) => [q.sourceId, q]));
  const q = (qq: CanonicalQuestion, depth: number) => out.push({
    depth, kind: "question", sourceId: qq.sourceId, label: `${qq.code ?? qq.variable} · ${plainText(qq.text).replace(/\s+/g, " ").slice(0, 90)}`,
    ...(qq.displayLogic ? { condition: exprText(qq.displayLogic, c) } : {}),
    ...(qq.skips.length ? { skips: qq.skips.map((s) => `if ${exprText(s.when, c)} → ${s.to.kind === "question" ? (byId.get(s.to.id)?.code ?? s.to.id) : s.to.kind === "end" ? `end (${s.to.status})` : s.to.kind === "block" ? `block ${s.to.id}` : s.to.kind === "url" ? s.to.url : "end of block"}`) } : {}),
  });
  const walk = (fs: CFlow[], depth: number) => {
    for (const f of fs) {
      switch (f.t) {
        case "block": out.push({ depth, kind: "block", sourceId: f.sourceId, label: f.title ?? f.sourceId, ...(f.displayLogic ? { condition: exprText(f.displayLogic, c) } : {}) }); for (const p of f.pages) for (const id of p) { const qq = byId.get(id); if (qq) q(qq, depth + 1); } break;
        case "branch": out.push({ depth, kind: "branch", sourceId: f.sourceId, label: f.description ?? "Branch", condition: exprText(f.when, c) }); walk(f.children, depth + 1); break;
        case "randomizer": out.push({ depth, kind: "randomizer", sourceId: f.sourceId, label: `Randomizer${f.show ? ` (show ${f.show})` : ""}${f.even ? " · evenly" : ""}` }); walk(f.children, depth + 1); break;
        case "group": out.push({ depth, kind: "group", sourceId: f.sourceId, label: f.title ?? "Group" }); walk(f.children, depth + 1); break;
        case "embedded": out.push({ depth, kind: "embedded", sourceId: f.sourceId, label: `Set ${f.fields.map((x) => `${x.name}${x.value ? ` = ${x.value}` : ` (${x.source})`}`).join(", ")}` }); break;
        case "end": out.push({ depth, kind: "end", sourceId: f.sourceId, label: `End — ${f.status}`, ...(f.redirectUrl ? { redirect: f.redirectUrl } : {}) }); break;
        case "quota_check": out.push({ depth, kind: "quota_check", sourceId: f.sourceId, label: `Quota check (${f.quotaIds.join(", ")})` }); break;
        case "unsupported": out.push({ depth, kind: "unsupported", sourceId: f.sourceId, label: `${f.sourceType} (not reproduced)` }); break;
      }
    }
  };
  walk(c.flow, 0);
  /* a flat document: no flow — the questions in order */
  if (!c.flow.length) for (const qq of c.questions) q(qq, 0);
  return out;
}

/** the blocks a person can choose from: id, title, how many questions */
export function blockList(c: CanonicalSurvey): { id: string; title: string; questions: number }[] {
  const out: { id: string; title: string; questions: number }[] = [];
  const walk = (fs: CFlow[]) => { for (const f of fs) { if (f.t === "block") out.push({ id: f.sourceId, title: f.title ?? f.sourceId, questions: f.pages.flat().length }); else if ("children" in f) walk(f.children); } };
  walk(c.flow);
  return out;
}

/**
 * IMPORT SELECTED BLOCKS: the flow keeps only the chosen blocks (branches, randomizers and groups that end up
 * empty are dropped), the questions only those blocks hold. Embedded data, ends and quotas stay. What the kept
 * questions still refer to outside the selection is reported by the graph and the mapper as an unresolved
 * reference — it is never silently rewritten.
 */
export function selectBlocks(c: CanonicalSurvey, ids: string[]): CanonicalSurvey {
  const keep = new Set(ids);
  if (!keep.size) return c;
  const kept = new Set<string>();
  const walk = (fs: CFlow[]): CFlow[] => fs.flatMap((f): CFlow[] => {
    if (f.t === "block") { if (!keep.has(f.sourceId)) return []; for (const id of f.pages.flat()) kept.add(id); return [f]; }
    if (f.t === "branch" || f.t === "randomizer" || f.t === "group") { const children = walk(f.children); return children.some((x) => x.t === "block") ? [{ ...f, children } as CFlow] : []; }
    return [f];
  });
  const flow = walk(c.flow);
  return {
    ...c, flow, questions: c.questions.filter((q) => kept.has(q.sourceId)),
    issues: [...c.issues, { location: "import scope", type: "inferred", severity: "info", message: `Only ${ids.length} selected block${ids.length === 1 ? "" : "s"} were imported (${kept.size} question${kept.size === 1 ? "" : "s"}).`, autoAttempted: false }],
  };
}
