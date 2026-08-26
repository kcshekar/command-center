import { SQL } from "bun";

// Runtime connection: a non-superuser role so Postgres RLS (tenant isolation,
// audit_log immutability) actually applies. Superusers bypass RLS even with
// FORCE ROW LEVEL SECURITY — DATABASE_URL (admin) is for migrations only,
// never used here.
export const sql = new SQL(process.env.APP_DATABASE_URL!);

export interface AuthCtx {
  userId: string;
  orgId: string;
  role: "owner" | "admin" | "member" | "contractor";
}

// Every module route runs its handler through here: sets the RLS session
// variable for the duration of one transaction, so a bug in a handler can't
// accidentally read/write another org's rows even if it forgets a WHERE clause.
export async function withTenantTx<T>(
  ctx: AuthCtx,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_org_id', ${ctx.orgId}, true)`;
    await tx`SELECT set_config('app.current_user_id', ${ctx.userId}, true)`;
    return fn(tx);
  });
}
