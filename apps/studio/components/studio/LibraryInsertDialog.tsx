"use client";
import React from "react";
import { SurveyDefinition } from "@rescript/schema";
import { importQuestions, listPages, markupToText } from "@rescript/engine";
import { useStudio } from "./store";
import { VALIDATED_SCALES, scaleBlock, citationText } from "@rescript/templates";

/**
 * INSERT FROM ANOTHER SURVEY — the question / block library (2026-11-07).
 *
 * Any project you can open is a library: pick it, tick pages (or single questions), and they arrive here as a new
 * block — fresh ids, a code that collides renamed, the rules between them pointing at the copies, piping following
 * renamed codes. Rules that named a question you did not copy are removed and listed before you insert.
 */
interface ProjectRow { surveyId: string; code: string; title: string }

export function LibraryInsertDialog({ onClose, intoBlock }: { onClose(): void; /** 2026-11-14: the block the dialog was opened from — the copies arrive beside it, or in it while it is empty */ intoBlock?: string }) {
  const s = useStudio();
  const [projects, setProjects] = React.useState<ProjectRow[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [srcId, setSrcId] = React.useState("");
  const [src, setSrc] = React.useState<SurveyDefinition | null>(null);
  const [pages, setPages] = React.useState<Set<string>>(new Set());
  const [qs, setQs] = React.useState<Set<string>>(new Set());
  const [filter, setFilter] = React.useState("");
  /* P2-10: a published scale, with its items, options, citation and scoring, from the validated scale library */
  const [mode, setMode] = React.useState<"survey" | "scale">("survey");
  const [scaleId, setScaleId] = React.useState("");

  React.useEffect(() => {
    fetch("/api/projects").then((r) => r.json()).then((d: { owned?: unknown[]; shared?: unknown[]; workspace?: unknown[]; error?: string }) => {
      if (d.error) { setErr(d.error); return; }
      const rows = [...(d.owned ?? []), ...(d.workspace ?? []), ...(d.shared ?? [])] as { surveyId?: string; survey_id?: string; id?: string; code: string; title: string }[];
      setProjects(rows.map((r) => ({ surveyId: String(r.surveyId ?? r.survey_id ?? r.id), code: r.code, title: r.title })).filter((r) => r.surveyId !== s.surveyDbId));
    }).catch(() => setErr("Your projects could not be listed."));
  }, [s.surveyDbId]);

  React.useEffect(() => {
    if (!srcId) { setSrc(null); return; }
    setSrc(null); setErr(null); setPages(new Set()); setQs(new Set());
    (async () => {
      try {
        const d = await fetch(`/api/surveys/${srcId}/draft`).then((r) => r.json()) as { draft_definition?: unknown; error?: string };
        let raw = d.draft_definition;
        if (!raw) { const v = await fetch(`/api/surveys/${srcId}`).then((r) => r.json()) as { version?: { definition?: unknown } }; raw = v.version?.definition; }
        const parsed = raw ? SurveyDefinition.safeParse(raw) : null;
        if (!parsed?.success) { setErr("That project has no readable questionnaire yet."); return; }
        setSrc(parsed.data);
      } catch { setErr("That project could not be opened."); }
    })();
  }, [srcId]);

  /** the scale as a one-page survey, under a stem nobody here uses yet (PSS10, PSS10_2 …), with its score calculations */
  const scaleSrc = React.useMemo(() => {
    const scale = VALIDATED_SCALES.find((x) => x.id === scaleId);
    if (mode !== "scale" || !scale) return null;
    const used = new Set([...s.def.questions.flatMap((q) => [q.code.toUpperCase(), (q.variableName ?? "").toUpperCase()]), ...s.def.calculations.map((c) => c.targetVariable.toUpperCase())]);
    const base = scale.short.replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
    let stem = base; for (let k = 2; used.has(stem) || scale.scores.some((sc) => used.has(`${stem}_${sc.id}`)); k++) stem = `${base}_${k}`;
    const b = scaleBlock(scale, { prefix: stem, idPrefix: `q_${scale.id}_${Date.now().toString(36)}` });
    const def = SurveyDefinition.parse({ meta: { id: scale.id, code: scale.short, title: scale.name, version: "1", schemaVersion: 1, status: "draft" }, questions: [b.question], flow: [b.page, { type: "end", id: "e", status: "complete" }], calculations: b.calculations });
    return { scale, def, pageId: b.page.id, calculations: def.calculations, stem };
  }, [mode, scaleId, s.def]);
  const preview = React.useMemo(() => (mode === "scale"
    ? (scaleSrc ? importQuestions(s.def, scaleSrc.def, { pageIds: [scaleSrc.pageId], ...(intoBlock ? { intoBlock } : {}) }) : null)
    : (src && (pages.size || qs.size) ? importQuestions(s.def, src, { pageIds: [...pages], questionIds: [...qs], ...(intoBlock ? { intoBlock } : {}) }) : null)), [mode, scaleSrc, src, pages, qs, s.def, intoBlock]);
  const toggle = (set: Set<string>, id: string, put: (x: Set<string>) => void) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); put(n); };
  const f = filter.trim().toLowerCase();
  const strip = (t: string) => markupToText(t);

  const insert = () => {
    if (mode === "scale") {
      if (!preview || !scaleSrc) return;
      s.labelNextEdit(`insert the ${scaleSrc.scale.short}`);
      s.update((d) => { const next = preview.def; d.questions = next.questions; d.flow = next.flow; d.calculations = [...d.calculations, ...scaleSrc.calculations]; });
      s.toast(`Inserted the ${scaleSrc.scale.name} as ${scaleSrc.stem}, with ${scaleSrc.calculations.length === 1 ? "its score" : `its ${scaleSrc.calculations.length} scores`} (${scaleSrc.calculations.map((c) => c.targetVariable).join(", ")}).`);
      onClose();
      return;
    }
    if (!preview || !src) return;
    s.labelNextEdit(`insert ${preview.count} question${preview.count === 1 ? "" : "s"} from ${src.meta.code}`);
    s.update((d) => { const next = preview.def; d.questions = next.questions; d.flow = next.flow; });
    s.toast(`Inserted ${preview.count} question${preview.count === 1 ? "" : "s"} from ${src.meta.title || src.meta.code}${Object.keys(preview.renamed).length ? ` — renamed ${Object.entries(preview.renamed).map(([a, b]) => `${a}→${b}`).join(", ")}` : ""}.`);
    onClose();
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" style={{ width: 720, maxWidth: "calc(100vw - 32px)" }} onClick={(e) => e.stopPropagation()} data-testid="library-dialog" role="dialog" aria-label="Insert from a library">
        <h3 style={{ marginTop: 0 }}>Insert from a library</h3>
        <div className="row" style={{ gap: 6, marginBottom: 8 }} role="tablist">
          <button type="button" role="tab" aria-selected={mode === "survey"} className={`btn small ${mode === "survey" ? "primary" : ""}`} onClick={() => setMode("survey")} data-testid="library-mode-survey">Another survey</button>
          <button type="button" role="tab" aria-selected={mode === "scale"} className={`btn small ${mode === "scale" ? "primary" : ""}`} onClick={() => setMode("scale")} data-testid="library-mode-scale">Validated scale</button>
        </div>
        {mode === "scale" ? (
          <div data-testid="library-scales">
            <p className="muted" style={{ marginTop: 0 }}>Published measures with their exact items, options and scoring. The score is added as a calculation. Check the licence line before commercial use.</p>
            <div style={{ maxHeight: "46vh", overflow: "auto", border: "1px solid var(--c-border, #e5e7eb)", borderRadius: 8, padding: 8 }}>
              {VALIDATED_SCALES.map((sc) => (
                <label key={sc.id} className="row" style={{ gap: 8, alignItems: "flex-start", padding: "6px 0", borderBottom: "1px solid var(--c-border, #eef0f3)" }}>
                  <input type="radio" name="scale" checked={scaleId === sc.id} onChange={() => setScaleId(sc.id)} data-testid={`library-scale-${sc.id}`} style={{ marginTop: 4 }} />
                  <span>
                    <b>{sc.short}</b> — {sc.name} <span className="muted">· {sc.items.length} items · {sc.construct}</span>
                    <div className="muted" style={{ fontSize: 12 }}>{citationText(sc.citation)}</div>
                    <div style={{ fontSize: 12 }}>Licence: {sc.licence}</div>
                    {sc.caution && <div style={{ fontSize: 12, color: "var(--c-warning-fg)" }}>{sc.caution}</div>}
                    <div className="muted" style={{ fontSize: 12 }}>Scores: {sc.scores.map((x) => `${x.label}${x.bands ? " (with published bands)" : ""}`).join("; ")}</div>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : <>
        <p className="muted" style={{ marginTop: -6 }}>Any project you can open works as a library. Pick pages or single questions; they arrive {intoBlock ? "next to the block you opened this from (in it, while it is still empty)" : "as a new block"}, with fresh codes where needed.</p>
        {err && <div className="callout err" role="alert">{err}</div>}
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <select className="input" value={srcId} onChange={(e) => setSrcId(e.target.value)} data-testid="library-source" style={{ flex: 1 }}>
            <option value="">{projects ? "Choose a project…" : "Loading your projects…"}</option>
            {(projects ?? []).map((p) => <option key={p.surveyId} value={p.surveyId}>{p.code} — {p.title}</option>)}
          </select>
          {src && <input className="input" placeholder="filter questions…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 200 }} />}
        </div>
        {srcId && !src && !err && <div className="muted">Opening…</div>}
        {src && (
          <div style={{ maxHeight: "46vh", overflow: "auto", border: "1px solid var(--c-border, #e5e7eb)", borderRadius: 8, padding: 8 }} data-testid="library-pages">
            {listPages(src.flow as unknown[]).map((p, i) => {
              const node = p.node as { id: string; title?: string; questionIds: string[] };
              const items = node.questionIds.map((id) => src.questions.find((q) => q.id === id)).filter((q): q is NonNullable<typeof q> => !!q)
                .filter((q) => !f || q.code.toLowerCase().includes(f) || strip(q.text ?? "").toLowerCase().includes(f));
              if (!items.length) return null;
              return (
                <div key={node.id} style={{ marginBottom: 8 }}>
                  <label className="row" style={{ gap: 6, fontWeight: 600 }}>
                    <input type="checkbox" checked={pages.has(node.id)} onChange={() => toggle(pages, node.id, setPages)} data-testid="library-page" />
                    {node.title || `Page ${i + 1}`} <span className="muted" style={{ fontWeight: 400 }}>· {node.questionIds.length} question{node.questionIds.length === 1 ? "" : "s"}</span>
                  </label>
                  {items.map((q) => (
                    <label key={q.id} className="row" style={{ gap: 6, paddingLeft: 22, fontSize: 13 }}>
                      <input type="checkbox" disabled={pages.has(node.id)} checked={pages.has(node.id) || qs.has(q.id)} onChange={() => toggle(qs, q.id, setQs)} data-testid="library-question" />
                      <b>{q.code}</b> <span className="muted">{q.type.replace(/_/g, " ")}</span> {strip(q.text ?? "").slice(0, 90)}
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        )}
        </>}
        {preview && (
          <div style={{ marginTop: 10, fontSize: 13 }} data-testid="library-preview">
            <b>{preview.count}</b> question{preview.count === 1 ? "" : "s"} will be added {intoBlock ? "here — right after this block, or in it if it has no questions yet" : "as a new block"}.
            {Object.keys(preview.renamed).length > 0 && <div>Renamed (code already used here): {Object.entries(preview.renamed).map(([a, b]) => `${a} → ${b}`).join(", ")}</div>}
            {preview.dropped.length > 0 && <div className="callout warn" style={{ marginTop: 6 }}>Rules that named questions you did not copy will be removed: {preview.dropped.slice(0, 6).join("; ")}{preview.dropped.length > 6 ? ` and ${preview.dropped.length - 6} more` : ""}</div>}
          </div>
        )}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!preview?.count || s.readOnly} onClick={insert} data-testid="library-insert">{mode === "scale" && scaleSrc ? `Insert the ${scaleSrc.scale.short}` : `Insert${preview?.count ? ` ${preview.count}` : ""}`}</button>
        </div>
      </div>
    </div>
  );
}
