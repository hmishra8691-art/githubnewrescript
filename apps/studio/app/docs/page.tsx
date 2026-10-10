import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listDocs, renderDoc } from "@/lib/docs/pages";
import { DocShell } from "./DocShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "ReScript Studio — developer documentation",
  description: "How to program surveys in ReScript Studio: the survey definition, question types, logic and expressions, piping, custom code, Intelligent mode, the Research Engine, data and exports, the API.",
  alternates: { canonical: "/docs" },
};

export default function DocsIndex() {
  const doc = renderDoc("index");
  if (!doc) notFound();
  return <DocShell pages={listDocs()} current="index" toc={doc.headings}><article className="docs-article" dangerouslySetInnerHTML={{ __html: doc.html }} /></DocShell>;
}
