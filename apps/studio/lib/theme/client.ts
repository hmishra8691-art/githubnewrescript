"use client";
import React from "react";
import { DEFAULT_THEME, THEME_STORAGE_KEY, isStudioTheme, studioTheme } from "./themes";

/**
 * THE THEME, IN THE BROWSER (2026-11-11).
 *
 *   applied   what the page is drawn in right now — `data-theme` on <html>. A preview changes only this.
 *   saved     the person's choice: this browser's memory (so the next load paints it before anything else) and
 *             their account (`/api/profile/theme`), so it follows them to another browser and survives signing
 *             out and in. The account is the truth when it answers: somebody else signing in on this browser gets
 *             THEIR theme, or the default if they never chose one — not the last person's.
 *
 * One module-level store, so the selector, the boot and any other reader agree without a provider.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
let saved: string = DEFAULT_THEME;
let preview: string | null = null;
let booted = false;

const read = (): string => { try { const v = window.localStorage.getItem(THEME_STORAGE_KEY); return isStudioTheme(v) ? v : DEFAULT_THEME; } catch { return DEFAULT_THEME; } };
const remember = (id: string) => { try { if (id === DEFAULT_THEME) window.localStorage.removeItem(THEME_STORAGE_KEY); else window.localStorage.setItem(THEME_STORAGE_KEY, id); } catch { /* private mode: the account still has it */ } };
function paint(id: string) {
  const el = document.documentElement;
  if (el.getAttribute("data-theme") !== id) el.setAttribute("data-theme", id);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", studioTheme(id).swatch[2]);
}
const emit = () => { paint(preview ?? saved); listeners.forEach((l) => l()); };

/** once per page load: this browser's memory first, then the account's answer */
export function bootTheme(): void {
  if (booted || typeof window === "undefined") return;
  booted = true;
  saved = read();
  emit();
  void fetch("/api/profile/theme", { cache: "no-store" }).then(async (r) => {
    if (!r.ok) return;
    const d = (await r.json().catch(() => null)) as { theme?: string | null; stored?: boolean } | null;
    if (!d?.stored) return;
    const mine = isStudioTheme(d.theme) ? d.theme : DEFAULT_THEME;
    if (mine !== saved) { saved = mine; remember(mine); emit(); }
  }).catch(() => { /* offline, or the sandbox: this browser's memory stands */ });
}

/** choose a theme: drawn at once, remembered here, and saved to the account */
export function chooseTheme(id: string): void {
  if (!isStudioTheme(id)) return;
  saved = id; preview = null;
  remember(id);
  emit();
  void fetch("/api/profile/theme", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: id }), cache: "no-store" }).catch(() => {});
}

/** show a theme without choosing it (null: back to the chosen one) */
export function previewTheme(id: string | null): void {
  const next = id && isStudioTheme(id) && id !== saved ? id : null;
  if (next === preview) return;
  preview = next;
  emit();
}

export function useStudioTheme(): { saved: string; preview: string | null } {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => { listeners.add(force); bootTheme(); force(); return () => { listeners.delete(force); }; }, []);
  return { saved, preview };
}

/** mounted once in the root layout: every page — the dashboard, a project, analytics — gets the person's theme */
export function ThemeBoot(): null {
  React.useEffect(() => { bootTheme(); }, []);
  return null;
}
