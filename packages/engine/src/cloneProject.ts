import type { SurveyDefinition } from "@rescript/schema";

/**
 * CLONE A PROJECT'S PROGRAMMING.
 *
 * ## The rule, in one line
 *
 * **Ids change. Codes and names do not.**
 *
 * Everything in a definition is named twice. It has an ID — `q_k3f8`,
 * `page_2`, `quota_a1` — which is private to the project and means nothing
 * outside it. And it has a CODE or a NAME — `Q5`, `BRAND_AWARE`, option `3`,
 * row `A` — which is the platform's join key: stored answers, export columns,
 * quota counters, List Fill counters and the variable dictionary are all keyed
 * by it, and some of those live in database tables.
 *
 * A clone is a second project, so every ID must be new: two projects sharing
 * `q_k3f8` is two rows claiming one primary key, and any reference that
 * survives into the copy still points at the original's question — the copy
 * quietly reading someone else's survey. Every CODE, on the other hand,
 * should be identical: a cloned `Q5` is still `Q5`, its export column is
 * still `Q5`, and the thousand references written as codes — every piping
 * token, every calculation expression, every masking expression — keep
 * working without being touched at all. That is not a shortcut; it is why the
 * copy is recognisably the same survey.
 *
 * ## How the references are rewritten
 *
 * Not by enumerating them. A survey definition refers to ids from something
 * like sixty places — conditions, skip targets, carry-forward, list logic,
 * masks, punches, loop sources, quota checks, display rules, list fills,
 * translation keys, the logic flow — and a clone that knows fifty-nine of
 * them produces a survey that works until the day somebody opens the
 * sixtieth. That list also grows with every feature, and a list that must be
 * maintained in a second place to stay correct will not be.
 *
 * So the direction is inverted. This file knows only where ids are
 * DECLARED — one id per question, per option, per flow node, per quota — which
 * is a short, stable list that the schema itself dictates. Every declaration
 * gets a new id, and then every string in the whole document that equals an
 * old id becomes the new one, wherever it happens to live and whatever field
 * it is called. A reference the author of this file never heard of is
 * rewritten anyway, because the rewrite is driven by the id, not by the name
 * of the field holding it.
 *
 * Two things are not plain ids, and are handled explicitly:
 *
 *   · TRANSLATION KEYS (`q:<qid>:opt:<code>`, `flow:<id>:title`,
 *     `quota:<id>:message`) and audio `elementKey`s embed an id inside a
 *     colon-joined string, and they are object KEYS, not values. A key that
 *     is not rewritten detaches every translated word in the survey from the
 *     question it belongs to — silently, because a missing translation falls
 *     back to the source language and simply looks untranslated.
 *
 *   · `meta`, which is restamped for the new project.
 *
 * ## The proof
 *
 * `stowaways` is the whole point of the design. After the rewrite, the clone
 * is serialised and searched for every original id. If any survives, the
 * clone is wrong — some reference lives somewhere this file did not reach —
 * and the caller must refuse rather than create a project that reads another
 * project's questions. It has caught nothing so far; it exists because the
 * day it catches something is the day it pays for itself.
 *
 * ## What is NOT here
 *
 * Responses, respondents, wallets, credits, deployments, test runs and audit
 * history. A clone is a copy of the PROGRAMMING — the thing a researcher
 * means by "start from this study". Everything else belongs to the original's
 * fieldwork and copying it would put another project's respondents, and
 * another project's money, in a new project's name.
 */

export interface CloneOptions {
  /** The new project's id — `meta.id`. */
  surveyId: string;
  /** The new project's code and title. Codes INSIDE the survey are untouched. */
  code: string;
  title: string;
  /**
   * How a new id is minted. Injectable so a test can make the mapping
   * readable, and so the caller decides between a random and a seeded id.
   */
  newId?: (prefix: string) => string;
  /** `deployment.studySlug` for the copy — a slug must not be shared. */
  studySlug?: string;
}

export interface CloneResult {
  def: SurveyDefinition;
  /** old id → new id, every entity, for the audit record and for tests. */
  mapping: Record<string, string>;
  /** how many ids were minted, by kind */
  counts: Record<string, number>;
  /** how many string occurrences were rewritten (references, keys and all) */
  rewritten: number;
  /**
   * Original ids still present in the clone. MUST be empty. A non-empty
   * list means the copy still points at the original and must not be saved.
   */
  stowaways: string[];
}

type Any = Record<string, any>;

const rnd = () => Math.random().toString(36).slice(2, 10);
const defaultNewId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${rnd()}`;

/** A slug the URL layer will accept, derived from the new code. */
export function slugForCode(code: string): string {
  const base = code.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${base || "survey"}-${rnd().slice(0, 5)}`;
}

