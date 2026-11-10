/**
 * HELP USAGE AND COST (2026-11-10) — what the router actually did, from the answers it recorded (help_messages,
 * `content.route` and `content.charge`). Platform administrators read it on the admin page's Support tab: how many
 * answers came from each level, how many needed the model, how many the cache saved, what the model answers were
 * charged, how often people said an answer solved it, and how many conversations went to a person.
 *
 * Answers saved before the router existed have no `route`; they are counted as "before routing" (model if their
 * origin was the model), not guessed into a level.
 */
export interface UsageRow { content: Record<string, unknown>; created_at?: string }
export interface HelpUsage {
  answers: number;
  byLevel: { 1: number; 2: number; 3: number; unrouted: number };
  modelCalls: number;
  cacheHits: number;
  /** share of answers that needed no model call (levels 1 and 2, and cache hits) */
  internalShare: number;
  charge: number;
  escalationsOffered: number;
  solved: { yes: number; no: number };
  diagnosed: number;
}

export function helpUsage(rows: UsageRow[]): HelpUsage {
  const u: HelpUsage = { answers: 0, byLevel: { 1: 0, 2: 0, 3: 0, unrouted: 0 }, modelCalls: 0, cacheHits: 0, internalShare: 0, charge: 0, escalationsOffered: 0, solved: { yes: 0, no: 0 }, diagnosed: 0 };
  for (const r of rows) {
    const c = r.content ?? {};
    u.answers++;
    const route = c.route as { level?: number; cached?: boolean; modelUsed?: boolean } | undefined;
    if (route?.level === 1 || route?.level === 2 || route?.level === 3) u.byLevel[route.level]++;
    else u.byLevel.unrouted++;
    if (route ? route.modelUsed : c.origin === "model") u.modelCalls++;
    if (route?.cached) u.cacheHits++;
    u.charge += Number(c.charge ?? 0) || 0;
    if ((c.escalate as { offer?: boolean } | null)?.offer) u.escalationsOffered++;
    if (c.solved === true) u.solved.yes++;
    if (c.solved === false) u.solved.no++;
    if (c.diagnosis) u.diagnosed++;
  }
  u.internalShare = u.answers ? Math.round(((u.answers - u.modelCalls) / u.answers) * 1000) / 10 : 0;
  u.charge = Math.round(u.charge * 10000) / 10000;
  return u;
}
