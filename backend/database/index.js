const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

const enabled = Boolean(process.env.DATABASE_URL);
const pool = enabled ? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DATABASE_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
}) : null;

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email || "",
    displayName: row.display_name,
    birthday: row.birthday ? String(row.birthday).slice(0, 10) : "",
    gender: row.gender || "",
    bio: row.bio || "",
    intent: row.intent || "",
    salt: row.password_salt,
    hash: row.password_hash,
    createdAt: row.created_at,
  };
}

async function initialize() {
  if (!enabled) return;
  const schema = await fs.readFile(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema.replace(/^\uFEFF/, ""));
  await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
  await pool.query("DELETE FROM password_reset_tokens WHERE expires_at <= NOW()");
  const cleanup = setInterval(() => {
    pool.query("DELETE FROM sessions WHERE expires_at <= NOW()").catch(error => {
      console.error("Could not clean expired database sessions:", error.message);
    });
    pool.query("DELETE FROM password_reset_tokens WHERE expires_at <= NOW()").catch(error => {
      console.error("Could not clean expired password reset tokens:", error.message);
    });
  }, 60 * 60 * 1000);
  cleanup.unref();
  console.log("YapPay Postgres database ready");
}

async function findUserByUsername(username) {
  const result = await pool.query(
    "SELECT id, username, email, display_name, birthday, gender, bio, intent, password_salt, password_hash, created_at FROM users WHERE username = $1",
    [username],
  );
  return fromRow(result.rows[0]);
}

async function findUserByEmail(email) {
  const result = await pool.query(
    "SELECT id, username, email, display_name, birthday, gender, bio, intent, password_salt, password_hash, created_at FROM users WHERE LOWER(email) = $1",
    [email],
  );
  return fromRow(result.rows[0]);
}

async function findUserById(id) {
  const result = await pool.query(
    "SELECT id, username, email, display_name, birthday, gender, bio, intent, password_salt, password_hash, created_at FROM users WHERE id = $1",
    [id],
  );
  return fromRow(result.rows[0]);
}

async function createUser(user) {
  const result = await pool.query(
    `INSERT INTO users (id, username, email, display_name, password_salt, password_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, username, email, display_name, password_salt, password_hash, created_at`,
    [user.id, user.username, user.email || null, user.displayName, user.salt, user.hash, user.createdAt],
  );
  return fromRow(result.rows[0]);
}

async function updateUserProfile(userId, profile) {
  const result = await pool.query(
    `UPDATE users SET display_name = $2, birthday = $3, gender = $4, bio = $5, intent = $6, email = $7 WHERE id = $1
     RETURNING id, username, email, display_name, birthday, gender, bio, intent, password_salt, password_hash, created_at`,
    [userId, profile.displayName, profile.birthday || null, profile.gender, profile.bio, profile.intent, profile.email || null],
  );
  return fromRow(result.rows[0]);
}

async function createSession(tokenHash, userId, expiresAt) {
  await pool.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [tokenHash, userId, expiresAt],
  );
}

async function findSessionUser(tokenHash) {
  const result = await pool.query(
    "SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > NOW()",
    [tokenHash],
  );
  return result.rows[0]?.user_id || null;
}

async function deleteSession(tokenHash) {
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
}

async function updateUserPassword(userId, credentials) {
  await pool.query(
    "UPDATE users SET password_salt = $2, password_hash = $3 WHERE id = $1",
    [userId, credentials.salt, credentials.hash],
  );
}

async function deleteSessionsForUser(userId) {
  await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

async function createPasswordReset(tokenHash, userId, expiresAt) {
  await pool.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [userId]);
  await pool.query(
    "INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [tokenHash, userId, expiresAt],
  );
}

async function consumePasswordReset(tokenHash) {
  const result = await pool.query(
    "DELETE FROM password_reset_tokens WHERE token_hash = $1 AND expires_at > NOW() RETURNING user_id",
    [tokenHash],
  );
  return result.rows[0]?.user_id || null;
}

async function createPayment(checkoutRequestId, plan, phone) {
  await pool.query("INSERT INTO mpesa_payments (checkout_request_id, status, plan, phone) VALUES ($1, 'pending', $2, $3)", [checkoutRequestId, plan, phone]);
}

async function updatePayment(checkoutRequestId, status, details = {}) {
  await pool.query("UPDATE mpesa_payments SET status = $2, receipt = COALESCE($3, receipt), message = COALESCE($4, message), updated_at = NOW() WHERE checkout_request_id = $1", [checkoutRequestId, status, details.receipt || null, details.message || null]);
}

async function findPayment(checkoutRequestId) {
  const result = await pool.query("SELECT status, message, receipt FROM mpesa_payments WHERE checkout_request_id = $1", [checkoutRequestId]);
  return result.rows[0] || null;
}

module.exports = {
  enabled,
  initialize,
  findUserByUsername,
  findUserByEmail,
  findUserById,
  createUser,
  updateUserProfile,
  createSession,
  findSessionUser,
  deleteSession,
  updateUserPassword,
  deleteSessionsForUser,
  createPasswordReset,
  consumePasswordReset,
  createPayment,
  updatePayment,
  findPayment,
};
