import type { EvalContext } from "./evaluate.js";

/**
 * Where "what was the respondent shown" is registered. A module of its own
 * with NO runtime imports, on purpose: `carryforward.ts` registers at load
 * time, and `evaluate.ts` and `carryforward.ts` import each other, so a
 * registry living inside either one is not yet initialised when the other
 * runs its top level (a temporal-dead-zone error at import).
 */
export type DisplayedCodesResolver = (questionRef: string, ctx: EvalContext) => (string | number)[] | null;
let resolver: DisplayedCodesResolver | null = null;
export function registerDisplayedCodesResolver(fn: DisplayedCodesResolver): void { resolver = fn; }
export const displayedCodesFor = (ref: string, ctx: EvalContext): (string | number)[] | null | undefined =>
  resolver ? resolver(ref, ctx) : undefined;
export const hasDisplayedResolver = (): boolean => resolver !== null;
