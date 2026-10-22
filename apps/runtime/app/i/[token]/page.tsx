import { AiInterview } from "@/components/AiInterview";

export const dynamic = "force-dynamic";

/**
 * THE PUBLIC LINK OF AN AI-MODERATED INTERVIEW STUDY — /i/<link token>[?test=<test token>][&pid=<panel id>].
 * Consent → optional screener → a one-to-one interview with the AI moderator (text, voice, or voice +
 * camera). Everything happens in the client against /api/ai-interview/*; this page only hands it the
 * link's parameters (the token is checked by the API, never trusted here).
 */
export default function AiInterviewPage({ params, searchParams }: { params: { token: string }; searchParams: Record<string, string> }) {
  const token = String(params.token ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 80);
  const test = typeof searchParams.test === "string" ? searchParams.test.replace(/[^0-9a-f]/gi, "").slice(0, 80) : null;
  const pid = typeof searchParams.pid === "string" ? searchParams.pid.slice(0, 120) : null;
  return <AiInterview token={token} test={test} pid={pid} />;
}
