"use client";
import React from "react";
import { Studio } from "@/components/studio/Studio";
import { newSurveyDefinition } from "@/lib/defaults";

/**
 * Editor sandbox: the full Studio running on an in-memory definition with no
 * database. Used for developing and E2E-testing the authoring experience —
 * saves/deploys are expected to fail here.
 */
export default function SandboxPage() {
  const [def] = React.useState(() => newSurveyDefinition("sandbox", "SANDBOX", "Editor Sandbox"));
  return <Studio definition={def} surveyDbId="sandbox" versionId={null} />;
}
