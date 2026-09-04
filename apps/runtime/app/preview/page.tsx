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
  /**
   * "Preview block": the Studio also sends `startAt` (a flow node id) and
   * `answers` (test values for the questions the block depends on). Both are
   * fixed for the life of the preview — the Runner is keyed on them so a new
   * block preview starts fresh while ordinary live edits keep the position.
   */
  const [entry, setEntry] = React.useState<{ startAt?: string; answers?: Record<string, unknown>; revision?: number | null } | null>(null);

  React.useEffect(() => {
    const tryLoad = (raw: unknown) => {
      const parsed = SurveyDefinition.safeParse(raw);
      if (parsed.success) { setDef(parsed.data); setError(null); }
      else setError(parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
    };
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "rescript:preview" && e.data.definition) {
        tryLoad(e.data.definition);
        if (e.data.startAt !== undefined || e.data.answers !== undefined) {
          setEntry({ startAt: e.data.startAt || undefined, answers: e.data.answers ?? undefined, revision: e.data.revision ?? null });
        }
      }
    };
    window.addEventListener("message", onMsg);
    // NOTE: an earlier build read a "rescript_preview_definition" key from
    // localStorage here. Nothing has ever written it, and a stale value would
    // have clobbered the definition the Studio had just pushed. Removed —
    // postMessage is the only channel.
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
  /**
   * A preview you cannot identify is a preview you cannot trust. The banner
   * names the definition on screen — version and when it was last saved — so
   * "am I looking at my change?" is answerable without guessing.
   */
  const saved = def.meta.updatedAt
    ? new Date(def.meta.updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : null;
  const blockTitle = entry?.startAt ? findNodeTitle(def.flow as any[], entry.startAt) : null;
  const seeded = entry?.answers ? Object.keys(entry.answers).filter((k) => entry.answers![k] !== undefined && entry.answers![k] !== "").length : 0;
  return (
    <>
      <div className="rs-preview-bar" data-testid="preview-bar">
        <strong>{entry?.startAt ? "Preview block" : "Preview"}</strong>
        {entry?.startAt && <span data-testid="preview-block">{blockTitle || entry.startAt}</span>}
        <span>{def.meta.code} · v{def.meta.version}{entry?.revision != null ? ` · rev ${entry.revision}` : ""}</span>
        <span>{saved ? `saved ${saved}` : "unsaved draft"}</span>
        {seeded > 0 && <span data-testid="preview-seeded">{seeded} test value{seeded === 1 ? "" : "s"}</span>}
        <span className="rs-preview-live">live — follows your edits</span>
      </div>
      {/* deliberately not keyed on the definition: the Studio pushes edits live
          and remounting on each one would restart the respondent every keystroke.
          It IS keyed on the entry point, so a new block preview starts over. */}
      <Runner
        key={`${entry?.startAt ?? ""}|${JSON.stringify(entry?.answers ?? null)}`}
        definition={def}
        mode="preview"
        startAt={entry?.startAt}
        seedAnswers={entry?.answers}
      />
    </>
  );
}

/** The title of a flow node by id, wherever it sits — for the preview bar. */
function findNodeTitle(nodes: any[], id: string): string | null {
  for (const n of nodes ?? []) {
    if (n?.id === id) return n.title ?? ""; // "" = found, untitled
    for (const kids of [n?.children, n?.otherwise, ...(n?.branches ?? []).map((b: any) => b.children)]) {
      if (!kids) continue;
      const t = findNodeTitle(kids, id);
      if (t !== null) return t;
    }
  }
  return null;
}
