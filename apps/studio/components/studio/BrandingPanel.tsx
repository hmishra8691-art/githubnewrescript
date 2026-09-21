"use client";
import React from "react";
import { useStudio } from "./store";
import { THEME_PRESETS } from "@/lib/defaults";
import { Branding, SurveyDefinition } from "@rescript/schema";
import { createResponseState, start, setAnswer } from "@rescript/engine";
import { QuestionRenderer, brandingVars, widthModeClass } from "@rescript/renderer";
import { AiConversationSection } from "./AiConversationPanel";
import { MediaUrlInput } from "./MediaUrlInput";
import { MediaDisplayControls } from "./MediaDisplayControls";
import { dominantColorsFromImage, generatePalette, generatePaletteFromHex, hexToRgb, type GeneratedColors, type RGB } from "@/lib/paletteFromImage";

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
 * A color with no schema default — absent means "inherit down the CSS
 * fallback chain" (see questions.css's `:root` comment), not "black". The
 * swatch shows what it currently resolves to (the explicit value, or the
 * `inherits` color passed in) so the box is never just blank, and "Reset"
 * clears the override rather than requiring the color to be retyped to
 * whatever it was inheriting a moment ago.
 */
function OptionalColor({ label, value, inherits, onChange }: {
  label: string; value: string | undefined; inherits: string; onChange(v: string | undefined): void;
}) {
  const shown = value ?? inherits;
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return (
    <label className="f" style={{ width: 150 }} data-testid={`branding-optcolor-${slug}`}>
      <span>{label}{!value && <span className="muted" style={{ fontWeight: 400 }} data-testid={`branding-optcolor-${slug}-inherited`}> (inherited)</span>}</span>
      <div className="row" style={{ gap: 6 }}>
        <input type="color" value={/^#([0-9a-f]{6})$/i.test(shown) ? shown : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 30, height: 28, padding: 0, border: "1px solid var(--border)", background: "none", borderRadius: 6 }} />
        <input className="input mono" style={{ width: 82 }} value={value ?? ""} placeholder={inherits}
          data-testid={`branding-optcolor-${slug}-input`}
          onChange={(e) => onChange(e.target.value || undefined)} />
        {value && (
          <button type="button" className="btn small" data-testid={`branding-optcolor-${slug}-reset`}
            title={`Inherit ${inherits}`} onClick={() => onChange(undefined)}>×</button>
        )}
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

/* ============================================================ live preview */

/**
 * A small, fixed survey used ONLY to preview a theme — never the survey
 * being edited, never sent anywhere. Three question types (choice, a
 * numeric with a validation error already showing, open text) plus the
 * progress bar and nav buttons cover every element the brief's live-preview
 * requirement names: "question text, answer options, buttons, input
 * fields, cards, progress bar, validation message... header/logo".
 */
// Parsed through the real schema — like `newSurveyDefinition` — rather than
// hand-cast, so every question gets the same defaulted shape (option flags,
// validation array, etc.) a real one has. If this fails to parse, that's a
// bug in the fixture, not a bug in the preview.
const PREVIEW_DEF: SurveyDefinition = SurveyDefinition.parse({
  meta: { id: "00000000-0000-4000-8000-00000preview", code: "PREVIEW", title: "Theme preview", version: "1.0" },
  questions: [
    {
      id: "pv1", code: "Q1", variableName: "PICK", type: "single_select", text: "Which of these best describes you?",
      options: [
        { code: "1", label: "Just browsing" },
        { code: "2", label: "Ready to buy" },
        { code: "3", label: "Already a customer" },
      ],
    },
    {
      id: "pv2", code: "Q2", variableName: "QTY", type: "numeric", text: "How many would you like?",
      instructions: "Enter a whole number.",
    },
    {
      id: "pv3", code: "Q3", variableName: "NOTE", type: "open_text", text: "Anything else you'd like us to know?",
    },
  ],
  flow: [
    { type: "page", id: "pv_p1", questionIds: ["pv1", "pv2", "pv3"] },
    { type: "end", id: "pv_e1", status: "complete" },
  ],
});

const PREVIEW_ERROR = { questionId: "pv2", message: "Please enter a value greater than 0." };

/**
 * THE LIVE PREVIEW (req §6, "very important"). Renders through the SAME
 * `QuestionRenderer` and the SAME `brandingVars()`/`widthModeClass()`
 * `@rescript/renderer` exports the respondent runtime uses — not a
 * hand-drawn mockup of what a survey looks like, the real component tree,
 * fed a small fixed preview definition instead of the survey being edited.
 * Every render reads `branding` straight from the live draft, so a color,
 * font, width, alignment or button-label edit appears here on the very next
 * keystroke, with no save step and no separate Test/Preview tab.
 *
 * SEPT 21 FOLLOW-UP ("Context-Aware Right Panel & Live Preview UI Fix"): this
 * used to render inline, above "Identity", inside this same scrolling column
 * as every control below it — which is exactly the "preview forces the user
 * to scroll back and forth" layout that brief flagged. It is now mounted by
 * `Studio.tsx`'s `RightPanel` in the aside beside this panel instead (a
 * two-column layout: controls here, preview on the right), so it is exported
 * rather than kept local. Nothing about the component itself changed — same
 * fixed preview survey, same live read of `branding`, same `data-testid`s —
 * only where it is mounted did.
 */
export function ThemeLivePreview({ branding, logoUrl }: { branding: Branding; logoUrl?: string }) {
  const s = useStudio();
  const [answers, setAnswers] = React.useState<Record<string, unknown>>({ pv1: "2" });
  const state = React.useMemo(() => {
    const st = createResponseState(PREVIEW_DEF);
    start(PREVIEW_DEF, st);
    for (const [qid, v] of Object.entries(answers)) setAnswer(PREVIEW_DEF, st, qid, v);
    return st;
  }, [answers]);

  const vars = brandingVars(branding) as React.CSSProperties;
  const cls = `rs-shell rs-${branding.layout.cardStyle} ${widthModeClass(branding)}`;

  return (
    <div className="theme-preview" data-testid="theme-live-preview">
      <div className="theme-preview-frame">
        <div className={cls} style={{ ...vars, padding: "16px 16px 24px" }}>
          {logoUrl && (
            <div className={`rs-header ${branding.logoPosition}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoUrl} alt="" style={{ maxHeight: 36 }} />
            </div>
          )}
          {branding.layout.progressBar !== "none" && (
            <>
              <div className="rs-progress-track"><div className="rs-progress-fill" style={{ width: "38%" }} /></div>
              {branding.layout.progressStyle === "percent" && <div className="rs-progress-label">38%</div>}
            </>
          )}
          <div className="rs-card" data-testid="theme-preview-q1">
            <QuestionRenderer def={PREVIEW_DEF} q={PREVIEW_DEF.questions[0]} state={state} loop={null}
              value={answers.pv1} errors={[]} onChange={(v) => setAnswers((a) => ({ ...a, pv1: v }))} />
          </div>
          <div className="rs-card" data-testid="theme-preview-q2">
            <QuestionRenderer def={PREVIEW_DEF} q={PREVIEW_DEF.questions[1]} state={state} loop={null}
              value={answers.pv2} errors={[PREVIEW_ERROR]} onChange={(v) => setAnswers((a) => ({ ...a, pv2: v }))} />
          </div>
          <div className="rs-card" data-testid="theme-preview-q3">
            <QuestionRenderer def={PREVIEW_DEF} q={PREVIEW_DEF.questions[2]} state={state} loop={null}
              value={answers.pv3} errors={[]} onChange={(v) => setAnswers((a) => ({ ...a, pv3: v }))} />
          </div>
          <div className="rs-nav">
            {branding.buttons.showBack && (
              <button type="button" className={`rs-btn secondary ${branding.buttons.style}`} data-testid="theme-preview-back">
                {branding.buttons.backLabel}
              </button>
            )}
            <span />
            <button type="button" className={`rs-btn ${branding.buttons.style}`} data-testid="theme-preview-next">
              {branding.buttons.nextLabel}
            </button>
          </div>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
        A fixed preview survey, not {s.def.meta.title || "this survey"} — updates as you edit anything below.
      </p>
    </div>
  );
}

/* ================================================== logo detection / brand color */

/**
 * Three sources feeding one destination: "Detect Logo Colors" (req §4),
 * "generate from a brand color" (a typed hex), and — Sept 21 follow-up —
 * "Import Brand from URL", which analyzes a website's own CSS/meta/logo
 * server-side (`/api/surveys/{id}/brand-scrape`) and hands back seed
 * colors for the exact same generator.
 *
 * All three end at the same place: a generated palette shown for review,
 * applied only on "Use this palette" — never silently overwriting the
 * survey's colors the moment a URL or logo loads. And all three ultimately
 * call the one `generatePalette` — there is no second, URL-specific palette
 * generator; the URL path's only job is producing seed colors the other two
 * paths already know how to turn into a full theme.
 */
function ThemeGenerator({ b, set }: { b: Branding; set(path: (draft: Branding) => void): void }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [generated, setGenerated] = React.useState<GeneratedColors | null>(null);
  const [brandHex, setBrandHex] = React.useState("#2563eb");
  const [siteUrl, setSiteUrl] = React.useState("");
  const [siteStatus, setSiteStatus] = React.useState<string | null>(null);
  const [detectedColors, setDetectedColors] = React.useState<{ hex: string; role: string }[] | null>(null);

  // toast/survey id live on the store; grabbed lazily so this file doesn't
  // need the whole store type threaded through this small component's props
  const s = useStudio();
  const sandboxed = s.surveyDbId === "sandbox";

  const fromRgbSeeds = (rgbs: RGB[]) => setGenerated(generatePalette(rgbs));

  const fromLogo = async () => {
    if (!b.logoUrl) return;
    setBusy(true); setError(null); setGenerated(null); setDetectedColors(null); setSiteStatus(null);
    try {
      fromRgbSeeds(await dominantColorsFromImage(b.logoUrl));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fromHex = () => {
    setError(null); setDetectedColors(null); setSiteStatus(null);
    try {
      setGenerated(generatePaletteFromHex(brandHex));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * WEBSITE URL -> BRAND COLORS -> SURVEY THEME (Sept 21 follow-up brief).
   *
   * The server (`/api/surveys/{id}/brand-scrape`) does the actual
   * fetching/parsing and returns only short hex-color strings plus, at
   * most, a logo/favicon URL — never the page's HTML or CSS. If it found
   * usable colors, they become the palette generator's seeds directly. If
   * it found NONE but did find a logo, this reuses the exact same
   * browser-side `dominantColorsFromImage` the "Detect logo colors" button
   * uses — the brief's §6 fallback chain (CSS → logo image → manual entry),
   * implemented as "try the next existing path", not new image-decoding
   * code. If both come up empty, the error simply says so; the hex input
   * right below is the manual-entry fallback and needs nothing extra.
   */
  const fromUrl = async () => {
    if (!siteUrl.trim() || sandboxed) return;
    setBusy(true); setError(null); setGenerated(null); setDetectedColors(null);
    setSiteStatus("Analyzing website…");
    try {
      const res = await fetch(`/api/surveys/${s.surveyDbId}/brand-scrape`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: siteUrl.trim() }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: "That didn't come back as a usable response." }));

      if (data.ok && Array.isArray(data.seeds) && data.seeds.length) {
        const rgbs = (data.seeds as { hex: string; role: string }[]).map((s2) => hexToRgb(s2.hex)).filter((x: RGB | null): x is RGB => !!x);
        if (rgbs.length) {
          fromRgbSeeds(rgbs);
          setDetectedColors(data.seeds);
          setSiteStatus(`Found ${data.seeds.length} brand color${data.seeds.length === 1 ? "" : "s"} from the site's ${data.source === "meta" ? "declared theme color" : "styles"}.`);
          return;
        }
      }

      // no CSS/meta colors — try the site's own logo/favicon image, the
      // same way "Detect logo colors" already works, just with a
      // discovered URL instead of this survey's own b.logoUrl
      if (data.logoUrl) {
        setSiteStatus("No brand colors found in the page's styles — trying the site's logo…");
        try {
          fromRgbSeeds(await dominantColorsFromImage(data.logoUrl));
          setSiteStatus("Found colors from the site's logo image.");
          return;
        } catch {
          // falls through to the shared "nothing worked" message below
        }
      }

      setSiteStatus(null);
      setError(data.ok ? "No usable brand colors found on that page — try entering a color below." : (data.error || "Couldn't analyze that site — try entering a color below."));
    } catch {
      setSiteStatus(null);
      setError("Couldn't reach the analysis service — try entering a color below.");
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!generated) return;
    set((x) => { x.colors = { ...x.colors, ...generated }; });
    s.toast("Palette applied — every color below can still be tweaked by hand");
  };

  return (
    <div className="card" style={{ padding: 12, marginTop: 4 }} data-testid="theme-generator">
      <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: 10 }}>
        <label className="f" style={{ width: 260 }}><span>Import brand from URL</span>
          <div className="row" style={{ gap: 6 }}>
            <input className="input" style={{ minWidth: 160 }} placeholder="https://example.com" value={siteUrl}
              disabled={sandboxed} data-testid="brand-url-input"
              onChange={(e) => setSiteUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void fromUrl(); } }} />
            <button type="button" className="btn" disabled={!siteUrl.trim() || busy || sandboxed} data-testid="analyze-brand-url"
              onClick={() => void fromUrl()} title={sandboxed ? "Save the survey first — brand analysis needs a saved survey." : "Analyze this website's colors and generate a theme from them"}>
              {busy && siteStatus ? "Analyzing…" : "🔗 Analyze website"}
            </button>
          </div>
        </label>
        <button type="button" className="btn" disabled={!b.logoUrl || busy} data-testid="detect-logo-colors" onClick={() => void fromLogo()}
          title={b.logoUrl ? "Analyze the logo above and generate a palette from its colors" : "Add a logo above first"}>
          {busy && !siteStatus ? "Analyzing…" : "🎨 Detect logo colors"}
        </button>
        <span className="muted" style={{ fontSize: 12.5 }}>or</span>
        <label className="f" style={{ width: 130 }}><span>Brand color</span>
          <div className="row" style={{ gap: 6 }}>
            <input type="color" value={brandHex} onChange={(e) => setBrandHex(e.target.value)}
              style={{ width: 30, height: 28, padding: 0, border: "1px solid var(--border)", background: "none", borderRadius: 6 }} />
            <input className="input mono" style={{ width: 82 }} value={brandHex} onChange={(e) => setBrandHex(e.target.value)} />
          </div>
        </label>
        <button type="button" className="btn" data-testid="generate-from-hex" onClick={fromHex}>Generate theme</button>
      </div>
      {sandboxed && <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>Save the survey first — brand analysis needs a saved survey.</p>}
      {siteStatus && <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }} data-testid="brand-url-status">{siteStatus}</p>}
      {error && <p className="chip warn" data-testid="theme-generator-error" style={{ marginTop: 8 }}>{error}</p>}
      {detectedColors && (
        <div style={{ marginTop: 8 }} data-testid="brand-colors-detected">
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>Brand colors detected:</p>
          <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
            {detectedColors.map((c, i) => (
              <span key={i} className="row" style={{ gap: 5, alignItems: "center", fontSize: 12.5 }} title={c.role}>
                <span style={{ width: 16, height: 16, borderRadius: 4, background: c.hex, border: "1px solid var(--border)", display: "inline-block" }} />
                <span className="mono">{c.hex}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {generated && (
        <div style={{ marginTop: 10 }} data-testid="generated-palette">
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {(Object.entries(generated) as [string, string][]).map(([k, hex]) => (
              <div key={k} title={`${k}: ${hex}`} style={{
                width: 26, height: 26, borderRadius: 6, background: hex, border: "1px solid var(--border)",
              }} />
            ))}
          </div>
          <button type="button" className="btn primary small" style={{ marginTop: 8 }} data-testid="apply-generated-palette" onClick={apply}>
            Use this palette
          </button>
        </div>
      )}
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

      {/* The live preview used to render here — see ThemeLivePreview's export
          comment above. It now sits in the right-hand panel (Studio.tsx's
          RightPanel), beside these controls instead of above them. */}

      <h3 className="sec">Identity</h3>
      <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
        <div className="grow">
          <MediaUrlInput label="Logo" testId="branding-logo" accept={["image"]} placeholder="Logo image URL — or choose / upload from Assets"
            value={b.logoUrl} onChange={(v) => set((x) => { x.logoUrl = v || undefined; })} />
        </div>
        <label className="f" style={{ width: 120 }}><span>Position</span>
          <select className="select" value={b.logoPosition}
            onChange={(e) => set((x) => { x.logoPosition = e.target.value as any; })}>
            <option value="left">left</option><option value="center">center</option><option value="right">right</option>
          </select></label>
      </div>
      {b.logoUrl && (
        <details className="qs-details" data-testid="branding-logo-display" open={!!b.logoDisplay}>
          <summary>Logo size &amp; fit</summary>
          <MediaDisplayControls kind="image" value={b.logoDisplay}
            onChange={(logoDisplay) => set((x) => { x.logoDisplay = logoDisplay; })} />
        </details>
      )}

      <ThemeGenerator b={b} set={set} />

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
      <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
        <OptionalColor label="Accent" value={b.colors.accent} inherits={b.colors.primary}
          onChange={(v) => set((x) => { x.colors.accent = v; })} />
        <OptionalColor label="Heading" value={b.colors.heading} inherits={b.colors.text}
          onChange={(v) => set((x) => { x.colors.heading = v; })} />
        <OptionalColor label="Link" value={b.colors.link} inherits={b.colors.accent ?? b.colors.primary}
          onChange={(v) => set((x) => { x.colors.link = v; })} />
        <OptionalColor label="Input bg" value={b.colors.inputBackground} inherits={b.colors.surface}
          onChange={(v) => set((x) => { x.colors.inputBackground = v; })} />
        <OptionalColor label="Button bg" value={b.colors.buttonBackground} inherits={b.colors.primary}
          onChange={(v) => set((x) => { x.colors.buttonBackground = v; })} />
        <OptionalColor label="Button text" value={b.colors.buttonText} inherits="#ffffff"
          onChange={(v) => set((x) => { x.colors.buttonText = v; })} />
        <OptionalColor label="Progress" value={b.colors.progress} inherits={b.colors.accent ?? b.colors.primary}
          onChange={(v) => set((x) => { x.colors.progress = v; })} />
      </div>

      <h3 className="sec">Typography &amp; layout</h3>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <label className="f" style={{ width: 260 }}><span>Font family</span>
          <input className="input" value={b.typography.fontFamily}
            onChange={(e) => set((x) => { x.typography.fontFamily = e.target.value; })} /></label>
        <label className="f" style={{ width: 90 }}><span>Base size</span>
          <input className="input" value={b.typography.baseSize}
            onChange={(e) => set((x) => { x.typography.baseSize = e.target.value; })} /></label>
        <label className="f" style={{ width: 130 }} title="Full-width uses the whole browser window on desktop, like a modern web app. Contained keeps the classic centered card at Max width below.">
          <span>Desktop width</span>
          <select className="select" data-testid="branding-width-mode" value={b.layout.widthMode}
            onChange={(e) => set((x) => { x.layout.widthMode = e.target.value as any; })}>
            <option value="full">full width</option>
            <option value="contained">contained</option>
          </select></label>
        <label className="f" style={{ width: 110 }} title="Where survey content sits on the page. Left is standard for LTR languages, Right for RTL, Center suits a branding-forward look.">
          <span>Content align</span>
          <select className="select" data-testid="branding-content-align" value={b.layout.contentAlign}
            onChange={(e) => set((x) => { x.layout.contentAlign = e.target.value as any; })}>
            <option value="left">left</option>
            <option value="center">center</option>
            <option value="right">right</option>
          </select></label>
        <label className="f" style={{ width: 110 }}><span>Max width</span>
          <input className="input" value={b.layout.maxWidth} disabled={b.layout.widthMode === "full"}
            title={b.layout.widthMode === "full" ? "Only applies in Contained mode" : undefined}
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
