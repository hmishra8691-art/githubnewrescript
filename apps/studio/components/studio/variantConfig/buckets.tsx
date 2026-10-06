"use client";
import React from "react";
import { registerVariantSettings, type VariantSettingsProps } from "./registry";
import { CountInput } from "../CountInput";
import { randomAxes, toggleRandomAxis } from "@/lib/builder/randomAxes";

/**
 * BUCKET RULES AND DISPLAY — Drag into Buckets and Image Categorization
 * (October 2026 review).
 *
 * The items (Rows / Images) and the buckets (Options) are edited in the
 * sections above, drawn in the order the review asked for — "Question →
 * Rows/Items → Buckets → Bucket Rules → Layout → Validation" (the variant's
 * `builder` policy). This is the "Bucket Rules" step, plus Image
 * Categorization's "Display Settings". The rules are the engine's
 * `bucketRules.ts`, which both the respondent's view and validation apply, so
 * what is set here is what happens.
 */
function BucketRules({ q, patch, patchSettings, images }: VariantSettingsProps & { images: boolean }) {
  const mode = q.settings.bucketMode ?? "multiple";
  const axes = randomAxes(q.randomization);
  const noun = images ? "images" : "items";
  return (
    <div data-testid="bucket-rules">
      <h3 className="sec">Bucket rules</h3>
      <div className="row" style={{ flexWrap: "wrap", gap: 14, alignItems: "flex-end" }}>
        <label className="f" style={{ width: 250 }}><span>Items per bucket</span>
          <select className="select" data-testid="bucket-mode" value={mode}
            onChange={(e) => patchSettings({ bucketMode: e.target.value === "one" ? "one" : undefined })}>
            <option value="multiple">allow multiple {noun} per bucket</option>
            <option value="one">allow one {images ? "image" : "item"} per bucket</option>
          </select></label>
        <label className="f" style={{ width: 280 }}><span>When a bucket is full</span>
          <select className="select" data-testid="bucket-full" value={q.settings.bucketFull ?? "prevent"}
            onChange={(e) => patchSettings({ bucketFull: e.target.value === "replace" ? "replace" : undefined })}>
            <option value="prevent">prevent the drop and say why</option>
            <option value="replace">replace — the earlier one goes back</option>
          </select></label>
        {mode === "multiple" && (
          <label className="f" style={{ width: 190 }}><span>Maximum per bucket</span>
            <CountInput min={1} width={90} data-testid="bucket-max" value={q.settings.bucketMax}
              onChange={(v) => patchSettings({ bucketMax: v ?? undefined })} /></label>
        )}
        {mode === "multiple" && (
          <label className="f" style={{ width: 190 }}><span>Minimum per bucket</span>
            <CountInput min={0} width={90} data-testid="bucket-min" value={q.settings.bucketMin}
              onChange={(v) => patchSettings({ bucketMin: v ? v : undefined })} /></label>
        )}
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 16, marginTop: 6 }}>
        <label className="row" style={{ gap: 6, fontSize: 13 }}>
          <input type="checkbox" data-testid="bucket-require-all" checked={!!q.required}
            onChange={(e) => patch({ required: e.target.checked })} />
          require every {images ? "image" : "item"} to be categorized
        </label>
        <label className="row" style={{ gap: 6, fontSize: 13 }}>
          <input type="checkbox" data-testid="bucket-allow-empty" checked={q.settings.allowEmptyBuckets !== false}
            onChange={(e) => patchSettings({ allowEmptyBuckets: e.target.checked ? undefined : false })} />
          allow empty buckets
        </label>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        A bucket's own capacity (in its row above) overrides the maximum for that bucket.
      </p>
      {images && (
        <>
          <h3 className="sec">Display settings</h3>
          <div className="row" style={{ flexWrap: "wrap", gap: 16 }} data-testid="bucket-display">
            <label className="row" style={{ gap: 6, fontSize: 13 }}>
              <input type="checkbox" data-testid="randomize-images" checked={axes.includes("rows")}
                onChange={(e) => patch({ randomization: toggleRandomAxis(q.randomization, "rows", e.target.checked) })} />
              randomize images
            </label>
            <label className="row" style={{ gap: 6, fontSize: 13 }}>
              <input type="checkbox" data-testid="randomize-buckets" checked={axes.includes("options")}
                onChange={(e) => patch({ randomization: toggleRandomAxis(q.randomization, "options", e.target.checked) })} />
              randomize buckets
            </label>
            <label className="row" style={{ gap: 6, fontSize: 13 }}>
              <input type="checkbox" data-testid="show-image-labels" checked={q.settings.showItemLabels !== false}
                onChange={(e) => patchSettings({ showItemLabels: e.target.checked ? undefined : false })} />
              show image labels
            </label>
          </div>
        </>
      )}
    </div>
  );
}

registerVariantSettings("dragbuckets", (p) => <BucketRules {...p} images={false} />);
registerVariantSettings("categorize", (p) => <BucketRules {...p} images />);
