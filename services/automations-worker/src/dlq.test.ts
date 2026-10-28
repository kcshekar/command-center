import { test } from "node:test";
import assert from "node:assert/strict";
import { externalErrorCode } from "./dlq.js";

test("only transient external failures are dead-lettered", () => {
  assert.equal(externalErrorCode(new Error("adzuna 429: slow down")), "ADZUNA_429");
  assert.equal(externalErrorCode(new Error("serpapi 503: unavailable")), "SERPAPI_503");
  assert.equal(externalErrorCode(new Error("github 500")), "GITHUB_500");
  assert.equal(externalErrorCode(new TypeError("fetch failed")), "NETWORK");
  assert.equal(externalErrorCode(Object.assign(new Error("t/o"), { name: "TimeoutError" })), "NETWORK");
  assert.equal(externalErrorCode(new Error("adzuna 401: bad key")), null); // config problem, retry won't help
  assert.equal(externalErrorCode(new Error("jsearch 404: nope")), null);
  assert.equal(externalErrorCode(new SyntaxError("Unexpected token")), null);
});
