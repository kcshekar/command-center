import { tenantRoute } from "../../core/router";
import { getUploadUrl, getDownloadUrl, deleteObject } from "../../core/storage";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";

// Generic across resource types (kb_command today; any future module can
// reuse this with its own resourceType) — no FK to a specific table, mirrors
// resource_grants' pattern in core.
export const attachmentRoutes = {
  "/api/kb/attachments/presign": {
    POST: tenantRoute(async (req, ctx) => {
      const { resourceType, resourceId, filename, contentType } = await req.json();
      if (!resourceType || !resourceId || !filename || !contentType) {
        throw new HttpError(400, "missing fields");
      }
      const objectKey = `${resourceType}/${resourceId}/${crypto.randomUUID()}-${filename}`;
      const uploadUrl = await getUploadUrl(objectKey, contentType);
      return Response.json({ uploadUrl, objectKey });
    }),
  },

  "/api/kb/attachments/confirm": {
    POST: tenantRoute(async (req, ctx) => {
      const { resourceType, resourceId, objectKey, filename, contentType, sizeBytes } = await req.json();
      if (!resourceType || !resourceId || !objectKey || !filename || !contentType) {
        throw new HttpError(400, "missing fields");
      }
      const [row] = await ctx.tx`
        INSERT INTO attachments (org_id, resource_type, resource_id, object_key, filename, content_type, size_bytes, uploaded_by)
        VALUES (${ctx.orgId}, ${resourceType}, ${resourceId}, ${objectKey}, ${filename}, ${contentType}, ${sizeBytes ?? null}, ${ctx.userId})
        RETURNING id, filename, content_type, size_bytes, uploaded_at
      `;
      await writeAudit(ctx.tx, ctx, {
        action: "attachment:create",
        resourceType: "attachment",
        resourceId: row.id,
        metadata: { resourceType, resourceId, filename },
      });
      return Response.json(row, { status: 201 });
    }),
  },

  "/api/kb/attachments": {
    GET: tenantRoute(async (req, ctx) => {
      const url = new URL(req.url);
      const resourceType = url.searchParams.get("resourceType");
      const resourceId = url.searchParams.get("resourceId");
      if (!resourceType || !resourceId) throw new HttpError(400, "resourceType and resourceId required");
      const rows = await ctx.tx`
        SELECT id, object_key, filename, content_type, size_bytes, uploaded_by, uploaded_at
        FROM attachments WHERE resource_type = ${resourceType} AND resource_id = ${resourceId}
        ORDER BY uploaded_at DESC
      `;
      const withUrls = await Promise.all(
        rows.map(async (r: any) => ({
          id: r.id,
          filename: r.filename,
          contentType: r.content_type,
          sizeBytes: r.size_bytes,
          uploadedBy: r.uploaded_by,
          uploadedAt: r.uploaded_at,
          downloadUrl: await getDownloadUrl(r.object_key),
        }))
      );
      return Response.json(withUrls);
    }),
  },

  "/api/kb/attachments/:attachmentId": {
    DELETE: tenantRoute(async (req, ctx) => {
      const { attachmentId } = req.params;
      const [row] = await ctx.tx`DELETE FROM attachments WHERE id = ${attachmentId} RETURNING object_key, filename`;
      if (!row) throw new HttpError(404, "not found");
      await deleteObject(row.object_key);
      await writeAudit(ctx.tx, ctx, {
        action: "attachment:delete",
        resourceType: "attachment",
        resourceId: attachmentId,
        metadata: { filename: row.filename },
      });
      return new Response(null, { status: 204 });
    }),
  },
};
