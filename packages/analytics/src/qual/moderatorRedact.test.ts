import { test } from "node:test";
import assert from "node:assert/strict";
import { maskContactDetails } from "@rescript/engine";
import { redactText } from "./redact.js";

/*
 * THE AI MODERATOR MASKS CONTACT DETAILS WITH THE SAME PATTERNS AS THE QUALITATIVE REDACTION (2026-10-22).
 * The engine cannot import analytics (analytics depends on the engine), so the moderator keeps its own copy
 * of the e-mail and phone patterns; this pins the two together: any drift fails here.
 */
test("maskContactDetails === redactText without a names list, on a corpus of contact details and look-alikes", () => {
  const corpus = [
    "Email me at anna.smith@example.com or call +91 98765 43210",
    "call 020 7946 0958 at 10:30, or (555) 123-4567",
    "the price went up from £25 to £32.50 in 2024",
    "my number is 9876543210 and my email A.B+c@mail.co.uk",
    "version 1.2.3 released on 2026-10-22, ticket 12345",
    "+44 7700 900123 and 07700-900-123",
    "nothing personal here at all",
    "पता: anna@example.in फ़ोन 98765 43210",
  ];
  for (const t of corpus) assert.equal(maskContactDetails(t).text, redactText(t).text, t);
});
