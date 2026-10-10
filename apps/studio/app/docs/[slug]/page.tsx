import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DOC_ORDER, listDocs, renderDoc } from "@/lib/docs/pages";
import { DocShell } from "../DocShell";

export const dynamic = "force-dynamic";

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const doc = renderDoc(params.slug);
  const entry = DOC_ORDER.find((d) => d.slug === params.slug);
  if (!doc || !entry) return { title: "Not found" };
  return { title: `${doc.title} — ReScript Studio docs`, description: entry.description, alternates: { canonical: `/docs/${params.slug}` } };
}

export default function DocPage({ params }: { params: { slug: string } }) {
  const slug = params.slug.endsWith(".md") ? params.slug.slice(0, -3) : params.slug;
  const doc = renderDoc(slug);
  if (!doc || slug === "index") notFound();
  return <DocShell pages={listDocs()} current={slug} toc={doc.headings}><article className="docs-article" dangerouslySetInnerHTML={{ __html: doc.html }} /></DocShell>;
}
