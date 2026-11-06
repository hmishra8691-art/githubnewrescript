"use client";
import React from "react";
import type { AnalysisDefinition } from "@rescript/analytics";
import type { AxApi, Row, RunResult } from "../api";

/**
 * RESULTS FOR THE ARCHITECT, a few at a time. Every analysis on show is computed server-side (the stored result
 * when there is one), three in flight at once, each ending in a result or a visible failure with a retry — the
 * same discipline as the Charts library. Results are keyed by analysis id and shared by the Workspace and the
 * Properties panel, so an analysis shown in both is computed once.
 */
export interface ResultsState { results: Record<string, RunResult>; status: Record<string, "loading" | "error">; errors: Record<string, string> }

export function useResults(api: AxApi, analyses: Row[], wanted: readonly string[]): ResultsState & { retry: (id: string) => void; invalidate: (id?: string) => void } {
  const [results, setResults] = React.useState<Record<string, RunResult>>({});
  const [status, setStatus] = React.useState<Record<string, "loading" | "error">>({});
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const inFlight = React.useRef(new Set<string>());
  const done = React.useRef(new Set<string>());
  const analysesRef = React.useRef(analyses); analysesRef.current = analyses;
  const load = React.useCallback(async (id: string, force = false) => {
    if (!force && (done.current.has(id) || inFlight.current.has(id))) return;
    const a = analysesRef.current.find((x) => x.id === id); if (!a) return;
    inFlight.current.add(id); setStatus((s) => ({ ...s, [id]: "loading" }));
    try {
      const { result } = await api.run({ ...(a.definition as AnalysisDefinition), name: a.name });
      done.current.add(id); setResults((r) => ({ ...r, [id]: result }));
      setStatus((s) => { const { [id]: _x, ...rest } = s; void _x; return rest; });
    } catch (e) { setStatus((s) => ({ ...s, [id]: "error" })); setErrors((x) => ({ ...x, [id]: (e as Error).message })); }
    finally { inFlight.current.delete(id); }
  }, [api]);
  const key = wanted.join("\u0000");
  React.useEffect(() => {
    const ids = key ? key.split("\u0000") : [];
    let cancelled = false; let next = 0;
    const worker = async () => { while (!cancelled && next < ids.length) { const id = ids[next++]; await load(id); } };
    void Promise.all([worker(), worker(), worker()]);
    return () => { cancelled = true; };
  }, [key, load]);
  const retry = React.useCallback((id: string) => { done.current.delete(id); void load(id, true); }, [load]);
  const invalidate = React.useCallback((id?: string) => {
    if (id) { done.current.delete(id); setResults((r) => { const { [id]: _x, ...rest } = r; void _x; return rest; }); }
    else { done.current.clear(); setResults({}); }
  }, []);
  return { results, status, errors, retry, invalidate };
}
