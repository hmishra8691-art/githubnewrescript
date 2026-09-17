"use client";

/**
 * "Download PDF" is the print dialog. That is not a shortcut: it is the route
 * this repository already takes for survey reports, it needs no server-side
 * renderer, and every platform offers Save as PDF from the same dialog. The
 * page's own `@media print` rules are what make the result a document rather
 * than a screenshot of a web page.
 */
export function PrintButton() {
  return (
    <button type="button" className="btn" onClick={() => window.print()} data-testid="download-pdf">
      Download as PDF
    </button>
  );
}
