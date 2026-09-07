import {
  DEFAULT_SESSION_POLICY, DEFAULT_THROTTLE,
  sessionPolicy, throttlePolicy,
  type SessionPolicy, type ThrottlePolicy,
} from "./sessions.js";
import { GRANTABLE_ROLES, isProjectRole } from "./roles.js";

/**
 * BUILDING THE STORED ACCESS POLICY (§7).
 *
 * `public.access_settings` holds a jsonb document that `loadPolicies` merges
 * over the code defaults on every sign-in. Turning a form into that document
 * is the only interesting part of the settings screen, and it lives here
 * rather than in the route for the reason this repo has hit before: a route
 * imports `server-only`, so pure logic inside one cannot be unit-tested, and
 * untested is exactly what this should not be — a wrong value here signs
 * every colleague out mid-edit.
 *
 * TWO RULES, AND BOTH ARE ABOUT WHAT *NOT* TO STORE.
 *
 * 1. ONLY WHAT DIFFERS FROM THE DEFAULT IS KEPT. A settings row that restates
 *    every default silently pins them: raise a default in a later release and
 *    every workspace keeps the old number with nothing to show why it chose
 *    to. Storing deltas means a workspace inherits improvements it never
 *    opted out of — and it makes the screen able to answer the operator's
 *    real question, which is "did somebody change this, or has it always
 *    been so".
 *
 * 2. THE VALUE STORED IS THE VALUE THAT WILL BE IN FORCE. Every number goes
 *    through the same `sessionPolicy()` / `throttlePolicy()` helpers that
 *    `loadPolicies` uses, so the clamps and the ordering rule between `idle`
 *    and `stale` are applied BEFORE the comparison. A screen that stores 40
 *    and runs 60 is worse than one that refuses 40.
 */

export interface AccessPolicyInput {
  session?: Record<string, unknown> | null;
  throttle?: Record<string, unknown> | null;
  /** `"none"` is an explicit "no baseline", distinct from omitting the key. */
  workspace?: { defaultRole?: unknown } | null;
}

export interface AccessPolicyDraft {
  /** the document to store — only the overrides */
  policy: Record<string, Record<string, unknown>>;
  /** what was refused, in words an operator can act on */
  rejected: string[];
  /**
   * Values that were accepted but CHANGED on the way in, so the screen can
   * say so. The ordering rule is the one that bites: ask for a stale timeout
   * shorter than the idle timeout and you get the idle timeout, because a
   * session that skipped IDLE entirely would be a worse answer than a
   * corrected number.
   */
  adjusted: { field: string; asked: number; stored: number; why: string }[];
}

export interface NumericFieldSpec {
  min: number;
  max: number;
  label: string;
  unit: "seconds" | "";
}

/**
 * The bounds the UI renders and this module enforces.
 *
 * Wider than the policy helpers' own floors on purpose: the helpers protect
 * the platform from nonsense, and these protect an operator from a plausible
 * mistake. A five-second session lifetime passes `sessionPolicy` and is not a
 * configuration anybody meant.
 */
export const ACCESS_FIELDS: {
  session: Record<keyof Omit<SessionPolicy, "allowForceTakeover">, NumericFieldSpec>;
  throttle: Record<keyof ThrottlePolicy, NumericFieldSpec>;
} = {
  session: {
    heartbeatSeconds: { min: 5, max: 600, label: "Heartbeat", unit: "seconds" },
    idleAfterSeconds: { min: 30, max: 3600, label: "Idle after", unit: "seconds" },
    staleAfterSeconds: { min: 60, max: 86_400, label: "Stale after", unit: "seconds" },
    absoluteLifetimeSeconds: { min: 300, max: 30 * 86_400, label: "Signed out after", unit: "seconds" },
  },
  throttle: {
    windowSeconds: { min: 60, max: 86_400, label: "Attempt window", unit: "seconds" },
    maxAttemptsPerAccount: { min: 3, max: 100, label: "Attempts per account", unit: "" },
    maxAttemptsPerSource: { min: 3, max: 1000, label: "Attempts per source", unit: "" },
    lockoutSeconds: { min: 60, max: 86_400, label: "Lockout", unit: "seconds" },
  },
};

