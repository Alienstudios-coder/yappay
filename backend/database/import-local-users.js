const fs = require("node:fs/promises");
const path = require("node:path");
const { Client } = require("pg");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to the hosted PostgreSQL connection string in backend/.env.");
  const source = path.join(__dirname, "..", "data", "users.json");
  const users = JSON.parse(await fs.readFile(source, "utf8"));
  if (!Array.isArray(users)) throw new Error("The local account file has an invalid format.");

  for (const user of users) {
    if (!/^[0-9a-f-]{36}$/i.test(user.id || "") || !/^[a-z0-9_]{3,24}$/.test(user.username || "") ||
        !/^[0-9a-f]{32}$/i.test(user.salt || "") || !/^[0-9a-f]{128}$/i.test(user.hash || "")) {
      throw new Error("The local account file contains an invalid account record; no accounts were imported.");
    }
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const user of users) {
      const existing = await client.query(
        "SELECT id, password_salt, password_hash FROM users WHERE id = $1 OR username = $2 FOR UPDATE",
        [user.id, user.username],
      );
      if (existing.rows.length) {
        const row = existing.rows[0];
        if (row.id !== user.id || row.password_salt !== user.salt || row.password_hash !== user.hash) {
          throw new Error("An account ID or username already exists with different credentials; migration stopped without changes.");
        }
        continue;
      }
      await client.query(
        `INSERT INTO users (id, username, email, display_name, password_salt, password_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [user.id, user.username, user.email || null, user.displayName || "", user.salt, user.hash, user.createdAt || new Date()],
      );
    }
    await client.query("COMMIT");
    console.log(`Account migration finished. ${users.length} account(s) are present in PostgreSQL.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Account migration failed: ${error.message}`);
  process.exitCode = 1;
});