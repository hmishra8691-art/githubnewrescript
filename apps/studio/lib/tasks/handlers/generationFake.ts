/**
 * THE FAKE PROVIDER'S STAND-IN FOR GENERATION STEPS (K2, 2026-10-25) — a TEST SEAM, read only under
 * `AI_API_URL=fake:` (the task engine's `ctx.ai` consults `fakeResponse` there and nowhere else).
 *
 * Deterministic answers built from the machine-readable input block every generation prompt ends with
 * (PLAN_INPUT, BATCH_INPUT, LOGIC_INPUT, QUOTA_INPUT, METHOD_INPUT, EDIT_INPUT, REPAIR_INPUT), so a 300-question
 * browser suite exercises the whole path — skeleton, adaptive batches, logic with nested AND/OR across batches,
 * quotas, randomization, design generation, validation — without a network or a key.
 *
 * Markers in the request (the task summary's goal carries them into every prompt):
 *   [fake:invalid-batch]   round 0 of a batch holding the second section writes that section's first question (in the batch) with no options
 *                          → the batch's validation fails → a targeted repair step (round 1) writes it properly
 *   [fake:bad-logic]       round 0 of the first logic step names a question that does not exist → repair
 *   [fake:bad-design]      round 0 of a design: a MaxDiff with as many items per task as items (the Studio corrects it
 *                          deterministically), a conjoint with a one-level attribute (refused → a repair round)
 */
import type { FakeAiAnswer, FakeAiCall } from "../fakeResponders.ts";

const inputOf = (prompt: string, tag: string): Record<string, unknown> | null => {
  const m = new RegExp(`${tag}: (\\{.*\\})\\s*$`, "m").exec(prompt);
  if (!m) return null;
  try { return JSON.parse(m[1]) as Record<string, unknown>; } catch { return null; }
};
const reply = (actions: unknown[], extra: Record<string, unknown> = {}): FakeAiAnswer => ({ value: { kind: "proposal", reply: `Fake: ${actions.length} actions.`, actions, ...extra } });

/** "Q12 [single_select] text {1=Yes; 2=No}" lines of a digest */
function digestOf(prompt: string): { code: string; type: string; options: string[]; labels: string[]; hasLogic: boolean }[] {
  const out: { code: string; type: string; options: string[]; labels: string[]; hasLogic: boolean }[] = [];
  for (const line of prompt.split("\n")) {
    const m = /^([A-Za-z_][\w]*) \[([a-z_]+)\] .*?(?:\{([^}]*)\})?(?: ·.*)?$/.exec(line.trim());
    if (!m) continue;
    const pairs = (m[3] ?? "").split(";").map((x) => x.trim()).filter((x) => /^[^=]+=/.test(x));
    out.push({ code: m[1], type: m[2], options: pairs.map((p) => p.split("=")[0].trim()), labels: pairs.map((p) => p.split("=").slice(1).join("=").trim()), hasLogic: / · shown when /.test(line) });
  }
  return out;
}

const TOPICS = ["Category usage", "Brand awareness", "Brand perceptions", "Purchase journey", "Product experience", "Satisfaction", "Media habits", "Pricing", "Attitudes", "Future intentions", "Lifestyle", "Technology use", "Service", "Loyalty", "Innovation"];
const SUBJECTS = ["Polity", "History", "Geography", "Economy", "Environment", "Science and Technology", "Current Affairs", "Art and Culture"];

