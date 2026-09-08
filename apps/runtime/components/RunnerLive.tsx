"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { Runner, type RunnerProps } from "./Runner";

/**
 * The LIVE survey page's entry point (P0-1: Fast Origin Transfer).
 *
 * `Runner` itself is untouched — every mode (live, test, preview) still hands
 * it a `SurveyDefinition` exactly as before. This wrapper exists only for the
 * live path: instead of the server embedding the full definition in the
 * page's own always-dynamic response, the browser fetches it from
 * `/api/runtime-definition/[versionId]`, a route the CDN can answer directly
 * once it has seen that version once — safe because a published version's
 * content is immutable and pinned to its own id (see that route's comment).
 *
 * A brief loading state replaces what used to be instant SSR'd content; that
 * trade is the point — it is what makes the (large) definition payload
 * eligible for edge caching instead of merely avoiding a Postgres read.
 */
export function RunnerLive({
  versionId,
  ...rest
}: Omit<RunnerProps, "definition" | "mode"> & { versionId: string }) {
  const [state, setState] = React.useState<
    { kind: "loading" } | { kind: "error" } | { kind: "ready"; definition: SurveyDefinition }
  >({ kind: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetch(`/api/runtime-definition/${versionId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((definition) => {
        if (!cancelled) setState({ kind: "ready", definition });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [versionId]);

  if (state.kind === "loading") {
    return (
      <div className="rs-shell">
        <div className="rs-card rs-end"><p>Loading…</p></div>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="rs-shell">
        <div className="rs-card rs-end">
          <h2>Unable to load this survey</h2>
          <p>Please check your connection and reload the page.</p>
        </div>
      </div>
    );
  }
  return <Runner definition={state.definition} mode="live" {...rest} />;
}
