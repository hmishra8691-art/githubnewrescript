"use client";
import React from "react";
import { useStudio } from "./store";
import { THEME_PRESETS } from "@/lib/defaults";
import { Branding, SurveyDefinition } from "@rescript/schema";
import { createResponseState, start, setAnswer, codeGate, listPages } from "@rescript/engine";
import { QuestionRenderer, ProgressIndicator, brandingVars, widthModeClass, brandingClasses, brandingResponsiveCss } from "@rescript/renderer";
import { TypographyMore, BackgroundSection, AppearanceSection, ResponsiveSection, ThemeAssistant } from "./BrandingAdvanced";
import { UxItemsEditor } from "./UxItemsEditor";
import { OptionalCondition } from "./ConditionBuilder";
import { themePreviewStore } from "@/lib/themePreview";
import { brandingFocus, activeRegion } from "@/lib/brandingFocus";
import { describeBrandingChanges, type BrandingChange, type PreviewRegion } from "@/lib/brandingChanges";
import { AiConversationSection } from "./AiConversationPanel";
import { MediaUrlInput } from "./MediaUrlInput";
import { MediaDisplayControls } from "./MediaDisplayControls";
import { ScriptHealthChip, ScriptHealthSummaryBar } from "./ScriptHealth";
import { LegacyScriptsBanner } from "./LegacyScripts";
import { CodeEditor } from "./code/CodeEditor";
import { useScriptTools } from "./code/ScriptTools";
import { duplicateLogicScript, DUPLICATE_NOTE } from "@/lib/scripts/manage.ts";
import { dominantColorsFromImage, generatePalette, generatePaletteFromHex, hexToRgb, contrastRatio, type GeneratedColors, type RGB } from "@/lib/paletteFromImage";

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
      id: "pv4", code: "Q2", variableName: "LIKE", type: "multi_select", text: "What do you enjoy about it? Choose all that apply.",
      options: [
        { code: "1", label: "Design" },
        { code: "2", label: "Price" },
        { code: "3", label: "Ease of use" },
        { code: "97", label: "Something else", flags: ["other_specify"] },
      ],
    },
    {
      id: "pv5", code: "Q3", variableName: "GRID", type: "matrix_single", text: "How do you rate each of these?",
      rows: [{ code: "1", label: "Quality" }, { code: "2", label: "Value" }, { code: "3", label: "Service" }],
      options: [{ code: "1", label: "Poor" }, { code: "2", label: "Fair" }, { code: "3", label: "Good" }, { code: "4", label: "Great" }],
    },
    {
      id: "pv6", code: "Q4", variableName: "REC", type: "nps", text: "How likely are you to recommend us to a friend?",
      settings: { npsLeftLabel: "Not at all likely", npsRightLabel: "Extremely likely" },
    },
    {
      id: "pv7", code: "Q5", variableName: "FAV", type: "single_select", variant: "carousel.single", text: "Which look do you like most?",
      options: [{ code: "1", label: "Classic" }, { code: "2", label: "Modern" }, { code: "3", label: "Bold" }],
    },
    {
      id: "pv2", code: "Q6", variableName: "QTY", type: "numeric", text: "How many would you like?",
      instructions: "Enter a whole number.",
    },
    {
      id: "pv3", code: "Q7", variableName: "NOTE", type: "open_text", text: "Anything else you'd like us to know?",
    },
  ],
  flow: [
    { type: "page", id: "pv_p1", questionIds: ["pv1", "pv4"] },
    { type: "page", id: "pv_p2", questionIds: ["pv5", "pv6"] },
    { type: "page", id: "pv_p3", questionIds: ["pv7", "pv2", "pv3"] },
    { type: "end", id: "pv_e1", status: "complete" },
  ],
});
/** the sample's pages: choices · grid and rating scale · carousel and open answers */
const PREVIEW_PAGES = [["pv1", "pv4"], ["pv5", "pv6"], ["pv7", "pv2", "pv3"]];
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
/** one edit in the "Just changed" list: each setting, before → after, what it affects (pointing outlines it) */
function ChangeGroup({ items, latest }: { items: BrandingChange[]; latest?: boolean }) {
  return (
    <div className={`tp-change${latest ? " latest" : ""}`}>
      {items.length > 3 ? (
        <details>
          <summary><b>{items.length} settings</b> changed at once (a preset or theme)</summary>
          {items.map((x) => <div key={x.path} className="tp-change-line"><b>{x.label}</b> <span className="mono">{x.before} → {x.after}</span></div>)}
        </details>
      ) : items.map((x) => (
        <div key={x.path} className="tp-change-line" onMouseEnter={() => brandingFocus.setHover(x.region)} onMouseLeave={() => brandingFocus.setHover(null)}>
          <b>{x.label}</b> <span className="mono">{x.before} → {x.after}</span>
          <small className="muted"> — {x.impact}</small>
        </div>
      ))}
    </div>
  );
}

