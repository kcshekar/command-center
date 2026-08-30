import { sql } from "./db";
import { hashPassword, revokeAllSessions } from "./auth";
import { sendEmail } from "./email";
import { writeAudit } from "./audit";
import { log } from "./log";

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function generateToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest).toString("hex");
}

// Always behaves the same whether or not the email has an account —
// otherwise the response itself leaks which emails are registered.
export async function requestPasswordReset(email: string): Promise<void> {
  const [user] = await sql`SELECT id FROM users WHERE email = ${email}`;
  if (!user) return;

  const token = generateToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await sql`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (${user.id}, ${tokenHash}, ${expiresAt})
  `;

  const resetUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/reset-password?token=${token}`;
  try {
    await sendEmail(
      email,
      "Reset your Command Center password",
      `<p>Click the link below to reset your password. This link expires in 30 minutes.</p>
       <p><a href="${resetUrl}">${resetUrl}</a></p>
       <p>If you didn't request this, you can ignore this email.</p>`
    );
  } catch (err) {
    // Never let a delivery failure propagate: a request for an existing
    // email that fails to send (500) vs. a nonexistent email that returns
    // immediately (200) is exactly the enumeration leak this function
    // exists to prevent — just via status code instead of response body.
    log.error("password reset email failed to send", { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function resetPassword(token: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
  const tokenHash = await hashToken(token);
  const [row] = await sql`
    SELECT prt.id, prt.user_id, u.org_id FROM password_reset_tokens prt
    JOIN users u ON u.id = prt.user_id
    WHERE prt.token_hash = ${tokenHash} AND prt.used_at IS NULL AND prt.expires_at > now()
  `;
  if (!row) return { ok: false, error: "Invalid or expired reset link" };

  const passwordHash = await hashPassword(newPassword);
  await sql.begin(async (tx) => {
    await tx`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${row.user_id}`;
    await tx`UPDATE password_reset_tokens SET used_at = now() WHERE id = ${row.id}`;
    // No session cookie exists at this point (pre-auth flow) — build a
    // one-off ctx from the token's own lookup rather than authenticate().
    await writeAudit(tx, { userId: row.user_id, orgId: row.org_id, role: "member" }, { action: "password:reset", resourceType: "user", resourceId: row.user_id });
  });
  // The old password is dead, so every session established under it should
  // be too — no one is logged in yet at this point, so no token to spare.
  await revokeAllSessions(row.user_id);
  return { ok: true };
}
