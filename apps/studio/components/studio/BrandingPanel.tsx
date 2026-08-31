"use client";
import React from "react";
import { useStudio } from "./store";
import { THEME_PRESETS } from "@/lib/defaults";
import { Branding } from "@rescript/schema";

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
      </div>

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
      </div>

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
      <p className="muted" style={{ fontSize: 12 }}>
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
            <label className="row" style={{ gap: 4, fontSize: 12 }}>
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
