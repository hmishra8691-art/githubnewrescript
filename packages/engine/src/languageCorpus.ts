import type { SurveyDefinition } from "@rescript/schema";
import { SurveyDefinition as SurveyDefinitionSchema } from "@rescript/schema";
import { DEFER_TO_GRAMMAR, interpretRequest, type Interpretation, type InterpretContext } from "./nlIntent.js";

/**
 * THE LANGUAGE REGRESSION CORPUS (Phase 8).
 *
 * Every sentence a researcher types in Intelligent mode is recorded in the
 * operation history with how it was read. A corpus is those sentences, with
 * the survey they were read against and the reading each one got, as a file:
 * replaying it reads every sentence again with the engine as it is now and
 * says, sentence by sentence, whether the reading is the same, better (the
 * model's sentence the engine now reads), worse (the engine's sentence now
 * handed to the model) or merely different. A change to the recognisers or the
 * lexicon is checked against what researchers actually say, not only against
 * the examples we wrote; and the sentences the engine still hands on are the
 * lexicon's backlog, ranked by how often they were said.
 *
 * The corpus is engine-only data: no history record shapes here (the Studio
 * builds one from its history with `corpusFromHistory`, which takes the fields
 * every record has), and the replay needs nothing but the engine.
 */

/** how a sentence was read: an engine kind, the model, or the old grammar */
export type CorpusKind = Interpretation["kind"] | "grammar";

export interface CorpusEntry {
  text: string;
  kind: CorpusKind;
  category?: string | null;
  /** the operations proposed, for an `actions` reading (the op names, in order) */
  ops?: string[];
  /** the selection the sentence was read with */
  selected?: string;
  /** how many times it was said */
  count?: number;
  /** when it was last said */
  at?: string;
}

export interface LanguageCorpus {
  version: 1;
  exported: string;
  survey: { id: string; title: string };
  definition: SurveyDefinition;
  entries: CorpusEntry[];
}

/** a compact reading — what the corpus records and what the replay compares */
export interface CompactReading { kind: CorpusKind; category: string | null; ops?: string[]; understood?: string }

/** the reading as the corpus records it: a hand-off to the old grammar's read-only answers is the grammar's, not the model's */
export function readingOf(def: SurveyDefinition, text: string, ctx: InterpretContext = {}): CompactReading {
  const r = interpretRequest(def, text, ctx);
  return {
    kind: r.kind === "model" && r.reason === DEFER_TO_GRAMMAR ? "grammar" : r.kind,
    category: r.category ?? null,
    ...(r.kind === "actions" ? { ops: r.actions.map((a) => a.op) } : {}),
    ...(r.kind !== "model" ? { understood: r.understood } : {}),
  };
}

export type ReplayVerdict = "same" | "better" | "worse" | "changed";

export interface ReplayResult { entry: CorpusEntry; now: CompactReading; verdict: ReplayVerdict; why: string }

export interface ReplayReport {
  results: ReplayResult[];
  counts: Record<ReplayVerdict, number>;
  /** the sentences the engine still hands to the model, most said first */
  backlog: CorpusEntry[];
}

const ENGINE_KINDS = new Set<CorpusKind>(["actions", "answer", "query", "output", "workflow", "clarify", "refused"]);
const HANDED_ON = new Set<CorpusKind>(["model", "grammar"]);

function verdictFor(entry: CorpusEntry, now: CompactReading): { verdict: ReplayVerdict; why: string } {
  const was = entry.kind;
  if (was === now.kind) {
    if (was === "actions" && entry.ops && now.ops && entry.ops.join(",") !== now.ops.join(",")) return { verdict: "changed", why: `the actions changed: ${entry.ops.join(", ")} → ${now.ops.join(", ")}` };
    return { verdict: "same", why: was === "model" ? "still the model's" : was === "grammar" ? "still the grammar's" : `still ${was}` };
  }
  if (HANDED_ON.has(was) && ENGINE_KINDS.has(now.kind)) return { verdict: "better", why: `was ${was === "grammar" ? "the grammar's" : "the model's"}, now ${now.kind}` };
  if (ENGINE_KINDS.has(was) && now.kind === "model") return { verdict: "worse", why: `was ${was}, now handed to the model` };
  return { verdict: "changed", why: `was ${was}, now ${now.kind}` };
}

