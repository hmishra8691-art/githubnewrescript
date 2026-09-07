/**
 * A STABLE ID FOR EVERY PROGRAMMABLE ELEMENT (§31–49).
 *
 * Most containers already had one — questions, columns, pages, blocks,
 * sections, branches, randomizers, loops, ends, List Fills, quotas, quota
 * cells, calculations, and every kind of logic rule except validation. The
 * leaves did not: options, rows, validation rules and List Fill entries were
 * addressed by `code`, by `name`, or by array index.
 *
 * `code` is not a bad key — it is the platform's join key, and it has to
 * stay one, because stored answers, export column names, quota cells, List
 * Fill counters and the variable dictionary are all keyed by it and several of
 * those live in database tables that nothing can rewrite. What `code` is not
 * is STABLE: `resequence` renumbers a whole list when a sibling is deleted,
 * and the code box is a plain text input. An id is the second name that
 * survives that.
 *
 * ## THE THREE CONSTRAINTS THAT DECIDED THE DESIGN
 *
 * 1. IDS ARE OPTIONAL IN THE SCHEMA. Every definition already stored was
 *    written without them. A required field fails `safeParse`, and both the
 *    runtime and the Studio treat a parse failure as "cannot open" — so a
 *    required id would take every live survey dark at deploy.
 *
 * 2. BACKFILL CANNOT BE A ZOD DEFAULT. `z.string().default(() => uid())`
 *    mints a FRESH id on every parse, and every read path parses: opening the
 *    Studio, serving a respondent, running a quality check, building an
 *    export. Ids would churn per request, which is the exact opposite of
 *    stable. Backfill is an explicit function, run at write boundaries and
 *    persisted.
 *
 * 3. BACKFILL MUST BE DETERMINISTIC, because published versions are frozen.
 *    `survey_versions.definition` is protected by a database trigger (0012):
 *    a published snapshot cannot be rewritten, deliberately, because a
 *    deployed link is pinned to it. So an old version can only be backfilled
 *    ON READ — and a random id would differ on every request, which would
 *    break anything that stored one. Derived ids are identical every time.
 *
 * ## WHAT THAT MEANS IN PRACTICE, STATED PLAINLY
 *
 * A backfilled id is derived from the element's parent and its code. For a
 * DRAFT that is written once and then persisted, so a later code change does
 * not move the id — the id is only derived while it is missing. For a FROZEN
 * VERSION the derivation runs on every read and gives the same answer,
 * because a frozen definition cannot change.
 *
 * The one honest caveat: a pre-existing element's id is a function of the code
 * it had at backfill time. Elements created from now on get a minted id that
 * was never a function of anything.
 */
import type { SurveyDefinition } from "@rescript/schema";

/* ------------------------------------------------------------ minting */

/**
 * FNV-1a, 32 bits, hex.
 *
 * Not a security hash and not trying to be. It needs to be deterministic
 * across processes and versions of Node, short enough to read in a JSON diff,
 * and available in the browser bundle — which rules out `node:crypto`, as the
 * test-case fingerprint found before it.
 */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The id a missing element would be given. Pure, and the same every time. */
export function derivedId(prefix: string, ...parts: unknown[]): string {
  return `${prefix}_${hash(parts.map(String).join(""))}`;
}

/**
 * The id of a matrix / composite CELL (§36).
 *
 * Derived, never stored. A cell is not an object in this schema — it is the
 * intersection of a row and a column, and storing an id for every one of them
 * would add rows×columns entries to a definition to say something that can be
 * computed. Deterministic from its parents' ids, which is exactly what §36
 * asks for: "a deterministic relationship to its parent row/column without
 * becoming dependent on visible labels".
 */
export function cellId(rowId: string, columnId: string): string {
  return derivedId("cell", rowId, columnId);
}

/* -------------------------------------------------------------- backfill */

export interface BackfillResult {
  def: SurveyDefinition;
  /** how many ids were added, by element kind */
  added: Record<string, number>;
  /** true when nothing was missing — the caller can skip the write */
  clean: boolean;
}

type Any = Record<string, any>;

/**
 * Fill in every missing element id, deterministically.
 *
 * Returns a NEW definition; the input is not touched. Idempotent: running it
 * twice adds nothing the second time, which is what makes it safe to call on
 * every read.
 */