export function ThemeLivePreview({ branding: saved, logoUrl }: { branding: Branding; logoUrl?: string }) {
  const s = useStudio();
  // a theme on approval (the theme assistant's proposal, a preset under the pointer) shows here until it is applied or cancelled
  const proposed = React.useSyncExternalStore(themePreviewStore.subscribe, themePreviewStore.get, () => null);
  const focus = React.useSyncExternalStore(brandingFocus.subscribe, brandingFocus.get, brandingFocus.get);
  const branding = proposed ?? saved;
  const [device, setDevice] = React.useState<"desktop" | "tablet" | "mobile">("desktop");
  /* a group about a screen size (Phone & tablet) switches the preview to it */
  React.useEffect(() => { if (focus.device) setDevice(focus.device); }, [focus.device, focus.seq]);
  const [source, setSource] = React.useState<"sample" | "survey">("sample");
  const [answers, setAnswers] = React.useState<Record<string, unknown>>({ pv1: "2", pv4: ["1", "3"] });
  /* the sample is three pages a researcher can click through with the preview's own Back / Next */
  const [samplePage, setSamplePage] = React.useState(0);
  const paged = source === "sample";

  /*
   * WHAT IS PREVIEWED. "Sample" is the fixed page below (every element a theme touches, with a validation message
   * showing); "This survey" is the first page of the survey being edited. Both carry the CURRENT branding, so the
   * display settings the renderer reads from the definition (question numbers, option letters) show too.
   */
  const page = React.useMemo(() => {
    if (source === "survey") {
      for (const p of listPages(s.def.flow as unknown[])) {
        const ids = ((p.node as { questionIds?: string[] }).questionIds ?? []).filter((id) => s.def.questions.some((q) => q.id === id && q.type !== "hidden" && q.type !== "calculated" && q.type !== "embedded_data")).slice(0, 4);
        if (ids.length) return { def: { ...s.def, branding } as SurveyDefinition, ids, errors: [] as { questionId: string; message: string }[] };
      }
    }
    return { def: { ...PREVIEW_DEF, branding } as SurveyDefinition, ids: PREVIEW_PAGES[samplePage]!, errors: [PREVIEW_ERROR] };
  }, [source, s.def, branding, samplePage]);
  const state = React.useMemo(() => {
    try {
      const st = createResponseState(page.def);
      start(page.def, st);
      for (const [qid, v] of Object.entries(answers)) if (page.def.questions.some((q) => q.id === qid)) setAnswer(page.def, st, qid, v);
      return st;
    } catch { return createResponseState(page.def); }
  }, [answers, page.def]);

  /* JUST CHANGED: each edit named, before → after, what it affects; the affected part flashes */
  const [changes, setChanges] = React.useState<{ id: number; items: BrandingChange[]; at: number }[]>([]);
  const prev = React.useRef<{ branding: unknown; navigation: unknown } | null>(null);
  React.useEffect(() => {
    const snap = { branding: saved, navigation: s.def.navigation ?? null };
    const before = prev.current;
    prev.current = snap;
    if (!before) return;
    const items = describeBrandingChanges({ ...(before.branding as object), navigation: before.navigation }, { ...(saved as object), navigation: snap.navigation });
    if (!items.length) return;
    setChanges((cs) => [{ id: Date.now(), items, at: Date.now() }, ...cs].slice(0, 4));
    brandingFocus.flash(items[0]!.region);
  }, [saved, s.def.navigation]);

  const region = activeRegion(focus);
  const rootRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!region) return;
    const sel: Record<string, string> = { cards: ".rs-card", text: ".rs-qtext", hints: ".rs-qinstruction", options: ".rs-options", inputs: ".rs-input, .rs-textarea, .rs-select", progress: ".rs-progress", buttons: ".rs-nav", error: ".rs-error-msg", logo: ".rs-header", nav: ".tp-secnav" };
    const el = sel[region] ? rootRef.current?.querySelector(sel[region]!) : null;
    const t = setTimeout(() => el?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 120);
    return () => clearTimeout(t);
  }, [region]);
  const vars = brandingVars(branding) as React.CSSProperties;
  const cls = `rs-shell rs-${branding.layout.cardStyle} ${widthModeClass(branding)} ${brandingClasses(branding)}`;
  const label = (k: string) => ({ page: "the page", cards: "the cards", text: "question text", hints: "hints", options: "the answers", inputs: "the inputs", progress: "the progress bar", buttons: "the buttons", error: "error messages", logo: "the header", nav: "the navigation" } as Record<string, string>)[k] ?? k;

  return (
    <div ref={rootRef} className={`theme-preview${region ? ` tp-hl tp-hl-${region}` : ""}${focus.flash ? " tp-flash" : ""}`} data-testid="theme-live-preview" data-device={device} data-proposed={proposed ? "1" : undefined} data-region={region ?? undefined}>
      <div className="row" style={{ gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
        <div className="row" style={{ gap: 4 }} role="group" aria-label="Preview device">
          {(["desktop", "tablet", "mobile"] as const).map((d) => (
            <button key={d} type="button" className={`btn small${device === d ? " primary" : ""}`} onClick={() => setDevice(d)} data-testid={`theme-preview-${d}`}>{d === "mobile" ? "phone" : d}</button>
          ))}
        </div>
        <span className="grow" />
        <div className="row" style={{ gap: 4 }} role="group" aria-label="What to preview">
          <button type="button" className={`btn small${source === "sample" ? " primary" : ""}`} onClick={() => setSource("sample")} data-testid="theme-preview-source-sample" title="A fixed page with every element a theme changes">Sample page</button>
          <button type="button" className={`btn small${source === "survey" ? " primary" : ""}`} onClick={() => setSource("survey")} data-testid="theme-preview-source-survey" title="The first page of this survey">This survey</button>
        </div>
      </div>
      {paged && (
        <div className="tp-pages" role="tablist" aria-label="Sample pages">
          {["Choices", "Grid & rating", "Carousel & text"].map((l, i) => (
            <button key={l} type="button" role="tab" aria-selected={samplePage === i} className={`tp-page${samplePage === i ? " on" : ""}`} data-testid={`theme-preview-page-${i + 1}`} onClick={() => setSamplePage(i)}>{i + 1}. {l}</button>
          ))}
        </div>
      )}
      <div className="tp-status muted" aria-live="polite">
        {proposed ? <span data-testid="theme-preview-proposed">Showing a proposed look — not applied yet.</span>
          : region ? <span data-testid="theme-preview-pointing">Outlined: {label(region)}</span>
          : <span>Point at a setting to see what it changes.</span>}
      </div>
      <div className="tp-changes" data-testid="theme-preview-changes" hidden={!changes.length}>
        <div className="row" style={{ alignItems: "center" }}>
          <b style={{ fontSize: 12 }}>Just changed</b>
          <span className="grow" />
          {changes.length > 0 && <button type="button" className="btn small" disabled={!s.canUndo} onClick={() => s.undo()} data-testid="theme-preview-undo">↶ Undo</button>}
        </div>
        {changes.slice(0, 1).map((c) => <ChangeGroup key={c.id} items={c.items} latest />)}
        {changes.length > 1 && (
          <details className="tp-earlier">
            <summary>Earlier changes ({changes.length - 1})</summary>
            {changes.slice(1).map((c) => <ChangeGroup key={c.id} items={c.items} />)}
          </details>
        )}
      </div>
      {branding.responsive && <style dangerouslySetInnerHTML={{ __html: brandingResponsiveCss(branding, '[data-testid="theme-preview-shell"]') }} />}
      <div className={`theme-preview-frame${device !== "desktop" ? ` rs-viewport ${device}` : ""}`} style={device === "mobile" ? { maxWidth: 390, margin: "0 auto" } : device === "tablet" ? { maxWidth: 768, margin: "0 auto" } : undefined}>
        <div className={cls} style={{ ...vars, padding: "16px 16px 24px" }} data-testid="theme-preview-shell">
          {logoUrl && (
            <div className={`rs-header ${branding.logoPosition}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoUrl} alt="" style={{ maxHeight: 36 }} />
            </div>
          )}
          {(s.def.navigation?.sectionNav ?? "off") !== "off" && (
            <div className="tp-secnav" data-testid="theme-preview-secnav"><span className="on">Section 1</span><span>Section 2</span><span>Section 3</span></div>
          )}
          {/* D20: the runtime's own indicator — page 3 of 7 of the fixed preview; "bottom" is drawn after the buttons */}
          {branding.layout.progressBar === "top" && (
            <ProgressIndicator position="top" style={branding.layout.progressStyle} current={paged ? samplePage + 1 : 3} total={paged ? PREVIEW_PAGES.length : 7} testid="theme-preview-progress" />
          )}
          {page.ids.map((id, i) => {
            const q = page.def.questions.find((x) => x.id === id)!;
            return (
              /* QuestionRenderer draws its own card; this wrapper only carries the test id */
              <div style={{ display: "contents" }} key={id} data-testid={source === "sample" ? (samplePage === 0 && id === "pv1" ? "theme-preview-q1" : `theme-preview-${q.code}`) : `theme-preview-survey-${q.code}`}>
                <QuestionRenderer def={page.def} q={q} state={state} loop={null}
                  value={answers[id]} errors={page.errors.filter((e) => e.questionId === id)} onChange={(v) => setAnswers((a) => ({ ...a, [id]: v }))} />
              </div>
            );
          })}
          {branding.layout.autoAdvance && (
            <p className="tp-note" data-testid="theme-preview-autonext">Auto-next is on: a page of single-answer questions moves on as soon as it is answered.</p>
          )}
          <div className="rs-nav">
            {branding.buttons.showBack && (
              <button type="button" className={`rs-btn secondary ${branding.buttons.style}`} data-testid="theme-preview-back"
                disabled={paged && samplePage === 0} onClick={() => paged && setSamplePage((n) => Math.max(0, n - 1))}>
                {branding.buttons.backLabel}
              </button>
            )}
            <span />
            <button type="button" className={`rs-btn ${branding.buttons.style}`} data-testid="theme-preview-next"
              onClick={() => paged && setSamplePage((n) => (n + 1) % PREVIEW_PAGES.length)}>
              {paged && samplePage === PREVIEW_PAGES.length - 1 ? branding.buttons.submitLabel : branding.buttons.nextLabel}
            </button>
          </div>
          {branding.layout.progressBar === "bottom" && (
            <ProgressIndicator position="bottom" style={branding.layout.progressStyle} current={paged ? samplePage + 1 : 3} total={paged ? PREVIEW_PAGES.length : 7} testid="theme-preview-progress" />
          )}
        </div>
      </div>
      <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
        {source === "sample" ? <>A sample survey (page {samplePage + 1} of {PREVIEW_PAGES.length}: {["choices", "grid and rating scale", "carousel and open answers"][samplePage]}) — click answers, use Next / Back to move through it. &ldquo;This survey&rdquo; shows your own first page.</> : <>The first page of {s.def.meta.title || "this survey"}, with this look. Answers you click here are not saved.</>}
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

  /* IM8: the brand book as a PDF — its stated colours become the generator's seeds, its typeface the font */
  const [guideFonts, setGuideFonts] = React.useState<string[] | null>(null);
  const fromGuide = async (file: File) => {
    if (sandboxed) return;
    setBusy(true); setError(null); setGenerated(null); setDetectedColors(null); setGuideFonts(null);
    setSiteStatus("Reading the brand guidelines…");
    try {
      const fd = new FormData(); fd.append("file", file);
      const res = await fetch(`/api/surveys/${s.surveyDbId}/brand-guide`, { method: "POST", body: fd });
      const data = await res.json().catch(() => ({ ok: false, error: "That didn't come back as a usable response." }));
      const rgbs = data.ok && Array.isArray(data.seeds) ? (data.seeds as { hex: string }[]).map((x) => hexToRgb(x.hex)).filter((x: RGB | null): x is RGB => !!x) : [];
      if (rgbs.length) {
        fromRgbSeeds(rgbs);
        setDetectedColors(data.seeds);
        if (Array.isArray(data.fonts) && data.fonts.length) setGuideFonts(data.fonts);
        setSiteStatus(`Found ${rgbs.length} brand colour${rgbs.length === 1 ? "" : "s"}${data.fonts?.length ? ` and the typeface ${data.fonts[0]}` : ""} in the guidelines.`);
        return;
      }
      setSiteStatus(null);
      setError(data.error || "No colours are stated in that PDF as text — enter the brand colour below.");
    } catch {
      setSiteStatus(null);
      setError("Couldn't read the guidelines — try entering a colour below.");
    } finally { setBusy(false); }
  };

  /* the generated palette is shown in the live preview until it is applied or dismissed */
  React.useEffect(() => {
    themePreviewStore.set(generated ? Branding.parse({ ...b, colors: { ...b.colors, ...generated } }) : null);
    return () => themePreviewStore.set(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generated]);
  const apply = () => {
    if (!generated) return;
    if (guideFonts?.length) set((x) => { x.typography = { ...x.typography, fontFamily: `${guideFonts[0]}, system-ui, sans-serif` }; });
    set((x) => { x.colors = { ...x.colors, ...generated }; });
    setGenerated(null);
    s.toast("Palette applied — every colour can still be tweaked under Colours");
  };

  return (
    <div className="card" style={{ padding: 12, marginTop: 4 }} data-testid="theme-generator">
      <div className="bw-sources">
        <div className="bw-source">
          <b>From your website</b>
          <small className="bw-hint">We read its colours (and fonts) and build a palette.</small>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <input className="input grow" placeholder="https://example.com" value={siteUrl}
              disabled={sandboxed} data-testid="brand-url-input" aria-label="Import brand from URL"
              onChange={(e) => setSiteUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void fromUrl(); } }} />
            <button type="button" className="btn" disabled={!siteUrl.trim() || busy || sandboxed} data-testid="analyze-brand-url"
              onClick={() => void fromUrl()} title={sandboxed ? "Save the survey first — brand analysis needs a saved survey." : "Analyze this website's colors and generate a theme from them"}>
              {busy && siteStatus ? "Analyzing…" : "Analyze"}
            </button>
          </div>
        </div>
        <div className="bw-source">
          <b>From a document or your logo</b>
          <small className="bw-hint">A brand-guidelines PDF, or the logo set under Page &amp; logo.</small>
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            <label className="btn" data-testid="brand-guide-upload" title={sandboxed ? "Save the survey first — reading guidelines needs a saved survey." : "Read the colours and typeface from a brand-guidelines PDF"} style={{ cursor: sandboxed || busy ? "not-allowed" : "pointer", opacity: sandboxed || busy ? 0.6 : 1 }}>
              Brand guidelines (PDF)
              <input type="file" accept="application/pdf" hidden disabled={sandboxed || busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void fromGuide(f); }} />
            </label>
            <button type="button" className="btn" disabled={!b.logoUrl || busy} data-testid="detect-logo-colors" onClick={() => void fromLogo()}
              title={b.logoUrl ? "Analyze the logo and generate a palette from its colors" : "Add a logo under Page & logo first"}>
              {busy && !siteStatus ? "Analyzing…" : "Logo colours"}
            </button>
          </div>
        </div>
        <div className="bw-source">
          <b>From one brand colour</b>
          <small className="bw-hint">We derive the rest of the palette from it.</small>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <input type="color" value={brandHex} onChange={(e) => setBrandHex(e.target.value)} aria-label="Brand color"
              style={{ width: 34, height: 34, padding: 0, border: "1px solid var(--border)", background: "none", borderRadius: 6, flex: "none" }} />
            <input className="input mono" style={{ width: 96 }} value={brandHex} onChange={(e) => setBrandHex(e.target.value)} />
            <button type="button" className="btn" data-testid="generate-from-hex" onClick={fromHex}>Generate</button>
          </div>
        </div>
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
          <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>Showing in the live preview — nothing has changed yet.</p>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <button type="button" className="btn primary small" data-testid="apply-generated-palette" onClick={apply}>Use this palette</button>
            <button type="button" className="btn small" data-testid="dismiss-generated-palette" onClick={() => setGenerated(null)}>Dismiss</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================================================== the Branding workspace (2026-11-07 redesign) */

/**
 * THE SAME SETTINGS, ORGANISED BY WHAT THEY CHANGE (Branding redesign, 2026-11-07).
 *
 * Every control the panel had is still here, with the same data-testids and the same writes to the definition.
 * What changed is how they are presented:
 *   - "Start from" puts the four ways to get a whole look in one place: a preset, your brand (website / PDF / logo
 *     / colour), a description for the AI, a workspace theme.
 *   - The settings are grouped by the part of the respondent's page they change (Colours, Text, Page, Answers &
 *     inputs, Background, Buttons & navigation, Respondent experience, Phone & tablet, AI interviewer, Code), one
 *     group at a time, each with a sentence saying what it is for. The settings most people need come first; the
 *     rest are under "More …" in the same group, and "Show everything" lays every group out on one page.
 *   - Pointing at a setting, or opening a group, outlines what it affects in the live preview; every change is
 *     named in the preview's "Just changed" list (before → after, and what it affects) with Undo.
 */
type SectionId = "colors" | "text" | "page" | "answers" | "background" | "buttons" | "experience" | "devices" | "ai" | "code";
interface SectionDef { id: SectionId; label: string; desc: string; region: PreviewRegion; device?: "tablet" | "mobile"; keywords: string }

const SECTIONS: SectionDef[] = [
  { id: "colors", label: "Colours", region: "buttons", desc: "Four colours set the whole look; fine-tune individual elements only if you need to.", keywords: "colour color primary secondary background surface text subtle border error accent heading link input button progress palette" },
  { id: "text", label: "Text", region: "text", desc: "The font and size respondents read in, and how question text is set.", keywords: "font family size typography heading weight line height letter spacing question size" },
  { id: "page", label: "Page & logo", region: "page", desc: "How wide the survey is, how questions are framed, and the logo at the top.", keywords: "width full contained max width align alignment card style flat line radius corner spacing logo position progress bar" },
  { id: "answers", label: "Style & answers", region: "options", desc: "The theme's style (decorations, motion) and how answer choices, grids, scales and text boxes look — selection cards (tiles) replace radio buttons and checkboxes.", keywords: "theme style motif peach kids robotics creative illustrations motion animation tiles selection cards options look cards pills minimal radio checkbox inputs filled underline shadow padding border gap tint focus button radius progress height logo height" },
  { id: "background", label: "Background", region: "page", desc: "An image or gradient behind the survey, with an overlay to keep text readable.", keywords: "background image gradient overlay fit cover contain repeat fixed scroll" },
  { id: "buttons", label: "Buttons & navigation", region: "buttons", desc: "The Next / Back / Submit buttons and how respondents move between sections.", keywords: "button next back submit label style solid outline pill navigation section visited free jump" },
  { id: "experience", label: "Respondent experience", region: "options", desc: "Behaviour respondents notice: moving on automatically, question numbers, answer letters, block headings.", keywords: "auto next advance automatic question numbers option labels letters numbering block names headings" },
  { id: "devices", label: "Phone & tablet", region: "page", device: "mobile", desc: "Sizes that change on smaller screens. Empty means the same as on a computer.", keywords: "phone mobile tablet responsive small screen" },
  { id: "ai", label: "AI interviewer", region: "page", desc: "Run the survey as a text or voice conversation — the questions, logic and data stay the same.", keywords: "ai conversational voice text interviewer probing adaptive follow-up" },
  { id: "code", label: "Code & custom", region: "page", desc: "For programmers: survey-wide styles, animations and scripts, custom header / footer HTML and CSS.", keywords: "css html header footer script style animation behaviour custom code javascript" },
];

/** points the live preview at what a group of settings changes, while the pointer or keyboard focus is on it */
function Zone({ region, children, className, style }: { region: PreviewRegion; children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={className} style={style} data-zone={region}
      onMouseEnter={() => brandingFocus.setHover(region)} onMouseLeave={() => brandingFocus.setHover(null)}
      onFocusCapture={() => brandingFocus.setHover(region)} onBlurCapture={() => brandingFocus.setHover(null)}>
      {children}
    </div>
  );
}

/** the rest of a group's settings, one click away */
function More({ label, children, testId, open }: { label: string; children: React.ReactNode; testId?: string; open?: boolean }) {
  return (
    <details className="bw-more" data-testid={testId} open={open}>
      <summary>{label}</summary>
      <div className="bw-more-body">{children}</div>
    </details>
  );
}

const FONT_CHOICES = ["Inter, system-ui, sans-serif", "system-ui, sans-serif", "Georgia, 'Times New Roman', serif", "'Helvetica Neue', Arial, sans-serif", "Verdana, sans-serif", "'Trebuchet MS', sans-serif", "Merriweather, Georgia, serif", "'Source Sans 3', sans-serif", "Roboto, sans-serif", "'Open Sans', sans-serif", "Lato, sans-serif"];

/** READABILITY, AS YOU PICK: the colour pairs respondents actually read, checked against WCAG AA (4.5:1) */
function ContrastCheck({ b }: { b: Branding }) {
  const pairs: [string, string | undefined, string | undefined][] = [
    ["Text on cards", b.colors.text, b.colors.surface],
    ["Question text on cards", b.colors.heading ?? b.colors.text, b.colors.surface],
    ["Text on the page", b.colors.text, b.colors.background],
    ["Button label on the button", b.colors.buttonText ?? "#ffffff", b.colors.buttonBackground ?? b.colors.primary],
    ["Hints on cards", b.colors.subtleText, b.colors.surface],
  ];
  const rows = pairs.flatMap(([label, fg, bg]) => {
    const a = fg ? hexToRgb(fg) : null, c = bg ? hexToRgb(bg) : null;
    return a && c ? [{ label, ratio: contrastRatio(a, c) }] : [];
  });
  const weak = rows.filter((r) => r.ratio < 4.5);
  return (
    <div className={`bw-contrast${weak.length ? " warn" : ""}`} data-testid="branding-contrast">
      {weak.length
        ? <>Hard to read: {weak.map((r) => `${r.label} ${r.ratio.toFixed(1)}:1`).join(" · ")} — aim for 4.5:1 or more.</>
        : <>Readable: every text colour has at least 4.5:1 contrast with what it sits on.</>}
    </div>
  );
}

/**
 * A PRESET ON TOP OF THIS SURVEY'S LOOK. A preset sets colours, type, layout and buttons; it used to REPLACE each of
 * those objects whole, which silently switched off settings it does not mention (auto-next, question numbers,
 * option letters). Merged one level down, it changes what it names and keeps the rest — except the colours, which
 * are one palette and are replaced together.
 */
/** set as one piece by a preset: a palette, a type system, a background */
const WHOLE = new Set(["colors", "typography", "background"]);
function withPreset(b: Branding, preset: Partial<Branding>): Branding {
  const out: Record<string, unknown> = { ...b };
  for (const [k, v] of Object.entries(preset)) {
    const cur = (b as unknown as Record<string, unknown>)[k];
    /* colours are a palette: a preset replaces it whole, so a fine-tuned heading or button colour from the old look does not survive on the new background */
    out[k] = !WHOLE.has(k) && v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" ? { ...(cur as object), ...(v as object) } : v;
  }
  /* a preset with no background means none: the previous theme's gradient does not linger behind the new one */
  if (!("background" in preset)) delete out.background;
  return Branding.parse(out);
}

/** "Start from": the four ways to get a whole look */
function StartFrom({ b, set, showAll }: { b: Branding; set(path: (draft: Branding) => void): void; showAll?: boolean }) {
  const s = useStudio();
  const [tab, setTab] = React.useState<"preset" | "brand" | "ai" | "workspace">("preset");
  const tabs = [
    ["preset", "A preset", "Ready-made looks"],
    ["brand", "Your brand", "Website, guidelines PDF, logo or colour"],
    ["ai", "Describe it", "Tell the AI the look you want"],
    ...(s.surveyDbId === "sandbox" ? [] : [["workspace", "Workspace theme", "Your team's saved looks"]]),
  ] as [typeof tab, string, string][];
  return (
    <section className="bw-start" data-testid="branding-start">
      <div className="bw-start-head">
        <b>Start from</b>
        <span className="muted">Pick a starting point — everything it sets stays editable in the groups below.</span>
      </div>
      <div className="bw-start-tabs" role="tablist">
        {tabs.map(([id, label, hint]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`bw-start-tab${tab === id ? " on" : ""}`} data-testid={`branding-start-${id}`} onClick={() => setTab(id)}>
            <span>{label}</span><small>{hint}</small>
          </button>
        ))}
      </div>
      <div className="bw-start-body">
        {(showAll ? tabs.map(([id]) => id) : [tab]).map((cur) => <React.Fragment key={cur}>
        {showAll && <h4 className="bw-sub">{tabs.find(([id]) => id === cur)![1]}</h4>}
        {cur === "preset" && (
          <div className="bw-presets" data-testid="branding-presets">
            {THEME_PRESETS.map((t) => {
              const c = t.branding.colors;
              return (
                <button key={t.name} type="button" className="bw-preset" data-testid={`branding-preset-${t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                  onMouseEnter={() => themePreviewStore.set(withPreset(b, t.branding))} onMouseLeave={() => themePreviewStore.set(null)}
                  onFocus={() => themePreviewStore.set(withPreset(b, t.branding))} onBlur={() => themePreviewStore.set(null)}
                  onClick={() => { themePreviewStore.set(null); s.labelNextEdit(`apply ${t.name} theme`); s.update((d) => { d.branding = withPreset(d.branding, t.branding); }); s.toast(`Applied "${t.name}" theme`); }}>
                  <span className="bw-preset-swatch" style={{ background: c?.background ?? "#fff", borderColor: c?.border ?? "#ddd" }}>
                    <i style={{ background: c?.surface ?? "#fff", borderColor: c?.border ?? "#ddd" }}><em style={{ background: c?.primary ?? "#333" }} /><em style={{ background: c?.text ?? "#111", opacity: .6 }} /></i>
                  </span>
                  <b>{t.name}</b>
                  <small>{t.description}</small>
                </button>
              );
            })}
            <p className="muted bw-note">Point at a preset to see it in the preview; click to apply. Undo puts the previous look back.</p>
          </div>
        )}
        {cur === "brand" && (
          <div>
            <p className="muted bw-note">Analyse your website, read a brand-guidelines PDF, take the colours from your logo, or start from one brand colour. You review the palette before anything changes.</p>
            <ThemeGenerator b={b} set={set} />
          </div>
        )}
        {cur === "ai" && <ThemeAssistant />}
        {cur === "workspace" && (
          <div>
            <p className="muted bw-note">Apply a look your team saved, or save this one so other surveys in the workspace can use it.</p>
            <WorkspaceThemes />
          </div>
        )}
        </React.Fragment>)}
      </div>
    </section>
  );
}

