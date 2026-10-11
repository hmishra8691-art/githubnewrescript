import { ProjectOverview } from "@/components/project/ProjectOverview";

export const dynamic = "force-dynamic";

/**
 * THE PROJECT OVERVIEW IN THE SANDBOX — the same component a real project
 * opens on, reading `/api/surveys/sandbox/overview`, which the browser suites
 * answer with a fixture. Nothing here touches the database.
 */
export default function SandboxOverviewPage() {
  return <ProjectOverview surveyDbId="sandbox" />;
}
