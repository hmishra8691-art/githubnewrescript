"use client";
import React from "react";

/**
 * "THE NEXT BUTTON SHOULD REMAIN DISABLED UNTIL THE VIDEO HAS BEEN COMPLETELY
 * WATCHED" (October 2026 review, Video Hotspot / Annotation — Require Complete
 * Video Watch).
 *
 * A question's renderer cannot reach the page's Next button, and a hotspot
 * question's answer is its list of reactions, with no room for a watch record.
 * So a question that must be watched first HOLDS the page: it registers a hold
 * while any of its clips is unfinished and releases it when the last one ends
 * (or cannot play — a respondent must always be able to finish). The Runner
 * provides the context and keeps Next disabled while any hold stands; outside
 * a Runner (the Studio canvas) there is no provider and a hold does nothing.
 *
 * Independent of Required, as the review asked: a question may be optional
 * and still have to be watched, or required and not.
 */
export interface MediaGate {
  hold(id: string, on: boolean, reason?: string): void;
}
export const MediaGateContext = React.createContext<MediaGate | null>(null);

/** Hold the page while `on`; released on unmount, so leaving the page never strands a hold. */
export function useMediaHold(id: string, on: boolean, reason?: string): void {
  const gate = React.useContext(MediaGateContext);
  React.useEffect(() => {
    gate?.hold(id, on, reason);
    return () => gate?.hold(id, false);
  }, [gate, id, on, reason]);
}

/** The Runner's side: the set of holds, and whether Next must wait. */
export function useMediaGateState(): { gate: MediaGate; held: boolean; reason: string | null } {
  const [holds, setHolds] = React.useState<Map<string, string>>(() => new Map());
  const gate = React.useMemo<MediaGate>(() => ({
    hold(id, on, reason) {
      setHolds((cur) => {
        if (on === cur.has(id) && (!on || cur.get(id) === (reason ?? ""))) return cur;
        const next = new Map(cur);
        if (on) next.set(id, reason ?? ""); else next.delete(id);
        return next;
      });
    },
  }), []);
  const first = holds.values().next();
  return { gate, held: holds.size > 0, reason: holds.size ? (first.value || "Please watch the video to the end to continue.") : null };
}
