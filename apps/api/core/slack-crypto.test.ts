import { expect, test } from "bun:test";
// Must be set BEFORE the module imports — slack-crypto reads it at call time
// but requires a non-empty value; setting here keeps the test self-contained.
process.env.SLACK_ENCRYPTION_SECRET ??= "test-slack-kek-do-not-use-in-prod";
import { encryptSlackToken, decryptSlackToken, maskToken } from "./slack-crypto";

test("encrypts and decrypts slack tokens accurately", () => {
  const token = "xoxb-1234567890-9876543210-abcdefghijklmnop";
  const { ciphertext, iv } = encryptSlackToken(token);
  expect(ciphertext).not.toEqual(Buffer.from(token));
  const decrypted = decryptSlackToken(ciphertext, iv);
  expect(decrypted).toBe(token);
});

test("masks slack tokens for API display", () => {
  expect(maskToken("xoxb-1234567890123456789")).toBe("xoxb-123...6789");
  expect(maskToken("short")).toBe("********");
});
