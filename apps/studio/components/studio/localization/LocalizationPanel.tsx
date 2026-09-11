"use client";
import React from "react";
import type { Condition, LanguageConfig } from "@rescript/schema";
import { LANGUAGE_LIBRARY, LANGUAGE_STATUSES, LANGUAGE_ROUTING_MODES, languageInfo } from "@rescript/schema";
import { lintLocalization, lintLanguage, languageName, languageLocale, languageDirection, searchLanguages, translationRows, applyTranslationRows, languageReady, type LanguageReport, type LocalizationIssue } from "@rescript/engine";
import { useLocalization, useEditorName, downloadBlob } from "./shared";
import { TranslationEditor } from "./TranslationEditor";
import { GlossaryEditor } from "./GlossaryEditor";
import { AudioStudio } from "./AudioStudio";
import { openPreview } from "../previewWindow";
import { runtimeBaseUrl } from "@/lib/runtime-url";
import { ConditionEditor, newConditionGroup } from "../ConditionBuilder";
import { uid } from "../store";

/**
 * TRANSLATION & LOCALIZATION — the tab.
 *
 *   Languages   which language versions exist (country → language → locale),
 *               their status, completion and readiness; add from the library
 *   Translate   the translation table; AI / manual / hybrid; bulk translate
 *   Glossary    preferred terms, project and workspace
 *   Voice/Audio record, generate, link; priority; library
 *   QA          the localization report per language, with Fix buttons
 *   Routing     how a respondent gets their language
 *   Import/Export  Excel / CSV / JSON round trip for external translators
 *
 * Everything writes ONE object, `localization`, addressed by stable element
 * keys; the survey's questions, ids, codes and logic are never touched here.
 */

type View = "languages" | "translate" | "glossary" | "audio" | "qa" | "routing" | "files";

export function LocalizationPanel() {
  const { s, loc, setLoc } = useLocalization();
  const editor = useEditorName();
  const [view, setView] = React.useState<View>("languages");
  const [focus, setFocus] = React.useState<string | null>(null);
  const reports = React.useMemo(() => lintLocalization(s.def), [s.def]);
  const targets = loc.languages.filter((l) => l.code !== loc.sourceLanguage);
  const [previewLang, setPreviewLang] = React.useState<string>(loc.sourceLanguage);

  const goFix = (issue: LocalizationIssue) => {
    setFocus(issue.key);
    setView(issue.kind.startsWith("audio") ? "audio" : "translate");
  };

  return (
    <div data-testid="localization-panel">
      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Translation &amp; Localization</h2>
        <span className="grow" />
        <label className="f" style={{ width: 200 }} title="AI: the provider translates everything. Manual: people enter every string. Hybrid (recommended): AI first, then review and edit."><span>Translation mode</span>
          <select className="select" data-testid="loc-mode" value={loc.mode} onChange={(e) => setLoc((cur) => ({ ...cur, mode: e.target.value as typeof cur.mode }))}>
            <option value="hybrid">Hybrid — AI first, then review (recommended)</option>
            <option value="ai">AI translation</option>
            <option value="manual">Manual translation</option>
          </select></label>
        <label className="f" style={{ width: 160 }}><span>Preview in</span>
          <select className="select" data-testid="loc-preview-lang" value={previewLang} onChange={(e) => setPreviewLang(e.target.value)}>
            {[loc.sourceLanguage, ...targets.map((l) => l.code)].map((c) => <option key={c} value={c}>{languageName(c, loc.languages.find((l) => l.code === c))}</option>)}
          </select></label>
        <button type="button" className="btn small" data-testid="loc-preview" style={{ alignSelf: "end" }} onClick={() => { if (!openPreview(runtimeBaseUrl(), s.def, { language: previewLang })) s.toast("The preview window was blocked — allow pop-ups for the Studio", "err"); }}>
          Preview →
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        Build the survey once → select languages → auto-translate → review and edit → add voice → QA → preview → publish. One survey, one set of question and option codes, one dataset; every language is text and audio over the same structure, and <code>SURVEY_LANGUAGE</code> records which one each respondent answered in.
      </div>

      <div className="row" style={{ gap: 4, marginBottom: 12, flexWrap: "wrap" }} data-testid="loc-views">
        {([["languages", "Languages"], ["translate", "Translate"], ["glossary", "Glossary"], ["audio", "Voice / Audio"], ["qa", "QA"], ["routing", "Routing"], ["files", "Import / Export"]] as [View, string][]).map(([k, label]) => (
          <button key={k} type="button" className={`btn small ${view === k ? "primary" : ""}`} data-testid={`loc-view-${k}`} onClick={() => setView(k)}>
            {label}{k === "qa" && reports.some((r) => r.language !== loc.sourceLanguage && !r.ready) ? " ⚠" : ""}
          </button>
        ))}
      </div>

      {view === "languages" && <Languages reports={reports} onTranslate={() => setView("translate")} onQa={() => setView("qa")} />}
      {view === "translate" && <TranslationEditor focusKey={focus} onFocused={() => setFocus(null)} />}
      {view === "glossary" && <GlossaryEditor />}
      {view === "audio" && <AudioStudio focusKey={focus} onFocused={() => setFocus(null)} />}
      {view === "qa" && <QaReport reports={reports} onFix={goFix} />}
      {view === "routing" && <RoutingEditor />}
      {view === "files" && <ImportExport />}
      <span hidden>{editor}</span>
    </div>
  );
}

