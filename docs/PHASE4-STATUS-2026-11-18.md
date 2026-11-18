# Phase 4 (analytics depth, data quality, abuse protection): status, 2026-11-18

Patches 0178–0180, plus this note (0181).

| Item | Patch | Outcome |
| --- | --- | --- |
| P2-06 Relative importance for drivers | 0178 | NPS and CSAT/CES driver tables now show each driver's share of R². Shapley/LMG is exact over every subset for up to 12 drivers. Johnson's relative weights are always shown. Rows are ranked by that share, with the betas kept beside it. Checked against an independent NumPy computation to 1e-9 (the fixture and its generator are committed). |
| P2-05 Nested column banners | 0179 | `nestCols` crosses up to three column variables (at most 120 columns) into one two-level header, such as Gender › Region. Counts, bases and tests reuse the existing single-variable path. Significance letters compare only columns under the same outer category. The option is in the crosstab builder. A column base is checked against a hand count. |
| P1-08 Bot challenge on open links | 0180 | `deployment.access.botChallenge` is off by default and is a Studio checkbox for open access. It runs only where the runtime has `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`. The token is verified before a response row exists. Test links, resumes and closed access modes are not challenged. If Cloudflare is unreachable or our secret is refused, the start is allowed and logged. The CSP allows Cloudflare only when the keys are set. |
| P1-06 Every complete assessed | none | **No defect.** Quality checks have been on by default since CLEAN-03. In the live database, all 37 live and 22 test completes without an assessment belong to surveys whose published version explicitly turned the checks off. The Quality tab says so, and "Re-assess" scores them. The keep / flag / exclude review queue already exists. Running Re-assess on those surveys writes to the live database, so it waits for the owner. |
| P2-02 Raw vs cleaned exports | none | **Already present.** Every export takes `dataset=all\|clean\|custom` and stamps which one it is. The cleaning plan document records the decisions. |
| P2-07 HB from the analysis tab | none | **Audit overstated.** HB is a method in the analysis builder, run as a background job with chains, burn-in and draws in Options. It is not only available through the plan. |
| P2-08 Reference-value pack | none | **Partly in place.** 74 analytics test files check results against scipy, statsmodels, R/lavaan or SPSS reference values. These are not yet collected into one published document for customers. That is a documentation task left open. |
| P2-03 Cross-study respondent reputation | none | **Owner decision.** It would link one person's behaviour across studies, and across customers on a shared panel. That is a data-protection decision (lawful basis, retention, tenant boundary) before it is an engineering one. Nothing was built. |

## Testing done

- Analytics: 879 unit tests pass, including 3 relative-importance tests and 3 nested-banner tests.
- Runtime: 128 tests pass (4 new: challenge configuration, verification, fail-open behaviour and CSP).
- Schema: 20 tests pass.
- Typecheck is clean for Studio and runtime. `audit:code` reports 0 problems.

## Not tested

- **The Turnstile widget has not been run in a browser.** It needs Cloudflare's network and a live deployment, and neither is available in this sandbox. Only the server verification and the CSP are covered by tests. Before relying on it, try it on staging with Cloudflare's published test keys.
- **Nested columns have not been checked in the Studio grid in a browser.** They use the existing group-header rendering in `ProTable`.
