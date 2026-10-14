import "server-only";
import { aiConfigured, identityOf, withAiScope, type ChatScope } from "@rescript/ai";
import type { AuthedUser } from "@/lib/guard";
import { aiAllowed, type AiSource } from "@/lib/aiPolicy";
import { featureOf, needsOf } from "./features";
import { allowPrivateFrom, resolveConnection, type Resolution } from "./resolve";
import { aiStore, workspaceAllowsByok } from "./server";

/**
 * THE STUDIO'S ONE QUESTION ABOUT WHOSE AI A CALL USES.
 *
 * `meteredAi`, the two hand-reserving sites (story narration, speech preview)
 * and every route that used to ask "is a model configured?" all ask it here,
 * so there is exactly one answer: the project's choice, else the acting
 * user's, else the platform — `resolveConnection` — with the workspace's
 * policy applied.
 */

/** the project's own choice of AI source (settings.ai.source), read with the same settings read the AI switch already makes */
export async function projectAiSource(surveyId: string | null | undefined, operation: string): Promise<AiSource | undefined> {
  const d = await aiAllowed(surveyId, operation, { once: true }); // the switch itself is asked by the caller; here only the project's source is read
  return d.source;
}

export interface ConnectionAsk { userId: string | null | undefined; customerId: string | null | undefined; surveyId: string | null | undefined; operation: string; source?: AiSource; /** the caller already read the project's choice (`source` is it, possibly none) */ sourceKnown?: boolean }

/** resolve whose AI `operation` uses for this acting user in this project */
export async function connectionFor(ask: ConnectionAsk): Promise<Resolution> {
  if (!ask.userId) return { kind: "platform", reason: "default" }; // sandbox / the fake-provider carve-out: no user, no personal provider
  const feature = featureOf(ask.operation);
  const source = ask.sourceKnown ? ask.source : ask.source ?? await projectAiSource(ask.surveyId, ask.operation);
  const store = aiStore();
  /* a user with no AI settings at all (the common case) costs one indexed read and no workspace lookup */
  if (!source && !(await store.getSetting(ask.userId, feature))) return { kind: "platform", reason: "default" };
  return resolveConnection({ userId: ask.userId, feature, store, workspaceAllows: await workspaceAllowsByok(ask.customerId), project: source ? { mode: source } : null, need: needsOf(ask.operation) });
}

/** a short tag for cache keys: empty for the platform, else the connection's identity (no secret) — so a cached answer is only served under the connection that produced it */
export async function connectionTag(ask: ConnectionAsk): Promise<string> {
  const r = await connectionFor(ask);
  return r.kind === "user" ? `|${r.source}:${identityOf(r.scope)}` : "";
}

/**
 * "Is there an AI to use?" — the question routes asked as `aiConfigured()`
 * before this feature. True when the platform has one, or when the user's own
 * choice applies (or is refused with a reason — the call then explains it,
 * which is better than "no model configured").
 */
export async function aiReadyFor(user: Pick<AuthedUser, "userId" | "customerId"> | null, surveyId: string | null | undefined, operation = "additional"): Promise<boolean> {
  if (aiConfigured()) return true;
  if (!user) return false;
  const r = await connectionFor({ userId: user.userId, customerId: user.customerId, surveyId, operation });
  return r.kind !== "platform";
}

/** run `fn` inside the user's connection scope (or untouched, for the platform) */
export function inConnection<T>(scope: ChatScope, fn: () => Promise<T>): Promise<T> {
  return withAiScope({ chat: scope, allowPrivate: allowPrivateFrom() }, fn);
}
