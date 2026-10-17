import { pool } from "../db.js";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// One-time setup: paste the client_id + client_secret issued by CC's
// `/tokens` → "Register Worker" flow (or by the admin bootstrap endpoint),
// and this seeds the single worker_identity row. The worker then calls
// CC's mint endpoint instead of reading a long-lived cc_st_... from .env.
//
// For rotations after this, use the UI's Rotate button — this script is
// install-time only.

async function main() {
  const rl = createInterface({ input, output });
  console.log("Worker identity setup — paste the values from CC's Worker Identities tab.\n");

  const existing = await pool.query(`SELECT client_id FROM worker_identity WHERE id = 1`).catch(() => null);
  if (existing && existing.rows.length > 0) {
    const ans = (await rl.question(`A worker_identity already exists (client_id=${existing.rows[0].client_id}). Overwrite? [y/N] `)).trim().toLowerCase();
    if (ans !== "y" && ans !== "yes") {
      console.log("Aborted.");
      rl.close();
      await pool.end();
      return;
    }
  }

  const clientId = (await rl.question("client_id (worker_...): ")).trim();
  if (!/^worker_[a-f0-9]+$/i.test(clientId)) {
    throw new Error("client_id must look like worker_<hex>");
  }
  const clientSecret = (await rl.question("client_secret (whk_...): ")).trim();
  if (!/^whk_[a-f0-9]+$/i.test(clientSecret)) {
    throw new Error("client_secret must look like whk_<hex>");
  }
  const ccBaseUrl = (await rl.question(`CC base URL [${process.env.CC_BASE_URL ?? "http://localhost:3011"}]: `)).trim()
    || process.env.CC_BASE_URL
    || "http://localhost:3011";
  rl.close();

  await pool.query(
    `INSERT INTO worker_identity (id, client_id, client_secret, cc_base_url, updated_at)
     VALUES (1, $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       client_id = EXCLUDED.client_id,
       client_secret = EXCLUDED.client_secret,
       cc_base_url = EXCLUDED.cc_base_url,
       updated_at = now()`,
    [clientId, clientSecret, ccBaseUrl]
  );
  console.log("\nSaved. The worker will pick up these credentials on next activity run (no restart needed).");
  console.log("You can now remove CC_SERVICE_TOKEN from .env — it was only the migration fallback.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
