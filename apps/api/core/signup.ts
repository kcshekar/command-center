import { sql, type AuthCtx } from "./db";
import { hashPassword, createSession } from "./auth";
import { writeAudit } from "./audit";
import { HttpError } from "./auth";

// Every signup creates a fresh organization with a single owner user — the
// same shape scripts/seed.ts creates by hand today. There's no invite flow;
// additional org members (admin/member/contractor) are still provisioned
// out of band, same as before this existed.
export async function signup(orgName: string, email: string, password: string): Promise<{ token: string; ctx: AuthCtx }> {
  const [existing] = await sql`SELECT id FROM users WHERE email = ${email}`;
  if (existing) throw new HttpError(409, "An account with that email already exists");

  const passwordHash = await hashPassword(password);
  const { org, user } = await sql.begin(async (tx) => {
    const [org] = await tx`INSERT INTO organizations (name) VALUES (${orgName}) RETURNING id`;
    const [user] = await tx`
      INSERT INTO users (org_id, email, password_hash, role)
      VALUES (${org.id}, ${email}, ${passwordHash}, 'owner')
      RETURNING id
    `;
    const ctx: AuthCtx = { userId: user.id, orgId: org.id, role: "owner" };
    await writeAudit(tx, ctx, { action: "organization:create", resourceType: "organization", resourceId: org.id });
    await writeAudit(tx, ctx, { action: "user:signup", resourceType: "user", resourceId: user.id });
    return { org, user };
  });

  const ctx: AuthCtx = { userId: user.id, orgId: org.id, role: "owner" };
  const token = await createSession(ctx);
  return { token, ctx };
}
