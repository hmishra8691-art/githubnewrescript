import type { SurveyDefinition, Question } from "@rescript/schema";
import { pipeTokensIn } from "./pipingTokens.js";
import { referencedNames } from "./embedded.js";
import { buildDerivedVariables } from "./variables.js";
import { CALC_FUNCTION_NAMES } from "./calc.js";

/**
 * WHAT USES THIS VARIABLE, AND WHAT A RENAME WOULD DO TO IT (§44, phase 2).
 *
 * The brief asks for an editable variable name. An editable variable name is
 * only safe if renaming can find everything that refers to the old one —
 * otherwise the first rename silently falsifies a skip pattern, a quota or a
 * crosstab, and nobody finds out until the data is wrong.
 *
 * ## The trap this is mostly here to close
 *
 * `getQuestionByCodeOrVar` resolves a stored reference against a question's
 * `id`, its `code` OR its `variableName` — the three are one identity at
 * runtime. And when a question is created, `code` and `variableName` are set
 * to the SAME string.
 *
 * So renaming `variableName` from `Q1` to `GENDER` usually breaks nothing
 * immediately: every `ref: "Q1"` keeps resolving, through the code. The
 * survey looks fine. Then somebody edits the code, or a piped `{{Q1}}` is
 * re-parsed in a context with no question of that code, and rules that have
 * been "working" for weeks stop resolving. A rename tool that reports
 * "0 references affected" because everything still resolves is worse than no
 * tool, so `renameImpact` reports the alias explicitly (`aliasedByCode`) and
 * the rename offers to carry the code along.
 *
 * ## Why a new module rather than `references.ts`
 *
 * `references.ts` answers "what breaks if this QUESTION is deleted", walks by
 * question identity, and describes everything in prune semantics. This
 * answers "what mentions this NAME, and can it be rewritten" — a different
 * question with a different answer shape. The pieces that do overlap
 * (`pipeTokensIn`, `referencedNames`) are imported rather than re-derived.
 */

export type UsageRewrite =
  /** the rename can rewrite this correctly and completely */
  | "auto"
  /** a person has to look at it — the tool can find it but must not edit it */
  | "review"
  /** it cannot change at all: published, immutable, or outside the definition */
  | "frozen";

export type UsageKind =
  | "question_variable"
  | "condition_ref"
  | "value_ref"
  | "pipe"
  | "expression"
  | "expression_wildcard"
  | "calc_target"
  | "override"
  | "script"
  | "analysis"
  | "derived_column";

export interface VariableUsage {
  kind: UsageKind;
  /** in the Studio's own words: "Q7 — display logic" */
  where: string;
  /** dotted path into the definition, for tests and the audit record */
  path: string;
  rewrite: UsageRewrite;
  /** why it needs review, or what exactly was found */
  detail?: string;
}

/**
 * String fields whose CONTENT is a calc expression.
 *
 * Enumerated by KEY rather than by path on purpose. There are ~20 paths that
 * can hold an expression and the list grows with every feature; there are six
 * key names and they are stable. A walk that matches keys picks up the next
 * expression field for free, where a list of paths silently misses it.
 *
 * `ref` and `value` are conditional — they are expressions only next to the
 * right sibling `kind` — so they are handled in the walk, not here.
 */
const EXPRESSION_KEYS = new Set(["expression"]);

/** `kind` values that make a sibling `value` field an expression. */
const EXPR_VALUE_KINDS = new Set(["custom_expression", "date_min", "date_max"]);

const isObj = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A variable whose name is also a calc function name is INVISIBLE inside
 * expressions.
 *
 * `referencedNames` skips anything in the function list so that `upper(X)`
 * does not report `upper` as a variable — correct, but it means a variable
 * actually called `AGE`, `COUNT`, `TEXT` or `DATE` cannot be distinguished
 * from the function of the same name by any static scan. The usage report
 * therefore cannot promise it found every expression that reads one, and
 * says so rather than quietly under-reporting.
 *
 * Found while testing: the first fixture named its variable `AGE`, the
 * expression scan returned nothing, and the test failed for what looked like
 * a bug in the walk.
 */
