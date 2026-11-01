"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { lintBeforeAfter, beforeAfterView } from "@rescript/engine";
import { MediaUrlInput } from "../MediaUrlInput";
import { registerVariantSettings } from "./registry";

/**
 * S5a (MM2-06): the Before / After Slider's editor — two image pickers (mediaItems[0] before, [1] after, each with
 * alt text), the two labels, where the divider starts, the rating after (or the position as the answer) and
 * whether the divider's position and dwell are recorded (BA_<CODE>_* paradata).
 */
type Item = NonNullable<Question["settings"]["mediaItems"]>[number];
type BA = NonNullable<Question["settings"]["beforeAfter"]>;

registerVariantSettings("beforeafter", ({ q, patchSettings }) => {
  const items: Item[] = [...(q.settings.mediaItems ?? [])];
  while (items.length < 2) items.push({ id: `ba_${items.length}`, url: "" });
  const ba: BA = q.settings.beforeAfter ?? {};
  const v = beforeAfterView(q);
  const setItem = (i: number, p: Partial<Item>) => {
    const next = items.map((m, j) => (j === i ? { ...m, ...p } : m));
    patchSettings({ mediaItems: next, mediaUrl: next[0]?.url || undefined });
  };
  const setBA = (p: Partial<BA>) => patchSettings({ beforeAfter: { ...ba, ...p } });
  const problems = lintBeforeAfter(q).map((m) => m.replace(/^[^:]+:\s*/, ""));
  return (
    <div className="card" style={{ padding: 10 }} data-testid="ba-editor">
      {(["Before", "After"] as const).map((side, i) => (
        <div key={side} style={{ marginBottom: 8 }}>
          <MediaUrlInput label={`${side} image`} testId={`ba-image-${i}`} questionId={q.id} value={items[i].url || undefined}
            accept={["image"]} onChange={(url) => setItem(i, { url: url ?? "" })} />
          <input className="input" style={{ marginTop: 4 }} data-testid={`ba-alt-${i}`} placeholder={`${side} image — alt text`}
            value={items[i].alt ?? ""} onChange={(e) => setItem(i, { alt: e.target.value || undefined })} />
        </div>
      ))}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 10px", alignItems: "center" }}>
        <span className="flabel">Before label</span>
        <input className="input" data-testid="ba-before-label" value={ba.beforeLabel ?? ""} placeholder="Before" onChange={(e) => setBA({ beforeLabel: e.target.value || undefined })} />
        <span className="flabel">After label</span>
        <input className="input" data-testid="ba-after-label" value={ba.afterLabel ?? ""} placeholder="After" onChange={(e) => setBA({ afterLabel: e.target.value || undefined })} />
        <span className="flabel">Divider starts at (%)</span>
        <input className="input" type="number" min={0} max={100} style={{ width: 90 }} data-testid="ba-start" value={ba.startPosition ?? 50}
          onChange={(e) => setBA({ startPosition: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
      </div>
      <label className="row" style={{ gap: 6, marginTop: 8 }}>
        <input type="checkbox" data-testid="ba-ask-rating" checked={v.askRating}
          onChange={(e) => patchSettings(e.target.checked
            ? { beforeAfter: { ...ba, askRating: true }, minValue: 1, maxValue: 5 }
            : { beforeAfter: { ...ba, askRating: false }, minValue: 0, maxValue: 100 })} />
        Ask a rating after (otherwise the final divider position 0–100 is the answer)
      </label>
      {v.askRating && (
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 10px", alignItems: "center", marginTop: 6 }}>
          <span className="flabel">Rating prompt</span>
          <input className="input" data-testid="ba-rating-prompt" value={ba.ratingPrompt ?? ""} placeholder="How would you rate the change?" onChange={(e) => setBA({ ratingPrompt: e.target.value || undefined })} />
          <span className="flabel">Scale</span>
          <span className="row" style={{ gap: 6 }}>
            <input className="input" type="number" style={{ width: 70 }} data-testid="ba-min" value={q.settings.minValue ?? 1} onChange={(e) => patchSettings({ minValue: Number(e.target.value) })} />
            to
            <input className="input" type="number" style={{ width: 70 }} data-testid="ba-max" value={q.settings.maxValue ?? 5} onChange={(e) => patchSettings({ maxValue: Number(e.target.value) })} />
          </span>
          <span className="flabel">End labels</span>
          <span className="row" style={{ gap: 6 }}>
            <input className="input" placeholder="low end" value={ba.minLabel ?? ""} onChange={(e) => setBA({ minLabel: e.target.value || undefined })} />
            <input className="input" placeholder="high end" value={ba.maxLabel ?? ""} onChange={(e) => setBA({ maxLabel: e.target.value || undefined })} />
          </span>
        </div>
      )}
      <label className="row" style={{ gap: 6, marginTop: 8 }}>
        <input type="checkbox" data-testid="ba-record" checked={!!q.settings.recordPosition} onChange={(e) => patchSettings({ recordPosition: e.target.checked || undefined })} />
        Record the divider position and the time on each side (BA_{q.code}_POSITION, _DWELL_BEFORE, _DWELL_AFTER)
      </label>
      {problems.length > 0 && <ul className="muted" data-testid="ba-problems" style={{ fontSize: 12.5, color: "var(--warn, #b45309)", margin: "6px 0 0 16px" }}>{problems.map((m) => <li key={m}>{m}</li>)}</ul>}
    </div>
  );
});
