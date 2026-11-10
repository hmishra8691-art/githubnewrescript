import type { MetadataRoute } from "next";
import { listDocs } from "@/lib/docs/pages";

/** the documentation pages, for search engines (Phase 7; Developer Docs 2026-11-09: the home and every page) */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  const now = new Date();
  return [{ url: `${base}/docs`, lastModified: now, changeFrequency: "weekly" as const, priority: 1 }, ...listDocs().map((p) => ({ url: `${base}/docs/${p.slug}`, lastModified: now, changeFrequency: "weekly" as const, priority: 0.8 }))];
}
