import { expect, test } from "bun:test";
import { generateServiceToken, hashToken } from "./service-token";

test("generates a raw token with the cc_st_ prefix and a matching sha256 hash", () => {
  const { raw, hash, prefix } = generateServiceToken();
  expect(raw).toMatch(/^cc_st_[0-9a-f]{64}$/);
  expect(prefix).toBe(raw.slice(0, 12));
  expect(hash).toBe(hashToken(raw));
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
});

test("hashToken is deterministic", () => {
  expect(hashToken("cc_st_deadbeef")).toBe(hashToken("cc_st_deadbeef"));
});
