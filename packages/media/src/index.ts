/**
 * The browser reaches this barrel.
 *
 * `packages/renderer` imports `@rescript/media` for the recorder's own limits
 * — bitrates, the 25 MB cap, how many seconds fit — and that import ends up
 * in a webpack bundle. So everything re-exported here must be safe to send to
 * a browser: pure policy, no `node:` builtin, no secret.
 *
 * `delivery.ts` is not, and cannot be: it mints a download credential with
 * `node:crypto`. It is reached at `@rescript/media/delivery` instead, which
 * keeps the boundary in the import path where a reviewer can see it rather
 * than in a comment nobody reads. Adding it to this file breaks the
 * respondent's survey, which is how this rule was learned.
 */
export * from "./plan.js";
export * from "./store.js";
export * from "./runner.js";
export * from "./zip.js";
