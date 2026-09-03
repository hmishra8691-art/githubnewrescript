"use client";
import React from "react";
import type { Condition, Option } from "@rescript/schema";
import { registerVariantSettings } from "./registry";
import { ConditionEditor, newConditionGroup } from "../ConditionBuilder";

/**
 * Studio authoring for the dynamic family — the adaptive question's
 * alternatives (`settings.adaptive`).
 *
 * Each alternative is a condition plus what it replaces. The list is read
 * top-down: the FIRST alternative whose condition holds wins, which is why
 * the rows can be reordered rather than only added.
 */

interface Alt {
  label?: string;
  when: Condition;
  text?: string;
  instruction?: string;
  options?: Option[];
}

/** "1<TAB>Label" per line, or bare labels that become codes 1..N. */
function parseOptions(text: string): Option[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      const m = /^([^\t|]+)[\t|]\s*(.+)$/.exec(line);
      const code = m ? m[1].trim() : String(i + 1);
      const label = m ? m[2].trim() : line;
      return { code: /^\d+$/.test(code) ? Number(code) : code, label, flags: [] } as Option;
    });
}
function printOptions(opts: Option[] | undefined): string {
  return (opts ?? []).map((o) => `${o.code}\t${o.label}`).join("\n");
}

registerVariantSettings("adaptive", ({ q, patchSettings }) => {
  const alts = (q.settings.adaptive ?? []) as Alt[];
  const write = (next: Alt[]) =>
    patchSettings({ adaptive: next.length ? (next as NonNullable<typeof q.settings.adaptive>) : undefined });
  const setAt = (i: number, patch: Partial<Alt>) =>
    write(alts.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= alts.length) return;
    const next = [...alts];
    [next[i], next[j]] = [next[j], next[i]];
    write(next);
  };

  return (
    <>
      <h3 className="sec">Adaptive alternatives</h3>
      <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        The question text above is the DEFAULT stem — it is what a respondent
        sees when no alternative matches. Each alternative can replace the stem,
        the instruction and the option list. The first one whose condition holds
        wins, so order matters.
      </div>

      {alts.map((alt, i) => (
        <div key={i} className="chip-block" data-testid={`adaptive-alt-${i}`}
          style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="chip">#{i + 1}</span>
            <input className="input grow" placeholder="name this alternative (optional)"
              data-testid={`adaptive-label-${i}`}
              value={alt.label ?? ""}
              onChange={(e) => setAt(i, { label: e.target.value || undefined })} />
            <button className="btn small" title="move up" onClick={() => move(i, -1)}>↑</button>
            <button className="btn small" title="move down" onClick={() => move(i, 1)}>↓</button>
            <button className="btn small danger" data-testid={`adaptive-remove-${i}`}
              onClick={() => write(alts.filter((_, j) => j !== i))}>remove</button>
          </div>

          <div className="flabel">Show this alternative when</div>
          <ConditionEditor value={alt.when} onChange={(c) => setAt(i, { when: c })} />

          <label className="f" style={{ marginTop: 8 }}>
            <span>Replacement question text</span>
            <input className="input" data-testid={`adaptive-text-${i}`}
              placeholder="leave empty to keep the default stem"
              value={alt.text ?? ""}
              onChange={(e) => setAt(i, { text: e.target.value || undefined })} />
          </label>
          <label className="f">
            <span>Replacement instruction</span>
            <input className="input" data-testid={`adaptive-instruction-${i}`}
              value={alt.instruction ?? ""}
              onChange={(e) => setAt(i, { instruction: e.target.value || undefined })} />
          </label>
          <label className="f">
            <span>Replacement options — one per line, “code⇥label” or just labels</span>
            <textarea className="ta" style={{ minHeight: 70 }} data-testid={`adaptive-options-${i}`}
              placeholder={"1\tNot at all\n2\tSomewhat\n3\tVery"}
              value={printOptions(alt.options)}
              onChange={(e) => {
                const parsed = parseOptions(e.target.value);
                setAt(i, { options: parsed.length ? parsed : undefined });
              }} />
          </label>
          <div className="muted" style={{ fontSize: 11 }}>
            {alt.options?.length
              ? `${alt.options.length} options replace the list — masks, list logic and randomization still apply to them.`
              : "Empty = the question's own options."}
          </div>
        </div>
      ))}

      <button className="btn small" data-testid="adaptive-add"
        onClick={() => write([...alts, { when: newConditionGroup(), label: `Alternative ${alts.length + 1}` }])}>
        + add alternative
      </button>
    </>
  );
});
