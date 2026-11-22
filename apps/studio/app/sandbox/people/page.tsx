"use client";
import React from "react";
import { DistributionPanel } from "@/components/studio/DistributionPanel";
import { StudioProvider } from "@/components/studio/store";
import { PortalSettings } from "@rescript/schema";
import { newSurveyDefinition } from "@/lib/defaults";

/**
 * THE DISTRIBUTION TAB ON ITS OWN, IN THE SANDBOX (2026-11-21) — the real `DistributionPanel` (lists, adding
 * people, the respondent portal's people and accounts) for the id "sandbox", so a browser suite can walk
 * "add people → preview → confirm → choose a list → create accounts" without a database and without compiling the
 * whole editor. The routes it calls answer from memory for this id only, and only where there is no database and
 * it is not production (lib/respondentIntake.ts `peopleSandboxAllowed`).
 */
export default function SandboxPeoplePage() {
  const def = React.useMemo(() => {
    const d = newSurveyDefinition("sandbox", "SANDBOX", "People sandbox");
    return { ...d, portal: PortalSettings.parse({ enabled: true }) };
  }, []);
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);
  if (!ready) return null;
  return (
    <StudioProvider initial={def} surveyDbId="sandbox" versionId={null}>
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: 20 }}><DistributionPanel /></main>
    </StudioProvider>
  );
}
