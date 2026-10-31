/**
 * S3b — MANAGING SCRIPTS, the pure half (audit MM-06 duplicate). The Studio's cards call these and write the result
 * through the store as one labelled edit.
 *
 * A DUPLICATE is a copy with a new id and "(copy)" in its name. A copied SCRIPT (a behaviour, with a script or with
 * effects, and a Scripts-panel logic script) starts SWITCHED OFF, so the two copies never both run — the original
 * keeps running, the copy waits until it is edited and switched on (which passes the gate). Styles and animations have
 * no switch: a copy applies at once, which is what a copied look is for.
 */
import type { CustomScript, UxAnimation, UxBehavior, UxStyle } from "@rescript/schema";

export type UxKind = "style" | "animation" | "behavior";

const copyName = (name: string, max: number) => {
  const base = name.replace(/\s*\(copy(?: \d+)?\)$/, "");
  const n = /\(copy(?: (\d+))?\)$/.exec(name);
  const tag = n ? ` (copy ${Number(n[1] ?? 1) + 1})` : " (copy)";
  return `${base.slice(0, Math.max(1, max - tag.length))}${tag}`;
};

/** a copy of a style, animation or behaviour; behaviours start switched off */
export function duplicateUxItem<T extends UxStyle | UxAnimation | UxBehavior>(kind: UxKind, item: T, newId: string, now = new Date().toISOString()): T {
  const copy = structuredClone(item) as T;
  copy.id = newId;
  copy.label = copyName(item.label, 160);
  (copy as { createdAt?: string }).createdAt = now;
  if (kind === "behavior") {
    (copy as UxBehavior).enabled = false;
    /* a copy is not the old Custom code field it may have come from */
    delete (copy as UxBehavior).source;
  }
  return copy;
}

/** a copy of a Scripts-panel logic script, switched off */
export function duplicateLogicScript(sc: CustomScript, newId: string): CustomScript {
  const copy = structuredClone(sc);
  copy.id = newId;
  copy.name = copyName(sc.name, 120);
  copy.enabled = false;
  return copy;
}

export const DUPLICATE_NOTE = "The copy is switched off, so the two never both run — edit it, then switch it on.";
