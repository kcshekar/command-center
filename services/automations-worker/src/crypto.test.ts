import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyOAuthState } from "./crypto.js";

// Mirrors CC's GET /api/integrations/oauth-state signer.
function sign(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

test("oauth state: accepts CC-signed, rejects forged / expired / missing", () => {
  process.env.WORKER_CALLBACK_TOKEN = "test-secret";
  const good = sign({ u: "user-1", o: "org-1", exp: Date.now() + 60_000 }, "test-secret");
  assert.deepEqual(verifyOAuthState(good), { ccUserId: "user-1", orgId: "org-1" });

  assert.equal(verifyOAuthState(sign({ u: "user-1", o: "org-1", exp: Date.now() + 60_000 }, "wrong")), null);
  assert.equal(verifyOAuthState(sign({ u: "user-1", o: "org-1", exp: Date.now() - 1 }, "test-secret")), null);
  assert.equal(verifyOAuthState("victim@gmail.com"), null); // the old raw-email state
  assert.equal(verifyOAuthState(null), null);

  // Tampered payload with the original signature.
  const [, sig] = good.split(".");
  const forgedBody = Buffer.from(JSON.stringify({ u: "attacker", o: "org-1", exp: Date.now() + 60_000 })).toString("base64url");
  assert.equal(verifyOAuthState(`${forgedBody}.${sig}`), null);
});
