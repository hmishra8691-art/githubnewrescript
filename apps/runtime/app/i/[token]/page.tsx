import { headers } from "next/headers";
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
  /* G3: every other URL parameter, for a panel's id and kept values (PROLIFIC_PID, RID, psid …); bounded by the API */
  const linkParams = Object.fromEntries(Object.entries(searchParams ?? {}).filter(([k, v]) => k !== "test" && typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/.test(k)).slice(0, 30).map(([k, v]) => [k, String(v).slice(0, 300)]));
  /* G1: the browser's languages (Accept-Language) — the page starts in the first one the study offers; ?lang= forces one */
  const acceptLanguage = (headers().get("accept-language") ?? "").slice(0, 200);
  const lang = typeof searchParams.lang === "string" ? searchParams.lang.replace(/[^A-Za-z-]/g, "").slice(0, 12) : null;
  return <AiInterview token={token} test={test} pid={pid} params={linkParams} acceptLanguage={acceptLanguage} forcedLanguage={lang} />;
}
