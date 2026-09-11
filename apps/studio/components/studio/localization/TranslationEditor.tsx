"use client";
import React from "react";
import type { Localization, TranslationEntry } from "@rescript/schema";
import { translatableElements, recordTranslation, setTranslationStatus, glossaryFor, applyGlossary, textHash, languageName, languageLocale, lintLanguage, type TranslatableElement } from "@rescript/engine";
import { useLocalization, useEditorName, STATUS_LABEL, STATUS_COLOR, fmtDate } from "./shared";

/**
 * THE TRANSLATION TABLE — a translation-management view over the survey.
 *
 * One row per respondent-facing element (by stable key), the source text,
 * and one column per selected target language. Each cell is the translation
 * with its status (Not translated → AI → Edited → Reviewed → Approved), where
 * it came from, when and by whom; an edit is recorded with the previous
 * version kept. "Translate all" / "Translate selected" ask the AI in batches
 * of 40 per language with the survey's glossary and the language's notes,
 * showing progress per language; nothing already Reviewed or Approved is
 * overwritten unless asked. Filters: status, question, text search, QA issues.
 */

const CHUNK = 40;

export function TranslationEditor({ focusKey, onFocused }: { focusKey?: string | null; onFocused?(): void }) {
  const { s, loc, setLoc } = useLocalization();
  const editor = useEditorName();
  const targets = loc.languages.map((l) => l.code).filter((c) => c !== loc.sourceLanguage);
  const [shown, setShown] = React.useState<string[]>(() => targets.slice(0, 3));
  const [status, setStatus] = React.useState<string>("");
  const [search, setSearch] = React.useState("");
  const [question, setQuestion] = React.useState("");
  const [onlyIssues, setOnlyIssues] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [progress, setProgress] = React.useState<Record<string, { done: number; total: number; error?: string }>>({});
  const [busy, setBusy] = React.useState(false);
  const [history, setHistory] = React.useState<{ key: string; lang: string } | null>(null);
  const rowRefs = React.useRef<Record<string, HTMLTableRowElement | null>>({});

  const elements = React.useMemo(() => translatableElements(s.def), [s.def]);
  const reports = React.useMemo(() => Object.fromEntries(shown.map((l) => [l, lintLanguage(s.def, l)])), [s.def, shown]);
  const issueKeys = React.useMemo(() => new Set(Object.values(reports).flatMap((r) => r.issues.map((i) => i.key))), [reports]);
  const questions = React.useMemo(() => [...new Map(elements.filter((e) => e.questionId).map((e) => [e.questionId!, e.questionCode!])).entries()], [elements]);

  React.useEffect(() => { setShown((cur) => { const keep = cur.filter((c) => targets.includes(c)); return keep.length ? keep : targets.slice(0, 3); }); }, [targets.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (!focusKey) return;
    const el = rowRefs.current[focusKey];
    if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("loc-row-focus"); setTimeout(() => el.classList.remove("loc-row-focus"), 2000); }
    onFocused?.();
  }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = elements.filter((e) => {
    if (question && e.questionId !== question && !(question === "__ui" && e.kind === "ui") && !(question === "__survey" && !e.questionId && e.kind !== "ui")) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const hit = e.source.toLowerCase().includes(q) || e.label.toLowerCase().includes(q) || shown.some((l) => (loc.translations[l]?.[e.key]?.text ?? "").toLowerCase().includes(q));
      if (!hit) return false;
    }
    if (status) {
      const any = shown.some((l) => (loc.translations[l]?.[e.key]?.status ?? "not_translated") === status);
      if (!any) return false;
    }
    if (onlyIssues && !issueKeys.has(e.key)) return false;
    return true;
  });

  const write = (lang: string, el: TranslatableElement, text: string, opts: { origin?: TranslationEntry["origin"]; status?: TranslationEntry["status"] } = {}) =>
    setLoc((cur) => recordTranslation(cur, lang, el.key, text, el.source, { ...opts, by: editor }));
  const mark = (lang: string, key: string, st: TranslationEntry["status"]) => setLoc((cur) => setTranslationStatus(cur, lang, key, st, editor));

  /** Ask the AI for the given elements in the given languages, in chunks, recording each answer as "ai". Reviewed/approved cells are skipped unless `force`. */
  const translate = async (langs: string[], els: TranslatableElement[], force = false) => {
    setBusy(true);
    const title = s.def.meta.title;
    for (const lang of langs) {
      const cfg = loc.languages.find((l) => l.code === lang);
      const todo = els.filter((e) => {
        const t = loc.translations[lang]?.[e.key];
        if (!t || t.status === "not_translated" || !t.text.trim()) return true;
        if (force) return true;
        if (t.status === "reviewed" || t.status === "approved") return false;
        // an AI or edited translation whose source has since changed is re-translated
        return t.sourceHash !== textHash(e.source) && t.status === "ai";
      });
      setProgress((p) => ({ ...p, [lang]: { done: 0, total: todo.length } }));
      const glossary = glossaryFor(loc, lang);
      let done = 0;
      for (let i = 0; i < todo.length; i += CHUNK) {
        const chunk = todo.slice(i, i + CHUNK);
        try {
          const r = await fetch("/api/ai/translate", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ items: chunk.map((e) => ({ key: e.key, text: e.source, kind: e.kind.replace(/_/g, " ") })), sourceLanguage: loc.sourceLanguage, targetLanguage: lang, locale: languageLocale(lang, cfg), glossary, notes: cfg?.notes, context: title }),
          });
          if (r.status === 501) { setProgress((p) => ({ ...p, [lang]: { done, total: todo.length, error: "AI is not configured on this Studio — translate by hand or import a file." } })); break; }
          if (!r.ok) { const j = await r.json().catch(() => ({})) as { error?: string }; setProgress((p) => ({ ...p, [lang]: { done, total: todo.length, error: j.error ?? `Translation failed (${r.status})` } })); break; }
          const j = await r.json() as { translations?: Record<string, string> };
          const got = j.translations ?? {};
          s.update((d) => {
            let cur = (d.localization ?? loc) as Localization;
            for (const e of chunk) {
              const t = got[e.key];
              if (!t) continue;
              cur = recordTranslation(cur, lang, e.key, applyGlossary(t, glossary), e.source, { origin: "ai", status: "ai", by: "AI" });
            }
            d.localization = cur;
          });
        } catch { setProgress((p) => ({ ...p, [lang]: { done, total: todo.length, error: "Could not reach the Studio." } })); break; }
        done += chunk.length;
        setProgress((p) => ({ ...p, [lang]: { done, total: todo.length } }));
      }
    }
    setBusy(false);
  };

  const toggleAll = (on: boolean) => setSelected(on ? new Set(rows.map((r) => r.key)) : new Set());
  const approveAll = (lang: string) => setLoc((cur) => {
    let out = cur;
    for (const e of rows) { const t = out.translations[lang]?.[e.key]; if (t && (t.status === "ai" || t.status === "edited" || t.status === "reviewed") && t.text.trim()) out = setTranslationStatus(out, lang, e.key, "approved", editor); }
    return out;
  });

  if (!targets.length) return <div className="muted" data-testid="loc-editor-empty">Add a language first — Languages tab.</div>;

  return (
    <div data-testid="loc-editor">
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <div className="row" style={{ gap: 4, flexWrap: "wrap" }} data-testid="loc-columns">
          <span className="flabel" style={{ margin: 0 }}>Columns</span>
          {targets.map((l) => (
            <label key={l} className={`chip ${shown.includes(l) ? "on" : ""}`} style={{ cursor: "pointer" }}>
              <input type="checkbox" style={{ marginRight: 4 }} checked={shown.includes(l)} data-testid={`loc-col-${l}`} onChange={(e) => setShown((cur) => (e.target.checked ? [...cur, l] : cur.filter((x) => x !== l)))} />
              {languageName(l, loc.languages.find((x) => x.code === l))}
            </label>
          ))}
        </div>
        <span className="grow" />
        <button type="button" className="btn small primary" data-testid="loc-translate-all" disabled={busy || !shown.length} onClick={() => translate(shown, elements)} title="AI-translate every element that has no translation yet (reviewed and approved cells are left alone)">
          {busy ? "Translating…" : "Translate all"}
        </button>
        <button type="button" className="btn small" data-testid="loc-translate-selected" disabled={busy || !selected.size || !shown.length} onClick={() => translate(shown, elements.filter((e) => selected.has(e.key)), true)} title="AI-translate the ticked rows, replacing what is there">
          Translate selected ({selected.size})
        </button>
      </div>
      {Object.entries(progress).length > 0 && (
        <div className="row" style={{ flexWrap: "wrap", gap: 10, marginBottom: 8 }} data-testid="loc-progress">
          {Object.entries(progress).map(([l, p]) => (
            <span key={l} className="chip" data-testid={`loc-progress-${l}`} title={p.error ?? ""} style={p.error ? { color: "#b91c1c" } : undefined}>
              {languageName(l, loc.languages.find((x) => x.code === l))} — {p.total ? `${Math.round((p.done / p.total) * 100)}%` : "up to date"}{p.error ? ` · ${p.error}` : ""}
            </span>
          ))}
        </div>
      )}
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <input className="input" style={{ width: 240 }} placeholder="Search source or translation…" value={search} data-testid="loc-search" onChange={(e) => setSearch(e.target.value)} />
        <select className="select" style={{ width: 200 }} value={question} data-testid="loc-filter-question" onChange={(e) => setQuestion(e.target.value)}>
          <option value="">All elements</option>
          <option value="__survey">Survey, flow &amp; buttons</option>
          {questions.map(([id, code]) => <option key={id} value={id}>{code}</option>)}
          <option value="__ui">Interface &amp; validation messages</option>
        </select>
        <select className="select" style={{ width: 170 }} value={status} data-testid="loc-filter-status" onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="row" style={{ gap: 4, fontSize: 13 }}><input type="checkbox" checked={onlyIssues} data-testid="loc-filter-issues" onChange={(e) => setOnlyIssues(e.target.checked)} /> only QA issues</label>
        <span className="muted" style={{ fontSize: 12.5 }}>{rows.length} of {elements.length} elements</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="loc-table" data-testid="loc-table">
          <thead>
            <tr>
              <th style={{ width: 28 }}><input type="checkbox" checked={rows.length > 0 && rows.every((r) => selected.has(r.key))} onChange={(e) => toggleAll(e.target.checked)} aria-label="select all" /></th>
              <th style={{ width: 150 }}>Element</th>
              <th style={{ minWidth: 220 }}>{languageName(loc.sourceLanguage)} <span className="chip">source</span></th>
              {shown.map((l) => (
                <th key={l} style={{ minWidth: 260 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <span>{languageName(l, loc.languages.find((x) => x.code === l))}</span>
                    <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{reports[l]?.completion ?? 0}%</span>
                    <span className="grow" />
                    <button type="button" className="btn small" data-testid={`loc-approve-all-${l}`} onClick={() => approveAll(l)} title="Approve every translated cell in view">approve all</button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((el) => (
              <tr key={el.key} ref={(r) => { rowRefs.current[el.key] = r; }} data-testid="loc-row" data-key={el.key} className={issueKeys.has(el.key) ? "loc-row-issue" : undefined}>
                <td><input type="checkbox" checked={selected.has(el.key)} onChange={(e) => setSelected((cur) => { const n = new Set(cur); if (e.target.checked) n.add(el.key); else n.delete(el.key); return n; })} aria-label={`select ${el.label}`} /></td>
                <td className="loc-elem"><div>{el.label}</div><code className="muted" style={{ fontSize: 10.5 }}>{el.key}</code>{el.mandatory ? null : <div className="muted" style={{ fontSize: 10.5 }}>optional</div>}</td>
                <td className="loc-source"><div dangerouslySetInnerHTML={{ __html: el.source }} /></td>
                {shown.map((l) => {
                  const t = loc.translations[l]?.[el.key];
                  const st = t?.status ?? "not_translated";
                  const stale = t?.sourceHash && t.sourceHash !== textHash(el.source);
                  const issues = reports[l]?.issues.filter((i) => i.key === el.key) ?? [];
                  return (
                    <td key={l} className="loc-cell" data-testid={`loc-cell-${l}`} data-status={st}>
                      <textarea className="ta loc-ta" data-testid={`loc-input-${l}`} value={t?.text ?? ""} placeholder={`${languageName(l)}…`} dir={l === "ar" || l === "ur" || l === "he" || l === "fa" ? "rtl" : undefined}
                        onChange={(e) => write(l, el, e.target.value, { origin: "manual" })} />
                      <div className="row" style={{ gap: 4, flexWrap: "wrap", fontSize: 11 }}>
                        <span className="chip" data-testid={`loc-status-${l}`} style={{ borderColor: STATUS_COLOR[st], color: STATUS_COLOR[st] }}>{STATUS_LABEL[st]}</span>
                        {t?.origin && st !== "not_translated" && <span className="muted">{t.origin === "ai" ? "AI" : t.origin === "import" ? "imported" : t.origin === "glossary" ? "glossary" : "manual"} · v{t.version}</span>}
                        {t?.updatedAt && <span className="muted" title={`${fmtDate(t.updatedAt)}${t.updatedBy ? ` by ${t.updatedBy}` : ""}`}>{fmtDate(t.updatedAt)}{t.updatedBy ? ` · ${t.updatedBy}` : ""}</span>}
                        {stale && <span className="chip warn" title="The source text was edited after this translation">source changed</span>}
                        {issues.filter((i) => i.kind !== "not_approved" && i.kind !== "stale_source").map((i, k) => <span key={k} className={`chip ${i.blocking ? "warn" : ""}`} title={i.message}>{i.kind.replace(/_/g, " ")}</span>)}
                        <span className="grow" />
                        <button type="button" className="btn small" data-testid={`loc-ai-${l}`} disabled={busy} onClick={() => translate([l], [el], true)} title="AI-translate this element">AI</button>
                        {t && st !== "not_translated" && st !== "reviewed" && st !== "approved" && <button type="button" className="btn small" data-testid={`loc-review-${l}`} onClick={() => mark(l, el.key, "reviewed")}>reviewed</button>}
                        {t && st !== "not_translated" && st !== "approved" && <button type="button" className="btn small" data-testid={`loc-approve-${l}`} onClick={() => mark(l, el.key, "approved")}>approve</button>}
                        {t && t.history.length > 0 && <button type="button" className="btn small" data-testid={`loc-history-${l}`} onClick={() => setHistory(history?.key === el.key && history.lang === l ? null : { key: el.key, lang: l })}>v{t.version} ▾</button>}
                      </div>
                      {history?.key === el.key && history.lang === l && t && (
                        <div className="loc-history" data-testid="loc-history">
                          <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>Previous versions (newest first)</div>
                          {t.history.map((h, k) => (
                            <div key={k} className="row" style={{ gap: 6, fontSize: 12 }}>
                              <span className="muted">v{h.version}</span><span style={{ flex: 1 }}>{h.text}</span><span className="muted">{STATUS_LABEL[h.status] ?? h.status} · {fmtDate(h.updatedAt)}{h.updatedBy ? ` · ${h.updatedBy}` : ""}</span>
                              <button type="button" className="btn small" onClick={() => write(l, el, h.text, { origin: "manual" })}>restore</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
