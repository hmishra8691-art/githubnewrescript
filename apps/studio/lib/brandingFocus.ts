import type { PreviewRegion } from "./brandingChanges.ts";

/**
 * WHERE THE PREVIEW SHOULD POINT (Branding redesign, 2026-11-07). The settings column says which part of the
 * respondent's page the setting under the pointer (or the open section) affects; the live preview outlines that
 * part. `device` lets a section (Phone & tablet) switch the preview to the screen it is about. `flash` is a region
 * a change just touched, highlighted briefly.
 */
export interface BrandingFocus { region: PreviewRegion | null; hover: PreviewRegion | null; flash: PreviewRegion | null; device: "desktop" | "tablet" | "mobile" | null; seq: number }

let state: BrandingFocus = { region: null, hover: null, flash: null, device: null, seq: 0 };
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };
let flashTimer: ReturnType<typeof setTimeout> | null = null;

export const brandingFocus = {
  get: () => state,
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  setRegion(region: PreviewRegion | null, device: BrandingFocus["device"] = null) { state = { ...state, region, device, seq: state.seq + 1 }; emit(); },
  setHover(hover: PreviewRegion | null) { if (state.hover === hover) return; state = { ...state, hover }; emit(); },
  flash(region: PreviewRegion) {
    state = { ...state, flash: region }; emit();
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { state = { ...state, flash: null }; emit(); }, 1600);
  },
};

/** the region the preview outlines: what the pointer is on, else what just changed, else the open section */
export const activeRegion = (f: BrandingFocus): PreviewRegion | null => f.hover ?? f.flash ?? f.region;
