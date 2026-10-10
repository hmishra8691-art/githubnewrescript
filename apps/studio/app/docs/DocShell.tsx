import React from "react";
import Link from "next/link";
import type { DocPage } from "@/lib/docs/pages";

/**
 * THE PUBLIC DOCUMENTATION SHELL (Phase 7): a left navigation of the pages,
 * the page, a table of contents. Public (no session), server-rendered,
 * indexable; styled with the design system's tokens so it reads as the
 * product's own documentation. Nothing here reaches the database.
 */
export function DocShell({ pages, current, toc, children }: { pages: DocPage[]; current: string; toc?: { level: number; text: string; id: string }[]; children: React.ReactNode }) {
  return (
    <div className="docs" data-testid="docs">
      <header className="docs-head">
        <Link href="/docs" className="docs-brand">ReScript Studio <span>developer docs</span></Link>
        <nav className="docs-top"><Link href="/llms.txt">llms.txt</Link><Link href="/login">Sign in</Link></nav>
      </header>
      <div className="docs-body">
        <nav className="docs-nav" aria-label="Pages" data-testid="docs-nav">
          <ul>{pages.map((p) => <li key={p.slug}><Link href={p.slug === "index" ? "/docs" : `/docs/${p.slug}`} aria-current={p.slug === current ? "page" : undefined}>{p.title}{p.generated ? <span className="docs-gen" title="generated from the code">·</span> : null}</Link></li>)}</ul>
        </nav>
        <main className="docs-main" data-testid="docs-main">{children}</main>
        {toc && toc.length > 2 && (
          <aside className="docs-toc" aria-label="On this page">
            <div className="docs-toc-title">On this page</div>
            <ul>{toc.filter((h) => h.level === 2 || h.level === 3).map((h) => <li key={h.id} className={`l${h.level}`}><a href={`#${h.id}`}>{h.text}</a></li>)}</ul>
          </aside>
        )}
      </div>
    </div>
  );
}
