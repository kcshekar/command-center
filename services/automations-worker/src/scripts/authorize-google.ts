import { createServer } from "node:http";
import { google } from "googleapis";
import { pool } from "../db.js";
import { oauthClient, saveTokens } from "../google-oauth.js";

// One-time CLI: run once per Google account. Opens a loopback HTTP server,
// prints the auth URL, catches the redirect, exchanges the code, stores the
// refresh token. `access_type: "offline"` + `prompt: "consent"` is what
// guarantees Google returns a refresh_token (otherwise it only issues one on
// the very first grant per client — repeat runs would silently get none).
// ponytail: no web UI, no multi-user flow. Add if a second Google account
// ever needs to be authed by someone other than the operator.

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("usage: npm run google:auth -- <user@gmail.com>");
    process.exit(1);
  }

  const client = oauthClient();
  const scopes = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/tasks",
  ];
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    login_hint: email,
  });

  const redirect = new URL(process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:53682/oauth2/callback");
  const port = Number(redirect.port);

  console.log(`\nOpen this URL in your browser:\n\n${url}\n`);

  const code: string = await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", `http://localhost:${port}`);
      const c = u.searchParams.get("code");
      if (!c) {
        res.writeHead(400).end("no code");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end("<h2>Authorized. You can close this tab.</h2>");
      server.close();
      resolve(c);
    });
    server.on("error", reject);
    server.listen(port);
  });

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("no refresh_token returned — revoke prior grants in Google account settings and retry");
  }

  await saveTokens(email, {
    access_token: tokens.access_token!,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date ?? Date.now() + 3600 * 1000,
    scope: tokens.scope,
  });

  // Verify by hitting Gmail profile once.
  const testAuth = new google.auth.OAuth2();
  testAuth.setCredentials({ access_token: tokens.access_token });
  const profile = await google.gmail({ version: "v1", auth: testAuth }).users.getProfile({ userId: "me" });
  console.log(`\nauthorized ${profile.data.emailAddress}. tokens stored.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
