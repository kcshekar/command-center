import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMeetingPrep, matchSession } from "./meeting-prep.js";

test("N13: session match, link vs location, attendee overflow, related notes", () => {
  const sessions = [{ company: "Teradata", role: "Principal Engineer" }, { company: "HP", role: "SDE" }];
  assert.deepEqual(matchSession("Teradata · system design round", sessions), sessions[0]);
  assert.equal(matchSession("Chapter review", sessions), null); // "HP" too short to match inside words
  const text = formatMeetingPrep(
    {
      id: "e1", summary: "Teradata · system design round", start: "2026-10-27T10:30:00+05:30",
      attendees: ["Alex Chen", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com", "g@x.com"],
      link: "https://meet.google.com/abc", location: "Room 4",
    },
    { notes: [{ title: "Teradata prep notes", type: "prep", createdOn: "2026-10-25" }], session: sessions[0] },
  );
  assert.match(text, /^\*Up next at 10:30 am: Teradata · system design round\*/);
  assert.match(text, /With: Alex Chen, b@x\.com, c@x\.com, d@x\.com, e@x\.com, f@x\.com \+1 more/);
  assert.match(text, /Join: https:\/\/meet\.google\.com\/abc/);
  assert.doesNotMatch(text, /Where:/);
  assert.match(text, /Interview: Teradata · Principal Engineer/);
  assert.match(text, /• Teradata prep notes \(prep, 2026-10-25\)/);
  const bare = formatMeetingPrep({ id: "e2", summary: "1:1", start: "2026-10-27T15:00:00+05:30", attendees: ["Ravi"], link: null, location: "Cafe" }, { notes: [], session: null });
  assert.equal(bare, "*Up next at 03:00 pm: 1:1*\nWith: Ravi\nWhere: Cafe");
});
