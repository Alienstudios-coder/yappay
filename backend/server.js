const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const database = require("./database");
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

const {
  PORT = 3000,
  MPESA_ENV = "sandbox",
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE = "174379",
  MPESA_PASSKEY,
  MPESA_TRANSACTION_TYPE = "CustomerPayBillOnline",
  CALLBACK_URL,
  ALLOWED_ORIGIN = "*",
  NODE_ENV,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
} = process.env;

const BASE = MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const sessions = new Map(); // Local demo sessions; hosted sessions are stored in Postgres.
const loginAttempts = new Map();
const passwordResets = new Map(); // Local demo only; hosted reset records are stored in Postgres.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const COOKIE = "yappay_session";
const GOOGLE_STATE_COOKIE = "yappay_google_state";
const GOOGLE_NONCE_COOKIE = "yappay_google_nonce";

const PLANS = {
  plus: { amount: 499, label: "YapPay Plus" },
  premium: { amount: 1299, label: "YapPay Premium" },
};
const payments = new Map();

const ALLOWED_ORIGINS = ALLOWED_ORIGIN.split(",").map(value => value.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.get("Origin");
  const wildcard = ALLOWED_ORIGINS.includes("*");
  const allowed = !origin || wildcard || ALLOWED_ORIGINS.includes(origin);
  res.vary("Origin");
  if (origin && allowed) {
    res.set("Access-Control-Allow-Origin", wildcard ? "*" : origin);
    if (!wildcard) res.set("Access-Control-Allow-Credentials", "true");
  }
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(allowed ? 204 : 403);
  next();
});