const FUNCTION_NAMES = new Set(CALC_FUNCTION_NAMES.map((n) => n.toLowerCase()));

export function shadowsCalcFunction(name: string): boolean {
  return FUNCTION_NAMES.has(name.toLowerCase());
}

/**
 * Does a calc expression read this name?
 *
 * Exact matches are references. A `*` glob is reported separately, because
 * `sum(ALLOC_*)` does not name `ALLOC_1` — it captures whatever happens to
 * start with `ALLOC_`, so renaming `ALLOC_1` changes the RESULT of a sum
 * without appearing anywhere in its text. There is nothing to rewrite and
 * something to tell the user about, which is what `review` means.
 */
function expressionHits(expr: string, name: string): { exact: boolean; wildcard: string[] } {
  const names = referencedNames(expr);
  let exact = false;
  const wildcard: string[] = [];
  for (const n of names) {
    if (n === name) { exact = true; continue; }
    if (n.includes("*")) {
      const prefix = n.slice(0, n.indexOf("*"));
      if (prefix && name.startsWith(prefix)) wildcard.push(n);
    }
  }
  return { exact, wildcard: [...new Set(wildcard)] };
}

/** The question a name belongs to, if it is a question's own variable name. */
export function questionForVariable(def: SurveyDefinition, name: string): Question | undefined {
  return def.questions.find((q) => q.variableName === name);
}

export interface UsageScope {
  /**
   * Saved analyses, dashboards and reports. They live in their own database
   * tables rather than in the definition, so the engine cannot reach them;
   * the API route passes them in. Omitting them does not make the rename
   * unsafe — it makes the report incomplete, which is why `renameImpact`
   * says so when the scope is absent.
   */
  analyses?: { id: string; name?: string; definition: unknown }[];
}

/**
 * Every mention of `name` in the survey definition (plus any analyses the
 * caller supplies), with what a rename could do to each.
 */