function outline(input: Record<string, unknown>): FakeAiAnswer {
  const total = Number(input.total) || 30;
  const hints = (input.hints ?? {}) as Record<string, boolean>;
  if (input.assessment) {
    const parts = Math.min(SUBJECTS.length, Math.max(1, Math.round(total / 13)));
    return { value: { sections: SUBJECTS.slice(0, parts).map((t) => ({ title: t, topic: t, count: Math.round(total / parts), complexity: "simple", purpose: `${t} questions` })) } };
  }
  const screener = Math.min(8, Math.max(3, Math.round(total * 0.04)));
  const profile = Math.min(6, Math.max(2, Math.round(total * 0.03)));
  const middle = Math.max(1, total - screener - profile);
  const n = Math.max(1, Math.round(middle / 24));
  const sections = [
    { title: "Screening", count: screener, complexity: "simple", purpose: "Qualify the respondent", types: ["single"], logic: hints.logic ? "screen out respondents who answer No to the first two questions" : "" },
    ...Array.from({ length: n }, (_, i) => ({ title: TOPICS[i % TOPICS.length] + (i >= TOPICS.length ? ` ${Math.floor(i / TOPICS.length) + 1}` : ""), count: Math.round(middle / n), complexity: i % 3 === 2 ? "complex" : "simple", purpose: `Measure ${TOPICS[i % TOPICS.length].toLowerCase()}`, types: i % 3 === 2 ? ["matrix"] : ["single", "multi", "rating", "numeric"], logic: hints.logic ? "ask follow-ups only of qualified users" : "" })),
    { title: "Profile", count: profile, complexity: "simple", purpose: "Demographics" },
  ];
  const mids = sections.slice(1, -1).map((s) => s.title);
  return { value: { sections, quotas: hints.quotas ? ["gender 50/50 on the screening question"] : [], randomize: hints.randomization && mids.length >= 3 ? mids.slice(0, 3) : [], logic: hints.logic ? ["users of the category see the detailed sections"] : [] } };
}

function batch(input: Record<string, unknown>, prompt: string): FakeAiAnswer {
  const slots = (input.slots as { code: string; block: string; complexity: string; section: number }[]) ?? [];
  const exam = input.assessment as { optionsCount?: number } | null;
  const round = Number(input.round ?? 0);
  const invalid = prompt.includes("[fake:invalid-batch]") && round === 0;
  const actions: unknown[] = [];
  const singles: string[] = [];
  const firstOfSection1 = slots.findIndex((x) => x.section === 1);
  slots.forEach((s, i) => {
    const num = Number(/\d+/.exec(s.code)?.[0] ?? i);
    if (exam) {
      const k = Number(exam.optionsCount ?? 4);
      const correct = (num % k) + 1;
      actions.push({ op: "create_question", code: s.code, block: s.block, type: "single", required: true, text: `${s.block} — question ${s.code}: which of these statements about ${s.block.toLowerCase()} item ${num} is correct?`, options: Array.from({ length: k }, (_, j) => ({ label: `Statement ${String.fromCharCode(65 + j)} for item ${num}`, code: j + 1 })) });
      actions.push({ op: "set_answer_key", target: s.code, correct: [correct], topic: s.block, subtopic: `Unit ${(num % 5) + 1}`, explanation: `Statement ${String.fromCharCode(64 + correct)} is correct for item ${num} because it matches the standard reference.`, optionExplanations: Object.fromEntries(Array.from({ length: k }, (_, j) => j + 1).filter((j) => j !== correct).map((j) => [String(j), `Statement ${String.fromCharCode(64 + j)} confuses item ${num} with a related concept.`])), difficulty: ["easy", "medium", "hard"][num % 3] });
      return;
    }
    if (s.section === 0) {
      const gender = i === 2 || (slots.length <= 2 && i === slots.length - 1 && num > 2);
      if (gender) actions.push({ op: "create_question", code: s.code, block: s.block, type: "single", required: true, text: `[${s.code}] What is your gender?`, options: [{ label: "Male", code: 1 }, { label: "Female", code: 2 }, { label: "Another identity", code: 3 }] });
      else {
        actions.push({ op: "create_question", code: s.code, block: s.block, type: "single", required: true, text: `[${s.code}] Screening: do you qualify on criterion ${num}?`, options: [{ label: "Yes", code: 1 }, { label: "No", code: 2 }] });
        if (i < 2) actions.push({ op: "add_skip", from: s.code, when: `${s.code} = 2`, to: "screen_out" });
      }
      singles.push(s.code);
      return;
    }
    if (invalid && i === firstOfSection1) {
      actions.push({ op: "create_question", code: s.code, block: s.block, type: "single", text: `[${s.code}] ${s.block}: which option applies to you?` });
      return;
    }
    if (s.complexity === "complex") {
      actions.push({ op: "create_question", code: s.code, block: s.block, type: "matrix", text: `[${s.code}] ${s.block}: how much do you agree with each statement (set ${num})?`, rows: [`Statement ${num}.1`, `Statement ${num}.2`, `Statement ${num}.3`], scale: { points: 5, low: "Strongly disagree", high: "Strongly agree" } });
      return;
    }
    switch (num % 5) {
      case 0: actions.push({ op: "create_question", code: s.code, block: s.block, type: "single", text: `[${s.code}] ${s.block}: which of these applies to you most (item ${num})?`, options: [{ label: "Option one", code: 1 }, { label: "Option two", code: 2 }, { label: "Option three", code: 3 }, { label: "Option four", code: 4 }] }); singles.push(s.code); break;
      case 1: actions.push({ op: "create_question", code: s.code, block: s.block, type: "multi", text: `[${s.code}] ${s.block}: which of these have you done (item ${num})?`, options: [{ label: "First", code: 1 }, { label: "Second", code: 2 }, { label: "Third", code: 3 }, { label: "None of these", code: 99, exclusive: true }] }); break;
      case 2: actions.push({ op: "create_question", code: s.code, block: s.block, type: "rating", text: `[${s.code}] ${s.block}: how would you rate aspect ${num}?`, scale: { points: 5, low: "Very poor", high: "Excellent" } }); break;
      case 3: actions.push({ op: "create_question", code: s.code, block: s.block, type: "numeric", text: `[${s.code}] ${s.block}: how many times in the last month (item ${num})?`, validation: [{ kind: "min_value", value: 0 }, { kind: "max_value", value: 100 }] }); break;
      default: actions.push({ op: "create_question", code: s.code, block: s.block, type: "single", text: `[${s.code}] ${s.block}: how often do you do activity ${num}?`, options: [{ label: "Daily", code: 1 }, { label: "Weekly", code: 2 }, { label: "Monthly", code: 3 }, { label: "Rarely", code: 4 }] }); singles.push(s.code);
    }
    /* logic inside the batch: a follow-up shown to those who chose option 1 of an earlier single in this batch */
    const prev = singles.filter((c) => c !== s.code).slice(-1)[0];
    if (prev && i % 4 === 3) actions.push({ op: "set_display_logic", target: s.code, expression: `${prev} = 1 OR ${prev} = 2` });
  });
  return reply(actions);
}

