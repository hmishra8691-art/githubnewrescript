-- 0090 — One margin resolver (2026-11-05).
--
-- 0087 shipped the margin engine twice: `resolveMargin` in packages/recruitment/src/margin.ts, and
-- `rescript_margin_resolve` here. Its own comment said the second existed "so a report, a reconciliation or a
-- finance query can ask the same question and get the same answer, rather than a second implementation
-- drifting from the first" — which has the reasoning backwards. Writing the rules twice is what causes the
-- drift; it cannot also be the cure for it.
--
-- Nothing ever called the SQL one. The TypeScript one is on the quoting path, where the precedence
-- (override → project → recruitment_type → market → default) decides what a researcher is charged.
--
-- ## Why the quoting side wins, and finance loses nothing
--
-- `margin_applications` already records every price that was computed, with its cost, its rate, its scope and
-- the rule's id. A finance query wants the rate that WAS applied to a quote somebody accepted, not the rate
-- that would be resolved if the question were asked again today — and those differ by design the moment a
-- rule is superseded, which is the normal case. Reading the record is both simpler and more correct than
-- recomputing it, so the recomputation is the half to remove.
--
-- An ad-hoc query that genuinely needs today's rate can still select it: the ordering is four lines of SQL
-- over `commercial_margins` and it is written out in this file's history. What it must not be is a second
-- callable authority that can disagree with the one that priced the work.
--
-- Nothing else changes. `commercial_margins`, `margin_applications`, their constraints and their policies are
-- untouched, and no price already recorded moves.
--
-- Re-runnable: `drop … if exists`. Undo: re-apply the resolver block from 0087.

drop function if exists public.rescript_margin_resolve(uuid, text, uuid, text, timestamptz, integer);

comment on table public.margin_applications is
  'Every price computed, with its cost, rate and rule (0087). Administrator reads only — cost_amount and profit_amount never reach a researcher. Since 0090 this is also the ANSWER to "what rate applied here": the margin is resolved once, on the quoting path, and recorded here rather than recomputed.';
