"use client";
import React from "react";
import { useStudio } from "./store";
import { THEME_PRESETS } from "@/lib/defaults";
import { Branding } from "@rescript/schema";
import { AiConversationSection } from "./AiConversationPanel";

function Color({ label, value, onChange }: { label: string; value: string; onChange(v: string): void }) {
  return (
    <label className="f" style={{ width: 130 }}>
      <span>{label}</span>
      <div className="row" style={{ gap: 6 }}>
        <input type="color" value={/^#([0-9a-f]{6})$/i.test(value) ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 30, height: 28, padding: 0, border: "1px solid var(--border)", background: "none", borderRadius: 6 }} />
        <input className="input mono" style={{ width: 88 }} value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </label>
  );
}

/**
 * WORKSPACE THEMES.
 *
 * The built-in presets are Rescript's; these are the client's. `public.themes`
 * and `Branding.themeId` have been in the data model since the first
 * migration with no route, loader or UI attached — so a house style was
 * re-entered by hand on every study and drifted between them. Saved here,
 * applied to any survey in the workspace.
 */
function WorkspaceThemes() {
  const s = useStudio();
  const [themes, setThemes] = React.useState<{ id: string; name: string; branding: unknown }[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const disabled = s.surveyDbId === "sandbox";

  const load = React.useCallback(async () => {
    if (disabled) return;
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/themes`, { cache: "no-store" });
      if (!r.ok) return; // a workspace with no themes yet is not an error worth showing
      const j = await r.json();
      setThemes(j.themes ?? []);
    } catch { /* offline — the presets still work */ }
  }, [s.surveyDbId, disabled]);
  React.useEffect(() => { void load(); }, [load]);

  const saveCurrent = async () => {
    const name = window.prompt("Save this look as a workspace theme. Name it:", s.def.meta.title)?.trim();
    if (!name) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/themes`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, branding: s.def.branding }),
      });
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? `Could not save (${r.status})`); return; }
      s.toast(j.replaced ? `Theme "${name}" updated` : `Theme "${name}" saved to this workspace`);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const apply = (id: string) => {
    const t = themes.find((x) => x.id === id);
    if (!t) return;
    s.labelNextEdit("apply theme");
    /*
     * The theme is written INTO the definition, and `themeId` records where
     * it came from. Not a live reference: a survey already in field must not
     * change appearance because somebody edited a theme, and a version
     * snapshot has to carry the look it was fielded with.
     */
    s.update((d) => { d.branding = Branding.parse({ ...(t.branding as object), themeId: t.id }); });
    s.toast(`Applied "${t.name}"`);
  };

  if (disabled) return null;
  return (
    <div className="row" style={{ gap: 8 }} data-testid="workspace-themes">
      {themes.length > 0 && (
        <select className="select" style={{ width: 200 }} value="" data-testid="apply-workspace-theme"
          onChange={(e) => { if (e.target.value) apply(e.target.value); }}>
          <option value="">Apply workspace theme…</option>
          {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
      <button className="btn" disabled={busy} onClick={() => void saveCurrent()} data-testid="save-workspace-theme">
        {busy ? "Saving…" : "Save as workspace theme"}
      </button>
      {error && <span className="chip warn" data-testid="theme-error">{error}</span>}
    </div>
  );
}

/** Branding / theming (requirement §19) + presets (§20). */
export function BrandingPanel() {
  const s = useStudio();
  const b = s.def.branding;
  const set = (path: (draft: typeof b) => void) => s.update((d) => path(d.branding));

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Branding &amp; Theme</h2>
        <span className="grow" />
        <select className="select" style={{ width: 220 }} value=""
          onChange={(e) => {
            const preset = THEME_PRESETS.find((t) => t.name === e.target.value);
            if (!preset) return;
            s.update((d) => { d.branding = Branding.parse({ ...d.branding, ...preset.branding }); });
            s.toast(`Applied "${preset.name}" theme`);
          }}>
          <option value="">Apply preset theme…</option>
          {THEME_PRESETS.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
        </select>
        <WorkspaceThemes />
      </div>
      {b.themeId && (
        <p className="muted" style={{ fontSize: 12.5, marginTop: -6 }} data-testid="theme-origin">
          This survey&apos;s look came from a workspace theme. Editing anything below changes only
          this survey — save it again as a theme to share the change.
        </p>
      )}

      <h3 className="sec">Identity</h3>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="f grow"><span>Logo URL</span>
          <input className="input" value={b.logoUrl ?? ""}
            onChange={(e) => set((x) => { x.logoUrl = e.target.value || undefined; })} /></label>
        <label className="f" style={{ width: 120 }}><span>Position</span>
          <select className="select" value={b.logoPosition}
            onChange={(e) => set((x) => { x.logoPosition = e.target.value as any; })}>
            <option value="left">left</option><option value="center">center</option><option value="right">right</option>
          </select></label>
      </div>

      <h3 className="sec">Colors</h3>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <Color label="Primary" value={b.colors.primary} onChange={(v) => set((x) => { x.colors.primary = v; })} />
        <Color label="Secondary" value={b.colors.secondary} onChange={(v) => set((x) => { x.colors.secondary = v; })} />
        <Color label="Background" value={b.colors.background} onChange={(v) => set((x) => { x.colors.background = v; })} />
        <Color label="Surface" value={b.colors.surface} onChange={(v) => set((x) => { x.colors.surface = v; })} />
        <Color label="Text" value={b.colors.text} onChange={(v) => set((x) => { x.colors.text = v; })} />
        <Color label="Subtle" value={b.colors.subtleText} onChange={(v) => set((x) => { x.colors.subtleText = v; })} />
        <Color label="Border" value={b.colors.border} onChange={(v) => set((x) => { x.colors.border = v; })} />
        <Color label="Error" value={b.colors.error} onChange={(v) => set((x) => { x.colors.error = v; })} />
      </div>

      <h3 className="sec">Typography &amp; layout</h3>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="f" style={{ width: 260 }}><span>Font family</span>
          <input className="input" value={b.typography.fontFamily}
            onChange={(e) => set((x) => { x.typography.fontFamily = e.target.value; })} /></label>
        <label className="f" style={{ width: 90 }}><span>Base size</span>
          <input className="input" value={b.typography.baseSize}
            onChange={(e) => set((x) => { x.typography.baseSize = e.target.value; })} /></label>
        <label className="f" style={{ width: 110 }}><span>Max width</span>
          <input className="input" value={b.layout.maxWidth}
            onChange={(e) => set((x) => { x.layout.maxWidth = e.target.value; })} /></label>
        <label className="f" style={{ width: 100 }}><span>Radius</span>
          <input className="input" value={b.layout.radius}
            onChange={(e) => set((x) => { x.layout.radius = e.target.value; })} /></label>
        <label className="f" style={{ width: 110 }}><span>Card style</span>
          <select className="select" value={b.layout.cardStyle}
            onChange={(e) => set((x) => { x.layout.cardStyle = e.target.value as any; })}>
            <option value="card">card</option><option value="flat">flat</option><option value="line">line</option>
          </select></label>
        <label className="f" style={{ width: 110 }}><span>Spacing</span>
          <select className="select" value={b.layout.spacing}
            onChange={(e) => set((x) => { x.layout.spacing = e.target.value as any; })}>
            <option value="compact">compact</option><option value="regular">regular</option><option value="relaxed">relaxed</option>
          </select></label>
        <label className="f" style={{ width: 120 }}><span>Progress bar</span>
          <select className="select" value={b.layout.progressBar}
            onChange={(e) => set((x) => { x.layout.progressBar = e.target.value as any; })}>
            <option value="top">top</option><option value="bottom">bottom</option><option value="none">none</option>
          </select></label>
        <label className="f" style={{ width: 230 }} title="Block names always show in the Studio. This decides whether respondents see them as page headings. A block can override it in its ••• menu.">
          <span>Block names</span>
          <select className="select" data-testid="show-block-titles"
            value={b.layout.showBlockTitles ? "show" : "hide"}
            onChange={(e) => set((x) => { x.layout.showBlockTitles = e.target.value === "show"; })}>
            <option value="show">shown to respondents</option>
            <option value="hide">hidden from respondents</option>
          </select></label>
      </div>

      {/*
        * THE AI CONVERSATIONAL SURVEY — text / voice / both; standard,
        * conversational or adaptive; the voice, the interviewer, the
        * follow-ups. One object (branding.aiConversation); the older
        * layout.presentation / layout.voice fields are mirrored from it.
        */}
      <AiConversationSection />

      <h3 className="sec">Buttons</h3>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="f" style={{ width: 100 }}><span>Style</span>
          <select className="select" value={b.buttons.style}
            onChange={(e) => set((x) => { x.buttons.style = e.target.value as any; })}>
            <option value="solid">solid</option><option value="outline">outline</option><option value="pill">pill</option>
          </select></label>
        <label className="f" style={{ width: 110 }}><span>Next label</span>
          <input className="input" value={b.buttons.nextLabel}
            onChange={(e) => set((x) => { x.buttons.nextLabel = e.target.value; })} /></label>
        <label className="f" style={{ width: 110 }}><span>Back label</span>
          <input className="input" value={b.buttons.backLabel}
            onChange={(e) => set((x) => { x.buttons.backLabel = e.target.value; })} /></label>
        <label className="f" style={{ width: 110 }}><span>Submit label</span>
          <input className="input" value={b.buttons.submitLabel}
            onChange={(e) => set((x) => { x.buttons.submitLabel = e.target.value; })} /></label>
        <label className="row" style={{ gap: 4 }}>
          <input type="checkbox" checked={b.buttons.showBack}
            onChange={(e) => set((x) => { x.buttons.showBack = e.target.checked; })} /> show back button
        </label>
      </div>

      <h3 className="sec">Header / footer / custom code</h3>
      <label className="f"><span>Header HTML</span>
        <textarea className="ta code" style={{ minHeight: 60 }} value={b.headerHtml ?? ""}
          onChange={(e) => set((x) => { x.headerHtml = e.target.value || undefined; })} /></label>
      <label className="f"><span>Footer HTML</span>
        <textarea className="ta code" style={{ minHeight: 60 }} value={b.footerHtml ?? ""}
          onChange={(e) => set((x) => { x.footerHtml = e.target.value || undefined; })} /></label>
      <label className="f"><span>Custom CSS (survey-wide)</span>
        <textarea className="ta code" value={b.customCss ?? ""}
          onChange={(e) => set((x) => { x.customCss = e.target.value || undefined; })} /></label>
      <label className="f"><span>Custom JS (survey-wide, runs in runtime)</span>
        <textarea className="ta code" value={b.customJs ?? ""}
          onChange={(e) => set((x) => { x.customJs = e.target.value || undefined; })} /></label>
    </div>
  );
}

export function ScriptsPanel() {
  const s = useStudio();
  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Custom Scripts</h2>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Scripts run in the runtime&apos;s controlled host with this API:{" "}
        <code>get(ref) set(ref, v) getCalc/setCalc getEmbedded/setEmbedded expr(&quot;Q1+Q2&quot;) pipe(&quot;{"{{Q1}}"}&quot;)
        flag(name) log(...) error(msg, ref) loop</code>. Events: on_load, on_change, on_submit, on_validate, on_complete.
      </p>
      {s.def.scripts.map((sc, i) => (
        <div key={sc.id} className="card">
          <div className="row" style={{ marginBottom: 6, flexWrap: "wrap" }}>
            <input className="input" style={{ width: 180 }} value={sc.name}
              onChange={(e) => s.update((d) => { d.scripts[i].name = e.target.value; })} />
            <select className="select" value={sc.scope}
              onChange={(e) => s.update((d) => { d.scripts[i].scope = e.target.value as any; })}>
              <option value="survey">survey</option><option value="page">page</option><option value="question">question</option>
            </select>
            {sc.scope !== "survey" && (
              <input className="input mono" style={{ width: 130 }} placeholder="page/question id" value={sc.ref ?? ""}
                onChange={(e) => s.update((d) => { d.scripts[i].ref = e.target.value || undefined; })} />
            )}
            <select className="select" value={sc.event}
              onChange={(e) => s.update((d) => { d.scripts[i].event = e.target.value as any; })}>
              <option value="on_load">on_load</option><option value="on_change">on_change</option>
              <option value="on_submit">on_submit</option><option value="on_validate">on_validate</option>
              <option value="on_complete">on_complete</option>
            </select>
            <label className="row" style={{ gap: 4, fontSize: 13 }}>
              <input type="checkbox" checked={sc.enabled}
                onChange={(e) => s.update((d) => { d.scripts[i].enabled = e.target.checked; })} /> enabled
            </label>
            <span className="grow" />
            <button className="btn small danger" onClick={() => s.update((d) => { d.scripts.splice(i, 1); })}>×</button>
          </div>
          <textarea className="ta code" value={sc.code}
            placeholder={`// e.g. total of three questions\nconst total = expr('Q1 + Q2 + Q3');\nsetCalc('TOTAL', total);\nif (total > 100) flag('over_100');`}
            onChange={(e) => s.update((d) => { d.scripts[i].code = e.target.value; })} />
        </div>
      ))}
      <button className="btn" onClick={() =>
        s.update((d) => {
          d.scripts.push({
            id: `script_${Date.now().toString(36)}`, name: `Script ${d.scripts.length + 1}`,
            scope: "survey", event: "on_submit", code: "", enabled: true,
          });
        })}>
        + script
      </button>
    </div>
  );
}
