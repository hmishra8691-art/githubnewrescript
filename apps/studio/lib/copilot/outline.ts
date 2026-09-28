import type { SurveyDefinition } from "@rescript/schema";
import { listBlocks, formatCondition, describeUxTarget, uxContextFor } from "@rescript/engine";
import { surveyContext } from "../intelligent/context.ts";

/**
 * THE SURVEY-STATE SNAPSHOT a copilot turn is given (the copilot brief §8).
 *
 * The Intelligent mode's `surveyContext` — one line per question, pages,
 * blocks, embedded data, loops, quotas — plus what an EDITING model needs
 * and a one-line-per-question listing does not carry: which questions each
 * block holds, and, for the questions this request names, their display
 * logic and skip rules in full. A 400-question survey gets its first 60
 * questions in full and the rest by code, plus the named ones in full, so
 * the prompt stays bounded however large the survey is.
 */
export function copilotOutline(def: SurveyDefinition, opts: { selectedId?: string | null; focusIds?: string[]; ux?: boolean } = {}): string {
  const n = def.questions.length;
  const base = surveyContext(def, { selectedId: opts.selectedId ?? null, focusIds: opts.focusIds ?? [], limit: n > 150 ? 60 : 150, textWidth: n > 150 ? 70 : 110 });
  const lines = [base];
  const code = (id: string) => def.questions.find((q) => q.id === id)?.code ?? id;
  const blocks = listBlocks(def.flow as unknown[]);
  if (blocks.length) {
    lines.push("Block contents: " + blocks.slice(0, 60).map((b) => `“${b.title ?? b.id}”: ${b.pages.map((p) => p.node.questionIds.map(code).join(" ")).join(" | ") || "(empty)"}`).join("; "));
  }
  const focus = new Set([...(opts.focusIds ?? []), ...(opts.selectedId ? [opts.selectedId] : [])]);
  for (const id of focus) {
    const q = def.questions.find((x) => x.id === id);
    if (!q) continue;
    const bits: string[] = [];
    if (q.displayLogic) bits.push(`display logic: ${formatCondition(def, q.displayLogic, { width: 400 }).replace(/\s+/g, " ")}`);
    for (const s of q.skipLogic ?? []) {
      const t = s.target;
      const to = t.kind === "question" ? code(t.ref ?? "") : t.kind === "end" ? "end" : t.kind === "terminate" ? `screen out (${t.status ?? "terminated"})` : `${t.kind} ${t.ref ?? ""}`;
      bits.push(`skip when ${formatCondition(def, s.when, { width: 400 }).replace(/\s+/g, " ")} → ${to}`);
    }
    if (q.rows?.length) bits.push(`rows: ${q.rows.slice(0, 20).map((r) => `${r.code}=${String(r.label).replace(/<[^>]+>/g, "").replace(/(\*\*|__)(.+?)\1/g, "$2").trim()}`).join(", ")}`);
    if (q.options?.length) bits.push(`option codes: ${q.options.slice(0, 30).map((o) => `${o.code}=${String(o.label).replace(/<[^>]+>/g, "").replace(/(\*\*|__)(.+?)\1/g, "$2").trim()}`).join(", ")}`);
    if (q.punches?.length) bits.push(`punch rules: ${q.punches.length}`);
    if (q.randomization?.enabled) bits.push("options randomized");
    if (bits.length) lines.push(`${q.code} details: ${bits.join(" · ")}`);
  }
  /*
   * THE LOOK AND BEHAVIOUR as it is, so the copilot modifies what exists
   * rather than adding a second, competing style. Every turn gets the list
   * (it is short, and absent on most surveys); a UX request also gets the
   * theme and, for the questions it names, their layout and everything that
   * styles them.
   */
  const ux = def.ux;
  const items = ux ? ux.styles.length + ux.animations.length + ux.behaviors.length : 0;
  if (opts.ux) {
    const b = def.branding;
    lines.push(`Theme: primary ${b.colors?.primary ?? "default"}, font ${b.typography?.fontFamily ?? "default"}, cards ${b.layout?.cardStyle ?? "card"}, buttons ${b.buttons?.style ?? "solid"}${b.customCss ? `, Branding custom CSS ${b.customCss.length} chars` : ""}${b.customJs ? ", Branding custom JS (hand-written)" : ""}`);
  }
  if (ux && items) {
    lines.push(`UX configuration (${items} item${items === 1 ? "" : "s"}; change these by id rather than adding competing ones):`);
    for (const st of ux.styles.slice(0, 40)) lines.push(`  style ${st.id} “${st.label}” on ${describeUxTarget(def, st.target)}: ${st.rules.map((r) => `${[r.state, r.media, r.whenClass ? `when ${r.whenClass}` : "", r.selector].filter(Boolean).join(" ") || "base"} {${Object.entries(r.declarations).map(([k, v]) => `${k}:${v}`).join("; ").slice(0, 160)}}`).join(" · ").slice(0, 400)}${st.css ? ` + scoped CSS (${st.css.length} chars)` : ""}`);
    for (const a of ux.animations.slice(0, 40)) lines.push(`  animation ${a.id} “${a.label}” on ${describeUxTarget(def, a.target)}: ${a.preset} on ${a.trigger}, ${a.durationMs}ms${a.delayMs ? ` +${a.delayMs}ms` : ""}${a.staggerMs ? `, stagger ${a.staggerMs}ms` : ""}${a.iterations !== 1 ? `, ×${a.iterations}` : ""}${a.media ? `, ${a.media}` : ""}`);
    for (const bh of ux.behaviors.slice(0, 40)) lines.push(`  behaviour ${bh.id} “${bh.label}” on ${describeUxTarget(def, bh.target)}: ${bh.script ? `script: ${bh.script.replace(/\s+/g, " ").slice(0, opts.ux ? 600 : 120)}` : `on ${bh.on}${bh.options?.length ? ` (${bh.options.join(", ")})` : ""} → ${bh.effects.map((e) => `${e.do}${e.target ? ` ${describeUxTarget(def, e.target)}` : ""}${e.preset ? ` ${e.preset}` : ""}${e.className ? ` “${e.className}”` : ""}`).join(", ")}`}`);
  }
  if (opts.ux) for (const id of focus) {
    const q = def.questions.find((x) => x.id === id);
    if (q) lines.push(`${q.code} ux: ${uxContextFor(def, id).join(" · ")}`);
  }
  const r = def.research;
  if (r) {
    const role = (id: string) => code(id);
    lines.push(`Research design: ${[r.objective ? `objective: ${r.objective}` : "", r.hypotheses.length ? `hypotheses: ${r.hypotheses.join(" | ")}` : "", r.population ? `population: ${r.population}` : "", r.constructs.length ? `constructs: ${r.constructs.map((c) => `${c.name} (${c.role}${c.questionIds.length ? `: ${c.questionIds.map(role).join(" ")}` : ", not measured"})`).join("; ")}` : ""].filter(Boolean).join(" · ")}`);
  }
  return lines.join("\n");
}
