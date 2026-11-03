import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { supabaseAdmin } from "./admin";
import { admissionRisk, type AdmissionSignals } from "@rescript/quality";
import type { QualityConfig } from "@rescript/schema";

/**
 * THE ADMISSION GATEWAY (0084) — the brief's §23 flow, as one function.
 *
 *   vendor link → /r/<client>/<study> → identity (0083) → risk (quality/admission.ts) → access token → survey
 *
 * Before this, `session/start` was both the gate and the thing being gated. Separating them buys three things:
 * somewhere to put a verification step that is not already inside the survey; a record, per arrival, of the
 * evidence a decision rested on; and a short-lived single-use token, so opening the survey URL directly is not
 * the same as having been admitted (the brief's §22).
 *
 * ## The latency budget
 *
 * Everything here is on the path between a respondent clicking a link and seeing a question, so it is three
 * indexed round trips and no more: resolve, reserve, issue. The risk scoring is pure arithmetic over signals
 * already in hand. Graph clustering, behavioural analysis and anything that needs a model belong to the
 * asynchronous side and run after the person is already answering.
 *
 * ## What it will not do
 *
 * It does not refuse anybody on a risk score. The worst band quarantines the participation for review and holds
 * its complete from being billed. Refusal on identity (a confirmed duplicate, under 0083's enforcement) is a
 * different decision and remains available.
 */

export type AdmissionMode = "off" | "observe" | "review";

export interface GatewayOutcome {
  /** let them through to the survey */
  admit: boolean;
  /** the secret to put in the redirect. Null when no token was issued (mode off, or refused). */
  token: string | null;
  decisionId: string | null;
  caseId: string | null;
  risk: { score: number; band: string; reasons: string[] };
  /** why, in words that can be shown to a respondent or repeated to a vendor */
  reason: string;
  code: string;
}

const TOKEN_TTL_SECONDS = 900;

/** The token the respondent carries, and the hash we keep. Never both in the same place. */
function mintToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

export function hashAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * What the admission rules are allowed to see, assembled from the network's own record and the identity's
 * history. Deliberately thin: nobody has answered anything yet.
 */
async function signalsFor(
  customerId: string,
  networkToken: string | null,
  trustUuid: string | null,
  deviceToken: string | null,
): Promise<AdmissionSignals> {
  const db = supabaseAdmin();
  const out: AdmissionSignals = {};

  if (networkToken) {
    const { data } = await db.rpc("rescript_network_seen", {
      p_customer: customerId, p_network_token: networkToken, p_trust: trustUuid,
    });
    const n = Array.isArray(data) ? data[0] : data;
    if (n) {
      out.network = {
        datacenter: n.datacenter === true,
        tor: n.tor === true,
        vpn: n.vpn === true,
        identities: Number(n.identities ?? 0),
        providerRisk: n.provider_risk === null || n.provider_risk === undefined ? null : Number(n.provider_risk),
      };
    }
  }

  if (deviceToken) {
    // how many distinct identities share this device signature — the density the rule counts
    const { count } = await db
      .from("identity_match_tokens")
      .select("trust_id", { count: "exact", head: true })
      .eq("customer_id", customerId).eq("kind", "device").eq("token", deviceToken);
    out.device = { identities: count ?? 0 };
  }

  if (trustUuid) {
    const { data } = await db
      .from("respondent_trust_ids")
      .select("participations, rejections, duplicates")
      .eq("id", trustUuid).maybeSingle();
    if (data) {
      out.history = {
        participations: Number(data.participations ?? 0),
        rejections: Number(data.rejections ?? 0),
        duplicates: Number(data.duplicates ?? 0),
      };
    }
  }

  return out;
}

export interface GatewayInput {
  customerId: string;
  surveyId: string;
  mode: AdmissionMode;
  trustUuid: string | null;
  ledgerId: string | null;
  integrationId?: string | null;
  networkToken?: string | null;
  deviceToken?: string | null;
  /** how the arrival was matched to its identity (0083), carried through for the reviewer */
  resolution?: string | null;
  /** the identity decision already made upstream: a confirmed duplicate under enforcement */
  identityRefused?: boolean;
  identityReason?: string | null;
  identityCode?: string | null;
  isTest?: boolean;
  /** the project's quality settings, so a researcher's thresholds apply here too */
  qualityConfig?: QualityConfig;
}

const DEFAULT_CONFIG = { enabled: true, strictness: "standard", rules: {} } as unknown as QualityConfig;

