// Slack mrkdwn → plain text for in-app display. Notification text is written
// for Slack (worker side), so the web strips its markup instead of showing
// raw *bold*, _italic_, <@U123> mentions and <url|label> links.
export function slackToText(s: string): string {
  return s
    .replace(/ by <@[A-Z0-9]+>/g, " in Slack")          // "Rejected by <@U…>" → "Rejected in Slack"
    .replace(/<@[A-Z0-9]+>/g, "a Slack user")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")      // <url|label> → label
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s).,:!?])/gm, "$1$2") // Slack: markers hug non-space text
    .replace(/(^|[\s(])_(\S(?:[^_\n]*\S)?)_(?=$|[\s).,:!?])/gm, "$1$2");
}

export function firstLine(text: string, fallback = "Notification"): string {
  return slackToText(text).split("\n").find((l) => l.trim())?.trim() ?? fallback;
}
