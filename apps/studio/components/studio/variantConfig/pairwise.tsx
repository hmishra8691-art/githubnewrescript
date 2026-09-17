"use client";
import React from "react";
import { registerVariantSettings } from "./registry";

/**
 * AUTHORING A SET OF PAIRWISE COMPARISONS.
 *
 * The rows are the pairs and the options are the pool of choices, which is
 * what lets this borrow the single-select matrix's answer shape instead of
 * inventing one. But the generic Rows editor knows nothing about a pair, so
 * a programmer editing this variant would be typing option codes into a meta
 * field by hand. This is the editor for it: two dropdowns per pair, both
 * drawn from the question's own options.
 *
 * The review's wording was "each pair should always contain exactly two
 * choices", and that is enforced by shape here — there is nowhere to put a
 * third.
 */

let seq = 0;
const nextCode = (used: Set<string>) => {
  let c = "";
  do { c = `p${++seq}`; } while (used.has(c));
  return c;
};

registerVariantSettings("pairwiseset", ({ q, patch }) => {
  const options = q.options;
  const setPair = (i: number, key: "left" | "right", code: string) =>
    patch({
      rows: q.rows.map((r, j) =>
        j === i ? { ...r, meta: { ...(r.meta ?? {}), [key]: code } } : r),
    });

  const addPair = () => {
    const used = new Set(q.rows.map((r) => String(r.code)));
    /* pick two choices nothing else has paired yet, so a new pair is usable
       the moment it appears rather than being two copies of Choice 1 */
    const paired = new Set(q.rows.flatMap((r) => [String(r.meta?.left ?? ""), String(r.meta?.right ?? "")]));
    const free = options.filter((o) => !paired.has(String(o.code)));
    const left = free[0] ?? options[0];
    const right = free[1] ?? options[1] ?? options[0];
    if (!left || !right) return;
    patch({
      rows: [...q.rows, {
        code: nextCode(used),
        label: `Pair ${q.rows.length + 1}`,
        flags: [], validation: [], required: false,
        meta: { left: String(left.code), right: String(right.code) },
      } as never],
    });
  };

  return (
    <div className="card" style={{ padding: 10 }} data-testid="pairwise-pairs">
      <h3 className="sec" style={{ marginTop: 0 }}>Comparisons — each pair holds exactly two choices</h3>
      {options.length < 2 && (
        <p className="muted" style={{ fontSize: 13 }}>
          Add at least two choices in Options above, then build pairs from them.
        </p>
      )}
      {q.rows.map((r, i) => {
        const left = String(r.meta?.left ?? "");
        const right = String(r.meta?.right ?? "");
        const missing = !options.some((o) => String(o.code) === left) || !options.some((o) => String(o.code) === right);
        return (
          <div key={i} className="row" style={{ flexWrap: "wrap", marginBottom: 8, alignItems: "flex-end" }}>
            <label className="f" style={{ width: 130 }}><span>Pair</span>
              <input className="input" value={r.label} data-testid={`pair-label-${i}`}
                onChange={(e) => patch({ rows: q.rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            </label>
            <label className="f" style={{ width: 190 }}><span>Choice A</span>
              <select className="select" value={left} data-testid={`pair-left-${i}`}
                onChange={(e) => setPair(i, "left", e.target.value)}>
                <option value="">—</option>
                {options.map((o) => (
                  <option key={String(o.code)} value={String(o.code)}>
                    {o.label.replace(/<[^>]*>/g, "") || String(o.code)}
                  </option>
                ))}
              </select>
            </label>
            <span style={{ paddingBottom: 9, color: "var(--subtle)" }}>vs</span>
            <label className="f" style={{ width: 190 }}><span>Choice B</span>
              <select className="select" value={right} data-testid={`pair-right-${i}`}
                onChange={(e) => setPair(i, "right", e.target.value)}>
                <option value="">—</option>
                {options.map((o) => (
                  <option key={String(o.code)} value={String(o.code)}>
                    {o.label.replace(/<[^>]*>/g, "") || String(o.code)}
                  </option>
                ))}
              </select>
            </label>
            {left && right && left === right && (
              <span className="chip warn" style={{ marginBottom: 7 }} data-testid={`pair-same-${i}`}>
                both sides are the same choice
              </span>
            )}
            {missing && (
              <span className="chip warn" style={{ marginBottom: 7 }} data-testid={`pair-missing-${i}`}>
                a choice this pair names is no longer in the options
              </span>
            )}
            <button className="btn small danger" style={{ marginBottom: 7 }}
              data-testid={`pair-remove-${i}`}
              onClick={() => patch({ rows: q.rows.filter((_, j) => j !== i) })}>×</button>
          </div>
        );
      })}
      <button className="btn small" data-testid="pair-add" disabled={options.length < 2} onClick={addPair}>
        + comparison
      </button>
    </div>
  );
});
