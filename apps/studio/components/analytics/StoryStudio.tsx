"use client";
import * as React from "react";
import {
  composeReport, renderFrame, sceneTiming, chartAllowed, chartWords, PRESETS, applyDesignPatch,
  type StoryReport, type Scene, type Measurer, type ComposedPage, type DesignConfig, type StoryChartType, type StoryOp, type PresetId, type BrandInput, type Composed,
} from "@rescript/analytics/story";
import { StoryShare } from "./StoryShare";
import { StoryApi, ApiError, reportMeasurer, type StoryPayload, type StoryListItem, type RevisionPreview, type DesignReading, type BrandReading, type RenderView } from "./storyApi";
import { DEFAULT_NUMBER_LOCALE } from "@/lib/number";

/**
 * ANIMATED RESEARCH REPORTS — Results → Reports → Create report.
 *
 * The list of story reports and the dialog that proposes one from the
 * analysis plan; the storyboard that edits it scene by scene (preview,
 * text, chart, layout, emphasis, motion, duration, order, sections,
 * regenerate, restore), with a design panel (presets drawn with the
 * report's own content, words → design, brand files → themes), revisions
 * in words (shown as operations before they are applied), versions
 * (compare, revert) and the exports (estimate, progress, cancel, the
 * checks, downloads). The preview is drawn by the same renderer and the
 * same fonts as the video and the deck, so the checks shown here are the
 * checks the exports pass.
 */

const STATUS_WORDS: Record<string, string> = { draft: "Draft", ready_for_review: "Ready for review", validation_required: "Validation required", ready_to_render: "Ready to render", rendering: "Rendering", completed: "Completed", failed: "Failed" };
const KIND_WORDS: Record<string, string> = { title: "Title", objective: "Objective", method: "Method", sample: "Sample", summary: "Summary", section: "Section", finding: "Finding", comparison: "Comparison", hypotheses: "Hypotheses", statistic: "Statistic", kpis: "KPIs", wave: "Since last wave", themes: "Themes", conclusions: "Conclusions", recommendations: "Recommendations", limitations: "Limitations", appendix_table: "Appendix table", closing: "Closing" };
const CHART_TYPES: StoryChartType[] = ["bar", "hbar", "grouped_bar", "stacked_100", "line", "donut"];
const ago = (iso: string) => { const s = (Date.now() - new Date(iso).getTime()) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString(); };
const fmtSec = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const errText = (e: unknown) => { const x = e as ApiError; const d = Array.isArray(x.details) ? (x.details as unknown[]).map((v) => (typeof v === "string" ? v : (v as { message?: string }).message ?? JSON.stringify(v))).slice(0, 6) : []; return [x.message, ...d].join(" · "); };

/* ================================================================ list + create */

export function StoryReports({ surveyId, onOpen }: { surveyId: string; onOpen?: (open: boolean) => void }) {
  const api = React.useMemo(() => new StoryApi(surveyId), [surveyId]);
  const [items, setItems] = React.useState<StoryListItem[] | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const refresh = React.useCallback(() => { api.list().then((r) => setItems(r.stories)).catch((e) => { setItems([]); setError(errText(e)); }); }, [api]);
  React.useEffect(() => { refresh(); }, [refresh]);
  React.useEffect(() => { onOpen?.(!!open); }, [open, onOpen]);
  if (open) return <StoryStudio api={api} id={open} onClose={() => { setOpen(null); refresh(); }} />;
  return (
    <div className="st-list" data-testid="st-reports">
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Research reports — PowerPoint and video</h3><span className="grow" />
        <button className="btn primary small" onClick={() => setCreating(true)} data-testid="st-create-open">Create report</button>
      </div>
      {error && <div className="ax-error">{error}</div>}
      {creating && <CreateStoryDialog api={api} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
      <div className="ax-cards">
        {items === null && <div className="muted">Loading…</div>}
        {items?.map((s) => (
          <div key={s.id} className="card selectable" onClick={() => setOpen(s.id)} data-testid="st-card">
            <div className="card-title">▶ {s.title}</div>
            <div className="muted" style={{ fontSize: 13 }}>{[s.outputs.pptx && "PowerPoint", s.outputs.video && "video"].filter(Boolean).join(" + ")} · {s.scenes} scenes · v{s.version} · <span className={`st-status st-status-${s.status}`}>{STATUS_WORDS[s.status] ?? s.status}</span> · {s.design} · {ago(s.updatedAt)}</div>
          </div>
        ))}
        {items?.length === 0 && <div className="muted">No research reports yet. Create one: the story is proposed from the applied analysis plan and its results, and you can edit every scene before exporting.</div>}
      </div>
    </div>
  );
}

function CreateStoryDialog({ api, onClose, onCreated }: { api: StoryApi; onClose: () => void; onCreated: (id: string) => void }) {
  const [output, setOutput] = React.useState<"both" | "pptx" | "video">("both");
  const [title, setTitle] = React.useState("");
  const [audience, setAudience] = React.useState<"executive" | "client" | "researcher">("client");
  const [preset, setPreset] = React.useState<PresetId>("corporate_executive");
  const [themeId, setThemeId] = React.useState("");
  const [environment, setEnvironment] = React.useState("LIVE");
  const [dataset, setDataset] = React.useState("all");
  const [maxFindings, setMaxFindings] = React.useState(5);
  const [themes, setThemes] = React.useState<{ id: string; name: string; scope: string }[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { api.themes().then((t) => setThemes(t.themes)).catch(() => setThemes([])); }, [api]);
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.create({ title: title.trim() || undefined, audience, preset, themeId: themeId || null, outputs: { pptx: output !== "video", video: output !== "pptx" }, environment, dataset, maxFindings });
      onCreated(r.story.id);
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card st-create" data-testid="st-create">
      <div className="row"><b>Create report</b><span className="grow" /><button className="btn small" onClick={onClose}>Cancel</button></div>
      <p className="muted" style={{ margin: "4px 0 10px" }}>The structure is proposed from the analysis plan and a fresh run of it: objective and hypotheses, method and sample, the findings and their tests, conclusions, recommendations, limitations and an appendix. Nothing is invented — every number comes from the run.</p>
      <div className="st-grid">
        <label>Output<div className="st-seg" role="radiogroup">{(["pptx", "video", "both"] as const).map((o) => <button key={o} className={`btn small ${output === o ? "primary" : ""}`} aria-pressed={output === o} onClick={() => setOutput(o)} data-testid={`st-output-${o}`}>{o === "pptx" ? "PowerPoint" : o === "video" ? "Animated video" : "Both"}</button>)}</div></label>
        <label>Title (optional)<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="From the research objective" data-testid="st-title" /></label>
        <label>Audience<select className="select" value={audience} onChange={(e) => setAudience(e.target.value as typeof audience)} data-testid="st-audience"><option value="executive">Executives — the headline and the decision</option><option value="client">Client — findings with their evidence</option><option value="researcher">Researchers — tests and statistics</option></select></label>
        <label>Theme<select className="select" value={themeId || preset} onChange={(e) => { const v = e.target.value; if (themes.some((t) => t.id === v)) setThemeId(v); else { setThemeId(""); setPreset(v as PresetId); } }} data-testid="st-theme">
          <optgroup label="Themes">{(Object.keys(PRESETS) as PresetId[]).map((p) => <option key={p} value={p}>{PRESETS[p].name}</option>)}</optgroup>
          {themes.length > 0 && <optgroup label="Saved themes">{themes.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.scope})</option>)}</optgroup>}
        </select></label>
        <label>Data<select className="select" value={`${environment}/${dataset}`} onChange={(e) => { const [a, b] = e.target.value.split("/"); setEnvironment(a); setDataset(b); }} data-testid="st-dataset"><option value="LIVE/all">Live — all completes</option><option value="LIVE/clean">Live — clean completes only</option><option value="TEST/all">Test data</option><option value="ALL/all">Live and test</option></select></label>
        <label>Key findings (at most)<input className="input" type="number" min={1} max={12} value={maxFindings} onChange={(e) => setMaxFindings(Math.max(1, Math.min(12, Number(e.target.value) || 5)))} /></label>
      </div>
      {error && <div className="ax-error" data-testid="st-create-error">{error}</div>}
      <div className="row" style={{ marginTop: 10 }}><span className="grow" /><button className="btn primary" disabled={busy} onClick={create} data-testid="st-create">{busy ? "Running the plan and proposing the story…" : "Create report"}</button></div>
    </div>
  );
}