export function variableUsages(def: SurveyDefinition, name: string, scope: UsageScope = {}): VariableUsage[] {
  const out: VariableUsage[] = [];
  const seen = new Set<string>();
  const add = (u: VariableUsage) => {
    const k = `${u.kind}|${u.path}|${u.detail ?? ""}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(u);
  };

  /* -------------------------------------------------- the question itself */

  const owner = questionForVariable(def, name);
  if (owner) {
    add({
      kind: "question_variable",
      where: `${owner.code} — the question's variable name`,
      path: `questions[${def.questions.indexOf(owner)}].variableName`,
      rewrite: "auto",
    });
  }

  /* --------------------------------------------- calculations by that name */

  (def.calculations ?? []).forEach((c, i) => {
    if (c.targetVariable === name) {
      add({
        kind: "calc_target",
        where: `Calculation ${c.label || c.targetVariable} — what it writes to`,
        path: `calculations[${i}].targetVariable`,
        rewrite: "auto",
      });
    }
  });

  /* ------------------------------------------- programmer overrides on it */

  (def.variables ?? []).forEach((v, i) => {
    if (v.name === name) {
      add({
        kind: "override",
        where: "Variables — the saved settings for this variable",
        path: `variables[${i}].name`,
        rewrite: "auto",
        detail: "label, value labels, missing values and export name are stored against the name and must move with it",
      });
    }
  });

  /* -------------------------------------------------------- the deep walk */

  const walk = (node: unknown, path: string, ownerWords: string): void => {
    if (typeof node === "string") {
      // pipes can appear in ANY string field, so every string is scanned
      if (node.includes("{{")) {
        for (const t of pipeTokensIn(node)) {
          if (t.kind === "question" && t.ref === name) {
            add({
              kind: "pipe",
              where: `${ownerWords} — piped into the text`,
              path,
              rewrite: "auto",
              detail: t.text,
            });
          } else if (t.kind === "calc" && t.ref === name) {
            add({
              kind: "pipe",
              where: `${ownerWords} — a calculated value piped into the text`,
              path,
              rewrite: "auto",
              detail: t.text,
            });
          } else if (t.kind === "expr") {
            const hit = expressionHits(t.ref, name);
            if (hit.exact) {
              add({
                kind: "pipe",
                where: `${ownerWords} — an expression piped into the text`,
                path,
                rewrite: "auto",
                detail: t.text,
              });
            }
            for (const g of hit.wildcard) {
              add({
                kind: "expression_wildcard",
                where: `${ownerWords} — a piped expression`,
                path,
                rewrite: "review",
                detail: `${g} captures this variable by prefix; renaming changes what it sums without changing its text`,
              });
            }
          }
        }
      }
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, ownerWords));
      return;
    }
    if (!isObj(node)) return;

    /*
     * The words for the thing being walked. A question announces itself by
     * code, so a usage reads "Q7 — display logic" rather than a path.
     */
    const words =
      typeof node.code === "string" && typeof node.variableName === "string"
        ? String(node.code)
        : typeof node.label === "string" && typeof node.targetVariable === "string"
          ? `Calculation ${node.label || node.targetVariable}`
          : ownerWords;

    /* a structured condition source: { kind, ref } */
    if (typeof node.ref === "string" && typeof node.kind === "string") {
      if (node.kind === "expr") {
        const hit = expressionHits(node.ref, name);
        if (hit.exact) {
          add({
            kind: "expression",
            where: `${words} — an expression in a rule`,
            path: `${path}.ref`,
            rewrite: "auto",
            detail: node.ref,
          });
        }
        for (const g of hit.wildcard) {
          add({
            kind: "expression_wildcard",
            where: `${words} — an expression in a rule`,
            path: `${path}.ref`,
            rewrite: "review",
            detail: `${g} captures this variable by prefix`,
          });
        }
      } else if (node.ref === name) {
        add({
          kind: "condition_ref",
          where: `${words} — a rule reads it`,
          path: `${path}.ref`,
          rewrite: "auto",
          detail: `${node.kind} reference`,
        });
      }
    }

    /* a question value reference: { $question: "GENDER" } */
    if (node.$question === name) {
      add({
        kind: "value_ref",
        where: `${words} — a rule compares against it`,
        path: `${path}.$question`,
        rewrite: "auto",
      });
    }

    /* expression-valued fields */
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (typeof v !== "string") continue;
      const isExpr =
        EXPRESSION_KEYS.has(key) ||
        (key === "value" && typeof node.kind === "string" && EXPR_VALUE_KINDS.has(node.kind)) ||
        (key === "value" && node.source === "expression");
      if (!isExpr) continue;
      const hit = expressionHits(v, name);
      if (hit.exact) {
        add({
          kind: "expression",
          where: `${words} — an expression`,
          path: `${path}.${key}`,
          rewrite: "auto",
          detail: v,
        });
      }
      for (const g of hit.wildcard) {
        add({
          kind: "expression_wildcard",
          where: `${words} — an expression`,
          path: `${path}.${key}`,
          rewrite: "review",
          detail: `${g} captures this variable by prefix`,
        });
      }
    }

    /*
     * CUSTOM SCRIPTS CANNOT BE REWRITTEN.
     *
     * `def.scripts[].code` is arbitrary JavaScript, and the sandbox hands it
     * the flat variable map by name (`getVar("GENDER")`, and `names()` to
     * enumerate). A name can be built at runtime from a string, so no static
     * rewrite is correct; a regex substitution would be a guess that
     * sometimes corrupts working code. It is reported and left alone.
     */
    if (typeof node.code === "string" && typeof node.id === "string" && /^survey\.scripts\[/.test(path)) {
      if (node.code.includes(name)) {
        add({
          kind: "script",
          where: `Script ${node.name || node.id} — the code mentions it`,
          path: `${path}.code`,
          rewrite: "frozen",
          detail: "scripts are not rewritten automatically: a variable name can be assembled at runtime, so any substitution would be a guess",
        });
      }
    }

    for (const key of Object.keys(node)) walk(node[key], `${path}.${key}`, words);
  };

  walk(def, "survey", "the survey");

  /* ------------------------------------------------ analyses, if supplied */

  for (const a of scope.analyses ?? []) {
    if (JSON.stringify(a.definition ?? null).includes(`"${name}"`)) {
      add({
        kind: "analysis",
        where: `Analysis ${a.name || a.id} — it charts this variable`,
        path: `analytics_analyses[${a.id}]`,
        rewrite: "review",
        detail: "saved analyses are stored outside the questionnaire; published report versions are frozen snapshots and are never rewritten",
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------- the rename */

export interface RenameImpact {
  oldName: string;
  newName: string;
  ok: boolean;
  /** why the rename must not proceed */
  blockers: string[];
  /** things that change but are fine, said out loud */
  warnings: string[];
  usages: VariableUsage[];
  /**
   * The question's `code` is the same string as the old variable name, so
   * every reference spelled that way will keep resolving through the code
   * after the rename. That is the failure mode this whole module exists for:
   * it looks like a clean rename and is a delayed break.
   */
  aliasedByCode: boolean;
  /** derived columns that change name as a consequence, e.g. Q1_1 → S1_1 */
  derivedRenames: { from: string; to: string }[];
  /** true when no analyses were supplied, so the report cannot speak for them */
  analysesUnchecked: boolean;
}

/** Names nothing may be renamed to. */
const RESERVED = new Set([
  "RESP_ID", "SESSION_ID", "SURVEY_VERSION", "START_TIME", "END_TIME", "STATUS",
]);

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What renaming `oldName` to `newName` would do — computed by actually
 * rebuilding the dictionary, so the preview cannot promise a result the
 * rename does not produce.
 */
export function renameImpact(
  def: SurveyDefinition,
  oldName: string,
  newName: string,
  scope: UsageScope = {},
): RenameImpact {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!newName.trim()) blockers.push("A variable needs a name.");
  else if (!VALID_NAME.test(newName)) {
    blockers.push(`"${newName}" is not a usable variable name: use a letter or underscore first, then letters, digits and underscores.`);
  }
  if (RESERVED.has(newName.toUpperCase())) {
    blockers.push(`"${newName}" is one of the system columns every export carries; pick another name.`);
  }
  /*
   * Renaming INTO a function name creates a variable no expression scan can
   * see, so it is refused. Renaming OUT of one is the fix for that situation
   * and must stay available — but the usage list for the old name cannot be
   * trusted to be complete, so it warns instead.
   */
  if (shadowsCalcFunction(newName)) {
    blockers.push(
      `"${newName}" is also the name of a calculation function, so expressions could not tell the two apart. Pick another name.`,
    );
  }
  if (shadowsCalcFunction(oldName)) {
    warnings.push(
      `"${oldName}" is also the name of a calculation function, so expressions that read it cannot be found automatically. Check any calculation using ${oldName} by hand after renaming.`,
    );
  }

  const before = buildDerivedVariables(def);
  const owner = questionForVariable(def, oldName);
  const calc = (def.calculations ?? []).find((c) => c.targetVariable === oldName);

  if (!owner && !calc) {
    blockers.push(
      `Nothing in this survey produces a variable called "${oldName}". Renaming is available for a question's variable name and for a calculation's target.`,
    );
  }
  if (owner && calc) {
    blockers.push(`"${oldName}" is both a question's variable name and a calculation target, which should not happen; fix the duplicate first.`);
  }

  /*
   * Collision, against the WHOLE namespace rather than just variable names.
   * `getQuestionByCodeOrVar` resolves codes too, so renaming a variable onto
   * an existing question CODE makes every reference to that code ambiguous —
   * resolved by definition order, which is not a rule anybody should rely on.
   */
  if (newName !== oldName) {
    /*
     * THE NAMESPACE IS WIDER THAN THE DICTIONARY.
     *
     * This checked `buildDerivedVariables` alone, which sounds right and is
     * not: a question's `variableName` is not always a column. A multi-select
     * called `BRANDS` produces `BRANDS_1`, `BRANDS_2` and NO bare `BRANDS`,
     * so renaming another variable to `BRANDS` passed the check, applied
     * cleanly, and left two questions owning one name — found by the browser
     * suite, which ended up with `["V2", "V2", "V3"]`.
     *
     * So the check is against everything that OWNS a name, not just
     * everything that produces a column.
     */
    const takenVars = new Set<string>(before.map((v) => v.name));
    for (const q of def.questions) if (q.variableName !== oldName) takenVars.add(q.variableName);
    for (const c of def.calculations ?? []) if (c.targetVariable !== oldName) takenVars.add(c.targetVariable);
    if (takenVars.has(newName)) {
      blockers.push(`"${newName}" is already a variable in this survey.`);
    }
    const clashingCode = def.questions.find((q) => q.code === newName && q.variableName !== oldName);
    if (clashingCode) {
      blockers.push(`"${newName}" is already the question code of ${clashingCode.code}, and a rule that names it would become ambiguous.`);
    }
    if ((def.embeddedData ?? []).some((e) => e.name === newName)) {
      blockers.push(`"${newName}" is already an embedded data field.`);
    }
  }

  const usages = variableUsages(def, oldName, scope);

  /*
   * THE ALIAS. Only meaningful for a question: a calculation has no code.
   */
  const aliasedByCode = !!owner && owner.code === oldName;

  /* What the dictionary looks like afterwards, computed rather than guessed. */
  let derivedRenames: { from: string; to: string }[] = [];
  if (blockers.length === 0) {
    const after = buildDerivedVariables(applyRename(def, oldName, newName, { alsoCode: false }));
    const beforeNames = before.map((v) => v.name);
    const afterNames = after.map((v) => v.name);
    if (beforeNames.length === afterNames.length) {
      for (let i = 0; i < beforeNames.length; i++) {
        if (beforeNames[i] !== afterNames[i]) derivedRenames.push({ from: beforeNames[i], to: afterNames[i] });
      }
    } else {
      warnings.push("The rename changes how many columns the survey produces, which it should not; check the dictionary afterwards.");
      const gone = beforeNames.filter((n) => !afterNames.includes(n));
      const fresh = afterNames.filter((n) => !beforeNames.includes(n));
      derivedRenames = gone.map((from, i) => ({ from, to: fresh[i] ?? "—" }));
    }

    /*
     * The invariant, checked on the actual result rather than inferred from
     * the inputs: no two columns may share a name afterwards.
     *
     * The namespace check above catches the cases we can name. This catches
     * the ones we cannot — a renamed question whose DERIVED columns collide
     * with another question's, which no comparison of base names would see.
     */
    const seenAfter = new Set<string>();
    for (const n of afterNames) {
      if (seenAfter.has(n)) {
        blockers.push(`Renaming to "${newName}" would produce two columns called "${n}".`);
        break;
      }
      seenAfter.add(n);
    }
  }

  if (derivedRenames.length > 1) {
    warnings.push(
      `${derivedRenames.length} columns change name, because this question produces one per option or row. Every delivered file and every saved analysis refers to those columns.`,
    );
  }
  if (aliasedByCode) {
    warnings.push(
      `The question code is also "${oldName}", so rules that name it will keep working through the code after the rename — which hides the change until the code is edited. Rename the code too unless you have a reason not to.`,
    );
  }
  for (const u of usages) {
    if (u.rewrite === "frozen") blockers.push(`${u.where}. ${u.detail ?? ""}`.trim());
    else if (u.rewrite === "review") warnings.push(`${u.where}. ${u.detail ?? ""}`.trim());
  }

  return {
    oldName,
    newName,
    ok: blockers.length === 0,
    blockers,
    warnings,
    usages,
    aliasedByCode,
    derivedRenames,
    analysesUnchecked: scope.analyses === undefined,
  };
}

/**
 * The rewrite itself, on a deep copy.
 *
 * Deliberately separate from `renameImpact` so the preview runs the real
 * thing: the impact report calls this to compute the resulting dictionary,
 * which means a preview that says "12 columns change" is the output of the
 * same code that will change them.
 */
export function applyRename(
  def: SurveyDefinition,
  oldName: string,
  newName: string,
  opts: { alsoCode?: boolean } = {},
): SurveyDefinition {
  const next: SurveyDefinition = JSON.parse(JSON.stringify(def));

  const owner = next.questions.find((q) => q.variableName === oldName);
  const renameCode = !!opts.alsoCode && !!owner && owner.code === oldName;

  if (owner) {
    owner.variableName = newName;
    if (renameCode) owner.code = newName;
  }
  for (const c of next.calculations ?? []) {
    if (c.targetVariable === oldName) c.targetVariable = newName;
  }
  for (const v of next.variables ?? []) {
    if (v.name === oldName) v.name = newName;
  }

  /*
   * Everything else is a string somewhere in the tree. The walk mirrors
   * `variableUsages` exactly — same conditions, same keys — because a finder
   * and a rewriter that disagree produce the worst outcome available: a
   * preview that lists a usage the rename then fails to update.
   */
  const rewriteExpression = (expr: string): string =>
    // word boundaries, so QUOTA_AGE is not touched when renaming AGE
    expr.replace(new RegExp(`(?<![A-Za-z0-9_.])${escapeRe(oldName)}(?![A-Za-z0-9_*])`, "g"), newName);

  const walk = (node: any, path: string): void => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (!isObj(node)) return;

    for (const key of Object.keys(node)) {
      const v = node[key];

      if (typeof v === "string") {
        if (v.includes("{{")) node[key] = rewritePipes(v, oldName, newName, rewriteExpression);

        const isExprField =
          EXPRESSION_KEYS.has(key) ||
          (key === "value" && typeof node.kind === "string" && EXPR_VALUE_KINDS.has(node.kind)) ||
          (key === "value" && node.source === "expression");
        if (isExprField) node[key] = rewriteExpression(node[key]);

        if (key === "ref" && node.kind === "expr") node[key] = rewriteExpression(node[key]);
        else if (key === "ref" && typeof node.kind === "string" && v === oldName) node[key] = newName;
        else if (key === "$question" && v === oldName) node[key] = newName;
        continue;
      }
      walk(v, `${path}.${key}`);
    }
  };

  /*
   * `questions[].variableName` and `calculations[].targetVariable` were set
   * above; the walk must not undo them, and it will not — it only rewrites
   * `ref`, `$question`, expression fields and pipe tokens, none of which
   * those are.
   */
  walk(next, "survey");
  return next;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite the pipe tokens in one string, leaving the rest of it alone.
 *
 * SURGERY ON THE TOKEN BODY, not re-serialisation. `serializePipeToken` is
 * not round-trip safe: the parser fills in defaults the author never typed,
 * so `{{AGE}}` comes back as `{{AGE.label}}`. Re-serialising every token
 * would rewrite piping the rename was not asked to touch, and change what
 * some of it renders. Replacing just the name inside the body preserves the
 * row selector, the property and the `|` modifiers exactly as written.
 *
 * Note `t.raw` is the BODY (`AGE`) and `t.text` is the whole token
 * (`{{AGE}}`) — the two are easy to confuse, and confusing them produces
 * `{{{{AGE}}}}`.
 */
function rewritePipes(text: string, oldName: string, newName: string, rewriteExpression: (s: string) => string): string {
  let out = text;
  const head = new RegExp(`^(\\s*)${escapeRe(oldName)}(?![A-Za-z0-9_])`);
  for (const t of pipeTokensIn(text)) {
    let body: string | null = null;

    if (t.kind === "question" && t.ref === oldName && head.test(t.raw)) {
      body = t.raw.replace(head, `$1${newName}`);
    } else if (t.kind === "calc" && t.ref === oldName) {
      body = t.raw.replace(
        new RegExp(`(^\\s*calc\\.)${escapeRe(oldName)}(?![A-Za-z0-9_])`),
        `$1${newName}`,
      );
    } else if (t.kind === "expr") {
      const rewritten = rewriteExpression(t.raw);
      if (rewritten !== t.raw) body = rewritten;
    }

    if (body !== null && body !== t.raw) out = out.split(t.text).join(`{{${body}}}`);
  }
  return out;
}

/**
 * Rename, or refuse and say why. The single entry point the UI and the API
 * should both use — so a rename done through the API is checked exactly as
 * hard as one done through the panel.
 */
export function renameVariable(
  def: SurveyDefinition,
  oldName: string,
  newName: string,
  opts: { alsoCode?: boolean; scope?: UsageScope } = {},
): { ok: false; impact: RenameImpact } | { ok: true; def: SurveyDefinition; impact: RenameImpact } {
  const impact = renameImpact(def, oldName, newName, opts.scope ?? {});
  if (!impact.ok) return { ok: false, impact };
  return { ok: true, def: applyRename(def, oldName, newName, { alsoCode: opts.alsoCode }), impact };
}

/* ------------------------------------------------------- naming a copy */

/**
 * EVERY NAME THAT ALREADY MEANS SOMETHING IN THIS SURVEY.
 *
 * Codes and variable names share one namespace, because
 * `getQuestionByCodeOrVar` resolves both — so a copy whose CODE collides with
 * another question's VARIABLE NAME is just as broken as two identical
 * variable names, and a uniqueness check that looks at only one of them finds
 * only half the collisions. Calculation targets, embedded-data fields and the
 * reserved system columns are in the same namespace for the same reason.
 */
export function usedNames(def: SurveyDefinition): Set<string> {
  const taken = new Set<string>(RESERVED);
  for (const q of def.questions ?? []) {
    if (q.code) taken.add(q.code);
    if (q.variableName) taken.add(q.variableName);
  }
  for (const c of def.calculations ?? []) if (c.targetVariable) taken.add(c.targetVariable);
  for (const node of def.flow ?? []) collectEmbeddedNames(node as Record<string, unknown>, taken);
  return taken;
}

/** Embedded-data fields live on flow nodes, at any depth. */
function collectEmbeddedNames(node: Record<string, unknown>, into: Set<string>): void {
  if (!node || typeof node !== "object") return;
  const fields = (node as { fields?: { name?: string }[] }).fields;
  if (Array.isArray(fields)) for (const f of fields) if (f?.name) into.add(f.name);
  for (const key of ["children", "branches", "cases"]) {
    const kids = (node as Record<string, unknown>)[key];
    if (Array.isArray(kids)) for (const k of kids) collectEmbeddedNames(k as Record<string, unknown>, into);
  }
}

/**
 * NAME A DUPLICATED QUESTION SO IT CANNOT COLLIDE.
 *
 * Both duplicate paths in the Studio appended `_COPY` blindly. Duplicating one
 * question TWICE therefore produced two questions with the same code and the
 * same variable name — and a duplicate variable name is a blocking problem at
 * the publish gate, so the survey then could not be versioned or tested at
 * all. The reported symptom was "my changes could not be saved"; this is what
 * was actually wrong.
 *
 * The code and the variable name take the SAME suffix, chosen so that neither
 * collides. They are usually identical (`Q1`/`Q1`) and a programmer reasonably
 * expects them to stay in step, so numbering them independently — `Q1_COPY`
 * with `Q1_COPY_2` — would be its own small betrayal.
 *
 * `taken` is passed in and mutated by the caller rather than recomputed per
 * question, because duplicating a BLOCK mints several copies before any of
 * them is in the definition; recomputing from `def` each time would hand the
 * same name to every question in the block.
 */
export function copyNames(
  taken: Set<string>,
  from: { code?: string; variableName?: string },
): { code: string; variableName: string } {
  const code = from.code ?? "";
  const variableName = from.variableName ?? "";
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? "_COPY" : `_COPY_${n}`;
    const c = `${code}${suffix}`;
    const v = `${variableName}${suffix}`;
    // a name is free only if BOTH are, so the two stay in step
    if (!taken.has(c) && !taken.has(v)) {
      taken.add(c);
      taken.add(v);
      return { code: c, variableName: v };
    }
  }
  /* a thousand copies of one question is not a real survey; rather than loop
     for ever, fall back to something that cannot collide */
  const unique = `_COPY_${Date.now().toString(36).toUpperCase()}`;
  taken.add(`${code}${unique}`);
  taken.add(`${variableName}${unique}`);
  return { code: `${code}${unique}`, variableName: `${variableName}${unique}` };
}