/** Read a field, or explain why it was refused. */
function readNumber(
  raw: Record<string, unknown> | null | undefined,
  key: string,
  spec: NumericFieldSpec,
  rejected: string[],
): number | undefined {
  const v = raw?.[key];
  /*
   * Absent, null and empty string all mean INHERIT. The empty string matters:
   * it is what an emptied number input sends, and reading it as 0 would store
   * a zero-second timeout for somebody who was clearing a field.
   */
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    rejected.push(`${spec.label} must be a number`);
    return undefined;
  }
  if (n < spec.min || n > spec.max) {
    rejected.push(`${spec.label} must be between ${spec.min} and ${spec.max}`);
    return undefined;
  }
  return Math.round(n);
}

export function buildAccessPolicy(input: AccessPolicyInput): AccessPolicyDraft {
  const rejected: string[] = [];
  const adjusted: AccessPolicyDraft["adjusted"] = [];
  const policy: Record<string, Record<string, unknown>> = {};

  /* -------------------------------------------------------------- sessions */
  const sessionAsked: Record<string, number | boolean> = {};
  for (const [key, spec] of Object.entries(ACCESS_FIELDS.session)) {
    const n = readNumber(input.session, key, spec, rejected);
    if (n !== undefined) sessionAsked[key] = n;
  }
  if (typeof input.session?.allowForceTakeover === "boolean") {
    sessionAsked.allowForceTakeover = input.session.allowForceTakeover;
  }
  if (Object.keys(sessionAsked).length) {
    const applied = sessionPolicy(sessionAsked as Partial<SessionPolicy>);
    const deltas: Record<string, unknown> = {};
    for (const key of Object.keys(sessionAsked) as (keyof SessionPolicy)[]) {
      const stored = applied[key];
      const asked = sessionAsked[key as string];
      if (typeof stored === "number" && typeof asked === "number" && stored !== asked) {
        adjusted.push({
          field: String(key), asked, stored,
          why: key === "staleAfterSeconds"
            ? "a session must not go stale before it goes idle, so this was raised to the idle timeout"
            : "clamped to the range this setting allows",
        });
      }
      if (stored !== DEFAULT_SESSION_POLICY[key]) deltas[key as string] = stored;
    }
    if (Object.keys(deltas).length) policy.session = deltas;
  }

  /* -------------------------------------------------------------- throttle */
  const throttleAsked: Record<string, number> = {};
  for (const [key, spec] of Object.entries(ACCESS_FIELDS.throttle)) {
    const n = readNumber(input.throttle, key, spec, rejected);
    if (n !== undefined) throttleAsked[key] = n;
  }
  if (Object.keys(throttleAsked).length) {
    const applied = throttlePolicy(throttleAsked as Partial<ThrottlePolicy>);
    const deltas: Record<string, unknown> = {};
    for (const key of Object.keys(throttleAsked) as (keyof ThrottlePolicy)[]) {
      if (applied[key] !== throttleAsked[key as string]) {
        adjusted.push({
          field: String(key), asked: throttleAsked[key as string], stored: applied[key],
          why: "clamped to the range this setting allows",
        });
      }
      if (applied[key] !== DEFAULT_THROTTLE[key]) deltas[key as string] = applied[key];
    }
    if (Object.keys(deltas).length) policy.throttle = deltas;
  }

  /* ------------------------------------------------------------- workspace */
  const baseline = input.workspace?.defaultRole;
  if (typeof baseline === "string" && baseline !== "") {
    if (baseline === "none") {
      /*
       * Stored as an explicit null rather than by omitting the key. Omitting
       * it would mean "inherit", and the platform default could later grant a
       * baseline this workspace deliberately refused.
       */
      policy.workspace = { defaultRole: null };
    } else if (isProjectRole(baseline) && (GRANTABLE_ROLES as readonly string[]).includes(baseline)) {
      policy.workspace = { defaultRole: baseline };
    } else {
      rejected.push(`“${baseline}” is not a role that can be granted`);
    }
  }

  return { policy, rejected, adjusted };
}

/** A sentence for an audit line and a toast. */
export function describeAccessPolicy(policy: Record<string, Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [section, values] of Object.entries(policy)) {
    const keys = Object.keys(values);
    if (keys.length) parts.push(`${section}: ${keys.join(", ")}`);
  }
  return parts.length
    ? `Overriding ${parts.join("; ")}`
    : "Every setting is back to the platform default";
}