/* ================================================================ frames */

function Frame({ page, t, final, width, measurer, total, testId }: { page: ComposedPage; t: number; final?: boolean; width: number; measurer: Measurer; total: number; testId?: string }) {
  const height = Math.round((width * page.canvas.h) / page.canvas.w);
  const svg = React.useMemo(() => renderFrame(page, t, { total, fadeIn: final ? 0 : 0.35, fadeOut: final ? 0 : 0.4, width, height, measure: measurer, ...(final ? { final: true } : {}) }), [page, t, final, width, height, measurer, total]);
  return <div className="st-frame" style={{ width, height }} data-testid={testId} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Player({ pages, timings, measurer, width, startAt, onScene }: { pages: ComposedPage[]; timings: { total: number }[]; measurer: Measurer; width: number; startAt: number; onScene?: (i: number) => void }) {
  const [i, setI] = React.useState(startAt);
  const [t, setT] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [all, setAll] = React.useState(false);
  const sceneCb = React.useRef(onScene); sceneCb.current = onScene;
  React.useEffect(() => { if (!all) { setI(startAt); setT(0); } }, [startAt, all]);
  React.useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      setT((x) => {
        const total = timings[i]?.total ?? 3;
        if (x + dt < total) return x + dt;
        if (all && i < pages.length - 1) { setI(i + 1); sceneCb.current?.(i + 1); return 0; }
        setPlaying(false); return total;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, all, i, pages.length, timings]);
  const page = pages[i];
  if (!page) return <div className="muted">This scene is only in the PowerPoint (appendix).</div>;
  const total = timings[i]?.total ?? 3;
  const elapsed = timings.slice(0, i).reduce((a, x) => a + x.total, 0) + t;
  const whole = timings.reduce((a, x) => a + x.total, 0);
  return (
    <div className="st-player" data-testid="st-player">
      <Frame page={page} t={playing || t > 0 ? t : 0} width={width} measurer={measurer} total={total} final={!playing && t === 0} testId="st-preview" />
      <div className="row st-controls">
        <button className="btn small" onClick={() => { if (t >= total) setT(0); setAll(false); setPlaying(!playing); }} data-testid="st-play">{playing && !all ? "Pause" : "Play scene"}</button>
        <button className="btn small" onClick={() => { if (all && playing) { setPlaying(false); return; } setI(0); setT(0); setAll(true); setPlaying(true); sceneCb.current?.(0); }} data-testid="st-play-all">{all && playing ? "Pause" : "Play full video"}</button>
        <input type="range" min={0} max={total} step={0.05} value={Math.min(t, total)} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} aria-label="Scrub this scene" className="grow" />
        <span className="muted st-time" data-testid="st-time">{all ? `${fmtSec(elapsed)} / ${fmtSec(whole)}` : `${t.toFixed(1)}s / ${total.toFixed(1)}s`}</span>
      </div>
    </div>
  );
}

/* ================================================================ the storyboard */

type Tab = "scene" | "revise" | "design" | "export" | "share" | "versions";