function logic(input: Record<string, unknown>, prompt: string): FakeAiAnswer {
  const targets = (input.targets as string[]) ?? [];
  const round = Number(input.round ?? 0);
  const dig = digestOf(prompt);
  const screener = dig.filter((d) => d.labels.includes("Yes") && d.labels.includes("No"));
  const actions: unknown[] = [];
  if (prompt.includes("[fake:bad-logic]") && round === 0 && targets.length) actions.push({ op: "set_display_logic", target: targets[0], expression: "QNOPE99 = 1" });
  const tset = new Set(targets.map((t) => t.toUpperCase()));
  targets.forEach((t, i) => {
    if (screener.some((s) => s.code === t)) return;
    const d = dig.find((x) => x.code === t);
    if (!d || !tset.has(t.toUpperCase()) || d.hasLogic) return;
    const earlier = screener.filter((s) => dig.indexOf(s) < dig.indexOf(d));
    if (earlier.length >= 2 && i % 7 === 2) actions.push({ op: "set_display_logic", target: t, expression: `(${earlier[0].code} = 1 OR ${earlier[1].code} = 1) AND NOT (${earlier[earlier.length - 1].code} = 2)` });
    else if (earlier.length && i % 5 === 1) actions.push({ op: "set_display_logic", target: t, expression: `${earlier[0].code} = 1` });
  });
  return reply(actions);
}

function quotas(prompt: string): FakeAiAnswer {
  const dig = digestOf(prompt);
  const g = dig.find((d) => d.labels.includes("Male")) ?? dig.find((d) => d.options.length >= 2);
  if (!g) return reply([]);
  return reply([{ op: "create_quota", name: "Gender", cells: [{ label: g.labels[0] || "Group 1", when: `${g.code} = ${g.options[0]}`, limit: 150 }, { label: g.labels[1] || "Group 2", when: `${g.code} = ${g.options[1]}`, limit: 150 }] }]);
}

