"use client";
import React from "react";
import type { BackCheck, Localization } from "@rescript/schema";
import { glossaryFor, languageName, textHash, type TranslatableElement } from "@rescript/engine";

/**
 * BACK-TRANSLATION CHECK (audit 2026-11-17, P2-09). Each shown language's translations go back into the source
 * language (/api/ai/back-translate) and are compared with the source. The check is stored in the survey's
 * localization (`backChecks`): the score, the flagged strings with what was found, and how each was reconciled —
 * kept as it is with a reason, or revised in the editor (recorded as a revision when the wording has changed).
 */
const CHUNK = 40;
type Review = { score: number; counts: { ok: number; review: number; shift: number }; items: { key: string; status: "ok" | "review" | "shift"; issues: { kind: string; severity: "shift" | "review"; message: string }[] }[] };

export function BackTranslationPanel({ langs, loc, elements, surveyId, editor, update, onFocus }: {
  langs: string[]; loc: Localization; elements: TranslatableElement[]; surveyId: string | null | undefined; editor: string;
  update: (fn: (cur: Localization) => Localization) => void; onFocus: (key: string) => void;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState<Record<string, string>>({});
  const byKey = React.useMemo(() => new Map(elements.map((e) => [e.key, e])), [elements]);

  const run = async (lang: string) => {
    setBusy(lang); setError(null);
    const items = elements.map((e) => ({ e, t: loc.translations[lang]?.[e.key] })).filter(({ t }) => t && t.text.trim() && t.status !== "not_translated").map(({ e, t }) => ({ key: e.key, source: e.source, translation: t!.text, kind: e.kind.replace(/_/g, " ") }));
    if (!items.length) { setBusy(null); setError(`${languageName(lang)} has nothing translated yet.`); return; }
    const all: Review["items"] = []; const back: Record<string, string> = {}; let provider = ""; const missing: string[] = [];
    try {
      for (let i = 0; i < items.length; i += CHUNK) {
        const r = await fetch("/api/ai/back-translate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId, items: items.slice(i, i + CHUNK), sourceLanguage: loc.sourceLanguage, targetLanguage: lang, glossary: glossaryFor(loc, lang) }) });
        const j = await r.json().catch(() => ({})) as { review?: Review; back?: Record<string, string>; missing?: string[]; provider?: string; error?: { message: string } | string };
        if (!j.review) { setError(r.status === 501 ? "No translation provider is configured, so the back-translation cannot run." : typeof j.error === "string" ? j.error : j.error?.message ?? `The check failed (${r.status}).`); setBusy(null); return; }
        all.push(...j.review.items); Object.assign(back, j.back ?? {}); missing.push(...(j.missing ?? [])); provider = j.provider ?? provider;
      }
    } catch { setError("Could not reach the Studio."); setBusy(null); return; }
    const counts = { ok: 0, review: 0, shift: 0 };
    for (const it of all) counts[it.status]++;
    const score = all.length ? Math.round(((counts.ok + counts.review * 0.5) / all.length) * 100) : 100;
    const check: BackCheck = {
      checkedAt: new Date().toISOString(), ...(provider ? { provider } : {}), score, counts,
      flagged: all.filter((x) => x.status !== "ok").map((x) => ({ key: x.key, status: x.status as "review" | "shift", issues: x.issues, back: back[x.key] ?? "", translationHash: textHash(loc.translations[lang]?.[x.key]?.text ?? "") })),
      record: [],
    };
    update((cur) => ({ ...cur, backChecks: { ...(cur.backChecks ?? {}), [lang]: check } }));
    if (missing.length) setError(`${missing.length} string${missing.length === 1 ? " was" : "s were"} not back-translated by the provider and ${missing.length === 1 ? "is" : "are"} not scored.`);
    setBusy(null);
  };

  const decide = (lang: string, key: string, action: "keep" | "revise") => update((cur) => {
    const c = cur.backChecks?.[lang]; if (!c) return cur;
    const f = c.flagged.find((x) => x.key === key); if (!f) return cur;
    const now = cur.translations[lang]?.[key]?.text ?? "";
    const entry = action === "keep"
      ? { key, status: f.status, action: "keep" as const, reason: (reason[`${lang}:${key}`] ?? "").trim(), by: editor, at: new Date().toISOString() }
      : { key, status: f.status, action: "revise" as const, to: now, by: editor, at: new Date().toISOString() };
    return { ...cur, backChecks: { ...cur.backChecks, [lang]: { ...c, record: [...c.record.filter((r) => r.key !== key), entry] } } };
  });

  return (
    <div className="card" style={{ padding: 10, marginBottom: 10 }} data-testid="loc-backcheck">
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <strong>Back-translation check</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>Each translation goes back into {languageName(loc.sourceLanguage)} and is compared with the source: numbers, “not”, scale direction, intensity, placeholders, glossary, missing content.</span>
      </div>
      {error && <div className="chip warn" style={{ marginTop: 6 }} data-testid="loc-backcheck-error">{error}</div>}
      {langs.map((lang) => {
        const c = loc.backChecks?.[lang];
        const decided = new Map((c?.record ?? []).map((r) => [r.key, r]));
        const open = (c?.flagged ?? []).filter((f) => !decided.has(f.key));
        return (
          <div key={lang} style={{ marginTop: 10 }} data-testid={`loc-backcheck-${lang}`}>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <strong>{languageName(lang, loc.languages.find((x) => x.code === lang))}</strong>
              {c ? <span className={`chip ${c.score >= 90 ? "ok" : c.score >= 70 ? "" : "warn"}`} data-testid={`loc-backcheck-score-${lang}`}>QA {c.score} · {c.counts.ok} ok · {c.counts.review} to review · {c.counts.shift} meaning changed · {open.length} open</span> : <span className="muted" style={{ fontSize: 12.5 }}>not checked yet</span>}
              {c && <span className="muted" style={{ fontSize: 12 }}>{c.checkedAt.slice(0, 16).replace("T", " ")}</span>}
              <button type="button" className="btn small" data-testid={`loc-backcheck-run-${lang}`} disabled={!!busy} onClick={() => run(lang)}>{busy === lang ? "Checking…" : c ? "Check again" : "Run check"}</button>
            </div>
            {c && c.flagged.length > 0 && (
              <table className="loc-table" style={{ marginTop: 6 }}>
                <thead><tr><th>Element</th><th>Source</th><th>Translation</th><th>Back-translation</th><th>Found</th><th>Reconcile</th></tr></thead>
                <tbody>
                  {c.flagged.map((f) => {
                    const el = byKey.get(f.key); const now = loc.translations[lang]?.[f.key]?.text ?? "";
                    const changed = textHash(now) !== f.translationHash;
                    const d = decided.get(f.key);
                    return (
                      <tr key={f.key} data-testid={`loc-backcheck-row-${f.key}`} data-status={f.status}>
                        <td><button type="button" className="ax-linkbtn" onClick={() => onFocus(f.key)}>{el?.label ?? f.key}</button></td>
                        <td>{el?.source}</td>
                        <td>{now}{changed && <span className="chip" style={{ marginLeft: 4 }}>edited since</span>}</td>
                        <td><em>{f.back}</em></td>
                        <td>{f.issues.map((i, k) => <div key={k} style={{ color: i.severity === "shift" ? "var(--c-error-fg)" : undefined, fontSize: 12.5 }}>{i.severity === "shift" ? "Meaning changed: " : "Check: "}{i.message}</div>)}</td>
                        <td style={{ minWidth: 200 }}>
                          {d ? <span className="chip ok" title={`${d.by}, ${d.at.slice(0, 10)}`}>{d.action === "keep" ? `kept — ${d.reason}` : "revised"}</span> : <>
                            {changed ? <button type="button" className="btn small" data-testid={`loc-backcheck-revised-${f.key}`} onClick={() => decide(lang, f.key, "revise")}>Record revision</button> : <>
                              <input className="input" style={{ width: 150 }} placeholder="Why it is right as it is" value={reason[`${lang}:${f.key}`] ?? ""} onChange={(e) => setReason((r) => ({ ...r, [`${lang}:${f.key}`]: e.target.value }))} />
                              <button type="button" className="btn small" data-testid={`loc-backcheck-keep-${f.key}`} disabled={!(reason[`${lang}:${f.key}`] ?? "").trim()} onClick={() => decide(lang, f.key, "keep")}>Keep</button>
                            </>}
                          </>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}
