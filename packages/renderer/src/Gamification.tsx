"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import type { ResponseState } from "@rescript/engine";
import { gamificationOf, newBadges, earnedBadges, BADGE_ICON_GLYPHS } from "@rescript/engine";
import { openUxPopup } from "./uxPopup";

/**
 * S5a item 4 — THE POINTS HUD AND THE BADGE POPUP (audit GA-06, GA-07).
 *
 * The HUD is a small status region in the corner the survey chose (hud.position): points, the level name and the
 * badge icons, each with a text name for screen readers (role="status", polite — a change is announced once, not
 * every tick). A badge earned since the last render opens the survey's NATIVE popup (uxPopup: placement "top", closes
 * by itself after 5 s) with the badge's icon, title and description; under prefers-reduced-motion the HUD's "pop" is
 * off (CSS). Values are read from the calculated variables the engine keeps (POINTS, LEVEL_NAME, BADGES) — this
 * component computes nothing.
 */
export function GamificationHud({ def, state, rootRef, tick }: { def: SurveyDefinition; state: Pick<ResponseState, "calculated">; rootRef: React.RefObject<HTMLElement | null>; tick?: unknown }) {
  const g = gamificationOf(def);
  const badges = String(state.calculated.BADGES ?? "");
  const seen = React.useRef<string | null>(null);
  const [pop, setPop] = React.useState(0);
  React.useEffect(() => {
    if (!g) return;
    if (seen.current === null) { seen.current = badges; return; }
    const fresh = newBadges(seen.current, badges, g);
    seen.current = badges;
    if (!fresh.length) return;
    setPop((n) => n + 1);
    const root = rootRef.current;
    if (!root) return;
    for (const b of fresh) {
      openUxPopup({ root, owner: `badge:${b.id}`, effect: { title: `${BADGE_ICON_GLYPHS[b.icon] ?? "⭐"} Badge earned: ${b.title}`, text: b.description ?? `You earned the “${b.title}” badge.`, placement: "top", dismiss: "auto", autoMs: 5000 } });
    }
  }, [badges, g, rootRef, tick]);
  if (!g || g.hud.show === false) return null;
  const points = Number(state.calculated.POINTS ?? 0) || 0;
  const level = String(state.calculated.LEVEL_NAME ?? "");
  const earned = g.badges.filter((b) => earnedBadges(badges).includes(b.id));
  return (
    <div className={`rs-gam-hud rs-gam-${g.hud.position}`} role="status" aria-live="polite" data-testid="rs-gam-hud" data-points={points} data-badges={badges}>
      <span key={pop} className="rs-gam-points" data-testid="rs-gam-points"><b>{points}</b> points</span>
      {level && <span className="rs-gam-level" data-testid="rs-gam-level">· {level}</span>}
      {earned.length > 0 && (
        <span className="rs-gam-badges" data-testid="rs-gam-badges">
          {earned.map((b) => <span key={b.id} role="img" aria-label={`Badge: ${b.title}`} title={b.title}>{BADGE_ICON_GLYPHS[b.icon] ?? "⭐"}</span>)}
        </span>
      )}
    </div>
  );
}
