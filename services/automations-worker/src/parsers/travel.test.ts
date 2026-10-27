import { test } from "node:test";
import assert from "node:assert/strict";
import { isTravelBooking } from "./travel.js";

const m = (from: string, subject: string, snippet = "") => ({ from, subject, snippet });

test("R14: confirmed bookings in, deals / reminders / receipts / unrelated mail out", () => {
  assert.equal(isTravelBooking(m("IRCTC <ticketadmin@irctc.co.in>", "Booking Confirmation on IRCTC, Train: 12723", "PNR No : 4521367890 Train Name: TELANGANA EXP")), true);
  assert.equal(isTravelBooking(m("IndiGo <reservations@customer.goindigo.in>", "Your IndiGo Itinerary - ABC12D", "Thank you for booking. Booking reference ABC12D, HYD-BLR 6E 6123")), true);
  assert.equal(isTravelBooking(m("Booking.com <noreply@booking.com>", "Your booking is confirmed at Taj Krishna", "Booking number 4123.567.890 Check-in Friday")), true);
  assert.equal(isTravelBooking(m("Some Agent <agent@travelco.in>", "Tickets", "Your PNR is 8XK2LM for the 6 Nov flight")), true); // unknown sender, but PNR

  assert.equal(isTravelBooking(m("MakeMyTrip <deals@makemytrip.com>", "Flash sale! Flights from ₹1,999", "Book now, offer ends tonight")), false);
  assert.equal(isTravelBooking(m("Goibibo <noreply@goibibo.com>", "Complete your booking to Goa", "Your itinerary is waiting")), false);
  assert.equal(isTravelBooking(m("Uber Receipts <noreply@uber.com>", "Your Tuesday morning trip with Uber", "Total ₹243. Booking ID 123")), false);
  assert.equal(isTravelBooking(m("IndiGo <reservations@customer.goindigo.in>", "Refund processed for booking ABC12D", "Booking reference ABC12D")), false);
  assert.equal(isTravelBooking(m("eChai <hello@echai.ventures>", "📅 Just scheduled: eChai Startup Demo Day in Hyderabad", "")), false);
  assert.equal(isTravelBooking(m("HDFC Bank <alerts@hdfcbank.net>", "Transaction alert", "Rs.4500 spent at MAKEMYTRIP")), false);
});