/* ------------------------------------------------------------ languages */

function Languages({ reports, onTranslate, onQa }: { reports: LanguageReport[]; onTranslate(): void; onQa(): void }) {
  const { s, loc, setLoc } = useLocalization();
  const [adding, setAdding] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [picked, setPicked] = React.useState<Record<string, string>>({}); // code → locale tag
  const [customCode, setCustomCode] = React.useState("");
  const existing = new Set([loc.sourceLanguage, ...loc.languages.map((l) => l.code)]);
  const results = searchLanguages(query).filter((l) => !existing.has(l.code));

  const addPicked = () => {
    const entries = Object.entries(picked);
    if (!entries.length && !customCode.trim()) return;
    setLoc((cur) => ({
      ...cur,
      languages: [
        ...cur.languages,
        ...entries.filter(([code]) => !cur.languages.some((l) => l.code === code) && code !== cur.sourceLanguage).map(([code, tag]) => {
          const info = languageInfo(code);
          const locale = info?.locales.find((x) => x.tag === tag) ?? info?.locales[0];
          return { code, locale: locale?.tag, country: locale?.country, direction: info?.direction, status: "draft", enabled: true, format: {} } as LanguageConfig;
        }),
        ...(customCode.trim() && !cur.languages.some((l) => l.code === customCode.trim()) ? [{ code: customCode.trim().toLowerCase(), status: "draft", enabled: true, format: {} } as LanguageConfig] : []),
      ],
    }));
    setPicked({}); setCustomCode(""); setAdding(false); setQuery("");
    s.toast(`${entries.length + (customCode.trim() ? 1 : 0)} language${entries.length + (customCode.trim() ? 1 : 0) === 1 ? "" : "s"} added — Translate to fill them`);
  };
  const patch = (code: string, p: Partial<LanguageConfig>) => setLoc((cur) => ({ ...cur, languages: cur.languages.map((l) => (l.code === code ? { ...l, ...p } : l)) }));
  const remove = (code: string) => {
    if (!window.confirm(`Remove ${languageName(code)} and its translations and audio from this survey?`)) return;
    setLoc((cur) => { const t = { ...cur.translations }; delete t[code]; return { ...cur, languages: cur.languages.filter((l) => l.code !== code), translations: t, audio: cur.audio.filter((a) => a.language !== code) }; });
  };

  return (
    <div data-testid="loc-languages">
      <div className="row" style={{ flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <label className="f" style={{ width: 240 }} title="The language the survey is written in — every translation is FROM it."><span>Source language</span>
          <select className="select" data-testid="loc-source" value={loc.sourceLanguage} onChange={(e) => setLoc((cur) => ({ ...cur, sourceLanguage: e.target.value, languages: cur.languages.filter((l) => l.code !== e.target.value) }))}>
            {LANGUAGE_LIBRARY.map((l) => <option key={l.code} value={l.code}>{l.name} — {l.nativeName}</option>)}
          </select></label>
        <span className="grow" />
        <button type="button" className="btn small primary" data-testid="loc-add-languages" style={{ alignSelf: "end" }} onClick={() => setAdding((a) => !a)}>+ Add languages</button>
      </div>
      {adding && (
        <div className="card" style={{ padding: 12, marginBottom: 12 }} data-testid="loc-add-panel">
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <input className="input" style={{ width: 300 }} autoFocus placeholder="Search a language or country — Hindi, India, Spanish, Mexico…" value={query} data-testid="loc-lang-search" onChange={(e) => setQuery(e.target.value)} />
            <span className="muted" style={{ fontSize: 12 }}>{results.length} of {LANGUAGE_LIBRARY.length} languages · pick the country / locale beside each</span>
          </div>
          <div className="loc-lang-grid">
            {results.slice(0, 60).map((l) => (
              <label key={l.code} className={`loc-lang-pick${picked[l.code] ? " on" : ""}`} data-testid={`loc-pick-${l.code}`}>
                <input type="checkbox" checked={!!picked[l.code]} onChange={(e) => setPicked((p) => { const n = { ...p }; if (e.target.checked) n[l.code] = l.locales[0].tag; else delete n[l.code]; return n; })} />
                <span className="loc-lang-name">{l.name} <span className="muted">{l.nativeName}{l.direction === "rtl" ? " · RTL" : ""}</span></span>
                {picked[l.code] && l.locales.length > 1 && (
                  <select className="select" style={{ width: 210 }} value={picked[l.code]} data-testid={`loc-pick-locale-${l.code}`} onChange={(e) => setPicked((p) => ({ ...p, [l.code]: e.target.value }))} onClick={(e) => e.stopPropagation()}>
                    {l.locales.map((x) => <option key={x.tag} value={x.tag}>{x.countryName} → {x.name} ({x.tag})</option>)}
                  </select>
                )}
                {picked[l.code] && l.locales.length === 1 && <span className="muted" style={{ fontSize: 11.5 }}>{l.locales[0].countryName} → {l.locales[0].name}</span>}
              </label>
            ))}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <input className="input mono" style={{ width: 200 }} placeholder="or a code not listed (e.g. haw)" value={customCode} data-testid="loc-custom-code" onChange={(e) => setCustomCode(e.target.value)} />
            <span className="grow" />
            <button type="button" className="btn small" onClick={() => { setAdding(false); setPicked({}); }}>cancel</button>
            <button type="button" className="btn small primary" data-testid="loc-add-confirm" disabled={!Object.keys(picked).length && !customCode.trim()} onClick={addPicked}>Add {Object.keys(picked).length + (customCode.trim() ? 1 : 0) || ""} language{Object.keys(picked).length + (customCode.trim() ? 1 : 0) === 1 ? "" : "s"}</button>
          </div>
        </div>
      )}

      <div className="loc-cards" data-testid="loc-cards">
        {reports.map((r) => {
          const cfg = loc.languages.find((l) => l.code === r.language);
          const source = r.language === loc.sourceLanguage;
          const blocking = r.issues.filter((i) => i.blocking).length;
          return (
            <div key={r.language} className="card loc-card" data-testid={`loc-card-${r.language}`} data-completion={r.completion} data-ready={r.ready ? "1" : "0"}>
              <div className="row" style={{ gap: 8 }}>
                <strong style={{ fontSize: 15 }}>{r.name}</strong>
                <span className="muted">{languageInfo(r.language)?.name ?? r.language} · {languageLocale(r.language, cfg)}{languageDirection(r.language, cfg) === "rtl" ? " · RTL" : ""}</span>
                <span className="grow" />
                {source ? <span className="chip">source</span> : (
                  <select className="select" style={{ width: 130 }} value={cfg?.status ?? "draft"} data-testid={`loc-status-${r.language}`}
                    onChange={(e) => {
                      const st = e.target.value as LanguageConfig["status"];
                      if ((st === "ready" || st === "live") && !languageReady(s.def, r.language)) { s.toast(`${r.name} cannot be marked ${st}: ${blocking} blocking QA issue${blocking === 1 ? "" : "s"} (see QA)`, "err"); return; }
                      patch(r.language, { status: st });
                    }}>
                    {LANGUAGE_STATUSES.map((st) => <option key={st} value={st}>{st.replace("_", " ")}</option>)}
                  </select>
                )}
              </div>
              <div className="loc-bar" title={`${r.translated} of ${r.elements} elements translated; ${r.mandatory - r.missing} of ${r.mandatory} mandatory`}><div className="loc-bar-fill" style={{ width: `${r.completion}%`, background: r.completion === 100 ? "#15803d" : "#2563eb" }} /></div>
              <div className="row" style={{ gap: 10, fontSize: 12.5, flexWrap: "wrap" }}>
                <span data-testid={`loc-completion-${r.language}`}><strong>{r.completion}%</strong> translated</span>
                {!source && <span>{r.approved} approved</span>}
                {!source && r.missing > 0 && <span style={{ color: "#b45309" }}>{r.missing} missing</span>}
                <span>{r.audio.withAudio} with audio{r.audio.stale ? ` · ${r.audio.stale} outdated` : ""}</span>
                {!source && (r.ready ? <span className="chip" style={{ color: "#15803d", borderColor: "#15803d" }}>ready for live</span> : <span className="chip warn">{blocking} blocking issue{blocking === 1 ? "" : "s"}</span>)}
              </div>
              {!source && cfg && (
                <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                  <label className="f" style={{ width: 200 }}><span>Locale / dialect</span>
                    <select className="select" value={cfg.locale ?? ""} data-testid={`loc-locale-${r.language}`} onChange={(e) => { const info = languageInfo(r.language); const hit = info?.locales.find((x) => x.tag === e.target.value); patch(r.language, { locale: e.target.value || undefined, country: hit?.country }); }}>
                      <option value="">— default —</option>
                      {(languageInfo(r.language)?.locales ?? []).map((x) => <option key={x.tag} value={x.tag}>{x.countryName} → {x.name} ({x.tag})</option>)}
                      {cfg.locale && !languageInfo(r.language)?.locales.some((x) => x.tag === cfg.locale) && <option value={cfg.locale}>{cfg.locale}</option>}
                    </select></label>
                  <label className="f" style={{ width: 150 }}><span>Shown to respondents as</span><input className="input" value={cfg.name ?? ""} placeholder={languageName(r.language)} onChange={(e) => patch(r.language, { name: e.target.value || undefined })} /></label>
                  <label className="f" style={{ width: 90 }}><span>Direction</span>
                    <select className="select" value={cfg.direction ?? ""} onChange={(e) => patch(r.language, { direction: (e.target.value || undefined) as never })}><option value="">auto</option><option value="ltr">LTR</option><option value="rtl">RTL</option></select></label>
                  <label className="f" style={{ width: 110 }}><span>Date format</span><input className="input mono" value={cfg.format.datePattern ?? ""} placeholder="locale" title="e.g. dd/MM/yyyy" onChange={(e) => patch(r.language, { format: { ...cfg.format, datePattern: e.target.value || undefined } })} /></label>
                  <label className="f" style={{ width: 70 }}><span>Decimal</span><input className="input mono" value={cfg.format.decimal ?? ""} placeholder="." onChange={(e) => patch(r.language, { format: { ...cfg.format, decimal: e.target.value || undefined } })} /></label>
                  <label className="f" style={{ width: 80 }}><span>Thousands</span><input className="input mono" value={cfg.format.thousands ?? ""} placeholder="," onChange={(e) => patch(r.language, { format: { ...cfg.format, thousands: e.target.value || undefined } })} /></label>
                  <label className="f" style={{ width: 80 }}><span>Currency</span><input className="input mono" value={cfg.format.currency ?? ""} placeholder="USD" onChange={(e) => patch(r.language, { format: { ...cfg.format, currency: e.target.value.toUpperCase() || undefined } })} /></label>
                  <label className="f grow"><span>Notes for translators / the AI</span><input className="input" value={cfg.notes ?? ""} placeholder="formal register; use the Gurmukhi script; …" onChange={(e) => patch(r.language, { notes: e.target.value || undefined })} /></label>
                  <label className="row" style={{ gap: 4, fontSize: 13, alignSelf: "end" }}><input type="checkbox" checked={cfg.enabled} onChange={(e) => patch(r.language, { enabled: e.target.checked })} /> offered to respondents</label>
                  <span className="grow" />
                  <button type="button" className="btn small" onClick={onTranslate}>Translate</button>
                  <button type="button" className="btn small" onClick={onQa}>QA</button>
                  <button type="button" className="btn small" onClick={() => { if (!openPreview(runtimeBaseUrl(), s.def, { language: r.language })) s.toast("Pop-up blocked", "err"); }}>Preview</button>
                  <button type="button" className="btn small" data-testid={`loc-remove-${r.language}`} onClick={() => remove(r.language)}>Remove</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- QA */

function QaReport({ reports, onFix }: { reports: LanguageReport[]; onFix(i: LocalizationIssue): void }) {
  const { loc } = useLocalization();
  const [kind, setKind] = React.useState("");
  return (
    <div data-testid="loc-qa">
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>Missing or untranslated text, changed sources, broken piping and HTML, duplicate or inconsistent wording, overflow risks, missing / outdated / unapproved audio. A language cannot be marked <em>ready</em> or <em>live</em> while a blocking issue remains.</div>
      {reports.filter((r) => r.language !== loc.sourceLanguage).length === 0 && <div className="muted">No target languages yet.</div>}
      {reports.filter((r) => r.language !== loc.sourceLanguage).map((r) => {
        const kinds = [...new Set(r.issues.map((i) => i.kind))];
        const shown = r.issues.filter((i) => !kind || i.kind === kind);
        return (
          <div key={r.language} className="card" style={{ padding: 12, marginBottom: 10 }} data-testid={`qa-${r.language}`} data-ready={r.ready ? "1" : "0"}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 15 }}>{r.name}</strong>
              {r.ready ? <span className="chip" style={{ color: "#15803d", borderColor: "#15803d" }}>ready for live</span> : <span className="chip warn">{r.issues.filter((i) => i.blocking).length} blocking</span>}
              <span className="grow" />
              <span className="muted" style={{ fontSize: 12.5 }}>{r.elements} elements · {r.translated} translated · {r.approved} approved · {r.missing} missing · {r.audio.missing} audio files missing · {r.audio.stale} outdated audio</span>
            </div>
            <div className="row" style={{ gap: 4, flexWrap: "wrap", margin: "6px 0" }}>
              <button type="button" className={`chip ${kind === "" ? "on" : ""}`} onClick={() => setKind("")} style={{ cursor: "pointer" }}>all ({r.issues.length})</button>
              {kinds.map((k) => <button key={k} type="button" className={`chip ${kind === k ? "on" : ""}`} data-testid={`qa-kind-${k}`} onClick={() => setKind(k)} style={{ cursor: "pointer" }}>{k.replace(/_/g, " ")} ({r.issues.filter((i) => i.kind === k).length})</button>)}
            </div>
            {shown.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>Nothing to fix.</div>}
            {shown.slice(0, 200).map((i, k) => (
              <div key={k} className="row" style={{ gap: 8, fontSize: 12.5, padding: "3px 0", borderTop: "1px solid var(--border)" }} data-testid="qa-issue" data-kind={i.kind} data-blocking={i.blocking ? "1" : "0"}>
                <span className={`chip ${i.blocking ? "warn" : ""}`}>{i.kind.replace(/_/g, " ")}</span>
                <span style={{ width: 200 }}>{i.label}</span>
                <span className="grow">{i.message}</span>
                <button type="button" className="btn small" data-testid="qa-fix" onClick={() => onFix(i)}>Fix</button>
              </div>
            ))}
            {shown.length > 200 && <div className="muted" style={{ fontSize: 12 }}>…and {shown.length - 200} more</div>}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------- routing */

function RoutingEditor() {
  const { loc, setLoc } = useLocalization();
  const r = loc.routing;
  const set = (p: Partial<typeof r>) => setLoc((cur) => ({ ...cur, routing: { ...cur.routing, ...p } }));
  const langs = [loc.sourceLanguage, ...loc.languages.map((l) => l.code).filter((c) => c !== loc.sourceLanguage)];
  const NAMES: Record<string, string> = { respondent: "Respondent selects (selector on the survey)", url: `URL parameter (?${r.urlParam}=hi)`, browser: "Browser language", country: "Country detection (country map)", embedded: `Embedded data field "${r.embeddedField}"`, invitation: "Email invitation language (embedded field)", panel: "Panel-provided language (embedded field)", rules: "Custom logic (rules below)" };
  const [country, setCountry] = React.useState(""); const [cLang, setCLang] = React.useState(langs[0]);
  return (
    <div data-testid="loc-routing">
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>How a respondent gets their language. Sources are tried in this order; the first that names a language the survey offers (enabled, ready or live) wins. A respondent&apos;s own choice on the survey always wins over detection; switching keeps their position, answers, seed and logic state.</div>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <div className="card" style={{ padding: 10, minWidth: 340 }} data-testid="loc-routing-order">
          <div className="flabel">Order</div>
          {r.order.map((m, i) => (
            <div key={m} className="row" style={{ gap: 6, fontSize: 13, padding: "2px 0" }}>
              <span className="muted" style={{ width: 16 }}>{i + 1}.</span><span className="grow">{NAMES[m] ?? m}</span>
              <button type="button" className="btn small" disabled={i === 0} onClick={() => { const o = [...r.order]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; set({ order: o }); }}>↑</button>
              <button type="button" className="btn small" onClick={() => set({ order: r.order.filter((x) => x !== m) })}>×</button>
            </div>
          ))}
          <select className="select" style={{ marginTop: 6 }} value="" onChange={(e) => { if (e.target.value) set({ order: [...r.order, e.target.value as never] }); }}>
            <option value="">+ add a source…</option>
            {LANGUAGE_ROUTING_MODES.filter((m) => !r.order.includes(m)).map((m) => <option key={m} value={m}>{NAMES[m]}</option>)}
          </select>
        </div>
        <div className="card" style={{ padding: 10, flex: 1, minWidth: 320 }}>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <label className="f" style={{ width: 140 }}><span>URL parameter</span><input className="input mono" data-testid="loc-url-param" value={r.urlParam} onChange={(e) => set({ urlParam: e.target.value.trim() || "lang" })} /></label>
            <label className="f" style={{ width: 170 }}><span>Embedded data field</span><input className="input mono" value={r.embeddedField} onChange={(e) => set({ embeddedField: e.target.value.trim() || "language" })} /></label>
            <label className="f" style={{ width: 170 }}><span>When nothing decides</span>
              <select className="select" value={r.fallback ?? ""} onChange={(e) => set({ fallback: e.target.value || undefined })}><option value="">source language</option>{langs.map((c) => <option key={c} value={c}>{languageName(c)}</option>)}</select></label>
            <label className="row" style={{ gap: 4, fontSize: 13, alignSelf: "end" }}><input type="checkbox" data-testid="loc-allow-switch" checked={r.allowSwitch} onChange={(e) => set({ allowSwitch: e.target.checked })} /> respondents may switch language</label>
          </div>
          <div className="flabel" style={{ margin: "10px 0 4px" }}>Country → language</div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap", fontSize: 13 }}>
            {Object.entries(r.countryMap).map(([c, l]) => <span key={c} className="chip">{c} → {languageName(l)} <button type="button" className="btn small" style={{ marginLeft: 4 }} onClick={() => { const m = { ...r.countryMap }; delete m[c]; set({ countryMap: m }); }}>×</button></span>)}
            <input className="input mono" style={{ width: 70 }} placeholder="IN" value={country} data-testid="loc-country-code" onChange={(e) => setCountry(e.target.value.toUpperCase())} />
            <select className="select" style={{ width: 140 }} value={cLang} data-testid="loc-country-lang" onChange={(e) => setCLang(e.target.value)}>{langs.map((c) => <option key={c} value={c}>{languageName(c)}</option>)}</select>
            <button type="button" className="btn small" data-testid="loc-country-add" disabled={!/^[A-Z]{2}$/.test(country)} onClick={() => { set({ countryMap: { ...r.countryMap, [country]: cLang } }); setCountry(""); }}>add</button>
          </div>
          <div className="flabel" style={{ margin: "10px 0 4px" }}>Rules — IF … THEN language</div>
          {r.rules.map((rule, i) => (
            <div key={rule.id ?? i} className="logic-rule" style={{ marginBottom: 6 }}>
              <div className="row" style={{ gap: 6, marginBottom: 4 }}>
                <span className="logic-if">IF</span><span className="grow" /><span style={{ fontSize: 13 }}>THEN</span>
                <select className="select" style={{ width: 140 }} value={rule.language} onChange={(e) => set({ rules: r.rules.map((x, k) => (k === i ? { ...x, language: e.target.value } : x)) })}>{langs.map((c) => <option key={c} value={c}>{languageName(c)}</option>)}</select>
                <button type="button" className="btn small" onClick={() => set({ rules: r.rules.filter((_, k) => k !== i) })}>remove</button>
              </div>
              <ConditionEditor value={rule.when as Condition} onChange={(when) => set({ rules: r.rules.map((x, k) => (k === i ? { ...x, when } : x)) })} />
            </div>
          ))}
          <button type="button" className="btn small" onClick={() => set({ rules: [...r.rules, { id: uid("lr"), when: newConditionGroup(), language: langs[langs.length - 1] }] })}>+ rule</button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- import / export */

function ImportExport() {
  const { s, loc, setLoc } = useLocalization();
  const editor = useEditorName();
  const targets = loc.languages.map((l) => l.code).filter((c) => c !== loc.sourceLanguage);
  const [langs, setLangs] = React.useState<string[]>(targets);
  const [note, setNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { setLangs((cur) => { const k = cur.filter((c) => targets.includes(c)); return k.length ? k : targets; }); }, [targets.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = `${(s.def.meta.code || "Survey").replace(/[^A-Za-z0-9_-]+/g, "_")}_Translations`;

  const exportRows = () => translationRows(s.def, langs);
  const exportCsv = () => {
    const rows = exportRows();
    const head = ["Element ID", "Question ID", "Question", "Element", "Source Language", "Target Language", "Source Text", "Translation", "Status", "Audio URL"];
    const esc = (v: unknown) => { const t = String(v ?? ""); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const csv = [head.join(","), ...rows.map((r) => [r.elementKey, r.questionId, r.questionCode, r.element, r.sourceLanguage, r.targetLanguage, r.sourceText, r.translation, r.status, r.audioUrl].map(esc).join(","))].join("\n");
    downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), `${base}.csv`);
  };
  const exportJson = () => downloadBlob(new Blob([JSON.stringify({ survey: s.def.meta.code, sourceLanguage: loc.sourceLanguage, languages: langs, rows: exportRows() }, null, 2)], { type: "application/json" }), `${base}.json`);
  const exportXlsx = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch("/api/localization/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ definition: s.def, languages: langs }) });
      if (!r.ok) { setNote(`Export failed (${r.status})`); return; }
      downloadBlob(await r.blob(), `${base}.xlsx`);
    } catch { setNote("Could not reach the Studio."); } finally { setBusy(false); }
  };
  const importFile = async (file: File) => {
    setBusy(true); setNote(null);
    try {
      let rows: { elementKey: string; targetLanguage: string; translation: string; status?: string; audioUrl?: string }[] = [];
      if (/\.json$/i.test(file.name)) {
        const j = JSON.parse(await file.text()) as { rows?: typeof rows } | typeof rows;
        rows = Array.isArray(j) ? j : (j.rows ?? []);
      } else {
        const form = new FormData(); form.append("file", file);
        const r = await fetch("/api/localization/import", { method: "POST", body: form });
        const j = await r.json().catch(() => ({})) as { rows?: typeof rows; error?: string };
        if (!r.ok) { setNote(j.error ?? `Import failed (${r.status})`); return; }
        rows = j.rows ?? [];
      }
      const res = applyTranslationRows(s.def, rows, editor);
      setLoc(res.localization);
      setNote(`${res.applied} translation${res.applied === 1 ? "" : "s"} imported${res.skipped ? `, ${res.skipped} row${res.skipped === 1 ? "" : "s"} skipped (blank, unknown element, or the source language)` : ""}.`);
    } catch (e) { setNote(`Could not read the file: ${(e as Error).message}`); } finally { setBusy(false); }
  };

  return (
    <div data-testid="loc-files">
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>One row per element and target language: <code>Element ID | Question ID | Source Language | Target Language | Source Text | Translation | Status | Audio URL</code>. Send the file to a translator, import it back; rows are matched by Element ID, never by text, so a survey edited in the meantime still lines up.</div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        <span className="flabel" style={{ margin: 0 }}>Languages</span>
        {targets.map((l) => <label key={l} className={`chip ${langs.includes(l) ? "on" : ""}`} style={{ cursor: "pointer" }}><input type="checkbox" style={{ marginRight: 4 }} checked={langs.includes(l)} onChange={(e) => setLangs((cur) => (e.target.checked ? [...cur, l] : cur.filter((x) => x !== l)))} />{languageName(l)}</label>)}
        <span className="grow" />
        <button type="button" className="btn small" data-testid="loc-export-xlsx" disabled={busy || !langs.length} onClick={exportXlsx}>Export Excel</button>
        <button type="button" className="btn small" data-testid="loc-export-csv" disabled={!langs.length} onClick={exportCsv}>Export CSV</button>
        <button type="button" className="btn small" data-testid="loc-export-json" disabled={!langs.length} onClick={exportJson}>Export JSON</button>
        <label className="btn small primary" style={{ cursor: "pointer" }}>Import file…<input type="file" accept=".xlsx,.csv,.json" style={{ display: "none" }} data-testid="loc-import-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} /></label>
      </div>
      {note && <div className="muted" style={{ fontSize: 12.5 }} data-testid="loc-import-note">{note}</div>}
    </div>
  );
}
