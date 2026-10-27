import { expect, test } from "bun:test";
import { categoryFor, parseUpiDebit } from "./upi-sms";

// Shapes of real bank SMS (numbers changed).
test("parseUpiDebit reads the common bank formats", () => {
  expect(parseUpiDebit("Sent Rs.450.00 From HDFC Bank A/C *1234 To SWIGGY On 27/10/26 Ref 612345678901 Not You? Call 18002586161/SMS BLOCK UPI to 7308080808"))
    .toEqual({ amountPaise: 45000, merchant: "SWIGGY", account: "1234", ref: "612345678901" });
  expect(parseUpiDebit("Dear UPI user A/C X5678 debited by 1250.0 on date 27Oct26 trf to UBER INDIA Refno 612345678902. If not u? call 1800111109. -SBI"))
    .toEqual({ amountPaise: 125000, merchant: "UBER INDIA", account: "5678", ref: "612345678902" });
  expect(parseUpiDebit("ICICI Bank Acct XX123 debited for Rs 2,499.00 on 27-Oct-26; AMAZON PAY credited. UPI:612345678903. Call 18002662 for dispute. SMS BLOCK 123 to 9215676766."))
    .toEqual({ amountPaise: 249900, merchant: "AMAZON PAY", account: "123", ref: "612345678903" });
  expect(parseUpiDebit("INR 300.00 debited A/c no. XX9012 27-10-26, 10:15:01 UPI/P2M/612345678904/BLINKIT Not you? SMS BLOCKUPI Cust ID to 919951860002 Axis Bank"))
    .toEqual({ amountPaise: 30000, merchant: "BLINKIT", account: "9012", ref: "612345678904" });
  expect(parseUpiDebit("Sent Rs.120.00 from Kotak Bank AC X3456 to zomato@hdfcbank on 27-10-26.UPI Ref 612345678905. Not you, https://kotak.com/KBANKT/Fraud"))
    .toEqual({ amountPaise: 12000, merchant: "zomato@hdfcbank", account: "3456", ref: "612345678905" });
});

test("parseUpiDebit ignores credits, OTPs and upcoming debits", () => {
  expect(parseUpiDebit("Rs.5000.00 credited to A/c XX1234 by VPA abc@okhdfc. Received from ABC. UPI Ref 612345678906")).toBeNull();
  expect(parseUpiDebit("123456 is your OTP for a transaction of Rs.450 at SWIGGY. Do not share.")).toBeNull();
  expect(parseUpiDebit("Rs.649 will be debited on 30/10 for your Netflix autopay mandate")).toBeNull();
  expect(parseUpiDebit("Hello, lunch tomorrow?")).toBeNull();
});

test("categoryFor maps obvious merchants, defaults to other", () => {
  expect(categoryFor("SWIGGY")).toBe("food");
  expect(categoryFor("zomato@hdfcbank")).toBe("food");
  expect(categoryFor("BLINKIT")).toBe("groceries");
  expect(categoryFor("UBER INDIA")).toBe("travel");
  expect(categoryFor("RAMESH KUMAR")).toBe("other");
  expect(categoryFor(null)).toBe("other");
});
