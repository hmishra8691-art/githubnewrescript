"use client";
import React from "react";
import type { Option, Question } from "@rescript/schema";
import { registerVariantSettings } from "./registry";
import { MediaUrlInput } from "../MediaUrlInput";
import { addPair, removePair, optionLetter, nextOptionCode, unpairedOptions } from "@/lib/builder/pairwise";

/**
 * THE PAIRWISE CHOICE BUILDER — the review's own shape.
 *
 * "For the initial comparison, show only: Option A, Option B. Remove the
 * existing + Option button from the Pairwise Choice question. Instead, add a
 * + Field option after Option A and Option B. When + Field is selected, add
 * another complete pair: Option C, Option D. The user can continue adding
 * additional pairs: Option A vs Option B, Option C vs Option D, Option E vs
 * Option F …" (October 2026 review).
 *
 * The question is stored the way Pairwise Comparison Set always stored it —
 * the ROWS are the pairs, the OPTIONS are the choices, each pair names its two
 * in `meta.left` / `meta.right` and records the winner's code — so the
 * exporter, the analytics, the logic engine and the variable dictionary read
 * it unchanged. What changed is that the programmer no longer sees that
 * plumbing: a pair is two text fields, "+ Field" makes the next two, and there
 * is no free option list to put a third option in (the variant hides the
 * generic Options and Rows editors).
 *
 * A pair built under the older editor may share a choice with another pair.
 * That still works and is said, because editing the shared text edits both.
 */

registerVariantSettings("pairwiseset", ({ q, patch }) => {
  const byCode = new Map(q.options.map((o) => [String(o.code), o]));
  const uses = new Map<string, number>();
  for (const r of q.rows) for (const k of [r.meta?.left, r.meta?.right]) uses.set(String(k ?? ""), (uses.get(String(k ?? "")) ?? 0) + 1);

  const editOption = (code: string, change: Partial<Option>) =>
    patch({ options: q.options.map((o) => (String(o.code) === code ? { ...o, ...change } : o)) });
  const setMeta = (code: string, key: string, value: string) =>
    patch({ options: q.options.map((o) => (String(o.code) === code ? { ...o, meta: { ...(o.meta ?? {}), [key]: value || undefined } } : o)) });

  const side = (rowIndex: number, which: "left" | "right") => {
    const code = String(q.rows[rowIndex].meta?.[which] ?? "");
    const o = byCode.get(code);
    const letter = optionLetter(rowIndex * 2 + (which === "left" ? 0 : 1));
    const testid = `pair-${rowIndex}-${which === "left" ? "a" : "b"}`;
    if (!o) {
      return (
        <div className="card" style={{ padding: 8, flex: 1, minWidth: 220 }} data-testid={`${testid}-missing`}>
          <span className="chip warn">Option {letter} is missing</span>
          <button type="button" className="btn small" style={{ marginLeft: 6 }}
            onClick={() => {
              const c = nextOptionCode(q.options);
              patch({
                options: [...q.options, { code: c, label: `Option ${letter}`, flags: [] } as Option],
                rows: q.rows.map((r, j) => (j === rowIndex ? { ...r, meta: { ...(r.meta ?? {}), [which]: String(c) } } : r)),
              });
            }}>add it</button>
        </div>
      );
    }
    const shared = (uses.get(code) ?? 0) > 1;
    return (
      <div className="card" style={{ padding: 8, flex: 1, minWidth: 220 }} data-testid={testid}>
        <label className="f" style={{ marginBottom: 6 }}><span>Option {letter}</span>
          <input className="input" value={o.label} data-testid={`${testid}-label`}
            onChange={(e) => editOption(code, { label: e.target.value })} /></label>
        <MediaUrlInput compact accept={["image"]} testId={`${testid}-image`}
          placeholder="image (optional)"
          value={o.imageUrl}
          onChange={(url) => editOption(code, { imageUrl: url || undefined })} />
        <input className="input" style={{ marginTop: 6 }} placeholder="description (optional)"
          data-testid={`${testid}-desc`}
          value={String(o.meta?.description ?? "")}
          onChange={(e) => setMeta(code, "description", e.target.value)} />
        {shared && (
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }} data-testid={`${testid}-shared`}>
            Also used in another pair — editing it changes both.
          </p>
        )}
      </div>
    );
  };

  return (
    <div data-testid="pairwise-pairs">
      <h3 className="sec">Comparisons — exactly two options in each pair</h3>
      {q.rows.map((r, i) => (
        <div key={String(r.code)} className="card" style={{ padding: 10, marginBottom: 8 }} data-testid={`pair-${i}`}>
          <div className="row" style={{ alignItems: "center", marginBottom: 6 }}>
            <input className="input" style={{ maxWidth: 220 }} value={r.label} data-testid={`pair-label-${i}`}
              placeholder={`Pair ${i + 1}`} aria-label={`Name of pair ${i + 1}`}
              onChange={(e) => patch({ rows: q.rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <span className="spacer" />
            {q.rows.length > 1 && (
              <button type="button" className="btn small danger" data-testid={`pair-remove-${i}`}
                title="Remove this pair and the two options only it uses"
                onClick={() => patch(removePair(q, i))}>remove pair</button>
            )}
          </div>
          <div className="row" style={{ alignItems: "stretch", gap: 8, flexWrap: "wrap" }}>
            {side(i, "left")}
            <span style={{ alignSelf: "center", color: "var(--subtle)" }}>vs</span>
            {side(i, "right")}
          </div>
        </div>
      ))}
      {unpairedOptions(q).length > 0 && (
        <p className="chip warn" data-testid="pair-unpaired" style={{ display: "block", whiteSpace: "normal" }}>
          Not in any pair, so never shown: {unpairedOptions(q).map((o) => o.label.replace(/<[^>]*>/g, "") || String(o.code)).join(", ")}.{" "}
          <button type="button" className="btn small" data-testid="pair-unpaired-remove"
            onClick={() => { const drop = new Set(unpairedOptions(q).map((o) => String(o.code))); patch({ options: q.options.filter((o) => !drop.has(String(o.code))) }); }}>
            remove {unpairedOptions(q).length === 1 ? "it" : "them"}</button>
        </p>
      )}
      <button type="button" className="btn small" data-testid="pair-add"
        title="Add another complete pair — two more options compared with each other"
        onClick={() => patch(addPair(q))}>
        + Field <span className="muted">(adds Option {optionLetter(q.rows.length * 2)} vs Option {optionLetter(q.rows.length * 2 + 1)})</span>
      </button>
    </div>
  );
});
