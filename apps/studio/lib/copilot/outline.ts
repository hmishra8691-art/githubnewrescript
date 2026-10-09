import type { SurveyDefinition } from "@rescript/schema";
import { listBlocks, formatCondition, structuredHypotheses, describeHypothesis, describeUxTarget, uxContextFor, inferQuestionAnalysis, effectiveLocalization, lintLanguage, translatableElements, languageName, reviewQuotas, quotaAdvice } from "@rescript/engine";
import type { FlowNode } from "@rescript/schema";
import { briefText, type AnalysisRun } from "@rescript/analytics";
import { hypothesisLabel } from "@rescript/schema";
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
export function copilotOutline(def: SurveyDefinition, opts: { selectedId?: string | null; focusIds?: string[]; ux?: boolean; analysis?: boolean; translation?: boolean; quota?: boolean; quotaCounts?: Record<string, Record<string, number>> | null; findings?: boolean; analysisRun?: Pick<AnalysisRun, "computedAt" | "n" | "findings" | "verdicts" | "warnings" | "environment" | "trigger"> | null } = {}): string {
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
    // each hypothesis with its structured reading (Phase 3): type, direction, the sides — recorded, else parsed from its words
    const readings = structuredHypotheses(def);
    lines.push(`Research design: ${[r.objective ? `objective: ${r.objective}` : "", r.hypotheses.length ? `hypotheses: ${r.hypotheses.map((h, i) => `${hypothesisLabel(i)} ${h}${readings[i] ? ` {${describeHypothesis(readings[i])}${readings[i].status ? `, ${readings[i].status}` : ""}}` : ""}`).join(" | ")}` : "", r.researchQuestions?.length ? `research questions: ${r.researchQuestions.join(" | ")}` : "", r.kpis?.length ? `KPIs: ${r.kpis.map((k) => `${k.name}${k.variable ? ` (${k.variable}${k.measure ? `, ${k.measure}` : ""})` : ""}${k.target ? ` target ${k.target}` : ""}`).join("; ")}` : "", r.population ? `population: ${r.population}` : "", r.audience ? `audience: ${r.audience.description}${r.audience.characteristics?.length ? ` — ${r.audience.characteristics.join("; ")}` : ""}${r.audience.literacy ? ` (${r.audience.literacy} language)` : ""}${r.audience.tone ? `, tone ${r.audience.tone}` : ""}` : "", r.constructs.length ? `constructs: ${r.constructs.map((c) => `${c.name} (${c.role}${c.questionIds.length ? `: ${c.questionIds.map(role).join(" ")}` : ", not measured"})`).join("; ")}` : ""].filter(Boolean).join(" · ")}`);
  }
  /*
   * THE ANALYSIS FRAMEWORK, as the model must address it: the saved plan with
   * its ids (so "remove the age crosstab" is remove_crosstab by id), and the
   * roles that are set or inferred (so a request about "the outcome" resolves).
   * Only on analysis turns and generation — a wording edit does not need it.
   */
  if (opts.analysis) {
    const plan = r?.analysisPlan;
    const asked = def.questions.filter((q) => !["html", "custom_component"].includes(q.type));
    const roles = asked.map((q) => ({ q, a: inferQuestionAnalysis(def, q) })).filter(({ a }) => a.role !== "descriptive" || !!a.construct);
    if (roles.length) lines.push(`Variable roles (set or inferred): ${roles.slice(0, 60).map(({ q, a }) => `${q.code}=${a.role}/${a.measurement}${a.hypotheses.length ? `[${a.hypotheses.join(",")}]` : ""}`).join(" ")}`);
    if (plan) {
      lines.push(`Analysis plan (${plan.source ?? "saved"}; name items by id):`);
      for (const x of plan.crosstabs.slice(0, 40)) lines.push(`  crosstab ${x.id} P${x.priority}: ${x.rows.join("+")} by ${x.columns.join("+")}${x.hypotheses.length ? ` [${x.hypotheses.join(",")}]` : ""}${x.reason ? ` — ${x.reason}` : ""}`);
      for (const t of plan.tests.slice(0, 40)) lines.push(`  test ${t.id} P${t.priority}: ${t.method}${t.outcome ? ` outcome ${t.outcome}` : ""}${t.variables.length ? ` vars ${t.variables.join(",")}` : ""}${t.groupBy ? ` by ${t.groupBy}` : ""}${t.moderator ? ` moderator ${t.moderator}` : ""}${t.mediator ? ` mediator ${t.mediator}` : ""}${t.hypotheses.length ? ` [${t.hypotheses.join(",")}]` : ""}`);
      for (const d of plan.derived.slice(0, 20)) lines.push(`  derived ${d.name}: ${d.kind} of ${d.from.join(",")}`);
      if (plan.segments.length) lines.push(`  segments: ${plan.segments.map((sg) => `${sg.name} (${sg.by.join(",")})`).join("; ")}`);
    } else lines.push("Analysis plan: none saved yet (propose_analysis_plan writes the engine's framework; set_analysis_plan writes yours).");
  }
  /*
   * THE QUOTAS, on a quota turn (the base context names them on every turn):
   * every cell with its limit and condition, where the check sits, the review's
   * findings about them, and — when the Studio sent the live counts — what
   * the counts say, so "which cells are behind?" is answered from numbers.
   */
  if (def.quotas.length) {
    const flow = def.flow as FlowNode[];
    const checkOf = (id: string) => { const i = flow.findIndex((n) => n.type === "quota_check" && (n as { quotaIds: string[] }).quotaIds.includes(id)); if (i < 0) return "not checked anywhere"; const before = flow.slice(0, i).reverse().find((n) => n.type === "block" || n.type === "page") as { title?: string; id: string } | undefined; return before ? `checked after “${before.title ?? before.id}”` : "checked at the start"; };
    // (the base context already names the quotas on every turn)
    if (opts.quota) {
      lines.push(`Quotas (name cells by label; limits are counts unless %):`);
      for (const q of def.quotas) {
        lines.push(`  ${q.name} [id ${q.id}] — ${q.mode}, when full: ${q.onFull.kind}${q.onFull.url ? ` → ${q.onFull.url}` : ""}${q.targetTotal ? `, total ${q.targetTotal}` : ""}, ${checkOf(q.id)}`);
        for (const c of q.cells.slice(0, 60)) { const n = opts.quotaCounts?.[q.id]?.[c.id]; lines.push(`    ${c.label}: ≤ ${c.limit}${c.limitType === "percent" ? "%" : ""}${n !== undefined ? ` (${n} so far)` : ""} when ${formatCondition(def, c.when)}`); }
        if (q.cells.length > 60) lines.push(`    … and ${q.cells.length - 60} more cells`);
      }
      const findings = reviewQuotas(def);
      if (findings.length) lines.push(`Quota review: ${findings.slice(0, 12).map((f) => `[${f.severity}] ${f.message}`).join(" ")}`);
      if (opts.quotaCounts) {
        const advice = quotaAdvice(def, opts.quotaCounts).flatMap((a) => a.lines.filter((l) => l.kind !== "no_data" && l.kind !== "on_track").map((l) => `${a.name}: ${l.message}`));
        if (advice.length) lines.push(`Fieldwork (from the live counts): ${advice.slice(0, 12).join(" ")}`);
      }
    }
  } else if (opts.quota) lines.push("Quotas: none yet (create_quota).");

  /*
   * THE FINDINGS, on a findings or analysis turn: the latest analysis run —
   * verdicts and findings with their evidence — so what the data showed is
   * answered from numbers the Studio computed, never from the model's guess.
   */
  if (opts.findings || (opts.analysis && opts.analysisRun)) {
    if (opts.analysisRun) lines.push(briefText(opts.analysisRun, { maxFindings: opts.findings ? 25 : 10 }));
    else lines.push(`Analysis run: none yet — ${def.research?.analysisPlan ? "the plan has not been run on the responses (the researcher runs it from the Findings tab, or it runs at the fieldwork milestones)" : "there is no analysis plan yet (propose_analysis_plan)"}; there are no results to report.`);
  }

  /*
   * THE LANGUAGES, on a translation turn: which versions exist and how far
   * along each is, the glossary (what never translates, what is preferred),
   * the routing — and for every question the request names, its elements
   * with the existing translation and status in each language, so the model
   * translates what is missing or outdated and leaves the approved alone.
   */
  if (opts.translation) {
    const loc = effectiveLocalization(def);
    const targets = loc.languages;
    lines.push(`Source language: ${loc.sourceLanguage}${loc.sourceLocale ? ` (${loc.sourceLocale})` : ""}. Language versions: ${targets.length ? targets.map((l) => { const r = lintLanguage(def, l.code); const stale = r.issues.filter((i) => i.kind === "stale_source").length; return `${l.code}${l.locale ? `/${l.locale}` : ""} ${languageName(l.code, l)} (${l.status}${l.enabled ? "" : ", not offered"}; ${r.completion}% translated, ${r.missing} missing${stale ? `, ${stale} outdated` : ""}, ${r.approved} approved${l.notes ? `; notes: ${l.notes}` : ""})`; }).join("; ") : "none yet (add_language)"}`);
    if (loc.glossary.length) lines.push(`Glossary: ${loc.glossary.slice(0, 60).map((g) => `${g.source}${g.doNotTranslate ? " (never translate)" : Object.keys(g.targets).length ? ` → ${Object.entries(g.targets).map(([l, t]) => `${l}: ${t}`).join(", ")}` : ""}`).join("; ")}`);
    const r = loc.routing;
    lines.push(`Language routing: order ${r.order.join(" → ")}; URL ?${r.urlParam}=; embedded field ${r.embeddedField}${Object.keys(r.countryMap).length ? `; countries ${Object.entries(r.countryMap).map(([c, l]) => `${c} → ${l}`).join(", ")}` : ""}${r.rules.length ? `; ${r.rules.length} rule${r.rules.length === 1 ? "" : "s"}` : ""}; switcher ${r.allowSwitch ? "on" : "off"}${r.fallback ? `; fallback ${r.fallback}` : ""}`);
    if (targets.length) {
      const els = translatableElements(def);
      const focusSet = new Set(opts.focusIds ?? []);
      const shown = els.filter((e) => (e.questionId ? focusSet.has(e.questionId) : focusSet.size === 0 || e.kind === "end_message" || e.kind === "survey_title"));
      const budget = shown.slice(0, 400);
      if (budget.length) {
        lines.push(`Translatable elements${focusSet.size ? " of the named questions" : ""} (target → source | existing translations):`);
        for (const e of budget) {
          const t = targetFor(e);
          const existing = targets.map((l) => { const x = loc.translations[l.code]?.[e.key]; return x && x.status !== "not_translated" && x.text.trim() ? `${l.code} [${x.status}] "${x.text.replace(/\s+/g, " ").slice(0, 160)}"` : `${l.code} —`; }).join(" · ");
          lines.push(`  ${t} → "${e.source.replace(/\s+/g, " ").slice(0, 240)}" | ${existing}`);
        }
        if (shown.length > budget.length) lines.push(`  … and ${shown.length - budget.length} more elements (name the questions to see them)`);
      }
    }
  }
  return lines.join("\n");
}

