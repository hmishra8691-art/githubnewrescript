"use client";
import React from "react";
import { registerVariantSettings, type VariantSettingsProps } from "./registry";
import { CountInput } from "../CountInput";

/**
 * Studio authoring for the file / media upload family — see
 * docs/VARIANT-BATCH.md §4.
 *
 * The three upload variants store the same thing, so they share one block:
 * what may be attached, how big, and how many. The count matters beyond the
 * respondent's screen — `maxFiles` decides whether the answer is one object
 * or a list, and therefore how many columns the export carries.
 */

function UploadSettings({ q, patchSettings, kind }: VariantSettingsProps & { kind: "file" | "photo" | "signature" }) {
  const max = q.settings.maxFiles ?? 1;
  return (
    <>
      {kind !== "signature" && (
        <div className="row">
          <label className="f"><span>Accepted files</span>
            <input className="input" value={q.settings.accept ?? ""}
              placeholder={kind === "photo" ? "image/*" : "e.g. .pdf,.docx,image/*"}
              data-testid="upload-accept"
              onChange={(e) => patchSettings({ accept: e.target.value || undefined })} /></label>
          <label className="f"><span>Maximum size (MB)</span>
            <CountInput min={1} max={100} value={q.settings.maxSizeMb ?? 10}
              onChange={(v) => patchSettings({ maxSizeMb: v ?? 10 })} /></label>
        </div>
      )}
      {kind === "file" && (
        <label className="f"><span>How many files</span>
          <CountInput min={1} max={10} allowEmpty={false} value={max}
            data-testid="upload-maxfiles"
            onChange={(v) => patchSettings({ maxFiles: v ?? 1 })} /></label>
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
