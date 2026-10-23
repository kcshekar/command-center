import { tenantRoute } from "../../core/router";
import { HttpError } from "../../core/auth";
import { writeAudit } from "../../core/audit";
import {
  getUserCredentialsDek,
  isKnownService,
  KNOWN_SERVICES,
  keyPrefix,
} from "../../core/user-credentials";

// BYOK — per-user API keys for the external services the automations call
// (Keepa for A6, OpenAI/Replicate for A1+A9, JSearch for A2 later, etc).
// Encrypted with pgcrypto at write time; the raw key never comes back out of
// this endpoint — workers decrypt in their own queries.

export const userCredentialRoutes = {
  "/api/user-credentials": {
    GET: tenantRoute(async (_req, ctx) => {
      const rows = await ctx.tx`
        SELECT service,
               label,
               key_prefix  AS "keyPrefix",
               metadata,
               created_at  AS "createdAt",
               updated_at  AS "updatedAt"
        FROM user_credentials
        ORDER BY service, label
      `;
      return Response.json({
        knownServices: KNOWN_SERVICES,
        credentials: rows,
      });
    }),

    POST: tenantRoute(async (req, ctx) => {
      const body = (await req.json().catch(() => ({}))) as {
        service?: unknown;
        label?: unknown;
        key?: unknown;
        metadata?: unknown;
      };

      if (typeof body.service !== "string" || !isKnownService(body.service)) {
        throw new HttpError(
          400,
          `service must be one of: ${KNOWN_SERVICES.join(", ")}`
        );
      }
      if (typeof body.key !== "string" || body.key.trim().length < 4) {
        throw new HttpError(400, "key must be a non-empty string");
      }
      const label =
        typeof body.label === "string" && body.label.trim()
          ? body.label.trim()
          : "primary";
      const metadata =
        body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? body.metadata
          : {};

      const dek = getUserCredentialsDek();
      const service = body.service;
      const rawKey = body.key.trim();
      const prefix = keyPrefix(rawKey);

      const [row] = await ctx.tx`
        INSERT INTO user_credentials
          (org_id, user_id, service, label, key_enc, key_prefix, metadata, updated_at)
        VALUES
          (${ctx.orgId}::uuid,
           ${ctx.userId}::uuid,
           ${service},
           ${label},
           pgp_sym_encrypt(${rawKey}, ${dek}),
           ${prefix},
           ${JSON.stringify(metadata)}::jsonb,
           now())
        ON CONFLICT (user_id, service, label) DO UPDATE SET
          key_enc    = EXCLUDED.key_enc,
          key_prefix = EXCLUDED.key_prefix,
          metadata   = EXCLUDED.metadata,
          updated_at = now()
        RETURNING service, label, key_prefix AS "keyPrefix", metadata,
                  created_at AS "createdAt", updated_at AS "updatedAt"
      `;

      await writeAudit(ctx.tx, ctx, {
        action: "user_credential:upsert",
        resourceType: "user_credential",
        metadata: { service, label },
      });

      return Response.json(row);
    }),
  },

  "/api/user-credentials/:service/:label": {
    DELETE: tenantRoute(async (req, ctx) => {
      const { service, label } = req.params;
      if (!isKnownService(service)) {
        throw new HttpError(400, `unknown service: ${service}`);
      }

      const deleted = await ctx.tx`
        DELETE FROM user_credentials
        WHERE user_id = ${ctx.userId}::uuid
          AND service = ${service}
          AND label   = ${label}
        RETURNING service
      `;
      if (deleted.length === 0) {
        throw new HttpError(404, "credential not found");
      }

      await writeAudit(ctx.tx, ctx, {
        action: "user_credential:delete",
        resourceType: "user_credential",
        metadata: { service, label },
      });

      return new Response(null, { status: 204 });
    }),
  },
};