/** an element's key as the model addresses it: Q5, Q5.option:2, Q5.row:r1, meta:title, end:<id>, ui:required… */
function targetFor(e: { key: string; questionCode?: string; code?: string; kind: string }): string {
  const q = e.questionCode;
  switch (e.kind) {
    case "question_text": return q!;
    case "question_instruction": return `${q}.instruction`;
    case "question_description": return `${q}.description`;
    case "question_placeholder": return `${q}.placeholder`;
    case "option": return `${q}.option:${e.code}`;
    case "option_alt": return `${q}.alt:${e.code}`;
    case "row": return `${q}.row:${e.code}`;
    case "row_placeholder": return e.key;
    case "column": return `${q}.column:${e.code}`;
    case "column_option": return `${q}.column:${(e.code ?? "").split(":")[0]}.option:${(e.code ?? "").split(":")[1]}`;
    case "column_placeholder": return e.key;
    case "scale_label": return `${q}.scale:${/left/i.test(e.key) ? "low" : "high"}`;
    case "validation_message": return `${q}.validation:${Number(e.key.split(":").pop()) + 1}`;
    case "probe_prompt": return `${q}.probe`;
    case "survey_title": return "meta:title";
    case "survey_description": return "meta:description";
    case "end_message": return `end:${e.key.split(":")[1]}`;
    case "page_title": return `block:${e.key.split(":")[1]}`;
    case "quota_message": return e.key;
    case "button": return `button:${e.key.split(":").pop()}`;
    case "ui": return e.key;
    default: return e.key;
  }
}
