import { pool } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";
import { cc } from "./cc-client.js";

// A7 — GitHub OAuth. Mirrors google-oauth.ts; stores tokens in the generic
// external_credentials table under service='github', user_id='<github login>'
// so the Connected Accounts UI already renders them. The CC → worker map
// (CC user uuid ↔ GitHub login) lives in metadata.ccUserId.
//
// GitHub tokens from the web flow don't expire by default and don't come with
// a refresh token (unlike GitHub Apps). We treat refresh as a no-op.

const AUTH_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";

interface GithubCredential {
  accessToken: string;
  scopes: string[];
  metadata: Record<string, unknown>;
}

function clientConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const redirectUri = process.env.GITHUB_REDIRECT_URI
    ?? `http://localhost:${process.env.WORKER_CALLBACK_PORT ?? 3005}/auth/github/callback`;
  if (!clientId || !clientSecret) {
    throw new Error("GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET must be set in worker .env");
  }
  return { clientId, clientSecret, redirectUri };
}

// Called by callback-server to redirect the user into GitHub's consent flow.
// `state` is the CC-signed token (verifyOAuthState) the callback re-checks to
// tie the GitHub login back to the right CC user.
export function githubAuthUrl(state: string, scopes: string[] = ["public_repo", "repo"]): string {
  const { clientId, redirectUri } = clientConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state,
    allow_signup: "false",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// Exchange the auth code for an access token + fetch the GitHub login.
export async function githubExchange(code: string): Promise<{ accessToken: string; scopes: string[]; login: string; htmlUrl: string }> {
  const { clientId, clientSecret, redirectUri } = clientConfig();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new Error(`github token exchange ${res.status}`);
  const body = (await res.json()) as { access_token?: string; scope?: string; error?: string };
  if (!body.access_token) throw new Error(`github token exchange failed: ${body.error ?? "unknown"}`);
  const accessToken = body.access_token;
  const scopes = (body.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  // Who are we?
  const uRes = await fetch(`${API}/user`, {
    headers: { "Authorization": `Bearer ${accessToken}`, "Accept": "application/vnd.github+json", "User-Agent": "memoryAllocator-a7" },
  });
  if (!uRes.ok) throw new Error(`github /user ${uRes.status}`);
  const user = (await uRes.json()) as { login?: string; html_url?: string };
  if (!user.login) throw new Error("github /user returned no login");
  return { accessToken, scopes, login: user.login, htmlUrl: user.html_url ?? "" };
}

// Persist under (service, user_id=login, label=primary). ccUserId goes into
// metadata so the worker can look up credentials by CC uuid.
export async function saveGithubTokens(login: string, ccUserId: string, cred: { accessToken: string; scopes: string[]; htmlUrl: string }): Promise<void> {
  const enc = encrypt(cred.accessToken);
  await pool.query(
    `INSERT INTO external_credentials
       (service, user_id, label, encrypted_access_token, access_token_iv, scopes, metadata)
     VALUES ($1, $2, 'primary', $3, $4, $5, $6)
     ON CONFLICT (service, user_id, label) DO UPDATE SET
       encrypted_access_token = EXCLUDED.encrypted_access_token,
       access_token_iv        = EXCLUDED.access_token_iv,
       scopes                 = EXCLUDED.scopes,
       metadata               = external_credentials.metadata || EXCLUDED.metadata,
       updated_at             = now()`,
    ["github", login, enc.ciphertext, enc.iv, cred.scopes, { ccUserId, htmlUrl: cred.htmlUrl, loginVerifiedAt: new Date().toISOString() }]
  );

  // Mirror into CC's external_accounts so the UI picks it up.
  await cc.upsertExternalAccount({
    service: "github",
    userId: login,
    label: "primary",
    scopes: cred.scopes,
    status: "active",
    metadata: { ccUserId, htmlUrl: cred.htmlUrl },
  }).catch((err) => console.warn("[a7.github] mirror to CC failed", { err: String(err) }));
}

// Resolve by CC user id. Scans github rows and picks the one whose metadata
// points at this ccUserId. Returns null when the user hasn't connected yet.
export async function getGithubCredentialByCcUser(ccUserId: string): Promise<(GithubCredential & { login: string }) | null> {
  const { rows } = await pool.query(
    `SELECT user_id AS login, encrypted_access_token, access_token_iv, scopes, metadata
       FROM external_credentials
      WHERE service = 'github'
        AND metadata->>'ccUserId' = $1
      ORDER BY updated_at DESC
      LIMIT 1`,
    [ccUserId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    login: r.login,
    accessToken: decrypt(r.encrypted_access_token, r.access_token_iv),
    scopes: r.scopes ?? [],
    metadata: r.metadata ?? {},
  };
}

// Minimal REST helper. Returns parsed JSON. 2xx → body, else throw.
export async function gh<T = unknown>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "memoryAllocator-a7",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`github ${res.status} ${path}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}
