import type { MetadataRoute } from "next";

/** the public documentation is indexable; the product is not (Phase 7) */
export default function robots(): MetadataRoute.Robots {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  return { rules: [{ userAgent: "*", allow: ["/docs", "/docs/", "/llms.txt", "/llms-full.txt", "/login", "/signup"], disallow: ["/api/", "/studio", "/analytics", "/billing", "/admin", "/profile", "/platform", "/share/", "/d/", "/sandbox"] }], ...(base ? { sitemap: `${base}/sitemap.xml` } : {}) };
}
