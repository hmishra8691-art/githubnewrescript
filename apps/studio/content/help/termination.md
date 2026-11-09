---
id: termination
title: End the survey, screen out or redirect respondents
category: logic
keywords: terminate, termination, screen out, screened, disqualify, end survey, quota full, redirect, end page, thank you page, panel redirect
related: skip-logic, quotas, branching
---
## What it does
An ending decides how an interview finishes: **complete**, screened out, quota full, or terminated. Panels usually need a redirect back to their site with the status, which ResLens.ai can attach.

## How to set it up
1. In **Programming** → **Survey Flow**, click **+ Add element** where the interview should end and choose **End of survey**; pick its status.
2. To send respondents elsewhere, add a **Redirect** element and enter the **Redirect URL** (you can pipe embedded data such as the panel's respondent id into it).
3. To end someone mid-questionnaire, add a skip rule on the deciding question with **THEN GO TO** an ending, or put the ending inside a **Branch / condition**.
4. Test each ending with **Test Survey** and look at the status in **Data**.

## Common mistakes
- Screening people out after the questions you paid for — put screeners first.
- A redirect without the respondent id the panel needs to credit them.

## Related
Quota-full endings are set on the quota itself (Programming → Quotas).
