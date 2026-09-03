"use client";
import React from "react";
import { Studio } from "@/components/studio/Studio";
import { newSurveyDefinition } from "@/lib/defaults";

/**
 * Editor sandbox: the full Studio running on an in-memory definition with no
 * database. Used for developing and E2E-testing the authoring experience.
 *
 * `?dbid=<id>` points it at a survey row, which makes the autosave path real:
 * the id "sandbox" deliberately short-circuits persistence, so without this
 * the one thing that most needs testing — that edits actually reach the
 * server, and that a refused write is honoured — could not be exercised at
 * all. `?rev=<n>` seeds the revision the editor believes it loaded.
 */
export default function SandboxPage() {
  const [def] = React.useState(() => newSurveyDefinition("sandbox", "SANDBOX", "Editor Sandbox"));
  const [params] = React.useState(() =>
    typeof window === "undefined"
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search),
  );
  const dbid = params.get("dbid") || "sandbox";
  const rev = params.get("rev");
  return (
    <Studio
      definition={def}
      surveyDbId={dbid}
      versionId={null}
      revision={rev === null ? null : Number(rev)}
    />
  );
}
