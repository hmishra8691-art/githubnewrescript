import "server-only";
import { supabaseAdmin } from "./admin";
import {
  decideAdmission, keyRing, tokensForArrival, type AdmissionDecision, type DedupeMode,
  type KeyRing, type MatchToken, type ParticipationState, type Resolution,
} from "@rescript/identity";

/**
 * RESPONDENT TRUST ID AT THE DOOR (Phase 3, 2026-11-03).
 *
 * `session/start` already refuses a second arrival from the SAME panel id (0072's `rescript_panel_enter`). This
 * is the part that asks the harder question: is this the same PERSON as somebody who already took part, even
 * though they arrived from a different vendor under a different id?
 *
 * Three properties govern everything in this file, in order of importance:
 *
 *   1. IT NEVER BREAKS A SURVEY. Every failure path admits the respondent. A missing key, an unreachable
 *      database, an unmigrated schema, a malformed response — all of them log once and let the person in. A
 *      deduplication system that takes the study down when it has a bad day is worse than no deduplication.
 *   2. IT REFUSES NOBODY IN SHADOW MODE, which is where every project starts. It resolves, it reserves, it
 *      records what it WOULD have refused, and it admits. Counting those records is the false-positive
 *      exposure, measurable before anybody loses a paid piece of work.
 *   3. IT COSTS ALMOST NOTHING. Two indexed round trips on the admission path and no model call, no graph walk,
 *      no clustering. The slow analysis belongs in Phase 4 and runs after the person is already answering.
 */

const OFF: Admission = {
  checked: false, admit: true, decision: null, ledgerId: null, trustId: null, trustUuid: null,
  customerId: null, networkToken: null, deviceToken: null, resolution: null, mode: "off",
};

export interface Admission {
  checked: boolean;
  admit: boolean;
  decision: AdmissionDecision | null;
  ledgerId: string | null;
  /** the pseudonymous handle, for logs and the fraud dashboard. Never an identifier of the person. */
  trustId: string | null;
  /* what the gateway needs to carry on from here (0084) — all derived, none of it an identifier of the person */
  trustUuid: string | null;
  customerId: string | null;
  networkToken: string | null;
  deviceToken: string | null;
  /** how THIS ARRIVAL was matched, not how well the identity is known */
  resolution: string | null;
  mode: DedupeMode;
}

/**
 * The key ring, resolved once. `RTID_MATCH_KEY` is deliberately required by `@rescript/identity` rather than
 * defaulted, so its absence disables the whole subsystem here instead of silently deriving tokens nobody
 * intended under a guessable key.
 */
let ring: KeyRing | null | undefined;
let warnedKey = false;
function identityKeys(): KeyRing | null {
  if (ring !== undefined) return ring;
  try {
    ring = keyRing();
  } catch (e) {
    ring = null;
    if (!warnedKey) {
      warnedKey = true;
      console.info("[rescript:rtid] cross-vendor deduplication is off:", (e as Error).message);
    }
  }
  return ring;
}

/** The project's setting, cached briefly: a survey's dedupe mode does not change between two page loads. */
const modeCache = new Map<string, { mode: DedupeMode; customerId: string | null; at: number }>();
const MODE_TTL_MS = 60_000;
let warnedSchema = false;

async function projectMode(surveyId: string): Promise<{ mode: DedupeMode; customerId: string | null }> {
  const hit = modeCache.get(surveyId);
  if (hit && Date.now() - hit.at < MODE_TTL_MS) return { mode: hit.mode, customerId: hit.customerId };

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("recruitment_projects")
    .select("customer_id, dedupe_mode")
    .eq("survey_id", surveyId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    // 0081/0083 not applied, or the table is unreachable: off, said once, and the survey runs exactly as before
    if (!warnedSchema) {
      warnedSchema = true;
      console.info("[rescript:rtid] no recruitment project readable (migrations 0081/0083 applied?):", error.message);
    }
    const miss = { mode: "off" as DedupeMode, customerId: null };
    modeCache.set(surveyId, { ...miss, at: Date.now() });
    return miss;
  }

  const out = {
    mode: ((data?.dedupe_mode as DedupeMode) ?? "off"),
    customerId: (data?.customer_id as string | null) ?? null,
  };
  modeCache.set(surveyId, { ...out, at: Date.now() });
  return out;
}

export function __clearIdentityCacheForTests(): void {
  modeCache.clear();
  ring = undefined;
  warnedKey = false;
  warnedSchema = false;
}

