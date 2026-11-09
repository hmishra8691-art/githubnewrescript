---
id: troubleshoot-piping-blank
title: Piped text is blank
category: troubleshooting
keywords: piping blank, piped text empty, pipe not working, answer not inserted, token empty, piped text appearing blank, merge field empty
related: piping, loops
---
## Likely causes
- **The source question was not answered** — skipped, hidden by display logic, or optional and left blank.
- **The source is on the same page** — the value is not known until that page is submitted.
- **The source comes later** in the flow than the question that pipes it.
- **A loop item piped outside its loop** — it renders empty.
- **The wrong source**: a grid without the row, or an “Other” box not chosen.

## What to check
1. Open the question's text and look at the token: which question, row or field does it pipe?
2. Check the source question is always answered before this one (its own display logic, skip rules on the way).
3. Check they are on different pages.
4. Test with **Test Survey**, answering the source.

## How to fix
Move the piping question to a later page; make the source required, or add display logic so the piping question shows only when the source has an answer; for loops, pipe the loop item only inside the loop.
