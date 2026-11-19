import assert from "node:assert/strict";
import { parseCalendar } from "./calendar.ts";

const text = [
  "begin:vcalendar", "begin:vevent", "uid:CaseSensitive",
  "dtstart:20261117T180000Z", "summary:Tuesday Review", "rrule:freq=daily;count=2",
  "end:vevent", "end:vcalendar",
].join("\r\n");
const calendar = parseCalendar(text, new Date("2026-11-17T00:00:00Z"));
assert.deepEqual(calendar.events.map(({ id, start, title }) => [id, start, title]), [
  ["CaseSensitive", "2026-11-17T18:00:00.000Z", "Tuesday Review"],
  ["CaseSensitive", "2026-11-18T18:00:00.000Z", "Tuesday Review"],
]);
console.log("Case-insensitive calendar import preserves user text and recurrence.");
