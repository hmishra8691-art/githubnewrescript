import { designAdvice, recommendMethodology, STUDY_METHODOLOGIES, parseAttributes, type DesignAdvice, type MethodInput, type MethodInputs, type Methodology, type MethodologyRecommendation } from "./studyMethodology.js";
import { describeBuild } from "./methodGuides.js";

/**
 * A STUDY FROM A DESCRIPTION (2026-11-10) — the natural-language path into Study design.
 *
 * A researcher writes the brief the way they would say it: the decision, the product, and whatever they already know
 * (prices, attributes and levels, the items, the sample). This reads it in the order a methodologist works:
 *
 *   1 the objective      → the method (recommendMethodology: the same deterministic engine, with its reasons)
 *   2 what was given     → the method's own inputs, READ from the text: attributes and levels, prices, items, concepts,
 *                          brands, statements, the product, the sample and the interview time
 *   3 what is missing    → a QUESTION for every required input the text does not contain. Nothing is invented: a
 *                          conjoint without levels is asked for its levels, not given plausible ones.
 *   4 the design         → for conjoint / MaxDiff, the design advice (tasks, concepts per task, minimum sample)
 *   5 what will be built → the blocks and questions the method's builder writes for THESE inputs (once nothing is missing)
 *   6 the explanation    → why this method, what the design is, what is built and how it will be analysed
 *
 * Deterministic and offline: no model reads the brief, so the same words always give the same study, and a value the
 * text does not contain is never present in the result. The panel shows what was read for the researcher to correct
 * before anything is built; building and checking are the existing gate, generators and simulation.
 */
export interface BriefReading { key: string; label: string; value: string }
export interface BriefQuestion { key: string; question: string; example?: string }
export interface DesignBrief {
  recommendation: MethodologyRecommendation | null;
  method: Methodology;
  inputs: MethodInputs;
  /** the inputs as the text the panel's fields hold (attributes "Name: a, b" per line, lists one per line, prices comma-separated) */
  fields: Record<string, string>;
  understood: BriefReading[];
  questions: BriefQuestion[];
  ready: boolean;
  advice: DesignAdvice | null;
  /** the structure the builder writes for these inputs — empty until nothing required is missing */
  structure: string[];
  explanation: string[];
}

const LIST_WORDS: Record<string, string> = {
  items: "items|features|benefits|claims|messages|flavou?rs|ideas|options|tasks|stages|sections|subjects|topics|channels|visits|exposures|behaviou?rs|institutions|services",
  concepts: "concepts|versions|variants|designs|ads|adverts|creatives|conditions|executions",
  brands: "brands|competitors",
  statements: "statements|outcomes|indicators|measures|drivers|predictors|learning outcomes|screening items",
};
const splitList = (t: string): string[] => t.replace(/\s+(?:and|&)\s+(?=[^,;]*$)/i, ", ").split(/\s*[,;\n]\s*/).map((x) => x.trim().replace(/^[-•*:=\s]+/, "").replace(/^\d+[.)]\s+/, "").replace(/[.\s]+$/, "")).filter((x) => x.length > 0 && x.length <= 120);

/** attributes with levels: "Price: $9, $14, $19" on its own line, or inline "price ($9, $14, $19), storage (50 GB, 1 TB)" */
function readAttributes(text: string): { name: string; levels: string[] }[] {
  const lines = text.split(/\n/).map((l) => l.trim().replace(/^[-•*]\s*/, "")).filter((l) => /^[^:\n]{2,40}:\s*[^,\n]+(?:,\s*[^,\n]+)+\.?$/.test(l) && !new RegExp(`^(?:${Object.values(LIST_WORDS).join("|")}|attributes|prices)\\s*:`, "i").test(l));
  if (lines.length >= 2) return parseAttributes(lines.map((l) => l.replace(/\.$/, "")).join("\n")).filter((a) => a.levels.length >= 2);
  const out: { name: string; levels: string[] }[] = [];
  for (const m of text.matchAll(/([A-Za-z][A-Za-z0-9\-/]*(?: [A-Za-z0-9\-/]+){0,3})\s*\(([^()]{3,160})\)/g)) {
    /* a comma inside a number ("$1,199") is not a separator: levels are split on a comma followed by a space */
    const levels = m[2].split(/\s*(?:,\s+|;|\s+or\s+)\s*/).map((x) => x.trim()).filter(Boolean);
    let name = m[1].trim();
    for (let k = 0; k < 6; k++) name = name.replace(/^(?:and|the|with|a|an|by|are|is|of|on|our|its|attributes?|levels?|include[sd]?|including|conjoint|use|test)\s+/i, "").trim();
    if (levels.length >= 2 && name.length >= 2 && !/^(?:e\.?g|i\.?e|such as)$/i.test(name)) out.push({ name: name.charAt(0).toUpperCase() + name.slice(1), levels });
  }
  return out.length >= 2 ? out : [];
}

