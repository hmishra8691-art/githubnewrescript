/**
 * A SENTENCE HANDED TO INTELLIGENT MODE (2026-11-09) — from Help's "Send to Intelligent Mode". The text lands in
 * Intelligent Mode's input for the researcher to read and send; nothing is proposed or applied until they do.
 */
let pending: string | null = null;
export const INTELLIGENT_INPUT_EVENT = "rescript:intelligent-input";
export function setPendingIntelligentInput(text: string): void {
  pending = text;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(INTELLIGENT_INPUT_EVENT));
}
export function takePendingIntelligentInput(): string | null { const p = pending; pending = null; return p; }
