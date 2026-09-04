/**
 * @rescript/access — the four layers the requirement insists stay distinct:
 *
 *   AUTHENTICATION        who is this user?            (Supabase Auth + profiles)
 *   SESSION MANAGEMENT    are they logged in?          sessions.ts
 *   PROJECT AUTHORIZATION what may they touch?         roles.ts
 *   EDITING CONTROL       may they change it now?      locks.ts
 *
 * Everything here is PURE: no database, no clock beyond an injectable `now`,
 * no framework. The same functions decide the answer in an API route, in the
 * browser, and in the tests — and the atomic claims in SQL enforce only the
 * predicates stated here, so the two can never disagree.
 */
export * from "./roles.js";
export * from "./sessions.js";
export * from "./locks.js";
export * from "./audit.js";
