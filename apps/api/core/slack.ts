// Native fetch against Slack's Web API — no SDK needed for one endpoint call.
export async function sendSlackMessage(text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) {
    throw new Error("Slack not configured (SLACK_BOT_TOKEN / SLACK_CHANNEL_ID missing)");
  }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
}