/** Branding / theming (requirement §19) + presets (§20) — the guided workspace */
export function BrandingPanel() {
  const s = useStudio();
  const b = s.def.branding;
  const set = (path: (draft: typeof b) => void) => s.update((d) => path(d.branding));
  const [active, setActive] = React.useState<SectionId>("colors");
  const [showAll, setShowAll] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const open = React.useCallback((id: SectionId) => {
    setActive(id);
    const sec = SECTIONS.find((x) => x.id === id)!;
    brandingFocus.setRegion(sec.region, sec.device ?? null);
  }, []);
  React.useEffect(() => { open("colors"); return () => { brandingFocus.setRegion(null); brandingFocus.setHover(null); }; }, [open]);

  const q = query.trim().toLowerCase();
  const matches = q ? SECTIONS.filter((x) => `${x.label} ${x.desc} ${x.keywords}`.toLowerCase().includes(q)) : SECTIONS;
  React.useEffect(() => { if (q && matches.length && !matches.some((m) => m.id === active)) open(matches[0]!.id); }, [q, matches, active, open]);

  const body: Record<SectionId, React.ReactNode> = {
    colors: (
      <>
        <Zone region="buttons" className="bw-colors">
          <div className="bw-color-row">
            <Zone region="buttons"><Color label="Primary" value={b.colors.primary} onChange={(v) => set((x) => { x.colors.primary = v; })} /><small className="bw-hint">Buttons, selected answers, progress</small></Zone>
            <Zone region="page"><Color label="Background" value={b.colors.background} onChange={(v) => set((x) => { x.colors.background = v; })} /><small className="bw-hint">The page behind the questions</small></Zone>
            <Zone region="cards"><Color label="Surface" value={b.colors.surface} onChange={(v) => set((x) => { x.colors.surface = v; })} /><small className="bw-hint">The cards questions sit on</small></Zone>
            <Zone region="text"><Color label="Text" value={b.colors.text} onChange={(v) => set((x) => { x.colors.text = v; })} /><small className="bw-hint">Questions and answers</small></Zone>
          </div>
        </Zone>
        <ContrastCheck b={b} />
        <More label="More colours — secondary, hints, borders, errors" testId="branding-more-colors">
          <div className="bw-color-row">
            <Zone region="buttons"><Color label="Secondary" value={b.colors.secondary} onChange={(v) => set((x) => { x.colors.secondary = v; })} /><small className="bw-hint">Back button, accents</small></Zone>
            <Zone region="hints"><Color label="Subtle" value={b.colors.subtleText} onChange={(v) => set((x) => { x.colors.subtleText = v; })} /><small className="bw-hint">Instructions, hints</small></Zone>
            <Zone region="cards"><Color label="Border" value={b.colors.border} onChange={(v) => set((x) => { x.colors.border = v; })} /><small className="bw-hint">Card, option, input edges</small></Zone>
            <Zone region="error"><Color label="Error" value={b.colors.error} onChange={(v) => set((x) => { x.colors.error = v; })} /><small className="bw-hint">Validation messages</small></Zone>
          </div>
        </More>
        <More label="Fine-tune single elements — unset ones follow the colours above" testId="branding-fine-colors" open={!!(b.colors.accent || b.colors.heading || b.colors.link || b.colors.inputBackground || b.colors.buttonBackground || b.colors.buttonText || b.colors.progress)}>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <Zone region="options"><OptionalColor label="Accent" value={b.colors.accent} inherits={b.colors.primary} onChange={(v) => set((x) => { x.colors.accent = v; })} /></Zone>
            <Zone region="text"><OptionalColor label="Heading" value={b.colors.heading} inherits={b.colors.text} onChange={(v) => set((x) => { x.colors.heading = v; })} /></Zone>
            <Zone region="text"><OptionalColor label="Link" value={b.colors.link} inherits={b.colors.accent ?? b.colors.primary} onChange={(v) => set((x) => { x.colors.link = v; })} /></Zone>
            <Zone region="inputs"><OptionalColor label="Input bg" value={b.colors.inputBackground} inherits={b.colors.surface} onChange={(v) => set((x) => { x.colors.inputBackground = v; })} /></Zone>
            <Zone region="buttons"><OptionalColor label="Button bg" value={b.colors.buttonBackground} inherits={b.colors.primary} onChange={(v) => set((x) => { x.colors.buttonBackground = v; })} /></Zone>
            <Zone region="buttons"><OptionalColor label="Button text" value={b.colors.buttonText} inherits="#ffffff" onChange={(v) => set((x) => { x.colors.buttonText = v; })} /></Zone>
            <Zone region="progress"><OptionalColor label="Progress" value={b.colors.progress} inherits={b.colors.accent ?? b.colors.primary} onChange={(v) => set((x) => { x.colors.progress = v; })} /></Zone>
          </div>
        </More>
      </>
    ),
    text: (
      <Zone region="text">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <label className="f" style={{ width: 280 }}><span>Font family</span>
            <input className="input" list="bw-fonts" value={b.typography.fontFamily}
              onChange={(e) => set((x) => { x.typography.fontFamily = e.target.value; })} />
            <datalist id="bw-fonts">{FONT_CHOICES.map((f) => <option key={f} value={f} />)}</datalist>
            <small className="bw-hint">Pick from the list or type any CSS font stack</small></label>
          <label className="f" style={{ width: 110 }}><span>Base size</span>
            <input className="input" value={b.typography.baseSize}
              onChange={(e) => set((x) => { x.typography.baseSize = e.target.value; })} />
            <small className="bw-hint">16px is standard</small></label>
        </div>
        <More label="More text settings — question font, weight, size, line height, letter spacing, progress style" testId="branding-more-text">
          <TypographyMore b={b} set={set} />
        </More>
      </Zone>
    ),
    page: (
      <>
        <Zone region="page">
          <div className="row" style={{ flexWrap: "wrap" }}>
            <label className="f" style={{ width: 150 }} title="Full-width uses the whole browser window on desktop, like a modern web app. Contained keeps the classic centered card at Max width below.">
              <span>Desktop width</span>
              <select className="select" data-testid="branding-width-mode" value={b.layout.widthMode}
                onChange={(e) => set((x) => { x.layout.widthMode = e.target.value as any; })}>
                <option value="full">full width</option>
                <option value="contained">contained</option>
              </select>
              <small className="bw-hint">{b.layout.widthMode === "full" ? "Uses the whole window on a computer" : "A centred column, Max width wide"}</small></label>
            {b.layout.widthMode !== "full" && (
              <label className="f" style={{ width: 110 }}><span>Max width</span>
                <input className="input" value={b.layout.maxWidth}
                  onChange={(e) => set((x) => { x.layout.maxWidth = e.target.value; })} /></label>
            )}
            <label className="f" style={{ width: 130 }} title="How question text lines up inside the survey's column — the column itself is always centred on the page. Left follows the language's direction (right for RTL), Center suits a branding-forward look.">
              <span>Content align</span>
              <select className="select" data-testid="branding-content-align" value={b.layout.contentAlign}
                onChange={(e) => set((x) => { x.layout.contentAlign = e.target.value as any; })}>
                <option value="left">left</option>
                <option value="center">center</option>
                <option value="right">right</option>
              </select></label>
            <label className="f" style={{ width: 120 }}><span>Spacing</span>
              <select className="select" value={b.layout.spacing}
                onChange={(e) => set((x) => { x.layout.spacing = e.target.value as any; })}>
                <option value="compact">compact</option><option value="regular">regular</option><option value="relaxed">relaxed</option>
              </select></label>
          </div>
        </Zone>
        <Zone region="cards">
          <div className="row" style={{ flexWrap: "wrap" }}>
            <label className="f" style={{ width: 130 }}><span>Card style</span>
              <select className="select" value={b.layout.cardStyle}
                onChange={(e) => set((x) => { x.layout.cardStyle = e.target.value as any; })}>
                <option value="card">card</option><option value="flat">flat</option><option value="line">line</option>
              </select>
              <small className="bw-hint">How each question is framed</small></label>
            <label className="f" style={{ width: 110 }}><span>Radius</span>
              <input className="input" value={b.layout.radius}
                onChange={(e) => set((x) => { x.layout.radius = e.target.value; })} />
              <small className="bw-hint">0px is square</small></label>
          </div>
        </Zone>
        <Zone region="progress">
          <label className="f" style={{ width: 160 }}><span>Progress bar</span>
            <select className="select" data-testid="branding-progress-bar" value={b.layout.progressBar}
              onChange={(e) => set((x) => { x.layout.progressBar = e.target.value as any; })}>
              <option value="top">top</option><option value="bottom">bottom</option><option value="none">none</option>
            </select></label>
        </Zone>
        <Zone region="logo">
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
        </Zone>
      </>
    ),
    answers: <Zone region="options"><AppearanceSection b={b} set={set} /></Zone>,
    background: <Zone region="page"><BackgroundSection b={b} set={set} /></Zone>,
    buttons: (
      <>
        <Zone region="buttons">
          <div className="row" style={{ flexWrap: "wrap" }}>
            <label className="f" style={{ width: 110 }}><span>Style</span>
              <select className="select" value={b.buttons.style}
                onChange={(e) => set((x) => { x.buttons.style = e.target.value as any; })}>
                <option value="solid">solid</option><option value="outline">outline</option><option value="pill">pill</option>
              </select></label>
            <label className="f" style={{ width: 120 }}><span>Next label</span>
              <input className="input" value={b.buttons.nextLabel}
                onChange={(e) => set((x) => { x.buttons.nextLabel = e.target.value; })} /></label>
            <label className="f" style={{ width: 120 }}><span>Back label</span>
              <input className="input" value={b.buttons.backLabel}
                onChange={(e) => set((x) => { x.buttons.backLabel = e.target.value; })} /></label>
            <label className="f" style={{ width: 120 }}><span>Submit label</span>
              <input className="input" value={b.buttons.submitLabel}
                onChange={(e) => set((x) => { x.buttons.submitLabel = e.target.value; })} />
              <small className="bw-hint">Shown on the last page</small></label>
            <label className="row" style={{ gap: 4, alignSelf: "center" }}>
              <input type="checkbox" checked={b.buttons.showBack}
                onChange={(e) => set((x) => { x.buttons.showBack = e.target.checked; })} /> show back button
            </label>
          </div>
        </Zone>
        {/*
          * SECTION NAVIGATION (2026-10-30, engine sectionNav.ts): a survey-level behaviour (def.navigation), beside
          * the Back button because it is the same question — how a respondent moves.
          */}
        <Zone region="nav">
          <h4 className="bw-sub" id="navigation">Moving between sections</h4>
          <div data-testid="nav-settings">
            {([
              ["off", "Off", "Next and Back only — the survey as it has always run."],
              ["visited", "Visited sections", "A bar of the survey's sections: back to any earlier section, forward only to sections already visited."],
              ["free", "Free", "Jump to any section reachable with the answers so far."],
            ] as const).map(([value, label, hint]) => (
              <label key={value} className="row" style={{ gap: 6, alignItems: "flex-start", marginBottom: 6 }}>
                <input type="radio" name="section-nav" value={value} data-testid={`nav-mode-${value}`}
                  checked={(s.def.navigation?.sectionNav ?? "off") === value}
                  onChange={() => s.update((d) => { d.navigation = { sectionNav: value, position: d.navigation?.position ?? "top" }; })} />
                <span><b>{label}</b> <span className="muted">— {hint}</span></span>
              </label>
            ))}
            {(s.def.navigation?.sectionNav ?? "off") !== "off" && (
              <>
                <label className="f" style={{ width: 220 }}><span>Position</span>
                  <select className="select" data-testid="nav-position" value={s.def.navigation?.position ?? "top"}
                    onChange={(e) => s.update((d) => { d.navigation = { sectionNav: d.navigation?.sectionNav ?? "visited", position: e.target.value as "top" | "side" }; })}>
                    <option value="top">Bar above the page</option>
                    <option value="side">Side rail (wide screens)</option>
                  </select></label>
                <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
                  The navigator lists the survey&apos;s blocks — give each section its own block. It never jumps past an end, a quota check or a skip rule that fires, or to a page hidden by logic.
                </p>
                {s.def.navigation?.sectionNav === "free" && (
                  <p className="muted" data-testid="nav-free-note" style={{ fontSize: 12, margin: "4px 0 0" }}>
                    Pages a respondent jumps over are not checked when they jump: required questions left unanswered are listed per section at Submit, and Submit waits until they are answered. In an assessment, unanswered questions count as unattempted and Submit only asks the respondent to confirm.
                  </p>
                )}
              </>
            )}
          </div>
        </Zone>
      </>
    ),
    experience: (
      <div className="bw-cards">
        <Zone region="options" className="bw-choice">
          <label className="row" style={{ gap: 8, alignItems: "flex-start" }} title="Single-answer questions (single choice, buttons, stars, NPS, a single-choice grid once every row is answered) move the page on when answered; multi-selects and open ends wait for Next. Each question can override this.">
            <input type="checkbox" data-testid="branding-auto-advance" checked={!!b.layout.autoAdvance} style={{ width: 16, height: 16, flex: "none", marginTop: 3 }}
              onChange={(e) => set((x) => { x.layout.autoAdvance = e.target.checked || undefined; })} />
            <span><b>Auto-next on single-answer questions</b>
              <small className="bw-hint">Picking an answer moves the page on — single choice, buttons, stars, NPS, a single-choice grid once every row is answered. Multi-selects, open answers, sliders and rankings still wait for Next. Each question can override this (Question › Auto-next).</small></span>
          </label>
        </Zone>
        <Zone region="text" className="bw-choice">
          <label className="f" style={{ width: 220 }} title="Numbers shown before each question's text — display only; codes and exports are unchanged">
            <span>Question numbers</span>
            <select className="select" data-testid="branding-question-numbers" value={b.layout.questionNumbers ?? "none"}
              onChange={(e) => set((x) => { x.layout.questionNumbers = e.target.value === "none" ? undefined : e.target.value as never; })}>
              <option value="none">not shown</option><option value="code">question code (Q7.)</option><option value="sequence">1, 2, 3…</option>
            </select>
            <small className="bw-hint">Display only — codes and exports don&apos;t change</small></label>
        </Zone>
        <Zone region="options" className="bw-choice">
          <label className="f" style={{ width: 220 }} title="A letter or number before each choice of a list question — display only">
            <span>Option labels</span>
            <select className="select" data-testid="branding-option-numbering" value={b.layout.optionNumbering ?? "none"}
              onChange={(e) => set((x) => { x.layout.optionNumbering = e.target.value === "none" ? undefined : e.target.value as never; })}>
              <option value="none">plain</option><option value="letters">A. B. C.</option><option value="numbers">1. 2. 3.</option>
            </select>
            <small className="bw-hint">A letter or number before each answer</small></label>
        </Zone>
        <Zone region="text" className="bw-choice">
          <label className="f" style={{ width: 240 }} title="Block names always show in the Studio. This decides whether respondents see them as page headings. A block can override it in its ••• menu.">
            <span>Block names</span>
            <select className="select" data-testid="show-block-titles"
              value={b.layout.showBlockTitles ? "show" : "hide"}
              onChange={(e) => set((x) => { x.layout.showBlockTitles = e.target.value === "show"; })}>
              <option value="show">shown to respondents</option>
              <option value="hide">hidden from respondents</option>
            </select>
            <small className="bw-hint">As page headings; a block can override it</small></label>
        </Zone>
      </div>
    ),
    devices: <Zone region="page"><ResponsiveSection b={b} set={set} /></Zone>,
    ai: <AiConversationSection />,
    code: (
      <>
        <h4 className="bw-sub">Styles, animations &amp; scripts (survey-wide)</h4>
        <UxItemsEditor scope={{ kind: "survey" }} intro="For the whole survey, its buttons, progress bar and navigation — scoped to this survey. Created here or by Intelligent mode; the same settings." />
        <h4 className="bw-sub">Header, footer &amp; custom CSS</h4>
        <div className="f"><span>Header HTML</span>
          <CodeEditor language="html" value={b.headerHtml ?? ""} minHeight={60} label="Header HTML" testId="branding-header-html" readOnly={s.readOnly}
            onChange={(v) => set((x) => { x.headerHtml = v || undefined; })} /></div>
        <div className="f"><span>Footer HTML</span>
          <CodeEditor language="html" value={b.footerHtml ?? ""} minHeight={60} label="Footer HTML" testId="branding-footer-html" readOnly={s.readOnly}
            onChange={(v) => set((x) => { x.footerHtml = v || undefined; })} /></div>
        <div className="f"><span>Custom CSS (survey-wide)</span>
          <CodeEditor language="css" value={b.customCss ?? ""} minHeight={90} label="Custom CSS (survey-wide)" testId="branding-custom-css" readOnly={s.readOnly}
            onChange={(v) => set((x) => { x.customCss = v || undefined; })} /></div>
        {/* survey-wide JavaScript is a script in the list above — the same sandboxed pipeline as everything else */}
      </>
    ),
  };

  const visible = showAll ? matches : matches.filter((x) => x.id === active);
  return (
    <div className="bw" data-testid="branding-workspace">
      <div className="bw-head">
        <div>
          <h2 style={{ margin: 0, fontSize: 17 }}>Branding &amp; Theme</h2>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 12.5 }}>How respondents see this survey. Every change shows in the live preview — what it touches is outlined, and named under &ldquo;Just changed&rdquo;.</p>
        </div>
        <span className="grow" />
        <button className="btn small" disabled={!s.canUndo} onClick={() => s.undo()} data-testid="branding-undo" title="Undo the last change">↶ Undo</button>
      </div>
      {b.themeId && (
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }} data-testid="theme-origin">
          This survey&apos;s look came from a workspace theme. Editing anything here changes only
          this survey — save it again as a theme to share the change.
        </p>
      )}

      <StartFrom b={b} set={set} showAll={showAll} />

      <div className="bw-nav">
        <div className="bw-search">
          <input className="input" placeholder="Find a setting — e.g. radius, logo, auto-next" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="branding-search" aria-label="Find a setting" />
        </div>
        <div className="bw-tabs" role="tablist" aria-label="Setting groups">
          {matches.map((x) => (
            <button key={x.id} role="tab" aria-selected={!showAll && active === x.id} className={`bw-tab${!showAll && active === x.id ? " on" : ""}`} data-testid={`branding-tab-${x.id}`}
              onClick={() => { setShowAll(false); open(x.id); }}>{x.label}</button>
          ))}
          {!matches.length && <span className="muted" style={{ fontSize: 12.5 }}>No setting matches “{query}”.</span>}
          <span className="grow" />
          <label className="bw-all"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} data-testid="branding-show-all" /> Show everything</label>
        </div>
      </div>

      {visible.map((x) => (
        <section key={x.id} className="bw-section" data-testid={`branding-section-${x.id}`}
          onMouseEnter={showAll ? () => brandingFocus.setRegion(x.region, x.device ?? null) : undefined}>
          <h3 className="sec" style={{ marginTop: showAll ? 22 : 12 }}>{x.label}</h3>
          <p className="muted bw-desc">{x.desc}</p>
          {body[x.id]}
        </section>
      ))}
    </div>
  );
}