export function ensureElementIds(input: SurveyDefinition): BackfillResult {
  const def = JSON.parse(JSON.stringify(input)) as SurveyDefinition;
  const added: Record<string, number> = {};
  const bump = (kind: string) => { added[kind] = (added[kind] ?? 0) + 1; };

  /** Set `id` if absent. Returns whatever the id now is. */
  const fill = (obj: Any, kind: string, prefix: string, ...parts: unknown[]): string => {
    const cur = obj.id;
    if (typeof cur === "string" && cur) return cur;
    const id = derivedId(prefix, ...parts);
    obj.id = id;
    bump(kind);
    return id;
  };

  for (const q of (def.questions ?? []) as unknown as Any[]) {
    const qid = String(q.id ?? "");

    for (const [i, o] of ((q.options ?? []) as Any[]).entries()) {
      fill(o, "option", "opt", qid, o.code ?? i);
    }
    for (const [i, r] of ((q.rows ?? []) as Any[]).entries()) {
      fill(r, "row", "row", qid, r.code ?? i);
    }
    for (const [i, c] of ((q.columns ?? []) as Any[]).entries()) {
      /* columns have always had ids; this only catches a hand-written one */
      fill(c, "column", "col", qid, i);
      /* a column can carry its own option list */
      for (const [j, o] of ((c.options ?? []) as Any[]).entries()) {
        fill(o, "option", "opt", qid, String(c.id), o.code ?? j);
      }
      for (const [j, v] of ((c.validation ?? []) as Any[]).entries()) {
        fill(v, "validation", "vr", qid, String(c.id), v.kind ?? "", j);
      }
    }
    /*
     * Validation rules are indexed by their POSITION as well as their kind,
     * because a question may legitimately carry two rules of the same kind
     * (two `pattern` rules, say) and they must not collide onto one id.
     */
    for (const [i, v] of ((q.validation ?? []) as Any[]).entries()) {
      fill(v, "validation", "vr", qid, v.kind ?? "", i);
    }
    for (const r of ((q.rows ?? []) as Any[])) {
      for (const [j, v] of ((r.validation ?? []) as Any[]).entries()) {
        fill(v, "validation", "vr", qid, String(r.id), v.kind ?? "", j);
      }
    }
    /* option groups, when the question has them (§37) */
    for (const [i, g] of ((q.optionGroups ?? []) as Any[]).entries()) {
      fill(g, "group", "grp", qid, g.name ?? i);
    }
  }

  for (const lf of (def.listFills ?? []) as unknown as Any[]) {
    const lid = String(lf.id ?? "");
    for (const [i, o] of ((lf.options ?? []) as Any[]).entries()) {
      fill(o, "listFillOption", "lfo", lid, o.code ?? i);
    }
    for (const [i, d] of ((lf.destinations ?? []) as Any[]).entries()) {
      fill(d, "listFillDestination", "lfd", lid, d.questionId ?? "", d.position ?? i);
    }
  }

  const total = Object.values(added).reduce((a, b) => a + b, 0);
  return { def, added, clean: total === 0 };
}

/* ---------------------------------------------------------------- lookup */

export type ElementKind =
  | "question" | "option" | "row" | "column" | "group"
  | "block" | "page" | "section" | "loop" | "listFill"
  | "quota" | "quotaCell" | "calculation" | "logicRule" | "validation";

export interface ElementRef {
  kind: ElementKind;
  id: string;
  /** the element itself, as stored */
  element: unknown;
  /** the id of the thing that owns it, when it has one */
  parentId?: string;
  /** a short human label, for debugging output */
  label?: string;
}

/**
 * Every identified element in a definition, by id.
 *
 * This is what makes an id worth having: `getOption("opt_a3f19b2c")` from a
 * script, an error message that names the element rather than its position,
 * and a debugger that can resolve a reference found in stored JSON.
 */
