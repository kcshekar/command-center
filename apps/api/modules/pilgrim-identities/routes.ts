import { tenantRoute } from "../../core/router";
import { HttpError } from "../../core/auth";
import { writeAudit } from "../../core/audit";
import {
  getPilgrimIdentitiesDek,
  GENDERS, ID_TYPES, RELATIONSHIPS,
  type PilgrimPii,
} from "../../core/pilgrim-identities";

// A10.1 — CRUD for pilgrim_identities.
//
// GET returns the decrypted PII inline. User-facing self-service tool over
// HTTPS; same risk model as a password manager. Mask client-side if we want
// defence-in-depth.
//
// PATCH: any field, including PII. If any PII field is in the body we
// re-encrypt the whole blob (cheap, one pgcrypto call); other fields take the
// usual sequential UPDATE-per-column path.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PII_KEYS = ["dob", "idNumber", "phone", "email", "address"] as const;
type PiiKey = (typeof PII_KEYS)[number];

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function asMetadata(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}
function parsePii(body: Record<string, unknown>): PilgrimPii {
  const pii: PilgrimPii = {};
  for (const k of PII_KEYS) {
    const v = body[k];
    if (typeof v === "string" && v.trim()) (pii as Record<string, string>)[k] = v.trim();
  }
  return pii;
}

