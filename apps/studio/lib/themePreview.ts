import type { Branding } from "@rescript/schema";

/**
 * A THEME ON APPROVAL. While the Branding panel's theme assistant has a
 * proposal open, the live preview beside the panel shows the proposed
 * branding instead of the saved one — the same preview component, the same
 * renderer — and goes back to the saved one on Apply or Cancel.
 */
let current: Branding | null = null;
const listeners = new Set<() => void>();
export const themePreviewStore = {
  get: () => current,
  set(b: Branding | null) { current = b; for (const l of listeners) l(); },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};
