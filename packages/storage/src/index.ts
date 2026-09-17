/**
 * THE SERVER BARREL.
 *
 * `sigv4.ts` imports `node:crypto` and `r2.ts`/`memory.ts` import it, so this
 * whole entry point is Node-only. A client component that pulls it in fails
 * the bundle with "Module not found: node:crypto", which is the build telling
 * the truth: a browser must never hold a signing key.
 *
 * The pure arithmetic a browser DOES need — the upload plan, the part
 * accumulator, the resume and retry policy — is at `@rescript/storage/upload`,
 * with no dependencies at all. `packages/media` draws the same line for the
 * same reason, with `delivery.ts` kept out of its barrel.
 */
export * from "./provider.js";
export * from "./sigv4.js";
export * from "./r2.js";
export * from "./memory.js";
export * from "./upload.js";
export * from "./completion.js";
