import React from "react";
import Link from "next/link";
import type { DocPage } from "@/lib/docs/pages";
import { DOC_NAV } from "@/lib/docs/nav";
import { DocsSearch } from "@/components/docs/DocsSearch";
import { DocsEnhance } from "@/components/docs/DocsEnhance";

/**
 * THE DEVELOPER DOCS SHELL (Phase 7; rebuilt as Developer Docs 2026-11-09): a header with search, a left navigation
 * of categories A–G and the reference (each a collapsible group; the current page's category open), the page, and a
 * table of contents. Public (no session), server-rendered, indexable; styled with the design system's tokens so it
 * reads as the product's own documentation. Nothing here reaches the database.
 */
export function DocShell({ pages, current, toc, children }: { pages: DocPage[]; current: string; toc?: { level: number; text: string; id: string }[]; children: React.ReactNode }) {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const currentCat = bySlug.get(current)?.category ?? null;
  return (
    <div className="docs" data-testid="docs">
      <header className="docs-head">
        <Link href="/docs" className="docs-brand" data-testid="docs-brand">ResLens.ai <span>Developer Docs</span></Link>
        <DocsSearch />
        <nav className="docs-top" aria-label="Site">
          <Link href="/help" data-testid="docs-to-help">Help</Link>
          <Link href="/platform" data-testid="docs-to-app">Open the app</Link>
          <Link href="/login">Sign in</Link>
        </nav>
      </header>
      <div className="docs-body">
        <nav className="docs-nav" aria-label="Documentation" data-testid="docs-nav">
          {DOC_NAV.map((c) => {
            const groups = c.groups.map((g) => ({ ...g, pages: g.slugs.map((s) => bySlug.get(s)).filter((p): p is DocPage => !!p) })).filter((g) => g.pages.length);
            if (!groups.length) return null;
            const open = c.key === currentCat || c.groups.some((g) => g.slugs.includes(current)) || (current === "index" && c.key === "start");
            return (
              <details key={c.key} className="docs-cat" open={open} data-testid={`docs-cat-${c.key}`}>
                <summary><span className="docs-cat-letter">{c.letter}</span>{c.label}</summary>
                {!c.guides && <p className="docs-cat-note">Visual guides for this area are being written; the reference below is current.</p>}
                {groups.map((g) => (
                  <div key={g.label} className="docs-group">
                    {groups.length > 1 || g.label !== "Reference" ? <div className="docs-group-label">{g.label}</div> : null}
                    <ul>{g.pages.map((p) => (
                      <li key={`${g.label}:${p.slug}`}>
                        <Link href={`/docs/${p.slug}`} aria-current={p.slug === current ? "page" : undefined} data-testid={`docs-link-${p.slug}`}>
                          {p.title}{p.generated ? <span className="docs-gen" title="generated from the platform's code">generated</span> : null}
                        </Link>
                      </li>
                    ))}</ul>
                  </div>
                ))}
              </details>
            );
          })}
        </nav>
        <main className="docs-main" data-testid="docs-main">{children}</main>
        {toc && toc.filter((h) => h.level === 2 || h.level === 3).length > 2 && (
          <aside className="docs-toc" aria-label="On this page">
            <div className="docs-toc-title">On this page</div>
            <ul>{toc.filter((h) => h.level === 2 || h.level === 3).map((h) => <li key={h.id} className={`l${h.level}`}><a href={`#${h.id}`}>{h.text}</a></li>)}</ul>
          </aside>
        )}
      </div>
      <DocsEnhance />
    </div>
  );
}