function methods(input: Record<string, unknown>, prompt: string): FakeAiAnswer {
  const code = String(input.code), block = String(input.block);
  const round = Number(input.round ?? 0);
  if (input.method === "maxdiff") {
    const items = ["Battery life", "Camera quality", "Screen size", "Price", "Brand reputation", "Storage", "Durability", "Charging speed", "Weight", "Design", "Software updates", "Water resistance"];
    /* [fake:bad-design]: items per task ≥ the items — the Studio corrects it itself (engine #13), no second call */
    const perTask = prompt.includes("[fake:bad-design]") && round === 0 ? items.length : 4;
    return reply([{ op: "create_maxdiff", code, block, text: "Of these features, which is MOST and which is LEAST important to you?", items, perTask, versions: 2 }], { assumptions: ["Twelve smartphone features, four per task."] });
  }
  /* [fake:bad-design]: a one-level attribute — refused (never invented by the Studio) → a repair round with the reason */
  const attributes = prompt.includes("[fake:bad-design]") && round === 0
    ? [{ name: "Brand", levels: ["Alpha"] }, { name: "Price", levels: ["$299", "$499"] }]
    : [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Price", levels: ["$299", "$499", "$699", "$899"] }, { name: "Storage", levels: ["64 GB", "128 GB", "256 GB"] }, { name: "Battery", levels: ["1 day", "2 days", "3 days"] }];
  return reply([{ op: "create_conjoint", code, block, method: input.method === "acbc" ? "acbc" : "cbc", text: "Which of these phones would you choose?", attributes, alternatives: 3, tasks: 12, versions: 4, none: true, design: "efficient" }], { assumptions: ["Four attributes proposed for the category."] });
}

function edit(input: Record<string, unknown>, prompt: string): FakeAiAnswer {
  const codes = (input.codes as string[]) ?? [];
  const kind = String(input.editKind);
  const dig = digestOf(prompt);
  const actions: unknown[] = [];
  codes.forEach((c, i) => {
    const d = dig.find((x) => x.code === c);
    if (kind === "options") { if (d?.options.length) actions.push({ op: "update_question", target: c, addOptions: [{ label: "Prefer not to say", code: 98, exclusive: true }] }); }
    else if (kind === "logic") { const src = dig.find((x) => x.options.includes("1") && x.code !== c && dig.indexOf(x) < dig.indexOf(d ?? x)); if (src && i > 0) actions.push({ op: "set_display_logic", target: c, expression: `${src.code} = 1` }); }
    else actions.push({ op: "update_question", target: c, instruction: `Explanation for ${c}: answer about your own experience; there is no right or wrong answer.` });
  });
  return reply(actions);
}

function repair(input: Record<string, unknown>): FakeAiAnswer {
  const problems = (input.problems as { kind: string; code: string | null }[]) ?? [];
  const missing = (input.missing as { code: string; block: string }[]) ?? [];
  const actions: unknown[] = [];
  for (const m of missing) actions.push({ op: "create_question", code: m.code, block: m.block, type: "single", text: `[${m.code}] ${m.block}: which option applies to you (repaired)?`, options: [{ label: "Yes", code: 1 }, { label: "No", code: 2 }] });
  for (const p of problems) {
    if (!p.code || missing.some((m) => m.code === p.code)) continue;
    if (p.kind === "missing_options") actions.push({ op: "update_question", target: p.code, options: [{ label: "Yes", code: 1 }, { label: "No", code: 2 }, { label: "Not sure", code: 3 }] });
    else if (p.kind === "duplicate_text") actions.push({ op: "update_question", target: p.code, text: `[${p.code}] (reworded) Please tell us about this aspect.` });
    else if (["logic", "nested_condition", "piping"].includes(p.kind)) actions.push({ op: "set_display_logic", target: p.code, expression: null });
  }
  return reply(actions);
}

export function generationFakeResponder(call: FakeAiCall): FakeAiAnswer | undefined {
  const p = call.prompt ?? "";
  switch (call.purpose) {
    case "gen.outline": { const i = inputOf(p, "PLAN_INPUT"); return i ? outline(i) : undefined; }
    case "gen.design": return reply([{ op: "set_research", objective: "Understand the category and what drives choice", population: "Adults in the category", methodology: "Online quantitative survey", hypotheses: ["Satisfaction drives loyalty"], assumptions: ["Fake provider design"] }]);
    case "gen.batch": { const i = inputOf(p, "BATCH_INPUT"); return i ? batch(i, p) : undefined; }
    case "gen.logic": { const i = inputOf(p, "LOGIC_INPUT"); return i ? logic(i, p) : undefined; }
    case "gen.quotas": return quotas(p);
    case "gen.methods": { const i = inputOf(p, "METHOD_INPUT"); return i ? methods(i, p) : undefined; }
    case "gen.edit": { const i = inputOf(p, "EDIT_INPUT"); return i ? edit(i, p) : undefined; }
    case "gen.repair": { const i = inputOf(p, "REPAIR_INPUT"); return i ? repair(i) : undefined; }
    default: return undefined;
  }
}
