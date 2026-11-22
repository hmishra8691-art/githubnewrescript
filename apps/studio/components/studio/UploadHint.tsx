import React from "react";

/**
 * WHAT AN UPLOAD ACCEPTS, SAID THE SAME WAY EVERYWHERE (upload audit, 2026-11-21): the file types, what the file
 * must contain, and where a correctly laid-out file comes from. One sentence each, beside the button — so nobody
 * has to try a file to learn whether it is the right one.
 */
export function UploadHint({ formats, needs, template, testid }: { formats: string; needs: string; template?: React.ReactNode; testid?: string }) {
  return (
    <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: "6px 0" }} data-testid={testid ?? "upload-hint"}>
      <div><strong>Accepts:</strong> {formats}</div>
      <div><strong>Needs:</strong> {needs}</div>
      {template && <div><strong>Template:</strong> {template}</div>}
    </div>
  );
}