export function cloneSurveyDefinition(input: SurveyDefinition, opts: CloneOptions): CloneResult {
  const def = JSON.parse(JSON.stringify(input)) as SurveyDefinition;
  const newId = opts.newId ?? defaultNewId;
  const map = new Map<string, string>();
  const counts: Record<string, number> = {};

  /** Declare: this id belongs to this project and needs a new one. */
  const claim = (id: unknown, kind: string, prefix: string): void => {
    if (typeof id !== "string" || !id || map.has(id)) return;
    map.set(id, newId(prefix));
    counts[kind] = (counts[kind] ?? 0) + 1;
  };

  /* ---------------------------------------------------------- declarations
   * Only where an id is DEFINED. Every other appearance of that string —
   * wherever it is, whatever the field is called — is a reference, and is
   * rewritten below because it is in this map.
   */
  for (const q of (def.questions ?? []) as unknown as Any[]) {
    claim(q.id, "question", "q");
    for (const o of (q.options ?? []) as Any[]) claim(o.id, "option", "opt");
    for (const r of (q.rows ?? []) as Any[]) claim(r.id, "row", "row");
    for (const c of (q.columns ?? []) as Any[]) {
      claim(c.id, "column", "col");
      for (const o of (c.options ?? []) as Any[]) claim(o.id, "option", "opt");
      for (const v of (c.validation ?? []) as Any[]) claim(v.id, "validation", "val");
    }
    for (const v of (q.validation ?? []) as Any[]) claim(v.id, "validation", "val");
    for (const r of (q.rows ?? []) as Any[]) for (const v of (r.validation ?? []) as Any[]) claim(v.id, "validation", "val");
    for (const g of (q.optionGroups ?? []) as Any[]) claim(g.id, "optionGroup", "grp");
    for (const s of (q.skipLogic ?? []) as Any[]) claim(s.id, "rule", "skip");
    for (const l of (q.listLogic ?? []) as Any[]) claim(l.id, "rule", "list");
    for (const p of (q.punches ?? []) as Any[]) claim(p.id, "rule", "punch");
  }

  const walkFlow = (nodes: Any[] | undefined): void => {
    for (const n of nodes ?? []) {
      claim(n.id, "flowNode", n.type === "page" ? "page" : n.type === "block" ? "block" : "node");
      walkFlow(n.children);
      walkFlow(n.otherwise);
      for (const b of (n.branches ?? []) as Any[]) {
        claim(b.id, "branch", "br");
        walkFlow(b.children);
      }
    }
  };
  walkFlow(def.flow as unknown as Any[]);

  for (const qt of (def.quotas ?? []) as unknown as Any[]) {
    claim(qt.id, "quota", "quota");
    for (const c of (qt.cells ?? []) as Any[]) claim(c.id, "quotaCell", "cell");
  }
  for (const lf of (def.listFills ?? []) as unknown as Any[]) claim(lf.id, "listFill", "lf");
  for (const ne of (def.namedExpressions ?? []) as unknown as Any[]) claim(ne.id, "namedExpression", "expr");
  for (const d of (def.designs ?? []) as unknown as Any[]) claim(d.id, "design", "design");
  for (const s of (def.scripts ?? []) as unknown as Any[]) claim(s.id, "script", "script");
  for (const c of (def.calculations ?? []) as unknown as Any[]) claim(c.id, "calculation", "calc");
  for (const r of (def.displayRules ?? []) as unknown as Any[]) claim(r.id, "displayRule", "rule");
  for (const a of ((def.localization as Any)?.audio ?? []) as Any[]) claim(a.id, "audio", "audio");
  const lfNodes = (def.logicFlow ?? {}) as Any;
  for (const n of (lfNodes.nodes ?? []) as Any[]) claim(n.id, "logicFlowNode", "lfn");
  for (const e of (lfNodes.edges ?? []) as Any[]) claim(e.id, "logicFlowEdge", "lfe");

  /* ------------------------------------------------------------- rewriting */
  let rewritten = 0;

  /** A whole string that IS an id, or a colon-joined key that CONTAINS ids. */
  const rewriteString = (s: string): string => {
    const direct = map.get(s);
    if (direct) { rewritten += 1; return direct; }
    if (!s.includes(":")) return s;
    /* `q:<qid>:opt:<code>` and friends — the id is one colon-delimited part,
       and the code parts beside it are deliberately left alone */
    let touched = false;
    const parts = s.split(":").map((part) => {
      const hit = map.get(part);
      if (!hit) return part;
      touched = true;
      return hit;
    });
    if (!touched) return s;
    rewritten += 1;
    return parts.join(":");
  };

  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") return rewriteString(value);
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      const out: Any = {};
      for (const [k, v] of Object.entries(value as Any)) {
        /* KEYS matter too: translations are keyed by element key, and a key
           left behind detaches every translated word from its question. */
        out[rewriteString(k)] = rewrite(v);
      }
      return out;
    }
    return value;
  };

  const cloned = rewrite(def) as unknown as SurveyDefinition & Any;

  /* ------------------------------------------------------------ the new project */
  cloned.meta = {
    ...cloned.meta,
    id: opts.surveyId,
    code: opts.code,
    title: opts.title,
    version: "1.0",
    status: "draft",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (cloned.deployment) {
    /* A slug is a public address. Two projects answering on one is the
       original's respondents landing in the copy. */
    cloned.deployment = { ...cloned.deployment, studySlug: opts.studySlug ?? slugForCode(opts.code) };
  }

  /* ------------------------------------------------------------- the proof */
  /*
   * A PLAIN SUBSTRING SEARCH, on purpose. Looking only at whole string values
   * would miss the cases most worth catching — an id inside a custom script,
   * inside an expression, inside a key. So every NEW id is stripped out first
   * (a new id could in principle contain an old one as a substring, and a
   * false alarm would block a clone that is actually correct) and then any
   * original id still findable anywhere in the document is a real leftover.
   */
  const serialised = JSON.stringify(cloned);
  const withoutNew = [...map.values()].reduce((s, id) => s.split(id).join(" "), serialised);
  const stowaways = [...map.keys()].filter((old) => withoutNew.includes(old));

  return { def: cloned as SurveyDefinition, mapping: Object.fromEntries(map), counts, rewritten, stowaways };
}
