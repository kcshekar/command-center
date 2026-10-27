// R14 — is this email a CONFIRMED travel booking? Deterministic on purpose:
// adding a category to the local LLM classifier shifted unrelated emails
// (tested 2026-10-27 on 15 real messages: 2 of 15 moved, 1 for the worse), so
// bookings are recognised here and never reach the classifier — which also
// means a booking can never be proposed for trash as "promotional".
// Pure (no I/O): safe to call from workflow code.

const TRAVEL_SENDERS = /(irctc|makemytrip|goibibo|cleartrip|yatra|ixigo|redbus|abhibus|easemytrip|booking\.com|agoda|airbnb|oyo|expedia|indigo|goindigo|airindia|air india|vistara|akasaairline|akasa air|spicejet|airasia|emirates|qatarairways|lufthansa|singaporeair|britishairways|uber|rapido)/i;
const CONFIRMED = /\b(pnr|e-?ticket|booking (id|ref(erence)?|no\.?|number|confirmed|confirmation)|reservation (confirmed|number)|itinerary|your (trip|flight|stay|journey) (is|has been) (booked|confirmed)|check-?in (date|time)|boarding pass)\b/i;
const NOT_A_BOOKING = /\b(sale|offer|% off|discount|deal|cashback|fare alert|price drop|complete your booking|still thinking|abandon|recommend|newsletter|refund (processed|initiated)|cancel(l)?ation)\b/i;

export function isTravelBooking(email: { from: string; subject: string; snippet: string }): boolean {
  const text = `${email.subject} ${email.snippet}`;
  if (NOT_A_BOOKING.test(text)) return false;
  // Ride receipts (Uber/Rapido) are expenses, not trips.
  if (/(uber|rapido)/i.test(email.from) && !/\bpnr\b/i.test(text)) return false;
  return CONFIRMED.test(text) && (TRAVEL_SENDERS.test(email.from) || /\bpnr\b/i.test(text));
}
