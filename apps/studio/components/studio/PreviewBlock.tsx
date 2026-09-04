"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { blockDependencies } from "@rescript/engine";
import { useStudio } from "./store";
import { openPreview, setPreviewRevision } from "./previewWindow";
import { runtimeBaseUrl } from "@/lib/runtime-url";

/**
 * "Preview block": the real runtime, entered at this block.
 *
 * Same Runner, same compiled flow, same logic / piping / masking / page breaks
 * / punching — only the entry point moves (engine `start({ startAt })`). What
 * a block cannot fake is the answers that come before it, so the dependencies
 * are computed (`blockDependencies`) and, when there are any, the tester is
 * offered test values for exactly those questions before the tab opens.
 *
 * The draft is flushed first so the preview stamps the revision it is
 * showing; the tab itself is opened synchronously in the click so popup
 * blockers stay out of it.
 */

const strip = (s: string) => s.replace(/<[^>]*>/g, "").trim();

export function usePreviewBlock() {
  const s = useStudio();
  const [dialog, setDialog] = React.useState<{ blockId: string; title: string; deps: Question[] } | null>(null);

  const launch = (blockId: string, answers?: Record<string, unknown>) => {
    if (!openPreview(runtimeBaseUrl(), s.def, { startAt: blockId, answers, revision: s.currentRevision() })) return;
    console.debug("[rescript:preview-block]", { blockId, seeded: Object.keys(answers ?? {}) });
    void s.flushDraft().then(() => setPreviewRevision(s.currentRevision()));
  };

  const previewBlock = (blockId: string, title: string) => {
    const deps = blockDependencies(s.def, blockId);
    if (deps.dependsOn.length === 0) { launch(blockId); return; }
    setDialog({ blockId, title, deps: deps.dependsOn });
  };

  const modal = dialog ? (
    <TestValuesDialog
      title={dialog.title}
      deps={dialog.deps}
      onClose={() => setDialog(null)}
      onPreview={(answers) => { setDialog(null); launch(dialog.blockId, answers); }}
    />
  ) : null;

  return { previewBlock, modal };
}

function TestValuesDialog({ title, deps, onClose, onPreview }: {
  title: string;
  deps: Question[];
  onClose(): void;
  onPreview(answers: Record<string, unknown> | undefined): void;
}) {
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const set = (id: string, v: unknown) => setValues((x) => ({ ...x, [id]: v }));

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)));

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" data-testid="preview-block-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontSize: 16 }}>Preview “{title}”</h2>
        <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
          This block depends on {deps.length} earlier question{deps.length === 1 ? "" : "s"} — its logic, piping,
          masking or auto punch reads them. Set test values so the block behaves as it would mid-survey,
          or preview with them unanswered.
        </p>
        <div style={{ display: "grid", gap: 10, margin: "12px 0" }}>
          {deps.map((q) => (
            <div key={q.id} className="card" style={{ padding: 10 }} data-testid="preview-dep">
              <div style={{ fontSize: 12, marginBottom: 6 }}>
                <span className="mono" style={{ fontWeight: 600 }}>{q.code}</span>
                <span className="muted"> · {strip(q.text).slice(0, 80) || q.variableName}</span>
              </div>
              <DepInput q={q} value={values[q.id]} onChange={(v) => set(q.id, v)} />
            </div>
          ))}
        </div>
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button className="btn small" data-testid="preview-block-skip" onClick={() => onPreview(undefined)}>Preview without test values</button>
          <button className="btn small primary" data-testid="preview-block-go" onClick={() => onPreview(filled)}>
            Preview with {Object.keys(filled).length} test value{Object.keys(filled).length === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}

const MULTI = new Set(["multi_select", "multi_dropdown", "checkbox", "ranking", "image_ranking", "image_multi", "max_diff"]);

function DepInput({ q, value, onChange }: { q: Question; value: unknown; onChange(v: unknown): void }) {
  if (q.options.length > 0 && q.rows.length === 0) {
    if (MULTI.has(q.type)) {
      const cur = Array.isArray(value) ? value.map(String) : [];
      return (
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }} data-testid="dep-multi">
          {q.options.map((o) => (
            <label key={String(o.code)} className="chip" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={cur.includes(String(o.code))}
                onChange={(e) => onChange(e.target.checked ? [...cur, o.code] : cur.filter((c) => c !== String(o.code)))} />
              {" "}{o.code}: {strip(o.label).slice(0, 28)}
            </label>
          ))}
        </div>
      );
    }
    return (
      <select className="select" data-testid="dep-single" value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}>
        <option value="">— unanswered —</option>
        {q.options.map((o) => <option key={String(o.code)} value={String(o.code)}>{o.code}: {strip(o.label).slice(0, 40)}</option>)}
      </select>
    );
  }
  if (q.type === "numeric" || q.type === "slider" || q.type === "numeric_list") {
    return <input className="input" type="number" data-testid="dep-number" value={value === undefined ? "" : String(value)}
      onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />;
  }
  return <input className="input" data-testid="dep-text" placeholder="test answer" value={value === undefined ? "" : String(value)}
    onChange={(e) => onChange(e.target.value || undefined)} />;
}
