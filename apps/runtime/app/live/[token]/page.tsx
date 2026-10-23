import { LiveSessionPage } from "@/components/LiveSession";

export const dynamic = "force-dynamic";

/**
 * A LIVE HUMAN-MODERATED SESSION'S PERSONAL LINK — /live/<link token> (2026-10-22, G2). A participant: the consent
 * screen (the recording disclosure; no agreement → no room), a camera and microphone check, the waiting room, then
 * the room with the moderator and the other participants. An observer link: the back room (receive-only; chat with
 * the moderator; notes) — participants never see or hear observers. Everything happens in the client against
 * /api/live; the token is checked by the API, never trusted here.
 */
export default function LivePage({ params }: { params: { token: string } }) {
  const token = String(params.token ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
  return <LiveSessionPage invite={token} />;
}
