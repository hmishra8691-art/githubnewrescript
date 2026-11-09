import type { SurveyDefinition } from "@rescript/schema";
import type { SimulationConfig, SimulationRunReport } from "@rescript/templates";

/**
 * "GENERATE 100 TEST RESPONSES AND TEST EVERYTHING" (2026-11-09) — Intelligent Mode's reading of a simulation request,
 * and the answer it gives. Deterministic: the sentence becomes a SimulationConfig (the same one the Manual form
 * builds), the run happens in the browser through the real engine (runSimulation), and the answer states what was
 * found. Saving the respondents as TEST data and opening the full report are offered as the next sentences.
 */
const WORDS: Record<string, number> = { ten: 10, twenty: 20, fifty: 50, hundred: 100, "one hundred": 100, "two hundred": 200, "five hundred": 500, thousand: 1000 };

export function simulationRequest(text: string, def: SurveyDefinition): { config: SimulationConfig; understood: string } | null {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  const asks = /\b(?:generate|create|simulate|run|make|produce|add)\b.{0,40}\b(?:test |dummy |fake |synthetic |simulated )?(?:responses?|respondents?|completes?|interviews?|data)\b/.test(t)
    || /\b(?:simulate|simulation)\b.{0,30}\b(?:survey|questionnaire|respondents?|responses?)\b/.test(t)
    || /\btest the (?:survey|questionnaire)\b.{0,30}\b(?:with|using) \d+/.test(t);
  if (!asks || /\b(?:delete|remove|clear)\b/.test(t)) return null;
  if (!/\b(?:test|dummy|fake|synthetic|simulat|qa)\w*\b/.test(t)) return null;
  const n = t.match(/\b(\d{1,4})\b/);
  const word = Object.keys(WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(t));
  const count = Math.max(1, Math.min(2000, n ? Number(n[1]) : word ? WORDS[word] : 100));
  const edge = /\bedge|boundary|extreme|corner\b/.test(t);
  const ends = /\bterminat|screen.?outs?|quota|disqualif/.test(t);
  /* a named block or section: focus the run there */
  const focus: string[] = [];
  const walk = (nodes: SurveyDefinition["flow"]) => {
    for (const nd of nodes) {
      const title = String((nd as { title?: string }).title ?? "").toLowerCase();
      if (nd.type === "block" && title.length > 2 && t.includes(title)) focus.push(nd.id);
      const k = nd as { children?: SurveyDefinition["flow"]; branches?: { children: SurveyDefinition["flow"] }[]; otherwise?: SurveyDefinition["flow"] };
      for (const c of [k.children, ...(k.branches ?? []).map((b) => b.children), k.otherwise]) if (c) walk(c);
    }
  };
  walk(def.flow);
  const config: SimulationConfig = { count, seed: 20261109, edgeRate: edge ? 0.5 : 0.2, completeShare: ends ? 0.6 : 0.75, probeInvalid: true, ...(focus.length ? { focus } : {}) };
  return { config, understood: `Simulate ${count} test respondents through the real survey logic${edge ? ", half of them on edge cases" : ""}${ends ? ", with more screen-outs and quota paths" : ""}${focus.length ? `, focused on ${focus.join(", ")}` : ""}, and check what happened.` };
}

/** the answer Intelligent Mode gives after a run */
export function simulationAnswer(def: SurveyDefinition, r: SimulationRunReport): { answer: string; sections: { title: string; items: { label: string; detail?: string }[] }[] } {
  const q = r.coverage.questions;
  const ends = Object.entries(r.endings).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ");
  const bad = r.probes.filter((p) => !p.rejected);
  const answer = `${r.produced} simulated test respondents went through the survey (run ${r.runId}, nothing saved yet): ${ends}. ${q.exercised} of ${q.total} questions were reached. ${r.verdict.ok ? "No problems found." : `${r.verdict.problems.length} problem${r.verdict.problems.length === 1 ? "" : "s"} found — listed below.`}`;
  const label = (id?: string) => (id ? def.questions.find((x) => x.id === id)?.code ?? id : "");
  return {
    answer,
    sections: [
      ...(r.verdict.problems.length ? [{ title: "Problems", items: r.verdict.problems.slice(0, 12).map((p) => ({ label: p })) }] : []),
      ...(q.missing.length ? [{ title: "Never reached", items: q.missing.slice(0, 10).map((m) => ({ label: `${m.code}`, detail: m.text.slice(0, 80) })) }] : []),
      ...(r.coverage.conditions.never.length ? [{ title: "Conditions that never fired", items: r.coverage.conditions.never.slice(0, 8).map((c) => ({ label: c })) }] : []),
      { title: "Validation probes", items: [{ label: `${r.probes.length - bad.length} of ${r.probes.length} invalid answers were refused by the survey's own rules${bad.length ? ` — accepted: ${bad.slice(0, 4).map((b) => `${label(b.question)} (${b.probe})`).join("; ")}` : ""}` }] },
      ...(r.randomization.length ? [{ title: "Randomization", items: r.randomization.slice(0, 6).map((x) => ({ label: `${x.variable}: ${x.balanced ? "balanced" : "unbalanced"}`, detail: x.items.slice(0, 4).map((i) => `${i.item} first ${Math.round(i.firstShare * 100)}%`).join(", ") })) }] : []),
    ],
  };
}

