"use client";
import React from "react";

export interface BuilderPool {
  id: string;
  code: string;
  name: string;
  description: string;
  draw: number | null;
  position: number;
  randomize: boolean;
}

/**
 * RANDOMIZATION, IN THE INTERVIEWER'S TERMS.
 *
 * The draw engine has existed since Phase 1 and drawn from pools with pick-N-
 * of-M, seeded shuffles and a recorded, explainable sequence. Nothing could
 * reach it: there was no way to create a pool. This is that way.
 *
 * ## How the brief's shapes map
 *
 *   Fixed order       — no pools. Every question is loose, positional.
 *   Random order      — one pool holding everything, "shuffle" on.
 *   Mixed structure   — several pools in order: Q1 alone (fixed), a pool of
 *                       five drawing three, Q7 alone, a pool of five shuffled.
 *
 * A question belongs to at most one pool, chosen on the question itself. A
 * pool with "draw" blank takes every question in it — a fixed block that can
 * still be shuffled internally. Pools appear in the interview in the order
 * listed here unless "shuffle the pools" is on.
 *
 * ## What "reproducible" means here
 *
 * Every candidate's draw is made once, from a seed stored on their interview,
 * and the resulting sequence is written down. Changing a pool later changes
 * what the NEXT candidate gets, never what an existing candidate got — and
 * `explainDraw` can say, for any past interview, whether today's pool would
 * still produce the sequence they were given.
 */
export function PoolsPanel({ projectId, pools: initial, randomizePools: initialRandomizePools, questionCounts, mayEdit }: {
  projectId: string;
  pools: BuilderPool[];
  randomizePools: boolean;
  /** how many questions currently sit in each pool, by pool id */
  questionCounts: Record<string, number>;
  mayEdit: boolean;
}) {
  const [pools, setPools] = React.useState(initial);
  const [randomizePools, setRandomizePools] = React.useState(initialRandomizePools);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError(null);
    const res = await fetch(`/api/projects/${projectId}/pools`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const reply = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !reply.ok) { setError(reply.error ?? "That pool could not be created."); return; }
    setPools((ps) => [...ps, reply.pool]);
    setName("");
  }

  async function patch(pool: BuilderPool, changes: Partial<Pick<BuilderPool, "draw" | "randomize" | "name">>) {
    setPools((ps) => ps.map((p) => (p.id === pool.id ? { ...p, ...changes } : p)));
    const res = await fetch(`/api/projects/${projectId}/pools/${pool.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
    });
    if (!res.ok) setError("That change could not be saved — reload to see the real settings.");
  }

  async function remove(pool: BuilderPool) {
    setBusy(true); setError(null);
    const res = await fetch(`/api/projects/${projectId}/pools/${pool.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) { setError("That pool could not be removed."); return; }
    setPools((ps) => ps.filter((p) => p.id !== pool.id));
  }

  async function toggleRandomizePools(on: boolean) {
    setRandomizePools(on);
    const res = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ randomizePools: on }),
    });
    if (!res.ok) setError("That change could not be saved.");
  }

  return (
    <section className="card" data-testid="pools-panel">
      <h2 style={{ marginTop: 0 }}>Order and randomization</h2>
      <p className="muted small" style={{ marginTop: 4 }}>
        Questions outside any pool appear in their listed order. Put questions in a pool to draw
        some of them at random, shuffle them, or both. Each candidate&apos;s draw is made once and
        recorded, so it can be explained later.
      </p>

      {pools.length === 0 && (
        <p className="tiny muted" data-testid="no-pools">No pools — every candidate sees every question, in order.</p>
      )}

      {pools.map((p) => (
        <div key={p.id} data-testid="pool-row" data-code={p.code}
          style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 10 }}>
          <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <strong><code>{p.code}</code></strong>
            {mayEdit
              ? <input value={p.name} onChange={(e) => void patch(p, { name: e.target.value })} style={{ maxWidth: 220 }} data-testid="pool-name" />
              : <span>{p.name}</span>}
            <span className="tiny muted">{questionCounts[p.id] ?? 0} question{(questionCounts[p.id] ?? 0) === 1 ? "" : "s"}</span>
          </div>
          <div className="row" style={{ gap: 14, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
            <label className="row" style={{ gap: 6, alignItems: "center" }}>
              <span className="tiny muted">Ask</span>
              <input type="number" min={0} max={questionCounts[p.id] ?? 99} value={p.draw ?? ""} placeholder="all"
                disabled={!mayEdit} style={{ width: 70 }} data-testid="pool-draw"
                onChange={(e) => void patch(p, { draw: e.target.value === "" ? null : Number(e.target.value) })} />
              <span className="tiny muted">of {questionCounts[p.id] ?? 0}</span>
            </label>
            <label className="row" style={{ gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={p.randomize} disabled={!mayEdit} data-testid="pool-randomize"
                onChange={(e) => void patch(p, { randomize: e.target.checked })} />
              <span className="tiny">Shuffle the order within this pool</span>
            </label>
            {mayEdit && (
              <button type="button" className="btn small secondary" disabled={busy} onClick={() => void remove(p)} data-testid="pool-remove">
                Remove pool
              </button>
            )}
          </div>
          {p.draw !== null && p.draw > (questionCounts[p.id] ?? 0) && (
            <p className="note warn" style={{ marginTop: 6 }}>
              This pool asks for {p.draw} but holds {questionCounts[p.id] ?? 0}. Candidates will get all of them, and the draw
              will be recorded as short.
            </p>
          )}
        </div>
      ))}

      {pools.length > 1 && (
        <label className="row" style={{ gap: 8, alignItems: "center", marginTop: 12 }}>
          <input type="checkbox" checked={randomizePools} disabled={!mayEdit} data-testid="randomize-pools"
            onChange={(e) => void toggleRandomizePools(e.target.checked)} />
          <span className="small">Shuffle the order of the pools themselves</span>
        </label>
      )}

      {mayEdit && (
        <form onSubmit={add} className="row" style={{ gap: 8, marginTop: 14, alignItems: "center" }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New pool, e.g. Technical" data-testid="pool-new-name" />
          <button className="btn" disabled={busy || !name.trim()} data-testid="pool-add">Add a pool</button>
        </form>
      )}

      {error && <p className="note bad" style={{ marginTop: 10 }}>{error}</p>}
    </section>
  );
}
