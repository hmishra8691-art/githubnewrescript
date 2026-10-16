import { describeFailure, isTurnFailure } from "/home/claude/rescript/apps/studio/lib/copilot/failure.ts";
// what useCopilot.ts:594/606 does for a non-ok JSON answer that carries no `failure` (route 400/401 bodies)
for (const [status, body] of [[401, { error: "Not signed in.", code: "no_session" }], [400, { error: "send the survey as it is open in the editor (definition)" }], [400, { error: "say what you want" }]] as const) {
  const d = body as Record<string, unknown>;
  const fallback = status === 402 || status === 423 ? "wallet" : "provider";
  const failure = isTurnFailure(d.failure) ? d.failure : describeFailure(fallback, String(d.error ?? "").slice(0, 200) || undefined);
  console.log(`HTTP ${status} ${JSON.stringify(body)}\n  → card kicker: ${failure.title}\n  → message: ${failure.message}\n  → next: ${failure.next.join(" / ")}\n  → admin: ${failure.admin}\n  (detail kept but not shown in message: ${failure.detail})\n`);
}