function readList(text: string, key: string): string[] {
  const words = LIST_WORDS[key];
  if (!words) return [];
  const m = new RegExp(`\\b(?:${words})\\b\\s*(?:are|is|:|include[sd]?|to (?:test|compare|rate|rank)\\s*(?:are|:)?|will be|would be|=|—|-)\\s*([^\\n]+(?:\\n[-•*\\d][^\\n]*)*)`, "i").exec(text);
  if (!m) return [];
  /* up to the end of the sentence — a full stop followed by a capital starts something else */
  const body = m[1].split(/\.\s+(?=[A-Z0-9])/)[0];
  const list = splitList(body);
  return list.length >= 2 ? list : [];
}

function readPrices(text: string): number[] {
  const labelled = /\bprices?(?:\s+points?|\s+levels?)?\s*(?:are|:|of|to test(?:\s*(?:are|:))?|=|—|-)\s*([^\n]+)/i.exec(text)?.[1] ?? "";
  const nums = (t: string) => [...t.matchAll(/(?:[$£€₹]\s?)?(\d+(?:\.\d+)?)/g)].map((x) => Number(x[1])).filter((n) => Number.isFinite(n) && n > 0);
  const fromLabel = nums(labelled.split(/\.\s+(?=[A-Z0-9])/)[0]);
  if (fromLabel.length >= 2) return [...new Set(fromLabel)].sort((a, b) => a - b);
  const money = [...text.matchAll(/[$£€₹]\s?(\d+(?:\.\d+)?)/g)].map((x) => Number(x[1]));
  return money.length >= 3 ? [...new Set(money)].sort((a, b) => a - b) : [];
}

