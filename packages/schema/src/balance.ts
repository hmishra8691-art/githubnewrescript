import { z } from "zod";

/**
 * EXACT BALANCE (2026-10-22, engine item #15) — one setting shared by the two
 * places a survey hands each respondent one of several arms:
 *
 *   · a flow randomizer with "evenly present" (blocks, pages / questions or
 *     elements — whatever its children are): `randomizer.balance`
 *   · a design question's VERSION (MaxDiff, CBC, menu, CVA, ACBC — any
 *     question with `settings.designRef`): `settings.versionBalance`
 *
 * Absent (every survey written before this) = the old, seed-derived
 * assignment, balanced on average only. `exact: true` = the arm is CLAIMED
 * atomically on the server — the least-filled arm wins, deterministic
 * tie-break — so across the sample the counts never differ by more than one,
 * whatever the concurrency (`rescript_claim_balance`, migration 0073; an
 * in-memory equivalent for the sandbox and the preview).
 */
export const ExactBalance = z.object({
  exact: z.boolean(),
  /**
   * What is counted. `completed` (default): completes + respondents still in
   * progress; an abandoned (expired) or screened-out respondent's claim is
   * given back, so the final completes balance. `started`: every respondent
   * who was ever assigned counts, finished or not (exposure balance).
   */
  basis: z.enum(["completed", "started"]).optional(),
  /** among equally-filled arms: `seeded` (default, per respondent, reproducible) or `sequential` (the arms' own order) */
  tieBreak: z.enum(["seeded", "sequential"]).optional(),
  /** balance within each cell of this quota (the respondent's matching cell), instead of across the whole sample */
  byQuota: z.string().optional(),
  /** an in-progress claim older than this is treated as abandoned and given back (default 120 minutes) */
  holdMinutes: z.number().int().min(5).max(10_080).optional(),
});
export type ExactBalance = z.infer<typeof ExactBalance>;
