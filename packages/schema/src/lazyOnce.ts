/**
 * A RECURSIVE SCHEMA BUILT ONCE (P1, 2026-11-27). zod 3's `z.lazy(getter)` calls `getter` on every parse — and
 * every getter here builds a fresh object, union or discriminated union, so every condition, set expression and
 * flow node in a survey constructed its schema again each time it was read. On the 501-question benchmark survey
 * that was about a third of a full parse. The getter still runs late (the bindings it names exist by then); it now
 * runs once and the result is kept.
 */
export function once<T>(build: () => T): () => T {
  let built: T | undefined;
  return () => (built ??= build());
}