export async function runGateway(input: GatewayInput): Promise<GatewayOutcome> {
  const started = Date.now();
  const noRisk = { score: 0, band: "low", reasons: [] as string[] };

  if (input.mode === "off") {
    const { token, hash } = mintToken();
    const issued = await issue(input, "admitted", noRisk, {}, hash, started, false);
    return { admit: true, token, decisionId: issued.decisionId, caseId: null, risk: noRisk, reason: "Admission checks are off for this project.", code: "not_checked" };
  }

  /*
   * An identity refusal decided upstream (0083 enforcement: a confirmed duplicate) is recorded and the arrival
   * is turned away with no token. That is an identity decision, not a risk one — the distinction matters to the
   * vendor reconciling its invoice.
   */
  if (input.identityRefused) {
    await issue(input, "duplicate", noRisk, { identity: input.identityCode ?? "duplicate" }, null, started, false);
    return {
      admit: false, token: null, decisionId: null, caseId: null, risk: noRisk,
      reason: input.identityReason ?? "You have already taken part in this study.",
      code: input.identityCode ?? "duplicate",
    };
  }

  const signals = await signalsFor(input.customerId, input.networkToken ?? null, input.trustUuid, input.deviceToken ?? null);
  const risk = admissionRisk(signals, input.qualityConfig ?? DEFAULT_CONFIG);

  // a case is opened only in `review` mode; `observe` scores and records and leaves the queue alone
  const openCase = input.mode === "review" && risk.quarantine;
  const decision = openCase ? "admitted_flagged" : "admitted";

  const { token, hash } = mintToken();
  const issued = await issue(
    input, decision,
    { score: risk.score, band: risk.band, reasons: risk.reasons },
    { signals, flags: risk.flags.map((f) => ({ rule: f.ruleId, observed: f.observed, explanation: f.explanation, caveat: f.caveat })) },
    hash, started, openCase,
  );

  return {
    admit: true,
    token,
    decisionId: issued.decisionId,
    caseId: issued.caseId,
    risk: { score: risk.score, band: risk.band, reasons: risk.reasons },
    reason: openCase
      ? "Admitted. This participation is held for review before its complete is billed."
      : "Admitted.",
    code: openCase ? "admitted_flagged" : "admitted",
  };
}

async function issue(
  input: GatewayInput,
  decision: string,
  risk: { score: number; band: string; reasons: string[] },
  evidence: Record<string, unknown>,
  tokenHash: string | null,
  started: number,
  openCase: boolean,
): Promise<{ decisionId: string | null; caseId: string | null }> {
  try {
    const { data, error } = await supabaseAdmin().rpc("rescript_admission_issue", {
      p_customer: input.customerId, p_survey: input.surveyId, p_trust: input.trustUuid,
      p_ledger: input.ledgerId, p_integration: input.integrationId ?? null,
      p_decision: decision, p_risk: risk.score, p_band: risk.band, p_reasons: risk.reasons,
      p_evidence: evidence, p_resolution: input.resolution ?? null,
      p_network_token: input.networkToken ?? null, p_token_hash: tokenHash,
      p_ttl_seconds: TOKEN_TTL_SECONDS, p_is_test: input.isTest === true,
      p_decided_in_ms: Date.now() - started, p_open_case: openCase,
    });
    if (error) throw new Error(error.message);
    const r = Array.isArray(data) ? data[0] : data;
    return { decisionId: (r?.decision_id as string) ?? null, caseId: (r?.case_id as string) ?? null };
  } catch (e) {
    /*
     * The gateway must not be able to lock a study out. If the decision cannot be recorded, the respondent
     * still goes in — without a token, which `session/start` treats as an arrival that did not come through
     * the gateway, exactly as it treats every arrival today.
     */
    console.warn("[rescript:gateway] decision not recorded; admitting anyway", (e as Error).message);
    return { decisionId: null, caseId: null };
  }
}

/** Redeem the token `session/start` was handed. Single use, enforced in the database. */
export async function redeemAccessToken(
  token: string, surveyId: string, sessionId: string,
): Promise<{ ok: boolean; reason: string; ledgerId: string | null }> {
  try {
    const { data, error } = await supabaseAdmin().rpc("rescript_admission_redeem", {
      p_token_hash: hashAccessToken(token), p_survey: surveyId, p_session: sessionId, p_network_token: null,
    });
    if (error) throw new Error(error.message);
    const r = Array.isArray(data) ? data[0] : data;
    return { ok: r?.ok === true, reason: String(r?.reason ?? "unknown"), ledgerId: (r?.ledger_id as string) ?? null };
  } catch (e) {
    console.warn("[rescript:gateway] token redemption failed", (e as Error).message);
    return { ok: false, reason: "error", ledgerId: null };
  }
}
