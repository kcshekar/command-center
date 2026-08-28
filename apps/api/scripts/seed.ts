import { sql } from "../core/db";
import { hashPassword } from "../core/auth";

// Idempotent local-dev bootstrap: `bun run apps/api/scripts/seed.ts`
const ORG_NAME = "Dev Org";
const EMAIL = "owner@dev.local";
const PASSWORD = "devpassword123";

async function seed() {
  let [org] = await sql`SELECT id FROM organizations WHERE name = ${ORG_NAME}`;
  if (!org) {
    [org] = await sql`INSERT INTO organizations (name) VALUES (${ORG_NAME}) RETURNING id`;
    console.log("created org", org.id);
  }

  const [existing] = await sql`SELECT id FROM users WHERE email = ${EMAIL}`;
  if (existing) {
    console.log("user already exists:", EMAIL);
    process.exit(0);
  }

  const passwordHash = await hashPassword(PASSWORD);
  const [user] = await sql`
    INSERT INTO users (org_id, email, password_hash, role)
    VALUES (${org.id}, ${EMAIL}, ${passwordHash}, 'owner')
    RETURNING id
  `;
  console.log("created user", user.id, EMAIL, PASSWORD);
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
