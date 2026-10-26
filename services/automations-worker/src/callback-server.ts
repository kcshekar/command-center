import { createServer } from "node:http";
import { Connection, Client } from "@temporalio/client";
import { google } from "googleapis";
import { oauthClient, saveTokens } from "./google-oauth.js";
import { pool } from "./db.js";
import { evictIdentityCache, evictTokenCache } from "./cc-token-store.js";

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
        const payload = JSON.parse(body) as Callback & { updateName?: string };
        const handle = temporal.workflow.getHandle(payload.workflowId);
        // Each approval card carries its workflow's update name on the
        // button value. Fall back to "submitApproval" for the existing
        // triage trash flow that predates this field.
        const updateName = payload.updateName ?? "submitApproval";
        await handle.executeUpdate(updateName, {
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

    // ─── Rotate worker identity (CC → worker, bearer-authed) ─────────────
    // CC's rotate button pushes the new client_secret here so the operator
    // never has to SSH. Reuses WORKER_CALLBACK_TOKEN — localhost-only in
    // normal deploy (nginx doesn't proxy /admin/* to the worker).
    if (req.method === "POST" && url.pathname === "/admin/worker-identity") {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${token}`) return void res.writeHead(401).end();
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const { client_id, client_secret, cc_base_url } = JSON.parse(body) as {
          client_id?: string;
          client_secret?: string;
          cc_base_url?: string;
        };
        if (!client_id || !client_secret) throw new Error("client_id and client_secret are required");
        // Resolve cc_base_url: use what was passed; else keep the existing
        // row's value (rotation path); else fall back to env; else default.
        // NOT NULL on the column is checked before ON CONFLICT, so a bare
        // null here would 500 even when the row exists.
        const existing = await pool.query(`SELECT cc_base_url FROM worker_identity WHERE id = 1`);
        const resolvedBase =
          cc_base_url ??
          existing.rows[0]?.cc_base_url ??
          process.env.CC_BASE_URL ??
          "http://localhost:3011";
        await pool.query(
          `INSERT INTO worker_identity (id, client_id, client_secret, cc_base_url, updated_at)
           VALUES (1, $1, $2, $3, now())
           ON CONFLICT (id) DO UPDATE SET
             client_id = EXCLUDED.client_id,
             client_secret = EXCLUDED.client_secret,
             cc_base_url = EXCLUDED.cc_base_url,
             updated_at = now()`,
          [client_id, client_secret, resolvedBase]
        );
        // Flush caches so the next mint uses the new secret immediately.
        evictIdentityCache();
        evictTokenCache();
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("worker-identity rotate error", err);
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
        );
      }
      return;
    }

    // ─── GitHub OAuth: start → redirect browser to GitHub consent ───────
    if (req.method === "GET" && url.pathname === "/auth/github/start") {
      const ccUserId = url.searchParams.get("ccUserId");
      if (!ccUserId) return void res.writeHead(400).end("missing ?ccUserId=");
      try {
        const { githubAuthUrl } = await import("./github-oauth.js");
        res.writeHead(302, { Location: githubAuthUrl(ccUserId) }).end();
      } catch (err) {
        res.writeHead(500).end(`github start failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // ─── GitHub OAuth: callback → exchange + persist + close popup ──────
    if (req.method === "GET" && url.pathname === "/auth/github/callback") {
      const code = url.searchParams.get("code");
      const ccUserId = url.searchParams.get("state");
      if (!code || !ccUserId) return void res.writeHead(400).end("missing code or state");
      try {
        const { githubExchange, saveGithubTokens } = await import("./github-oauth.js");
        const cred = await githubExchange(code);
        await saveGithubTokens(cred.login, ccUserId, cred);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
          `<!doctype html><meta charset="utf-8"><title>GitHub Connected</title>
          <body style="font-family:system-ui;padding:40px;max-width:520px;margin:auto">
            <h2>✅ Connected GitHub: ${cred.login}</h2>
            <p id="status">Tokens stored. Closing…</p>
            <script>
              (function () {
                try {
                  if (window.opener && !window.opener.closed) {
                    window.opener.postMessage(
                      { type: "cc-github-oauth-complete", login: ${JSON.stringify(cred.login)} },
                      "*"
                    );
                  }
                } catch (e) {}
                setTimeout(function () { window.close(); }, 400);
              })();
            </script>
          </body>`
        );
      } catch (err) {
        console.error("github oauth exchange failed", err);
        res.writeHead(500).end(`exchange failed: ${err instanceof Error ? err.message : String(err)}`);
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
        // Signal the opener (Connected Accounts panel) so it can refresh the
        // list, then auto-close. Falls back to a manual-close message when
        // the tab was opened directly (no opener, or opener on a different
        // origin that blocks postMessage).
        const emailAddr = profile.data.emailAddress ?? "";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
          `<!doctype html><meta charset="utf-8"><title>Authorized</title>
          <body style="font-family:system-ui;padding:40px;max-width:520px;margin:auto">
            <h2>✅ Authorized ${emailAddr}</h2>
            <p id="status">Tokens stored. Closing this tab…</p>
            <script>
              (function () {
                try {
                  if (window.opener && !window.opener.closed) {
                    window.opener.postMessage(
                      { type: "cc-google-oauth-complete", email: ${JSON.stringify(emailAddr)} },
                      "*"
                    );
                  }
                } catch (e) { /* cross-origin: ignore */ }
                setTimeout(function () {
                  window.close();
                  var s = document.getElementById("status");
                  if (s) s.textContent = "Tokens stored. You can close this tab.";
                }, 400);
              })();
            </script>
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
