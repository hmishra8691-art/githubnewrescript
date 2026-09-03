"use client";
import React from "react";
import { registerVariantSettings, type VariantSettingsProps } from "./registry";
import { CountInput } from "../CountInput";

/**
 * Studio authoring for the image family — see docs/VARIANT-BATCH.md §4.
 *
 * One block serves both variants that use the `annotate` renderer (Image
 * Annotation / Markup and Draw-on-Image): the stimulus image, which tools the
 * respondent is offered, and the ink.
 */

const TOOLS: { key: "pin" | "pen" | "highlight"; label: string; hint: string }[] = [
  { key: "pin", label: "Pin + comment", hint: "click places a numbered pin with a comment box" },
  { key: "pen", label: "Freehand pen", hint: "drag draws a thin line" },
  { key: "highlight", label: "Highlighter", hint: "drag draws a wide translucent line" },
];

function AnnotateSettings({ q, patchSettings }: VariantSettingsProps) {
  const tools = q.settings.tools ?? ["pin", "pen"];
  const toggle = (key: "pin" | "pen" | "highlight") => {
    const next = tools.includes(key) ? tools.filter((t) => t !== key) : [...tools, key];
    // with no tool at all the respondent cannot answer; keep at least one
    patchSettings({ tools: next.length ? next : [key] });
  };
  return (
    <>
      <label className="f"><span>Stimulus image URL</span>
        <input className="input" value={q.settings.imageUrl ?? ""}
          placeholder="https://…/image.jpg"
          data-testid="annot-image-url"
          onChange={(e) => patchSettings({ imageUrl: e.target.value || undefined })} /></label>

      <div className="f">
        <span className="flabel">Tools offered</span>
        <div className="row" style={{ flexWrap: "wrap", gap: 14 }}>
          {TOOLS.map((t) => (
            <label key={t.key} title={t.hint} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={tools.includes(t.key)}
                data-testid={`annot-tool-${t.key}`}
                onChange={() => toggle(t.key)} />
              {t.label}
            </label>
          ))}
        </div>
      </div>

      <div className="row">
        <label className="f"><span>Ink colour</span>
          <input className="input" type="color" style={{ width: 70, padding: 2 }}
            value={q.settings.penColor ?? "#e11d48"}
            data-testid="annot-pen-color"
            onChange={(e) => patchSettings({ penColor: e.target.value })} /></label>
        <label className="f"><span>Ink width (px)</span>
          <CountInput min={1} max={20} value={q.settings.penWidth ?? 3}
            onChange={(v) => patchSettings({ penWidth: v ?? 3 })} /></label>
      </div>

      {q.settings.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={q.settings.imageUrl} alt="stimulus preview"
          style={{ maxWidth: 320, borderRadius: 8, border: "1px solid var(--border)" }} />
      )}
      {!q.settings.imageUrl && (
        <div className="chip warn" data-testid="annot-no-image">
          Without an image the respondent sees only a message — add the stimulus URL above.
        </div>
      )}
    </>
  );
}

registerVariantSettings("annotate", (p) => <AnnotateSettings {...p} />);
