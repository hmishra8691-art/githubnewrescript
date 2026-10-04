"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { effectiveLocalization, languageName, lintLanguage, type SurveyAction } from "@rescript/engine";
import { Icon } from "../../ui/Icon";
import { Linked } from "./CopilotCard";
import type { Copilot } from "./useCopilot";

/**
 * THE LANGUAGES — Intelligent → Languages.
 *
 * Where each language version stands, read from the definition the engine
 * lints: how much is translated, what is missing, what went OUTDATED when
 * the source text changed, what blocks "ready", what is still machine
 * translation waiting for a reviewer — and the next step for each, as a
 * proposal through Changes or as a request to the copilot in words.
 *
 * The translations themselves are edited in the Localization panel; this is
 * the copilot's view of the same data, so nothing here is stored twice.
 */
export function LanguagesTab({ copilot, def, onSelect }: { copilot: Copilot; def: SurveyDefinition; onSelect(id: string): void }) {
  const loc = React.useMemo(() => effectiveLocalization(def), [def]);
  const reports = React.useMemo(() => loc.languages.map((l) => ({ cfg: l, r: lintLanguage(def, l.code) })), [def, loc]);
  const empty = !def.questions.length;
  const ask = (text: string) => void copilot.ask(text);

  return (
    <div className="cp-analysis cp-languages" data-testid="cp-languages">
      <section>
        <div className="iq-label">Source language · {languageName(loc.sourceLanguage)} ({loc.sourceLanguage}{loc.sourceLocale ? `, ${loc.sourceLocale}` : ""})</div>
        {!loc.languages.length && <p className="cp-empty" data-testid="lg-none">{empty ? "Add questions first — then ask for the languages the fieldwork needs." : "No other language yet. Ask the copilot — “add Spanish and German”, “translate the survey into Hindi”, “route Mexican respondents to Spanish” — and the translations arrive as a proposal you review in Changes before anything is written."}</p>}
      </section>

      {reports.map(({ cfg, r }) => {
        const stale = r.issues.filter((i) => i.kind === "stale_source");
        const blocking = r.issues.filter((i) => i.blocking && i.kind !== "missing" && i.kind !== "stale_source");
        const unreviewed = r.issues.filter((i) => i.kind === "not_approved").length;
        const name = languageName(cfg.code, cfg);
        const unapprovedTargets = Object.entries(loc.translations[cfg.code] ?? {}).filter(([, t]) => t.status === "ai" || t.status === "edited").map(([k]) => k);
        const staleTargets = stale.map((i) => i.key);
        return (
          <section key={cfg.code} className="cp-block" data-testid="lg-language" data-code={cfg.code} data-status={cfg.status}>
            <div className="row" style={{ alignItems: "center", gap: 8 }}>
              <div><b>{name}</b> <span className="mono iqi-dim">{cfg.code}{cfg.locale ? ` · ${cfg.locale}` : ""}</span> <span className={`cp-sev v-${cfg.status === "live" ? "suggestion" : cfg.status === "ready" ? "suggestion" : "warning"}`}>{cfg.status}</span>{!cfg.enabled && <span className="iqi-dim"> · not offered</span>}</div>
              <span className="grow" />
              <span className="iqi-dim" data-testid="lg-completion">{r.completion}% translated</span>
            </div>
            <div className="cp-lang-bar" aria-hidden><span style={{ width: `${r.completion}%` }} /></div>
            <p className="iqi-dim" data-testid="lg-counts">
              {r.translated} of {r.mandatory} needed elements translated · {r.approved} approved{r.reviewed ? ` · ${r.reviewed} reviewed` : ""}{unreviewed ? ` · ${unreviewed} awaiting review` : ""}
              {r.missing > 0 && <> · <b>{r.missing} missing</b></>}
              {stale.length > 0 && <> · <b className="cp-outdated">{stale.length} outdated</b></>}
              {blocking.length > 0 && <> · <b>{blocking.length} blocking</b></>}
              {r.ready && cfg.status !== "live" && cfg.status !== "ready" && <> · ready to go live</>}
            </p>
            {stale.length > 0 && (
              <ul className="cp-review-list" data-testid="lg-outdated">
                {stale.slice(0, 6).map((i) => <li key={i.key} data-severity="warning"><span className="cp-sev v-warning">outdated</span> <Linked text={i.label} def={def} onSelect={onSelect} /></li>)}
                {stale.length > 6 && <li className="iqi-dim">… and {stale.length - 6} more</li>}
              </ul>
            )}
            {blocking.length > 0 && (
              <ul className="cp-review-list" data-testid="lg-blocking">
                {blocking.slice(0, 6).map((i, k) => <li key={`${i.key}${k}`} data-severity="critical"><span className="cp-sev v-critical">{i.kind.replace(/_/g, " ")}</span> <Linked text={`${i.label}: ${i.message}`} def={def} onSelect={onSelect} /></li>)}
                {blocking.length > 6 && <li className="iqi-dim">… and {blocking.length - 6} more</li>}
              </ul>
            )}
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {r.missing > 0 && <button type="button" className="iq-btn primary" data-testid="lg-translate-missing" disabled={copilot.busy} onClick={() => ask(`Translate the ${r.missing} missing element${r.missing === 1 ? "" : "s"} into ${name} (${cfg.code}) — do not touch approved translations.`)}>Translate the missing {r.missing}</button>}
              {stale.length > 0 && <button type="button" className="iq-btn primary" data-testid="lg-retranslate" disabled={copilot.busy} onClick={() => ask(`Re-translate the ${stale.length} outdated ${name} (${cfg.code}) translation${stale.length === 1 ? "" : "s"} — the source text changed: ${stale.slice(0, 12).map((i) => i.label).join("; ")}${stale.length > 12 ? "; …" : ""}.`)}>Re-translate the outdated</button>}
              {stale.length > 0 && <button type="button" className="iq-btn" data-testid="lg-confirm" title="The source edit did not change the meaning — the existing translations still fit" onClick={() => copilot.previewFix([{ op: "confirm_translations", language: cfg.code, targets: staleTargets } as SurveyAction], `Confirm ${stale.length} outdated ${name} translation${stale.length === 1 ? "" : "s"}`)}>Confirm they still fit</button>}
              {unapprovedTargets.length > 0 && <button type="button" className="iq-btn" data-testid="lg-approve" title="Lock the machine / edited translations as approved — the copilot will not overwrite them unless asked to" onClick={() => copilot.previewFix([{ op: "approve_translations", language: cfg.code, targets: unapprovedTargets } as SurveyAction], `Approve ${unapprovedTargets.length} ${name} translation${unapprovedTargets.length === 1 ? "" : "s"}`)}>Approve {unapprovedTargets.length}</button>}
              {r.ready && cfg.status === "draft" && <button type="button" className="iq-btn" data-testid="lg-mark-ready" onClick={() => copilot.previewFix([{ op: "set_language_status", code: cfg.code, status: "ready" } as SurveyAction], `Mark ${name} ready`)}>Mark ready</button>}
            </div>
          </section>
        );
      })}

      {loc.languages.length > 0 && (
        <section data-testid="lg-routing">
          <div className="iq-label">Who gets which language</div>
          <p className="iqi-dim">
            In order: {loc.routing.order.join(" → ")}. URL <span className="mono">?{loc.routing.urlParam}=</span>, embedded field <span className="mono">{loc.routing.embeddedField}</span>
            {Object.keys(loc.routing.countryMap).length > 0 && <>; by country {Object.entries(loc.routing.countryMap).map(([c, l]) => `${c} → ${languageName(l, loc.languages.find((x) => x.code === l))}`).join(", ")}</>}
            {loc.routing.rules.length > 0 && <>; {loc.routing.rules.length} rule{loc.routing.rules.length === 1 ? "" : "s"} ({loc.routing.rules.map((x) => `${x.label ?? x.when} → ${x.language}`).join("; ")})</>}
            ; switcher {loc.routing.allowSwitch ? "shown" : "hidden"}{loc.routing.fallback ? `; fallback ${loc.routing.fallback}` : ""}.
          </p>
          {loc.glossary.length > 0 && <p className="iqi-dim" data-testid="lg-glossary">Glossary: {loc.glossary.map((g) => `${g.source}${g.doNotTranslate ? " (never translated)" : ""}`).join(", ")}.</p>}
          <p className="iqi-dim"><Icon name="info" size={12} /> Change any of this in words — “US respondents get English, MX Spanish”, “never translate the brand name”, “hide the language switcher” — or edit it in Localization.</p>
        </section>
      )}
    </div>
  );
}
