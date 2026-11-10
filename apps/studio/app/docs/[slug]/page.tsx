import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listDocs, neighbours, renderDoc } from "@/lib/docs/pages";
import { homeOf } from "@/lib/docs/nav";
import { EXAMPLE_SPLIT } from "@/lib/docs/markdown";
import { buildExample } from "@/lib/docs/build";
import { LiveExample } from "@/components/docs/LiveExample";
import { RolesCatalog } from "@/components/docs/RolesCatalog";
import { DocScreenFigure } from "@/components/docs/DocScreenFigure";
import { MethodCatalog } from "@/components/docs/MethodCatalog";
import { DocShell } from "../DocShell";

export const dynamic = "force-dynamic";

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const doc = renderDoc(params.slug);
  const page = listDocs().find((p) => p.slug === params.slug);
  if (!doc || !page) return { title: "Not found" };
  return { title: `${doc.title} — ResLens.ai Developer Docs`, description: page.description, alternates: { canonical: `/docs/${params.slug}` } };
}

/**
 * ONE DOCS PAGE (Developer Docs, 2026-11-09): the markdown, with each `::: example` replaced by its live example
 * (built on the server by the engine, interactive in the browser), then Related and Previous / Next.
 */
export default function DocPage({ params }: { params: { slug: string } }) {
  const slug = params.slug;
  const doc = renderDoc(slug);
  const pages = listDocs();
  const page = pages.find((p) => p.slug === slug);
  if (!doc || !page) notFound();
  const home = homeOf(slug);
  const parts = doc.html.split(EXAMPLE_SPLIT);
  const { prev, next, related } = neighbours(slug, doc.meta.related);
  return (
    <DocShell pages={pages} current={slug} toc={doc.headings}>
      <nav className="docs-crumbs" aria-label="Breadcrumb" data-testid="docs-crumbs">
        <Link href="/docs">Docs</Link>
        {home && <><span>›</span><span>{home.category.letter ? `${home.category.letter} · ` : ""}{home.category.label}</span><span>›</span><span>{home.group.label}</span></>}
      </nav>
      {doc.meta.status && <div className={`docs-status docs-status-${doc.meta.status}`} data-testid="docs-status">{doc.meta.status === "available" ? "Available now" : doc.meta.status === "partial" ? "Partly supported — see “What is not supported”" : doc.meta.status}</div>}
      <article className="docs-article" data-testid="docs-article">
        {parts.map((part, i) => {
          if (i % 2 === 0) return <div key={i} dangerouslySetInnerHTML={{ __html: part }} />;
          if (part === "catalog-methodologies") return <MethodCatalog key={i} />;
          if (part === "catalog-roles") return <RolesCatalog key={i} />;
          if (part.startsWith("screen-")) return <DocScreenFigure key={i} id={part.slice(7)} />;
          const ex = buildExample(part);
          if (!ex) return <p key={i} className="docs-ex-missing">Example “{part}” is not defined.</p>;
          return <LiveExample key={i} ex={{ id: ex.id, title: ex.title, tryIt: ex.tryIt, def: ex.def, logic: ex.logic, json: ex.json, builder: ex.builder, embedded: ex.embedded, said: ex.said, output: ex.output, simulated: ex.simulated, designs: ex.designs, viewport: ex.viewport }} />;
        })}
      </article>
      {related.length > 0 && (
        <section className="docs-related" data-testid="docs-related">
          <h2>Related</h2>
          <ul>{related.map((r) => <li key={r.slug}><Link href={`/docs/${r.slug}`}><b>{r.title}</b><span>{r.description}</span></Link></li>)}</ul>
        </section>
      )}
      <nav className="docs-pager" aria-label="Previous and next" data-testid="docs-pager">
        {prev ? <Link href={`/docs/${prev.slug}`} className="docs-pager-prev" data-testid="docs-prev"><span>← Previous</span><b>{prev.title}</b></Link> : <span />}
        {next ? <Link href={`/docs/${next.slug}`} className="docs-pager-next" data-testid="docs-next"><span>Next →</span><b>{next.title}</b></Link> : <span />}
      </nav>
    </DocShell>
  );
}
