"use client";
import * as React from "react";

/**
 * SMALL PAGE ENHANCEMENTS FOR THE DOCS (2026-11-09): a Copy button on every code block of the article (the
 * markdown renderer escapes everything and emits no buttons), and a language label. Runs after hydration; the page
 * is complete without it.
 */
export function DocsEnhance() {
  React.useEffect(() => {
    const pres = Array.from(document.querySelectorAll<HTMLPreElement>(".docs-article pre:not(.docs-ex-pre)"));
    for (const pre of pres) {
      if (pre.dataset.enhanced) continue;
      pre.dataset.enhanced = "1";
      const bar = document.createElement("div");
      bar.className = "docs-pre-bar";
      const lang = pre.dataset.lang;
      if (lang) { const l = document.createElement("span"); l.className = "docs-pre-lang"; l.textContent = lang === "logic" ? "logic expression" : lang; bar.appendChild(l); }
      const b = document.createElement("button");
      b.type = "button"; b.className = "docs-copy"; b.textContent = "Copy"; b.setAttribute("data-testid", "docs-copy");
      b.addEventListener("click", () => {
        void navigator.clipboard?.writeText(pre.querySelector("code")?.textContent ?? pre.textContent ?? "").then(() => { b.textContent = "Copied ✓"; setTimeout(() => { b.textContent = "Copy"; }, 1400); }).catch(() => {});
      });
      bar.appendChild(b);
      pre.parentNode?.insertBefore(bar, pre);
      pre.classList.add("has-bar");
    }
  });
  return null;
}
