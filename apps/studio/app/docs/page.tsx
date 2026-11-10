import type { Metadata } from "next";
import Link from "next/link";
import { listDocs } from "@/lib/docs/pages";
import { DOC_NAV } from "@/lib/docs/nav";
import { DocShell } from "./DocShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "ResLens.ai Developer Docs",
  description: "How to program surveys in ResLens.ai: every question type and feature shown in the builder, as an expression and in the live survey — plus the complete technical reference.",
  alternates: { canonical: "/docs" },
};

/** THE DEVELOPER DOCS HOME (2026-11-09): what the docs show, and every category with its pages */
export default function DocsHome() {
  const pages = listDocs();
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  return (
    <DocShell pages={pages} current="index">
      <article className="docs-article docs-home" data-testid="docs-home">
        <h1>ResLens.ai Developer Docs</h1>
        <p className="docs-lede">The visual guide and technical reference for programming surveys in ResLens.ai. Pick any feature to see what it does, when to use it, how to set it up — and the same example three ways:</p>
        <div className="docs-three" data-testid="docs-three">
          <div><span className="docs-ex-n">1</span><b>Builder view</b><p>The real Studio screen where the feature is configured.</p></div>
          <div><span className="docs-ex-n">2</span><b>Programming view</b><p>The expression and the stored survey definition behind it, ready to copy.</p></div>
          <div><span className="docs-ex-n">3</span><b>Respondent view</b><p>The survey itself, live: answer it and watch the logic work.</p></div>
        </div>
        <div className="docs-cats">
          {DOC_NAV.filter((c) => c.key !== "start").map((c) => {
            const ps = [...new Set(c.groups.flatMap((g) => g.slugs))].map((s) => bySlug.get(s)).filter((p): p is NonNullable<typeof p> => !!p);
            if (!ps.length) return null;
            return (
              <section key={c.key} className="docs-cat-card" data-testid={`docs-home-cat-${c.key}`}>
                <h2>{c.letter && <span className="docs-cat-letter">{c.letter}</span>}{c.label}</h2>
                <p>{c.summary}</p>
                {!c.guides && <p className="docs-cat-note">Visual guides for this area are being written; the reference pages below are current.</p>}
                <ul>{ps.slice(0, 40).map((p) => <li key={p.slug}><Link href={`/docs/${p.slug}`}>{p.title}</Link></li>)}</ul>
              </section>
            );
          })}
        </div>
        <p className="docs-cat-note">New to ResLens.ai? Start with <Link href="/docs/getting-started">Getting started</Link>. Pages marked <i>generated</i> are written from the platform&apos;s own code, so they always match the current release.</p>
      </article>
    </DocShell>
  );
}
