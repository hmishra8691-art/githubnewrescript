import type { Metadata } from "next";
import "./portal.css";

/**
 * THE RESPONDENT PORTAL (Respondent Intelligence Engine, phase 1, 2026-11-20) — /portal. A signed-in place for the
 * people who answer: their assessments, what they submitted, and their account. Nothing about it is indexed.
 */
export const metadata: Metadata = { title: "My assessments", robots: { index: false, follow: false } };

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return children;
}