export function StoryStudio({ api, id, onClose }: { api: StoryApi; id: string; onClose: () => void }) {
  const [payload, setPayload] = React.useState<StoryPayload | null>(null);
  const [def, setDef] = React.useState<StoryReport | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [measurer, setMeasurer] = React.useState<Measurer | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [view, setView] = React.useState<"video" | "slide">("video");
  const [tab, setTab] = React.useState<Tab>("scene");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const accept = React.useCallback((p: StoryPayload) => { setPayload(p); setDef(p.definition as StoryReport); setDirty(false); setSelected((s) => s ?? (p.definition as StoryReport).scenes[0]?.id ?? null); }, []);
  const load = React.useCallback(async () => { try { accept(await api.get(id)); } catch (e) { setError(errText(e)); } }, [api, id, accept]);
  React.useEffect(() => { void load(); reportMeasurer().then(setMeasurer).catch((e) => setError(`The report fonts did not load: ${(e as Error).message}`)); }, [load]);

  const video = React.useMemo<Composed | null>(() => (def && measurer ? composeReport(def, measurer, "video") : null), [def, measurer]);
  const slides = React.useMemo<Composed | null>(() => (def && measurer ? composeReport(def, measurer, "pptx") : null), [def, measurer]);
  const timings = React.useMemo(() => (video && def ? video.pages.map((p) => sceneTiming(p, def.scenes[p.sceneIndex], def)) : []), [video, def]);

  if (!payload || !def) return <div className="ax-panel">{error ? <div className="ax-error">{error}</div> : "Loading the report…"}</div>;
  const scene = def.scenes.find((s) => s.id === selected) ?? def.scenes[0];
  const update = (sceneId: string, patch: Partial<Scene>, lockField?: string) => {
    setDef({ ...def, scenes: def.scenes.map((s) => (s.id === sceneId ? { ...s, ...patch, locked: lockField && !s.locked.includes(lockField) ? [...s.locked, lockField] : s.locked } : s)) });
    setDirty(true);
  };
  const move = (sceneId: string, dir: -1 | 1) => {
    const i = def.scenes.findIndex((s) => s.id === sceneId); const j = i + dir;
    if (j < 0 || j >= def.scenes.length || def.scenes[j].section !== def.scenes[i].section || def.scenes[j].kind === "title" || def.scenes[i].kind === "title") return;
    const next = [...def.scenes]; [next[i], next[j]] = [next[j], next[i]];
    setDef({ ...def, scenes: next.map((s) => (s.id === sceneId && !s.locked.includes("order") ? { ...s, locked: [...s.locked, "order"] } : s)) }); setDirty(true);
  };
  /* drag and drop: the dragged scene takes the target's place (same section; the title stays first) */
  const moveTo = (sceneId: string, targetId: string) => {
    const from = def.scenes.findIndex((s) => s.id === sceneId), to = def.scenes.findIndex((s) => s.id === targetId);
    if (from < 0 || to < 0 || def.scenes[from].section !== def.scenes[to].section || def.scenes[from].kind === "title" || def.scenes[to].kind === "title") return;
    const next = [...def.scenes]; const [x] = next.splice(from, 1); next.splice(to, 0, x);
    setDef({ ...def, scenes: next.map((s) => (s.id === sceneId && !s.locked.includes("order") ? { ...s, locked: [...s.locked, "order"] } : s)) }); setDirty(true);
  };
  const setSection = (sceneId: string, section: "main" | "appendix") => {
    const s = def.scenes.find((x) => x.id === sceneId)!; if (s.kind === "title") return;
    const rest = def.scenes.filter((x) => x.id !== sceneId);
    const moved = { ...s, section, locked: s.locked.includes("section") ? s.locked : [...s.locked, "section"] };
    const main = rest.filter((x) => x.section === "main"), app = rest.filter((x) => x.section === "appendix");
    setDef({ ...def, scenes: section === "main" ? [...main.slice(0, -1), moved, ...main.slice(-1), ...app] : [...main, moved, ...app] }); setDirty(true);
  };
  const removeScene = (sceneId: string) => { const s = def.scenes.find((x) => x.id === sceneId)!; if (s.kind === "title") return; if (!confirm(`Remove “${s.title}”? You can restore it from the version history.`)) return; setDef({ ...def, scenes: def.scenes.filter((x) => x.id !== sceneId) }); setDirty(true); setSelected(def.scenes[0].id); };
  const addScene = () => {
    const i = def.scenes.findIndex((s) => s.id === scene.id);
    const n: Scene = { id: `note_${Date.now().toString(36)}`, kind: "section", section: scene.section, kicker: "Note", title: "New section", visual: { type: "bullets", items: ["Write the point here."] }, layout: "text", emphasis: "standard", motion: { enter: "rise", chart: "none", transition: "inherit" }, duration: "auto", notes: { sources: [], footnotes: [], caveats: [] }, locked: ["title", "visual"] };
    const next = [...def.scenes]; next.splice(Math.max(1, i + 1), 0, n); setDef({ ...def, scenes: next }); setDirty(true); setSelected(n.id); setTab("scene");
  };
  const save = async (note?: string) => {
    setBusy(true); setError(null);
    try { const r = await api.save(id, def, payload.story.version, note); accept(r); setMsg(r.saved.version === payload.story.version ? "No changes to save." : `Saved as version ${r.saved.version}: ${r.saved.changes}.`); }
    catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const act = async (fn: () => Promise<StoryPayload>, ok: string) => { setBusy(true); setError(null); try { accept(await fn()); setMsg(ok); } catch (e) { setError(errText(e)); } finally { setBusy(false); } };

  const pagesFor = (target: Composed | null, sceneId: string) => target?.pages.filter((p) => p.sceneId === sceneId) ?? [];
  const issuesFor = (sceneId: string) => [...(video?.qa.critical ?? []), ...(slides?.qa.critical ?? [])].filter((x) => (x as { sceneId?: string }).sceneId === sceneId);
  const warningsFor = (sceneId: string) => [...(video?.qa.warnings ?? [])].filter((x) => (x as { sceneId?: string }).sceneId === sceneId);
  const criticalCount = (video?.qa.critical.length ?? 0) + (slides?.qa.critical.length ?? 0);
  const videoIndex = video ? Math.max(0, video.pages.findIndex((p) => p.sceneId === scene.id)) : 0;
  const totalSeconds = timings.reduce((a, x) => a + x.total, 0);

  return (
    <div className="ax-panel st-studio" data-testid="st-studio">
      <div className="st-bar">
        <button className="btn small" onClick={() => { if (!dirty || confirm("Leave without saving your changes?")) onClose(); }}>← Reports</button>
        <input className="input st-title-input" value={def.title} onChange={(e) => { setDef({ ...def, title: e.target.value, scenes: def.scenes.map((s) => (s.kind === "title" ? { ...s, title: e.target.value } : s)) }); setDirty(true); }} aria-label="Report title" data-testid="st-report-title" />
        <span className={`st-status st-status-${dirty ? "draft" : payload.status}`} data-testid="st-status">{dirty ? "Unsaved changes" : STATUS_WORDS[payload.status]}</span>
        <span className="muted">v{payload.story.version} · {def.scenes.filter((s) => s.section === "main").length} scenes · {fmtSec(totalSeconds)} video · {slides?.pages.length ?? "…"} slides</span>
        <span className="grow" />
        {!dirty && payload.status === "draft" && <button className="btn small" disabled={busy} onClick={() => act(() => api.setStatus(id, "ready_for_review"), "Marked ready for review.")} data-testid="st-mark-review">Ready for review</button>}
        {!dirty && (payload.status === "ready_for_review" || payload.status === "draft") && criticalCount === 0 && <button className="btn small" disabled={busy} onClick={() => act(() => api.setStatus(id, "ready_to_render"), "Approved for rendering.")} data-testid="st-mark-ready">Approve for rendering</button>}
        <button className="btn primary small" disabled={!dirty || busy} onClick={() => save()} data-testid="st-save">Save</button>
      </div>
      {msg && <div className="ax-note" data-testid="st-msg">{msg}</div>}
      {error && <div className="ax-error" data-testid="st-error">{error}</div>}
      {!measurer && <div className="muted">Loading the report fonts…</div>}
      {criticalCount > 0 && <div className="ax-error" data-testid="st-validation">{criticalCount} issue{criticalCount === 1 ? "" : "s"} must be fixed before export — {[...(video?.qa.critical ?? []), ...(slides?.qa.critical ?? [])].slice(0, 3).map((x) => x.message).join("; ")}</div>}

      <div className="st-body">
        {/* ---- timeline ---- */}
        <div className="st-timeline" data-testid="st-timeline">
          {(["main", "appendix"] as const).map((section) => (
            <div key={section}>
              <div className="st-section-label">{section === "main" ? "Main story" : "Appendix (PowerPoint only)"}</div>
              {def.scenes.filter((s) => s.section === section).map((s) => {
                const page = (section === "main" ? pagesFor(video, s.id) : pagesFor(slides, s.id))[0];
                const ti = video ? video.pages.findIndex((p) => p.sceneId === s.id) : -1;
                const bad = issuesFor(s.id).length;
                return (
                  <div key={s.id} className={`st-thumb ${s.id === scene.id ? "on" : ""}`} onClick={() => { setSelected(s.id); setTab("scene"); }} data-testid="st-thumb" data-scene={s.id}
                    /* #18: drag a scene onto another in the same section, or focus it and press Alt + ↑ / ↓ — the order of the story, its PowerPoint and its video */
                    tabIndex={0} role="button" aria-label={`Scene: ${s.title}. Alt + arrow keys move it.`} draggable={s.kind !== "title"}
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", s.id); } catch { /* fine */ } }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); const from = e.dataTransfer.getData("text/plain"); if (from && from !== s.id) moveTo(from, s.id); }}
                    onKeyDown={(e) => { if ((e.altKey || e.metaKey) && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); move(s.id, e.key === "ArrowUp" ? -1 : 1); const id = s.id; requestAnimationFrame(() => (document.querySelector(`[data-testid="st-thumb"][data-scene="${id}"]`) as HTMLElement | null)?.focus()); } else if (e.key === "Enter") { setSelected(s.id); setTab("scene"); } }}>
                    {page && measurer ? <Frame page={page} t={0} final width={150} measurer={measurer} total={3} /> : <div className="st-frame st-frame-empty" style={{ width: 150, height: 84 }} />}
                    <div className="st-thumb-meta"><b>{KIND_WORDS[s.kind] ?? s.kind}</b>{ti >= 0 && timings[ti] ? <span className="muted"> · {timings[ti].total.toFixed(1)}s</span> : null}{bad ? <span className="st-bad" title="Issues to fix"> · {bad} issue{bad === 1 ? "" : "s"}</span> : null}</div>
                    <div className="st-thumb-title">{s.title}</div>
                  </div>
                );
              })}
            </div>
          ))}
          <button className="btn small" onClick={addScene} data-testid="st-add-scene">+ Text scene</button>
        </div>

        {/* ---- preview ---- */}
        <div className="st-stage">
          <div className="row" style={{ marginBottom: 6 }}>
            <div className="st-seg">
              <button className={`btn small ${view === "video" ? "primary" : ""}`} onClick={() => setView("video")} data-testid="st-view-video">Video preview</button>
              <button className={`btn small ${view === "slide" ? "primary" : ""}`} onClick={() => setView("slide")} data-testid="st-view-slide">PowerPoint preview</button>
            </div>
            <span className="grow" />
            <span className="muted">{view === "video" ? `${def.design.video.aspect} · ${def.design.video.height}p · ${def.design.video.fps} fps${def.design.video.narration ? " · narration" : ""}${def.design.video.subtitles ? " · subtitles" : ""}` : "16:9 editable slides — final chart states, native charts and tables"}</span>
          </div>
          {measurer && video && view === "video" && <Player pages={video.pages} timings={timings} measurer={measurer} width={def.design.video.aspect === "9:16" ? 300 : def.design.video.aspect === "1:1" ? 440 : 640} startAt={videoIndex} onScene={(i) => setSelected(video.pages[i]?.sceneId ?? null)} />}
          {measurer && slides && view === "slide" && (pagesFor(slides, scene.id).length ? pagesFor(slides, scene.id).map((p, k) => <div key={k} className="st-slide"><Frame page={p} t={0} final width={640} measurer={measurer} total={1} testId="st-slide-preview" /><div className="muted">Slide {p.page}{p.repairs.length ? ` · repaired: ${p.repairs.join("; ")}` : ""}</div></div>) : <div className="muted">This scene is not in the PowerPoint.</div>)}
          {issuesFor(scene.id).length > 0 && <div className="ax-error" data-testid="st-scene-issues">{issuesFor(scene.id).map((x, k) => <div key={k}>{x.message}</div>)}</div>}
          {warningsFor(scene.id).length > 0 && <details className="muted"><summary>{warningsFor(scene.id).length} note{warningsFor(scene.id).length === 1 ? "" : "s"} from the checks</summary>{warningsFor(scene.id).map((x, k) => <div key={k}>{x.message}</div>)}</details>}
          {[...pagesFor(video, scene.id), ...pagesFor(slides, scene.id)].some((p) => p.repairs.length) && <div className="muted st-repairs">Automatic fixes: {[...new Set([...pagesFor(video, scene.id), ...pagesFor(slides, scene.id)].flatMap((p) => p.repairs))].join("; ")}.</div>}
        </div>

        {/* ---- side panel ---- */}
        <div className="st-side">
          <div className="st-tabs" role="tablist">
            {(["scene", "revise", "design", "export", "share", "versions"] as Tab[]).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={`btn small ${tab === t ? "primary" : ""}`} onClick={() => setTab(t)} data-testid={`st-tab-${t}`}>{t === "scene" ? "Scene" : t === "revise" ? "Revise" : t === "design" ? "Design" : t === "export" ? "Export" : t === "share" ? "Share" : "Versions"}</button>)}
          </div>
          {tab === "scene" && <SceneInspector scene={scene} def={def} update={update} move={move} setSection={setSection} remove={removeScene} timing={timings[videoIndex]} regenerate={() => act(() => api.regenerate(id, scene.id), "Scene regenerated from a fresh run. Your edits to it were kept.")} busy={busy || dirty} />}
          {tab === "revise" && <RevisePanel api={api} id={id} version={payload.story.version} selected={scene.id} dirty={dirty} onApplied={(p, words) => { accept(p); setMsg(words); }} />}
          {tab === "design" && measurer && <DesignPanel api={api} id={id} payload={payload} def={def} measurer={measurer} dirty={dirty} onApplied={(p, words) => { accept(p); setMsg(words); }} />}
          {tab === "export" && <ExportPanel api={api} id={id} payload={payload} dirty={dirty} criticalCount={criticalCount} onChange={load} />}
          {tab === "share" && <StoryShare api={api} id={id} payload={payload} dirty={dirty} onChange={load} />}
          {tab === "versions" && <VersionsPanel api={api} id={id} payload={payload} dirty={dirty} onReverted={(p, v) => { accept(p); setMsg(`Version ${v} restored as version ${p.story.version}.`); }} onRegenerate={() => act(() => api.regenerate(id), "Regenerated from a fresh run of the plan; your edits were kept.")} />}
        </div>
      </div>
    </div>
  );
}

