import type { SurveyDefinition } from "@rescript/schema";
import type { LoopFlowNode } from "./loopModel.js";
import { formatCondition } from "./logicExpression.js";
import { formatSetExpression } from "./setExpression.js";
import { getQuestion } from "./state.js";

/**
 * A LOOP AS ONE STATEMENT.
 *
 *   FOR EACH brand IN Q2.selected
 *     WHERE loop.Category = "Premium"
 *     SKIP IF loop.code = "other"
 *     ORDER BY selection
 *     AT MOST 5
 *     BREAK WHEN Q23 >= 9
 *     RESOLVE ONCE
 *     LOOP_BRAND_AVG_SAT = avg(Q23)
 *
 * The visual editor is the way a loop is configured; this is the same
 * configuration read back as text, so a programmer can see the whole loop
 * at a glance, paste it into a spec, and check that what they built is what
 * they meant. The conditions in it are printed by the same `formatCondition`
 * the condition builder's Expression tab uses, and the set-expression source
 * by the mask builder's formatter — one grammar for each, read from the
 * definition. It is deliberately one-way: a parser for the loop's own shape
 * would be a second grammar to keep in step with the editor for ever, and
 * the conditions — the part with real logic in it — already round-trip in
 * their own editors.
 */
export function describeLoop(def: SurveyDefinition, node: LoopFlowNode): string {
  const lines: string[] = [];
  const src = node.source;
  let source: string;
  switch (src.kind) {
    case "question": {
      const q = getQuestion(def, src.questionId);
      const dim = src.dimension && src.dimension !== "options" ? `.${src.dimension}` : "";
      source = `${q?.code ?? src.questionId}${dim}.${src.filter ?? "selected"}`;
      break;
    }
    case "static": source = `[${src.items.map((i) => i.code).join(", ")}]`; break;
    case "count": source = typeof src.count === "number" ? `1..${src.count}` : `1..${src.count.kind}(${src.count.ref})`; break;
    case "variable": source = `variable ${src.ref}`; break;
    case "listFill": source = `listFill ${def.listFills.find((l) => l.id === src.listFillId)?.name ?? src.listFillId}`; break;
    case "design": source = `design ${def.designs.find((d) => d.id === src.designId)?.name ?? src.designId}`; break;
    case "setExpression": source = `(${formatSetExpression(def, src.expr)})`; break;
    default: source = (src as { kind: string }).kind;
  }
  lines.push(`FOR EACH ${node.loopVar} IN ${source}`);
  const cond = (c: LoopFlowNode["eligibleIf"]) => formatCondition(def, c, { width: 200 }).replace(/\s+/g, " ").trim();
  if (node.eligibleIf) lines.push(`  WHERE ${cond(node.eligibleIf)}`);
  if (node.invalidIf) lines.push(`  INVALID IF ${cond(node.invalidIf)}`);
  if (node.skipIf) lines.push(`  SKIP IF ${cond(node.skipIf)}`);
  const order = node.order?.kind ?? (node.randomizeIterations ? "random" : null);
  if (order && order !== "source") {
    const col = node.order?.column ? ` ${node.order.column}${node.order.direction === "desc" ? " desc" : ""}` : "";
    const custom = order === "custom" && node.order?.custom?.length ? ` [${node.order.custom.join(", ")}]` : "";
    lines.push(`  ORDER BY ${order}${col}${custom}`);
  }
  const count = node.count ?? (node.maxIterations != null ? { mode: "max" as const, value: node.maxIterations } : null);
  if (count && count.mode !== "all") {
    const v = count.value == null ? "?" : typeof count.value === "number" ? String(count.value) : `${count.value.kind}(${count.value.ref})`;
    lines.push(`  ${count.mode === "exact" ? "EXACTLY" : count.mode === "max" ? "AT MOST" : "ONLY IF AT LEAST"} ${v}`);
  }
  if (node.breakIf) lines.push(`  BREAK WHEN ${cond(node.breakIf)}`);
  if (node.resolveSource === "once") lines.push("  RESOLVE ONCE");
  for (const a of node.aggregates ?? []) {
    const q = def.questions.find((x) => x.id === a.questionRef || x.code === a.questionRef || x.variableName === a.questionRef);
    lines.push(`  LOOP_${node.loopVar.toUpperCase()}_${a.name} = ${a.op}(${q?.code ?? a.questionRef}${a.where ? ` WHERE ${cond(a.where)}` : ""})`);
  }
  return lines.join("\n");
}