export const pilgrimIdentityRoutes = {
  "/api/pilgrim-identities": {
    GET: tenantRoute(async (_req, ctx) => {
      const dek = getPilgrimIdentitiesDek();
      const rows = await ctx.tx`
        SELECT id, full_name AS "fullName", gender,
               id_type AS "idType", relationship, note, metadata,
               CASE WHEN pii_enc IS NULL
                    THEN NULL
                    ELSE pgp_sym_decrypt(pii_enc, ${dek})::text
               END AS "piiJson",
               created_at AS "createdAt",
               updated_at AS "updatedAt"
        FROM pilgrim_identities
        ORDER BY (relationship = 'self') DESC, created_at ASC
      `;
      return Response.json(
        rows.map((r: Record<string, unknown>) => {
          const { piiJson, ...rest } = r;
          const pii: PilgrimPii = piiJson ? JSON.parse(String(piiJson)) : {};
          return { ...rest, pii };
        })
      );
    }),

    POST: tenantRoute(async (req, ctx) => {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

      const fullName = asString(body.fullName ?? body.full_name);
      if (!fullName) throw new HttpError(400, "fullName is required");

      const gender = asString(body.gender);
      if (gender && !(GENDERS as readonly string[]).includes(gender)) {
        throw new HttpError(400, `gender must be one of: ${GENDERS.join(", ")}`);
      }
      const idType = asString(body.idType ?? body.id_type);
      if (idType && !(ID_TYPES as readonly string[]).includes(idType)) {
        throw new HttpError(400, `idType must be one of: ${ID_TYPES.join(", ")}`);
      }
      const relationship = asString(body.relationship) ?? "self";
      if (!(RELATIONSHIPS as readonly string[]).includes(relationship)) {
        throw new HttpError(400, `relationship must be one of: ${RELATIONSHIPS.join(", ")}`);
      }
      const note = asString(body.note);
      const metadata = asMetadata(body.metadata);
      const pii = parsePii((body.pii && typeof body.pii === "object" ? body.pii : body) as Record<string, unknown>);
      const hasPii = Object.keys(pii).length > 0;
      const dek = getPilgrimIdentitiesDek();

      const [row] = hasPii
        ? await ctx.tx`
            INSERT INTO pilgrim_identities
              (org_id, user_id, full_name, gender, id_type, relationship, pii_enc, note, metadata)
            VALUES
              (${ctx.orgId}::uuid, ${ctx.userId}::uuid,
               ${fullName}, ${gender}, ${idType}, ${relationship},
               pgp_sym_encrypt(${JSON.stringify(pii)}, ${dek}),
               ${note}, ${JSON.stringify(metadata)}::text::jsonb)
            RETURNING id, full_name AS "fullName", gender, id_type AS "idType",
                      relationship, note, metadata,
                      created_at AS "createdAt", updated_at AS "updatedAt"
          `
        : await ctx.tx`
            INSERT INTO pilgrim_identities
              (org_id, user_id, full_name, gender, id_type, relationship, note, metadata)
            VALUES
              (${ctx.orgId}::uuid, ${ctx.userId}::uuid,
               ${fullName}, ${gender}, ${idType}, ${relationship},
               ${note}, ${JSON.stringify(metadata)}::text::jsonb)
            RETURNING id, full_name AS "fullName", gender, id_type AS "idType",
                      relationship, note, metadata,
                      created_at AS "createdAt", updated_at AS "updatedAt"
          `;

      await writeAudit(ctx.tx, ctx, {
        action: "pilgrim_identity:create",
        resourceType: "pilgrim_identity",
        resourceId: String(row.id),
        metadata: { relationship, idType, hasPii },
      });

      return Response.json({ ...row, pii }, { status: 201 });
    }),
  },

  "/api/pilgrim-identities/:id": {
    GET: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const dek = getPilgrimIdentitiesDek();
      const [row] = await ctx.tx`
        SELECT id, full_name AS "fullName", gender, id_type AS "idType",
               relationship, note, metadata,
               CASE WHEN pii_enc IS NULL
                    THEN NULL
                    ELSE pgp_sym_decrypt(pii_enc, ${dek})::text
               END AS "piiJson",
               created_at AS "createdAt",
               updated_at AS "updatedAt"
        FROM pilgrim_identities
        WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "pilgrim identity not found");
      const { piiJson, ...rest } = row;
      const pii: PilgrimPii = piiJson ? JSON.parse(String(piiJson)) : {};
      return Response.json({ ...rest, pii });
    }),

    // One UPDATE per changed non-encrypted column. If any PII field is in the
    // body, we read-merge-rewrite the whole encrypted blob in a single extra
    // UPDATE — simpler than per-field re-encryption and still one pgcrypto
    // call. The CASE in the select handles the "no PII yet" case.
    PATCH: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const hasKey = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
      const piiSrc = (body.pii && typeof body.pii === "object" ? body.pii : body) as Record<string, unknown>;
      const touchesPii = PII_KEYS.some((k) => Object.prototype.hasOwnProperty.call(piiSrc, k));

      let changed = 0;

      if (hasKey("fullName") || hasKey("full_name")) {
        const next = asString(body.fullName ?? body.full_name);
        if (!next) throw new HttpError(400, "fullName cannot be cleared");
        await ctx.tx`UPDATE pilgrim_identities SET full_name = ${next}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("gender")) {
        const next = asString(body.gender);
        if (next && !(GENDERS as readonly string[]).includes(next)) {
          throw new HttpError(400, `gender must be one of: ${GENDERS.join(", ")}`);
        }
        await ctx.tx`UPDATE pilgrim_identities SET gender = ${next}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("idType") || hasKey("id_type")) {
        const next = asString(body.idType ?? body.id_type);
        if (next && !(ID_TYPES as readonly string[]).includes(next)) {
          throw new HttpError(400, `idType must be one of: ${ID_TYPES.join(", ")}`);
        }
        await ctx.tx`UPDATE pilgrim_identities SET id_type = ${next}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("relationship")) {
        const next = asString(body.relationship) ?? "self";
        if (!(RELATIONSHIPS as readonly string[]).includes(next)) {
          throw new HttpError(400, `relationship must be one of: ${RELATIONSHIPS.join(", ")}`);
        }
        await ctx.tx`UPDATE pilgrim_identities SET relationship = ${next}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("note")) {
        const next = asString(body.note) ?? null;
        await ctx.tx`UPDATE pilgrim_identities SET note = ${next}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("metadata")) {
        const next = asMetadata(body.metadata);
        await ctx.tx`UPDATE pilgrim_identities SET metadata = ${JSON.stringify(next)}::text::jsonb, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (touchesPii) {
        const dek = getPilgrimIdentitiesDek();
        const [existing] = await ctx.tx`
          SELECT CASE WHEN pii_enc IS NULL
                      THEN NULL
                      ELSE pgp_sym_decrypt(pii_enc, ${dek})::text
                 END AS "piiJson"
          FROM pilgrim_identities WHERE id = ${id}::uuid
        `;
        if (!existing) throw new HttpError(404, "pilgrim identity not found");
        const prior: PilgrimPii = existing.piiJson ? JSON.parse(String(existing.piiJson)) : {};
        // Merge: patch semantics — only touch fields that appear in the body.
        // Pass null/"" to clear a field.
        for (const k of PII_KEYS) {
          if (Object.prototype.hasOwnProperty.call(piiSrc, k)) {
            const v = piiSrc[k];
            if (typeof v === "string" && v.trim()) {
              (prior as Record<string, string>)[k] = v.trim();
            } else {
              delete (prior as Record<string, unknown>)[k];
            }
          }
        }
        const hasAny = Object.keys(prior).length > 0;
        if (hasAny) {
          await ctx.tx`UPDATE pilgrim_identities SET pii_enc = pgp_sym_encrypt(${JSON.stringify(prior)}, ${dek}), updated_at = now() WHERE id = ${id}::uuid`;
        } else {
          await ctx.tx`UPDATE pilgrim_identities SET pii_enc = NULL, updated_at = now() WHERE id = ${id}::uuid`;
        }
        changed++;
      }

      if (changed === 0) {
        throw new HttpError(
          400,
          "no updatable fields: fullName | gender | idType | relationship | note | metadata | pii.{dob,idNumber,phone,email,address}"
        );
      }

      const dek = getPilgrimIdentitiesDek();
      const [row] = await ctx.tx`
        SELECT id, full_name AS "fullName", gender, id_type AS "idType",
               relationship, note, metadata,
               CASE WHEN pii_enc IS NULL
                    THEN NULL
                    ELSE pgp_sym_decrypt(pii_enc, ${dek})::text
               END AS "piiJson",
               created_at AS "createdAt",
               updated_at AS "updatedAt"
        FROM pilgrim_identities
        WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "pilgrim identity not found");

      await writeAudit(ctx.tx, ctx, {
        action: "pilgrim_identity:update",
        resourceType: "pilgrim_identity",
        resourceId: id,
        metadata: { touchedPii: touchesPii },
      });

      const { piiJson, ...rest } = row;
      const pii: PilgrimPii = piiJson ? JSON.parse(String(piiJson)) : {};
      return Response.json({ ...rest, pii });
    }),

    DELETE: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const deleted = await ctx.tx`DELETE FROM pilgrim_identities WHERE id = ${id}::uuid RETURNING id`;
      if (deleted.length === 0) throw new HttpError(404, "pilgrim identity not found");

      await writeAudit(ctx.tx, ctx, {
        action: "pilgrim_identity:delete",
        resourceType: "pilgrim_identity",
        resourceId: id,
      });
      return new Response(null, { status: 204 });
    }),
  },
};