/* ================================================================ scene inspector */

function SceneInspector({ scene, def, update, move, setSection, remove, timing, regenerate, busy }: { scene: Scene; def: StoryReport; update: (id: string, patch: Partial<Scene>, lock?: string) => void; move: (id: string, d: -1 | 1) => void; setSection: (id: string, s: "main" | "appendix") => void; remove: (id: string) => void; timing?: { total: number; minimum: number }; regenerate: () => void; busy: boolean }) {
  const v = scene.visual;
  const field = (k: "kicker" | "title" | "subtitle" | "body" | "voiceover", label: string, area = false) => (
    <label className="st-field">{label}{area
      ? <textarea className="input" rows={3} value={scene[k] ?? ""} onChange={(e) => update(scene.id, { [k]: e.target.value || (k === "title" ? "" : undefined) } as Partial<Scene>, k)} data-testid={`st-field-${k}`} />
      : <input className="input" value={scene[k] ?? ""} onChange={(e) => update(scene.id, { [k]: e.target.value || (k === "title" ? "" : undefined) } as Partial<Scene>, k)} data-testid={`st-field-${k}`} />}</label>
  );
  return (
    <div className="st-inspector" data-testid="st-inspector">
      <div className="row"><b>{KIND_WORDS[scene.kind]}</b>{scene.evidence && <span className="st-chip">{scene.evidence.replace("_", " ")}</span>}<span className="grow" />
        <button className="btn tiny" onClick={() => move(scene.id, -1)} title="Move earlier" data-testid="st-move-up">↑</button>
        <button className="btn tiny" onClick={() => move(scene.id, 1)} title="Move later" data-testid="st-move-down">↓</button>
      </div>
      {field("kicker", "Label")}
      {field("title", "Title")}
      {field("subtitle", "Subtitle")}
      {field("body", "Explanation", true)}
      {v.type === "bullets" && <label className="st-field">Points (one per line)<textarea className="input" rows={5} value={v.items.join("\n")} onChange={(e) => update(scene.id, { visual: { type: "bullets", items: e.target.value.split("\n") } }, "visual")} data-testid="st-field-bullets" /></label>}
      {v.type === "chart" && (
        <div className="st-field" data-testid="st-chart-choice">Chart
          <div className="st-chart-types">{CHART_TYPES.map((t) => { const ok = chartAllowed(t, v.data); return <button key={t} className={`btn tiny ${v.chart === t ? "primary" : ""}`} disabled={!ok.ok} title={ok.ok ? chartWords(t) : ok.why} onClick={() => update(scene.id, { visual: { ...v, chart: t } }, "chart")} data-testid={`st-chart-${t}`}>{chartWords(t)}</button>; })}</div>
          {v.recommendation && <div className="muted st-why">Recommended: {chartWords(v.recommendation.type)} — {v.recommendation.why}{v.chart !== v.recommendation.type ? " (overridden)" : ""}</div>}
          <div className="muted">Base n = {v.data.base ?? "—"} · {v.data.significanceTested ? "significance tested" : "descriptive — no test shown"} · the numbers come from the run and cannot be edited here.</div>
          {v.data.series.length === 1 && <label className="st-field">Highlight<select className="select" multiple value={v.highlight ?? []} onChange={(e) => update(scene.id, { visual: { ...v, highlight: [...e.target.selectedOptions].map((o) => o.value) } }, "highlight")} data-testid="st-highlight">{v.data.categories.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>}
        </div>
      )}
      {v.type === "table" && <div className="muted">Table: {v.table.title} — {v.table.rows.length} rows, base n = {v.table.base ?? "—"}.</div>}
      <div className="st-grid2">
        <label className="st-field">Layout<select className="select" value={scene.layout} onChange={(e) => update(scene.id, { layout: e.target.value as Scene["layout"] }, "layout")} data-testid="st-layout">
          {(v.type === "chart" || v.type === "table" ? ["visual_right", "visual_full", "table"] : v.type === "none" ? ["title", "text", "closing"] : [scene.layout, "text"]).filter((x, i, a) => a.indexOf(x) === i).map((l) => <option key={l} value={l}>{l.replace("_", " ")}</option>)}
        </select></label>
        <label className="st-field">Emphasis<select className="select" value={scene.emphasis} onChange={(e) => update(scene.id, { emphasis: e.target.value as Scene["emphasis"] }, "emphasis")} data-testid="st-emphasis"><option value="standard">Standard</option><option value="focus">Focus</option></select></label>
        <label className="st-field">Entrance<select className="select" value={scene.motion.enter} onChange={(e) => update(scene.id, { motion: { ...scene.motion, enter: e.target.value as Scene["motion"]["enter"] } }, "motion")} data-testid="st-enter"><option value="rise">Rise</option><option value="fade">Fade</option><option value="none">None</option></select></label>
        <label className="st-field">Chart motion<select className="select" value={scene.motion.chart} onChange={(e) => update(scene.id, { motion: { ...scene.motion, chart: e.target.value as Scene["motion"]["chart"] } }, "motion")} disabled={v.type !== "chart"}><option value="grow">Grow</option><option value="reveal">Reveal</option><option value="none">None</option></select></label>
        <label className="st-field">Transition<select className="select" value={scene.motion.transition} onChange={(e) => update(scene.id, { motion: { ...scene.motion, transition: e.target.value as Scene["motion"]["transition"] } }, "motion")}><option value="inherit">Theme default</option><option value="fade">Fade</option><option value="slide">Slide</option><option value="cut">Cut</option></select></label>
        <label className="st-field">Duration<div className="row"><select className="select" value={scene.duration === "auto" ? "auto" : "set"} onChange={(e) => update(scene.id, { duration: e.target.value === "auto" ? "auto" : Math.max(timing?.minimum ?? 4, 6) }, "duration")} data-testid="st-duration-mode"><option value="auto">Automatic</option><option value="set">Seconds</option></select>{scene.duration !== "auto" && <input className="input" type="number" min={1} max={120} step={0.5} value={scene.duration} onChange={(e) => update(scene.id, { duration: Number(e.target.value) || 1 }, "duration")} style={{ width: 70 }} data-testid="st-duration" />}</div>
          {timing && <span className="muted">{timing.total.toFixed(1)}s on screen; reading needs {timing.minimum.toFixed(1)}s{scene.duration !== "auto" && scene.duration < timing.minimum ? " — extended to that" : ""}.</span>}</label>
      </div>
      {def.design.video.narration && field("voiceover", "Narration (what the voice says)", true)}
      {(scene.notes.sources.length > 0 || scene.notes.caveats.length > 0) && <div className="muted st-notes">{scene.notes.sources.map((s) => `Source: ${s.name}`).join(" · ")}{scene.notes.caveats.length ? ` · ${scene.notes.caveats.join(" · ")}` : ""}</div>}
      <div className="row st-actions">
        <button className="btn small" onClick={() => setSection(scene.id, scene.section === "main" ? "appendix" : "main")} disabled={scene.kind === "title"} data-testid="st-section-toggle">{scene.section === "main" ? "Move to appendix" : "Move to main story"}</button>
        {scene.recommended && <button className="btn small" onClick={() => update(scene.id, { ...(structuredClone(scene.recommended) as Partial<Scene>), locked: [] })} data-testid="st-restore">Restore recommended</button>}
        {scene.notes.sources.length > 0 && <button className="btn small" onClick={regenerate} disabled={busy} title={busy ? "Save first" : "Run the plan again and redo this scene's content"} data-testid="st-regenerate-scene">Regenerate</button>}
        <button className="btn small danger" onClick={() => remove(scene.id)} disabled={scene.kind === "title"} data-testid="st-remove">Remove</button>
      </div>
    </div>
  );
}

/* ================================================================ revise in words */

function RevisePanel({ api, id, version, selected, dirty, onApplied }: { api: StoryApi; id: string; version: number; selected: string; dirty: boolean; onApplied: (p: StoryPayload, words: string) => void }) {
  const [text, setText] = React.useState("");
  const [preview, setPreview] = React.useState<RevisionPreview | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const ask = async () => { setBusy(true); setError(null); try { setPreview((await api.previewRevision(id, text, selected, version)).preview); } catch (e) { setError(errText(e)); } finally { setBusy(false); } };
  const apply = async () => { if (!preview) return; setBusy(true); setError(null); try { const r = await api.applyRevision(id, preview.ops as StoryOp[], text, version); setPreview(null); setText(""); onApplied(r, `Applied: ${r.result.changes.slice(0, 6).join("; ")}${r.result.refused.length ? ` — not applied: ${r.result.refused.join("; ")}` : ""}.`); } catch (e) { setError(errText(e)); } finally { setBusy(false); } };
  return (
    <div className="st-revise" data-testid="st-revise">
      <p className="muted">Say what to change. It is read into explicit changes to the report and shown before anything is applied — to both the video and the PowerPoint. “This chart” is the selected scene.</p>
      <textarea className="input" rows={4} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} placeholder="Shorten this to three minutes. Move the methodology to the appendix. Replace this chart with a horizontal bar chart. Less animation, more emphasis on the findings." data-testid="st-revise-text" />
      <div className="row"><span className="grow" /><button className="btn small" disabled={!text.trim() || busy || dirty} title={dirty ? "Save your edits first" : ""} onClick={ask} data-testid="st-revise-preview">Show the changes</button></div>
      {error && <div className="ax-error">{error}</div>}
      {preview && (
        <div className="card" data-testid="st-revise-result">
          {preview.ops.length > 0 && <><b>Will change</b><ul>{preview.ops.map((o, k) => <li key={k} data-testid="st-revise-op">{o.describe}</li>)}</ul></>}
          {preview.understood.length > 0 && <div className="muted">Understood: {preview.understood.join("; ")}</div>}
          {preview.refused.length > 0 && <div className="st-refused" data-testid="st-revise-refused"><b>Not done</b>{preview.refused.map((r, k) => <div key={k}>{r.request}: {r.why}{r.alternative ? ` — instead: ${r.alternative}` : ""}</div>)}</div>}
          {preview.unclear.length > 0 && <div className="muted">Not understood: “{preview.unclear.join("; ")}”. Try naming the scene or the change more directly.</div>}
          <div className="row"><span className="grow" /><button className="btn small" onClick={() => setPreview(null)}>Discard</button><button className="btn primary small" disabled={!preview.ops.length || busy} onClick={apply} data-testid="st-revise-apply">Apply these changes</button></div>
        </div>
      )}
    </div>
  );
}

