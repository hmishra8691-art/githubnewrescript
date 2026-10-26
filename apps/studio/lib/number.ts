/**
 * COUNTS IN THE STUDIO READ THE SAME WAY THE TABLES BESIDE THEM DO.
 *
 * `n.toLocaleString()` with no locale takes the browser's. That is defensible
 * on its own — this is the researcher's own screen — but the Studio renders
 * analytics output, and analytics pins its numbers. The two met inside a
 * single expression in `AnalyticsWorkspace`:
 *
 *     ct === "count" ? Math.round(v).toLocaleString()                 // browser
 *                    : v.toLocaleString("en-US", { … })               // pinned
 *
 * so on a machine with Indian settings one crosstab showed a base of
 * "2,50,000" in one column and a mean of "250,000" in the next. Twenty-eight
 * call sites across thirteen files were on the browser's side of that line.
 *
 * DATES are deliberately not included. A timestamp on a researcher's own
 * screen should follow their locale and their time zone, and the thirty-one
 * `new Date(…).toLocaleString()` calls are left exactly as they are.
 */
export { DEFAULT_NUMBER_LOCALE } from "@rescript/engine";
