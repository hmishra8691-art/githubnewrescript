/**
 * A CAROUSEL OF INSERTED MEDIA, MADE USABLE (October 2026 review: "the
 * respondent can use Previous / Next controls or swipe on mobile").
 *
 * The question text holds the group (`mediaGroupHtml`, layout "carousel");
 * the stylesheet makes it a scroll-snapped strip, so a swipe already works.
 * This adds ← → and the dots beside it, once per group, and keeps them in
 * step with the strip. It touches only the markup the text produced, and is
 * re-applied whenever that text is redrawn.
 */
export function enhanceMediaCarousels(root: HTMLElement | null): () => void {
  if (!root || typeof window === "undefined") return () => {};
  const cleanups: (() => void)[] = [];
  root.querySelectorAll<HTMLElement>('.rs-media-group[data-rs-layout="carousel"]').forEach((strip) => {
    if (strip.dataset.rsEnhanced === "1") return;
    const cells = Array.from(strip.children).filter((c) => c.classList.contains("rs-media-cell")) as HTMLElement[];
    if (cells.length < 2) return;
    strip.dataset.rsEnhanced = "1";
    const nav = document.createElement("div");
    nav.className = "rs-media-carousel-nav";
    nav.setAttribute("data-testid", "media-carousel-nav");
    const prev = document.createElement("button");
    prev.type = "button"; prev.textContent = "←"; prev.setAttribute("aria-label", "Previous media");
    prev.setAttribute("data-testid", "media-carousel-prev");
    const next = document.createElement("button");
    next.type = "button"; next.textContent = "→"; next.setAttribute("aria-label", "Next media");
    next.setAttribute("data-testid", "media-carousel-next");
    const dots = document.createElement("span");
    dots.className = "rs-media-carousel-dots";
    const dotEls = cells.map(() => { const d = document.createElement("span"); dots.appendChild(d); return d; });
    nav.append(prev, dots, next);
    strip.after(nav);
    const index = () => Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth));
    const sync = () => {
      const i = Math.max(0, Math.min(cells.length - 1, index()));
      dotEls.forEach((d, k) => d.classList.toggle("on", k === i));
      prev.disabled = i === 0;
      next.disabled = i === cells.length - 1;
      strip.setAttribute("data-rs-index", String(i));
    };
    const go = (d: -1 | 1) => {
      const i = Math.max(0, Math.min(cells.length - 1, index() + d));
      strip.scrollTo({ left: i * strip.clientWidth, behavior: "smooth" });
      /* scroll events settle the dots; set them now too, for a strip that cannot scroll (hidden, zero width) */
      window.setTimeout(sync, 350);
    };
    prev.onclick = () => go(-1);
    next.onclick = () => go(1);
    strip.addEventListener("scroll", sync, { passive: true });
    sync();
    cleanups.push(() => {
      strip.removeEventListener("scroll", sync);
      nav.remove();
      delete strip.dataset.rsEnhanced;
    });
  });
  return () => cleanups.forEach((c) => c());
}
