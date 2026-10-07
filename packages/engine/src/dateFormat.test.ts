import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDateAs, parseDateAs, formatTimeAs, localToday, localNow, initialDateValue, initialTimeValue, DATE_FORMATS } from "./dateFormat.js";

test("formatDateAs — the review's eight formats, for 23 September 2026", () => {
  const want: Record<string, string> = {
    "MM/DD/YYYY": "09/23/2026", "DD/MM/YYYY": "23/09/2026", "YYYY/MM/DD": "2026/09/23", "MM-DD-YYYY": "09-23-2026",
    "DD-MM-YYYY": "23-09-2026", "YYYY-MM-DD": "2026-09-23", "DD MMM YYYY": "23 Sep 2026", "MMM DD, YYYY": "Sep 23, 2026",
    "DD MMMM YYYY": "23 September 2026", "MMMM DD, YYYY": "September 23, 2026",
  };
  assert.equal(DATE_FORMATS.length, 10, "the October 2026 review's ten formats");
  for (const f of DATE_FORMATS) assert.equal(formatDateAs("2026-09-23", f), want[f], f);
  assert.equal(formatDateAs("2026-09-23", undefined), "09/23/2026", "unset keeps the old MM/DD/YYYY");
  assert.equal(formatDateAs("not a date", "DD/MM/YYYY"), "");
});

test("parseDateAs — each format reads back to the stored date; day-first and month-first are not confused", () => {
  for (const f of DATE_FORMATS) assert.equal(parseDateAs(formatDateAs("2026-09-23", f), f), "2026-09-23", f);
  assert.equal(parseDateAs("03/04/2026", "DD/MM/YYYY"), "2026-04-03", "3 April when the day comes first");
  assert.equal(parseDateAs("03/04/2026", "MM/DD/YYYY"), "2026-03-04", "4 March when the month comes first");
  assert.equal(parseDateAs("3/4/2026", "DD/MM/YYYY"), "2026-04-03", "single digits are fine");
  assert.equal(parseDateAs("23 september 2026", "DD MMM YYYY"), "2026-09-23", "a month name on its first three letters");
  assert.equal(parseDateAs("Sep 23 2026", "MMM DD, YYYY"), "2026-09-23", "the comma is optional");
});

test("parseDateAs — not a date, the wrong format, and a day the calendar does not have, are all null", () => {
  assert.equal(parseDateAs("", "DD/MM/YYYY"), null);
  assert.equal(parseDateAs("31/02/2026", "DD/MM/YYYY"), null, "31 February");
  assert.equal(parseDateAs("29/02/2025", "DD/MM/YYYY"), null, "not a leap year");
  assert.equal(parseDateAs("29/02/2024", "DD/MM/YYYY"), "2024-02-29", "a leap year");
  assert.equal(parseDateAs("2026-09-23", "DD/MM/YYYY"), null, "another format is not this one");
  assert.equal(parseDateAs("13/13/2026", "MM/DD/YYYY"), null, "month 13");
  assert.equal(parseDateAs("23 Foo 2026", "DD MMM YYYY"), null, "an unknown month");
  assert.equal(parseDateAs("23 Septober 2026", "DD MMMM YYYY"), null, "a word that only starts like a month");
  assert.equal(parseDateAs("15 January 2026", "DD MMMM YYYY"), "2026-01-15");
  assert.equal(parseDateAs("January 30, 2026", "MMMM DD, YYYY"), "2026-01-30");
  assert.equal(parseDateAs("Sept 3, 2026", "MMMM DD, YYYY"), "2026-09-03", "an abbreviation is read in the long format too");
});

test("formatTimeAs — 12 and 24 hour, with and without seconds", () => {
  assert.equal(formatTimeAs("09:30", { hour12: true }), "09:30 AM");
  assert.equal(formatTimeAs("21:05", { hour12: true }), "09:05 PM");
  assert.equal(formatTimeAs("00:15", { hour12: true }), "12:15 AM", "midnight is 12 AM");
  assert.equal(formatTimeAs("12:00", { hour12: true }), "12:00 PM", "noon is 12 PM");
  assert.equal(formatTimeAs("09:30", {}), "09:30");
  assert.equal(formatTimeAs("09:30", { seconds: true }), "09:30:00");
  assert.equal(formatTimeAs("21:05:07", { hour12: true, seconds: true }), "09:05:07 PM");
  assert.equal(formatTimeAs("nope", {}), "");
});

test("defaults — none, the respondent's own today / now, or the programmer's fixed value", () => {
  const now = new Date(2026, 8, 23, 14, 7, 9); // local time
  assert.equal(localToday(now), "2026-09-23");
  assert.equal(localNow(now), "14:07");
  assert.equal(localNow(now, true), "14:07:09");
  assert.equal(initialDateValue({}, now), null);
  assert.equal(initialDateValue({ defaultDateMode: "none" }, now), null);
  assert.equal(initialDateValue({ defaultDateMode: "current" }, now), "2026-09-23");
  assert.equal(initialDateValue({ defaultDateMode: "custom", defaultDate: "2026-01-01" }, now), "2026-01-01");
  assert.equal(initialDateValue({ defaultDateMode: "custom", defaultDate: "" }, now), null, "custom with no date is nothing");
  assert.equal(initialTimeValue({ defaultTimeMode: "current" }, now), "14:07");
  assert.equal(initialTimeValue({ defaultTimeMode: "current", showSeconds: true }, now), "14:07:09");
  assert.equal(initialTimeValue({ defaultTimeMode: "custom", defaultTime: "09:30" }, now), "09:30");
  assert.equal(initialTimeValue({ defaultTimeMode: "custom", defaultTime: "9.30" }, now), null);
});