export interface ArrivalSignals {
  /** the vendor's own id for this person, from the panel entry */
  vendorPid?: string | null;
  /** which integration sent them, when it is known */
  integrationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** a client-side fingerprint, when the runner has already computed one */
  deviceHash?: string | null;
}

/**
 * Resolve the arrival to a Trust ID and reserve its place in the project.
 *
 * The signals available at the door are thin on purpose: the vendor's participant id, the network, and a coarse
 * device proxy. A real fingerprint arrives later from the browser and belongs to the fraud engine, not to the
 * two round trips standing between a respondent and the first question.
 */
export async function admitArrival(
  surveyId: string,
  signals: ArrivalSignals,
  opts: { isTest?: boolean } = {},
): Promise<Admission> {
  // a test link is the programmer's own and is never deduplicated against live respondents
  if (opts.isTest) return OFF;

  const keys = identityKeys();
  if (!keys) return OFF;

  const { mode, customerId } = await projectMode(surveyId);
  if (mode === "off" || !customerId) return { ...OFF, mode };

  const tokens: MatchToken[] = tokensForArrival(keys, {
    vendor_pid: signals.vendorPid ?? undefined,
    network: signals.ip ?? undefined,
    // the user agent is a weak device proxy, and is labelled probabilistic like any other circumstantial signal
    device: signals.deviceHash ?? (signals.userAgent ? `ua:${signals.userAgent}` : undefined),
  });

  try {
    const db = supabaseAdmin();

    const { data: resolved, error: resolveError } = await db.rpc("rescript_rtid_resolve", {
      p_customer: customerId,
      p_tokens: tokens,
      p_integration: signals.integrationId ?? null,
      p_participant: signals.vendorPid ?? null,
      p_survey: surveyId,
    });
    if (resolveError) throw new Error(resolveError.message);
    const r = Array.isArray(resolved) ? resolved[0] : resolved;
    if (!r?.trust_uuid) throw new Error("resolve returned no identity");

    const { data: reserved, error: reserveError } = await db.rpc("rescript_rtid_reserve", {
      p_customer: customerId,
      p_survey: surveyId,
      p_trust: r.trust_uuid,
      p_integration: signals.integrationId ?? null,
      p_mode: mode,
      p_ttl_seconds: 3600,
    });
    if (reserveError) throw new Error(reserveError.message);
    const res = Array.isArray(reserved) ? reserved[0] : reserved;

    const decision = decideAdmission({
      mode,
      resolution: (r.resolution as Resolution) ?? "vendor_scoped",
      confidence: Number(r.confidence ?? 0),
      wouldBlock: res?.would_block === true,
      heldState: (res?.held_state as ParticipationState | null) ?? null,
    });

    if (decision.wouldBlock || !decision.admit) {
      console.info("[rescript:rtid]", JSON.stringify({
        survey: surveyId.slice(0, 8), mode, code: decision.code, admit: decision.admit,
        resolution: r.resolution, confidence: Number(r.confidence ?? 0),
        trust: String(r.trust_id ?? "").slice(0, 14), held: res?.held_state ?? null,
      }));
    }

    return {
      checked: true,
      admit: decision.admit,
      decision,
      ledgerId: (res?.ledger_id as string | null) ?? null,
      trustId: (r.trust_id as string | null) ?? null,
      trustUuid: (r.trust_uuid as string | null) ?? null,
      customerId,
      networkToken: tokens.find((t) => t.kind === "network")?.token ?? null,
      deviceToken: tokens.find((t) => t.kind === "device")?.token ?? null,
      resolution: (r.resolution as string | null) ?? null,
      mode,
    };
  } catch (e) {
    // rule 1: a respondent is never turned away because this subsystem had a bad day
    console.warn("[rescript:rtid] identity check failed; admitting", (e as Error).message);
    return { ...OFF, mode };
  }
}

/** Tie an admitted arrival's ledger row to the session that was actually created. */
export async function attachParticipation(ledgerId: string, sessionId: string): Promise<void> {
  try {
    await supabaseAdmin().rpc("rescript_rtid_settle", {
      p_ledger: ledgerId, p_state: "in_survey", p_response: null, p_outcome: null, p_session: sessionId,
    });
  } catch (e) {
    console.warn("[rescript:rtid] could not attach the participation", (e as Error).message);
  }
}