/** read every sentence again with the engine as it is now */
export function replayCorpus(corpus: LanguageCorpus): ReplayReport {
  const def = SurveyDefinitionSchema.parse(corpus.definition);
  const results: ReplayResult[] = corpus.entries.map((entry) => {
    const now = readingOf(def, entry.text, entry.selected ? { selectedId: entry.selected } : {});
    return { entry, now, ...verdictFor(entry, now) };
  });
  const counts: Record<ReplayVerdict, number> = { same: 0, better: 0, worse: 0, changed: 0 };
  for (const r of results) counts[r.verdict]++;
  const backlog = results.filter((r) => r.now.kind === "model").map((r) => r.entry).sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || a.text.localeCompare(b.text));
  return { results, counts, backlog };
}

/** the corpus with every entry's reading as it is now — what a `--record` writes */
export function recordCorpus(corpus: LanguageCorpus): LanguageCorpus {
  const def = SurveyDefinitionSchema.parse(corpus.definition);
  return { ...corpus, exported: new Date().toISOString(), entries: corpus.entries.map((e) => { const now = readingOf(def, e.text, e.selected ? { selectedId: e.selected } : {}); return { ...e, kind: now.kind, category: now.category, ...(now.ops ? { ops: now.ops } : {}) }; }) };
}

/** what every history record has, whatever the Studio's own shape */
export interface HistoryLike {
  prompt: string;
  source: string;
  intent?: Record<string, unknown> | null;
  createdAt?: string;
}

const KINDS = new Set<string>(["actions", "answer", "clarify", "refused", "query", "output", "workflow", "model"]);

/**
 * A corpus from the history: one entry per distinct sentence (case and
 * spacing aside), with how many times it was said and the reading it got
 * last. A proposal revised in place ("a → b") contributes its last sentence.
 * Fixes, imports and context records are not sentences. The reading comes
 * from the record's `intent`: `engine` (what the engine read, recorded on every
 * turn since Phase 8), else `kind` for an engine record; a model record whose
 * engine reading was not kept is the model's; a grammar record is the
 * grammar's.
 */
export function corpusFromHistory(def: SurveyDefinition, records: HistoryLike[], survey: { id: string; title: string }): LanguageCorpus {
  const byText = new Map<string, CorpusEntry>();
  const key = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  for (const rec of [...records].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))) {
    if (!["engine", "model", "grammar"].includes(rec.source)) continue;
    const parts = rec.prompt.split(" → ");
    const text = parts[parts.length - 1].trim();
    if (!text || text.length > 4000) continue;
    const intent = rec.intent ?? {};
    const engineKind = typeof intent.engine === "string" ? intent.engine : undefined;
    let kind: CorpusKind;
    if (engineKind && KINDS.has(engineKind)) kind = engineKind as CorpusKind;
    else if (rec.source === "engine" && typeof intent.kind === "string" && KINDS.has(intent.kind)) kind = intent.kind as CorpusKind;
    else if (rec.source === "grammar") kind = "grammar";
    else kind = "model";
    const category = typeof intent.engineCategory === "string" ? intent.engineCategory : typeof intent.category === "string" ? intent.category : null;
    const ops = typeof intent.ops === "string" && intent.ops ? intent.ops.split(",") : undefined;
    const selected = typeof intent.selected === "string" && intent.selected ? intent.selected : undefined;
    const k = key(text);
    const have = byText.get(k);
    byText.set(k, { text: have?.text ?? text, kind, category, ...(ops ? { ops } : {}), ...(selected ? { selected } : {}), count: (have?.count ?? 0) + 1, ...(rec.createdAt ? { at: rec.createdAt } : {}) });
  }
  return { version: 1, exported: new Date().toISOString(), survey, definition: def, entries: [...byText.values()].sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || a.text.localeCompare(b.text)) };
}

/** the replay in words: counts, then every sentence that is not the same */
export function describeReplay(report: ReplayReport, corpus: LanguageCorpus): string {
  const c = report.counts;
  const lines = [`${corpus.survey.title}: ${corpus.entries.length} sentences — ${c.same} same, ${c.better} better, ${c.worse} worse, ${c.changed} changed; ${report.backlog.length} still the model's.`];
  for (const r of report.results) if (r.verdict !== "same") lines.push(`  ${r.verdict.toUpperCase().padEnd(7)} “${r.entry.text}” — ${r.why}`);
  if (report.backlog.length) { lines.push("  Backlog (the model's, most said first):"); for (const e of report.backlog.slice(0, 20)) lines.push(`    ${e.count ?? 1}× “${e.text}”`); }
  return lines.join("\n");
}
