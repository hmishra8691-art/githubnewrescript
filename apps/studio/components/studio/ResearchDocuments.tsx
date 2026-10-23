"use client";
import React from "react";
import { EXPORT_PRESETS } from "@rescript/exporters";
import { REPORT_THEMES, DEFAULT_REPORT_THEME, enforceTheme, type ThemeSpec, type ThemeReading, type StructureRequest, type DocumentFamily } from "@rescript/analytics";
import { useStudio } from "./store";
import { editionOf, mimeOf, type ArtifactType } from "../../lib/artifacts/core";
import { fetchArtifactLines, fetchArtifactLink, sandboxFingerprint, saveBytes, saveUrl, sessionStore, type ArtifactLineView } from "../../lib/artifacts/client";
import { sandboxLines, sandboxPut, sandboxTheme, setSandboxTheme, fromBase64 } from "../../lib/artifacts/sandboxStore";
import { LiveThemePreview, SectionOrderEditor, orderedCatalog } from "./ReportLayout";
import { themeTurn, applyThemeTurn, saveThemeTurn, type ThemeCard } from "../../lib/copilot/reportThemeTurn";
import { ThemeSwatches } from "../intelligent/copilot/DocumentCards";

/**
 * THE DOCUMENTS PANEL (audit DOC-11) — the six documents a research project
 * hands over, one button each, so none of them is reachable only by typing a
 * sentence to the copilot:
 *
 *   Research plan (.docx)              the full plan: hypotheses and rationale, traceability, variables, tests, charts, QC, limitations (2026-10-17)
 *   Research proposal (.docx)          the design, the sample, the screening, the timeline, the ethics
 *   Statistical analysis plan (.docx)  what is tested, how, at what α, on whom
 *   Data-cleaning plan (.docx)         the quality rules in force for this survey
 *   Questionnaire (.docx)              the programming specification, from the draft on screen
 *   Findings report (.docx)            from a run of the plan on the survey's completes
 *   Findings deck (.pptx)              the same, as slides
 *
 * KEPT, NOT REMADE (2026-10-18): the plan, proposal, SAP, findings report and
 * deck are kept once made (a saved project: `artifacts` + Storage; the
 * sandbox: this tab only). A kept document's button downloads the stored file
 * — nothing is generated — and says its version; when what it is made from has
 * changed (the design, the data, the report theme) the line says "a new
 * version is available" and offers to make it; Regenerate makes a new version
 * on purpose. Earlier versions stay downloadable.
 *
 * THE REPORT THEME (2026-10-18): the look of these documents and decks, picked
 * from the built-in and saved themes or described in words, previewed, then
 * applied — the documents' content never changes with it.
 */
type DocKey = "research_plan_docx" | "proposal_docx" | "sap_docx" | "cleaning_plan_docx" | "questionnaire_docx" | "findings_docx" | "findings_pptx";
type Audience = "executive" | "client" | "researcher";
const KEPT: ReadonlySet<DocKey> = new Set(["research_plan_docx", "proposal_docx", "sap_docx", "findings_docx", "findings_pptx"]);
interface Kept { id: string; version: number; name: string; state: "current" | "stale"; createdAt: string; versions: { id: string; version: number; createdAt: string; name: string }[] }

