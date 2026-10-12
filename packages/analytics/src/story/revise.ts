/**
 * REVISIONS IN WORDS — read into explicit operations, shown, then applied.
 *
 * "Shorten this to three minutes", "replace this pie chart with a horizontal
 * bar chart", "move the methodology to the appendix", "use our blue and gold
 * palette", "less animation, more emphasis on the findings" — each clause
 * becomes an operation on the report definition (or a design patch), listed
 * in words before anything changes. A request that would misrepresent the
 * analysis (an axis that does not start at zero under bars, hiding the base,
 * calling a hypothesis supported, a donut for shares that do not add up) is
 * refused with the reason and a valid alternative. A change a person asked
 * for is recorded as theirs (`locked`), so regenerating the report from new
 * data does not undo it.
 */
import type { DesignConfig, Scene, StoryChartType, StoryReport } from "./types.js";
import { chartAllowed, chartWords } from "./charts.js";
import { applyDesignPatch, interpretDesignRequest, type BrandInput, type DesignPatch } from "./design.js";

export type StoryOp =
  | { op: "set_text"; sceneId: string; field: "title" | "body" | "subtitle" | "kicker" | "voiceover"; value: string }
  | { op: "set_chart"; sceneId: string; chart: StoryChartType }
  | { op: "set_bullets"; sceneId: string; items: string[] }
  | { op: "move"; sceneId: string; to: number }
  | { op: "set_section"; sceneId: string; section: "main" | "appendix"; after?: string }
  | { op: "remove"; sceneId: string }
  | { op: "set_duration"; sceneId: string; seconds: number | "auto" }
  | { op: "set_emphasis"; sceneId: string; emphasis: Scene["emphasis"] }
  | { op: "set_motion"; sceneId: string; motion: Partial<Scene["motion"]> }
  | { op: "set_layout"; sceneId: string; layout: Scene["layout"] }
  | { op: "set_highlight"; sceneId: string; categories: string[] }
  | { op: "restore"; sceneId: string }
  | { op: "design"; patch: DesignPatch };

export interface RevisionReading { ops: StoryOp[]; understood: string[]; refused: { request: string; why: string; alternative?: string }[]; unclear: string[] }

const CHART_WORDS: [RegExp, StoryChartType][] = [
  [/horizontal (bar|bars|column)/, "hbar"], [/(grouped|clustered|side[- ]by[- ]side) (bar|bars|column)/, "grouped_bar"], [/(100%|percent(age)?|stacked)/, "stacked_100"],
  [/(pie|donut|doughnut)/, "donut"], [/line/, "line"], [/(vertical )?(bar|bars|column)s?( chart)?/, "bar"],
];
const chartIn = (s: string): StoryChartType | null => { for (const [re, t] of CHART_WORDS) if (re.test(s)) return t; return null; };

const SECTION_WORDS: [RegExp, Scene["kind"][]][] = [
  [/method(ology)?|how (it|the study) was done/, ["method"]], [/sample|who took part|respondents?|profile/, ["sample"]], [/objective|research question/, ["objective"]],
  [/summary|executive summary/, ["summary"]], [/hypothes(is|es)|verdicts?/, ["hypotheses"]], [/limitations?|caveats?/, ["limitations"]],
  [/recommendations?|next steps/, ["recommendations"]], [/conclusions?|implications?|what it means/, ["conclusions"]], [/themes?|open[- ]text/, ["themes"]],
  [/statistic(al)? highlight/, ["statistic"]], [/(since the last wave|wave)/, ["wave"]], [/closing|ending|outro|final (slide|scene)/, ["closing"]], [/title|opening|intro(duction)?|cover/, ["title"]],
];

function findScenes(report: StoryReport, phrase: string, selected?: string): Scene[] {
  const p = phrase.toLowerCase();
  if (/\b(this|current|selected) (scene|slide|chart)\b/.test(p) && selected) return report.scenes.filter((s) => s.id === selected);
  const num = /\b(?:scene|slide) (\d+)\b/.exec(p);
  if (num) { const main = report.scenes.filter((s) => s.section === "main"); const s = main[Number(num[1]) - 1]; return s ? [s] : []; }
  for (const [re, kinds] of SECTION_WORDS) if (re.test(p)) return report.scenes.filter((s) => kinds.includes(s.kind));
  const finding = /\bfinding (\d+)\b/.exec(p);
  if (finding) { const fs = report.scenes.filter((s) => s.kind === "finding"); const s = fs[Number(finding[1]) - 1]; return s ? [s] : []; }
  if (/\b(findings?|key findings?)\b/.test(p)) return report.scenes.filter((s) => s.kind === "finding" || s.kind === "comparison");
  return [];
}

