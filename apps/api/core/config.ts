// Fail fast on missing required config, with one clear message naming every
// gap at once — instead of the app booting fine and then failing confusingly
// on the first query/session that touches the unset variable. Optional
// integrations (SMTP, Slack, GCS, Ollama, Chrome) are intentionally NOT
// checked here — each already reports its own clear "not configured" error
// at the point of use, so a deployment without e.g. Slack still runs.
const REQUIRED = ["APP_DATABASE_URL", "REDIS_URL", "SESSION_SECRET"] as const;

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
}

if (process.env.SESSION_SECRET === "change-me" && process.env.NODE_ENV === "production") {
  throw new Error("SESSION_SECRET is still the placeholder value — set a real secret before running in production");
}
