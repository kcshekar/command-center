import { test, expect } from "bun:test";
import { evalAmountExpression, resolveAmountInput } from "./calc";

test("evalAmountExpression computes simple arithmetic", () => {
  expect(evalAmountExpression("1200+350-40")).toBe(1510);
  expect(evalAmountExpression("10 * 3")).toBe(30);
  expect(evalAmountExpression("(2+3)*4")).toBe(20);
});

test("evalAmountExpression rejects anything outside the digit/operator whitelist", () => {
  expect(evalAmountExpression("process.exit()")).toBeNull();
  expect(evalAmountExpression("1+1; alert(1)")).toBeNull();
  expect(evalAmountExpression("`${1}`")).toBeNull();
  expect(evalAmountExpression("1+a")).toBeNull();
});

test("evalAmountExpression rejects empty or malformed input", () => {
  expect(evalAmountExpression("")).toBeNull();
  expect(evalAmountExpression("   ")).toBeNull();
  expect(evalAmountExpression("+*/")).toBeNull();
  expect(evalAmountExpression("1/0")).toBeNull(); // Infinity is not finite
});

test("resolveAmountInput resolves valid expressions and rounds to cents", () => {
  expect(resolveAmountInput("1200+350-40")).toBe("1510");
  expect(resolveAmountInput("10/3")).toBe("3.33");
});

test("resolveAmountInput returns the raw input unchanged when not resolvable", () => {
  expect(resolveAmountInput("500")).toBe("500");
  expect(resolveAmountInput("abc")).toBe("abc");
  expect(resolveAmountInput("12+")).toBe("12+");
});