export function ResearchDocuments() {
  const s = useStudio();
  const id = s.surveyDbId;
  const sandbox = !id || id === "sandbox";
  const [completes, setCompletes] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState<DocKey | null>(null);
  const [audience, setAudience] = React.useState<Audience>("client");
  const [kept, setKept] = React.useState<Record<string, Kept>>({});
  const [themeName, setThemeName] = React.useState<string | null>(null);

  /* how many completes there are, to know whether a findings document has anything to report on */
  React.useEffect(() => {
    if (sandbox) { setCompletes(0); return; }
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/surveys/${id}/overview`, { cache: "no-store" });
        const j = await res.json().catch(() => null) as { counts?: { complete?: number | null } } | null;
        if (live) setCompletes(res.ok && typeof j?.counts?.complete === "number" ? j.counts.complete : 0);
      } catch { if (live) setCompletes(0); }
    })();
    return () => { live = false; };
  }, [id, sandbox]);

  /* the kept documents: what each button would download, and whether a new version is available */
  const refreshKept = React.useCallback(async () => {
    const out: Record<string, Kept> = {};
    if (sandbox) {
      const st = sandboxTheme(sessionStore());
      setThemeName(st.theme?.name ?? null);
      for (const l of sandboxLines(sessionStore())) {
        const now = sandboxFingerprint({ type: l.type, audience: l.edition, def: s.def, theme: st.theme, structure: st.structure });
        out[`${l.type}:${l.edition}`] = { id: l.latest.id, version: l.latest.version, name: l.latest.name, createdAt: l.latest.createdAt, state: now === l.latest.fingerprint ? "current" : "stale", versions: l.versions.map((v) => ({ id: v.id, version: v.version, createdAt: v.createdAt, name: v.name })) };
      }
    } else {
      const got = await fetchArtifactLines(id);
      if (!got.ok) return;
      setThemeName(got.theme?.name ?? null);
      for (const l of got.lines as ArtifactLineView[]) out[`${l.type}:${l.edition}`] = { id: l.latest.id, version: l.latest.version, name: l.latest.name, createdAt: l.latest.createdAt, state: l.state, versions: l.versions.map((v) => ({ id: v.id, version: v.version, createdAt: v.createdAt, name: v.name })) };
    }
    setKept(out);
  }, [id, sandbox, s.def]);
  React.useEffect(() => { void refreshKept(); }, [refreshKept]);

  const keyOf = (key: DocKey) => `${key}:${editionOf(key as ArtifactType, audience)}`;

  /** a kept version: the tab's copy (sandbox) or a fresh, access-checked signed link — never a regeneration */
  const downloadKept = async (versionId: string, name: string): Promise<boolean> => {
    if (sandbox) {
      const a = sandboxLines(sessionStore()).flatMap((l) => l.versions).find((v) => v.id === versionId);
      if (!a) { s.toast("This tab no longer holds that version — make the document again.", "err"); return false; }
      saveBytes(fromBase64(a.base64), a.name, a.mime);
      s.toast(`Downloaded ${a.name} (version ${a.version}, kept — not regenerated)`);
      return true;
    }
    const link = await fetchArtifactLink(id, versionId);
    if (!link.ok) { s.toast(link.error, "err"); return false; }
    saveUrl(link.link.url, link.link.name);
    s.toast(`Downloaded ${name} (version ${link.link.version}, kept — not regenerated)`);
    return true;
  };

  const download = async (key: DocKey, how: { regenerate?: boolean } = {}) => {
    if (busy) return;
    setBusy(key);
    try {
      const k = kept[keyOf(key)];
      if (KEPT.has(key) && k && k.state === "current" && !how.regenerate) { await downloadKept(k.id, k.name); return; }
      let res: Response;
      const json = { "content-type": "application/json" };
      const st = sandbox ? sandboxTheme(sessionStore()) : null;
      if (key === "cleaning_plan_docx") res = await fetch(`/api/surveys/${id}/quality/plan`, { cache: "no-store" });
      else if (key === "questionnaire_docx") res = await fetch(`/api/surveys/${id || "sandbox"}/export/survey`, { method: "POST", headers: json, body: JSON.stringify({ definition: s.def, fields: EXPORT_PRESETS.spec, format: "docx", version: s.def.meta.version }) });
      else {
        const type = key;
        res = await fetch("/api/copilot/output", { method: "POST", headers: json, body: JSON.stringify({ surveyId: id || "sandbox", output: { type, audience, ...(how.regenerate && k?.state === "current" ? { regenerate: true } : {}) }, source: "research_tab", ...(sandbox ? { definition: s.def, ...(st?.theme ? { theme: st.theme } : {}), ...(st?.structure ? { structure: st.structure } : {}) } : {}) }) });
      }
      if (!res.ok) {
        const j = await res.json().catch(() => null) as { error?: string } | null;
        s.toast(j?.error ?? (res.status === 401 ? "Sign in to produce documents for this survey." : res.status === 403 ? "You do not have access to this document." : `The document could not be produced (HTTP ${res.status}).`), "err");
        return;
      }
      const blob = await res.blob();
      /* never save a file that is not one (2026-10-17): an empty body or an error page saved as .docx is what "the Word file will not open" was */
      const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
      if (blob.size < 100 || head[0] !== 0x50 || head[1] !== 0x4b) { s.toast(`The document could not be produced: the server sent ${blob.size ? "something that is not a document" : "an empty file"}.`, "err"); return; }
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `${key.replace(/_/g, ".")}`;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      /* the sandbox keeps it in this tab (sandbox only) */
      if (sandbox && KEPT.has(key)) {
        const t = key as ArtifactType;
        sandboxPut(sessionStore(), { type: t, edition: editionOf(t, audience), fingerprint: sandboxFingerprint({ type: t, audience, def: s.def, theme: st?.theme, structure: st?.structure }), name, mime: blob.type || mimeOf(t), summary: res.headers.get("x-rescript-output"), regenerate: !!how.regenerate }, bytes);
      }
      saveBytes(bytes, name, blob.type || "application/octet-stream");
      const said = res.headers.get("x-rescript-output");
      const v = res.headers.get("x-rescript-artifact-version");
      const reused = res.headers.get("x-rescript-artifact-reused") === "1";
      s.toast(said ? `${name}${v ? ` (version ${v}${reused ? ", kept — not regenerated" : ""})` : ""}: ${said}` : `Downloaded ${name}`);
      if (KEPT.has(key)) void refreshKept();
    } catch (e) {
      s.toast(`The document could not be produced: ${(e as Error).message || "the network request failed"}.`, "err");
    } finally { setBusy(null); }
  };

  const noData = completes === null ? "Checking for completes…" : completes === 0 ? "There are no completes to report on yet — this document is made from a run of the analysis plan on the survey's data." : "";
  const noDb = "Open a saved project to produce this document — it is made from stored survey data.";
  const docs: { key: DocKey; label: string; hint: string; disabled: string }[] = [
    { key: "research_plan_docx", label: "Research plan (.docx)", hint: "Executive summary, objectives, hypotheses and rationale, how each question serves them, variables and scales, hypothesis tests, proposed tables and charts, interpretation framework, QC, limitations", disabled: "" },
    { key: "proposal_docx", label: "Research proposal (.docx)", hint: "Objective, hypotheses, questionnaire, sampling design, screening, timeline, analysis plan, ethics", disabled: "" },
    { key: "sap_docx", label: "Statistical analysis plan (.docx)", hint: "Variables, populations, the test for each analysis and why, α and corrections, weighting, missing data, sample size", disabled: "" },
    { key: "cleaning_plan_docx", label: "Data-cleaning plan (.docx)", hint: "The quality rules in force for this survey, their thresholds and what each does to the dataset", disabled: sandbox ? noDb : "" },
    { key: "questionnaire_docx", label: "Questionnaire (.docx)", hint: "The programming specification of the survey as it is open in the editor", disabled: "" },
    { key: "findings_docx", label: "Findings report (.docx)", hint: "Executive summary, verdicts on each hypothesis, key findings, caveats", disabled: sandbox ? noDb : noData },
    { key: "findings_pptx", label: "Findings deck (.pptx)", hint: "The findings as slides, edition for the audience chosen", disabled: sandbox ? noDb : noData },
  ];

  return (
    <div data-testid="research-documents">
      <h4 className="rd-h">Documents <span className="muted">· download what the project hands over{themeName ? ` · ${themeName} theme` : ""}</span></h4>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {docs.map((d) => {
          const k = KEPT.has(d.key) ? kept[keyOf(d.key)] : undefined;
          return (
            <span key={d.key} className="row" style={{ gap: 4, alignItems: "center" }} data-testid={`doc-line-${d.key}`} data-version={k?.version ?? ""} data-state={k?.state ?? "none"}>
              <button type="button" className="btn small" data-testid={`doc-${d.key}`} disabled={!!d.disabled || !!busy} aria-busy={busy === d.key}
                title={d.disabled || (k ? `${k.state === "current" ? "Download the kept file — nothing is regenerated" : "A new version is available"} · ${d.hint}` : d.hint)} onClick={() => void download(d.key)}>
                {busy === d.key ? "Preparing…" : k ? `${d.label} · v${k.version}` : d.label}
              </button>
              {k && k.state === "stale" && !d.disabled && <span className="badge warning" data-testid={`doc-stale-${d.key}`} title="The design, the data or the report theme changed since this version was made">New version available</span>}
              {k && !d.disabled && <button type="button" className="btn small ghost" data-testid={`doc-regenerate-${d.key}`} disabled={!!busy} title={k.state === "stale" ? "Make the new version" : "Make a new version anyway (the kept versions stay downloadable)"} onClick={() => void download(d.key, { regenerate: true })}>{k.state === "stale" ? "Make new version" : "Regenerate"}</button>}
              {k && k.versions.length > 1 && (
                <select className="select" style={{ width: 92 }} data-testid={`doc-versions-${d.key}`} value="" aria-label="Earlier versions" onChange={(e) => { const v = k.versions.find((x) => x.id === e.target.value); if (v) void downloadKept(v.id, v.name); }}>
                  <option value="">Earlier…</option>
                  {k.versions.slice(1).map((v) => <option key={v.id} value={v.id}>v{v.version} · {v.createdAt.slice(0, 10)}</option>)}
                </select>
              )}
            </span>
          );
        })}
        <label className="row" style={{ gap: 6, alignItems: "center" }} title="Who the findings report and deck are written for">
          <span className="muted" style={{ fontSize: 12.5 }}>Findings for</span>
          <select className="select" style={{ width: 130 }} data-testid="doc-audience" value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
            <option value="client">the client</option>
            <option value="executive">executives</option>
            <option value="researcher">researchers</option>
          </select>
        </label>
      </div>
      <ReportThemePanel surveyId={id || "sandbox"} def={s.def} onChanged={() => void refreshKept()} toast={s.toast} />
    </div>
  );
}

/**
 * THE REPORT THEME, IN THE RESEARCH TAB: pick a built-in or saved theme, or
 * describe one in words; the preview shows the colours by role, the fonts and a
 * table as the documents will draw them; Apply makes it the project's (the next
 * version of each document uses it), Save as keeps it under a name.
 */
function ReportThemePanel({ surveyId, def, onChanged, toast }: { surveyId: string; def: unknown; onChanged: () => void; toast: (m: string, kind?: "err") => void }) {
  const [text, setText] = React.useState("");
  const [card, setCard] = React.useState<ThemeCard | null>(null);
  const [name, setName] = React.useState("");
  const [scope, setScope] = React.useState<"user" | "org">("user");
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState<ThemeSpec[]>([]);
  /* #18: the project's applied selection (theme + section orders), the theme being edited live, the family whose order is shown */
  const [applied, setApplied] = React.useState<{ theme: ThemeSpec | null; structure: StructureRequest | null }>({ theme: null, structure: null });
  const [draft, setDraft] = React.useState<ThemeSpec | null>(null);
  const [edited, setEdited] = React.useState(false);
  const [family, setFamily] = React.useState<DocumentFamily>("findings");
  const ctx = React.useMemo(() => ({ surveyId, def, store: sessionStore() }), [surveyId, def]);
  const loadSaved = React.useCallback(async () => {
    if (surveyId === "sandbox") { const st = sandboxTheme(sessionStore()); setSaved(st.saved); setApplied({ theme: st.theme, structure: st.structure }); return; }
    const r = await fetch(`/api/surveys/${surveyId}/report-themes`, { cache: "no-store" }).then((x) => (x.ok ? x.json() : null)).catch(() => null) as { saved?: ThemeSpec[]; applied?: { theme: ThemeSpec | null; structure: StructureRequest | null } | null } | null;
    setSaved(r?.saved ?? []);
    setApplied({ theme: r?.applied?.theme ?? null, structure: r?.applied?.structure ?? null });
  }, [surveyId]);
  /* the order of a family's sections, saved where the project keeps its report selection */
  const saveStructure = async (structure: StructureRequest) => {
    setBusy(true);
    try {
      if (surveyId === "sandbox") { setSandboxTheme(sessionStore(), { structure }); setApplied((a) => ({ ...a, structure })); toast("Section order saved: the next version of these documents uses it."); }
      else {
        const r = await fetch(`/api/surveys/${surveyId}/report-themes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "apply", structure }) });
        const d = await r.json().catch(() => null) as { applied?: { structure: StructureRequest | null }; error?: string } | null;
        if (!r.ok) toast(d?.error ?? `The order could not be saved (HTTP ${r.status}).`, "err");
        else { setApplied((a) => ({ ...a, structure: d?.applied?.structure ?? structure })); toast("Section order saved: the next version of these documents uses it."); }
      }
    } finally { setBusy(false); onChanged(); }
  };
  /* switching theme: the live preview redraws at once (no request); the reading for Apply follows */
  const pick = (name: string) => {
    const t = [...saved, ...REPORT_THEMES].find((x) => x.name === name);
    if (t) { setDraft(structuredClone(t)); setEdited(false); }
    void preview(`Apply the ${name} theme`);
  };
  const applyEdits = async () => {
    if (!draft) return;
    const { theme, adjustments } = enforceTheme(draft);
    const reading = { intent: "modify", patch: {}, preview: { ...theme, name: draft.name || "Custom theme" }, adjustments, understood: ["edited in the live preview"], unclear: [], needsModel: false, proposedName: draft.name || "Custom theme" } as unknown as ThemeReading;
    setBusy(true);
    const r = await applyThemeTurn({ op: "describe", status: "preview", reading, canApply: true }, ctx);
    setCard(r.card); toast(r.said, r.card.status === "applied" ? undefined : "err");
    setBusy(false); setEdited(false); onChanged(); void loadSaved();
  };
  React.useEffect(() => { void loadSaved(); }, [loadSaved]);
  const preview = async (words: string) => {
    if (!words.trim()) return;
    setBusy(true);
    const t = await themeTurn(words, { op: "describe", text: words }, ctx);
    setCard(t.card); setName(t.card.reading?.saveAs ?? t.card.reading?.proposedName ?? t.card.reading?.preview?.name ?? "");
    if (t.card.reading?.preview) { setDraft(structuredClone(t.card.reading.preview)); setEdited(false); }
    if (t.card.status !== "preview") toast(t.said, t.card.status === "failed" ? "err" : undefined);
    setBusy(false);
  };
  const apply = async () => {
    if (!card) return;
    setBusy(true);
    const r = await applyThemeTurn(card, ctx);
    setCard(r.card); toast(r.said, r.card.status === "applied" ? undefined : "err");
    setBusy(false); onChanged();
  };
  const save = async () => {
    if (!card) return;
    setBusy(true);
    const r = await saveThemeTurn(card, name, scope, ctx);
    setCard(r.card); toast(r.said, r.card.status === "saved" ? undefined : "err");
    setBusy(false); onChanged(); void loadSaved();
  };
  const r = card?.reading;
  return (
    <div className="rd-theme" data-testid="report-theme" style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12.5 }}>Report theme</span>
        <select className="select" style={{ width: 200 }} data-testid="report-theme-pick" value="" aria-label="Pick a theme" onChange={(e) => { if (e.target.value) pick(e.target.value); }}>
          <option value="">Pick a theme…</option>
          <optgroup label="Built-in">{REPORT_THEMES.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}</optgroup>
          {saved.length > 0 && <optgroup label="Saved">{saved.map((t) => <option key={t.id} value={t.name}>{t.name}{t.version ? ` (v${t.version})` : ""}</option>)}</optgroup>}
        </select>
        <input className="input" style={{ minWidth: 280, flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void preview(text); }}
          placeholder="…or describe it: navy headings, subtle cyan accents, white backgrounds, striped tables" data-testid="report-theme-text" aria-label="Describe a report theme" />
        <button type="button" className="btn small" disabled={busy || !text.trim()} onClick={() => void preview(text)} data-testid="report-theme-preview">Preview</button>
      </div>
      {/* the reading's swatches (what Apply will apply), kept beside the live page */}
      {r?.preview && <ThemeSwatches theme={r.preview} />}
      {/* #18: the live preview — switching or editing redraws it at once; nothing is generated */}
      <LiveThemePreview theme={draft ?? applied.theme ?? DEFAULT_REPORT_THEME} onChange={(t) => { setDraft(t); setEdited(true); }}
        sections={orderedCatalog(family, applied.structure?.sections?.[family]).map((x) => x.title)} />
      {edited && draft && (
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn small primary" disabled={busy} onClick={() => void applyEdits()} data-testid="theme-live-apply">Apply these edits to the project</button>
          <button type="button" className="btn small" onClick={() => { setDraft(r?.preview ? structuredClone(r.preview) : null); setEdited(false); }} data-testid="theme-live-discard">Discard edits</button>
        </div>
      )}
      <SectionOrderEditor structure={applied.structure} onSave={saveStructure} busy={busy} family={family} setFamily={setFamily} />
      {r?.structure && <p className="muted" style={{ fontSize: 12.5 }} data-testid="report-theme-structure">Section order for the findings report: {r.structure.order.join(" → ")} — content unchanged.</p>}
      {r && r.understood.length > 0 && <p className="muted" style={{ fontSize: 12.5 }} data-testid="report-theme-understood">Understood: {r.understood.join(" · ")}</p>}
      {r && r.adjustments.length > 0 && <p className="muted" style={{ fontSize: 12.5 }}>Adjusted for legibility: {r.adjustments.map((a) => `${a.token} → ${a.to}`).join(" · ")}</p>}
      {r && (r.intent === "unknown_name" || r.intent === "none") && <p className="muted" style={{ fontSize: 12.5 }} data-testid="report-theme-question">{r.question ?? "No look could be read — name colours by role, fonts, tables or a theme."}</p>}
      {card && r && (r.preview || r.structure) && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {card.status === "preview" && <button type="button" className="btn small primary" disabled={busy || card.canApply === false} onClick={() => void apply()} data-testid="report-theme-apply">{r.intent === "structure" ? "Apply this order" : "Apply to this project"}</button>}
          {card.status === "applied" && <span className="badge success" data-testid="report-theme-applied">Applied{card.appliedName ? `: ${card.appliedName}` : ""}</span>}
          {card.status === "saved" && card.savedAs && <span className="badge success" data-testid="report-theme-saved">Saved “{card.savedAs.name}” v{card.savedAs.version}</span>}
          {r.preview && card.status !== "saved" && <>
            <input className="input" style={{ width: 170 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Theme name" data-testid="report-theme-name" aria-label="Theme name" />
            {surveyId !== "sandbox" && <select className="select" style={{ width: 150 }} value={scope} onChange={(e) => setScope(e.target.value as "user" | "org")} data-testid="report-theme-scope" aria-label="Save for"><option value="user">Just for me</option><option value="org" disabled={!card.canSaveOrg}>My organisation</option></select>}
            <button type="button" className="btn small" disabled={busy || !name.trim()} onClick={() => void save()} data-testid="report-theme-save">Save as theme</button>
          </>}
        </div>
      )}
    </div>
  );
}
