# YapPay Website

- `index.html` – the full single-file site and its existing welcome, sign-up and login screens.
- `backend/` – Node backend for email-or-username/password authentication and the existing M-Pesa demo. Needs Node >= 20.6.
- `backend/database/` – PostgreSQL connection layer and SQL schema used by hosted deployments.

## Local demo with login

1. From this folder, run `npm run backend:install` once.
2. Run `npm run backend:start`.
3. Open http://localhost:3000, choose **Sign up**, and add your email, username, and password. Usernames use 3–24 letters, numbers or underscores; passwords need at least 8 characters.
4. Without `DATABASE_URL`, local accounts are kept in `backend/data/users.json`. Passwords are stored as salted scrypt hashes. This data file is ignored by Git.
5. Log in with either your username or email address. Existing accounts can add an email from **Profile → Edit profile**. From the login screen, choose **Forgot password?**, enter the account username or email, then open the one-time local demo reset link. Reset links expire after 30 minutes. No email sender is configured, so this recovery flow is for local demo use only.

Google sign-in is ready after Google OAuth credentials are configured. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` on the backend. For local use, register `http://localhost:3000/api/auth/google/callback` as an authorized redirect URI in Google Cloud Console. Email addresses used for regular sign-up are not verified because no email delivery service is configured.

The separate `npm run serve` static preview does not include the authentication API. Use the backend command above to try sign-up and login.

## Hosted PostgreSQL

The Render Blueprint at the repository root provisions a managed Render Postgres database and supplies its internal connection string as `DATABASE_URL`. On startup, the backend applies `backend/database/schema.sql`; the first deployment creates the account and session tables. Users, hashed session tokens and M-Pesa checkout statuses are then stored in PostgreSQL instead of the local JSON file and in-memory maps. Membership balances are not yet connected to user accounts.

To deploy, connect the repository to Render using `render.yaml` and provide the existing M-Pesa and site-origin settings in Render's environment panel. Use the internal database URL for a Render service in the same region. For local or external database connections, set `DATABASE_URL` to the database's external URL and require TLS as directed by the database provider.

`render.yaml` selects Render Postgres `basic-256mb`, the smallest paid plan, so the configured database does not rely on a temporary free database. Review Render's current plan and storage pricing before provisioning.

The authentication application stores password hashes (scrypt) and hashed session tokens. Password reset tokens are hashed in PostgreSQL and expire after 30 minutes. The local demo displays the reset link in the page because it has no email sender; production disables password reset until an email delivery provider is configured. Add email verification, backups and operational monitoring before using the service for a broad public launch. M-Pesa transaction status and membership balances remain in memory and are not yet tied to user accounts.
