# Phase 5 (Reporting and research automation): status, 2026-11-18

Patches 0182–0184, plus this note (0185).

| Item | Patch | Outcome |
| --- | --- | --- |
| P2-11 Analyst-grade decks | 0182 | Every claim a generated deck makes from the data now cites a source table: T1, T2 … numbered in the order first cited. Key findings, segment comparisons and statistical highlights cite their analysis. A finding outside the plan cites its own evidence (groups, test, p, effect, n) as a table. Summary, implications and recommendations cite per bullet. A model-written section carries the sources its engine version cites. The objective, the brief and "plan a test for…" lines are marked as context, not claims. The PowerPoint ends with a "Source tables" divider and one slide per table, and each slide's Source links open its table. `unlinkedClaims()` is the gate. Organisation themes and brand rules (contrast enforcement) already existed (report_themes, `enforceTheme`). |
| P2-09 Back-translation workflow | 0183 | Translation tab → Back-translation check. Each translation is put back into the source language through the same provider gate and metering as translation (cache off). It is compared with the source for numbers, negation, scale direction, intensity, placeholders, glossary, untranslated text and dropped content. Each string is ok, review or "meaning changed". The language gets a QA score (the share ok, with review counting half). Every flag must be reconciled: kept with a reason, or revised. The check, its flags and the decisions are stored in the survey (`localization.backChecks`). |
| P2-10 Validated scale library | 0184 | Insert from a library → Validated scale. Eight scales: SUS, UMUX-LITE, SWLS, RSES, PSS-10, GAD-7, WHO-5 and TIPI. Each has its published items, options and recall period, reverse keying, citation, the authors' licence terms and cautions. A scale arrives as a required grid plus a calculation for each score, using the published scoring. |

## Gates

- **"Every deck claim links to its table":** met for every deck the engine writes. The test builds a deck from a planned run and finds no unlinked claim. It also checks the gate is not vacuous (a removed or wrong source is reported), and checks inside the PowerPoint that each source slide holds its table and that the links point to those slides.
- **"Planted meaning shifts flagged":** met on the corpus of 18 Spanish strings: 10 planted shifts (number, negation, two polarity, two scale-direction, placeholder, untranslated, drift, intensity) and 8 faithful translations. Every shift is flagged with the kind it was planted as, and no faithful string is flagged.
- **"Each scale has a citation and its scoring":** met. The tests check that every score spans exactly its published range. They check worked values (SUS all neutral = 50, GAD-7 cut-points, WHO-5 × 4, the PSS-10 reverse items, TIPI subscale means). They also check that the calculation the survey runs gives the same score as the scoring function on random answers, in the real engine.

## Testing done

- Analytics: 880 unit tests pass.
- AI package: 153 tests pass, including 3 new back-translation tests.
- Templates: 174 tests pass, including the 3 new scale tests.
- Studio: 1,289 tests pass. Typecheck is clean. `audit:code` reports 0 problems, and the new back-translate route is guarded.
- Browser (Studio sandbox, `scripts/phase5-library-backcheck-test.mjs`): 5 checks pass. They cover inserting PSS-10 (items, citation, reverse-keyed score), a second copy getting its own stem, the back-translation check running and storing its score, and "Keep" requiring a reason and being recorded.
- The PowerPoint was converted with LibreOffice and inspected: citations, Source links and source-table slides render, with one paragraph-properties element per paragraph.

## Not done, or not tested

- **No real provider was used for back-translation.** The sandbox uses the fake one, so its score there means nothing. The comparison itself is tested on the corpus.
- **The comparison rules are English-source rules.** Negation, polarity and intensity words are English. A survey written in another source language gets the number, placeholder, glossary and untranslated checks, but not the word-level ones.
- **Literature search through an approved source is not built.** It needs a licensed source, which is an owner decision.
- **Scale citations were written from knowledge, because web search is unavailable here.** Check them against the originals before quoting them in a client document. The file says so.
- **Scale licence lines repeat what the authors state.** They are not legal advice. The PSS, RSES and TIPI are marked free for non-commercial or academic research only.
