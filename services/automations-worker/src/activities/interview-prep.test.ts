import { test } from "node:test";
import assert from "node:assert/strict";
import { verifiedBullets } from "./interview-prep.js";

test("research keeps only bullets whose source tool actually returned results", () => {
  const text = "Here you go:\n* [web] HQ in Sunnyvale\n* [notes] Asked about SQL last time\n* untagged guess";
  const unavailable = [{ tool: "web_search", result: "Web search unavailable (no SerpAPI key)." }, { tool: "search_knowledge", result: "- Teradata loop (prep): SQL round" }];
  assert.equal(verifiedBullets(text, unavailable), "* [notes] Asked about SQL last time");
  assert.equal(verifiedBullets(text, []), "");
  assert.equal(verifiedBullets(text, [{ tool: "web_search", result: "- Teradata: ..." }]), "* [web] HQ in Sunnyvale");
});