/* ================================================================ design */

function DesignPanel({ api, id, payload, def, measurer, dirty, onApplied }: { api: StoryApi; id: string; payload: StoryPayload; def: StoryReport; measurer: Measurer; dirty: boolean; onApplied: (p: StoryPayload, words: string) => void }) {
  const [text, setText] = React.useState("");
  const [reading, setReading] = React.useState<DesignReading | null>(null);
  const [brand, setBrand] = React.useState<BrandReading | null>(null);
  const [draft, setDraft] = React.useState<DesignConfig>(def.design);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [themeName, setThemeName] = React.useState("");
  React.useEffect(() => setDraft(def.design), [def.design]);
  const brandInput: BrandInput | null = brand ? { colors: brand.brand.colors, fonts: brand.brand.fonts } : null;
  /* previews use the report's own scenes: the title and the first chart */
  const sample = React.useMemo(() => {
    const picks = [def.scenes.find((s) => s.kind === "title"), def.scenes.find((s) => s.section === "main" && s.visual.type === "chart")].filter(Boolean) as Scene[];
    return picks.length ? picks : def.scenes.slice(0, 1);
  }, [def.scenes]);
  const previewOf = (design: DesignConfig) => composeReport({ ...def, design: { ...design, video: { ...design.video, aspect: "16:9" } }, scenes: sample.map((s) => ({ ...s, section: "main" as const })) }, measurer, "video").pages;
  const apply = async (body: { patch?: unknown; design?: DesignConfig }, note: string) => {
    setBusy(true); setError(null);
    try { const r = await api.applyDesign(id, { ...(body as object), baseVersion: payload.story.version, note, brand: brandInput } as never); onApplied(r, `Design saved${r.adjustments.length ? ` — adjusted for readability: ${r.adjustments.map((a) => `${a.token} (${a.why})`).slice(0, 3).join("; ")}` : ""}.`); setReading(null); setText(""); }
    catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const interpret = async () => { setBusy(true); setError(null); try { setReading(await api.interpretDesign(id, text, brandInput)); } catch (e) { setError(errText(e)); } finally { setBusy(false); } };
  const upload = async (files: FileList | null) => { if (!files?.length) return; setBusy(true); setError(null); try { setBrand(await api.brand(id, [...files])); } catch (e) { setError(errText(e)); } finally { setBusy(false); } };
  const setColor = (k: keyof DesignConfig["colors"], v: string) => setDraft(applyDesignPatch(draft, { colors: { [k]: v } }).design);
  const presetCards = (Object.keys(PRESETS) as PresetId[]).filter((p) => p !== "custom_brand").map((p) => ({ id: p, name: PRESETS[p].name, design: { ...PRESETS[p], logo: def.design.logo, video: def.design.video } as DesignConfig }));
  return (
    <div className="st-design" data-testid="st-design">
      {dirty && <div className="ax-note">Save your scene edits before changing the design.</div>}
      <b>Themes</b>
      <div className="st-themes">
        {[...presetCards, ...(brand?.themes ?? []).map((t) => ({ id: `brand-${t.preset}`, name: t.name, design: t.design }))].map((t) => (
          <div key={t.id} className={`st-theme ${def.design.name === t.name ? "on" : ""}`} data-testid="st-theme-card">
            <div className="st-theme-frames">{previewOf(t.design).map((p, k) => <Frame key={k} page={p} t={0} final width={150} measurer={measurer} total={1} />)}</div>
            <div className="row"><span>{t.name}</span><span className="grow" /><button className="btn tiny" disabled={busy || dirty} onClick={() => apply({ design: t.design }, `Theme: ${t.name}`)} data-testid="st-theme-apply">Use</button></div>
          </div>
        ))}
      </div>
      <b>Describe the look</b>
      <textarea className="input" rows={3} value={text} onChange={(e) => { setText(e.target.value); setReading(null); }} placeholder="Use our blue and gold palette, larger chart labels, a dark background, a vertical video for social media, five minutes with narration." data-testid="st-design-text" />
      <div className="row"><span className="grow" /><button className="btn small" disabled={!text.trim() || busy || dirty} onClick={interpret} data-testid="st-design-interpret">Show the design</button></div>
      {reading && (
        <div className="card" data-testid="st-design-result">
          <div className="st-theme-frames">{previewOf(reading.preview).map((p, k) => <Frame key={k} page={p} t={0} final width={180} measurer={measurer} total={1} />)}</div>
          {reading.understood.length > 0 && <div>Understood: {reading.understood.join("; ")}</div>}
          {reading.unclear.length > 0 && <div className="muted">Not understood: “{reading.unclear.join("; ")}”</div>}
          {reading.adjustments.length > 0 && <div className="muted">Adjusted for readability: {reading.adjustments.map((a) => `${a.token} ${a.from} → ${a.to} (${a.why})`).join("; ")}</div>}
          <div className="row"><span className="grow" /><button className="btn small" onClick={() => setReading(null)}>Discard</button><button className="btn primary small" disabled={busy} onClick={() => apply({ patch: reading.patch }, `Design: “${text.slice(0, 120)}”`)} data-testid="st-design-apply">Apply</button></div>
        </div>
      )}
      <b>Brand files</b>
      <p className="muted">Logos (PNG, JPEG, SVG), a PowerPoint template, a PDF guideline or font files. They are read on our server and never sent to an AI service. Uploaded fonts are not drawn into the outputs (their licences vary) — the closest bundled open-licence face is used.</p>
      <input type="file" multiple accept=".png,.jpg,.jpeg,.svg,.webp,.gif,.pptx,.potx,.pdf,.ttf,.otf" onChange={(e) => upload(e.target.files)} disabled={busy || dirty} data-testid="st-brand-upload" />
      {brand && (
        <div className="card" data-testid="st-brand-result">
          {brand.analyses.map((a, k) => (
            <div key={k} className="st-brand-file">
              <b>{a.name}</b> <span className="muted">({a.kind})</span>
              {a.colors.length > 0 && <div className="st-swatches">{a.colors.map((c) => <span key={c.hex} className="st-swatch" style={{ background: c.hex }} title={c.hex} />)}</div>}
              {a.fonts.map((f) => <div key={f.name} className="muted">Font {f.name}: {f.note}</div>)}
              {a.notes.map((n, j) => <div key={j} className="muted">{n}</div>)}
              {a.problems.map((n, j) => <div key={j} className="ax-error">{n}</div>)}
            </div>
          ))}
          {brand.themes.length === 0 && <div className="muted">No colours or logo could be taken from these files.</div>}
          {brand.themes.length > 0 && <div className="muted">Six themes built from your brand are shown above, each checked for contrast.</div>}
        </div>
      )}
      <b>Details</b>
      <div className="st-grid2">
        {(["primary", "accent", "background", "text", "highlight"] as const).map((k) => <label key={k} className="st-field">{k}<input type="color" value={draft.colors[k]} onChange={(e) => setColor(k, e.target.value)} data-testid={`st-color-${k}`} /></label>)}
        <label className="st-field">Headings<select className="select" value={draft.typography.heading} onChange={(e) => setDraft({ ...draft, typography: { ...draft.typography, heading: e.target.value as never } })}>{["Inter", "Source Serif 4", "Montserrat"].map((f) => <option key={f}>{f}</option>)}</select></label>
        <label className="st-field">Body<select className="select" value={draft.typography.body} onChange={(e) => setDraft({ ...draft, typography: { ...draft.typography, body: e.target.value as never } })}>{["Inter", "Source Serif 4", "Montserrat"].map((f) => <option key={f}>{f}</option>)}</select></label>
        <label className="st-field">Density<select className="select" value={draft.density} onChange={(e) => setDraft({ ...draft, density: e.target.value as never })}><option value="airy">Airy</option><option value="balanced">Balanced</option><option value="dense">Dense</option></select></label>
        <label className="st-field">Titles<select className="select" value={draft.titleStyle} onChange={(e) => setDraft({ ...draft, titleStyle: e.target.value as never })}><option value="left_rule">Rule</option><option value="kicker">Label</option><option value="centered">Centred</option><option value="band">Band</option></select></label>
        <label className="st-field">Decoration<select className="select" value={draft.imagery} onChange={(e) => setDraft({ ...draft, imagery: e.target.value as never })}><option value="none">None</option><option value="logo_only">Logo only</option><option value="geometric">Geometric</option></select></label>
        <label className="st-field">Data labels<select className="select" value={`${draft.dataLabels.show}/${draft.dataLabels.decimals}`} onChange={(e) => { const [s, d] = e.target.value.split("/"); setDraft({ ...draft, dataLabels: { show: s === "true", decimals: Number(d) } }); }}><option value="true/0">Shown, whole numbers</option><option value="true/1">Shown, 1 decimal</option><option value="false/0">Hidden</option></select></label>
        <label className="st-field">Motion<select className="select" value={draft.motion.style} onChange={(e) => setDraft({ ...draft, motion: { ...draft.motion, style: e.target.value as never } })} data-testid="st-motion"><option value="none">None</option><option value="subtle">Subtle</option><option value="standard">Standard</option><option value="expressive">Expressive</option></select></label>
        <label className="st-field">Speed<input type="range" min={0.6} max={1.6} step={0.1} value={draft.motion.speed} onChange={(e) => setDraft({ ...draft, motion: { ...draft.motion, speed: Number(e.target.value) } })} /></label>
        <label className="st-field">Video shape<select className="select" value={draft.video.aspect} onChange={(e) => setDraft({ ...draft, video: { ...draft.video, aspect: e.target.value as never } })} data-testid="st-aspect"><option value="16:9">16:9 landscape</option><option value="9:16">9:16 vertical</option><option value="1:1">1:1 square</option></select></label>
        <label className="st-field">Resolution<select className="select" value={draft.video.height} onChange={(e) => setDraft({ ...draft, video: { ...draft.video, height: Number(e.target.value) as never } })}><option value={720}>720p (draft)</option><option value={1080}>1080p</option><option value={1440}>1440p</option><option value={2160}>4K</option></select></label>
        <label className="st-field">Frame rate<select className="select" value={draft.video.fps} onChange={(e) => setDraft({ ...draft, video: { ...draft.video, fps: Number(e.target.value) as never } })}><option value={24}>24</option><option value={25}>25</option><option value={30}>30</option></select></label>
        <label className="st-field">Target length (s)<input className="input" type="number" min={10} max={3600} placeholder="Automatic" value={draft.video.targetDurationSec ?? ""} onChange={(e) => { const n = Number(e.target.value); setDraft({ ...draft, video: { ...draft.video, targetDurationSec: e.target.value && n >= 10 ? n : undefined } }); }} /></label>
        <label className="st-field st-check"><input type="checkbox" checked={draft.video.narration} onChange={(e) => setDraft({ ...draft, video: { ...draft.video, narration: e.target.checked } })} /> Narration</label>
        <label className="st-field st-check"><input type="checkbox" checked={draft.video.subtitles} onChange={(e) => setDraft({ ...draft, video: { ...draft.video, subtitles: e.target.checked } })} /> Subtitles</label>
        <label className="st-field st-check"><input type="checkbox" checked={draft.footer.pageNumbers} onChange={(e) => setDraft({ ...draft, footer: { ...draft.footer, pageNumbers: e.target.checked } })} /> Page numbers</label>
        <label className="st-field">Footer<input className="input" value={draft.footer.text ?? ""} onChange={(e) => setDraft({ ...draft, footer: { ...draft.footer, text: e.target.value } })} /></label>
        {draft.logo && <label className="st-field">Logo<select className="select" value={draft.logo.placement} onChange={(e) => setDraft({ ...draft, logo: { ...draft.logo!, placement: e.target.value as never } })}><option value="top_right">Top right</option><option value="bottom_right">Bottom right</option><option value="bottom_left">Bottom left</option></select></label>}
      </div>
      <div className="row"><span className="grow" /><button className="btn small" onClick={() => setDraft(def.design)} disabled={JSON.stringify(draft) === JSON.stringify(def.design)}>Reset</button><button className="btn primary small" disabled={busy || dirty || JSON.stringify(draft) === JSON.stringify(def.design)} onClick={() => apply({ design: draft }, "Design details")} data-testid="st-design-save">Save design</button></div>
      <b>Save as a theme</b>
      <div className="row st-actions"><input className="input" placeholder="Theme name" value={themeName} onChange={(e) => setThemeName(e.target.value)} data-testid="st-theme-name" />
        <button className="btn small" disabled={!themeName.trim() || busy} onClick={async () => { try { await api.saveTheme({ name: themeName, design: def.design, scope: "project" }); setThemeName(""); onApplied(payload, `Saved “${themeName}” for this project.`); } catch (e) { setError(errText(e)); } }} data-testid="st-theme-save-project">For this project</button>
        <button className="btn small" disabled={!themeName.trim() || busy} onClick={async () => { try { await api.saveTheme({ name: themeName, design: def.design, scope: "workspace" }); setThemeName(""); onApplied(payload, `Saved “${themeName}” for your workspace.`); } catch (e) { setError(errText(e)); } }}>For the workspace</button></div>
      {error && <div className="ax-error">{error}</div>}
    </div>
  );
}

/* ================================================================ export */

function ExportPanel({ api, id, payload, dirty, criticalCount, onChange }: { api: StoryApi; id: string; payload: StoryPayload; dirty: boolean; criticalCount: number; onChange: () => void }) {
  const [renders, setRenders] = React.useState<RenderView[]>(payload.renders);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  React.useEffect(() => setRenders(payload.renders), [payload.renders]);
  const active = renders.filter((r) => ["queued", "rendering", "verifying"].includes(r.status));
  /* while a video is being made and this panel is open, advance it; the scheduler continues when it is closed */
  React.useEffect(() => {
    if (!active.length) return;
    let stop = false;
    const go = async () => {
      for (const r of active) {
        if (stop) return;
        try { const x = await api.step(id, r.id); setRenders((list) => list.map((y) => (y.id === x.render.id ? x.render : y))); if (!["queued", "rendering", "verifying"].includes(x.render.status)) onChange(); }
        catch (e) { setError(errText(e)); }
      }
    };
    const timer = setTimeout(go, 1200);
    return () => { stop = true; clearTimeout(timer); };
  }, [active, api, id, onChange]);
  const start = async (kind: "video" | "pptx") => {
    setBusy(kind); setError(null);
    try { const r = await api.startRender(id, kind); setRenders((list) => [r.render, ...list.filter((x) => x.id !== r.render.id)]); if (r.render.status === "completed") onChange(); }
    catch (e) { setError(errText(e)); } finally { setBusy(null); }
  };
  const download = async (r: RenderView, what: "file" | "subtitles" = "file") => { try { const d = await api.download(id, r.id, what); window.location.assign(d.url); } catch (e) { setError(errText(e)); } };
  const est = payload.estimate;
  const blocked = dirty ? "Save your changes first." : criticalCount ? `Fix the ${criticalCount} issue${criticalCount === 1 ? "" : "s"} first.` : null;
  return (
    <div className="st-export" data-testid="st-export">
      <div className="card">
        <b>Before you render</b>
        <div className="muted" data-testid="st-estimate">{payload.timing.width}×{payload.timing.height}, {fmtSec(est.seconds)} long, {est.scenes} scenes — {est.note}. About {Math.max(1, Math.round(est.renderSeconds / 60))} min to render, ~{est.storageMB} MB.{est.narrationCharacters ? ` Narration: ${est.narrationCharacters.toLocaleString(DEFAULT_NUMBER_LOCALE)} characters through the speech service.` : ""}</div>
        {payload.timing.pacingNote && <div className="ax-note">{payload.timing.pacingNote}</div>}
        <div className="row" style={{ marginTop: 8 }}>
          {payload.story.outputs.pptx && <button className="btn primary small" disabled={!!blocked || busy !== null} title={blocked ?? ""} onClick={() => start("pptx")} data-testid="st-export-pptx">{busy === "pptx" ? "Building and checking…" : "Export PowerPoint"}</button>}
          {payload.story.outputs.video && <button className="btn primary small" disabled={!!blocked || busy !== null || active.some((r) => r.kind === "video")} title={blocked ?? ""} onClick={() => start("video")} data-testid="st-export-video">{busy === "video" ? "Starting…" : "Render video"}</button>}
        </div>
        {blocked && <div className="muted">{blocked}</div>}
      </div>
      {error && <div className="ax-error">{error}</div>}
      {renders.map((r) => {
        const p = r.progress as { stage?: string; done?: number; total?: number; current?: { title: string } | null; reused?: number };
        const qa = r.qa as { video?: { ok: boolean; checks: { severity: string; message: string }[]; scenes: unknown[] }; pptx?: { ok: boolean; slides: number; charts: number; tables: number; valuesChecked: number; checks: { severity: string; message: string }[] }; layout?: { valuesVerified: number; repairs: unknown[] } } | null;
        return (
          <div key={r.id} className="card st-render" data-testid="st-render" data-status={r.status}>
            <div className="row"><b>{r.kind === "video" ? "Video" : "PowerPoint"} · v{r.version}</b><span className={`st-status st-status-${r.status}`}>{r.status}</span><span className="grow" /><span className="muted">{ago(r.createdAt)}</span></div>
            {["queued", "rendering", "verifying"].includes(r.status) && (
              <>
                <progress max={p.total ?? 1} value={p.done ?? 0} style={{ width: "100%" }} data-testid="st-progress" />
                <div className="muted">{p.stage === "verifying" ? "Checking the finished video frame by frame…" : p.stage === "narration" ? "Recording the narration…" : p.current ? `Rendering “${p.current.title}” (${(p.done ?? 0) + 1} of ${p.total})` : `${p.done ?? 0} of ${p.total ?? "?"} scenes`}{p.reused ? ` · ${p.reused} reused` : ""}</div>
                <button className="btn small" onClick={async () => { await api.cancel(id, r.id).catch((e) => setError(errText(e))); onChange(); }} data-testid="st-cancel">Cancel</button>
              </>
            )}
            {r.status === "completed" && (
              <>
                <div className="row"><button className="btn primary small" onClick={() => download(r)} data-testid="st-download">Download {r.kind === "video" ? "MP4" : "PPTX"}</button>{r.kind === "video" && (r.progress as { subtitles?: boolean }).subtitles && <button className="btn small" onClick={() => download(r, "subtitles")}>Subtitles (.srt)</button>}<span className="muted">{r.bytes ? `${(r.bytes / 1048576).toFixed(1)} MB` : ""}{r.expiresAt ? ` · kept until ${new Date(r.expiresAt).toLocaleDateString()}` : ""}</span></div>
                <div className="muted" data-testid="st-render-qa">Checked: {r.kind === "video" ? `${qa?.video?.scenes.length ?? 0} scenes matched to their definition frame by frame, the file decoded end to end` : `${qa?.pptx?.slides} slides, ${qa?.pptx?.charts} native charts (${qa?.pptx?.valuesChecked} values checked), ${qa?.pptx?.tables} native tables`}; {qa?.layout?.valuesVerified ?? 0} printed numbers matched to the results.</div>
              </>
            )}
            {r.status === "failed" && <div className="ax-error" data-testid="st-render-error">{r.error}</div>}
            {(r.providers as { kind: string; provider: string; status: string; detail?: string }[]).length > 0 && <details className="muted"><summary>How it was made</summary>{(r.providers as { kind: string; provider: string; model?: string; status: string; detail?: string }[]).map((x, k) => <div key={k}>{x.kind}: {x.provider}{x.model ? ` (${x.model})` : ""} — {x.status}{x.detail ? `: ${x.detail}` : ""}</div>)}</details>}
          </div>
        );
      })}
    </div>
  );
}

/* ================================================================ versions */

function VersionsPanel({ api, id, payload, dirty, onReverted, onRegenerate }: { api: StoryApi; id: string; payload: StoryPayload; dirty: boolean; onReverted: (p: StoryPayload, v: number) => void; onRegenerate: () => void }) {
  const [cmp, setCmp] = React.useState<{ a: number; summary: string; lines: string[] } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const versions = payload.versions as { version: number; note: string | null; created_at: string; changes: string[] }[];
  const renders = payload.renders;
  return (
    <div className="st-versions" data-testid="st-versions">
      <div className="row"><span className="muted">Results from run {String(payload.story.runId ?? "").slice(0, 8)} · {(payload.definition as StoryReport).createdFrom.n} completes</span><span className="grow" /><button className="btn small" disabled={dirty} onClick={onRegenerate} data-testid="st-regenerate">Regenerate from a new run</button></div>
      {error && <div className="ax-error">{error}</div>}
      {versions.map((v) => {
        const made = renders.filter((r) => r.version === v.version && r.status === "completed");
        return (
          <div key={v.version} className="card st-version" data-testid="st-version">
            <div className="row"><b>v{v.version}</b>{v.version === payload.story.version && <span className="st-chip">current</span>}<span className="muted">{ago(v.created_at)}</span><span className="grow" />
              {v.version !== payload.story.version && <button className="btn tiny" onClick={async () => { try { const r = await api.compare(id, v.version, payload.story.version); setCmp({ a: v.version, summary: r.summary, lines: [...r.diff.changed.map((c) => `${c.title}: ${c.fields.join(", ")}`), ...r.diff.added.map((x) => `added ${x}`), ...r.diff.removed.map((x) => `removed ${x}`), ...(r.diff.design.length ? [`design: ${r.diff.design.join(", ")}`] : [])] }); } catch (e) { setError(errText(e)); } }} data-testid="st-compare">Compare with current</button>}
              {v.version !== payload.story.version && <button className="btn tiny" disabled={dirty} onClick={async () => { if (!confirm(`Restore version ${v.version}? It becomes a new version; nothing is lost.`)) return; try { onReverted(await api.revert(id, v.version), v.version); } catch (e) { setError(errText(e)); } }} data-testid="st-revert">Restore</button>}
            </div>
            <div className="muted">{v.note}</div>
            {made.length > 0 && <div className="muted">Exported: {made.map((r) => (r.kind === "video" ? "video" : "PowerPoint")).join(", ")}</div>}
            {cmp?.a === v.version && <div className="st-diff" data-testid="st-diff"><b>v{v.version} → v{payload.story.version}: {cmp.summary}</b>{cmp.lines.slice(0, 20).map((l, k) => <div key={k}>{l}</div>)}</div>}
          </div>
        );
      })}
    </div>
  );
}
