"use client";
import { CountInput } from "./CountInput";
import React from "react";
import { useStudio, uid } from "./store";
import { ConditionEditor, conditionToText } from "./ConditionBuilder";

type Env = "TEST" | "LIVE";

/**
 * Quota manager + counts dashboard (requirement §15).
 *
 * The counts shown belong to ONE environment — test responses and live
 * responses fill separate counters (migration 0006), so a test run can never
 * make a live cell look full. The selector says which dataset is on screen.
 *
 * "Recount from data" rebuilds the counters from the responses that exist,
 * which is the honest number after an edit, a delete or an import; the live
 * increments are a cache of it. "Generate from data" reads the distinct
 * answers of the questions you pick and writes the cells for you — ordinary
 * cells with ordinary conditions, so the runtime routes on them without
 * knowing where they came from.
 */
export function QuotasPanel({ focusQuotaId }: { focusQuotaId?: string } = {}) {
  const s = useStudio();
  // opened from the dashboard's "Edit Logic": bring that quota into view once
  React.useEffect(() => {
    if (!focusQuotaId) return;
    const el = document.querySelector(`[data-quota-logic-id="${focusQuotaId}"]`);
    if (el) { el.scrollIntoView({ block: "start" }); el.classList.add("qd-focus"); }
  }, [focusQuotaId]);
  const [counts, setCounts] = React.useState<Record<string, Record<string, number>>>({});
  const [env, setEnv] = React.useState<Env>("TEST");
  const [perEnvironment, setPerEnvironment] = React.useState(true);
  const [busy, setBusy] = React.useState<null | "recount" | "generate">(null);
  const [note, setNote] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [genOpen, setGenOpen] = React.useState(false);
  const [genQs, setGenQs] = React.useState<string[]>([]);

  const refresh = React.useCallback(() => {
    fetch(`/api/surveys/${s.surveyDbId}/quotas?environment=${env}`, { cache: "no-store" }).then((r) => r.json())
      .then((d) => { setCounts(d.counts ?? {}); if (typeof d.perEnvironment === "boolean") setPerEnvironment(d.perEnvironment); }).catch(() => {});
  }, [s.surveyDbId, env]);
  React.useEffect(refresh, [refresh]);

  const recount = async () => {
    setBusy("recount"); setNote(null);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/quotas/recount`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ environment: env }) });
      const j = await r.json();
      if (!r.ok) setNote({ text: j.error ?? `Recount failed (${r.status})`, ok: false });
      else {
        const res = j.results?.[env];
        setNote({ text: `Recounted ${env} from ${res?.responses ?? 0} completed response${res?.responses === 1 ? "" : "s"} — ${res?.cells ?? 0} cell${res?.cells === 1 ? "" : "s"} have a count.`, ok: true });
        refresh();
      }
    } catch (e) { setNote({ text: (e as Error).message, ok: false }); }
    finally { setBusy(null); }
  };

  /** Read the data, then write the cells as an ordinary (undoable) edit. */
  const generate = async () => {
    if (!genQs.length) return;
    setBusy("generate"); setNote(null);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/quotas/recount`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ environment: env, generate: true, questionIds: genQs }),
      });
      const j = await r.json();
      if (!r.ok) { setNote({ text: j.error ?? `Could not read the data (${r.status})`, ok: false }); return; }
      let added = 0;
      s.labelNextEdit?.("generate quota from data");
      s.update((d) => {
        for (const q of j.questions ?? []) {
          if (!q.cells.length) continue;
          d.quotas.push({
            id: uid("quota"),
            name: `${q.code} — from ${env.toLowerCase()} data`,
            mode: "hard",
            cells: q.cells.map((c: any) => ({ id: c.id, label: c.label, when: c.when, limit: c.limit, limitType: "count" })),
            onFull: { kind: "terminate" },
            countStatus: ["complete"],
          } as never);
          added += q.cells.length;
        }
      });
      setNote({ text: `Added ${added} cell${added === 1 ? "" : "s"} from ${j.responses} completed ${env.toLowerCase()} response${j.responses === 1 ? "" : "s"}. Limits start at the counts found — edit them, then Save version.`, ok: true });
      setGenOpen(false); setGenQs([]);
      setTimeout(refresh, 400);
    } catch (e) { setNote({ text: (e as Error).message, ok: false }); }
    finally { setBusy(null); }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Quotas</h2>
        <span className="grow" />
        <div className="row" style={{ gap: 4 }} data-testid="quota-env">
          {(["TEST", "LIVE"] as Env[]).map((e) => (
            <button key={e} className={`btn small ${env === e ? "primary" : ""}`} data-testid={`quota-env-${e}`} onClick={() => setEnv(e)}>{e === "TEST" ? "Test data" : "Live data"}</button>
          ))}
        </div>
        <button className="btn small" onClick={refresh}>↻ refresh</button>
        <button className="btn small" data-testid="quota-recount" disabled={!!busy} onClick={recount}>{busy === "recount" ? "Recounting…" : "↻ Recount from data"}</button>
        <button className="btn small" data-testid="quota-generate-open" disabled={!!busy} onClick={() => setGenOpen((o) => !o)}>+ Generate from data</button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Counts shown are <strong>{env === "TEST" ? "test" : "live"}</strong> responses. Hard quotas terminate when full (add a
        <em> quota check</em> node in the Survey Flow to enforce mid-survey); soft quotas only flag. Percent limits use the
        quota&apos;s target total. Multi-dimensional quotas = one cell per crossing (e.g. Male × 18–24).
      </p>
      {!perEnvironment && (
        <div className="chip warn qd-note" data-testid="quota-shared-note">
          These counters are shared between test and live until migration 0006 is applied — the numbers shown are the combined ones.
        </div>
      )}
      {note && <div className={`chip ${note.ok ? "on" : "warn"} qd-note`} data-testid="quota-note">{note.text}</div>}
      {genOpen && (
        <div className="card" style={{ padding: 12 }} data-testid="quota-generate">
          <div className="flabel">Generate one quota per question, from the {env === "TEST" ? "test" : "live"} responses</div>
          <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
            One cell per distinct answer, with the number of completed responses that gave it as the starting limit. Cells use
            the ordinary condition builder afterwards, so you can merge or edit them.
          </p>
          <div className="qs-chips" style={{ marginBottom: 8 }}>
            {s.def.questions.filter((q) => (q.options?.length ?? 0) > 0 || /numeric|open_text|date/.test(String(q.type))).map((q) => (
              <label key={q.id} className={`chip qs-chip-check ${genQs.includes(q.id) ? "on" : ""}`}>
                <input type="checkbox" checked={genQs.includes(q.id)} data-testid={`quota-gen-q-${q.code}`}
                  onChange={(e) => setGenQs((x) => e.target.checked ? [...x, q.id] : x.filter((y) => y !== q.id))} /> {q.code}
              </label>
            ))}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small primary" data-testid="quota-generate-run" disabled={!genQs.length || !!busy} onClick={generate}>
              {busy === "generate" ? "Reading data…" : `Generate from ${genQs.length} question${genQs.length === 1 ? "" : "s"}`}
            </button>
            <button className="btn small" onClick={() => { setGenOpen(false); setGenQs([]); }}>Cancel</button>
          </div>
        </div>
      )}
      {s.def.quotas.map((qt, qi) => (
        <div key={qt.id} className="card" data-quota-logic-id={qt.id} data-testid="quota-logic-card">
          <div className="row" style={{ marginBottom: 8 }}>
            <input className="input" style={{ width: 220 }} value={qt.name}
              onChange={(e) => s.update((d) => { d.quotas[qi].name = e.target.value; })} />
            <select className="select" value={qt.mode}
              onChange={(e) => s.update((d) => { d.quotas[qi].mode = e.target.value as any; })}>
              <option value="hard">hard</option><option value="soft">soft</option>
            </select>
            <label className="row" style={{ gap: 4 }}>target total
              <CountInput value={qt.targetTotal}
                onChange={(v) => s.update((d) => { d.quotas[qi].targetTotal = v; })} />
            </label>
            <select className="select" value={qt.onFull.kind}
              onChange={(e) => s.update((d) => { d.quotas[qi].onFull.kind = e.target.value as any; })}>
              <option value="terminate">terminate</option>
              <option value="redirect">redirect</option>
              <option value="flag">flag</option>
              <option value="warn">warn</option>
            </select>
            <span className="grow" />
            <button className="btn small danger" onClick={() => s.update((d) => { d.quotas.splice(qi, 1); })}>× quota</button>
          </div>

          {qt.cells.map((cell, ci) => {
            const count = counts[qt.id]?.[cell.id] ?? 0;
            const limit = cell.limitType === "percent"
              ? Math.floor((cell.limit / 100) * (qt.targetTotal ?? 0))
              : cell.limit;
            const pct = limit ? Math.min(100, (count / limit) * 100) : 0;
            return (
              <div key={cell.id} className="card" style={{ padding: 10 }}>
                <div className="row">
                  <input className="input" style={{ width: 180 }} value={cell.label}
                    onChange={(e) => s.update((d) => { d.quotas[qi].cells[ci].label = e.target.value; })} />
                  <CountInput width={84} allowEmpty={false} value={cell.limit}
                    onChange={(v) => s.update((d) => { d.quotas[qi].cells[ci].limit = v ?? 0; })} />
                  <select className="select" style={{ width: 100 }} value={cell.limitType}
                    onChange={(e) => s.update((d) => { d.quotas[qi].cells[ci].limitType = e.target.value as any; })}>
                    <option value="count">count</option><option value="percent">%</option>
                  </select>
                  <span className="mono muted">{count}/{limit || "∞"}</span>
                  <span className="grow" />
                  <button className="btn small danger"
                    onClick={() => s.update((d) => { d.quotas[qi].cells.splice(ci, 1); })}>×</button>
                </div>
                <div className="qbar"><div className={pct >= 100 ? "full" : ""} style={{ width: `${pct}%` }} /></div>
                <div className="flabel" style={{ marginTop: 8 }}>cell condition — {conditionToText(cell.when, s.def)}</div>
                <ConditionEditor value={cell.when}
                  onChange={(when) => s.update((d) => { d.quotas[qi].cells[ci].when = when; })} />
              </div>
            );
          })}
          <button className="btn small" onClick={() =>
            s.update((d) => {
              d.quotas[qi].cells.push({
                id: uid("cell"), label: `Cell ${qt.cells.length + 1}`,
                when: { type: "group", op: "and", children: [] }, limit: 50, limitType: "count",
              });
            })}>
            + cell
          </button>
        </div>
      ))}
      <button className="btn" onClick={() =>
        s.update((d) => {
          d.quotas.push({
            id: uid("quota"), name: `Quota ${d.quotas.length + 1}`, mode: "hard",
            cells: [], onFull: { kind: "terminate" }, countStatus: ["complete"],
          });
        })}>
        + quota
      </button>
    </div>
  );
}