/**
 * A logic script's code, saved only when the code gate passes (S0b D3) — the way UxItemsEditor saves a behaviour
 * script: typed into a draft, checked when the field is left (or "Save code"), refused with the reasons.
 */
function ScriptCodeField({ code, refusal, onRefusal, onSave, def, label, header, itemKey, scriptId }: { code: string; refusal?: string[]; onRefusal(errors: string[] | undefined): void; onSave(code: string): void; def: SurveyDefinition; label: string; header?: React.ReactNode; itemKey?: string; scriptId?: string }) {
  const [draft, setDraft] = React.useState(code);
  const tools = useScriptTools({ itemKey: itemKey ?? null, code: draft, def, run: scriptId ? { kind: "logic", id: scriptId } : null });
  React.useEffect(() => { setDraft(code); }, [code]);
  const dirty = draft !== code;
  const save = () => {
    if (!dirty) { onRefusal(undefined); return; }
    const v = draft.trim() ? codeGate(draft, "logic") : { ok: true, errors: [] as string[] };
    if (!v.ok) { onRefusal(v.errors); return; }
    onRefusal(undefined);
    onSave(draft);
  };
  return (
    <div>
      <CodeEditor language="js" kind="logic" def={def} value={draft} testId="script-code" label={label} header={<>{header}{tools.buttons}</>} showRefs minHeight={120} extraDiagnostics={tools.diagnostics}
        placeholder={`// e.g. total of three questions\nconst total = expr('Q1 + Q2 + Q3');\nsetCalc('TOTAL', total);\nif (total > 100) flag('over_100');`}
        onChange={setDraft} onCommit={save} />
      {tools.panels}
      {dirty && <div className="row" style={{ gap: 6, marginTop: 4 }}>
        <button type="button" className="btn small primary" onClick={save} data-testid="script-save">Save code</button>
        <button type="button" className="btn small ghost" onClick={() => { setDraft(code); onRefusal(undefined); }}>Discard changes</button>
      </div>}
      {refusal?.length ? (
        <div className="ux-errors" role="alert" data-testid="script-refused" style={{ color: "var(--danger, #b42318)", fontSize: 12.5, marginTop: 4 }}>
          Not saved — the script check refused it:
          <ul style={{ margin: "4px 0 0 18px" }}>{refusal.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}

/** one Scripts-panel logic script, editable (the Scripts panel's list, and Research tools → All code in place) */
export function LogicScriptCard({ index: i, refusal, setRefusal }: { index: number; refusal?: string[]; setRefusal(errs: string[] | undefined): void }) {
  const s = useStudio();
  const sc = s.def.scripts[i];
  if (!sc) return null;
  return (
      <div className="card" data-testid="logic-script-card" data-id={sc.id}>
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
            <input type="checkbox" checked={sc.enabled} data-testid="script-enabled"
              onChange={(e) => {
                /* S0b D3: a script the code gate refuses cannot be switched on (an import arrives off, "pending review") */
                if (e.target.checked && !codeGate(sc.code, "logic").ok) { setRefusal(codeGate(sc.code, "logic").errors); return; }
                s.update((d) => { d.scripts[i].enabled = e.target.checked; });
              }} /> enabled
          </label>
          <span className="grow" />
          {/* S3b (MM-06): a copy, switched off so the two never both run */}
          <button className="btn small ghost" disabled={s.readOnly} title={`Make a copy with a new id. ${DUPLICATE_NOTE}`} data-testid="script-duplicate"
            onClick={() => { const copy = duplicateLogicScript(sc, `script_${Date.now().toString(36)}`); s.labelNextEdit(`Duplicate script “${sc.name}”`); s.update((d) => { d.scripts.splice(i + 1, 0, copy); }); s.toast(`Copied as “${copy.name}”. ${DUPLICATE_NOTE}`); }}>Duplicate</button>
          <button className="btn small danger" onClick={() => s.update((d) => { d.scripts.splice(i, 1); })}>×</button>
        </div>
        <ScriptCodeField code={sc.code} refusal={refusal} def={s.def} label={`Script “${sc.name}” code`} header={<ScriptHealthChip scriptId={sc.id} />} itemKey={`logic_script:${sc.id}`} scriptId={sc.id}
          onRefusal={setRefusal}
          onSave={(code) => { s.labelNextEdit(`Edit script “${sc.name}”`); s.update((d) => { d.scripts[i].code = code; }); }} />
        <div style={{ marginTop: 6 }} data-testid="script-when">
          <OptionalCondition label="Run only when" value={sc.when}
            hint="Otherwise the script runs for every respondent at its event."
            onChange={(when) => s.update((d) => { d.scripts[i].when = when; })} />
        </div>
      </div>
  );
}

export function ScriptsPanel() {
  const s = useStudio();
  const [refusal, setRefusal] = React.useState<Record<string, string[] | undefined>>({});
  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Custom Scripts</h2>
      </div>
      <ScriptHealthSummaryBar />
      <LegacyScriptsBanner />
      <p className="muted" style={{ fontSize: 13 }}>
        Scripts run in a sandboxed frame (never on the respondent&apos;s page) with this API:{" "}
        <code>get(ref) set(ref, v) getCalc/setCalc getEmbedded/setEmbedded expr(&quot;Q1+Q2&quot;) pipe(&quot;{"{{Q1}}"}&quot;)
        flag(name) log(...) error(msg, ref) loop</code>. Events: on_load, on_change, on_submit, on_validate, on_complete.
      </p>
      <p className="muted" style={{ fontSize: 12.5 }} data-testid="script-gate-note">
        Code is checked before it is saved and again before it runs: it reaches the survey through these helpers only —
        no <code>constructor</code>, <code>globalThis</code>, <code>window</code>, network, storage or <code>navigator</code>;
        loops are allowed and stopped after 100,000 rounds. A refused script does not run; the preview inspector says why.
      </p>
      <p className="muted" style={{ fontSize: 12.5 }} data-testid="script-sandbox-note">
        Writes (<code>set</code>, <code>setCalc</code>, <code>setEmbedded</code>, <code>flag</code>) are requests: they are applied after the
        script returns, checked like a respondent&apos;s answer (a question on screen belongs to the respondent; a refused write is
        logged with the reason). A <code>get</code> later in the same run sees the run&apos;s own writes. on_change runs just after the
        change; on_validate / on_submit may take at most 1.5 s on Next. <code>expr</code> / <code>pipe</code> take their text written out.
      </p>
      {s.def.scripts.map((sc, i) => <LogicScriptCard key={sc.id} index={i} refusal={refusal[sc.id]} setRefusal={(errs) => setRefusal((r) => ({ ...r, [sc.id]: errs }))} />)}
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
