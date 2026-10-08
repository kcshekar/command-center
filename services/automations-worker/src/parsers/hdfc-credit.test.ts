import { test } from "node:test";
import assert from "node:assert/strict";
import { hdfcCreditParser } from "./hdfc-credit.js";

test("hdfc-credit: parses a netflix alert into integer paise", () => {
  const parsed = hdfcCreditParser.parse({
    from: "alerts@hdfcbank.net",
    subject: "You've used your HDFC Bank Card",
    snippet: "Rs. 1,499.00 spent on HDFC Bank Card XX1234 at NETFLIX on 2026-09-25",
  });
  assert.deepEqual(parsed, {
    amountCents: 149900,
    currency: "INR",
    accountName: "HDFC Credit Card XX1234",
    category: "subscription",
    occurredOn: "2026-09-25",
  });
});

test("hdfc-credit: matches sender + keyword", () => {
  assert.equal(
    hdfcCreditParser.matches({ from: "alerts@hdfcbank.net", subject: "HDFC Bank Card txn", snippet: "" }),
    true
  );
  assert.equal(
    hdfcCreditParser.matches({ from: "no-reply@icicibank.com", subject: "ICICI Debit", snippet: "" }),
    false
  );
});

test("hdfc-credit: preserves paise on odd amounts", () => {
  const parsed = hdfcCreditParser.parse({
    from: "alerts@hdfcbank.net",
    subject: "HDFC Bank Card",
    snippet: "Rs. 42.75 spent on HDFC Bank Card XX9999 at SWIGGY on 2026-09-10",
  });
  assert.equal(parsed?.amountCents, 4275);
  assert.equal(parsed?.category, "food");
});

test("hdfc-credit: returns null on non-match", () => {
  const parsed = hdfcCreditParser.parse({
    from: "alerts@hdfcbank.net",
    subject: "Statement generated",
    snippet: "Your monthly statement is ready.",
  });
  assert.equal(parsed, null);
});
