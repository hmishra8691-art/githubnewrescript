"use client";
import React from "react";
import { Studio } from "@/components/studio/Studio";
import { newSurveyDefinition } from "@/lib/defaults";

/**
 * Editor sandbox: the full Studio running on an in-memory definition with no
 * database. Used for developing and E2E-testing the authoring experience.
 *
 * `?collab=1` turns the collaboration layer on (presence, the edit lock,
 * read-only mode). It is OFF by default here because the fixture has no
 * session: the poll would answer 401 and leave the editor read-only for a
 * reason that has nothing to do with what these suites are testing.
 *
 * `?dbid=<id>` points it at a survey row, which makes the autosave path real:
 * the id "sandbox" deliberately short-circuits persistence, so without this
 * the one thing that most needs testing — that edits actually reach the
 * server, and that a refused write is honoured — could not be exercised at
 * all. `?rev=<n>` seeds the revision the editor believes it loaded.
 */
export default function SandboxPage() {
  const [def] = React.useState(() => newSurveyDefinition("sandbox", "SANDBOX", "Editor Sandbox"));
  // The URL is only readable in the browser, and the Studio renders values
  // from it (the revision in the header), so mount it after hydration rather
  // than server-render one thing and hydrate another.
  const [params, setParams] = React.useState<URLSearchParams | null>(null);
  React.useEffect(() => { setParams(new URLSearchParams(window.location.search)); }, []);
  if (!params) return null;
  const dbid = params.get("dbid") || "sandbox";
  const rev = params.get("rev");
  return (
    <Studio
      definition={def}
      surveyDbId={dbid}
      versionId={null}
      revision={rev === null ? null : Number(rev)}
      collaboration={params.get("collab") === "1"}
    />
  );
}
