import "dotenv/config";
import pg from "pg";

if (!process.env.AUTOMATIONS_DATABASE_URL) {
  throw new Error("AUTOMATIONS_DATABASE_URL must be set");
}

// One shared pool; the worker is single-process so no per-request lifetime concerns.
export const pool = new pg.Pool({ connectionString: process.env.AUTOMATIONS_DATABASE_URL });
