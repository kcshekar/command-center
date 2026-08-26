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
export async function writeAudit(tx: SQL, ctx: AuthCtx, event: AuditEvent) {
  await tx`
    INSERT INTO audit_log (org_id, actor_id, action, resource_type, resource_id, ip, metadata)
    VALUES (
      ${ctx.orgId}, ${ctx.userId}, ${event.action}, ${event.resourceType},
      ${event.resourceId ?? null}, ${event.ip ?? null},
      ${JSON.stringify(event.metadata ?? {})}
    )
  `;
}
