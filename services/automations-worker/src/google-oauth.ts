import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { pool } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";
import { cc } from "./cc-client.js";

// Generic credential storage. Google is one `service` among many; the schema
// supports github, slack-user-tokens, notion, etc. without new tables.
export interface Credential {
  accessToken: string;
  refreshToken: string | null;
  expiryDate: number | null;
  scopes: string[];
  metadata: Record<string, unknown>;
}

export async function getCredentials(
  service: string,
  userId: string,
  label = "primary"
): Promise<Credential> {
  const { rows } = await pool.query(
    `SELECT encrypted_access_token, access_token_iv,
            encrypted_refresh_token, refresh_token_iv,
            token_expiry, scopes, metadata
       FROM external_credentials
      WHERE service = $1 AND user_id = $2 AND label = $3`,
    [service, userId, label]
  );
  if (rows.length === 0) {
    throw new Error(`no stored ${service} credentials for ${userId} (${label})`);
  }
  const r = rows[0];
  return {
    accessToken: decrypt(r.encrypted_access_token, r.access_token_iv),
    refreshToken: r.encrypted_refresh_token
      ? decrypt(r.encrypted_refresh_token, r.refresh_token_iv)
      : null,
    expiryDate: r.token_expiry ? new Date(r.token_expiry).getTime() : null,
    scopes: r.scopes ?? [],
    metadata: r.metadata ?? {},
  };
}

export async function saveCredentials(
  service: string,
  userId: string,
  cred: { accessToken: string; refreshToken?: string | null; expiryDate?: number | null; scopes?: string[]; metadata?: Record<string, unknown>; label?: string }
): Promise<void> {
  const label = cred.label ?? "primary";
  const accessEnc = encrypt(cred.accessToken);
  const refreshEnc = cred.refreshToken ? encrypt(cred.refreshToken) : null;
  const scopes = cred.scopes ?? [];
  await pool.query(
    `INSERT INTO external_credentials
       (service, user_id, label,
        encrypted_access_token, access_token_iv,
        encrypted_refresh_token, refresh_token_iv,
        token_expiry, scopes, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (service, user_id, label) DO UPDATE SET
       encrypted_access_token  = EXCLUDED.encrypted_access_token,
       access_token_iv         = EXCLUDED.access_token_iv,
       encrypted_refresh_token = COALESCE(EXCLUDED.encrypted_refresh_token, external_credentials.encrypted_refresh_token),
       refresh_token_iv        = COALESCE(EXCLUDED.refresh_token_iv,        external_credentials.refresh_token_iv),
       token_expiry            = EXCLUDED.token_expiry,
       scopes                  = EXCLUDED.scopes,
       metadata                = external_credentials.metadata || EXCLUDED.metadata,
       updated_at              = now()`,
    [
      service, userId, label,
      accessEnc.ciphertext, accessEnc.iv,
      refreshEnc?.ciphertext ?? null, refreshEnc?.iv ?? null,
      cred.expiryDate ? new Date(cred.expiryDate) : null,
      scopes, cred.metadata ?? {},
    ]
  );

  // Mirror metadata to CC so the UI can list connected accounts without
  // reaching the worker's HTTP server. Non-blocking.
  void cc
    .upsertExternalAccount({
      service,
      userId,
      label,
      scopes,
      status: "active",
      lastRefreshedAt: new Date().toISOString(),
      metadata: cred.metadata ?? {},
    })
    .catch((err) => console.error(`external_account mirror upsert failed (${service}/${userId}):`, err?.message ?? err));
}

// ─── Google-specific wrappers (keep so activities don't need to change) ─────

function oauthClient(): OAuth2Client {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error("GOOGLE_CLIENT_ID/SECRET must be set");
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

// Loads stored tokens, decrypts, and hands back an OAuth2 client with
// automatic refresh already configured. googleapis persists refreshed
// access tokens back through the `tokens` event — we save them.
export async function getAuthClient(userEmail: string): Promise<OAuth2Client> {
  const cred = await getCredentials("google", userEmail);
  if (!cred.refreshToken) {
    throw new Error(`google credential for ${userEmail} has no refresh token — re-authorize via /agent-automations`);
  }

  const client = oauthClient();
  client.setCredentials({
    access_token: cred.accessToken,
    refresh_token: cred.refreshToken,
    expiry_date: cred.expiryDate ?? Date.now() + 3600 * 1000,
  });

  client.on("tokens", (tokens) => {
    if (tokens.access_token) {
      void saveTokens(userEmail, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? cred.refreshToken!,
        expiry_date: tokens.expiry_date ?? Date.now() + 3600 * 1000,
        scope: tokens.scope,
      });
    }
  });

  return client;
}

// Google-shaped save (matches the googleapis `tokens` event payload). Delegates
// to the generic saveCredentials under service='google'.
export async function saveTokens(
  userEmail: string,
  tokens: { access_token: string; refresh_token: string; expiry_date: number; scope?: string | null },
  metadata?: Record<string, unknown>
) {
  const scopes = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [];
  await saveCredentials("google", userEmail, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    scopes,
    metadata,
  });
}

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
