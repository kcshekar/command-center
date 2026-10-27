import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTripPack, maskReference } from "./travel.js";

test("R14: reference masked, flights vs hotels, nothing when no trips", () => {
  assert.equal(maskReference("ABC12D"), "••••2D");
  assert.equal(maskReference("4521367890"), "••••90");
  assert.equal(maskReference(null), null);
  const text = formatTripPack([
    { kind: "flight", provider: "IndiGo", reference: "ABC12D", from: "Hyderabad", to: "Bengaluru", departAt: "2026-11-06T07:15:00+05:30", endAt: "2026-11-06T08:30:00+05:30" },
    { kind: "hotel", provider: "Taj", reference: null, from: null, to: "Taj MG Road, Bengaluru", departAt: "2026-11-06T14:00:00+05:30", endAt: null },
  ])!;
  assert.match(text, /\*Flight: Hyderabad → Bengaluru\*\nDeparts Fri, 6 Nov, 07:15 am · arrives Fri, 6 Nov, 08:30 am\nIndiGo · ref ••••2D \(full on the Trips page\)/);
  assert.match(text, /\*Hotel: Taj MG Road, Bengaluru\*\nCheck-in Fri, 6 Nov, 02:00 pm\nTaj$/m);
  assert.doesNotMatch(text, /ABC12D/);
  assert.equal(formatTripPack([]), null);
});
