"use client";
import React from "react";
import { useStudio, uid } from "./store";
import { CountInput } from "./CountInput";
import { ConditionEditor, conditionToText } from "./ConditionBuilder";
import type { ListFill, ListFillMethod } from "@rescript/schema";
import {
  decideListFill, simulateListFill, listFillStatus, listFillVariableNames, explainRejection,
  type ListFillCounts, type ListFillTrace, type ResponseState,
} from "@rescript/engine";

type Env = "TEST" | "LIVE";

/**
 * The List Fill programming panel.
 *
 * Three things a programmer needs, and the reason this is a panel rather than
 * a question property:
 *
 *   CONFIGURE  the option grid — priority, target, minimum, maximum, weight,
 *              eligibility — plus the strategy that decides between options
 *              and the rules for what happens at a target or a cap
 *   SIMULATE   run the REAL engine, in this browser, against the real
 *              counters: one respondent with a full decision trace, or N
 *              respondents to see how the allocation would distribute. Not a
 *              model of the engine — the same function the runtime calls
 *              (§31, §38), which is why what you see here is what fieldwork
 *              will do
 *   WATCH      the live dashboard: what each option has been allocated, how
 *              much room is left, and its status
 *
 * The configuration lives in the survey definition, so it versions with the
 * survey and a deployed link keeps allocating the way it was deployed (§37).
 */

const METHODS: { value: ListFillMethod; label: string; hint: string }[] = [
  { value: "highest_priority", label: "Priority order", hint: "Prefer the lowest priority number that still has room." },
  { value: "lowest_priority", label: "Reverse priority", hint: "Prefer the highest priority number first." },
  { value: "priority_quota", label: "Priority, quota-aware", hint: "Priority order, skipping anything a hard quota has closed." },
  { value: "priority_random", label: "Priority, random within band", hint: "Priority bands, random between options that share a number." },
  { value: "first_selected", label: "First selected", hint: "The first option this respondent chose." },
  { value: "selection_order", label: "Selection order", hint: "The respondent's own order of selection." },
  { value: "random", label: "Random", hint: "Even chance between everything eligible." },
  { value: "weighted_random", label: "Weighted random", hint: "Chance proportional to each option's weight." },
  { value: "balanced_random", label: "Balanced", hint: "Prefer whichever option is furthest from its target." },
  { value: "quota_aware_random", label: "Most remaining capacity", hint: "Prefer whichever option has the most room left." },
  { value: "custom", label: "Custom script", hint: "A script supplies the order; falls back to priority if it does not." },
];

const STATUS_TONE: Record<string, string> = {
  ACTIVE: "on", NEAR_CAP: "warn", TARGET_REACHED: "warn", FULL: "warn", INELIGIBLE: "", DISABLED: "",
};

