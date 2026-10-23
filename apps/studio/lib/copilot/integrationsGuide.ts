/**
 * THE PANELS & ALERTS GUIDE (2026-10-22, G3) — how Intelligent Mode connects a study to a sample panel
 * (`connect_panel` / `disconnect_panel`) and routes its alerts (`configure_alerts`), engine `integrationActions.ts`.
 * Sent only when a request is about panels or alerts (`integrationsIntent`), lifted into the cached system prefix like
 * every guide (`aiPromptCache.ts`); the system prompt is at its cap and is not touched. Every `{"op":…}` line is
 * applied by the engine as written (`integrationsGuide.test.ts`).
 *
 * What it must never let the model do: put a secret (a webhook URL, a hashing key) in an action — the gate refuses
 * it — or say that alerts were sent / a panel is live: channels are added in Settings → Alerts, secrets typed into
 * the Studio, links given to the panel by the researcher.
 */
export const COPILOT_INTEGRATIONS_GUIDE = `PANELS AND ALERTS — a study can take participants from a sample panel and send them back with the right outcome, and can alert the team about what happens in it.
connect_panel {panel: Prolific | Cint (Lucid) | PureSpectrum | Dynata | Toluna | CloudResearch | MTurk | custom, completionCode?, codes?: {complete, screenout, quota_full, terminate, over_quota}, redirects?: {outcome: "https://…{{pid}}…"}, idParam?, params?: ["STUDY_ID"], targets?: ["AI interviews","group sessions","live sessions","survey"], completesTarget?, signing?: {algorithm: hmac-sha256 | hmac-sha1 | sha256 | sha1 | none, param, scope: url | query | params, encoding: hex | base64 | base64url}} — presets fill the panel's id parameter, end links and hashing; patching by panel. disconnect_panel {panel}. Presets must be verified with the panel's current docs: say so.
configure_alerts {events: ["distress", "abuse", "injection", "completed", "quota full", "target reached", "cost cap", "provider fallback", "group flags", "no-shows", "milestones"], slack?: "#channel", teams?: "name", webhook?: "name", email?: ["me" | "the team" | an address], inApp?: ["me" | "the team"], digest?: immediate | hourly | daily, quietHours?: {start: "22:00", end: "07:00", timeZone}, maxPerHour?, remove?: true}.
NEVER put a webhook URL, a hashing key or any secret in an action (refused): Slack / Teams / webhook channels are added in Settings → Alerts and named here; a panel's signing secret is typed in Research Tools → Qualitative → Alerts & panels. Never say alerts were sent or a panel is live — the researcher gives the link to the panel.
{"op":"connect_panel","panel":"Prolific","completionCode":"ABC123"}
{"op":"configure_alerts","events":["distress"],"slack":"#research-ops","email":["me"]}
{"op":"disconnect_panel","panel":"Prolific"}`;

/** a request about panel recruitment or alert routing */
export function integrationsIntent(text: string): boolean {
  return /\b(?:prolific|cint|lucid(?: marketplace)?|pure ?spectrum|dynata|toluna|cloudresearch|mturk|mechanical turk)\b|\bpanel (?:provider|integration|redirects?|end ?links?|recruitment)\b|\bcompletion codes?\b|\bconnect (?:this|the|my) (?:study|survey|project) to\b|\b(?:distress|abuse|injection|quota|cost|safety|budget) alerts?\b|\balerts? (?:to|on|in|via|by) (?:slack|teams|e-?mail|webhooks?)\b|\b(?:slack|microsoft teams|webhook)\b.*\balert|\balert.*\b(?:slack|microsoft teams|webhook)\b|\bnotify (?:me|the team|us)\b|\bconnect_panel\b|\bconfigure_alerts\b/i.test(text)
    || /प्रोलिफिक|अलर्ट|स्लैक/.test(text);
}
