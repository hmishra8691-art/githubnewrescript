/**
 * IF / ELSE IF / ELSE over an ordered list of rules (§8, §23).
 *
 * Auto punch already carried a full nested AND/OR/NOT condition on every
 * rule — what it had no notion of was ELSE. To express
 *
 *   if      COUNT(Q2) >= 5   →  "Heavy User"
 *   else if COUNT(Q2) >= 3   →  "Medium User"
 *   else                     →  "Light User"
 *
 * a programmer had to write the second rule as `COUNT(Q2) >= 3 AND NOT
 * COUNT(Q2) >= 5` and the third as the negation of both — by hand, and again
 * every time a threshold moved. Three rules and two hand-written negations for
 * something the brief writes in three lines.
 *
 * ## WHY THIS IS A FUNCTION AND NOT A NEW RULE TYPE
 *
 * A chain is not a new kind of object. It is an ADJACENCY over the rules that
 * already exist: consecutive rules form one chain and the first match wins.
 * That means:
 *
 *   · nothing in the stored shape changes except one optional field, so every
 *     punch rule that exists today keeps behaving exactly as it does —
 *     independent, applied in order, last writer wins per code;
 *   · the same function serves both punch code paths (the answer side in
 *     `setExpression.ts` and the option-list side in `carryforward.ts`), which
 *     is what stops them disagreeing about which rules ran;
 *   · it is pure. It takes a predicate rather than a context, so it can be
 *     tested without a survey and reused by any other ordered rule list that
 *     wants the same semantics.
 *
 * ## THE ONE JUDGEMENT CALL
 *
 * An `else_if` or `else` with no `if` above it starts its OWN chain, and
 * therefore behaves as an `if`. The alternative — treating it as belonging to
 * a chain that does not exist — is a rule that silently never runs, which is
 * the worst outcome available: it looks configured and does nothing.
 */

export interface ChainableRule {
  /** Absent means the rule always applies (subject to the chain). */
  when?: unknown;
  mode?: "if" | "else_if" | "else";
}

export interface ChainStep<T> {
  rule: T;
  /** Did this rule's own condition hold? `else` has none, so always true. */
  held: boolean;
  /** Was it reached at all, or short-circuited by an earlier match? */
  reached: boolean;
  /** Did it actually apply — reached AND held? */
  applied: boolean;
  /** 0-based chain number, for a trace that has to explain what happened. */
  chain: number;
}

/**
 * Walk the rules, honouring chains, and say what happened to each.
 *
 * `holds` is called only for rules that are REACHED — which is the point of a
 * chain, and worth relying on: a condition that is expensive or that has side
 * effects (a trace collector, say) is not evaluated for a branch the chain
 * already skipped.
 */
export function walkPunchChain<T extends ChainableRule>(
  rules: T[],
  holds: (rule: T) => boolean,
): ChainStep<T>[] {
  const out: ChainStep<T>[] = [];
  let chain = -1;
  /** has something in the current chain already matched? */
  let settled = false;
  /** is a chain open — i.e. has an `if` been seen since the last one closed? */
  let open = false;

  for (const rule of rules) {
    const mode = rule.mode ?? "if";
    const continues = (mode === "else_if" || mode === "else") && open;

    if (!continues) {
      /* a new chain: an `if`, or an orphaned else that starts one of its own */
      chain += 1;
      settled = false;
      open = true;
    }

    if (settled) {
      /* an earlier branch of this chain matched, so this one is not reached */
      out.push({ rule, held: false, reached: false, applied: false, chain });
      continue;
    }

    /* `else` has no condition of its own — reaching it IS the condition */
    const held = mode === "else" && continues ? true : holds(rule);
    if (held) settled = true;
    out.push({ rule, held, reached: true, applied: held, chain });
  }

  return out;
}

/** Just the rules that apply, in order. The common case. */
export function activePunchRules<T extends ChainableRule>(
  rules: T[],
  holds: (rule: T) => boolean,
): T[] {
  return walkPunchChain(rules, holds).filter((s) => s.applied).map((s) => s.rule);
}

/**
 * Problems a chain can have that the engine cannot refuse (§46).
 *
 * Each of these evaluates perfectly well and produces a rule that never runs,
 * which is precisely the class of thing that has to be caught by reading the
 * definition rather than by running it.
 */
export function lintPunchChain<T extends ChainableRule & { label?: string; id?: string }>(
  rules: T[],
  describe: (rule: T, index: number) => string = (_r, i) => `rule ${i + 1}`,
): string[] {
  const out: string[] = [];
  const steps = walkPunchChain(rules, () => false);

  rules.forEach((rule, i) => {
    const mode = rule.mode ?? "if";

    if (mode === "else" && rule.when) {
      out.push(
        `${describe(rule, i)} is an ELSE but also has a condition. `
        + "An ELSE runs when everything above it failed — the condition is ignored.",
      );
    }
    if (mode === "else_if" && !rule.when) {
      out.push(
        `${describe(rule, i)} is an ELSE IF with no condition, so it behaves as a plain ELSE `
        + "and nothing after it in the chain can ever run.",
      );
    }
    /*
     * An orphan is not an error — it starts its own chain and behaves as an
     * `if`, which is the safe reading. But it is almost never what somebody
     * meant, so it is worth saying.
     */
    if ((mode === "else_if" || mode === "else") && steps[i].chain !== steps[i - 1]?.chain) {
      out.push(
        `${describe(rule, i)} is an ${mode === "else" ? "ELSE" : "ELSE IF"} with no IF above it, `
        + "so it starts a chain of its own and runs on its own merits.",
      );
    }
  });

  /* anything after an unconditional ELSE in the same chain is unreachable */
  let sawElse = -1;
  let elseChain = -1;
  steps.forEach((step, i) => {
    const mode = step.rule.mode ?? "if";
    if (mode === "else" && step.chain === elseChain) return;
    if (mode === "else") { sawElse = i; elseChain = step.chain; return; }
    if (sawElse >= 0 && step.chain === elseChain) {
      out.push(
        `${describe(step.rule, i)} comes after the ELSE in its chain, so it can never run. `
        + "Move it above the ELSE.",
      );
    }
  });

  return out;
}