/* the run Intelligent Mode just made, handed to the Tests panel's full report (read once) */
let pending: { config: SimulationConfig; report: SimulationRunReport } | null = null;
export function setPendingSimulation(p: { config: SimulationConfig; report: SimulationRunReport } | null): void { pending = p; }
export function takePendingSimulation(): { config: SimulationConfig; report: SimulationRunReport } | null { const p = pending; pending = null; return p; }

/* ------------------------------------------------------------ the Manual form's text fields → a configuration */

const qOf = (def: SurveyDefinition, ref: string) => { const r = ref.trim().toLowerCase(); return def.questions.find((q) => q.code?.toLowerCase() === r || q.variableName?.toLowerCase() === r || q.id.toLowerCase() === r) ?? null; };
const valueOf = (raw: string): unknown => { const v = raw.trim().replace(/^["']|["']$/g, ""); return /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : v; };

/** "Seniors, 30%, Q3=70; Q1=1" per line → profiles; errors name the line */
export function parseProfiles(def: SurveyDefinition, text: string): { profiles: NonNullable<SimulationConfig["profiles"]>; errors: string[] } {
  const profiles: NonNullable<SimulationConfig["profiles"]> = [], errors: string[] = [];
  for (const [i, line] of text.split("\n").map((l) => l.trim()).entries()) {
    if (!line) continue;
    const m = line.match(/^([^,]+),\s*(\d+(?:\.\d+)?)\s*%?\s*(?:,\s*(.*))?$/);
    if (!m) { errors.push(`Profile line ${i + 1}: write “Name, 30%, Q3=70; Q1=1”.`); continue; }
    const answers: Record<string, unknown> = {};
    for (const pair of (m[3] ?? "").split(/[;]/).map((x) => x.trim()).filter(Boolean)) {
      const [ref, val] = pair.split("=");
      const q = ref ? qOf(def, ref) : null;
      if (!q || val === undefined) { errors.push(`Profile “${m[1].trim()}”: “${pair}” names no question.`); continue; }
      answers[q.id] = q.type === "multi_select" ? val.split("|").map(valueOf) : valueOf(val);
    }
    profiles.push({ name: m[1].trim(), share: Number(m[2]) / 100, answers });
  }
  return { profiles, errors };
}
/** "Q1: 1=60, 2=40" per line → distributions */
export function parseDistributions(def: SurveyDefinition, text: string): { distributions: Record<string, Record<string, number>>; errors: string[] } {
  const distributions: Record<string, Record<string, number>> = {}, errors: string[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [ref, rest] = line.split(":");
    const q = ref ? qOf(def, ref) : null;
    if (!q || !rest) { errors.push(`“${line}”: write “Q1: 1=60, 2=40”.`); continue; }
    const w: Record<string, number> = {};
    for (const p of rest.split(",").map((x) => x.trim()).filter(Boolean)) { const [c, n] = p.split("="); if (c && Number(n) >= 0 && q.options.some((o) => String(o.code) === c.trim())) w[c.trim()] = Number(n); else errors.push(`${q.code}: “${p}” is not one of its option codes.`); }
    distributions[q.id] = w;
  }
  return { distributions, errors };
}
/** "Q2 shown when Q1 = 1" / "Q5 hidden when Q2 != 3" / "Q2 shown" per line → expectations */
export function parseExpectations(def: SurveyDefinition, text: string): { expectations: NonNullable<SimulationConfig["expectations"]>; errors: string[] } {
  const expectations: NonNullable<SimulationConfig["expectations"]> = [], errors: string[] = [];
  for (const [i, line] of text.split("\n").map((l) => l.trim()).entries()) {
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(?:is\s+)?(shown|hidden|asked|skipped)(?:\s+(?:when|if)\s+(\S+)\s*(=|!=|>=|<=|>|<)\s*(.+))?$/i);
    const q = m ? qOf(def, m[1]) : null;
    const src = m?.[3] ? qOf(def, m[3]) : null;
    if (!m || !q || (m[3] && !src)) { errors.push(`Expectation line ${i + 1}: write “Q2 shown when Q1 = 1”.`); continue; }
    const op = ({ "=": "eq", "!=": "ne", ">=": "gte", "<=": "lte", ">": "gt", "<": "lt" } as const)[m[4] as "="] ?? "eq";
    expectations.push({
      id: `e${i + 1}`, label: line, question: q.id, expect: /shown|asked/i.test(m[2]) ? "shown" : "hidden",
      ...(src ? { when: { type: "rule", source: { kind: "question", ref: src.id }, operator: op, value: valueOf(m[5]) } as never } : {}),
    });
  }
  return { expectations, errors };
}
