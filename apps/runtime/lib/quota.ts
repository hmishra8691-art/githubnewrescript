import "server-only";
import { supabaseAdmin } from "./admin";
import { claimedAttributes, observedAttributes, type Attributes, type QuotaMapping, type ScreenerAnswer } from "@rescript/identity";
import type { AdmissionMode } from "./gateway";

/**
 * QUOTA CELLS AT THE THREE MOMENTS THAT MATTER (0088, 0089).
 *
 *   /r/<client>/<study>   CHECK    is there room for somebody like this? Thirty seconds to turn them away
 *                                  here against twenty minutes and an incentive owed if we wait.
 *   session/start         HOLD     a slot, so a cell with ten places left is not oversold to the fifty
 *                                  people already answering.
 *   session/save          COUNT    the completion, against what the SURVEY observed — and give back the
 *                                  slot held on what the VENDOR claimed, which may be a different cell.
 *
 * Plus the one nobody sees: the abandonment sweep, which releases the hold of a respondent who closed the
 * tab. Without it `in_progress` only ever rises and a cell stops admitting people while it is half empty.
 *
 * ## Everything here fails OPEN
 *
 * Every call is on the path between a person clicking a link and seeing a question. An unmigrated database,
 * an unreachable table, a malformed mapping: the respondent goes through, exactly as they would have before
 * any of this existed. A quota engine that can take a study offline is worse than no quota engine — the cost
 * of a missed check is one complete too many in a cell, and the cost of a refusal is the whole field period.
 *
 * ## One mapping, two kinds of key
 *
 * `quota_mapping` is keyed by the name the value arrives under: a vendor's URL parameter at the door
 * (`gender`, `age`) and a screener's question id inside the survey (`scr_gender`). Both feed the same
 * criterion, which is what makes the claim and the answer comparable at the end.
 */

export interface QuotaProject {
  id: string;
  /** read here too, so the gateway's setting and the quota's mapping cost one query between them */
  admissionMode: AdmissionMode;
  mapping: QuotaMapping;
  /** false when no mapping is declared: nothing can resolve, so the door check is skipped rather than wasted */
  mapped: boolean;
}

const EMPTY: QuotaProject | null = null;

/**
 * The recruitment project governing this survey, with everything the admission path needs from it.
 *
 * Absent is the ordinary case — most surveys have no recruitment project — and so is a database without 0089,
 * where the `quota_mapping` column does not exist. Both give back a project with no mapping rather than an
 * error, because neither is a reason to stop a respondent.
 */
export async function quotaProject(surveyId: string): Promise<QuotaProject | null> {
  try {
    const { data } = await supabaseAdmin()
      .from("recruitment_projects").select("id, admission_mode, quota_mapping")
      .eq("survey_id", surveyId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!data) return EMPTY;
    const mode = (data as { admission_mode?: string }).admission_mode;
    const raw = (data as { quota_mapping?: unknown }).quota_mapping;
    const mapping = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as QuotaMapping;
    return {
      id: String((data as { id: string }).id),
      admissionMode: mode === "review" || mode === "observe" ? mode : "off",
      mapping,
      mapped: Object.keys(mapping).length > 0,
    };
  } catch {
    /* 0089 not applied, or the table is unreachable: no mapping, no check, no refusal */
    return EMPTY;
  }
}

export interface DoorDecision {
  admit: boolean;
  /** the cells that are full, for the record of why somebody was turned away */
  fullCells: string[];
  /** what the vendor claimed, resolved — carried to the hold so both speak the same vocabulary */
  claimed: Attributes;
}

const OPEN = (claimed: Attributes): DoorDecision => ({ admit: true, fullCells: [], claimed });

/**
 * Is there room for the person at the door?
 *
 * A respondent whose attributes the mapping cannot resolve is ADMITTED and holds nothing. Refusing somebody
 * because configuration cannot prove which cell they are in turns away valid sample over a gap in a form —
 * and the quota survives it, because the completion is counted on what the survey observed.
 */
export async function doorCheck(project: QuotaProject, params: Readonly<Record<string, string>>): Promise<DoorDecision> {
  const claimed = claimedAttributes(params, project.mapping).attributes;
  // nothing resolved means nothing to check: `{} @> {"gender":"male"}` matches no cell, so the round trip is waste
  if (!Object.keys(claimed).length) return OPEN(claimed);
  try {
    const { data, error } = await supabaseAdmin().rpc("rescript_quota_check", {
      p_project: project.id, p_attributes: claimed,
    });
    if (error) throw new Error(error.message);
    const r = Array.isArray(data) ? data[0] : data;
    if (!r || r.admit !== false) return OPEN(claimed);
    return { admit: false, fullCells: Array.isArray(r.full_cells) ? r.full_cells.map(String) : [], claimed };
  } catch (e) {
    console.warn("[rescript:quota] check unavailable; admitting", (e as Error).message);
    return OPEN(claimed);
  }
}