function readProduct(text: string): string {
  const m = /\b(?:for|of|about|on|price of|pricing (?:for|of)|launch(?:ing)?|test(?:ing)?|evaluate|rate)\s+(?:our|the|a|an|my|its)\s+(?:new\s+)?([A-Za-z0-9][^,.;:\n(]{2,70})/i.exec(text);
  if (!m) return "";
  let p = m[1].split(/\s+(?:and (?:we|need|want|which|how)|to (?:find|know|see|understand|measure|learn|decide)|which|that|so|among|with|using|by|in order|because|we|need|should|would|could|can|is|are)\b/i)[0].trim();
  p = p.replace(/\s+(?:study|survey|research)$/i, "").trim();
  return p.length >= 3 && p.split(/\s+/).length <= 7 ? p : "";
}

const fieldText = (i: MethodInput, inputs: MethodInputs): string => {
  const v = (inputs as Record<string, unknown>)[i.key];
  if (i.kind === "attributes") return (inputs.attributes ?? []).map((a) => `${a.name}: ${a.levels.join(", ")}`).join("\n");
  if (i.kind === "prices") return (inputs.prices ?? []).join(", ");
  if (i.kind === "list") return Array.isArray(v) ? (v as string[]).join("\n") : "";
  return v == null ? "" : String(v);
};

export function readDesignBrief(text: string, opts: { methodId?: string } = {}): DesignBrief | null {
  const t = String(text ?? "").trim();
  const recommendation = recommendMethodology(t);
  const method = (opts.methodId ? STUDY_METHODOLOGIES.find((m) => m.id === opts.methodId) : null) ?? recommendation?.recommended ?? null;
  if (!method) return null;
  const inputs: MethodInputs = {};
  const understood: BriefReading[] = [];
  const questions: BriefQuestion[] = [];
  const attrs = readAttributes(t);
  for (const i of method.inputs) {
    if (i.kind === "attributes") {
      if (attrs.length) { inputs.attributes = attrs; understood.push({ key: i.key, label: i.label, value: attrs.map((a) => `${a.name} (${a.levels.join(", ")})`).join("; ") }); }
      else if (i.required) questions.push({ key: i.key, question: `What are the ${/menu/i.test(i.label) ? "menu items and their prices" : "attributes and their levels"}? One per line, as “Name: level, level, level”.`, ...(i.example ? { example: i.example } : {}) });
    } else if (i.kind === "prices") {
      const prices = attrs.length ? [] : readPrices(t);
      if (prices.length) { inputs.prices = prices; understood.push({ key: i.key, label: i.label, value: prices.join(", ") }); }
      else if (i.required) questions.push({ key: i.key, question: "Which prices should be tested? List them, lowest to highest.", ...(i.example ? { example: i.example } : {}) });
    } else if (i.kind === "list") {
      const list = readList(t, i.key);
      if (list.length) { (inputs as Record<string, unknown>)[i.key] = list; understood.push({ key: i.key, label: i.label, value: list.join(", ") }); }
      else if (i.required) questions.push({ key: i.key, question: `Which ${i.label.replace(/\s*\(.*\)\s*$/, "").toLowerCase()}? List them, one per line.`, ...(i.example ? { example: i.example.split("\n").join(", ") } : {}) });
    } else if (i.key === "product") {
      const p = readProduct(t);
      if (p) { inputs.product = p; understood.push({ key: i.key, label: i.label, value: p }); }
      else if (i.required) questions.push({ key: i.key, question: `${i.label}: what is it called?`, ...(i.example ? { example: i.example } : {}) });
    } else if (i.key === "currency") {
      const c = /[$£€₹]/.exec(t)?.[0];
      if (c) { inputs.currency = c; understood.push({ key: i.key, label: i.label, value: c }); }
    }
  }
  const sample = /\b(\d{2,6})\s*(?:respondents?|completes|completed interviews|people|interviews|participants|customers|patients|students|employees)\b/i.exec(t)?.[1] ?? /\bn\s*=\s*(\d{2,6})\b/i.exec(t)?.[1];
  if (sample) { inputs.sample = Number(sample); understood.push({ key: "sample", label: "Completes", value: sample }); }
  const minutes = /\b(\d{1,2})\s*[- ]?\s*min(?:ute)?s?\b/i.exec(t)?.[1];
  if (minutes) { inputs.minutes = Number(minutes); understood.push({ key: "minutes", label: "Minutes available", value: minutes }); }

  const needsDesign = method.inputs.some((i) => i.kind === "attributes") || (method.inputs.some((i) => i.key === "items") && /maxdiff|innovation/.test(method.id));
  const advice = needsDesign && (inputs.attributes?.length || inputs.items?.length)
    ? designAdvice({ ...(inputs.attributes?.length ? { attributes: inputs.attributes } : {}), ...(inputs.items?.length && !inputs.attributes?.length ? { items: inputs.items } : {}), ...(method.id === "menu_conjoint" ? { menu: true } : {}), ...(inputs.sample ? { sample: inputs.sample } : {}), ...(inputs.minutes ? { maxMinutes: inputs.minutes } : {}), ...(method.id === "rating_conjoint" ? { specialist: true } : {}) })
    : null;
  const ready = questions.length === 0;
  let structure: string[] = [];
  if (ready) { try { structure = describeBuild(method.build(inputs)); } catch { structure = []; } }

  const explanation: string[] = [];
  if (recommendation && recommendation.recommended.id === method.id) {
    explanation.push(`Method: ${method.name}. It fits ${method.fit}.`);
    if (recommendation.proposed && !recommendation.proposed.fits && recommendation.proposed.problem) explanation.push(`${recommendation.proposed.method.name}, which you mentioned, does not answer this objective: ${recommendation.proposed.problem}`);
  } else explanation.push(`Method: ${method.name} (chosen by you). It fits ${method.fit}.`);
  if (advice) explanation.push(`Design: ${advice.why} ${advice.tasks} tasks${advice.alternatives ? `, ${advice.alternatives} concepts per task` : ""}${advice.perTask ? `, ${advice.perTask} items per task` : ""}; about ${advice.minutes} minutes; at least ${advice.minSample} completes.`, ...advice.warnings);
  else explanation.push(`Sample: ${method.sample.note}. Interview: ${method.loi}.`);
  if (inputs.sample && inputs.sample < method.sample.min) explanation.push(`${inputs.sample} completes is below what ${method.name} needs (${method.sample.note}).`);
  if (structure.length) explanation.push(`It will build: ${structure.join("; ")}.`);
  explanation.push(`Analysis: ${method.analysis.join("; ")}.`);
  if (method.caution) explanation.push(method.caution);
  if (!ready) explanation.push(`Before it can be built: ${questions.length} question${questions.length === 1 ? "" : "s"} to answer — nothing is assumed in their place.`);

  return { recommendation, method, inputs, fields: Object.fromEntries(method.inputs.map((i) => [i.key, fieldText(i, inputs)]).filter(([, v]) => v !== "")), understood, questions, ready, advice, structure, explanation };
}
