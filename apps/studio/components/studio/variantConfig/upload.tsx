"use client";
import React from "react";
import { registerVariantSettings, type VariantSettingsProps } from "./registry";
import { CountInput } from "../CountInput";
import { UPLOAD_KINDS } from "@rescript/engine";

/**
 * Studio authoring for the file / media upload family — see
 * docs/VARIANT-BATCH.md §4.
 *
 * The three upload variants store the same thing, so they share one block:
 * what may be attached, how big, and how many. The count matters beyond the
 * respondent's screen — `maxFiles` decides whether the answer is one object
 * or a list, and therefore how many columns the export carries.
 */

/*
 * WHICH FILES, HOW MANY, HOW BIG (October 2026 review). "Instead of allowing
 * free-text entry in Accepted Files, provide a dropdown/multi-select list of
 * supported file types … Minimum Files … Maximum Files … Maximum File Size
 * per File … Optional Maximum Total Upload Size", all "actively enforced in
 * Preview and the respondent view" — the engine's `uploadAccept` is what the
 * respondent's picker and validation both apply. Photo / Camera Capture has no
 * Accepted Files at all: it takes JPG, JPEG and PNG, by definition.
 */
function UploadSettings({ q, patchSettings, kind }: VariantSettingsProps & { kind: "file" | "photo" | "signature" }) {
  const max = q.settings.maxFiles ?? 1;
  const picked = q.settings.acceptTypes ?? [];
  const custom = picked.filter((t) => t.startsWith("."));
  const toggle = (key: string, on: boolean) => {
    const next = on ? [...new Set([...picked, key])] : picked.filter((t) => t !== key);
    patchSettings({ acceptTypes: next.length ? next : undefined });
  };
  const [customText, setCustomText] = React.useState(custom.join(", "));
  return (
    <>
      {kind === "file" && (
        <div data-testid="upload-accept-types">
          <div className="flabel">Accepted file types <span className="muted">— none ticked accepts any file</span></div>
          <div className="row" style={{ flexWrap: "wrap", gap: "6px 14px", marginBottom: 6 }}>
            {UPLOAD_KINDS.map((k) => (
              <label key={k.key} className="row" style={{ gap: 4, fontSize: 13 }}>
                <input type="checkbox" data-testid={`upload-kind-${k.key}`} checked={picked.includes(k.key)}
                  onChange={(e) => toggle(k.key, e.target.checked)} />
                {k.label}
              </label>
            ))}
          </div>
          <label className="f" style={{ maxWidth: 360 }}><span>Other / custom extensions</span>
            <input className="input" data-testid="upload-custom-ext" placeholder=".dwg, .psd"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onBlur={() => {
                const exts = customText.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)
                  .map((x) => (x.startsWith(".") ? x : `.${x}`)).filter((x) => /^\.[a-z0-9]+$/.test(x));
                const next = [...picked.filter((t) => !t.startsWith(".")), ...exts];
                setCustomText(exts.join(", "));
                patchSettings({ acceptTypes: next.length ? next : undefined });
              }} /></label>
          {q.settings.accept && (
            <p className="chip warn" data-testid="upload-legacy-accept" style={{ display: "block", whiteSpace: "normal" }}>
              This question also has the older free-text setting “{q.settings.accept}”, which is enforced
              {picked.length ? " only while no type above is ticked" : ""}.{" "}
              <button type="button" className="btn small" data-testid="upload-legacy-clear"
                onClick={() => patchSettings({ accept: undefined })}>remove it</button>
            </p>
          )}
        </div>
      )}
      {kind === "photo" && (
        <div className="chip" data-testid="upload-photo-types">Accepts JPG, JPEG and PNG images only — anything else is refused with a message.</div>
      )}
      {kind !== "signature" && (
        <div className="row" style={{ flexWrap: "wrap" }}>
          {kind === "file" && (
            <label className="f"><span>Minimum files</span>
              <CountInput min={1} max={10} value={q.settings.minFiles ?? 1} data-testid="upload-minfiles"
                onChange={(v) => patchSettings({ minFiles: v == null || v <= 1 ? undefined : Math.min(v, max) })} /></label>
          )}
          {kind === "file" && (
            <label className="f"><span>Maximum files</span>
              <CountInput min={1} max={10} allowEmpty={false} value={max}
                data-testid="upload-maxfiles"
                onChange={(v) => patchSettings({ maxFiles: v ?? 1, ...(q.settings.minFiles && (v ?? 1) < q.settings.minFiles ? { minFiles: v ?? 1 } : {}) })} /></label>
          )}
          <label className="f"><span>Maximum size per file (MB)</span>
            <CountInput min={1} max={100} value={q.settings.maxSizeMb ?? 10} data-testid="upload-maxsize"
              onChange={(v) => patchSettings({ maxSizeMb: v ?? 10 })} /></label>
          {kind === "file" && max > 1 && (
            <label className="f"><span>Maximum total size (MB, optional)</span>
              <CountInput min={1} max={1000} value={q.settings.maxTotalMb} data-testid="upload-maxtotal"
                onChange={(v) => patchSettings({ maxTotalMb: v ?? undefined })} /></label>
          )}
        </div>
      )}
      <div className="chip" data-testid={`upload-note-${kind}`}>
        {kind === "signature"
          ? "The signature is saved as a PNG through the ordinary upload path — one file on the response."
          : max > 1
            ? `Stores a list of up to ${max} files: ${q.variableName}_1_URL … ${q.variableName}_${max}_URL in the export.`
            : `Stores one file: ${q.variableName}_URL, ${q.variableName}_NAME and ${q.variableName}_SIZE in the export.`}
      </div>
    </>
  );
}

// `upload.file` is the base type's own presentation and carries no renderer
// key, so the editor looks the block up under `base:upload`.
registerVariantSettings("base:upload", (p) => <UploadSettings {...p} kind="file" />);
registerVariantSettings("camera", (p) => <UploadSettings {...p} kind="photo" />);
registerVariantSettings("signature", (p) => <UploadSettings {...p} kind="signature" />);
