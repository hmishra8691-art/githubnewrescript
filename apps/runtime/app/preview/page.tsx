"use client";
import React from "react";
import { SurveyDefinition } from "@rescript/schema";
import { Runner } from "@/components/Runner";

/**
 * In-memory preview: the Studio posts the survey definition into this page
 * (postMessage or localStorage handoff). Nothing is written to the database —
 * ideal for instant iteration while programming.
 */
export default function PreviewPage() {
  const [def, setDef] = React.useState<SurveyDefinition | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const tryLoad = (raw: unknown) => {
      const parsed = SurveyDefinition.safeParse(raw);
      if (parsed.success) { setDef(parsed.data); setError(null); }
      else setError(parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
    };
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "rescript:preview" && e.data.definition) tryLoad(e.data.definition);
    };
    window.addEventListener("message", onMsg);
    try {
      const stored = localStorage.getItem("rescript_preview_definition");
      if (stored) tryLoad(JSON.parse(stored));
    } catch { /* ignore */ }
    // announce readiness to opener
    window.opener?.postMessage({ type: "rescript:preview-ready" }, "*");
    window.parent?.postMessage({ type: "rescript:preview-ready" }, "*");
    return () => window.removeEventListener("message", onMsg);
  }, []);

  if (error) {
    return (
      <div className="rs-shell"><div className="rs-card">
        <h2>Definition failed validation</h2><pre style={{ whiteSpace: "pre-wrap" }}>{error}</pre>
      </div></div>
    );
  }
  if (!def) {
    return (
      <div className="rs-shell"><div className="rs-card rs-end">
        <h2>Waiting for survey definition…</h2>
        <p style={{ color: "var(--rs-subtle)" }}>Open this page from the Studio&apos;s Preview button.</p>
      </div></div>
    );
  }
  return <Runner key={def.meta.updatedAt ?? "def"} definition={def} mode="preview" />;
}
