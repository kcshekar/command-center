import { test, expect } from "bun:test";
import { numberToWords, amountInWords } from "./number-to-words";

test("numberToWords handles the invoice-template example", () => {
  expect(numberToWords(2165)).toBe("two thousand one hundred sixty-five");
});

test("numberToWords handles zero, teens, and round thousands", () => {
  expect(numberToWords(0)).toBe("zero");
  expect(numberToWords(15)).toBe("fifteen");
  expect(numberToWords(1000)).toBe("one thousand");
  expect(numberToWords(100000)).toBe("one hundred thousand");
});

test("amountInWords capitalizes and appends currency", () => {
  expect(amountInWords(216500, "EUR")).toBe("Two thousand one hundred sixty-five euros only (EUR)");
  expect(amountInWords(50000, "USD")).toBe("Five hundred dollars only (USD)");
});
