/**
 * THE CHANGE PLAN (Research Engine audit, Phase 2) — a plan the researcher
 * reads BEFORE the model writes a single action.
 *
 * A whole questionnaire from a brief, a restructuring, a redesign: the model
 * used to answer with every action in one reply — long, truncation-prone,
 * and approved only as a finished diff. Now such a request is two stages:
 *
 *   plan     one small, schema-bound call: "Modify Q5 wording · Remove Q12 ·
 *            Add a purchase-intent block · Update the screener logic", each
 *            item with the objects it touches and why. Shown as a card; the
 *            researcher unticks what they do not want and approves.
 *   execute  one schema-bound call PER ITEM, each asked for that item's
 *            actions only (a budget each, so nothing is cut off), gathered
 *            into one proposal that goes through the same gate, review and
 *            Apply as any other.
 *
 * This module is the pure part: the plan's shape and schema, its reading from
 * the model's reply, and the prompts for both stages. The route runs it; the
 * copilot hook and the card show it.
 */

export type ChangeKind = "create" | "modify" | "remove" | "logic" | "design" | "analysis" | "other";
export interface ChangePlanItem {
  id: string;
  /** "Add a purchase-intent block", imperative, short */
  title: string;
  kind: ChangeKind;
  /** the questions, blocks or design parts it touches — codes where they exist, else names */
  objects: string[];
  /** why — in the researcher's terms (the objective, the hypothesis, the problem it fixes) */
  reason: string;
  /** what exactly will be done, when the title is not enough */
  detail?: string;
}
export interface ChangePlan {
  summary: string;
  items: ChangePlanItem[];
  /** what the model would ask before building, when the request is under-specified */
  questions: string[];
  /** what it assumed instead of asking */
  assumptions: string[];
}

const KINDS = new Set<ChangeKind>(["create", "modify", "remove", "logic", "design", "analysis", "other"]);
export const CHANGE_PLAN_SCHEMA = {
  name: "change_plan",
  schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["plan"] },
      summary: { type: "string" },
      items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, kind: { type: "string", enum: [...KINDS] }, objects: { type: "array", items: { type: "string" } }, reason: { type: "string" }, detail: { type: "string" } }, required: ["title", "kind", "reason"], additionalProperties: true } },
      questions: { type: "array", items: { type: "string" } },
      assumptions: { type: "array", items: { type: "string" } },
    },
    required: ["kind", "summary", "items"],
    additionalProperties: true,
  },
};

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const strs = (v: unknown, max: number, len: number): string[] => (Array.isArray(v) ? v.map((x) => str(x, len)).filter((x): x is string => !!x).slice(0, max) : []);

/** The gate on a plan reply: null when it carries no item. Ids are made stable (p1, p2 …) when the model gave none or repeated them. */
export function coerceChangePlan(raw: unknown): ChangePlan | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.items)) return null;
  const seen = new Set<string>();
  const items: ChangePlanItem[] = o.items.map((it, i) => {
    const x = (it ?? {}) as Record<string, unknown>;
    const title = str(x.title, 160);
    if (!title) return null;
    let id = str(x.id, 24) ?? `p${i + 1}`;
    if (seen.has(id)) id = `p${i + 1}`;
    seen.add(id);
    const kind = KINDS.has(x.kind as ChangeKind) ? (x.kind as ChangeKind) : "other";
    return { id, title, kind, objects: strs(x.objects, 20, 60), reason: str(x.reason, 400) ?? "", ...(str(x.detail, 800) ? { detail: str(x.detail, 800) } : {}) };
  }).filter((x): x is ChangePlanItem => !!x).slice(0, 30);
  if (!items.length) return null;
  return { summary: str(o.summary, 600) ?? `${items.length} change${items.length === 1 ? "" : "s"}`, items, questions: strs(o.questions, 5, 300), assumptions: strs(o.assumptions, 10, 300) };
}

/** The instruction appended to the normal prompt for the plan stage. */
export function planStagePrompt(): string {
  return `

THIS TURN: THE CHANGE PLAN ONLY — NO ACTIONS. Before anything is built, the researcher reads a plan and approves it item by item. Reply with ONLY this JSON object:
{"kind":"plan","summary":"<one sentence: what will change and why>","items":[{"id":"p1","title":"<imperative, short: Add a purchase-intent block>","kind":"create|modify|remove|logic|design|analysis|other","objects":["Q5","Screener"],"reason":"<why, in research terms>","detail":"<what exactly, when the title is not enough>"}],"questions":["<what you would ask before building, if anything>"],"assumptions":["<what you assumed instead of asking>"]}
Rules: one item per coherent change (a block of questions is one item; a logic rule is one item; the research design — objective, hypotheses, constructs — is one item; the analysis plan is one item). Order the items as they should be built: design first, then structure, then questions, then logic, then analysis. Name objects by their codes where they exist in the OUTLINE. 3 to 15 items. Do not write questions or options here — only what will be done.`;
}

/** The instruction appended to the normal prompt for one item of an approved plan. */
export function executeItemPrompt(plan: ChangePlan, item: ChangePlanItem, index: number, approved: ChangePlanItem[], done: string[]): string {
  const list = approved.map((p, i) => `${i + 1}. ${p.title}${p.objects.length ? ` [${p.objects.join(", ")}]` : ""}`).join("\n");
  return `

THIS TURN: EXECUTE ONE ITEM OF THE APPROVED CHANGE PLAN. The researcher approved this plan (${plan.summary}):
${list}
${done.length ? `\nALREADY BUILT in earlier turns of this plan (do not repeat; new questions may reference these by the codes given): ${done.join("; ")}\n` : ""}
BUILD ITEM ${index + 1} ONLY: "${item.title}"${item.detail ? ` — ${item.detail}` : ""} (${item.reason}). Reply in the usual JSON shape with "kind":"proposal" and the ACTIONS FOR THIS ITEM ONLY — complete questions with their options, codes and analysis tags where they apply. No "plan" field, no actions for other items, no commentary about the other items. "reply": one sentence saying what this item adds.`;
}

/** The replies of the executed items, as one reply for the gate: actions in plan order, the sentences joined, the plan carried as blocks. */
export function mergeItemReplies(items: { item: ChangePlanItem; raw: unknown }[]): Record<string, unknown> {
  const actions: unknown[] = [];
  const replies: string[] = [];
  const assumptions: unknown[] = [];
  const sources: unknown[] = [];
  let understanding: unknown;
  let memory: unknown;
  for (const { item, raw } of items) {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (Array.isArray(o.actions)) actions.push(...o.actions);
    if (typeof o.reply === "string" && o.reply.trim()) replies.push(`${item.title}: ${o.reply.trim()}`);
    if (Array.isArray(o.assumptions)) assumptions.push(...o.assumptions);
    if (Array.isArray(o.sources)) sources.push(...o.sources);
    if (!understanding && o.understanding) understanding = o.understanding;
    if (typeof o.memory === "string") memory = o.memory;
  }
  return { kind: "proposal", reply: replies.join(" ") || `Built ${items.length} item${items.length === 1 ? "" : "s"} of the plan.`, actions, assumptions, sources, ...(understanding ? { understanding } : {}), ...(memory ? { memory } : {}), plan: items.map(({ item }) => ({ block: item.title, purpose: item.reason })) };
}
