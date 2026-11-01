"use client";
import React from "react";
import { lintVideoRecording, videoRecordingConfig, VIDEO_RECORDING_MAX_SECONDS, VIDEO_RECORDING_MAX_MB } from "@rescript/engine";
import { registerVariantSettings } from "./registry";

/**
 * S5a (MM2-09): the Video Recording question's editor — duration limit, retakes, size cap, the consent text the
 * camera waits for, and the file-upload fallback. Storage: a respondent file (≤ 50 MB, WebM / MP4 / MOV, about
 * 7.5 MB per recorded minute).
 */
registerVariantSettings("videorecording", ({ q, patchSettings }) => {
  const cfg = videoRecordingConfig(q);
  const problems = lintVideoRecording(q).map((m) => m.replace(/^[^:]+:\s*/, ""));
  const num = (v: string, lo: number, hi: number) => (v.trim() === "" ? undefined : Math.max(lo, Math.min(hi, Math.round(Number(v)) || lo)));
  return (
    <div className="card" style={{ padding: 10 }} data-testid="vrec-editor">
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 10px", alignItems: "center" }}>
        <span className="flabel">Maximum length (seconds)</span>
        <input className="input" type="number" min={5} max={VIDEO_RECORDING_MAX_SECONDS} style={{ width: 100 }} data-testid="vrec-max-seconds"
          value={q.settings.maxAnswerSeconds ?? cfg.maxSeconds} onChange={(e) => patchSettings({ maxAnswerSeconds: num(e.target.value, 5, VIDEO_RECORDING_MAX_SECONDS) })} />
        <span className="flabel">Re-records allowed</span>
        <input className="input" type="number" min={0} max={20} style={{ width: 100 }} data-testid="vrec-retakes"
          value={q.settings.maxRetakes ?? ""} placeholder="unlimited" onChange={(e) => patchSettings({ maxRetakes: num(e.target.value, 0, 20) })} />
        <span className="flabel">Size limit (MB)</span>
        <input className="input" type="number" min={1} max={VIDEO_RECORDING_MAX_MB} style={{ width: 100 }} data-testid="vrec-max-mb"
          value={q.settings.maxSizeMb ?? cfg.maxSizeMb} onChange={(e) => patchSettings({ maxSizeMb: num(e.target.value, 1, VIDEO_RECORDING_MAX_MB) })} />
      </div>
      <label className="f" style={{ marginTop: 8 }}><span>Consent text (the camera stays off until the respondent ticks it)</span>
        <textarea className="input" rows={3} data-testid="vrec-consent-text" value={q.settings.consentText ?? ""}
          onChange={(e) => patchSettings({ consentText: e.target.value || undefined })} /></label>
      <label className="row" style={{ gap: 6, marginTop: 6 }}>
        <input type="checkbox" data-testid="vrec-allow-upload" checked={cfg.allowUpload} onChange={(e) => patchSettings({ allowFileUpload: e.target.checked ? undefined : false })} />
        Also offer “Upload a video file” (always offered when the device has no camera)
      </label>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
        Stored as a respondent file through the resumable upload (WebM / MP4 / MOV, checked on the server). About 7.5 MB per
        recorded minute — 1,000 one-minute answers ≈ 7.5 GB, kept like every respondent file.
      </div>
      {problems.length > 0 && <ul className="muted" data-testid="vrec-problems" style={{ fontSize: 12.5, color: "var(--warn, #b45309)", margin: "6px 0 0 16px" }}>{problems.map((m) => <li key={m}>{m}</li>)}</ul>}
    </div>
  );
});
