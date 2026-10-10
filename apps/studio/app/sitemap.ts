import type { MetadataRoute } from "next";
import { listDocs } from "@/lib/docs/pages";

/** the documentation pages, for search engines (Phase 7) */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  const now = new Date();
  return listDocs().map((p) => ({ url: `${base}/docs${p.slug === "index" ? "" : `/${p.slug}`}`, lastModified: now, changeFrequency: "weekly" as const, priority: p.slug === "index" ? 1 : 0.8 }));
}
