import { expect, test } from "bun:test";
import { firstLine, slackToText } from "./slack-text";
test("slack text", () => {
  expect(firstLine("📅 *Interview coming up — in 1h 59m*")).toBe("📅 Interview coming up — in 1h 59m");
  expect(firstLine("❌ Rejected by <@U0BSQM7ACHH> — nothing moved.")).toBe("❌ Rejected in Slack — nothing moved.");
  expect(slackToText("*LinkedIn headline:*\n_Senior Backend Engineer_")).toBe("LinkedIn headline:\nSenior Backend Engineer");
  expect(slackToText("see <https://x.io/a_b|the post> and snake_case_name")).toBe("see the post and snake_case_name");
  expect(slackToText("2 * 3 * 4")).toBe("2 * 3 * 4");
});