async function readUsers() {
  try { return JSON.parse(await fs.readFile(USERS_FILE, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function writeUsers(users) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = `${USERS_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(users, null, 2), { mode: 0o600 });
  await fs.rename(temp, USERS_FILE);
}
async function findUserByUsername(username) {
  if (database.enabled) return database.findUserByUsername(username);
  return (await readUsers()).find(user => user.username === username) || null;
}
async function findUserByEmail(email) {
  if (database.enabled) return database.findUserByEmail(email);
  return (await readUsers()).find(user => (user.email || "").toLowerCase() === email) || null;
}
async function findUserByIdentifier(identifier) {
  return identifier.includes("@") ? findUserByEmail(identifier) : findUserByUsername(identifier);
}
async function findUserById(id) {
  if (database.enabled) return database.findUserById(id);
  return (await readUsers()).find(user => user.id === id) || null;
}
async function createUser(user) {
  if (database.enabled) return database.createUser(user);
  const users = await readUsers();
  if (users.some(existing => existing.username === user.username || (user.email && (existing.email || "").toLowerCase() === user.email))) {
    const error = new Error("Username already exists");
    error.code = "23505";
    throw error;
  }
  users.push(user);
  await writeUsers(users);
  return user;
}
function publicUser(user) {
  return { username: user.username, email: user.email || "", displayName: user.displayName || "", birthday: user.birthday || "", gender: user.gender || "", bio: user.bio || "", intent: user.intent || "" };
}
function cleanUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function cookieValue(req, name) {
  return (req.headers.cookie || "").split(";").map(part => part.trim())
    .find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
function googleRedirectUri(req) {
  if (GOOGLE_REDIRECT_URI) return GOOGLE_REDIRECT_URI;
  if (NODE_ENV === "production") return "";
  return `${req.protocol}://${req.get("host")}/api/auth/google/callback`;
}
function clearGoogleCookies(res) {
  const options = { httpOnly: true, secure: NODE_ENV === "production", sameSite: "lax", path: "/api/auth/google" };
  res.clearCookie(GOOGLE_STATE_COOKIE, options);
  res.clearCookie(GOOGLE_NONCE_COOKIE, options);
}
function googleErrorPage(res, status, message) {
  return res.status(status).type("html").send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google sign-in · YapPay</title><body style="margin:0;background:#f2e8ff;color:#24182f;font:16px system-ui;min-height:100vh;display:grid;place-items:center"><main style="max-width:440px;margin:24px;padding:32px;background:white;border:1px solid #ddd0e8;border-radius:20px"><p style="color:#75409a;font-size:12px;font-weight:700;letter-spacing:.12em">YAPPAY ACCOUNT</p><h1>Google sign-in unavailable</h1><p>${message}</p><a style="color:#68338c" href="/#login">Return to YapPay</a></main></body></html>`);
}
function validUsername(username) {
  return /^[a-z0-9_]{3,24}$/.test(username);
}
function cleanEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}
function passwordHash(password, salt = crypto.randomBytes(16)) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => {
    if (error) return reject(error);
    resolve({ salt: salt.toString("hex"), hash: key.toString("hex") });
  }));
}
async function issueSession(user, res) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  if (database.enabled) await database.createSession(tokenHash, user.id, expires);
  else sessions.set(tokenHash, { userId: user.id, expires: expires.getTime() });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: NODE_ENV === "production" ? "none" : "lax",
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}
async function sessionUser(req) {
  const token = (req.headers.cookie || "").split(";").map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  if (database.enabled) return database.findSessionUser(tokenHash);
  const session = sessions.get(tokenHash);
  if (!session || session.expires <= Date.now()) {
    sessions.delete(tokenHash);
    return null;
  }
  return session.userId;
}
function getClientKey(req) { return req.ip || req.socket.remoteAddress || "unknown"; }
function tooManyAttempts(req) {
  const key = getClientKey(req);
  const current = loginAttempts.get(key);
  if (!current || current.until <= Date.now()) {
    loginAttempts.set(key, { count: 1, until: Date.now() + 15 * 60 * 1000 });
    return false;
  }
  current.count++;
  return current.count > 10;
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const username = cleanUsername(req.body?.username);
    const email = cleanEmail(req.body?.email);
    const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim().slice(0, 60) : "";
    const password = req.body?.password;
    if (!validUsername(username)) return res.status(400).json({ error: "Use 3–24 letters, numbers, or underscores for your username." });
    if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (typeof password !== "string" || password.length < 8 || password.length > 128)
      return res.status(400).json({ error: "Your password must be at least 8 characters." });
    const credentials = await passwordHash(password);
    const user = await createUser({ id: crypto.randomUUID(), username, email, displayName, ...credentials, createdAt: new Date().toISOString() });
    await issueSession(user, res);
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That username or email is already registered." });
    console.error("Registration failed:", error.message);
    res.status(500).json({ error: "Could not create your account. Please try again." });
  }
});

app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    // This project has no configured email sender yet. Never expose reset tokens from production.
    if (NODE_ENV === "production") {
      return res.status(503).json({ error: "Password reset email delivery is not configured. Please contact support." });
    }
    const identifier = cleanEmail(req.body?.identifier ?? req.body?.username);
    const user = identifier.includes("@") ? (validEmail(identifier) ? await findUserByIdentifier(identifier) : null) : (validUsername(identifier) ? await findUserByIdentifier(identifier) : null);
    const response = { message: "If that username belongs to an account, reset instructions are ready." };
    if (user) {
      const token = crypto.randomBytes(32).toString("base64url");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const expires = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
      if (database.enabled) await database.createPasswordReset(tokenHash, user.id, expires);
      else {
        for (const [savedHash, reset] of passwordResets) {
          if (reset.userId === user.id) passwordResets.delete(savedHash);
        }
        passwordResets.set(tokenHash, { userId: user.id, expires: expires.getTime() });
      }
      // Local demo only: show this link in the UI because no email service is configured.
      response.resetToken = token;
      response.demoOnly = true;
    }
    res.json(response);
  } catch (error) {
    console.error("Password reset request failed:", error.message);
    res.status(500).json({ error: "Could not start password reset. Please try again." });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const password = req.body?.password;
  if (token.length < 32 || token.length > 128) return res.status(400).json({ error: "This reset link is invalid or expired. Request a new one." });
  if (typeof password !== "string" || password.length < 8 || password.length > 128)
    return res.status(400).json({ error: "Your password must be 8–128 characters." });
  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    let userId;
    if (database.enabled) userId = await database.consumePasswordReset(tokenHash);
    else {
      const reset = passwordResets.get(tokenHash);
      passwordResets.delete(tokenHash);
      if (reset && reset.expires > Date.now()) userId = reset.userId;
    }
    if (!userId) return res.status(400).json({ error: "This reset link is invalid or expired. Request a new one." });
    const credentials = await passwordHash(password);
    if (database.enabled) {
      await database.updateUserPassword(userId, credentials);
      await database.deleteSessionsForUser(userId);
    } else {
      const users = await readUsers();
      const user = users.find(entry => entry.id === userId);
      if (!user) return res.status(400).json({ error: "This reset link is invalid or expired. Request a new one." });
      Object.assign(user, credentials);
      await writeUsers(users);
      for (const [sessionHash, session] of sessions) {
        if (session.userId === userId) sessions.delete(sessionHash);
      }
    }
    res.json({ message: "Password updated. Log in with your new password." });
  } catch (error) {
    console.error("Password reset failed:", error.message);
    res.status(500).json({ error: "Could not reset your password. Please try again." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  if (tooManyAttempts(req)) return res.status(429).json({ error: "Too many attempts. Please wait 15 minutes and try again." });
  try {
    const identifier = cleanEmail(req.body?.identifier ?? req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const user = await findUserByIdentifier(identifier);
    const salt = user ? Buffer.from(user.salt, "hex") : Buffer.alloc(16);
    const expected = user ? Buffer.from(user.hash, "hex") : Buffer.alloc(64);
    const actual = Buffer.from((await passwordHash(password, salt)).hash, "hex");
    if (!user || !crypto.timingSafeEqual(expected, actual)) return res.status(401).json({ error: "Username or password is incorrect." });
    loginAttempts.delete(getClientKey(req));
    await issueSession(user, res);
    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error("Login failed:", error.message);
    res.status(500).json({ error: "Could not log in. Please try again." });
  }
});

app.get("/api/auth/google/start", (req, res) => {
  const redirectUri = googleRedirectUri(req);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !redirectUri) {
    return googleErrorPage(res, 503, "Google sign-in is not configured yet. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI to the server settings.");
  }
  const state = crypto.randomBytes(32).toString("base64url");
  const nonce = crypto.randomBytes(32).toString("base64url");
  const cookieOptions = { httpOnly: true, secure: NODE_ENV === "production", sameSite: "lax", path: "/api/auth/google", maxAge: 10 * 60 * 1000 };
  res.cookie(GOOGLE_STATE_COOKIE, state, cookieOptions);
  res.cookie(GOOGLE_NONCE_COOKIE, nonce, cookieOptions);
  const oauth = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri);
  res.redirect(oauth.generateAuthUrl({ access_type: "online", prompt: "select_account", scope: ["openid", "email", "profile"], state, nonce }));
});

app.get("/api/auth/google/callback", async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const nonce = cookieValue(req, GOOGLE_NONCE_COOKIE);
  const savedState = cookieValue(req, GOOGLE_STATE_COOKIE);
  clearGoogleCookies(res);
  if (req.query.error) return googleErrorPage(res, 401, "Google sign-in was cancelled or could not be completed. You can return and use email or username login.");
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !googleRedirectUri(req)) return googleErrorPage(res, 503, "Google sign-in is not configured yet. Add the OAuth credentials and callback URL to the server settings.");
  const receivedState = Buffer.from(state);
  const expectedState = Buffer.from(savedState || "");
  if (!state || !savedState || !nonce || receivedState.length !== expectedState.length || !crypto.timingSafeEqual(receivedState, expectedState)) return googleErrorPage(res, 400, "This sign-in request expired or could not be verified. Please try again.");
  if (typeof req.query.code !== "string") return googleErrorPage(res, 400, "Google did not return a sign-in code. Please try again.");
  try {
    const oauth = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, googleRedirectUri(req));
    const { tokens } = await oauth.getToken(req.query.code);
    if (!tokens.id_token) return googleErrorPage(res, 401, "Google did not return a verified account. Please try again.");
    const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
    const claims = ticket.getPayload();
    if (!claims?.sub || !claims.email || !claims.email_verified || claims.nonce !== nonce) return googleErrorPage(res, 401, "Google could not verify this email address. Please try another account.");
    const email = cleanEmail(claims.email);
    let user = await findUserByEmail(email);
    if (!user) {
      const base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 18) || "member";
      const credentials = await passwordHash(crypto.randomBytes(32).toString("base64url"));
      for (let attempt = 0; attempt < 8 && !user; attempt++) {
        const suffix = crypto.randomInt(1000, 100000).toString();
        const username = `${base.slice(0, 24 - suffix.length - 1)}_${suffix}`;
        if (await findUserByUsername(username)) continue;
        try {
          user = await createUser({ id: crypto.randomUUID(), username, email, displayName: String(claims.name || claims.given_name || base).trim().slice(0, 60), ...credentials, createdAt: new Date().toISOString() });
        } catch (error) {
          if (error.code !== "23505") throw error;
          user = await findUserByEmail(email);
        }
      }
      if (!user) return googleErrorPage(res, 500, "We could not create your YapPay account. Please try again.");
    }
    await issueSession(user, res);
    res.redirect("/");
  } catch (error) {
    console.error("Google sign-in failed:", error.message);
    googleErrorPage(res, 401, "Google sign-in could not be verified. Please try again or use email or username login.");
  }
});

app.patch("/api/auth/profile", async (req, res) => {
  try {
    const userId = await sessionUser(req);
    if (!userId) return res.status(401).json({ error: "Please log in to edit your profile." });
    const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";
    const email = cleanEmail(req.body?.email);
    const birthday = typeof req.body?.birthday === "string" ? req.body.birthday : "";
    const gender = typeof req.body?.gender === "string" ? req.body.gender : "";
    const bio = typeof req.body?.bio === "string" ? req.body.bio.trim() : "";
    const intent = typeof req.body?.intent === "string" ? req.body.intent : "";
    const genders = ["", "Woman", "Man", "Non-binary", "Prefer not to say"];
    const intents = ["", "Meaningful connections", "New friends", "See where it goes"];
    if (!displayName || displayName.length > 60) return res.status(400).json({ error: "Your name must be between 1 and 60 characters." });
    if (email && !validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (birthday && (!/^\d{4}-\d{2}-\d{2}$/.test(birthday) || Number.isNaN(Date.parse(birthday)) || new Date(birthday).toISOString().slice(0, 10) !== birthday || birthday > new Date().toISOString().slice(0, 10))) return res.status(400).json({ error: "Enter a valid birthday that is not in the future." });
    if (!genders.includes(gender)) return res.status(400).json({ error: "Choose a valid gender option." });
    if (bio.length > 300) return res.status(400).json({ error: "Your bio must be 300 characters or fewer." });
    if (!intents.includes(intent)) return res.status(400).json({ error: "Choose a valid profile goal." });
    let user;
    if (database.enabled) user = await database.updateUserProfile(userId, { displayName, email, birthday, gender, bio, intent });
    else {
      const users = await readUsers();
      user = users.find(entry => entry.id === userId);
      if (!user) return res.status(401).json({ error: "Please log in to edit your profile." });
      if (email && users.some(entry => entry.id !== userId && (entry.email || "").toLowerCase() === email)) return res.status(409).json({ error: "That email is already linked to another account." });
      Object.assign(user, { displayName, email, birthday, gender, bio, intent });
      await writeUsers(users);
    }
    if (!user) return res.status(401).json({ error: "Please log in to edit your profile." });
    res.json({ user: publicUser(user) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "That email is already linked to another account." });
    console.error("Profile update failed:", error.message);
    res.status(500).json({ error: "Could not save your profile. Please try again." });
  }
});

app.get("/api/auth/me", async (req, res) => {
  try {
    const userId = await sessionUser(req);
    if (!userId) return res.status(401).json({ error: "Not signed in" });
    const user = await findUserById(userId);
    if (!user) return res.status(401).json({ error: "Not signed in" });
    res.json({ user: publicUser(user) });
  } catch (error) {
    console.error("Session lookup failed:", error.message);
    res.status(500).json({ error: "Could not verify your session." });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  const token = (req.headers.cookie || "").split(";").map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (token) {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    if (database.enabled) await database.deleteSession(tokenHash);
    else sessions.delete(tokenHash);
  }
  res.clearCookie(COOKIE, { httpOnly: true, secure: NODE_ENV === "production", sameSite: NODE_ENV === "production" ? "none" : "lax", path: "/" });
  res.sendStatus(204);
});

let tokenCache = { value: null, exp: 0 };
async function getToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString("base64");
  const r = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!r.ok) throw new Error(`Daraja auth failed (${r.status})`);
  const d = await r.json();
  tokenCache = { value: d.access_token, exp: Date.now() + (Number(d.expires_in) - 60) * 1000 };
  return tokenCache.value;
}
function timestamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
app.post("/api/mpesa/stkpush", async (req, res) => {
  try {
    const { phone, plan } = req.body || {};
    if (!/^254(7|1)\d{8}$/.test(String(phone))) return res.status(400).json({ error: "Invalid phone number" });
    const p = PLANS[plan];
    if (!p) return res.status(400).json({ error: "Unknown plan" });
    if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET || !MPESA_PASSKEY || !CALLBACK_URL)
      return res.status(500).json({ error: "M-Pesa is not configured on the server" });
    const ts = timestamp();
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${ts}`).toString("base64");
    const token = await getToken();
    const r = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ BusinessShortCode: MPESA_SHORTCODE, Password: password, Timestamp: ts,
        TransactionType: MPESA_TRANSACTION_TYPE, Amount: p.amount, PartyA: phone, PartyB: MPESA_SHORTCODE,
        PhoneNumber: phone, CallBackURL: CALLBACK_URL, AccountReference: "YapPay", TransactionDesc: p.label }),
    });
    const d = await r.json();
    if (!r.ok || d.ResponseCode !== "0") return res.status(502).json({ error: d.errorMessage || d.ResponseDescription || "M-Pesa rejected the request" });
    if (database.enabled) await database.createPayment(d.CheckoutRequestID, plan, phone);
    else payments.set(d.CheckoutRequestID, { status: "pending", plan, phone });
    res.json({ checkoutRequestId: d.CheckoutRequestID });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not reach M-Pesa. Try again." });
  }
});
app.post("/api/mpesa/callback", async (req, res) => {
  const cb = req.body?.Body?.stkCallback;
  if (cb) {
    const rec = payments.get(cb.CheckoutRequestID) || {};
    if (cb.ResultCode === 0) {
      const items = cb.CallbackMetadata?.Item || [];
      const receipt = items.find(item => item.Name === "MpesaReceiptNumber")?.Value;
      if (database.enabled) await database.updatePayment(cb.CheckoutRequestID, "success", { receipt });
      else payments.set(cb.CheckoutRequestID, { ...rec, status: "success", receipt });
    } else {
      const message = cb.ResultCode === 1032 ? "You cancelled the payment" : cb.ResultDesc || "Payment failed";
      if (database.enabled) await database.updatePayment(cb.CheckoutRequestID, "failed", { message });
      else payments.set(cb.CheckoutRequestID, { ...rec, status: "failed", message });
    }
  }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});
app.get("/api/mpesa/status/:id", async (req, res) => {
  const payment = database.enabled ? await database.findPayment(req.params.id) : payments.get(req.params.id);
  if (!payment) return res.status(404).json({ status: "failed", message: "Unknown payment" });
  res.json({ status: payment.status, message: payment.message, receipt: payment.receipt });
});

// Serve only the public site files. Never expose backend code or account data.
const SITE_DIR = path.join(__dirname, "..");
for (const file of ["robots.txt", "404.html"]) {
  app.get(`/${file}`, (req, res) => res.sendFile(path.join(SITE_DIR, file)));
}
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(SITE_DIR, "index.html")));
async function start() {
  if (NODE_ENV === "production" && !database.enabled) {
    throw new Error("DATABASE_URL is required in production; configure a persistent PostgreSQL database.");
  }
  await database.initialize();
  app.listen(PORT, () => console.log(`YapPay server on :${PORT} (${MPESA_ENV})`));
}
start().catch(error => {
  console.error("YapPay startup failed:", error.message);
  process.exitCode = 1;
});
