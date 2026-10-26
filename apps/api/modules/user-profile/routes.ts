import { tenantRoute } from "../../core/router";
import { HttpError } from "../../core/auth";
import { writeAudit } from "../../core/audit";
import { textArrayLiteral } from "../../core/pg-array";

// A2.1 — singleton profile per user. GET returns the one row (or null if the
// user hasn't set one up yet). PUT upserts: idempotent, UI can save on every
// edit. No DELETE — if the user wants to blank it, they clear the fields.

const REMOTE_PREFS = ["remote", "hybrid", "onsite", "any"] as const;

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}
function asIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}
function asNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

export const userProfileRoutes = {
  "/api/user-profile": {
    GET: tenantRoute(async (_req, ctx) => {
      const [row] = await ctx.tx`
        SELECT id, headline,
               years_exp       AS "yearsExp",
               location,
               remote_pref     AS "remotePref",
               min_salary_lpa  AS "minSalaryLpa",
               currency,
               skills, keywords, anti_keywords AS "antiKeywords",
               bio, metadata,
               created_at      AS "createdAt",
               updated_at      AS "updatedAt"
        FROM user_profile WHERE user_id = ${ctx.userId}::uuid
      `;
      return Response.json(row ?? null);
    }),

    PUT: tenantRoute(async (req, ctx) => {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const headline = asString(body.headline);
      const yearsExp = asIntOrNull(body.yearsExp ?? body.years_exp);
      const location = asString(body.location);
      const remotePref = asString(body.remotePref ?? body.remote_pref) ?? "any";
      if (!(REMOTE_PREFS as readonly string[]).includes(remotePref)) {
        throw new HttpError(400, `remotePref must be one of: ${REMOTE_PREFS.join(", ")}`);
      }
      const minSalaryLpa = asNumberOrNull(body.minSalaryLpa ?? body.min_salary_lpa);
      const currency = (asString(body.currency) ?? "INR").toUpperCase();
      const skills = asStringArray(body.skills);
      const keywords = asStringArray(body.keywords);
      const antiKeywords = asStringArray(body.antiKeywords ?? body.anti_keywords);
      const bio = asString(body.bio);
      const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown> : {};

      const [row] = await ctx.tx`
        INSERT INTO user_profile
          (org_id, user_id, headline, years_exp, location, remote_pref, min_salary_lpa,
           currency, skills, keywords, anti_keywords, bio, metadata, updated_at)
        VALUES
          (${ctx.orgId}::uuid, ${ctx.userId}::uuid,
           ${headline}, ${yearsExp}, ${location}, ${remotePref}, ${minSalaryLpa},
           ${currency},
           ${textArrayLiteral(skills)}::text[],
           ${textArrayLiteral(keywords)}::text[],
           ${textArrayLiteral(antiKeywords)}::text[],
           ${bio},
           ${JSON.stringify(metadata)}::text::jsonb,
           now())
        ON CONFLICT (user_id) DO UPDATE SET
          headline        = EXCLUDED.headline,
          years_exp       = EXCLUDED.years_exp,
          location        = EXCLUDED.location,
          remote_pref     = EXCLUDED.remote_pref,
          min_salary_lpa  = EXCLUDED.min_salary_lpa,
          currency        = EXCLUDED.currency,
          skills          = EXCLUDED.skills,
          keywords        = EXCLUDED.keywords,
          anti_keywords   = EXCLUDED.anti_keywords,
          bio             = EXCLUDED.bio,
          metadata        = EXCLUDED.metadata,
          updated_at      = now()
        RETURNING id, headline,
                  years_exp       AS "yearsExp",
                  location,
                  remote_pref     AS "remotePref",
                  min_salary_lpa  AS "minSalaryLpa",
                  currency,
                  skills, keywords, anti_keywords AS "antiKeywords",
                  bio, metadata,
                  created_at      AS "createdAt",
                  updated_at      AS "updatedAt"
      `;

      await writeAudit(ctx.tx, ctx, {
        action: "user_profile:upsert",
        resourceType: "user_profile",
        resourceId: String(row.id),
        metadata: { skillsCount: skills.length, keywordsCount: keywords.length },
      });

      return Response.json(row);
    }),
  },
};
