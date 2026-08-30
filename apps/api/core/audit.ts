import type { SQL } from "bun";
import type { AuthCtx } from "./db";

export interface AuditEvent {
  action: string;          // 'secret:view' | 'secret:copy' | 'payroll:update' ...
  resourceType: string;
  resourceId?: string;
  ip?: string;
  metadata?: Record<string, unknown>;
}

// Called inside the same tx as the read/write it's logging, so the audit
// record and the data change commit or roll back together.
//
// The audit_insert RLS policy checks org_id against the
// app.current_org_id session variable, which withTenantTx already sets for
// every module route — but a handful of callers (signup, password-reset,
// MFA enable/disable, session revoke) write an audit event outside any
// tenant transaction, where that variable was never set. The set_config
// runs in a CTE that the INSERT's SELECT actually reads from (not just a
// sibling WITH clause — an unreferenced CTE can be optimized away and never
// executed), so it's always applied before this same INSERT's RLS check,
// regardless of whether the caller already set it (harmless no-op re-set)
// or never did.
export async function writeAudit(tx: SQL, ctx: AuthCtx, event: AuditEvent) {
  await tx`
    WITH cfg AS (SELECT set_config('app.current_org_id', ${ctx.orgId}, true) AS applied)
    INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_id, ip, metadata)
    SELECT ${ctx.orgId}, ${ctx.userId}, ${event.action}, ${event.resourceType},
      ${event.resourceId ?? null}, ${event.ip ?? null}, ${JSON.stringify(event.metadata ?? {})}
    FROM cfg
  `;
}
