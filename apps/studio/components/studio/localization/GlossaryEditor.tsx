"use client";
import React from "react";
import type { GlossaryEntry } from "@rescript/schema";
import { languageName, translatableElements, recordTranslation, glossaryFor, applyGlossary } from "@rescript/engine";
import { useLocalization, useEditorName } from "./shared";
import { uid } from "../store";

/**
 * TRANSLATION MEMORY / GLOSSARY — preferred wordings for terms, reused
 * everywhere and told to the AI.
 *
 * A row is a source term with a preferred translation per language; "do not
 * translate" keeps a brand name as written in every language. Project rows
 * live in this survey; the WORKSPACE glossary is shared across the
 * organisation's surveys (stored beside the workspace themes) — "Import
 * workspace terms" copies them in as org-scoped rows, "Share to workspace"
 * publishes this survey's rows. "Apply to translations" enforces the glossary
 * on every existing translation, so a term decided late is fixed everywhere
 * at once (each change is recorded as a versioned edit).
 */
export function GlossaryEditor() {
  const { s, loc, setLoc } = useLocalization();
  const editor = useEditorName();
  const targets = loc.languages.map((l) => l.code).filter((c) => c !== loc.sourceLanguage);
  const [source, setSource] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const disabledOrg = s.surveyDbId === "sandbox";

  const patch = (id: string, p: Partial<GlossaryEntry>) => setLoc((cur) => ({ ...cur, glossary: cur.glossary.map((g) => (g.id === id ? { ...g, ...p } : g)) }));
  const add = () => {
    const term = source.trim();
    if (!term) return;
    setLoc((cur) => ({ ...cur, glossary: [...cur.glossary, { id: uid("gl"), source: term, targets: {}, scope: "project", caseSensitive: false, doNotTranslate: false }] }));
    setSource("");
  };
  const remove = (id: string) => setLoc((cur) => ({ ...cur, glossary: cur.glossary.filter((g) => g.id !== id) }));

  /** Enforce every glossary term on every existing translation. */
  const applyAll = () => {
    const elements = translatableElements(s.def);
    let changed = 0;
    setLoc((cur) => {
      let out = cur;
      for (const lang of targets) {
        const entries = glossaryFor(cur, lang);
        if (!entries.length) continue;
        for (const el of elements) {
          const t = cur.translations[lang]?.[el.key];
          if (!t || !t.text.trim()) continue;
          const fixed = applyGlossary(t.text, entries);
          if (fixed !== t.text) { out = recordTranslation(out, lang, el.key, fixed, el.source, { origin: "glossary", status: t.status === "approved" || t.status === "reviewed" ? "edited" : t.status, by: editor }); changed++; }
        }
      }
      return out;
    });
    setNote(changed ? `${changed} translation${changed === 1 ? "" : "s"} updated to the preferred wording.` : "Every translation already follows the glossary.");
  };

  const importOrg = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/glossary`, { cache: "no-store" });
      if (!r.ok) { setNote(`Could not load the workspace glossary (${r.status}).`); return; }
      const j = await r.json() as { entries?: GlossaryEntry[] };
      const incoming = (j.entries ?? []).map((g) => ({ ...g, scope: "org" as const }));
      setLoc((cur) => {
        const have = new Set(cur.glossary.map((g) => g.source.toLowerCase()));
        return { ...cur, glossary: [...cur.glossary, ...incoming.filter((g) => !have.has(g.source.toLowerCase()))] };
      });
      setNote(`${incoming.length} workspace term${incoming.length === 1 ? "" : "s"} available; new ones added.`);
    } catch { setNote("Could not reach the Studio."); }
    finally { setBusy(false); }
  };
  const shareOrg = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/glossary`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries: loc.glossary }) });
      const j = await r.json().catch(() => ({})) as { error?: string; count?: number };
      setNote(r.ok ? `Workspace glossary now holds ${j.count ?? loc.glossary.length} terms.` : (j.error ?? `Could not save (${r.status})`));
    } catch { setNote("Could not reach the Studio."); }
    finally { setBusy(false); }
  };

  return (
    <div data-testid="loc-glossary">
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        Preferred translations for terms — reused throughout the survey and given to the AI on every request. A term marked <em>do not translate</em> stays exactly as written in every language (brand names, product names).
      </div>
      <div className="row" style={{ gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        <input className="input" style={{ width: 260 }} placeholder="Source term, e.g. Customer Satisfaction" value={source} data-testid="gl-source" onChange={(e) => setSource(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        <button type="button" className="btn small primary" data-testid="gl-add" disabled={!source.trim()} onClick={add}>+ term</button>
        <span className="grow" />
        <button type="button" className="btn small" data-testid="gl-apply" disabled={!loc.glossary.length} onClick={applyAll} title="Enforce the glossary on every existing translation">Apply to translations</button>
        <button type="button" className="btn small" disabled={busy || disabledOrg} onClick={importOrg} title={disabledOrg ? "The sandbox has no workspace" : "Copy the organisation's shared terms into this survey"}>Import workspace terms</button>
        <button type="button" className="btn small" disabled={busy || disabledOrg || !loc.glossary.length} onClick={shareOrg} title={disabledOrg ? "The sandbox has no workspace" : "Publish this survey's terms to the organisation's shared glossary"}>Share to workspace</button>
      </div>
      {note && <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }} data-testid="gl-note">{note}</div>}
      {loc.glossary.length === 0 ? <div className="muted" data-testid="gl-empty">No terms yet.</div> : (
        <div style={{ overflowX: "auto" }}>
          <table className="loc-table" data-testid="gl-table">
            <thead><tr><th>Source term</th>{targets.map((l) => <th key={l}>{languageName(l, loc.languages.find((x) => x.code === l))}</th>)}<th>Rules</th><th /></tr></thead>
            <tbody>
              {loc.glossary.map((g) => (
                <tr key={g.id} data-testid="gl-row" data-source={g.source}>
                  <td><input className="input" value={g.source} onChange={(e) => patch(g.id, { source: e.target.value })} />{g.scope === "org" && <div className="muted" style={{ fontSize: 10.5 }}>workspace</div>}</td>
                  {targets.map((l) => (
                    <td key={l}>
                      <input className="input" data-testid={`gl-target-${l}`} disabled={g.doNotTranslate} placeholder={g.doNotTranslate ? g.source : "preferred wording"} value={g.doNotTranslate ? "" : (g.targets[l] ?? "")}
                        onChange={(e) => patch(g.id, { targets: { ...g.targets, [l]: e.target.value } })} />
                    </td>
                  ))}
                  <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                    <label className="row" style={{ gap: 4 }}><input type="checkbox" data-testid="gl-dnt" checked={g.doNotTranslate} onChange={(e) => patch(g.id, { doNotTranslate: e.target.checked })} /> do not translate</label>
                    <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={g.caseSensitive} onChange={(e) => patch(g.id, { caseSensitive: e.target.checked })} /> case-sensitive</label>
                  </td>
                  <td><button type="button" className="btn small" onClick={() => remove(g.id)}>remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