export function elementIndex(def: SurveyDefinition): Map<string, ElementRef> {
  const out = new Map<string, ElementRef>();
  const put = (kind: ElementKind, id: unknown, element: unknown, parentId?: string, label?: string) => {
    if (typeof id !== "string" || !id) return;
    /*
     * FIRST WINS, and duplicates are not silently merged. A definition with
     * two elements claiming one id is a broken definition; overwriting would
     * hide it, and `duplicateElementIds` below is how it gets reported.
     */
    if (!out.has(id)) out.set(kind === "question" ? id : id, { kind, id, element, parentId, label });
  };

  for (const q of (def.questions ?? []) as unknown as Any[]) {
    const qid = String(q.id ?? "");
    put("question", q.id, q, undefined, String(q.code ?? ""));
    for (const o of ((q.options ?? []) as Any[])) put("option", o.id, o, qid, String(o.label ?? o.code ?? ""));
    for (const r of ((q.rows ?? []) as Any[])) put("row", r.id, r, qid, String(r.label ?? r.code ?? ""));
    for (const c of ((q.columns ?? []) as Any[])) {
      put("column", c.id, c, qid, String(c.label ?? ""));
      for (const o of ((c.options ?? []) as Any[])) put("option", o.id, o, String(c.id), String(o.label ?? o.code ?? ""));
    }
    for (const g of ((q.optionGroups ?? []) as Any[])) put("group", g.id, g, qid, String(g.name ?? ""));
    for (const v of ((q.validation ?? []) as Any[])) put("validation", v.id, v, qid, String(v.kind ?? ""));
    for (const s of ((q.skipRules ?? []) as Any[])) put("logicRule", s.id, s, qid, "skip");
  }

  const walkFlow = (nodes: Any[]) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      const t = String(n.type ?? "");
      const kind: ElementKind | null =
        t === "page" ? "page" : t === "block" ? "block" : t === "section" ? "section"
          : t === "loop" ? "loop" : null;
      if (kind) put(kind, n.id, n, undefined, String(n.title ?? ""));
      if (n.children) walkFlow(n.children as Any[]);
      if (n.branches) for (const b of n.branches as Any[]) walkFlow(b.children as Any[]);
      if (n.otherwise) walkFlow(n.otherwise as Any[]);
    }
  };
  walkFlow((def.flow ?? []) as unknown as Any[]);

  for (const lf of (def.listFills ?? []) as unknown as Any[]) {
    put("listFill", lf.id, lf, undefined, String(lf.name ?? lf.id ?? ""));
  }
  for (const qu of (def.quotas ?? []) as unknown as Any[]) {
    put("quota", qu.id, qu, undefined, String(qu.name ?? ""));
    for (const c of ((qu.cells ?? []) as Any[])) put("quotaCell", c.id, c, String(qu.id), String(c.label ?? ""));
  }
  for (const c of (def.calculations ?? []) as unknown as Any[]) {
    put("calculation", c.id, c, undefined, String(c.targetVariable ?? ""));
  }
  for (const d of (def.displayRules ?? []) as unknown as Any[]) {
    put("logicRule", d.id, d, undefined, String(d.label ?? "display rule"));
  }

  return out;
}

/**
 * Ids claimed by more than one element.
 *
 * Studio's minter is `Date.now()` plus a counter that resets per page load,
 * so two collaborators editing in the same millisecond can produce the same
 * id. Flow nodes were already linted for this; nothing else was.
 */
export function duplicateElementIds(def: SurveyDefinition): { id: string; count: number; kinds: string[] }[] {
  const seen = new Map<string, { count: number; kinds: Set<string> }>();
  const note = (kind: string, id: unknown) => {
    if (typeof id !== "string" || !id) return;
    const e = seen.get(id) ?? { count: 0, kinds: new Set<string>() };
    e.count += 1; e.kinds.add(kind);
    seen.set(id, e);
  };

  for (const q of (def.questions ?? []) as unknown as Any[]) {
    note("question", q.id);
    for (const o of ((q.options ?? []) as Any[])) note("option", o.id);
    for (const r of ((q.rows ?? []) as Any[])) note("row", r.id);
    for (const c of ((q.columns ?? []) as Any[])) note("column", c.id);
    for (const g of ((q.optionGroups ?? []) as Any[])) note("group", g.id);
  }
  for (const lf of (def.listFills ?? []) as unknown as Any[]) note("listFill", lf.id);
  for (const qu of (def.quotas ?? []) as unknown as Any[]) {
    note("quota", qu.id);
    for (const c of ((qu.cells ?? []) as Any[])) note("quotaCell", c.id);
  }

  return [...seen.entries()]
    .filter(([, e]) => e.count > 1)
    .map(([id, e]) => ({ id, count: e.count, kinds: [...e.kinds] }));
}

/** Human-readable, for a lint list. */
export function lintElementIds(def: SurveyDefinition): string[] {
  return duplicateElementIds(def).map(
    (d) => `${d.count} elements share the id "${d.id}" (${d.kinds.join(", ")}) — `
      + "only the first can be addressed, so logic and scripts pointing at it will reach the wrong one.",
  );
}