export function ListFillPanel() {
  const s = useStudio();
  const [env, setEnv] = React.useState<Env>("TEST");
  const [counts, setCounts] = React.useState<ListFillCounts>({});
  const [completed, setCompleted] = React.useState<ListFillCounts>({});
  const [available, setAvailable] = React.useState(true);
  const [note, setNote] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const [simDraws, setSimDraws] = React.useState(100);
  const [sim, setSim] = React.useState<null | { listFillId: string; kind: "one"; trace: ListFillTrace } | { listFillId: string; kind: "many"; counts: Record<string, number>; empty: number; draws: number }>(null);
  const [simAnswers, setSimAnswers] = React.useState<Record<string, string[]>>({});

  const refresh = React.useCallback(() => {
    fetch(`/api/surveys/${s.surveyDbId}/listfill?environment=${env}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setCounts(d.counts ?? {});
        setCompleted(d.completed ?? {});
        setAvailable(d.available !== false);
        if (d.note) setNote({ text: d.note, ok: false });
      })
      .catch(() => {});
  }, [s.surveyDbId, env]);
  React.useEffect(refresh, [refresh]);

  const recount = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/listfill`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ environment: env, action: "recount" }),
      });
      const j = await r.json();
      if (!r.ok) setNote({ text: j.error ?? `Recount failed (${r.status})`, ok: false });
      else { setNote({ text: `Recounted ${env} from the allocations on record.`, ok: true }); refresh(); }
    } catch (e) { setNote({ text: (e as Error).message, ok: false }); }
    finally { setBusy(false); }
  };

  /** A respondent for the simulator: the answers a tester picked, nothing else. */
  const simState = (lf: ListFill, seed: number): ResponseState => ({
    surveyId: s.def.meta.id, surveyVersion: s.def.meta.version, sessionId: "simulate",
    seed, startedAt: new Date().toISOString(), status: "in_progress",
    answers: Object.fromEntries(Object.entries(simAnswers).filter(([, v]) => v.length)) as never,
    embedded: {}, calculated: {}, flags: [], stepIndex: 0,
  });

  /** Everything the source could offer, so the tester can pick a selection. */
  const sourceOptions = (lf: ListFill): { code: string; label: string }[] => {
    if (lf.source.kind === "question") {
      const q = s.def.questions.find((x) => x.id === (lf.source as { questionId: string }).questionId);
      return (q?.options ?? []).map((o) => ({ code: String(o.code), label: o.label }));
    }
    if (lf.source.kind === "static") return lf.source.items.map((i) => ({ code: String(i.code), label: i.label }));
    return lf.options.map((o) => ({ code: String(o.code), label: o.label ?? String(o.code) }));
  };

  const simulateOne = (lf: ListFill) => {
    const res = decideListFill({ def: s.def, listFill: lf, state: simState(lf, Date.now() % 100000), counts });
    setSim({ listFillId: lf.id, kind: "one", trace: res.trace });
  };
  const simulateMany = (lf: ListFill) => {
    const res = simulateListFill({ def: s.def, listFill: lf, state: simState(lf, 12345), counts, draws: simDraws });
    setSim({ listFillId: lf.id, kind: "many", counts: res.counts, empty: res.empty, draws: res.draws });
  };

  const setLf = (i: number, patch: (lf: any) => void) => s.update((d) => { patch(d.listFills[i]); });

  return (
    <div>
      <div className="row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>List Fill</h2>
        <span className="grow" />
        <div className="row" style={{ gap: 4 }} data-testid="lf-env">
          {(["TEST", "LIVE"] as Env[]).map((e) => (
            <button key={e} className={`btn small ${env === e ? "primary" : ""}`} data-testid={`lf-env-${e}`} onClick={() => setEnv(e)}>
              {e === "TEST" ? "Test data" : "Live data"}
            </button>
          ))}
        </div>
        <button className="btn small" onClick={refresh}>↻ refresh</button>
        <button className="btn small" data-testid="lf-recount" disabled={busy || !available} onClick={recount}>
          {busy ? "Recounting…" : "↻ Recount from allocations"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        A List Fill takes a list — usually what a respondent selected — and allocates one or more items to them by
        priority, target and capacity, then writes the result into destination questions and{" "}
        <code>{"{{LISTFILL_…}}"}</code> variables. Counts shown are <strong>{env === "TEST" ? "test" : "live"}</strong>{" "}
        allocations; the two never share a counter. Caps are enforced by the database at the moment a slot is claimed, so a
        maximum cannot be exceeded however many respondents arrive at once.
      </p>
      {!available && (
        <div className="chip warn qd-note" data-testid="lf-migration-note">
          Sample-level allocation needs migration 0007 — configuration can be edited now, and counts appear once it is applied.
        </div>
      )}
      {note && <div className={`chip ${note.ok ? "on" : "warn"} qd-note`} data-testid="lf-note">{note.text}</div>}

      {s.def.listFills.length === 0 && (
        <div className="card" style={{ padding: 14 }} data-testid="lf-empty">
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            No List Fill yet. Add one, choose the question whose answers feed it, then set each option&apos;s priority and
            limits in the grid.
          </p>
        </div>
      )}

      {s.def.listFills.map((lf, i) => {
        const status = listFillStatus(lf, counts);
        const done = completed[lf.id] ?? {};
        const isOpen = open === lf.id;
        const srcOpts = sourceOptions(lf);
        const total = status.total;
        return (
          <div key={lf.id} className="card" data-testid={`lf-${lf.id}`}>
            <div className="row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
              <input className="input" style={{ width: 150 }} value={lf.name ?? ""} placeholder="name (e.g. Q1)"
                data-testid={`lf-name-${lf.id}`}
                onChange={(e) => setLf(i, (x) => { x.name = e.target.value; })} />
              <label className="row" style={{ gap: 4 }}>
                <input type="checkbox" checked={lf.enabled}
                  data-testid={`lf-enabled-${lf.id}`}
                  onChange={(e) => setLf(i, (x) => { x.enabled = e.target.checked; })} /> enabled
              </label>
              <select className="select" style={{ width: 160 }}
                value={lf.source.kind === "question" ? lf.source.questionId : ""}
                data-testid={`lf-source-${lf.id}`}
                onChange={(e) => setLf(i, (x) => {
                  x.source = e.target.value
                    ? { kind: "question", questionId: e.target.value, take: "selected" }
                    : { kind: "static", items: [] };
                })}>
                <option value="">— source —</option>
                {s.def.questions.filter((q) => (q.options?.length ?? 0) > 0).map((q) => (
                  <option key={q.id} value={q.id}>{q.code} — {q.variableName}</option>
                ))}
              </select>
              {lf.source.kind === "question" && (
                <select className="select" style={{ width: 120 }} value={lf.source.take}
                  onChange={(e) => setLf(i, (x) => { x.source.take = e.target.value; })}>
                  <option value="selected">selected</option>
                  <option value="displayed">displayed</option>
                  <option value="all">all options</option>
                </select>
              )}
              <span className="mono muted" data-testid={`lf-total-${lf.id}`}>{total} allocated</span>
              <span className="grow" />
              <button className="btn small" data-testid={`lf-open-${lf.id}`} onClick={() => setOpen(isOpen ? null : lf.id)}>
                {isOpen ? "▾ hide" : "▸ configure"}
              </button>
              <button className="btn small danger" onClick={() => s.update((d) => { d.listFills.splice(i, 1); })}>× list fill</button>
            </div>

            {/* the dashboard is always visible: it is what you check during fieldwork */}
            <div className="table-wrap">
            <table className="grid lf-grid" data-testid={`lf-grid-${lf.id}`}>
              <thead>
                <tr>
                  <th>option</th><th>priority</th><th>target</th><th>min</th><th>max</th><th>weight</th>
                  <th>allocated</th><th>completed</th><th>left</th><th>status</th><th />
                </tr>
              </thead>
              <tbody>
                {status.rows.map((row) => {
                  const oi = lf.options.findIndex((o) => String(o.code) === row.code);
                  const opt = oi >= 0 ? lf.options[oi] : null;
                  const pct = row.fill ?? 0;
                  return (
                    <tr key={row.code} data-code={row.code} data-status={row.status}>
                      <td className="mono">
                        {row.code}
                        <span className="muted" style={{ marginLeft: 6 }}>{row.label !== row.code ? row.label : ""}</span>
                      </td>
                      <td><CountInput width={62} value={opt?.priority} onChange={(v) => oi >= 0 && setLf(i, (x) => { x.options[oi].priority = v; })} /></td>
                      <td><CountInput width={70} value={opt?.target} onChange={(v) => oi >= 0 && setLf(i, (x) => { x.options[oi].target = v; })} /></td>
                      <td><CountInput width={62} value={opt?.minimum} onChange={(v) => oi >= 0 && setLf(i, (x) => { x.options[oi].minimum = v; })} /></td>
                      <td><CountInput width={70} value={opt?.maximum} onChange={(v) => oi >= 0 && setLf(i, (x) => { x.options[oi].maximum = v; })} /></td>
                      <td><CountInput width={58} value={opt?.weight} onChange={(v) => oi >= 0 && setLf(i, (x) => { x.options[oi].weight = v; })} /></td>
                      <td className="mono">{row.current}</td>
                      <td className="mono">{done[row.code] ?? 0}</td>
                      <td className="mono">{row.remaining === null ? "∞" : row.remaining}</td>
                      <td>
                        <span className={`chip ${STATUS_TONE[row.status] ?? ""}`} style={{ fontSize: 10 }}>{row.status.replace(/_/g, " ").toLowerCase()}</span>
                        {row.maximum != null && <div className="qbar" style={{ marginTop: 4 }}><div className={pct >= 100 ? "full" : ""} style={{ width: `${Math.min(100, pct)}%` }} /></div>}
                      </td>
                      <td>
                        {oi >= 0 && (
                          <label className="row" style={{ gap: 3 }} title="Eligible for allocation">
                            <input type="checkbox" checked={opt?.eligible !== false}
                              data-testid={`lf-eligible-${lf.id}-${row.code}`}
                              onChange={(e) => setLf(i, (x) => { x.options[oi].eligible = e.target.checked; })} />
                          </label>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!status.rows.length && (
                  <tr><td colSpan={11} className="muted" style={{ fontSize: 12 }}>
                    No options configured. Use “add every option from the source” below, then set priorities and limits.
                  </td></tr>
                )}
              </tbody>
            </table>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button className="btn small" data-testid={`lf-fill-options-${lf.id}`} disabled={!srcOpts.length}
                onClick={() => setLf(i, (x) => {
                  for (const o of srcOpts) {
                    if (x.options.some((e: any) => String(e.code) === o.code)) continue;
                    x.options.push({ code: o.code, label: o.label, eligible: true });
                  }
                })}>
                + add every option from the source
              </button>
              <span className="muted" style={{ fontSize: 11 }}>
                Priority is not a quota: a lower number is tried first, and target / maximum decide when to move on.
              </span>
            </div>

            {isOpen && (
              <div style={{ marginTop: 14 }}>
                {/* ---------------------------------------- strategy */}
                <div className="flabel">how the engine chooses</div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                  <select className="select" style={{ width: 210 }} value={lf.selection.method}
                    data-testid={`lf-method-${lf.id}`}
                    onChange={(e) => setLf(i, (x) => { x.selection.method = e.target.value; })}>
                    {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                  <label className="row" style={{ gap: 4 }}>items
                    <CountInput width={64} allowEmpty={false}
                      value={lf.selection.count.kind === "fixed" ? lf.selection.count.n : undefined}
                      onChange={(v) => setLf(i, (x) => { x.selection.count = { kind: "fixed", n: v ?? 1 }; })} />
                  </label>
                  <label className="row" style={{ gap: 4 }}>
                    <input type="checkbox" checked={lf.selection.count.kind === "all"}
                      onChange={(e) => setLf(i, (x) => { x.selection.count = e.target.checked ? { kind: "all" } : { kind: "fixed", n: 1 }; })} />
                    all eligible
                  </label>
                </div>
                <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
                  {METHODS.find((m) => m.value === lf.selection.method)?.hint}
                </p>

                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <label className="row" style={{ gap: 4 }}>equal priority
                    <select className="select" style={{ width: 150 }} value={lf.selection.equalPriority}
                      onChange={(e) => setLf(i, (x) => { x.selection.equalPriority = e.target.value; })}>
                      <option value="random">random</option>
                      <option value="balanced">balanced to target</option>
                      <option value="sequential">configured order</option>
                      <option value="weighted">weighted</option>
                      <option value="quota_aware_random">most room left</option>
                    </select>
                  </label>
                  <label className="row" style={{ gap: 4 }}>at target
                    <select className="select" style={{ width: 140 }} value={lf.selection.afterTarget}
                      onChange={(e) => setLf(i, (x) => { x.selection.afterTarget = e.target.value; })}>
                      <option value="continue">keep using</option>
                      <option value="reduce_priority">drop behind others</option>
                      <option value="next_priority">next priority</option>
                      <option value="random_pool">into random pool</option>
                      <option value="stop">stop using</option>
                    </select>
                  </label>
                  <label className="row" style={{ gap: 4 }}>when nothing is left
                    <select className="select" style={{ width: 150 }} value={lf.selection.fallback}
                      onChange={(e) => setLf(i, (x) => { x.selection.fallback = e.target.value; })}>
                      <option value="none">allocate nothing</option>
                      <option value="random_eligible">random eligible</option>
                      <option value="weighted_eligible">weighted eligible</option>
                      <option value="balanced_eligible">balanced eligible</option>
                      <option value="next_priority">next priority</option>
                    </select>
                  </label>
                </div>

                {/* ---------------------------------------- tracking */}
                <div className="flabel" style={{ marginTop: 12 }}>counting</div>
                <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                  <label className="row" style={{ gap: 4 }}>
                    <input type="checkbox" checked={lf.tracking.sampleLevel}
                      data-testid={`lf-samplelevel-${lf.id}`}
                      onChange={(e) => setLf(i, (x) => { x.tracking.sampleLevel = e.target.checked; })} />
                    count across the sample (targets and maximums apply)
                  </label>
                  <label className="row" style={{ gap: 4 }}>
                    <input type="checkbox" checked={lf.tracking.countOnCompleteOnly}
                      onChange={(e) => setLf(i, (x) => { x.tracking.countOnCompleteOnly = e.target.checked; })} />
                    count completed interviews only
                  </label>
                  <label className="row" style={{ gap: 4 }}>
                    <input type="checkbox" checked={lf.tracking.respectQuotas}
                      onChange={(e) => setLf(i, (x) => { x.tracking.respectQuotas = e.target.checked; })} />
                    respect hard quotas
                  </label>
                  <label className="row" style={{ gap: 4 }}>
                    <input type="checkbox" checked={lf.storeTrace}
                      onChange={(e) => setLf(i, (x) => { x.storeTrace = e.target.checked; })} />
                    store the decision trace on each response
                  </label>
                </div>
                {lf.tracking.countOnCompleteOnly && (
                  <p className="muted" style={{ fontSize: 11 }}>
                    Counting completes means in-progress sessions do not close an option, so slightly more respondents than
                    the target may be given it while they are still answering. Screen-outs give their slot back.
                  </p>
                )}

                {/* ---------------------------------------- destinations */}
                <div className="flabel" style={{ marginTop: 12 }}>where the result goes</div>
                {lf.destinations.map((dest, di) => (
                  <div key={di} className="row" style={{ gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
                    <select className="select" style={{ width: 170 }} value={dest.questionId}
                      onChange={(e) => setLf(i, (x) => { x.destinations[di].questionId = e.target.value; })}>
                      <option value="">— question —</option>
                      {s.def.questions.map((q) => <option key={q.id} value={q.id}>{q.code} — {q.variableName}</option>)}
                    </select>
                    <select className="select" style={{ width: 130 }} value={dest.write}
                      onChange={(e) => setLf(i, (x) => { x.destinations[di].write = e.target.value; })}>
                      <option value="answer">write the answer</option>
                      <option value="piping_only">piping only</option>
                    </select>
                    <label className="row" style={{ gap: 4 }}>item
                      <CountInput width={58} value={dest.position} onChange={(v) => setLf(i, (x) => { x.destinations[di].position = v; })} />
                    </label>
                    <label className="row" style={{ gap: 4 }}>if unused
                      <select className="select" style={{ width: 140 }} value={dest.whenUnused ?? ""}
                        onChange={(e) => setLf(i, (x) => { x.destinations[di].whenUnused = e.target.value || undefined; })}>
                        <option value="">leave as is</option>
                        <option value="hide">hide the question</option>
                        <option value="skip">skip it</option>
                        <option value="disable">show it disabled</option>
                        <option value="blank">clear the answer</option>
                        <option value="do_not_instantiate">do not create it</option>
                      </select>
                    </label>
                    <button className="btn small danger" onClick={() => setLf(i, (x) => { x.destinations.splice(di, 1); })}>×</button>
                  </div>
                ))}
                <button className="btn small" onClick={() => setLf(i, (x) => { x.destinations.push({ questionId: "", write: "answer" }); })}>
                  + destination
                </button>

                {/* ---------------------------------------- run condition */}
                <div className="flabel" style={{ marginTop: 12 }}>
                  run this List Fill only when — {lf.runWhen ? conditionToText(lf.runWhen as never, s.def) : "always"}
                </div>
                <ConditionEditor value={(lf.runWhen ?? { type: "group", op: "and", children: [] }) as never}
                  onChange={(when) => setLf(i, (x) => {
                    const empty = (when as any)?.type === "group" && !(when as any).children?.length;
                    x.runWhen = empty ? undefined : when;
                  })} />

                {/* ---------------------------------------- variables */}
                <div className="flabel" style={{ marginTop: 12 }}>variables this List Fill creates</div>
                <div className="qs-chips">
                  {listFillVariableNames(lf).slice(0, 24).map((v) => (
                    <span key={v.name} className="chip mono" style={{ fontSize: 10 }}>{v.name}</span>
                  ))}
                </div>

                {/* ---------------------------------------- simulator */}
                <div className="flabel" style={{ marginTop: 14 }}>simulate</div>
                <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
                  Runs the real allocation engine against the {env === "TEST" ? "test" : "live"} counters shown above.
                  Nothing is written and no slot is claimed.
                </p>
                {lf.source.kind === "question" && (
                  <div className="qs-chips" style={{ marginBottom: 8 }}>
                    {srcOpts.map((o) => {
                      const qid = (lf.source as { questionId: string }).questionId;
                      const picked = (simAnswers[qid] ?? []).includes(o.code);
                      return (
                        <label key={o.code} className={`chip qs-chip-check ${picked ? "on" : ""}`}>
                          <input type="checkbox" checked={picked}
                            data-testid={`lf-sim-pick-${lf.id}-${o.code}`}
                            onChange={(e) => setSimAnswers((prev) => {
                              const cur = prev[qid] ?? [];
                              return { ...prev, [qid]: e.target.checked ? [...cur, o.code] : cur.filter((c) => c !== o.code) };
                            })} /> {o.code}
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <button className="btn small primary" data-testid={`lf-sim-one-${lf.id}`} onClick={() => simulateOne(lf)}>
                    Simulate one respondent
                  </button>
                  <label className="row" style={{ gap: 4 }}>
                    <CountInput width={70} allowEmpty={false} value={simDraws} onChange={(v) => setSimDraws(Math.max(1, v ?? 1))} />
                    <button className="btn small" data-testid={`lf-sim-many-${lf.id}`} onClick={() => simulateMany(lf)}>
                      Simulate {simDraws} respondents
                    </button>
                  </label>
                </div>

                {sim?.listFillId === lf.id && sim.kind === "one" && (
                  <div className="card" style={{ padding: 10, marginTop: 8 }} data-testid={`lf-trace-${lf.id}`}>
                    <div className="row"><strong style={{ fontSize: 12 }}>{sim.trace.reason}</strong></div>
                    <table className="grid" style={{ marginTop: 8 }}>
                      <thead><tr><th>option</th><th>priority</th><th>allocated</th><th>left</th><th>outcome</th></tr></thead>
                      <tbody>
                        {sim.trace.options.map((o) => (
                          <tr key={o.code} data-code={o.code} data-position={o.position ?? ""}>
                            <td className="mono">{o.code}</td>
                            <td className="mono">{o.priority ?? "—"}</td>
                            <td className="mono">{o.current}</td>
                            <td className="mono">{o.remaining === null ? "∞" : o.remaining}</td>
                            <td style={{ fontSize: 11 }}>
                              {o.position != null
                                ? <span className="chip on">item {o.position}{o.selectedBy ? ` — ${o.selectedBy}` : ""}</span>
                                : <span className="muted">{explainRejection(o)}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="flabel" style={{ marginTop: 8 }}>every decision, in order</div>
                    <ol className="muted" style={{ fontSize: 11, marginTop: 0, paddingLeft: 18 }}>
                      {sim.trace.steps.map((line, li) => <li key={li}>{line}</li>)}
                    </ol>
                  </div>
                )}

                {sim?.listFillId === lf.id && sim.kind === "many" && (
                  <div className="card" style={{ padding: 10, marginTop: 8 }} data-testid={`lf-sim-result-${lf.id}`}>
                    <div style={{ fontSize: 12, marginBottom: 6 }}>
                      {sim.draws} respondents, starting from the counts above.
                      {sim.empty > 0 && <> <strong>{sim.empty}</strong> would get nothing — every option was full.</>}
                    </div>
                    <table className="grid">
                      <thead><tr><th>option</th><th>would end at</th><th>gained</th></tr></thead>
                      <tbody>
                        {Object.entries(sim.counts).sort((a, b) => b[1] - a[1]).map(([code, n]) => (
                          <tr key={code} data-code={code}>
                            <td className="mono">{code}</td>
                            <td className="mono">{n}</td>
                            <td className="mono">+{n - (counts[lf.id]?.[code] ?? 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      <button className="btn" data-testid="lf-add" onClick={() =>
        s.update((d) => {
          d.listFills.push({
            id: uid("listfill"),
            name: `LF${d.listFills.length + 1}`,
            enabled: true,
            source: { kind: "static", items: [] },
            selection: {
              count: { kind: "fixed", n: 1 }, method: "highest_priority", equalPriority: "random",
              afterTarget: "reduce_priority", afterMaximum: "next_priority", fallback: "random_eligible",
              weighted: false, allowDuplicates: false, fillToCount: true,
            },
            tracking: { sampleLevel: true, respectQuotas: false, quotaIds: [], separateTestCounts: true, countOnCompleteOnly: false },
            options: [], destinations: [], storeTrace: false,
          } as never);
        })}>
        + List Fill
      </button>
    </div>
  );
}