/** Record that somebody was turned away at a full cell — the number that justifies widening a quota. */
export async function recordTurnedAway(projectId: string, cells: string[]): Promise<void> {
  if (!cells.length) return;
  try {
    await supabaseAdmin().rpc("rescript_quota_turned_away", { p_project: projectId, p_cells: cells });
  } catch (e) {
    console.warn("[rescript:quota] refusal not counted", (e as Error).message);
  }
}

/**
 * Reserve a slot for a session that has just begun.
 *
 * Idempotent in the database on the session id, so a reload, a retried request or a second tab reserves
 * nothing further. Taken HERE rather than at the door because this is the first moment there is a row the
 * abandonment sweep can later find — a hold taken before the session exists is a hold nothing can release.
 */
export async function holdSlot(projectId: string, sessionId: string, claimed: Attributes): Promise<void> {
  try {
    await supabaseAdmin().rpc("rescript_quota_hold_session", {
      p_project: projectId, p_session: sessionId, p_claimed: claimed,
    });
  } catch (e) {
    console.warn("[rescript:quota] hold not taken (the complete will still count)", (e as Error).message);
  }
}

/** The session ended without a complete. Give the slots back. Idempotent; a session with no hold is fine. */
export async function releaseSlot(sessionId: string, outcome: string): Promise<void> {
  try {
    await supabaseAdmin().rpc("rescript_quota_release_session", { p_session: sessionId, p_outcome: outcome });
  } catch (e) {
    console.warn("[rescript:quota] slot not released", (e as Error).message);
  }
}

export interface CountedComplete {
  counted: number;
  nowFull: string[];
  overshot: string[];
  /** the vendor's claim did not survive the screener — a quality signal about the sample, not the respondent */
  corrected: boolean;
}

/**
 * Count a completion: release what the claim held, count what the survey observed, in one statement.
 *
 * The merge and the correction happen in the database because that is where both halves are, and because two
 * people finishing into the last slot of a cell is a race the database has to settle. See migration 0089.
 */
export async function countComplete(
  projectId: string, sessionId: string, observed: Attributes,
): Promise<CountedComplete | null> {
  try {
    const { data, error } = await supabaseAdmin().rpc("rescript_quota_complete_session", {
      p_project: projectId, p_session: sessionId, p_observed: observed,
    });
    if (error) throw new Error(error.message);
    const r = Array.isArray(data) ? data[0] : data;
    if (!r) return null;
    return {
      counted: Number(r.counted ?? 0),
      nowFull: Array.isArray(r.now_full) ? r.now_full.map(String) : [],
      overshot: Array.isArray(r.overshot) ? r.overshot.map(String) : [],
      corrected: r.corrected === true,
    };
  } catch (e) {
    /* the answers are the data; a count that did not land can be rebuilt from them */
    console.warn("[rescript:quota] complete not counted", (e as Error).message);
    return null;
  }
}

/**
 * The survey's answers, in the shape the mapping reads.
 *
 * Only scalar answers. A multi-select or a grid is a set, not a value, and a quota criterion is one value —
 * `String(["a","b"])` would produce "a,b", which no mapping lists and which would be reported as an unknown
 * value for ever. A study that quotas on a multi-select needs a derived single-answer variable, declared.
 */
export function screenerAnswers(answers: unknown): ScreenerAnswer[] {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return [];
  const out: ScreenerAnswer[] = [];
  for (const [id, v] of Object.entries(answers as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number") out.push({ id, answer: String(v) });
  }
  return out;
}

/**
 * What the vendor claimed about this respondent, read through the project's own mapping.
 *
 * Resolved again at the start rather than carried from the door: the two are different requests, and the
 * mapping is a pure function of the parameters, so the answer is the same one the door reached. Carrying it
 * through a URL would mean trusting the browser with the attribute a quota cell is counted on.
 */
export function claimedFor(project: QuotaProject, params: Readonly<Record<string, string>>): Attributes {
  return claimedAttributes(params, project.mapping).attributes;
}

/** What the survey observed about this respondent, read through the project's own mapping. */
export function observedFor(project: QuotaProject, answers: unknown): Attributes {
  return observedAttributes(screenerAnswers(answers), project.mapping).attributes;
}
