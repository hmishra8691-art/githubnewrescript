import "server-only";
import { NextResponse } from "next/server";
import { aiProviderName } from "@rescript/ai";
import { isFailure, type AuthedUser, type GuardFailure } from "../guard";
import type { ImportSession } from "./sessions";

/**
 * WHO MAY SEE OR CHANGE AN IMPORT SESSION (I4). A session belongs to an organisation: its members read it.
 * Sandbox sessions (no organisation) exist only where the AI is the FAKE provider — the same carve-out as
 * the sandbox's import route — and need no session. Changing a session additionally needs the project
 * permission the change implies (checked by the route).
 */
export const sandboxAllowed = () => aiProviderName() === "fake";

/** the caller, from the result of `requireUser` (which every handler calls first): a person, or the sandbox */
export function callerFrom(u: AuthedUser | GuardFailure, wantsSandbox: boolean): { user: AuthedUser | null; customerId: string | null } | { response: NextResponse } {
  if (isFailure(u)) {
    if (wantsSandbox && sandboxAllowed()) return { user: null, customerId: null };
    return { response: u.response };
  }
  return { user: u, customerId: wantsSandbox && sandboxAllowed() ? null : u.customerId };
}

export function canSee(s: ImportSession, caller: { user: AuthedUser | null; customerId: string | null }): boolean {
  if (s.customerId === null) return sandboxAllowed();
  if (!caller.user) return false;
  return caller.user.isPlatformAdmin || caller.user.customerId === s.customerId;
}

export const notFound = () => NextResponse.json({ error: "No such import." }, { status: 404 });
