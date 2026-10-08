import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { pool } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";

function oauthClient(): OAuth2Client {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error("GOOGLE_CLIENT_ID/SECRET must be set");
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

// Loads stored tokens, decrypts, and hands back an OAuth2 client with
// automatic refresh already configured. googleapis persists refreshed
// access tokens back through the `tokens` event — we save them.
export async function getAuthClient(userEmail: string): Promise<OAuth2Client> {
  const { rows } = await pool.query(
    `SELECT encrypted_access_token, access_token_iv,
            encrypted_refresh_token, refresh_token_iv, token_expiry
       FROM google_oauth_tokens WHERE user_email = $1`,
    [userEmail]
  );
  if (rows.length === 0) throw new Error(`no stored Google tokens for ${userEmail}. Run 'npm run google:auth' first.`);
  const row = rows[0];

  const client = oauthClient();
  client.setCredentials({
    access_token: decrypt(row.encrypted_access_token, row.access_token_iv),
    refresh_token: decrypt(row.encrypted_refresh_token, row.refresh_token_iv),
    expiry_date: new Date(row.token_expiry).getTime(),
  });

  client.on("tokens", (tokens) => {
    // Fired after a refresh; persist the new access token asynchronously.
    // refresh_token only reappears when Google rotates it (rare).
    if (tokens.access_token) {
      void saveTokens(userEmail, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? decrypt(row.encrypted_refresh_token, row.refresh_token_iv),
        expiry_date: tokens.expiry_date ?? Date.now() + 3600 * 1000,
        scope: tokens.scope,
      });
    }
  });

  return client;
}

export async function saveTokens(
  userEmail: string,
  tokens: { access_token: string; refresh_token: string; expiry_date: number; scope?: string | null }
) {
  const accessEnc = encrypt(tokens.access_token);
  const refreshEnc = encrypt(tokens.refresh_token);
  const scopes = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [];
  await pool.query(
    `INSERT INTO google_oauth_tokens
       (user_email, encrypted_access_token, access_token_iv,
        encrypted_refresh_token, refresh_token_iv, token_expiry, scopes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_email) DO UPDATE SET
       encrypted_access_token = EXCLUDED.encrypted_access_token,
       access_token_iv        = EXCLUDED.access_token_iv,
       encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
       refresh_token_iv        = EXCLUDED.refresh_token_iv,
       token_expiry            = EXCLUDED.token_expiry,
       scopes                  = EXCLUDED.scopes,
       updated_at              = now()`,
    [userEmail, accessEnc.ciphertext, accessEnc.iv, refreshEnc.ciphertext, refreshEnc.iv, new Date(tokens.expiry_date), scopes]
  );
}

// Called by activities to build the freshly-authed google service clients.
export async function gmailClient(userEmail: string) {
  return google.gmail({ version: "v1", auth: await getAuthClient(userEmail) });
}
export async function calendarClient(userEmail: string) {
  return google.calendar({ version: "v3", auth: await getAuthClient(userEmail) });
}
export async function tasksClient(userEmail: string) {
  return google.tasks({ version: "v1", auth: await getAuthClient(userEmail) });
}

export { oauthClient };
