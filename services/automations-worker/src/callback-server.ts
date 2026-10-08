import { createServer } from "node:http";
import { Connection, Client } from "@temporalio/client";
import { google } from "googleapis";
import { oauthClient, saveTokens } from "./google-oauth.js";

// Tiny node:http server. Two concerns, same port:
//   POST /callback/approval          — Slack button click dispatched by CC
//   GET  /auth/google/{start,callback} — one-time Google OAuth consent
// ponytail: no framework yet. Four routes is still fine on a switch.

interface Callback {
  workflowId: string;
  actionId: string;
  decision: "approved" | "rejected";
  approverSlackId: string;
  messageRef: { channel: string; ts: string };
  orgId: string;
}

export async function startCallbackServer(): Promise<void> {
  const port = Number(process.env.WORKER_CALLBACK_PORT ?? 3005);
  const token = process.env.WORKER_CALLBACK_TOKEN;
  if (!token) throw new Error("WORKER_CALLBACK_TOKEN must be set");

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "personal";
  const connection = await Connection.connect({ address });
  const temporal = new Client({ connection, namespace });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // ─── Approval callback (CC → worker, bearer-authed) ───────────────────
    if (req.method === "POST" && url.pathname === "/callback/approval") {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${token}`) return void res.writeHead(401).end();
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const payload = JSON.parse(body) as Callback;
        const handle = temporal.workflow.getHandle(payload.workflowId);
        await handle.executeUpdate("submitApproval", {
          args: [{
            actionId: payload.actionId,
            decision: payload.decision,
            approverSlackId: payload.approverSlackId,
            messageRef: payload.messageRef,
          }],
        });
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("callback error", err);
        res.writeHead(400, { "Content-Type": "application/json" }).end(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
        );
      }
      return;
    }

    // ─── Google OAuth: start → redirect browser to Google consent ────────
    if (req.method === "GET" && url.pathname === "/auth/google/start") {
      const email = url.searchParams.get("email");
      if (!email) return void res.writeHead(400).end("missing ?email=");
      const client = oauthClient();
      const authUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/tasks",
        ],
        login_hint: email,
        state: email,
      });
      res.writeHead(302, { Location: authUrl }).end();
      return;
    }

    // ─── Google OAuth: callback → exchange + persist ─────────────────────
    if (req.method === "GET" && url.pathname === "/auth/google/callback") {
      const code = url.searchParams.get("code");
      const email = url.searchParams.get("state"); // we stuffed email into state
      if (!code || !email) return void res.writeHead(400).end("missing code or state");
      try {
        const client = oauthClient();
        const { tokens } = await client.getToken(code);
        if (!tokens.refresh_token) {
          res.writeHead(400).end("no refresh_token returned — revoke prior grants in your Google account settings and retry");
          return;
        }
        await saveTokens(email, {
          access_token: tokens.access_token!,
          refresh_token: tokens.refresh_token,
          expiry_date: tokens.expiry_date ?? Date.now() + 3600 * 1000,
          scope: tokens.scope,
        });
        // Verify + show which account landed.
        const verify = new google.auth.OAuth2();
        verify.setCredentials({ access_token: tokens.access_token });
        const profile = await google.gmail({ version: "v1", auth: verify }).users.getProfile({ userId: "me" });
        res.writeHead(200, { "Content-Type": "text/html" }).end(
          `<!doctype html><meta charset="utf-8"><title>Authorized</title>
          <body style="font-family:system-ui;padding:40px;max-width:520px;margin:auto">
            <h2>✅ Authorized ${profile.data.emailAddress}</h2>
            <p>Tokens stored. You can close this tab.</p>
          </body>`
        );
      } catch (err) {
        console.error("google oauth exchange failed", err);
        res.writeHead(500).end(`exchange failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`callback server listening on :${port}`);
}
