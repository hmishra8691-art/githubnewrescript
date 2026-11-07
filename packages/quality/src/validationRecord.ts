/* written by scripts/quality-validation.mjs --record — do not edit by hand */
import type { ValidationRecord } from "./validation.js";

export const VALIDATION_RECORD: ValidationRecord = {
  "generatedAt": "2026-11-07T19:31:17.749Z",
  "source": "synthetic",
  "responses": 360,
  "flaggedPrecision": 1,
  "genuineFlagged": 0,
  "genuineReview": 0.0875,
  "recall": {
    "inattentive": 1,
    "duplicate": 1,
    "suspicious": 0.9666666666666667,
    "fraudulent": 1
  },
  "gateOpen": false,
  "checks": [
    {
      "name": "sample",
      "ok": true,
      "detail": "360 labelled responses (need 300)"
    },
    {
      "name": "manual labels",
      "ok": false,
      "detail": "source: synthetic (a person-labelled sample of real responses is required)"
    },
    {
      "name": "flagged precision",
      "ok": true,
      "detail": "100.0 % of 90 flagged were real problems (need 95.0 %)"
    },
    {
      "name": "genuine flagged",
      "ok": true,
      "detail": "0.0 % of 240 genuine respondents flagged (max 1.0 %)"
    },
    {
      "name": "genuine sent to review",
      "ok": true,
      "detail": "8.8 % of genuine respondents not PASS (max 10.0 %)"
    },
    {
      "name": "segment device=desktop",
      "ok": true,
      "detail": "0.0 % of 100 genuine flagged (max 3.0 %)"
    },
    {
      "name": "segment locale=en-GB",
      "ok": true,
      "detail": "0.0 % of 100 genuine flagged (max 3.0 %)"
    },
    {
      "name": "segment device=mobile",
      "ok": true,
      "detail": "0.0 % of 100 genuine flagged (max 3.0 %)"
    },
    {
      "name": "segment locale=en-IN",
      "ok": true,
      "detail": "0.0 % of 90 genuine flagged (max 3.0 %)"
    },
    {
      "name": "segment locale=en-US",
      "ok": true,
      "detail": "0.0 % of 50 genuine flagged (max 3.0 %)"
    },
    {
      "name": "segment device=tablet",
      "ok": true,
      "detail": "0.0 % of 40 genuine flagged (max 3.0 %)"
    },
    {
      "name": "recall fraudulent",
      "ok": true,
      "detail": "100.0 % of 30 caught (need 90.0 %)"
    },
    {
      "name": "recall duplicate",
      "ok": true,
      "detail": "100.0 % of 30 caught (need 90.0 %)"
    },
    {
      "name": "recall inattentive",
      "ok": true,
      "detail": "100.0 % of 30 caught (need 75.0 %)"
    }
  ]
};