/** Read a revision request into operations. `selected` is the scene open in the storyboard ("this chart"). */
export function interpretRevision(text: string, report: StoryReport, ctx: { selected?: string; brand?: BrandInput | null } = {}): RevisionReading {
  const t = ` ${text.toLowerCase().replace(/[“”"']/g, "")} `;
  const ops: StoryOp[] = [];
  const understood: string[] = [];
  const refused: RevisionReading["refused"] = [];
  const say = (s: string) => understood.push(s);

  /* refusals first: requests that would misrepresent the analysis */
  if ((/\b(axis|scale)\b/.test(t) && (/\b(start|starts|begin|begins|from|at)\s+(at\s+)?([1-9]\d*|higher|above zero)\b/.test(t) || /\bnot (start|begin) at (zero|0)\b/.test(t))) || /\b(truncate|cut off|zoom in on) the (y-)?axis\b/.test(t)) refused.push({ request: "change where the value axis starts", why: "bars are read by their length; an axis that does not start at zero makes small differences look large", alternative: "show the difference as a labelled value, or use a line chart for an ordered series" });
  if (/\b(hide|remove|drop|without)\b.*\b(base|sample sizes?|n =|n=)\b/.test(t)) refused.push({ request: "hide the base sizes", why: "a percentage or mean without its base cannot be judged — the base is part of the finding", alternative: "the base can be moved into the source line in smaller type (it already is)" });
  if (/\b(say|claim|state|show|call|mark)\b.*\b(supported|proven|significant|confirmed)\b/.test(t) && !/\bnot\b/.test(t)) refused.push({ request: "state a result the tests did not give", why: "verdicts and significance come from the tests the plan ran; the report cannot say more than they did", alternative: "add a test for it to the analysis plan, apply the plan, and regenerate" });
  if (/\b3d|three[- ]dimensional\b/.test(t)) refused.push({ request: "3D charts", why: "perspective distorts the lengths and areas a chart is read by", alternative: "flat charts, with depth kept to the cards and backgrounds" });
  if (/\b(hide|remove|drop)\b.*\bnon[- ]?significant\b/.test(t)) refused.push({ request: "drop the non-significant results", why: "leaving out tests that did not reach significance overstates the ones that did", alternative: "move them to the appendix — they stay in the report, out of the main story" });

  /* charts */
  const clauses = t.split(/[.;!?]|,\s*(?=(?:and |then )?(?:replace|swap|change|move|make|use|turn|switch|convert|remove|delete|shorten|draw|show)\b)|\band\b(?=\s+(?:then\s+)?(?:replace|swap|change|move|make|use|turn|switch|convert|remove|delete|shorten|draw|show)\b)/);
  for (const clause of clauses) {
    const replace = /\b(?:replace|swap|change|turn|switch|convert|make|use|draw|show)\s+(.*?)\s+(?:with|to|into|as)\s+(.+)$/.exec(clause.trim());
    if (!replace) continue;
    const to = chartIn(replace[2]);
    if (!to || !/\b(chart|graph|visual|bars?|pie|donut|doughnut|line|column)\b/.test(clause)) continue;
    const fromType = chartIn(replace[1]);
    const where = /\b(?:on|in|for)\s+(.+)$/.exec(replace[2])?.[1] ?? "";
    let targets = findScenes(report, `${replace[1]} ${where}`, ctx.selected).filter((s) => s.visual.type === "chart");
    if (!targets.length && ctx.selected && /\b(this|current|selected|the)\b/.test(replace[1]) && !fromType) targets = report.scenes.filter((s) => s.id === ctx.selected && s.visual.type === "chart");
    if (!targets.length && fromType) targets = report.scenes.filter((s) => s.visual.type === "chart" && s.visual.chart === fromType);
    if (!targets.length) { refused.push({ request: `change a chart to ${chartWords(to)}`, why: "it is not clear which chart — select the scene first, or name it (\"finding 2\", \"scene 5\")" }); continue; }
    for (const s of targets) {
      if (s.visual.type !== "chart") continue;
      const check = chartAllowed(to, s.visual.data);
      if (!check.ok) { const alt = s.visual.recommendation?.alternatives.find((a) => a.allowed)?.type ?? s.visual.recommendation?.type; refused.push({ request: `${chartWords(to)} for “${s.title.slice(0, 50)}”`, why: check.why, ...(alt ? { alternative: chartWords(alt) } : {}) }); continue; }
      ops.push({ op: "set_chart", sceneId: s.id, chart: to }); say(`“${s.title.slice(0, 50)}” as ${chartWords(to)}`);
    }
  }

  /* moving sections */
  for (const m of t.matchAll(/\bmove (?:the )?(.{3,40}?) (?:to|into) (?:the )?(appendix|main (?:story|presentation|report|deck)|front|beginning|start|end)\b/g)) {
    const scenes = findScenes(report, m[1], ctx.selected);
    if (!scenes.length) { understood.push(`no “${m[1].trim()}” section to move`); continue; }
    for (const s of scenes) {
      if (m[2] === "appendix") { ops.push({ op: "set_section", sceneId: s.id, section: "appendix" }); say(`${s.kind.replace("_", " ")} moved to the appendix`); }
      else if (/^main/.test(m[2])) { ops.push({ op: "set_section", sceneId: s.id, section: "main" }); say(`${s.title.slice(0, 40)} brought into the main story`); }
      else { const idx = /end/.test(m[2]) ? report.scenes.filter((x) => x.section === "main").length - 1 : 1; ops.push({ op: "move", sceneId: s.id, to: idx }); say(`${s.kind.replace("_", " ")} moved to the ${m[2]}`); }
    }
  }
  if (/\b(most important|key|main|strongest) (cross[- ]?tab|table)\b.*\b(main|presentation|story|report)\b/.test(t)) {
    const app = report.scenes.find((s) => s.kind === "appendix_table" && s.section === "appendix");
    if (app) { const src = app.notes.sources[0]; const finding = report.scenes.find((s) => s.kind === "finding" && s.notes.sources.some((x) => x.name === src?.name)); ops.push({ op: "set_section", sceneId: app.id, section: "main", ...(finding ? { after: finding.id } : {}) }); say(`the full table “${app.title.slice(0, 50)}” in the main story${finding ? ", after its finding" : ""}`); }
    else understood.push("every cross-tab is already in the main story");
  }
  for (const m of t.matchAll(/\b(?:remove|delete|drop|cut) (?:the )?(.{3,40}?) (?:scene|slide|section)s?\b/g)) {
    const scenes = findScenes(report, m[1], ctx.selected).filter((s) => s.kind !== "title");
    for (const s of scenes) { ops.push({ op: "remove", sceneId: s.id }); say(`remove “${s.title.slice(0, 50)}”`); }
  }

  /* durations */
  const sceneDur = /\b(this scene|this slide|scene \d+|slide \d+|the (?:title|opening|summary|closing)(?: scene)?)\b.{0,20}?\b(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b/.exec(t);
  if (sceneDur) { const scenes = findScenes(report, sceneDur[1], ctx.selected); for (const s of scenes) { ops.push({ op: "set_duration", sceneId: s.id, seconds: Number(sceneDur[2]) }); say(`“${s.title.slice(0, 40)}” held for ${sceneDur[2]}s (never below its reading time)`); } }

  /* emphasis */
  if (/\b(more )?emphasis on (the )?(key )?findings\b|\bhighlight (the )?findings\b/.test(t)) for (const s of report.scenes.filter((x) => x.kind === "finding")) { ops.push({ op: "set_emphasis", sceneId: s.id, emphasis: "focus" }); }
  if (ops.some((o) => o.op === "set_emphasis")) say("emphasis on the findings");

  /* the opening, for executives: the summary up front and short */
  if (/\b(opening|start|beginning|intro)\b.*\bexecutive\b|\bexecutive[- ]friendly\b/.test(t)) {
    const sum = report.scenes.find((s) => s.kind === "summary");
    if (sum && sum.visual.type === "bullets") { ops.push({ op: "move", sceneId: sum.id, to: 1 }); if (sum.visual.items.length > 3) ops.push({ op: "set_bullets", sceneId: sum.id, items: sum.visual.items.slice(0, 3) }); say("the executive summary straight after the title, cut to its three strongest points"); }
    const method = report.scenes.find((s) => s.kind === "method" && s.section === "main");
    if (method) { ops.push({ op: "set_section", sceneId: method.id, section: "appendix" }); say("the methodology moved to the appendix (still in the deck)"); }
  }

  /* the look: everything the design reader understands */
  const design = interpretDesignRequest(text, { brand: ctx.brand ?? null, current: report.design });
  if (Object.keys(design.patch).length) { ops.push({ op: "design", patch: design.patch }); understood.push(...design.understood); }
  if (/\b(both|the video and the (powerpoint|deck|slides)|powerpoint and (the )?video)\b/.test(t)) understood.push("both outputs are made from this one report, so every change applies to the video and the PowerPoint");
  if (/\b(reword|rewrite|rephrase|more (persuasive|concise|friendly))\b/.test(t) && !ops.some((o) => o.op === "set_text")) refused.push({ request: "rewording text", why: "rewording is done by the language model when one is configured, or by editing the scene's text directly — the engine does not invent wording" });

  const unclear = understood.length || ops.length || refused.length ? [] : [text.trim()];
  return { ops, understood: [...new Set(understood)], refused, unclear };
}

/** Apply operations; returns the new report and, in words, what changed. Operations from a person lock what they touch. */
export function applyOps(report: StoryReport, ops: StoryOp[], ctx: { brand?: BrandInput | null; byPerson?: boolean } = {}): { report: StoryReport; changes: string[]; affected: string[]; refused: string[] } {
  const r: StoryReport = structuredClone(report);
  const changes: string[] = [];
  const refused: string[] = [];
  const affected = new Set<string>();
  const byPerson = ctx.byPerson !== false;
  const lock = (s: Scene, field: string) => { if (byPerson && !s.locked.includes(field)) s.locked.push(field); };
  const sceneOf = (id: string) => r.scenes.find((s) => s.id === id);
  for (const o of ops) {
    if (o.op === "design") {
      const { design, adjustments } = applyDesignPatch(r.design, o.patch, { brand: ctx.brand ?? null });
      r.design = design as DesignConfig;
      changes.push("design updated");
      for (const a of adjustments) changes.push(`${a.token} adjusted to ${a.to}: ${a.why}`);
      r.scenes.forEach((s) => affected.add(s.id));
      continue;
    }
    const s = sceneOf(o.sceneId);
    if (!s) { refused.push(`no scene ${o.sceneId}`); continue; }
    affected.add(s.id);
    switch (o.op) {
      case "set_text": (s[o.field] as string | undefined) = o.value.trim() || undefined; if (o.field === "title" && !o.value.trim()) { refused.push("a scene needs a title"); s.title = report.scenes.find((x) => x.id === s.id)!.title; break; } lock(s, o.field); changes.push(`${o.field} of “${s.title.slice(0, 40)}” edited`); break;
      case "set_bullets": if (s.visual.type === "bullets") { s.visual = { type: "bullets", items: o.items.map((x) => x.trim()).filter(Boolean) }; lock(s, "visual"); changes.push(`points of “${s.title.slice(0, 40)}” edited`); } break;
      case "set_chart": {
        if (s.visual.type !== "chart") { refused.push(`“${s.title.slice(0, 40)}” has no chart`); break; }
        const check = chartAllowed(o.chart, s.visual.data);
        if (!check.ok) { refused.push(`${chartWords(o.chart)} for “${s.title.slice(0, 40)}”: ${check.why}`); break; }
        s.visual = { ...s.visual, chart: o.chart };
        lock(s, "chart"); changes.push(`“${s.title.slice(0, 40)}” drawn as ${chartWords(o.chart)}`); break;
      }
      case "set_highlight": if (s.visual.type === "chart") { s.visual = { ...s.visual, highlight: o.categories.filter((c) => s.visual.type === "chart" && s.visual.data.categories.includes(c)) }; lock(s, "highlight"); changes.push(`highlight on “${s.title.slice(0, 40)}”: ${o.categories.join(", ") || "none"}`); } break;
      case "move": {
        const main = r.scenes.filter((x) => x.section === s.section);
        const from = main.indexOf(s);
        const to = Math.max(s.kind === "title" ? 0 : 1, Math.min(main.length - 1, o.to));
        if (from < 0 || from === to) break;
        main.splice(from, 1); main.splice(to, 0, s);
        const other = r.scenes.filter((x) => x.section !== s.section);
        r.scenes = s.section === "main" ? [...main, ...other] : [...other, ...main];
        lock(s, "order"); changes.push(`“${s.title.slice(0, 40)}” moved to position ${to + 1}`); break;
      }
      case "set_section": {
        if (s.kind === "title") { refused.push("the title scene stays in the main story"); break; }
        s.section = o.section;
        const rest = r.scenes.filter((x) => x !== s);
        if (o.section === "main") {
          const at = o.after ? rest.findIndex((x) => x.id === o.after) + 1 : rest.filter((x) => x.section === "main").length - 1;
          rest.splice(Math.max(1, at), 0, s);
        } else rest.push(s);
        r.scenes = [...rest.filter((x) => x.section === "main"), ...rest.filter((x) => x.section === "appendix")];
        lock(s, "section"); changes.push(`“${s.title.slice(0, 40)}” → ${o.section === "main" ? "main story" : "appendix"}`); break;
      }
      case "remove": if (s.kind === "title") { refused.push("the title scene cannot be removed"); break; } r.scenes = r.scenes.filter((x) => x !== s); changes.push(`“${s.title.slice(0, 40)}” removed`); break;
      case "set_duration": s.duration = o.seconds === "auto" ? "auto" : Math.max(1.5, Math.min(60, o.seconds)); lock(s, "duration"); changes.push(`“${s.title.slice(0, 40)}” duration ${o.seconds === "auto" ? "automatic" : `${s.duration}s`}`); break;
      case "set_emphasis": s.emphasis = o.emphasis; lock(s, "emphasis"); changes.push(`“${s.title.slice(0, 40)}” emphasis ${o.emphasis}`); break;
      case "set_motion": s.motion = { ...s.motion, ...o.motion }; lock(s, "motion"); changes.push(`“${s.title.slice(0, 40)}” motion changed`); break;
      case "set_layout": s.layout = o.layout; lock(s, "layout"); changes.push(`“${s.title.slice(0, 40)}” layout ${o.layout}`); break;
      case "restore": if (s.recommended) { const keep = { id: s.id, recommended: s.recommended }; Object.assign(s, structuredClone(s.recommended), keep, { locked: [] }); changes.push(`“${s.title.slice(0, 40)}” restored to the recommended version`); } break;
    }
  }
  return { report: r, changes, affected: [...affected], refused };
}

/** describe an operation before it is applied */
export function describeOp(o: StoryOp, report: StoryReport): string {
  const s = "sceneId" in o ? report.scenes.find((x) => x.id === o.sceneId) : undefined;
  const name = s ? `“${s.title.slice(0, 50)}”` : "";
  switch (o.op) {
    case "design": return `Design: ${Object.keys(o.patch).join(", ")}`;
    case "set_chart": return `${name}: draw as ${chartWords(o.chart)}`;
    case "set_section": return `${name}: move to the ${o.section === "main" ? "main story" : "appendix"}`;
    case "move": return `${name}: move to position ${o.to + 1}`;
    case "remove": return `${name}: remove`;
    case "set_duration": return `${name}: ${o.seconds === "auto" ? "automatic duration" : `${o.seconds}s`}`;
    case "set_emphasis": return `${name}: ${o.emphasis} emphasis`;
    case "set_text": return `${name}: new ${o.field}`;
    case "set_bullets": return `${name}: ${o.items.length} points`;
    case "set_motion": return `${name}: motion`;
    case "set_layout": return `${name}: layout ${o.layout}`;
    case "set_highlight": return `${name}: highlight ${o.categories.join(", ")}`;
    case "restore": return `${name}: restore the recommended version`;
  }
}

/**
 * A fresh plan for the same report (new data, a regenerated scene): every
 * scene a person did not touch takes the new version; a touched field keeps
 * the person's value; scenes the person removed stay removed and scenes the
 * person moved stay where they put them.
 */
export function mergeRegenerated(current: StoryReport, fresh: StoryReport, onlyScene?: string): StoryReport {
  const out = structuredClone(current);
  out.createdFrom = fresh.createdFrom;
  out.subtitle = fresh.subtitle;
  for (const f of fresh.scenes) {
    if (onlyScene && f.id !== onlyScene) continue;
    const i = out.scenes.findIndex((s) => s.id === f.id);
    if (i < 0) continue;
    const old = out.scenes[i];
    const next: Scene = { ...structuredClone(f), locked: old.locked, section: old.locked.includes("section") ? old.section : f.section };
    for (const k of old.locked) {
      if (k === "chart" && old.visual.type === "chart" && next.visual.type === "chart" && chartAllowed(old.visual.chart, next.visual.data).ok) next.visual = { ...next.visual, chart: old.visual.chart };
      else if (k === "visual") next.visual = old.visual;
      else if (k === "highlight" && old.visual.type === "chart" && next.visual.type === "chart") next.visual = { ...next.visual, highlight: old.visual.highlight };
      else if (k in old && k !== "chart" && k !== "order" && k !== "section" && k !== "highlight") (next as unknown as Record<string, unknown>)[k] = (old as unknown as Record<string, unknown>)[k];
    }
    out.scenes[i] = next;
  }
  return out;
}
